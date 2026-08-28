import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { useAuth, useGameThemes } from '@/context/AuthContext';
import { applyGameTheme } from '@/lib/branding';
import { useServer } from '@/context/ServerContext';
import { useI18n, useT } from '@/context/I18nContext';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useApi } from '@/hooks/useApi';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Loading } from '@/components/shared/Loading';
import ErrorBoundary from '@/components/shared/ErrorBoundary';
import { LoginView } from '@/views/LoginView';
import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';
import { ControlBar } from '@/components/layout/ControlBar';
import { Page } from '@/components/layout/Page';
import { FirstStartDialog } from '@/components/shared/FirstStartDialog';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { SettingsDialog } from '@/components/shared/SettingsDialog';
import { BugReportButton } from '@/components/shared/BugReportButton';
import { OnboardingTour } from '@/components/shared/OnboardingTour';
import { ChangelogDialog } from '@/components/shared/ChangelogDialog';
import { DashboardView } from '@/views/DashboardView';
import { ServersView } from '@/views/ServersView';
import { HealthView } from '@/views/HealthView';
import { ConsoleView } from '@/views/ConsoleView';
import { PlayersView } from '@/views/PlayersView';
import { TerrariaTshockView } from '@/views/TerrariaTshockView';
import { MapView } from '@/views/MapView';
import { AddonsView } from '@/views/AddonsView';
import { TerrariaModsView } from '@/views/TerrariaModsView';
import { ModrinthView } from '@/views/ModrinthView';
import { FileManagerView } from '@/views/FileManagerView';
import { ConfigsView } from '@/views/ConfigsView';
import { WorldsView } from '@/views/WorldsView';
import { BackupsView } from '@/views/BackupsView';
import { UpdatesView } from '@/views/UpdatesView';
import { TasksView } from '@/views/TasksView';
import { UsersView } from '@/views/UsersView';
import { AuditView } from '@/views/AuditView';
import { GamesView } from '@/views/GamesView';
import { pathToView, VIEW_NAMES } from '@/lib/routes';
import { GAME_IDS, gameForServer } from '@/lib/games';
import { GameArtwork } from '@/components/shared/GameArtwork';
import { Wifi, WifiOff, RefreshCw } from 'lucide-react';
import { cn, jwtSubject } from '@/lib/utils';

// Views that touch the server's on-disk content (plugins, mods, configs, files).
// Navigating into any of them while the active server has never been started
// triggers the "Start the server first" prompt so mods/plugins install into a
// fully generated folder tree instead of a half-empty one.
const CONTENT_VIEWS = ['addons', 'modrinth', 'files', 'configs'];

// Views that are meaningless without at least one registered server: every one
// of them reads a server's status, files, or config. With zero servers they are
// blocked (the sidebar greys them out and direct URLs bounce to Servers).
const SERVER_REQUIRED_VIEWS = new Set([
  'health', 'console', 'players', 'map',
  'addons', 'modrinth', 'files', 'configs', 'worlds',
  'backups', 'tasks',
  'updates',
]);

// Views that need a capability to open. Admins always pass; everyone else is
// bounced to the dashboard, so a typed URL cannot reach a view whose API calls
// would all come back 403 anyway.
const VIEW_CAPABILITIES = { users: 'users.manage', audit: 'audit.view', worlds: 'worlds.view' };
// A list means "any of these": the worlds view serves two different world
// models, Minecraft's folder-per-world (`worlds`) and Terraria's file-per-world
// (`terraria-worlds`), and a server declares whichever one it actually has.
const VIEW_MODULE_CAPABILITIES = {
  console: 'console',
  players: ['players', 'terraria-tshock'],
  addons: ['addons', 'terraria-mods'],
  modrinth: 'content-install',
  worlds: ['worlds', 'terraria-worlds', 'valheim-worlds'],
  map: 'map',
  files: 'files',
  configs: 'configs',
  backups: 'backups',
  tasks: 'schedules',
  updates: 'updates',
};
// One capability or any of a list of them.
const supportsAny = (capability, supports) =>
  (Array.isArray(capability) ? capability : [capability]).some((entry) => supports(entry));

const CONSOLE_DUPLICATE_WINDOW_MS = 1500;
const CONSOLE_ANSI_ESCAPE_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~])/g;
const CONSOLE_MC_TIMESTAMP_RE = /^\[\d{2}:\d{2}:\d{2}(?:\s+\w+)?\](?:\s*\[[^\]]*\])?:\s*/;

function consoleLineKey(line) {
  return String(line?.text || '')
    .replace(CONSOLE_ANSI_ESCAPE_RE, '')
    .replace(/\r/g, '')
    .replace(CONSOLE_MC_TIMESTAMP_RE, '');
}

function isRecentConsoleDuplicate(lines, line) {
  if (!line || line.level === 'cmd') return false;
  const timestamp = line.ts || 0;
  const key = consoleLineKey(line);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const previous = lines[i];
    const delta = Math.abs(timestamp - (previous.ts || 0));
    if (delta > CONSOLE_DUPLICATE_WINDOW_MS && (previous.ts || 0) <= timestamp) break;
    if (previous.level !== 'cmd' && consoleLineKey(previous) === key && delta <= CONSOLE_DUPLICATE_WINDOW_MS) return true;
  }
  return false;
}

// A monotonic id per accepted console line. The buffer is capped, so an array
// index is neither stable nor monotonic once it fills up - `seq` is what lets
// the console key its rows and tell a genuinely new line from one that has
// merely shifted position.
let consoleSeq = 0;

function appendConsoleFrame(lines, line) {
  if (isRecentConsoleDuplicate(lines, line)) return lines;
  consoleSeq += 1;
  return [...lines, { ...line, seq: consoleSeq }].slice(-1200);
}

function dedupeConsoleHistory(lines) {
  return (Array.isArray(lines) ? lines : []).reduce((result, line) => appendConsoleFrame(result, line), []);
}

// The game named by the current URL, or null when it doesn't name one (the
// hub at `/games`, a bookmarked `/`, a pre-hub link like `/console`).
function pathGame() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  return parts[0] === 'games' && GAME_IDS.has(parts[1]) ? parts[1] : null;
}

function pathView() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  const view = parts[0] === 'games' && GAME_IDS.has(parts[1])
    ? (parts[2] || 'dashboard')
    : (pathToView(window.location.pathname) || 'dashboard');
  return VIEW_NAMES.has(view) ? view : 'dashboard';
}

// Where the shell opens on a fresh page load. A URL that names a game wins.
// Otherwise we restore the game + view this user was last in, and fall back to
// the games hub when there is nothing to restore - never to a silent default
// game, which is how a bookmarked `/` used to land everyone in Minecraft.
function bootLocation(token) {
  const game = pathGame();
  if (game) return { game, view: pathView(), hub: false };
  if (window.location.pathname === '/games') return { game: null, view: 'dashboard', hub: true };
  const remembered = readLastLocation(jwtSubject(token));
  if (remembered) return { ...remembered, hub: false };
  return { game: null, view: 'dashboard', hub: true };
}

function dismissedKey(serverId) {
  return `ls-fs-dismissed:${serverId || ''}`;
}

// Last game + view, remembered per user so re-opening the panel resumes where
// they left off instead of dropping them on an arbitrary game.
function lastLocationKey(userId) {
  return `fleetdeck_last_location:${userId || ''}`;
}

function readLastLocation(userId) {
  if (!userId) return null;
  try {
    const raw = JSON.parse(localStorage.getItem(lastLocationKey(userId)) || 'null');
    if (!raw || !GAME_IDS.has(raw.game)) return null;
    return { game: raw.game, view: VIEW_NAMES.has(raw.view) ? raw.view : 'dashboard' };
  } catch (_) { return null; }
}

function writeLastLocation(userId, game, view) {
  if (!userId || !GAME_IDS.has(game)) return;
  try {
    localStorage.setItem(lastLocationKey(userId), JSON.stringify({ game, view: VIEW_NAMES.has(view) ? view : 'dashboard' }));
  } catch (_) {}
}

// Tours are shared across the catalogue: the per-game walkthroughs are
// near-identical (only a couple of station targets differ), so finishing it
// in one game marks it seen in every game and entering another game never
// reopens it. The per-game key stays so users who completed a game before
// this change are still treated as seen; every read and write covers all
// games. The game catalogue itself never shows a tour.
function tourSeenKey(userId, game) {
  return `fleetdeck_tour_seen:${userId || ''}:${game || ''}`;
}

function tourSeenCookie(userId, game) {
  const safeUserId = String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeGame = String(game || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `fleetdeck_tour_seen_${safeUserId}_${safeGame}`;
}

function hasTourCookie(userId, game) {
  const name = `${tourSeenCookie(userId, game)}=`;
  try {
    return document.cookie.split(';').some(part => part.trim().startsWith(name));
  } catch (_) {
    return false;
  }
}

// --- Never-show-again (idea 9) removed: redundant with the seen flag.
// Both used identical localStorage + cookie storage, so a storage wipe that
// resurrected the tour also wiped the opt-out. No behavioural difference.
function hasSeenTour(userId, game) {
  if (!userId || !GAME_IDS.has(game)) return false;
  try {
    for (const gid of GAME_IDS) {
      if (localStorage.getItem(tourSeenKey(userId, gid)) === '1') return true;
    }
  } catch (_) {}
  for (const gid of GAME_IDS) {
    if (hasTourCookie(userId, gid)) return true;
  }
  return false;
}

function markTourSeen(userId, game) {
  if (!userId || !GAME_IDS.has(game)) return;
  // Shared seen: write the flag for every game, not just the one the tour
  // ran in, so completing it here also completes it everywhere else.
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  for (const gid of GAME_IDS) {
    try { localStorage.setItem(tourSeenKey(userId, gid), '1'); } catch (_) {}
    try {
      document.cookie = `${tourSeenCookie(userId, gid)}=1; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    } catch (_) {}
  }
}

// --- Changelog version tracking ---
function changelogVersionKey() {
  return 'fleetdeck_changelog_version';
}

// Keep reading the pre-dialog marker so an existing install does not lose its
// update history when the touring what's-new experience is replaced.
function legacyTourVersionKey() {
  return 'fleetdeck_tour_version';
}

// Desktop launches can use a different loopback port each time. Cookies are
// host-scoped, unlike localStorage, so keep the version there as well; the
// localStorage fallback preserves state from older browser installs.
function readVersionCookie(key) {
  const prefix = `${key}=`;
  try {
    const entry = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
    return entry ? decodeURIComponent(entry.slice(prefix.length)) || null : null;
  } catch (_) {
    return null;
  }
}

function readChangelogVersion() {
  for (const key of [changelogVersionKey(), legacyTourVersionKey()]) {
    const cookieVersion = readVersionCookie(key);
    if (cookieVersion) return cookieVersion;
    try {
      const storageVersion = localStorage.getItem(key);
      if (storageVersion) return storageVersion;
    } catch (_) {}
  }
  return null;
}

function writeChangelogVersion(v) {
  const value = String(v || '');
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  for (const key of [changelogVersionKey(), legacyTourVersionKey()]) {
    try { localStorage.setItem(key, value); } catch (_) {}
    try {
      document.cookie = `${key}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    } catch (_) {}
  }
}

// Current build version injected by Vite's define (guarded for SSR/build contexts).
function currentAppVersion() {
  try { return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''; }
  catch { return ''; }
}

function isDismissed(serverId) {
  if (!serverId) return false;
  try { return sessionStorage.getItem(dismissedKey(serverId)) === '1'; }
  catch { return false; }
}

function markDismissed(serverId) {
  if (!serverId) return;
  try { sessionStorage.setItem(dismissedKey(serverId), '1'); } catch (_) {}
}

// Anything layered over the workbench that already answers to Escape: Radix
// dialogs, dropdown menus and selects, the server selector's own panel, and the
// onboarding tour and changelog dialog. All of them are mounted only while
// open, so finding one in the document is the same as knowing something is over
// the desk.
const OPEN_OVERLAY = '[role="dialog"],[role="menu"],[role="listbox"]';

function AppShell({ onLoggedIn }) {
  const { token, user, setUser, isLoggedIn, hasCapability } = useAuth();
  const { servers, setServers, activeServerId, setActiveServerId, getServerStatus, updateStatus, activeModule, supports, setModules, currentGame, setCurrentGame } = useServer();
  const api = useApi();
  const t = useT();
  const gameThemes = useGameThemes();

  // Resolved once, before the first paint, so the shell never renders a frame
  // with no game selected (which resolves to Minecraft everywhere downstream).
  const [boot] = useState(() => bootLocation(token));
  const [currentView, setCurrentView] = useState(boot.view);
  const [showGames, setShowGames] = useState(boot.hub);
  const [serversLoaded, setServersLoaded] = useState(false);
  const [consoleLines, setConsoleLines] = useState([]);
  const [connState, setConnState] = useState('connecting');

  const isAdmin = user?.role === 'admin';

  // Push (or replace) the URL so it matches the shown view. Pushing adds a
  // history entry so Back/Forward (and the mouse back button) can return here.
  // `currentGame` lives in the context and is only committed a tick after mount,
  // so a redirect fired in that window would otherwise see null and send the
  // user to the hub - fall back to the booted game until it lands.
  const syncUrl = useCallback((view, replace = false) => {
    const game = currentGame || (showGames ? null : boot.game);
    const path = game ? `/games/${game}/${view}` : '/games';
    if (window.location.pathname === path) return;
    if (replace) window.history.replaceState({ game, view }, '', path);
    else window.history.pushState({ game, view }, '', path);
  }, [currentGame, showGames, boot.game]);

  useEffect(() => { setCurrentGame(boot.game); }, [boot.game, setCurrentGame]);

  // Mirror the entered game onto <html> so the per-game colour ramp in
  // src/tokens.css reaches everything, not just this subtree: dialogs,
  // dropdowns, tooltips and toasts all portal to <body> and would otherwise
  // render on the default ember theme while the shell behind them is themed.
  // Cleared in the hub, where the carousel themes itself slide by slide.
  useEffect(() => {
    const root = document.documentElement;
    const game = showGames ? null : currentGame;
    if (game) root.dataset.game = game;
    else delete root.dataset.game;
    applyGameTheme(game, gameThemes?.[game]);
    return () => { delete root.dataset.game; };
  }, [currentGame, showGames, gameThemes]);

  const selectGame = useCallback((game) => {
    setCurrentGame(game);
    setShowGames(false);
    setCurrentView('dashboard');
    window.history.pushState({ game, view: 'dashboard' }, '', `/games/${game}/dashboard`);
  }, [setCurrentGame]);

  // The game the hub should open on. Leaving a game puts its own slide in
  // front, so stepping out and back in lands where you were rather than at the
  // head of the catalogue.
  const [hubGame, setHubGame] = useState(boot.game);

  const showAllGames = useCallback(() => {
    setHubGame((game) => currentGame || game);
    setShowGames(true);
    setCurrentGame(null);
    window.history.pushState({ hub: true }, '', '/games');
  }, [setCurrentGame, currentGame]);

  // Bumped whenever the active server transitions to "online" after a
  // first-start prompt, so the current view re-mounts and re-fetches its data
  // (the auto-generated files only exist once the server is fully up).
  const [viewNonce, setViewNonce] = useState(0);
  const [firstStart, setFirstStart] = useState({ open: false, pendingView: null, starting: false });
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const awaitingFirstStart = useRef(false);


  // Open only after entering a game, once for each user/game pair.
  // Existing users who already completed the full tour see the changelog once
  // when the app version changes.
  useEffect(() => {
    if (!user?.id || showGames || !GAME_IDS.has(currentGame)) {
      setTourOpen(false);
      setChangelogOpen(false);
      return;
    }
    const seen = hasSeenTour(user.id, currentGame);
    const appVer = currentAppVersion();
    if (!seen) {
      // First-time user: show the full tour, never the changelog.
      setChangelogOpen(false);
      setTourOpen(true);
    } else if (appVer && readChangelogVersion() !== appVer) {
      // Existing user, new version: show the complete changelog in one dialog.
      // Store version immediately so it won't re-open on every mount.
      writeChangelogVersion(appVer);
      setTourOpen(false);
      setChangelogOpen(true);
    } else {
      setChangelogOpen(false);
    }
  }, [user?.id, currentGame, showGames]);

  // Escape steps back out of the game to the catalogue, landing on the game
  // being left. It is the last thing Escape means, though: every layer the app
  // can put over the workbench already owns the key and closes on it, and
  // exiting to the hub as well would throw away the place the user was
  // standing. OPEN_OVERLAY finds those layers by role - they are portalled out
  // of this subtree and only rendered while open - and the tour and the app's
  // own dialogs are checked from state, which is cheaper and certain.
  useEffect(() => {
    if (showGames) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (settingsOpen || tourOpen || changelogOpen || firstStart.open || confirmRestart) return;
      const active = document.activeElement;
      if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA' || active?.isContentEditable) return;
      if (document.querySelector(OPEN_OVERLAY)) return;
      event.preventDefault();
      showAllGames();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showGames, settingsOpen, tourOpen, changelogOpen, firstStart.open, confirmRestart, showAllGames]);

  function startTour() {
    setSettingsOpen(false);
    setChangelogOpen(false);
    // Defer so the settings dialog's closing transition doesn't overlap the
    // spotlight measurement of the profile button underneath it.
    requestAnimationFrame(() => {
      setTourOpen(true);
    });
  }

  function closeTour() {
    if (user?.id) markTourSeen(user.id, currentGame);
    // Store the app version when the full tour completes, so the changelog
    // detector starts from the version the user has actually seen.
    const appVer = currentAppVersion();
    if (appVer) writeChangelogVersion(appVer);
    setTourOpen(false);
  }

  // --- Tour analytics listener (idea 11) ---
  // The tour-core dispatches window CustomEvent 'fleetdeck:tour' with detail
  // { type, step, total, game, variant }. We listen here in App.jsx (the
  // owner of tourOpen state) to record server-side audit events.
  useEffect(() => {
    function onTourEvent(e) {
      const d = e.detail || {};
      const detailType = d.type;

      // --- Analytics recording (idea 11) ---
      try {
        // The panel's API is bearer-authenticated, same as every other call.
        const token = localStorage.getItem('fleetdeck_token') || '';
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = `Bearer ${token}`;
        fetch('/api/audit/tour-event', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            type: detailType,
            step: d.step ?? null,
            total: d.total ?? null,
            game: d.game || currentGame || null,
            variant: d.variant || 'full',
          }),
        }).catch(() => {});
      } catch (_) { /* recording failure must never break the tour */ }
    }
    window.addEventListener('fleetdeck:tour', onTourEvent);
    return () => window.removeEventListener('fleetdeck:tour', onTourEvent);
  }, [user?.id, currentGame]);

  // Central navigation entry point. Applies the no-server, admin, and
  // first-start guards, then shows the view and updates the URL.
  const goTo = useCallback((view, { fromHistory = false } = {}) => {
    // Block server-only sections until at least one server exists.
    if (SERVER_REQUIRED_VIEWS.has(view) && serversLoaded && servers.length === 0) {
      toast.error(t('nav.requiresServerToast'));
      setCurrentView('servers');
      syncUrl('servers', true);
      return;
    }
    // Block admin-only sections for non-admins.
    if (VIEW_CAPABILITIES[view] && user && !isAdmin && !hasCapability(VIEW_CAPABILITIES[view])) {
      setCurrentView('dashboard');
      syncUrl('dashboard', true);
      return;
    }
    if (VIEW_MODULE_CAPABILITIES[view] && activeModule && !supportsAny(VIEW_MODULE_CAPABILITIES[view], supports)) {
      toast.error(t('errors.notSupported'));
      setCurrentView('dashboard');
      syncUrl('dashboard', true);
      return;
    }
    // First-start prompt for content views on a never-started server. Only on
    // in-app navigation; on Back/Forward we just show the page (the URL already
    // moved, and the prompt is still reachable from the section itself).
    if (!fromHistory && CONTENT_VIEWS.includes(view)) {
      const active = servers.find(s => s.id === activeServerId);
      const generated = !active || active.hasGenerated || isDismissed(active.id);
      const live = active ? getServerStatus(active.id) : null;
      const online = !!(live && live.status && live.status !== 'offline');
      if (active && !generated && !online) {
        setFirstStart({ open: true, pendingView: view, starting: false });
        return;
      }
    }
    setCurrentView(view);
    syncUrl(view, fromHistory);
  }, [serversLoaded, servers, activeServerId, user, isAdmin, hasCapability, activeModule, supports, getServerStatus, syncUrl, t]);

  const navigate = useCallback((view) => goTo(view), [goTo]);

  // Commit to a view unconditionally (used once the first-start dialog resolves).
  const commitView = useCallback((view) => {
    setCurrentView(view);
    syncUrl(view, false);
  }, [syncUrl]);

  // Browser Back/Forward and the mouse back button fire popstate; mirror the URL
  // back into the shown view (re-running the same guards).
  useEffect(() => {
    const onPop = () => {
      const game = pathGame();
      if (window.location.pathname === '/games') {
        // Back out of a game and its slide is the one waiting, same as when
        // the brand mark or Escape takes you there.
        setHubGame((last) => currentGame || last);
        setShowGames(true);
        setCurrentGame(null);
        return;
      }
      setShowGames(false);
      setCurrentGame(game);
      goTo(pathView(), { fromHistory: true });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [goTo, currentGame]);

  // Normalize the URL to the booted location once on mount (an unknown or
  // pre-hub path collapses to the restored game, or to the hub), seeding a
  // history entry so the first Back works. This can't go through `syncUrl`:
  // `currentGame` only lands in the context a tick later, so the closure here
  // would still see null and rewrite every path to '/games'.
  useEffect(() => {
    const path = boot.hub ? '/games' : `/games/${boot.game}/${boot.view}`;
    if (window.location.pathname === path) return;
    window.history.replaceState(boot.hub ? { hub: true } : { game: boot.game, view: boot.view }, '', path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remember where the user is, so the next visit to a game-less URL resumes
  // here. The hub is deliberately not recorded - it's a picker, not a place.
  useEffect(() => {
    if (showGames || !currentGame || !user?.id) return;
    writeLastLocation(user.id, currentGame, currentView);
  }, [showGames, currentGame, currentView, user?.id]);

  // Once servers/user are known, bounce out of any view the current state no
  // longer allows (deleted the last server while on Console, opened /users as a
  // non-admin via a direct link, etc.).
  useEffect(() => {
    if (!serversLoaded) return;
    if (SERVER_REQUIRED_VIEWS.has(currentView) && servers.length === 0) {
      setCurrentView('servers');
      syncUrl('servers', true);
    } else if (VIEW_CAPABILITIES[currentView] && user && !isAdmin && !hasCapability(VIEW_CAPABILITIES[currentView])) {
      setCurrentView('dashboard');
      syncUrl('dashboard', true);
    } else if (VIEW_MODULE_CAPABILITIES[currentView] && activeModule && !supportsAny(VIEW_MODULE_CAPABILITIES[currentView], supports)
      // The active server for the game is derived a tick after the fleet
      // loads (ServerContext), so a cold-load render may still be resolving
      // it. Bouncing a variant-gated view then would check it against the
      // game type's fallback capability list and throw away a valid bookmark
      // (a tModLoader mods URL opening while no server is selected yet).
      // Once the server resolves, `supports` changes and this effect re-runs
      // against the real capabilities.
      && !(currentGame && !activeServerId && (servers || []).some((server) => gameForServer(server) === currentGame))) {
      setCurrentView('dashboard');
      syncUrl('dashboard', true);
    }
  }, [serversLoaded, servers, currentView, user, isAdmin, hasCapability, activeModule, supports, syncUrl]);

  // Boot: load /api/me if we have a token but no user yet
  useEffect(() => {
    if (isLoggedIn && !user) {
      api('/api/me', { silent: true })
        .then(u => setUser(u))
        .catch(() => {});
    }
  }, [isLoggedIn]);

  // Load initial data on mount
  useEffect(() => {
    if (!isLoggedIn) return;
    loadServers();
  }, [isLoggedIn]);

  async function loadServers() {
    try {
      const [data, moduleData] = await Promise.all([
        api('/api/servers'),
        api('/api/modules'),
      ]);
      setModules(moduleData.modules || []);
      const srvs = data.servers || [];
      setServers(srvs);
      // Which server is active follows from the selected game - ServerContext
      // re-derives it from `servers` + `currentGame` (preferring the one this
      // user last used for that game). Picking one here instead would race it,
      // and this callback's `currentGame` is the mount-time value anyway.
      srvs.forEach((server) => { if (server.status) updateStatus(server.status); });
    } catch (e) { toast.error(e.message); }
    finally { setServersLoaded(true); }
  }

  // WebSocket
  const { sendMessage } = useWebSocket({
    onLine: useCallback((msg) => {
      if (msg.serverId !== activeServerId) return;
      setConsoleLines(prev => appendConsoleFrame(prev, msg.line));
    }, [activeServerId]),
    onHistory: useCallback((msg) => {
      if (msg.serverId !== activeServerId) return;
      setConsoleLines(dedupeConsoleHistory(msg.lines));
    }, [activeServerId]),
    onStatus: useCallback((msg) => {
      if (!msg) return;
      updateStatus(msg);
      if (msg.serverId === activeServerId && msg.status === 'online' && awaitingFirstStart.current) {
        awaitingFirstStart.current = false;
        setViewNonce(n => n + 1);
        toast.success(t('firstStart.onlineToast'));
        loadServers();
      }
    }, [activeServerId, updateStatus, t]),
    onStats: useCallback((stats) => {
      // Pass to dashboard if it's the active listener
      if (window.__dashOnStats) window.__dashOnStats(stats);
    }, []),
    onNotification: useCallback((n) => {
      // Routine mutations already show a specific success toast at their call
      // site. Keep those events in the bell without showing them a second time.
      const liveToastTypes = new Set(['server_crashed', 'watchdog_limit', 'watchdog_restart']);
      if (!liveToastTypes.has(n.type)) return;
      const serverName = servers.find((server) => server.id === n.serverId)?.name || '';
      const fallbackKey = `notifications.${n.type}`;
      const title = n.titleKey ? t(n.titleKey, n.titleVars) : t(`${fallbackKey}Title`, { name: serverName });
      const message = n.messageKey ? t(n.messageKey, n.messageVars) : t(`${fallbackKey}Message`, { name: serverName });
      const opts = message ? { description: message } : undefined;
      if (n.type === 'server_crashed' || n.type === 'watchdog_limit') toast.error(title, opts);
      else toast(title, opts);
    }, [servers, t]),
    onConnChange: setConnState,
  });

  async function handleSetActive(id) {
    if (!id || id === activeServerId) return;
    try {
      setActiveServerId(id);
      setConsoleLines([]);
      sendMessage({ type: 'selectServer', serverId: id });
    } catch (e) { toast.error(e.message); }
  }

  async function runServerAction(action) {
    const endpoint = action === 'start' ? '/api/server/start' :
                     action === 'stop'  ? '/api/server/stop' :
                     '/api/server/restart';
    try {
      await api(endpoint, { method: 'POST' });
    } catch (e) { toast.error(e.message); }
  }

  function serverAction(action) {
    // Mirrors handleCommand's liveness check below: no active server means
    // there is nothing to start, stop, or restart, so this is a silent no-op
    // rather than a request into the void.
    if (!activeServerId) return;
    // Restart is disruptive (kicks everyone) - confirm with the app's own
    // dialog instead of the browser's native confirm box.
    if (action === 'restart') { setConfirmRestart(true); return; }
    runServerAction(action);
  }

  function handleCommand(cmd) {
    const live = activeServerId ? getServerStatus(activeServerId) : null;
    const online = !!(live && live.status && live.status !== 'offline');
    if (!online) {
      toast.warning(t('console.serverOffline'));
      return;
    }
    sendMessage({ type: 'command', cmd });
  }

  function closeFirstStart() {
    setFirstStart({ open: false, pendingView: null, starting: false });
  }

  async function startFromFirstStart() {
    if (!activeServerId) { closeFirstStart(); return; }
    markDismissed(activeServerId);
    setFirstStart(prev => ({ ...prev, starting: true }));
    awaitingFirstStart.current = true;
    const pendingView = firstStart.pendingView;
    try {
      await api('/api/server/start', { method: 'POST' });
      commitView(pendingView);
      closeFirstStart();
      toast(t('firstStart.startingToast'));
      loadServers();
    } catch (e) {
      awaitingFirstStart.current = false;
      toast.error(e.message);
      setFirstStart(prev => ({ ...prev, starting: false }));
    }
  }

  function continueFromFirstStart() {
    if (activeServerId) markDismissed(activeServerId);
    commitView(firstStart.pendingView);
    closeFirstStart();
  }

  const views = {
    dashboard: <DashboardView active={currentView === 'dashboard'} onNavigate={navigate} onServerAction={serverAction} />,
    servers:   <ServersView onSetActive={handleSetActive} onRefresh={loadServers} onNavigate={navigate} />,
    health:    <HealthView onNavigate={navigate} />,
    console:   <ConsoleView lines={consoleLines} onCommand={handleCommand} onNavigate={navigate} />,
    players:   supports('terraria-tshock') ? <TerrariaTshockView /> : <PlayersView />,
    map:       <MapView />,
    addons:    supports('terraria-mods') ? <TerrariaModsView /> : <AddonsView />,
    modrinth:  <ModrinthView />,
    files:     <FileManagerView />,
    configs:   <ConfigsView />,
    worlds:    <WorldsView />,
    backups:   <BackupsView />,
    updates:   <UpdatesView />,
    tasks:     <TasksView />,
    users:     <UsersView />,
    audit:     <AuditView />,
  };

  const connBanner = connState === 'connecting' ? {
    icon: RefreshCw,
    text: t('common.reconnecting'),
    desc: t('common.reconnectingDesc'),
    tint: 'bg-primary/15',
    classes: 'text-primary border-primary/20',
  } : connState === 'bad' ? {
    icon: WifiOff,
    text: t('common.connectionLost'),
    desc: t('common.loadFailed'),
    tint: 'bg-status-error/15',
    classes: 'text-status-error border-status-error/20',
  } : null;

  return (
    <TooltipProvider delayDuration={800}>
      {showGames ? <GamesView onSelect={selectGame} startGame={hubGame} /> : (
      <div data-game={currentGame || 'custom'} className="app-shell-enter relative flex min-h-screen bg-background">
        {/* Connection banner */}
        {connBanner && (
          <div className={cn('fixed top-0 left-0 right-0 z-50 flex items-center gap-3 border-b bg-background px-4 py-2 text-xs', connBanner.classes)}>
            <div className={cn('absolute inset-0 -z-10 pointer-events-none', connBanner.tint)} />
            <connBanner.icon className="h-3.5 w-3.5 animate-pulse shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="font-medium">{connBanner.text}</span>
              {connBanner.desc && <span className="opacity-70 ml-1">{connBanner.desc}</span>}
            </div>
            {connState === 'bad' && (
              <Button variant="glass" size="xs" onClick={() => window.location.reload()}>
                <RefreshCw className="h-3 w-3" /> {t('common.retry')}
              </Button>
            )}
          </div>
        )}

        <div className="app-environment pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
          <GameArtwork gameId={currentGame || 'custom'} eager className="absolute inset-x-0 top-0 h-[26rem] opacity-[0.075] grayscale" />
          <div className="app-environment-shade absolute inset-0" />
        </div>
        <Sidebar currentView={currentView} onNavigate={navigate} onAllGames={showAllGames} />
        <div className={cn(
          'app-main relative z-10 flex min-h-screen flex-1 min-w-0 flex-col pl-[var(--ls-sidebar-w,220px)] transition-[padding] duration-200',
          connBanner && 'pt-9',
        )}>
          <Header currentView={currentView} onOpenSettings={() => setSettingsOpen(true)} />
          <main className="flex-1 px-4 pb-28 pt-5 sm:px-6 lg:px-8">
            <div className="view-enter" key={`${currentView}:${viewNonce}`}>
              {!serversLoaded ? (
                <Loading size="lg" className="py-24" />
              ) : (
                <Page>
                  <ErrorBoundary fallbackText={t('errors.viewCrashed')} reloadText={t('errors.reloadView')}>
                    {new URLSearchParams(window.location.search).has('fleetdeckThrowView') ? <ViewErrorProbe /> : views[currentView] || null}
                  </ErrorBoundary>
                </Page>
              )}
            </div>
          </main>
        </div>
      </div>
      )}
      <FirstStartDialog
        open={firstStart.open}
        onOpenChange={(o) => { if (!o) closeFirstStart(); }}
        serverName={servers.find(s => s.id === activeServerId)?.name}
        starting={firstStart.starting}
        onStartNow={startFromFirstStart}
        onContinueAnyway={continueFromFirstStart}
      />
      <OnboardingTour open={tourOpen && !showGames} onClose={closeTour} gameId={currentGame} />
      <ChangelogDialog
        open={changelogOpen && !showGames}
        onOpenChange={setChangelogOpen}
        version={currentAppVersion()}
      />
      <ConfirmDialog
        open={confirmRestart}
        onOpenChange={setConfirmRestart}
        title={t('header.restart')}
        description={t('header.restartConfirm')}
        confirmLabel={t('header.restart')}
        onConfirm={() => runServerAction('restart')}
      />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onStartTour={startTour}
      />
      {!showGames && (
        <ControlBar
          onServerSwitch={handleSetActive}
          onStart={() => serverAction('start')}
          onStop={() => serverAction('stop')}
          onRestart={() => serverAction('restart')}
        />
      )}
      {!showGames && (
        <BugReportButton
          game={currentGame}
          view={currentView}
        />
      )}
    </TooltipProvider>
  );
}

// e2e/QA probe: ?fleetdeckThrowView=1 forces a render error inside the
// ErrorBoundary so the recovery UI can be tested deterministically. It is
// inert unless the query parameter is present; no real user flow hits it.
function ViewErrorProbe() {
  throw new Error('fleetdeck error-boundary e2e probe');
}

export default function App() {
  const { isLoggedIn, login, authChecked } = useAuth();
  const { setLang } = useI18n();

  const handleLogin = (token, user) => {
    if (user && user.language) setLang(user.language);
    login(token, user);
    window.history.replaceState({ hub: true }, '', '/games');
  };

  // Hold off on the login screen until /api/auth-mode answers - when sign-in
  // is off the app shell boots straight into the guest session.
  if (!authChecked) return null;

  if (!isLoggedIn) {
    return <LoginView onLogin={handleLogin} />;
  }

  return <AppShell />;
}
