'use strict';

/*
 * Relay HTTP service.
 *
 * Narrow public surface for the upstream bug-report relay:
 *
 *   POST /v1/reports   accept a validated bug-report payload, enqueue it
 *                      durably. 202 Accepted when queued; 201 Created only
 *                      when the queue adapter reports a synchronous sync.
 *   GET  /healthz      minimal liveness probe. No versions, no repo names,
 *                      no queue depth, no credentials.
 *
 * Hardening applied at this layer:
 *   - strict JSON body limit (default 32 KiB) and application/json content type
 *   - generic fixed-string error responses: no stack traces, no GitHub API
 *     bodies, no filesystem paths, no echoed user input, no client-selected
 *     URLs or repositories
 *   - server-generated X-Request-Id (a client-supplied id is honoured only
 *     when it matches a safe pattern); no other request header is reflected
 *   - per-IP, per-instance, hourly and daily rate limits (fixed window,
 *     injectable counter store)
 *   - request timeout so a stuck queue adapter cannot hold connections open
 *   - no CORS headers unless an explicit allowlist is configured
 *   - credential-shaped request fields are rejected before validation
 *   - unknown payload fields are dropped, never persisted
 *
 * Everything the service needs is injected (queue/store adapter `enqueue`,
 * validator, rate-limit store, logger, clock, request-id generator) so the
 * module is deterministic and testable without any network access. The HTTP
 * layer never talks to GitHub and never holds a credential: createRelayServer()
 * throws when no enqueue adapter is provided (fail closed).
 *
 * enqueue contract:
 *   async enqueue(report, { requestId }) -> { id, state?, issueUrl? }
 *   - report: the validated payload (camelCase fields, unknown fields removed)
 *   - resolves { id } at minimum; state 'synced' + issueUrl maps to 201,
 *     anything else maps to 202 { state: 'queued' }
 *   - a resolve without an id, or a reject, maps to 503 (fail closed)
 *
 * The durable queue itself (Task 3, relay/lib/store.cjs) and the deep
 * validator/redactor (Task 2, relay/lib/validate-report.cjs) plug in through
 * these seams. The built-in validator below is the strict HTTP-layer fallback
 * so the service stays self-contained until Task 2 lands.
 */

const crypto = require('crypto');
const express = require('express');
const { createRateLimiter } = require('./rate-limiter.cjs');

const DEFAULTS = {
  bodyLimitBytes: 32 * 1024,        // express.json limit: '32kb'
  requestTimeoutMs: 10_000,
  ipLimit: { max: 10, windowMs: 60_000 },         // per peer IP
  instanceLimit: { max: 600, windowMs: 60_000 },  // whole instance
  hourlyBudget: { max: 1000, windowMs: 3_600_000 },
  dailyBudget: { max: 5000, windowMs: 86_400_000 },
  allowedOrigins: [],                // empty = no CORS headers at all
  ipSource: 'socket',                // 'socket' (spoof-proof) | 'forwarded'
  requestIdPattern: /^[A-Za-z0-9._-]{1,64}$/,
};

// Field limits mirror lib/bug-reports.cjs LIMITS so the HTTP layer accepts
// exactly what the Hostkind store accepts (the 32 KiB body limit is the
// real cap on description size).
const FIELD_LIMITS = {
  title: { required: true, max: 200 },
  description: { required: true, max: 100_000 },
  actorId: { max: 500 },
  actorUsername: { max: 500 },
  game: { max: 500 },
  view: { max: 500 },
  route: { max: 500 },
  reproSteps: { max: 5000 },
  expected: { max: 5000 },
  userAgent: { max: 1000 },
  version: { max: 100 },
  marker: { max: 100, pattern: /^[A-Za-z0-9._-]{1,100}$/ },
};
const KNOWN_FIELDS = Object.keys(FIELD_LIMITS);

// The contract has no credential field: bodies that smuggle one are rejected
// outright, before any validation output could echo it.
const DENY_FIELDS = new Set([
  'token', 'password', 'secret', 'authorization', 'api_key', 'apikey',
  'private_key', 'credential', 'access_token', 'github_token', 'bearer',
]);

const MESSAGES = {
  invalid_json: 'request body must be a JSON object',
  validation_error: 'report failed validation',
  title_required: 'title is required',
  description_required: 'description is required',
  field_invalid: 'report contains an invalid field',
  field_too_long: 'report contains a field that is too long',
  forbidden_field: 'request contains a forbidden field',
  payload_too_large: 'request body is too large',
  unsupported_media_type: 'content-type must be application/json',
  rate_limited: 'too many requests',
  timeout: 'request timed out',
  unavailable: 'service temporarily unavailable',
  not_found: 'not found',
  internal_error: 'internal error',
};

/*
 * Strict HTTP-layer validator. Returns { ok: true, report } or
 * { ok: false, code }. Error codes are fixed strings — validation failures
 * NEVER carry the submitted value, so a secret cannot leak through an error.
 * Unknown fields are dropped (deep redaction is the Task 2 validator's job).
 */
function validateReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 'invalid_json' };
  }
  for (const key of Object.keys(body)) {
    if (DENY_FIELDS.has(String(key).toLowerCase())) {
      return { ok: false, code: 'forbidden_field' };
    }
  }
  const report = {};
  for (const key of KNOWN_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const value = body[key];
    if (value == null) continue;
    if (typeof value !== 'string') return { ok: false, code: 'field_invalid' };
    const trimmed = value.trim();
    if (FIELD_LIMITS[key].required && trimmed === '') {
      return { ok: false, code: `${key}_required` };
    }
    if (trimmed.length > FIELD_LIMITS[key].max) return { ok: false, code: 'field_too_long' };
    if (FIELD_LIMITS[key].pattern && !FIELD_LIMITS[key].pattern.test(trimmed)) {
      return { ok: false, code: 'field_invalid' };
    }
    report[key] = trimmed;
  }
  for (const key of KNOWN_FIELDS) {
    if (FIELD_LIMITS[key].required && !Object.prototype.hasOwnProperty.call(report, key)) {
      return { ok: false, code: `${key}_required` };
    }
  }
  return { ok: true, report };
}

function errorBody(code) {
  return { error: { code, message: MESSAGES[code] || 'error' } };
}

function redactText(text) {
  let out = String(text == null ? '' : text);
  out = out.replace(/(?:github_pat_|ghp_)[A-Za-z0-9_]+/g, '[REDACTED]');
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  return out.slice(0, 2000);
}

// Resolve the request's effective peer. 'socket' uses the actual TCP peer and
// ignores X-Forwarded-For (spoof-proof; correct when the tunnel terminates on
// the same host). 'forwarded' trusts the FIRST X-Forwarded-For entry and must
// only be enabled behind a trusted proxy that overwrites the header.
function getIp(req, ipSource) {
  if (ipSource === 'forwarded') {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.trim() !== '') {
      const first = fwd.split(',')[0].trim();
      if (first) return first.slice(0, 64);
    }
  }
  const addr = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : 'unknown';
  return addr.slice(0, 64);
}

function routeName(req) {
  const p = req.path || '';
  if (p === '/v1/reports') return '/v1/reports';
  if (p === '/healthz') return '/healthz';
  return 'unknown';
}

function normalizeLogger(logger) {
  if (!logger || typeof logger !== 'object') {
    return {
      info: (e) => console.log(JSON.stringify(e)),
      warn: (e) => console.warn(JSON.stringify(e)),
      error: (e) => console.error(JSON.stringify(e)),
    };
  }
  return {
    info: typeof logger.info === 'function' ? logger.info.bind(logger) : () => {},
    warn: typeof logger.warn === 'function' ? logger.warn.bind(logger) : () => {},
    error: typeof logger.error === 'function' ? logger.error.bind(logger) : () => {},
  };
}

function limitWith(defaults, value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    max: Number.isFinite(src.max) ? src.max : defaults.max,
    windowMs: Number.isFinite(src.windowMs) ? src.windowMs : defaults.windowMs,
  };
}

function raceTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error('relay-http: request timed out'), { relayCode: 'timeout' })),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function mapError(err) {
  if (err && err.type === 'entity.too.large') return { status: 413, code: 'payload_too_large' };
  if (err && err.type === 'entity.parse.failed') return { status: 400, code: 'invalid_json' };
  if (err && err.relayCode) {
    if (err.relayCode === 'timeout') return { status: 503, code: 'timeout' };
    if (err.relayCode === 'unavailable') return { status: 503, code: 'unavailable' };
  }
  return { status: 500, code: 'internal_error' };
}

function createRelayServer(deps = {}) {
  const enqueue = deps.enqueue;
  if (typeof enqueue !== 'function') {
    throw new Error('relay-http: enqueue (queue/store adapter) is required');
  }
  const validate = typeof deps.validate === 'function' ? deps.validate : validateReport;
  const logger = normalizeLogger(deps.logger);
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const requestId = typeof deps.requestId === 'function' ? deps.requestId : () => crypto.randomUUID();
  const requestIdPattern = deps.requestIdPattern instanceof RegExp ? deps.requestIdPattern : DEFAULTS.requestIdPattern;
  const bodyLimitBytes = Number.isFinite(deps.bodyLimitBytes) ? deps.bodyLimitBytes : DEFAULTS.bodyLimitBytes;
  const requestTimeoutMs = Number.isFinite(deps.requestTimeoutMs) ? deps.requestTimeoutMs : DEFAULTS.requestTimeoutMs;
  const ipSource = deps.ipSource === 'forwarded' ? 'forwarded' : 'socket';
  const allowedOrigins = Array.isArray(deps.allowedOrigins) ? deps.allowedOrigins.map(String) : [];

  const limits = {
    ip: limitWith(DEFAULTS.ipLimit, deps.limits && deps.limits.ip),
    instance: limitWith(DEFAULTS.instanceLimit, deps.limits && deps.limits.instance),
    hourly: limitWith(DEFAULTS.hourlyBudget, deps.limits && deps.limits.hourly),
    daily: limitWith(DEFAULTS.dailyBudget, deps.limits && deps.limits.daily),
  };

  const limiterStore = deps.limiterStore && typeof deps.limiterStore.get === 'function' ? deps.limiterStore : new Map();
  const ipLimiter = createRateLimiter({ ...limits.ip, now, store: limiterStore });
  const instanceLimiter = createRateLimiter({ ...limits.instance, now, store: limiterStore });
  const hourlyLimiter = createRateLimiter({ ...limits.hourly, now, store: limiterStore });
  const dailyLimiter = createRateLimiter({ ...limits.daily, now, store: limiterStore });

  const app = express();
  app.disable('x-powered-by');

  // 1. Request ID: generate unless the client supplied a safe one. This is the
  //    ONLY request header ever reflected.
  app.use((req, res, next) => {
    let rid = null;
    const provided = req.headers['x-request-id'];
    if (typeof provided === 'string' && requestIdPattern.test(provided)) rid = provided;
    if (!rid) rid = requestId();
    req.relayRequestId = rid;
    res.set('X-Request-Id', rid);
    next();
  });

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  // 2. Redacted request log (method, normalized route, status, duration only —
  //    never headers, bodies, or paths).
  app.use((req, res, next) => {
    const startedAt = now();
    res.on('finish', () => {
      logger.info({
        event: 'relay.http.request',
        requestId: req.relayRequestId,
        method: req.method,
        route: routeName(req),
        status: res.statusCode,
        durationMs: now() - startedAt,
      });
    });
    next();
  });

  // 3. CORS: opt-in allowlist only. No wildcard, no origin echo; preflight
  //    returns 204 for listed origins. No headers are sent when unconfigured.
  if (allowedOrigins.length > 0) {
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (typeof origin === 'string' && allowedOrigins.includes(origin)) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Vary', 'Origin');
        res.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, X-Request-Id');
        res.set('Access-Control-Max-Age', '600');
      }
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
    });
  }

  // 4. Rate limiting BEFORE body parsing: abuse control wins over work. Only
  //    POST /v1/reports is counted; /healthz never is.
  app.use((req, res, next) => {
    if (req.method !== 'POST' || (req.path || '') !== '/v1/reports') return next();
    const at = now();
    const ip = getIp(req, ipSource);
    const checks = [
      ['instance', instanceLimiter.check('instance', at)],
      ['hourly', hourlyLimiter.check('hourly', at)],
      ['daily', dailyLimiter.check('daily', at)],
      ['ip', ipLimiter.check(`ip:${ip}`, at)],
    ];
    let retryAfterMs = 0;
    for (const [, r] of checks) {
      if (!r.allowed && r.retryAfterMs != null && r.retryAfterMs > retryAfterMs) {
        retryAfterMs = r.retryAfterMs;
      }
    }
    if (retryAfterMs > 0) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      res.status(429).json(errorBody('rate_limited'));
      return;
    }
    next();
  });

  app.use(express.json({ limit: bodyLimitBytes, strict: true }));

  app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.post('/v1/reports', (req, res, next) => {
    let settled = false;
    function respond(status, body) {
      if (settled) return;
      settled = true;
      res.status(status).json(body);
    }

    (async () => {
      const contentType = String(req.headers['content-type'] || '');
      const mediaType = contentType.split(';')[0].trim().toLowerCase();
      if (mediaType !== 'application/json' && !mediaType.endsWith('+json')) {
        respond(415, errorBody('unsupported_media_type'));
        return;
      }

      const verdict = validate(req.body);
      if (!verdict.ok) {
        respond(400, errorBody(verdict.code));
        return;
      }

      let result;
      try {
        result = await raceTimeout(
          Promise.resolve().then(() => enqueue(verdict.report, { requestId: req.relayRequestId })),
          requestTimeoutMs
        );
      } catch (err) {
        if (err && err.relayCode === 'timeout') throw err;
        throw Object.assign(new Error('relay-http: queue unavailable'), {
          relayCode: 'unavailable',
          cause: err,
        });
      }

      if (!result || typeof result.id !== 'string' || result.id === '') {
        throw Object.assign(new Error('relay-http: queue adapter returned no report id'), {
          relayCode: 'unavailable',
        });
      }

      const state = result.state === 'synced' ? 'synced' : 'queued';
      const status = state === 'synced' ? 201 : 202;
      respond(status, {
        id: result.id,
        state,
        issueUrl: result.issueUrl && typeof result.issueUrl === 'string' ? result.issueUrl : null,
      });
    })().catch(next);
  });

  // 5. Unknown routes and methods: uniform JSON 404, no route listing.
  app.use((req, res) => {
    res.status(404).json(errorBody('not_found'));
  });

  // 6. Generic error handler: fixed strings only, redacted log for 5xx.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const mapped = mapError(err);
    if (mapped.status >= 500) {
      logger.error({
        event: 'relay.http.error',
        requestId: req.relayRequestId,
        status: mapped.status,
        code: mapped.code,
        detail: redactText(err && err.cause && err.cause.message ? err.cause.message : err && err.message ? err.message : String(err)),
      });
    }
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(mapped.status).json(errorBody(mapped.code));
  });

  return {
    app,
    config: {
      bodyLimitBytes,
      requestTimeoutMs,
      ipSource,
      allowedOrigins,
      limits,
    },
  };
}

module.exports = { createRelayServer, validateReport, DEFAULTS, FIELD_LIMITS };
