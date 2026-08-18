'use strict';

const assert = require('assert');
const { setupDataDir, teardown } = require('./_setup.cjs');
setupDataDir();

const { close, dbPath } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');
const redact = require('../lib/redact.cjs');
const guard = require('../lib/archiveGuard.cjs');

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

// Redact: string patterns
tests.push(() => {
  const r = redact.redactString('Bearer eyJabc.eyJabc.sig-sig-sig');
  assert.ok(r.hits.includes('bearer'), `expected bearer hit, got ${r.hits.join(',')}`);
  assert.ok(/REDACTED/.test(r.text));
});

tests.push(() => {
  const r = redact.redactString('https://discord.com/api/webhooks/1234567890/abcdefghij');
  assert.ok(r.hits.includes('discord-webhook'));
  assert.ok(/REDACTED_WEBHOOK/.test(r.text));
});

tests.push(() => {
  const r = redact.redactString('login from 192.168.1.42 with pwd=hunter2 ok');
  assert.ok(r.hits.includes('ip'));
  assert.ok(r.hits.includes('password'));
  assert.ok(/REDACTED_IP/.test(r.text));
  assert.ok(/REDACTED/.test(r.text));
});

// Redact: object walk
tests.push(() => {
  const o = redact.redactObject({
    user: 'alice',
    creds: { token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.4f5g6h7j8k9l0m', password: 'pwd=verysecretstring' },
    history: [{ ip: '10.0.0.5' }],
  });
  assert.strictEqual(o.user, 'alice');
  assert.ok(/REDACTED/.test(o.creds.token));
  assert.ok(/REDACTED/.test(o.creds.password));
  assert.ok(/REDACTED_IP/.test(o.history[0].ip));
});

// archiveGuard: traversal, absolute, symlink, ratio, duplicates.
tests.push(() => {
  const state = { entries: 0, totalSize: 0, totalCompressedSize: 0, seen: new Set() };
  guard.checkEntry({ fileName: 'a/b.txt', uncompressedSize: 100, compressedSize: 50 }, state);
  assert.strictEqual(state.entries, 1);
  assert.throws(() => guard.checkEntry({ fileName: '../etc/passwd', uncompressedSize: 100 }, state), /escapes/);
});

tests.push(() => {
  const state = { entries: 0, totalSize: 0, totalCompressedSize: 0, seen: new Set() };
  assert.throws(() => guard.checkEntry({ fileName: 'C:/Windows/System32', uncompressedSize: 10 }, state), /absolute/);
});

tests.push(() => {
  const state = { entries: 0, totalSize: 0, totalCompressedSize: 0, seen: new Set() };
  assert.throws(() => guard.checkEntry({ fileName: 'link', uncompressedSize: 0, compressedSize: 0, externalFileAttributes: 0xA1FF0000 }, state), /symlink/);
});

tests.push(() => {
  const state = { entries: 0, totalSize: 0, totalCompressedSize: 0, seen: new Set() };
  guard.checkEntry({ fileName: 'a.txt', uncompressedSize: 100, compressedSize: 50 }, state);
  assert.throws(() => guard.checkEntry({ fileName: 'A.TXT', uncompressedSize: 100, compressedSize: 50 }, state), /duplicate/);
});

tests.push(() => {
  const state = { entries: 0, totalSize: 0, totalCompressedSize: 0, seen: new Set() };
  // 10MB uncompressed packed into 1KB: ratio 10000 > 200.
  assert.throws(() => guard.checkEntry({ fileName: 'bomb.txt', uncompressedSize: 10 * 1024 * 1024, compressedSize: 1024 }, state), /ratio/);
});

tests.push(() => {
  const state = { entries: 0, totalSize: 0, totalCompressedSize: 0, seen: new Set() };
  for (let i = 0; i < 10; i++) {
    guard.checkEntry({ fileName: `f${i}.txt`, uncompressedSize: 1000, compressedSize: 500 }, state);
  }
  const out = guard.finalize(state);
  assert.strictEqual(out.entries, 10);
});

tests.push(() => {
  // Total size cap.
  const state = { entries: 0, totalSize: 0, totalCompressedSize: 0, seen: new Set() };
  let caught = null;
  try {
    guard.checkEntry({ fileName: 'big.bin', uncompressedSize: 9 * 1024 * 1024 * 1024, compressedSize: 1024 }, state);
  } catch (e) { caught = e; }
  assert.ok(caught, 'expected a size-cap error');
  assert.strictEqual(caught.code, 'too_large_total');
});

let failed = 0;
for (let i = 0; i < tests.length; i++) {
  try { tests[i](); console.log(`ok  redact/archive test ${i + 1}`); }
  catch (e) { failed++; console.error(`FAIL  redact/archive test ${i + 1}: ${e.message}\n${e.stack}`); }
}

close();
teardown();
if (failed) { console.error(`FAIL  ${failed} redact/archive test(s) failed`); process.exit(1); }
console.log('PASS  foundation-redact-archive');
