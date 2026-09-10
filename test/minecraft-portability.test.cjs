'use strict';

/*
 * Minecraft portability detection — pure-lib tests mirroring
 * test/palworld-portability.test.cjs.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { setupDataDir, teardown, TMP_ROOT } = require('./_setup.cjs');
setupDataDir();

const migrations = require('../lib/migrations.cjs');
const portability = require('../lib/minecraft-portability.cjs');

migrations.runMigrations();

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function makeServer(name, options = {}) {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });

  // server.properties
  const props = [
    'server-port=25565',
    'query.port=25565',
    'rcon.port=5575',
    'motd=A Test Server',
    'level-name=world',
    'level-seed=',
    'max-players=20',
    'online-mode=true',
    'gamemode=survival',
    'difficulty=easy',
    'pvp=true',
  ];
  if (options.port) props.push(`server-port=${options.port}`);
  if (options.motd) props.push(`motd=${options.motd}`);
  if (options.levelName) props.push(`level-name=${options.levelName}`);
  if (options.maxPlayers) props.push(`max-players=${options.maxPlayers}`);
  fs.writeFileSync(path.join(dir, 'server.properties'), props.join('\n'));

  // eula.txt
  const eulaAccepted = options.eulaAccepted !== false;
  fs.writeFileSync(path.join(dir, 'eula.txt'), `eula=${eulaAccepted ? 'true' : 'false'}\n`);

  // World folder with level.dat
  const worldName = options.levelName || 'world';
  const worldDir = path.join(dir, worldName);
  fs.mkdirSync(worldDir, { recursive: true });
  fs.writeFileSync(path.join(worldDir, 'level.dat'), 'fake-level-data');

  // Nether world
  if (options.nether !== false) {
    const netherDir = path.join(dir, `${worldName}_nether`);
    fs.mkdirSync(netherDir, { recursive: true });
    fs.writeFileSync(path.join(netherDir, 'level.dat'), 'fake-nether-data');
  }

  // Jar file
  if (options.jar !== null) {
    const jarName = options.jar || 'paper-1.20.1.jar';
    fs.writeFileSync(path.join(dir, jarName), 'fake-jar-bytes');
  }

  // Libraries dir (mod loader indicator)
  if (options.hasLibraries) {
    fs.mkdirSync(path.join(dir, 'libraries'), { recursive: true });
  }

  // Mods dir
  if (options.hasMods) {
    fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  }

  return { id: name, name, dir, type: 'minecraft', port: options.port || 25565 };
}

// --- parseServerProperties ------------------------------------------------

test('parseServerProperties parses a standard server.properties file', () => {
  const dir = path.join(TMP_ROOT, 'props-parse');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'server.properties');
  fs.writeFileSync(file, [
    '# comment line',
    'server-port=25575',
    'motd="Hello World"',
    'level-name=custom_world',
    'max-players=50',
    '',
    'gamemode=creative',
  ].join('\n'));
  const props = portability.parseServerProperties(file);
  assert.strictEqual(props['server-port'], '25575');
  assert.strictEqual(props['motd'], 'Hello World');
  assert.strictEqual(props['level-name'], 'custom_world');
  assert.strictEqual(props['max-players'], '50');
  assert.strictEqual(props['gamemode'], 'creative');
});

test('parseServerProperties returns null for missing file', () => {
  assert.strictEqual(portability.parseServerProperties('/nonexistent/server.properties'), null);
});

// --- detectJarLoader ------------------------------------------------------

test('detectJarLoader identifies Paper, Forge, and vanilla jars', () => {
  const dir = path.join(TMP_ROOT, 'jar-detect');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'paper-1.20.1.jar'), 'x');
  const result = portability.detectJarLoader(dir);
  assert.strictEqual(result.jar.type, 'paper');
  assert.strictEqual(result.jar.label, 'Paper');
  assert.strictEqual(result.jar.jar, 'paper-1.20.1.jar');
  assert.deepStrictEqual(result.jars, ['paper-1.20.1.jar']);
  assert.strictEqual(result.hasLibraries, false);
  assert.strictEqual(result.hasMods, false);
});

test('detectJarLoader detects libraries and mods directories', () => {
  const dir = path.join(TMP_ROOT, 'jar-libs');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'libraries'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'forge-1.20.1.jar'), 'x');
  const result = portability.detectJarLoader(dir);
  assert.strictEqual(result.jar.type, 'forge');
  assert.strictEqual(result.hasLibraries, true);
  assert.strictEqual(result.hasMods, true);
});

test('detectJarLoader recognizes a NeoForge argfile install without a root jar', () => {
  const dir = path.join(TMP_ROOT, 'jar-neoforge-argfile');
  const argName = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
  const argDir = path.join(dir, 'libraries', 'net', 'neoforged', 'neoforge', '21.4.157');
  fs.mkdirSync(argDir, { recursive: true });
  fs.writeFileSync(path.join(argDir, argName), [
    '--module-path',
    'libraries',
    '--fml.neoForgeVersion',
    '21.4.157',
    '--fml.mcVersion',
    '1.21.4',
  ].join('\n'));

  const result = portability.detectJarLoader(dir);

  assert.deepStrictEqual(result.jar, { jar: 'neoforge-server', type: 'neoforge', label: 'NeoForge' });
  assert.deepStrictEqual(result.launchArgs, [`@libraries/net/neoforged/neoforge/21.4.157/${argName}`, 'nogui']);
  assert.strictEqual(result.loader, 'neoforge');
  assert.strictEqual(result.mcVersion, '1.21.4');

  const detection = portability.detectServer({ dir, servers: [] });
  const descriptor = portability.buildDescriptor({ detection, name: 'NeoForge server' });
  assert.deepStrictEqual(descriptor.launchArgs, result.launchArgs);
  assert.strictEqual(descriptor.loader, 'neoforge');
  assert.strictEqual(descriptor.mcVersion, '1.21.4');
});

// --- detectWorlds ---------------------------------------------------------

test('detectWorlds finds worlds with level.dat', () => {
  const dir = path.join(TMP_ROOT, 'worlds-detect');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'x');
  fs.mkdirSync(path.join(dir, 'world_nether'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world_nether', 'level.dat'), 'x');
  fs.mkdirSync(path.join(dir, 'some-unrelated-dir'), { recursive: true });
  const worlds = portability.detectWorlds(dir, 'world');
  assert.strictEqual(worlds.length, 2);
  assert.ok(worlds.some((w) => w.name === 'world'));
  assert.ok(worlds.some((w) => w.name === 'world_nether'));
});

// --- detectEula ------------------------------------------------------------

test('detectEula detects accepted and rejected EULA', () => {
  const dir = path.join(TMP_ROOT, 'eula-detect');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  const accepted = portability.detectEula(dir);
  assert.strictEqual(accepted.present, true);
  assert.strictEqual(accepted.accepted, true);

  const dir2 = path.join(TMP_ROOT, 'eula-rejected');
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'eula.txt'), 'eula=false\n');
  const rejected = portability.detectEula(dir2);
  assert.strictEqual(rejected.present, true);
  assert.strictEqual(rejected.accepted, false);
});

test('detectEula returns not-present for missing file', () => {
  const dir = path.join(TMP_ROOT, 'eula-missing');
  fs.mkdirSync(dir, { recursive: true });
  const result = portability.detectEula(dir);
  assert.strictEqual(result.present, false);
  assert.strictEqual(result.accepted, false);
});

// --- detectServer ---------------------------------------------------------

test('detectServer returns a full descriptor for a valid install', () => {
  const server = makeServer('detect-valid');
  const detection = portability.detectServer({ dir: server.dir, servers: [] });
  assert.strictEqual(detection.ok, true);
  assert.strictEqual(detection.serverProperties.present, true);
  assert.strictEqual(detection.serverProperties.port, 25565);
  assert.strictEqual(detection.serverProperties.motd, 'A Test Server');
  assert.strictEqual(detection.serverProperties.levelName, 'world');
  assert.strictEqual(detection.eula.present, true);
  assert.strictEqual(detection.eula.accepted, true);
  assert.strictEqual(detection.jarLoader.jar.type, 'paper');
  assert.ok(detection.worlds.length >= 1);
  assert.strictEqual(detection.worlds[0].name, 'world');
  assert.strictEqual(detection.ready, true);
  assert.deepStrictEqual(detection.issues, []);
});

test('detectServer reports issues for missing eula and missing jar', () => {
  const dir = path.join(TMP_ROOT, 'detect-issues');
  fs.mkdirSync(dir, { recursive: true });
  // server.properties without eula
  fs.writeFileSync(path.join(dir, 'server.properties'), 'server-port=25565\n');
  // No eula.txt, no jar
  const detection = portability.detectServer({ dir, servers: [] });
  assert.strictEqual(detection.ok, true);
  assert.strictEqual(detection.ready, false);
  assert.ok(detection.issues.some((i) => /eula/i.test(i)));
});

test('detectServer rejects protected roots', () => {
  const detection = portability.detectServer({ dir: require('../lib/db.cjs').dataDir(), servers: [] });
  assert.strictEqual(detection.ok, false);
  assert.ok(detection.blocked);
});

test('detectServer blocks a folder that is already a registered server root', () => {
  const server = makeServer('detect-conflict');
  const registered = [{ id: 'existing', name: 'Existing', dir: server.dir }];
  const detection = portability.detectServer({ dir: server.dir, servers: registered });
  // Canonical adoption behaviour (matches Palworld): a folder that is already
  // a registered server root is blocked, not reported as ok-with-conflict.
  assert.strictEqual(detection.ok, false);
  assert.strictEqual(detection.blocked.reason, 'server_overlap');
  assert.strictEqual(detection.ready, false);
});

test('detectServer returns not-ready for missing directory', () => {
  const detection = portability.detectServer({ dir: '/nonexistent/path', servers: [] });
  assert.strictEqual(detection.ok, false);
  assert.strictEqual(detection.ready, false);
});

// --- buildDescriptor ------------------------------------------------------

test('buildDescriptor produces a registration-ready object', () => {
  const server = makeServer('build-desc');
  const detection = portability.detectServer({ dir: server.dir, servers: [] });
  const descriptor = portability.buildDescriptor({ detection, name: 'My Server' });
  assert.strictEqual(descriptor.type, 'minecraft');
  assert.strictEqual(descriptor.name, 'My Server');
  assert.strictEqual(descriptor.dir, server.dir);
  assert.strictEqual(descriptor.jar, 'paper-1.20.1.jar');
  assert.ok(Array.isArray(descriptor.javaArgs));
  assert.ok(descriptor.worlds.includes('world'));
});

test('buildDescriptor returns null for failed detection', () => {
  const detection = { ok: false };
  assert.strictEqual(portability.buildDescriptor({ detection, name: 'Nope' }), null);
});

// --- round trip: detect then build ----------------------------------------

test('a full detect-build round trip produces all required fields', () => {
  const server = makeServer('round-trip', { port: 25580, motd: 'Round Trip', levelName: 'custom', maxPlayers: 100 });
  const detection = portability.detectServer({ dir: server.dir, servers: [] });
  assert.strictEqual(detection.ok, true);
  assert.strictEqual(detection.serverProperties.port, 25580);
  assert.strictEqual(detection.serverProperties.motd, 'Round Trip');
  assert.strictEqual(detection.serverProperties.levelName, 'custom');
  assert.strictEqual(detection.serverProperties.maxPlayers, 100);

  const descriptor = portability.buildDescriptor({ detection, name: 'Round Trip' });
  assert.strictEqual(descriptor.type, 'minecraft');
  assert.strictEqual(descriptor.jar, 'paper-1.20.1.jar');
  assert.ok(descriptor.worlds.includes('custom'));
});

(async () => {
  for (const [name, fn] of tests) {
    await fn();
    console.log(`  ok  ${name}`);
  }
  console.log('minecraft portability tests passed');
  teardown();
})().catch((error) => {
  console.error(error);
  teardown();
  process.exitCode = 1;
});
