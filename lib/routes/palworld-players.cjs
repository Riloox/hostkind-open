'use strict';

/*
 * Palworld live-player surface: player list, kick/ban/unban, the live map,
 * announcements and saves, plus the legacy :action compatibility shim.
 *
 * GET  /api/palworld/players                - live player list + REST health
 * GET  /api/palworld/map                    - map state with projected player markers
 * GET  /api/palworld/map/asset              - map image asset stream
 * PUT  /api/palworld/map/calibration        - preview/apply/reset/restore calibration
 * POST /api/palworld/players/:userId/kick   - kick an online player
 * POST /api/palworld/players/:userId/ban    - ban an online player
 * POST /api/palworld/players/unban          - unban by user id
 * POST /api/palworld/announcements          - broadcast an announcement
 * POST /api/palworld/save                   - trigger a world save
 * POST /api/palworld/:action                - legacy kick|ban|unban|announce|save shim
 *
 * Mounted at /api/palworld, so router paths are relative.
 * One file (not a players/map split) because GET /map embeds the player-list
 * projection and every POST mutation shares the same private pipeline
 * (palworldMutationContext / applyPalworldMutation / playerMutation /
 * auditPalworldMutation); splitting would duplicate that pipeline or force
 * cross-router imports. The map asset/calibration engine itself stays in
 * lib/palworld-map.cjs; this router is a thin HTTP layer over it, over
 * lib/palworld-operations.cjs, and over the manager's Palworld module.
 * Rate-limiter instances, the replay store and the capability/audit singletons
 * arrive as injected factory deps so server.js keeps owning them.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function palworldPlayersRouter({
  targetManager,
  tErr,
  CAPABILITIES,
  foundationCapabilities,
  audit,
  persistConfig,
  log,
  palworldMap,
  palworldOperations,
  palworldReplays,
  limitPalworldPlayers,
  limitPalworldAnnouncements,
}) {
  const router = express.Router();

  router.get('/players', async (req, res) => {
    const manager = targetManager(req);
    if (!manager) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    try {
      await manager.module().refresh(manager);
      const health = manager.moduleState.restHealth;
      if (health?.state !== 'healthy') {
        return res.status(503).json({ error: 'Palworld REST API is unavailable.', restHealth: health });
      }
      const status = manager.statusPayload();
      res.json({
        ok: true,
        players: manager.module().listPlayers(manager),
        playerCount: status.playerCount || 0,
        maxPlayers: status.maxPlayers || 0,
        sampledAt: status.sampledAt || null,
        restHealth: health,
      });
    } catch (_) {
      res.status(503).json({ error: 'Palworld REST API is unavailable.' });
    }
  });

  router.get('/map', async (req, res) => {
    const manager = targetManager(req);
    if (!manager) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    if (manager.desc().type !== 'palworld') return res.status(409).json({ error: 'This server is not a Palworld server.' });
    if (!foundationCapabilities.has(req.user, manager.id, CAPABILITIES.PLAYERS_VIEW)) {
      return res.status(403).json({ error: tErr(req.user, 'errors.forbidden'), capability: CAPABILITIES.PLAYERS_VIEW });
    }
    await manager.module().refresh(manager).catch(() => {});
    const map = palworldMap.publicState(manager.desc());
    const health = manager.moduleState.restHealth;
    const healthy = health?.state === 'healthy';
    res.json({
      ok: true,
      ...map,
      restHealth: health,
      sampledAt: manager.statusPayload().sampledAt || null,
      players: (manager.module().listPlayers(manager) || []).map((player) => ({
        ...player,
        mapPosition: palworldMap.project(player.location, map.calibration),
        mapGrid: palworldMap.grid(player.location),
        state: healthy ? 'live' : 'stale',
      })).concat(healthy ? (manager.module().listDepartedPlayers?.(manager) || []).map((player) => ({
        ...player,
        mapPosition: palworldMap.project(player.location, map.calibration),
        mapGrid: palworldMap.grid(player.location),
        state: 'offline',
      })) : []),
    });
  });

  router.get('/map/asset', (req, res) => {
    const manager = targetManager(req);
    if (manager && manager.desc().type !== 'palworld') return res.status(409).json({ error: 'This server is not a Palworld server.' });
    const asset = manager ? palworldMap.assetFile(manager.desc()) : null;
    if (!asset) return res.status(404).json({ error: 'Map asset not found.' });
    const resolved = path.resolve(asset.file);
    if (!asset.builtin) {
      const allowed = path.resolve(manager.dir(), '.fleetdeck', 'palworld-map') + path.sep;
      if (!resolved.startsWith(allowed)) return res.status(404).json({ error: 'Map asset not found.' });
    }
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Map asset not found.' });
    res.type(asset.mediaType).sendFile(resolved);
  });

  router.put('/map/calibration', (req, res) => {
    const manager = targetManager(req);
    if (!manager) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    if (req.user.role !== 'admin') return res.status(403).json({ error: tErr(req.user, 'errors.forbidden') });
    if (manager.desc().type !== 'palworld') return res.status(409).json({ error: 'This server is not a Palworld server.' });
    try {
      if (req.body?.restoreRevision) {
        const result = palworldMap.restore(manager.desc(), req.body.restoreRevision);
        persistConfig();
        audit.record({
          actorId: req.user.id, actorUsername: req.user.username, serverId: manager.id,
          action: 'palworld.map.restore', targetType: 'server', targetId: manager.id,
          outcome: 'success', requestId: req.requestId, metadata: { revision: result.revision },
        });
        return res.json({ ok: true, ...result });
      }
      if (req.body?.resetToDefault) {
        const result = palworldMap.resetToDefault(manager.desc());
        persistConfig();
        audit.record({
          actorId: req.user.id, actorUsername: req.user.username, serverId: manager.id,
          action: 'palworld.map.reset', targetType: 'server', targetId: manager.id,
          outcome: 'success', requestId: req.requestId, metadata: { revision: result.revision },
        });
        return res.json({ ok: true, ...result });
      }
      const result = req.body?.preview
        ? palworldMap.preview(manager.desc(), req.body)
        : palworldMap.apply(manager.desc(), req.body);
      if (!req.body?.preview) persistConfig();
      if (!req.body?.preview) audit.record({
        actorId: req.user.id, actorUsername: req.user.username, serverId: manager.id,
        action: 'palworld.map.calibrate', targetType: 'server', targetId: manager.id,
        outcome: 'success', requestId: req.requestId,
        metadata: { revision: result.revision, assetVersion: result.asset.version, checksum: result.asset.checksum },
      });
      res.json({ ok: true, ...result, _decoded: undefined });
    } catch (error) {
      res.status(error.status || 400).json({ error: error.message, code: error.code || 'invalid_map' });
    }
  });

  function auditPalworldMutation(req, manager, action, outcome, {
    targetId = null, content = null, idempotencyKey = null, metadata = null,
  } = {}) {
    try {
      const auditMetadata = {};
      if (content != null) auditMetadata.content = palworldOperations.contentFingerprint(content);
      if (idempotencyKey) auditMetadata.idempotencyKeyHash = palworldOperations.safeTargetId(idempotencyKey);
      Object.assign(auditMetadata, metadata || {});
      audit.record({
        actorId: req.user.id,
        actorUsername: req.user.username,
        serverId: manager.id,
        action: `palworld.${action}`,
        targetType: targetId ? 'player' : 'server',
        targetId: targetId ? palworldOperations.safeTargetId(targetId) : manager.id,
        outcome,
        requestId: req.requestId,
        metadata: auditMetadata,
      });
    } catch (error) {
      log('audit: Palworld mutation capture failed:', error.message);
    }
  }

  function palworldMutationContext(req, res, capability, limiter) {
    const manager = targetManager(req);
    if (!manager) {
      res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
      return null;
    }
    if (!foundationCapabilities.has(req.user, manager.id, capability)) {
      res.status(403).json({ error: tErr(req.user, 'errors.forbidden'), capability });
      return null;
    }
    if (manager.status !== 'online') {
      res.status(409).json({ error: 'The server must be online.' });
      return null;
    }
    const rate = limiter(`${req.user.id}:${manager.id}`);
    if (!rate.allowed) {
      res.set('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
      res.status(429).json({ error: 'Too many Palworld requests. Try again shortly.' });
      return null;
    }
    return manager;
  }

  async function applyPalworldMutation(req, res, {
    action, endpoint = action, body, targetId = null, content = null, idempotent = false,
  }) {
    const manager = targetManager(req);
    const key = String(req.get('Idempotency-Key') || '').trim();
    if (idempotent && !key) return res.status(400).json({ error: 'Idempotency-Key is required.' });
    const replayKey = `${req.user.id}:${manager.id}:${action}:${key}`;
    const replay = idempotent ? palworldReplays.get(replayKey) : null;
    if (replay) return res.status(replay.status).json({ ...replay.body, replayed: true });
    try {
      const data = await manager.module().mutate(manager, endpoint, body);
      const result = { status: action === 'save' ? 202 : 200, body: {
        ok: true,
        accepted: true,
        completed: action === 'save' ? null : true,
        requestId: req.requestId,
        ...(data?.result || {}),
      } };
      if (idempotent) palworldReplays.set(replayKey, result);
      auditPalworldMutation(req, manager, action, 'success', { targetId, content, idempotencyKey: key });
      manager.module().refresh(manager).catch(() => {});
      return res.status(result.status).json(result.body);
    } catch (error) {
      const unknown = error?.state === 'timeout';
      const result = {
        status: unknown ? 504 : 503,
        body: {
          error: unknown
            ? 'The Palworld REST API timed out. The outcome is unknown; refresh before retrying.'
            : 'Palworld REST API is unavailable.',
          outcome: unknown ? 'unknown' : 'failure',
          requestId: req.requestId,
        },
      };
      if (idempotent) palworldReplays.set(replayKey, result);
      auditPalworldMutation(req, manager, action, unknown ? 'unknown' : 'failure', {
        targetId, content, idempotencyKey: key, metadata: { errorCode: error?.code || 'request_failed' },
      });
      manager.module().refresh(manager).catch(() => {});
      return res.status(result.status).json(result.body);
    }
  }

  async function playerMutation(req, res, action, routeUserId) {
    const manager = palworldMutationContext(req, res, CAPABILITIES.PLAYERS_MANAGE, limitPalworldPlayers);
    if (!manager) return;
    const parsedId = palworldOperations.userId(routeUserId ?? req.body?.userId);
    if (parsedId.error) return res.status(400).json({ error: parsedId.error });
    const parsedReason = palworldOperations.text(req.body?.reason ?? req.body?.message, { label: 'Reason' });
    if (parsedReason.error) return res.status(400).json({ error: parsedReason.error, limit: palworldOperations.MESSAGE_LIMIT });
    if (action !== 'unban') {
      await manager.module().refresh(manager);
      const health = manager.moduleState.restHealth;
      if (health?.state !== 'healthy') return res.status(503).json({ error: 'Palworld REST API is unavailable.', restHealth: health });
      const player = manager.module().listPlayers(manager).find((item) => item.userId === parsedId.value);
      if (!player) return res.status(409).json({ error: 'The player is no longer online. Refresh the list.' });
      if (Date.now() - Date.parse(player.observedAt) > palworldOperations.STALE_PLAYER_MS) {
        return res.status(409).json({ error: 'The player observation is stale. Refresh the list.' });
      }
    }
    const mutationBody = { userid: parsedId.value };
    if (action !== 'unban' && parsedReason.value) mutationBody.message = parsedReason.value;
    return applyPalworldMutation(req, res, {
      action,
      body: mutationBody,
      targetId: parsedId.value,
      content: parsedReason.value,
      idempotent: true,
    });
  }

  router.post('/players/:userId/kick', (req, res) => playerMutation(req, res, 'kick', req.params.userId));
  router.post('/players/:userId/ban', (req, res) => playerMutation(req, res, 'ban', req.params.userId));
  router.post('/players/unban', (req, res) => playerMutation(req, res, 'unban'));

  router.post('/announcements', (req, res) => {
    const manager = palworldMutationContext(req, res, CAPABILITIES.ANNOUNCEMENTS_SEND, limitPalworldAnnouncements);
    if (!manager) return;
    const parsed = palworldOperations.text(req.body?.message, { required: true });
    if (parsed.error) return res.status(400).json({ error: parsed.error, limit: palworldOperations.MESSAGE_LIMIT });
    return applyPalworldMutation(req, res, { action: 'announcement', endpoint: 'announce', body: { message: parsed.value }, content: parsed.value });
  });

  router.post('/save', (req, res) => {
    const manager = palworldMutationContext(req, res, CAPABILITIES.BACKUPS_CREATE, limitPalworldPlayers);
    if (!manager) return;
    return applyPalworldMutation(req, res, { action: 'save', body: undefined });
  });

  // Compatibility shims for clients using the original action endpoint.
  router.post('/:action', (req, res) => {
    const action = String(req.params.action || '').toLowerCase();
    if (action === 'kick' || action === 'ban' || action === 'unban') return playerMutation(req, res, action);
    if (action === 'announce') {
      const manager = palworldMutationContext(req, res, CAPABILITIES.ANNOUNCEMENTS_SEND, limitPalworldAnnouncements);
      if (!manager) return;
      const parsed = palworldOperations.text(req.body?.message, { required: true });
      if (parsed.error) return res.status(400).json({ error: parsed.error, limit: palworldOperations.MESSAGE_LIMIT });
      return applyPalworldMutation(req, res, { action: 'announcement', endpoint: 'announce', body: { message: parsed.value }, content: parsed.value });
    }
    if (action === 'save') {
      const manager = palworldMutationContext(req, res, CAPABILITIES.BACKUPS_CREATE, limitPalworldPlayers);
      if (!manager) return;
      return applyPalworldMutation(req, res, { action: 'save', body: undefined });
    }
    return res.status(400).json({ error: tErr(req.user, 'errors.unknownAction') });
  });

  return router;
};
