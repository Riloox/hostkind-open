'use strict';

const assert = require('assert');
const { createGenericGameModule, DEFINITIONS } = require('../lib/modules/generic-game.cjs');
const createPalworldModule = require('../lib/modules/palworld/manager.cjs');
const { createRegistry } = require('../lib/modules/registry.cjs');
const { validateManualRegistration, validPort } = require('../lib/modules/registration.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');

assert.equal(Object.hasOwn(DEFINITIONS, 'terraria'), false);
assert.throws(() => createGenericGameModule('terraria'), /Unknown game module: terraria/);
assert.equal(Object.hasOwn(DEFINITIONS, 'valheim'), false);
assert.throws(() => createGenericGameModule('valheim'), /Unknown game module: valheim/);
const palworld = createPalworldModule();
assert.equal(palworld.detectOnline('LogHttp: Display: Http server started'), true);
assert.equal(palworld.detectOnline('15:43:27.156 Running Palworld dedicated server on :8211'), true);
assert.equal(typeof palworld.buildStopSequence({}).execute, 'function');
assert.deepEqual(palworld.backupSelection(), ['Pal/Saved']);
assert.equal(palworld.capabilities.includes('rest-api'), true);
assert.equal(palworld.capabilities.includes('players'), true);
assert.equal(palworld.capabilities.includes('announcements'), true);
assert.equal(palworld.adapterVersion, 1);

const metadata = createRegistry({}).list();
for (const id of [...Object.keys(DEFINITIONS), 'valheim', 'palworld', 'terraria']) {
  const entry = metadata.find(item => item.type === id);
  assert.ok(entry, `${id} module must be registered`);
  assert.equal(entry.manualRegistration, true);
  assert.ok(Object.hasOwn(entry, 'creationAvailable'));
  assert.equal(entry.id, id);
}

assert.equal(createRegistry({}).get('future-game').id, 'unsupported');
assert.equal(createRegistry({}).get(undefined).id, 'minecraft');
assert.throws(() => validPort(0), /1 to 65535/);
assert.throws(() => validPort(65536), /1 to 65535/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-game-registration-'));
const executable = path.join(root, process.platform === 'win32' ? 'server.exe' : 'server');
fs.writeFileSync(executable, 'fixture');
if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
try {
  const value = validateManualRegistration({
    gameType: 'terraria', name: 'Terraria', cwd: root,
    executable, args: ['-port', '7777'], port: 7777,
  });
  assert.equal(value.type, 'terraria');
  assert.deepEqual(value.args, ['-port', '7777']);
  assert.equal(value.port, 7777);
  assert.throws(() => validateManualRegistration({ gameType: 'valheim', name: 'Bad', cwd: root, executable, port: 65534 }), /three consecutive ports/);
  assert.throws(() => validateManualRegistration({ gameType: 'custom', name: 'Escape', cwd: root, executable: path.join(root, '..', 'outside') }), /inside the working directory/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

async function testPalworldRestClient() {
  const originalFetch = global.fetch;
  let captured;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 200, text: async () => '{"version":"fixture"}' };
  };
  try {
    const manager = {
      desc: () => ({ restPort: 8212, adminPassword: 'private-secret' }),
      moduleState: {},
      pushLine: () => {},
    };
    const data = await palworld.request(manager, 'GET', '/info');
    assert.equal(captured.url, 'http://127.0.0.1:8212/v1/api/info');
    assert.equal(captured.options.headers.Authorization, `Basic ${Buffer.from('admin:private-secret').toString('base64')}`);
    assert.equal(data.version, 'fixture');
    manager.status = 'online';
    await palworld.backupPrepare(manager);
    assert.equal(captured.url, 'http://127.0.0.1:8212/v1/api/save');
    assert.equal(captured.options.method, 'POST');
    await palworld.buildStopSequence(manager).execute();
    assert.equal(captured.url, 'http://127.0.0.1:8212/v1/api/shutdown');
    assert.equal(captured.options.method, 'POST');
    assert.deepEqual(JSON.parse(captured.options.body), {
      waittime: 1,
      message: 'Hostkind requested shutdown',
    });
  } finally {
    global.fetch = originalFetch;
  }
}

/*
 * The Windows case: the server writes its console to its own window, so the
 * "Running Palworld dedicated server" line never reaches fleetdeck's pipe and
 * only a healthy REST answer can prove readiness. It must promote starting ->
 * online (and nothing else), and polling has to run during 'starting' so the
 * module promotes itself without a map/players screen touching the API first.
 */

/*
 * The registered executable on Windows is the launcher (PalServer.exe), which
 * spawns a grandchild that allocates its own console window. The module must
 * skip the launcher and spawn the inner server binary directly (headless),
 * ensure `-log` so UE writes Pal.log, and tail that file into the console.
 */
async function testPalworldHeadlessWindowsLaunch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-palworld-headless-'));
  const launcher = path.join(root, 'PalServer.exe');
  const innerDir = path.join(root, 'Pal', 'Binaries', 'Win64');
  const inner = path.join(innerDir, 'PalServer-Win64-Shipping.exe');
  fs.writeFileSync(launcher, 'launcher');
  fs.mkdirSync(innerDir, { recursive: true });
  fs.writeFileSync(inner, 'server');

  const captures = [];
  const state = { status: 'offline', moduleState: {} };
  const manager = {
    desc: () => ({ cwd: root, dir: root, executable: launcher, args: ['-port=8211'], restPort: 8212, adminPassword: 'test-admin' }),
    broadcast: () => {},
    statusPayload: () => ({ status: state.status }),
    pushLine: () => {},
    setStatus(next) { state.status = next; },
    _launch(bin, args) { captures.push({ bin, args }); state.status = 'starting'; return { ok: true }; },
    get status() { return state.status; },
    get moduleState() { return state.moduleState; },
    set moduleState(value) { state.moduleState = value; },
  };

  try {
    const module = createPalworldModule({ palworldAdapter: { fetch: async () => { throw new Error('connection refused'); } }, logPollMs: 10, hostPlatform: () => 'windows' });
    assert.equal(module.start(manager).ok, true);
    assert.equal(captures.length, 1, 'exactly one launch is attempted');
    assert.equal(captures[0].bin, inner, 'the launcher is skipped in favour of the inner server binary');
    assert.equal(captures[0].args[0], 'Pal', 'the UE project name leads the inner binary args');
    assert.ok(captures[0].args.includes('-log'), '-log is ensured so UE writes Pal.log');
    assert.ok(manager.moduleState.logTailer, 'a log tailer is started to feed the console');
    assert.equal(manager.moduleState.logTailer.file, path.join(root, 'Pal', 'Saved', 'Logs', 'Pal.log'));

    // Lines appended to Pal.log reach the console pipeline via pushLine.
    fs.mkdirSync(path.join(root, 'Pal', 'Saved', 'Logs'), { recursive: true });
    const pushed = [];
    manager.pushLine = (text, level) => pushed.push({ text, level });
    fs.writeFileSync(manager.moduleState.logTailer.file, '');
    fs.appendFileSync(manager.moduleState.logTailer.file, '[2026.08.09-14.22.33:456][  0]LogTemp: Display: Running Palworld dedicated server on :8211\n');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(pushed.length, 1, 'tailed lines reach pushLine');
    assert.equal(pushed[0].text, 'LogTemp: Display: Running Palworld dedicated server on :8211');

    module.onExit(manager);
    assert.equal(manager.moduleState.logTailer, undefined, 'the tailer is stopped on exit');
  } finally {
    if (manager.moduleState.logTailer) manager.moduleState.logTailer.stop();
    if (manager.moduleState.restTimer) clearTimeout(manager.moduleState.restTimer);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/*
 * An install with no inner binary (only the launcher, e.g. an unusual or
 * partial install) must fall back to launching the launcher as registered -
 * the headless resolution is a best effort, never a failure.
 */
async function testPalworldLauncherFallback() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-palworld-fallback-'));
  const launcher = path.join(root, 'PalServer.exe');
  fs.writeFileSync(launcher, 'launcher');

  const captures = [];
  const state = { status: 'offline', moduleState: {} };
  const manager = {
    desc: () => ({ cwd: root, dir: root, executable: launcher, args: ['-port=8211'], restPort: 8212, adminPassword: 'test-admin' }),
    broadcast: () => {},
    statusPayload: () => ({ status: state.status }),
    pushLine: () => {},
    setStatus(next) { state.status = next; },
    _launch(bin, args) { captures.push({ bin, args }); state.status = 'starting'; return { ok: true }; },
    get status() { return state.status; },
    get moduleState() { return state.moduleState; },
    set moduleState(value) { state.moduleState = value; },
  };

  try {
    const module = createPalworldModule({ palworldAdapter: { fetch: async () => { throw new Error('connection refused'); } }, logPollMs: 10, hostPlatform: () => 'windows' });
    module.start(manager);
    assert.equal(captures.length, 1);
    assert.equal(captures[0].bin, launcher, 'falls back to the launcher when the inner binary is absent');
    assert.equal(captures[0].args[0], '-port=8211', 'no project-name prefix on the launcher path');
    assert.ok(captures[0].args.includes('-log'));
  } finally {
    if (manager.moduleState.logTailer) manager.moduleState.logTailer.stop();
    if (manager.moduleState.restTimer) clearTimeout(manager.moduleState.restTimer);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testPalworldRestPromotion() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-palworld-rest-'));
  const executable = path.join(root, process.platform === 'win32' ? 'PalServer.exe' : 'PalServer.sh');
  fs.writeFileSync(executable, 'fixture');
  if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);

  const desc = () => ({ restPort: 8212, adminPassword: 'test-admin', cwd: root, dir: root, executable, args: [] });
  const healthyBody = (endpoint) => {
    if (endpoint === '/info') return { status: 'OK', version: 'v0.6', servername: 'Hostkind', description: 'Fixture' };
    if (endpoint === '/metrics') return { status: 'OK', days: 1, uptime: 60, currentplayernum: 1, maxplayernum: 32, serverfps: 60, serverframetime: 16.6, basecampnum: 2 };
    return { status: 'OK', players: [{ name: 'Lamball', userid: 'steam_1', accountName: 'a', location: { x: 1, y: 2, z: 3 }, level: 1, ping: 20 }] };
  };
  const healthyFetch = async (url) => {
    const endpoint = new URL(url).pathname.replace(/^\/v1\/api/, '');
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(healthyBody(endpoint)) };
  };

  function fakeManager() {
    const state = { status: 'offline', moduleState: {} };
    return {
      desc,
      broadcast: () => {},
      statusPayload: () => ({ status: state.status }),
      pushLine: () => {},
      setStatus(next) { state.status = next; },
      // Mirrors ServerManager._launch: STARTING synchronously, state reset.
      _launch() { state.status = 'starting'; state.moduleState = {}; return { ok: true }; },
      proc: null,
      get status() { return state.status; },
      get moduleState() { return state.moduleState; },
      set moduleState(value) { state.moduleState = value; },
    };
  }

  try {
    const healthyModule = createPalworldModule({ palworldAdapter: { fetch: healthyFetch } });
    assert.equal(healthyModule.detectOnline('[fake] REST API started on port 8212'), false, 'the readiness line must not match in the Windows case');
    const healthyManager = fakeManager();
    assert.equal(healthyModule.start(healthyManager).ok, true);
    await healthyModule.refresh(healthyManager);
    assert.equal(healthyManager.status, 'online', 'a healthy REST API promotes starting -> online without the console line');
    assert.equal(healthyManager.moduleState.restHealth.state, 'healthy');
    await healthyModule.refresh(healthyManager);
    assert.equal(healthyManager.status, 'online', 'promotion is a no-op once already online');
    if (healthyManager.moduleState.restTimer) clearTimeout(healthyManager.moduleState.restTimer);

    const downModule = createPalworldModule({ palworldAdapter: { fetch: async () => { throw new Error('connection refused'); } } });
    const downManager = fakeManager();
    downModule.start(downManager);
    await downModule.refresh(downManager);
    assert.equal(downManager.status, 'starting', 'with the REST API down, status stays starting');
    assert.ok(downManager.moduleState.restTimer, 'polling is scheduled during starting so the module promotes itself');
    clearTimeout(downManager.moduleState.restTimer);
    downManager.moduleState.restTimer = null;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

testPalworldRestClient()
  .then(testPalworldHeadlessWindowsLaunch)
  .then(testPalworldLauncherFallback)
  .then(testPalworldRestPromotion)
  .then(() => console.log('game module tests passed'))
  .catch((err) => { console.error(err); process.exitCode = 1; });
