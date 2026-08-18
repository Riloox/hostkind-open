'use strict';

/*
 * The HTTP contract of /api/terraria/worlds (docs/terraria/03-worlds.md "API"):
 * capability enforcement, a preview token on every destructive request, 202 +
 * operationId for long mutations, an Idempotency-Key that replays onto the
 * operation it already started, a download that also needs files.view, and no
 * absolute path anywhere in a response.
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
const terrariaWorldsRouter = require('../lib/routes/terraria.cjs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'terraria-wroutes-'));

function worldBuffer({ version = 279, fileType = 2, revision = 1 } = {}) {
  const buffer = Buffer.alloc(1024);
  buffer.writeInt32LE(version, 0);
  Buffer.from('relogic', 'ascii').copy(buffer, 4);
  buffer.writeUInt8(fileType, 11);
  buffer.writeUInt32LE(revision, 12);
  return buffer;
}

function seedServer(id, worldNames) {
  const dir = path.join(ROOT, id);
  const save = path.join(dir, 'worlds');
  fs.mkdirSync(save, { recursive: true });
  for (const name of worldNames) fs.writeFileSync(path.join(save, `${name}.wld`), worldBuffer());
  fs.writeFileSync(path.join(dir, 'TerrariaServer.bin.x86_64'), '#!/bin/false\n');
  fs.writeFileSync(path.join(dir, 'serverconfig.txt'), [
    `world=${path.join(save, `${worldNames[0]}.wld`)}`,
    `worldpath=${save}`,
    'maxplayers=8',
    'port=7777',
    '',
  ].join('\n'));
  return {
    id,
    name: `Server ${id}`,
    type: 'terraria',
    dir,
    cwd: dir,
    executable: path.join(dir, 'TerrariaServer.bin.x86_64'),
    args: ['-config', path.join(dir, 'serverconfig.txt')],
    terrariaVariant: 'vanilla',
    terrariaSaveDir: 'worlds',
    terrariaWorld: { file: `worlds/${worldNames[0]}.wld`, name: worldNames[0] },
  };
}

async function main() {
  migrations.runMigrations();

  const admin = { id: 'admin-t', role: 'admin', username: 'admin' };
  const viewer = { id: 'viewer-t', role: 'operator', username: 'viewer' };
  const nobody = { id: 'nobody-t', role: 'operator', username: 'nobody' };

  const server = seedServer('srv-terraria', ['World', 'Second']);
  const minecraft = { id: 'srv-minecraft', name: 'MC', type: 'minecraft', dir: path.join(ROOT, 'mc') };
  const managers = { [server.id]: { status: 'offline' }, [minecraft.id]: { status: 'offline' } };

  // A viewer may look at this server's worlds and nothing else - in particular,
  // seeing the list is not on its own a grant to take a world home.
  capabilities.grant(viewer.id, server.id, capabilities.CAPABILITIES.WORLDS_VIEW, admin.id);

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { admin, viewer, nobody }[req.headers['x-test-user'] || 'nobody'];
    next();
  });
  app.use('/api/terraria/worlds', terrariaWorldsRouter({
    activeServerId: () => server.id,
    findServer: (id) => (id === server.id ? server : id === minecraft.id ? minecraft : null),
    getManager: (id) => managers[id],
    allServers: () => [server],
    saveDescriptor: (id, fields) => {
      for (const [key, value] of Object.entries(fields)) {
        if (value === null) delete server[key];
        else server[key] = value;
      }
    },
    broadcast: () => {},
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

  const settle = async (operationId) => {
    for (let i = 0; i < 100 && ['queued', 'running'].includes(operations.get(operationId).state); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return operations.get(operationId);
  };

  try {
    // --- reads ---
    let res = await call('GET', `/api/terraria/worlds?serverId=${server.id}`, { user: 'viewer' });
    assert.strictEqual(res.status, 200);
    let json = await res.json();
    assert.deepStrictEqual(json.worlds.map((w) => w.file), ['Second.wld', 'World.wld']);
    assert.strictEqual(json.worlds.find((w) => w.file === 'World.wld').active, true);
    assert.strictEqual(json.saveDir, 'worlds');
    assert.ok(!JSON.stringify(json).includes(server.dir), 'the response leaked an absolute path');

    // No grant at all: the world list is not readable.
    res = await call('GET', `/api/terraria/worlds?serverId=${server.id}`, { user: 'nobody' });
    assert.strictEqual(res.status, 403);

    // A Minecraft server has no Terraria worlds surface, whatever the caller holds.
    res = await call('GET', `/api/terraria/worlds?serverId=${minecraft.id}`);
    assert.strictEqual(res.status, 404);

    // --- destructive requests need a preview ---
    res = await call('POST', '/api/terraria/worlds/select', { body: { serverId: server.id }, key: 'k-no-token' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual((await res.json()).code, 'preview_invalid');

    res = await call('DELETE', '/api/terraria/worlds/Second.wld', { body: { serverId: server.id }, key: 'k-no-token-2' });
    assert.strictEqual(res.status, 409);

    // A viewer may not mutate.
    res = await call('POST', '/api/terraria/worlds/select/preview', { user: 'viewer', body: { serverId: server.id, file: 'Second.wld' } });
    assert.strictEqual(res.status, 403);

    // --- select: preview, then 202, then the operation runs to success ---
    res = await call('POST', '/api/terraria/worlds/select/preview', { body: { serverId: server.id, file: 'Second.wld' } });
    assert.strictEqual(res.status, 200);
    const preview = (await res.json()).preview;
    assert.strictEqual(preview.world.file, 'Second.wld');
    assert.strictEqual(preview.requiresOffline, true);
    assert.ok(preview.token);

    // No Idempotency-Key is a refusal, not a silent one-off - and the refusal
    // happens before the token is spent, so the same preview still works once the
    // caller sends the header.
    res = await call('POST', '/api/terraria/worlds/select', { body: { serverId: server.id, token: preview.token } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).code, 'idempotency_key_required');

    res = await call('POST', '/api/terraria/worlds/select', { body: { serverId: server.id, token: preview.token }, key: 'select-1' });
    assert.strictEqual(res.status, 202);
    const { operationId } = await res.json();
    assert.ok(operationId);

    // The same key replays onto the same operation instead of selecting twice.
    res = await call('POST', '/api/terraria/worlds/select', { body: { serverId: server.id, token: preview.token }, key: 'select-1' });
    assert.strictEqual(res.status, 202);
    const replay = await res.json();
    assert.strictEqual(replay.operationId, operationId);
    assert.strictEqual(replay.replay, true);

    assert.strictEqual((await settle(operationId)).state, 'succeeded');
    assert.strictEqual(server.terrariaWorld.file, 'worlds/Second.wld');
    assert.match(fs.readFileSync(path.join(server.dir, 'serverconfig.txt'), 'utf8'), /world=.*Second\.wld/);

    // --- download needs files.view on top of worlds.view ---
    res = await fetch(`${base}/api/terraria/worlds/World.wld/download?serverId=${server.id}`, { headers: { 'x-test-user': 'viewer' } });
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).capability, capabilities.CAPABILITIES.FILES_VIEW);

    res = await fetch(`${base}/api/terraria/worlds/World.wld/download?serverId=${server.id}`, { headers: { 'x-test-user': 'admin' } });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="Server-srv-terraria-World-[\d-]+T[\d-]+\.zip"/);
    const zip = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(zip.subarray(0, 2).toString('ascii'), 'PK', 'the download is not a zip');

    // A world that is not there is a 404, and a path that tries to leave the
    // world folder is refused before anything is read.
    res = await fetch(`${base}/api/terraria/worlds/Nope.wld/download?serverId=${server.id}`, { headers: { 'x-test-user': 'admin' } });
    assert.strictEqual(res.status, 404);
    res = await fetch(`${base}/api/terraria/worlds/${encodeURIComponent('../serverconfig.txt')}/download?serverId=${server.id}`, {
      headers: { 'x-test-user': 'admin' },
    });
    assert.ok(res.status === 400 || res.status === 404, `traversal answered ${res.status}`);

    // --- import: a multipart upload is previewed before it is committed ---
    const form = new FormData();
    form.append('files', new Blob([worldBuffer({ revision: 7 })]), 'Adventure.wld');
    form.append('name', 'Adventure');
    res = await fetch(`${base}/api/terraria/worlds/import/preview?serverId=${server.id}`, {
      method: 'POST', headers: { 'x-test-user': 'admin' }, body: form,
    });
    assert.strictEqual(res.status, 200);
    const importPreview = (await res.json()).preview;
    assert.strictEqual(importPreview.file, 'Adventure.wld');
    assert.ok(!JSON.stringify(importPreview).includes(server.dir), 'the import preview leaked an absolute path');

    res = await call('POST', '/api/terraria/worlds/import', { body: { serverId: server.id, token: importPreview.token }, key: 'import-1' });
    assert.strictEqual(res.status, 202);
    const importOp = (await res.json()).operationId;
    assert.strictEqual((await settle(importOp)).state, 'succeeded');
    assert.ok(fs.existsSync(path.join(server.dir, 'worlds', 'Adventure.wld')));

    // A file that is not a world is refused by the preview, with a reason.
    const bad = new FormData();
    bad.append('files', new Blob([Buffer.alloc(32, 9)]), 'broken.wld');
    res = await fetch(`${base}/api/terraria/worlds/import/preview?serverId=${server.id}`, {
      method: 'POST', headers: { 'x-test-user': 'admin' }, body: bad,
    });
    assert.strictEqual(res.status, 422);
    assert.match((await res.json()).code, /^import_/);

    // An unsupported upload type never reaches the disk.
    const wrong = new FormData();
    wrong.append('files', new Blob([Buffer.alloc(8)]), 'notes.txt');
    res = await fetch(`${base}/api/terraria/worlds/import/preview?serverId=${server.id}`, {
      method: 'POST', headers: { 'x-test-user': 'admin' }, body: wrong,
    });
    assert.strictEqual(res.status, 400);

    // --- delete: quarantined, and the world list shrinks ---
    res = await call('POST', '/api/terraria/worlds/Adventure.wld/delete/preview', { body: { serverId: server.id } });
    assert.strictEqual(res.status, 200);
    const deletePreview = (await res.json()).preview;
    assert.strictEqual(deletePreview.world.file, 'Adventure.wld');

    res = await call('DELETE', '/api/terraria/worlds/Adventure.wld', {
      body: { serverId: server.id, token: deletePreview.token }, key: 'delete-1',
    });
    assert.strictEqual(res.status, 202);
    const deleteOp = (await res.json()).operationId;
    assert.strictEqual((await settle(deleteOp)).state, 'succeeded');
    assert.strictEqual(fs.existsSync(path.join(server.dir, 'worlds', 'Adventure.wld')), false);

    // --- a running server refuses every mutation, at the HTTP layer ---
    managers[server.id] = { status: 'online' };
    res = await call('POST', '/api/terraria/worlds/select/preview', { body: { serverId: server.id, file: 'World.wld' } });
    const onlinePreview = (await res.json()).preview;
    assert.strictEqual(onlinePreview.serverOffline, false);
    for (const [method, url] of [
      ['POST', '/api/terraria/worlds/select'],
      ['POST', '/api/terraria/worlds/import'],
      ['POST', '/api/terraria/worlds/generate'],
      ['DELETE', '/api/terraria/worlds/World.wld'],
    ]) {
      res = await call(method, url, { body: { serverId: server.id, token: onlinePreview.token }, key: `online-${method}-${url}` });
      assert.strictEqual(res.status, 409, `${method} ${url} was accepted while the server was running`);
    }

    console.log('PASS  terraria-worlds-routes');
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
