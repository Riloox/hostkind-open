'use strict';

/*
 * Relay server wiring tests (plan Task 4 — relay/server.cjs composition
 * root: HTTP layer + SQLite store + queue worker + injected GitHub client).
 *
 * Exercises the full stack over an in-process HTTP server on an ephemeral
 * port: queue-before-GitHub ordering, 201/202 semantics, generic redacted
 * errors, rate limiting, content-type/body gates, request ids, and the
 * no-credential/no-echo response contract. The HTTP layer test file owned by
 * the parallel HTTP task is test/bug-report-relay-http.test.cjs; this file
 * covers the wiring/entry-point server at relay/server.cjs.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRelayApp } = require('../relay/server.cjs');
const { createStore } = require('../relay/lib/store.cjs');
const { createQueueWorker } = require('../relay/lib/queue-worker.cjs');
const { createRateLimiter } = require('../relay/lib/rate-limit.cjs');

const tests = [];

/* ── helpers ─────────────────────────────────────────────────────── */

function tmpDb() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-server-')));
  return {
    dir,
    dbPath: path.join(dir, 'relay.db'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }),
  };
}

const PAYLOAD = {
  title: 'Crash on world load',
  description: 'The server crashes when the world loads. Do not echo this.',
  reproSteps: '1. Start server\n2. Load world',
  expected: 'World loads without crashing',
  game: 'minecraft',
  view: 'servers',
  route: '/servers/abc',
  userAgent: 'Mozilla/5.0 (fleetdeck test)',
  version: '0.1.0',
};

function fakeGithub({ onCreate } = {}) {
  const calls = { createIssue: [], findIssueByMarker: [] };
  return {
    calls,
    async createIssue(input) {
      calls.createIssue.push(input);
      if (onCreate) return onCreate(input);
      return { issueNumber: 42, issueUrl: 'https://github.com/Riloox/hostkind-open/issues/42' };
    },
    async findIssueByMarker(marker) {
      calls.findIssueByMarker.push(marker);
      return null;
    },
  };
}

async function boot(opts = {}) {
  const t = opts.tmp || tmpDb();
  const store = createStore({ dbPath: t.dbPath });
  // Default client FAILS non-retryably so the queued (202) path is the
  // default; tests that need synchronous sync pass a success client.
  const client = opts.client || fakeGithub({
    onCreate: () => {
      throw Object.assign(new Error('GitHub API error 422: validation failed'), { retryable: false, kind: 'validation' });
    },
  });
  const worker = opts.worker || createQueueWorker({
    store,
    client,
    backoffBaseMs: opts.backoffBaseMs !== undefined ? opts.backoffBaseMs : 0,
  });
  const logs = [];
  const app = createRelayApp({
    store,
    worker,
    logger: { info: () => {}, warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    perIpLimiter: opts.perIpLimiter || createRateLimiter({ windowMs: 60_000, max: 1000 }),
    dailyLimiter: opts.dailyLimiter || createRateLimiter({ windowMs: 86_400_000, max: 1000 }),
  });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    t,
    store,
    client,
    worker,
    logs,
    base,
    close: () => new Promise((resolve) => {
      server.close(() => { store.close(); t.cleanup(); resolve(); });
    }),
  };
}

async function post(base, body, headers = {}) {
  const res = await fetch(`${base}/v1/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json, headers: res.headers };
}

/* ── happy paths ─────────────────────────────────────────────────── */

tests.push(async () => {
  const h = await boot();
  try {
    const { status, json } = await post(h.base, PAYLOAD);
    assert.strictEqual(status, 202, `expected 202, got ${status}`);
    assert.strictEqual(json.status, 'queued');
    assert.ok(json.id, 'response must carry the queue id');
    assert.strictEqual(json.issueUrl, null);
    assert.strictEqual(json.issueNumber, null);
    assert.deepStrictEqual(Object.keys(json).sort(), ['id', 'issueNumber', 'issueUrl', 'status']);
    assert.ok(h.store.get(json.id), 'report must be durable after the response');
    assert.strictEqual(h.store.counts().total, 1);
  } finally {
    await h.close();
  }
  console.log('ok  relay-server POST: 202 queued with minimal response shape');
});

tests.push(async () => {
  const h = await boot();
  try {
    const { status, json } = await post(h.base, PAYLOAD);
    assert.strictEqual(status, 202);
    assert.ok(!JSON.stringify(json).includes(PAYLOAD.description), 'response must not echo report content');
    assert.ok(!JSON.stringify(json).includes('token'), 'response must have no credential fields');
    assert.ok(!JSON.stringify(json).includes('password'));
  } finally {
    await h.close();
  }
  console.log('ok  relay-server POST: response never echoes content or credentials');
});

tests.push(async () => {
  const h = await boot({ client: fakeGithub() });
  try {
    const client = h.client;
    const { status, json } = await post(h.base, PAYLOAD);
    assert.strictEqual(status, 201, `expected 201 when issue created synchronously, got ${status}`);
    assert.strictEqual(json.status, 'synced');
    assert.strictEqual(json.issueUrl, 'https://github.com/Riloox/hostkind-open/issues/42');
    assert.strictEqual(json.issueNumber, 42);
    assert.strictEqual(client.calls.createIssue.length, 1);
    const fresh = h.store.get(json.id);
    assert.strictEqual(fresh.sync_state, 'synced');
  } finally {
    await h.close();
  }
  console.log('ok  relay-server POST: 201 synced with issueUrl when created synchronously');
});

tests.push(async () => {
  // Fake client asserts the row exists when called -> proves the report was
  // enqueued before any GitHub interaction.
  let sawRow = false;
  const client = fakeGithub({
    onCreate: () => {
      sawRow = h2.store.counts().total === 1;
      return { issueNumber: 1, issueUrl: 'https://github.com/Riloox/hostkind-open/issues/1' };
    },
  });
  const h2 = await boot({ client });
  try {
    const { status } = await post(h2.base, PAYLOAD);
    assert.strictEqual(status, 201);
    assert.strictEqual(sawRow, true, 'GitHub call must happen after the row is queued');
    assert.strictEqual(h2.store.counts().total, 1);
  } finally {
    await h2.close();
  }
  console.log('ok  relay-server ordering: report queued before any GitHub call');
});

tests.push(async () => {
  const h = await boot();
  try {
    const body = { ...PAYLOAD, clientKey: 'client-key-1234' };
    const first = await post(h.base, body);
    const second = await post(h.base, body);
    assert.strictEqual(first.status, 202);
    assert.strictEqual(second.status, 202);
    assert.strictEqual(first.json.id, second.json.id, 'same clientKey must dedupe to the same queue entry');
    assert.strictEqual(h.store.counts().total, 1);
    assert.strictEqual(h.client.calls.createIssue.length, 1);
  } finally {
    await h.close();
  }
  console.log('ok  relay-server idempotency: double submit with clientKey -> one issue');
});

/* ── input gates ─────────────────────────────────────────────────── */

tests.push(async () => {
  const h = await boot();
  try {
    const { status, json } = await post(h.base, JSON.stringify(PAYLOAD), { 'content-type': 'text/plain' });
    assert.strictEqual(status, 415);
    assert.strictEqual(json.error, 'unsupported_content_type');
  } finally {
    await h.close();
  }
  console.log('ok  relay-server gates: non-JSON content type -> 415');
});

tests.push(async () => {
  const h = await boot();
  try {
    const { status, json } = await post(h.base, '{"title": "oops",');
    assert.strictEqual(status, 400);
    assert.strictEqual(json.error, 'invalid_json');
  } finally {
    await h.close();
  }
  console.log('ok  relay-server gates: invalid JSON -> 400');
});

tests.push(async () => {
  const h = await boot();
  try {
    const big = JSON.stringify({ title: 'x'.repeat(200), description: 'y'.repeat(40 * 1024) });
    const { status, json } = await post(h.base, big);
    assert.strictEqual(status, 413);
    assert.strictEqual(json.error, 'payload_too_large');
  } finally {
    await h.close();
  }
  console.log('ok  relay-server gates: oversized body -> 413');
});

tests.push(async () => {
  const h = await boot();
  try {
    const { status, json } = await post(h.base, { description: 'missing title' });
    assert.strictEqual(status, 400);
    assert.strictEqual(json.error, 'validation_failed');
    assert.ok(Array.isArray(json.errors) && json.errors.length > 0);
    assert.ok(json.errors.includes('title: must be a non-empty string'), JSON.stringify(json.errors));
    assert.ok(!JSON.stringify(json).includes('missing title'), 'validation errors must not echo values');
  } finally {
    await h.close();
  }
  console.log('ok  relay-server gates: validation failure -> 400 with secret-free errors');
});

tests.push(async () => {
  const h = await boot();
  try {
    const { status } = await post(h.base, { ...PAYLOAD, token: 'ghp_top_secret_token_1234567890' });
    assert.strictEqual(status, 400, 'credential-shaped field must be rejected');
  } finally {
    await h.close();
  }
  console.log('ok  relay-server gates: unknown/credential field rejected (no credential field in contract)');
});

/* ── rate limits ─────────────────────────────────────────────────── */

tests.push(async () => {
  const perIpLimiter = createRateLimiter({ windowMs: 60_000, max: 2 });
  const h = await boot({ perIpLimiter });
  try {
    await post(h.base, PAYLOAD);
    await post(h.base, PAYLOAD);
    const { status, json } = await post(h.base, PAYLOAD);
    assert.strictEqual(status, 429);
    assert.strictEqual(json.error, 'rate_limited');
  } finally {
    await h.close();
  }
  console.log('ok  relay-server limits: per-IP rate limit -> 429');
});

tests.push(async () => {
  const dailyLimiter = createRateLimiter({ windowMs: 86_400_000, max: 1 });
  const h = await boot({ dailyLimiter });
  try {
    await post(h.base, PAYLOAD);
    const { status, json } = await post(h.base, PAYLOAD);
    assert.strictEqual(status, 429);
    assert.strictEqual(json.error, 'budget_exceeded');
  } finally {
    await h.close();
  }
  console.log('ok  relay-server limits: global daily budget -> 429');
});

/* ── misc surface ────────────────────────────────────────────────── */

tests.push(async () => {
  const h = await boot();
  try {
    const res = await fetch(`${h.base}/nope`, { method: 'GET' });
    assert.strictEqual(res.status, 404);
    const json = await res.json();
    assert.strictEqual(json.error, 'not_found');
    assert.ok(res.headers.get('x-request-id'), '404 must still carry X-Request-Id');
  } finally {
    await h.close();
  }
  console.log('ok  relay-server routes: unknown route -> 404 JSON with request id');
});

tests.push(async () => {
  const h = await boot();
  try {
    const res = await fetch(`${h.base}/healthz`);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.status, 'ok');
    assert.ok(Number.isInteger(json.queue && json.queue.total), JSON.stringify(json));
    assert.ok(!JSON.stringify(json).includes('Riloox'), 'healthz must not leak repo/credential details');
  } finally {
    await h.close();
  }
  console.log('ok  relay-server healthz: minimal liveness with queue counts only');
});

tests.push(async () => {
  const h = await boot();
  try {
    const { headers } = await post(h.base, PAYLOAD, { 'x-request-id': 'safe-id-123' });
    assert.strictEqual(headers.get('x-request-id'), 'safe-id-123', 'safe client request id must be honoured');
    const res2 = await fetch(`${h.base}/v1/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'bad id with spaces' },
      body: JSON.stringify(PAYLOAD),
    });
    const echoed = res2.headers.get('x-request-id');
    assert.ok(echoed && echoed !== 'bad id with spaces', 'unsafe request id must be replaced');
    assert.ok(!echoed.includes(' '), 'replaced id must be clean');
    await res2.json();
  } finally {
    await h.close();
  }
  console.log('ok  relay-server request ids: safe honoured, unsafe replaced');
});

tests.push(async () => {
  const h = await boot();
  try {
    const res = await post(h.base, PAYLOAD);
    assert.strictEqual(res.headers.get('access-control-allow-origin'), null, 'no CORS headers by default');
    const health = await fetch(`${h.base}/healthz`);
    assert.strictEqual(health.headers.get('access-control-allow-origin'), null);
  } finally {
    await h.close();
  }
  console.log('ok  relay-server CORS: no CORS headers (server-to-server only)');
});

tests.push(async () => {
  // Force an internal failure: a worker whose runOnce throws AND a store that
  // throws on get() after enqueue would be a 500 path; simplest is a broken
  // store that throws on enqueue.
  const t = tmpDb();
  const goodStore = createStore({ dbPath: t.dbPath });
  const brokenStore = {
    enqueue: () => { throw new Error('disk full'); },
  };
  const client = fakeGithub();
  const worker = createQueueWorker({ store: goodStore, client });
  const logs = [];
  const app = createRelayApp({
    store: brokenStore,
    worker,
    logger: { info: () => {}, warn: () => {}, error: (m) => logs.push(String(m)) },
  });
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/reports`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(PAYLOAD),
    });
    assert.strictEqual(res.status, 500);
    const json = await res.json();
    assert.strictEqual(json.error, 'internal_error');
    const raw = JSON.stringify(json);
    assert.ok(!raw.includes('disk full'), 'error body must not contain internal details');
    assert.ok(!raw.includes('at '), 'error body must not contain stack traces');
    const logsJoined = JSON.stringify(logs);
    assert.ok(!logsJoined.includes('ghp_'), 'logs must not contain credentials');
  } finally {
    server.close();
    goodStore.close();
    t.cleanup();
  }
  console.log('ok  relay-server errors: generic 500, no stacks, redacted logs');
});

/* ── run ─────────────────────────────────────────────────────────── */

(async function main() {
  let failed = 0;
  for (let i = 0; i < tests.length; i++) {
    try {
      await tests[i]();
    } catch (e) {
      failed++;
      console.error(`FAIL  bug-report-relay-server test ${i + 1}: ${e.message}\n${e.stack}`);
    }
  }
  if (failed) {
    console.error(`FAIL  ${failed} bug-report-relay-server test(s) failed`);
    process.exit(1);
  }
  console.log(`PASS  bug-report-relay-server (${tests.length} tests)`);
})();
