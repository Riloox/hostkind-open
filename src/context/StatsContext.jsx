import { createContext, useContext, useCallback, useMemo, useRef } from 'react';

// Replaces the window.__dashOnStats global bridge (App.jsx onStats callback ->
// DashboardView listener). A tiny emitter instead of state: WS stats ticks are
// frequent, and state would re-render every provider descendant on each tick.
// Listeners only fire while subscribed, so ticks update the dashboard only when
// it is mounted (and active).
const StatsContext = createContext(null);

export function StatsProvider({ children }) {
  const listenersRef = useRef(new Set());
  const latestRef = useRef(null);

  const publishStats = useCallback((stats) => {
    if (!stats) return;
    latestRef.current = stats;
    listenersRef.current.forEach((listener) => {
      try { listener(stats); } catch {}
    });
  }, []);

  const subscribe = useCallback((listener) => {
    if (typeof listener !== 'function') return () => {};
    listenersRef.current.add(listener);
    return () => { listenersRef.current.delete(listener); };
  }, []);

  const getLatest = useCallback(() => latestRef.current, []);

  const value = useMemo(
    () => ({ publishStats, subscribe, getLatest }),
    [publishStats, subscribe, getLatest],
  );

  return <StatsContext.Provider value={value}>{children}</StatsContext.Provider>;
}

export function useStats() {
  const ctx = useContext(StatsContext);
  if (!ctx) throw new Error('useStats must be used within a StatsProvider');
  return ctx;
}
