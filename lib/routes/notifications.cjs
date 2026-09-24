'use strict';

/*
 * GET    /api/notifications        - list visible notifications (newest first)
 * POST   /api/notifications/read-all - mark every visible notification read
 * POST   /api/notifications/clear  - delete every visible notification
 * POST   /api/notifications/:id/read - mark one notification read
 * DELETE /api/notifications/:id    - delete one notification
 *
 * Mounted at /api/notifications, so router paths are relative.
 * Single-segment actions (read-all, clear) are registered before the
 * :id routes so they can never be shadowed by a parameter match.
 */

const express = require('express');

module.exports = function notificationsRouter({ store, canSee = () => true }) {
  const router = express.Router();
  // A panel-wide notification (no serverId) is visible to every principal; a
  // server's notification only to callers who can see that server.
  const visibleTo = (req) => (n) => canSee(req.user, n);

  router.get('/', (req, res) => {
    res.json({ notifications: store.list(visibleTo(req)) });
  });

  router.post('/read-all', (req, res) => {
    store.markAllRead(visibleTo(req));
    res.json({ ok: true });
  });

  router.post('/clear', (req, res) => {
    store.clear(visibleTo(req));
    res.json({ ok: true });
  });

  router.post('/:id/read', (req, res) => {
    const n = store.markRead(req.params.id, visibleTo(req));
    if (!n) return res.status(404).json({ error: 'Notification not found' });
    res.json({ ok: true });
  });

  router.delete('/:id', (req, res) => {
    const removed = store.remove(req.params.id, visibleTo(req));
    if (!removed) return res.status(404).json({ error: 'Notification not found' });
    res.json({ ok: true });
  });

  return router;
};
