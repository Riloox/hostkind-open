'use strict';

/*
 * Bug-report storage tests — plan Task 2
 * (.hermes/plans/2026-08-14_235510-report-bug-github.md)
 *
 * Implementation contract under test — lib/bug-reports.cjs:
 *
 *   Migration: version 14, name 'bug-reports' (appended to MIGRATIONS in
 *   lib/migrations.cjs, following the existing per-version pattern). Creates:
 *
 *     bug_reports (
 *       id             TEXT PRIMARY KEY,            -- UUID
 *       actor_id       TEXT NOT NULL,
 *       actor_username TEXT,
 *       created_at     INTEGER NOT NULL,            -- epoch ms
 *       game           TEXT,
 *       view           TEXT,
 *       route          TEXT,
 *       title          TEXT NOT NULL,
 *       description    TEXT NOT NULL,
 *       repro_steps    TEXT,
 *       expected       TEXT,
 *       user_agent     TEXT,
 *       version        TEXT,                        -- panel version at submit time
 *       sync_state     TEXT NOT NULL DEFAULT 'pending'
 *                      CHECK (sync_state IN ('pending','failed','synced')),
 *       issue_number   INTEGER,
 *       issue_url      TEXT,
 *       marker         TEXT,                        -- idempotency marker
 *       last_error     TEXT,
 *       attempts       INTEGER NOT NULL DEFAULT 0,
 *       updated_at     INTEGER NOT NULL
 *     );
 *     CREATE INDEX bug_reports_sync_state_idx ON bug_reports(sync_state);
 *     CREATE INDEX bug_reports_created_at_idx ON bug_reports(created_at);
 *     CREATE UNIQUE INDEX bug_reports_marker_unique ON bug_reports(marker);
 *
 *   Module exports — all SYNCHRONOUS, db handle opened lazily per call
 *   (lib/audit.cjs pattern: call open() inside each function; never cache
 *   prepared statements at module scope so tests can fresh()/reopen):
 *
 *     create(input, opts) -> stored row
 *       input: { actorId, actorUsername, game, view, route, title,
 *                description, reproSteps, expected, userAgent, version, marker }
 *       opts:  { now, id }  (deterministic test seams; defaults Date.now/randomUUID)
 *       Validation: actorId/title/description are required non-empty strings;
 *       title <= 200 chars, description <= 100_000 chars; optional strings are
 *       trimmed and normalized ('' / whitespace / null / undefined -> null),
 *       each <= 500 chars (reproSteps/expected <= 5000, userAgent <= 1000,
 *       version <= 100, marker <= 100); invalid input THROWS and writes nothing.
 *       Defaults: sync_state 'pending', attempts 0, created_at = updated_at = now.
 *       marker: generated 'fleetdeck-<uuid>' when omitted; when the caller
 *       supplies a marker that already exists, returns the EXISTING row
 *       (idempotent double-submit protection, mirroring operations.create).
 *
 *     get(id) -> row | undefined
 *
 *     listPending(opts) -> rows eligible for sync, ordered created_at ASC
 *       opts: { limit (10), now (Date.now), maxAttempts (5),
 *               backoffBaseMs (60_000), maxAgeMs (30 days) }
 *       Eligibility: sync_state IN ('pending','failed') AND attempts < maxAttempts
 *       AND updated_at >= now - maxAgeMs AND
 *       (attempts === 0 OR updated_at + backoffBaseMs * 2^(attempts-1) <= now)
 *
 *     markSynced(id, { issueNumber, issueUrl }, opts) -> updated row
 *       sets sync_state 'synced', issue_number, issue_url, last_error NULL,
 *       updated_at = opts.now; attempts preserved.
 *
 *     markFailed(id, { error, attempts }, opts) -> updated row
 *       sets sync_state 'failed', attempts = given value (worker computes
 *       attempts+1 or the max on give-up), last_error = REDACT then TRUNCATE
 *       (<= 500 chars) of the error text, updated_at = opts.now.
 *       Redaction strips PAT-shaped secrets (ghp_/github_pat_/'Bearer <secret>'
 *       forms); the exact token itself is redacted by the GitHub client before
 *       any error text reaches storage — a stored error must never carry a
 *       secret in any form.
 */

const assert = require('assert');
const fs = require('fs');
const { setupDataDir, teardown } = require('./_setup.cjs');
setupDataDir();

const { open, close, dbPath } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');
const bugReports = require('../lib/bug-reports.cjs');

/* ── helpers ─────────────────────────────────────────────────────── */

const T0 = 1_700_000_000_000;

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

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

function indexNames(db, table) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?").all(table)
    .map((r) => r.name);
}

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
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

function createSample(overrides = {}, opts = {}) {
  return bugReports.create(sampleInput(overrides), { now: T0, ...opts });
}

const EXPECTED_COLUMNS = [
  'id', 'actor_id', 'actor_username', 'created_at', 'game', 'view', 'route',
  'title', 'description', 'repro_steps', 'expected', 'user_agent', 'version',
  'sync_state', 'issue_number', 'issue_url', 'marker', 'last_error',
  'attempts', 'updated_at',
];

const EXPECTED_INDEXES = [
  'bug_reports_sync_state_idx',
  'bug_reports_created_at_idx',
  'bug_reports_marker_unique',
];

/* ── tests ───────────────────────────────────────────────────────── */

const tests = [];

/* 1. Migration exists as version 14 'bug-reports', applies, and is idempotent. */
tests.push(() => {
  const m = migrations.MIGRATIONS.find((x) => x.version === 14);
  assert.ok(m, 'expected migration version 14 (bug-reports) in MIGRATIONS');
  assert.strictEqual(m.name, 'bug-reports');

  const r1 = runMigrationsFresh();
  assert.ok(r1.applied.some((a) => a.version === 14), 'migration 14 should apply on a fresh db');

  const db = open();
  const recorded = db.prepare('SELECT version FROM schema_migrations WHERE version = 14').get();
  assert.ok(recorded, 'version 14 should be recorded in schema_migrations');
  assert.ok(tableExists(db, 'bug_reports'), 'bug_reports table should exist');
  close();

  const r2 = migrations.runMigrations();
  assert.strictEqual(r2.applied.length, 0, 'second run should be a no-op');
  console.log('ok  bug-reports migration: v14 applies, records, idempotent');
});

/* 2. Schema: exact column set and required indexes. */
tests.push(() => {
  runMigrationsFresh();
  const db = open();
  assert.deepStrictEqual(columnNames(db, 'bug_reports').sort(), [...EXPECTED_COLUMNS].sort());
  const indexes = indexNames(db, 'bug_reports');
  for (const idx of EXPECTED_INDEXES) {
    assert.ok(indexes.includes(idx), `missing index ${idx}; got ${indexes.join(', ')}`);
  }
  close();
  console.log('ok  bug-reports migration: columns and indexes match contract');
});

/* 3. Row survival across a migration re-run and a full reopen (durability). */
tests.push(() => {
  runMigrationsFresh();
  const row = createSample({ marker: 'm-survive' }, { id: 'r-survive' });
  assert.strictEqual(row.id, 'r-survive');

  close();
  migrations.runMigrations();           // no-op re-run
  const db = open();
  assert.strictEqual(countRows(db, 'bug_reports'), 1, 'no rows should be lost');
  const again = bugReports.get('r-survive');
  assert.ok(again, 'report should survive re-open');
  assert.strictEqual(again.title, 'Panel crashes on boot');
  assert.strictEqual(again.sync_state, 'pending');
  close();
  console.log('ok  bug-reports durability: row survives re-run and reopen');
});

/* 4. create() stores the full normalized row with defaults. */
tests.push(() => {
  runMigrationsFresh();
  const row = createSample(
    { marker: 'm-4' },
    { id: 'r-4', now: T0 },
  );
  assert.strictEqual(row.id, 'r-4');
  assert.strictEqual(row.actor_id, 'user-123');
  assert.strictEqual(row.actor_username, 'alice');
  assert.strictEqual(row.game, 'minecraft');
  assert.strictEqual(row.view, 'servers');
  assert.strictEqual(row.route, '/servers');
  assert.strictEqual(row.title, 'Panel crashes on boot');
  assert.strictEqual(row.description, 'After upgrading, the panel crashes with a white screen.');
  assert.strictEqual(row.repro_steps, '1. Start the panel\n2. Open the dashboard');
  assert.strictEqual(row.expected, 'It should boot normally.');
  assert.strictEqual(row.user_agent, 'Mozilla/5.0 (fleetdeck test)');
  assert.strictEqual(row.version, '0.1.0');
  assert.strictEqual(row.sync_state, 'pending');
  assert.strictEqual(row.attempts, 0);
  assert.strictEqual(row.created_at, T0);
  assert.strictEqual(row.updated_at, T0);
  assert.strictEqual(row.issue_number, null);
  assert.strictEqual(row.issue_url, null);
  assert.strictEqual(row.last_error, null);
  close();
  console.log('ok  bug-reports create: stores normalized row with pending defaults');
});

/* 5. create() generates a UUID id and a fleetdeck- marker when omitted. */
tests.push(() => {
  runMigrationsFresh();
  const row = bugReports.create(sampleInput({ marker: undefined }), { now: T0 });
  assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.match(row.marker, /^fleetdeck-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  close();
  console.log('ok  bug-reports create: auto id + marker generated');
});

/* 6. create() rejects empty/whitespace titles and descriptions. */
tests.push(() => {
  runMigrationsFresh();
  assert.throws(() => createSample({ title: '' }), /title/i);
  assert.throws(() => createSample({ title: '   \n  ' }), /title/i);
  assert.throws(() => createSample({ description: '' }), /description/i);
  assert.throws(() => createSample({ description: '  ' }), /description/i);
  assert.throws(() => createSample({ actorId: '' }), /actor/i);
  close();
  console.log('ok  bug-reports create: rejects empty title/description/actor');
});

/* 7. create() rejects non-string required fields. */
tests.push(() => {
  runMigrationsFresh();
  assert.throws(() => createSample({ title: 123 }), /title/i);
  assert.throws(() => createSample({ description: { text: 'x' } }), /description/i);
  assert.throws(() => createSample({ actorId: null }), /actor/i);
  close();
  console.log('ok  bug-reports create: rejects non-string required fields');
});

/* 8. create() rejects oversized payloads (title/description/optionals). */
tests.push(() => {
  runMigrationsFresh();
  assert.throws(() => createSample({ title: 'x'.repeat(201) }), /title/i);
  assert.throws(() => createSample({ description: 'x'.repeat(100_001) }), /description/i);
  assert.throws(() => createSample({ userAgent: 'x'.repeat(1001) }), /user/i);
  assert.throws(() => createSample({ game: 'x'.repeat(501) }), /game/i);
  assert.throws(() => createSample({ reproSteps: 'x'.repeat(5001) }), /steps/i);
  assert.throws(() => createSample({ marker: 'x'.repeat(101) }), /marker/i);
  close();
  console.log('ok  bug-reports create: rejects oversized payloads');
});

/* 9. create() normalizes empty/whitespace optional strings to null. */
tests.push(() => {
  runMigrationsFresh();
  const row = createSample({
    game: '',
    view: '   ',
    route: null,
    reproSteps: undefined,
    expected: '   ',
    userAgent: '',
    actorUsername: ' \t ',
    version: null,
  }, { id: 'r-9' });
  assert.strictEqual(row.game, null);
  assert.strictEqual(row.view, null);
  assert.strictEqual(row.route, null);
  assert.strictEqual(row.repro_steps, null);
  assert.strictEqual(row.expected, null);
  assert.strictEqual(row.user_agent, null);
  assert.strictEqual(row.actor_username, null);
  assert.strictEqual(row.version, null);
  close();
  console.log('ok  bug-reports create: normalizes optional strings to null');
});

/* 10. create() with a duplicate marker returns the existing row (idempotent). */
tests.push(() => {
  runMigrationsFresh();
  const first = createSample({ marker: 'm-dup' }, { id: 'r-dup-1' });
  const second = createSample({ marker: 'm-dup', title: 'Different title' }, { id: 'r-dup-2' });
  assert.strictEqual(second.id, first.id, 'duplicate marker must return the existing report');
  assert.strictEqual(second.title, first.title, 'existing row must not be overwritten');
  const db = open();
  assert.strictEqual(countRows(db, 'bug_reports'), 1, 'duplicate marker must not create a second row');
  close();
  console.log('ok  bug-reports create: duplicate marker is idempotent');
});

/* 11. get() returns the row for a known id and undefined for an unknown one. */
tests.push(() => {
  runMigrationsFresh();
  createSample({ marker: 'm-11' }, { id: 'r-11' });
  const row = bugReports.get('r-11');
  assert.ok(row);
  assert.strictEqual(row.id, 'r-11');
  assert.strictEqual(bugReports.get('r-missing'), undefined);
  close();
  console.log('ok  bug-reports get: found row / undefined for unknown id');
});

/* 12. listPending returns pending+failed only, created_at ASC, limit respected. */
tests.push(() => {
  runMigrationsFresh();
  const r1 = createSample({ marker: 'm-a' }, { id: 'r-a', now: T0 });
  const r2 = createSample({ marker: 'm-b' }, { id: 'r-b', now: T0 + 1 });
  const r3 = createSample({ marker: 'm-c' }, { id: 'r-c', now: T0 + 2 });
  assert.strictEqual(r1.sync_state, 'pending');
  // mark r-b synced -> excluded
  bugReports.markSynced(r2.id, { issueNumber: 2, issueUrl: 'https://github.com/Riloox/hostkind-open/issues/2' }, { now: T0 + 3 });
  // mark r-c failed at T0+2 -> eligible again after its 60s backoff (T0+62_000)
  bugReports.markFailed(r3.id, { error: 'boom', attempts: 1 }, { now: T0 + 2 });

  const all = bugReports.listPending({ now: T0 + 62_000 });
  assert.deepStrictEqual(all.map((r) => r.id), ['r-a', 'r-c'], 'pending+failed only, ordered by created_at');
  assert.strictEqual(all[1].sync_state, 'failed');

  const limited = bugReports.listPending({ now: T0 + 62_000, limit: 1 });
  assert.deepStrictEqual(limited.map((r) => r.id), ['r-a'], 'limit respected');
  close();
  console.log('ok  bug-reports listPending: state filter, order, limit');
});

/* 13. listPending excludes reports at the retry limit (attempts >= maxAttempts). */
tests.push(() => {
  runMigrationsFresh();
  const old = T0 - 500_000; // far enough in the past that backoff has elapsed
  createSample({ marker: 'm-never' }, { id: 'r-never', now: old });
  bugReports.markFailed('r-never', { error: 'exhausted', attempts: 5 }, { now: old });
  // attempts=5 with maxAttempts=5 must never be selected, even with time passed
  const out = bugReports.listPending({ now: T0, maxAttempts: 5, backoffBaseMs: 60_000 });
  assert.deepStrictEqual(out, [], 'attempts >= maxAttempts must be excluded');

  // attempts=4 (still below the limit) with elapsed backoff IS eligible
  createSample({ marker: 'm-4x' }, { id: 'r-4x', now: old });
  bugReports.markFailed('r-4x', { error: 'retryable', attempts: 4 }, { now: old });
  const eligible = bugReports.listPending({ now: T0, maxAttempts: 5, backoffBaseMs: 60_000 });
  assert.deepStrictEqual(eligible.map((r) => r.id), ['r-4x']);
  close();
  console.log('ok  bug-reports listPending: retry limit enforced');
});

/* 14. listPending applies exponential backoff on failed attempts. */
tests.push(() => {
  runMigrationsFresh();
  createSample({ marker: 'm-bo' }, { id: 'r-bo', now: T0 });
  bugReports.markFailed('r-bo', { error: 'boom', attempts: 1 }, { now: T0 });

  const before = bugReports.listPending({ now: T0 + 59_999, maxAttempts: 5, backoffBaseMs: 60_000 });
  assert.deepStrictEqual(before, [], 'attempt 1 needs a full 60s backoff');

  const at = bugReports.listPending({ now: T0 + 60_000, maxAttempts: 5, backoffBaseMs: 60_000 });
  assert.deepStrictEqual(at.map((r) => r.id), ['r-bo'], 'eligible exactly at backoff boundary');

  // attempts=2 doubles the window (120s measured FROM the failure at T0+60_000)
  bugReports.markFailed('r-bo', { error: 'boom again', attempts: 2 }, { now: T0 + 60_000 });
  const mid = bugReports.listPending({ now: T0 + 180_000 - 1, maxAttempts: 5, backoffBaseMs: 60_000 });
  assert.deepStrictEqual(mid, [], 'attempt 2 needs 120s from its failure');
  const done = bugReports.listPending({ now: T0 + 180_000, maxAttempts: 5, backoffBaseMs: 60_000 });
  assert.deepStrictEqual(done.map((r) => r.id), ['r-bo']);
  close();
  console.log('ok  bug-reports listPending: exponential backoff');
});

/* 15. listPending applies the maximum-age policy. */
tests.push(() => {
  runMigrationsFresh();
  const twoDaysAgo = T0 - 2 * 86_400_000;
  createSample({ marker: 'm-old' }, { id: 'r-old', now: twoDaysAgo });

  const capped = bugReports.listPending({ now: T0, maxAgeMs: 86_400_000 });
  assert.deepStrictEqual(capped, [], 'reports older than maxAgeMs must not be retried');

  const uncapped = bugReports.listPending({ now: T0, maxAgeMs: 3 * 86_400_000 });
  assert.deepStrictEqual(uncapped.map((r) => r.id), ['r-old']);
  close();
  console.log('ok  bug-reports listPending: maximum age enforced');
});

/* 16. markSynced records issue metadata and clears last_error. */
tests.push(() => {
  runMigrationsFresh();
  createSample({ marker: 'm-syn' }, { id: 'r-syn', now: T0 });
  bugReports.markFailed('r-syn', { error: 'ghp_abcdefghijklmnopqrstuvwxyz boom', attempts: 1 }, { now: T0 + 1 });
  const row = bugReports.markSynced('r-syn', {
    issueNumber: 42,
    issueUrl: 'https://github.com/Riloox/hostkind-open/issues/42',
  }, { now: T0 + 2 });

  assert.strictEqual(row.sync_state, 'synced');
  assert.strictEqual(row.issue_number, 42);
  assert.strictEqual(row.issue_url, 'https://github.com/Riloox/hostkind-open/issues/42');
  assert.strictEqual(row.last_error, null, 'last_error must be cleared on success');
  assert.strictEqual(row.updated_at, T0 + 2);
  assert.strictEqual(row.attempts, 1, 'attempts history preserved');
  close();
  console.log('ok  bug-reports markSynced: issue metadata stored, error cleared');
});

/* 17. markFailed stores a redacted, truncated error and bumps updated_at. */
tests.push(() => {
  runMigrationsFresh();
  createSample({ marker: 'm-fail' }, { id: 'r-fail', now: T0 });

  // Secret at the start of a long message: redaction must survive truncation.
  const secretFirst = 'ghp_abcdefghijklmnopqrstuvwxyz' + 'x'.repeat(600);
  const a = bugReports.markFailed('r-fail', { error: secretFirst, attempts: 1 }, { now: T0 + 1 });
  assert.ok(!a.last_error.includes('ghp_'), 'ghp_ secret must be redacted');
  assert.ok(!a.last_error.includes('abcdefghijklmnopqrstuvwxyz'));
  assert.ok(a.last_error.includes('[REDACTED]'), 'redaction marker expected');
  assert.ok(a.last_error.length <= 500, `last_error truncated to ${a.last_error.length}`);

  // Literal-secret redaction is the GitHub client's job (it knows the token);
  // the storage layer strips PAT-shaped secrets that could reach it verbatim.
  const b = bugReports.markFailed('r-fail', {
    error: 'rate limited github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345678 and again ghp_zyxwvutsrqponmlkjihgfedcba',
    attempts: 2,
  }, { now: T0 + 2 });
  assert.ok(!b.last_error.includes('github_pat_'), 'github_pat_ must be redacted');
  assert.ok(!b.last_error.includes('ghp_zyxwvutsrqponmlkjihgfedcba'), 'ghp_ must be redacted');
  assert.strictEqual(b.sync_state, 'failed');
  assert.strictEqual(b.attempts, 2);
  assert.strictEqual(b.updated_at, T0 + 2);
  close();
  console.log('ok  bug-reports markFailed: redaction, truncation, state');
});

/* 18. Full transition round trip: pending -> failed -> synced. */
tests.push(() => {
  runMigrationsFresh();
  const row = createSample({ marker: 'm-rt' }, { id: 'r-rt', now: T0 });
  assert.strictEqual(row.sync_state, 'pending');

  bugReports.markFailed('r-rt', { error: 'network down', attempts: 1 }, { now: T0 + 1 });
  assert.strictEqual(bugReports.get('r-rt').sync_state, 'failed');
  assert.deepStrictEqual(
    bugReports.listPending({ now: T0 + 61_000 }).map((r) => r.id),
    ['r-rt'],
    'failed report is retryable after its 60s backoff',
  );

  bugReports.markSynced('r-rt', { issueNumber: 7, issueUrl: 'https://github.com/Riloox/hostkind-open/issues/7' }, { now: T0 + 61_001 });
  const done = bugReports.get('r-rt');
  assert.strictEqual(done.sync_state, 'synced');
  assert.strictEqual(done.issue_number, 7);
  assert.deepStrictEqual(bugReports.listPending({ now: T0 + 61_002 }), [], 'synced reports leave the retry set');
  close();
  console.log('ok  bug-reports transitions: pending -> failed -> synced');
});

/* ── run ─────────────────────────────────────────────────────────── */

(async function main() {
  let failed = 0;
  for (let i = 0; i < tests.length; i++) {
    try { await tests[i](); }
    catch (e) {
      failed++;
      console.error(`FAIL  bug-reports test ${i + 1}: ${e.message}\n${e.stack}`);
    }
  }
  close();
  teardown();
  if (failed) { console.error(`FAIL  ${failed} bug-reports test(s) failed`); process.exit(1); }
  console.log(`PASS  bug-reports (${tests.length} tests)`);
})();
