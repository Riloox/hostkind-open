'use strict';

/*
 * The HTTP contract of /api/templates and the clone routes: capability
 * filtering, Idempotency-Key on destructive requests, 202 + operationId for
 * long mutations, and the recovery path when a promoted server folder cannot
 * be registered.
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
const templates = require('../lib/templates.cjs');
const templatesRouter = require('../lib/routes/templates.cjs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-troutes-'));

function seedServer(id) {
  const dir = path.join(ROOT, id);
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.properties'), 'server-port=25565\nmotd=Source\n');
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'lvl');
  return { id, name: `Server ${id}`, dir, loader: 'paper', mcVersion: '1.21.4', worlds: ['world'] };
}

async function settled(operationId, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const op = operations.get(operationId);
    if (op && ['succeeded', 'failed', 'cancelled', 'recovery_required'].includes(op.state)) return op;
    if (Date.now() > deadline) throw new Error(`operation ${operationId} never settled`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function main() {
  migrations.runMigrations();

  const admin = { id: 'admin-t', role: 'admin', username: 'admin' };
  const manager = { id: 'manager-t', role: 'operator', username: 'manager' };
  const nobody = { id: 'nobody-t', role: 'operator', username: 'nobody' };

  const server = seedServer('srv-t');
  const registry = [];
  let registrationFails = false;

  // The manager may see and manage this server, but has no content.view, so it
  // may not curate templates from it.
  capabilities.grant(manager.id, server.id, capabilities.CAPABILITIES.SERVER_VIEW, admin.id);
  capabilities.grant(manager.id, server.id, capabilities.CAPABILITIES.SERVER_MANAGE, admin.id);

  const deps = {
    findServer: (id) => (id === server.id ? server : null),
    prepareRuntime: async (dir) => {
      fs.writeFileSync(path.join(dir, 'paper.jar'), 'JAR');
      return { jar: 'paper.jar', launchArgs: null, loader: 'paper', mcVersion: '1.21.4' };
    },
    registerCreated: ({ name, dir }) => {
      if (registrationFails) throw Object.assign(new Error('config write failed'), { code: 'registry_failed' });
      const entry = { id: `reg-${registry.length}`, name, dir };
      registry.push(entry);
      return entry;
    },
    registerExisting: ({ name, dir }) => {
      const entry = { id: `reg-${registry.length}`, name, dir };
      registry.push(entry);
      return entry;
    },
    recordProvenance: () => {},
    isRegisteredDir: (dir) => registry.some((item) => path.resolve(item.dir) === path.resolve(dir)),
  };

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { admin, manager, nobody }[req.headers['x-test-user'] || 'nobody'];
    next();
  });
  app.use('/api/templates', templatesRouter.router(deps));
  app.use('/api/servers', templatesRouter.cloneRouter(deps));

  const httpServer = http.createServer(app);
  await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const call = (method, url, { user = 'admin', body, key } = {}) => {
    const headers = { 'x-test-user': user, 'content-type': 'application/json' };
    if (key) headers['Idempotency-Key'] = key;
    return fetch(`${base}${url}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  const parent = fs.mkdtempSync(path.join(ROOT, 'dest-'));

  try {
    // --- curation needs content.view + server.manage -------------------------
    let res = await call('POST', '/api/templates/preview', { user: 'manager', body: { serverId: server.id } });
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).capability, 'content.view');
    res = await call('POST', '/api/templates/preview', { user: 'nobody', body: { serverId: server.id } });
    assert.strictEqual(res.status, 403);

    res = await call('POST', '/api/templates', { body: { serverId: server.id, name: 'Base' } });
    assert.strictEqual(res.status, 201);
    const templateId = (await res.json()).template.id;
    console.log('ok  template creation requires content.view plus server.manage');

    // --- listing is filtered by server.view on the source --------------------
    res = await call('GET', '/api/templates', { user: 'manager' });
    assert.strictEqual((await res.json()).templates.length, 1);
    res = await call('GET', '/api/templates', { user: 'nobody' });
    assert.strictEqual((await res.json()).templates.length, 0, 'a template leaked a server the user cannot see');
    res = await call('GET', `/api/templates/${templateId}/preview`, { user: 'nobody' });
    assert.strictEqual(res.status, 403);
    console.log('ok  listing and inspection are filtered by server.view on the source');

    // --- destructive requests require an Idempotency-Key ---------------------
    res = await call('POST', `/api/templates/${templateId}/instantiate`, { body: { name: 'From template', parentDir: parent } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await res.json()).code, 'idempotency_key_required');

    res = await call('POST', `/api/templates/${templateId}/instantiate`, { user: 'nobody', body: { name: 'x', parentDir: parent }, key: 'k-403' });
    assert.strictEqual(res.status, 403);
    console.log('ok  instantiation requires an Idempotency-Key and server.manage');

    // --- 202 + operation, promoted and registered ----------------------------
    res = await call('POST', `/api/templates/${templateId}/instantiate`, { body: { name: 'From template', parentDir: parent }, key: 'k-1' });
    assert.strictEqual(res.status, 202);
    const first = (await res.json()).operationId;
    let op = await settled(first);
    assert.strictEqual(op.state, 'succeeded');
    const created = path.join(parent, 'from-template');
    assert.strictEqual(fs.existsSync(path.join(created, 'server.properties')), true);
    assert.strictEqual(fs.existsSync(path.join(created, 'paper.jar')), true);
    assert.strictEqual(fs.existsSync(path.join(created, 'world')), false);
    assert.strictEqual(registry.length, 1);
    assert.strictEqual(fs.existsSync(templates.stagingRootFor(parent, first)), false);

    // A replayed key returns the same operation instead of building again.
    res = await call('POST', `/api/templates/${templateId}/instantiate`, { body: { name: 'From template', parentDir: parent }, key: 'k-1' });
    assert.strictEqual(res.status, 202);
    const replay = await res.json();
    assert.strictEqual(replay.operationId, first);
    assert.strictEqual(replay.replay, true);
    assert.strictEqual(registry.length, 1, 'a replayed request built a second server');
    console.log('ok  instantiation answers 202, promotes, registers, and replays idempotently');

    // --- an existing destination is never overwritten -------------------------
    res = await call('POST', `/api/templates/${templateId}/instantiate`, { body: { name: 'From template', parentDir: parent }, key: 'k-2' });
    op = await settled((await res.json()).operationId);
    assert.strictEqual(op.state, 'failed');
    assert.strictEqual(op.error.code, 'destination_exists');
    assert.strictEqual(registry.length, 1);
    console.log('ok  an existing destination fails the operation instead of merging');

    // --- clone: same pipeline, scoped by server.manage ------------------------
    res = await call('POST', `/api/servers/${server.id}/clone-preview`, { user: 'nobody', body: {} });
    assert.strictEqual(res.status, 403);
    res = await call('POST', `/api/servers/${server.id}/clone-preview`, { user: 'manager', body: { name: 'Copy' } });
    assert.strictEqual(res.status, 200);
    assert.ok((await res.json()).manifest.entries.some((entry) => entry.path === 'world' && entry.action === 'excluded'));

    res = await call('POST', `/api/servers/${server.id}/clone`, { user: 'manager', body: { name: 'Cloned', parentDir: parent }, key: 'k-3' });
    assert.strictEqual(res.status, 202);
    op = await settled((await res.json()).operationId);
    assert.strictEqual(op.state, 'succeeded');
    assert.strictEqual(fs.existsSync(path.join(parent, 'cloned', 'world')), false);
    assert.strictEqual(registry.length, 2);
    console.log('ok  clone runs the same staged pipeline without worlds');

    // --- promoted but unregistered becomes recoverable ------------------------
    registrationFails = true;
    res = await call('POST', `/api/templates/${templateId}/instantiate`, { body: { name: 'Orphan', parentDir: parent }, key: 'k-4' });
    const orphanOp = (await res.json()).operationId;
    op = await settled(orphanOp);
    assert.strictEqual(op.state, 'recovery_required');
    const orphanDir = path.join(parent, 'orphan');
    assert.strictEqual(fs.existsSync(path.join(orphanDir, 'server.properties')), true, 'recovery must not delete the promoted folder');
    assert.strictEqual(registry.length, 2);
    registrationFails = false;

    res = await call('POST', `/api/templates/operations/${orphanOp}/recover`, { body: { action: 'register' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(registry.length, 3);
    assert.strictEqual(operations.get(orphanOp).state, 'succeeded');
    console.log('ok  a promoted-but-unregistered server is recoverable, not destroyed');

    // --- discard is the other half of recovery --------------------------------
    registrationFails = true;
    res = await call('POST', `/api/templates/${templateId}/instantiate`, { body: { name: 'Discardable', parentDir: parent }, key: 'k-5' });
    const discardOp = (await res.json()).operationId;
    await settled(discardOp);
    registrationFails = false;
    const discardDir = path.join(parent, 'discardable');
    assert.strictEqual(fs.existsSync(discardDir), true);
    res = await call('POST', `/api/templates/operations/${discardOp}/recover`, { user: 'nobody', body: { action: 'discard' } });
    assert.strictEqual(res.status, 403);
    res = await call('POST', `/api/templates/operations/${discardOp}/recover`, { body: { action: 'discard' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(fs.existsSync(discardDir), false);
    assert.strictEqual(operations.get(discardOp).state, 'cancelled');
    console.log('ok  discard removes only the folder the operation itself promoted');

    // --- export and delete need curation --------------------------------------
    res = await call('GET', `/api/templates/${templateId}/export`, { user: 'manager' });
    assert.strictEqual(res.status, 403);
    res = await call('GET', `/api/templates/${templateId}/export`);
    assert.strictEqual(res.status, 200);
    const disposition = res.headers.get('content-disposition');
    assert.ok(/^attachment; filename="[A-Za-z0-9._-]+\.zip"/.test(disposition), `unsafe disposition: ${disposition}`);
    assert.ok((await res.arrayBuffer()).byteLength > 0);

    res = await call('DELETE', `/api/templates/${templateId}`, { user: 'manager' });
    assert.strictEqual(res.status, 403);
    res = await call('DELETE', `/api/templates/${templateId}`);
    assert.strictEqual(res.status, 200);
    console.log('ok  export and delete require content.view plus server.manage');

    // --- imports are admin-only ------------------------------------------------
    res = await call('POST', '/api/templates/import', { user: 'manager', body: { token: 'x' } });
    assert.strictEqual(res.status, 403);
    console.log('ok  template import is admin-only');
  } finally {
    httpServer.close();
    close();
    fs.rmSync(ROOT, { recursive: true, force: true });
    teardown();
  }
  console.log('PASS  server-templates-routes');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
