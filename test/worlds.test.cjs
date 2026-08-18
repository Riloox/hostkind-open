'use strict';

/*
 * World operations (docs/roadmap/08-world-operations.md).
 *
 * The acceptance list is the test list: no world-root escape, complete disk and
 * impact preview, verified snapshot before destructive work, an atomic commit
 * that requires the server to be offline, config and disk agreeing after a
 * failure, honest Chunky compatibility, explicit install consent, and a
 * cancellation status that matches what pre-generation actually did.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const archiver = require('archiver');
const { setupDataDir, teardown } = require('./_setup.cjs');
setupDataDir();

const { close, dbPath, open } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');
const worlds = require('../lib/worlds.cjs');
const operations = require('../lib/operations.cjs');
const snapshots = require('../lib/snapshots.cjs');

function fresh() {
  close();
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath() + ext;
    if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (_) { /* */ }
  }
  migrations.runMigrations();
}
fresh();

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lodestone-worlds-'));
let seq = 0;

// A server folder with real world folders in it: level.dat is what makes a
// directory a world, so the fixtures carry one.
function makeServer(worldNames = ['world'], { files = 3 } = {}) {
  const id = `srv-${++seq}`;
  const dir = path.join(ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of worldNames) {
    const w = path.join(dir, name);
    fs.mkdirSync(path.join(w, 'region'), { recursive: true });
    fs.writeFileSync(path.join(w, 'level.dat'), `level:${name}`);
    for (let i = 0; i < files; i++) fs.writeFileSync(path.join(w, 'region', `r.${i}.mca`), Buffer.alloc(1024, i));
  }
  return { id, name: `Server ${id}`, dir, worlds: [...worldNames] };
}

function fakeManager(status = 'offline') {
  const sent = [];
  const watchers = new Set();
  return {
    status,
    // Test fixtures written after this object are treated as content that was
    // already present when the simulated JVM started.
    startedAt: Date.now() + 60000,
    sent,
    sendCommand: (cmd) => { sent.push(cmd); return { ok: true }; },
    watchLines: (fn) => { watchers.add(fn); return () => watchers.delete(fn); },
    emit: (line) => { for (const fn of [...watchers]) fn(line); },
  };
}

// Build a zip from a { path: contents } map.
function makeZip(file, entries) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    const zip = archiver('zip', { zlib: { level: 0 } });
    out.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(out);
    for (const [name, content] of Object.entries(entries)) zip.append(Buffer.from(content), { name });
    zip.finalize();
  });
}

/*
 * A hand-built, store-only zip. archiver normalizes "../" out of entry names,
 * which makes it useless for testing a hostile archive - so the malicious
 * fixtures are written byte by byte, exactly as an attacker would.
 */
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function writeRawZip(file, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const nameBuf = Buffer.from(name, 'utf8');
    const sum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(0, 8);           // stored
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 10);            // stored
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);       // local header offset
    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...chunks, centralBuf, end]));
}

const ACTOR = 'actor-1';
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function rejects(fn, code) {
  try { await fn(); }
  catch (err) { assert.strictEqual(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`); return err; }
  assert.fail(`expected ${code}, but the call succeeded`);
}

// --- names and roots ------------------------------------------------------

test('a world name may not escape the server folder', () => {
  for (const bad of ['../evil', '/etc', 'a/b', 'C:\\x', '..', 'world\0']) {
    assert.throws(() => worlds.normalizeName(bad), /world name|folder name/i, `accepted ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(worlds.normalizeName(' my world '), 'my world');
});

test('reserved and unsafe folder names are refused', () => {
  for (const bad of ['CON', 'lpt1', 'nul', 'trailing.', 'x'.repeat(65)]) {
    assert.throws(() => worlds.normalizeName(bad));
  }
});

test('a path that would escape the server folder is refused by worldPath', () => {
  const server = makeServer();
  assert.throws(() => worlds.worldPath(server, '../..'), /inside the server folder/);
});

test('a symlinked world root is refused rather than followed', function () {
  const server = makeServer();
  const outside = path.join(ROOT, 'outside-target');
  fs.mkdirSync(outside, { recursive: true });
  try { fs.symlinkSync(outside, path.join(server.dir, 'linked')); }
  catch { return; } // unprivileged Windows: nothing to test
  assert.throws(() => worlds.worldPath(server, 'linked'), /link/i);
});

test('nested registered roots are refused', () => {
  assert.throws(() => worlds.assertNoOverlap(['world', 'world/region']), /overlap/i);
  assert.throws(() => worlds.assertNoOverlap(['world', 'WORLD']), /overlap/i);
  worlds.assertNoOverlap(['world', 'world_nether']); // sibling names are fine
});

// --- inventory ------------------------------------------------------------

test('inventory reports registered worlds and lists unregistered candidates separately', () => {
  const server = makeServer(['world']);
  fs.mkdirSync(path.join(server.dir, 'spare'), { recursive: true });
  fs.writeFileSync(path.join(server.dir, 'spare', 'level.dat'), 'spare');

  const inv = worlds.inventory(server);
  assert.strictEqual(inv.worlds.length, 1);
  assert.strictEqual(inv.worlds[0].name, 'world');
  assert.ok(inv.worlds[0].hasMarker);
  assert.ok(inv.worlds[0].sizeBytes > 0);
  assert.deepStrictEqual(inv.worlds[0].dimensions, ['overworld']);
  // Discovered, not adopted: the configured worlds stay authoritative.
  assert.deepStrictEqual(inv.candidates.map((c) => c.name), ['spare']);
  assert.deepStrictEqual(server.worlds, ['world']);

  const cached = open().prepare('SELECT * FROM world_inventory WHERE server_id = ?').all(server.id);
  assert.strictEqual(cached.length, 1);
});

test('responses carry no absolute paths', () => {
  const server = makeServer(['world']);
  const json = JSON.stringify(worlds.inventory(server));
  assert.ok(!json.includes(server.dir), 'inventory leaked the server folder path');
});

// --- previews -------------------------------------------------------------

test('a preview is single-use and dies when the worlds change under it', () => {
  const server = makeServer(['world', 'spare']);
  const world = worlds.findWorld(server, 'spare');
  const preview = worlds.previewDelete({ server, actorId: ACTOR, world, manager: fakeManager() });
  assert.strictEqual(preview.requiresOffline, true);
  assert.ok(preview.disk.requiredBytes > 0);

  // Another actor cannot spend it.
  assert.throws(() => worlds.consumePreview({ token: preview.token, server, actorId: 'someone-else', action: 'delete' }), /current preview/);

  const second = worlds.previewDelete({ server, actorId: ACTOR, world, manager: fakeManager() });
  fs.writeFileSync(path.join(server.dir, 'world', 'level.dat'), 'changed');
  assert.throws(() => worlds.consumePreview({ token: second.token, server, actorId: ACTOR, action: 'delete' }), /changed since the preview/);

  const third = worlds.previewDelete({ server, actorId: ACTOR, world, manager: fakeManager() });
  worlds.consumePreview({ token: third.token, server, actorId: ACTOR, action: 'delete' });
  // Single-use: the replay of a destructive request cannot reuse the consent.
  assert.throws(() => worlds.consumePreview({ token: third.token, server, actorId: ACTOR, action: 'delete' }), /current preview/);
});

test('the last registered world cannot be deleted', () => {
  const server = makeServer(['world']);
  const world = worlds.findWorld(server, 'world');
  assert.throws(() => worlds.previewDelete({ server, actorId: ACTOR, world, manager: fakeManager() }), /only registered world/);
});

// --- import ---------------------------------------------------------------

test('an archive with no level.dat is refused', async () => {
  const server = makeServer();
  const zip = path.join(ROOT, `no-marker-${++seq}.zip`);
  await makeZip(zip, { 'stuff/readme.txt': 'hello' });
  await rejects(() => worlds.previewImport({ server, actorId: ACTOR, archivePath: zip }), 'missing_marker');
});

test('a traversing archive entry never reaches the disk', async () => {
  const dest = path.join(ROOT, `extract-${++seq}`);
  const zip = path.join(ROOT, `evil-${++seq}.zip`);
  writeRawZip(zip, { 'w/level.dat': 'x', '../../escaped.txt': 'pwned' });

  await rejects(() => worlds.scanArchive(zip), 'path_traversal');
  await rejects(() => worlds.extractRoot(zip, 'w', dest), 'path_traversal');
  assert.ok(!fs.existsSync(path.join(ROOT, 'escaped.txt')), 'the archive escaped the staging root');
  assert.ok(!fs.existsSync(path.join(path.dirname(ROOT), 'escaped.txt')));
});

test('an absolute path in an archive is refused', async () => {
  const zip = path.join(ROOT, `abs-${++seq}.zip`);
  writeRawZip(zip, { 'w/level.dat': 'x', 'C:\\windows\\system32\\evil.dll': 'pwned' });
  await rejects(() => worlds.scanArchive(zip), 'absolute_path');
});

test('a case-fold duplicate in an archive is refused', async () => {
  const zip = path.join(ROOT, `dupe-${++seq}.zip`);
  writeRawZip(zip, { 'w/level.dat': 'x', 'W/LEVEL.DAT': 'y' });
  await rejects(() => worlds.scanArchive(zip), 'duplicate_entry');
});

test('importing onto an existing name collides instead of overwriting', async () => {
  const server = makeServer(['world']);
  const zip = path.join(ROOT, `dup-${++seq}.zip`);
  await makeZip(zip, { 'world/level.dat': 'x', 'world/region/r.0.mca': 'y' });
  await rejects(() => worlds.previewImport({ server, actorId: ACTOR, archivePath: zip, mode: 'add' }), 'name_collision');
  // Case-only differences collide too: they are the same folder on Windows/macOS.
  await rejects(() => worlds.previewImport({ server, actorId: ACTOR, archivePath: zip, requestedName: 'WORLD', mode: 'add' }), 'name_collision');
});

test('an import registers the world and leaves config and disk agreeing', async () => {
  const server = makeServer(['world']);
  const manager = fakeManager('offline');
  const zip = path.join(ROOT, `import-${++seq}.zip`);
  await makeZip(zip, { 'creative/level.dat': 'lvl', 'creative/region/r.0.mca': 'chunks' });

  const preview = await worlds.previewImport({ server, actorId: ACTOR, archivePath: zip, mode: 'add' });
  assert.strictEqual(preview.name, 'creative');
  assert.strictEqual(preview.requiresOffline, false);
  assert.deepStrictEqual(preview.registration, { adds: 'creative' });
  assert.ok(preview.disk.requiredBytes > 0);

  const consumed = worlds.consumePreview({ token: preview.token, server, actorId: ACTOR, action: 'import' });
  const op = operations.create({ kind: worlds.KIND.IMPORT, actorId: ACTOR, serverId: server.id, idempotencyKey: `import-${seq}` });
  operations.start(op.id, { phase: 'preview-revalidate' });

  const saved = [];
  const result = await worlds.runImport({
    server, manager, operationId: op.id, archivePath: zip, preview: consumed,
    saveWorlds: (next) => { saved.push(next); server.worlds = next; },
  });

  assert.strictEqual(result.name, 'creative');
  assert.ok(fs.existsSync(path.join(server.dir, 'creative', 'level.dat')));
  assert.deepStrictEqual(saved, [['world', 'creative']]);
  assert.strictEqual(operations.get(op.id).state, 'succeeded');
  // Nothing of ours is left behind.
  assert.ok(!fs.existsSync(path.join(server.dir, '.lodestone', 'staging', op.id)));
});

test('a config save that fails undoes the import rather than reporting success', async () => {
  const server = makeServer(['world']);
  const zip = path.join(ROOT, `import-fail-${++seq}.zip`);
  await makeZip(zip, { 'broken/level.dat': 'lvl' });

  const preview = await worlds.previewImport({ server, actorId: ACTOR, archivePath: zip, mode: 'add' });
  const consumed = worlds.consumePreview({ token: preview.token, server, actorId: ACTOR, action: 'import' });
  const op = operations.create({ kind: worlds.KIND.IMPORT, actorId: ACTOR, serverId: server.id, idempotencyKey: `import-fail-${seq}` });
  operations.start(op.id, { phase: 'preview-revalidate' });

  await rejects(() => worlds.runImport({
    server, manager: fakeManager('offline'), operationId: op.id, archivePath: zip, preview: consumed,
    saveWorlds: () => { throw new Error('disk full'); },
  }), 'config_save_failed');

  // Compensated: the folder is gone, the config never grew a world it does not have.
  assert.ok(!fs.existsSync(path.join(server.dir, 'broken')));
  assert.deepStrictEqual(server.worlds, ['world']);
  assert.strictEqual(operations.get(op.id).state, 'failed');
});

test('replacing a registered world requires the server to be offline', async () => {
  const server = makeServer(['world']);
  const zip = path.join(ROOT, `replace-${++seq}.zip`);
  await makeZip(zip, { 'world/level.dat': 'replacement', 'world/region/r.0.mca': 'new' });

  const preview = await worlds.previewImport({ server, actorId: ACTOR, archivePath: zip, mode: 'replace' });
  assert.strictEqual(preview.requiresOffline, true);
  assert.deepStrictEqual(preview.registration, { replaces: 'world' });

  const consumed = worlds.consumePreview({ token: preview.token, server, actorId: ACTOR, action: 'import' });
  const op = operations.create({ kind: worlds.KIND.IMPORT, actorId: ACTOR, serverId: server.id, idempotencyKey: `replace-${seq}` });
  operations.start(op.id, { phase: 'preview-revalidate' });

  // The online race: the server came up while the import was staging.
  await rejects(() => worlds.runImport({
    server, manager: fakeManager('online'), operationId: op.id, archivePath: zip, preview: consumed,
    saveWorlds: () => assert.fail('config must not be touched when the commit is refused'),
  }), 'server_online');

  // Refused before the commit: the original world is untouched.
  assert.strictEqual(fs.readFileSync(path.join(server.dir, 'world', 'level.dat'), 'utf8'), 'level:world');
  assert.strictEqual(operations.get(op.id).state, 'failed');
});

test('a verified snapshot is taken before a world is replaced', async () => {
  const server = makeServer(['world']);
  const zip = path.join(ROOT, `replace-ok-${++seq}.zip`);
  await makeZip(zip, { 'world/level.dat': 'replacement' });

  const preview = await worlds.previewImport({ server, actorId: ACTOR, archivePath: zip, mode: 'replace' });
  const consumed = worlds.consumePreview({ token: preview.token, server, actorId: ACTOR, action: 'import' });
  const op = operations.create({ kind: worlds.KIND.IMPORT, actorId: ACTOR, serverId: server.id, idempotencyKey: `replace-ok-${seq}` });
  operations.start(op.id, { phase: 'preview-revalidate' });

  const taken = [];
  const realTake = snapshots.take;
  snapshots.take = (args) => { const s = realTake(args); taken.push(s); return s; };
  try {
    await worlds.runImport({
      server, manager: fakeManager('offline'), operationId: op.id, archivePath: zip, preview: consumed,
      saveWorlds: () => assert.fail('a replacement does not change the registered world list'),
    });
  } finally { snapshots.take = realTake; }

  assert.strictEqual(taken.length, 1);
  assert.strictEqual(taken[0].kind, 'world-import');
  assert.strictEqual(fs.readFileSync(path.join(server.dir, 'world', 'level.dat'), 'utf8'), 'replacement');
  assert.deepStrictEqual(server.worlds, ['world']);
});

// --- clone ----------------------------------------------------------------

test('a clone copies the world, registers it, and cancels cleanly before the commit', async () => {
  const server = makeServer(['world']);
  const world = worlds.findWorld(server, 'world');

  const preview = worlds.previewClone({ server, actorId: ACTOR, world, requestedName: 'backup world' });
  assert.strictEqual(preview.name, 'backup world');
  assert.ok(preview.source.sizeBytes > 0);
  const consumed = worlds.consumePreview({ token: preview.token, server, actorId: ACTOR, action: 'clone' });

  const op = operations.create({ kind: worlds.KIND.CLONE, actorId: ACTOR, serverId: server.id, idempotencyKey: `clone-${seq}` });
  operations.start(op.id, { phase: 'preview-revalidate' });
  const result = await worlds.runClone({
    server, operationId: op.id, world, preview: consumed,
    saveWorlds: (next) => { server.worlds = next; },
  });
  assert.strictEqual(result.name, 'backup world');
  assert.ok(fs.existsSync(path.join(server.dir, 'backup world', 'level.dat')));
  assert.deepStrictEqual(server.worlds, ['world', 'backup world']);

  // Cancelling before the commit leaves nothing behind and reports cancelled.
  const second = worlds.previewClone({ server, actorId: ACTOR, world, requestedName: 'aborted' });
  const secondConsumed = worlds.consumePreview({ token: second.token, server, actorId: ACTOR, action: 'clone' });
  const op2 = operations.create({ kind: worlds.KIND.CLONE, actorId: ACTOR, serverId: server.id, idempotencyKey: `clone2-${seq}` });
  operations.start(op2.id, { phase: 'preview-revalidate' });
  operations.cancel(op2.id);
  await rejects(() => worlds.runClone({
    server, operationId: op2.id, world, preview: secondConsumed,
    saveWorlds: () => assert.fail('a cancelled clone must not touch the config'),
  }), 'cancelled');
  assert.strictEqual(operations.get(op2.id).state, 'cancelled');
  assert.ok(!fs.existsSync(path.join(server.dir, 'aborted')));
});

// --- delete ---------------------------------------------------------------

test('delete is a staged rename, retained until the operation verifies itself', async () => {
  const server = makeServer(['world', 'doomed']);
  const world = worlds.findWorld(server, 'doomed');
  const preview = worlds.previewDelete({ server, actorId: ACTOR, world, manager: fakeManager('offline') });
  assert.deepStrictEqual(preview.registration, { removes: 'doomed' });
  assert.deepStrictEqual(preview.remaining, ['world']);
  const consumed = worlds.consumePreview({ token: preview.token, server, actorId: ACTOR, action: 'delete' });

  const op = operations.create({ kind: worlds.KIND.DELETE, actorId: ACTOR, serverId: server.id, idempotencyKey: `del-${seq}` });
  operations.start(op.id, { phase: 'preview-revalidate' });
  const result = await worlds.runDelete({
    server, manager: fakeManager('offline'), operationId: op.id, world, preview: consumed,
    saveWorlds: (next) => { server.worlds = next; },
  });

  assert.ok(!fs.existsSync(path.join(server.dir, 'doomed')));
  assert.deepStrictEqual(server.worlds, ['world']);
  assert.strictEqual(operations.get(op.id).state, 'succeeded');
  // The snapshot is the recovery position, and it is verified.
  const snapshot = snapshots.list(server.id).find((s) => s.id === result.snapshotId);
  assert.ok(snapshot, 'the delete kept no snapshot');
  assert.strictEqual(snapshot.verified, 1);
});

test('a config save that fails puts the deleted world back', async () => {
  const server = makeServer(['world', 'doomed']);
  const world = worlds.findWorld(server, 'doomed');
  const preview = worlds.previewDelete({ server, actorId: ACTOR, world, manager: fakeManager('offline') });
  const consumed = worlds.consumePreview({ token: preview.token, server, actorId: ACTOR, action: 'delete' });
  const op = operations.create({ kind: worlds.KIND.DELETE, actorId: ACTOR, serverId: server.id, idempotencyKey: `del-fail-${seq}` });
  operations.start(op.id, { phase: 'preview-revalidate' });

  await rejects(() => worlds.runDelete({
    server, manager: fakeManager('offline'), operationId: op.id, world, preview: consumed,
    saveWorlds: () => { throw new Error('config is read-only'); },
  }), 'config_save_failed');

  // Compensation: the folder is back where it was, with its contents.
  assert.ok(fs.existsSync(path.join(server.dir, 'doomed', 'level.dat')));
  assert.deepStrictEqual(server.worlds, ['world', 'doomed']);
  assert.strictEqual(operations.get(op.id).state, 'failed');
});

test('deleting while the server is online is refused before anything moves', async () => {
  const server = makeServer(['world', 'doomed']);
  const world = worlds.findWorld(server, 'doomed');
  const preview = worlds.previewDelete({ server, actorId: ACTOR, world, manager: fakeManager('online') });
  assert.strictEqual(preview.serverOffline, false);
  const consumed = worlds.consumePreview({ token: preview.token, server, actorId: ACTOR, action: 'delete' });
  const op = operations.create({ kind: worlds.KIND.DELETE, actorId: ACTOR, serverId: server.id, idempotencyKey: `del-online-${seq}` });
  operations.start(op.id, { phase: 'preview-revalidate' });

  await rejects(() => worlds.runDelete({
    server, manager: fakeManager('online'), operationId: op.id, world, preview: consumed,
    saveWorlds: () => assert.fail('config must not change while the server is online'),
  }), 'server_online');
  assert.ok(fs.existsSync(path.join(server.dir, 'doomed', 'level.dat')));
});

// --- download names -------------------------------------------------------

test('download names cannot carry a path, a quote, or a header break', () => {
  const name = worlds.safeDownloadName('My Server; rm -rf /', '../../etc/pa"sswd\r\n');
  assert.ok(/^[A-Za-z0-9._-]+\.zip$/.test(name), `unsafe download name: ${name}`);
  assert.ok(!name.includes('..'));
});

// --- disk gates -----------------------------------------------------------

test('an unknown disk capacity fails closed', () => {
  assert.throws(() => worlds.assertDisk({ sufficient: false, reason: 'capacity_unknown' }), /could not be read/);
  assert.throws(() => worlds.assertDisk({ sufficient: false, reason: 'insufficient_space' }), /Not enough free disk space/);
  worlds.assertDisk({ sufficient: true });
});

test('the disk plan asks for headroom above the payload', () => {
  const server = makeServer();
  const plan = worlds.diskPlan(server.dir, 1000);
  assert.strictEqual(plan.requiredBytes, 1000);
  assert.ok(plan.neededBytes > 1000, 'no headroom over the payload');
});

// --- pre-generation -------------------------------------------------------

test('Chunky compatibility is answered honestly, never guessed', async () => {
  // Vanilla loads neither plugins nor mods: no amount of Modrinth searching
  // changes that, so we do not go looking.
  const vanilla = await worlds.resolveChunky({ projectType: null, loaders: [], mcVersion: '1.21', label: 'Vanilla' });
  assert.deepStrictEqual(vanilla, { supported: false, reason: 'vanilla' });

  const unknown = await worlds.resolveChunky({ projectType: 'plugin', loaders: ['paper'], mcVersion: '', label: 'Paper' });
  assert.strictEqual(unknown.supported, false);
  assert.strictEqual(unknown.reason, 'unknown_mc_version');

  // Provider down: unsupported with a reason, never a silent "yes".
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const offline = await worlds.resolveChunky({ projectType: 'plugin', loaders: ['paper'], mcVersion: '1.21', label: 'Paper' });
    assert.strictEqual(offline.supported, false);
    assert.strictEqual(offline.reason, 'provider_unavailable');
  } finally { global.fetch = realFetch; }

  // Modrinth answers, but with nothing for this exact version.
  global.fetch = async () => ({ ok: true, json: async () => [] });
  try {
    const none = await worlds.resolveChunky({ projectType: 'mod', loaders: ['neoforge'], mcVersion: '1.99', label: 'NeoForge' });
    assert.strictEqual(none.supported, false);
    assert.strictEqual(none.reason, 'no_compatible_build');
  } finally { global.fetch = realFetch; }
});

test('pre-generation reports progress and completes', async () => {
  const server = makeServer(['world']);
  const world = worlds.findWorld(server, 'world');
  const manager = fakeManager('online');
  fs.mkdirSync(path.join(server.dir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(server.dir, 'plugins', 'Chunky-1.4.28.jar'), 'jar');

  const op = operations.create({ kind: worlds.KIND.PREGENERATE, actorId: ACTOR, serverId: server.id, idempotencyKey: `pre-${seq}` });
  operations.start(op.id, { phase: 'preview-revalidate' });
  const preview = { radius: 500, _resolved: { supported: true, folder: 'plugins', filename: 'Chunky-1.4.28.jar' } };

  const run = worlds.runPregenerate({ server, manager, operationId: op.id, world, preview });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(manager.sent.includes('chunky radius 500'), `commands sent: ${manager.sent.join(', ')}`);
  assert.ok(manager.sent.includes('chunky start'));

  manager.emit('[12:00:00] [Server thread/INFO]: [Chunky] Task running for [world]: 42.50%, ETA 0h 3m');
  await new Promise((r) => setTimeout(r, 10));
  const mid = operations.get(op.id);
  assert.ok(mid.progress > 0.4 && mid.progress < 0.6, `progress not tracked: ${mid.progress}`);

  manager.emit('[12:05:00] [Server thread/INFO]: [Chunky] Task finished for [world]');
  const result = await run;
  assert.strictEqual(result.completed, true);
  assert.strictEqual(operations.get(op.id).state, 'succeeded');
});

test('Chunky installed after server startup requires a restart', () => {
  const server = makeServer(['world']);
  const manager = fakeManager('online');
  manager.startedAt = Date.now() - 60000;
  fs.mkdirSync(path.join(server.dir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(server.dir, 'plugins', 'chunky.jar'), 'jar');

  assert.strictEqual(worlds.chunkyNeedsRestart(server, manager, 'plugins/chunky.jar'), true);
  manager.startedAt = Date.now() + 60000;
  assert.strictEqual(worlds.chunkyNeedsRestart(server, manager, 'plugins/chunky.jar'), false);
});

test('cancellation is only "cancelled" once Chunky confirms it stopped', async () => {
  const server = makeServer(['world']);
  const world = worlds.findWorld(server, 'world');
  const manager = fakeManager('online');
  fs.mkdirSync(path.join(server.dir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(server.dir, 'plugins', 'chunky.jar'), 'jar');

  const op = operations.create({ kind: worlds.KIND.PREGENERATE, actorId: ACTOR, serverId: server.id, idempotencyKey: `pre-cancel-${seq}` });
  operations.start(op.id, { phase: 'preview-revalidate' });
  const preview = { radius: 100, _resolved: { supported: true, folder: 'plugins', filename: 'chunky.jar' } };

  const run = worlds.runPregenerate({ server, manager, operationId: op.id, world, preview });
  await new Promise((r) => setTimeout(r, 20));
  operations.cancel(op.id);
  // The cancel command goes out, and until Chunky answers we are not cancelled.
  await new Promise((r) => setTimeout(r, 2200));
  assert.ok(manager.sent.includes('chunky cancel'), 'no cancellation command was sent');
  manager.emit('[12:01:00] [Server thread/INFO]: [Chunky] Task cancelled for [world]');
  await rejects(() => run, 'cancelled');
  assert.strictEqual(operations.get(op.id).state, 'cancelled');
});

test('a cancellation the server never confirms is not reported as cancelled', async () => {
  const server = makeServer(['world']);
  const world = worlds.findWorld(server, 'world');
  const manager = fakeManager('online');
  fs.mkdirSync(path.join(server.dir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(server.dir, 'plugins', 'chunky.jar'), 'jar');
  // The console is gone (an adopted process): the cancel cannot even be sent.
  manager.sendCommand = () => ({ ok: false, error: 'console detached' });

  const op = operations.create({ kind: worlds.KIND.PREGENERATE, actorId: ACTOR, serverId: server.id, idempotencyKey: `pre-nocancel-${seq}` });
  operations.start(op.id, { phase: 'preview-revalidate' });
  const preview = { radius: 100, _resolved: { supported: true, folder: 'plugins', filename: 'chunky.jar' } };

  await rejects(() => worlds.runPregenerate({ server, manager, operationId: op.id, world, preview }), 'console_unavailable');
  assert.strictEqual(operations.get(op.id).state, 'failed');
});

// --- interrupted work -----------------------------------------------------

test('an interrupted world mutation becomes recovery_required, not a silent failure', () => {
  assert.ok(operations.isDestructiveKind(worlds.KIND.IMPORT));
  assert.ok(operations.isDestructiveKind(worlds.KIND.CLONE));
  assert.ok(operations.isDestructiveKind(worlds.KIND.DELETE));

  const server = makeServer();
  const op = operations.create({ kind: worlds.KIND.DELETE, actorId: ACTOR, serverId: server.id });
  operations.start(op.id, { phase: 'commit' });
  const swept = operations.sweepStale({ heartbeatStaleMs: -1 });
  const mine = swept.find((s) => s.id === op.id);
  assert.strictEqual(mine.state, 'recovery_required');
  assert.ok(mine.recovery, 'no recovery instructions were recorded');
});

// --- runner ---------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL  ${name}\n      ${err.message}`);
    }
  }
  close();
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* */ }
  teardown();
  console.log(failed ? `\n${failed} of ${tests.length} world tests failed` : `\nall ${tests.length} world tests passed`);
  process.exit(failed ? 1 : 0);
})();
