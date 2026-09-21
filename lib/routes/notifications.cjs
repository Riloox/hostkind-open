'use strict';

/*
 * GET    /api/notifications        - list all notifications (newest first)
 * POST   /api/notifications/read-all - mark every notification read
 * POST   /api/notifications/clear  - delete every notification
 * POST   /api/notifications/:id/read - mark one notification read
 * DELETE /api/notifications/:id    - delete one notification
 *
 * Mounted at /api/notifications, so router paths are relative.
 * Single-segment actions (read-all, clear) are registered before the
 * :id routes so they can never be shadowed by a parameter match.
 */

const express = require('express');

module.exports = function notificationsRouter({ store }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({ notifications: store.list() });
  });

  router.post('/read-all', (req, res) => {
    store.markAllRead();
    res.json({ ok: true });
  });

  router.post('/clear', (req, res) => {
    store.clear();
    res.json({ ok: true });
  });

  router.post('/:id/read', (req, res) => {
    const n = store.markRead(req.params.id);
    if (!n) return res.status(404).json({ error: 'Notification not found' });
    res.json({ ok: true });
  });

  router.delete('/:id', (req, res) => {
    const removed = store.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Notification not found' });
    res.json({ ok: true });
  });

  return router;
};
