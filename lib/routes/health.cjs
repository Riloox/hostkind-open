'use strict';

/*
 * GET  /api/health           - findings, baselines, forecast, backup freshness
 * GET  /api/health/samples   - bounded metric history (the charts read this)
 * PUT  /api/health/settings  - rule thresholds (health.manage)
 *
 * Every route is scoped to a single server the caller is authorized for; there
 * is no cross-server read here, so a grant on one server cannot leak another's
 * metrics.
 */

const express = require('express');
const health = require('../health.cjs');
const audit = require('../audit.cjs');
const { CAPABILITIES, requireCap } = require('../capabilities.cjs');
const { sendError } = require('../httpError.cjs');

const RANGES = { hour: 3600e3, '6h': 6 * 3600e3, day: 24 * 3600e3, week: 7 * 24 * 3600e3 };

module.exports = function healthRouter({ resolveServerId, knownServer }) {
  const router = express.Router();
  const serverId = (req) => resolveServerId(req);
  const scope = { getServerId: serverId };

  const target = (req, res) => {
    const id = serverId(req);
    if (!id || !knownServer(id)) {
      res.status(404).json({ error: 'Server not found.' });
      return null;
    }
    return id;
  };

  router.get('/', requireCap(CAPABILITIES.HEALTH_VIEW, scope), (req, res) => {
    const id = target(req, res);
    if (!id) return;
    res.json(health.summary(id));
  });

  router.get('/samples', requireCap(CAPABILITIES.HEALTH_VIEW, scope), (req, res) => {
    const id = target(req, res);
    if (!id) return;
    const rangeKey = RANGES[req.query.range] ? req.query.range : '6h';
    const points = health.querySamples(id, { since: Date.now() - RANGES[rangeKey] });
    res.json({ serverId: id, range: rangeKey, points });
  });

  router.put('/settings', requireCap(CAPABILITIES.HEALTH_MANAGE, scope), (req, res) => {
    const id = target(req, res);
    if (!id) return;
    try {
      const settings = health.saveSettings(id, req.body || {}, req.user.id);
      audit.record({
        actorId: req.user.id, actorUsername: req.user.username, serverId: id,
        action: 'health.settings.update', targetType: 'health_settings', targetId: id,
        outcome: 'success', requestId: req.requestId, metadata: { settings },
      });
      res.json({ ok: true, settings });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
};
