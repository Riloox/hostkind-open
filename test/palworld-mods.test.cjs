'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { setupDataDir, teardown, TMP_ROOT } = require('./_setup.cjs');
setupDataDir();

const migrations = require('../lib/migrations.cjs');
const mods = require('../lib/palworld-mods.cjs');
const platform = require('../lib/palworld-platform.cjs');

migrations.runMigrations();

function zip(file, entries) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    const archive = archiver('zip', { zlib: { level: 1 } });
    out.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(out);
    for (const [name, content] of Object.entries(entries)) archive.append(Buffer.from(content), { name });
    archive.finalize();
  });
}

/*
 * Previews take the host as an argument, but committing reads the real one and
 * refuses a target this machine cannot run. Tests that commit therefore
 * describe a server native to whatever host they run on; the ones below that
 * pin a specific target are asserting the platform rules themselves.
 */
const NATIVE_HOST = process.platform === 'win32' ? 'windows' : 'linux';
const NATIVE_EXECUTABLE = NATIVE_HOST === 'windows' ? 'PalServer.exe' : 'PalServer.sh';

function makeServer(name, executable) {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(path.join(dir, 'Pal', 'Content', 'Paks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Pal', 'Binaries', 'Win64'), { recursive: true });
  return { id: name, dir, executable: path.join(dir, executable), type: 'palworld' };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --- platform model -------------------------------------------------------

test('target platform is read from the executable, not the host', () => {
  assert.strictEqual(platform.targetPlatform({ executable: '/srv/pal/PalServer.exe' }), 'windows');
  assert.strictEqual(platform.targetPlatform({ executable: '/srv/pal/PalServer.sh' }), 'linux');
  assert.strictEqual(platform.targetPlatform({ executable: '' }), 'unknown');
});

test('host/target/wine combinations are explained, never guessed', () => {
  const win = { executable: 'C:/pal/PalServer.exe' };
  const lin = { executable: '/srv/pal/PalServer.sh' };
  assert.strictEqual(platform.compatibility({ server: win, host: 'windows' }).supported, true);
  assert.strictEqual(platform.compatibility({ server: lin, host: 'linux' }).supported, true);

  const noWine = platform.compatibility({ server: win, host: 'linux' });
  assert.strictEqual(noWine.supported, false);
  assert.strictEqual(noWine.reason, 'wine_not_configured');

  const undetected = platform.compatibility({
    server: win, host: 'linux',
    wine: { enabled: true, executable: '/usr/bin/wine' },
    wineDetection: { available: false },
  });
  assert.strictEqual(undetected.reason, 'wine_not_detected');

  const detected = platform.compatibility({
    server: win, host: 'linux',
    wine: { enabled: true, executable: '/usr/bin/wine' },
    wineDetection: { available: true, version: 'wine-9.0' },
  });
  assert.strictEqual(detected.supported, true);
  assert.strictEqual(detected.runtime, 'wine');

  const backwards = platform.compatibility({ server: lin, host: 'windows' });
  assert.strictEqual(backwards.supported, false);
  assert.strictEqual(backwards.reason, 'no_runtime');
  assert.strictEqual(platform.compatibility({ server: {}, host: 'linux' }).reason, 'unknown_target');
});

test('wine settings are validated and their environment values stay private', () => {
  const safe = platform.safeWine({
    enabled: true,
    executable: '/usr/bin/wine; rm -rf /',
    prefix: 'relative/prefix',
    args: ['--foo', 'bad\u0000arg'],
    env: { WINEDEBUG: '-all', 'bad name': 'x', WINE_TOKEN: 'secret' },
  });
  assert.strictEqual(safe.executable, null);
  assert.strictEqual(safe.enabled, false, 'wine cannot be enabled without a usable executable');
  assert.strictEqual(safe.prefix, null);
  assert.deepStrictEqual(safe.args, ['--foo']);
  assert.deepStrictEqual(Object.keys(safe.env), ['WINEDEBUG', 'WINE_TOKEN']);
  assert.ok(safe.issues.length >= 3);

  const shown = platform.publicWine({ enabled: true, executable: '/usr/bin/wine', env: { WINE_TOKEN: 'secret' } });
  assert.deepStrictEqual(shown.envKeys, ['WINE_TOKEN']);
  assert.ok(!JSON.stringify(shown).includes('secret'));
});

test('a windows target on a linux host launches through wine, directly spawned', () => {
  const plan = platform.launchPlan({
    executable: '/srv/pal/PalServer.exe',
    args: ['-port=8211'],
    host: 'linux',
    target: 'windows',
    wine: { enabled: true, executable: '/usr/bin/wine', prefix: '/srv/prefix', args: ['--no-sandbox'], env: { WINEDEBUG: '-all' } },
  });
  assert.strictEqual(plan.bin, '/usr/bin/wine');
  assert.deepStrictEqual(plan.args, ['--no-sandbox', '/srv/pal/PalServer.exe', '-port=8211']);
  assert.strictEqual(plan.env.WINEPREFIX, '/srv/prefix');
  assert.strictEqual(plan.runtime, 'wine');

  const native = platform.launchPlan({ executable: '/srv/pal/PalServer.sh', host: 'linux', target: 'linux', wine: { enabled: true, executable: '/usr/bin/wine' } });
  assert.strictEqual(native.bin, '/srv/pal/PalServer.sh');
  assert.strictEqual(native.env, null);
});

// --- archive validation and classification --------------------------------

test('layout classification places packages and rejects everything else', () => {
  const pak = mods.classify([{ path: 'CoolMod/CoolMod.pak', bytes: 10 }, { path: 'CoolMod/readme.txt', bytes: 2 }]);
  assert.strictEqual(pak.kind, 'pak');
  assert.strictEqual(pak.strip, 'CoolMod');
  assert.deepStrictEqual(pak.files.map((f) => f.path), ['CoolMod.pak', 'readme.txt']);

  const lua = mods.classify([{ path: 'Scripts/main.lua', bytes: 4 }]);
  assert.strictEqual(lua.kind, 'ue4ss-lua');
  assert.strictEqual(lua.framework, 'ue4ss');

  assert.throws(() => mods.classify([{ path: 'Mod/install.exe', bytes: 4 }, { path: 'Mod/a.pak', bytes: 4 }]), /executable content/i);
  assert.throws(() => mods.classify([{ path: 'Mod/setup.dll', bytes: 4 }]), /executable content/i);
  assert.throws(() => mods.classify([{ path: 'Mod/notes.txt', bytes: 4 }]), /supported Palworld mod/i);
  assert.throws(() => mods.classify([{ path: 'Mod/a.pak', bytes: 4 }, { path: 'Mod/data.sql', bytes: 4 }]), /does not allow/i);
  assert.throws(() => mods.classify([]), /no files/i);
});

test('the shared guard rejects duplicate entries in an uploaded archive', async () => {
  const file = path.join(TMP_ROOT, 'dupe.zip');
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    const archive = archiver('zip', { zlib: { level: 1 } });
    out.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(out);
    archive.append(Buffer.from('a'), { name: 'Mod/a.pak' });
    archive.append(Buffer.from('b'), { name: 'Mod/a.pak' });
    archive.finalize();
  });
  await assert.rejects(() => mods.scanArchive(file), (error) => error.code === 'duplicate_entry');
});

// --- lifecycle ------------------------------------------------------------

test('import previews, stages, verifies and commits a package', async () => {
  const server = makeServer('pal-import', NATIVE_EXECUTABLE);
  const manager = { status: 'offline', id: server.id, start: () => ({ ok: true }) };
  const archive = path.join(TMP_ROOT, 'coolmod.zip');
  await zip(archive, { 'CoolMod/CoolMod.pak': 'pak-bytes', 'CoolMod/readme.txt': 'hello' });

  const preview = await mods.previewImport({
    server, manager, actorId: 'user-1', archivePath: archive, fileName: 'coolmod.zip', host: NATIVE_HOST,
  });
  assert.strictEqual(preview.plan.kind, 'pak');
  assert.strictEqual(preview.plan.mode, 'install');
  assert.strictEqual(preview.plan.installPath, 'Pal/Content/Paks/~mods/CoolMod');
  assert.deepStrictEqual(preview.plan.overwrite, []);
  assert.ok(preview.plan.diskEstimateBytes > 0);
  assert.ok(preview.plan.restartRequired);

  await assert.rejects(() => mods.applyImport({
    server, manager, actorId: 'user-1', idempotencyKey: 'k1', previewToken: preview.previewToken, revision: 'wrong',
  }), (error) => error.code === 'stale_preview');

  const applied = await mods.applyImport({
    server, manager, actorId: 'user-1', idempotencyKey: 'k1',
    previewToken: preview.previewToken, revision: preview.revision,
  });
  const op = await applied.completed;
  assert.strictEqual(op.state, 'succeeded', op.errorText || '');
  assert.ok(fs.existsSync(path.join(server.dir, 'Pal', 'Content', 'Paks', '~mods', 'CoolMod', 'CoolMod.pak')));

  const listed = await mods.inventory({ server, host: NATIVE_HOST, verify: true });
  assert.strictEqual(listed.packages.length, 1);
  assert.strictEqual(listed.packages[0].enabled, true);
  assert.strictEqual(listed.packages[0].integrity.ok, true);
  assert.strictEqual(listed.unmanaged.length, 0);
  return { server, manager, packageId: listed.packages[0].id };
});

test('disable parks and enable restores, without deleting anything', async () => {
  const server = makeServer('pal-park', NATIVE_EXECUTABLE);
  const manager = { status: 'offline', id: server.id };
  const archive = path.join(TMP_ROOT, 'parkmod.zip');
  await zip(archive, { 'ParkMod/ParkMod.pak': 'x' });
  const preview = await mods.previewImport({ server, manager, actorId: 'u', archivePath: archive, fileName: 'parkmod.zip', host: NATIVE_HOST });
  const applied = await mods.applyImport({ server, manager, actorId: 'u', idempotencyKey: 'park-1', previewToken: preview.previewToken, revision: preview.revision });
  assert.strictEqual((await applied.completed).state, 'succeeded');
  const id = mods.readInventory(server).packages[0].id;
  const live = path.join(server.dir, 'Pal', 'Content', 'Paks', '~mods', 'ParkMod');

  const disabled = mods.setEnabled({ server, manager, packageId: id, enabled: false });
  assert.strictEqual(disabled.package.enabled, false);
  assert.strictEqual(fs.existsSync(live), false);
  assert.ok(fs.existsSync(path.join(mods.parkedDir(server, id), 'ParkMod.pak')), 'parked copy is kept');

  const enabled = mods.setEnabled({ server, manager, packageId: id, enabled: true });
  assert.strictEqual(enabled.package.enabled, true);
  assert.ok(fs.existsSync(path.join(live, 'ParkMod.pak')));

  assert.throws(() => mods.setEnabled({ server, manager: { status: 'online' }, packageId: id, enabled: false }), (error) => error.code === 'server_online');
});

test('removal is recoverable through trash and a verified snapshot', async () => {
  const server = makeServer('pal-remove', NATIVE_EXECUTABLE);
  const manager = { status: 'offline', id: server.id };
  const archive = path.join(TMP_ROOT, 'gonemod.zip');
  await zip(archive, { 'GoneMod/GoneMod.pak': 'bytes' });
  const preview = await mods.previewImport({ server, manager, actorId: 'u', archivePath: archive, fileName: 'gonemod.zip', host: NATIVE_HOST });
  assert.strictEqual((await (await mods.applyImport({ server, manager, actorId: 'u', idempotencyKey: 'rm-1', previewToken: preview.previewToken, revision: preview.revision })).completed).state, 'succeeded');
  const id = mods.readInventory(server).packages[0].id;

  const removed = mods.remove({ server, manager, packageId: id });
  assert.ok(removed.trashId);
  assert.ok(removed.snapshotId);
  assert.strictEqual(fs.existsSync(path.join(server.dir, 'Pal', 'Content', 'Paks', '~mods', 'GoneMod')), false);
  assert.strictEqual(mods.readInventory(server).packages.length, 0);

  const trash = mods.listTrash(server);
  assert.strictEqual(trash.length, 1);
  assert.strictEqual(trash[0].restorable, true);

  const restored = mods.restoreTrash({ server, manager, trashId: removed.trashId });
  assert.strictEqual(restored.package.name, 'GoneMod');
  assert.ok(fs.existsSync(path.join(server.dir, 'Pal', 'Content', 'Paks', '~mods', 'GoneMod', 'GoneMod.pak')));
  assert.strictEqual(mods.listTrash(server).length, 0);
});

test('an update re-imports over the package and keeps the previous version', async () => {
  const server = makeServer('pal-update', NATIVE_EXECUTABLE);
  const manager = { status: 'offline', id: server.id };
  const first = path.join(TMP_ROOT, 'up-1.zip');
  const second = path.join(TMP_ROOT, 'up-2.zip');
  await zip(first, { 'UpMod/UpMod.pak': 'v1' });
  await zip(second, { 'UpMod/UpMod.pak': 'v2-longer' });

  const p1 = await mods.previewImport({ server, manager, actorId: 'u', archivePath: first, fileName: 'up-1.zip', host: NATIVE_HOST });
  assert.strictEqual((await (await mods.applyImport({ server, manager, actorId: 'u', idempotencyKey: 'up-1', previewToken: p1.previewToken, revision: p1.revision })).completed).state, 'succeeded');

  const p2 = await mods.previewImport({ server, manager, actorId: 'u', archivePath: second, fileName: 'up-2.zip', host: NATIVE_HOST });
  assert.strictEqual(p2.plan.mode, 'update');
  assert.deepStrictEqual(p2.plan.overwrite, ['Pal/Content/Paks/~mods/UpMod/UpMod.pak']);
  assert.ok(p2.plan.replaces);
  assert.strictEqual((await (await mods.applyImport({ server, manager, actorId: 'u', idempotencyKey: 'up-2', previewToken: p2.previewToken, revision: p2.revision })).completed).state, 'succeeded');

  assert.strictEqual(fs.readFileSync(path.join(server.dir, 'Pal', 'Content', 'Paks', '~mods', 'UpMod', 'UpMod.pak'), 'utf8'), 'v2-longer');
  assert.strictEqual(mods.readInventory(server).packages.length, 1);
  assert.strictEqual(mods.listTrash(server).length, 1, 'the replaced version stays recoverable');
});

test('a windows-only package is refused on a linux-target server', async () => {
  const server = makeServer('pal-target', 'PalServer.sh');
  const archive = path.join(TMP_ROOT, 'luamod.zip');
  await zip(archive, { 'LuaMod/Scripts/main.lua': 'print("hi")' });
  await assert.rejects(
    () => mods.previewImport({ server, manager: { status: 'offline' }, actorId: 'u', archivePath: archive, fileName: 'luamod.zip', host: 'linux' }),
    (error) => error.code === 'target_unsupported',
  );
});

test('a lua package needs its framework present on a windows-target server', async () => {
  const server = makeServer('pal-framework', 'PalServer.exe');
  const archive = path.join(TMP_ROOT, 'luamod2.zip');
  await zip(archive, { 'LuaMod/Scripts/main.lua': 'print("hi")' });
  await assert.rejects(
    () => mods.previewImport({ server, manager: { status: 'offline' }, actorId: 'u', archivePath: archive, fileName: 'luamod2.zip', host: 'windows' }),
    (error) => error.code === 'framework_missing',
  );

  fs.writeFileSync(path.join(server.dir, 'Pal', 'Binaries', 'Win64', 'UE4SS.dll'), 'stub');
  const detected = mods.detectFrameworks(server).find((item) => item.id === 'ue4ss');
  assert.strictEqual(detected.detected, true);
  assert.strictEqual(detected.managed, false, 'frameworks are detected, never installed by Hostkind');

  const preview = await mods.previewImport({ server, manager: { status: 'offline' }, actorId: 'u', archivePath: archive, fileName: 'luamod2.zip', host: 'windows' });
  assert.strictEqual(preview.plan.kind, 'ue4ss-lua');
  assert.strictEqual(preview.plan.installPath, 'Pal/Binaries/Win64/ue4ss/Mods/LuaMod');
});

test('UE4SS is previewed and installed from an extracted local folder', async () => {
  const server = makeServer('pal-ue4ss-folder', 'PalServer.exe');
  const source = path.join(TMP_ROOT, 'ue4ss-download');
  fs.mkdirSync(path.join(source, 'ue4ss', 'Mods'), { recursive: true });
  fs.writeFileSync(path.join(source, 'UE4SS.dll'), 'framework');
  fs.writeFileSync(path.join(source, 'dwmapi.dll'), 'loader');
  fs.writeFileSync(path.join(source, 'UE4SS-settings.ini'), '[General]');
  fs.writeFileSync(path.join(source, 'ue4ss', 'Mods', 'mods.txt'), '');

  const preview = await mods.previewFrameworkFolder({
    server,
    manager: { status: 'offline' },
    actorId: 'u',
    folder: source,
    host: 'windows',
  });
  assert.strictEqual(preview.plan.mode, 'install');
  assert.strictEqual(preview.plan.files.length, 4);
  assert.strictEqual(preview.plan.installPath, 'Pal/Binaries/Win64');

  const installed = await mods.applyFrameworkFolder({
    server,
    manager: { status: 'offline' },
    actorId: 'u',
    previewToken: preview.previewToken,
    revision: preview.revision,
  });
  assert.strictEqual(installed.ok, true);
  assert.strictEqual(installed.framework.detected, true);
  assert.strictEqual(fs.readFileSync(path.join(server.dir, 'Pal', 'Binaries', 'Win64', 'dwmapi.dll'), 'utf8'), 'loader');

  const running = {
    status: 'online',
    starts: 0,
    stop() { this.status = 'offline'; },
    start() { this.starts += 1; this.status = 'starting'; return { ok: true }; },
  };
  const upgrade = await mods.previewFrameworkFolder({
    server,
    manager: running,
    actorId: 'u',
    folder: source,
    host: 'windows',
  });
  const upgraded = await mods.applyFrameworkFolder({
    server,
    manager: running,
    actorId: 'u',
    previewToken: upgrade.previewToken,
    revision: upgrade.revision,
  });
  assert.strictEqual(upgraded.restarted, true);
  assert.strictEqual(running.starts, 1);

  fs.rmSync(path.join(source, 'dwmapi.dll'));
  await assert.rejects(
    () => mods.previewFrameworkFolder({ server, manager: { status: 'offline' }, actorId: 'u', folder: source, host: 'windows' }),
    (error) => error.code === 'framework_loader_missing',
  );
});

test('unmanaged mods are inventoried without mutation and need adoption', async () => {
  const server = makeServer('pal-unmanaged', NATIVE_EXECUTABLE);
  const stray = path.join(server.dir, 'Pal', 'Content', 'Paks', '~mods', 'StrayMod');
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(path.join(stray, 'Stray.pak'), 'stray');

  const listed = await mods.inventory({ server, host: NATIVE_HOST });
  assert.strictEqual(listed.packages.length, 0);
  assert.strictEqual(listed.unmanaged.length, 1);
  assert.strictEqual(listed.unmanaged[0].path, 'Pal/Content/Paks/~mods/StrayMod');
  assert.ok(fs.existsSync(path.join(stray, 'Stray.pak')), 'listing never mutates');

  assert.throws(() => mods.remove({ server, manager: { status: 'offline' }, packageId: 'not-a-package' }), (error) => error.code === 'package_not_found');

  const adopted = mods.adopt({ server, relPath: 'Pal/Content/Paks/~mods/StrayMod' });
  assert.strictEqual(adopted.package.provider, 'adopted');
  assert.strictEqual(adopted.package.fileCount, 1);
  assert.strictEqual((await mods.inventory({ server, host: NATIVE_HOST })).unmanaged.length, 0);
  assert.throws(() => mods.adopt({ server, relPath: '../../etc' }), (error) => error.code === 'not_adoptable');

  // An importing conflict with an unmanaged folder is refused, not overwritten.
  const other = makeServer('pal-conflict', 'PalServer.sh');
  const dir = path.join(other.dir, 'Pal', 'Content', 'Paks', '~mods', 'CoolMod');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'other.pak'), 'x');
  const archive = path.join(TMP_ROOT, 'conflict.zip');
  await zip(archive, { 'CoolMod/CoolMod.pak': 'x' });
  await assert.rejects(
    () => mods.previewImport({ server: other, manager: { status: 'offline' }, actorId: 'u', archivePath: archive, fileName: 'conflict.zip', host: 'linux' }),
    (error) => error.code === 'conflict_unmanaged',
  );
});

test('workshop update checks report freshness, staleness and outages', async () => {
  const server = makeServer('pal-updates', NATIVE_EXECUTABLE);
  const manager = { status: 'offline', id: server.id };
  const archive = path.join(TMP_ROOT, 'wsmod.zip');
  await zip(archive, { 'WsMod/WsMod.pak': 'x' });
  const preview = await mods.previewImport({
    server, manager, actorId: 'u', archivePath: archive, fileName: 'wsmod.zip', host: NATIVE_HOST,
    provider: 'steam-workshop', sourceItemId: '3141592653',
  });
  assert.strictEqual(preview.plan.provider, 'steam-workshop');
  assert.strictEqual((await (await mods.applyImport({ server, manager, actorId: 'u', idempotencyKey: 'ws-1', previewToken: preview.previewToken, revision: preview.revision })).completed).state, 'succeeded');

  mods.resetCaches();
  const current = await mods.checkUpdates({
    server, force: true,
    fetchImpl: async () => ({ ok: true, json: async () => ({ response: { publishedfiledetails: [{ publishedfileid: '3141592653', result: 1, title: 'Ws Mod', time_updated: 1000 }] } }) }),
  });
  assert.strictEqual(current.packages[0].update.state, 'current');
  assert.strictEqual(current.packages[0].update.source, 'steam-workshop');

  const ready = await mods.checkUpdates({
    server, force: true, now: Date.now(),
    fetchImpl: async () => ({ ok: true, json: async () => ({ response: { publishedfiledetails: [{ publishedfileid: '3141592653', result: 1, title: 'Ws Mod', time_updated: Math.floor(Date.now() / 1000) + 60 }] } }) }),
  });
  assert.strictEqual(ready.packages[0].update.state, 'update-ready');
  assert.ok(ready.packages[0].update.latestVersion);

  const outage = await mods.checkUpdates({
    server, force: true,
    fetchImpl: async () => { throw new Error('network down'); },
  });
  assert.strictEqual(outage.stale, true);
  assert.ok(outage.error);
  assert.strictEqual(outage.packages[0].update.state, 'update-ready', 'the last known answer is kept and labelled stale');

  // A local archive has no upstream, so it says so rather than claiming to be current.
  const localServer = makeServer('pal-local', NATIVE_EXECUTABLE);
  const localArchive = path.join(TMP_ROOT, 'localmod.zip');
  await zip(localArchive, { 'LocalMod/LocalMod.pak': 'x' });
  const localPreview = await mods.previewImport({ server: localServer, manager: { status: 'offline' }, actorId: 'u', archivePath: localArchive, fileName: 'localmod.zip', host: NATIVE_HOST });
  await (await mods.applyImport({ server: localServer, manager: { status: 'offline', id: localServer.id }, actorId: 'u', idempotencyKey: 'local-1', previewToken: localPreview.previewToken, revision: localPreview.revision })).completed;
  const local = await mods.checkUpdates({ server: localServer, force: true });
  assert.strictEqual(local.packages[0].update.state, 'manual');
});

test('workshop responses are parsed defensively', () => {
  assert.throws(() => mods.parseWorkshopDetails({ response: {} }), (error) => error.code === 'workshop_malformed');
  const parsed = mods.parseWorkshopDetails({ response: { publishedfiledetails: [{ publishedfileid: '1', result: 9 }] } });
  assert.strictEqual(parsed.get('1').ok, false);
});

test('a broken mod inventory never reads as "nothing installed"', () => {
  const server = makeServer('pal-broken', 'PalServer.sh');
  fs.mkdirSync(mods.stateDir(server), { recursive: true });
  fs.writeFileSync(mods.inventoryPath(server), '{ not json');
  const state = mods.readInventory(server);
  assert.strictEqual(state.readable, false);
  assert.throws(() => mods.remove({ server, manager: { status: 'offline' }, packageId: 'x' }), (error) => error.code === 'inventory_unreadable');
});

(async () => {
  for (const [name, fn] of tests) {
    await fn();
    console.log(`  ok  ${name}`);
  }
  console.log('palworld mods tests passed');
  teardown();
})().catch((error) => {
  console.error(error);
  teardown();
  process.exitCode = 1;
});
