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
  createDesktopInstaller,
  createParentPortInstallRequester,
  createManifestVerifier,
  createFileStateStore,
  platformKeyFor,
  isDesktopRuntime,
  isPackagedRuntime,
  DESKTOP_RUN_INSTALLER,
  DESKTOP_RUN_INSTALLER_RESULT,
} = require('../lib/application-update-runtime.cjs');
const { validateInstallerRequest, desktopEnvironment, resolveDesktopPaths } = require('../electron/runtime.cjs');

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

  // --- Electron desktop build --------------------------------------------
  // HOSTKIND_DESKTOP_UPDATE marks the packaged desktop backend as supported
  // even though its execPath is the Electron executable.
  assert.strictEqual(isDesktopRuntime({ HOSTKIND_DESKTOP_UPDATE: '1' }), true);
  assert.strictEqual(isPackagedRuntime({ platform: 'win32', execPath: 'C:\\dev\\electron.exe', packaged: false, env: { HOSTKIND_DESKTOP_UPDATE: '1' } }), true);

  const stagingDir = path.join(stateRoot, 'updates');
  fs.mkdirSync(stagingDir, { recursive: true });
  const setupPath = path.join(stagingDir, 'Hostkind-1.2.3-Setup.exe');
  fs.writeFileSync(setupPath, 'fake installer bytes');
  const setupSha = crypto.createHash('sha256').update('fake installer bytes').digest('hex');
  const installRequests = [];
  const desktopInstaller = createDesktopInstaller({
    stagingDir,
    platformKey: 'windows-x64',
    requestInstall: async (request) => { installRequests.push(request); },
  });
  const desktopResult = await desktopInstaller.install({ packagePath: setupPath, version: '1.2.3', expectedSha256: setupSha });
  assert.deepStrictEqual(desktopResult, { ok: true, restarting: true });
  assert.deepStrictEqual(installRequests, [{ installerPath: path.resolve(setupPath), sha256: setupSha, version: '1.2.3' }]);
  await assert.rejects(
    () => desktopInstaller.install({ packagePath: setupPath, version: '1.2.3', expectedSha256: 'b'.repeat(64) }),
    /SHA-256/,
  );
  await assert.rejects(
    () => desktopInstaller.install({ packagePath: path.join(stateRoot, 'Hostkind-1.2.3-Setup.exe'), version: '1.2.3', expectedSha256: setupSha }),
    /outside the update folder/,
  );
  const linuxDesktopInstaller = createDesktopInstaller({ stagingDir, platformKey: 'linux-x64', requestInstall: async () => {} });
  await assert.rejects(
    () => linuxDesktopInstaller.install({ packagePath: setupPath, version: '1.2.3', expectedSha256: setupSha }),
    /only available on Windows/,
  );
  assert.strictEqual(installRequests.length, 1, 'rejected installs never reach the main process');

  // The desktop runtime keeps state and staging out of the install directory.
  const desktopStatePath = path.join(stateRoot, 'desktop', 'application-update.json');
  const desktopRuntime = createApplicationUpdateRuntime({
    platform: 'win32',
    arch: 'x64',
    execPath: 'C:\\Program Files\\Hostkind\\Hostkind.exe',
    packaged: false,
    currentVersion: '1.1.0',
    env: {
      HOSTKIND_DESKTOP_UPDATE: '1',
      HOSTKIND_UPDATE_STATE_PATH: desktopStatePath,
      HOSTKIND_UPDATE_STAGING_DIR: stagingDir,
    },
    requestInstall: async () => {},
    logger: { warn() {} },
  });
  assert.strictEqual(desktopRuntime.supported, true);

  // Parent-port bridge: resolves on the main process's ok, rejects on refusal.
  const posted = [];
  const listeners = [];
  const fakePort = {
    postMessage: (message) => posted.push(message),
    on: (event, handler) => { if (event === 'message') listeners.push(handler); },
  };
  const requestInstall = createParentPortInstallRequester({ parentPort: fakePort, timeoutMs: 1000 });
  const accepted = requestInstall({ installerPath: setupPath, sha256: setupSha, version: '1.2.3' });
  assert.strictEqual(posted[0].type, DESKTOP_RUN_INSTALLER);
  listeners.forEach((handler) => handler({ data: { type: DESKTOP_RUN_INSTALLER_RESULT, id: posted[0].id, ok: true } }));
  await accepted;
  const refused = requestInstall({ installerPath: setupPath, sha256: setupSha, version: '1.2.3' });
  listeners.forEach((handler) => handler({ data: { type: DESKTOP_RUN_INSTALLER_RESULT, id: posted[1].id, ok: false, error: 'nope' } }));
  await assert.rejects(() => refused, (error) => error.code === 'INSTALLER_ERROR' && /nope/.test(error.message));
  await assert.rejects(
    () => createParentPortInstallRequester({ parentPort: null })({ installerPath: setupPath, sha256: setupSha }),
    /bridge is unavailable/,
  );

  // Main-process validation of the installer launch request.
  const validated = await validateInstallerRequest({ message: { installerPath: setupPath, sha256: setupSha }, stagingDir, platform: 'win32' });
  assert.strictEqual(validated, path.resolve(setupPath));
  await assert.rejects(() => validateInstallerRequest({ message: { installerPath: setupPath, sha256: 'c'.repeat(64) }, stagingDir, platform: 'win32' }), /SHA-256/);
  const rogue = path.join(stagingDir, 'evil.exe');
  fs.writeFileSync(rogue, 'fake installer bytes');
  await assert.rejects(() => validateInstallerRequest({ message: { installerPath: rogue, sha256: setupSha }, stagingDir, platform: 'win32' }), /not a Hostkind setup/);
  await assert.rejects(() => validateInstallerRequest({ message: { installerPath: path.join(stateRoot, '..', 'Hostkind-1.2.3-Setup.exe'), sha256: setupSha }, stagingDir, platform: 'win32' }), /outside the update folder/);
  await assert.rejects(() => validateInstallerRequest({ message: { installerPath: setupPath, sha256: setupSha }, stagingDir, platform: 'linux' }), /only supported on Windows/);

  const desktopEnv = desktopEnvironment({ paths: resolveDesktopPaths({ userData: stateRoot, localData: stateRoot, documents: stateRoot }), configPath: 'x', packaged: true });
  assert.strictEqual(desktopEnv.HOSTKIND_DESKTOP_UPDATE, '1');
  assert.ok(desktopEnv.HOSTKIND_UPDATE_STATE_PATH.startsWith(stateRoot));
  assert.ok(desktopEnv.HOSTKIND_UPDATE_STAGING_DIR.startsWith(stateRoot));
  assert.strictEqual(desktopEnvironment({ paths: resolveDesktopPaths({ userData: stateRoot, localData: stateRoot, documents: stateRoot }), configPath: 'x' }).HOSTKIND_DESKTOP_UPDATE, undefined);

  fs.rmSync(stateRoot, { recursive: true, force: true });
  console.log('PASS application-update-runtime');
})().catch((error) => {
  console.error(error.stack || error);
  fs.rmSync(stateRoot, { recursive: true, force: true });
  process.exitCode = 1;
});
