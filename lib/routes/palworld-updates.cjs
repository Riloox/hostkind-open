'use strict';

/*
 * GET  /api/palworld/updates                    - current update status
 * POST /api/palworld/updates/check              - force a Steam metadata refresh, then status
 * POST /api/palworld/updates/preview            - plan an update
 * POST /api/palworld/updates/apply              - start (or replay) an update operation
 * GET  /api/palworld/updates/policy            - read the automatic-update policy
 * PUT  /api/palworld/updates/policy            - write the automatic-update policy
 * GET  /api/valheim/updates                    - current update status
 * POST /api/valheim/updates/check              - force a Steam metadata refresh, then status
 * POST /api/valheim/updates/preview            - plan an update
 * POST /api/valheim/updates/apply              - apply a previewed update
 * POST /api/valheim/updates/:operationId/rollback - roll back an update
 * GET  /api/valheim/updates/policy            - manual-only policy stub
 * PUT  /api/valheim/updates/policy            - manual-only policy stub (409)
 *
 * Mounted at /api with fully-qualified subpaths so the Palworld and Valheim
 * update surfaces share one router: both are SteamCMD-driven update flows
 * with the same target-resolution shape and download plumbing, and keeping
 * them together avoids splitting the shared steamUpdateDeps/palworldLatest
 * helpers (which stay owned by server.js because the automation scheduler
 * also calls them).
 * Thin HTTP layer over lib/palworld-updates.cjs and lib/valheim-install.cjs.
 */

const crypto = require('crypto');
const express = require('express');

module.exports = function palworldUpdatesRouter({
  targetManager,
  findServer,
  palworldUpdates,
  valheimInstall,
  steamUpdateDeps,
  palworldLatest,
  createBackup,
  persistConfig,
  audit,
}) {
  const router = express.Router();

  function palworldUpdateTarget(req, res) {
    const manager = targetManager(req);
    const server = manager && findServer(manager.id);
    if (!manager || !server || server.type !== 'palworld') {
      res.status(404).json({ error: 'Palworld updates are not available for this server.' });
      return null;
    }
    return { server, manager };
  }

  function sendPalworldUpdateError(res, error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code || 'update_failed' });
  }

  router.get('/palworld/updates', async (req, res) => {
    const target = palworldUpdateTarget(req, res);
    if (!target) return;
    try {
      const latest = await palworldLatest(false);
      res.json({ ok: true, update: await palworldUpdates.status({ ...target, latest }) });
    } catch (error) { sendPalworldUpdateError(res, error); }
  });

  router.post('/palworld/updates/check', async (req, res) => {
    const target = palworldUpdateTarget(req, res);
    if (!target) return;
    try {
      const latest = await palworldLatest(true);
      res.json({ ok: true, update: await palworldUpdates.status({ ...target, latest }) });
    } catch (error) { sendPalworldUpdateError(res, error); }
  });

  router.post('/palworld/updates/preview', async (req, res) => {
    const target = palworldUpdateTarget(req, res);
    if (!target) return;
    try {
      const latest = await palworldLatest(false);
      const plan = await palworldUpdates.preview({ ...target, latest, input: req.body || {} });
      res.json({ ok: true, plan });
    } catch (error) { sendPalworldUpdateError(res, error); }
  });

  router.post('/palworld/updates/apply', async (req, res) => {
    const target = palworldUpdateTarget(req, res);
    if (!target) return;
    try {
      const result = await palworldUpdates.apply({
        ...target,
        actorId: req.user.id,
        idempotencyKey: req.get('Idempotency-Key'),
        plan: req.body?.plan,
        planRevision: req.body?.revision,
        ...steamUpdateDeps(),
        announce: async (seconds) => {
          await target.manager.module().request(target.manager, 'POST', '/announce', {
            message: `Server update in ${seconds} seconds. Please move to a safe location.`,
          });
          await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        },
        createBackup: () => createBackup(target.manager, { applyRetention: false }),
      });
      audit.record({
        actorId: req.user.id,
        actorUsername: req.user.username,
        serverId: target.server.id,
        action: 'palworld.update.apply',
        target: { fromBuildId: req.body?.plan?.installedBuildId, toBuildId: req.body?.plan?.targetBuildId },
        outcome: result.replay ? 'replayed' : 'started',
        requestId: req.requestId,
        operationId: result.operation.id,
        metadata: { policy: { restart: req.body?.plan?.restart, backupRequired: req.body?.plan?.backupRequired } },
      });
      res.status(202).json({ ok: true, operationId: result.operation.id, replay: result.replay });
    } catch (error) { sendPalworldUpdateError(res, error); }
  });

  router.get('/palworld/updates/policy', (req, res) => {
    const target = palworldUpdateTarget(req, res);
    if (!target) return;
    res.json({ ok: true, policy: palworldUpdates.safePolicy(target.server.palworldUpdatePolicy) });
  });

  router.put('/palworld/updates/policy', (req, res) => {
    const target = palworldUpdateTarget(req, res);
    if (!target) return;
    target.server.palworldUpdatePolicy = palworldUpdates.safePolicy(req.body);
    persistConfig();
    audit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: target.server.id,
      action: 'palworld.update.policy',
      targetType: 'server',
      targetId: target.server.id,
      outcome: 'success',
      requestId: req.requestId,
      metadata: { policy: target.server.palworldUpdatePolicy },
    });
    res.json({ ok: true, policy: target.server.palworldUpdatePolicy });
  });

  function valheimUpdateTarget(req, res) {
    const manager = targetManager(req);
    const server = manager && findServer(manager.id);
    if (!manager || !server || server.type !== 'valheim') {
      res.status(404).json({ error: 'Valheim updates are not available for this server.' });
      return null;
    }
    return { server, manager };
  }

  async function valheimLatest(force = false) {
    return valheimInstall.discoverAvailable({ ...steamUpdateDeps(), force });
  }

  function sendValheimUpdateError(res, error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code || 'valheim_update_failed' });
  }

  router.get('/valheim/updates', async (req, res) => {
    const target = valheimUpdateTarget(req, res);
    if (!target) return;
    try { res.json({ ok: true, update: valheimInstall.updateStatus({ server: target.server, latest: await valheimLatest(false) }) }); }
    catch (error) { sendValheimUpdateError(res, error); }
  });

  router.post('/valheim/updates/check', async (req, res) => {
    const target = valheimUpdateTarget(req, res);
    if (!target) return;
    try { res.json({ ok: true, update: valheimInstall.updateStatus({ server: target.server, latest: await valheimLatest(true) }) }); }
    catch (error) { sendValheimUpdateError(res, error); }
  });

  router.post('/valheim/updates/preview', async (req, res) => {
    const target = valheimUpdateTarget(req, res);
    if (!target) return;
    try {
      const plan = valheimInstall.createPreview({
        ...target, actorId: req.user.id, latest: await valheimLatest(false), restart: req.body?.restart,
      });
      res.json({ ok: true, plan });
    } catch (error) { sendValheimUpdateError(res, error); }
  });

  router.post('/valheim/updates/apply', async (req, res) => {
    const target = valheimUpdateTarget(req, res);
    if (!target) return;
    try {
      const result = await valheimInstall.applyUpdate({
        ...target,
        actorId: req.user.id,
        previewToken: req.body?.previewToken,
        latest: await valheimLatest(false),
        restart: req.body?.restart !== false,
        options: {
          ...steamUpdateDeps(),
          operationId: req.get('Idempotency-Key') || crypto.randomUUID(),
          idempotencyKey: req.get('Idempotency-Key'),
          saveDescriptor: () => persistConfig(),
        },
      });
      res.json({ ok: true, ...result });
    } catch (error) { sendValheimUpdateError(res, error); }
  });

  router.post('/valheim/updates/:operationId/rollback', async (req, res) => {
    const target = valheimUpdateTarget(req, res);
    if (!target) return;
    try {
      const result = await valheimInstall.rollbackUpdate({
        rollbackId: req.params.operationId,
        ...target,
        restart: req.body?.restart === true,
        saveDescriptor: () => persistConfig(),
      });
      res.json({ ok: true, ...result });
    } catch (error) { sendValheimUpdateError(res, error); }
  });

  router.get('/valheim/updates/policy', (req, res) => {
    if (!valheimUpdateTarget(req, res)) return;
    res.json({ ok: true, policy: { enabled: false, mode: 'manual' } });
  });

  router.put('/valheim/updates/policy', (req, res) => {
    if (!valheimUpdateTarget(req, res)) return;
    res.status(409).json({ error: 'Automatic Valheim updates are not implemented. Manual updates remain available.', code: 'policy_not_implemented' });
  });

  return router;
};
