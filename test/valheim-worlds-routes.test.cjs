'use strict';

/*
 * The HTTP contract of /api/valheim/worlds (docs/valheim/03-worlds.md "API and
 * frontend"): capability enforcement, a preview token on every destructive
 * request, 202 + operationId for long mutations, an Idempotency-Key that
 * replays onto the operation it already started, a download that also needs
 * files.view, and no absolute path anywhere in a response.
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
const valheimWorldsRouter = require('../lib/routes/valheim.cjs');
const valheimWorlds = require('../lib/valheim-worlds.cjs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'valheim-wroutes-'));

function seedServer(id, worldNames) {
  const dir = path.join(ROOT, id);
  const save = path.join(dir, 'data', 'worlds_local');
  fs.mkdirSync(save, { recursive: true });
  for (const name of worldNames) {
    fs.writeFileSync(path.join(save, `${name}${valheimWorlds.META_EXT}`), Buffer.alloc(64, 1));
    fs.writeFileSync(path.join(save, `${name}${valheimWorlds.DATA_EXT}`), Buffer.alloc(256, 2));
  }
  return {
    id,
    name: `Server ${id}`,
    type: 'valheim',
    dir,
    cwd: dir,
    valheimSaveDir: 'data',
    worldName: worldNames[0],
  };
}

async function main() {
  migrations.runMigrations();

  const admin = { id: 'admin-v', role: 'admin', username: 'admin' };
  const viewer = { id: 'viewer-v', role: 'operator', username: 'viewer' };
  const nobody = { id: 'nobody-v', role: 'operator', username: 'nobody' };

  const server = seedServer('srv-valheim', ['Dedicated', 'Second']);
  const minecraft = { id: 'srv-minecraft', name: 'MC', type: 'minecraft', dir: path.join(ROOT, 'mc') };
  const managers = { [server.id]: { status: 'offline' }, [minecraft.id]: { status: 'offline' } };

  // A viewer may look at this server's worlds and nothing else - seeing the
  // list is not on its own a grant to take a world home.
  capabilities.grant(viewer.id, server.id, capabilities.CAPABILITIES.WORLDS_VIEW, admin.id);

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { admin, viewer, nobody }[req.headers['x-test-user'] || 'nobody'];
    next();
  });
  app.use('/api/valheim/worlds', valheimWorldsRouter({
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
    let res = await call('GET', `/api/valheim/worlds?serverId=${server.id}`, { user: 'viewer' });
    assert.strictEqual(res.status, 200);
    let json = await res.json();
    assert.deepStrictEqual(json.worlds.map((w) => w.name).sort(), ['Dedicated', 'Second']);
    assert.strictEqual(json.worlds.find((w) => w.name === 'Dedicated').active, true);
    assert.strictEqual(json.saveDir, 'data/worlds_local');
    assert.ok(!JSON.stringify(json).includes(server.dir), 'the response leaked an absolute path');

    // No grant at all: the world list is not readable.
    res = await call('GET', `/api/valheim/worlds?serverId=${server.id}`, { user: 'nobody' });
    assert.strictEqual(res.status, 403);

    // A Minecraft server has no Valheim worlds surface, whatever the caller holds.
    res = await call('GET', `/api/valheim/worlds?serverId=${minecraft.id}`);
    assert.strictEqual(res.status, 404);

    // --- destructive requests need a preview ---
    res = await call('POST', '/api/valheim/worlds/select', { body: { serverId: server.id }, key: 'k-no-token' });
    assert.strictEqual(res.status, 409);
    assert.strictEqual((await res.json()).code, 'preview_invalid');

    res = await call('DELETE', '/api/valheim/worlds/Second', { body: { serverId: server.id }, key: 'k-no-token-2' });
    assert.strictEqual(res.status, 409);

    // A viewer may not mutate.
    res = await call('POST', '/api/valheim/worlds/select/preview', { user: 'viewer', body: { serverId: server.id, name: 'Second' } });
    assert.strictEqual(res.status, 403);

    // --- select: preview, then 202, then the operation runs to success ---
    res = await call('POST', '/api/valheim/worlds/select/preview', { body: { serverId: server.id, name: 'Second' } });
    assert.strictEqual(res.status, 200);
    const preview = (await res.json()).preview;
    assert.strictEqual(preview.world.name, 'Second');
    assert.strictEqual(preview.requiresOffline, true);
    assert.ok(preview.token);

    // No Idempotency-Key is a refusal, not a silent one-off - and the refusal
    // happens before the token is spent, so the same preview still works once
    // the caller sends the header.
    res = await call('POST', '/api/valheim/worlds/select', { body: { serverId: server.id, token: preview.token } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).code, 'idempotency_key_required');

    res = await call('POST', '/api/valheim/worlds/select', { body: { serverId: server.id, token: preview.token }, key: 'select-1' });
    assert.strictEqual(res.status, 202);
    const { operationId } = await res.json();
    assert.ok(operationId);

    // The same key replays onto the same operation instead of selecting twice.
    res = await call('POST', '/api/valheim/worlds/select', { body: { serverId: server.id, token: preview.token }, key: 'select-1' });
    assert.strictEqual(res.status, 202);
    const replay = await res.json();
    assert.strictEqual(replay.operationId, operationId);
    assert.strictEqual(replay.replay, true);

    assert.strictEqual((await settle(operationId)).state, 'succeeded');
    assert.strictEqual(server.worldName, 'Second');

    // --- download needs files.view on top of worlds.view ---
    res = await fetch(`${base}/api/valheim/worlds/Dedicated/download?serverId=${server.id}`, { headers: { 'x-test-user': 'viewer' } });
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).capability, capabilities.CAPABILITIES.FILES_VIEW);

    res = await fetch(`${base}/api/valheim/worlds/Dedicated/download?serverId=${server.id}`, { headers: { 'x-test-user': 'admin' } });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="Server-srv-valheim-Dedicated-[\d-]+T[\d-]+\.zip"/);
    const zip = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(zip.subarray(0, 2).toString('ascii'), 'PK', 'the download is not a zip');

    // A world that is not there is a 404, and a name that tries to leave the
    // worlds directory is refused before anything is read.
    res = await fetch(`${base}/api/valheim/worlds/Nope/download?serverId=${server.id}`, { headers: { 'x-test-user': 'admin' } });
    assert.strictEqual(res.status, 404);
    res = await fetch(`${base}/api/valheim/worlds/${encodeURIComponent('../data')}/download?serverId=${server.id}`, {
      headers: { 'x-test-user': 'admin' },
    });
    assert.ok(res.status === 400 || res.status === 404, `traversal answered ${res.status}`);

    // --- import: a multipart upload is previewed before it is committed ---
    const form = new FormData();
    form.append('files', new Blob([Buffer.alloc(64, 5)]), `Adventure${valheimWorlds.META_EXT}`);
    form.append('files', new Blob([Buffer.alloc(256, 6)]), `Adventure${valheimWorlds.DATA_EXT}`);
    // The staged filenames are fixed (`world.fwl`/`world.db`, matching the
    // Terraria route's convention of never trusting the client's filename for
    // anything but suggesting a name), so the requested name is explicit.
    form.append('name', 'Adventure');
    res = await fetch(`${base}/api/valheim/worlds/import/preview?serverId=${server.id}`, {
      method: 'POST', headers: { 'x-test-user': 'admin' }, body: form,
    });
    assert.strictEqual(res.status, 200);
    const importPreview = (await res.json()).preview;
    assert.strictEqual(importPreview.name, 'Adventure');
    assert.ok(!JSON.stringify(importPreview).includes(server.dir), 'the import preview leaked an absolute path');

    res = await call('POST', '/api/valheim/worlds/import', { body: { serverId: server.id, token: importPreview.token }, key: 'import-1' });
    assert.strictEqual(res.status, 202);
    const importOp = (await res.json()).operationId;
    assert.strictEqual((await settle(importOp)).state, 'succeeded');
    assert.ok(fs.existsSync(path.join(server.dir, 'data', 'worlds_local', `Adventure${valheimWorlds.META_EXT}`)));

    // Only one of the pair is refused by the preview.
    const half = new FormData();
    half.append('files', new Blob([Buffer.alloc(32, 9)]), `Broken${valheimWorlds.META_EXT}`);
    res = await fetch(`${base}/api/valheim/worlds/import/preview?serverId=${server.id}`, {
      method: 'POST', headers: { 'x-test-user': 'admin' }, body: half,
    });
    assert.strictEqual(res.status, 422);
    assert.strictEqual((await res.json()).code, 'pair_incomplete');

    // An unsupported upload type never reaches the disk.
    const wrong = new FormData();
    wrong.append('files', new Blob([Buffer.alloc(8)]), 'notes.txt');
    res = await fetch(`${base}/api/valheim/worlds/import/preview?serverId=${server.id}`, {
      method: 'POST', headers: { 'x-test-user': 'admin' }, body: wrong,
    });
    assert.strictEqual(res.status, 400);

    // --- rename ---
    res = await call('POST', '/api/valheim/worlds/rename/preview', { body: { serverId: server.id, from: 'Adventure', to: 'Renamed' } });
    assert.strictEqual(res.status, 200);
    const renamePreview = (await res.json()).preview;
    assert.strictEqual(renamePreview.from, 'Adventure');
    assert.strictEqual(renamePreview.to, 'Renamed');

    res = await call('POST', '/api/valheim/worlds/rename', { body: { serverId: server.id, token: renamePreview.token }, key: 'rename-1' });
    assert.strictEqual(res.status, 202);
    const renameOp = (await res.json()).operationId;
    assert.strictEqual((await settle(renameOp)).state, 'succeeded');
    assert.ok(fs.existsSync(path.join(server.dir, 'data', 'worlds_local', `Renamed${valheimWorlds.META_EXT}`)));
    assert.strictEqual(fs.existsSync(path.join(server.dir, 'data', 'worlds_local', `Adventure${valheimWorlds.META_EXT}`)), false);

    // --- delete: quarantined, and the world list shrinks ---
    res = await call('POST', '/api/valheim/worlds/Renamed/delete/preview', { body: { serverId: server.id } });
    assert.strictEqual(res.status, 200);
    const deletePreview = (await res.json()).preview;
    assert.strictEqual(deletePreview.world.name, 'Renamed');

    res = await call('DELETE', '/api/valheim/worlds/Renamed', {
      body: { serverId: server.id, token: deletePreview.token }, key: 'delete-1',
    });
    assert.strictEqual(res.status, 202);
    const deleteOp = (await res.json()).operationId;
    assert.strictEqual((await settle(deleteOp)).state, 'succeeded');
    assert.strictEqual(fs.existsSync(path.join(server.dir, 'data', 'worlds_local', `Renamed${valheimWorlds.META_EXT}`)), false);

    // --- a running server refuses every mutation, at the HTTP layer ---
    managers[server.id] = { status: 'online' };
    res = await call('POST', '/api/valheim/worlds/select/preview', { body: { serverId: server.id, name: 'Dedicated' } });
    const onlinePreview = (await res.json()).preview;
    assert.strictEqual(onlinePreview.serverOffline, false);
    for (const [method, url] of [
      ['POST', '/api/valheim/worlds/select'],
      ['POST', '/api/valheim/worlds/import'],
      ['POST', '/api/valheim/worlds/rename'],
      ['DELETE', '/api/valheim/worlds/Dedicated'],
    ]) {
      res = await call(method, url, { body: { serverId: server.id, token: onlinePreview.token }, key: `online-${method}-${url}` });
      assert.strictEqual(res.status, 409, `${method} ${url} was accepted while the server was running`);
    }

    console.log('PASS  valheim-worlds-routes');
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
