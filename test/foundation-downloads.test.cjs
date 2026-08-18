'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { setupDataDir, teardown, TMP_ROOT } = require('./_setup.cjs');
setupDataDir();

const { close, dbPath } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');
const downloads = require('../lib/downloads.cjs');

function fresh() {
  close();
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath() + ext;
    if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch { /* */ }
  }
}

fresh();
migrations.runMigrations();

const tests = [];

// Spin up a tiny local HTTPS-ish server. The downloads module insists on
// https://, so we override the URL and the allowlist with a function that
// trusts our local host. We do this by reaching into the module: the
// fetchToFile function takes allowlist(host) => bool. We use http:// in
// tests by monkey-patching the protocol check; this is a test-only escape
// hatch we expose below.
const _orig = downloads.fetchToFile;

// Test-only downloader that uses http://. Mirrors fetchToFile but skips
// the protocol check.
async function fetchHttpToFile(url, destPath, opts = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:') throw new downloads.DownloadError('test: only http', 'test_protocol');
  if (opts.allowlist && !opts.allowlist(parsed.host)) throw new downloads.DownloadError('blocked', 'origin_blocked');
  return _orig(url, destPath, { ...opts });
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

tests.push(async function okDownload() {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end('hello world');
  });
  try {
    const dest = path.join(TMP_ROOT, 'dl-ok.bin');
    const r = await downloads.fetchToFile(url + '/file', dest, { allowInsecure: true, allowlist: () => true });
    assert.ok(r.ok, 'download should succeed');
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'hello world');
  } finally { server.close(); }
});

tests.push(async function sizeLimit() {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(Buffer.alloc(1024 * 1024));
  });
  try {
    const dest = path.join(TMP_ROOT, 'dl-big.bin');
    let caught = null;
    try {
      await downloads.fetchToFile(url + '/file', dest, { allowInsecure: true, allowlist: () => true, maxBytes: 1024 });
    } catch (e) { caught = e; }
    assert.ok(caught, 'expected a download error');
    assert.ok(caught.code === 'too_large' || caught.code === 'fetch_failed',
      `unexpected code: ${caught.code}`);
  } finally { server.close(); }
});

tests.push(async function hashMismatch() {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end('hello');
  });
  try {
    const dest = path.join(TMP_ROOT, 'dl-hash.bin');
    let caught = null;
    try {
      await downloads.fetchToFile(url + '/file', dest, {
        allowInsecure: true,
        allowlist: () => true,
        expectedSha256: '0'.repeat(64),
      });
    } catch (e) { caught = e; }
    assert.ok(caught, 'expected a hash mismatch error');
    assert.strictEqual(caught.code, 'hash_mismatch');
    assert.ok(!fs.existsSync(dest), 'part file should be cleaned up');
  } finally { server.close(); }
});

tests.push(async function httpRefused() {
  let caught = null;
  try {
    await downloads.fetchToFile('http://example.com/file', '/tmp/dl-refused.bin', { allowlist: () => true });
  } catch (e) { caught = e; }
  assert.ok(caught, 'expected a protocol refusal');
  assert.strictEqual(caught.code, 'insecure_scheme');
});

tests.push(async function allowlistBlocks() {
  const { server, url } = await startServer((req, res) => {
    res.writeHead(200); res.end('x');
  });
  try {
    let caught = null;
    try {
      await downloads.fetchToFile(url + '/file', path.join(TMP_ROOT, 'dl-blocked.bin'),
        { allowInsecure: true, allowlist: (host) => host === 'blocked.example' });
    } catch (e) { caught = e; }
    assert.ok(caught, 'expected an allowlist block');
    assert.strictEqual(caught.code, 'origin_blocked');
  } finally { server.close(); }
});

tests.push(async function cacheFresh() {
  const cache = downloads.newCacheEntry({ key: 'k1', source: 'test', url: 'https://example.invalid' });
  cache.retrievedAt = Date.now();
  cache.path = path.join(TMP_ROOT, 'dl-cache-existing.bin');
  fs.writeFileSync(cache.path, 'cached-body');
  const r = await downloads.fetchWithCache({ cache, destPath: path.join(TMP_ROOT, 'dl-cache.bin'), opts: { allowInsecure: true, allowlist: () => true } });
  assert.ok(r.cached, 'should use cache');
  assert.strictEqual(r.path, cache.path);
  assert.strictEqual(fs.readFileSync(r.path, 'utf8'), 'cached-body');
});

function waitForPart(dest, size, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      try {
        if (fs.statSync(dest + '.part').size >= size) return resolve();
      } catch { /* not there yet */ }
      if (Date.now() - started > timeoutMs) return resolve();
      setTimeout(check, 20);
    };
    check();
  });
}

// An interrupted download leaves the .part in place and the bytes already
// written; a retry with resume:true continues from the exact byte offset.
tests.push(async function interruptedLeavesResumablePart() {
  const body = Buffer.from('resume-payload-content-that-gets-cut');
  const cut = 10;
  let requests = 0;
  const { server, url } = await startServer((req, res) => {
    requests += 1;
    if (requests === 1) {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.write(body.slice(0, cut));
      // Kill the connection partway, like a dropped socket mid-download.
      setTimeout(() => res.destroy(), 30);
      return;
    }
    const range = req.headers.range;
    assert.ok(range, `resume must send a Range header, got ${range}`);
    const m = /^bytes=(\d+)-$/.exec(range);
    assert.ok(m, `unexpected range: ${range}`);
    const from = Number(m[1]);
    assert.strictEqual(from, cut, `resume must continue from byte ${cut}, got ${from}`);
    res.writeHead(206, {
      'content-range': `bytes ${from}-${body.length - 1}/${body.length}`,
      'content-length': String(body.length - from),
    });
    res.end(body.slice(from));
  });
  try {
    const dest = path.join(TMP_ROOT, 'dl-resume.bin');
    let caught = null;
    try {
      await downloads.fetchToFile(url + '/file', dest, { allowInsecure: true, allowlist: () => true });
    } catch (e) { caught = e; }
    assert.ok(caught, 'the killed connection must fail the first fetch');
    await waitForPart(dest, cut);
    assert.ok(fs.existsSync(dest + '.part'), 'a .part file must survive the interruption');
    assert.strictEqual(fs.statSync(dest + '.part').size, cut, 'the .part must hold the partial bytes');

    const r = await downloads.fetchToFile(url + '/file', dest, { allowInsecure: true, allowlist: () => true, resume: true });
    assert.ok(r.ok);
    assert.strictEqual(r.resumed.from, cut, 'resume must report the byte it continued from');
    assert.strictEqual(r.resumed.to, body.length);
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), body.toString('utf8'));
    assert.ok(!fs.existsSync(dest + '.part'), 'the .part must be promoted on success');
  } finally { server.close(); }
});

// A server that answers 200 in response to a Range (it ignored the header)
// restarts from zero instead of appending garbage, and the final file is whole.
tests.push(async function resumeRestartsWhenServerIgnoresRange() {
  const body = Buffer.from('range-ignored-server-body');
  const cut = 6;
  let sawRange = false;
  const { server, url } = await startServer((req, res) => {
    if (req.headers.range) sawRange = true;
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(body);
  });
  try {
    const dest = path.join(TMP_ROOT, 'dl-norange.bin');
    fs.writeFileSync(dest + '.part', body.slice(0, cut));
    const r = await downloads.fetchToFile(url + '/file', dest, { allowInsecure: true, allowlist: () => true, resume: true });
    assert.ok(r.ok);
    assert.ok(sawRange, 'resume must ask for a range even when the server ignores it');
    assert.strictEqual(r.resumed.restarted, true, 'a 200 answer to a Range must restart from zero');
    assert.strictEqual(r.resumed.from, 0);
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), body.toString('utf8'));
    assert.ok(!fs.existsSync(dest + '.part'));
  } finally { server.close(); }
});

// A resumed download still verifies the hash over the WHOLE file, not just
// the appended tail.
tests.push(async function resumeVerifiesWholeFileHash() {
  const body = Buffer.from('hash-resume-body-content');
  const cut = 8;
  const { server, url } = await startServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      const from = Number(/^bytes=(\d+)-$/.exec(range)[1]);
      res.writeHead(206, {
        'content-range': `bytes ${from}-${body.length - 1}/${body.length}`,
        'content-length': String(body.length - from),
      });
      res.end(body.slice(from));
    } else {
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
    }
  });
  try {
    const dest = path.join(TMP_ROOT, 'dl-hashresume.bin');
    fs.writeFileSync(dest + '.part', body.slice(0, cut));
    const sha = crypto.createHash('sha256').update(body).digest('hex');
    const r = await downloads.fetchToFile(url + '/file', dest, { allowInsecure: true, allowlist: () => true, resume: true, expectedSha256: sha });
    assert.strictEqual(r.sha256, sha);
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), body.toString('utf8'));
  } finally { server.close(); }
});

// A .part that already holds the whole body (the process died between the
// last byte and the promoting rename) promotes as-is when the server answers
// 416 with a matching Content-Range.
tests.push(async function resumePromotesWhenAlreadyComplete() {
  const body = Buffer.from('already-complete-body');
  const { server, url } = await startServer((req, res) => {
    assert.ok(req.headers.range, 'a resume must send a Range header');
    res.writeHead(416, { 'content-range': `bytes */${body.length}` });
    res.end();
  });
  try {
    const dest = path.join(TMP_ROOT, 'dl-416.bin');
    fs.writeFileSync(dest + '.part', body);
    const r = await downloads.fetchToFile(url + '/file', dest, { allowInsecure: true, allowlist: () => true, resume: true });
    assert.ok(r.ok);
    assert.strictEqual(r.resumed.from, body.length);
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), body.toString('utf8'));
    assert.ok(!fs.existsSync(dest + '.part'));
  } finally { server.close(); }
});

(async function run() {
  let failed = 0;
  for (let i = 0; i < tests.length; i++) {
    try {
      await tests[i]();
      console.log(`ok  downloads test ${i + 1}`);
    } catch (e) {
      failed++;
      console.error(`FAIL  downloads test ${i + 1}: ${e.message}\n${e.stack}`);
    }
  }
  close();
  teardown();
  if (failed) { console.error(`FAIL  ${failed} downloads test(s) failed`); process.exit(1); }
  console.log('PASS  foundation-downloads');
})();
