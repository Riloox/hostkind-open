'use strict';

/*
 * GET    /api/trash              - trash entries plus OS-trash availability and retention
 * POST   /api/trash/:id/restore  - put a trashed payload back where it came from (admin)
 * DELETE /api/trash/:id          - purge a trash entry permanently (admin, explicit only)
 *
 * Thin HTTP layer over lib/trash.cjs. Trashed files stay restorable until
 * their retention expires or someone explicitly purges them; nothing here
 * deletes as a side effect.
 */

const express = require('express');
const trash = require('../trash.cjs');

module.exports = function trashRouter({ requireAdmin, audit, getConfig, sendError }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    res.json({
      ok: true,
      osTrash: trash.detectOsTrash(),
      retentionDays: trash.DEFAULT_RETENTION_DAYS,
      entries: trash.list({ serverId: req.query.serverId || null, kind: req.query.kind || null }),
    });
  });

  router.post('/:id/restore', requireAdmin, (req, res) => {
    try {
      const result = trash.restore(req.params.id, { servers: getConfig().servers });
      audit.record({
        actorId: req.user.id,
        actorUsername: req.user.username,
        serverId: result.entry?.serverId || null,
        action: 'trash.restore',
        targetType: 'trash-entry',
        targetId: req.params.id,
        outcome: 'success',
        requestId: req.requestId,
        metadata: { restoredTo: result.restoredTo },
      });
      res.json(result);
    } catch (error) { sendError(res, error); }
  });

  // Permanent and irreversible, and only ever reached by asking for it directly.
  router.delete('/:id', requireAdmin, (req, res) => {
    try {
      const entry = trash.get(req.params.id);
      const result = trash.purge(req.params.id);
      audit.record({
        actorId: req.user.id,
        actorUsername: req.user.username,
        serverId: entry?.serverId || null,
        action: 'trash.purge',
        targetType: 'trash-entry',
        targetId: req.params.id,
        outcome: 'success',
        requestId: req.requestId,
        metadata: { label: entry?.label || null, permanent: true },
      });
      res.json(result);
    } catch (error) { sendError(res, error); }
  });

  return router;
};
