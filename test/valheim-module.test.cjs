'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createValheimModule = require('../lib/modules/valheim/manager.cjs');
const { createRegistry } = require('../lib/modules/registry.cjs');
const { DEFINITIONS } = require('../lib/modules/generic-game.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-valheim-module-'));
const executable = path.join(root, process.platform === 'win32' ? 'valheim_server.exe' : 'valheim_server.x86_64');
fs.writeFileSync(executable, 'fixture');
if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);

function descriptor(overrides = {}) {
  return {
    id: 'valheim-1', type: 'valheim', valheimSchema: 1, dir: root, cwd: root,
    executable, args: [], port: 2456, serverName: 'Hostkind server',
    worldName: 'Dedicated', password: 'secret5', valheimSaveDir: 'data',
    valheimBackend: 'steam', valheimPublic: true, valheimInstanceId: null,
    valheimBuildId: null, stopTimeoutSeconds: 90, valheimSettings: {},
    valheimExtraArgs: ['-nographics', '-batchmode'], ...overrides,
  };
}

try {
  const mod = createValheimModule();
  assert.equal(mod.id, 'valheim');
  assert.deepEqual(mod.capabilities, ['console', 'files', 'schedules', 'metrics', 'watchdog', 'valheim-status', 'updates', 'valheim-updates', 'valheim-worlds']);
  for (const absent of ['access-lists', 'configs', 'backups']) assert.equal(mod.capabilities.includes(absent), false);
  assert.equal(Object.hasOwn(DEFINITIONS, 'valheim'), false);
  assert.equal(createRegistry({}).get('valheim').id, 'valheim');
  assert.notEqual(createRegistry({}).get('valheim').id, 'custom');
  assert.notEqual(createRegistry({}).get('valheim').id, 'minecraft');

  const linux = fs.readFileSync(path.join(__dirname, 'fixtures', 'valheim', 'linux-start.log'), 'utf8');
  const windows = fs.readFileSync(path.join(__dirname, 'fixtures', 'valheim', 'windows-start.log'), 'utf8');
  assert.equal(mod.detectOnline(linux), true);
  assert.equal(mod.detectOnline(windows), true);
  assert.equal(mod.buildStopSequence({ proc: null }).signal, 'SIGINT');
  assert.equal(typeof mod.buildStopSequence({ proc: null }).execute, 'function');
  assert.deepEqual(mod.backupSelection(descriptor()), ['data']);

  const manager = { desc: () => descriptor(), moduleState: {} };
  mod.resetState(manager);
  for (const line of linux.split(/\r?\n/)) mod.inspectLine(line, manager);
  mod.detectOnline('Game server connected', manager);
  assert.deepEqual(mod.normalizeStatus(manager), {
    buildId: null, gameVersion: '0.218.15',
    world: { name: 'Dedicated', saveDir: 'data' }, backend: 'steam',
    public: true, port: 2456, portRange: [2456, 2458],
    save: { lastObservedAt: null, inProgress: false }, observedConnections: [],
    observedIdentitiesStale: true, readyEvidence: 'Game server connected',
    readinessTimedOut: false, integrityWarning: null, lifecycleEvidence: null, commandInput: false,
    degraded: true,
    degradedReason: 'Valheim port-span evidence is not settled; Hostkind reserves three ports conservatively.',
  });

  const launched = mod.buildLaunch(descriptor());
  assert.equal(launched.executable, executable);
  assert.equal(launched.cwd, root);
  assert.equal(Object.hasOwn(launched, 'command'), false);
  assert.deepEqual(launched.args.slice(0, 14), [
    '-name', 'Hostkind server', '-port', '2456', '-world', 'Dedicated',
    '-password', 'secret5', '-savedir', path.join(root, 'data'),
    '-public', '1', '-nographics', '-batchmode',
  ]);
  assert.equal(mod.displayLaunchArgs(launched.args).includes('secret5'), false);
  assert.equal(mod.displayLaunchArgs(launched.args)[7], '********');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('valheim module tests passed');
