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

  // The shell sets this from the URL (`/servers/<id>/...`); nothing else picks
  // a server on its own.
  const setActiveServerId = useCallback((id) => {
    setActiveServerIdState(id || null);
  }, []);

  // Look up the active server once per render; MapView and any other
  // consumer needs to react whenever the user switches servers or any
  // server's mapUrl is updated (via PUT /api/servers/:id/map or the regular
  // edit form). useMemo with these deps re-evaluates the URL only when
  // something the URL actually depends on changes.
  const activeServer = useMemo(
    () => servers.find((s) => s.id === activeServerId) || null,
    [servers, activeServerId]
  );
  // The game is a property of the server being looked at, not a separate
  // choice. With no server open (home, the server list, users) there is none,
  // and no module applies.
  const currentGame = activeServer ? gameForServer(activeServer) : null;

  // Remembered per game so an old game-scoped link (`/games/<game>/...`) can
  // still land on the server this user last had open for that game. Written
  // straight into storage as one key merged into the stored map, so no write
  // can drop another game's entry.
  useEffect(() => {
    if (!activeServer || !user?.id) return;
    const key = `fleetdeck_active_servers:${user.id}`;
    try {
      const stored = JSON.parse(localStorage.getItem(key) || '{}');
      const map = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
      const game = gameForServer(activeServer);
      if (map[game] !== activeServer.id) localStorage.setItem(key, JSON.stringify({ ...map, [game]: activeServer.id }));
    } catch { /* storage unavailable: old links fall back to the game's first server */ }
  }, [activeServer, user?.id]);

  const mapUrl = activeServer ? (activeServer.mapUrl || '') : '';
  const activeModuleType = activeServer?.type || null;
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
    currentGame,
    mapUrl,
    wsRef,
  }), [
    servers, activeServerId, setActiveServerId, activeServer,
    notifications, pushNotification,
    modules, activeModule, moduleCapabilities, supports,
    currentGame, mapUrl,
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
