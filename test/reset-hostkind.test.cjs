'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  RESET_CONFIRMATION,
  SERVER_DELETE_CONFIRMATION,
  resetHostkind,
  startPanel,
} = require('../scripts/reset-hostkind.cjs');

function fixture(config) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-reset-test-')));
  const serverA = path.join(root, 'managed-servers', 'alpha');
  const serverB = path.join(root, 'managed-servers', 'beta');
  const paths = {
    root,
    configPath: path.join(root, 'config.json'),
    dataDir: path.join(root, 'data'),
    installerCache: path.join(root, 'resources', 'installers'),
    runtimesDir: path.join(root, 'runtimes'),
    metricsPath: path.join(root, 'metrics.json'),
    runningPath: path.join(root, 'running.json'),
    initialPasswordPath: path.join(root, 'initial-admin-password.txt'),
    folderPickerCacheDir: path.join(root, 'folder-picker-cache'),
  };
  for (const dir of [paths.dataDir, paths.installerCache, paths.runtimesDir, paths.folderPickerCacheDir, serverA, serverB]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'marker.txt'), 'runtime data');
  }
  fs.writeFileSync(paths.configPath, JSON.stringify(config({ root, serverA, serverB }), null, 2));
  fs.writeFileSync(paths.metricsPath, 'runtime state');
  fs.writeFileSync(path.join(root, '.eslintcache'), 'cache');
  fs.writeFileSync(paths.runningPath, '{}');
  fs.writeFileSync(paths.initialPasswordPath, 'runtime state');
  fs.writeFileSync(path.join(root, '.env'), 'PLACEHOLDER=not-a-secret');
  fs.writeFileSync(path.join(root, '.env.local'), 'PLACEHOLDER=not-a-secret');
  fs.writeFileSync(path.join(root, '.env.example'), 'PLACEHOLDER=template');
  fs.writeFileSync(path.join(root, '.env.sample'), 'PLACEHOLDER=template');
  return { root, paths, serverA, serverB };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

async function testResetKeepsServerDirectoriesByDefault() {
  const f = fixture(({ serverA, serverB }) => ({
    serverDir: serverA,
    servers: [{ id: 'a', dir: serverA }, { id: 'b', dir: serverB }],
    panelPort: 0,
  }));
  const confirmations = [];
  try {
    const result = await resetHostkind({
      paths: f.paths,
      config: JSON.parse(fs.readFileSync(f.paths.configPath, 'utf8')),
      includeServers: false,
      start: false,
      confirm: async ({ expectedToken }) => {
        confirmations.push(expectedToken);
        return true;
      },
    });

    assert.deepStrictEqual(confirmations, [RESET_CONFIRMATION, RESET_CONFIRMATION]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.started, false);
    assert.ok(!fs.existsSync(f.paths.configPath), 'config and credentials should be reset');
    assert.ok(!fs.existsSync(f.paths.dataDir), 'application state should be reset');
    assert.ok(!fs.existsSync(f.paths.installerCache), 'installer cache should be reset');
    assert.ok(!fs.existsSync(f.paths.runtimesDir), 'runtime cache should be reset');
    assert.ok(!fs.existsSync(f.paths.metricsPath), 'metrics cache should be reset');
    assert.ok(!fs.existsSync(path.join(f.root, '.eslintcache')), 'eslint cache should be reset');
    assert.ok(!fs.existsSync(f.paths.runningPath), 'running state should be reset');
    assert.ok(!fs.existsSync(f.paths.initialPasswordPath), 'initial credentials should be reset');
    assert.ok(!fs.existsSync(f.paths.folderPickerCacheDir), 'folder-picker cache should be reset');
    assert.ok(!fs.existsSync(path.join(f.root, '.env')), 'local environment credentials should be reset');
    assert.ok(!fs.existsSync(path.join(f.root, '.env.local')), 'local environment variants should be reset');
    assert.ok(fs.existsSync(path.join(f.root, '.env.example')), 'environment templates must be preserved');
    assert.ok(fs.existsSync(path.join(f.root, '.env.sample')), 'environment sample templates must be preserved');
    assert.ok(fs.existsSync(path.join(f.serverA, 'marker.txt')), 'server files must be preserved by default');
    assert.ok(fs.existsSync(path.join(f.serverB, 'marker.txt')), 'all server files must be preserved by default');
  } finally {
    cleanup(f.root);
  }
}

async function testResetDeletesRegisteredServersOnlyAfterExplicitServerConfirmation() {
  const f = fixture(({ serverA, serverB }) => ({
    servers: [{ id: 'a', dir: serverA }, { id: 'b', dir: serverB }],
    panelPort: 0,
  }));
  const confirmations = [];
  try {
    const result = await resetHostkind({
      paths: f.paths,
      config: JSON.parse(fs.readFileSync(f.paths.configPath, 'utf8')),
      includeServers: true,
      start: false,
      confirm: async ({ expectedToken }) => {
        confirmations.push(expectedToken);
        return true;
      },
    });

    assert.deepStrictEqual(confirmations, [RESET_CONFIRMATION, SERVER_DELETE_CONFIRMATION]);
    assert.strictEqual(result.ok, true);
    assert.ok(!fs.existsSync(f.serverA), 'registered server A should be deleted when explicitly selected');
    assert.ok(!fs.existsSync(f.serverB), 'registered server B should be deleted when explicitly selected');
  } finally {
    cleanup(f.root);
  }
}

async function testResetMakesNoChangesWhenConfirmationIsDeclined() {
  const f = fixture(({ serverA }) => ({
    servers: [{ id: 'a', dir: serverA }],
    panelPort: 0,
  }));
  let confirmationCount = 0;
  try {
    const result = await resetHostkind({
      paths: f.paths,
      config: JSON.parse(fs.readFileSync(f.paths.configPath, 'utf8')),
      includeServers: true,
      start: false,
      confirm: async () => {
        confirmationCount += 1;
        return false;
      },
    });

    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(confirmationCount, 1);
    assert.ok(fs.existsSync(f.paths.configPath), 'declining must preserve config');
    assert.ok(fs.existsSync(f.serverA), 'declining must preserve servers');
  } finally {
    cleanup(f.root);
  }
}

async function testResetStopsBeforeMutationWhenServerDeletionConfirmationIsDeclined() {
  const f = fixture(({ serverA }) => ({
    servers: [{ id: 'a', dir: serverA }],
    panelPort: 0,
  }));
  const confirmations = [];
  try {
    const result = await resetHostkind({
      paths: f.paths,
      config: JSON.parse(fs.readFileSync(f.paths.configPath, 'utf8')),
      includeServers: true,
      start: false,
      confirm: async ({ expectedToken }) => {
        confirmations.push(expectedToken);
        return confirmations.length === 1;
      },
    });

    assert.deepStrictEqual(confirmations, [RESET_CONFIRMATION, SERVER_DELETE_CONFIRMATION]);
    assert.strictEqual(result.cancelled, true);
    assert.ok(fs.existsSync(f.paths.configPath), 'declining server deletion must preserve config');
    assert.ok(fs.existsSync(f.paths.dataDir), 'declining server deletion must preserve application state');
    assert.ok(fs.existsSync(f.serverA), 'declining server deletion must preserve server files');
  } finally {
    cleanup(f.root);
  }
}

async function testResetRefusesToRunWhileAGameServerIsLive() {
  const f = fixture(({ serverA }) => ({
    servers: [{ id: 'a', dir: serverA }],
    panelPort: 0,
  }));
  let confirmationCalled = false;
  try {
    fs.writeFileSync(f.paths.runningPath, JSON.stringify({ a: { pid: 4242 } }));
    await assert.rejects(
      resetHostkind({
        paths: f.paths,
        config: JSON.parse(fs.readFileSync(f.paths.configPath, 'utf8')),
        includeServers: true,
        start: false,
        isRunning: () => true,
        confirm: async () => {
          confirmationCalled = true;
          return true;
        },
      }),
      /game servers are still running/i,
    );
    assert.strictEqual(confirmationCalled, false, 'a live server must be rejected before confirmation');
    assert.ok(fs.existsSync(f.paths.configPath), 'live-server refusal must preserve config');
    assert.ok(fs.existsSync(f.serverA), 'live-server refusal must preserve server files');
  } finally {
    cleanup(f.root);
  }
}

async function testResetRejectsConfiguredServerInsideResetTarget() {
  const f = fixture(({ root }) => ({
    servers: [{ id: 'nested', dir: path.join(root, 'data') }],
    panelPort: 0,
  }));
  try {
    await assert.rejects(
      resetHostkind({
        paths: f.paths,
        config: JSON.parse(fs.readFileSync(f.paths.configPath, 'utf8')),
        includeServers: false,
        start: false,
        confirm: async () => true,
      }),
      /overlaps reset target/i,
    );
    assert.ok(fs.existsSync(f.paths.configPath), 'overlapping server paths must fail before deletion');
    assert.ok(fs.existsSync(f.paths.dataDir), 'overlapping server paths must preserve application state');
  } finally {
    cleanup(f.root);
  }
}

async function testResetRejectsARegisteredDirectoryThatCouldDeleteTheInstall() {
  const f = fixture(({ root }) => ({
    servers: [{ id: 'unsafe', dir: root }],
    panelPort: 0,
  }));
  try {
    await assert.rejects(
      resetHostkind({
        paths: f.paths,
        config: JSON.parse(fs.readFileSync(f.paths.configPath, 'utf8')),
        includeServers: true,
        start: false,
        confirm: async () => true,
      }),
      /unsafe server directory/i,
    );
    assert.ok(fs.existsSync(f.paths.configPath), 'unsafe plans must fail before deletion');
  } finally {
    cleanup(f.root);
  }
}

async function testStartPanelReturnsAfterProcessSpawn() {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-reset-start-test-')));
  fs.writeFileSync(path.join(root, 'server.js'), '');
  let spawnOptions;
  let unrefCalled = false;
  const child = new EventEmitter();
  child.pid = 42424;
  child.unref = () => { unrefCalled = true; };
  try {
    const result = await Promise.race([
      startPanel({
        root,
        env: { TEST_ENV: '1' },
        spawnImpl: (execPath, args, options) => {
          spawnOptions = { execPath, args, options };
          setImmediate(() => child.emit('spawn'));
          return child;
        },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('startPanel did not return after spawn')), 100)),
    ]);
    assert.strictEqual(result.started, true);
    assert.strictEqual(result.pid, child.pid);
    assert.strictEqual(spawnOptions.options.detached, true);
    assert.strictEqual(spawnOptions.options.stdio, 'inherit');
    assert.strictEqual(spawnOptions.options.shell, false);
    assert.strictEqual(unrefCalled, true);
  } finally {
    cleanup(root);
  }
}

(async () => {
  await testResetKeepsServerDirectoriesByDefault();
  await testResetDeletesRegisteredServersOnlyAfterExplicitServerConfirmation();
  await testResetMakesNoChangesWhenConfirmationIsDeclined();
  await testResetStopsBeforeMutationWhenServerDeletionConfirmationIsDeclined();
  await testResetRefusesToRunWhileAGameServerIsLive();
  await testResetRejectsConfiguredServerInsideResetTarget();
  await testResetRejectsARegisteredDirectoryThatCouldDeleteTheInstall();
  await testStartPanelReturnsAfterProcessSpawn();
  console.log('PASS reset-hostkind');
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
