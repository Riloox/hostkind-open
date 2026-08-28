'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { manifestFromServer, validateManifest } = require('../server-manifest.cjs');
const { buildReport } = require('../restore-drill.cjs');
const { scoreModule, selectDeepSupport } = require('../lifecycle-scorecard.cjs');
const { sanitizeEvent } = require('../product-validation.cjs');

function errorStatus(error, fallback = 400) {
  return Number.isInteger(error && error.status) ? error.status : fallback;
}

const pairingConsumeLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
});

function createProductRouter({ findServer, listModules, store } = {}) {
  if (typeof findServer !== 'function') throw new TypeError('product router requires findServer');
  if (typeof listModules !== 'function') throw new TypeError('product router requires listModules');
  if (!store || typeof store.listTargets !== 'function') throw new TypeError('product router requires store');

  const router = express.Router();

  router.get('/manifest/:serverId', (req, res) => {
    const server = findServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'server_not_found' });
    const manifest = manifestFromServer(server);
    store.recordEvent({ type: 'manifest_exported', serverId: server.id, game: server.type, source: 'api', occurredAt: manifest.createdAt });
    return res.json({ manifest });
  });

  router.post('/manifest/validate', (req, res) => {
    const result = validateManifest(req.body && req.body.manifest ? req.body.manifest : req.body);
    return res.status(result.ok ? 200 : 400).json(result);
  });

  router.get('/lifecycle', (req, res) => {
    const entries = (listModules() || []).map((entry) => {
      if (entry && entry.module) return entry;
      return { id: entry && entry.id, module: entry, descriptor: {} };
    });
    const modules = entries.map((entry) => entry.module).filter(Boolean);
    const ids = entries.map((entry) => entry.id || (entry.module && entry.module.id)).filter(Boolean);
    const descriptorById = Object.fromEntries(entries.map((entry) => [entry.id || (entry.module && entry.module.id), entry.descriptor || {}]));
    const scorecards = selectDeepSupport(modules, ids, descriptorById);
    return res.json({ scorecards });
  });

  router.get('/byoc/targets', (req, res) => res.json({ targets: store.listTargets() }));

  router.post('/byoc/targets', (req, res) => {
    try {
      const target = store.createTarget(req.body || {});
      return res.status(201).json({ target });
    } catch (error) {
      return res.status(errorStatus(error)).json({ error: error.code || 'invalid_target', message: error.message });
    }
  });

  router.patch('/byoc/targets/:id', (req, res) => {
    try {
      const target = store.updateTarget(req.params.id, req.body && req.body.status);
      if (!target) return res.status(404).json({ error: 'target_not_found' });
      return res.json({ target });
    } catch (error) {
      return res.status(errorStatus(error)).json({ error: error.code || 'invalid_target_status', message: error.message });
    }
  });

  router.post('/pairing/challenges', (req, res) => {
    try {
      const challenge = store.createPairing({
        targetId: req.body && req.body.targetId,
        actorId: req.user && (req.user.id || req.user.userId),
      });
      return res.status(201).json({ challenge });
    } catch (error) {
      return res.status(errorStatus(error)).json({ error: error.code || 'pairing_create_failed', message: error.message });
    }
  });

  router.post('/pairing/consume', pairingConsumeLimit, (req, res) => {
    const result = store.consumePairing({
      id: req.body && req.body.id,
      token: req.body && req.body.token,
    });
    if (!result || !result.ok) {
      const status = result && (result.code === 'expired' || result.code === 'already_used') ? 410
        : result && result.code === 'too_many_attempts' ? 429 : 401;
      return res.status(status).json({ error: (result && result.code) || 'pairing_failed' });
    }
    return res.json({ pairing: result });
  });

  router.post('/restore-drills', (req, res) => {
    try {
      const report = buildReport(req.body || {});
      const stored = store.recordRestoreDrill(report);
      return res.status(report.status === 'succeeded' ? 201 : 409).json({ report: stored });
    } catch (error) {
      return res.status(errorStatus(error)).json({ error: error.code || 'invalid_restore_drill', message: error.message });
    }
  });

  router.get('/restore-drills/latest', (req, res) => {
    const report = store.latestRestoreDrill();
    if (!report) return res.status(404).json({ error: 'restore_drill_not_found' });
    return res.json({ report });
  });

  router.post('/events', (req, res) => {
    const event = sanitizeEvent(req.body || {});
    if (!event.type) return res.status(400).json({ error: 'invalid_event' });
    try {
      return res.status(201).json({ event: store.recordEvent(event) });
    } catch (error) {
      return res.status(errorStatus(error)).json({ error: error.code || 'invalid_event', message: error.message });
    }
  });

  router.get('/summary', (req, res) => {
    const from = req.query.from === undefined ? undefined : Number(req.query.from);
    const to = req.query.to === undefined ? undefined : Number(req.query.to);
    return res.json({ summary: store.summaryEvents({ from, to }) });
  });

  return router;
}

module.exports = createProductRouter;
module.exports.scoreModule = scoreModule;
