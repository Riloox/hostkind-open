'use strict';

/*
 * GET  /api/crashes                        - paged crash groups (query: cursor, serverId, acknowledged, from, to)
 * GET  /api/crashes/:id                    - one crash group with latest incident, conclusions, backup context
 * POST /api/crashes/groups/:id/acknowledge   - mark a group acknowledged
 * POST /api/crashes/groups/:id/unacknowledge - clear a group acknowledgement
 *
 * Thin HTTP layer over lib/crashes.cjs. Authz rides the /api capability gate
 * in server.js (HEALTH_VIEW for GET, HEALTH_MANAGE otherwise), so no guard is
 * applied here; the active-server fallback comes in via getActiveServerId.
 */

const express = require('express');
const crashIntelligence = require('../crashes.cjs');

module.exports = function crashesRouter({ getActiveServerId }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const acknowledged = req.query.acknowledged === 'true' ? true : req.query.acknowledged === 'false' ? false : undefined;
    const data = crashIntelligence.list({ cursor: Number(req.query.cursor) || undefined, serverId: req.query.serverId || getActiveServerId(), acknowledged, from: Number(req.query.from) || undefined, to: Number(req.query.to) || undefined });
    res.json(data);
  });

  router.get('/:id', (req, res) => {
    const item = crashIntelligence.detail(req.params.id);
    if (!item) return res.status(404).json({ error: 'Crash group not found.' });
    res.json(item);
  });

  for (const [suffix, value] of [['acknowledge', true], ['unacknowledge', false]]) {
    router.post(`/groups/:id/${suffix}`, (req, res) => {
      const result = crashIntelligence.acknowledge(req.params.id, req.user.id, value);
      if (!result) return res.status(404).json({ error: 'Crash group not found.' });
      res.json({ ok: true, ...result });
    });
  }

  return router;
};
