'use strict';

/*
 * Upgrade-drill test .
 *
 * Proves that a v0.1.0-era database (migrations 1–12 applied) upgrades
 * cleanly when the v0.2 migration runner boots over it.  Hermetically
 * isolated: temp dirs, no real config, no network.
 *
 * Scenarios:
 *   1. Idempotent no-op upgrade — v0.1.0 DB with rows survives v0.2 boot
 *      with no pending migrations (v0.2 ships no schema change).
 *   2. Pending-migration upgrade — when a new migration IS present, a
 *      pre-migration snapshot is created and data survives.
 *   3. Rollback — a deliberately broken migration restores the snapshot
 *      and the DB is usable at the prior version.
 *   4. Schema completeness — every v0.1.0 table still exists after upgrade.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { setupDataDir, teardown, TMP_ROOT } = require('./_setup.cjs');
setupDataDir();

const { open, close, dbPath } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');

/* ── helpers ─────────────────────────────────────────────────────── */

function fresh() {
  close();
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath() + ext;
    if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch { /* */ }
  }
}

/** Check whether a table exists in the current database. */
function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/** Apply migrations 1–12 (the v0.1.0 set) then insert representative rows. */
function buildV01Db() {
  fresh();
  const result = migrations.runMigrations();
  assert.strictEqual(
    result.applied.length,
    migrations.MIGRATIONS.length,
    `v0.1 baseline should apply all ${migrations.MIGRATIONS.length} migrations`,
  );
  return result;
}

/**
 * Insert one representative row per hot table so the upgrade can prove
 * byte-identical survival.  Column names come from migrations 1–12.
 * Tables that do not yet exist (e.g. when testing with a subset of
 * migrations) are silently skipped.
 */
function insertRepresentativeRows(db) {
  const now = Date.now();

  const runIfTable = (table, sql, ...args) => {
    if (!tableExists(db, table)) return;
    db.prepare(sql).run(...args);
  };

  // audit_events (migration 1, extended by 7)
  runIfTable('audit_events', `INSERT INTO audit_events
    (id, ts, actor_id, server_id, action, target, outcome, request_id,
     actor_username, target_type, target_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'audit-drill-1', now, 'user-1', 'srv-1', 'server.create', 'srv-1',
    'success', 'req-1', 'admin', 'server', 'srv-1');

  // operations (migration 1)
  runIfTable('operations', `INSERT INTO operations
    (id, kind, state, queued_at, actor_id, server_id, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    'op-drill-1', 'backup', 'completed', now, 'user-1', 'srv-1', 'test backup');

  // metric_samples (migration 1, extended by 8)
  runIfTable('metric_samples', `INSERT INTO metric_samples
    (server_id, ts, cpu, memory_mb, players, world_mb,
     tps, online, heap_mb, disk_used_mb, disk_total_mb)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'srv-1', now, 0.42, 2048.0, 12, 512.0,
    20.0, 1, 4096.0, 10240.0, 51200.0);

  // crash_groups (migration 3)
  runIfTable('crash_groups', `INSERT INTO crash_groups
    (id, server_id, fingerprint, category, first_seen_at, last_seen_at, count)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    'cg-drill-1', 'srv-1', 'fp-abc', 'OOM', now, now, 3);

  // health_alerts (migration 8)
  runIfTable('health_alerts', `INSERT INTO health_alerts
    (id, server_id, rule_id, severity, state, occurrences,
     first_seen_at, last_seen_at, algo_version, evidence_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    'ha-drill-1', 'srv-1', 'high-memory', 'warning', 'active', 5,
    now, now, '1.0', '{}');

  // api_keys (migration 12)
  runIfTable('api_keys', `INSERT INTO api_keys
    (id, name, role, secret_hash, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?)`,
    'ak-drill-1', 'ci-key', 'admin', 'sha256-abc', now, 'user-1');

  // backup_manifests (migration 6)
  runIfTable('backup_manifests', `INSERT INTO backup_manifests
    (id, server_id, filename, size_bytes, sha256, created_at,
     inventory_json, world_roots_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    'bm-drill-1', 'srv-1', 'backup-1.db', 1024, 'deadbeef', now,
    '[]', '[]');
}

/** Read all rows from a table and return a JSON string for comparison. */
function dumpTable(db, table) {
  return JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());
}

/* ── tests ───────────────────────────────────────────────────────── */

const tests = [];

/* 1. Idempotent no-op upgrade — v0.1.0 DB with rows survives v0.2 boot. */
tests.push(() => {
  buildV01Db();
  const db = open();
  insertRepresentativeRows(db);

  // Snapshot rows before the "upgrade".
  const before = {
    audit:      dumpTable(db, 'audit_events'),
    ops:        dumpTable(db, 'operations'),
    metrics:    dumpTable(db, 'metric_samples'),
    crashes:    dumpTable(db, 'crash_groups'),
    alerts:     dumpTable(db, 'health_alerts'),
    keys:       dumpTable(db, 'api_keys'),
    backups:    dumpTable(db, 'backup_manifests'),
    migrations: dumpTable(db, 'schema_migrations'),
  };
  close();

  // Simulate v0.2 boot: run the full migration runner.
  // Since all 12 are already applied, this should be a no-op.
  const r = migrations.runMigrations();
  assert.strictEqual(r.applied.length, 0, 'no-op upgrade should apply zero migrations');

  // Reopen and compare every row byte-identical.
  const db2 = open();
  assert.strictEqual(dumpTable(db2, 'audit_events'), before.audit,    'audit_events drifted');
  assert.strictEqual(dumpTable(db2, 'operations'),    before.ops,     'operations drifted');
  assert.strictEqual(dumpTable(db2, 'metric_samples'),before.metrics, 'metric_samples drifted');
  assert.strictEqual(dumpTable(db2, 'crash_groups'),  before.crashes, 'crash_groups drifted');
  assert.strictEqual(dumpTable(db2, 'health_alerts'), before.alerts,  'health_alerts drifted');
  assert.strictEqual(dumpTable(db2, 'api_keys'),      before.keys,    'api_keys drifted');
  assert.strictEqual(dumpTable(db2, 'backup_manifests'), before.backups, 'backup_manifests drifted');

  // All v0.1.0 migration versions are still recorded.
  const versions = db2.prepare('SELECT version FROM schema_migrations ORDER BY version')
    .all().map((r) => r.version);
  for (let v = 1; v <= 12; v++) {
    assert.ok(versions.includes(v), `schema_migrations should contain version ${v}`);
  }

  close();
  console.log('ok  upgrade-drill: idempotent no-op upgrade preserves all rows');
});

/* 2. Pending-migration upgrade — snapshot is created when there are pending
 *    migrations, and data survives. */
tests.push(() => {
  fresh();
  // Remove everything after migration 11 temporarily so only 1–11 are
  // applied (simulating a v0.1.0 DB that predates the api-keys and bug-report
  // schemas).
  // Restore right after so the runner can pick them up as pending.
  // (Find the split by name: newer migrations sit after it in the array.)
  const idx = migrations.MIGRATIONS.findIndex((m) => m.name === 'api-keys');
  assert.ok(idx > 0, 'api-keys migration should exist');
  const tail = migrations.MIGRATIONS.splice(idx);   // api-keys + the newer tail
  const r1 = migrations.runMigrations();            // applies 1–11
  migrations.MIGRATIONS.push(...tail);              // restore immediately
  assert.strictEqual(r1.applied.length, 11, 'should apply 11 migrations');

  const db = open();
  insertRepresentativeRows(db);                // skips api_keys (table missing)
  const beforeOps = dumpTable(db, 'operations');
  close();

  // Run the runner — it should pick up all pending migrations.
  const r2 = migrations.runMigrations();
  assert.strictEqual(r2.applied.length, 4, 'should apply the pending migrations');
  assert.strictEqual(r2.applied[0].name, 'api-keys');
  assert.strictEqual(r2.applied[1].name, 'drop-backup-drills');
  assert.strictEqual(r2.applied[2].name, 'bug-reports');
  assert.strictEqual(r2.applied[3].name, 'edge-product-foundation');

  // A snapshot was created before the upgrade ran.
  assert.ok(r2.snapshot, 'upgrade should produce a pre-migration snapshot');
  const snapBasename = path.basename(r2.snapshot);
  assert.ok(
    snapBasename.startsWith('fleetdeck-'),
    `snapshot should use fleetdeck- prefix, got: ${snapBasename}`,
  );

  // Snapshot file actually exists on disk.
  assert.ok(fs.existsSync(r2.snapshot), 'snapshot file should exist on disk');

  // Data survived.
  const db2 = open();
  assert.strictEqual(dumpTable(db2, 'operations'), beforeOps, 'operations drifted after upgrade');

  // The pending migration versions are now recorded.
  const v12row = db2.prepare('SELECT version FROM schema_migrations WHERE version = 12').get();
  assert.ok(v12row, 'migration 12 should be recorded');
  const v14row = db2.prepare('SELECT version FROM schema_migrations WHERE version = 14').get();
  assert.ok(v14row, 'migration 14 should be recorded');
  const v15row = db2.prepare('SELECT version FROM schema_migrations WHERE version = 15').get();
  assert.ok(v15row, 'migration 15 should be recorded');

  close();
  console.log('ok  upgrade-drill: pending migration creates snapshot, data survives');
});

/* 3. Rollback — a deliberately broken migration restores the prior snapshot
 *    and the DB is usable at the prior version. */
tests.push(() => {
  fresh();
  migrations.runMigrations();

  const db = open();
  insertRepresentativeRows(db);
  const beforeAudit = dumpTable(db, 'audit_events');
  close();

  // Inject a broken migration at version 99.
  migrations.MIGRATIONS.push({
    version: 99,
    name: 'broken-migration',
    up() { throw new Error('deliberate failure for rollback test'); },
  });

  let caught = null;
  try { migrations.runMigrations(); } catch (e) { caught = e; }
  assert.ok(caught, 'broken migration should throw');
  assert.ok(caught.migrationError, 'error should carry migrationError');
  assert.ok(caught.snapshot, 'error should carry snapshot path');

  // The snapshot file should exist (it's the pre-migration copy).
  assert.ok(fs.existsSync(caught.snapshot), 'pre-migration snapshot should exist on disk');

  // Clean up the broken migration entry.
  migrations.MIGRATIONS.pop();

  // Run again — should succeed (no broken migration, no pending).
  const r2 = migrations.runMigrations();
  assert.strictEqual(r2.applied.length, 0, 'should be no pending migrations');

  // The broken version was NOT recorded.
  const db2 = open();
  const badRow = db2.prepare('SELECT 1 FROM schema_migrations WHERE version = 99').get();
  assert.ok(!badRow, 'broken migration should not be recorded');

  // All original data survived the rollback.
  assert.strictEqual(dumpTable(db2, 'audit_events'), beforeAudit, 'audit_events drifted after rollback');

  close();
  console.log('ok  upgrade-drill: broken migration restores snapshot, data intact');
});

/* 4. Schema completeness — every v0.1.0 table exists after upgrade. */
tests.push(() => {
  buildV01Db();
  migrations.runMigrations(); // no-op, but exercises the runner path.

  const db = open();
  const expected = [
    'schema_migrations', 'data_imports', 'audit_events',
    'capability_grants', 'operations', 'operation_events', 'snapshots',
    'metric_samples', 'crash_groups', 'crash_incidents', 'crash_conclusions',
    'content_provenance', 'compatibility_cache', 'update_plans',
    'modpack_manifests', 'modpack_files', 'modpack_conflict_decisions',
    'modpack_previews', 'backup_manifests', 'backup_verifications',
    'backup_previews', 'backup_game_metadata',
    'metric_rollups', 'health_baselines', 'health_alerts',
    'health_analysis', 'health_settings',
    'world_inventory', 'world_operations', 'world_previews',
    'templates', 'template_versions', 'template_import_previews',
    'api_keys',
    'byoc_targets', 'pairing_challenges', 'byoc_agents', 'restore_drills', 'product_events',
  ];
  for (const t of expected) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    assert.ok(row, `missing table after upgrade: ${t}`);
  }
  close();
  console.log('ok  upgrade-drill: all v0.1.0 tables present after upgrade');
});

/* ── run ─────────────────────────────────────────────────────────── */

let failed = 0;
for (let i = 0; i < tests.length; i++) {
  try { tests[i](); }
  catch (e) { failed++; console.error(`FAIL  upgrade-drill test ${i + 1}: ${e.message}\n${e.stack}`); }
}

close();
teardown();
if (failed) { console.error(`FAIL  ${failed} upgrade-drill test(s) failed`); process.exit(1); }
console.log('PASS  upgrade-drill');
