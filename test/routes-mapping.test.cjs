'use strict';

/*
 * The URL model in src/lib/routes.js: server-scoped paths, top-level app
 * views, and the rewrite of every older link shape (the games hub and the
 * pre-hub paths) onto a server.
 *
 * routes.js is browser ESM in a CommonJS package, so it is copied to a
 * temporary .mjs and imported from there.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

async function loadRoutes() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'routes.js'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-routes-'));
  const file = path.join(dir, 'routes.mjs');
  fs.writeFileSync(file, source);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  const { parseLocation, buildPath, resolveLegacy, VIEW_PATHS, PANEL_TABS, SECTION_TAB_NAMES } = await loadRoutes();

  // parseLocation
  assert.deepStrictEqual(parseLocation('/'), { kind: 'home' });
  assert.deepStrictEqual(parseLocation(''), { kind: 'home' });
  assert.deepStrictEqual(parseLocation('/servers'), { kind: 'app', view: 'servers' });
  assert.deepStrictEqual(parseLocation('/servers/'), { kind: 'app', view: 'servers' });
  assert.deepStrictEqual(parseLocation('/servers/abc'), { kind: 'server', serverId: 'abc', view: 'dashboard' });
  assert.deepStrictEqual(parseLocation('/servers/abc/console'), { kind: 'server', serverId: 'abc', view: 'console' });
  assert.deepStrictEqual(parseLocation('/servers/abc/schedules'), { kind: 'server', serverId: 'abc', view: 'tasks' });
  assert.deepStrictEqual(parseLocation('/servers/abc/mods'), { kind: 'server', serverId: 'abc', view: 'mods' });
  assert.deepStrictEqual(parseLocation('/servers/abc/mods/browse'), { kind: 'server', serverId: 'abc', view: 'mods', tab: 'browse' });
  assert.deepStrictEqual(parseLocation('/servers/abc/mods/nonsense'), { kind: 'server', serverId: 'abc', view: 'mods' },
    'a tab the section cannot have is dropped');
  assert.deepStrictEqual(parseLocation('/servers/abc/worlds/map'), { kind: 'server', serverId: 'abc', view: 'worlds', tab: 'map' });
  assert.deepStrictEqual(parseLocation('/servers/abc/settings/files'), { kind: 'server', serverId: 'abc', view: 'settings', tab: 'files' });
  assert.deepStrictEqual(parseLocation('/servers/abc/details'), { kind: 'server', serverId: 'abc', view: 'details' });
  assert.deepStrictEqual(parseLocation('/servers/abc/crashes/g%201'), { kind: 'server', serverId: 'abc', view: 'crashes', tab: 'g 1' });
  assert.deepStrictEqual(parseLocation('/servers/abc/crashes'), { kind: 'server', serverId: 'abc', view: 'details' },
    'the crash list lives on the details page');
  // Sections that were merged: an old segment under a server parses to where it lives now.
  assert.deepStrictEqual(parseLocation('/servers/abc/metrics'), { kind: 'server', serverId: 'abc', view: 'details' });
  assert.deepStrictEqual(parseLocation('/servers/abc/health'), { kind: 'server', serverId: 'abc', view: 'details' });
  assert.deepStrictEqual(parseLocation('/servers/abc/addons'), { kind: 'server', serverId: 'abc', view: 'mods', tab: 'installed' });
  assert.deepStrictEqual(parseLocation('/servers/abc/content'), { kind: 'server', serverId: 'abc', view: 'mods', tab: 'browse' });
  assert.deepStrictEqual(parseLocation('/servers/abc/updates'), { kind: 'server', serverId: 'abc', view: 'mods', tab: 'updates' });
  assert.deepStrictEqual(parseLocation('/servers/abc/map'), { kind: 'server', serverId: 'abc', view: 'worlds', tab: 'map' });
  assert.deepStrictEqual(parseLocation('/servers/abc/configs'), { kind: 'server', serverId: 'abc', view: 'settings', tab: 'game' });
  assert.deepStrictEqual(parseLocation('/servers/abc/nonsense'), { kind: 'server', serverId: 'abc', view: 'dashboard' });
  assert.deepStrictEqual(parseLocation('/servers/abc/users'), { kind: 'server', serverId: 'abc', view: 'dashboard' },
    'an app view under a server is not a server view');
  assert.deepStrictEqual(parseLocation('/servers/a%20b/files'), { kind: 'server', serverId: 'a b', view: 'settings', tab: 'files' });
  // Hostkind settings owns the top-level /settings; a server's Settings is
  // only ever under /servers/<id>/.
  assert.deepStrictEqual(parseLocation('/settings'), { kind: 'app', view: 'panel' });
  assert.deepStrictEqual(parseLocation('/settings/'), { kind: 'app', view: 'panel' });
  assert.deepStrictEqual(parseLocation('/settings/users'), { kind: 'app', view: 'panel', tab: 'users' });
  assert.deepStrictEqual(parseLocation('/settings/audit'), { kind: 'app', view: 'panel', tab: 'audit' });
  assert.deepStrictEqual(parseLocation('/settings/updates'), { kind: 'app', view: 'panel', tab: 'updates' });
  assert.deepStrictEqual(parseLocation('/settings/preferences'), { kind: 'app', view: 'panel' }, 'the default tab has no segment');
  assert.deepStrictEqual(parseLocation('/settings/files'), { kind: 'app', view: 'panel' }, 'a server Settings tab is not a panel tab');
  assert.deepStrictEqual(parseLocation('/servers/abc/settings'), { kind: 'server', serverId: 'abc', view: 'settings' });
  // The panel's old top-level pages open their tab.
  assert.deepStrictEqual(parseLocation('/users'), { kind: 'legacy', game: null, view: 'panel', tab: 'users' });
  assert.deepStrictEqual(parseLocation('/audit'), { kind: 'legacy', game: null, view: 'panel', tab: 'audit' });
  assert.deepStrictEqual(parseLocation('/updates'), { kind: 'legacy', game: null, view: 'mods', tab: 'updates' },
    'the old updates page was a server section, not the app updater');
  assert.deepStrictEqual(parseLocation('/servers/abc/users'), { kind: 'server', serverId: 'abc', view: 'dashboard' });
  assert.deepStrictEqual(parseLocation('/games'), { kind: 'legacy', game: null, view: 'dashboard' });
  assert.deepStrictEqual(parseLocation('/games/minecraft'), { kind: 'legacy', game: 'minecraft', view: 'dashboard' });
  assert.deepStrictEqual(parseLocation('/games/minecraft/files'), { kind: 'legacy', game: 'minecraft', view: 'settings', tab: 'files' });
  assert.deepStrictEqual(parseLocation('/games/minecraft/content'), { kind: 'legacy', game: 'minecraft', view: 'mods', tab: 'browse' });
  assert.deepStrictEqual(parseLocation('/games/minecraft/health'), { kind: 'legacy', game: 'minecraft', view: 'details' });
  assert.deepStrictEqual(parseLocation('/games/minecraft/tasks'), { kind: 'legacy', game: 'minecraft', view: 'tasks' });
  assert.deepStrictEqual(parseLocation('/games/terraria/users'), { kind: 'legacy', game: 'terraria', view: 'panel', tab: 'users' });
  assert.deepStrictEqual(parseLocation('/games/terraria/updates'), { kind: 'legacy', game: 'terraria', view: 'mods', tab: 'updates' });
  assert.deepStrictEqual(parseLocation('/console'), { kind: 'legacy', game: null, view: 'console' });
  assert.deepStrictEqual(parseLocation('/metrics'), { kind: 'legacy', game: null, view: 'details' });
  assert.deepStrictEqual(parseLocation('/configs'), { kind: 'legacy', game: null, view: 'settings', tab: 'game' });
  assert.deepStrictEqual(parseLocation('/whatever'), { kind: 'legacy', game: null, view: 'dashboard' });

  // buildPath
  assert.strictEqual(buildPath({ view: 'dashboard', serverId: 'abc' }), '/servers/abc');
  assert.strictEqual(buildPath({ view: 'console', serverId: 'abc' }), '/servers/abc/console');
  assert.strictEqual(buildPath({ view: 'tasks', serverId: 'abc' }), '/servers/abc/schedules');
  assert.strictEqual(buildPath({ view: 'console', serverId: 'a b' }), '/servers/a%20b/console');
  assert.strictEqual(buildPath({ view: 'console' }), '/', 'a server view with no server goes home');
  assert.strictEqual(buildPath({ view: 'panel', serverId: 'abc' }), '/settings');
  assert.strictEqual(buildPath({ view: 'panel', tab: 'preferences' }), '/settings');
  assert.strictEqual(buildPath({ view: 'panel', tab: 'audit' }), '/settings/audit');
  assert.strictEqual(buildPath({ view: 'servers' }), '/servers');
  assert.strictEqual(buildPath({ view: 'mods', serverId: 'abc', tab: 'browse' }), '/servers/abc/mods/browse');
  assert.strictEqual(buildPath({ view: 'mods', serverId: 'abc' }), '/servers/abc/mods');
  assert.strictEqual(buildPath({ view: 'crashes', serverId: 'abc', tab: 'g 1' }), '/servers/abc/crashes/g%201');
  assert.strictEqual(buildPath({ view: 'crashes', serverId: 'abc' }), '/servers/abc/details');

  // Every view round-trips (a crash page needs its crash id).
  for (const view of Object.keys(VIEW_PATHS).filter((name) => name !== 'crashes')) {
    const parsed = parseLocation(buildPath({ view, serverId: 's1' }));
    assert.strictEqual(parsed.view, view, `${view} round-trips`);
  }
  for (const tab of PANEL_TABS.slice(1)) {
    assert.deepStrictEqual(parseLocation(buildPath({ view: 'panel', tab })), { kind: 'app', view: 'panel', tab }, `panel/${tab} round-trips`);
  }
  for (const [view, tabs] of Object.entries(SECTION_TAB_NAMES)) {
    for (const tab of tabs) {
      const parsed = parseLocation(buildPath({ view, serverId: 's1', tab }));
      assert.deepStrictEqual([parsed.view, parsed.tab], [view, tab], `${view}/${tab} round-trips`);
    }
  }

  // resolveLegacy
  const servers = [
    { id: 'mc1', game: 'minecraft' },
    { id: 'mc2', game: 'minecraft' },
    { id: 'tr1', game: 'terraria' },
  ];
  const at = (pathname, remembered) => resolveLegacy(parseLocation(pathname), servers, remembered);

  assert.strictEqual(at('/games/minecraft/files'), '/servers/mc1/settings/files', 'first server of the game');
  assert.strictEqual(at('/games/minecraft/files', { byGame: { minecraft: 'mc2' } }), '/servers/mc2/settings/files', 'remembered server of the game');
  assert.strictEqual(at('/games/minecraft/files', { byGame: { minecraft: 'tr1' } }), '/servers/mc1/settings/files', 'a remembered server of another game is ignored');
  assert.strictEqual(at('/games/minecraft/files', { byGame: { minecraft: 'gone' } }), '/servers/mc1/settings/files', 'a deleted server is ignored');
  // Every merged section lands on its new home.
  assert.strictEqual(at('/games/minecraft/dashboard'), '/servers/mc1');
  assert.strictEqual(at('/games/minecraft/health'), '/servers/mc1/details');
  assert.strictEqual(at('/games/minecraft/metrics'), '/servers/mc1/details');
  assert.strictEqual(at('/games/minecraft/map'), '/servers/mc1/worlds/map');
  assert.strictEqual(at('/games/minecraft/addons'), '/servers/mc1/mods/installed');
  assert.strictEqual(at('/games/minecraft/content'), '/servers/mc1/mods/browse');
  assert.strictEqual(at('/games/minecraft/mods'), '/servers/mc1/mods');
  assert.strictEqual(at('/games/minecraft/updates'), '/servers/mc1/mods/updates');
  assert.strictEqual(at('/games/minecraft/configs'), '/servers/mc1/settings/game');
  assert.strictEqual(at('/games/minecraft/tasks'), '/servers/mc1/schedules');
  assert.strictEqual(at('/games/terraria/dashboard'), '/servers/tr1');
  assert.strictEqual(at('/games/valheim/console'), '/', 'no server of that game');
  assert.strictEqual(at('/games/minecraft/users'), '/settings/users');
  assert.strictEqual(at('/games/minecraft/audit'), '/settings/audit');
  assert.strictEqual(at('/users'), '/settings/users');
  assert.strictEqual(at('/audit'), '/settings/audit');
  assert.strictEqual(resolveLegacy(parseLocation('/users'), []), '/settings/users', 'needs no server');
  // One line per panel tab, so the open edition (which has no such tab)
  // drops it with the tab.
  if (PANEL_TABS.includes('license')) assert.strictEqual(at('/license'), '/settings/license');
  if (PANEL_TABS.includes('license')) assert.strictEqual(at('/games/minecraft/license'), '/settings/license');
  assert.strictEqual(at('/games/minecraft/servers'), '/servers');
  assert.strictEqual(at('/games'), '/');
  assert.strictEqual(at('/games', { lastServerId: 'tr1' }), '/servers/tr1', 'the hub resumes the last server');
  assert.strictEqual(at('/console', { lastServerId: 'mc2' }), '/servers/mc2/console');
  assert.strictEqual(at('/console'), '/', 'ambiguous with several servers and nothing remembered');
  assert.strictEqual(resolveLegacy(parseLocation('/console'), [{ id: 'only', game: 'valheim' }]), '/servers/only/console',
    'a single server is unambiguous');
  assert.strictEqual(resolveLegacy(parseLocation('/games/minecraft/files'), []), '/');

  console.log('routes mapping tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
