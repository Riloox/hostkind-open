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

// 1. admins always pass.
tests.push(() => {
  const admin = { id: 'admin-1', role: 'admin' };
  assert.ok(capabilities.has(admin, 'srv-1', capabilities.CAPABILITIES.SERVER_CONTROL));
});

// 2. non-admins need an explicit grant.
tests.push(() => {
  const op = { id: 'op-1', role: 'operator' };
  assert.ok(!capabilities.has(op, 'srv-1', capabilities.CAPABILITIES.SERVER_CONTROL));
  capabilities.grant(op.id, 'srv-1', capabilities.CAPABILITIES.SERVER_CONTROL, 'admin-1');
  assert.ok(capabilities.has(op, 'srv-1', capabilities.CAPABILITIES.SERVER_CONTROL));
  // Other servers still denied.
  assert.ok(!capabilities.has(op, 'srv-2', capabilities.CAPABILITIES.SERVER_CONTROL));
});

// 3. server-agnostic grants apply to every server.
tests.push(() => {
  const op = { id: 'op-2', role: 'operator' };
  capabilities.grant(op.id, null, capabilities.CAPABILITIES.FLEET_VIEW, 'admin-1');
  assert.ok(!capabilities.has(op, 'srv-1', capabilities.CAPABILITIES.FLEET_VIEW));
  assert.ok(!capabilities.has(op, 'srv-2', capabilities.CAPABILITIES.FLEET_VIEW));
  assert.ok(capabilities.has(op, null, capabilities.CAPABILITIES.FLEET_VIEW));
  capabilities.grant(op.id, null, capabilities.CAPABILITIES.FLEET_VIEW, 'admin-1');
  assert.strictEqual(capabilities.listForUser(op.id).filter((g) => g.capability === capabilities.CAPABILITIES.FLEET_VIEW).length, 1);
});

// 4. revoke removes a grant.
tests.push(() => {
  const op = { id: 'op-3', role: 'operator' };
  capabilities.grant(op.id, 'srv-1', capabilities.CAPABILITIES.SERVER_CONTROL, 'admin-1');
  assert.ok(capabilities.has(op, 'srv-1', capabilities.CAPABILITIES.SERVER_CONTROL));
  capabilities.revoke(op.id, 'srv-1', capabilities.CAPABILITIES.SERVER_CONTROL);
  assert.ok(!capabilities.has(op, 'srv-1', capabilities.CAPABILITIES.SERVER_CONTROL));
});

// 5. requireCap middleware 403s for non-grant.
tests.push(() => {
  const op = { id: 'op-4', role: 'operator' };
  const calls = [];
  const req = { user: op, query: { serverId: 'srv-1' } };
  const res = { status(c) { calls.push(c); return this; }, json(o) { calls.push(o); return this; } };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  capabilities.requireCap(capabilities.CAPABILITIES.SERVER_CONTROL)(req, res, next);
  assert.strictEqual(calls[0], 403);
  assert.ok(!nextCalled);
});

// 6. requireCap middleware passes for admin and stamps req.serverId.
tests.push(() => {
  const admin = { id: 'admin-2', role: 'admin' };
  const req = { user: admin, query: { serverId: 'srv-1' } };
  let nextCalled = false;
  const next = () => { nextCalled = true; };
  capabilities.requireCap(capabilities.CAPABILITIES.SERVER_CONTROL)(req, {}, next);
  assert.ok(nextCalled);
  assert.strictEqual(req.serverId, 'srv-1');
});

// 7. deleteUserGrants / deleteServerGrants.
tests.push(() => {
  const op = { id: 'op-5', role: 'operator' };
  capabilities.grant(op.id, 'srv-A', capabilities.CAPABILITIES.SERVER_CONTROL, 'admin-1');
  capabilities.grant(op.id, 'srv-B', capabilities.CAPABILITIES.SERVER_CONTROL, 'admin-1');
  const c1 = capabilities.deleteUserGrants(op.id);
  assert.ok(c1 >= 2);
  assert.ok(!capabilities.has(op, 'srv-A', capabilities.CAPABILITIES.SERVER_CONTROL));
});

let failed = 0;
for (let i = 0; i < tests.length; i++) {
  try { tests[i](); console.log(`ok  capabilities test ${i + 1}`); }
  catch (e) { failed++; console.error(`FAIL  capabilities test ${i + 1}: ${e.message}\n${e.stack}`); }
}

close();
teardown();
if (failed) { console.error(`FAIL  ${failed} capabilities test(s) failed`); process.exit(1); }
console.log('PASS  foundation-capabilities');
