'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-boundary-'));
const configPath = path.join(root, 'config.json');
const dataDir = path.join(root, 'data');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
config.password = 'Str0ngBoundary!';
config.users = [];
config.servers = [];
config.activeServerId = null;
config.requireAuth = true;
config.jwtSecret = 'boundary-test-secret-that-is-long-enough';
config.backups.dir = path.join(root, 'backups');
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
process.env.FLEETDECK_CONFIG = configPath;
process.env.FLEETDECK_DATA_DIR = dataDir;

const serverExports = require('../server.js');
const { close: closeDatabase } = require('../lib/db.cjs');
if (!serverExports.app) {
  console.error('server.js should expose the configured app for integration tests');
  process.exit(1);
}

function request(base, method, route, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const url = new URL(route, base);
    const headers = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request(url, {
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* plain response */ }
        resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async function main() {
  const listener = await new Promise((resolve) => {
    const value = serverExports.app.listen(0, '127.0.0.1', () => resolve(value));
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  try {
    let response = await request(base, 'POST', '/api/login', { username: 'admin', password: 'Str0ngBoundary!' });
    assert.strictEqual(response.status, 200);
    const token = response.body.token;

    response = await request(base, 'POST', '/api/product/byoc/targets', {
      name: 'Boundary target', provider: 'hetzner', endpoint: 'https://vps.example.test',
      region: 'fsn1', resourceTier: 'cx33', secretRef: 'BOUNDARY_TARGET',
    }, token);
    assert.strictEqual(response.status, 201);
    const targetId = response.body.target.id;

    response = await request(base, 'POST', '/api/product/pairing/challenges', { targetId }, token);
    assert.strictEqual(response.status, 201);
    const challenge = response.body.challenge;

    response = await request(base, 'GET', '/api/product/summary');
    assert.strictEqual(response.status, 401, 'product summary must remain protected');

    response = await request(base, 'POST', '/api/product/pairing/consume', { id: challenge.id, token: challenge.token });
    assert.strictEqual(response.status, 200, 'a remote agent must consume a valid challenge without a panel session');
    assert.ok(response.body.pairing.agentToken);

    response = await request(base, 'POST', '/api/product/pairing/consume/', { id: 'missing', token: 'missing' });
    assert.strictEqual(response.status, 401, 'a near-match path must not inherit the public bypass');

    for (let attempt = 0; attempt < 9; attempt += 1) {
      response = await request(base, 'POST', '/api/product/pairing/consume', { id: `missing-${attempt}`, token: 'missing' });
      assert.strictEqual(response.status, 401);
    }
    response = await request(base, 'POST', '/api/product/pairing/consume', { id: 'rate-limited', token: 'missing' });
    assert.strictEqual(response.status, 429, 'the token-only endpoint must be rate limited');

    console.log('PASS product-boundary');
  } finally {
    await new Promise((resolve) => listener.close(resolve));
    try { closeDatabase(); } catch { /* already closed */ }
    fs.rmSync(root, { recursive: true, force: true });
    delete process.env.FLEETDECK_CONFIG;
    delete process.env.FLEETDECK_DATA_DIR;
  }
})().then(() => process.exit(0)).catch((error) => { console.error(error.stack || error); process.exit(1); });
