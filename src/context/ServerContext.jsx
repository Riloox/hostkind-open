import { createContext, useContext, useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { useAuth } from '@/context/AuthContext';
import { gameForServer } from '@/lib/games';

const ServerContext = createContext(null);

export function ServerProvider({ children }) {
  const { user } = useAuth();
  const [servers, setServers] = useState([]);
  const [activeServerId, setActiveServerIdState] = useState(null);
  const [statuses, setStatuses] = useState({});
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

  const updateStatus = useCallback((status) => {
    setStatuses(prev => ({ ...prev, [status.serverId]: status }));
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

  const getServerStatus = useCallback((serverId) => {
    return statuses[serverId] || { status: 'offline', playerCount: 0, maxPlayers: 0 };
  }, [statuses]);

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

  return (
    <ServerContext.Provider value={{
      servers, setServers,
      activeServerId, setActiveServerId,
      activeServer,
      statuses, updateStatus, getServerStatus,
      notifications, setNotifications, pushNotification,
      modules, setModules, activeModule, moduleCapabilities, supports,
      currentGame, setCurrentGame, activeServerByGame,
      mapUrl,
      wsRef,
    }}>
      {children}
    </ServerContext.Provider>
  );
}

export function useServer() {
  return useContext(ServerContext);
}
