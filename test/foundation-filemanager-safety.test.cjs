'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setupDataDir, teardown } = require('./_setup.cjs');
setupDataDir();

const pathSafety = require('../lib/pathSafety.cjs');

/*
 * The file-manager guards live in lib/routes/files.cjs (extracted from the
 * large server module, which cannot be required in isolation as it boots the
 * whole panel). These tests exercise the same resolver contract against real
 * symlinks; keep them in step with safeResolve / safeResolveNoFollow in
 * lib/routes/files.cjs.
 */
function safeResolve(root, rel) {
  const base = path.resolve(root);
  const target = path.resolve(base, '.' + path.sep + (rel || '').replace(/^[\\/]+/, ''));
  const rootWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(rootWithSep)) return null;
  return target;
}
function safeResolveNoFollow(root, rel) {
  const abs = safeResolve(root, rel);
  if (!abs) return null;
  const how = pathSafety.relation(abs, root);
  return how === 'same' || how === 'inside' ? abs : null;
}

// A directory junction needs no admin rights on Windows; a plain symlink works
// elsewhere. Realpath resolves both, which is what the resolver relies on.
function symlinkTo(target, linkPath) {
  if (process.platform === 'win32') {
    if (fs.statSync(target).isDirectory()) {
      fs.symlinkSync(target, linkPath, 'junction');
      return 'junction';
    }
    fs.symlinkSync(target, linkPath, 'file');
    return 'file';
  }
  const type = fs.statSync(target).isDirectory() ? 'dir' : 'file';
  fs.symlinkSync(target, linkPath, type);
  return type;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-path-'));
const root = path.join(tmp, 'server');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(root, 'ok.txt'), 'inside');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');

const tests = [];

tests.push(() => {
  assert.strictEqual(safeResolveNoFollow(root, 'ok.txt'), path.join(root, 'ok.txt'));
  assert.strictEqual(safeResolveNoFollow(root, ''), path.resolve(root));
});

tests.push(() => {
  assert.strictEqual(safeResolveNoFollow(root, '../outside/secret.txt'), null);
  assert.strictEqual(safeResolveNoFollow(root, 'a/../../..'), null);
});

tests.push(() => {
  const link = path.join(root, 'escape-file');
  let created = true;
  try {
    symlinkTo(path.join(outside, 'secret.txt'), link);
  } catch (e) {
    // File symlinks need SeCreateSymbolicLinkPrivilege on Windows (Developer
    // Mode or an elevated shell); without it creation is EPERM. The junction
    // case below still proves directory links cannot escape, so skip the
    // file-link assertion rather than fail on the platform privilege.
    created = false;
    skipped++;
    console.log(`skip  file-symlink escape (${e.code || 'EPERM'}: symlink creation not permitted here)`);
  }
  if (created) {
    assert.strictEqual(safeResolveNoFollow(root, 'escape-file'), null, 'a file symlink out of the root must be refused');
    assert.strictEqual(safeResolveNoFollow(root, 'escape-file/anything'), null);
    // The real file behind the link must never be reached.
    assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret');
  }
});

tests.push(() => {
  const link = path.join(root, 'escape-dir');
  symlinkTo(outside, link);
  assert.strictEqual(safeResolveNoFollow(root, 'escape-dir'), null, 'a directory link out of the root must be refused');
  assert.strictEqual(safeResolveNoFollow(root, 'escape-dir/secret.txt'), null);
});

tests.push(() => {
  const inner = path.join(root, 'inner');
  fs.mkdirSync(inner, { recursive: true });
  symlinkTo(inner, path.join(root, 'link-inside'));
  assert.strictEqual(
    safeResolveNoFollow(root, 'link-inside/file.txt'),
    path.join(root, 'link-inside', 'file.txt'),
    'a link that stays inside the root must still be allowed',
  );
});

tests.push(() => {
  assert.strictEqual(safeResolveNoFollow(root, 'inner'), path.join(root, 'inner'));
});

// The live file-manager routes must send every path through the
// symlink-safe resolver, never the lexical prefix check alone. The routes
// were extracted from server.js into lib/routes/files.cjs; paths there are
// router-relative under the /api/files mount.
tests.push(() => {
  const FILES_ROUTER = fs.readFileSync(path.join(__dirname, '..', 'lib', 'routes', 'files.cjs'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(/function safeResolveNoFollow\(root, rel\)/.test(FILES_ROUTER));
  for (const marker of [
    "router.get('/'",
    "router.get('/read'",
    "router.put('/write'",
    "router.post('/mkdir'",
    "router.post('/rename'",
    "router.delete('/'",
    "router.get('/download'",
  ]) {
    const start = FILES_ROUTER.indexOf(marker);
    assert.ok(start >= 0, `${marker} must exist in lib/routes/files.cjs`);
    // Each handler runs to the next router registration (handlers are
    // indented inside the factory, so brace-counting closings is fragile;
    // the span to the next route fully contains this handler's body).
    const after = FILES_ROUTER.slice(start + marker.length);
    const nextRel = after.search(/\n\s*router\.(get|post|put|delete|patch|use)\(/);
    const body = nextRel < 0 ? after : after.slice(0, nextRel);
    assert.ok(/safeResolveNoFollow/.test(body), `${marker} must use safeResolveNoFollow`);
  }
  const destStart = FILES_ROUTER.indexOf('destination:');
  assert.ok(destStart >= 0, 'upload destination must exist in lib/routes/files.cjs');
  const destEnd = FILES_ROUTER.indexOf('filename:', destStart);
  assert.ok(/safeResolveNoFollow/.test(FILES_ROUTER.slice(destStart, destEnd)), 'upload destination must use safeResolveNoFollow');
});

let failed = 0;
let skipped = 0;
for (let i = 0; i < tests.length; i++) {
  try { tests[i](); console.log(`ok  filemanager-safety test ${i + 1}`); }
  catch (e) { failed++; console.error(`FAIL  filemanager-safety test ${i + 1}: ${e.message}\n${e.stack}`); }
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
teardown();
if (failed) { console.error(`FAIL  ${failed} filemanager-safety test(s) failed`); process.exit(1); }
console.log(`PASS  foundation-filemanager-safety${skipped ? ` (${skipped} skipped)` : ''}`);
