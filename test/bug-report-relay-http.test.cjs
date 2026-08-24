'use strict';

/*
 * bug-report-relay-http — HTTP service contract for the upstream bug-report relay.
 * Tests run against an in-process HTTP server on an ephemeral port
 * with injected fakes: no network access, no database, no secrets, no
 * long-running process. The server is closed after every test.
 *
 * Contract pinned here:
 *   - POST /v1/reports: 202 { id, state:'queued', issueUrl:null } when queued;
 *     201 { state:'synced', issueUrl } only on synchronous sync; 400/413/415/
 *     429/503 generic errors — never stacks, never GitHub bodies, never the
 *     submitted values, never a credential.
 *   - GET /healthz: 200 { status:'ok' } with no sensitive details, never
 *     rate-limited.
 *   - X-Request-Id generated server-side; safe client ids honoured; unsafe
 *     ids replaced; no other request header is reflected.
 *   - Rate limits: per-IP, per-instance, hourly, daily (fixed window) with
 *     Retry-After; socket IP source ignores X-Forwarded-For.
 *   - No CORS headers unless an allowlist is configured.
 *   - Credential-shaped request fields rejected before enqueue.
 */

const assert = require('assert');
const http = require('http');
const { createRelayServer, validateReport } = require('../relay/http/server.cjs');
const { createRateLimiter } = require('../relay/http/rate-limiter.cjs');

const tests = [];

const VALID = {
  actorId: 'user-42',
  actorUsername: 'tester',
  game: 'minecraft',
  view: 'servers',
  route: '/servers/abc',
  title: 'Crash on world load',
  description: 'The server crashes when loading the world.',
  reproSteps: '1. Start server\n2. Load world',
  expected: 'World loads without crashing',
  userAgent: 'Hostkind/0.1.0',
  version: '0.1.0',
};

// --- harness ----------------------------------------------------------------

async function boot(opts = {}) {
  const enqueued = [];
  const logs = [];
  let seq = 0;
  const defaults = {
    enqueue: async (report) => {
      const id = `rep-${++seq}`;
      enqueued.push({ id, ...report });
      return { id, state: 'queued', issueUrl: null };
    },
    logger: {
      info: (e) => logs.push({ level: 'info', ...e }),
      warn: (e) => logs.push({ level: 'warn', ...e }),
      error: (e) => logs.push({ level: 'error', ...e }),
    },
  };
  const { app, config } = createRelayServer({ ...defaults, ...opts });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((resolve) => {
    server.close(resolve);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
  return { app, config, server, base, enqueued, logs, close };
}

async function request(base, path, { method = 'POST', body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { res, json };
}

// --- rate limiter unit tests --------------------------------------------------

tests.push({ name: 'rate-limiter: allows up to max, then denies with retryAfter; other keys unaffected', fn: () => {
  const t = 1_000_000;
  const l = createRateLimiter({ max: 3, windowMs: 60_000, now: () => t });
  assert.strictEqual(l.check('k', t).allowed, true);
  assert.strictEqual(l.check('k', t).allowed, true);
  assert.strictEqual(l.check('k', t).allowed, true);
  const denied = l.check('k', t);
  assert.strictEqual(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 60_000);
  assert.strictEqual(l.check('other', t).allowed, true);
}});

tests.push({ name: 'rate-limiter: window expiry resets the counter', fn: () => {
  let t = 1_000_000;
  const l = createRateLimiter({ max: 1, windowMs: 10_000, now: () => t });
  assert.strictEqual(l.check('k', t).allowed, true);
  assert.strictEqual(l.check('k', t).allowed, false);
  t += 10_001;
  assert.strictEqual(l.check('k', t).allowed, true);
}});

tests.push({ name: 'rate-limiter: injectable store and explicit reset', fn: () => {
  const store = new Map();
  const l = createRateLimiter({ max: 1, windowMs: 60_000, store });
  const t = 5;
  l.check('k', t);
  assert.strictEqual(store.size, 1);
  l.reset('k');
  assert.strictEqual(store.size, 0);
  assert.strictEqual(l.check('k', t).allowed, true);
}});

// --- validator unit tests ------------------------------------------------------

tests.push({ name: 'validateReport: full valid payload kept, unknown fields dropped', fn: () => {
  const v = validateReport({ ...VALID, evil: 'x', nested: { a: 1 } });
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.report.title, VALID.title);
  assert.ok(!('evil' in v.report));
  assert.ok(!('nested' in v.report));
}});

tests.push({ name: 'validateReport: missing/blank required fields produce fixed codes', fn: () => {
  assert.strictEqual(validateReport({ description: 'x' }).code, 'title_required');
  assert.strictEqual(validateReport({ title: 'x' }).code, 'description_required');
  assert.strictEqual(validateReport({ title: ' ', description: 'x' }).code, 'title_required');
}});

tests.push({ name: 'validateReport: credential-shaped fields rejected without echoing them', fn: () => {
  const secret = 'ghp_S3CR3TVALU3';
  const v = validateReport({ ...VALID, token: secret });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'forbidden_field');
  assert.ok(!JSON.stringify(v).includes(secret));
}});

tests.push({ name: 'validateReport: length and pattern limits enforced', fn: () => {
  assert.strictEqual(validateReport({ ...VALID, title: 'x'.repeat(201) }).code, 'field_too_long');
  assert.strictEqual(validateReport({ ...VALID, marker: 'bad marker with spaces!' }).code, 'field_invalid');
  assert.strictEqual(validateReport({ ...VALID, description: 42 }).code, 'field_invalid');
}});

tests.push({ name: 'validateReport: rejects non-object bodies', fn: () => {
  assert.strictEqual(validateReport(null).code, 'invalid_json');
  assert.strictEqual(validateReport([1, 2]).code, 'invalid_json');
  assert.strictEqual(validateReport('text').code, 'invalid_json');
}});

// --- HTTP contract tests -------------------------------------------------------

tests.push({ name: 'GET /healthz: 200 ok with no sensitive details, never rate-limited', fn: async () => {
  const h = await boot({ limits: { ip: { max: 1, windowMs: 60_000 } } });
  try {
    const first = await request(h.base, '/healthz', { method: 'GET' });
    assert.strictEqual(first.res.status, 200);
    assert.deepStrictEqual(first.json, { status: 'ok' });
    // exhaust the per-IP quota, then healthz must still answer
    await request(h.base, '/v1/reports', { body: VALID });
    await request(h.base, '/v1/reports', { body: VALID });
    const after = await request(h.base, '/healthz', { method: 'GET' });
    assert.strictEqual(after.res.status, 200);
  } finally { await h.close(); }
}});

tests.push({ name: 'POST /v1/reports: valid payload -> 202 queued, narrow body, enqueue called once', fn: async () => {
  const h = await boot();
  try {
    const { res, json } = await request(h.base, '/v1/reports', { body: VALID });
    assert.strictEqual(res.status, 202);
    assert.strictEqual(json.state, 'queued');
    assert.ok(typeof json.id === 'string' && json.id.length > 0);
    assert.strictEqual(json.issueUrl, null);
    assert.deepStrictEqual(Object.keys(json).sort(), ['id', 'issueUrl', 'state']);
    assert.strictEqual(h.enqueued.length, 1);
    assert.strictEqual(h.enqueued[0].title, VALID.title);
    assert.ok(!JSON.stringify(json).includes('token'));
    assert.ok(res.headers.get('x-request-id'), 'response must carry X-Request-Id');
  } finally { await h.close(); }
}});

tests.push({ name: 'POST /v1/reports: synchronous sync -> 201 with public issue URL', fn: async () => {
  const h = await boot({
    enqueue: async () => ({ id: 'rep-1', state: 'synced', issueUrl: 'https://github.com/Riloox/hostkind-open/issues/12' }),
  });
  try {
    const { res, json } = await request(h.base, '/v1/reports', { body: VALID });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(json.state, 'synced');
    assert.strictEqual(json.issueUrl, 'https://github.com/Riloox/hostkind-open/issues/12');
    assert.strictEqual(json.id, 'rep-1');
  } finally { await h.close(); }
}});

tests.push({ name: 'POST /v1/reports: adapter returning no id fails closed -> 503', fn: async () => {
  const h = await boot({ enqueue: async () => ({ state: 'queued' }) });
  try {
    const { res, json } = await request(h.base, '/v1/reports', { body: VALID });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(json.error.code, 'unavailable');
    assert.ok(!JSON.stringify(json).includes('stack'));
  } finally { await h.close(); }
}});

tests.push({ name: 'POST /v1/reports: invalid JSON -> 400 invalid_json, body never echoed', fn: async () => {
  const h = await boot();
  try {
    const raw = '{not json';
    const { res, json } = await request(h.base, '/v1/reports', { body: raw });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(json.error.code, 'invalid_json');
    assert.ok(!JSON.stringify(json).includes(raw));
    assert.strictEqual(h.enqueued.length, 0);
  } finally { await h.close(); }
}});

tests.push({ name: 'POST /v1/reports: non-JSON content type -> 415, not enqueued', fn: async () => {
  const h = await boot();
  try {
    const { res, json } = await request(h.base, '/v1/reports', {
      body: 'title=x', headers: { 'content-type': 'text/plain' },
    });
    assert.strictEqual(res.status, 415);
    assert.strictEqual(json.error.code, 'unsupported_media_type');
    assert.strictEqual(h.enqueued.length, 0);
  } finally { await h.close(); }
}});

tests.push({ name: 'POST /v1/reports: oversized body -> 413 payload_too_large, not enqueued', fn: async () => {
  const h = await boot();
  try {
    const { res, json } = await request(h.base, '/v1/reports', {
      body: { title: 'big', description: 'x'.repeat(40_000) },
    });
    assert.strictEqual(res.status, 413);
    assert.strictEqual(json.error.code, 'payload_too_large');
    assert.strictEqual(h.enqueued.length, 0);
  } finally { await h.close(); }
}});

tests.push({ name: 'POST /v1/reports: large-but-legal body still accepted (limit is 32 KiB, not tiny)', fn: async () => {
  const h = await boot();
  try {
    const { res, json } = await request(h.base, '/v1/reports', {
      body: { title: 'big-ish', description: 'y'.repeat(10_000) },
    });
    assert.strictEqual(res.status, 202);
    assert.strictEqual(json.state, 'queued');
  } finally { await h.close(); }
}});

tests.push({ name: 'POST /v1/reports: missing required field -> 400 fixed code, no secret echo', fn: async () => {
  const h = await boot();
  try {
    const secret = 'hunter2password';
    const { res, json } = await request(h.base, '/v1/reports', { body: { description: secret } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(json.error.code, 'title_required');
    assert.ok(!JSON.stringify(json).includes(secret));
    assert.strictEqual(h.enqueued.length, 0);
  } finally { await h.close(); }
}});

tests.push({ name: 'POST /v1/reports: credential-shaped field rejected, enqueue never called', fn: async () => {
  const h = await boot();
  try {
    const secret = 'ghp_SUPERSECRETTOKEN';
    const { res, json } = await request(h.base, '/v1/reports', { body: { ...VALID, token: secret } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(json.error.code, 'forbidden_field');
    assert.strictEqual(h.enqueued.length, 0);
    assert.ok(!JSON.stringify(json).includes('SUPERSECRET'));
    assert.ok(!JSON.stringify(json).includes(secret));
  } finally { await h.close(); }
}});

tests.push({ name: 'POST /v1/reports: unknown fields are dropped before enqueue; no prototype pollution', fn: async () => {
  const h = await boot();
  try {
    const body = JSON.parse('{"title":"T","description":"D","__proto__":{"polluted":true},"constructor":{"prototype":{}}}');
    const { res } = await request(h.base, '/v1/reports', { body });
    assert.strictEqual(res.status, 202);
    assert.strictEqual(h.enqueued.length, 1);
    assert.deepStrictEqual(Object.keys(h.enqueued[0]).sort(), ['description', 'id', 'title'],
      'only known fields plus the id may reach the queue');
    assert.ok(!('polluted' in Object.prototype), 'no prototype pollution');
    assert.ok(!Object.prototype.hasOwnProperty.call(h.enqueued[0], '__proto__'));
    assert.ok(!Object.prototype.hasOwnProperty.call(h.enqueued[0], 'constructor'));
  } finally { await h.close(); }
}});

tests.push({ name: 'unknown routes and wrong methods -> uniform JSON 404 without stacks', fn: async () => {
  const h = await boot();
  try {
    const cases = [
      ['GET', '/v1/reports'],
      ['POST', '/healthz'],
      ['GET', '/admin'],
      ['GET', '/v1/reports/1'],
      ['DELETE', '/v1/reports'],
    ];
    for (const [method, path] of cases) {
      const { res, json } = await request(h.base, path, { method });
      assert.strictEqual(res.status, 404, `${method} ${path} -> 404`);
      assert.strictEqual(json.error.code, 'not_found');
      assert.ok(!JSON.stringify(json).includes(' at '), `${method} ${path} must not leak a stack`);
    }
    assert.ok(!JSON.stringify(await (await fetch(h.base + '/nope')).json()).includes('at '));
  } finally { await h.close(); }
}});

tests.push({ name: 'X-Request-Id: generated, unique per request, echoed', fn: async () => {
  const h = await boot();
  try {
    const a = await request(h.base, '/v1/reports', { body: VALID });
    const b = await request(h.base, '/v1/reports', { body: VALID });
    const idA = a.res.headers.get('x-request-id');
    const idB = b.res.headers.get('x-request-id');
    assert.ok(idA && idB, 'every response carries X-Request-Id');
    assert.notStrictEqual(idA, idB, 'ids must be unique per request');
  } finally { await h.close(); }
}});

tests.push({ name: 'X-Request-Id: safe client value honoured, unsafe value replaced', fn: async () => {
  const h = await boot();
  try {
    const safe = await request(h.base, '/v1/reports', { body: VALID, headers: { 'x-request-id': 'trace-123' } });
    assert.strictEqual(safe.res.headers.get('x-request-id'), 'trace-123');
    const unsafe = await request(h.base, '/v1/reports', { body: VALID, headers: { 'x-request-id': 'abc/def' } });
    const got = unsafe.res.headers.get('x-request-id');
    assert.ok(got && got !== 'abc/def', 'out-of-pattern client ids must be replaced by a server id');
  } finally { await h.close(); }
}});

tests.push({ name: 'rate limit: per-IP quota in forwarded mode; other IPs unaffected; healthz unaffected', fn: async () => {
  const h = await boot({ ipSource: 'forwarded', limits: { ip: { max: 2, windowMs: 60_000 } } });
  try {
    const r1 = await request(h.base, '/v1/reports', { body: VALID, headers: { 'x-forwarded-for': '203.0.113.1' } });
    assert.strictEqual(r1.res.status, 202);
    const r2 = await request(h.base, '/v1/reports', { body: VALID, headers: { 'x-forwarded-for': '203.0.113.1' } });
    assert.strictEqual(r2.res.status, 202);
    const r3 = await request(h.base, '/v1/reports', { body: VALID, headers: { 'x-forwarded-for': '203.0.113.1' } });
    assert.strictEqual(r3.res.status, 429);
    assert.strictEqual(r3.json.error.code, 'rate_limited');
    assert.ok(Number(r3.res.headers.get('retry-after')) >= 1, 'Retry-After header must be set');
    const other = await request(h.base, '/v1/reports', { body: VALID, headers: { 'x-forwarded-for': '198.51.100.9' } });
    assert.strictEqual(other.res.status, 202, 'a different IP keeps its own quota');
  } finally { await h.close(); }
}});

tests.push({ name: 'rate limit: per-instance quota -> 429 with Retry-After', fn: async () => {
  const h = await boot({ limits: { instance: { max: 2, windowMs: 60_000 } } });
  try {
    assert.strictEqual((await request(h.base, '/v1/reports', { body: VALID })).res.status, 202);
    assert.strictEqual((await request(h.base, '/v1/reports', { body: VALID })).res.status, 202);
    const r3 = await request(h.base, '/v1/reports', { body: VALID });
    assert.strictEqual(r3.res.status, 429);
    assert.strictEqual(r3.json.error.code, 'rate_limited');
    assert.ok(Number(r3.res.headers.get('retry-after')) >= 1);
  } finally { await h.close(); }
}});

tests.push({ name: 'rate limit: socket ipSource ignores X-Forwarded-For (spoof-proof)', fn: async () => {
  const h = await boot({ limits: { ip: { max: 1, windowMs: 60_000 } } });
  try {
    const a = await request(h.base, '/v1/reports', { body: VALID, headers: { 'x-forwarded-for': '203.0.113.1' } });
    assert.strictEqual(a.res.status, 202);
    const b = await request(h.base, '/v1/reports', { body: VALID, headers: { 'x-forwarded-for': '198.51.100.9' } });
    assert.strictEqual(b.res.status, 429, 'both requests share the socket peer and must share the quota');
  } finally { await h.close(); }
}});

tests.push({ name: 'POST /v1/reports: hanging enqueue -> 503 timeout (single response)', fn: async () => {
  const h = await boot({ enqueue: () => new Promise(() => {}), requestTimeoutMs: 60 });
  try {
    const { res, json } = await request(h.base, '/v1/reports', { body: VALID });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(json.error.code, 'timeout');
  } finally { await h.close(); }
}});

tests.push({ name: 'POST /v1/reports: enqueue failure -> 503 generic; token redacted from logs', fn: async () => {
  const secret = 'ghp_T0PSECRET123456';
  const h = await boot({
    enqueue: async () => { throw new Error('github api failed with ' + secret); },
  });
  try {
    const { res, json } = await request(h.base, '/v1/reports', { body: VALID });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(json.error.code, 'unavailable');
    const bodyText = JSON.stringify(json);
    assert.ok(!bodyText.includes('T0PSECRET'));
    assert.ok(!bodyText.includes('github api'));
    assert.ok(!bodyText.includes(' at '));
    const errLog = h.logs.find((l) => l.level === 'error' && l.event === 'relay.http.error');
    assert.ok(errLog, 'an error log entry must exist');
    assert.ok(!errLog.detail.includes('T0PSECRET'), 'logged error detail must be redacted');
  } finally { await h.close(); }
}});

tests.push({ name: 'CORS: no headers by default; allowlist honours only listed origins', fn: async () => {
  const plain = await boot();
  try {
    const r = await request(plain.base, '/v1/reports', { body: VALID, headers: { origin: 'https://fleetdeck.example' } });
    assert.strictEqual(r.res.headers.get('access-control-allow-origin'), null, 'no CORS headers by default');
  } finally { await plain.close(); }

  const h = await boot({ allowedOrigins: ['https://fleetdeck.example'] });
  try {
    const ok = await request(h.base, '/v1/reports', { body: VALID, headers: { origin: 'https://fleetdeck.example' } });
    assert.strictEqual(ok.res.headers.get('access-control-allow-origin'), 'https://fleetdeck.example');
    const bad = await request(h.base, '/v1/reports', { body: VALID, headers: { origin: 'https://evil.example' } });
    assert.strictEqual(bad.res.headers.get('access-control-allow-origin'), null, 'non-listed origin gets no CORS header');
    const pre = await request(h.base, '/v1/reports', {
      method: 'OPTIONS',
      headers: { origin: 'https://fleetdeck.example', 'access-control-request-method': 'POST' },
    });
    assert.strictEqual(pre.res.status, 204, 'preflight for a listed origin -> 204');
  } finally { await h.close(); }
}});

tests.push({ name: 'responses set nosniff and carry no internal details', fn: async () => {
  const h = await boot();
  try {
    const { res } = await request(h.base, '/v1/reports', { body: VALID });
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  } finally { await h.close(); }
}});

tests.push({ name: 'createRelayServer fails closed without an enqueue adapter', fn: () => {
  assert.throws(() => createRelayServer({}), /enqueue/);
}});

// --- boot --------------------------------------------------------------------

async function main() {
  let failed = 0;
  for (let i = 0; i < tests.length; i++) {
    try {
      await tests[i].fn();
      console.log(`ok  bug-report-relay-http test ${i + 1}: ${tests[i].name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL bug-report-relay-http test ${i + 1}: ${tests[i].name}: ${err && err.stack ? err.stack : err}`);
    }
  }
  if (failed) {
    console.error(`FAIL  ${failed} bug-report-relay-http test(s) failed`);
    process.exit(1);
  }
  console.log('PASS  bug-report-relay-http');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
