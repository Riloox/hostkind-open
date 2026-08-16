'use strict';

/*
 * Relay HTTP service.
 *
 * Exposes exactly two routes:
 *   POST /v1/reports — validated, redacted report submission.
 *                      Returns 202 when queued for the GitHub worker (the
 *                      common case), 201 only when the issue was created
 *                      synchronously in the same pass. The response body is
 *                      queue/sync state ONLY — never report content and
 *                      never a credential.
 *   GET  /healthz    — { status: 'ok' } plus aggregate queue counts.
 *
 * Hardening applied here:
 *   - application/json content-type gate (415), express.json limit '32kb'
 *     (413 via the error handler), generic errors with no stack traces and
 *     no GitHub response bodies, X-Request-Id generation + echo, no CORS
 *     headers (server-to-server only), per-IP and global daily rate limits.
 *
 * createRelayApp(deps) builds a bare express app with an injected
 * store + worker (test seam). createRelayServer(opts) wires the real
 * standalone stack (SQLite store + env-configured GitHub client + worker)
 * and is also the process entry point (binds 127.0.0.1 only by default).
 */

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { validateReport } = require('./lib/validate-report.cjs');
const { redactReport } = require('./lib/redact-report.cjs');
const { createStore } = require('./lib/store.cjs');
const { createQueueWorker } = require('./lib/queue-worker.cjs');
const { createRateLimiter } = require('./lib/rate-limit.cjs');
const { githubClientFromEnv } = require('./lib/github-client.cjs');

const noopLogger = { info() {}, warn() {}, error() {} };

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

function createRelayApp(deps = {}) {
  const store = deps.store;
  const worker = deps.worker;
  if (!store || typeof store.enqueue !== 'function') {
    throw new Error('relay-server: store is required');
  }
  if (!worker || typeof worker.runOnce !== 'function') {
    throw new Error('relay-server: worker is required');
  }
  const logger = deps.logger || noopLogger;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const jsonLimit = deps.jsonLimit || '32kb';

  const perIpLimiter = deps.perIpLimiter || createRateLimiter({
    windowMs: 60 * 60 * 1000,   // 10 submissions per IP per hour
    max: 10,
    now,
  });
  const dailyLimiter = deps.dailyLimiter || createRateLimiter({
    windowMs: 24 * 60 * 60 * 1000, // global daily budget
    max: 500,
    now,
  });

  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');

  /*
   * X-Request-Id: accept a bounded caller-supplied id (safe charset only) or
   * generate one; echo it on every response and include it in logs/errors.
   * No other request header is ever reflected.
   */
  app.use((req, res, next) => {
    const supplied = req.headers['x-request-id'];
    const requestId = typeof supplied === 'string' && REQUEST_ID_PATTERN.test(supplied)
      ? supplied
      : crypto.randomUUID();
    req.requestId = requestId;
    res.set('X-Request-Id', requestId);
    next();
  });

  function sendError(res, status, code, errors) {
    res.status(status).json({ error: code, errors: errors || [], requestId: res.get('X-Request-Id') });
  }

  app.post(
    '/v1/reports',
    (req, res, next) => {
      const contentType = String(req.headers['content-type'] || '').trim();
      const mediaType = contentType.split(';')[0].trim().toLowerCase();
      if (mediaType !== 'application/json' && !mediaType.endsWith('+json')) {
        return sendError(res, 415, 'unsupported_content_type', ['content-type: must be application/json']);
      }
      next();
    },
    express.json({ limit: jsonLimit }),
    async (req, res) => {
      try {
        const ip = req.ip || 'unknown';
        const ipHit = perIpLimiter.hit(ip);
        if (!ipHit.allowed) {
          return sendError(res, 429, 'rate_limited', ['too many submissions from this address']);
        }
        const dailyHit = dailyLimiter.hit('global');
        if (!dailyHit.allowed) {
          return sendError(res, 429, 'budget_exceeded', ['submission budget exhausted for today']);
        }

        const result = validateReport(req.body);
        if (!result.ok) {
          return sendError(res, 400, 'validation_failed', result.errors);
        }

        // Redact BEFORE persistence: the queue only ever stores clean data.
        const redacted = redactReport(result.report).report;
        const marker = redacted.clientKey || `relay-${crypto.randomUUID()}`;
        const row = store.enqueue({ marker, title: redacted.title, payload: redacted }, { now: now() });

        // Attempt one bounded sync pass. The worker never rejects and never
        // throws; queue-before-call ordering is guaranteed because the row
        // was written above before runOnce was invoked.
        let counts = null;
        try {
          counts = await worker.runOnce();
        } catch {
          counts = null;
        }

        const fresh = store.get(row.id);
        if (fresh && fresh.sync_state === 'synced') {
          return res.status(201).json({
            id: fresh.id,
            status: 'synced',
            issueUrl: fresh.issue_url || null,
            issueNumber: fresh.issue_number == null ? null : fresh.issue_number,
          });
        }
        return res.status(202).json({
          id: fresh ? fresh.id : row.id,
          status: 'queued',
          issueUrl: null,
          issueNumber: null,
        });
      } catch (err) {
        logger.error(`relay-server: POST /v1/reports failed (requestId=${req.requestId}): ${err && err.message ? err.message : err}`);
        return sendError(res, 500, 'internal_error', ['internal error']);
      }
    },
  );

  app.get('/healthz', (req, res) => {
    let counts = null;
    try {
      counts = store.counts ? store.counts() : null;
    } catch {
      counts = null;
    }
    const body = { status: 'ok' };
    if (counts) body.queue = counts;
    res.status(200).json(body);
  });

  app.use((req, res) => {
    sendError(res, 404, 'not_found', ['route not found']);
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
      return sendError(res, 413, 'payload_too_large', ['payload: exceeds body size limit']);
    }
    if (err && err.type === 'entity.parse.failed') {
      return sendError(res, 400, 'invalid_json', ['payload: invalid JSON']);
    }
    logger.error(`relay-server: unhandled error (requestId=${req.requestId}): ${err && err.message ? err.message : err}`);
    return sendError(res, 500, 'internal_error', ['internal error']);
  });

  return app;
}

/*
 * Wire the full standalone stack:
 *   - SQLite store under RELAY_DATA_DIR (default relay/data)
 *   - GitHub client from env (fails closed when RELAY_GITHUB_TOKEN is
 *     missing — the relay refuses to start without a credential)
 *   - queue worker polling on an unref'd interval
 * Binds 127.0.0.1 only; public exposure is provided by a separately managed
 * edge layer.
 */
function createRelayServer(opts = {}) {
  const dataDir = opts.dataDir || process.env.RELAY_DATA_DIR || path.join(__dirname, 'data');
  const store = opts.store || createStore({ dbPath: path.join(dataDir, 'relay.db') });
  const client = opts.client || githubClientFromEnv(process.env);
  const worker = opts.worker || createQueueWorker({ store, client });
  const app = createRelayApp({ store, worker, logger: opts.logger || noopLogger });

  let timer = null;
  let httpServer = null;

  function start({ port = 8787, host = '127.0.0.1', pollIntervalMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      httpServer = app.listen(port, host, () => resolve(httpServer));
      httpServer.on('error', reject);
      if (pollIntervalMs > 0) {
        timer = setInterval(() => {
          worker.runOnce().catch(() => {});
        }, pollIntervalMs);
        if (timer.unref) timer.unref();
      }
    });
  }

  function close() {
    return new Promise((resolve) => {
      if (timer) clearInterval(timer);
      if (httpServer) {
        httpServer.close(() => { store.close(); resolve(); });
      } else {
        store.close();
        resolve();
      }
    });
  }

  return { app, store, worker, start, close };
}

if (require.main === module) {
  const server = createRelayServer();
  const port = Number(process.env.RELAY_PORT) || 8787;
  const host = process.env.RELAY_HOST || '127.0.0.1';
  server.start({ port, host })
    .then((httpServer) => {
      const address = httpServer.address();
      console.log(`fleetdeck-relay listening on ${host}:${address && address.port ? address.port : port} (queue poll every 30s)`);
      const shutdown = () => {
        server.close().then(() => process.exit(0));
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    })
    .catch((err) => {
      console.error(`fleetdeck-relay failed to start: ${err && err.message ? err.message : err}`);
      process.exit(1);
    });
}

module.exports = { createRelayApp, createRelayServer };
