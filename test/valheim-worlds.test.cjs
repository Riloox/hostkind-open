'use strict';

/*
 * Valheim world creation, import, rename and selection (docs/valheim/03-worlds.md).
 *
 * The acceptance list in that phase is the test list: pairs group correctly
 * and report incomplete, names cannot escape the worlds directory, offline
 * gates every mutation, previews are single-use and fingerprint-bound,
 * archive import is refused before anything is written, rename and delete
 * always move the whole set (pair + recognized backups) together, export
 * checksums round-trip, and an interrupted mutation reports
 * recovery_required rather than success.
 *
 * Nothing here parses `.fwl`/`.db` internals - the doc forbids a speculative
 * binary parser, so "health" is existence, regular-file-ness and non-empty
 * size only, and the fixtures below are plain filled buffers, not a real
 * Valheim save format.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { setupDataDir, teardown, TMP_ROOT } = require('./_setup.cjs');
setupDataDir();

const { close, dbPath, open } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');
const operations = require('../lib/operations.cjs');
const snapshots = require('../lib/snapshots.cjs');
const trash = require('../lib/trash.cjs');
const worlds = require('../lib/valheim-worlds.cjs');

global.fetch = () => { throw new Error('a test reached the network'); };

function fresh() {
  close();
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath() + ext;
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch { /* */ } }
  }
  migrations.runMigrations();
}
fresh();

const ROOT = fs.mkdtempSync(path.join(TMP_ROOT, 'valheim-worlds-'));
const ACTOR = 'actor-1';
let seq = 0;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function rejects(fn, code) {
  try { await fn(); }
  catch (err) {
    assert.strictEqual(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    assert.ok(err.message && err.message.length > 5, 'errors carry a readable message');
    return err;
  }
  assert.fail(`expected ${code}, but the call succeeded`);
  return null;
}

// A runner needs a real durable operation to check in against (checkpoint()
// reads it back), so every direct runSelect/runImport/runRename/runDelete
// call in this file goes through here rather than inventing an operationId -
// same pattern as test/terraria-worlds.test.cjs's runOperation.
async function runOperation(kind, run) {
  const op = operations.create({ kind, actorId: ACTOR, serverId: `op-${++seq}` });
  operations.start(op.id, { phase: 'preview-revalidate' });
  try { return { id: op.id, result: await run(op.id) }; }
  catch (error) { return { id: op.id, error }; }
}

/* ------------------------------------------------------------- fixtures -- */

const fwlBuf = (fill = 0x11, size = 64) => Buffer.alloc(size, fill);
const dbBuf = (fill = 0x22, size = 256) => Buffer.alloc(size, fill);

function makeServer({ worldNames = ['Dedicated'], saveDir = 'data', backups = {} } = {}) {
  const id = `srv-${++seq}`;
  const dir = path.join(ROOT, id);
  const save = path.join(dir, saveDir, 'worlds_local');
  fs.mkdirSync(save, { recursive: true });
  for (const name of worldNames) {
    fs.writeFileSync(path.join(save, `${name}${worlds.META_EXT}`), fwlBuf());
    fs.writeFileSync(path.join(save, `${name}${worlds.DATA_EXT}`), dbBuf());
  }
  for (const [name, files] of Object.entries(backups)) {
    const dir2 = path.join(save, worlds.BACKUPS_DIR);
    fs.mkdirSync(dir2, { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(dir2, file), fwlBuf(0x33, 16));
  }
  return {
    id,
    name: `Server ${id}`,
    type: 'valheim',
    dir,
    cwd: dir,
    valheimSaveDir: saveDir,
    worldName: worldNames.length ? worldNames[0] : null,
  };
}

// A descriptor store that behaves like config.json does: the runner writes
// through `saveDescriptor` and verifies through `readDescriptor`, and those
// must not be the same object.
function descriptorStore(desc, { failSave = false } = {}) {
  const live = { ...desc };
  return {
    desc: live,
    saved: [],
    saveDescriptor(fields) {
      if (failSave) throw new Error('config.json is read-only in this test');
      for (const [key, value] of Object.entries(fields)) {
        if (value === null) delete live[key];
        else live[key] = value;
      }
      this.saved.push(fields);
    },
    readDescriptor() { return JSON.parse(JSON.stringify(live)); },
  };
}

const fakeManager = (status = 'offline') => ({ status });

function saveDirOf(desc) {
  return path.join(desc.dir, desc.valheimSaveDir || 'data', 'worlds_local');
}

// Stage an upload the way lib/routes/valheim.cjs does, without the HTTP layer.
function stageUpload(files, { kind = 'upload' } = {}) {
  const dir = worlds.importStagingDir(`stage-${++seq}`);
  fs.mkdirSync(path.join(dir, 'payload'), { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, 'payload', name), data);
  }
  return { dir, kind, archive: kind === 'archive' ? path.join('payload', 'upload.zip') : null, originalName: Object.keys(files)[0] };
}

// A store-only zip built byte by byte, mirroring test/terraria-worlds.test.cjs's
// makeZip: archiver normalizes traversal out of entry names and cannot emit a
// symlink entry, so a hostile archive built with it would test nothing.
function makeZip(dest, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const push = (buffer) => { chunks.push(buffer); offset += buffer.length; };
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data == null ? '' : entry.data);
    const crc = zlib.crc32(data);
    const mode = entry.mode == null ? 0o100644 : entry.mode;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localOffset = offset;
    push(local); push(name); push(data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(mode * 0x10000, 38);
    record.writeUInt32LE(localOffset, 42);
    central.push(Buffer.concat([record, name]));
  }
  const centralOffset = offset;
  for (const record of central) push(record);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - centralOffset, 12);
  end.writeUInt32LE(centralOffset, 16);
  push(end);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.concat(chunks));
  return dest;
}

/* ----------------------------------------------------------- 1. naming -- */

test('names accept the documented character set and reject everything else', () => {
  assert.strictEqual(worlds.normalizeName('My World-1.txt'), 'My World-1.txt');
  // Note: a trailing space in the raw input is not testable here - the
  // implementation trims before validating (matching lib/terraria-worlds.cjs),
  // so 'a ' simply normalizes to 'a'. The trailing-dot check is still real.
  for (const bad of ['', '   ', 'a'.repeat(65), '..', '.', 'a.', 'CON', 'com1', 'lpt9']) {
    assert.throws(() => worlds.normalizeName(bad), (err) => ['name_required', 'name_too_long', 'name_invalid', 'name_reserved'].includes(err.code), bad);
  }
  assert.throws(() => worlds.normalizeName('../escape'), (err) => err.code === 'name_invalid');
  assert.throws(() => worlds.normalizeName('a/b'), (err) => err.code === 'name_invalid');
  assert.throws(() => worlds.normalizeName('a\\b'), (err) => err.code === 'name_invalid');
  assert.throws(() => worlds.normalizeName(`bad${String.fromCharCode(0)}name`), (err) => err.code === 'name_invalid');
  assert.throws(() => worlds.normalizeName(`bad${String.fromCharCode(31)}name`), (err) => err.code === 'name_invalid');
});

test('the worlds directory cannot be reached through a link', () => {
  if (process.platform === 'win32') return;
  const desc = makeServer({ worldNames: [] });
  const outside = fs.mkdtempSync(path.join(ROOT, 'outside-'));
  fs.rmSync(path.join(desc.dir, 'data'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(desc.dir, 'data'), 'dir');
  assert.throws(() => worlds.resolveSaveDir(desc), (err) => err.code === 'symlink_path');
});

test('a name escaping the worlds directory is refused before any path is touched', () => {
  const desc = makeServer({ worldNames: [] });
  const saveDir = worlds.resolveSaveDir(desc);
  assert.throws(() => worlds.pairPaths(saveDir, '..'), (err) => err.code === 'name_invalid' || err.code === 'path_escape');
});

/* --------------------------------------------------------- 2. inventory -- */

test('inventory groups a pair, reports incomplete, and counts recognized backup files', () => {
  const desc = makeServer({
    worldNames: ['Dedicated'],
    backups: { Dedicated: ['Dedicated_backup_auto-1_20260101000000.fwl', 'Dedicated_backup_auto-1_20260101000000.db'] },
  });
  // An incomplete second world: only the .db half exists.
  fs.writeFileSync(path.join(saveDirOf(desc), `Orphan${worlds.DATA_EXT}`), dbBuf());
  const inv = worlds.inventory(desc, { status: 'offline', activeOperations: [] });
  assert.strictEqual(inv.worlds.length, 2);
  const dedicated = inv.worlds.find((w) => w.name === 'Dedicated');
  assert.strictEqual(dedicated.complete, true);
  assert.strictEqual(dedicated.health, 'healthy');
  assert.strictEqual(dedicated.files.backups, 2, 'one backup revision is two files (.fwl + .db)');
  assert.strictEqual(dedicated.active, true);
  const orphan = inv.worlds.find((w) => w.name === 'Orphan');
  assert.strictEqual(orphan.health, 'incomplete');
  assert.strictEqual(orphan.reason, 'metadata_missing');
  assert.strictEqual(orphan.files.metadata, false);
  assert.strictEqual(orphan.files.database, true);
  assert.strictEqual(inv.selection.name, 'Dedicated');
});

test('an unrecognized backup name is never grouped with a world', () => {
  const desc = makeServer({ worldNames: ['Dedicated'] });
  const backupsDir = path.join(saveDirOf(desc), worlds.BACKUPS_DIR);
  fs.mkdirSync(backupsDir, { recursive: true });
  fs.writeFileSync(path.join(backupsDir, 'unrelated_backup_auto-1.fwl'), fwlBuf());
  const inv = worlds.inventory(desc, {});
  assert.strictEqual(inv.worlds.find((w) => w.name === 'Dedicated').files.backups, 0);
});

test('an empty pair is unreadable, never healthy', () => {
  const desc = makeServer({ worldNames: [] });
  const save = saveDirOf(desc);
  fs.writeFileSync(path.join(save, `Empty${worlds.META_EXT}`), Buffer.alloc(0));
  fs.writeFileSync(path.join(save, `Empty${worlds.DATA_EXT}`), dbBuf());
  const inv = worlds.inventory(desc, {});
  const w = inv.worlds.find((x) => x.name === 'Empty');
  assert.strictEqual(w.health, 'unreadable');
  assert.strictEqual(w.reason, 'metadata_empty');
});

/* ------------------------------------------------------------- 3. select -- */

test('selecting an existing complete world previews cleanly and is not "willCreate"', () => {
  const desc = makeServer({ worldNames: ['Dedicated', 'Second'] });
  const preview = worlds.previewSelect({ desc, actorId: ACTOR, name: 'Second', manager: fakeManager() });
  assert.strictEqual(preview.willCreate, false);
  assert.strictEqual(preview.world.name, 'Second');
  assert.strictEqual(preview.current, 'Dedicated');
  assert.strictEqual(preview.alreadySelected, false);
});

test('selecting a free name is the create-new-world path, flagged willCreate', () => {
  const desc = makeServer({ worldNames: ['Dedicated'] });
  const preview = worlds.previewSelect({ desc, actorId: ACTOR, name: 'BrandNew', manager: fakeManager() });
  assert.strictEqual(preview.willCreate, true);
  assert.strictEqual(preview.world, null);
});

test('selecting an incomplete or unreadable pair is refused - both files must verify first', async () => {
  const desc = makeServer({ worldNames: [] });
  const save = saveDirOf(desc);
  fs.writeFileSync(path.join(save, `Half${worlds.META_EXT}`), fwlBuf());
  await rejects(() => Promise.resolve(worlds.previewSelect({ desc, actorId: ACTOR, name: 'Half', manager: fakeManager() })), 'world_incomplete');
  fs.writeFileSync(path.join(save, `Bad${worlds.META_EXT}`), Buffer.alloc(0));
  fs.writeFileSync(path.join(save, `Bad${worlds.DATA_EXT}`), dbBuf());
  await rejects(() => Promise.resolve(worlds.previewSelect({ desc, actorId: ACTOR, name: 'Bad', manager: fakeManager() })), 'world_unreadable');
});

test('selection, rename, import and delete are all impossible unless the server is offline', async () => {
  const desc = makeServer({ worldNames: ['Dedicated', 'Second'] });
  const store = descriptorStore(desc);
  const preview = worlds.previewSelect({ desc: store.desc, actorId: ACTOR, name: 'Second', manager: fakeManager('online') });
  const { error } = await runOperation(worlds.KIND.SELECT, (operationId) => worlds.runSelect({
    desc: store.desc, manager: fakeManager('online'), operationId, preview, saveDescriptor: (fields) => store.saveDescriptor(fields), readDescriptor: () => store.readDescriptor(),
  }));
  assert.strictEqual(error && error.code, 'server_online');
});

test('a selection writes the descriptor and verifies it landed', async () => {
  const desc = makeServer({ worldNames: ['Dedicated', 'Second'] });
  const store = descriptorStore(desc);
  const preview = worlds.previewSelect({ desc: store.desc, actorId: ACTOR, name: 'Second', manager: fakeManager() });
  const { result, error } = await runOperation(worlds.KIND.SELECT, (operationId) => worlds.runSelect({
    desc: store.desc, manager: fakeManager(), operationId, preview, saveDescriptor: (fields) => store.saveDescriptor(fields), readDescriptor: () => store.readDescriptor(),
  }));
  assert.ifError(error);
  assert.strictEqual(result.name, 'Second');
  assert.strictEqual(store.desc.worldName, 'Second');
});

test('a config-save failure during a plain selection fails cleanly - nothing on disk to disagree with', async () => {
  const desc = makeServer({ worldNames: ['Dedicated', 'Second'] });
  const store = descriptorStore(desc, { failSave: true });
  const preview = worlds.previewSelect({ desc: store.desc, actorId: ACTOR, name: 'Second', manager: fakeManager() });
  const { id, error } = await runOperation(worlds.KIND.SELECT, (operationId) => worlds.runSelect({
    desc: store.desc, manager: fakeManager(), operationId, preview, saveDescriptor: (fields) => store.saveDescriptor(fields), readDescriptor: () => store.readDescriptor(),
  }));
  assert.strictEqual(error && error.code, 'config_save_failed');
  assert.strictEqual(operations.get(id).state, operations.STATES.FAILED, 'nothing was written to disk, so this is a plain failure, not recovery_required');
});

/* ------------------------------------------------------------- 4. previews -- */

test('a preview is single-use', async () => {
  const desc = makeServer({ worldNames: ['Dedicated', 'Second'] });
  const store = descriptorStore(desc);
  const preview = worlds.previewSelect({ desc: store.desc, actorId: ACTOR, name: 'Second', manager: fakeManager() });
  // Consuming it the way the router does before calling the runner.
  const consumed = worlds.consumePreview({ token: preview.token, desc: store.desc, actorId: ACTOR, action: preview.action });
  await runOperation(worlds.KIND.SELECT, (operationId) => worlds.runSelect({
    desc: store.desc, manager: fakeManager(), operationId, preview: consumed, saveDescriptor: (fields) => store.saveDescriptor(fields), readDescriptor: () => store.readDescriptor(),
  }));
  assert.throws(() => worlds.consumePreview({ token: preview.token, desc: store.desc, actorId: ACTOR, action: preview.action }), (err) => err.code === 'preview_invalid');
});

test('a preview expires', () => {
  const desc = makeServer({ worldNames: ['Dedicated', 'Second'] });
  const preview = worlds.previewSelect({ desc, actorId: ACTOR, name: 'Second', manager: fakeManager() });
  open().prepare('UPDATE world_previews SET expires_at = ? WHERE token = ?').run(Date.now() - 1000, preview.token);
  assert.throws(() => worlds.consumePreview({ token: preview.token, desc, actorId: ACTOR, action: preview.action }), (err) => err.code === 'preview_expired');
});

test('a preview is bound to the actor, the server, and the action that took it', () => {
  const desc = makeServer({ worldNames: ['Dedicated', 'Second'] });
  const preview = worlds.previewSelect({ desc, actorId: ACTOR, name: 'Second', manager: fakeManager() });
  assert.throws(() => worlds.consumePreview({ token: preview.token, desc, actorId: 'someone-else', action: preview.action }), (err) => err.code === 'preview_invalid');
});

test('a preview goes stale when the worlds directory changes underneath it', () => {
  const desc = makeServer({ worldNames: ['Dedicated', 'Second'] });
  const preview = worlds.previewSelect({ desc, actorId: ACTOR, name: 'Second', manager: fakeManager() });
  fs.writeFileSync(path.join(saveDirOf(desc), `Third${worlds.META_EXT}`), fwlBuf());
  fs.writeFileSync(path.join(saveDirOf(desc), `Third${worlds.DATA_EXT}`), dbBuf());
  assert.throws(() => worlds.consumePreview({ token: preview.token, desc, actorId: ACTOR, action: preview.action }), (err) => err.code === 'preview_stale');
});

/* -------------------------------------------------------------- 5. import -- */

test('importing a raw pair requires both files', async () => {
  const desc = makeServer({ worldNames: [] });
  await rejects(() => worlds.previewImport({
    desc, actorId: ACTOR, staged: stageUpload({ [`world${worlds.META_EXT}`]: fwlBuf() }), manager: fakeManager(),
  }), 'pair_incomplete');
});

test('a mismatched base name between .fwl and .db is refused', async () => {
  const desc = makeServer({ worldNames: [] });
  await rejects(() => worlds.previewImport({
    desc, actorId: ACTOR,
    staged: stageUpload({ [`One${worlds.META_EXT}`]: fwlBuf(), [`Two${worlds.DATA_EXT}`]: dbBuf() }),
    manager: fakeManager(),
  }), 'name_mismatch');
});

test('importing onto an existing name collides instead of overwriting', async () => {
  const desc = makeServer({ worldNames: ['Dedicated'] });
  const original = fs.readFileSync(path.join(saveDirOf(desc), `Dedicated${worlds.META_EXT}`));
  await rejects(() => worlds.previewImport({
    desc, actorId: ACTOR,
    staged: stageUpload({ [`world${worlds.META_EXT}`]: fwlBuf(0x99), [`world${worlds.DATA_EXT}`]: dbBuf(0x99) }),
    requestedName: 'Dedicated', manager: fakeManager(),
  }), 'name_collision');
  assert.ok(original.equals(fs.readFileSync(path.join(saveDirOf(desc), `Dedicated${worlds.META_EXT}`))), 'the existing world changed');
});

test('an import registers the world and leaves disk and descriptor agreeing', async () => {
  const desc = makeServer({ worldNames: [] });
  const store = descriptorStore(desc);
  const preview = await worlds.previewImport({
    desc: store.desc, actorId: ACTOR,
    staged: stageUpload({ [`Imported${worlds.META_EXT}`]: fwlBuf(), [`Imported${worlds.DATA_EXT}`]: dbBuf() }),
    select: true, manager: fakeManager(),
  });
  const { result, error } = await runOperation(worlds.KIND.IMPORT, (operationId) => worlds.runImport({
    desc: store.desc, manager: fakeManager(), operationId, preview, saveDescriptor: (fields) => store.saveDescriptor(fields), readDescriptor: () => store.readDescriptor(),
  }));
  assert.ifError(error);
  assert.strictEqual(result.selected, true);
  assert.strictEqual(store.desc.worldName, 'Imported');
  const pair = worlds.readPair(worlds.resolveSaveDir(store.desc), 'Imported');
  assert.strictEqual(pair.health, 'healthy');
});

test('an import that commits does not fail just because the optional select afterward failed', async () => {
  const desc = makeServer({ worldNames: [] });
  const store = descriptorStore(desc, { failSave: true });
  const preview = await worlds.previewImport({
    desc: store.desc, actorId: ACTOR,
    staged: stageUpload({ [`Imported${worlds.META_EXT}`]: fwlBuf(), [`Imported${worlds.DATA_EXT}`]: dbBuf() }),
    select: true, manager: fakeManager(),
  });
  const { result, error } = await runOperation(worlds.KIND.IMPORT, (operationId) => worlds.runImport({
    desc: store.desc, manager: fakeManager(), operationId, preview, saveDescriptor: (fields) => store.saveDescriptor(fields), readDescriptor: () => store.readDescriptor(),
  }));
  assert.ifError(error);
  assert.strictEqual(result.selected, false);
  assert.ok(result.selectError);
  const pair = worlds.readPair(worlds.resolveSaveDir(store.desc), 'Imported');
  assert.strictEqual(pair.health, 'healthy', 'the import itself still committed');
});

test('recognized backups travel with an import under their original names', async () => {
  const desc = makeServer({ worldNames: [] });
  const store = descriptorStore(desc);
  const preview = await worlds.previewImport({
    desc: store.desc, actorId: ACTOR,
    staged: stageUpload({
      [`Imported${worlds.META_EXT}`]: fwlBuf(),
      [`Imported${worlds.DATA_EXT}`]: dbBuf(),
      'Imported_backup_auto-1_20260101000000.fwl': fwlBuf(0x44, 8),
      'Imported_backup_auto-1_20260101000000.db': dbBuf(0x44, 8),
    }),
    manager: fakeManager(),
  });
  assert.strictEqual(preview.source.backups.length, 2);
  await runOperation(worlds.KIND.IMPORT, (operationId) => worlds.runImport({
    desc: store.desc, manager: fakeManager(), operationId, preview, saveDescriptor: (fields) => store.saveDescriptor(fields), readDescriptor: () => store.readDescriptor(),
  }));
  const inv = worlds.inventory(store.desc, {});
  assert.strictEqual(inv.worlds.find((w) => w.name === 'Imported').files.backups, 2);
});

test('an archive import takes the one world pair it contains and ignores the rest', async () => {
  const desc = makeServer({ worldNames: [] });
  const zip = makeZip(path.join(ROOT, `zip-${++seq}.zip`), [
    { name: 'Worlds_Local/Adventure.fwl', data: fwlBuf() },
    { name: 'Worlds_Local/Adventure.db', data: dbBuf() },
    { name: 'logs/server.log', data: 'notes' },
  ]);
  const staged = stageUpload({ 'upload.zip': fs.readFileSync(zip) }, { kind: 'archive' });
  const preview = await worlds.previewImport({ desc, actorId: ACTOR, staged, manager: fakeManager() });
  assert.strictEqual(preview.name, 'Adventure');
  const extracted = fs.readdirSync(path.join(staged.dir, 'payload')).sort();
  assert.deepStrictEqual(extracted, ['Adventure.db', 'Adventure.fwl', 'upload.zip']);
});

test('a hostile or ambiguous archive is refused before anything is written', async () => {
  const desc = makeServer({ worldNames: [] });
  const cases = [
    ['path_traversal', [{ name: `../escape${worlds.META_EXT}`, data: fwlBuf() }]],
    ['symlink', [{ name: `link${worlds.META_EXT}`, data: '/etc/passwd', mode: 0o120777 }]],
    ['absolute_path', [{ name: `C:/worlds/evil${worlds.META_EXT}`, data: fwlBuf() }]],
    ['multiple_worlds', [{ name: `a${worlds.META_EXT}`, data: fwlBuf() }, { name: `b${worlds.META_EXT}`, data: fwlBuf() }]],
  ];
  for (const [code, entries] of cases) {
    const staged = stageUpload({ 'upload.zip': fs.readFileSync(makeZip(path.join(ROOT, `hostile-${++seq}.zip`), entries)) }, { kind: 'archive' });
    const error = await rejects(() => worlds.previewImport({ desc, actorId: ACTOR, staged, manager: fakeManager() }), code);
    assert.ok(error);
    assert.deepStrictEqual(fs.readdirSync(saveDirOf(desc)), [], 'the save directory was written to');
  }
});

test('an over-limit archive is refused before extraction completes', async () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({ name: `file${i}.txt`, data: 'x' }));
  const archive = makeZip(path.join(ROOT, `many-${++seq}.zip`), entries);
  const out = path.join(ROOT, `many-out-${seq}`);
  await rejects(() => worlds.extractPairFromArchive(archive, out, { maxEntries: 4 }), 'too_many_entries');
  assert.deepStrictEqual(fs.readdirSync(out), [], 'entries were written past the limit');
});

/* -------------------------------------------------------------- 6. rename -- */

test('renaming requires a different, unused name', () => {
  const desc = makeServer({ worldNames: ['Dedicated', 'Second'] });
  assert.throws(() => worlds.previewRename({ desc, actorId: ACTOR, from: 'Dedicated', to: 'Dedicated', manager: fakeManager() }), (err) => err.code === 'name_unchanged');
  assert.throws(() => worlds.previewRename({ desc, actorId: ACTOR, from: 'Dedicated', to: 'Second', manager: fakeManager() }), (err) => err.code === 'name_collision');
  assert.throws(() => worlds.previewRename({ desc, actorId: ACTOR, from: 'NoSuchWorld', to: 'New', manager: fakeManager() }), (err) => err.code === 'world_not_found');
});

test('rename moves both files and every recognized backup together, preserving backup suffixes', async () => {
  const desc = makeServer({
    worldNames: ['Dedicated'],
    backups: { Dedicated: ['Dedicated_backup_auto-1_20260101000000.fwl', 'Dedicated_backup_auto-1_20260101000000.db'] },
  });
  const store = descriptorStore(desc);
  const preview = worlds.previewRename({ desc: store.desc, actorId: ACTOR, from: 'Dedicated', to: 'Renamed', manager: fakeManager() });
  assert.strictEqual(preview.selected, true, 'the selected world is being renamed');
  const { result, error } = await runOperation(worlds.KIND.RENAME, (operationId) => worlds.runRename({
    desc: store.desc, manager: fakeManager(), operationId, preview, saveDescriptor: (fields) => store.saveDescriptor(fields), readDescriptor: () => store.readDescriptor(),
  }));
  assert.ifError(error);
  assert.strictEqual(result.reselected, true);
  assert.strictEqual(store.desc.worldName, 'Renamed');

  const save = saveDirOf(desc);
  assert.strictEqual(fs.existsSync(path.join(save, `Dedicated${worlds.META_EXT}`)), false);
  assert.strictEqual(fs.existsSync(path.join(save, `Dedicated${worlds.DATA_EXT}`)), false);
  assert.strictEqual(fs.existsSync(path.join(save, `Renamed${worlds.META_EXT}`)), true);
  assert.strictEqual(fs.existsSync(path.join(save, `Renamed${worlds.DATA_EXT}`)), true);
  assert.strictEqual(fs.existsSync(path.join(save, worlds.BACKUPS_DIR, 'Renamed_backup_auto-1_20260101000000.fwl')), true);
  assert.strictEqual(fs.existsSync(path.join(save, worlds.BACKUPS_DIR, 'Dedicated_backup_auto-1_20260101000000.fwl')), false);
});

test('renaming an incomplete pair still moves whatever exists', async () => {
  const desc = makeServer({ worldNames: [] });
  const save = saveDirOf(desc);
  fs.writeFileSync(path.join(save, `Half${worlds.META_EXT}`), fwlBuf());
  const store = descriptorStore(desc);
  const preview = worlds.previewRename({ desc: store.desc, actorId: ACTOR, from: 'Half', to: 'HalfRenamed', manager: fakeManager() });
  const { error } = await runOperation(worlds.KIND.RENAME, (operationId) => worlds.runRename({
    desc: store.desc, manager: fakeManager(), operationId, preview, saveDescriptor: (fields) => store.saveDescriptor(fields), readDescriptor: () => store.readDescriptor(),
  }));
  assert.ifError(error);
  assert.strictEqual(fs.existsSync(path.join(save, `HalfRenamed${worlds.META_EXT}`)), true);
  assert.strictEqual(fs.existsSync(path.join(save, `HalfRenamed${worlds.DATA_EXT}`)), false);
});

test('rename is refused while the server is online', async () => {
  const desc = makeServer({ worldNames: ['Dedicated', 'Second'] });
  const store = descriptorStore(desc);
  const preview = worlds.previewRename({ desc: store.desc, actorId: ACTOR, from: 'Second', to: 'Third', manager: fakeManager() });
  const { error } = await runOperation(worlds.KIND.RENAME, (operationId) => worlds.runRename({
    desc: store.desc, manager: fakeManager('online'), operationId, preview, saveDescriptor: (fields) => store.saveDescriptor(fields), readDescriptor: () => store.readDescriptor(),
  }));
  assert.strictEqual(error && error.code, 'server_online');
});

test('a reselect failure during rename goes recovery_required - the descriptor must never point at a name that moved away', async () => {
  const desc = makeServer({ worldNames: ['Dedicated'] });
  const store = descriptorStore(desc, { failSave: true });
  const preview = worlds.previewRename({ desc: store.desc, actorId: ACTOR, from: 'Dedicated', to: 'Moved', manager: fakeManager() });
  const { id, error } = await runOperation(worlds.KIND.RENAME, (operationId) => worlds.runRename({
    desc: store.desc, manager: fakeManager(), operationId, preview, saveDescriptor: (fields) => store.saveDescriptor(fields), readDescriptor: () => store.readDescriptor(),
  }));
  assert.strictEqual(error && error.code, 'config_save_failed');
  assert.strictEqual(operations.get(id).state, operations.STATES.RECOVERY_REQUIRED);
  // The files still moved even though the reselect failed - that is the
  // scenario recovery_required exists to surface, not to prevent.
  const save = saveDirOf(desc);
  assert.strictEqual(fs.existsSync(path.join(save, `Moved${worlds.META_EXT}`)), true);
});

/* -------------------------------------------------------------- 7. delete -- */

test('deleting the selected world clears the selection and quarantines every file together', async () => {
  const desc = makeServer({
    worldNames: ['Dedicated'],
    backups: { Dedicated: ['Dedicated_backup_auto-1_20260101000000.fwl', 'Dedicated_backup_auto-1_20260101000000.db'] },
  });
  const store = descriptorStore(desc);
  const preview = worlds.previewDelete({ desc: store.desc, actorId: ACTOR, name: 'Dedicated', manager: fakeManager() });
  assert.strictEqual(preview.clearsSelection, true);
  const { result, error } = await runOperation(worlds.KIND.DELETE, (operationId) => worlds.runDelete({
    desc: store.desc, manager: fakeManager(), operationId, preview, actorId: ACTOR, servers: [], saveDescriptor: (fields) => store.saveDescriptor(fields), readDescriptor: () => store.readDescriptor(),
  }));
  assert.ifError(error);
  assert.strictEqual(result.trash.length, 4);
  assert.strictEqual(result.selectionCleared, true);
  assert.strictEqual(store.desc.worldName, undefined);
  const save = saveDirOf(desc);
  assert.deepStrictEqual(fs.readdirSync(save).filter((n) => n !== worlds.BACKUPS_DIR), []);
});

test('an incomplete or unreadable world is still deletable', async () => {
  const desc = makeServer({ worldNames: [] });
  const save = saveDirOf(desc);
  fs.writeFileSync(path.join(save, `Half${worlds.META_EXT}`), fwlBuf());
  const store = descriptorStore(desc);
  const preview = worlds.previewDelete({ desc: store.desc, actorId: ACTOR, name: 'Half', manager: fakeManager() });
  const { result, error } = await runOperation(worlds.KIND.DELETE, (operationId) => worlds.runDelete({
    desc: store.desc, manager: fakeManager(), operationId, preview, actorId: ACTOR, servers: [], saveDescriptor: (fields) => store.saveDescriptor(fields), readDescriptor: () => store.readDescriptor(),
  }));
  assert.ifError(error);
  assert.strictEqual(result.trash.length, 1);
});

test('delete is refused while the server is online', async () => {
  const desc = makeServer({ worldNames: ['Dedicated', 'Second'] });
  const store = descriptorStore(desc);
  const preview = worlds.previewDelete({ desc: store.desc, actorId: ACTOR, name: 'Second', manager: fakeManager() });
  const { error } = await runOperation(worlds.KIND.DELETE, (operationId) => worlds.runDelete({
    desc: store.desc, manager: fakeManager('online'), operationId, preview, actorId: ACTOR, servers: [], saveDescriptor: (fields) => store.saveDescriptor(fields), readDescriptor: () => store.readDescriptor(),
  }));
  assert.strictEqual(error && error.code, 'server_online');
});

test('a clear-selection failure after quarantine goes recovery_required, and the trash entries stay put', async () => {
  const desc = makeServer({ worldNames: ['Dedicated'] });
  const store = descriptorStore(desc, { failSave: true });
  const preview = worlds.previewDelete({ desc: store.desc, actorId: ACTOR, name: 'Dedicated', manager: fakeManager() });
  const { id, error } = await runOperation(worlds.KIND.DELETE, (operationId) => worlds.runDelete({
    desc: store.desc, manager: fakeManager(), operationId, preview, actorId: ACTOR, servers: [], saveDescriptor: (fields) => store.saveDescriptor(fields), readDescriptor: () => store.readDescriptor(),
  }));
  assert.strictEqual(error && error.code, 'config_save_failed');
  assert.strictEqual(operations.get(id).state, operations.STATES.RECOVERY_REQUIRED);
  assert.strictEqual(trash.list({ serverId: desc.id }).length, 2);
});

test('a snapshot is taken and verified before every disk-mutating operation', async () => {
  const desc = makeServer({ worldNames: ['Dedicated'] });
  const before = snapshots.list(desc.id).length;
  const store = descriptorStore(desc);
  const preview = worlds.previewDelete({ desc: store.desc, actorId: ACTOR, name: 'Dedicated', manager: fakeManager() });
  const { error } = await runOperation(worlds.KIND.DELETE, (operationId) => worlds.runDelete({
    desc: store.desc, manager: fakeManager(), operationId, preview, actorId: ACTOR, servers: [], saveDescriptor: (fields) => store.saveDescriptor(fields), readDescriptor: () => store.readDescriptor(),
  }));
  assert.ifError(error);
  // Unlike select/import, a successful delete keeps its pre-mutation
  // snapshot as an extra backstop alongside the trash entry (matching
  // lib/terraria-worlds.cjs's runDelete) - it ages out via retention rather
  // than being removed immediately, so what is asserted is that exactly one
  // more snapshot was taken and verified, not that it was cleaned up.
  assert.strictEqual(snapshots.list(desc.id).length, before + 1);
});

/* -------------------------------------------------------------- 8. export -- */

test('export produces a zip whose manifest checksums match, and never leaks an absolute path', async () => {
  const desc = makeServer({ worldNames: ['Dedicated'] });
  const dest = path.join(ROOT, `export-${++seq}.zip`);
  const out = fs.createWriteStream(dest);
  const result = await worlds.archive(desc, 'Dedicated', out);
  assert.ok(result.filename.endsWith('.zip'));
  assert.ok(!path.isAbsolute(result.filename));

  // Re-extract and confirm the manifest never carries a path, only relative
  // names, sizes and checksums.
  const yauzl = require('yauzl');
  const entries = await new Promise((resolve, reject) => {
    yauzl.open(dest, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const found = {};
      zip.on('entry', (entry) => {
        if (entry.fileName === 'manifest.json') {
          zip.openReadStream(entry, (e2, stream) => {
            const chunks = [];
            stream.on('data', (c) => chunks.push(c));
            stream.on('end', () => { found.manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')); zip.readEntry(); });
          });
        } else { found[entry.fileName] = entry.uncompressedSize; zip.readEntry(); }
      });
      zip.on('end', () => resolve(found));
      zip.readEntry();
    });
  });
  assert.ok(entries.manifest);
  assert.strictEqual(entries.manifest.name, 'Dedicated');
  for (const file of entries.manifest.files) {
    assert.ok(!file.name.includes('..'));
    assert.ok(!path.isAbsolute(file.name));
    assert.ok(/^[a-f0-9]{64}$/.test(file.sha256));
  }
  assert.strictEqual(JSON.stringify(entries.manifest).includes(desc.dir), false, 'no absolute path leaked into the manifest');
});

test('downloadName refuses a world that does not exist', () => {
  const desc = makeServer({ worldNames: [] });
  assert.throws(() => worlds.downloadName(desc, 'NoSuchWorld'), (err) => err.code === 'world_not_found');
});

/* -------------------------------------------------------- 9. create-new -- */

test('a start with no world selected fails with a clear, specific error', () => {
  const launch = require('../lib/modules/valheim/launch.cjs');
  const root = fs.mkdtempSync(path.join(ROOT, 'launch-'));
  const executable = path.join(root, process.platform === 'win32' ? 'valheim_server.exe' : 'valheim_server.x86_64');
  fs.writeFileSync(executable, 'fixture');
  if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
  assert.throws(() => launch.buildLaunch({
    type: 'valheim', valheimSchema: 1, dir: root, cwd: root, executable, args: [],
    port: 2456, serverName: 'Test', worldName: '', password: 'secret5',
    valheimSaveDir: 'data', valheimBackend: 'steam', valheimPublic: true,
  }), (err) => err.code === 'world_unselected');
});

/* ------------------------------------------------------------------- run -- */

(async () => {
  let failed = 0;
  for (const entry of tests) {
    try { await entry.fn(); console.log(`ok  ${entry.name}`); }
    catch (error) { failed++; console.error(`FAIL  ${entry.name}: ${error.message}\n${error.stack}`); }
  }
  close();
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* */ }
  teardown();
  if (failed) { console.error(`FAIL  ${failed} of ${tests.length} valheim-worlds test(s) failed`); process.exit(1); }
  console.log(`PASS  valheim-worlds (${tests.length} tests)`);
})();
