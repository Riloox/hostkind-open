'use strict';

const assert = require('assert');
const { setupDataDir, teardown } = require('./_setup.cjs');
setupDataDir();

const { close, dbPath } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');
const capabilities = require('../lib/capabilities.cjs');

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

// 1. An operator granted SERVER_VIEW on server-a sees server-a but not server-b.
tests.push(() => {
  const op = { id: 'op-list-1', role: 'operator' };
  capabilities.grant(op.id, 'server-a', capabilities.CAPABILITIES.SERVER_VIEW, 'admin-1');
  assert.strictEqual(capabilities.hasAnyPerServerGrant(op, 'server-a'), true);
  assert.strictEqual(capabilities.hasAnyPerServerGrant(op, 'server-b'), false);
  assert.strictEqual(capabilities.hasAnyPerServerGrant(op, null), false);
});

// 2. Any per-server capability earns a row in the fleet, not just server.view.
tests.push(() => {
  const op = { id: 'op-list-2', role: 'operator' };
  capabilities.grant(op.id, 'server-c', capabilities.CAPABILITIES.BACKUPS_CREATE, 'admin-1');
  assert.strictEqual(capabilities.hasAnyPerServerGrant(op, 'server-c'), true);
});

// 3. A NULL-scope (global) grant is not a per-server grant on anything.
tests.push(() => {
  const op = { id: 'op-list-3', role: 'operator' };
  capabilities.grant(op.id, null, capabilities.CAPABILITIES.FLEET_VIEW, 'admin-1');
  assert.strictEqual(capabilities.hasAnyPerServerGrant(op, 'server-a'), false);
  assert.strictEqual(capabilities.hasAnyPerServerGrant(op, null), false);
});

// 4. Admins list everything; no identity lists nothing.
tests.push(() => {
  const admin = { id: 'admin-list-1', role: 'admin' };
  assert.strictEqual(capabilities.hasAnyPerServerGrant(admin, 'server-a'), true);
  assert.strictEqual(capabilities.hasAnyPerServerGrant(admin, 'does-not-exist'), true);
  assert.strictEqual(capabilities.hasAnyPerServerGrant(null, 'server-a'), false);
});

// 5. The handler's filter - mirrors app.get('/api/servers') in server.js.
tests.push(() => {
  const op = { id: 'op-list-4', role: 'operator' };
  capabilities.grant(op.id, 'fleet-a', capabilities.CAPABILITIES.SERVER_VIEW, 'admin-1');
  capabilities.grant(op.id, 'fleet-b', capabilities.CAPABILITIES.CONSOLE_VIEW, 'admin-1');
  const all = [{ id: 'fleet-a' }, { id: 'fleet-b' }, { id: 'fleet-c' }];
  const visible = all.filter((s) => capabilities.hasAnyPerServerGrant(op, s.id)).map((s) => s.id);
  assert.deepStrictEqual(visible.sort(), ['fleet-a', 'fleet-b']);
});

let failed = 0;
for (let i = 0; i < tests.length; i++) {
  try { tests[i](); console.log(`ok  server-list test ${i + 1}`); }
  catch (e) { failed++; console.error(`FAIL  server-list test ${i + 1}: ${e.message}\n${e.stack}`); }
}

close();
teardown();
if (failed) { console.error(`FAIL  ${failed} server-list test(s) failed`); process.exit(1); }
console.log('PASS  foundation-server-list');
