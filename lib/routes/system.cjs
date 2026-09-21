'use strict';

/*
 * GET /api/metrics - bounded metric history for one server (charts read this)
 * GET /api/system  - point-in-time system snapshot (the stream goes over WS)
 *
 * Mounted at /api, so router paths are relative (/metrics, /system).
 * The panel config object is replaced on save, so the active server id is
 * read through a getter instead of a captured reference.
 */

const express = require('express');

module.exports = function systemRouter({ targetManager, systemStats, getActiveServerId, health, moduleGate, log, ranges }) {
  const router = express.Router();

  // Same contract as before (t/cpu/mem/players/world per point), now served from
  // SQLite with a bounded time window and page size. The response carries the
  // extra columns (tps, disk) too; older clients simply ignore them.
  router.get('/metrics', (req, res) => {
    const id = (req.query.serverId) || getActiveServerId();
    const rangeKey = ranges[req.query.range] ? req.query.range : '6h';
    if (!id) return res.json({ serverId: id, range: rangeKey, points: [] });
    try {
      let points = health.querySamples(id, { since: Date.now() - ranges[rangeKey] });
      if (!moduleGate.supports(req, 'players')) {
        points = points.map(({ players, world, tps, ...point }) => point);
      }
      return res.json({ serverId: id, range: rangeKey, points });
    } catch (err) {
      log('metrics query failed:', err.message);
      return res.status(503).json({ error: 'Metrics history is unavailable.' });
    }
  });

  // Point-in-time snapshot; the live stream goes over WS.
  router.get('/system', async (req, res) => {
    res.json(await systemStats(targetManager(req)));
  });

  return router;
};
