'use strict';

// Core + release-client contract tests for the application updater.
// Contract: .gauntlet/application-updater-contract.md
//
// These tests define the core/release contract implemented by the updater modules:
//   lib/application-release.cjs   -> { createReleaseClient, validateManifest, compareVersions }
//   lib/application-updater.cjs   -> { createApplicationUpdater }
//
// Behaviour-focused: every network/verifier/installer/stateStore/clock dependency
// is injected as a fake. No real GitHub or network access happens here.

const assert = require('assert');

const {
  createReleaseClient,
  validateManifest,
  compareVersions,
} = require('../lib/application-release.cjs');
const { createApplicationUpdater } = require('../lib/application-updater.cjs');

const SHA256 = 'a'.repeat(64);
const MANIFEST_URL =
  'https://github.com/Riloox/hostkind-open/releases/latest/download/manifest.json';
const CLOCK = 1_700_000_000_000;

function updaterError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.isUpdaterError = true;
  return error;
}

function validManifest(overrides) {
  const manifest = Object.assign(
    {
      schema: 1,
      product: 'hostkind',
      edition: 'open',
      version: '1.2.3',
      channel: 'stable',
      priority: 'normal',
      releaseNotesUrl: 'https://github.com/Riloox/hostkind-open/releases/tag/v1.2.3',
      publishedAt: '2026-08-25T12:00:00.000Z',
      artifacts: {
        'windows-x64': {
          name: 'hostkind-1.2.3-windows-x64.exe',
          url: 'https://github.com/Riloox/hostkind-open/releases/download/v1.2.3/hostkind-1.2.3-windows-x64.exe',
          sha256: SHA256,
        },
        'linux-x64': {
          name: 'hostkind-1.2.3-linux-x64',
          url: 'https://github.com/Riloox/hostkind-open/releases/download/v1.2.3/hostkind-1.2.3-linux-x64',
          sha256: SHA256,
        },
      },
      manifestSignature: 'detached-signature',
    },
    overrides || {},
  );
  return manifest;
}

function responseLike({ ok = true, status = 200, body, jsonError, headers = {} } = {}) {
  return {
    ok,
    status,
    headers: {
      get(name) { return headers[String(name).toLowerCase()] || null; },
    },
    async json() {
      if (jsonError) throw jsonError;
      if (typeof body === 'string') return JSON.parse(body);
      return structuredClone(body);
    },
  };
}

function fakeInstaller(overrides) {
  const calls = { download: [], install: [] };
  const installer = Object.assign(
    {
      async download({ artifact, onProgress }) {
        calls.download.push({ artifact, hasProgress: typeof onProgress === 'function' });
        if (typeof onProgress === 'function') onProgress({ percent: 50, downloadedBytes: 1, totalBytes: 2 });
        return { packagePath: 'C:/staged/hostkind-1.2.3-windows-x64.exe' };
      },
      async install(options) {
        calls.install.push(options);
        return { ok: true };
      },
    },
    overrides || {},
  );
  installer.calls = calls;
  return installer;
}

function fakeStateStore(seed) {
  let current = seed === undefined ? null : structuredClone(seed);
  const written = [];
  return {
    written,
    read() {
      return structuredClone(current);
    },
    write(namespace, key, value) {
      current = structuredClone(value);
      written.push(structuredClone(value));
    },
  };
}

function availableResult(overrides) {
  const manifest = validManifest();
  return Object.assign(
    {
      available: true,
      currentVersion: '1.1.0',
      checkedAt: 123,
      manifest,
      artifact: manifest.artifacts['windows-x64'],
      platformKey: 'windows-x64',
    },
    overrides || {},
  );
}

function noUpdateResult() {
  return { available: false, currentVersion: '1.1.0', checkedAt: 123 };
}

function highPriorityResult() {
  const manifest = validManifest({ priority: 'high' });
  return {
    available: true,
    currentVersion: '1.1.0',
    checkedAt: 123,
    manifest,
    artifact: manifest.artifacts['windows-x64'],
    platformKey: 'windows-x64',
  };
}

function makeUpdater({
  releaseClient = { getLatest: async () => availableResult() },
  installer = fakeInstaller(),
  stateStore = fakeStateStore(),
} = {}) {
  return createApplicationUpdater({
    releaseClient,
    installer,
    stateStore,
    platformKey: 'windows-x64',
    currentVersion: '1.1.0',
    now: () => CLOCK,
  });
}

(async function main() {
  // ---------------------------------------------------------------------------
  // 1. Strict stable semver comparison (never string comparison)
  // ---------------------------------------------------------------------------
  assert.strictEqual(compareVersions('1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('1.2.4', '1.2.3') > 0);
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
  assert.ok(compareVersions('0.9.9', '1.0.0') < 0);
  assert.ok(
    compareVersions('1.10.0', '1.9.9') > 0,
    '1.10.0 must sort after 1.9.9; lexicographic comparison would sort 1.9.9 last',
  );
  assert.ok(compareVersions('1.9.9', '1.10.0') < 0);
  assert.throws(() => compareVersions('1.2', '1.2.3'), /(semver|version)/i);
  assert.throws(() => compareVersions('v1.2.3', '1.2.3'), /(semver|version)/i);
  assert.throws(() => compareVersions('1.2.3-beta.1', '1.2.3'), /(semver|version)/i);

  // ---------------------------------------------------------------------------
  // 2. Manifest validation: accepted shape
  // ---------------------------------------------------------------------------
  const validated = validateManifest(validManifest(), { platformKey: 'windows-x64' });
  assert.strictEqual(validated.version, '1.2.3');
  assert.strictEqual(validated.artifacts['windows-x64'].sha256, SHA256);

  const linuxValidated = validateManifest(validManifest(), { platformKey: 'linux-x64' });
  assert.strictEqual(linuxValidated.artifacts['linux-x64'].name, 'hostkind-1.2.3-linux-x64');

  // 3. Manifest validation: fail closed (all throw VALIDATION_ERROR)
  function expectValidationError(manifest, options) {
    assert.throws(
      () => validateManifest(manifest, options || { platformKey: 'windows-x64' }),
      (error) => error instanceof Error && error.code === 'VALIDATION_ERROR' && error.isUpdaterError === true,
      `expected VALIDATION_ERROR for manifest ${JSON.stringify(manifest)}`,
    );
  }

  expectValidationError(validManifest({ schema: 2 })); // unsupported schema
  expectValidationError(validManifest({ schema: undefined }));
  expectValidationError(validManifest({ product: 'hostkind-closed' })); // wrong product
  expectValidationError(validManifest({ product: undefined }));
  expectValidationError(validManifest({ edition: 'pro' })); // wrong edition
  expectValidationError(validManifest({ channel: 'beta' })); // prerelease channel out of scope
  expectValidationError(validManifest({ version: '1.2.3-beta.1' })); // prerelease version
  expectValidationError(validManifest({ version: '1.2.3+build.5' })); // build suffix
  expectValidationError(validManifest({ version: 'v1.2.3' }));
  expectValidationError(validManifest({ version: '1.2' }));
  expectValidationError(validManifest({ version: '01.2.3' }));
  expectValidationError(validManifest({ priority: 'urgent' })); // priority must be normal|high
  expectValidationError(validManifest({ priority: undefined }));
  expectValidationError(validManifest({
    releaseNotesUrl: 'http://github.com/Riloox/hostkind-open/releases/tag/v1.2.3',
  })); // releaseNotesUrl must be HTTPS
  expectValidationError(validManifest({ artifacts: undefined }));
  expectValidationError(validManifest(), { platformKey: 'macos-arm64' }); // unsupported platform

  const missingWindowsArtifact = validManifest();
  delete missingWindowsArtifact.artifacts['windows-x64'];
  expectValidationError(missingWindowsArtifact); // selected platform has no artifact

  function artifactMutation(mutate) {
    const manifest = validManifest();
    mutate(manifest.artifacts['windows-x64']);
    return manifest;
  }

  expectValidationError(artifactMutation((a) => {
    a.url = 'http://github.com/Riloox/hostkind-open/releases/download/v1.2.3/x.exe';
  })); // artifact URL must be HTTPS
  expectValidationError(artifactMutation((a) => {
    a.url = 'https://evil.example/hostkind.exe';
  })); // artifact URL must be an allowed GitHub release origin
  expectValidationError(artifactMutation((a) => {
    a.url = 'https://github.com/SomeoneElse/hostkind-open/releases/download/v1.2.3/x.exe';
  })); // wrong repository owner
  expectValidationError(artifactMutation((a) => {
    a.url = 'https://github.com/Riloox/hostkind-open/raw/main/x.exe';
  })); // not a /releases/ origin
  expectValidationError(artifactMutation((a) => {
    a.url = 'https://github.com:443/Riloox/hostkind-open/releases/download/v1.2.3/x.exe';
  })); // non-default port is not the trusted authority
  expectValidationError(artifactMutation((a) => {
    a.url = 'https://attacker:secret@github.com/Riloox/hostkind-open/releases/download/v1.2.3/x.exe';
  })); // userinfo is not the trusted authority
  expectValidationError(artifactMutation((a) => { a.name = '..\\..\\evil.exe'; })); // path traversal
  expectValidationError(artifactMutation((a) => { a.name = 'a/b.exe'; })); // path separator
  expectValidationError(artifactMutation((a) => { a.name = 'evil\u0000.exe'; })); // control char
  expectValidationError(artifactMutation((a) => { a.name = undefined; }));
  expectValidationError(artifactMutation((a) => { a.sha256 = 'A'.repeat(64); })); // not lowercase hex
  expectValidationError(artifactMutation((a) => { a.sha256 = 'abc123'; })); // wrong length
  expectValidationError(artifactMutation((a) => { a.sha256 = 'z'.repeat(64); })); // not hex
  expectValidationError(artifactMutation((a) => { a.sha256 = undefined; }));

  assert.throws(
    () => createReleaseClient({
      fetchImpl: async () => responseLike({ body: validManifest() }),
      repository: 'Riloox/hostkind-open',
      manifestUrl: 'https://evil.example/hostkind-update.json',
      verifyManifest: async () => {},
    }),
    (error) => error && error.code === 'VALIDATION_ERROR',
    'manifest URL must be constrained to the trusted GitHub release repository',
  );

  // ---------------------------------------------------------------------------
  // 4. Release client: available result
  // ---------------------------------------------------------------------------
  const fetched = [];
  const verified = [];
  const client = createReleaseClient({
    fetchImpl: async (url) => {
      fetched.push(url);
      return responseLike({ body: validManifest() });
    },
    repository: 'Riloox/hostkind-open',
    manifestUrl: MANIFEST_URL,
    verifyManifest: async (manifest) => {
      verified.push(manifest.version);
      return manifest;
    },
  });

  const result = await client.getLatest({ platformKey: 'windows-x64', currentVersion: '1.1.0' });
  assert.deepStrictEqual(fetched, [MANIFEST_URL]);
  assert.deepStrictEqual(verified, ['1.2.3']);
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.currentVersion, '1.1.0');
  assert.strictEqual(result.platformKey, 'windows-x64');
  assert.strictEqual(result.manifest.version, '1.2.3');
  assert.strictEqual(result.artifact.name, 'hostkind-1.2.3-windows-x64.exe');
  assert.strictEqual(result.artifact.sha256, SHA256);
  assert.ok(result.artifact.url.startsWith('https://github.com/Riloox/hostkind-open/releases/'));
  assert.ok(Number.isFinite(result.checkedAt) && result.checkedAt > 0);

  const etagCalls = [];
  const etagClient = createReleaseClient({
    fetchImpl: async (url, options = {}) => {
      etagCalls.push({ url, headers: options.headers || {} });
      if (etagCalls.length === 1) return responseLike({ body: validManifest(), headers: { etag: '"manifest-v1"' } });
      return responseLike({ ok: false, status: 304 });
    },
    repository: 'Riloox/hostkind-open',
    manifestUrl: MANIFEST_URL,
    verifyManifest: async (manifest) => manifest,
  });
  await etagClient.getLatest({ platformKey: 'windows-x64', currentVersion: '1.1.0' });
  const cachedEtagResult = await etagClient.getLatest({ platformKey: 'windows-x64', currentVersion: '1.1.0' });
  assert.strictEqual(cachedEtagResult.available, true);
  assert.strictEqual(etagCalls[1].headers['If-None-Match'], '"manifest-v1"');

  const linuxResult = await client.getLatest({ platformKey: 'linux-x64', currentVersion: '1.1.0' });
  assert.strictEqual(linuxResult.available, true);
  assert.strictEqual(linuxResult.artifact.name, 'hostkind-1.2.3-linux-x64');

  // 5. Release client: no update / downgrade (semver-aware)
  const same = await client.getLatest({ platformKey: 'windows-x64', currentVersion: '1.2.3' });
  assert.strictEqual(same.available, false);
  assert.strictEqual(same.currentVersion, '1.2.3');
  assert.ok(Number.isFinite(same.checkedAt));
  assert.strictEqual(same.manifest, undefined);

  const newer = await client.getLatest({ platformKey: 'windows-x64', currentVersion: '1.3.0' });
  assert.strictEqual(newer.available, false);

  const semverClient = createReleaseClient({
    fetchImpl: async () => responseLike({
      body: validManifest({
        version: '1.9.9',
        releaseNotesUrl: 'https://github.com/Riloox/hostkind-open/releases/tag/v1.9.9',
      }),
    }),
    repository: 'Riloox/hostkind-open',
    manifestUrl: MANIFEST_URL,
    verifyManifest: async (manifest) => manifest,
  });
  const stringTrap = await semverClient.getLatest({ platformKey: 'windows-x64', currentVersion: '1.10.0' });
  assert.strictEqual(
    stringTrap.available,
    false,
    '1.10.0 is newer than 1.9.9; a lexicographic compare would wrongly report an update',
  );

  // 6. Release client: network / JSON / validation / verification failures are
  //    typed errors, never { available: false }
  const networkClient = createReleaseClient({
    fetchImpl: async () => {
      throw new Error('connection refused');
    },
    repository: 'Riloox/hostkind-open',
    manifestUrl: MANIFEST_URL,
    verifyManifest: async (manifest) => manifest,
  });
  await assert.rejects(
    () => networkClient.getLatest({ platformKey: 'windows-x64', currentVersion: '1.1.0' }),
    (error) => error instanceof Error && error.code === 'NETWORK_ERROR' && error.isUpdaterError === true,
  );

  const httpErrorClient = createReleaseClient({
    fetchImpl: async () => responseLike({ ok: false, status: 503 }),
    repository: 'Riloox/hostkind-open',
    manifestUrl: MANIFEST_URL,
    verifyManifest: async (manifest) => manifest,
  });
  await assert.rejects(
    () => httpErrorClient.getLatest({ platformKey: 'windows-x64', currentVersion: '1.1.0' }),
    { code: 'NETWORK_ERROR' },
  );

  const jsonClient = createReleaseClient({
    fetchImpl: async () => responseLike({
      body: '<html>not a manifest</html>',
    }),
    repository: 'Riloox/hostkind-open',
    manifestUrl: MANIFEST_URL,
    verifyManifest: async (manifest) => manifest,
  });
  await assert.rejects(
    () => jsonClient.getLatest({ platformKey: 'windows-x64', currentVersion: '1.1.0' }),
    { code: 'JSON_ERROR' },
  );

  const validationClient = createReleaseClient({
    fetchImpl: async () => responseLike({ body: validManifest({ version: '1.2.3-beta.1' }) }),
    repository: 'Riloox/hostkind-open',
    manifestUrl: MANIFEST_URL,
    verifyManifest: async (manifest) => manifest,
  });
  await assert.rejects(
    () => validationClient.getLatest({ platformKey: 'windows-x64', currentVersion: '1.1.0' }),
    { code: 'VALIDATION_ERROR' },
  );

  const verificationClient = createReleaseClient({
    fetchImpl: async () => responseLike({ body: validManifest() }),
    repository: 'Riloox/hostkind-open',
    manifestUrl: MANIFEST_URL,
    verifyManifest: async () => {
      throw new Error('detached signature does not match canonical JSON');
    },
  });
  await assert.rejects(
    () => verificationClient.getLatest({ platformKey: 'windows-x64', currentVersion: '1.1.0' }),
    (error) => error instanceof Error && error.code === 'VERIFICATION_ERROR' && error.isUpdaterError === true,
  );

  // ---------------------------------------------------------------------------
  // 7. Updater service: initial status and check() transitions
  // ---------------------------------------------------------------------------
  const idleUpdater = makeUpdater();
  assert.strictEqual(idleUpdater.getStatus().state, 'idle');

  let resolveCheck;
  const deferredClient = {
    getLatest: () => new Promise((resolve) => {
      resolveCheck = resolve;
    }),
  };
  const checkingUpdater = makeUpdater({ releaseClient: deferredClient });
  const pendingCheck = checkingUpdater.check();
  assert.strictEqual(checkingUpdater.getStatus().state, 'checking');
  resolveCheck(availableResult());
  const checkedStatus = await pendingCheck;
  assert.strictEqual(checkedStatus.state, 'available');
  assert.strictEqual(checkedStatus.availableVersion, '1.2.3');
  assert.strictEqual(checkingUpdater.getStatus().state, 'available');
  assert.strictEqual(checkingUpdater.getStatus().checkedAt, CLOCK, 'status stamps the injected clock');

  const noUpdateUpdater = makeUpdater({
    releaseClient: { getLatest: async () => noUpdateResult() },
  });
  await noUpdateUpdater.check();
  assert.strictEqual(noUpdateUpdater.getStatus().state, 'idle');

  // 8. Updater service: check() failure is a typed error, never "no update"
  const networkFailureStore = fakeStateStore();
  const networkFailureUpdater = makeUpdater({
    releaseClient: {
      getLatest: async () => {
        throw updaterError('NETWORK_ERROR', 'offline');
      },
    },
    stateStore: networkFailureStore,
  });
  await assert.rejects(
    () => networkFailureUpdater.check(),
    (error) => error instanceof Error && error.code === 'NETWORK_ERROR' && error.isUpdaterError === true,
  );
  assert.strictEqual(networkFailureUpdater.getStatus().state, 'failed');
  assert.strictEqual(networkFailureStore.written[networkFailureStore.written.length - 1].state, 'failed');

  const validationFailureUpdater = makeUpdater({
    releaseClient: {
      getLatest: async () => {
        throw updaterError('VALIDATION_ERROR', 'manifest invalid');
      },
    },
  });
  await assert.rejects(() => validationFailureUpdater.check(), { code: 'VALIDATION_ERROR' });
  assert.strictEqual(validationFailureUpdater.getStatus().state, 'failed');

  // 9. Updater service: download() transitions and installer wiring
  const readyStore = fakeStateStore();
  const readyInstaller = fakeInstaller();
  const readyUpdater = makeUpdater({ installer: readyInstaller, stateStore: readyStore });
  await readyUpdater.check();
  await readyUpdater.download();
  assert.strictEqual(readyUpdater.getStatus().state, 'ready');
  assert.strictEqual(readyInstaller.calls.download.length, 1);
  assert.strictEqual(readyInstaller.calls.download[0].artifact.name, 'hostkind-1.2.3-windows-x64.exe');
  assert.strictEqual(readyInstaller.calls.download[0].artifact.sha256, SHA256);
  assert.ok(readyInstaller.calls.download[0].hasProgress, 'installer receives an onProgress callback');
  assert.strictEqual(readyInstaller.calls.install.length, 0, 'downloading must never install');
  assert.strictEqual(readyStore.written[readyStore.written.length - 1].state, 'ready');

  let resolveDownload;
  const midDownloadInstaller = fakeInstaller({
    async download(options) {
      midDownloadInstaller.calls.download.push(options);
      return new Promise((resolve) => {
        resolveDownload = () => resolve({ packagePath: 'C:/staged/hostkind-1.2.3-windows-x64.exe' });
      });
    },
  });
  const midDownloadUpdater = makeUpdater({ installer: midDownloadInstaller });
  await midDownloadUpdater.check();
  const pendingDownload = midDownloadUpdater.download();
  assert.strictEqual(midDownloadUpdater.getStatus().state, 'downloading');
  resolveDownload();
  await pendingDownload;
  assert.strictEqual(midDownloadUpdater.getStatus().state, 'ready');

  // 10. Updater service: download() failure fails closed
  const failedStore = fakeStateStore();
  const failedInstaller = fakeInstaller({
    async download() {
      throw new Error('checksum mismatch');
    },
  });
  const failedUpdater = makeUpdater({ installer: failedInstaller, stateStore: failedStore });
  await failedUpdater.check();
  await assert.rejects(() => failedUpdater.download(), (error) => error instanceof Error);
  assert.strictEqual(failedUpdater.getStatus().state, 'failed');
  assert.strictEqual(failedStore.written[failedStore.written.length - 1].state, 'failed');

  // 11. Updater service: normal updates require explicit approval
  const approvalStore = fakeStateStore();
  const approvalInstaller = fakeInstaller();
  const approvalUpdater = makeUpdater({ installer: approvalInstaller, stateStore: approvalStore });
  await approvalUpdater.check();
  await approvalUpdater.download();
  await assert.rejects(
    () => approvalUpdater.install({}),
    (error) => error instanceof Error && error.code === 'APPROVAL_REQUIRED' && error.isUpdaterError === true,
  );
  await assert.rejects(() => approvalUpdater.install({ approved: false }), { code: 'APPROVAL_REQUIRED' });
  assert.strictEqual(approvalInstaller.calls.install.length, 0, 'unapproved install must not reach the installer');
  assert.strictEqual(approvalUpdater.getStatus().state, 'ready');
  assert.strictEqual(approvalStore.written[approvalStore.written.length - 1].state, 'ready');
  // Approval rejection is non-destructive: an approved install still works.
  await approvalUpdater.install({ approved: true });
  assert.strictEqual(approvalUpdater.getStatus().state, 'restarting');

  // 12. Updater service: approved normal install
  const installStore = fakeStateStore();
  let resolveInstall;
  const installInstaller = fakeInstaller({
    async install(options) {
      installInstaller.calls.install.push(options);
      return new Promise((resolve) => {
        resolveInstall = () => resolve({ ok: true });
      });
    },
  });
  const installUpdater = makeUpdater({ installer: installInstaller, stateStore: installStore });
  await installUpdater.check();
  await installUpdater.download();
  const pendingInstall = installUpdater.install({ approved: true });
  assert.strictEqual(installUpdater.getStatus().state, 'installing');
  resolveInstall();
  await pendingInstall;
  assert.strictEqual(installUpdater.getStatus().state, 'restarting');
  assert.strictEqual(installInstaller.calls.install.length, 1);
  const installOptions = installInstaller.calls.install[0];
  assert.strictEqual(installOptions.version, '1.2.3');
  assert.strictEqual(installOptions.priority, 'normal');
  assert.strictEqual(typeof installOptions.packagePath, 'string');
  assert.ok(installOptions.packagePath.length > 0);
  assert.strictEqual(installStore.written[installStore.written.length - 1].state, 'restarting');

  // 13. Updater service: high-priority safe-install path (no approval, installer boundary intact)
  const highStore = fakeStateStore();
  const highInstaller = fakeInstaller();
  const highUpdater = makeUpdater({
    releaseClient: { getLatest: async () => highPriorityResult() },
    installer: highInstaller,
    stateStore: highStore,
  });
  await highUpdater.check();
  await highUpdater.download();
  await highUpdater.install({ approved: false });
  assert.strictEqual(highInstaller.calls.install.length, 1, 'high priority install must still go through the installer');
  assert.strictEqual(highInstaller.calls.install[0].priority, 'high');
  assert.strictEqual(highUpdater.getStatus().state, 'restarting');
  assert.strictEqual(highStore.written[highStore.written.length - 1].state, 'restarting');

  // 14. Updater service: invalid transitions reject with INVALID_TRANSITION
  const idleInstallUpdater = makeUpdater();
  await assert.rejects(
    () => idleInstallUpdater.install({ approved: true }),
    (error) => error instanceof Error && error.code === 'INVALID_TRANSITION' && error.isUpdaterError === true,
  );

  const idleDownloadInstaller = fakeInstaller();
  const idleDownloadUpdater = makeUpdater({ installer: idleDownloadInstaller });
  await assert.rejects(() => idleDownloadUpdater.download(), { code: 'INVALID_TRANSITION' });
  assert.strictEqual(idleDownloadInstaller.calls.download.length, 0);
  assert.strictEqual(idleDownloadUpdater.getStatus().state, 'idle');

  const notReadyInstaller = fakeInstaller();
  const notReadyUpdater = makeUpdater({ installer: notReadyInstaller });
  await notReadyUpdater.check(); // available, but nothing downloaded yet
  await assert.rejects(() => notReadyUpdater.install({ approved: true }), { code: 'INVALID_TRANSITION' });
  assert.strictEqual(notReadyInstaller.calls.install.length, 0);
  assert.strictEqual(notReadyUpdater.getStatus().state, 'available');

  // 15. Updater service: durable state survives a restart
  const durableStore = fakeStateStore();
  const firstProcess = makeUpdater({ stateStore: durableStore });
  await firstProcess.check();
  await firstProcess.download();
  const restartedProcess = makeUpdater({ stateStore: durableStore });
  assert.strictEqual(restartedProcess.getStatus().state, 'ready', 'persisted state must survive a restart');

  const seededStore = fakeStateStore({ state: 'failed', updatedAt: CLOCK });
  const seededUpdater = makeUpdater({ stateStore: seededStore });
  assert.strictEqual(seededUpdater.getStatus().state, 'failed');

  console.log('PASS application-updater-core');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});