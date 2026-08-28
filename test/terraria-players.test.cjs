'use strict';

/*
 * RED contract for the vanilla Terraria Players tab.
 *
 * React is not mounted in this repository's plain Node test wave, so the view
 * selection and JSX surface are inspected as source. The live-roster assertions
 * below exercise the real Terraria module against the captured vanilla console
 * lines; that keeps the frontend contract tied to the normalized status payload
 * rather than to a second, invented player API.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PLAYERS_VIEW = path.join(ROOT, 'src', 'views', 'PlayersView.jsx');
const TERRARIA_PLAYERS_VIEW = path.join(ROOT, 'src', 'views', 'TerrariaPlayersView.jsx');
const APP = path.join(ROOT, 'src', 'App.jsx');
const SERVER = path.join(ROOT, 'server.js');

function read(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); }
  catch { return ''; }
}

const playersSource = read(PLAYERS_VIEW);
const appSource = read(APP);
const serverSource = read(SERVER);
const terrariaViewSource = read(TERRARIA_PLAYERS_VIEW);


function selectionSource() {
  const start = playersSource.indexOf('export function PlayersView()');
  if (start < 0) return '';
  const end = playersSource.indexOf('\n}', start);
  return end < 0 ? playersSource.slice(start) : playersSource.slice(start, end + 2);
}

function dedicatedRouteSource() {
  const inline = serverSource;
  const extracted = read(path.join(ROOT, 'lib', 'routes', 'terraria-players.cjs'));
  return `${inline}\n${extracted}`;
}

function requireTerrariaView() {
  assert.ok(
    terrariaViewSource,
    'vanilla Terraria must have a dedicated TerrariaPlayersView.jsx surface',
  );
  return terrariaViewSource;
}

function fixtureLines(name) {
  return read(path.join(ROOT, 'test', 'fixtures', 'terraria', name))
    .split('\n')
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('> '));
}

function fakeManager(desc = {}) {
  return {
    status: 'online',
    moduleState: {},
    sent: [],
    desc: () => ({ terrariaVariant: 'vanilla', ...desc }),
    _afterPlayerChange() {},
    _startModulePolling() {},
    sendCommand(command) { this.sent.push(command); return { ok: true }; },
  };
}

function vanillaRosterStatus() {
  const createTerrariaModule = require('../lib/modules/terraria/manager.cjs');
  const module = createTerrariaModule();
  const manager = fakeManager();
  module.onOnline(manager);
  for (const line of fixtureLines('vanilla-players.log').filter((entry) => entry.endsWith('has joined.'))) {
    module.inspectLine(line, manager);
  }
  return { module, manager, status: module.statusFields(manager) };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// --- routing -----------------------------------------------------------------

test('vanilla Terraria selects a Terraria player surface, never MinecraftPlayersView', () => {
  const selection = selectionSource();
  assert.ok(selection, 'PlayersView must expose a selectable component boundary');
  assert.match(selection, /activeServer\?\.type\s*===\s*['"]terraria['"]/, 'selection must identify Terraria by server type');
  assert.match(selection, /TerrariaPlayersView/, 'the Terraria branch must render a dedicated player view');
  assert.doesNotMatch(selection, /return\s*<MinecraftPlayersView\s*\/>/, 'the Terraria branch must not fall through to MinecraftPlayersView');
});

test('TShock keeps its existing dedicated view while vanilla uses the new surface', () => {
  assert.match(appSource, /supports\(['"]terraria-tshock['"]\)\s*\?\s*<TerrariaTshockView\s*\/>\s*:\s*<PlayersView\s*\/>/);
  assert.match(playersSource, /TerrariaPlayersView/, 'PlayersView must import the vanilla Terraria surface');
});

// --- live roster and status contract ----------------------------------------

test('the Terraria view consumes the normalized live status roster and slot state', () => {
  const { status } = vanillaRosterStatus();
  assert.deepEqual(status.players, ['Hostkind Guest', 'Zoë Müller']);
  assert.equal(status.playerCount, 2);
  assert.equal(typeof status.maxPlayers, 'number');

  const view = requireTerrariaView();
  assert.match(view, /useServer\(\)/, 'the view must consume the shared server status context');
  assert.match(view, /status(?:\?\.)?\.players/, 'the roster source is status.players, not a Minecraft list');
  assert.match(view, /status(?:\?\.)?\.playerCount/, 'the normalized player count is represented');
  assert.match(view, /status(?:\?\.)?\.maxPlayers/, 'the normalized slot limit is represented');
});

test('an empty or offline vanilla roster has an explicit status and EmptyState path', () => {
  const { module, manager } = vanillaRosterStatus();
  assert.equal(manager.moduleState.players.size, 2);
  manager.moduleState.players.clear();
  const emptyStatus = module.statusFields(manager);
  assert.deepEqual(emptyStatus.players, []);
  assert.equal(emptyStatus.playerCount, 0);

  const view = requireTerrariaView();
  assert.match(view, /<EmptyState\b/, 'zero players must render an empty state');
  assert.match(view, /(?:players|roster)[^\n]{0,180}(?:length|playerCount)[^\n]{0,80}(?:===\s*0|!|<=\s*0)/i, 'the empty branch must be tied to the roster count');
  assert.match(view, /status(?:\?\.)?\.status|processStatus/, 'offline/starting state must be represented rather than looking like a Minecraft list');
});

// --- Minecraft surface exclusions -------------------------------------------

test('the Terraria UI does not call Minecraft list, whitelist, lookup, or mutation endpoints', () => {
  const view = requireTerrariaView();
  for (const forbidden of [
    '/api/playerlists',
    '/api/players/lookup',
    '/api/whitelist',
    '/api/players/${',
    '/api/players/:',
  ]) {
    assert.equal(view.includes(forbidden), false, `Terraria UI must not use ${forbidden}`);
  }
  assert.doesNotMatch(view, /minecraft\.players/i, 'Terraria labels must not be sourced from Minecraft player translations');
  assert.doesNotMatch(view, /\b(?:whitelist|whitelisted|opAdd|opRemove|pardon|makeOp|removeOp)\b/i, 'Minecraft-only player controls must not be rendered');
});

test('the Terraria UI has no Mojang or Minotar character-image behavior', () => {
  const view = requireTerrariaView();
  assert.doesNotMatch(view, /minotar\.net|api\.mojang\.com|Mojang/i);
});

// --- Terraria-specific action contract --------------------------------------

test('vanilla player actions are scoped to Terraria and use an explicit target payload', () => {
  const { CAPABILITIES } = require('../lib/capabilities.cjs');
  const { matchTerrariaRoute } = require('../lib/modules/terraria/routes.cjs');
  assert.deepEqual(matchTerrariaRoute('/terraria/players', 'GET'), {
    capability: CAPABILITIES.PLAYERS_VIEW,
    explicit: true,
  });
  assert.deepEqual(matchTerrariaRoute('/terraria/players/kick', 'POST'), {
    capability: CAPABILITIES.PLAYERS_MANAGE,
    explicit: true,
  });

  const route = dedicatedRouteSource();
  assert.match(route, /(?:app|router)\.post\(\s*['"](?:\/api)?\/terraria\/players\/?:action/,
    'the action endpoint must be under /api/terraria/players/:action');
  assert.match(route, /req\.body\??\.target|req\.body\s*&&\s*req\.body\.target/,
    'the Terraria action payload must name its target explicitly');
  assert.match(route, /res\.json\(\s*(?:result|\{\s*ok)/,
    'supported actions must return a JSON result with ok=true');
  assert.match(route, /unsupported_action|invalid_action/,
    'the endpoint must expose a structured rejection for unsupported actions');
});

test('the Terraria module accepts only evidenced vanilla kick/ban actions and rejects Minecraft actions', () => {
  const createTerrariaModule = require('../lib/modules/terraria/manager.cjs');
  const module = createTerrariaModule();
  assert.equal(typeof module.playerAction, 'function', 'Terraria must own its player-action contract');

  for (const action of ['kick', 'ban']) {
    const manager = fakeManager();
    const result = module.playerAction(manager, action, 'Hostkind Guest');
    assert.equal(result.ok, true, `${action} is a supported vanilla console action`);
    assert.equal(result.source, 'console');
    assert.equal(manager.sent.length, 1);
    assert.match(manager.sent[0], new RegExp(`^${action}\\s+`));
    assert.match(manager.sent[0], /Hostkind Guest/);
  }

  for (const action of ['op', 'deop', 'whitelist-add', 'whitelist-remove', 'pardon', 'unban']) {
    const manager = fakeManager();
    assert.throws(
      () => module.playerAction(manager, action, 'Hostkind Guest'),
      (error) => error && error.code === 'unsupported_action',
      `${action} is a Minecraft/TShock action and must be rejected by vanilla Terraria`,
    );
    assert.deepEqual(manager.sent, [], `${action} must not reach the Terraria console`);
  }

  const route = dedicatedRouteSource();
  assert.match(route, /playerAction\s*\(/, 'the route must delegate to the Terraria module, not generic Minecraft commands');
});

// --- optional character image ------------------------------------------------

test('a missing character image stays blank and never falls back to a Minecraft skin URL', () => {
  const { status } = vanillaRosterStatus();
  const player = status.players[0];
  assert.equal(typeof player, 'string', 'vanilla status roster entries are names, not Minecraft UUID records');

  const view = requireTerrariaView();
  assert.doesNotMatch(view, /https?:\/\/[^'"`]*minotar|https?:\/\/[^'"`]*mojang/i);

  // An implementation may omit the image entirely. If it renders an optional
  // <img>, its source must have an explicit empty fallback for absent data.
  const imageTags = view.match(/<img\b[\s\S]*?>/gi) || [];
  for (const tag of imageTags) {
    const source = tag.match(/\bsrc\s*=\s*\{([^}]*)\}/i)?.[1] || '';
    if (source) assert.match(source, /\|\||\?\?|['"]\s*['"]/, `missing image must resolve to blank: ${tag}`);
  }
});

// --- run ---------------------------------------------------------------------

let failed = 0;
(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok  ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL  ${name}`);
      console.error(error);
    }
  }
  if (failed) {
    console.error(`${failed} of ${tests.length} terraria players tests failed`);
    process.exitCode = 1;
  } else {
    console.log('PASS  terraria-players');
  }
})();
