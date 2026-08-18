'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { setupDataDir, teardown, TMP_ROOT } = require('./_setup.cjs');
setupDataDir();

const { close, dbPath } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');
const foundation = require('../lib/foundation.cjs');
const ops = require('../lib/operations.cjs');
const audit = require('../lib/audit.cjs');
const caps = require('../lib/capabilities.cjs');

function fresh() {
  close();
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath() + ext;
    if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch { /* */ }
  }
  // Remove the data dir so the foundation creates it fresh.
  const dataDir = path.dirname(dbPath());
  if (fs.existsSync(dataDir)) {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
  }
}

const tests = [];

// 1. boot is idempotent and creates the data dir.
tests.push(() => {
  fresh();
  const r = foundation.bootFoundation({ servers: [], logFn: () => {} });
  assert.ok(r.ok, `boot should succeed: ${JSON.stringify(r)}`);
  assert.ok(fs.existsSync(path.dirname(dbPath())), 'data dir should be created');
});

// 2. boot on a second call does not re-run migrations and does not duplicate imports.
tests.push(() => {
  fresh();
  foundation.bootFoundation({ servers: [], logFn: () => {} });
  const r2 = foundation.bootFoundation({ servers: [], logFn: () => {} });
  const migrateStep = r2.steps.find((s) => s.step === 'migrate');
  assert.strictEqual(migrateStep.applied, 0, 'second boot should apply zero migrations');
});

// 3. foundationStatus reports table counts.
tests.push(() => {
  fresh();
  foundation.bootFoundation({ servers: [], logFn: () => {} });
  const status = foundation.foundationStatus();
  assert.ok(status.ok);
  assert.ok(status.dbPath);
  assert.ok(status.applied.length >= 1);
});

// 4. boot sweeps stale staging directories left over from a prior crash.
tests.push(() => {
  fresh();
  const serverDir = fs.mkdtempSync(path.join(TMP_ROOT, 'srv-boot-'));
  const orphan = path.join(serverDir, '.fleetdeck', 'staging', 'op-orphan');
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'junk'), 'x');
  foundation.bootFoundation({ servers: [{ id: 'srv-boot', dir: serverDir }], logFn: () => {} });
  assert.ok(!fs.existsSync(orphan), 'orphan staging dir should be swept');
});

let failed = 0;
for (let i = 0; i < tests.length; i++) {
  try { tests[i](); console.log(`ok  foundation boot test ${i + 1}`); }
  catch (e) { failed++; console.error(`FAIL  foundation boot test ${i + 1}: ${e.message}\n${e.stack}`); }
}

close();
teardown();
if (failed) { console.error(`FAIL  ${failed} foundation boot test(s) failed`); process.exit(1); }
console.log('PASS  foundation-boot');
