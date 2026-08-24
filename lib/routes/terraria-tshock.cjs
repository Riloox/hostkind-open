'use strict';

const express = require('express');
const tshock = require('../terraria-tshock.cjs');
const audit = require('../audit.cjs');
const palworldOperations = require('../palworld-operations.cjs');
const { CAPABILITIES, requireCap } = require('../capabilities.cjs');

module.exports = function terrariaTshockRouter(deps) {
  const router = express.Router();
  const adapter = tshock.createAdapter({ fetch: deps.fetch });
  const limitPlayerActions = palworldOperations.createRateLimiter({ limit: 10, windowMs: 60_000 });
  const sid = (req) => req.get('X-Hostkind-Server-Id') || req.query?.serverId || req.body?.serverId || deps.activeServerId();
  const scope = { getServerId: sid };

  function context(req, res) {
    const server = deps.findServer(sid(req));
    if (!server || server.type !== 'terraria' || server.terrariaVariant !== 'tshock') {
      res.status(404).json({ error: 'TShock server not found.' });
      return null;
    }
    const manager = deps.getManager(server.id);
    return { server, manager, online: manager?.status === 'online' };
  }

  function send(res, error) {
    res.status(error.status || 500).json({ error: error.message, code: error.code || 'tshock_failed' });
  }

  function record(req, server, action, outcome, target, metadata = {}) {
    audit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: server.id,
      action: `terraria.tshock.${action}`,
      targetType: 'tshock',
      targetId: target || null,
      outcome,
      requestId: req.requestId,
      metadata,
    });
  }

  async function restList(ctx, endpoint, keys) {
    const body = await adapter.request(tshock.tshockConfig(ctx.server), 'GET', endpoint);
    for (const key of keys) if (Array.isArray(body?.[key])) return body[key];
    if (Array.isArray(body)) return body;
    throw new tshock.TShockError('malformed', 'invalid_list', 'TShock REST returned an invalid list.');
  }

  router.get('/status', requireCap(CAPABILITIES.SERVER_VIEW, scope), async (req, res) => {
    const ctx = context(req, res);
    if (!ctx) return;
    const configured = tshock.tshockConfig(ctx.server);
    let health = adapter.health();
    if (ctx.online && configured.enabled) {
      try { await adapter.request(configured, 'GET', '/v2/server/status'); } catch {}
      health = adapter.health();
    }
    const loopbackSafe = ['127.0.0.1', 'localhost', '::1'].includes(configured.host.toLowerCase());
    res.json({
      ok: true,
      transport: ctx.online ? (health.state === 'healthy' ? 'rest' : 'console') : 'database',
      reason: ctx.online && health.state !== 'healthy' ? health.code : null,
      health,
      loopbackSafe,
      fixAvailable: !loopbackSafe,
      unavailable: ctx.online ? ['offline database review'] : ['live players', 'player actions'],
      version: adapter.version,
    });
  });

  router.get('/players', requireCap(CAPABILITIES.PLAYERS_VIEW, scope), async (req, res) => {
    const ctx = context(req, res);
    if (!ctx) return;
    if (!ctx.online) return res.status(409).json({ error: 'Live players are unavailable while the server is offline.', code: 'server_offline', unavailable: true });
    try {
      try {
        const values = await restList(ctx, '/v2/players/list', ['players']);
        const players = values.map((player, index) => ({
          name: String(player.name || player.nickname || ''),
          account: player.account || player.username || null,
          group: player.group || null,
          index: Number.isInteger(player.index) ? player.index : index,
          muted: Boolean(player.muted),
          source: 'rest',
        })).filter((player) => player.name);
        return res.json({ ok: true, players, source: 'rest', authoritative: true });
      } catch { /* The console roster is the explicit degraded fallback. */ }
      const players = tshock.listPlayers(ctx.server, { manager: ctx.manager, online: true });
      res.json({ ok: true, players, source: 'console', authoritative: false });
    } catch (error) { send(res, error); }
  });

  router.post('/players/:action', requireCap(CAPABILITIES.PLAYERS_MANAGE, scope), (req, res) => {
    const ctx = context(req, res);
    if (!ctx) return;
    const rate = limitPlayerActions(ctx.server.id);
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(rate.retryAfterMs / 1000)));
      return res.status(429).json({ error: 'Too many player actions. Try again shortly.', code: 'rate_limited' });
    }
    const target = String(req.body?.target || '');
    try {
      const result = tshock.playerAction(ctx.server, req.params.action, target, {
        manager: ctx.manager, online: ctx.online, reason: req.body?.reason, duration: req.body?.duration, message: req.body?.message,
      });
      record(req, ctx.server, `players.${req.params.action}`, 'success', target, { source: result.source });
      res.json(result);
    } catch (error) {
      record(req, ctx.server, `players.${req.params.action}`, 'failure', target, { code: error.code || 'failed' });
      send(res, error);
    }
  });

  router.get('/accounts', requireCap(CAPABILITIES.PLAYERS_VIEW, scope), async (req, res) => {
    const ctx = context(req, res);
    if (!ctx) return;
    try {
      if (ctx.online) {
        const values = await restList(ctx, '/v2/users/list', ['users', 'accounts']);
        const accounts = values.map((account) => ({
          name: account.name || account.username, group: account.group || account.usergroup || null,
          lastLogin: account.lastLogin || account.lastAccessed || null,
          registeredAt: account.registeredAt || account.registered || null, source: 'rest',
        })).filter((account) => account.name);
        return res.json({ ok: true, accounts, source: 'rest' });
      }
      res.json({ ok: true, accounts: tshock.listAccounts(ctx.server), source: 'database' });
    }
    catch (error) { send(res, error); }
  });

  router.post('/accounts', requireCap(CAPABILITIES.PLAYERS_MANAGE, scope), (req, res) => {
    const ctx = context(req, res);
    if (!ctx) return;
    const action = String(req.body?.action || 'create');
    const name = String(req.body?.name || '');
    try {
      const result = tshock.accountAction(ctx.server, action, req.body || {}, { manager: ctx.manager, online: ctx.online });
      record(req, ctx.server, `accounts.${action}`, 'success', name, { passwordChanged: result.passwordChanged === true });
      res.json(result);
    } catch (error) {
      record(req, ctx.server, `accounts.${action}`, 'failure', name, { code: error.code || 'failed' });
      send(res, error);
    }
  });

  router.delete('/accounts/:name', requireCap(CAPABILITIES.PLAYERS_MANAGE, scope), (req, res) => {
    const ctx = context(req, res);
    if (!ctx) return;
    try {
      const result = tshock.accountAction(ctx.server, 'delete', { name: req.params.name }, { manager: ctx.manager, online: ctx.online });
      record(req, ctx.server, 'accounts.delete', 'success', req.params.name);
      res.json(result);
    } catch (error) {
      record(req, ctx.server, 'accounts.delete', 'failure', req.params.name, { code: error.code || 'failed' });
      send(res, error);
    }
  });

  router.get('/groups', requireCap(CAPABILITIES.PLAYERS_VIEW, scope), async (req, res) => {
    const ctx = context(req, res);
    if (!ctx) return;
    try {
      let groups;
      if (ctx.online) {
        const values = await restList(ctx, '/v2/groups/list', ['groups']);
        groups = values.map((group) => ({
          name: group.name || group.group, parent: group.parent || null,
          permissions: tshock.splitPermissions(group.permissions || group.commands),
          chatColor: group.chatColor || null, prefix: group.prefix || null, suffix: group.suffix || null, source: 'rest',
        })).filter((group) => group.name);
      } else groups = tshock.listGroups(ctx.server);
      res.json({ ok: true, groups: groups.map((group) => ({
        ...group,
        effectivePermissions: tshock.effectivePermissions(groups, group.name),
      })), source: 'database', editable: !ctx.online, editReason: ctx.online ? 'Stop the server to edit groups safely.' : null });
    } catch (error) { send(res, error); }
  });

  router.post('/groups/preview', requireCap(CAPABILITIES.SERVER_MANAGE, scope), (req, res) => {
    const ctx = context(req, res);
    if (!ctx) return;
    try { res.json({ ok: true, preview: tshock.previewGroup(ctx.server, req.body || {}, req.body?.actorAccount || null) }); }
    catch (error) { send(res, error); }
  });

  router.post('/groups', requireCap(CAPABILITIES.SERVER_MANAGE, scope), (req, res) => {
    const ctx = context(req, res);
    if (!ctx) return;
    const name = String(req.body?.name || '');
    try {
      const result = tshock.groupAction(ctx.server, 'save', req.body || {}, {
        online: ctx.online, actorAccount: req.body?.actorAccount || null, confirmSelfLockout: req.body?.confirmSelfLockout === true,
      });
      record(req, ctx.server, 'groups.save', 'success', name, {
        added: result.preview?.added, removed: result.preview?.removed, parentChanged: result.preview?.parentChanged,
        selfLockoutConfirmed: result.preview?.selfLockout === true,
      });
      res.json(result);
    } catch (error) {
      record(req, ctx.server, 'groups.save', 'failure', name, { code: error.code || 'failed' });
      send(res, error);
    }
  });

  router.delete('/groups/:name', requireCap(CAPABILITIES.SERVER_MANAGE, scope), (req, res) => {
    const ctx = context(req, res);
    if (!ctx) return;
    try {
      const result = tshock.groupAction(ctx.server, 'delete', { name: req.params.name }, { online: ctx.online });
      record(req, ctx.server, 'groups.delete', 'success', req.params.name);
      res.json(result);
    } catch (error) {
      record(req, ctx.server, 'groups.delete', 'failure', req.params.name, { code: error.code || 'failed' });
      send(res, error);
    }
  });

  router.get('/permissions', requireCap(CAPABILITIES.PLAYERS_VIEW, scope), async (req, res) => {
    const ctx = context(req, res);
    if (!ctx) return;
    try {
      if (ctx.online) {
        const values = await restList(ctx, '/v2/groups/list', ['groups']);
        const names = new Set();
        for (const group of values) for (const name of tshock.splitPermissions(group.permissions || group.commands)) names.add(name);
        return res.json({ ok: true, permissions: [...names].sort().map((name) => ({ name, source: 'rest', recognized: true })) });
      }
      res.json({ ok: true, permissions: tshock.permissionCatalogue(ctx.server) });
    }
    catch (error) { send(res, error); }
  });

  router.get('/bans', requireCap(CAPABILITIES.PLAYERS_VIEW, scope), async (req, res) => {
    const ctx = context(req, res);
    if (!ctx) return;
    try {
      if (ctx.online) {
        const values = await restList(ctx, '/v2/bans/list', ['bans']);
        const bans = values.map((ban) => ({
          identifier: String(ban.identifier || ban.name || ban.uuid || ban.id),
          reason: ban.reason || null, expiration: ban.expiration || null, bannedBy: ban.bannedBy || ban.banningUser || null, source: 'rest',
        }));
        return res.json({ ok: true, bans, source: 'rest' });
      }
      res.json({ ok: true, bans: tshock.listBans(ctx.server), source: 'database' });
    }
    catch (error) { send(res, error); }
  });

  router.post('/bans', requireCap(CAPABILITIES.PLAYERS_MANAGE, scope), (req, res) => {
    const ctx = context(req, res);
    if (!ctx) return;
    const target = String(req.body?.target || req.body?.identifier || '');
    try {
      const result = tshock.playerAction(ctx.server, 'ban', target, {
        manager: ctx.manager, online: ctx.online, reason: req.body?.reason, duration: req.body?.duration,
      });
      record(req, ctx.server, 'bans.create', 'success', target);
      res.json(result);
    } catch (error) {
      record(req, ctx.server, 'bans.create', 'failure', target, { code: error.code || 'failed' });
      send(res, error);
    }
  });

  router.delete('/bans/:id', requireCap(CAPABILITIES.PLAYERS_MANAGE, scope), (req, res) => {
    const ctx = context(req, res);
    if (!ctx) return;
    try {
      const result = tshock.playerAction(ctx.server, 'unban', req.params.id, { manager: ctx.manager, online: ctx.online });
      record(req, ctx.server, 'bans.delete', 'success', req.params.id);
      res.json(result);
    } catch (error) { send(res, error); }
  });

  return router;
};
