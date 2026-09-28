'use strict';

/*
 * lib/updates.cjs pendingSummary: the overview's "n plugin updates available"
 * count. It reads only what earlier scans cached, so it must never hash files
 * or call Modrinth, and it must agree with scan() about what counts as newer.
 */

const assert = require('assert');
const { setupDataDir, teardown } = require('./_setup.cjs');
setupDataDir();

const migrations = require('../lib/migrations.cjs');
const { open, close } = require('../lib/db.cjs');
const { pendingSummary } = require('../lib/updates.cjs');

try {
  migrations.runMigrations();
  const db = open();
  const server = { id: 'srv-1', dir: '/nonexistent' };
  const compat = { mcVersion: '1.21.4', loaders: ['paper', 'spigot', 'bukkit'] };

  assert.deepStrictEqual(pendingSummary(server, compat), { available: 0, checkedAt: null });
  console.log('ok  nothing managed, nothing to report');

  const provenance = db.prepare(`INSERT INTO content_provenance
    (id, server_id, relative_path, kind, provider, project_id, version_id, mc_version, loader, sha256, managed_at)
    VALUES (?, ?, ?, 'plugin', ?, ?, ?, '1.21.4', 'paper', 'x', 0)`);
  provenance.run('a', 'srv-1', 'plugins/a.jar', 'modrinth', 'proj-a', 'v1');
  provenance.run('b', 'srv-1', 'plugins/b.jar', 'modrinth', 'proj-b', 'v7');
  provenance.run('c', 'srv-1', 'plugins/c.jar', 'modrinth', 'proj-c', 'v1');
  provenance.run('d', 'srv-1', 'plugins/d.jar', 'upload', 'proj-d', 'v1');
  provenance.run('e', 'srv-2', 'plugins/e.jar', 'modrinth', 'proj-a', 'v1');

  const cache = db.prepare(`INSERT INTO compatibility_cache VALUES ('modrinth', ?, ?, ?, 0, ?, NULL)`);
  const key = (project) => `${project}:1.21.4:paper,spigot,bukkit`;
  cache.run(key('proj-a'), 1000, 9e15, JSON.stringify([{ id: 'v2' }, { id: 'v1' }]));
  cache.run(key('proj-b'), 2000, 9e15, JSON.stringify([{ id: 'v7' }]));
  cache.run(key('proj-d'), 3000, 9e15, JSON.stringify([{ id: 'v9' }]));
  // proj-c was never scanned, so it has no cache row.

  assert.deepStrictEqual(pendingSummary(server, compat), { available: 1, checkedAt: 2000 });
  console.log('ok  counts only scanned Modrinth items with a newer version on this server');

  assert.deepStrictEqual(pendingSummary(server, { mcVersion: '1.20.1', loaders: compat.loaders }), { available: 0, checkedAt: null });
  assert.deepStrictEqual(pendingSummary(server, { mcVersion: '', loaders: [] }), { available: 0, checkedAt: null });
  assert.deepStrictEqual(pendingSummary(server, null), { available: 0, checkedAt: null });
  console.log('ok  another game version or no compatibility info reports nothing');

  close();
  teardown();
  console.log('PASS  updates-summary');
} catch (err) {
  close();
  teardown();
  console.error(err);
  process.exitCode = 1;
}
