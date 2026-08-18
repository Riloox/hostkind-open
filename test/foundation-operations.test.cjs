'use strict';

const assert = require('assert');
const { setupDataDir, teardown } = require('./_setup.cjs');
setupDataDir();

const { close, dbPath } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');
const operations = require('../lib/operations.cjs');

function fresh() {
  close();
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath() + ext;
    if (require('fs').existsSync(p)) try { require('fs').unlinkSync(p); } catch { /* */ }
  }
}

fresh();
migrations.runMigrations();

const tests = [];

// 1. create + get + list.
tests.push(() => {
  const op = operations.create({ kind: 'test.something', actorId: 'user-1', serverId: 'srv-1' });
  assert.ok(op.id);
  assert.strictEqual(op.state, operations.STATES.QUEUED);
  assert.ok(op.queuedAt > 0);
  const got = operations.get(op.id);
  assert.deepStrictEqual(got.id, op.id);
  const list = operations.list({ serverId: 'srv-1' });
  assert.ok(list.items.find((o) => o.id === op.id));
});

// Late workers cannot overwrite a terminal cancellation.
tests.push(() => {
  const op = operations.create({ kind: 'test.late-worker' });
  operations.start(op.id);
  operations.cancel(op.id);
  operations.finish(op.id, { shouldNot: 'win' });
  operations.fail(op.id, { code: 'late', text: 'late failure' });
  assert.strictEqual(operations.get(op.id).state, operations.STATES.CANCELLED);
});

// Fresh queued work is not stale solely because it has no heartbeat yet.
tests.push(() => {
  const op = operations.create({ kind: 'test.fresh-queued' });
  const swept = operations.sweepStale({ heartbeatStaleMs: 60_000, now: Date.now() });
  assert.ok(!swept.some((item) => item.id === op.id));
  assert.strictEqual(operations.get(op.id).state, operations.STATES.QUEUED);
});

// 2. start / heartbeat / finish.
tests.push(() => {
  const op = operations.create({ kind: 'test.work', actorId: 'user-1' });
  const started = operations.start(op.id, { phase: 'fetching' });
  assert.strictEqual(started.state, operations.STATES.RUNNING);
  assert.strictEqual(started.phase, 'fetching');
  operations.heartbeat(op.id, { progress: 0.5 });
  const h = operations.get(op.id);
  assert.strictEqual(h.progress, 0.5);
  operations.finish(op.id, { note: 'all good' });
  const done = operations.get(op.id);
  assert.strictEqual(done.state, operations.STATES.SUCCEEDED);
  assert.strictEqual(done.summary.note, 'all good');
});

// 3. fail() with code/text/recovery.
tests.push(() => {
  const op = operations.create({ kind: 'test.fail', serverId: 'srv-1' });
  operations.start(op.id);
  operations.fail(op.id, { code: 'boom', text: 'something broke', recovery: { steps: ['restore snapshot 1'] } });
  const f = operations.get(op.id);
  assert.strictEqual(f.state, operations.STATES.FAILED);
  assert.strictEqual(f.error.code, 'boom');
  assert.ok(f.recovery.steps.length);
});

// 4. cancel.
tests.push(() => {
  const op = operations.create({ kind: 'test.cancel' });
  operations.cancel(op.id);
  assert.strictEqual(operations.get(op.id).state, operations.STATES.CANCELLED);
  // cancel is a no-op on terminal states.
  operations.cancel(op.id);
  assert.strictEqual(operations.get(op.id).state, operations.STATES.CANCELLED);
});

// 5. idempotency key returns the same op on replay.
tests.push(() => {
  const a = operations.create({ kind: 'test.idem', actorId: 'user-1', idempotencyKey: 'key-1' });
  const b = operations.create({ kind: 'test.idem', actorId: 'user-1', idempotencyKey: 'key-1' });
  assert.strictEqual(a.id, b.id);
});

// 6. event timeline.
tests.push(() => {
  const op = operations.create({ kind: 'test.timeline' });
  operations.start(op.id, { phase: 'phase-A' });
  operations.heartbeat(op.id, { progress: 0.25 });
  operations.finish(op.id);
  const events = operations.listEvents(op.id);
  assert.ok(events.length >= 3);
  assert.ok(events.some((e) => e.phase === 'phase-A'));
});

// 7. sweepStale: destructive kinds go to recovery_required, others fail.
tests.push(() => {
  const destructive = operations.create({ kind: 'plugin.update', serverId: 'srv-1' });
  const readOnly = operations.create({ kind: 'metrics.scan' });
  operations.start(destructive.id);
  operations.start(readOnly.id);
  // Pass a `now` slightly in the future so the just-set heartbeats are stale.
  const out = operations.sweepStale({ heartbeatStaleMs: 0, now: Date.now() + 10_000 });
  assert.ok(out.find((o) => o.id === destructive.id && o.state === operations.STATES.RECOVERY_REQUIRED),
    'destructive kind should be recovery_required');
  assert.ok(out.find((o) => o.id === readOnly.id && o.state === operations.STATES.FAILED),
    'read-only kind should be failed');
});

// 8. per-server lock.
tests.push(() => {
  const a = operations.create({ kind: 'plugin.update', serverId: 'srv-lock' });
  const b = operations.create({ kind: 'plugin.update', serverId: 'srv-lock' });
  operations.start(a.id);
  assert.ok(!operations.acquireServerLock(b.id, 'srv-lock'), 'second op on same server should be blocked');
  operations.finish(a.id);
  assert.ok(operations.acquireServerLock(b.id, 'srv-lock'), 'lock should release when first op finishes');
});

// 9. cursor pagination.
tests.push(() => {
  for (let i = 0; i < 5; i++) {
    operations.create({ kind: 'page.test', serverId: 'srv-page' });
  }
  const page1 = operations.list({ serverId: 'srv-page', limit: 2 });
  assert.strictEqual(page1.items.length, 2);
  assert.ok(page1.nextCursor);
  const page2 = operations.list({ serverId: 'srv-page', limit: 2, cursor: page1.nextCursor });
  assert.strictEqual(page2.items.length, 2);
  assert.notStrictEqual(page1.items[0].id, page2.items[0].id);
});

let failed = 0;
for (let i = 0; i < tests.length; i++) {
  try { tests[i](); console.log(`ok  operations test ${i + 1}`); }
  catch (e) { failed++; console.error(`FAIL  operations test ${i + 1}: ${e.message}\n${e.stack}`); }
}

close();
teardown();
if (failed) { console.error(`FAIL  ${failed} operations test(s) failed`); process.exit(1); }
console.log('PASS  foundation-operations');
