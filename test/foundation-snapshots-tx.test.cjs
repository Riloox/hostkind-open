'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { setupDataDir, teardown, TMP_ROOT } = require('./_setup.cjs');
setupDataDir();

const { close, dbPath } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');
const snapshots = require('../lib/snapshots.cjs');
const fsTx = require('../lib/fsTransaction.cjs');
const files = require('../lib/files.cjs');

function fresh() {
  close();
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath() + ext;
    if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch { /* */ }
  }
}

fresh();
migrations.runMigrations();

const tests = [];

// safeResolve
tests.push(() => {
  const root = fs.mkdtempSync(path.join(TMP_ROOT, 'safe-'));
  const a = files.safeResolve(root, 'foo/bar.txt');
  assert.ok(a.startsWith(root));
  assert.throws(() => files.safeResolve(root, '../etc/passwd'), /escapes/);
  assert.throws(() => files.safeResolve(root, '/etc/passwd'), /absolute/);
  assert.throws(() => files.safeResolve(root, 'a/\u0000b'), /NUL/);
  assert.throws(() => files.safeResolve(root, ''), /required/);
});

// fsTransaction rejects traversal and absolute destinations.
tests.push(() => {
  const serverDir = fs.mkdtempSync(path.join(TMP_ROOT, 'tx-safe-'));
  const tx = new fsTx.Transaction({ serverDir, operationId: 'op-safe' });
  assert.throws(() => tx.stageWrite('../outside.txt', 'bad'), /escapes|invalid/i);
  assert.throws(() => tx.stageWrite(path.resolve(serverDir, '..', 'outside.txt'), 'bad'), /absolute|invalid/i);
  assert.throws(() => new fsTx.Transaction({ serverDir, operationId: '../escape' }), /invalid operationId/);
  const outside = fs.mkdtempSync(path.join(TMP_ROOT, 'tx-outside-'));
  // A junction is the directory link an unprivileged Windows account can
  // actually create, and lstat reports it as a symbolic link either way.
  fs.symlinkSync(outside, path.join(serverDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  tx.stageWrite('linked/escape.txt', 'bad');
  assert.throws(() => tx.commit(), /symbolic link/);
  tx.rollback();
});

// snapshots: take, verify, restore
tests.push(() => {
  const serverDir = fs.mkdtempSync(path.join(TMP_ROOT, 'srv-'));
  fs.writeFileSync(path.join(serverDir, 'a.txt'), 'hello');
  fs.mkdirSync(path.join(serverDir, 'world'));
  fs.writeFileSync(path.join(serverDir, 'world', 'b.txt'), 'world');
  const snap = snapshots.take({ serverId: 'srv-snap', sourceDir: serverDir, kind: 'test' });
  assert.ok(snap.id);
  const v = snapshots.verify(snap.id);
  assert.ok(v.ok, `verify should pass, got ${JSON.stringify(v)}`);
  // Modify the live file, then restore from snapshot.
  fs.writeFileSync(path.join(serverDir, 'a.txt'), 'changed');
  const r = snapshots.restore({ id: snap.id, targetDir: serverDir });
  assert.ok(r.ok);
  const restored = fs.readFileSync(path.join(serverDir, 'a.txt'), 'utf8');
  assert.strictEqual(restored, 'hello');
});

// Recovery-required staging can be preserved while true orphans are swept.
tests.push(() => {
  const serverDir = fs.mkdtempSync(path.join(TMP_ROOT, 'tx-preserve-'));
  const keep = path.join(serverDir, '.lodestone', 'staging', 'op-keep');
  const remove = path.join(serverDir, '.lodestone', 'staging', 'op-remove');
  fs.mkdirSync(keep, { recursive: true });
  fs.mkdirSync(remove, { recursive: true });
  fsTx.sweep(serverDir, { preserveOperationIds: ['op-keep'] });
  assert.ok(fs.existsSync(keep));
  assert.ok(!fs.existsSync(remove));
});

// snapshots: verify detects drift.
tests.push(() => {
  const serverDir = fs.mkdtempSync(path.join(TMP_ROOT, 'srv-drift-'));
  fs.writeFileSync(path.join(serverDir, 'a.txt'), 'a');
  const snap = snapshots.take({ serverId: 'srv-drift', sourceDir: serverDir });
  // Tamper with the snapshot on disk.
  fs.writeFileSync(path.join(snapshots.snapshotDir(snap.id), 'root', 'a.txt'), 'bigger');
  const v = snapshots.verify(snap.id);
  assert.ok(!v.ok, 'tampered snapshot should fail verify');
});

// snapshots: list and retention
tests.push(() => {
  const serverDir = fs.mkdtempSync(path.join(TMP_ROOT, 'srv-ret-'));
  for (let i = 0; i < 7; i++) {
    fs.writeFileSync(path.join(serverDir, 'f.txt'), `v${i}`);
    snapshots.take({ serverId: 'srv-ret', sourceDir: serverDir, retention: 3 });
  }
  const listed = snapshots.list('srv-ret');
  assert.ok(listed.length <= 3, `retention should keep at most 3, got ${listed.length}`);
});

// migration snapshot prefix: takeSnapshot writes fleetdeck-*.db
tests.push(() => {
  fresh();
  const r = migrations.runMigrations();
  assert.ok(r.snapshot, 'runMigrations should produce a snapshot');
  const basename = path.basename(r.snapshot);
  assert.ok(basename.startsWith('fleetdeck-'), `snapshot should use fleetdeck- prefix, got: ${basename}`);
  // List should also find it under the new prefix.
  const listed = migrations.listSnapshots();
  assert.ok(listed.some((p) => path.basename(p).startsWith('fleetdeck-')), 'listSnapshots should find fleetdeck- files');
});

// legacy read-compat: listSnapshots/pruneSnapshots see lodestone-*.db files too
tests.push(() => {
  const dir = path.join(TMP_ROOT, 'data', 'snapshots');
  fs.mkdirSync(dir, { recursive: true });
  // Create a fake legacy snapshot file.
  const legacyName = 'lodestone-2025-01-01T00-00-00-000Z.db';
  fs.copyFileSync(dbPath(), path.join(dir, legacyName));
  const listed = migrations.listSnapshots();
  assert.ok(listed.some((p) => p.endsWith(legacyName)), 'listSnapshots should include lodestone- prefix');
});


// fsTransaction: stage, commit, rollback
tests.push(() => {
  const serverDir = fs.mkdtempSync(path.join(TMP_ROOT, 'tx-'));
  fs.writeFileSync(path.join(serverDir, 'a.txt'), 'old');
  const tx = new fsTx.Transaction({ serverDir, operationId: 'op-test-1' });
  tx.stageWrite('a.txt', 'new');
  tx.stageWrite('b.txt', 'fresh');
  tx.commit();
  assert.strictEqual(fs.readFileSync(path.join(serverDir, 'a.txt'), 'utf8'), 'new');
  assert.strictEqual(fs.readFileSync(path.join(serverDir, 'b.txt'), 'utf8'), 'fresh');
  // Staging dir cleaned up.
  const stagingRoot = path.join(serverDir, '.lodestone', 'staging', 'op-test-1');
  assert.ok(!fs.existsSync(stagingRoot), 'staging dir should be cleaned up');
});

tests.push(() => {
  const serverDir = fs.mkdtempSync(path.join(TMP_ROOT, 'tx-rb-'));
  fs.writeFileSync(path.join(serverDir, 'a.txt'), 'old');
  const tx = new fsTx.Transaction({ serverDir, operationId: 'op-rb-1' });
  tx.stageWrite('a.txt', 'new');
  tx.rollback();
  // Live file untouched, staging cleaned up.
  assert.strictEqual(fs.readFileSync(path.join(serverDir, 'a.txt'), 'utf8'), 'old');
  assert.ok(!fs.existsSync(path.join(serverDir, '.lodestone', 'staging', 'op-rb-1')));
});

// fsTransaction: sweep cleans up orphaned staging directories.
tests.push(() => {
  const serverDir = fs.mkdtempSync(path.join(TMP_ROOT, 'tx-sweep-'));
  const orphan = path.join(serverDir, '.lodestone', 'staging', 'op-orphan');
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'junk'), 'x');
  const removed = fsTx.sweep(serverDir);
  assert.ok(removed.length === 1, 'sweep should remove orphan');
  assert.ok(!fs.existsSync(orphan));
});

let failed = 0;
for (let i = 0; i < tests.length; i++) {
  try { tests[i](); console.log(`ok  snapshots/transaction test ${i + 1}`); }
  catch (e) { failed++; console.error(`FAIL  snapshots/transaction test ${i + 1}: ${e.message}\n${e.stack}`); }
}

close();
teardown();
if (failed) { console.error(`FAIL  ${failed} snapshots/transaction test(s) failed`); process.exit(1); }
console.log('PASS  foundation-snapshots-transaction');
