'use strict';

/*
 * The HTTP contract of /api/worlds: capability enforcement, 202 + operationId
 * for long mutations, Idempotency-Key on destructive requests, preview tokens,
 * and a download name a browser cannot be talked into misreading.
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const { setupDataDir, teardown } = require('./_setup.cjs');
setupDataDir();

const { close } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');
const capabilities = require('../lib/capabilities.cjs');
const operations = require('../lib/operations.cjs');
const worldsRouter = require('../lib/routes/worlds.cjs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-wroutes-'));

function seedServer(id, worldNames) {
  const dir = path.join(ROOT, id);
  for (const name of worldNames) {
    fs.mkdirSync(path.join(dir, name, 'region'), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'level.dat'), `lvl:${name}`);
    fs.writeFileSync(path.join(dir, name, 'region', 'r.0.mca'), Buffer.alloc(2048));
  }
  return { id, name: `Server ${id}`, dir, worlds: [...worldNames] };
}

async function main() {
  migrations.runMigrations();

  const admin = { id: 'admin-w', role: 'admin', username: 'admin' };
  const viewer = { id: 'viewer-w', role: 'operator', username: 'viewer' };
  const nobody = { id: 'nobody-w', role: 'operator', username: 'nobody' };

  const server = seedServer('srv-routes', ['world', 'spare']);
  const other = seedServer('srv-other', ['world']);
  const managers = { [server.id]: { status: 'offline' }, [other.id]: { status: 'offline' } };

  // A viewer may look at the worlds of this server, and nothing else.
  capabilities.grant(viewer.id, server.id, capabilities.CAPABILITIES.WORLDS_VIEW, admin.id);

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { admin, viewer, nobody }[req.headers['x-test-user'] || 'nobody'];
    next();
  });
  app.use('/api/worlds', worldsRouter({
    activeServerId: () => server.id,
    findServer: (id) => (id === server.id ? server : id === other.id ? other : null),
    getManager: (id) => managers[id],
    detectCompat: () => ({ projectType: 'plugin', loaders: ['paper'], folder: 'plugins', label: 'Paper', mcVersion: '1.21' }),
    backupsDir: () => path.join(ROOT, 'backups'),
    saveWorlds: (id, next) => { (id === server.id ? server : other).worlds = next; },
    inspectBackup: async () => ({ sha256: 'x' }),
    verifyBackup: async () => ({ status: 'verified' }),
    recordProvenance: () => {},
  }));

  const httpServer = http.createServer(app);
  await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const call = (method, url, { user = 'admin', body, key } = {}) => {
    const headers = {
      'x-test-user': user,
      'content-type': 'application/json',
    };
    if (key) headers['Idempotency-Key'] = key;
    return fetch(`${base}${url}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  try {
    // --- reads ---
    let res = await call('GET', `/api/worlds?serverId=${server.id}`, { user: 'viewer' });
    assert.strictEqual(res.status, 200);
    let json = await res.json();
    assert.deepStrictEqual(json.worlds.map((w) => w.name), ['world', 'spare']);
    assert.ok(!JSON.stringify(json).includes(server.dir), 'the response leaked an absolute path');

    // No grant on this server: the world list is not readable.
    res = await call('GET', `/api/worlds?serverId=${other.id}`, { user: 'viewer' });
    assert.strictEqual(res.status, 403);
    res = await call('GET', `/api/worlds?serverId=${server.id}`, { user: 'nobody' });
    assert.strictEqual(res.status, 403);

    // worlds.view alone is not worlds.manage.
    res = await call('POST', `/api/worlds/spare/delete/preview`, { user: 'viewer', body: { serverId: server.id } });
    assert.strictEqual(res.status, 403);

    // --- download needs files.view on top of worlds.view ---
    res = await call('GET', `/api/worlds/world/download?serverId=${server.id}`, { user: 'viewer' });
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).capability, 'files.view');

    res = await call('GET', `/api/worlds/world/download?serverId=${server.id}`, { user: 'admin' });
    assert.strictEqual(res.status, 200);
    const disposition = res.headers.get('content-disposition');
    assert.ok(/^attachment; filename="[A-Za-z0-9._-]+\.zip"/.test(disposition), `unsafe disposition: ${disposition}`);
    assert.ok((await res.arrayBuffer()).byteLength > 0);

    // --- destructive requests need a preview and an idempotency key ---
    res = await call('DELETE', '/api/worlds/spare', { body: { serverId: server.id } });
    assert.strictEqual(res.status, 409); // no preview token
    assert.strictEqual((await res.json()).code, 'preview_invalid');

    res = await call('POST', '/api/worlds/spare/delete/preview', { body: { serverId: server.id } });
    assert.strictEqual(res.status, 200);
    const preview = (await res.json()).preview;
    assert.strictEqual(preview.requiresOffline, true);
    assert.ok(preview.token);

    res = await call('DELETE', '/api/worlds/spare', { body: { serverId: server.id, token: preview.token } });
    assert.strictEqual(res.status, 400); // preview, but no Idempotency-Key
    assert.strictEqual((await res.json()).code, 'idempotency_key_required');

    // --- a long mutation answers 202 and runs as a durable operation ---
    res = await call('POST', '/api/worlds/world/clone', { body: { serverId: server.id, preview: true, name: 'copy' } });
    const clonePreview = (await res.json()).preview;
    assert.strictEqual(clonePreview.name, 'copy');

    res = await call('POST', '/api/worlds/world/clone', { body: { serverId: server.id, token: clonePreview.token }, key: 'clone-key-1' });
    assert.strictEqual(res.status, 202);
    const { operationId } = await res.json();
    assert.ok(operationId);

    // The same key replays onto the same operation instead of cloning twice.
    res = await call('POST', '/api/worlds/world/clone', { body: { serverId: server.id, token: clonePreview.token }, key: 'clone-key-1' });
    assert.strictEqual(res.status, 202);
    const replay = await res.json();
    assert.strictEqual(replay.operationId, operationId);
    assert.strictEqual(replay.replay, true);

    // Let it finish, then check the world was created and registered exactly once.
    for (let i = 0; i < 100 && ['queued', 'running'].includes(operations.get(operationId).state); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.strictEqual(operations.get(operationId).state, 'succeeded');
    assert.ok(fs.existsSync(path.join(server.dir, 'copy', 'level.dat')));
    assert.deepStrictEqual(server.worlds, ['world', 'spare', 'copy']);

    console.log('PASS  worlds-routes');
  } finally {
    await new Promise((resolve) => httpServer.close(resolve));
    close();
    try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
    teardown();
  }
}

main().catch((err) => {
  console.error(err);
  close();
  teardown();
  process.exit(1);
});
