'use strict';

/*
 * Application updater — binary installer & bootstrap safety tests.
 *
 * Owned by the binary/bootstrap agent wave (see
 * .gauntlet/application-updater-contract.md, "Binary/bootstrap agent"):
 *
 *   - scripts/apply-application-update.cjs
 *   - scripts/hostkind-bootstrap.cjs
 *
 * This suite is RED by design while those scripts do not exist yet. It pins
 * the helper behavior of the binary installer only — nothing here replaces
 * the running application, spawns a long-running process, touches the
 * network, or mutates git. Every process/filesystem seam is injectable:
 *
 *   fsImpl      -> defaults to require('fs')
 *   cryptoImpl  -> defaults to require('crypto')
 *   sleepImpl   -> defaults to a setTimeout promise
 *   relaunch    -> injected into createBootstrap(); the real default must
 *                  use child_process.spawn with an argument array and
 *                  shell:false, never a shell string
 *
 * Layout contract (installRoot):
 *
 *   <installRoot>/versions/<version>/   versioned executable directory
 *   <installRoot>/current.json          atomic current-version marker
 *                                       { "version": "x.y.z" }, promoted via
 *                                       temp file + rename so a failed swap
 *                                       leaves the previous selection intact
 *   <installRoot>/data/, <installRoot>/config/
 *                                       preserved user data/config, always
 *                                       outside any versions/<version>/ dir
 *
 * Error contract: helper failures throw Error subclasses with a `.code`
 * property, one of:
 *
 *   unsupported_platform, insecure_artifact_url, disallowed_artifact_origin,
 *   unsafe_artifact_name, invalid_artifact_sha256, checksum_mismatch,
 *   staged_missing, invalid_version, promotion_failed, data_path_inside_install,
 *   exit_timeout
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TMP_ROOT, teardown } = require('./_setup.cjs');

// RED: neither script exists yet in the binary/bootstrap wave.
const applyUpdate = require('../scripts/apply-application-update.cjs');
const bootstrap = require('../scripts/hostkind-bootstrap.cjs');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function makeArtifacts(overrides = {}) {
  return Object.assign(
    {
      'windows-x64': {
        name: 'hostkind-1.2.3-windows-x64.exe',
        url: 'https://github.com/Riloox/hostkind-open/releases/download/v1.2.3/hostkind-1.2.3-windows-x64.exe',
        sha256: 'a'.repeat(64)
      },
      'linux-x64': {
        name: 'hostkind-1.2.3-linux-x64',
        url: 'https://github.com/Riloox/hostkind-open/releases/download/v1.2.3/hostkind-1.2.3-linux-x64',
        sha256: 'b'.repeat(64)
      }
    },
    overrides
  );
}

// --- platform artifact key selection -------------------------------------

test('selectPlatformArtifact picks the windows-x64 artifact', () => {
  const artifacts = makeArtifacts();
  const picked = applyUpdate.selectPlatformArtifact(artifacts, 'windows-x64');
  assert.strictEqual(picked.name, 'hostkind-1.2.3-windows-x64.exe');
  assert.strictEqual(picked.sha256.length, 64);
});

test('selectPlatformArtifact picks the linux-x64 artifact and rejects unknown platforms', () => {
  const artifacts = makeArtifacts();
  assert.strictEqual(
    applyUpdate.selectPlatformArtifact(artifacts, 'linux-x64').name,
    'hostkind-1.2.3-linux-x64'
  );
  assert.throws(
    () => applyUpdate.selectPlatformArtifact(artifacts, 'darwin-x64'),
    (error) => error.code === 'unsupported_platform'
  );
  assert.throws(
    () => applyUpdate.selectPlatformArtifact(artifacts, 'linux-arm64'),
    (error) => error.code === 'unsupported_platform'
  );
  assert.throws(
    () => applyUpdate.selectPlatformArtifact({}, 'windows-x64'),
    (error) => error.code === 'unsupported_platform'
  );
});

// --- artifact metadata safety --------------------------------------------

test('validateArtifact accepts a well-formed GitHub-release artifact', () => {
  const artifact = makeArtifacts()['linux-x64'];
  const validated = applyUpdate.validateArtifact(artifact);
  assert.strictEqual(validated.name, artifact.name);
  assert.strictEqual(validated.url, artifact.url);
  assert.strictEqual(validated.sha256, artifact.sha256);
});

test('validateArtifact rejects non-HTTPS artifact URLs', () => {
  const base = () => makeArtifacts()['linux-x64'];
  for (const url of [
    'http://github.com/Riloox/hostkind-open/releases/download/v1.2.3/hostkind',
    'ftp://github.com/Riloox/hostkind-open/releases/download/v1.2.3/hostkind',
    'https:///Riloox/hostkind-open/releases/download/v1.2.3/hostkind'
  ]) {
    assert.throws(
      () => applyUpdate.validateArtifact(Object.assign(base(), { url })),
      (error) => error.code === 'insecure_artifact_url',
      `expected insecure_artifact_url for ${url}`
    );
  }
});

test('validateArtifact rejects artifact URLs outside the allowed GitHub release origin', () => {
  const base = () => makeArtifacts()['linux-x64'];
  for (const url of [
    'https://evil.example/payload',
    'https://github.com:443/Riloox/hostkind-open/releases/download/v1.2.3/hostkind',
    'https://attacker:secret@github.com/Riloox/hostkind-open/releases/download/v1.2.3/hostkind',
    'https://github.com/OtherOrg/other/releases/download/v1.2.3/hostkind',
    'https://github.com/Riloox/hostkind-open/raw/main/hostkind',
    'https://github.com/Riloox/hostkind-open/releases/page/2'
  ]) {
    assert.throws(
      () => applyUpdate.validateArtifact(Object.assign(base(), { url })),
      (error) => error.code === 'disallowed_artifact_origin',
      `expected disallowed_artifact_origin for ${url}`
    );
  }
});

test('validateArtifact rejects artifact names with separators, control characters, or empty names', () => {
  const base = () => makeArtifacts()['linux-x64'];
  for (const name of ['../evil.exe', 'a/b.exe', 'a\\b.exe', 'evil\u0000.exe', 'evil\u0001.exe', '']) {
    assert.throws(
      () => applyUpdate.validateArtifact(Object.assign(base(), { name })),
      (error) => error.code === 'unsafe_artifact_name',
      `expected unsafe_artifact_name for ${JSON.stringify(name)}`
    );
  }
});

test('validateArtifact rejects SHA-256 values that are not 64 lowercase hex characters', () => {
  const base = () => makeArtifacts()['linux-x64'];
  for (const sha256 of ['a'.repeat(63), 'A'.repeat(64), 'a'.repeat(63) + 'Z', 'a'.repeat(64).toUpperCase(), 'g'.repeat(64)]) {
    assert.throws(
      () => applyUpdate.validateArtifact(Object.assign(base(), { sha256 })),
      (error) => error.code === 'invalid_artifact_sha256',
      `expected invalid_artifact_sha256 for ${sha256}`
    );
  }
});

// --- staged executable checksum verification ------------------------------

test('verifyStagedChecksum verifies a real staged file and fails closed on mismatch or missing file', () => {
  const dir = path.join(TMP_ROOT, 'updater-checksum');
  fs.mkdirSync(dir, { recursive: true });
  const stagedPath = path.join(dir, 'hostkind-1.2.3-linux-x64');
  const content = Buffer.from('hostkind-binary-v1.2.3');
  fs.writeFileSync(stagedPath, content);
  const expected = crypto.createHash('sha256').update(content).digest('hex');

  const ok = applyUpdate.verifyStagedChecksum({ stagedPath, expectedSha256: expected });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.sha256, expected);

  assert.throws(
    () => applyUpdate.verifyStagedChecksum({ stagedPath, expectedSha256: 'f'.repeat(64) }),
    (error) => error.code === 'checksum_mismatch'
  );
  assert.throws(
    () => applyUpdate.verifyStagedChecksum({ stagedPath: path.join(dir, 'does-not-exist'), expectedSha256: expected }),
    (error) => error.code === 'staged_missing'
  );
});

test('verifyStagedChecksum honors injected fsImpl and cryptoImpl seams', () => {
  const calls = [];
  const fakeFs = {
    readFileSync: (p) => {
      calls.push(['readFileSync', p]);
      return Buffer.from('staged-bytes-xyz');
    }
  };
  const fakeCrypto = {
    createHash: (algorithm) => {
      calls.push(['createHash', algorithm]);
      return { update: () => fakeCrypto.hash, digest: () => '0'.repeat(64) };
    }
  };
  fakeCrypto.hash = { update: () => fakeCrypto.hash, digest: () => '0'.repeat(64) };

  const result = applyUpdate.verifyStagedChecksum({
    stagedPath: path.join(TMP_ROOT, 'seam-staged.exe'),
    expectedSha256: '0'.repeat(64),
    fsImpl: fakeFs,
    cryptoImpl: fakeCrypto
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.sha256, '0'.repeat(64));
  assert.strictEqual(calls.some(([name]) => name === 'readFileSync'), true);
  assert.strictEqual(calls.some(([name, algorithm]) => name === 'createHash' && algorithm === 'sha256'), true);
});

// --- versioned install directory -------------------------------------------

test('createVersionedInstallDir creates <installRoot>/versions/<version> and rejects non-strict-semver versions', () => {
  const root = path.join(TMP_ROOT, 'updater-install-dir');
  fs.mkdirSync(root, { recursive: true });
  const result = applyUpdate.createVersionedInstallDir({ installRoot: root, version: '1.2.3' });
  assert.strictEqual(result.installDir, path.join(root, 'versions', '1.2.3'));
  assert.strictEqual(fs.existsSync(result.installDir), true);
  assert.strictEqual(fs.statSync(result.installDir).isDirectory(), true);

  for (const version of ['1.2.3-beta.1', 'v1.2.3', '01.2.3', '1.2', '1.2.3.4', '1.2.3+build']) {
    assert.throws(
      () => applyUpdate.createVersionedInstallDir({ installRoot: root, version }),
      (error) => error.code === 'invalid_version',
      `expected invalid_version for ${version}`
    );
  }
});

test('createVersionedInstallDir honors an injected fsImpl seam', () => {
  const calls = [];
  const fakeFs = {
    mkdirSync: (dir, options) => {
      calls.push([dir, options]);
      return dir;
    }
  };
  const target = path.join(TMP_ROOT, 'seam-install-dir', 'versions', '2.0.0');
  const result = applyUpdate.createVersionedInstallDir({ installRoot: path.join(TMP_ROOT, 'seam-install-dir'), version: '2.0.0', fsImpl: fakeFs });
  assert.strictEqual(result.installDir, target);
  assert.deepStrictEqual(calls, [[target, { recursive: true }]]);
});

// --- atomic current-version marker ------------------------------------------

test('promoteVersion + readCurrentVersion round-trip leaves exactly one marker and no stray temp files', () => {
  const root = path.join(TMP_ROOT, 'updater-marker');
  fs.mkdirSync(root, { recursive: true });
  assert.strictEqual(applyUpdate.readCurrentVersion({ installRoot: root }), null);

  applyUpdate.promoteVersion({ installRoot: root, version: '1.2.3' });
  assert.strictEqual(applyUpdate.readCurrentVersion({ installRoot: root }), '1.2.3');

  applyUpdate.promoteVersion({ installRoot: root, version: '2.0.0' });
  assert.strictEqual(applyUpdate.readCurrentVersion({ installRoot: root }), '2.0.0');

  const markers = fs.readdirSync(root).filter((entry) => entry.startsWith('current.json'));
  assert.deepStrictEqual(markers, ['current.json']);
});

test('a failed promotion leaves the previous current version selected', () => {
  const root = path.join(TMP_ROOT, 'updater-marker-failure');
  fs.mkdirSync(root, { recursive: true });
  applyUpdate.promoteVersion({ installRoot: root, version: '1.0.0' });
  assert.strictEqual(applyUpdate.readCurrentVersion({ installRoot: root }), '1.0.0');

  // Promotion must go through an atomic rename of a temp marker: a failed
  // swap must throw promotion_failed and never disturb current.json.
  const breakingFs = Object.create(fs);
  breakingFs.renameSync = () => {
    throw new Error('simulated rename failure');
  };
  assert.throws(
    () => applyUpdate.promoteVersion({ installRoot: root, version: '9.9.9', fsImpl: breakingFs }),
    (error) => error.code === 'promotion_failed'
  );
  assert.strictEqual(applyUpdate.readCurrentVersion({ installRoot: root }), '1.0.0');
});

// --- preserved data/config paths ---------------------------------------------

test('resolveInstallLayout keeps data/config outside the versioned install directory', () => {
  const root = path.join(TMP_ROOT, 'updater-layout');
  fs.mkdirSync(root, { recursive: true });
  const layout = applyUpdate.resolveInstallLayout({ installRoot: root, version: '1.2.3', dataPaths: [] });
  assert.strictEqual(layout.installDir, path.join(root, 'versions', '1.2.3'));

  const byName = new Map(layout.preserved.map((entry) => [entry.name, entry.path]));
  assert.strictEqual(byName.get('data'), path.join(root, 'data'));
  assert.strictEqual(byName.get('config'), path.join(root, 'config'));
  for (const entry of layout.preserved) {
    const relative = path.relative(layout.installDir, entry.path);
    assert.strictEqual(relative.startsWith('..'), true, `${entry.path} must live outside ${layout.installDir}`);
  }
});

test('resolveInstallLayout fails closed when a data path would land inside the versioned install directory', () => {
  const root = path.join(TMP_ROOT, 'updater-layout-hostile');
  fs.mkdirSync(root, { recursive: true });
  const installDir = path.join(root, 'versions', '1.2.3');
  assert.throws(
    () =>
      applyUpdate.resolveInstallLayout({
        installRoot: root,
        version: '1.2.3',
        dataPaths: [{ name: 'server-data', path: path.join(installDir, 'server-data') }]
      }),
    (error) => error.code === 'data_path_inside_install'
  );
});

// --- launcher command construction (never shell interpolation) ---------------

test('buildLaunchCommand returns explicit argument arrays for Windows and Linux', () => {
  const windows = bootstrap.buildLaunchCommand({
    platformKey: 'windows-x64',
    launcherPath: 'C:\\hostkind\\launcher.exe',
    installDir: 'C:\\hostkind\\versions\\1.2.3',
    args: ['--serve']
  });
  assert.strictEqual(Array.isArray(windows), true);
  assert.deepStrictEqual(windows, ['C:\\hostkind\\launcher.exe', 'C:\\hostkind\\versions\\1.2.3\\hostkind.exe', '--serve']);

  const linux = bootstrap.buildLaunchCommand({
    platformKey: 'linux-x64',
    launcherPath: '/opt/hostkind/launcher',
    installDir: '/opt/hostkind/versions/1.2.3',
    args: []
  });
  assert.strictEqual(Array.isArray(linux), true);
  assert.deepStrictEqual(linux, ['/opt/hostkind/launcher', '/opt/hostkind/versions/1.2.3/hostkind']);

  assert.throws(
    () => bootstrap.buildLaunchCommand({ platformKey: 'darwin-arm64', launcherPath: '/x', installDir: '/y' }),
    (error) => error.code === 'unsupported_platform'
  );
});

test('buildLaunchCommand treats hostile strings as literal arguments, never as shell syntax', () => {
  const cmd = bootstrap.buildLaunchCommand({
    platformKey: 'linux-x64',
    launcherPath: '/opt/hostkind/launcher',
    installDir: '/opt/hostkind/versions/1.2.3; rm -rf /',
    args: ['--token', '$(touch /tmp/pwned)']
  });
  assert.strictEqual(Array.isArray(cmd), true);
  for (const element of cmd) {
    assert.strictEqual(typeof element, 'string');
  }
  const shellTokens = cmd.filter((element) => element.includes(';') || element.includes('$('));
  assert.strictEqual(shellTokens.length, 2);
  assert.strictEqual(shellTokens[0], '/opt/hostkind/versions/1.2.3; rm -rf /');
  assert.strictEqual(shellTokens[1], '$(touch /tmp/pwned)');
  assert.strictEqual(cmd.some((element) => element.includes(' && ') || element.includes(' | ')), false);
});

// --- bootstrap orchestration (all seams injected, nothing spawned) -----------

test('createBootstrap.run executes the contract steps in order on success', async () => {
  const order = [];
  const recorded = [];
  const runner = bootstrap.createBootstrap({
    waitForExit: async () => { order.push('waitForExit'); },
    verifyStagedChecksum: async () => { order.push('verifyStagedChecksum'); },
    preserveData: async () => { order.push('preserveData'); },
    promoteVersion: async () => { order.push('promoteVersion'); },
    relaunch: async () => { order.push('relaunch'); },
    recordResult: async (result) => { recorded.push(result); order.push('recordResult'); }
  });
  const outcome = await runner.run({
    installRoot: '/tmp/hostkind',
    version: '1.2.3',
    stagedPath: '/tmp/hostkind/staged',
    expectedSha256: 'a'.repeat(64),
    command: ['/opt/hostkind/launcher', '/opt/hostkind/versions/1.2.3/hostkind'],
    options: { detached: true, stdio: 'ignore' }
  });
  assert.strictEqual(outcome.ok, true);
  assert.deepStrictEqual(order, ['waitForExit', 'verifyStagedChecksum', 'preserveData', 'promoteVersion', 'relaunch', 'recordResult']);
  assert.strictEqual(recorded.length, 1);
  assert.strictEqual(recorded[0].ok, true);
  assert.strictEqual(recorded[0].version, '1.2.3');
});

test('createBootstrap.run fails closed when staged verification fails', async () => {
  let promoted = false;
  let relaunched = false;
  let recorded = null;
  const runner = bootstrap.createBootstrap({
    waitForExit: async () => {},
    verifyStagedChecksum: async () => {
      throw Object.assign(new Error('checksum mismatch'), { code: 'checksum_mismatch' });
    },
    preserveData: async () => {},
    promoteVersion: async () => { promoted = true; },
    relaunch: async () => { relaunched = true; },
    recordResult: async (result) => { recorded = result; }
  });
  const outcome = await runner.run({
    installRoot: '/tmp/hostkind',
    version: '1.2.3',
    stagedPath: '/tmp/hostkind/staged',
    expectedSha256: 'f'.repeat(64),
    command: ['/x']
  });
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.failedStep, 'verifyStagedChecksum');
  assert.strictEqual(promoted, false);
  assert.strictEqual(relaunched, false);
  assert.strictEqual(recorded.ok, false);
});

test('createBootstrap.run fails closed when promotion fails and never relaunches', async () => {
  let relaunched = false;
  let recorded = null;
  const runner = bootstrap.createBootstrap({
    waitForExit: async () => {},
    verifyStagedChecksum: async () => {},
    preserveData: async () => {},
    promoteVersion: async () => {
      throw Object.assign(new Error('promotion failed'), { code: 'promotion_failed' });
    },
    relaunch: async () => { relaunched = true; },
    recordResult: async (result) => { recorded = result; }
  });
  const outcome = await runner.run({ installRoot: '/tmp/hostkind', version: '9.9.9', command: ['/x'] });
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.failedStep, 'promoteVersion');
  assert.strictEqual(relaunched, false);
  assert.strictEqual(recorded.ok, false);
});

test('createBootstrap passes the launcher an argument array with shell disabled', async () => {
  let received = null;
  const command = bootstrap.buildLaunchCommand({
    platformKey: 'windows-x64',
    launcherPath: 'C:\\hostkind\\launcher.exe',
    installDir: 'C:\\hostkind\\versions\\1.2.3',
    args: ['--serve']
  });
  const runner = bootstrap.createBootstrap({
    waitForExit: async () => {},
    verifyStagedChecksum: async () => {},
    preserveData: async () => {},
    promoteVersion: async () => {},
    relaunch: async ({ command: cmd, options }) => { received = { cmd, options }; },
    recordResult: async () => {}
  });
  await runner.run({
    installRoot: 'C:\\hostkind',
    version: '1.2.3',
    stagedPath: 'C:\\hostkind\\staged',
    expectedSha256: 'a'.repeat(64),
    command,
    options: { detached: true, stdio: 'ignore' }
  });
  assert.strictEqual(Array.isArray(received.cmd), true);
  assert.deepStrictEqual(received.cmd, command);
  assert.strictEqual(received.options.shell, false);
  assert.strictEqual(received.options.detached, true);
});

test('default bootstrap promotes the staged executable before switching current.json', async () => {
  const root = path.join(TMP_ROOT, 'updater-default-promotion');
  const stagedPath = path.join(root, 'staging', 'hostkind');
  const bytes = Buffer.from('real-hostkind-binary');
  fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
  fs.writeFileSync(stagedPath, bytes);
  const expectedSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const runner = bootstrap.createBootstrap({
    waitForExit: async () => {},
    relaunch: async () => {},
    recordResult: async () => {},
  });
  const outcome = await runner.run({
    installRoot: root,
    version: '1.2.3',
    stagedPath,
    expectedSha256,
    platformKey: 'linux-x64',
    command: ['/opt/hostkind/launcher', '/opt/hostkind/versions/1.2.3/hostkind'],
  });
  assert.strictEqual(outcome.ok, true);
  const promoted = path.join(root, 'versions', '1.2.3', 'hostkind');
  assert.deepStrictEqual(fs.readFileSync(promoted), bytes);
  assert.strictEqual(applyUpdate.readCurrentVersion({ installRoot: root }), '1.2.3');
  if (process.platform !== 'win32') {
    assert.ok((fs.statSync(promoted).mode & 0o111) !== 0, 'Linux executable must retain executable permission');
  }
});

test('failed post-restart health rolls the pointer back and relaunches the previous version', async () => {
  const events = [];
  const launches = [];
  const runner = bootstrap.createBootstrap({
    waitForExit: async () => { events.push('wait'); },
    verifyStagedChecksum: async () => { events.push('verify'); },
    preserveData: async () => { events.push('preserve'); },
    promoteVersion: async ({ version }) => {
      events.push(`promote:${version}`);
      return { version, previousVersion: '1.1.0' };
    },
    relaunch: async ({ command }) => { events.push('relaunch'); launches.push(command); },
    healthCheck: async () => {
      events.push('health');
      const error = new Error('new version never became healthy');
      error.code = 'health_check_failed';
      throw error;
    },
    rollbackVersion: async ({ version }) => { events.push(`rollback:${version}`); },
    recordResult: async (result) => { events.push(`record:${result.rolledBack ? 'rolled-back' : result.ok ? 'ok' : 'failed'}`); },
  });
  const outcome = await runner.run({
    installRoot: 'C:/hostkind',
    version: '1.2.3',
    stagedPath: 'C:/hostkind/.hostkind/staging/hostkind.exe',
    expectedSha256: 'a'.repeat(64),
    currentPid: 42,
    command: ['C:/hostkind/hostkind-launcher.exe', '1.2.3'],
    rollbackCommand: ['C:/hostkind/hostkind-launcher.exe', '1.1.0'],
    healthCheck: true,
  });
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.rolledBack, true);
  assert.deepStrictEqual(events, [
    'wait', 'verify', 'preserve', 'promote:1.2.3', 'relaunch', 'health',
    'rollback:1.1.0', 'relaunch', 'record:rolled-back',
  ]);
  assert.deepStrictEqual(launches, [
    ['C:/hostkind/hostkind-launcher.exe', '1.2.3'],
    ['C:/hostkind/hostkind-launcher.exe', '1.1.0'],
  ]);
});

test('default result recording reconciles the application state file after helper completion', async () => {
  const root = path.join(TMP_ROOT, 'updater-result-state');
  const runner = bootstrap.createBootstrap({
    waitForExit: async () => {},
    verifyStagedChecksum: async () => {},
    preserveData: async () => {},
    promoteVersion: async ({ version }) => ({ version, previousVersion: '1.1.0' }),
    relaunch: async () => {},
  });
  const outcome = await runner.run({
    installRoot: root,
    version: '1.2.3',
    command: ['launcher', '1.2.3'],
  });
  assert.strictEqual(outcome.ok, true);
  const state = JSON.parse(fs.readFileSync(path.join(root, '.hostkind', 'update-state.json'), 'utf8'));
  assert.strictEqual(state.state, 'idle');
});

// --- process-exit wait (injected sleep, no real timers or spawns) -------------

test('waitForProcessExit resolves only after the running probe reports exit', async () => {
  const probes = [true, true, false];
  const isRunning = () => probes.shift() !== false;
  let sleeps = 0;
  await bootstrap.waitForProcessExit({
    isRunning,
    pollIntervalMs: 5,
    timeoutMs: 1000,
    sleepImpl: async () => { sleeps += 1; }
  });
  assert.strictEqual(sleeps, 2);
});

test('waitForProcessExit rejects exit_timeout when the process never exits', async () => {
  await assert.rejects(
    bootstrap.waitForProcessExit({
      isRunning: () => true,
      pollIntervalMs: 1,
      timeoutMs: 10,
      sleepImpl: async () => {}
    }),
    (error) => error.code === 'exit_timeout'
  );
});

(async () => {
  for (const [name, fn] of tests) {
    await fn();
    console.log(`  ok  ${name}`);
  }
  console.log('application updater bootstrap tests passed');
  teardown();
})().catch((error) => {
  console.error(error);
  teardown();
  process.exitCode = 1;
});