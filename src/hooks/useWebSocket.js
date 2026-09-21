import { useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useServer } from '@/context/ServerContext';

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 30;

export function useWebSocket({ onLine, onHistory, onStatus, onStats, onServer, onNotification, onConnChange } = {}) {
  const { token, authDisabled } = useAuth();
  const { updateStatus, activeServerId, setServers, setNotifications, pushNotification, wsRef } = useServer();
  const reconnectTimer = useRef(null);
  const mountedRef = useRef(true);
  const attemptRef = useRef(0);
  // Last serverId actually sent on the *current* connection. Reset on close so
  // a fresh socket re-selects exactly once; guards the onopen send and the
  // activeServerId effect below from double-sending on the same socket.
  const lastSelectedRef = useRef(null);
  // The connect closure must see the current server without re-subscribing the
  // whole socket every time the user switches servers.
  const serverIdRef = useRef(activeServerId);
  serverIdRef.current = activeServerId;

  // Keep latest callbacks in refs so the WS handler always calls current version
  const callbacksRef = useRef({ onLine, onHistory, onStatus, onStats, onServer, onNotification, onConnChange });
  useEffect(() => {
    callbacksRef.current = { onLine, onHistory, onStatus, onStats, onServer, onNotification, onConnChange };
  });

  const sendMessage = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      if (msg?.type === 'selectServer' && msg.serverId != null) {
        lastSelectedRef.current = msg.serverId;
      }
    }
  }, [wsRef]);

  // Deduped select: at most one selectServer per connection per serverId.
  const sendSelect = useCallback((serverId) => {
    const ws = wsRef.current;
    if (!serverId || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (lastSelectedRef.current === serverId) return;
    ws.send(JSON.stringify({ type: 'selectServer', serverId }));
    lastSelectedRef.current = serverId;
  }, [wsRef]);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current) return;
    if (attemptRef.current >= MAX_RECONNECT_ATTEMPTS) return;
    const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attemptRef.current);
    const jitter = Math.random() * 1000;
    const delay = Math.min(MAX_DELAY_MS, backoff + jitter);
    attemptRef.current += 1;
    clearTimeout(reconnectTimer.current);
    reconnectTimer.current = setTimeout(connect, delay); // eslint-disable-line no-use-before-define
  }, []);

  function connect() {
    if (!mountedRef.current) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    const ws = new WebSocket(`${proto}://${location.host}/ws${query}`);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      attemptRef.current = 0;
      callbacksRef.current.onConnChange?.('ok');
      sendSelect(serverIdRef.current);
    };

    ws.onmessage = (ev) => {
      if (!mountedRef.current) return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'history') {
        callbacksRef.current.onHistory?.(msg);
      } else if (msg.type === 'line') {
        callbacksRef.current.onLine?.(msg);
      } else if (msg.type === 'status') {
        updateStatus(msg.status);
        callbacksRef.current.onStatus?.(msg.status);
      } else if (msg.type === 'stats') {
        callbacksRef.current.onStats?.(msg.stats);
      } else if (msg.type === 'server' && msg.server) {
        // Server metadata (name, dir, mapUrl, ...) changed on another
        // client or in the backend. Merge it into the local list so
        // derived state (active server, mapUrl) updates without a refetch.
        setServers((prev) => prev.map((s) => s.id === msg.server.id ? { ...s, ...msg.server } : s));
        callbacksRef.current.onServer?.(msg.server);
      } else if (msg.type === 'notifications') {
        // Full list sent once on connect.
        setNotifications(Array.isArray(msg.notifications) ? msg.notifications : []);
      } else if (msg.type === 'notification' && msg.notification) {
        // A single new notification pushed live.
        pushNotification(msg.notification);
        callbacksRef.current.onNotification?.(msg.notification);
      }
    };

    ws.onerror = () => {
      if (!mountedRef.current) return;
      callbacksRef.current.onConnChange?.('bad');
      // Funnel through onclose so backoff state lives in exactly one place.
      try { ws.close(); } catch {}
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      lastSelectedRef.current = null;
      callbacksRef.current.onConnChange?.('bad');
      if (token || authDisabled) {
        scheduleReconnect();
      }
    };
  }

  useEffect(() => {
    mountedRef.current = true;
    attemptRef.current = 0;
    lastSelectedRef.current = null;
    // No token is needed while sign-in is off: the server upgrades the socket
    // as the guest session.
    if (!token && !authDisabled) return;

    connect();

    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectTimer.current);
      if (wsRef.current) {
        try { wsRef.current.close(); } catch {}
        wsRef.current = null;
      }
    };
  }, [token, authDisabled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeServerId) sendSelect(activeServerId);
  }, [activeServerId, sendSelect]);

  return { sendMessage };
}
