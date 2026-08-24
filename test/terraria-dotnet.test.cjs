'use strict';

/*
 * The .NET runtime a Terraria variant needs (lib/dotnetRuntime.cjs).
 *
 * The report this file exists for: a TShock server registered by the panel
 * printed the .NET host's own diagnostic and exited -
 *
 *   You must install .NET to run this application.
 *   .NET location: Not found
 *   Failed to resolve libhostfxr.so [not found]
 *
 * - on a host that had .NET 8 installed in ~/.dotnet and on PATH. Two separate
 * facts produced that, and both are pinned here: an apphost never looks at
 * PATH, so the installation was invisible to it; and the build wanted .NET 9,
 * so finding it would not have been enough. Every requirement below is read out
 * of the app itself, so nothing here has to be edited when TShock retargets.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dotnetRuntime = require('../lib/dotnetRuntime.cjs');
const createTerrariaModule = require('../lib/modules/terraria/manager.cjs');
const terrariaCrashes = require('../lib/terraria-crashes.cjs');
const crashes = require('../lib/crashes.cjs');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fleetdeck-dotnet-${label}-`));
}

// A .NET installation as an apphost recognizes one: a host resolver, plus a
// directory per installed shared-framework version.
function fakeInstall(root, versions) {
  fs.mkdirSync(path.join(root, 'host', 'fxr', '9.0.0'), { recursive: true });
  for (const version of versions) {
    fs.mkdirSync(path.join(root, 'shared', 'Microsoft.NETCore.App', version), { recursive: true });
  }
  return root;
}

function runtimeConfig(version) {
  return JSON.stringify({
    runtimeOptions: {
      tfm: `net${version.split('.')[0]}.0`,
      framework: { name: 'Microsoft.NETCore.App', version },
      configProperties: { 'System.Reflection.Metadata.MetadataUpdater.IsSupported': false },
    },
  }, null, 2);
}

/* ------------------------------------------------ 1. reading the requirement */

test('a framework-dependent app states its runtime in a sidecar config', () => {
  const root = tempDir('sidecar');
  try {
    const app = path.join(root, 'tModLoader.dll');
    fs.writeFileSync(app, 'managed');
    fs.writeFileSync(path.join(root, 'tModLoader.runtimeconfig.json'), runtimeConfig('8.0.0'));
    assert.deepEqual(dotnetRuntime.requiredFramework(app), {
      name: 'Microsoft.NETCore.App', version: '8.0.0', selfContained: false,
    });
    // A Windows apphost drops the same way: TShock.Server.exe -> .runtimeconfig.json
    const exe = path.join(root, 'TShock.Server.exe');
    fs.writeFileSync(exe, 'apphost');
    fs.writeFileSync(path.join(root, 'TShock.Server.runtimeconfig.json'), runtimeConfig('9.0.0'));
    assert.equal(dotnetRuntime.requiredFramework(exe).version, '9.0.0');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/*
 * TShock ships a single-file build: there is no sidecar on disk, the config is
 * a member of the bundle inside the executable. This is the shape the report
 * came from, and the reason the requirement is read rather than remembered.
 */
test('a single-file build states its runtime inside the executable', () => {
  const root = tempDir('bundle');
  try {
    const app = path.join(root, 'TShock.Server');
    const config = Buffer.from(runtimeConfig('9.0.0'), 'latin1');
    // Placed so the JSON straddles the scanner's 1 MB chunk boundary: an
    // object split across two reads must still be found.
    const offset = (1024 * 1024) - 120;
    const binary = Buffer.alloc(offset + config.length + 4096);
    config.copy(binary, offset);
    fs.writeFileSync(app, binary);
    assert.deepEqual(dotnetRuntime.requiredFramework(app), {
      name: 'Microsoft.NETCore.App', version: '9.0.0', selfContained: false,
    });

    // No evidence is not a licence to guess: a native binary states nothing,
    // and a file that is not there states nothing either.
    const native = path.join(root, 'TerrariaServer.bin.x86_64');
    fs.writeFileSync(native, Buffer.alloc(4096));
    assert.equal(dotnetRuntime.requiredFramework(native), null);
    assert.equal(dotnetRuntime.requiredFramework(path.join(root, 'gone')), null);
    assert.equal(dotnetRuntime.requiredFramework(''), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a self-contained build carries its own runtime and is never refused', () => {
  const root = tempDir('self-contained');
  try {
    const app = path.join(root, 'Server');
    fs.writeFileSync(app, 'apphost');
    fs.writeFileSync(path.join(root, 'Server.runtimeconfig.json'), JSON.stringify({
      runtimeOptions: { includedFrameworks: [{ name: 'Microsoft.NETCore.App', version: '9.0.0' }] },
    }));
    assert.equal(dotnetRuntime.requiredFramework(app).selfContained, true);
    const verdict = dotnetRuntime.inspect({ app, label: 'TShock', env: {}, platform: 'linux', findRuntime: () => null });
    assert.equal(verdict.ok, true, 'a bundled runtime cannot be missing from the host');
    assert.equal(verdict.env, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/* ------------------------------------------------------- 2. finding the host */

test('discovery follows the apphost order, and only PATH needs DOTNET_ROOT', () => {
  const root = tempDir('roots');
  try {
    const fromEnv = fakeInstall(path.join(root, 'env'), ['9.0.3']);
    const fromPath = fakeInstall(path.join(root, 'home', '.dotnet'), ['8.0.29']);
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    const findRuntime = () => path.join(fromPath, 'dotnet');

    // `roots: []` replaces the host's OS-wide install locations, so these
    // cases run the same on a host that has .NET installed system-wide (a CI
    // runner ships /usr/share/dotnet, which would otherwise win over PATH).
    assert.deepEqual(dotnetRuntime.discoverInstallRoot({ env: { DOTNET_ROOT: fromEnv }, platform: 'linux', roots: [], findRuntime }),
      { root: fromEnv, source: 'env', injected: false });

    // The case from the report: the only installation is one PATH knows about,
    // which is the one place an apphost does not look.
    assert.deepEqual(dotnetRuntime.discoverInstallRoot({ env: {}, platform: 'linux', roots: [], findRuntime }),
      { root: fromPath, source: 'path', injected: true });

    // A runtime the package brought with it wins outright, and also has to be
    // named in the environment.
    assert.deepEqual(dotnetRuntime.discoverInstallRoot({ hint: fromEnv, env: {}, platform: 'linux', roots: [], findRuntime }),
      { root: fromEnv, source: 'bundled', injected: true });

    // A stale DOTNET_ROOT is not an installation.
    assert.deepEqual(dotnetRuntime.discoverInstallRoot({ env: { DOTNET_ROOT: empty }, platform: 'linux', roots: [], findRuntime }),
      { root: fromPath, source: 'path', injected: true });
    assert.equal(dotnetRuntime.discoverInstallRoot({ env: {}, platform: 'linux', roots: [], findRuntime: () => null }), null);
    assert.equal(dotnetRuntime.hasRuntime({ env: {}, platform: 'linux', roots: [], findRuntime }), true);

    // A runtime in an OS-wide location the apphost checks by default beats a
    // PATH-only one, and needs no DOTNET_ROOT: the apphost finds it itself.
    const systemRoot = fakeInstall(path.join(root, 'system'), ['9.0.0']);
    assert.deepEqual(dotnetRuntime.discoverInstallRoot({ env: {}, platform: 'linux', roots: [systemRoot], findRuntime }),
      { root: systemRoot, source: 'default', injected: false });

    assert.deepEqual(dotnetRuntime.installedFrameworks(fakeInstall(path.join(root, 'many'), ['9.0.10', '8.0.29', '9.0.2'])),
      ['9.0.10', '9.0.2', '8.0.29']);
    assert.deepEqual(dotnetRuntime.installedFrameworks(empty), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// .NET's default roll-forward: a later minor or patch of the same major runs
// the app, an earlier one does not, and another major never does. Hostkind
// must refuse exactly what the apphost refuses - no more.
test('roll-forward matches the .NET default', () => {
  assert.equal(dotnetRuntime.satisfies('9.0.0', ['9.0.0']), true);
  assert.equal(dotnetRuntime.satisfies('9.0.0', ['9.0.14']), true);
  assert.equal(dotnetRuntime.satisfies('9.0.0', ['9.4.1']), true);
  assert.equal(dotnetRuntime.satisfies('9.0.5', ['9.0.2']), false);
  assert.equal(dotnetRuntime.satisfies('9.0.0', ['8.0.29']), false);
  assert.equal(dotnetRuntime.satisfies('9.0.0', ['10.0.1']), false);
  assert.equal(dotnetRuntime.satisfies('9.0.0', []), false);
  assert.equal(dotnetRuntime.satisfies(null, []), true);
});

/* --------------------------------------------------------- 3. the verdict -- */

test('a refusal names the server, the version needed, and the version present', () => {
  const root = tempDir('verdict');
  try {
    const app = path.join(root, 'TShock.Server');
    fs.writeFileSync(app, 'apphost');
    fs.writeFileSync(path.join(root, 'TShock.Server.runtimeconfig.json'), runtimeConfig('9.0.0'));
    const install = fakeInstall(path.join(root, 'dotnet'), ['8.0.29']);
    const findRuntime = () => path.join(install, 'dotnet');

    const nothing = dotnetRuntime.inspect({ app, label: 'TShock', env: {}, platform: 'linux', roots: [], findRuntime: () => null });
    assert.equal(nothing.ok, false);
    assert.equal(nothing.code, 'runtime_missing');
    assert.match(nothing.error, /TShock runs on the \.NET 9 runtime, and no \.NET installation was found/);

    const wrong = dotnetRuntime.inspect({ app, label: 'TShock', env: {}, platform: 'linux', roots: [], findRuntime });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, 'runtime_version');
    assert.match(wrong.error, /\.NET 9 runtime/);
    assert.match(wrong.error, /has only 8\.0\.29/);

    const upgraded = fakeInstall(path.join(root, 'dotnet9'), ['8.0.29', '9.0.4']);
    const ok = dotnetRuntime.inspect({ app, label: 'TShock', env: {}, platform: 'linux', roots: [], findRuntime: () => path.join(upgraded, 'dotnet') });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.env, { DOTNET_ROOT: upgraded }, 'a PATH-only installation has to be named for the child');

    // Already somewhere the apphost looks: nothing to add to the environment.
    const viaEnv = dotnetRuntime.inspect({ app, label: 'TShock', env: { DOTNET_ROOT: upgraded }, platform: 'linux', roots: [], findRuntime: () => null });
    assert.equal(viaEnv.ok, true);
    assert.equal(viaEnv.env, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/* ------------------------------------------------------ 4. the module wiring */

test('a TShock start is refused when the host cannot run it, and carries DOTNET_ROOT when it can', async () => {
  const root = tempDir('module');
  const savedRoot = process.env.DOTNET_ROOT;
  const savedRootX64 = process.env.DOTNET_ROOT_X64;
  const savedPath = process.env.PATH;
  try {
    const app = path.join(root, 'TShock.Server');
    fs.writeFileSync(app, 'apphost');
    fs.writeFileSync(path.join(root, 'TShock.Server.runtimeconfig.json'), runtimeConfig('9.0.0'));
    const desc = { terrariaVariant: 'tshock', dir: root, cwd: root, executable: app, args: ['-config', path.join(root, 'serverconfig.txt')] };
    const launches = [];
    const manager = { desc: () => desc, _launch: (bin, args, options) => { launches.push({ bin, args, options }); return { ok: true }; } };
    // `dotnetRoots: []` is the module's test seam (see dotnetPlan in the
    // manager): discovery consults no OS-wide location, so the PATH-only case
    // below is exercised the same on a host with .NET installed system-wide.
    const module = createTerrariaModule({ probePortInUse: async () => false, dotnetRoots: [] });

    process.env.DOTNET_ROOT = fakeInstall(path.join(root, 'dotnet8'), ['8.0.29']);
    const refused = await module.preLaunch(manager);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /TShock runs on the \.NET 9 runtime/);

    process.env.DOTNET_ROOT = fakeInstall(path.join(root, 'dotnet9'), ['9.0.4']);
    assert.deepEqual(await module.preLaunch(manager), { ok: true });
    module.start(manager);
    assert.equal(launches.length, 1);
    assert.deepEqual(launches[0].options, {}, 'an installation the apphost already finds needs no environment');

    // The reported host: .NET only reachable through PATH. The start is allowed
    // and the child is told where the runtime is. Runs on every OS - the muxer
    // only has to exist and be executable, and _launch is mocked - so this case
    // cannot pass on Linux and never run on Windows again.
    delete process.env.DOTNET_ROOT;
    delete process.env.DOTNET_ROOT_X64;
    const install = fakeInstall(path.join(root, 'home-dotnet'), ['9.0.4']);
    const muxer = path.join(install, 'dotnet');
    fs.writeFileSync(muxer, '#!/bin/sh\n');
    fs.chmodSync(muxer, 0o755);
    process.env.PATH = install;
    module.start(manager);
    assert.deepEqual(launches[1].options, { env: { DOTNET_ROOT: install } });
    assert.deepEqual(await module.preLaunch(manager), { ok: true });

    // Vanilla is native: no .NET question is asked of it at all.
    const vanilla = path.join(root, 'TerrariaServer.bin.x86_64');
    fs.writeFileSync(vanilla, Buffer.alloc(1024));
    const vanillaManager = { desc: () => ({ terrariaVariant: 'vanilla', dir: root, cwd: root, executable: vanilla, args: [] }), _launch: (bin, args, options) => ({ ok: true, options }) };
    assert.deepEqual(await module.preLaunch(vanillaManager), { ok: true });
    assert.deepEqual(module.start(vanillaManager).options, {});
  } finally {
    if (savedRoot === undefined) delete process.env.DOTNET_ROOT; else process.env.DOTNET_ROOT = savedRoot;
    if (savedRootX64 === undefined) delete process.env.DOTNET_ROOT_X64; else process.env.DOTNET_ROOT_X64 = savedRootX64;
    process.env.PATH = savedPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- 5. the console diagnosis */

// A start that fails this way leaves nothing in the console but the .NET host's
// own text, so the crash rules have to recognize it verbatim.
test('the .NET host output is classified for both .NET variants', () => {
  const missing = [
    'You must install .NET to run this application.',
    '.NET location: Not found',
    'Failed to resolve libhostfxr.so [not found]. Error code: 0x80008083',
  ];
  const version = [
    "Framework: 'Microsoft.NETCore.App', version '9.0.0' (x64)",
    'The following frameworks were found:',
  ];
  // The whole diagnostic, as the console actually receives it.
  const block = [
    'You must install or update .NET to run this application.',
    '',
    'App: /srv/terraria/TShock.Server',
    'Architecture: x64',
    "Framework: 'Microsoft.NETCore.App', version '9.0.0' (x64)",
    '.NET location: /home/user/.dotnet',
    '',
    'The following frameworks were found:',
    '  8.0.29 at [/home/user/.dotnet/shared/Microsoft.NETCore.App]',
  ];
  for (const variant of ['tshock', 'tmodloader']) {
    const rules = terrariaCrashes.crashRules({ terrariaVariant: variant });
    for (const text of missing) {
      const found = crashes.classify({ console: [{ text }] }, {}, rules).map((item) => item.ruleId);
      assert.deepEqual(found, ['terraria.runtime.missing'], `${variant}: ${text} -> ${found.join(', ')}`);
    }
    for (const text of version) {
      const found = crashes.classify({ console: [{ text }] }, {}, rules).map((item) => item.ruleId);
      assert.deepEqual(found, ['terraria.runtime.version'], `${variant}: ${text} -> ${found.join(', ')}`);
    }
    const whole = crashes.classify({ console: block.map((text) => ({ text })) }, {}, rules).map((item) => item.ruleId);
    assert.ok(whole.includes('terraria.runtime.version'), `${variant} block -> ${whole.join(', ')}`);
    assert.ok(whole.includes('terraria.runtime.missing'), `${variant} block -> ${whole.join(', ')}`);
  }
  // Vanilla is native; a .NET rule it can never hit is not declared for it.
  assert.deepEqual(crashes.classify({ console: [{ text: missing[0] }] }, {}, terrariaCrashes.crashRules({ terrariaVariant: 'vanilla' })), []);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok  ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL  ${name}`);
      console.error(err);
    }
  }
  if (failed) {
    console.error(`${failed} of ${tests.length} terraria .NET tests failed`);
    process.exit(1);
  }
  console.log('PASS  terraria-dotnet');
})();
