'use strict';

/*
 * Terraria module contract (docs/terraria/00-baseline-contracts.md).
 *
 * Phase 0 adds no feature, so this file's first job is to pin the behavior the
 * generic stub had - readiness lines, the `exit` stop sequence, the
 * working-directory error - and prove the real module still has it. The rest
 * locks the contract every later phase attaches to: the variant model, the
 * per-descriptor capability set, the frozen descriptor, and the route
 * capability mapping.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { setupDataDir, teardown } = require('./_setup.cjs');
setupDataDir();

const variants = require('../lib/modules/terraria/variants.cjs');
const createTerrariaModule = require('../lib/modules/terraria/manager.cjs');
const { RULES, FALLBACK_CAPABILITY, matchTerrariaRoute, terrariaRouteCapability } = require('../lib/modules/terraria/routes.cjs');
const { createRegistry } = require('../lib/modules/registry.cjs');
const { createModuleGate } = require('../lib/modules/gating.cjs');
const { DEFINITIONS } = require('../lib/modules/generic-game.cjs');
const { validateManualRegistration, normalizeTerrariaVariant } = require('../lib/modules/registration.cjs');
const { CAPABILITIES } = require('../lib/capabilities.cjs');

// Read as LF: the assertions below slice this source on '\n' boundaries, and a
// Windows checkout hands it back with CRLF.
const SERVER_JS = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const terraria = createTerrariaModule({});

// A stand-in ServerManager: the module only ever touches desc() and _launch().
function fakeManager(desc) {
  const launches = [];
  return {
    launches,
    desc: () => desc,
    _launch(bin, args) { launches.push({ bin, args }); return { ok: true }; },
  };
}

// --- 1. pinned baseline behavior -------------------------------------------

/*
 * Readiness.
 *
 * Phase 0 pinned the stub's two lines. Phase 2 captured real console output and
 * one of them turned out to be wrong: a server whose port is already bound
 * prints `Listening on port <n>` and then exits without ever starting
 * (test/fixtures/terraria/port-in-use.log), so matching it reported a dead
 * server as online. The started line is readiness; the listening line is not.
 * test/terraria-lifecycle.test.cjs asserts both against the fixtures.
 */
assert.equal(terraria.detectOnline('Server started', fakeManager({})), true);
assert.equal(terraria.detectOnline('Listening on port 7777', fakeManager({})), false);
assert.equal(terraria.detectOnline('Terraria Server v1.4.4.9', fakeManager({})), false);
for (const variant of variants.VARIANTS) {
  const manager = fakeManager({ terrariaVariant: variant });
  assert.equal(terraria.detectOnline('Server started', manager), true, `${variant} inherits the shared readiness line`);
  assert.deepEqual(terraria.buildStopSequence(manager), { command: 'exit' });
}

// The stop sequence is still `exit` on stdin, never a signal, for a known variant.
assert.deepEqual(terraria.buildStopSequence(fakeManager({})), { command: 'exit' });

// Working-directory validation: the message the stub produced, unchanged.
const missingDir = path.join(os.tmpdir(), 'fleetdeck-terraria-missing');
assert.deepEqual(terraria.start(fakeManager({ dir: '' })), { ok: false, error: 'Working directory not found: ' });
assert.deepEqual(terraria.start(fakeManager({ dir: missingDir })), { ok: false, error: `Working directory not found: ${missingDir}` });

// Without an authoritative save directory the backup refuses to guess.
assert.deepEqual(terraria.backupSelection({}), []);

// The capability list the stub declared, minus nothing an operator could use:
// every capability it had is still here.
for (const capability of ['console', 'players', 'configs', 'files', 'backups', 'schedules', 'metrics', 'watchdog', 'updates']) {
  assert.ok(terraria.capabilities.includes(capability), `${capability} must survive the module rewrite`);
}
assert.equal(terraria.metadata.manualRegistration, true);
assert.deepEqual(terraria.metadata.automaticInstallHosts, ['win32', 'linux', 'darwin']);

// --- 2. the variant model ---------------------------------------------------

assert.deepEqual(variants.VARIANTS, ['vanilla', 'tshock', 'tmodloader']);
assert.throws(() => { variants.VARIANTS.push('starbound'); }, /read only|not extensible|Cannot add/i);

// Missing means vanilla (a migration: nothing else could be registered before
// variants existed). Unknown is an error and never becomes vanilla.
assert.equal(variants.resolveVariant({}), 'vanilla');
assert.equal(variants.resolveVariant({ terrariaVariant: '' }), 'vanilla');
assert.equal(variants.resolveVariant({ terrariaVariant: 'tshock' }), 'tshock');
assert.throws(() => variants.resolveVariant({ terrariaVariant: 'vanila' }), /Unknown Terraria variant: vanila/);
assert.throws(() => variants.resolveVariant({ terrariaVariant: 'Vanilla' }), /Unknown Terraria variant/);

// Every variant declares the facts phases 1-9 read, and declares `null` rather
// than a guessed value where the fixture is still owed.
for (const variant of variants.VARIANTS) {
  const info = variants.variantInfo(variant);
  assert.equal(info.id, variant);
  assert.equal(info.saveCommand, 'save');
  assert.equal(info.stop.command, 'exit');
  assert.ok(info.configFiles.includes('serverconfig.txt'));
  assert.ok(info.evidence.length > 0);
  assert.ok(info.worldExtensions.includes('.wld'));
  // Readiness is not a variant fact any more: phase 2 moved it to console.cjs,
  // where every pattern names the capture it was read off.
  assert.equal(info.readiness, undefined);
  assert.equal(info.worldPath.defaultRelative, null, 'the world folder is read from worldpath, never assumed');
}
assert.deepEqual(variants.variantInfo('tmodloader').worldExtensions, ['.wld', '.twld']);
assert.deepEqual(variants.variantInfo('tshock').configFiles, ['serverconfig.txt', 'tshock/config.json']);
assert.equal(variants.variantInfo('tmodloader').executableNames, null, 'tModLoader needs phase 1 launch resolution, not a name lookup');
assert.deepEqual(variants.executableCandidates('vanilla', 'linux'), ['TerrariaServer.bin.x86_64']);
assert.deepEqual(variants.executableCandidates('vanilla', 'win32'), ['TerrariaServer.exe']);
assert.deepEqual(variants.executableCandidates('vanilla', 'darwin'), ['Terraria Server']);
assert.equal(variants.executableCandidates('tmodloader'), null);

// --- 3. capabilities differ per descriptor ----------------------------------

const capabilitiesOf = (variant) => terraria.capabilitiesFor({ type: 'terraria', terrariaVariant: variant });
assert.equal(capabilitiesOf('tmodloader').includes('terraria-mods'), true);
assert.equal(capabilitiesOf('vanilla').includes('terraria-mods'), false);
assert.equal(capabilitiesOf('tshock').includes('terraria-mods'), false);
assert.equal(capabilitiesOf('tshock').includes('terraria-tshock'), true);
assert.equal(capabilitiesOf('vanilla').includes('terraria-tshock'), false);
assert.equal(capabilitiesOf('tmodloader').includes('terraria-tshock'), false);
// An unrecognized variant gets the variant-independent subset, never a wider one.
assert.deepEqual(capabilitiesOf('nope'), [...variants.BASE_CAPABILITIES]);

for (const variant of variants.VARIANTS) {
  const capabilities = capabilitiesOf(variant);
  // `worlds` belongs to phase 3 (lib/routes/worlds.cjs reads level.dat) and
  // `addons`/`content-install` to phase 6, so /api/worlds, /api/addons and
  // /api/modrinth stay 404 for Terraria until a Terraria provider exists.
  assert.equal(capabilities.includes('worlds'), false, 'the generic worlds capability is phase 3');
  assert.equal(capabilities.includes('addons'), false, 'the generic addons capability is phase 6');
  assert.equal(capabilities.includes('content-install'), false, 'Modrinth is Minecraft-only');
  assert.equal(capabilities.includes('terraria-worlds'), true);
  assert.equal(capabilities.includes('terraria-config'), true);
}

// --- 4. registry wiring -----------------------------------------------------

const registry = createRegistry({});
assert.equal(registry.get('terraria').id, 'terraria');
assert.equal(typeof registry.get('terraria').capabilitiesFor, 'function');
assert.equal(registry.get('future-game').id, 'unsupported');
assert.equal(Object.hasOwn(DEFINITIONS, 'terraria'), false, 'generic-game.cjs must no longer define Terraria');
assert.equal(registry.list().some((entry) => entry.type === 'terraria'), true);

// --- 5. the descriptor ------------------------------------------------------

// statusFields reaches every WebSocket client and GET /api/status: no absolute
// paths, no secrets, whatever the descriptor happens to carry.
const loadedDesc = {
  type: 'terraria',
  dir: '/srv/terraria',
  cwd: '/srv/terraria',
  executable: '/srv/terraria/TerrariaServer.bin.x86_64',
  args: ['-config', '/srv/terraria/serverconfig.txt', '-password', 'hunter2'],
  terrariaVariant: 'tshock',
  terrariaVersion: { game: '1.4.4.9', variant: '5.2.0', source: 'fixture', resolvedAt: '2026-01-01T00:00:00.000Z' },
  terrariaWorld: { file: 'Worlds/main.wld', name: 'Main' },
  terrariaSaveDir: 'Worlds',
  terrariaTshock: { restPort: 7878, restEnabled: true },
  password: 'hunter2',
  restToken: 'never-leaves-the-process',
};
const status = terraria.statusFields(fakeManager(loadedDesc));
const statusJson = JSON.stringify(status);
assert.equal(status.terrariaVariant, 'tshock');
assert.equal(status.terrariaWorld.name, 'Main');
assert.equal(status.terrariaWorld.file, undefined, 'paths stay server-side');
assert.equal(statusJson.includes('/srv/terraria'), false, 'no absolute paths in the status payload');
assert.equal(statusJson.includes('hunter2'), false, 'no password in the status payload');
assert.equal(statusJson.includes('never-leaves-the-process'), false, 'no TShock token in the status payload');
assert.deepEqual(
  terraria.statusFields(fakeManager({ terrariaVariant: 'starbound' })),
  { terrariaVariant: null, degraded: true, moduleError: 'unknown_terraria_variant' },
);

// The password never reaches the console line or the panel log either.
assert.deepEqual(
  terraria.displayLaunchArgs(['-config', 'serverconfig.txt', '-password', 'hunter2']),
  ['-config', 'serverconfig.txt', '-password', '********'],
);

/*
 * `GET /api/servers` is projected by serverWithStatus in server.js, which is
 * not importable without booting the panel. What a regression would look like
 * is a new line in that projection, so the projection's source is the thing
 * under test: it must never start copying the launch command or a secret out
 * of the descriptor.
 */
const projection = SERVER_JS.slice(SERVER_JS.indexOf('function serverWithStatus(s) {'));
const projectionBody = projection.slice(0, projection.indexOf('\n}\n') + 2);
assert.ok(projectionBody.includes('capabilities: moduleCapabilitiesFor(s)'), 'the projection must publish per-server capabilities');
for (const leak of ['s.executable', 's.args', 's.cwd', 's.adminPassword', 's.password', 's.restToken', 's.startCommand']) {
  assert.equal(projectionBody.includes(leak), false, `serverWithStatus must not publish ${leak}`);
}

/*
 * Descriptor round-trip. saveConfig writes the whole config object as
 * pretty-printed JSON and loadConfig parses it back (server.js), so the round
 * trip is exercised here through the same serialization: fields Hostkind does
 * not know about must survive, because descriptors are never rebuilt from a
 * panel-side template.
 */
const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-terraria-config-'));
try {
  const configPath = path.join(configRoot, 'config.json');
  const stored = { ...loadedDesc, id: 'srv-1', name: 'Main', futureField: { addedBy: 'a later phase' } };
  fs.writeFileSync(configPath, JSON.stringify({ servers: [stored] }, null, 2), 'utf8');
  const reloaded = JSON.parse(fs.readFileSync(configPath, 'utf8')).servers[0];
  assert.deepEqual(reloaded, stored, 'unknown descriptor fields survive a save/load cycle');
  assert.equal(variants.resolveVariant(reloaded), 'tshock');
  assert.deepEqual(reloaded.terrariaWorld, { file: 'Worlds/main.wld', name: 'Main' });
} finally {
  fs.rmSync(configRoot, { recursive: true, force: true });
}

// --- 6. registration --------------------------------------------------------

const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-terraria-'));
const executable = path.join(installRoot, process.platform === 'win32' ? 'TerrariaServer.exe' : 'TerrariaServer.bin.x86_64');
fs.writeFileSync(executable, 'fixture');
if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
try {
  const registerBody = { gameType: 'terraria', name: 'Terraria', cwd: installRoot, executable, args: ['-port', '7777'], port: 7777 };
  const registered = validateManualRegistration(registerBody);
  assert.equal(registered.type, 'terraria');
  assert.equal(registered.terrariaVariant, 'vanilla', 'the variant is stored explicitly, never left to be re-inferred');

  assert.equal(validateManualRegistration({ ...registerBody, terrariaVariant: 'tmodloader' }).terrariaVariant, 'tmodloader');
  assert.throws(
    () => validateManualRegistration({ ...registerBody, terrariaVariant: 'tshok' }),
    /Unknown Terraria variant: tshok/,
    'an unknown variant is rejected and never falls back to vanilla',
  );
  assert.equal(normalizeTerrariaVariant('TSHOCK'), 'tshock');
  assert.throws(() => normalizeTerrariaVariant('modded'), /Unknown Terraria variant/);

  // start() launches the stored argv array - never a re-parsed command string.
  const manager = fakeManager({ ...registered, dir: installRoot });
  assert.deepEqual(terraria.start(manager), { ok: true });
  assert.deepEqual(manager.launches, [{ bin: executable, args: ['-port', '7777'] }]);

  // An unrecognized variant stops the launch before spawn.
  assert.throws(() => {
    const result = terraria.start(fakeManager({ ...registered, dir: installRoot, terrariaVariant: 'nope' }));
    if (result.ok === false) throw new Error(result.error);
  }, /Unknown Terraria variant: nope/);

  // A missing binary is reported, not spawned.
  assert.deepEqual(
    terraria.start(fakeManager({ ...registered, dir: installRoot, executable: path.join(installRoot, 'gone') })),
    { ok: false, error: 'Terraria server executable was not found' },
  );
} finally {
  fs.rmSync(installRoot, { recursive: true, force: true });
}

// --- 7. route capability mapping -------------------------------------------

assert.equal(terrariaRouteCapability('/palworld/mods', 'GET'), null, 'only Terraria paths are mapped here');
assert.equal(terrariaRouteCapability('/terraria/config', 'GET'), CAPABILITIES.CONFIGS_VIEW);
assert.equal(terrariaRouteCapability('/terraria/config', 'PUT'), CAPABILITIES.CONFIGS_EDIT);
assert.equal(terrariaRouteCapability('/terraria/config/history', 'GET'), CAPABILITIES.CONFIGS_VIEW);
assert.equal(terrariaRouteCapability('/terraria/config/history/3/restore', 'POST'), CAPABILITIES.CONFIGS_RESTORE);
assert.equal(terrariaRouteCapability('/terraria/worlds', 'GET'), CAPABILITIES.WORLDS_VIEW);
assert.equal(terrariaRouteCapability('/terraria/worlds/main/activate', 'POST'), CAPABILITIES.WORLDS_MANAGE);
assert.equal(terrariaRouteCapability('/terraria/mods', 'GET'), CAPABILITIES.CONTENT_VIEW);
assert.equal(terrariaRouteCapability('/terraria/mods/install', 'POST'), CAPABILITIES.PLUGINS_MANAGE);
assert.equal(terrariaRouteCapability('/terraria/tshock/players', 'GET'), CAPABILITIES.PLAYERS_VIEW);
assert.equal(terrariaRouteCapability('/terraria/tshock/players/1/kick', 'POST'), CAPABILITIES.PLAYERS_MANAGE);
assert.equal(terrariaRouteCapability('/terraria/tshock/groups', 'GET'), CAPABILITIES.PLAYERS_VIEW);
assert.equal(terrariaRouteCapability('/terraria/tshock/groups', 'POST'), CAPABILITIES.SERVER_MANAGE);
assert.equal(terrariaRouteCapability('/terraria/versions', 'GET'), CAPABILITIES.UPDATES_VIEW);
assert.equal(terrariaRouteCapability('/terraria/import', 'GET'), CAPABILITIES.SERVER_VIEW);
assert.equal(terrariaRouteCapability('/terraria/import', 'POST'), CAPABILITIES.SERVER_REGISTER);

// Deny by default: an unmapped path and an unmapped verb both land on the
// strongest per-server capability instead of inheriting a weaker one.
assert.equal(FALLBACK_CAPABILITY, CAPABILITIES.SERVER_MANAGE);
assert.deepEqual(matchTerrariaRoute('/terraria/whatever', 'GET'), { capability: CAPABILITIES.SERVER_MANAGE, explicit: false });
assert.deepEqual(matchTerrariaRoute('/terraria/versions', 'POST'), { capability: CAPABILITIES.SERVER_MANAGE, explicit: false });
for (const rule of RULES) {
  assert.ok(Object.values(CAPABILITIES).includes(rule.get), 'every mapped read capability exists in lib/capabilities.cjs');
  assert.ok(rule.mutate === null || Object.values(CAPABILITIES).includes(rule.mutate));
}

/*
 * Coverage: every `/api/terraria/*` path registered anywhere in the panel must
 * be matched explicitly by the mapping above. This is the test that fails when
 * a later phase adds a route and forgets the table.
 */
const REGISTERED_RE = /\.(get|post|put|patch|delete|all)\(\s*'((?:\/api)?\/terraria[^']*)'/g;
const registeredPaths = [];
// Routes declared inline on the app, with their full path.
for (const match of SERVER_JS.matchAll(REGISTERED_RE)) {
  registeredPaths.push({ method: match[1].toUpperCase(), path: match[2].replace(/^\/api/, '') });
}

/*
 * Routes declared on a mounted router, whose own paths are relative. The mount
 * prefix is read from server.js rather than assumed, so a router that is moved
 * is checked at the path it actually answers on - and a router that is written
 * but never mounted fails here rather than silently passing.
 */
const ROUTERS = [{ file: 'terraria.cjs', factory: 'terrariaWorldsRouter' }];
for (const { file, factory } of ROUTERS) {
  const full = path.join(__dirname, '..', 'lib', 'routes', file);
  if (!fs.existsSync(full)) continue;
  const mount = SERVER_JS.match(new RegExp(`app\\.use\\('(/api/terraria[^']*)',\\s*${factory}\\(`));
  assert.ok(mount, `lib/routes/${file} exists but is not mounted under /api/terraria in server.js`);
  const source = fs.readFileSync(full, 'utf8');
  for (const match of source.matchAll(/router\.(get|post|put|patch|delete|all)\(\s*'([^']*)'/g)) {
    const relative = match[2] === '/' ? '' : match[2];
    registeredPaths.push({
      method: match[1].toUpperCase(),
      path: `${mount[1]}${relative}`.replace(/^\/api/, ''),
    });
  }
}
// The mounted router is the whole worlds surface; if this ever reads zero
// routes, the extraction above has stopped matching and is proving nothing.
assert.ok(registeredPaths.filter((route) => route.path.startsWith('/terraria/worlds')).length >= 8,
  'the Terraria worlds routes were not found by the coverage scan');
for (const route of registeredPaths) {
  const matched = matchTerrariaRoute(route.path, route.method === 'ALL' ? 'POST' : route.method);
  assert.ok(matched, `${route.method} ${route.path} must be a Terraria path`);
  assert.equal(matched.explicit, true, `${route.method} ${route.path} has no explicit capability mapping`);
}

// The reservation itself: /api/terraria is gated, and the variant-only
// surfaces carry their own capability string.
//
// Phase 1 added one exemption: /api/terraria/versions lists what exists
// upstream, so the create wizard reaches it before any Terraria server is
// registered. The exemption is written as a narrow path test, not as an
// ungated prefix, and the route still carries updates.view through the
// capability map above.
assert.ok(SERVER_JS.includes("app.use('/api/terraria', exceptVersions(requireTerrariaServer), exceptVersions(requireModuleCapability('console')))"));
assert.ok(SERVER_JS.includes("/^\\/versions(?:\\/|$)/.test(req.path) ? next() : middleware(req, res, next)"));
assert.ok(SERVER_JS.includes("app.use('/api/terraria/mods', requireModuleCapability('terraria-mods'))"));
assert.ok(SERVER_JS.includes("app.use('/api/terraria/tshock', requireModuleCapability('terraria-tshock'))"));
// Server-scoped targeting: ?serverId= and cross-server isolation apply.
assert.ok(/palworld\|terraria\|addons/.test(SERVER_JS), '/terraria must be in the server-scoped path regex');

// --- 8. gating follows the descriptor's variant -----------------------------

async function testRouteGating() {
  const servers = [
    { id: 'vanilla-1', type: 'terraria', terrariaVariant: 'vanilla' },
    { id: 'tshock-1', type: 'terraria', terrariaVariant: 'tshock' },
    { id: 'tmod-1', type: 'terraria', terrariaVariant: 'tmodloader' },
    { id: 'mc-1', type: 'minecraft' },
  ];
  const gate = createModuleGate({
    registry,
    findServer: (id) => servers.find((server) => server.id === id) || null,
    requestServerId: (req) => req.query.serverId || null,
  });

  const app = express();
  app.use('/api/terraria', gate.requireGameType('terraria'), gate.requireModuleCapability('console'));
  app.use('/api/terraria/mods', gate.requireModuleCapability('terraria-mods'));
  app.use('/api/terraria/tshock', gate.requireModuleCapability('terraria-tshock'));
  app.use('/api/worlds', gate.requireModuleCapability('worlds'));
  app.use('/api/addons', gate.requireModuleCapability('addons'));
  app.get('/api/terraria/mods', (req, res) => res.json({ ok: true }));
  app.get('/api/terraria/tshock/players', (req, res) => res.json({ ok: true }));
  app.get('/api/terraria/config', (req, res) => res.json({ ok: true }));
  app.get('/api/worlds', (req, res) => res.json({ ok: true }));
  app.get('/api/addons', (req, res) => res.json({ ok: true }));

  const server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (route, serverId) => fetch(`${base}${route}?serverId=${serverId}`);
  try {
    // Mods: tModLoader only.
    assert.equal((await call('/api/terraria/mods', 'tmod-1')).status, 200);
    assert.equal((await call('/api/terraria/mods', 'vanilla-1')).status, 404);
    assert.equal((await call('/api/terraria/mods', 'tshock-1')).status, 404);
    assert.deepEqual(await (await call('/api/terraria/mods', 'vanilla-1')).json(), { error: 'not_supported' });

    // TShock administration: TShock only.
    assert.equal((await call('/api/terraria/tshock/players', 'tshock-1')).status, 200);
    assert.equal((await call('/api/terraria/tshock/players', 'vanilla-1')).status, 404);
    assert.equal((await call('/api/terraria/tshock/players', 'tmod-1')).status, 404);

    // The shared surface is open to every variant, and closed to other games.
    for (const id of ['vanilla-1', 'tshock-1', 'tmod-1']) {
      assert.equal((await call('/api/terraria/config', id)).status, 200);
    }
    assert.equal((await call('/api/terraria/config', 'mc-1')).status, 404);
    assert.equal((await call('/api/terraria/mods', 'mc-1')).status, 404);

    // Minecraft-shaped routes stay closed for Terraria until phases 3 and 6.
    assert.equal((await call('/api/worlds', 'tmod-1')).status, 404);
    assert.equal((await call('/api/addons', 'tmod-1')).status, 404);
    assert.equal((await call('/api/worlds', 'mc-1')).status, 200);
    assert.equal((await call('/api/addons', 'mc-1')).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

testRouteGating()
  .then(() => {
    teardown();
    console.log('PASS  terraria-module');
  })
  .catch((err) => {
    console.error(err);
    teardown();
    process.exit(1);
  });
