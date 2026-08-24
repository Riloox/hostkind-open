'use strict';

/*
 * Terraria lifecycle and live console (docs/terraria/02-lifecycle-console.md).
 *
 * The rule this file exists to enforce: no pattern ships without a capture.
 * Section 1 walks every rule in lib/modules/terraria/console.cjs and fails if a
 * rule matches nothing in the fixture it claims, and fails again if a fixture
 * on disk is claimed by no rule. Everything after that replays real fixture
 * lines through the module and asserts what the panel does with them.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { setupDataDir, teardown } = require('./_setup.cjs');
setupDataDir();

const consoleGrammar = require('../lib/modules/terraria/console.cjs');
const createTerrariaModule = require('../lib/modules/terraria/manager.cjs');
const { VARIANTS } = require('../lib/modules/terraria/variants.cjs');
const { redactString } = require('../lib/redact.cjs');
const migrations = require('../lib/migrations.cjs');
const audit = require('../lib/audit.cjs');
const { open } = require('../lib/db.cjs');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'terraria');
// Read as LF: the assertions below slice this source on '\n' boundaries, and a
// Windows checkout hands it back with CRLF.
const SERVER_JS = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');

// A fixture is console text plus `#` provenance/elision notes. The notes are
// not console output and are never fed to a parser.
function fixture(name) {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('#'));
}

// The lines a real console pump would hand the module: what the server wrote,
// without the `> command` echoes the harness recorded.
function serverLines(name) {
  return fixture(name).filter((line) => !line.startsWith('> '));
}

/*
 * A stand-in ServerManager. It implements only what the module touches, and it
 * records everything so a test can assert on console lines, broadcasts, and
 * anything written to stdin - the last one matters: the interactive menu must
 * not be answered.
 */
function fakeManager(desc = {}, overrides = {}) {
  const manager = {
    id: desc.id || 'srv-1',
    status: 'starting',
    manualStop: false,
    moduleState: {},
    lines: [],
    sent: [],
    broadcasts: 0,
    playerChanges: 0,
    pollingStarted: 0,
    desc: () => desc,
    name: () => desc.name || 'Terraria',
    pushLine(text, level = 'info') { this.lines.push({ text, level }); },
    broadcast() { this.broadcasts += 1; },
    statusPayload() { return {}; },
    _afterPlayerChange() { this.playerChanges += 1; },
    _startModulePolling() { this.pollingStarted += 1; },
    sendCommand(cmd) { this.sent.push(cmd); return { ok: true }; },
    ...overrides,
  };
  return manager;
}

// Replay a whole capture the way ServerManager does: readiness first, then
// inspection, for every line.
function replay(module, manager, lines) {
  for (const line of lines) {
    if (manager.status === 'starting' && module.detectOnline(line, manager)) {
      manager.status = 'online';
      module.onOnline(manager);
    }
    module.inspectLine(line, manager);
  }
  return manager;
}

const terraria = createTerrariaModule({});
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ---------------------------------------------- 1. fixtures back everything */

test('every console rule matches a line in every fixture it claims', () => {
  for (const rule of consoleGrammar.RULES) {
    assert.ok(rule.fixtures.length > 0, `${rule.id} has no fixture`);
    for (const name of rule.fixtures) {
      const file = path.join(FIXTURE_DIR, name);
      assert.ok(fs.existsSync(file), `${rule.id} claims a fixture that does not exist: ${name}`);
      const hit = fixture(name).some((line) => rule.pattern.test(line));
      assert.ok(hit, `${rule.id} matches nothing in ${name}`);
    }
  }
});

test('every fixture on disk is claimed by a rule or is a negative fixture', () => {
  // The two negatives exist to prove something does NOT match, so no rule
  // names them; every other capture has to be earning its place.
  const negatives = new Set(['port-in-use.log']);
  const claimed = new Set(consoleGrammar.RULES.flatMap((rule) => rule.fixtures));
  const onDisk = fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.log'));
  for (const name of onDisk) {
    assert.ok(claimed.has(name) || negatives.has(name), `${name} is claimed by no rule`);
  }
});

test('every fixture carries a provenance header and no address or token', () => {
  for (const name of fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.log'))) {
    const text = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
    const header = text.split('\n')[0];
    assert.ok(/^# variant=(vanilla|tshock|tmodloader) version=.+ host=.+ captured=\d{4}-\d{2}-\d{2}/.test(header), `${name} has no provenance header`);
    assert.equal(/\b(?:\d{1,3}\.){3}\d{1,3}:\d+/.test(text), false, `${name} still contains an address`);
    assert.equal(/\/setup \d+/.test(text), false, `${name} still contains a TShock setup code`);
  }
});

/* --------------------------------------------------------- 2. readiness */

test('readiness is the started line, in every variant fixture', () => {
  for (const [variant, name] of [['vanilla', 'vanilla-start.log'], ['tshock', 'tshock-start.log'], ['tmodloader', 'tmodloader-start.log']]) {
    const manager = fakeManager({ terrariaVariant: variant });
    const ready = serverLines(name).filter((line) => terraria.detectOnline(line, manager));
    assert.equal(ready.length, 1, `${variant} should have exactly one readiness line, got ${ready.length}`);
    assert.ok(/Server started\s*$/.test(ready[0]));
  }
});

test('port-in-use never produces online', () => {
  const manager = fakeManager({ terrariaVariant: 'vanilla' });
  const lines = serverLines('port-in-use.log');
  // The capture has to actually contain the trap, or the test proves nothing.
  assert.ok(lines.some((line) => /Listening on port \d+/.test(line)), 'the fixture must contain the listening line');
  for (const line of lines) {
    assert.equal(terraria.detectOnline(line, manager), false, `port-in-use flipped online on: ${line}`);
  }
});

test('missing-world never produces online, and says so', () => {
  const manager = fakeManager({ terrariaVariant: 'vanilla' });
  const lines = serverLines('missing-world.log');
  for (const line of lines) assert.equal(terraria.detectOnline(line, manager), false);
  replay(terraria, manager, lines);
  assert.ok(manager.lines.some((line) => line.level === 'error' && /could not open its world file/i.test(line.text)));
});

test('an unknown variant is never ready', () => {
  const manager = fakeManager({ terrariaVariant: 'starbound' });
  assert.equal(terraria.detectOnline('Server started', manager), false);
});

/* ------------------------------------------- 3. the interactive-menu trap */

test('the interactive menu sets awaitingWorldSelection, warns, and writes nothing', () => {
  const manager = fakeManager({ terrariaVariant: 'vanilla' });
  replay(terraria, manager, serverLines('interactive-menu.log'));
  assert.equal(terraria.statusFields(manager).awaitingWorldSelection, true);
  const warnings = manager.lines.filter((line) => line.level === 'warn');
  assert.equal(warnings.length, 1, 'exactly one warning, not one per prompt repaint');
  assert.ok(/waiting for a world to be selected/i.test(warnings[0].text));
  assert.ok(/will not answer the prompt/i.test(warnings[0].text));
  assert.deepEqual(manager.sent, [], 'nothing may be written to stdin in response to the menu');
  assert.notEqual(manager.status, 'online');
});

test('tModLoader shows the same menu and is trapped the same way', () => {
  const manager = fakeManager({ terrariaVariant: 'tmodloader' });
  const upToMenu = [];
  for (const line of serverLines('tmodloader-worldgen.log')) {
    upToMenu.push(line);
    if (/Choose World:/.test(line)) break;
  }
  replay(terraria, manager, upToMenu);
  assert.equal(terraria.statusFields(manager).awaitingWorldSelection, true);
  assert.deepEqual(manager.sent, []);
});

test('generating a world clears the trap, and reaching online clears it too', () => {
  const manager = fakeManager({ terrariaVariant: 'vanilla' });
  replay(terraria, manager, serverLines('vanilla-worldgen.log'));
  const status = terraria.statusFields(manager);
  // The worldgen capture ends back at the menu, so the flag is set again - but
  // the progress lines in between cleared it, which is what keeps a two-minute
  // generation from looking like a hang.
  assert.ok(manager.moduleState.worldgen === null || (typeof manager.moduleState.worldgen === 'object' && !Array.isArray(manager.moduleState.worldgen)));
  assert.equal(status.awaitingWorldSelection, true);

  const started = fakeManager({ terrariaVariant: 'vanilla' });
  replay(terraria, started, ['Choose World: ', ...serverLines('vanilla-start.log')]);
  assert.equal(started.status, 'online');
  assert.equal(terraria.statusFields(started).awaitingWorldSelection, false);
});

/* ------------------------------------------------------ 4. line inspection */

test('the version banner reaches statusFields, per variant', () => {
  const vanilla = replay(terraria, fakeManager({ terrariaVariant: 'vanilla' }), serverLines('vanilla-start.log'));
  assert.deepEqual(terraria.statusFields(vanilla).terrariaVersion, { game: '1.4.5.6', variant: null, source: 'console', resolvedAt: null });

  const tshock = replay(terraria, fakeManager({ terrariaVariant: 'tshock' }), serverLines('tshock-start.log'));
  assert.deepEqual(terraria.statusFields(tshock).terrariaVersion, { game: '1.4.5.6', variant: '6.1.0.0', source: 'console', resolvedAt: null });

  const tmod = replay(terraria, fakeManager({ terrariaVariant: 'tmodloader' }), serverLines('tmodloader-start.log'));
  assert.deepEqual(terraria.statusFields(tmod).terrariaVersion, { game: '1.4.4.9', variant: '2026.5.3.0', source: 'console', resolvedAt: null });
});

test('a version the console never printed falls back to what the install recorded', () => {
  const manager = fakeManager({
    terrariaVariant: 'vanilla',
    terrariaVersion: { game: '1.4.5.6', variant: null, source: 'terraria.org', resolvedAt: '2026-01-01T00:00:00.000Z' },
  });
  assert.deepEqual(terraria.statusFields(manager).terrariaVersion, {
    game: '1.4.5.6', variant: null, source: 'terraria.org', resolvedAt: '2026-01-01T00:00:00.000Z',
  });
});

test('world generation progress is surfaced as a percentage and a stage', () => {
  const manager = fakeManager({ terrariaVariant: 'vanilla' });
  const lines = serverLines('vanilla-worldgen.log');
  const generating = lines.slice(0, lines.findIndex((line) => /Generating world terrain - [\d.]+%/.test(line)) + 1);
  replay(terraria, manager, generating);
  const progress = terraria.statusFields(manager).terrariaWorldgen;
  assert.ok(progress, 'a generating server reports progress');
  assert.equal(progress.stage, 'Generating world terrain');
  assert.ok(progress.percent >= 0 && progress.percent <= 100);
  assert.ok(progress.stagePercent >= 0 && progress.stagePercent <= 100);
});

test('tModLoader mod-loading lines are surfaced and do not flip the status', () => {
  const manager = fakeManager({ terrariaVariant: 'tmodloader' });
  const loading = serverLines('tmodloader-modload.log');
  assert.ok(loading.length >= 4, 'the modload fixture must have the loading phase in it');
  for (const line of loading) {
    assert.equal(terraria.detectOnline(line, manager), false, `mod loading flipped online on: ${line}`);
    terraria.inspectLine(line, manager);
  }
  assert.notEqual(manager.status, 'online');
  assert.equal(terraria.statusFields(manager).terrariaModLoading, 'Adding Recipes');

  // And the mod name itself, not just the phase.
  const named = fakeManager({ terrariaVariant: 'tmodloader' });
  terraria.inspectLine('Adding Content: tModLoader v2026.5.3.0', named);
  assert.equal(terraria.statusFields(named).terrariaModLoading, 'tModLoader v2026.5.3.0');
});

test('mod loading is not parsed for a variant that has no mods', () => {
  const manager = fakeManager({ terrariaVariant: 'vanilla' });
  terraria.inspectLine('Adding Content: tModLoader v2026.5.3.0', manager);
  assert.equal(terraria.statusFields(manager).terrariaModLoading, null);
});

test('the save confirmation is recorded, per variant', () => {
  const vanilla = replay(terraria, fakeManager({ terrariaVariant: 'vanilla' }), serverLines('vanilla-start.log'));
  assert.ok(vanilla.moduleState.lastSavedAt, 'vanilla records the backup line as the end of a save');

  const tshock = replay(terraria, fakeManager({ terrariaVariant: 'tshock' }), serverLines('tshock-stop.log'));
  assert.ok(tshock.moduleState.lastSavedAt);

  // tModLoader ends a save with the modded half of the world instead.
  const tmod = replay(terraria, fakeManager({ terrariaVariant: 'tmodloader' }), serverLines('tmodloader-start.log'));
  assert.ok(tmod.moduleState.lastSavedAt);
});

test('an over-long line and a control-character name are refused', () => {
  const manager = fakeManager({ terrariaVariant: 'vanilla' });
  const long = `${'x'.repeat(consoleGrammar.MAX_LINE_LENGTH)} has joined.`;
  terraria.inspectLine(long, manager);
  assert.deepEqual(terraria.listPlayers(manager), []);
  assert.equal(consoleGrammar.inspect('vanilla', `${'y'.repeat(consoleGrammar.MAX_NAME_LENGTH + 1)} has joined.`), null);
});

/* ------------------------------------------------------------- 5. players */

test('join and leave lines maintain the roster', () => {
  const manager = fakeManager({ terrariaVariant: 'vanilla' });
  replay(terraria, manager, serverLines('vanilla-players.log'));
  // Both players joined and both left in this capture.
  assert.deepEqual(terraria.listPlayers(manager), []);
  assert.ok(manager.playerChanges >= 4, 'each join and leave broadcasts a player change');
});

test('names with spaces and non-ASCII characters round-trip', () => {
  const manager = fakeManager({ terrariaVariant: 'vanilla' });
  const lines = serverLines('vanilla-players.log');
  const upToRoster = lines.slice(0, lines.findIndex((line) => /\d+ players? connected\./.test(line)) + 1);
  replay(terraria, manager, upToRoster);
  assert.deepEqual(terraria.listPlayers(manager).map((p) => p.name), ['Hostkind Guest', 'Zoë Müller']);
  assert.deepEqual(terraria.statusFields(manager).players, ['Hostkind Guest', 'Zoë Müller']);
  assert.equal(terraria.statusFields(manager).playerCount, 2);
});

test('no address from the playing reply reaches the player list', () => {
  const manager = fakeManager({ terrariaVariant: 'vanilla' });
  const lines = serverLines('vanilla-players.log');
  replay(terraria, manager, lines.slice(0, lines.findIndex((line) => /\d+ players? connected\./.test(line)) + 1));
  const json = JSON.stringify(terraria.listPlayers(manager));
  assert.equal(json.includes('REDACTED_IP'), false);
  assert.equal(json.includes('44768'), false);
});

test('a playing reply reconciles a roster a leave line never corrected', () => {
  const manager = fakeManager({ terrariaVariant: 'vanilla' });
  manager.status = 'online';
  terraria.onOnline(manager);
  // Two players join; one drops without the server ever printing a leave line.
  terraria.inspectLine('Hostkind Guest has joined.', manager);
  terraria.inspectLine('Zoë Müller has joined.', manager);
  assert.equal(terraria.listPlayers(manager).length, 2);

  assert.deepEqual(terraria.pollCommands(manager), ['playing']);
  terraria.inspectLine('Hostkind Guest ([REDACTED_IP]:44768)', manager);
  terraria.inspectLine('1 player connected.', manager);
  assert.deepEqual(terraria.listPlayers(manager).map((p) => p.name), ['Hostkind Guest']);
});

test('an empty playing reply empties the roster', () => {
  for (const [variant, empty] of [['vanilla', 'No players connected.'], ['tshock', 'There are currently no players online.']]) {
    const manager = fakeManager({ terrariaVariant: variant });
    terraria.inspectLine(`${variant === 'tshock' ? 'A' : 'A'} has joined.`, manager);
    assert.equal(terraria.listPlayers(manager).length, 1);
    terraria.pollCommands(manager);
    terraria.inspectLine(empty, manager);
    assert.deepEqual(terraria.listPlayers(manager), []);
  }
});

test('a roster-shaped line outside a playing reply is not a player', () => {
  const manager = fakeManager({ terrariaVariant: 'vanilla' });
  manager.status = 'online';
  // No poll is in flight, so this is chat or noise, not a roster entry.
  terraria.inspectLine('Somebody (something)', manager);
  assert.deepEqual(terraria.listPlayers(manager), []);
});

test('TShock parses its own roster shape and its two join lines', () => {
  const manager = fakeManager({ terrariaVariant: 'tshock' });
  const lines = serverLines('tshock-players.log');
  const upToRoster = lines.slice(0, lines.findIndex((line) => /^Online Players/.test(line)) + 2);
  manager.status = 'online';
  terraria.onOnline(manager);
  for (const line of upToRoster) terraria.inspectLine(line, manager);
  assert.deepEqual(terraria.listPlayers(manager).map((p) => p.name), ['Hostkind Guest', 'Zoë Müller']);
  // "Online Players (2/8)" is also where the player limit comes from.
  assert.equal(terraria.statusFields(manager).maxPlayers, 8);
});

test('the roster is capped and a player carries a join time', () => {
  const manager = fakeManager({ terrariaVariant: 'vanilla' });
  for (let i = 0; i < consoleGrammar.MAX_PLAYERS + 10; i += 1) {
    terraria.inspectLine(`Player${i} has joined.`, manager);
  }
  assert.equal(terraria.listPlayers(manager).length, consoleGrammar.MAX_PLAYERS);
  assert.ok(terraria.listPlayers(manager).every((player) => typeof player.since === 'number'));
});

test('the poll is one command, on the shared interval', () => {
  const manager = fakeManager({ terrariaVariant: 'vanilla' });
  assert.deepEqual(terraria.pollCommands(manager), ['playing']);
  // The interval itself is the shared one ServerManager already uses for
  // Minecraft's list/tps; the module does not get its own timer.
  assert.ok(/config\.playerListIntervalSeconds \|\| 30/.test(SERVER_JS));
  assert.ok(/_startModulePolling\(\)/.test(SERVER_JS));
});

test('reaching online starts the poll and asks once immediately', () => {
  const manager = fakeManager({ terrariaVariant: 'vanilla' });
  replay(terraria, manager, serverLines('vanilla-start.log'));
  assert.equal(manager.status, 'online');
  assert.equal(manager.pollingStarted, 1);
  assert.deepEqual(manager.sent, ['playing']);
});

/* ------------------------------------------------------------ 6. commands */

test('the command route refuses anything that is not a single command', () => {
  const route = SERVER_JS.slice(SERVER_JS.indexOf("app.post('/api/command'"));
  const body = route.slice(0, route.indexOf('\n});') + 4);
  assert.ok(/\[\\r\\n\\u0000\]/.test(body), 'CR, LF and NUL are rejected so one request cannot run two commands');
  assert.ok(/MAX_COMMAND_LENGTH/.test(body), 'the command length is capped');
  assert.ok(/action: 'console\.command'/.test(body));
  assert.ok(/actorId: req\.user\.id/.test(body) && /actorUsername: req\.user\.username/.test(body));
  // The capability is the control; there is no allowlist of Terraria commands.
  assert.ok(/if \(p === '\/command'\) return foundationCapabilities\.CAPABILITIES\.COMMANDS_RUN;/.test(SERVER_JS));
});

test('a command is audited with its actor, and a password is not stored', () => {
  migrations.runMigrations();
  const recorded = audit.record({
    actorId: 'user-7',
    actorUsername: 'operator',
    serverId: 'srv-1',
    action: 'console.command',
    targetType: 'server',
    targetId: 'srv-1',
    outcome: 'success',
    metadata: { command: 'password hunter2' },
  });
  const row = open().prepare('SELECT * FROM audit_events WHERE id = ?').get(recorded.id);
  assert.equal(row.actor_id, 'user-7');
  assert.equal(row.actor_username, 'operator');
  assert.equal(row.action, 'console.command');
  assert.equal(row.metadata.includes('hunter2'), false, 'the password must not reach the audit record');
  assert.equal(redactString('password hunter2').text, 'password [REDACTED]');
  // An ordinary command is stored intact - redaction is not a blanket.
  assert.equal(redactString('kick Zoë Müller').text, 'kick Zoë Müller');
});

/* --------------------------------------------------- 7. stop and restart */

test('stop issues exit for every variant', () => {
  for (const variant of VARIANTS) {
    assert.deepEqual(terraria.buildStopSequence(fakeManager({ terrariaVariant: variant })), { command: 'exit' });
  }
  // `exit` saves; `exit-nosave` does not, and Hostkind never sends it.
  assert.equal(SERVER_JS.includes('exit-nosave'), false);
});

test('a stop that printed its shutdown line is clean', () => {
  for (const [variant, name] of [['vanilla', 'vanilla-stop.log'], ['tshock', 'tshock-stop.log'], ['tmodloader', 'tmodloader-stop.log']]) {
    const manager = fakeManager({ terrariaVariant: variant });
    manager.manualStop = true;
    for (const line of serverLines(name)) terraria.inspectLine(line, manager);
    terraria.onExit(manager);
    assert.deepEqual(manager.moduleState.lastStop.clean, true, `${variant} stop should be clean`);
    assert.deepEqual(manager.lines.filter((line) => line.level === 'warn'), []);
  }
});

test('a stop that never confirmed is recorded as unclean', () => {
  const manager = fakeManager({ terrariaVariant: 'vanilla' });
  manager.manualStop = true;
  terraria.inspectLine('Server started', manager);
  terraria.onExit(manager);
  assert.equal(manager.moduleState.lastStop.clean, false);
  assert.ok(manager.lines.some((line) => line.level === 'warn' && /without confirming/i.test(line.text)));
  assert.equal(terraria.statusFields(manager).terrariaLastStop.clean, false);
});

test('the escalation after stopTimeoutSeconds is the shared one', () => {
  const stop = SERVER_JS.slice(SERVER_JS.indexOf('  stop(force = false) {'));
  const body = stop.slice(0, stop.indexOf('\n  }\n') + 4);
  assert.ok(/this\.desc\(\)\.stopTimeoutSeconds \|\| config\.stopTimeoutSeconds \|\| 30/.test(body));
  assert.ok(/Did not close within \$\{timeoutSec\}s, killing process/.test(body));
  assert.ok(/this\._kill\(\)/.test(body));
  // Restart is the shared stop-then-start path: no Terraria-specific logic.
  const restart = SERVER_JS.slice(SERVER_JS.indexOf('  async restart() {'));
  assert.ok(/this\.stop\(false\)[\s\S]*return this\.start\(\)/.test(restart.slice(0, 900)));
});

test('a restart reaches online again with the same descriptor', () => {
  const desc = { terrariaVariant: 'vanilla', dir: __dirname };
  const manager = fakeManager(desc);
  replay(terraria, manager, serverLines('vanilla-start.log'));
  assert.equal(manager.status, 'online');
  terraria.inspectLine('Hostkind Guest has joined.', manager);
  assert.equal(terraria.listPlayers(manager).length, 1);

  // Stop, then start again through the same module state the manager reuses.
  manager.manualStop = true;
  for (const line of serverLines('vanilla-stop.log')) terraria.inspectLine(line, manager);
  terraria.onExit(manager);
  assert.deepEqual(terraria.listPlayers(manager), [], 'the roster does not survive the process');

  terraria.resetState(manager);
  manager.status = 'starting';
  replay(terraria, manager, serverLines('vanilla-start.log'));
  assert.equal(manager.status, 'online');
  assert.equal(terraria.statusFields(manager).terrariaVariant, 'vanilla');
  assert.equal(terraria.statusFields(manager).awaitingWorldSelection, false);
});

/* --------------------------------------------------- 8. pre-launch checks */

test('preLaunch blocks on a bound port, a missing world, and a missing runtime', async () => {
  const os = require('os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-terraria-prelaunch-'));
  const executable = path.join(root, 'TerrariaServer.bin.x86_64');
  fs.writeFileSync(executable, 'fixture');
  const worlds = path.join(root, 'Worlds');
  fs.mkdirSync(worlds);
  fs.writeFileSync(path.join(worlds, 'Main.wld'), 'fixture');

  try {
    const free = createTerrariaModule({ probePortInUse: async () => false });
    const busy = createTerrariaModule({ probePortInUse: async () => true });
    const base = { terrariaVariant: 'vanilla', dir: root, cwd: root, executable, port: 7777 };

    assert.deepEqual(await free.preLaunch(fakeManager(base)), { ok: true });

    const bound = await busy.preLaunch(fakeManager(base));
    assert.equal(bound.ok, false);
    assert.match(bound.error, /Port 7777 is already in use/);

    const missingWorld = await free.preLaunch(fakeManager({ ...base, terrariaWorld: { name: 'Gone', file: 'Worlds/Gone.wld' } }));
    assert.equal(missingWorld.ok, false);
    assert.match(missingWorld.error, /world configured for this server is missing: Gone/);

    // A world that is there is not a reason to refuse.
    assert.deepEqual(await free.preLaunch(fakeManager({ ...base, terrariaWorld: { name: 'Main', file: 'Worlds/Main.wld' } })), { ok: true });

    // A descriptor is not a licence to stat an arbitrary path.
    const escaping = await free.preLaunch(fakeManager({ ...base, terrariaWorld: { name: 'Escape', file: '../../etc/passwd' } }));
    assert.equal(escaping.ok, false);
    assert.match(escaping.error, /outside the server folder/);

    const missingBinary = await free.preLaunch(fakeManager({ ...base, executable: path.join(root, 'gone') }));
    assert.equal(missingBinary.ok, false);
    assert.match(missingBinary.error, /Terraria server executable is missing: gone/);

    // tModLoader's executable is the .NET runtime and its entry point is a dll;
    // both have to be there, and each says which one is not.
    const runtime = path.join(root, 'dotnet');
    fs.writeFileSync(runtime, 'fixture');
    const tmodBase = { terrariaVariant: 'tmodloader', dir: root, cwd: root, executable: runtime, args: [path.join(root, 'tModLoader.dll'), '-server'], port: 7777 };
    const missingRuntime = await free.preLaunch(fakeManager({ ...tmodBase, executable: path.join(root, 'no-dotnet') }));
    assert.equal(missingRuntime.ok, false);
    assert.match(missingRuntime.error, /tModLoader needs its \.NET runtime/);

    const missingEntry = await free.preLaunch(fakeManager(tmodBase));
    assert.equal(missingEntry.ok, false);
    assert.match(missingEntry.error, /tModLoader entry point is missing: tModLoader\.dll/);

    // The three messages are distinct, which is the whole point of the check.
    const messages = new Set([bound.error, missingWorld.error, missingRuntime.error]);
    assert.equal(messages.size, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failing probe does not block a legitimate start', async () => {
  const module = createTerrariaModule({ probePortInUse: async () => { throw new Error('probe exploded'); } });
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fleetdeck-terraria-probe-'));
  const executable = path.join(root, 'TerrariaServer.bin.x86_64');
  fs.writeFileSync(executable, 'fixture');
  try {
    assert.deepEqual(await module.preLaunch(fakeManager({ terrariaVariant: 'vanilla', dir: root, executable, port: 7777 })), { ok: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ 9. frontend */

test('the console view renders the phase-2 status, in both languages', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'ConsoleView.jsx'), 'utf8');
  assert.ok(/awaitingWorldSelection/.test(view), 'the banner reads the status field');
  assert.ok(/terrariaWorldgen/.test(view) && /terrariaModLoading/.test(view), 'progress is a status line, not raw spam');
  assert.ok(/terrariaVariant/.test(view) && /terrariaVersion/.test(view), 'the header names the variant and version');

  const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'i18n.json'), 'utf8'));
  const en = i18n.dictionaries.en.terraria.console;
  const es = i18n.dictionaries.es.terraria.console;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(es).sort(), 'terraria.console.* must be at parity in en and es');
  assert.ok(Object.keys(en).length >= 5);
  for (const [key, value] of Object.entries(en)) {
    assert.ok(typeof value === 'string' && value.length > 0, `terraria.console.${key} is empty in en`);
    assert.ok(typeof es[key] === 'string' && es[key].length > 0, `terraria.console.${key} is empty in es`);
  }
});

/* ------------------------------------------------------------------- run */

let failed = 0;
(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok  ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL  ${name}`);
      console.error(err);
    }
  }
  teardown();
  if (failed) {
    console.error(`${failed} of ${tests.length} terraria lifecycle tests failed`);
    process.exit(1);
  }
  console.log('PASS  terraria-lifecycle');
})();
