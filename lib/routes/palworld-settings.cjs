'use strict';

/*
 * GET  /api/palworld/status                   - live Palworld REST status
 * GET  /api/palworld/settings                 - friendly settings editor state
 * POST /api/palworld/settings/preview         - validate a patch, return a preview token
 * PUT  /api/palworld/settings                 - apply a previewed patch
 * GET  /api/palworld/settings/history        - settings snapshot history
 * POST /api/palworld/settings/history/:id/restore - restore a settings snapshot
 *
 * Mounted at /api/palworld, so router paths are relative.
 * Thin HTTP layer over lib/palworld-settings.cjs; the manager/target lookup
 * and translation helpers arrive as injected factory deps so server.js keeps
 * owning the multi-server model.
 */

const express = require('express');

module.exports = function palworldSettingsRouter({ targetManager, tErr, settings }) {
  const router = express.Router();

  function palworldSettingsTarget(req, res) {
    const manager = targetManager(req);
    if (!manager) {
      res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
      return null;
    }
    return { id: manager.id, dir: manager.dir(), manager };
  }

  function sendPalworldSettingsError(res, error) {
    const status = Number(error?.status) || 500;
    res.status(status).json({ error: error?.message || 'Palworld settings request failed.', code: error?.code || 'settings_error' });
  }

  router.get('/status', async (req, res) => {
    const manager = targetManager(req);
    if (!manager) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    try {
      await manager.module().refresh(manager);
      res.json({ ok: true, status: manager.statusPayload() });
    } catch {
      res.status(503).json({ error: 'Palworld REST API is unavailable.' });
    }
  });

  router.get('/settings', (req, res) => {
    const server = palworldSettingsTarget(req, res);
    if (!server) return;
    try {
      const result = settings.read(server);
      result.restartRequired = !!server.manager.moduleState?.settingsRestartRequired;
      res.json(result);
    } catch (error) {
      sendPalworldSettingsError(res, error);
    }
  });

  router.post('/settings/preview', (req, res) => {
    const server = palworldSettingsTarget(req, res);
    if (!server) return;
    try {
      const result = settings.preview(server, req.user.id, req.body || {});
      res.status(result.ok ? 200 : 422).json(result);
    } catch (error) {
      sendPalworldSettingsError(res, error);
    }
  });

  router.put('/settings', (req, res) => {
    const server = palworldSettingsTarget(req, res);
    if (!server) return;
    try {
      const result = settings.apply(server, req.user.id, req.body || {}, req.get('Idempotency-Key'));
      if (result.restartRequired) server.manager.moduleState.settingsRestartRequired = true;
      res.json(result);
    } catch (error) {
      sendPalworldSettingsError(res, error);
    }
  });

  router.get('/settings/history', (req, res) => {
    const server = palworldSettingsTarget(req, res);
    if (!server) return;
    try {
      res.json({ ok: true, history: settings.history(server) });
    } catch (error) {
      sendPalworldSettingsError(res, error);
    }
  });

  router.post('/settings/history/:id/restore', (req, res) => {
    const server = palworldSettingsTarget(req, res);
    if (!server) return;
    try {
      const result = settings.restore(server, req.params.id);
      server.manager.moduleState.settingsRestartRequired = true;
      res.json(result);
    } catch (error) {
      sendPalworldSettingsError(res, error);
    }
  });

  return router;
};
