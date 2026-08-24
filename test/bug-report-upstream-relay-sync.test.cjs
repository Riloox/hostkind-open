'use strict';

/*
 * bug-report upstream-relay client + one-shot sync state machine.
 *
 * Contract under test (lib/bug-report-config.cjs):
 *   buildRelayPayload(report)  — structured, redacted payload containing ONLY
 *                                the relay's allowlisted fields
 *                                (relay/lib/validate-report.cjs): title,
 *                                description, reproSteps, expected, game,
 *                                view, route, userAgent, version, clientKey.
 *                                Actor identity is deliberately NOT forwarded
 *                                (reports become public issue content).
 *   createRelayClient({ relayUrl, fetch, timeoutMs }) — POSTs to the fixed
 *                                URL; resolves { status, body, payload } for
 *                                every HTTP answer (4xx/5xx included) and
 *                                throws only on transport failure/timeout,
 *                                with err.retryable = true.
 *   syncReportToRelay(report, deps) — the syncBugReportNow state machine:
 *                                issueUrl returned  -> markSynced + 'synced'
 *                                202/queued (no url) -> row left pending with
 *                                                      a useful message
 *                                any other status   -> markFailed attempts+1
 *                                transport failure  -> markFailed attempts+1
 *                                NEVER throws.
 *
 * All tests are offline: fetch is injected and the relay URL is a localhost
 * http URL (only ever used through the injected fetch, never actually
 * contacted).
 */

const assert = require('assert');

const {
  buildRelayPayload,
  createRelayClient,
  syncReportToRelay,
} = require('../lib/bug-report-config.cjs');

const RELAY_URL = 'http://localhost:8787/v1/reports';

const tests = [];

/* ── helpers ─────────────────────────────────────────────────────── */

// snake_case row, the shape lib/bug-reports.cjs returns from SQLite.
function sampleRow(overrides = {}) {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    actor_id: 'user-123',
    actor_username: 'alice@example.com',
    created_at: 1700000000000,
    game: 'minecraft',
    view: 'servers',
    route: '/servers',
    title: 'Panel crashes on boot',
    description: 'After upgrading, the panel crashes with a white screen.',
    repro_steps: '1. Start the panel\n2. Open the dashboard',
    expected: 'It should boot normally.',
    user_agent: 'Mozilla/5.0 (fleetdeck test)',
    version: '0.1.0',
    sync_state: 'pending',
    issue_number: null,
    issue_url: null,
    marker: 'fleetdeck-marker-1234567890',
    last_error: null,
    attempts: 0,
    updated_at: 1700000000000,
    ...overrides,
  };
}

function jsonResponse(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

// fetch fake: records every call, serves queued responses (Error = network
// failure; function = route on url/init).
function makeFetchQueue(...responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(url, init);
    if (!next) throw new Error(`makeFetchQueue: no response queued for call ${calls.length}`);
    return next;
  };
  return { fetch, calls };
}

function makeSpies() {
  const calls = { synced: [], failed: [] };
  return {
    markSynced: (id, meta) => { calls.synced.push({ id, meta }); },
    markFailed: (id, meta) => { calls.failed.push({ id, meta }); },
    calls,
  };
}

/* ── buildRelayPayload ───────────────────────────────────────────── */

tests.push({ name: 'payload maps snake_case row to relay allowlist fields with clientKey from marker', fn: () => {
  const payload = buildRelayPayload(sampleRow());
  assert.strictEqual(payload.title, 'Panel crashes on boot');
  assert.strictEqual(payload.description, 'After upgrading, the panel crashes with a white screen.');
  assert.strictEqual(payload.reproSteps, '1. Start the panel\n2. Open the dashboard');
  assert.strictEqual(payload.expected, 'It should boot normally.');
  assert.strictEqual(payload.game, 'minecraft');
  assert.strictEqual(payload.view, 'servers');
  assert.strictEqual(payload.route, '/servers');
  assert.strictEqual(payload.userAgent, 'Mozilla/5.0 (fleetdeck test)');
  assert.strictEqual(payload.version, '0.1.0');
  assert.strictEqual(payload.clientKey, 'fleetdeck-marker-1234567890');
  // Only allowlisted keys reach the wire: no identity, no marker, no secrets.
  assert.deepStrictEqual(
    Object.keys(payload).sort(),
    ['clientKey', 'description', 'expected', 'game', 'reproSteps', 'route', 'title', 'userAgent', 'version', 'view']
  );
}});

tests.push({ name: 'camelCase row accepted too', fn: () => {
  const row = sampleRow();
  const camel = {
    id: row.id,
    title: row.title,
    description: row.description,
    reproSteps: row.repro_steps,
    expected: row.expected,
    game: row.game,
    view: row.view,
    route: row.route,
    userAgent: row.user_agent,
    version: row.version,
    marker: row.marker,
  };
  const payload = buildRelayPayload(camel);
  assert.strictEqual(payload.reproSteps, row.repro_steps);
  assert.strictEqual(payload.clientKey, row.marker);
}});

tests.push({ name: 'clientKey falls back to fleetdeck-<id> when marker is missing or unsafe', fn: () => {
  const safe = buildRelayPayload(sampleRow({ marker: null }));
  assert.strictEqual(safe.clientKey, 'fleetdeck-11111111-2222-3333-4444-555555555555');
  assert.match(safe.clientKey, /^[A-Za-z0-9._-]{8,100}$/, 'must satisfy the relay clientKey pattern');
  const unsafe = buildRelayPayload(sampleRow({ marker: 'has spaces and ümlauts' }));
  assert.strictEqual(unsafe.clientKey, 'fleetdeck-11111111-2222-3333-4444-555555555555');
}});

tests.push({ name: 'payload is redacted: secrets never leave the server', fn: () => {
  const row = sampleRow({
    description: 'Login with password=hunter2 then paste ghp_abcdef1234567890 and Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc.def',
  });
  const payload = buildRelayPayload(row);
  assert.ok(!payload.description.includes('hunter2'), 'password value must be masked');
  assert.ok(!payload.description.includes('ghp_abcdef1234567890'), 'github PAT must be masked');
  assert.ok(!payload.description.includes('eyJhbGciOiJIUzI1NiJ9'), 'JWT must be masked');
  assert.ok(payload.description.includes('[REDACTED]'), 'mask marker present');
}});

tests.push({ name: 'payload never carries token/password-shaped keys even if the row does', fn: () => {
  const payload = buildRelayPayload(sampleRow({ token: 'ghp_sneaky', password: 'p4ss' }));
  assert.ok(!('token' in payload));
  assert.ok(!('password' in payload));
}});

/* ── createRelayClient.submit ────────────────────────────────────── */

tests.push({ name: 'submit POSTs JSON to the fixed relayUrl with content-type application/json', fn: async () => {
  const { fetch, calls } = makeFetchQueue(jsonResponse(202, { id: 'r1', state: 'queued', issueUrl: null }));
  const client = createRelayClient({ relayUrl: RELAY_URL, fetch });
  const row = sampleRow();
  const result = await client.submit(row);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, RELAY_URL);
  assert.strictEqual(calls[0].init.method, 'POST');
  assert.strictEqual(calls[0].init.headers['content-type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), buildRelayPayload(row));
  assert.strictEqual(result.status, 202);
  assert.strictEqual(result.body.state, 'queued');
  assert.strictEqual(result.body.issueUrl, null);
}});

tests.push({ name: 'submit resolves (no throw) for 201 synced and 400 errors', fn: async () => {
  const synced = createRelayClient({
    relayUrl: RELAY_URL,
    fetch: makeFetchQueue(jsonResponse(201, { id: 'r1', state: 'synced', issueUrl: 'https://github.com/Riloox/hostkind-open/issues/42' })).fetch,
  });
  const ok = await synced.submit(sampleRow());
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.body.issueUrl, 'https://github.com/Riloox/hostkind-open/issues/42');

  const rejected = createRelayClient({
    relayUrl: RELAY_URL,
    fetch: makeFetchQueue(jsonResponse(400, { error: 'forbidden_field', errors: [], requestId: 'x' })).fetch,
  });
  const bad = await rejected.submit(sampleRow());
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.error, 'forbidden_field');
}});

tests.push({ name: 'submit resolves with body null when the relay answers non-JSON', fn: async () => {
  const fetch = makeFetchQueue({ status: 503, ok: false, json: async () => { throw new Error('not json'); } }).fetch;
  const client = createRelayClient({ relayUrl: RELAY_URL, fetch });
  const result = await client.submit(sampleRow());
  assert.strictEqual(result.status, 503);
  assert.strictEqual(result.body, null);
}});

tests.push({ name: 'submit network failure throws retryable relay_network_error', fn: async () => {
  const fetch = makeFetchQueue(new Error('ECONNREFUSED connect')).fetch;
  const client = createRelayClient({ relayUrl: RELAY_URL, fetch });
  try { await client.submit(sampleRow()); assert.fail('must throw'); }
  catch (err) {
    assert.strictEqual(err.retryable, true);
    assert.strictEqual(err.code, 'relay_network_error');
  }
}});

tests.push({ name: 'submit timeout throws retryable relay_timeout', fn: async () => {
  // fetch that never settles unless the AbortController signal fires.
  const fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const client = createRelayClient({ relayUrl: RELAY_URL, fetch, timeoutMs: 50 });
  try { await client.submit(sampleRow()); assert.fail('must throw'); }
  catch (err) {
    assert.strictEqual(err.retryable, true);
    assert.strictEqual(err.code, 'relay_timeout');
    assert.match(String(err.message), /timed out/i);
  }
}});

tests.push({ name: 'createRelayClient requires relayUrl', fn: () => {
  assert.throws(() => createRelayClient({ fetch: async () => {} }), /relayUrl is required/);
  assert.throws(() => createRelayClient({ relayUrl: '   ', fetch: async () => {} }), /relayUrl is required/);
}});

/* ── syncReportToRelay state machine ─────────────────────────────── */

tests.push({ name: '201 with issueUrl -> synced, row marked synced, no markFailed', fn: async () => {
  const { fetch } = makeFetchQueue(jsonResponse(201, { id: 'r1', state: 'synced', issueUrl: 'https://github.com/Riloox/hostkind-open/issues/42' }));
  const spies = makeSpies();
  const summary = await syncReportToRelay(sampleRow(), { relayUrl: RELAY_URL, fetch, ...spies });
  assert.strictEqual(summary.state, 'synced');
  assert.strictEqual(summary.issueUrl, 'https://github.com/Riloox/hostkind-open/issues/42');
  assert.strictEqual(summary.error, null);
  assert.strictEqual(spies.calls.synced.length, 1);
  assert.deepStrictEqual(spies.calls.synced[0], { id: '11111111-2222-3333-4444-555555555555', meta: { issueNumber: null, issueUrl: 'https://github.com/Riloox/hostkind-open/issues/42' } });
  assert.strictEqual(spies.calls.failed.length, 0);
}});

tests.push({ name: '202 queued -> pending with useful message, row untouched', fn: async () => {
  const { fetch } = makeFetchQueue(jsonResponse(202, { id: 'r1', state: 'queued', issueUrl: null }));
  const spies = makeSpies();
  const summary = await syncReportToRelay(sampleRow(), { relayUrl: RELAY_URL, fetch, ...spies });
  assert.strictEqual(summary.state, 'pending');
  assert.strictEqual(summary.reason, 'queued_upstream');
  assert.strictEqual(summary.issueUrl, null);
  assert.ok(typeof summary.message === 'string' && summary.message.length > 0, 'useful message required');
  assert.strictEqual(summary.error, null);
  assert.strictEqual(spies.calls.synced.length, 0);
  assert.strictEqual(spies.calls.failed.length, 0, '202 must not mark the row failed or synced');
}});

tests.push({ name: '202 that (unexpectedly) carries an issueUrl -> synced (contract: issueUrl wins)', fn: async () => {
  const { fetch } = makeFetchQueue(jsonResponse(202, { id: 'r1', state: 'queued', issueUrl: 'https://github.com/Riloox/hostkind-open/issues/9' }));
  const spies = makeSpies();
  const summary = await syncReportToRelay(sampleRow(), { relayUrl: RELAY_URL, fetch, ...spies });
  assert.strictEqual(summary.state, 'synced');
  assert.strictEqual(summary.issueUrl, 'https://github.com/Riloox/hostkind-open/issues/9');
  assert.strictEqual(spies.calls.synced.length, 1);
}});

tests.push({ name: '5xx -> failed relay_rejected, markFailed with attempts+1, error mentions HTTP status', fn: async () => {
  const { fetch } = makeFetchQueue(jsonResponse(503, { error: { code: 'unavailable', message: 'service temporarily unavailable' } }));
  const spies = makeSpies();
  const summary = await syncReportToRelay(sampleRow({ attempts: 2 }), { relayUrl: RELAY_URL, fetch, ...spies });
  assert.strictEqual(summary.state, 'failed');
  assert.strictEqual(summary.reason, 'relay_rejected');
  assert.match(summary.error, /HTTP 503/);
  assert.strictEqual(spies.calls.failed.length, 1);
  assert.strictEqual(spies.calls.failed[0].id, '11111111-2222-3333-4444-555555555555');
  assert.strictEqual(spies.calls.failed[0].meta.attempts, 3, 'attempts must bump by one (retryable)');
  assert.ok(spies.calls.failed[0].meta.error.includes('unavailable'));
}});

tests.push({ name: '400 validation -> failed relay_rejected, code surfaced, no submitted value leaked', fn: async () => {
  const { fetch } = makeFetchQueue(jsonResponse(400, { error: 'forbidden_field', errors: [], requestId: 'rid' }));
  const spies = makeSpies();
  const row = sampleRow();
  const summary = await syncReportToRelay(row, { relayUrl: RELAY_URL, fetch, ...spies });
  assert.strictEqual(summary.state, 'failed');
  assert.match(summary.error, /HTTP 400: forbidden_field/);
  assert.ok(!summary.error.includes('ghp_'), 'no secret in the error');
  assert.strictEqual(spies.calls.failed.length, 1);
  assert.strictEqual(spies.calls.failed[0].meta.attempts, 1);
}});

tests.push({ name: 'network failure -> failed relay_unreachable, markFailed attempts+1, never throws', fn: async () => {
  const { fetch } = makeFetchQueue(new Error('socket hang up'));
  const spies = makeSpies();
  const summary = await syncReportToRelay(sampleRow(), { relayUrl: RELAY_URL, fetch, ...spies });
  assert.strictEqual(summary.state, 'failed');
  assert.strictEqual(summary.reason, 'relay_unreachable');
  assert.strictEqual(spies.calls.failed.length, 1);
  assert.strictEqual(spies.calls.failed[0].meta.attempts, 1);
}});

tests.push({ name: 'timeout -> failed relay_timeout, retryable', fn: async () => {
  const fetch = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const spies = makeSpies();
  const summary = await syncReportToRelay(sampleRow(), { relayUrl: RELAY_URL, fetch, timeoutMs: 50, ...spies });
  assert.strictEqual(summary.state, 'failed');
  assert.strictEqual(summary.reason, 'relay_timeout');
  assert.strictEqual(spies.calls.failed.length, 1);
  assert.match(spies.calls.failed[0].meta.error, /timed out/i);
}});

tests.push({ name: 'missing relayUrl -> pending not_configured, fetch never called', fn: async () => {
  const { fetch, calls } = makeFetchQueue();
  const spies = makeSpies();
  const summary = await syncReportToRelay(sampleRow(), { relayUrl: '', fetch, ...spies });
  assert.strictEqual(summary.state, 'pending');
  assert.strictEqual(summary.reason, 'not_configured');
  assert.ok(summary.message.length > 0);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(spies.calls.failed.length, 0);
  assert.strictEqual(spies.calls.synced.length, 0);
  assert.strictEqual(summary.trackerUrl, null, 'no trackerUrl when the caller did not supply one');
}});

tests.push({ name: 'missing relayUrl summary carries the caller-supplied trackerUrl', fn: async () => {
  const { fetch, calls } = makeFetchQueue();
  const spies = makeSpies();
  const summary = await syncReportToRelay(sampleRow(), {
    relayUrl: '',
    fetch,
    trackerUrl: 'https://github.com/Riloox/hostkind-open/issues/new/choose',
    ...spies,
  });
  assert.strictEqual(summary.state, 'pending');
  assert.strictEqual(summary.reason, 'not_configured');
  assert.strictEqual(summary.trackerUrl, 'https://github.com/Riloox/hostkind-open/issues/new/choose', 'user-facing fallback link must survive to the UI');
  assert.strictEqual(calls.length, 0, 'no relay contact when unconfigured');
  assert.strictEqual(spies.calls.failed.length, 0);
  assert.strictEqual(spies.calls.synced.length, 0);
}});

tests.push({ name: 'syncReportToRelay never throws even when store seams throw', fn: async () => {
  const { fetch } = makeFetchQueue(jsonResponse(201, { id: 'r1', state: 'synced', issueUrl: 'https://github.com/Riloox/hostkind-open/issues/1' }));
  const throwing = {
    markSynced: () => { throw new Error('db locked'); },
    markFailed: () => { throw new Error('db locked'); },
  };
  const summary = await syncReportToRelay(sampleRow(), { relayUrl: RELAY_URL, fetch, ...throwing });
  assert.strictEqual(summary.state, 'synced', 'sync outcome survives a storage failure');
}});

/* ── run ─────────────────────────────────────────────────────────── */

(async function main() {
  let failed = 0;
  for (let i = 0; i < tests.length; i++) {
    try { await tests[i].fn(); console.log(`ok  bug-report-upstream-relay-sync test ${i + 1}: ${tests[i].name}`); }
    catch (e) { failed++; console.error(`FAIL bug-report-upstream-relay-sync test ${i + 1}: ${tests[i].name}: ${e.message}`); }
  }
  if (failed) { console.error(`FAIL  ${failed} bug-report-upstream-relay-sync test(s) failed`); process.exit(1); }
  console.log('PASS  bug-report-upstream-relay-sync');
})();
