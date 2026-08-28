'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { setupDataDir, teardown, TMP_ROOT } = require('./_setup.cjs');

setupDataDir();
const configPath = path.join(TMP_ROOT, 'config.json');
fs.copyFileSync(path.join(__dirname, '..', 'config.example.json'), configPath);
process.env.FLEETDECK_CONFIG = configPath;

const { app } = require('../server.js');
const { close: closeDb } = require('../lib/db.cjs');

function parseCsp(value) {
  return Object.fromEntries(String(value || '').split(';').map((directive) => {
    const [name, ...sources] = directive.trim().split(/\s+/);
    return [name, sources];
  }).filter(([name]) => name));
}

async function main() {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/modules`);
    assert.strictEqual(response.status, 401);

    const csp = parseCsp(response.headers.get('content-security-policy'));
    for (const source of ['https://images.steamusercontent.com', 'https://shared.fastly.steamstatic.com']) {
      assert.ok(
        csp['img-src']?.includes(source),
        `img-src must allow Terraria Workshop images from ${source}; got: ${csp['img-src']?.join(' ') || '<missing>'}`
      );
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    teardown();
  }

  console.log('PASS  terraria-workshop-icons');
}

main().catch((error) => {
  console.error(error);
  try { closeDb(); } catch { /* cleanup best effort */ }
  teardown();
  process.exitCode = 1;
}).finally(() => {
  // server.js installs background timers when its app is loaded; this test is
  // deliberately process-scoped so those timers cannot keep the test runner up.
  setImmediate(() => process.exit(process.exitCode || 0));
});
