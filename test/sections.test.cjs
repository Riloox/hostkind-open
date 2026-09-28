'use strict';

/*
 * src/lib/sections.js: which sections and tabs each game's server shows, and
 * where a location the server cannot show goes instead.
 *
 * sections.js is browser ESM in a CommonJS package, so it is copied to a
 * temporary .mjs and imported from there.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

async function loadSections() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'sections.js'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-sections-'));
  const file = path.join(dir, 'sections.mjs');
  fs.writeFileSync(file, source);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The capabilities each module declares (lib/modules/*/manager.cjs,
// lib/modules/terraria/variants.cjs).
const MODULES = {
  minecraft: ['console', 'players', 'addons', 'content-install', 'worlds', 'map', 'configs', 'files', 'backups', 'schedules', 'metrics', 'watchdog', 'updates'],
  palworld: ['console', 'configs', 'files', 'backups', 'schedules', 'metrics', 'watchdog', 'rest-api', 'players', 'announcements', 'map', 'palworld-map', 'updates', 'palworld-updates', 'addons', 'palworld-mods'],
  terraria: ['console', 'files', 'backups', 'schedules', 'metrics', 'watchdog', 'updates', 'players', 'configs', 'terraria-worlds', 'terraria-config'],
  tmodloader: ['console', 'files', 'backups', 'schedules', 'metrics', 'watchdog', 'updates', 'players', 'configs', 'terraria-worlds', 'terraria-config', 'terraria-mods'],
  valheim: ['console', 'files', 'schedules', 'metrics', 'watchdog', 'valheim-status', 'updates', 'valheim-updates', 'valheim-worlds'],
  custom: ['console', 'files', 'backups', 'schedules', 'metrics', 'watchdog'],
};

const ctx = (module, grants = null) => ({
  supports: (capability) => MODULES[module].includes(capability),
  can: (capability) => grants === null || grants.includes(capability),
});

(async () => {
  const { visibleTabs, viewAvailable, resolveTab, settleSection } = await loadSections();
  const tabs = (view, module, grants) => visibleTabs(view, ctx(module, grants)).map((entry) => entry.tab);
  const sections = (module, grants) => ['console', 'players', 'worlds', 'mods', 'backups', 'tasks', 'settings']
    .filter((view) => viewAvailable(view, ctx(module, grants)));

  // At most eight sidebar items: overview plus these.
  assert.deepStrictEqual(sections('minecraft'), ['console', 'players', 'worlds', 'mods', 'backups', 'tasks', 'settings']);
  assert.deepStrictEqual(sections('palworld'), ['console', 'players', 'worlds', 'mods', 'backups', 'tasks', 'settings']);
  assert.deepStrictEqual(sections('terraria'), ['console', 'players', 'worlds', 'backups', 'tasks', 'settings'],
    'vanilla Terraria has no mods, and its "updates" capability is not plugin updates');
  assert.deepStrictEqual(sections('valheim'), ['console', 'worlds', 'tasks', 'settings']);
  assert.deepStrictEqual(sections('custom'), ['console', 'backups', 'tasks', 'settings']);

  assert.deepStrictEqual(tabs('mods', 'minecraft'), ['installed', 'browse', 'updates']);
  assert.deepStrictEqual(tabs('mods', 'palworld'), ['installed']);
  assert.deepStrictEqual(tabs('mods', 'tmodloader'), ['installed']);
  assert.deepStrictEqual(tabs('worlds', 'minecraft'), ['worlds', 'map']);
  assert.deepStrictEqual(tabs('worlds', 'palworld'), ['map']);
  assert.deepStrictEqual(tabs('worlds', 'valheim'), ['worlds']);
  assert.deepStrictEqual(tabs('settings', 'minecraft'), ['game', 'general', 'files']);
  assert.deepStrictEqual(tabs('settings', 'palworld'), ['game', 'general', 'version', 'files']);
  assert.deepStrictEqual(tabs('settings', 'valheim'), ['general', 'version', 'files']);
  assert.deepStrictEqual(tabs('settings', 'custom'), ['general', 'files']);

  // User grants gate tabs as well as sections.
  assert.deepStrictEqual(tabs('worlds', 'minecraft', []), ['map'], 'no worlds.view: only the map');
  assert.strictEqual(viewAvailable('players', ctx('minecraft', [])), false);
  assert.strictEqual(viewAvailable('worlds', ctx('valheim', [])), false);

  assert.strictEqual(resolveTab('mods', null, ctx('minecraft')), 'installed');
  assert.strictEqual(resolveTab('mods', 'browse', ctx('minecraft')), 'browse');
  assert.strictEqual(resolveTab('mods', 'browse', ctx('palworld')), 'installed');
  assert.strictEqual(resolveTab('settings', null, ctx('valheim')), 'general');

  // settleSection
  assert.strictEqual(settleSection('mods', 'updates', ctx('minecraft')), null);
  assert.strictEqual(settleSection('mods', null, ctx('minecraft')), null);
  assert.deepStrictEqual(settleSection('mods', 'updates', ctx('palworld')), { view: 'settings', tab: 'version' },
    'an old "updates" link on Palworld meant the game build');
  assert.deepStrictEqual(settleSection('mods', 'updates', ctx('valheim')), { view: 'settings', tab: 'version' });
  assert.deepStrictEqual(settleSection('mods', 'updates', ctx('terraria')), { view: 'dashboard', tab: null });
  assert.deepStrictEqual(settleSection('mods', 'browse', ctx('palworld')), { view: 'mods', tab: null });
  assert.deepStrictEqual(settleSection('worlds', 'map', ctx('valheim')), { view: 'worlds', tab: null });
  assert.deepStrictEqual(settleSection('mods', null, ctx('custom')), { view: 'dashboard', tab: null });
  assert.deepStrictEqual(settleSection('players', null, ctx('valheim')), { view: 'dashboard', tab: null });
  assert.strictEqual(settleSection('details', null, ctx('custom')), null);
  assert.strictEqual(settleSection('crashes', 'g1', ctx('custom')), null);

  console.log('sections tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
