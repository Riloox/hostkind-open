'use strict';

const assert = require('assert');
const { setupDataDir, teardown } = require('./_setup.cjs');
setupDataDir();

const { open, close, dbPath } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');
const audit = require('../lib/audit.cjs');

function fresh() {
  close();
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath() + ext;
    if (fs_exists(p)) try { fs_unlink(p); } catch { /* */ }
  }
}
function fs_exists(p) { return require('fs').existsSync(p); }
function fs_unlink(p) { return require('fs').unlinkSync(p); }

fresh();
migrations.runMigrations();

const tests = [];

// 1. record() inserts a row.
tests.push(() => {
  const r = audit.record({
    actorId: 'user-1',
    serverId: 'srv-1',
    action: 'server.start',
    target: { id: 'srv-1' },
    outcome: 'success',
  });
  assert.ok(r.id);
  const db = open();
  const row = db.prepare('SELECT * FROM audit_events WHERE id = ?').get(r.id);
  assert.ok(row);
  assert.strictEqual(row.actor_id, 'user-1');
  assert.strictEqual(row.server_id, 'srv-1');
  assert.strictEqual(row.action, 'server.start');
  assert.strictEqual(row.outcome, 'success');
});

// 2. secret redaction happens in target/metadata.
tests.push(() => {
  audit.record({
    actorId: 'user-1',
    serverId: 'srv-1',
    action: 'login',
    target: { identifier: 'admin', password: 'hunter2 hunter2 hunter2' },
    outcome: 'success',
  });
  const list = audit.list({ actorId: 'user-1' });
  const row = list.items.find((r) => r.action === 'login' && r.target && r.target.password);
  assert.ok(row, 'expected the login row to be returned');
  assert.ok(/REDACTED/.test(row.target.password), 'password should be redacted in stored target');
});

// 3. JWT and webhook URLs are redacted.
tests.push(() => {
  audit.record({
    actorId: 'user-1',
    action: 'config.update',
    target: { note: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.f4OxZX7p3PzN8vR_test' },
    outcome: 'success',
  });
  audit.record({
    actorId: 'user-1',
    action: 'discord.test',
    target: { note: 'https://discord.com/api/webhooks/1234567890/abcdefghijklmnop-qrstuvwxyz' },
    outcome: 'success',
  });
  const list = audit.list({ actorId: 'user-1' });
  const jwtRow = list.items.find((r) => r.action === 'config.update');
  const whRow = list.items.find((r) => r.action === 'discord.test');
  assert.ok(/REDACTED_JWT/.test(jwtRow.target.note), 'JWT should be redacted');
  assert.ok(/REDACTED_WEBHOOK/.test(whRow.target.note), 'webhook should be redacted');
});

// 4. list() respects filters and orders newest-first.
tests.push(() => {
  for (let i = 0; i < 5; i++) {
    audit.record({ actorId: 'user-2', action: 'noop', outcome: 'success', ts: Date.now() - i * 1000 });
  }
  const list = audit.list({ actorId: 'user-2', limit: 3 });
  assert.strictEqual(list.items.length, 3);
  for (let i = 0; i < list.items.length - 1; i++) {
    assert.ok(list.items[i].ts >= list.items[i + 1].ts, 'list should be ordered newest-first');
  }
});

// 5. tour.event records are stored with metadata intact.
tests.push(() => {
  const r = audit.record({
    actorId: 'user-tour',
    action: 'tour.event',
    outcome: 'success',
    metadata: { type: 'complete', step: 8, total: 8, game: 'minecraft', variant: 'full' },
  });
  assert.ok(r.id);
  const db = open();
  const row = db.prepare('SELECT * FROM audit_events WHERE id = ?').get(r.id);
  assert.ok(row);
  assert.strictEqual(row.action, 'tour.event');
  const meta = audit.safeJson(row.metadata);
  assert.strictEqual(meta.type, 'complete');
  assert.strictEqual(meta.step, 8);
  assert.strictEqual(meta.total, 8);
  assert.strictEqual(meta.game, 'minecraft');
  assert.strictEqual(meta.variant, 'full');
});

// 6. tour.event supports all lifecycle types.
tests.push(() => {
  const types = ['start', 'step', 'complete', 'dismiss'];
  for (const type of types) {
    audit.record({
      actorId: 'user-tour-2',
      action: 'tour.event',
      outcome: 'success',
      metadata: { type, step: 1, total: 8, game: 'terraria', variant: 'whatsnew' },
    });
  }
  const list = audit.list({ actorId: 'user-tour-2', action: 'tour.event' });
  assert.strictEqual(list.items.length, 4, `expected 4 tour events, got ${list.items.length}`);
  for (const item of list.items) {
    assert.strictEqual(item.action, 'tour.event');
    assert.ok(types.includes(item.metadata.type), `unexpected type: ${item.metadata.type}`);
  }
});

let failed = 0;
for (let i = 0; i < tests.length; i++) {
  try { tests[i](); console.log(`ok  audit test ${i + 1}`); }
  catch (e) { failed++; console.error(`FAIL  audit test ${i + 1}: ${e.message}`); }
}

close();
teardown();
if (failed) { console.error(`FAIL  ${failed} audit test(s) failed`); process.exit(1); }
console.log('PASS  foundation-audit');
