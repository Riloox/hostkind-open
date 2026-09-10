// Maps each view (sidebar section) to a clean URL path and back, so the app can
// drive navigation through the History API. That gives us shareable/refreshable
// URLs and makes the browser's Back/Forward (including the mouse back button)
// work for free, since those fire `popstate`.

export const VIEW_PATHS = {
  dashboard: '/',
  servers: '/servers',
  health: '/health',
  console: '/console',
  players: '/players',
  map: '/map',
  addons: '/addons',
  content: '/content',
  files: '/files',
  configs: '/configs',
  worlds: '/worlds',
  backups: '/backups',
  updates: '/updates',
  tasks: '/schedules',
  users: '/users',
  audit: '/audit',
};

// Every view the shell can render, i.e. the set of valid third segments in
// `/games/<game>/<view>`. Anything else (a stale link, a hand-typed path, a
// remembered view from an older build) collapses to the dashboard.
export const VIEW_NAMES = new Set(Object.keys(VIEW_PATHS));

const PATH_TO_VIEW = Object.fromEntries(
  Object.entries(VIEW_PATHS).map(([view, path]) => [path, view])
);
PATH_TO_VIEW['/mods'] = 'content';
PATH_TO_VIEW['/metrics'] = 'health';

export function viewToPath(view) {
  return VIEW_PATHS[view] || '/';
}

// Resolve a pathname to a known view, or null when it doesn't map to one.
// Only the first path segment matters (e.g. `/files/anything` -> files).
export function pathToView(pathname) {
  const seg = String(pathname || '/').replace(/^\/+|\/+$/g, '').split('/')[0];
  if (!seg) return 'dashboard';
  return PATH_TO_VIEW[`/${seg}`] || null;
}
