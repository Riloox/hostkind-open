import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { toast } from 'sonner';
import { useAuth, useGameThemes } from '@/context/AuthContext';
import { applyGameTheme, fadeGameTheme } from '@/lib/branding';
import { useServer } from '@/context/ServerContext';
import { useStats } from '@/context/StatsContext';
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
import { Page } from '@/components/layout/Page';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { ApplicationUpdateNotice } from '@/components/shared/ApplicationUpdateNotice';
import { BugReportDialog } from '@/components/shared/BugReportDialog';
import { TermsDialog } from '@/components/shared/TermsDialog';
import { TERMS_VERSION } from '@/lib/terms';
import { ChangelogDialog } from '@/components/shared/ChangelogDialog';
import { currentAppVersion, changelogUnread, markChangelogRead } from '@/lib/changelog';
import { AddServerProvider } from '@/components/shared/AddServer';
// Route-split views: each lazy() boundary becomes its own Rollup chunk so the
// initial bundle stays small (see vite.config.js manualChunks). Named exports
// are remapped to default for lazy(). LoginView stays eager - it is the first
// paint for the logged-out state.
const HomeView = lazy(() => import('@/views/HomeView').then((m) => ({ default: m.HomeView })));
const OverviewView = lazy(() => import('@/views/OverviewView').then((m) => ({ default: m.OverviewView })));
const DetailsView = lazy(() => import('@/views/DetailsView').then((m) => ({ default: m.DetailsView })));
const CrashView = lazy(() => import('@/views/DetailsView').then((m) => ({ default: m.CrashView })));
const ConsoleView = lazy(() => import('@/views/ConsoleView').then((m) => ({ default: m.ConsoleView })));
const PlayersView = lazy(() => import('@/views/PlayersView').then((m) => ({ default: m.PlayersView })));
const TerrariaTshockView = lazy(() => import('@/views/TerrariaTshockView').then((m) => ({ default: m.TerrariaTshockView })));
const ModsSection = lazy(() => import('@/views/SectionViews').then((m) => ({ default: m.ModsSection })));
const WorldsSection = lazy(() => import('@/views/SectionViews').then((m) => ({ default: m.WorldsSection })));
const SettingsSection = lazy(() => import('@/views/SectionViews').then((m) => ({ default: m.SettingsSection })));
const BackupsView = lazy(() => import('@/views/BackupsView').then((m) => ({ default: m.BackupsView })));
const TasksView = lazy(() => import('@/views/TasksView').then((m) => ({ default: m.TasksView })));
const PanelSettingsView = lazy(() => import('@/views/PanelSettingsView').then((m) => ({ default: m.PanelSettingsView })));
import { parseLocation, buildPath, resolveLegacy, APP_VIEWS, SERVER_VIEWS } from '@/lib/routes';
import { viewAvailable, settleSection } from '@/lib/sections';
import { panelTabAllowed } from '@/lib/panel';
import { useSectionContext } from '@/hooks/useSections';
import { gameForServer } from '@/lib/games';
import { WifiOff, RefreshCw } from 'lucide-react';
import { cn, jwtSubject } from '@/lib/utils';

const CONSOLE_DUPLICATE_WINDOW_MS = 1500;
const CONSOLE_ANSI_ESCAPE_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~])/g;
const CONSOLE_MC_TIMESTAMP_RE = /^\[\d{2}:\d{2}:\d{2}(?:\s+\w+)?\](?:\s*\[[^\]]*\])?:\s*/;

// Stored frames carry their key (dedupeKey) so the duplicate scan below does a
// string compare per earlier line instead of three regex passes.
function consoleLineKey(line) {
  if (typeof line?.dedupeKey === 'string') return line.dedupeKey;
  return String(line?.text || '')
    .replace(CONSOLE_ANSI_ESCAPE_RE, '')
    .replace(/\r/g, '')
    .replace(CONSOLE_MC_TIMESTAMP_RE, '');
}

function isRecentConsoleDuplicate(lines, line, key) {
  if (!line || line.level === 'cmd') return false;
  const timestamp = line.ts || 0;
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

const CONSOLE_MAX_LINES = 1200;

// Appends a batch of lines with a single copy of the buffer. Copying (and
// re-rendering) once per line made a chatty server boot, or loading a full
// history, quadratic.
function appendConsoleFrames(lines, incoming) {
  let next = null;
  for (const line of incoming) {
    const key = consoleLineKey(line);
    if (isRecentConsoleDuplicate(next || lines, line, key)) continue;
    if (!next) next = lines.slice();
    consoleSeq += 1;
    next.push({ ...line, seq: consoleSeq, dedupeKey: key });
  }
  if (!next) return lines;
  return next.length > CONSOLE_MAX_LINES ? next.slice(-CONSOLE_MAX_LINES) : next;
}

function dedupeConsoleHistory(lines) {
  return appendConsoleFrames([], Array.isArray(lines) ? lines : []);
}

// Live lines are queued and flushed together at most this often, so a server
// printing hundreds of lines a second costs ~20 shell renders, not hundreds.
// A timer rather than requestAnimationFrame: rAF pauses in background tabs,
// and the queue would grow without bound there.
const CONSOLE_FLUSH_MS = 50;

// The server this user last had open, so a link that names no server (an old
// `/console` bookmark) can still land somewhere sensible.
function lastServerKey(userId) {
  return `fleetdeck_last_server:${userId || ''}`;
}

function readLastServer(userId) {
  if (!userId) return null;
  try { return localStorage.getItem(lastServerKey(userId)) || null; }
  catch (_) { return null; }
}

function writeLastServer(userId, serverId) {
  if (!userId || !serverId) return;
  try { localStorage.setItem(lastServerKey(userId), serverId); } catch (_) {}
}

// The last server per game, kept by ServerContext. Only old game-scoped links
// (`/games/<game>/...`) still need it.
function readServersByGame(userId) {
  if (!userId) return {};
  try {
    const stored = JSON.parse(localStorage.getItem(`fleetdeck_active_servers:${userId}`) || '{}');
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  } catch (_) { return {}; }
}

function AppShell({ onLoggedIn }) {
  const { token, user, setUser, isLoggedIn, hasCapability } = useAuth();
  const { servers, setServers, activeServerId, setActiveServerId, getServerStatus, updateStatus, activeModule, setModules, currentGame } = useServer();
  const sectionContext = useSectionContext();
  const { publishStats } = useStats();
  const api = useApi();
  const t = useT();
  const gameThemes = useGameThemes();
  const userId = user?.id || jwtSubject(token);

  // The URL is the source of truth for where the user is: which server (when
  // it names one) and which view. See src/lib/routes.js for the shapes.
  const [route, setRoute] = useState(() => parseLocation(window.location.pathname));
  // The sidebar drawer on phones. Any navigation closes it.
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => { setNavOpen(false); }, [route]);
  const closeNav = useCallback(() => setNavOpen(false), []);
  const currentView = route.kind === 'home' ? 'home' : (route.kind === 'legacy' ? null : route.view);
  const [serversLoaded, setServersLoaded] = useState(false);
  const [consoleLines, setConsoleLines] = useState([]);
  const pendingLinesRef = useRef([]);
  const lineFlushTimerRef = useRef(null);
  const [connState, setConnState] = useState('connecting');

  const isAdmin = user?.role === 'admin';
  // Which Hostkind settings tabs this user sees (src/lib/panel.js).
  const panelContext = useMemo(() => ({ isAdmin, can: (capability) => hasCapability(capability) }), [isAdmin, hasCapability]);

  // Move to a path. Pushing adds a history entry so Back/Forward (and the mouse
  // back button) can return here; replacing is for redirects the user did not
  // ask for, which keep the query and hash of the URL they rewrite.
  const navigatePath = useCallback((path, { replace = false } = {}) => {
    if (window.location.pathname !== path) {
      if (replace) window.history.replaceState(null, '', `${path}${window.location.search}${window.location.hash}`);
      else window.history.pushState(null, '', path);
    }
    setRoute(parseLocation(path));
  }, []);

  // The server in the URL is the one every server-scoped view acts on. Set
  // before paint so a view never fetches for the server it is leaving.
  useLayoutEffect(() => {
    if (route.kind === 'server' && route.serverId !== activeServerId) setActiveServerId(route.serverId);
  }, [route, activeServerId, setActiveServerId]);

  useEffect(() => {
    if (route.kind === 'server') writeLastServer(userId, route.serverId);
  }, [route, userId]);

  // Mirror the open server's game onto <html> so the per-game colour ramp in
  // src/tokens.css reaches everything, not just this subtree: dialogs,
  // dropdowns, tooltips and toasts all portal to <body> and would otherwise
  // render on the default ember theme while the shell behind them is themed.
  // Leaving one game's theme for another's fades between the two ramps rather
  // than snapping (src/lib/branding.js fadeGameTheme). Arriving from no game
  // snaps: on a page load the server list resolves after the first render, and
  // fading from the default ramp would flash it on every reload. A new colour
  // for the same game (Settings, or config arriving late) snaps too. The
  // cleanup lives in its own effect: clearing data-game between runs would
  // make every fade start from the default ramp instead of the game being left.
  const themedGame = useRef(null);
  useEffect(() => {
    const root = document.documentElement;
    const game = currentGame;
    const apply = () => {
      if (game) root.dataset.game = game;
      else delete root.dataset.game;
      applyGameTheme(game, gameThemes?.[game]);
    };
    if (themedGame.current && themedGame.current !== game) fadeGameTheme(apply);
    else apply();
    themedGame.current = game;
  }, [currentGame, gameThemes]);
  useEffect(() => () => { delete document.documentElement.dataset.game; }, []);

  const goHome = useCallback(() => navigatePath('/'), [navigatePath]);
  // Home lists every server once there are two or more; with one, home opens
  // it, so the list lives at /servers.
  const showAllServers = useCallback(() => navigatePath(servers.length > 1 ? '/' : buildPath({ view: 'servers' })), [navigatePath, servers.length]);
  const openServer = useCallback((serverId) => navigatePath(buildPath({ serverId })), [navigatePath]);

  // Bumped when the open server first comes online, so the current view
  // re-mounts and re-fetches its data (the auto-generated files only exist
  // once the server is fully up).
  const [viewNonce, setViewNonce] = useState(0);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  // The changelog never opens by itself; after an update the profile menu
  // marks "What's new" instead (src/lib/changelog.js).
  const [whatsNewUnread, setWhatsNewUnread] = useState(changelogUnread);
  const [bugReport, setBugReport] = useState({ open: false, context: null });
  // Never-started servers on their way up (see onStatus).
  const firstStarts = useRef(new Set());
  // Every user accepts the current Terms of Use before using the panel; the
  // changelog waits behind it.
  const termsPending = !!user?.id && user.termsAcceptedVersion !== TERMS_VERSION;

  function openChangelog() {
    markChangelogRead();
    setWhatsNewUnread(false);
    setChangelogOpen(true);
  }

  // The report describes the screen the user was on when they chose to file
  // it, so the context is captured now rather than read at render time.
  function openBugReport() {
    const view = route.tab && currentView !== 'crashes' ? `${currentView}/${route.tab}` : currentView;
    setBugReport({ open: true, context: { game: currentGame, view, route: window.location.pathname } });
  }

  // Central navigation entry point for in-app links. Applies the admin and
  // module guards, then moves the URL. A server view opens on
  // the server already open, else the one used last, else the only one there
  // is; with no server to show it on, the user goes home. `tab` picks a tab
  // of a tabbed section (or the crash on a crash page).
  const goTo = useCallback((view, tab = null) => {
    if (view === 'home') { navigatePath('/'); return; }
    if (view === 'panel' && tab && !panelTabAllowed(tab, panelContext)) return;
    if (APP_VIEWS.has(view)) { navigatePath(buildPath({ view, tab })); return; }
    const known = (id) => (id && servers.some((s) => s.id === id) ? id : null);
    const serverId = known(activeServerId) || known(readLastServer(userId)) || (servers.length === 1 ? servers[0].id : null);
    if (!serverId) {
      if (serversLoaded && servers.length === 0) toast.error(t('nav.requiresServerToast'));
      navigatePath('/');
      return;
    }
    if (serverId === activeServerId && activeModule && !viewAvailable(view, sectionContext)) {
      toast.error(t('errors.notSupported'));
      return;
    }
    navigatePath(buildPath({ view, serverId, tab }));
  }, [serversLoaded, servers, activeServerId, userId, panelContext, activeModule, sectionContext, navigatePath, t]);

  const navigate = goTo;
  const openPanelSettings = useCallback((tab = null) => goTo('panel', tab), [goTo]);

  // Choosing a tab of the section on screen. Same guards as any navigation.
  const openTab = useCallback((tab) => {
    if (route.kind === 'server') goTo(route.view, tab);
  }, [route, goTo]);

  // Browser Back/Forward and the mouse back button fire popstate; the URL is
  // already where the user went, so just read it back.
  useEffect(() => {
    const onPop = () => setRoute(parseLocation(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Once the server list is known, settle every location that cannot be shown
  // as it stands: an old link is rewritten onto a server, home with a single
  // server opens it, a server that no longer exists goes home, and a view this
  // user or this server cannot have falls back to the server's overview.
  useEffect(() => {
    if (!serversLoaded) return;
    if (route.kind === 'legacy') {
      const list = servers.map((s) => ({ id: s.id, game: gameForServer(s) }));
      const remembered = { lastServerId: readLastServer(userId), byGame: readServersByGame(userId) };
      navigatePath(resolveLegacy(route, list, remembered), { replace: true });
      return;
    }
    if (route.kind === 'home' && servers.length === 1) {
      navigatePath(buildPath({ serverId: servers[0].id }), { replace: true });
      return;
    }
    if (route.kind === 'server' && !servers.some((s) => s.id === route.serverId)) {
      navigatePath('/', { replace: true });
      return;
    }
    // A Hostkind settings tab this user may not see opens the page's first.
    if (route.kind === 'app' && route.view === 'panel' && route.tab && user && !panelTabAllowed(route.tab, panelContext)) {
      navigatePath(buildPath({ view: 'panel' }), { replace: true });
      return;
    }
    if (route.kind !== 'server') return;
    // An old section name (`/addons`) is shown where it lives now, under the
    // URL it has there.
    const canonical = buildPath(route);
    if (canonical !== window.location.pathname) {
      navigatePath(canonical, { replace: true });
      return;
    }
    // A section or tab this server (or this user) does not have.
    if (route.serverId === activeServerId && activeModule) {
      const moved = settleSection(route.view, route.tab, sectionContext);
      if (moved) navigatePath(buildPath({ ...moved, serverId: route.serverId }), { replace: true });
    }
  }, [serversLoaded, servers, route, activeServerId, userId, user, panelContext, activeModule, sectionContext, navigatePath]);

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

  // Resolves to the fresh list (or null on failure), so a caller that just
  // added a server can find it.
  async function loadServers() {
    try {
      const [data, moduleData] = await Promise.all([
        api('/api/servers'),
        api('/api/modules'),
      ]);
      setModules(moduleData.modules || []);
      const srvs = data.servers || [];
      setServers(srvs);
      // Which server is active follows from the URL, not from this list.
      srvs.forEach((server) => { if (server.status) updateStatus(server.status); });
      return srvs;
    } catch (e) {
      toast.error(e.message);
      return null;
    } finally { setServersLoaded(true); }
  }

  const flushConsoleLines = useCallback(() => {
    lineFlushTimerRef.current = null;
    const batch = pendingLinesRef.current;
    if (!batch.length) return;
    pendingLinesRef.current = [];
    setConsoleLines(prev => appendConsoleFrames(prev, batch));
  }, []);

  // Queued lines belong to whatever the console showed before a reset (a
  // server switch, or a history that already contains them).
  const dropPendingConsoleLines = useCallback(() => {
    pendingLinesRef.current = [];
    clearTimeout(lineFlushTimerRef.current);
    lineFlushTimerRef.current = null;
  }, []);

  useEffect(() => dropPendingConsoleLines, [dropPendingConsoleLines]);

  // A different server has a different console. Its history arrives over the
  // socket once useWebSocket re-selects it.
  useEffect(() => {
    dropPendingConsoleLines();
    setConsoleLines([]);
  }, [activeServerId, dropPendingConsoleLines]);

  // WebSocket
  const { sendMessage } = useWebSocket({
    onLine: useCallback((msg) => {
      if (msg.serverId !== activeServerId) return;
      pendingLinesRef.current.push(msg.line);
      if (!lineFlushTimerRef.current) {
        lineFlushTimerRef.current = setTimeout(flushConsoleLines, CONSOLE_FLUSH_MS);
      }
    }, [activeServerId, flushConsoleLines]),
    onHistory: useCallback((msg) => {
      if (msg.serverId !== activeServerId) return;
      dropPendingConsoleLines();
      setConsoleLines(dedupeConsoleHistory(msg.lines));
    }, [activeServerId, dropPendingConsoleLines]),
    onStatus: useCallback((msg) => {
      if (!msg) return;
      updateStatus(msg);
      // A never-started server that comes up has generated its files by the
      // time it is online: re-fetch the list and the page on screen then. It
      // is marked generated as soon as it launches, so remember it from the
      // "starting" frame.
      const server = servers.find((s) => s.id === msg.serverId);
      if (server?.hasGenerated === false && (msg.status === 'starting' || msg.status === 'online')) {
        firstStarts.current.add(server.id);
      }
      if (msg.status === 'online' && firstStarts.current.delete(msg.serverId) && msg.serverId === activeServerId) {
        setViewNonce(n => n + 1);
        toast.success(t('firstStart.onlineToast'));
        loadServers();
      }
    }, [activeServerId, servers, updateStatus, t]),
    onStats: useCallback((stats) => {
      publishStats(stats);
    }, [publishStats]),
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
    // Console commands are fire-and-forget over the socket; a refusal comes
    // back as an error frame and is the only sign the command did not run.
    onError: useCallback((msg) => {
      if (msg && typeof msg.code === 'string' && msg.code.startsWith('command_') && msg.error) toast.error(msg.error);
    }, []),
  });

  // Switching servers is a navigation: stay on the same section of the other
  // server when it is a server section, otherwise open its overview. A section
  // the other server does not have falls back to its overview (see the
  // settle-the-location effect above).
  function handleSetActive(id) {
    if (!id) return;
    // A crash belongs to the server it happened on; the other server gets
    // its own details page instead.
    const view = currentView === 'crashes' ? 'details' : (SERVER_VIEWS.has(currentView) ? currentView : 'dashboard');
    const tab = view === currentView ? route.tab : null;
    navigatePath(buildPath({ view, serverId: id, tab }));
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
    // Name the target: the socket's selected server can lag behind (or have
    // been refused), and a command must never land on a different console.
    if (!sendMessage({ type: 'command', serverId: activeServerId, cmd })) toast.error(t('console.notConnected'));
  }

  const views = {
    home:      <HomeView onOpenServer={openServer} onRefresh={loadServers} />,
    dashboard: <OverviewView active={currentView === 'dashboard'} onNavigate={navigate} onServerAction={serverAction} />,
    servers:   <HomeView onOpenServer={openServer} onRefresh={loadServers} />,
    details:   <DetailsView onNavigate={navigate} onOpenCrash={(id) => navigate('crashes', id)} />,
    crashes:   <CrashView crashId={route.tab} onNavigate={navigate} />,
    console:   <ConsoleView lines={consoleLines} onCommand={handleCommand} onNavigate={navigate} />,
    players:   sectionContext.supports('terraria-tshock') ? <TerrariaTshockView /> : <PlayersView />,
    worlds:    <WorldsSection tab={route.tab} onTab={openTab} />,
    mods:      <ModsSection tab={route.tab} onTab={openTab} />,
    backups:   <BackupsView />,
    tasks:     <TasksView />,
    settings:  <SettingsSection tab={route.tab} onTab={openTab} onRefresh={loadServers} />,
    panel:     <PanelSettingsView tab={route.tab} onTab={openPanelSettings} />,
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

  // Nothing to show yet: the server list is loading, or the location is about
  // to be rewritten (an old link, home with one server), or the URL has moved
  // to a server the context has not switched to - rendering then would let the
  // view fetch for the server being left.
  const settling = !serversLoaded
    || route.kind === 'legacy'
    || (route.kind === 'home' && servers.length === 1)
    || (route.kind === 'server' && route.serverId !== activeServerId);

  return (
    <TooltipProvider delayDuration={800}>
      <AddServerProvider canAddServer={isAdmin} onAdded={loadServers} onOpenServer={openServer}>
      <div className="app-shell-enter relative flex min-h-screen bg-background">
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

        <ErrorBoundary testId="shell-error-boundary" fallbackText={t('errors.shellCrashed')} reloadText={t('errors.reloadView')} resetKeys={[viewNonce]}>
          <Sidebar currentView={currentView} onNavigate={navigate} onHome={goHome} onSwitchServer={handleSetActive} onAllServers={showAllServers} drawerOpen={navOpen} onDrawerClose={closeNav} />
        </ErrorBoundary>
        <div className={cn(
          'app-main relative z-10 flex min-h-screen flex-1 min-w-0 flex-col pl-[var(--ls-sidebar-w,220px)] transition-[padding] duration-200',
          connBanner && 'pt-9',
        )}>
          <ErrorBoundary testId="shell-error-boundary" fallbackText={t('errors.shellCrashed')} reloadText={t('errors.reloadView')} resetKeys={[viewNonce]}>
            <Header currentView={currentView} onOpenNav={() => setNavOpen(true)} onOpenSettings={openPanelSettings} onOpenUpdates={() => openPanelSettings('updates')} whatsNewUnread={whatsNewUnread} onOpenChangelog={openChangelog} onReportProblem={openBugReport} onServerAction={serverAction} onNavigate={navigate} onRefresh={loadServers} />
          </ErrorBoundary>
          <main className="flex-1 px-4 pb-10 pt-5 sm:px-6 lg:px-8">
            <div className="view-enter" key={`${currentView}:${viewNonce}`}>
              {settling ? (
                <Loading size="lg" className="py-24" />
              ) : (
                <Page>
                  <ErrorBoundary fallbackText={t('errors.viewCrashed')} reloadText={t('errors.reloadView')} resetKeys={[viewNonce]}>
                    <Suspense fallback={<Loading size="lg" className="py-24" />} key={currentView}>
                      {new URLSearchParams(window.location.search).has('fleetdeckThrowView') ? <ViewErrorProbe /> : views[currentView] || null}
                    </Suspense>
                  </ErrorBoundary>
                </Page>
              )}
            </div>
          </main>
        </div>
      </div>
      <ChangelogDialog
        open={changelogOpen && !termsPending}
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
      <TermsDialog open={termsPending} mode="accept" />
      <ApplicationUpdateNotice onOpenSettings={() => openPanelSettings('updates')} />
      <BugReportDialog open={bugReport.open} onOpenChange={(open) => setBugReport((prev) => ({ ...prev, open }))} context={bugReport.context} />
      </AddServerProvider>
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
  const { setLang, t } = useI18n();

  const handleLogin = (token, user) => {
    if (user && user.language) setLang(user.language);
    login(token, user);
    window.history.replaceState(null, '', '/');
  };

  // Hold off on the login screen until /api/auth-mode answers - when sign-in
  // is off the app shell boots straight into the guest session.
  if (!authChecked) return null;

  if (!isLoggedIn) {
    return <LoginView onLogin={handleLogin} />;
  }

  // Last-resort boundary: per-panel and view-level boundaries recover locally,
  // this one keeps a total shell failure from white-screening the tab.
  return (
    <ErrorBoundary testId="app-error-boundary" fallbackText={t('errors.shellCrashed')} reloadText={t('errors.reloadView')}>
      <AppShell />
    </ErrorBoundary>
  );
}
