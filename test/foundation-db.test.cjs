'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { setupDataDir, teardown, TMP_ROOT } = require('./_setup.cjs');
setupDataDir();

const { open, close, dbPath } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');

function fresh() {
  close();
  // Clean slate: remove the .db file and any WAL/SHM companions.
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath() + ext;
    if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch { /* */ }
  }
}

function runMigrationsFresh() {
  fresh();
  return migrations.runMigrations();
}

(async function main() {
  // 1. open applies the right pragmas.
  {
    fresh();
    const db = open();
    const j = db.pragma('journal_mode', { simple: true });
    const fk = db.pragma('foreign_keys', { simple: true });
    assert.strictEqual(j, 'wal', `journal_mode should be wal, got ${j}`);
    assert.strictEqual(fk, 1, `foreign_keys should be 1, got ${fk}`);
    close();
    console.log('ok  pragmas: WAL + foreign_keys ON');
  }

  // 2. migrations run idempotently.
  {
    const r1 = runMigrationsFresh();
    assert.ok(r1.snapshot, 'first run should snapshot');
    assert.strictEqual(r1.applied.length, migrations.MIGRATIONS.length);
    const r2 = migrations.runMigrations();
    assert.strictEqual(r2.applied.length, 0, 'second run should be a no-op');
    console.log('ok  migrations: idempotent, snapshots on first run');
  }

  // 3. schema is current: every required table exists.
  {
    runMigrationsFresh();
    const db = open();
    const expected = [
      'schema_migrations', 'data_imports', 'audit_events',
      'capability_grants', 'operations', 'operation_events', 'snapshots',
    ];
    for (const t of expected) {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      assert.ok(row, `missing table: ${t}`);
    }
    console.log('ok  schema: all foundation tables present');
  }

  // 4. a failed migration restores from the snapshot.
  {
    fresh();
    // First, run the existing migration so we have a known-good baseline.
    migrations.runMigrations();
    close();
    // Now we add a deliberately bad migration by hand and re-run.
    migrations.MIGRATIONS.push({
      version: 99,
      name: 'broken',
      up() { throw new Error('boom'); },
    });
    let caught = null;
    try { migrations.runMigrations(); } catch (e) { caught = e; }
    assert.ok(caught, 'broken migration should throw');
    // After restore the file is back to the pre-migration state. The
    // second run should succeed and the version=99 row should not be
    // recorded.
    migrations.MIGRATIONS.pop();
    const r2 = migrations.runMigrations();
    const db = open();
    const row = db.prepare('SELECT 1 FROM schema_migrations WHERE version = 99').get();
    assert.ok(!row, 'broken migration should not have been recorded');
    console.log('ok  migrations: failure restores from snapshot, leaves prior version usable');
  }

  // 5. snapshot retention keeps at most MAX_SNAPSHOTS files.
  {
    fresh();
    migrations.runMigrations();
    const before = migrations.listSnapshots().length;
    // Force a few snapshot rotations by repeatedly opening and re-migrating
    // against a different process. We just call listSnapshots() and confirm
    // the count never exceeds the cap after several rotations. Simulate by
    // touching files with newer mtimes.
    const dir = path.join(TMP_ROOT, 'data', 'snapshots');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      const stamp = new Date(Date.now() - (5 - i) * 1000).toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(dbPath(), path.join(dir, `lodestone-${stamp}.db`));
    }
    // Trigger prune via a synthetic migration.
    migrations.MIGRATIONS.push({
      version: 50,
      name: 'noop-for-prune',
      up(db) { db.exec('SELECT 1'); },
    });
    migrations.runMigrations();
    migrations.MIGRATIONS.pop();
    const after = migrations.listSnapshots().length;
    assert.ok(after <= migrations.MAX_SNAPSHOTS, `expected <=${migrations.MAX_SNAPSHOTS} snapshots, got ${after}`);
    console.log(`ok  snapshots: pruned to ${after} (cap=${migrations.MAX_SNAPSHOTS})`);
  }

  close();
  teardown();
  console.log('PASS  foundation-db');
})();
