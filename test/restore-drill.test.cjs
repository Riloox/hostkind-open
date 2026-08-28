'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { inventoryDirectory, compareInventories, buildReport } = require('../lib/restore-drill.cjs');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-drill-')));
try {
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'server.properties'), 'motd=hello\n');
  fs.writeFileSync(path.join(root, 'world.dat'), 'world');

  const expected = inventoryDirectory(root);
  assert.deepStrictEqual(expected.map((entry) => entry.path), ['config/server.properties', 'world.dat']);
  assert.ok(expected.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
  assert.ok(expected.every((entry) => !path.isAbsolute(entry.path)));

  const same = compareInventories(expected, expected);
  assert.deepStrictEqual(same, { ok: true, missing: [], unexpected: [], changed: [] });

  fs.writeFileSync(path.join(root, 'config', 'server.properties'), 'motd=changed\n');
  fs.unlinkSync(path.join(root, 'world.dat'));
  fs.writeFileSync(path.join(root, 'extra.dat'), 'extra');
  const actual = inventoryDirectory(root);
  const diff = compareInventories(expected, actual);
  assert.strictEqual(diff.ok, false);
  assert.deepStrictEqual(diff.missing, ['world.dat']);
  assert.deepStrictEqual(diff.unexpected, ['extra.dat']);
  assert.deepStrictEqual(diff.changed, ['config/server.properties']);

  const failed = buildReport({ backupId: 'backup-1', target: 'drill-1', expected, actual, startedAt: 100, completedAt: 200 });
  assert.strictEqual(failed.status, 'failed');
  assert.strictEqual(failed.backupId, 'backup-1');
  assert.deepStrictEqual(failed.diff, diff);

  const succeeded = buildReport({ backupId: 'backup-1', target: 'drill-1', expected, actual: expected, startedAt: 100, completedAt: 200 });
  assert.strictEqual(succeeded.status, 'succeeded');
  assert.deepStrictEqual(succeeded.diff, { ok: true, missing: [], unexpected: [], changed: [] });

  assert.throws(() => compareInventories([{ path: '../escape', size: 1, sha256: 'a'.repeat(64) }], []), /path/i);
  console.log('PASS restore-drill');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
