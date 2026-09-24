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
 *
 * Every reader and mutator takes an optional `visible(n)` predicate. A
 * notification about one server must only be seen, marked, or deleted by a
 * caller who can see that server; the routes pass the caller's filter.
 */

const ALL = () => true;

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

  function list(visible = ALL) {
    return visible === ALL ? items : items.filter(visible);
  }

  function markRead(id, visible = ALL) {
    const n = items.find((x) => x.id === id && visible(x));
    if (!n) return null;
    n.read = true;
    return n;
  }

  function markAllRead(visible = ALL) {
    let count = 0;
    for (const n of items) if (visible(n)) { n.read = true; count += 1; }
    return count;
  }

  function clear(visible = ALL) {
    // In place: readers hold this array by reference.
    for (let i = items.length - 1; i >= 0; i -= 1) if (visible(items[i])) items.splice(i, 1);
  }

  function remove(id, visible = ALL) {
    const idx = items.findIndex((x) => x.id === id && visible(x));
    if (idx === -1) return false;
    items.splice(idx, 1);
    return true;
  }

  return { items, add, list, markRead, markAllRead, clear, remove };
}

module.exports = { createNotificationStore, MAX_NOTIFICATIONS };
