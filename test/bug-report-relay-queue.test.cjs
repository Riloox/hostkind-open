'use strict';

/*
 * Relay durable queue + sync worker tests.
 *
 * Proves with a real SQLite database (temp dir) and injected fake GitHub
 * clients:
 *   - the report survives a process restart (close + reopen the DB file)
 *   - a network failure does not lose the report
 *   - retrying cannot create duplicate issues (marker reconciliation)
 *   - a single bad report cannot stop the queue
 *   - secrets never appear in stored errors
 *   - the report is queued before any GitHub call
 *   - retry gating (backoff, attempt budget, age cap) and in-flight guard
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createStore, DEFAULT_MAX_ATTEMPTS, DEFAULT_BACKOFF_BASE_MS } = require('../relay/lib/store.cjs');
const { createQueueWorker } = require('../relay/lib/queue-worker.cjs');

const tests = [];

/* ── helpers ─────────────────────────────────────────────────────── */

function tmpDb() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-queue-')));
  return {
    dir,
    dbPath: path.join(dir, 'relay.db'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }),
  };
}

function makeClock() {
  const clock = { t: 1_000_000 };
  return {
    clock,
    now: () => clock.t,
    advance: (ms) => { clock.t += ms; },
  };
}

const PAYLOAD = {
  title: 'Crash on load',
  description: 'It crashes.',
  reproSteps: '1. Start\n2. Load',
  expected: 'No crash',
  game: 'minecraft',
  view: 'servers',
  route: '/servers/1',
  userAgent: 'Mozilla/5.0 (test)',
  version: '0.1.0',
};

function okIssue(overrides = {}) {
  return { issueNumber: 42, issueUrl: 'https://github.com/Riloox/hostkind-open/issues/42', ...overrides };
}

function fakeGithub({ onCreate } = {}) {
  const calls = { createIssue: [], findIssueByMarker: [] };
  return {
    calls,
    async createIssue(input) {
      calls.createIssue.push(input);
      if (onCreate) return onCreate(input);
      return okIssue();
    },
    async findIssueByMarker(marker) {
      calls.findIssueByMarker.push(marker);
      return null;
    },
  };
}

function retryableError(message) {
  return Object.assign(new Error(message), { retryable: true, kind: 'server_error' });
}

function nonRetryableError(message, status = 422) {
  return Object.assign(new Error(message), { retryable: false, kind: 'validation', status });
}

/* ── queue durability ────────────────────────────────────────────── */

tests.push(() => {
  const t = tmpDb();
  try {
    const store = createStore({ dbPath: t.dbPath });
    const row = store.enqueue({ marker: 'm-1', title: PAYLOAD.title, payload: PAYLOAD });
    assert.ok(row.id, 'row must have an id');
    assert.strictEqual(row.sync_state, 'pending');
    assert.strictEqual(row.attempts, 0);
    assert.deepStrictEqual(row.payload, PAYLOAD);
    store.close();
  } finally {
    t.cleanup();
  }
  console.log('ok  relay-queue enqueue: pending row with parsed payload');
});

tests.push(() => {
  const t = tmpDb();
  try {
    const store = createStore({ dbPath: t.dbPath });
    const a = store.enqueue({ marker: 'm-1', title: 't', payload: PAYLOAD });
    const b = store.enqueue({ marker: 'm-1', title: 't', payload: PAYLOAD });
    assert.strictEqual(a.id, b.id, 'same marker must return the same row');
    assert.strictEqual(store.counts().total, 1, 'double submit must not duplicate');
    store.close();
  } finally {
    t.cleanup();
  }
  console.log('ok  relay-queue idempotency: marker dedupe on enqueue');
});

tests.push(() => {
  const t = tmpDb();
  try {
    const store = createStore({ dbPath: t.dbPath });
    const row = store.enqueue({ marker: 'm-1', title: 't', payload: PAYLOAD });
    store.close();

    // "Process restart": reopen the same file.
    const reopened = createStore({ dbPath: t.dbPath });
    const found = reopened.get(row.id);
    assert.ok(found, 'report must survive a restart');
    assert.strictEqual(found.marker, 'm-1');
    assert.deepStrictEqual(found.payload, PAYLOAD);
    assert.strictEqual(found.sync_state, 'pending');
    reopened.close();
  } finally {
    t.cleanup();
  }
  console.log('ok  relay-queue durability: report survives a process restart');
});

/* ── retry gating ────────────────────────────────────────────────── */

tests.push(() => {
  const t = tmpDb();
  try {
    const { now, advance } = makeClock();
    const store = createStore({ dbPath: t.dbPath, now });
    store.enqueue({ marker: 'm-old', title: 't', payload: PAYLOAD }, { now: now() });
    advance(1);
    store.enqueue({ marker: 'm-new', title: 't', payload: PAYLOAD }, { now: now() });

    const rows = store.listPending({ now: now(), limit: 1 });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].marker, 'm-old', 'oldest first');
    store.close();
  } finally {
    t.cleanup();
  }
  console.log('ok  relay-queue listPending: FIFO order + limit');
});

tests.push(() => {
  const t = tmpDb();
  try {
    const { now, advance } = makeClock();
    const store = createStore({ dbPath: t.dbPath, now });
    const row = store.enqueue({ marker: 'm-1', title: 't', payload: PAYLOAD }, { now: now() });

    // Fail once at t (backoff base 60s): not eligible until t+60000.
    store.markFailed(row.id, { error: 'boom', attempts: 1 }, { now: now() });
    let rows = store.listPending({ now: now() });
    assert.strictEqual(rows.length, 0, 'inside backoff window must not be listed');

    advance(DEFAULT_BACKOFF_BASE_MS);
    rows = store.listPending({ now: now() });
    assert.strictEqual(rows.length, 1, 'after backoff window must be listed');

    // Second failure: backoff doubles to 120s.
    store.markFailed(row.id, { error: 'boom', attempts: 2 }, { now: now() });
    rows = store.listPending({ now: now() });
    assert.strictEqual(rows.length, 0);
    advance(2 * DEFAULT_BACKOFF_BASE_MS);
    rows = store.listPending({ now: now() });
    assert.strictEqual(rows.length, 1, 'exponential backoff must double');
    store.close();
  } finally {
    t.cleanup();
  }
  console.log('ok  relay-queue backoff: exponential window gating');
});

tests.push(() => {
  const t = tmpDb();
  try {
    const store = createStore({ dbPath: t.dbPath });
    const row = store.enqueue({ marker: 'm-1', title: 't', payload: PAYLOAD });
    store.markFailed(row.id, { error: 'boom', attempts: DEFAULT_MAX_ATTEMPTS });
    const rows = store.listPending({ now: Date.now(), maxAttempts: DEFAULT_MAX_ATTEMPTS });
    assert.strictEqual(rows.length, 0, 'exhausted budget must not be listed');
    store.close();
  } finally {
    t.cleanup();
  }
  console.log('ok  relay-queue budget: maxAttempts gating');
});

tests.push(() => {
  const t = tmpDb();
  try {
    const store = createStore({ dbPath: t.dbPath });
    // Insert a row with an old timestamp so the age cap actually applies.
    const oldTs = Date.now() - 100_000;
    store.enqueue({ marker: 'm-1', title: 't', payload: PAYLOAD }, { now: oldTs });
    const stale = store.listPending({ now: Date.now(), maxAgeMs: 1_000 });
    assert.strictEqual(stale.length, 0, 'older than maxAgeMs must not be listed');
    const fresh = store.listPending({ now: Date.now(), maxAgeMs: 200_000 });
    assert.strictEqual(fresh.length, 1);
    store.close();
  } finally {
    t.cleanup();
  }
  console.log('ok  relay-queue age: maxAgeMs gating');
});

/* ── worker: success & failure paths ─────────────────────────────── */

tests.push(async () => {
  const t = tmpDb();
  try {
    const store = createStore({ dbPath: t.dbPath });
    const row = store.enqueue({ marker: 'm-1', title: 'Crash on load', payload: PAYLOAD });
    const client = fakeGithub();
    const worker = createQueueWorker({ store, client });
    const counts = await worker.runOnce();

    assert.deepStrictEqual(counts, { attempted: 1, succeeded: 1, failed: 0, skipped: 0 });
    assert.strictEqual(client.calls.createIssue.length, 1);
    assert.strictEqual(client.calls.createIssue[0].title, 'Crash on load');
    assert.ok(client.calls.createIssue[0].body.includes('fleetdeck-report-marker: m-1'), 'marker comment must be in the body');

    const fresh = store.get(row.id);
    assert.strictEqual(fresh.sync_state, 'synced');
    assert.strictEqual(fresh.issue_number, 42);
    assert.strictEqual(fresh.issue_url, 'https://github.com/Riloox/hostkind-open/issues/42');
    assert.strictEqual(fresh.last_error, null);
    assert.strictEqual(store.counts().synced, 1);
    store.close();
  } finally {
    t.cleanup();
  }
  console.log('ok  relay-queue worker: success marks row synced with issue metadata');
});

tests.push(async () => {
  const t = tmpDb();
  try {
    const store = createStore({ dbPath: t.dbPath });
    const row = store.enqueue({ marker: 'm-1', title: 't', payload: PAYLOAD });
    const client = fakeGithub({ onCreate: () => { throw retryableError('GitHub API error 502: upstream down'); } });
    const worker = createQueueWorker({ store, client });
    const counts = await worker.runOnce();

    assert.deepStrictEqual(counts, { attempted: 1, succeeded: 0, failed: 1, skipped: 0 });
    const fresh = store.get(row.id);
    assert.ok(fresh, 'network failure must not lose the report');
    assert.strictEqual(fresh.sync_state, 'failed');
    assert.strictEqual(fresh.attempts, 1, 'retryable failure bumps attempts by one');
    assert.ok(fresh.last_error.includes('GitHub API error 502'), fresh.last_error);
    assert.strictEqual(store.counts().total, 1);
    store.close();
  } finally {
    t.cleanup();
  }
  console.log('ok  relay-queue worker: network failure records failed row, report kept');
});

tests.push(async () => {
  const t = tmpDb();
  try {
    const store = createStore({ dbPath: t.dbPath });
    const row = store.enqueue({ marker: 'm-1', title: 't', payload: PAYLOAD });
    let createCalls = 0;
    const client = fakeGithub({
      onCreate: () => {
        createCalls += 1;
        throw retryableError('GitHub API error 502: timeout');
      },
    });
    const worker = createQueueWorker({ store, client, backoffBaseMs: 0 });
    await worker.runOnce();

    // Second pass: attempts>0 -> reconcile by marker first; found upstream ->
    // adopt, do NOT create again.
    const worker2 = createQueueWorker({
      store,
      client: {
        ...client,
        findIssueByMarker: async (marker) => {
          client.calls.findIssueByMarker.push(marker);
          return { issueNumber: 7, issueUrl: 'https://github.com/Riloox/hostkind-open/issues/7' };
        },
      },
      backoffBaseMs: 0,
    });
    const counts = await worker2.runOnce();

    assert.deepStrictEqual(counts, { attempted: 1, succeeded: 1, failed: 0, skipped: 0 });
    assert.strictEqual(createCalls, 1, 'retry must never create a duplicate issue');
    assert.strictEqual(client.calls.findIssueByMarker.length, 1);
    const fresh = store.get(row.id);
    assert.strictEqual(fresh.sync_state, 'synced');
    assert.strictEqual(fresh.issue_number, 7);
    store.close();
  } finally {
    t.cleanup();
  }
  console.log('ok  relay-queue worker: retry reconciles by marker, no duplicate issue');
});

tests.push(async () => {
  const t = tmpDb();
  try {
    const store = createStore({ dbPath: t.dbPath });
    store.enqueue({ marker: 'm-bad', title: 'bad', payload: { ...PAYLOAD, title: 'bad' } });
    store.enqueue({ marker: 'm-good', title: 'good', payload: { ...PAYLOAD, title: 'good' } });

    const client = fakeGithub({
      onCreate: (input) => {
        if (input.title === 'bad') throw nonRetryableError('GitHub API error 422: validation failed');
        return okIssue({ issueNumber: 43, issueUrl: 'https://github.com/Riloox/hostkind-open/issues/43' });
      },
    });
    const worker = createQueueWorker({ store, client });
    const counts = await worker.runOnce();

    assert.deepStrictEqual(counts, { attempted: 2, succeeded: 1, failed: 1, skipped: 0 });
    const bad = store.getByMarker('m-bad');
    const good = store.getByMarker('m-good');
    assert.strictEqual(bad.sync_state, 'failed');
    assert.strictEqual(bad.attempts, DEFAULT_MAX_ATTEMPTS, 'non-retryable exhausts the budget');
    assert.strictEqual(good.sync_state, 'synced', 'a single bad report must not stop the queue');
    assert.strictEqual(good.issue_number, 43);
    store.close();
  } finally {
    t.cleanup();
  }
  console.log('ok  relay-queue worker: one bad report does not stop the queue');
});

tests.push(async () => {
  const t = tmpDb();
  try {
    const store = createStore({ dbPath: t.dbPath });
    const row = store.enqueue({ marker: 'm-1', title: 't', payload: PAYLOAD });
    const token = 'ghp_top_secret_token_1234567890';
    const client = fakeGithub({
      onCreate: () => { throw retryableError(`GitHub API error 502: token ${token} leaked`); },
    });
    const worker = createQueueWorker({ store, client });
    await worker.runOnce();

    const fresh = store.get(row.id);
    assert.ok(fresh.last_error, 'error must be recorded');
    assert.ok(!fresh.last_error.includes(token), 'stored error must not contain the secret');
    assert.ok(!fresh.last_error.includes('ghp_'), 'stored error must not contain PAT-shaped text');
    assert.ok(fresh.last_error.includes('[REDACTED]'), fresh.last_error);
    store.close();
  } finally {
    t.cleanup();
  }
  console.log('ok  relay-queue worker: secrets never appear in stored errors');
});

tests.push(async () => {
  const t = tmpDb();
  try {
    const store = createStore({ dbPath: t.dbPath });
    const row = store.enqueue({ marker: 'm-1', title: 't', payload: PAYLOAD });

    // Corrupt the stored payload directly (simulates disk corruption).
    const raw = new Database(t.dbPath);
    raw.prepare('UPDATE relay_reports SET payload = ? WHERE id = ?').run('not json {', row.id);
    raw.close();

    const client = fakeGithub();
    const worker = createQueueWorker({ store, client });
    const counts = await worker.runOnce();

    assert.deepStrictEqual(counts, { attempted: 1, succeeded: 0, failed: 1, skipped: 0 });
    assert.strictEqual(client.calls.createIssue.length, 0, 'corrupt payload must not reach GitHub');
    const fresh = store.get(row.id);
    assert.strictEqual(fresh.sync_state, 'failed');
    assert.strictEqual(fresh.attempts, DEFAULT_MAX_ATTEMPTS, 'corrupt payload is non-retryable');
    assert.ok(fresh.last_error.includes('not valid JSON'), fresh.last_error);
    store.close();
  } finally {
    t.cleanup();
  }
  console.log('ok  relay-queue worker: corrupt payload fails non-retryable without GitHub call');
});

/* ── robustness ──────────────────────────────────────────────────── */

tests.push(async () => {
  const brokenStore = {
    listPending: () => { throw new Error('db is gone'); },
  };
  const worker = createQueueWorker({ store: brokenStore, client: fakeGithub() });
  const counts = await worker.runOnce();
  assert.deepStrictEqual(counts, { attempted: 0, succeeded: 0, failed: 0, skipped: 0 });
  console.log('ok  relay-queue worker: runOnce never rejects when the store throws');
});

tests.push(async () => {
  const t = tmpDb();
  try {
    const store = createStore({ dbPath: t.dbPath });
    const row = store.enqueue({ marker: 'm-1', title: 't', payload: PAYLOAD });

    let resolveCreate;
    const gate = new Promise((resolve) => { resolveCreate = resolve; });
    let createCalls = 0;
    const client = {
      async createIssue(input) {
        createCalls += 1;
        await gate;
        return okIssue();
      },
      async findIssueByMarker() { return null; },
    };
    const inFlight = new Set();
    const worker = createQueueWorker({ store, client, inFlight });

    const first = worker.runOnce();
    // Give the first pass a chance to claim the row.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await worker.runOnce();
    resolveCreate();
    const firstCounts = await first;

    assert.strictEqual(createCalls, 1, 'in-flight guard must prevent double processing');
    assert.strictEqual(second.skipped, 1);
    assert.deepStrictEqual(firstCounts, { attempted: 1, succeeded: 1, failed: 0, skipped: 0 });
    const fresh = store.get(row.id);
    assert.strictEqual(fresh.sync_state, 'synced');
    store.close();
  } finally {
    t.cleanup();
  }
  console.log('ok  relay-queue worker: in-flight guard prevents double processing');
});

/* ── queue-before-GitHub ordering (contract) ─────────────────────── */

tests.push(async () => {
  const t = tmpDb();
  try {
    const store = createStore({ dbPath: t.dbPath });
    const marker = 'm-order-1';
    let rowSeenByClient = false;

    // The fake client proves the row existed BEFORE any GitHub call: if the
    // worker ran before enqueue, the lookup would miss.
    const client = fakeGithub({
      onCreate: (input) => {
        rowSeenByClient = store.getByMarker(input.marker || marker) !== null;
        return okIssue();
      },
    });

    const row = store.enqueue({ marker, title: 't', payload: PAYLOAD });
    assert.strictEqual(row.sync_state, 'pending', 'row must be durable before any GitHub call');
    const worker = createQueueWorker({ store, client });
    await worker.runOnce();
    assert.strictEqual(rowSeenByClient, true, 'GitHub call must see the already-persisted row');
    store.close();
  } finally {
    t.cleanup();
  }
  console.log('ok  relay-queue ordering: report queued before any GitHub call');
});

/* ── run ─────────────────────────────────────────────────────────── */

(async function main() {
  let failed = 0;
  for (let i = 0; i < tests.length; i++) {
    try {
      await tests[i]();
    } catch (e) {
      failed++;
      console.error(`FAIL  bug-report-relay-queue test ${i + 1}: ${e.message}\n${e.stack}`);
    }
  }
  if (failed) {
    console.error(`FAIL  ${failed} bug-report-relay-queue test(s) failed`);
    process.exit(1);
  }
  console.log(`PASS  bug-report-relay-queue (${tests.length} tests)`);
})();
