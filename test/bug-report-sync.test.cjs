'use strict';

/*
 * Bug-report sync worker tests — plan Task 3
 * (.hermes/plans/2026-08-14_235510-report-bug-github.md)
 *
 * Implementation contract under test — lib/bug-report-sync.cjs:
 *
 *   createSyncWorker(deps) -> { runOnce() }
 *     deps: {
 *       store,              // bug-reports storage module (defaults to lib/bug-reports.cjs)
 *       client,             // github-issues client (REQUIRED)
 *       buildBody?,         // (report) -> markdown body; defaults to a wrapper
 *                           // around lib/github-issues.cjs buildIssueBody using
 *                           // the stored columns (title/description/repro_steps/
 *                           // expected/route/view/game/actor_username/actor_id/
 *                           // created_at/version/user_agent/marker)
 *       now?,               // () -> ms timestamp (default Date.now; test seam)
 *       maxAttempts?,       // default 5
 *       backoffBaseMs?,     // default 60_000
 *       maxAgeMs?,          // default 30 days
 *       maxBatch?,          // default 10
 *       inFlight?,          // Set of report ids currently being synced
 *                           // (concurrency guard; default internal Set)
 *       logger?,            // { warn() } (default no-op)
 *     }
 *
 *   runOnce() -> { attempted, succeeded, failed, skipped }   (never rejects)
 *     For each report from store.listPending (ordered created_at ASC):
 *       1. skip if inFlight has the id (concurrent attempt protection)
 *       2. on a RETRY (report.attempts > 0), reconcile first:
 *            client.findIssueByMarker(report.marker)
 *              - found -> markSynced with the found issue; no create
 *              - null  -> proceed to create
 *              - throws -> record failure, do NOT create (duplicate risk)
 *       3. client.createIssue({ title, body: buildBody(report), marker })
 *            success -> store.markSynced(id, { issueNumber, issueUrl }, { now })
 *       4. any thrown error -> store.markFailed(id, { error, attempts }, { now })
 *            where attempts = report.attempts + 1 for retryable errors, and
 *            attempts = maxAttempts (budget exhausted, never selected again)
 *            for non-retryable errors (config/auth/validation failures).
 *     store.markSynced/markFailed are called with opts.now = now() so the
 *     whole flow is deterministic under an injected clock.
 *
 *   A failed GitHub sync never throws out of runOnce; the failure is recorded
 *   on the row. Reports are durable in SQLite BEFORE any network call.
 */

const assert = require('assert');
const fs = require('fs');
const { setupDataDir, teardown } = require('./_setup.cjs');
setupDataDir();

const { open, close, dbPath } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');
const bugReports = require('../lib/bug-reports.cjs');
const { createGitHubClient } = require('../lib/github-issues.cjs');
const { createSyncWorker } = require('../lib/bug-report-sync.cjs');

/* ── helpers ─────────────────────────────────────────────────────── */

const T0 = 1_700_000_000_000;
const TOKEN = 'ghp_sync_test_token_1234567890';
const ISSUE_URL_BASE = 'https://github.com/Riloox/hostkind-open/issues/';

function fresh() {
  close();
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath() + ext;
    if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch { /* */ }
  }
}

function runMigrationsFresh() {
  fresh();
  return migrations.runMigrations();
}

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (k in headers ? headers[k] : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function issueResponse(number) {
  return jsonResponse(201, { number, html_url: ISSUE_URL_BASE + number });
}

function sampleInput(overrides = {}) {
  return {
    actorId: 'user-123',
    actorUsername: 'alice',
    game: 'minecraft',
    view: 'servers',
    route: '/servers',
    title: 'Panel crashes on boot',
    description: 'After upgrading, the panel crashes with a white screen.',
    reproSteps: '1. Start the panel\n2. Open the dashboard',
    expected: 'It should boot normally.',
    userAgent: 'Mozilla/5.0 (fleetdeck test)',
    version: '0.1.0',
    ...overrides,
  };
}

/**
 * Build a test context: fresh DB + a client whose fetch is a call-queue.
 * `responses` may contain Response stubs, Errors (network failure), or
 * `(url, init) => response` functions (routing fakes).
 */
function makeContext({ responses = [], workerOverrides = {}, clientOverrides = {} } = {}) {
  runMigrationsFresh();
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(url, init);
    if (!next) throw new Error(`makeContext: no response queued for call ${calls.length}`);
    return next;
  };
  const client = createGitHubClient({
    token: TOKEN,
    owner: 'Riloox',
    repo: 'hostkind-open',
    fetch,
    ...clientOverrides,
  });
  let clock = T0;
  const worker = createSyncWorker({
    store: bugReports,
    client,
    now: () => clock,
    ...workerOverrides,
  });
  return { calls, client, worker, clock: () => clock, advance: (ms) => { clock += ms; } };
}

function createReport(input, opts) {
  return bugReports.create(sampleInput(input), { now: T0, ...opts });
}

/* ── tests ───────────────────────────────────────────────────────── */

const tests = [];

/* 1. The report is durable on disk BEFORE any network call happens. */
tests.push(async () => {
  const ctx = makeContext({ responses: [issueResponse(1)] });
  createReport({ marker: 'm-1' }, { id: 'r-1' });

  // Reopen the DB from disk: the report must survive independent of any sync.
  close(); open();
  const durable = bugReports.get('r-1');
  assert.ok(durable, 'report must be persisted before any sync attempt');
  assert.strictEqual(durable.sync_state, 'pending');
  assert.strictEqual(ctx.calls.length, 0, 'no network call may happen at persistence time');
  console.log('ok  sync: report persisted before any external call');
});

/* 2. Success: one POST, row synced, second run is a no-op. */
tests.push(async () => {
  const ctx = makeContext({ responses: [issueResponse(1)] });
  createReport({ marker: 'm-2' }, { id: 'r-2' });

  const first = await ctx.worker.runOnce();
  assert.deepStrictEqual(first, { attempted: 1, succeeded: 1, failed: 0, skipped: 0 });
  assert.strictEqual(ctx.calls.length, 1);
  assert.strictEqual(ctx.calls[0].init.method, 'POST');

  const row = bugReports.get('r-2');
  assert.strictEqual(row.sync_state, 'synced');
  assert.strictEqual(row.issue_number, 1);
  assert.strictEqual(row.issue_url, ISSUE_URL_BASE + '1');

  const second = await ctx.worker.runOnce();
  assert.deepStrictEqual(second, { attempted: 0, succeeded: 0, failed: 0, skipped: 0 });
  assert.strictEqual(ctx.calls.length, 1, 'synced reports must not be re-sent');
  console.log('ok  sync: success -> synced, idempotent re-run');
});

/* 3. Retryable failure respects exponential backoff, then succeeds. */
tests.push(async () => {
  // Retry path reconciles via search FIRST, so the queue is:
  // [failure, search-no-match, success].
  const ctx = makeContext({
    responses: [
      jsonResponse(500, { message: 'server exploded' }),
      jsonResponse(200, { items: [] }),
      issueResponse(2),
    ],
  });
  createReport({ marker: 'm-3' }, { id: 'r-3' });

  const first = await ctx.worker.runOnce();
  assert.deepStrictEqual(first, { attempted: 1, succeeded: 0, failed: 1, skipped: 0 });
  let row = bugReports.get('r-3');
  assert.strictEqual(row.sync_state, 'failed');
  assert.strictEqual(row.attempts, 1);
  assert.ok(row.last_error.includes('500'), 'last_error should describe the failure');
  assert.ok(!row.last_error.includes(TOKEN), 'last_error must be redacted');

  ctx.advance(59_999);
  const early = await ctx.worker.runOnce();
  assert.deepStrictEqual(early, { attempted: 0, succeeded: 0, failed: 0, skipped: 0 },
    'attempt 1 must wait the full 60s backoff');
  assert.strictEqual(ctx.calls.length, 1);

  ctx.advance(1); // total +60_000
  const retry = await ctx.worker.runOnce();
  assert.deepStrictEqual(retry, { attempted: 1, succeeded: 1, failed: 0, skipped: 0 });
  row = bugReports.get('r-3');
  assert.strictEqual(row.sync_state, 'synced');
  assert.strictEqual(row.issue_number, 2);
  assert.strictEqual(row.attempts, 1, 'attempts history preserved after success');
  console.log('ok  sync: retryable failure -> backoff -> retry -> synced');
});

/* 4. Retry limit: a report at maxAttempts is never selected again. */
tests.push(async () => {
  const ctx = makeContext({
    responses: [jsonResponse(500, {}), jsonResponse(500, {})],
    workerOverrides: { maxAttempts: 2 },
  });
  createReport({ marker: 'm-4' }, { id: 'r-4' });

  await ctx.worker.runOnce();                    // attempts 1
  ctx.advance(60_000);
  await ctx.worker.runOnce();                    // attempts 2 = maxAttempts
  const row = bugReports.get('r-4');
  assert.strictEqual(row.attempts, 2);
  assert.strictEqual(row.sync_state, 'failed');

  ctx.advance(1_000_000);                        // plenty of time
  const out = await ctx.worker.runOnce();
  assert.deepStrictEqual(out, { attempted: 0, succeeded: 0, failed: 0, skipped: 0 },
    'exhausted reports must never be retried');
  assert.strictEqual(ctx.calls.length, 2, 'no further POSTs allowed');
  console.log('ok  sync: retry limit enforced');
});

/* 5. Non-retryable failure (401) exhausts the budget immediately. */
tests.push(async () => {
  const ctx = makeContext({ responses: [jsonResponse(401, { message: 'Bad credentials' })] });
  createReport({ marker: 'm-5' }, { id: 'r-5' });

  const out = await ctx.worker.runOnce();
  assert.deepStrictEqual(out, { attempted: 1, succeeded: 0, failed: 1, skipped: 0 });
  const row = bugReports.get('r-5');
  assert.strictEqual(row.sync_state, 'failed');
  assert.strictEqual(row.attempts, 5, 'non-retryable failure must exhaust the budget');
  assert.ok(row.last_error.includes('401'));

  ctx.advance(1_000_000);
  const again = await ctx.worker.runOnce();
  assert.deepStrictEqual(again, { attempted: 0, succeeded: 0, failed: 0, skipped: 0 },
    'a broken configuration must not be hammered');
  assert.strictEqual(ctx.calls.length, 1);
  console.log('ok  sync: 401 config failure exhausts retry budget');
});

/* 6. Rate limit (429) is recorded and retried after backoff. */
tests.push(async () => {
  const ctx = makeContext({
    responses: [
      jsonResponse(429, { message: 'API rate limit exceeded' }, { 'retry-after': '120' }),
      jsonResponse(200, { items: [] }),
      issueResponse(6),
    ],
  });
  createReport({ marker: 'm-6' }, { id: 'r-6' });

  const first = await ctx.worker.runOnce();
  assert.deepStrictEqual(first, { attempted: 1, succeeded: 0, failed: 1, skipped: 0 });
  let row = bugReports.get('r-6');
  assert.strictEqual(row.attempts, 1, '429 is retryable, budget not exhausted');
  assert.ok(row.last_error.toLowerCase().includes('rate limit'));

  ctx.advance(60_000);
  await ctx.worker.runOnce();
  row = bugReports.get('r-6');
  assert.strictEqual(row.sync_state, 'synced');
  assert.strictEqual(row.issue_number, 6);
  console.log('ok  sync: 429 recorded, retried after backoff');
});

/* 7. Network failure is retryable; nothing is marked synced. */
tests.push(async () => {
  const ctx = makeContext({
    responses: [
      new TypeError('fetch failed'),
      jsonResponse(200, { items: [] }),
      issueResponse(7),
    ],
  });
  createReport({ marker: 'm-7' }, { id: 'r-7' });

  const first = await ctx.worker.runOnce();
  assert.deepStrictEqual(first, { attempted: 1, succeeded: 0, failed: 1, skipped: 0 });
  let row = bugReports.get('r-7');
  assert.strictEqual(row.sync_state, 'failed');
  assert.strictEqual(row.attempts, 1);
  assert.ok(!row.last_error.includes(TOKEN), 'network error text must be redacted');

  ctx.advance(60_000);
  await ctx.worker.runOnce();
  row = bugReports.get('r-7');
  assert.strictEqual(row.sync_state, 'synced', 'network failure must be safe to retry');
  assert.strictEqual(row.issue_number, 7);
  console.log('ok  sync: network failure retryable and safe');
});

/* 8. Marker reconciliation: an existing issue is reused, no duplicate created. */
tests.push(async () => {
  const ctx = makeContext({
    responses: [
      (url, init) => {
        assert.strictEqual(init.method, 'GET', 'reconciliation must search, not create');
        assert.ok(url.includes('/search/issues'));
        return jsonResponse(200, {
          items: [{ number: 99, html_url: ISSUE_URL_BASE + '99' }],
        });
      },
    ],
  });
  createReport({ marker: 'fleetdeck-m-8' }, { id: 'r-8' });
  // Simulate a prior ambiguous failure (timeout after POST may have landed).
  bugReports.markFailed('r-8', { error: 'network timeout', attempts: 1 }, { now: T0 });
  ctx.advance(60_000);

  const out = await ctx.worker.runOnce();
  assert.deepStrictEqual(out, { attempted: 1, succeeded: 1, failed: 0, skipped: 0 });
  const row = bugReports.get('r-8');
  assert.strictEqual(row.sync_state, 'synced');
  assert.strictEqual(row.issue_number, 99, 'must adopt the existing issue, not create one');
  assert.strictEqual(ctx.calls.length, 1, 'no POST may be issued when the issue already exists');
  console.log('ok  sync: marker reconciliation reuses existing issue');
});

/* 9. Marker reconciliation: no existing issue -> create proceeds. */
tests.push(async () => {
  const ctx = makeContext({
    responses: [
      jsonResponse(200, { items: [] }),
      issueResponse(100),
    ],
  });
  createReport({ marker: 'fleetdeck-m-9' }, { id: 'r-9' });
  bugReports.markFailed('r-9', { error: 'network timeout', attempts: 1 }, { now: T0 });
  ctx.advance(60_000);

  const out = await ctx.worker.runOnce();
  assert.deepStrictEqual(out, { attempted: 1, succeeded: 1, failed: 0, skipped: 0 });
  const row = bugReports.get('r-9');
  assert.strictEqual(row.sync_state, 'synced');
  assert.strictEqual(row.issue_number, 100);
  assert.strictEqual(ctx.calls.length, 2, 'search + create expected');
  console.log('ok  sync: marker reconciliation falls through to create');
});

/* 10. Marker reconciliation failure: do NOT create (duplicate risk), record it. */
tests.push(async () => {
  const ctx = makeContext({
    responses: [jsonResponse(403, { message: 'search quota exceeded' })],
  });
  createReport({ marker: 'fleetdeck-m-10' }, { id: 'r-10' });
  bugReports.markFailed('r-10', { error: 'network timeout', attempts: 1 }, { now: T0 });
  ctx.advance(60_000);

  const out = await ctx.worker.runOnce();
  assert.deepStrictEqual(out, { attempted: 1, succeeded: 0, failed: 1, skipped: 0 });
  const row = bugReports.get('r-10');
  assert.strictEqual(row.sync_state, 'failed');
  assert.strictEqual(row.attempts, 5, 'search failure classified non-retryable (403)');
  assert.strictEqual(ctx.calls.length, 1, 'no POST after an ambiguous search');
  console.log('ok  sync: ambiguous search never creates a duplicate');
});

/* 11. Concurrent runs never attempt the same report twice. */
tests.push(async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let postCalls = 0;
  const client = createGitHubClient({
    token: TOKEN,
    owner: 'Riloox',
    repo: 'hostkind-open',
    fetch: async () => {
      postCalls++;
      await gate;
      return issueResponse(11);
    },
  });
  runMigrationsFresh();
  createReport({ marker: 'm-11' }, { id: 'r-11' });
  let clock = T0;
  const worker = createSyncWorker({ store: bugReports, client, now: () => clock });

  const p1 = worker.runOnce();                       // parks at the fetch
  await new Promise((r) => setImmediate(r));
  const p2 = worker.runOnce();                       // must skip the in-flight report
  release();
  const [r1c, r2c] = await Promise.all([p1, p2]);

  assert.strictEqual(postCalls, 1, 'the same report must never be POSTed concurrently');
  assert.deepStrictEqual(r1c, { attempted: 1, succeeded: 1, failed: 0, skipped: 0 });
  assert.deepStrictEqual(r2c, { attempted: 0, succeeded: 0, failed: 0, skipped: 1 });
  assert.strictEqual(bugReports.get('r-11').sync_state, 'synced');
  console.log('ok  sync: concurrent runs protected by in-flight guard');
});

/* 12. A pre-seeded in-flight guard skips the report deterministically. */
tests.push(async () => {
  const ctx = makeContext({
    responses: [issueResponse(12)],
    workerOverrides: { inFlight: new Set(['r-12']) },
  });
  createReport({ marker: 'm-12' }, { id: 'r-12' });

  const out = await ctx.worker.runOnce();
  assert.deepStrictEqual(out, { attempted: 0, succeeded: 0, failed: 0, skipped: 1 });
  assert.strictEqual(ctx.calls.length, 0);
  assert.strictEqual(bugReports.get('r-12').sync_state, 'pending', 'unclaimed report stays pending');
  console.log('ok  sync: pre-seeded in-flight guard skips');
});

/* 13. maxBatch bounds each run; every report eventually syncs. */
tests.push(async () => {
  const ctx = makeContext({
    responses: [issueResponse(1), issueResponse(2)],
    workerOverrides: { maxBatch: 1 },
  });
  createReport({ marker: 'm-13a' }, { id: 'r-13a', now: T0 });
  createReport({ marker: 'm-13b' }, { id: 'r-13b', now: T0 + 1 });

  const first = await ctx.worker.runOnce();
  assert.strictEqual(first.attempted, 1, 'batch of 1 must process a single report');
  assert.strictEqual(ctx.calls.length, 1);
  const second = await ctx.worker.runOnce();
  assert.strictEqual(second.attempted, 1);
  assert.strictEqual(ctx.calls.length, 2);
  assert.strictEqual(bugReports.get('r-13a').sync_state, 'synced');
  assert.strictEqual(bugReports.get('r-13b').sync_state, 'synced');
  console.log('ok  sync: maxBatch bounds each run');
});

/* 14. Mixed outcomes: one success + one failure, counts reported, no throw. */
tests.push(async () => {
  const ctx = makeContext({
    responses: [issueResponse(1), jsonResponse(500, { message: 'boom' })],
  });
  createReport({ marker: 'm-14a' }, { id: 'r-14a', now: T0 });
  createReport({ marker: 'm-14b' }, { id: 'r-14b', now: T0 + 1 });

  const out = await ctx.worker.runOnce();            // must resolve, never reject
  assert.deepStrictEqual(out, { attempted: 2, succeeded: 1, failed: 1, skipped: 0 });
  assert.strictEqual(bugReports.get('r-14a').sync_state, 'synced');
  const failed = bugReports.get('r-14b');
  assert.strictEqual(failed.sync_state, 'failed');
  assert.strictEqual(failed.attempts, 1);
  assert.ok(!failed.last_error.includes(TOKEN));
  console.log('ok  sync: mixed outcomes resolved, failures isolated');
});

/* 15. The default buildBody wires stored columns into the GitHub issue body. */
tests.push(async () => {
  const ctx = makeContext({ responses: [issueResponse(15)] });
  createReport({
    marker: 'fleetdeck-m-15',
    title: 'Crash on boot',
    description: 'White screen after upgrade.',
    game: 'minecraft',
    route: '/servers',
    view: 'servers',
    reproSteps: '1. Start panel',
    expected: 'Boots normally.',
    userAgent: 'Mozilla/5.0 (fleetdeck test)',
    version: '0.1.0',
    actorUsername: 'alice',
    actorId: 'user-123',
  }, { id: 'r-15' });

  await ctx.worker.runOnce();
  const payload = JSON.parse(ctx.calls[0].init.body);
  assert.strictEqual(payload.title, '[In-app report] Crash on boot');
  assert.ok(payload.body.includes('## Summary'));
  assert.ok(payload.body.includes('## Description'));
  assert.ok(payload.body.includes('White screen after upgrade.'));
  assert.ok(payload.body.includes('## Game'));
  assert.ok(payload.body.includes('minecraft'));
  assert.ok(payload.body.includes('alice (user-123)'));
  assert.ok(payload.body.includes('fleetdeck-report-marker: fleetdeck-m-15'));
  assert.match(payload.body, /in-app reporter/i);
  assert.deepStrictEqual(payload.labels, ['bug', 'in-app-report']);
  console.log('ok  sync: default buildBody composes the issue from stored columns');
});

/* ── run ─────────────────────────────────────────────────────────── */

(async function main() {
  let failed = 0;
  for (let i = 0; i < tests.length; i++) {
    try { await tests[i](); }
    catch (e) {
      failed++;
      console.error(`FAIL  bug-report-sync test ${i + 1}: ${e.message}\n${e.stack}`);
    }
  }
  close();
  teardown();
  if (failed) { console.error(`FAIL  ${failed} bug-report-sync test(s) failed`); process.exit(1); }
  console.log(`PASS  bug-report-sync (${tests.length} tests)`);
})();
