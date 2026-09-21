'use strict';

/*
 * /api/terraria players + config surface (docs/terraria/02-configuration.md).
 *
 * Mounted at /api/terraria, so router paths are relative. The prefix guards
 * above (requireTerrariaServer + console capability) already ran before this
 * router, matching the previous inline order.
 *
 *   GET    /versions                    installable builds for one variant
 *   GET    /players                     vanilla console roster
 *   POST   /players/:action             vanilla console player action
 *   GET    /config                      parsed serverconfig.txt
 *   POST   /config/preview              validate config edits
 *   PUT    /config                      apply config edits
 *   GET    /config/raw                  raw file contents
 *   PUT    /config/raw                  write raw file contents
 *   GET    /config/history              config revision history
 *   POST   /config/history/:id/restore  restore a config revision
 *
 * The import endpoints and the worlds/mods/tshock routers live elsewhere;
 * nothing here may shadow them.
 */

const express = require('express');
const terrariaVariants = require('../modules/terraria/variants.cjs');
const terrariaInstall = require('../terraria-install.cjs');
const terrariaConfig = require('../terraria-config.cjs');
const audit = require('../audit.cjs');

module.exports = function terrariaConfigRouter({ targetManager }) {
  const router = express.Router();

  function sendTerrariaError(res, error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code || 'terraria_error' });
  }

  function terrariaPlayersTarget(req, res) {
    const manager = targetManager(req);
    const desc = manager && manager.desc();
    if (!manager || !desc || desc.type !== 'terraria') {
      res.status(404).json({ error: 'Terraria players are not available for this server.', code: 'not_supported' });
      return null;
    }
    // TShock has its own REST-backed player surface and must not be mixed with
    // the vanilla console roster or its action semantics.
    if (String(desc.terrariaVariant || '').toLowerCase() === 'tshock') {
      res.status(404).json({ error: 'Use the TShock player surface for this server.', code: 'not_supported' });
      return null;
    }
    return manager;
  }

  function terrariaConfigTarget(req, res) {
    const manager = targetManager(req);
    const desc = manager && manager.desc();
    if (!manager || !desc || desc.type !== 'terraria') {
      res.status(404).json({ error: 'Terraria configuration is not available for this server.' });
      return null;
    }
    return { id: manager.id, dir: manager.dir(), desc, manager };
  }

  function sendTerrariaConfigError(res, error) {
    const payload = {
      error: error?.message || 'Terraria configuration request failed.',
      code: error?.code || 'terraria_config_error',
    };
    if (error?.key) payload.key = error.key;
    res.status(Number(error?.status) || 500).json(payload);
  }

  /*
   * The installable builds of one Terraria variant, resolved from upstream at
   * request time (docs/terraria/01-installation-versions.md).
   *
   * Unsupported entries stay in the response with the reason they cannot be
   * installed here - the wizard disables them visibly rather than hiding them,
   * because "TShock has no arm64 build" is an answer and an empty list is not.
   * `force=1` is the "check again" button; without it the ten-minute cache
   * answers.
   */
  router.get('/versions', async (req, res) => {
    const variant = String(req.query.variant || 'vanilla').toLowerCase();
    if (!terrariaVariants.isVariant(variant)) {
      return res.status(400).json({ error: `Unknown Terraria variant: ${variant}`, code: 'unknown_variant' });
    }
    try {
      const list = await terrariaInstall.listVersions(variant, { force: req.query.force === '1' || req.query.force === 'true' });
      res.json({ ok: true, ...list });
    } catch (error) {
      sendTerrariaError(res, error);
    }
  });

  router.get('/players', (req, res) => {
    const manager = terrariaPlayersTarget(req, res);
    if (!manager) return;
    try {
      const terraria = manager.module();
      const fields = terraria.statusFields(manager);
      const players = typeof terraria.listPlayers === 'function' ? terraria.listPlayers(manager) : [];
      res.json({
        ok: true,
        players: players.map((player) => ({ ...player, characterImage: null })),
        maxPlayers: Number(fields.maxPlayers) || 0,
        source: 'console',
        characterImageAvailable: false,
      });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message, code: error.code || 'invalid_action' });
    }
  });

  router.post('/players/:action', (req, res) => {
    const manager = terrariaPlayersTarget(req, res);
    if (!manager) return;
    const target = req.body?.target;
    try {
      const result = manager.module().playerAction(manager, req.params.action, target);
      res.json(result);
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message, code: error.code || 'invalid_action' });
    }
  });

  router.get('/config', (req, res) => {
    const server = terrariaConfigTarget(req, res);
    if (!server) return;
    try {
      const result = terrariaConfig.read(server);
      result.restartRequired = !!server.manager.moduleState?.configRestartRequired;
      res.json(result);
    } catch (error) { sendTerrariaConfigError(res, error); }
  });

  router.post('/config/preview', (req, res) => {
    const server = terrariaConfigTarget(req, res);
    if (!server) return;
    try { res.json(terrariaConfig.preview(server, req.user.id, req.body || {})); }
    catch (error) { sendTerrariaConfigError(res, error); }
  });

  router.put('/config', (req, res) => {
    const server = terrariaConfigTarget(req, res);
    if (!server) return;
    try {
      const result = terrariaConfig.apply(server, req.user.id, req.body || {}, req.get('Idempotency-Key'));
      if (result.restartRequired) (server.manager.moduleState ||= {}).configRestartRequired = true;
      audit.record({
        actorId: req.user.id, actorUsername: req.user.username, serverId: server.id,
        action: 'configs.edit', targetType: 'terraria-config', outcome: 'success',
        metadata: { changedKeys: [] },
      });
      res.json(result);
    } catch (error) { sendTerrariaConfigError(res, error); }
  });

  router.get('/config/raw', (req, res) => {
    const server = terrariaConfigTarget(req, res);
    if (!server) return;
    try { res.json(terrariaConfig.readRaw(server, String(req.query.file || ''))); }
    catch (error) { sendTerrariaConfigError(res, error); }
  });

  router.put('/config/raw', (req, res) => {
    const server = terrariaConfigTarget(req, res);
    if (!server) return;
    try {
      const result = terrariaConfig.writeRaw(server, req.user.id, req.body || {});
      if (result.restartRequired) (server.manager.moduleState ||= {}).configRestartRequired = true;
      audit.record({
        actorId: req.user.id, actorUsername: req.user.username, serverId: server.id,
        action: 'configs.edit', targetType: 'terraria-config-raw',
        targetId: String(req.body?.file || ''), outcome: 'success',
      });
      res.json(result);
    } catch (error) { sendTerrariaConfigError(res, error); }
  });

  router.get('/config/history', (req, res) => {
    const server = terrariaConfigTarget(req, res);
    if (!server) return;
    try { res.json({ ok: true, history: terrariaConfig.history(server) }); }
    catch (error) { sendTerrariaConfigError(res, error); }
  });

  router.post('/config/history/:id/restore', (req, res) => {
    const server = terrariaConfigTarget(req, res);
    if (!server) return;
    try {
      const result = terrariaConfig.restore(server, req.params.id);
      (server.manager.moduleState ||= {}).configRestartRequired = true;
      audit.record({
        actorId: req.user.id, actorUsername: req.user.username, serverId: server.id,
        action: 'configs.restore', targetType: 'terraria-config',
        targetId: req.params.id, outcome: 'success',
      });
      res.json(result);
    } catch (error) { sendTerrariaConfigError(res, error); }
  });

  return router;
};
