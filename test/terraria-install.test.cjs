'use strict';

/*
 * Terraria installation and version selection (docs/terraria/01-installation-versions.md).
 *
 * Everything here runs offline: `global.fetch` is replaced with a throwing stub
 * for the whole file, so a test that reaches the network fails loudly instead
 * of passing on a good day. Upstream payloads are captured fixtures under
 * test/fixtures/terraria/, and archives are built byte-by-byte in-process -
 * including the hostile ones, because a ZIP library that sanitizes `../` on
 * the way in cannot prove the guard rejects it on the way out.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const { setupDataDir, teardown, TMP_ROOT } = require('./_setup.cjs');
setupDataDir();

const { close, dbPath } = require('../lib/db.cjs');
const migrations = require('../lib/migrations.cjs');
const operations = require('../lib/operations.cjs');
const terraria = require('../lib/terraria-install.cjs');
const { discoverTerrariaDownload } = require('../lib/dedicatedServerInstaller.cjs');

const MODULE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'lib', 'terraria-install.cjs'), 'utf8');
const FIXTURES = path.join(__dirname, 'fixtures', 'terraria');

function fresh() {
  close();
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath() + ext;
    if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch { /* */ }
  }
}
fresh();
migrations.runMigrations();

global.fetch = () => { throw new Error('a test reached the network'); };

const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const serve = (name) => async () => fixture(name);
const tmp = (prefix) => fs.mkdtempSync(path.join(TMP_ROOT, `${prefix}-`));

function host(overrides = {}) {
  return { platform: 'linux', arch: 'x64', findRuntime: () => '/usr/bin/dotnet', ...overrides };
}

function options(name, extra = {}) {
  terraria._resetCatalogue();
  return { fetchText: serve(name), host: host(extra.host), force: true, ...extra };
}

function throws(fn, code) {
  return fn().then(
    () => { throw new Error(`expected a rejection with code ${code}`); },
    (error) => {
      assert.strictEqual(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
      assert.ok(error.message && error.message.length > 10, 'errors carry a readable message');
      return error;
    },
  );
}

/* --------------------------------------------------------------- ZIP maker --
 *
 * A minimal store-only ZIP writer. archiver(1) normalizes `../` out of entry
 * names and cannot emit a directory-flagged file entry, so the guard tests
 * would silently test nothing if they used it.
 */
function makeZip(dest, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const push = (buffer) => { chunks.push(buffer); offset += buffer.length; };
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data == null ? '' : entry.data);
    const crc = zlib.crc32(data);
    const mode = entry.mode == null ? 0o100644 : entry.mode;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localOffset = offset;
    push(local); push(name); push(data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(3 << 8 | 20, 4); // made by unix
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

// The vanilla archive ships every platform side by side under a top-level
// folder whose name is the archive's business. The tests use a name no code
// could have guessed, so a passing discovery test proves discovery.
function vanillaZip(dest, root = 'release-XYZ') {
  return makeZip(dest, [
    { name: `${root}/Linux/TerrariaServer.bin.x86_64`, data: 'linux-binary' },
    { name: `${root}/Linux/System.dll`, data: 'lib' },
    { name: `${root}/Windows/TerrariaServer.exe`, data: 'windows-binary' },
    { name: `${root}/Mac/Terraria Server`, data: 'mac-binary' },
  ]);
}

// Mirrors the real package: tModLoader.dll plus its runtimeconfig at the root,
// next to the wrapper scripts Hostkind must not execute.
function tmodloaderZip(dest) {
  return makeZip(dest, [
    { name: 'tModLoader.dll', data: 'managed-entrypoint' },
    { name: 'tModLoader.runtimeconfig.json', data: JSON.stringify({ runtimeOptions: { tfm: 'net8.0', framework: { name: 'Microsoft.NETCore.App', version: '8.0.0' } } }) },
    { name: 'start-tModLoaderServer.sh', data: '#!/usr/bin/env bash\n', mode: 0o100755 },
    { name: 'start-tModLoaderServer.bat', data: '@echo off\n' },
    { name: 'LaunchUtils/ScriptCaller.sh', data: '#!/usr/bin/env bash\n', mode: 0o100755 },
  ]);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ------------------------------------------------- 1. version discovery -- */

test('each variant parses its captured upstream payload', async () => {
  const vanilla = await terraria.listVersions('vanilla', options('vanilla-names.json'));
  assert.deepStrictEqual(vanilla.versions.map((v) => [v.id, v.gameVersion]), [['1456', '1.4.5.6']]);
  assert.strictEqual(vanilla.versions[0].supported, true);
  assert.strictEqual(vanilla.stale, false);

  const tml = await terraria.listVersions('tmodloader', options('tmodloader-releases.json'));
  assert.deepStrictEqual(tml.versions.map((v) => v.id), ['v2026.05.3.0']);
  assert.strictEqual(tml.versions[0].gameVersion, '1.4.4', 'the game version is read from the release name, not the tag');
  assert.strictEqual(tml.versions[0].filename, 'tModLoader.zip');

  const tshock = await terraria.listVersions('tshock', options('tshock-releases.json'));
  assert.deepStrictEqual(tshock.versions.map((v) => v.id), ['v6.1.0', 'v6.0.0'], 'newest first');
  assert.deepStrictEqual(tshock.versions.map((v) => v.gameVersion), ['1.4.5.6', '1.4.5.5']);
  assert.match(tshock.versions[0].filename, /linux-x64/);
});

test('prereleases, drafts and malformed entries are excluded', async () => {
  const tml = await terraria.listVersions('tmodloader', options('tmodloader-releases.json'));
  assert.ok(!tml.versions.some((v) => /preview|legacy/i.test(v.id)), 'no preview build is offered');
  const tshock = await terraria.listVersions('tshock', options('tshock-releases.json'));
  assert.ok(!tshock.versions.some((v) => v.id.includes('pre')), 'no prerelease tag is offered');

  const synthetic = JSON.stringify([
    { tag_name: 'v9.9.9', name: 'draft', draft: true, prerelease: false, published_at: '2026-01-01T00:00:00Z', assets: [{ name: 'TShock-9.9.9-for-Terraria-1.4.9.9-linux-x64-Release.zip', browser_download_url: 'https://example.invalid/a.zip' }] },
    { tag_name: 'v9.9.8', name: 'no assets', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z', assets: [] },
    { tag_name: '', name: 'no tag', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z', assets: [{ name: 'TShock-x-linux-x64-Release.zip', browser_download_url: 'https://example.invalid/b.zip' }] },
  ]);
  terraria._resetCatalogue();
  // A draft, an assetless release and an untagged release are all dropped, and
  // a source that lists nothing installable says so rather than inventing one.
  await throws(() => terraria.listVersions('tshock', { fetchText: async () => synthetic, host: host(), force: true }), 'no_versions');
});

test('a malformed version number is refused rather than guessed', () => {
  assert.strictEqual(terraria.unpackVanillaVersion('1449'), '1.4.4.9');
  assert.strictEqual(terraria.unpackVanillaVersion('14'), null);
  assert.strictEqual(terraria.unpackVanillaVersion('1.4.4.9'), null);
  assert.strictEqual(terraria.unpackVanillaVersion(''), null);
});

test('a rate-limited source returns the cached list flagged stale', async () => {
  terraria._resetCatalogue();
  const warm = await terraria.listVersions('tshock', { fetchText: serve('tshock-releases.json'), host: host() });
  assert.strictEqual(warm.stale, false);

  const rateLimited = async () => { const error = new Error('HTTP 403 from api.github.com'); error.status = 403; throw error; };
  const cold = await terraria.listVersions('tshock', { fetchText: rateLimited, host: host(), force: true });
  assert.strictEqual(cold.stale, true);
  assert.deepStrictEqual(cold.versions.map((v) => v.id), warm.versions.map((v) => v.id), 'the last good answer survives a rate limit');
  assert.match(cold.error, /rate-limiting/i);

  terraria._resetCatalogue();
  const never = await terraria.listVersions('tshock', { fetchText: rateLimited, host: host(), force: true });
  assert.deepStrictEqual(never.versions, [], 'with nothing cached the list is empty');
  assert.strictEqual(never.stale, true, 'and it says so instead of throwing');
});

test('an unreachable source with no cache is an error, not an empty list', async () => {
  terraria._resetCatalogue();
  await throws(() => terraria.listVersions('vanilla', { fetchText: async () => { throw new Error('ECONNREFUSED'); }, host: host() }), 'source_unreachable');
});

/* ------------------------------------------------------- 2. supportedness -- */

test('a release with no asset for this host is unsupported, with a reason', async () => {
  const list = await terraria.listVersions('tshock', options('tshock-releases.json', { host: { platform: 'win32', arch: 'arm64' } }));
  assert.ok(list.versions.length, 'the builds are still listed');
  for (const entry of list.versions) {
    assert.strictEqual(entry.supported, false);
    assert.strictEqual(entry.reasonCode, 'no_platform_asset');
    assert.match(entry.reason, /win32\/arm64/);
  }
  await throws(
    () => terraria.resolveDownload('tshock', 'v6.1.0', options('tshock-releases.json', { host: { platform: 'win32', arch: 'arm64' } })),
    'no_platform_asset',
  );
});

test('tModLoader without a .NET runtime is unsupported, with an actionable reason', async () => {
  const list = await terraria.listVersions('tmodloader', options('tmodloader-releases.json', { host: { findRuntime: () => null } }));
  assert.strictEqual(list.versions[0].supported, false);
  assert.strictEqual(list.versions[0].reasonCode, 'runtime_missing');
  assert.match(list.versions[0].reason, /\.NET runtime/);
});

test('a version id outside the resolved list is rejected', async () => {
  await throws(() => terraria.resolveDownload('tshock', 'v6.6.6', options('tshock-releases.json')), 'unknown_version');
  await throws(() => terraria.resolveDownload('vanilla', '9999', options('vanilla-names.json')), 'unknown_version');
  const resolved = await terraria.resolveDownload('tshock', '', options('tshock-releases.json'));
  assert.strictEqual(resolved.versionId, 'v6.1.0', 'no id means newest supported stable');
  assert.match(resolved.url, /^https:\/\/github\.com\//);
});

/* ------------------------------------------------------- 3. archive guard -- */

test('archive validation rejects traversal, links and over-limit archives', async () => {
  const dir = tmp('guard');
  const traversal = makeZip(path.join(dir, 'traversal.zip'), [{ name: '../escape.txt', data: 'x' }]);
  await throws(() => terraria.validateZip(traversal), 'path_traversal');

  const symlink = makeZip(path.join(dir, 'symlink.zip'), [{ name: 'link', data: '/etc/passwd', mode: 0o120777 }]);
  await throws(() => terraria.validateZip(symlink), 'symlink');

  const absolute = makeZip(path.join(dir, 'absolute.zip'), [{ name: 'C:/windows/system32/evil.dll', data: 'x' }]);
  await throws(() => terraria.validateZip(absolute), 'absolute_path');

  const many = makeZip(path.join(dir, 'many.zip'), [{ name: 'a', data: 'a' }, { name: 'b', data: 'b' }]);
  await throws(() => terraria.validateZip(many, { maxEntries: 1 }), 'too_many_entries');
  await throws(() => terraria.validateZip(many, { maxEntrySize: 0 }), 'entry_too_large');

  const ok = await terraria.validateZip(vanillaZip(path.join(dir, 'good.zip')));
  assert.strictEqual(ok.entries, 4);
});

test('a hostile archive is refused before a single file is written', async () => {
  const root = tmp('hostile');
  const source = makeZip(path.join(root, 'source', 'evil.zip'), [
    { name: 'ok.txt', data: 'x' },
    { name: '../escape.txt', data: 'x' },
  ]);
  const destination = path.join(root, 'server');
  await throws(() => terraria.install('vanilla', {
    destination, worldName: 'World', port: 7777, maxPlayers: 8,
  }, {
    ...options('vanilla-names.json'),
    cacheDir: path.join(root, 'cache'),
    download: async (url, target) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); },
  }), 'path_traversal');
  assert.strictEqual(fs.existsSync(destination), false, 'the destination was never created');
  assert.deepStrictEqual(fs.readdirSync(root).sort(), ['cache', 'source'], 'and no staging directory was left behind');
});

test('the nested TAR TShock ships is validated before extraction', () => {
  if (spawnSync('tar', ['--version'], { encoding: 'utf8' }).status !== 0) return;
  const dir = tmp('tar');
  const payload = path.join(dir, 'payload');
  fs.mkdirSync(path.join(payload, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'TShock.Server'), 'binary');
  fs.writeFileSync(path.join(payload, 'bin', 'OTAPI.dll'), 'lib');
  // Built from `dir` by basename: GNU tar would read an absolute `C:\...`
  // archive as a remote `host:path`, exactly as validateTar has to avoid.
  const pack = (name) => spawnSync('tar', ['-cf', name, '-C', payload, '.'], { encoding: 'utf8', cwd: dir }).status;
  const good = path.join(dir, 'good.tar');
  assert.strictEqual(pack('good.tar'), 0);
  assert.ok(terraria.validateTar(good).some((name) => name.endsWith('TShock.Server')));

  // A junction is the only link an unprivileged Windows account can create;
  // tar records it as one either way, which is what validateTar refuses.
  const sneaky = path.join(payload, 'sneaky');
  if (process.platform === 'win32') fs.symlinkSync(path.join(payload, 'bin'), sneaky, 'junction');
  else fs.symlinkSync('/etc/passwd', sneaky);
  const linked = path.join(dir, 'linked.tar');
  assert.strictEqual(pack('linked.tar'), 0);
  // Some hosts' tar (e.g. Windows bsdtar without Developer Mode) record a
  // junction as a plain directory, so the archive carries no link entry at
  // all. When that is the case there is nothing to validate and the throw
  // cannot be exercised - skip the assertion rather than fail the suite.
  const linkedVerbose = spawnSync('tar', ['-tvf', linked], { encoding: 'utf8', windowsHide: true, cwd: dir });
  const hasLinkEntry = String(linkedVerbose.stdout || '').split(/\r?\n/).some((line) => line.trim() && (line[0] === 'l' || line[0] === 'h'));
  if (!hasLinkEntry) {
    console.log('skip  link-bearing TAR (this tar does not record junctions as links)');
  } else {
    assert.throws(() => terraria.validateTar(linked), /links/);
  }
});

/* --------------------------------------------------------- 4. installing -- */

function installOptions(root, archive, fixtureName, extra = {}) {
  return {
    ...options(fixtureName, extra),
    cacheDir: path.join(root, 'cache'),
    download: async (url, target) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(archive, target); },
  };
}

test('a vanilla install finds its binary in the extracted tree and promotes atomically', async () => {
  const root = tmp('vanilla-install');
  const archive = vanillaZip(path.join(root, 'source', 'server.zip'), 'a-folder-nobody-hardcoded');
  const destination = path.join(root, 'server');
  const phases = [];
  const runtime = await terraria.install('vanilla', {
    destination, worldName: 'Fleet World', port: 7777, maxPlayers: 8, worldSize: 3, difficulty: 1, seed: 'for the worthy', motd: 'hello',
  }, {
    ...installOptions(root, archive, 'vanilla-names.json'),
    onPhase: (phase) => phases.push(phase),
  });

  assert.deepStrictEqual(phases, ['resolving', 'downloading', 'verifying', 'extracting', 'locating', 'configuring', 'promoting']);
  assert.strictEqual(runtime.executable, path.join(destination, 'a-folder-nobody-hardcoded', 'Linux', 'TerrariaServer.bin.x86_64'));
  assert.deepStrictEqual(runtime.args, ['-config', path.join(destination, 'serverconfig.txt')]);
  assert.strictEqual(runtime.cwd, path.dirname(runtime.executable));
  assert.deepStrictEqual(runtime.version, {
    game: '1.4.5.6', variant: '1456', source: 'terraria.org', resolvedAt: runtime.version.resolvedAt,
  });
  assert.ok(fs.existsSync(runtime.saveDir), 'the world folder exists');
  const config = fs.readFileSync(path.join(destination, 'serverconfig.txt'), 'utf8');
  assert.match(config, /worldname=Fleet World/);
  assert.match(config, /autocreate=3/);
  assert.match(config, /difficulty=1/);
  assert.match(config, /seed=for the worthy/);
  assert.match(config, /motd=hello/);
  assert.match(config, new RegExp(`world=${destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(!config.includes('fleetdeck-install-'), 'no staging path leaked into the config');
  if (process.platform !== 'win32') {
    assert.ok(fs.statSync(runtime.executable).mode & 0o100, 'the binary is executable');
  }
});

test('a tModLoader install resolves an argv launch plan and never a wrapper script', async () => {
  const root = tmp('tml-install');
  const archive = tmodloaderZip(path.join(root, 'source', 'tModLoader.zip'));
  const destination = path.join(root, 'server');
  const runtime = await terraria.install('tmodloader', {
    destination, worldName: 'Modded', port: 7778, maxPlayers: 16,
  }, installOptions(root, archive, 'tmodloader-releases.json'));

  assert.ok(Array.isArray(runtime.args), 'the launch plan is an argv array');
  assert.strictEqual(runtime.executable, '/usr/bin/dotnet', 'the runtime runs the package, not the other way round');
  assert.deepStrictEqual(runtime.args, [
    path.join(destination, 'tModLoader.dll'), '-server', '-config', path.join(destination, 'serverconfig.txt'),
  ]);
  assert.strictEqual(runtime.cwd, destination);
  assert.strictEqual(runtime.runtime.framework, '8.0.0', 'the required framework is read from the package');
  assert.strictEqual(runtime.runtime.source, 'path');
  for (const value of [runtime.executable, ...runtime.args]) {
    assert.ok(!/\.(?:sh|bat|cmd|ps1)$/i.test(String(value)), `${value} is not a launcher script`);
  }
  assert.ok(fs.existsSync(path.join(destination, 'start-tModLoaderServer.sh')), 'the wrapper is installed but unused');
});

test('a bundled runtime wins over PATH, and no runtime fails with a readable message', async () => {
  const root = tmp('tml-runtime');
  const bundled = makeZip(path.join(root, 'source', 'bundled.zip'), [
    { name: 'tModLoader.dll', data: 'entry' },
    { name: 'tModLoader.runtimeconfig.json', data: JSON.stringify({ runtimeOptions: { framework: { version: '8.0.0' } } }) },
    { name: 'dotnet/dotnet', data: 'runtime', mode: 0o100755 },
  ]);
  const withBundle = path.join(root, 'bundled-server');
  const runtime = await terraria.install('tmodloader', {
    destination: withBundle, worldName: 'Modded', port: 7778, maxPlayers: 16,
  }, installOptions(root, bundled, 'tmodloader-releases.json'));
  assert.strictEqual(runtime.executable, path.join(withBundle, 'dotnet', 'dotnet'));
  assert.strictEqual(runtime.runtime.source, 'bundled');

  // Without a runtime the package is refused, and the message names the exact
  // .NET version the package asked for - read from its runtimeconfig, not from
  // a constant in Hostkind.
  const naked = path.join(root, 'naked-package');
  fs.mkdirSync(naked, { recursive: true });
  fs.writeFileSync(path.join(naked, 'tModLoader.dll'), 'entry');
  fs.writeFileSync(path.join(naked, 'tModLoader.runtimeconfig.json'), JSON.stringify({ runtimeOptions: { framework: { version: '8.0.0' } } }));
  fs.writeFileSync(path.join(naked, 'start-tModLoaderServer.sh'), '#!/bin/sh\n');
  assert.throws(
    () => terraria.buildLaunchPlan('tmodloader', naked, '/srv/serverconfig.txt', host({ findRuntime: () => null })),
    (error) => error.code === 'runtime_missing' && /\.NET 8 runtime/.test(error.message),
  );

  // And an unsupported version is refused at creation, before anything is
  // downloaded.
  const destination = path.join(root, 'runtimeless-server');
  await throws(() => terraria.install('tmodloader', {
    destination, worldName: 'Modded', port: 7778, maxPlayers: 16, versionId: 'v2026.05.3.0',
  }, installOptions(root, bundled, 'tmodloader-releases.json', { host: { findRuntime: () => null } })), 'runtime_missing');
  assert.strictEqual(fs.existsSync(destination), false);
});

/*
 * TShock is a framework-dependent .NET app too, and its binary is the only
 * thing that knows which .NET it wants. A host that cannot satisfy it has to
 * hear so at creation - the alternative is a registered server that answers
 * every start with the .NET host's own diagnostic.
 */
test('a TShock package is checked against the .NET this host has', async () => {
  const root = tmp('tshock-runtime');
  const install = path.join(root, 'dotnet8');
  fs.mkdirSync(path.join(install, 'host', 'fxr', '8.0.29'), { recursive: true });
  fs.mkdirSync(path.join(install, 'shared', 'Microsoft.NETCore.App', '8.0.29'), { recursive: true });

  const extracted = path.join(root, 'package');
  fs.mkdirSync(extracted, { recursive: true });
  fs.writeFileSync(path.join(extracted, 'TShock.Server'), 'apphost');
  fs.writeFileSync(path.join(extracted, 'TShock.Server.runtimeconfig.json'),
    JSON.stringify({ runtimeOptions: { framework: { name: 'Microsoft.NETCore.App', version: '9.0.0' } } }));

  const eight = host({ env: { DOTNET_ROOT: install }, dotnetRoots: [], findRuntime: () => null });
  assert.throws(
    () => terraria.buildLaunchPlan('tshock', extracted, '/srv/serverconfig.txt', eight),
    (error) => error.code === 'runtime_version' && /\.NET 9 runtime/.test(error.message) && /8\.0\.29/.test(error.message),
  );

  const nine = path.join(root, 'dotnet9');
  fs.mkdirSync(path.join(nine, 'host', 'fxr', '9.0.4'), { recursive: true });
  fs.mkdirSync(path.join(nine, 'shared', 'Microsoft.NETCore.App', '9.0.4'), { recursive: true });
  const plan = terraria.buildLaunchPlan('tshock', extracted, '/srv/serverconfig.txt',
    host({ env: { DOTNET_ROOT: nine }, dotnetRoots: [], findRuntime: () => null }));
  assert.strictEqual(plan.executable, path.join(extracted, 'TShock.Server'));
  assert.strictEqual(plan.runtime.framework, '9.0.0', 'the requirement is read from the binary, never remembered');

  // And with no .NET at all, the version list says so instead of offering a
  // download that cannot run.
  const none = await terraria.listVersions('tshock', options('tshock-releases.json', {
    host: { env: {}, dotnetRoots: [], findRuntime: () => null },
  }));
  assert.strictEqual(none.versions[0].supported, false);
  assert.strictEqual(none.versions[0].reasonCode, 'runtime_missing');
  assert.match(none.versions[0].reason, /TShock runs on the \.NET runtime/);
});

test('a package with only wrapper scripts fails instead of spawning one', async () => {
  const root = tmp('wrappers');
  const archive = makeZip(path.join(root, 'source', 'wrappers.zip'), [
    { name: 'start-tModLoaderServer.sh', data: '#!/bin/sh\n', mode: 0o100755 },
    { name: 'LaunchUtils/ScriptCaller.sh', data: '#!/bin/sh\n', mode: 0o100755 },
  ]);
  const destination = path.join(root, 'server');
  await throws(() => terraria.install('tmodloader', {
    destination, worldName: 'Modded', port: 7778, maxPlayers: 16,
  }, installOptions(root, archive, 'tmodloader-releases.json')), 'entrypoint_missing');
  assert.strictEqual(fs.existsSync(destination), false);
});

test('no code path builds a shell command string', () => {
  assert.ok(!/sh\s+-c|cmd\s*\/c|\bexecSync\b|child_process'\)\.exec|\bexecFile\b/.test(MODULE_SOURCE), 'the installer never shells out');
  assert.match(MODULE_SOURCE, /require\('child_process'\)/);
  assert.deepStrictEqual(MODULE_SOURCE.match(/const \{ ([^}]+) \} = require\('child_process'\)/)[1].trim(), 'spawnSync');
  for (const call of MODULE_SOURCE.match(/spawnSync\([^)]*\)/g) || []) {
    assert.match(call, /spawnSync\('tar', \[/, 'the only process spawned is tar, with an argv array');
    assert.ok(!/shell\s*:\s*true/.test(call), 'and never through a shell');
  }
  assert.match(MODULE_SOURCE, /WRAPPER_EXTENSIONS\.has\(/, 'the launch plan refuses wrapper scripts explicitly');
});

/* ---------------------------------------------------------- 5. rollbacks -- */

test('an interrupted download leaves no destination and no staging', async () => {
  const root = tmp('interrupted');
  const destination = path.join(root, 'server');
  await throws(() => terraria.install('vanilla', {
    destination, worldName: 'World', port: 7777, maxPlayers: 8,
  }, {
    ...options('vanilla-names.json'),
    cacheDir: path.join(root, 'cache'),
    download: async (url, target) => {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'half a fi');
      const error = new Error('connection reset');
      error.code = 'download_interrupted';
      throw error;
    },
  }), 'download_interrupted');
  assert.strictEqual(fs.existsSync(destination), false);
  assert.deepStrictEqual(fs.readdirSync(root), ['cache']);
});

test('a failed extraction leaves no destination and no staging', async () => {
  const root = tmp('bad-archive');
  const archive = path.join(root, 'source', 'broken.zip');
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.writeFileSync(archive, 'this is not a zip file');
  const destination = path.join(root, 'server');
  await throws(() => terraria.install('vanilla', {
    destination, worldName: 'World', port: 7777, maxPlayers: 8,
  }, installOptions(root, archive, 'vanilla-names.json')), 'invalid_archive');
  assert.strictEqual(fs.existsSync(destination), false);
  assert.deepStrictEqual(fs.readdirSync(root).sort(), ['cache', 'source']);
});

test('a failed promotion leaves the destination as it was', () => {
  const root = tmp('promote');
  const staging = path.join(root, 'staging');
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'new.txt'), 'new');
  const destination = path.join(root, 'server');
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'existing.txt'), 'original');
  assert.throws(() => terraria.promote(staging, destination), /not empty/);
  assert.deepStrictEqual(fs.readdirSync(destination), ['existing.txt']);
  assert.strictEqual(fs.readFileSync(path.join(destination, 'existing.txt'), 'utf8'), 'original');

  const empty = path.join(root, 'empty');
  fs.mkdirSync(empty);
  terraria.promote(staging, empty);
  assert.deepStrictEqual(fs.readdirSync(empty), ['new.txt'], 'an empty destination is replaced by the staged tree');
});

test('an existing non-empty destination is refused and left byte-identical', async () => {
  const root = tmp('occupied');
  const archive = vanillaZip(path.join(root, 'source', 'server.zip'));
  const destination = path.join(root, 'server');
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, 'world.wld'), 'irreplaceable');
  const before = fs.readFileSync(path.join(destination, 'world.wld'));
  await throws(() => terraria.install('vanilla', {
    destination, worldName: 'World', port: 7777, maxPlayers: 8,
  }, installOptions(root, archive, 'vanilla-names.json')), 'destination_not_empty');
  assert.deepStrictEqual(fs.readdirSync(destination), ['world.wld']);
  assert.ok(before.equals(fs.readFileSync(path.join(destination, 'world.wld'))));
});

/* ------------------------------------------------------------- 6. inputs -- */

test('world names and seeds are normalized, not sanitized', () => {
  assert.strictEqual(terraria.normalizeWorldName('  Fleet World  '), 'Fleet World');
  for (const bad of ['', '   ', '../escape', 'a/b', 'a\\b', 'CON', 'trailing.', '.hidden', 'x'.repeat(65)]) {
    assert.throws(() => terraria.normalizeWorldName(bad), /World name|world name|reserved|file name/, `${JSON.stringify(bad)} is refused`);
  }
  assert.strictEqual(terraria.normalizeSeed(''), '');
  assert.strictEqual(terraria.normalizeSeed('for the worthy'), 'for the worthy');
  assert.throws(() => terraria.normalizeSeed('seed\nport=1'), /Seeds may only/);
  assert.throws(() => terraria.normalizeSeed('x'.repeat(65)), /64 characters/);
});

test('a setting containing a line break cannot forge a second config key', () => {
  assert.throws(() => terraria.serverConfigText({ motd: 'hi\nport=1' }), /line breaks/);
  const text = terraria.serverConfigText({ port: 7777, password: '' });
  assert.match(text, /port=7777/);
  assert.ok(!text.includes('password='), 'empty values are omitted rather than written blank');
});

/* ------------------------------------------------------------ 7. updates -- */

async function installedServer(root, version) {
  const archive = vanillaZip(path.join(root, 'source', `server-${version}.zip`), `build-${version}`);
  const destination = path.join(root, 'server');
  const names = JSON.stringify([`terraria-server-${version}.zip`]);
  const runtime = await terraria.install('vanilla', {
    destination, worldName: 'World', port: 7777, maxPlayers: 8,
  }, {
    fetchText: async () => names,
    host: host(),
    force: true,
    cacheDir: path.join(root, 'cache'),
    download: async (url, target) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(archive, target); },
  });
  return { destination, runtime };
}

test('discoverUpdate compares the recorded build against the newest stable', async () => {
  const desc = { type: 'terraria', terrariaVariant: 'vanilla', terrariaVersion: { game: '1.4.5.5', variant: '1455' } };
  const plan = await terraria.discoverUpdate(desc, options('vanilla-names.json'));
  assert.strictEqual(plan.available, true);
  assert.strictEqual(plan.current.id, '1455');
  assert.strictEqual(plan.latest.id, '1456');
  assert.strictEqual(plan.restartRequired, true);
  assert.ok(plan.notes.some((note) => /preserved/.test(note)));

  const current = await terraria.discoverUpdate({ terrariaVariant: 'vanilla', terrariaVersion: { game: '1.4.5.6', variant: '1456' } }, options('vanilla-names.json'));
  assert.strictEqual(current.available, false);

  const unknown = await terraria.discoverUpdate({ terrariaVariant: 'vanilla' }, options('vanilla-names.json'));
  assert.strictEqual(unknown.available, false, 'a server whose build is unknown is not offered an update');
  assert.ok(unknown.notes.some((note) => /does not know which build/.test(note)));

  const modded = await terraria.discoverUpdate(
    { terrariaVariant: 'tmodloader', terrariaVersion: { game: '1.4.3', variant: 'v2020.01.1.0' } },
    options('tmodloader-releases.json'),
  );
  assert.ok(modded.notes.some((note) => /Mods built for 1\.4\.3 will not load/.test(note)), 'a game-version change warns about mods');
});

test('applyUpdate replaces binaries and preserves worlds, config, tshock/ and Mods/', async () => {
  const root = tmp('update');
  const { destination } = await installedServer(root, '1455');
  // The things an operator would lose if an update were a reinstall.
  fs.mkdirSync(path.join(destination, 'tshock'), { recursive: true });
  fs.mkdirSync(path.join(destination, 'Mods'), { recursive: true });
  fs.writeFileSync(path.join(destination, 'worlds', 'World.wld'), 'the world');
  fs.writeFileSync(path.join(destination, 'tshock', 'config.json'), '{"ServerPassword":"kept"}');
  fs.writeFileSync(path.join(destination, 'Mods', 'CalamityMod.tmod'), 'mod bytes');
  const configBefore = fs.readFileSync(path.join(destination, 'serverconfig.txt'));
  fs.appendFileSync(path.join(destination, 'serverconfig.txt'), 'motd=edited by the operator\n');
  const editedConfig = fs.readFileSync(path.join(destination, 'serverconfig.txt'));
  assert.ok(!configBefore.equals(editedConfig));

  const nextArchive = vanillaZip(path.join(root, 'source', 'next.zip'), 'build-1456');
  const result = await terraria.applyUpdate({
    serverId: 'srv-update', dir: destination, variant: 'vanilla', versionId: '1456', actorId: 'user-1', offline: true,
  }, {
    fetchText: serve('vanilla-names.json'),
    host: host(),
    force: true,
    cacheDir: path.join(root, 'cache'),
    download: async (url, target) => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(nextArchive, target); },
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.version.variant, '1456');
  assert.ok(fs.existsSync(path.join(destination, 'build-1456', 'Linux', 'TerrariaServer.bin.x86_64')), 'the new binaries landed');
  assert.strictEqual(fs.readFileSync(path.join(destination, 'worlds', 'World.wld'), 'utf8'), 'the world');
  assert.strictEqual(fs.readFileSync(path.join(destination, 'tshock', 'config.json'), 'utf8'), '{"ServerPassword":"kept"}');
  assert.strictEqual(fs.readFileSync(path.join(destination, 'Mods', 'CalamityMod.tmod'), 'utf8'), 'mod bytes');
  assert.ok(editedConfig.equals(fs.readFileSync(path.join(destination, 'serverconfig.txt'))), 'the operator\'s config edit survived');

  const operation = operations.get(result.operationId);
  assert.strictEqual(operation.state, 'succeeded');
  assert.strictEqual(operation.kind, 'terraria.update');

  const rolled = terraria.rollbackUpdate({ dir: destination, snapshotId: result.snapshotId, operationId: result.operationId, cause: 'test' });
  assert.strictEqual(rolled.ok, true);
  assert.ok(fs.existsSync(path.join(destination, 'build-1455', 'Linux', 'TerrariaServer.bin.x86_64')), 'the snapshot restored the old build');
});

test('an update refuses to run while the server is online', async () => {
  const root = tmp('update-online');
  const { destination } = await installedServer(root, '1455');
  await throws(() => terraria.applyUpdate({
    serverId: 'srv-online', dir: destination, variant: 'vanilla', versionId: '1456', offline: false,
  }, {
    fetchText: serve('vanilla-names.json'), host: host(), force: true,
    cacheDir: path.join(root, 'cache'),
    download: async () => { throw new Error('nothing should be downloaded'); },
  }), 'server_online');
});

test('an interrupted update becomes recovery_required, never a silent resume', () => {
  const operation = operations.create({ kind: 'terraria.update', serverId: 'srv-interrupted', actorId: 'user-1' });
  operations.start(operation.id);
  const swept = operations.sweepStale({ heartbeatStaleMs: 0, now: Date.now() + 60_000 });
  assert.ok(swept.some((op) => op.id === operation.id));
  assert.strictEqual(operations.get(operation.id).state, 'recovery_required');
});

test('the preserved set is matched by path, including worlds outside worlds/', () => {
  for (const kept of ['worlds/World.wld', 'serverconfig.txt', 'tshock/config.json', 'Mods/Calamity.tmod', 'mods/other.tmod', 'saves/Custom.twld', 'World.wld']) {
    assert.strictEqual(terraria.isPreserved(kept), true, `${kept} is preserved`);
  }
  for (const replaced of ['TerrariaServer.bin.x86_64', 'bin/OTAPI.dll', 'Content/Images/Item_1.xnb']) {
    assert.strictEqual(terraria.isPreserved(replaced), false, `${replaced} is replaced`);
  }
});

/* ------------------------------------------------------ 8. compatibility -- */

test('discoverTerrariaDownload keeps its published shape', async () => {
  terraria._resetCatalogue();
  const release = await discoverTerrariaDownload(async () => '["terraria-server-1450.zip","mobile-server.zip"]');
  assert.strictEqual(release.version, '1450');
  assert.strictEqual(release.gameVersion, '1.4.5.0');
  assert.strictEqual(release.url, 'https://terraria.org/api/download/pc-dedicated-server/terraria-server-1450.zip');
});

/* ------------------------------------------------------------------ run -- */

(async () => {
  let failed = 0;
  for (const entry of tests) {
    try { await entry.fn(); console.log(`ok  ${entry.name}`); }
    catch (error) { failed++; console.error(`FAIL  ${entry.name}: ${error.message}\n${error.stack}`); }
  }
  close();
  teardown();
  if (failed) { console.error(`FAIL  ${failed} terraria-install test(s) failed`); process.exit(1); }
  console.log('PASS  terraria-install');
})();
