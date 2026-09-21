import { createContext, useContext, useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import { gameForServer } from '@/lib/games';
import { StatusProvider, useStatus } from '@/context/StatusContext';

// Compatibility seam: StatusProvider owns the high-frequency statuses state,
// so status ticks no longer live in the same provider as the server list.
// useServer() below merges both contexts, so the 20+ existing consumers keep
// working unchanged; new code that only needs the list (or only statuses)
// should use useServerList() (or useStatus()) to skip unrelated re-renders.
export { StatusProvider, useStatus } from '@/context/StatusContext';

const ServerListContext = createContext(null);

export function ServerProvider({ children }) {
  return (
    <StatusProvider>
      <ServerListProvider>{children}</ServerListProvider>
    </StatusProvider>
  );
}

function ServerListProvider({ children }) {
  const { user } = useAuth();
  const [servers, setServers] = useState([]);
  const [activeServerId, setActiveServerIdState] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [modules, setModules] = useState([]);
  const [currentGame, setCurrentGame] = useState(null);
  const [activeServerByGame, setActiveServerByGame] = useState({});
  const wsRef = useRef(null);

  // Live notifications arrive over the WebSocket (a full list on connect, then
  // one frame per new event). Prepend live frames, dedupe by id, and cap the
  // client-side buffer to match the server's retention.
  const pushNotification = useCallback((n) => {
    if (!n || !n.id) return;
    setNotifications((prev) => (
      prev.some((x) => x.id === n.id) ? prev : [n, ...prev].slice(0, 200)
    ));
  }, []);

  const setActiveServerId = useCallback((id) => {
    setActiveServerIdState(id);
    const server = servers.find(item => item.id === id);
    const game = server ? gameForServer(server) : currentGame;
    if (game && id) setActiveServerByGame(prev => ({ ...prev, [game]: id }));
  }, [servers, currentGame]);

  useEffect(() => {
    if (!user?.id) return;
    try {
      const stored = JSON.parse(localStorage.getItem(`fleetdeck_active_servers:${user.id}`) || '{}');
      setActiveServerByGame(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {});
    } catch { setActiveServerByGame({}); }
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    try { localStorage.setItem(`fleetdeck_active_servers:${user.id}`, JSON.stringify(activeServerByGame)); } catch {}
  }, [activeServerByGame, user?.id]);

  useEffect(() => {
    if (!currentGame) return;
    const candidates = servers.filter(server => gameForServer(server) === currentGame);
    const selected = activeServerByGame[currentGame];
    setActiveServerIdState(candidates.some(server => server.id === selected) ? selected : (candidates[0]?.id || null));
  }, [currentGame, servers, activeServerByGame]);

  // Look up the active server once per render; MapView and any other
  // consumer needs to react whenever the user switches servers or any
  // server's mapUrl is updated (via PUT /api/servers/:id/map or the regular
  // edit form). useMemo with these deps re-evaluates the URL only when
  // something the URL actually depends on changes.
  const activeServer = useMemo(
    () => servers.find((s) => s.id === activeServerId) || null,
    [servers, activeServerId]
  );
  const mapUrl = activeServer ? (activeServer.mapUrl || '') : '';
  // No active server and no game selected means we're on the hub, where no
  // module applies - resolving to Minecraft there is how a game-less shell used
  // to quietly present itself as a Minecraft one.
  const activeModuleType = activeServer?.type || currentGame || null;
  const activeModule = (activeModuleType && modules.find((module) => module.type === activeModuleType)) || null;
  // A server's own capabilities win over its game type's. Terraria's variants
  // do not expose the same features (only tModLoader has mods, only TShock has
  // the TShock tools), so the type-level list is a fallback for a game with no
  // server selected, not the authority for one that is.
  const moduleCapabilities = activeServer?.capabilities || activeModule?.capabilities || [];
  const supports = useCallback(
    (capability) => moduleCapabilities.includes(capability),
    [moduleCapabilities]
  );

  const value = useMemo(() => ({
    servers, setServers,
    activeServerId, setActiveServerId,
    activeServer,
    notifications, setNotifications, pushNotification,
    modules, setModules, activeModule, moduleCapabilities, supports,
    currentGame, setCurrentGame, activeServerByGame,
    mapUrl,
    wsRef,
  }), [
    servers, activeServerId, setActiveServerId, activeServer,
    notifications, pushNotification,
    modules, activeModule, moduleCapabilities, supports,
    currentGame, activeServerByGame, mapUrl,
  ]);

  return (
    <ServerListContext.Provider value={value}>
      {children}
    </ServerListContext.Provider>
  );
}

// List / selection / modules slice only: does not subscribe to StatusContext,
// so status ticks never re-render consumers of this hook.
export function useServerList() {
  const ctx = useContext(ServerListContext);
  if (!ctx) throw new Error('useServerList must be used within a ServerProvider');
  return ctx;
}

// Full pre-split API: merges the list slice with StatusContext so existing
// consumers keep working unchanged.
export function useServer() {
  return { ...useServerList(), ...useStatus() };
}
