'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createApplicationUpdateRuntime,
  createApplicationUpdateScheduler,
  createBinaryInstaller,
  createManifestVerifier,
  createFileStateStore,
  platformKeyFor,
  isPackagedRuntime,
} = require('../lib/application-update-runtime.cjs');

assert.strictEqual(platformKeyFor('win32', 'x64'), 'windows-x64');
assert.strictEqual(platformKeyFor('linux', 'x64'), 'linux-x64');
assert.strictEqual(platformKeyFor('win32', 'arm64'), 'windows-arm64');
assert.strictEqual(platformKeyFor('darwin', 'x64'), null);

assert.strictEqual(isPackagedRuntime({ platform: 'win32', execPath: 'C:\\Program Files\\Hostkind\\hostkind.exe', packaged: true, env: {} }), true);
assert.strictEqual(isPackagedRuntime({ platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe', packaged: false, env: {} }), false);
assert.strictEqual(isPackagedRuntime({ platform: 'win32', execPath: 'C:\\dev\\node.exe', packaged: false, env: { HOSTKIND_BINARY: '1' } }), true);

const stateRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-update-runtime-')));
const statePath = path.join(stateRoot, '.hostkind', 'update-state.json');
const store = createFileStateStore(statePath);
assert.strictEqual(store.read(), null);
store.write('application-update', 'state', { state: 'ready', version: '1.2.3' });
assert.deepStrictEqual(store.read(), { state: 'ready', version: '1.2.3' });
assert.ok(fs.existsSync(statePath));

const runtime = createApplicationUpdateRuntime({
  platform: 'win32',
  arch: 'x64',
  execPath: 'C:\\dev\\node.exe',
  packaged: false,
  env: {},
  currentVersion: '0.1.1',
});
assert.strictEqual(runtime.supported, false);
assert.strictEqual(runtime.platformKey, 'windows-x64');
assert.strictEqual(runtime.service.getStatus().supported, false);
assert.strictEqual(runtime.service.getStatus().state, 'idle');
assert.strictEqual(runtime.service.getStatus().currentVersion, '0.1.1');
assert.strictEqual(runtime.service.getStatus().update, null);

const packagedWithoutKey = createApplicationUpdateRuntime({
  platform: 'win32',
  arch: 'x64',
  execPath: 'C:\\Program Files\\Hostkind\\hostkind.exe',
  packaged: true,
  env: {},
  currentVersion: '0.1.1',
});
assert.strictEqual(packagedWithoutKey.supported, true);
assert.strictEqual(packagedWithoutKey.service.getStatus().state, 'idle');

(async function main() {
  const normalCalls = [];
  const normalScheduler = createApplicationUpdateScheduler({
    service: {
      async check() { normalCalls.push('check'); return { state: 'available', priority: 'normal' }; },
      async download() { normalCalls.push('download'); },
      async install() { normalCalls.push('install'); },
      getStatus() { return { state: 'available', priority: 'normal' }; },
    },
  });
  await normalScheduler.runOnce();
  assert.deepStrictEqual(normalCalls, ['check']);

  const highCalls = [];
  let highState = { state: 'available', priority: 'high' };
  const highScheduler = createApplicationUpdateScheduler({
    service: {
      async check() { highCalls.push('check'); return highState; },
      async download() { highCalls.push('download'); highState = { state: 'ready', priority: 'high' }; },
      async install({ approved }) { highCalls.push(`install:${approved}`); highState = { state: 'restarting', priority: 'high' }; },
      getStatus() { highCalls.push('status'); return highState; },
    },
  });
  await highScheduler.runOnce();
  assert.deepStrictEqual(highCalls, ['check', 'download', 'status', 'install:false']);

  const spawned = [];
  const installer = createBinaryInstaller({
    installRoot: '/opt/hostkind',
    platformKey: 'linux-x64',
    env: {
      HOSTKIND_UPDATE_HELPER: '/opt/hostkind/hostkind-updater',
      HOSTKIND_LAUNCHER_PATH: '/opt/hostkind/hostkind-launcher',
    },
    spawnImpl: (file, args, options) => {
      const child = { unrefCalled: false, unref() { this.unrefCalled = true; } };
      spawned.push({ file, args, options, child });
      return child;
    },
  });
  const expectedSha256 = 'a'.repeat(64);
  await installer.install({
    packagePath: '/opt/hostkind/.hostkind/staging/hostkind',
    version: '1.2.3',
    priority: 'normal',
    expectedSha256,
  });
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(spawned[0].file, '/opt/hostkind/hostkind-updater');
  assert.strictEqual(spawned[0].args[0], '--install-root');
  assert.ok(spawned[0].args.includes('--expected-sha256'));
  assert.ok(spawned[0].args.includes(expectedSha256));
  assert.strictEqual(spawned[0].options.shell, false);
  assert.strictEqual(spawned[0].options.detached, true);
  assert.strictEqual(spawned[0].child.unrefCalled, true);

  const rsaPublicKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey;
  const rsaVerifier = createManifestVerifier(rsaPublicKey);
  await assert.rejects(
    () => rsaVerifier({ manifestSignature: 'AA==' }),
    (error) => error.code === 'VERIFICATION_ERROR' && /Ed25519/i.test(error.message),
  );

  const {
    BUILTIN_UPDATE_PUBLIC_KEY,
  } = require('../lib/application-update-runtime.cjs');
  const builtinKey = crypto.createPublicKey(BUILTIN_UPDATE_PUBLIC_KEY);
  assert.strictEqual(builtinKey.asymmetricKeyType, 'ed25519');
  const builtinVerifier = createManifestVerifier(BUILTIN_UPDATE_PUBLIC_KEY);
  await assert.rejects(
    () => builtinVerifier({ version: '0.1.3.2' }),
    (error) => error.code === 'VERIFICATION_ERROR' && /no detached signature/i.test(error.message),
  );
  await assert.rejects(
    () => builtinVerifier({ version: '0.1.3.2', manifestSignature: Buffer.alloc(64).toString('base64') }),
    (error) => error.code === 'VERIFICATION_ERROR' && /does not match/i.test(error.message),
  );

  const overridePair = crypto.generateKeyPairSync('ed25519');
  const overridePem = overridePair.publicKey.export({ type: 'spki', format: 'pem' });
  const { createUpdateManifest } = require('../scripts/create-update-manifest.cjs');
  const overrideManifest = createUpdateManifest({
    version: '0.1.3.2',
    releaseNotesUrl: 'https://github.com/Riloox/hostkind-open/releases/tag/v0.1.3.2',
    artifacts: {
      'windows-x64': {
        name: 'Hostkind-0.1.3.2-Setup.exe',
        url: 'https://github.com/Riloox/hostkind-open/releases/download/v0.1.3.2/Hostkind-0.1.3.2-Setup.exe',
        sha256: 'b'.repeat(64),
      },
    },
    signingKey: overridePair.privateKey,
  });
  await createManifestVerifier(overridePem)(overrideManifest);
  await assert.rejects(
    () => builtinVerifier(overrideManifest),
    (error) => error.code === 'VERIFICATION_ERROR' && /does not match/i.test(error.message),
  );

  const helperFailures = [];
  const failingInstaller = createBinaryInstaller({
    installRoot: '/opt/hostkind',
    platformKey: 'linux-x64',
    env: { HOSTKIND_UPDATE_HELPER: '/opt/hostkind/missing-helper' },
    stateStore: { write(_namespace, _key, value) { helperFailures.push(value); } },
    spawnImpl: () => ({
      on(event, handler) {
        if (event === 'error') handler(Object.assign(new Error('helper missing'), { code: 'ENOENT' }));
        return this;
      },
      unref() {},
    }),
  });
  await failingInstaller.install({
    packagePath: '/opt/hostkind/.hostkind/staging/hostkind',
    version: '1.2.3',
    priority: 'normal',
    expectedSha256,
  });
  assert.strictEqual(helperFailures[0].state, 'failed');
  assert.strictEqual(helperFailures[0].error.code, 'HELPER_SPAWN_FAILED');

  await assert.rejects(() => runtime.service.check(), (error) => error.code === 'UNSUPPORTED_RUNTIME');
  fs.rmSync(stateRoot, { recursive: true, force: true });
  console.log('PASS application-update-runtime');
})().catch((error) => {
  console.error(error.stack || error);
  fs.rmSync(stateRoot, { recursive: true, force: true });
  process.exitCode = 1;
});
