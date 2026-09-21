import { createContext, useContext, useState, useCallback, useMemo } from 'react';

// Split out of ServerContext so the high-frequency updateStatus tick (every WS
// status frame) owns its own provider. Consumers that only need the server
// list / modules / selection can use useServerList() and never re-render on
// status ticks; status readers use useStatus(). ServerContext re-exports this
// module, so existing `useServer` imports keep working unchanged.
const StatusContext = createContext(null);

export function StatusProvider({ children }) {
  const [statuses, setStatuses] = useState({});

  const updateStatus = useCallback((status) => {
    if (!status || !status.serverId) return;
    setStatuses((prev) => ({ ...prev, [status.serverId]: status }));
  }, []);

  const getServerStatus = useCallback((serverId) => {
    return statuses[serverId] || { status: 'offline', playerCount: 0, maxPlayers: 0 };
  }, [statuses]);

  const value = useMemo(
    () => ({ statuses, updateStatus, getServerStatus }),
    [statuses, updateStatus, getServerStatus],
  );

  return <StatusContext.Provider value={value}>{children}</StatusContext.Provider>;
}

export function useStatus() {
  const ctx = useContext(StatusContext);
  if (!ctx) throw new Error('useStatus must be used within a StatusProvider');
  return ctx;
}
