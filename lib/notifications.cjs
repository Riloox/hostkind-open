'use strict';

/*
 * Notification store — in-memory, panel-scoped (not per-server).
 *
 * Owns the notification list so server.js stays a thin wiring layer:
 * server.js creates one store, passes a broadcast hook (WebSocket fan-out),
 * and mounts the HTTP routes from lib/routes/notifications.cjs.
 *
 * The live `items` array is exposed by reference so existing readers that
 * hold the array (e.g. the WS handshake snapshot) keep seeing updates.
 */

const MAX_NOTIFICATIONS = 200;

function defaultGenId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createNotificationStore({ broadcast = () => {}, genId = defaultGenId } = {}) {
  const items = [];

  function add(type, title, message, serverId, i18nMeta = {}) {
    const n = {
      id: genId(),
      type,
      title,
      message,
      ...i18nMeta,
      serverId: serverId || null,
      read: false,
      timestamp: Date.now(),
    };
    items.unshift(n);
    if (items.length > MAX_NOTIFICATIONS) items.pop();
    broadcast(n);
    return n;
  }

  function list() {
    return items;
  }

  function markRead(id) {
    const n = items.find((x) => x.id === id);
    if (!n) return null;
    n.read = true;
    return n;
  }

  function markAllRead() {
    for (const n of items) n.read = true;
    return items.length;
  }

  function clear() {
    items.length = 0;
  }

  function remove(id) {
    const idx = items.findIndex((x) => x.id === id);
    if (idx === -1) return false;
    items.splice(idx, 1);
    return true;
  }

  return { items, add, list, markRead, markAllRead, clear, remove };
}

module.exports = { createNotificationStore, MAX_NOTIFICATIONS };
