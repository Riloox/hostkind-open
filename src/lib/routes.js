// Maps each view to a clean URL path and back, so the app can drive navigation
// through the History API. That gives us shareable/refreshable URLs and makes
// the browser's Back/Forward (including the mouse back button) work for free,
// since those fire `popstate`.
//
// The server is part of the URL: `/servers/<id>/<section>[/<tab>]`. Whatever
// server the URL names is the one every server-scoped view acts on, so there is
// no separate "active server" to keep in sync with it. The views that are not
// about one server (the server list, Hostkind settings) live at the top level.

export const VIEW_PATHS = {
  dashboard: '/',
  servers: '/servers',
  details: '/details',
  crashes: '/crashes',
  console: '/console',
  players: '/players',
  worlds: '/worlds',
  mods: '/mods',
  backups: '/backups',
  tasks: '/schedules',
  settings: '/settings',
};

// Every view the shell can render. Anything else (a stale link, a hand-typed
// path, a remembered view from an older build) collapses to the dashboard.
export const VIEW_NAMES = new Set(Object.keys(VIEW_PATHS));

// Views that act on one server, addressed as `/servers/<id>/<segment>`.
export const SERVER_VIEWS = new Set([
  'dashboard', 'details', 'crashes', 'console', 'players', 'worlds', 'mods',
  'backups', 'tasks', 'settings',
]);

// Views that are not about one server: the server list, and Hostkind settings
// (the panel's own page). The panel page is `panel` inside the app because a
// server also has a section called `settings`; only the top-level
// `/settings[/<tab>]` is the panel's.
export const APP_VIEWS = new Set(['servers', 'panel']);
export const PANEL_PATH = '/settings';

// The tabs of Hostkind settings. Which of them a user sees is decided in
// src/lib/panel.js. The first is the page's default and has no tab segment.
// scripts/strip-open.cjs removes one line of this list for the open edition.
export const PANEL_TABS = [
  'preferences',
  'users',
  'audit',
  'updates',
];

// The panel's own pages used to be top-level views (`/users`, `/audit`, ...)
// and hub views (`/games/<game>/users`). Those names now open the matching
// tab. `updates` is not one of them: it was a server section (LEGACY_SECTIONS).
function panelTabFor(segment) {
  return PANEL_TABS.includes(segment) && !LEGACY_SECTIONS[segment] ? segment : null;
}

// A panel location, without the default tab.
function panelLocation(tab) {
  return tab && tab !== PANEL_TABS[0] ? { view: 'panel', tab } : { view: 'panel' };
}

// The tabs each tabbed section can have. Which of them a given server shows is
// decided in src/lib/sections.js; the URL only has to know the names.
export const SECTION_TAB_NAMES = {
  worlds: ['worlds', 'map'],
  mods: ['installed', 'browse', 'updates'],
  settings: ['game', 'general', 'version', 'files'],
};

// Sections that existed before they were merged, and where they live now.
// Old links (`/games/<game>/configs`, `/files`, `/servers/<id>/addons`) keep
// working through this table.
export const LEGACY_SECTIONS = {
  dashboard: { view: 'dashboard' },
  health: { view: 'details' },
  metrics: { view: 'details' },
  map: { view: 'worlds', tab: 'map' },
  addons: { view: 'mods', tab: 'installed' },
  content: { view: 'mods', tab: 'browse' },
  // Plugin updates on Minecraft, the game build elsewhere: the shell moves
  // it to Settings → Version for a server without plugin updates.
  updates: { view: 'mods', tab: 'updates' },
  configs: { view: 'settings', tab: 'game' },
  files: { view: 'settings', tab: 'files' },
  tasks: { view: 'tasks' },
};

const PATH_TO_VIEW = Object.fromEntries(
  Object.entries(VIEW_PATHS).map(([view, path]) => [path, view])
);

// A path segment as a view and tab, or null when it names neither a current
// section nor an old one.
function segmentToSection(segment) {
  const view = PATH_TO_VIEW[`/${segment}`];
  if (view) return { view };
  return LEGACY_SECTIONS[segment] || null;
}

export function viewToPath(view) {
  return VIEW_PATHS[view] || '/';
}

// Resolve a pathname to a known view, or null when it doesn't map to one.
// Only the first path segment matters (e.g. `/files/anything` -> settings).
export function pathToView(pathname) {
  const seg = String(pathname || '/').replace(/^\/+|\/+$/g, '').split('/')[0];
  if (!seg) return 'dashboard';
  return segmentToSection(seg)?.view || null;
}

const splitPath = (pathname) => String(pathname || '/').split('/').filter(Boolean);

const decode = (segment) => {
  try { return decodeURIComponent(segment); } catch { return segment; }
};

// A section plus the segment after it. Tabbed sections keep only a tab they
// can have; a crash page keeps its crash id, and without one it is the
// details page the crash list lives on.
function withTab(section, raw) {
  const { view } = section;
  if (view === 'crashes') return raw ? { view, tab: decode(raw) } : { view: 'details' };
  const tab = section.tab || (raw && SECTION_TAB_NAMES[view]?.includes(raw) ? raw : null);
  return tab ? { view, tab } : { view };
}

/**
 * Where a pathname points.
 *
 *   { kind: 'home' }                               `/`
 *   { kind: 'server', serverId, view, tab? }       `/servers/<id>[/<view>[/<tab>]]`
 *   { kind: 'app', view: 'servers' }               `/servers`
 *   { kind: 'app', view: 'panel', tab? }           `/settings[/<tab>]` (Hostkind settings)
 *   { kind: 'legacy', game, view, tab? }           `/games[/<game>[/<view>]]` and pre-hub
 *                                                  paths such as `/console` - these name
 *                                                  no server and are resolved against
 *                                                  the server list (resolveLegacy).
 *                                                  `/users`, `/audit`, ... are legacy
 *                                                  links to a Hostkind settings tab.
 *
 * `tab` is the section's tab, or the crash id on a crash page. It is left out
 * when the URL has none. An old section name under a server (`/addons`) parses
 * to where it lives now; the shell rewrites the URL to match.
 */
export function parseLocation(pathname) {
  const parts = splitPath(pathname);
  if (parts.length === 0) return { kind: 'home' };

  if (parts[0] === 'servers') {
    if (parts.length === 1) return { kind: 'app', view: 'servers' };
    const section = parts[2] ? segmentToSection(parts[2]) : null;
    const target = section && SERVER_VIEWS.has(section.view)
      ? withTab(section, parts[3])
      : { view: 'dashboard' };
    return { kind: 'server', serverId: decode(parts[1]), ...target };
  }

  // Before the legacy fallback below, which would read `settings` as the
  // last server's Settings section.
  if (parts[0] === PANEL_PATH.slice(1)) {
    const tab = PANEL_TABS.includes(parts[1]) ? parts[1] : null;
    return { kind: 'app', ...panelLocation(tab) };
  }

  if (parts[0] === 'games') {
    const game = parts[1] || null;
    const raw = parts[2] || null;
    if (panelTabFor(raw)) return { kind: 'legacy', game, ...panelLocation(raw) };
    // Hub links used view names (`tasks`, `content`), not path segments.
    const section = raw ? (LEGACY_SECTIONS[raw] || segmentToSection(raw) || (VIEW_NAMES.has(raw) ? { view: raw } : null)) : null;
    return { kind: 'legacy', game, ...(section ? withTab(section, null) : { view: 'dashboard' }) };
  }

  if (panelTabFor(parts[0])) return { kind: 'legacy', game: null, ...panelLocation(parts[0]) };
  const section = segmentToSection(parts[0]);
  if (section && APP_VIEWS.has(section.view)) return { kind: 'app', view: section.view };
  return { kind: 'legacy', game: null, ...(section ? withTab(section, null) : { view: 'dashboard' }) };
}

/** The canonical path for a view, on a server when the view needs one. */
export function buildPath({ view = 'dashboard', serverId = null, tab = null } = {}) {
  if (view === 'panel') {
    return tab && tab !== PANEL_TABS[0] ? `${PANEL_PATH}/${encodeURIComponent(tab)}` : PANEL_PATH;
  }
  if (APP_VIEWS.has(view)) return VIEW_PATHS[view];
  if (!serverId) return '/';
  const base = `/servers/${encodeURIComponent(serverId)}`;
  if (view === 'dashboard' || !SERVER_VIEWS.has(view)) return base;
  if (view === 'crashes' && !tab) return `${base}${VIEW_PATHS.details}`;
  return `${base}${VIEW_PATHS[view]}${tab ? `/${encodeURIComponent(tab)}` : ''}`;
}

/**
 * Rewrite a legacy location onto a server. `servers` is the full list, each
 * with `id` and a `game`; `remembered` holds the last server this user had
 * open overall (`lastServerId`) and per game (`byGame`).
 *
 * A game-scoped link goes to the last server used for that game, or the first
 * one of that game; a link that names no game goes to the last server used at
 * all. With nothing to land on, it goes home.
 */
export function resolveLegacy(location, servers, remembered = {}) {
  const list = Array.isArray(servers) ? servers : [];
  const known = (id) => (id && list.some((server) => server.id === id) ? id : null);
  const view = location?.view || 'dashboard';
  const tab = location?.tab || null;
  if (APP_VIEWS.has(view)) return buildPath({ view, tab });

  let serverId = null;
  if (location?.game) {
    const ofGame = list.filter((server) => server.game === location.game);
    serverId = known(remembered.byGame?.[location.game]);
    if (serverId && !ofGame.some((server) => server.id === serverId)) serverId = null;
    serverId = serverId || ofGame[0]?.id || null;
  } else {
    serverId = known(remembered.lastServerId) || (list.length === 1 ? list[0].id : null);
  }
  return serverId ? buildPath({ view, serverId, tab }) : '/';
}
