'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const terrariaInstall = require('../lib/terraria-install.cjs');
const terrariaMods = require('../lib/terraria-mods.cjs');
const terrariaImport = require('../lib/terraria-import.cjs');
const createTerrariaModule = require('../lib/modules/terraria/manager.cjs');

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hostkind-${prefix}-`));
}

// Compare data roots by canonical path: on Windows runners os.tmpdir() can
// report the 8.3 short form (C:\Users\RUNNER~1\...) while the import code
// resolves the long form (C:\Users\runneradmin\...). Both name the same
// directory; realpathSync makes the assertion hold on either spelling.
function canonicalRoot(p) {
  return fs.realpathSync(p);
}

function writeTmodRuntime(root) {
  fs.writeFileSync(path.join(root, 'tModLoader.dll'), 'managed entry point');
  fs.writeFileSync(path.join(root, 'tModLoader.runtimeconfig.json'), JSON.stringify({
    runtimeOptions: { framework: { version: '8.0.0' } },
  }));
}

function saveFlag(args) {
  const index = args.findIndex((arg) => String(arg).toLowerCase() === '-tmlsavedirectory');
  return index < 0 ? null : { index, value: args[index + 1] };
}

test('fresh tModLoader launch plans select the server data root', () => {
  const root = tempRoot('fresh-tml');
  try {
    writeTmodRuntime(root);
    const configFile = path.join(root, 'serverconfig.txt');
    const plan = terrariaInstall.buildLaunchPlan('tmodloader', root, configFile, {
      platform: process.platform,
      arch: process.arch,
      findRuntime: () => '/usr/bin/dotnet',
    });

    assert.deepEqual(plan.args, [
      path.join(root, 'tModLoader.dll'),
      '-server',
      '-tmlsavedirectory',
      root,
      '-config',
      configFile,
    ]);
    const resolved = terrariaMods.resolveModsDir({
      id: 'fresh-tml',
      dir: root,
      terrariaVariant: 'tmodloader',
      args: plan.args,
    });
    assert.equal(resolved.abs, path.join(root, 'Mods'));
    assert.equal(resolved.source, 'launch-flag');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('normal start repairs a legacy tModLoader descriptor', () => {
  const root = tempRoot('legacy-tml');
  try {
    const executable = path.join(root, 'dotnet');
    fs.writeFileSync(executable, 'runtime');
    if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
    const desc = {
      id: 'legacy-tml',
      type: 'terraria',
      dir: root,
      cwd: root,
      executable,
      args: ['-server', '-config', 'serverconfig.txt'],
      terrariaVariant: 'tmodloader',
    };
    const launches = [];
    const manager = {
      desc: () => desc,
      _launch(bin, args) {
        launches.push({ bin, args });
        return { ok: true };
      },
    };

    assert.deepEqual(createTerrariaModule({ platform: 'win32', windowsSystemRoot: 'C:/Windows' }).start(manager), { ok: true });
    assert.deepEqual(launches, [{
      bin: path.join('C:/Windows', 'System32', 'conhost.exe'),
      args: ['--headless', executable, '-server', '-tmlsavedirectory', root, '-config', 'serverconfig.txt'],
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tModLoader import and adoption preserve the server data root', () => {
  const root = tempRoot('import-tml');
  try {
    writeTmodRuntime(root);
    const executable = path.join(root, 'dotnet');
    fs.writeFileSync(executable, 'runtime');
    if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
    fs.mkdirSync(path.join(root, 'Mods'));
    fs.writeFileSync(path.join(root, 'Mods', 'enabled.json'), '[]\n');
    fs.writeFileSync(path.join(root, 'serverconfig.txt'), 'port=7777\n');

    const preview = terrariaImport.preview({ dir: root, actorId: 'operator', variant: 'tmodloader' });
    const previewFlag = saveFlag(preview.inspection.launchPlan.args);
    assert.ok(previewFlag, 'the imported launch plan must select a tModLoader save root');
    assert.equal(canonicalRoot(previewFlag.value), canonicalRoot(root));

    const adopted = terrariaImport.adopt({
      token: preview.token,
      actorId: 'operator',
      name: 'Imported tModLoader',
      variant: 'tmodloader',
    });
    const adoptedFlag = saveFlag(adopted.descriptor.args);
    assert.ok(adoptedFlag, 'the adopted descriptor must keep the save-root flag');
    assert.equal(canonicalRoot(adoptedFlag.value), canonicalRoot(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
