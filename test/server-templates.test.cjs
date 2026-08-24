'use strict';

/*
 * Server templates (docs/roadmap/09-server-templates.md): classification and
 * sanitization, preview/archive parity, managed content as references rather
 * than copied binaries, untrusted imports, and the staged-then-promoted
 * materialization.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { setupDataDir, teardown, TMP_ROOT } = require('./_setup.cjs');
setupDataDir();

const migrations = require('../lib/migrations.cjs');
const { open, close } = require('../lib/db.cjs');
const templates = require('../lib/templates.cjs');

function zipOf(file, entries) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(file);
    const zip = archiver('zip');
    output.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(output);
    for (const [name, body] of Object.entries(entries)) zip.append(body, { name });
    zip.finalize();
  });
}

function seedSource() {
  const root = path.join(TMP_ROOT, 'Servidor ñ');
  fs.mkdirSync(path.join(root, 'world', 'region'), { recursive: true });
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config', 'plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server.properties'), 'server-ip=10.0.0.1\nserver-port=24444\nrcon.password=do-not-copy\nmotd=Hello\n');
  fs.writeFileSync(path.join(root, 'config', 'plugin', 'settings.yml'), 'path: /srv/minecraft/data\napi-key: very-secret\nenabled: true\n');
  fs.writeFileSync(path.join(root, 'world', 'level.dat'), 'world');
  fs.writeFileSync(path.join(root, 'logs', 'latest.log'), 'private log');
  fs.writeFileSync(path.join(root, 'server.jar'), 'binary');
  fs.writeFileSync(path.join(root, 'unknown.txt'), 'unknown');
  fs.writeFileSync(path.join(root, 'whitelist.json'), '[{"name":"Player"}]');
  fs.writeFileSync(path.join(root, 'plugins', 'EssentialsX.jar'), 'PLUGIN-BYTES');
  return root;
}

(async function main() {
  migrations.runMigrations();
  const root = seedSource();
  const server = { id: 'source-1', name: 'Survival ñ', dir: root, loader: 'paper', mcVersion: '1.21.4', worlds: ['world'] };

  // The plugin was installed by Hostkind, so it has provenance: the template
  // must carry the reference, never the jar.
  const pluginSha = templates.sha256File(path.join(root, 'plugins', 'EssentialsX.jar'));
  open().prepare('INSERT INTO content_provenance VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run('prov-1', server.id, 'plugins/EssentialsX.jar', 'plugin', 'modrinth', 'proj-ess', 'ver-ess', '1.21.4', 'paper', pluginSha, Date.now());

  // --- classification + sanitization ---------------------------------------
  const preview = templates.buildPreview(server, { name: 'Portable' });
  const byPath = new Map(preview.manifest.entries.map((item) => [item.path, item]));
  assert.strictEqual(byPath.get('world').action, 'excluded');
  assert.strictEqual(byPath.get('logs').action, 'excluded');
  assert.strictEqual(byPath.get('server.jar').action, 'excluded');
  assert.strictEqual(byPath.get('unknown.txt').action, 'excluded');
  assert.strictEqual(byPath.get('whitelist.json').action, 'excluded');
  assert.strictEqual(byPath.get('server.properties').action, 'transformed');
  assert.strictEqual(byPath.get('config/plugin/settings.yml').action, 'transformed');
  // An excluded world is not descended into, and a transparent container is not
  // reported as excluded while its children are included.
  assert.strictEqual(byPath.has('world/level.dat'), false);
  assert.strictEqual(byPath.has('config'), false);
  assert.strictEqual(byPath.has('plugins'), false);
  const props = preview.files.find((item) => item.path === 'server.properties').content.toString();
  assert.match(props, /server-ip=\{\{SERVER_IP\}\}/);
  assert.match(props, /server-port=\{\{SERVER_PORT\}\}/);
  assert.doesNotMatch(props, /do-not-copy/);
  const yml = preview.files.find((item) => item.path === 'config/plugin/settings.yml').content.toString();
  assert.doesNotMatch(yml, /very-secret/);
  assert.doesNotMatch(yml, /\/srv\/minecraft/);
  console.log('ok  preview classifies containers, exclusions, and sanitized values');

  // --- managed content is a reference, not a binary -------------------------
  assert.strictEqual(byPath.get('plugins/EssentialsX.jar').action, 'referenced');
  assert.deepStrictEqual(preview.manifest.content, [{
    path: 'plugins/EssentialsX.jar', kind: 'plugin', provider: 'modrinth', projectId: 'proj-ess',
    versionId: 'ver-ess', mcVersion: '1.21.4', loader: 'paper', sha256: pluginSha,
  }]);
  assert.strictEqual(preview.files.some((item) => item.path.endsWith('.jar')), false);
  console.log('ok  managed content travels as provider + hash, never as a copied jar');

  // --- archive parity ------------------------------------------------------
  const saved = await templates.create({ server, name: 'Portable', description: 'Test', actorId: 'admin' });
  assert.strictEqual(saved.version, 1);
  const row = templates.latest(saved.id);
  const loaded = await templates.readZip(templates.archivePath(row));
  templates.validateImported(loaded.manifest, loaded.files);
  assert.deepStrictEqual([...loaded.files.keys()].sort(), preview.files.map((item) => item.path).sort());
  const archived = [...loaded.files.values()].map((buffer) => buffer.toString()).join('\n');
  assert.doesNotMatch(archived, /do-not-copy|very-secret|10\.0\.0\.1/);
  console.log('ok  archive contents match the preview and carry no excluded data');

  // --- staged materialization + atomic promote ------------------------------
  const parent = fs.mkdtempSync(path.join(TMP_ROOT, 'dest-'));
  const source = await templates.loadForInstantiate(row);
  const resolve = async (content, stagedRoot) => {
    for (const item of content) {
      fs.mkdirSync(path.join(stagedRoot, path.dirname(item.path)), { recursive: true });
      fs.writeFileSync(path.join(stagedRoot, item.path), 'PLUGIN-BYTES');
      if (templates.sha256File(path.join(stagedRoot, item.path)) !== item.sha256) throw new Error('hash mismatch');
    }
    return content;
  };
  const staged = await templates.stageServer({
    parentDir: parent, operationId: 'op-1', files: source.files, content: source.content,
    placeholders: { SERVER_PORT: '25570' }, resolve,
  });
  const destination = path.join(parent, templates.slugFor('instantiated ñ'));
  assert.strictEqual(fs.existsSync(destination), false, 'nothing is written to the destination before promotion');
  templates.promote(staged.staged, destination);
  assert.strictEqual(fs.existsSync(staged.staged), false);

  const instantiated = fs.readFileSync(path.join(destination, 'server.properties'), 'utf8');
  assert.match(instantiated, /server-port=25570/);
  assert.match(instantiated, /server-ip=\r?\n/);
  assert.strictEqual(fs.existsSync(path.join(destination, 'world')), false);
  assert.strictEqual(fs.readFileSync(path.join(destination, 'eula.txt'), 'utf8'), 'eula=true\n');
  assert.strictEqual(fs.readFileSync(path.join(destination, 'plugins', 'EssentialsX.jar'), 'utf8'), 'PLUGIN-BYTES');
  console.log('ok  staging promotes atomically, applies placeholders, and resolves content');

  // --- an existing destination is never merged or overwritten ---------------
  const second = await templates.stageServer({
    parentDir: parent, operationId: 'op-2', files: source.files, content: [], placeholders: {},
  });
  assert.throws(() => templates.promote(second.staged, destination), /already exists/);
  fs.rmSync(second.staged, { recursive: true, force: true });
  console.log('ok  promotion refuses an existing destination');

  // --- content resolution failure leaves nothing behind ---------------------
  const failing = async () => { throw Object.assign(new Error('provider down'), { code: 'content_unavailable' }); };
  await assert.rejects(() => templates.stageServer({
    parentDir: parent, operationId: 'op-3', files: source.files, content: source.content,
    placeholders: {}, resolve: failing,
  }), /provider down/);
  assert.strictEqual(fs.existsSync(templates.stagingRootFor(parent, 'op-3')), false);
  console.log('ok  a content resolution failure discards staging before any promotion');

  // --- staging sweep --------------------------------------------------------
  const orphan = templates.stagingRootFor(parent, 'op-dead');
  fs.mkdirSync(orphan, { recursive: true });
  templates.sweepStaging(parent, (id) => id === 'op-live');
  assert.strictEqual(fs.existsSync(orphan), false);
  console.log('ok  interrupted staging is discarded');

  // --- import: roundtrip and rejections -------------------------------------
  const exported = path.join(TMP_ROOT, 'exported.zip');
  fs.copyFileSync(templates.archivePath(row), exported);
  const importable = path.join(TMP_ROOT, 'to-import.zip');
  fs.copyFileSync(exported, importable);
  const importPreview = await templates.importPreview(importable, 'admin');
  assert.strictEqual(importPreview.manifest.files.length, preview.files.length);
  const imported = await templates.confirmImport(importPreview.token, 'admin', { name: 'Imported' });
  assert.strictEqual(templates.latest(imported.id).name, 'Imported');
  assert.strictEqual(templates.latest(imported.id).source_server_id, null);
  console.log('ok  an exported template imports after preview and confirmation');

  const traversal = path.join(TMP_ROOT, 'evil-traversal.zip');
  await zipOf(traversal, { 'manifest.json': '{"schemaVersion":1,"files":[],"entries":[]}', '../escape.yml': 'x: 1' });
  await assert.rejects(() => templates.importPreview(traversal, 'admin'));

  const outside = path.join(TMP_ROOT, 'evil-scope.zip');
  await zipOf(outside, { 'manifest.json': '{"schemaVersion":1,"files":[],"entries":[]}', 'elsewhere/x.yml': 'x: 1' });
  await assert.rejects(() => templates.importPreview(outside, 'admin'), /outside the template root/);

  const tampered = path.join(TMP_ROOT, 'evil-hash.zip');
  await zipOf(tampered, {
    'manifest.json': JSON.stringify({
      schemaVersion: 1, name: 'x', entries: [],
      files: [{ path: 'server.properties', sha256: 'a'.repeat(64), size: 3 }],
    }),
    'files/server.properties': 'motd=changed\n',
  });
  await assert.rejects(() => templates.importPreview(tampered, 'admin'), /verification failed/);

  const future = path.join(TMP_ROOT, 'evil-schema.zip');
  await zipOf(future, { 'manifest.json': '{"schemaVersion":99,"files":[],"entries":[]}' });
  await assert.rejects(() => templates.importPreview(future, 'admin'), /newer than this Hostkind version/);

  const secretly = path.join(TMP_ROOT, 'evil-secret.zip');
  const body = 'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature\n';
  const crypto = require('crypto');
  await zipOf(secretly, {
    'manifest.json': JSON.stringify({
      schemaVersion: 1, name: 'x', entries: [],
      files: [{ path: 'config/x.yml', sha256: crypto.createHash('sha256').update(body).digest('hex'), size: body.length }],
    }),
    'files/config/x.yml': body,
  });
  await assert.rejects(() => templates.importPreview(secretly, 'admin'), /Possible secret/);

  const badProvider = path.join(TMP_ROOT, 'evil-provider.zip');
  await zipOf(badProvider, {
    'manifest.json': JSON.stringify({
      schemaVersion: 1, name: 'x', entries: [], files: [],
      content: [{ path: 'plugins/x.jar', provider: 'sketchy', projectId: 'p', versionId: 'v', sha256: 'a'.repeat(64) }],
    }),
  });
  await assert.rejects(() => templates.importPreview(badProvider, 'admin'), /Unsupported content provider/);
  console.log('ok  malicious imports are rejected: traversal, scope, hashes, schema, secrets, providers');

  // --- versions and soft delete ---------------------------------------------
  const next = await templates.create({ server, name: 'Portable', actorId: 'admin', templateId: saved.id });
  assert.strictEqual(next.version, 2);
  assert.deepStrictEqual(templates.versions(saved.id).map((item) => item.version), [2, 1]);
  templates.remove(saved.id);
  assert.strictEqual(templates.latest(saved.id), null);
  assert.ok(templates.latest(saved.id, true), 'deletion is soft: version history survives');
  assert.strictEqual(templates.list().items.some((item) => item.id === saved.id), false);
  console.log('ok  versions are immutable and deletion is soft');

  close();
  teardown();
  console.log('PASS  server-templates');
})().catch((err) => { close(); teardown(); console.error(err); process.exitCode = 1; });
