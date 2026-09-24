'use strict';

/*
 * GET    /servers               - fleet list (filtered to authorized servers)
 * POST   /servers               - register a server (admin)
 * PUT    /servers/:id           - edit a server (admin, stopped only)
 * PUT    /servers/:id/map       - update only the map URL (admin)
 * DELETE /servers/:id           - remove a server, optionally trashing files (admin)
 * POST   /active                - switch the active server
 * POST   /servers/:id/start     - start one server
 * POST   /servers/:id/stop      - stop one server
 * POST   /servers/:id/restart   - restart one server
 * GET    /status                - active-server status payload
 * POST   /server/start          - start the active server (legacy alias)
 * POST   /server/stop           - stop the active server (legacy alias)
 * POST   /server/restart        - restart the active server (legacy alias)
 * POST   /command               - run one console line on the active server
 *
 * Mounted at /api, so router paths are relative (e.g. '/servers').
 * Registration order matches the original inline block in server.js.
 * serverWithStatus/targetManager/getManager are shared process-supervision
 * core used by the whole file, so they stay in server.js and arrive here as
 * factory deps. `config` is a reassigned `let` in server.js, so live state
 * travels as getConfig/saveConfig getters, mirroring lib/routes/users.cjs.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

module.exports = function serversRouter({
  getConfig,
  saveConfig,
  findServer,
  getManager,
  targetManager,
  serverWithStatus,
  localizeManagerResult,
  requireAdmin,
  tErr,
  eKey,
  localizeErr,
  addNotification,
  globalBroadcast,
  foundationAudit,
  foundationCapabilities,
  health,
  crashIntelligence,
  trash,
  deleteManager,
  genId,
  log,
  serverNameMaxLength,
  getMaxCommandLength,
}) {
  const router = express.Router();

  // Rebase a path that lived under `from` onto `to`. Anything outside `from`
  // (or not a path at all) is returned untouched, so launch arguments that are
  // plain flags survive a folder move unchanged.
  function rebasePath(p, from, to) {
    if (typeof p !== 'string' || !p || !from) return p;
    const rel = path.relative(from, p);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return p;
    return path.join(to, rel);
  }

  // `existing` is the registry entry being edited (null when registering a new
  // one). Only Minecraft servers are jar-launched: every other game type is
  // installed by the panel with its own executable/args, and its gameplay
  // settings live in the game's own config files - so editing one only touches
  // the panel-side fields (name + install folder).
  function validateMinecraftLaunchArgs(dir, raw) {
    if (!Array.isArray(raw) || !raw.length || raw.some((arg) => typeof arg !== 'string' || /[\r\n\0]/.test(arg))) {
      return { error: eKey('errors.invalidLaunchArgs') };
    }
    const root = path.resolve(dir);
    for (const arg of raw) {
      if (!arg.startsWith('@')) continue;
      const reference = arg.slice(1).trim();
      if (!reference || path.isAbsolute(reference)) return { error: eKey('errors.invalidLaunchArgs') };
      const target = path.resolve(root, reference);
      const relative = path.relative(root, target);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return { error: eKey('errors.invalidLaunchArgs') };
      let stat;
      try { stat = fs.statSync(target); } catch (_) {}
      if (!stat?.isFile()) return { error: eKey('errors.invalidLaunchArgs') };
    }
    return { value: [...raw] };
  }

  function validateServerInput(body, user, existing = null) {
    const name = String(body.name || '').trim();
    const dir = String(body.dir || '').trim();
    let jar = String(body.jar || '').trim();
    if (!name) return { error: eKey('errors.nameRequired') };
    if (name.length > serverNameMaxLength) return { error: eKey('errors.nameTooLong', { max: serverNameMaxLength }) };
    if (!dir) return { error: eKey('errors.folderRequired') };
    if (!fs.existsSync(dir)) return { error: eKey('errors.folderDoesNotExist', { path: dir }) };
    if (!fs.statSync(dir).isDirectory()) return { error: eKey('errors.notAFolder') };
    const type = (existing && existing.type) || 'minecraft';
    if (type !== 'minecraft') {
      const value = { name, dir };
      // The folder moved: point the stored launch command at the new location.
      if (existing.dir && path.resolve(existing.dir) !== path.resolve(dir)) {
        const from = existing.dir;
        value.executable = rebasePath(existing.executable, from, dir);
        value.cwd = rebasePath(existing.cwd, from, dir);
        if (Array.isArray(existing.args)) value.args = existing.args.map((a) => rebasePath(a, from, dir));
      }
      return { value };
    }
    let launchArgs = null;
    if (body.launchArgs !== undefined && body.launchArgs !== null && body.launchArgs !== '') {
      const validated = validateMinecraftLaunchArgs(dir, body.launchArgs);
      if (validated.error) return validated;
      launchArgs = validated.value;
    }
    const hasLaunchArgs = Array.isArray(launchArgs) && launchArgs.length > 0;

    // Auto-detect the jar if not supplied and exactly one exists. Forge and
    // NeoForge argfile installs use launchArgs instead of a root jar.
    if (!hasLaunchArgs) {
      if (!jar) {
        const jars = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.jar'));
        if (jars.length === 1) jar = jars[0];
        else if (jars.length === 0) return { error: eKey('errors.noJar') };
        else return { error: eKey('errors.multipleJars') };
      } else if (!fs.existsSync(path.join(dir, jar))) {
        return { error: eKey('errors.jarNotFound', { name: jar }) };
      }
    }
    let javaArgs = body.javaArgs;
    if (typeof javaArgs === 'string') {
      javaArgs = javaArgs.trim().split(/\s+/).filter(Boolean);
    }
    if (!Array.isArray(javaArgs) || !javaArgs.length) javaArgs = ['-Xmx2G', '-Xms2G'];
    let worlds = body.worlds;
    if (typeof worlds === 'string') worlds = worlds.split(',').map((w) => w.trim()).filter(Boolean);
    if (!Array.isArray(worlds) || !worlds.length) worlds = ['world', 'world_nether', 'world_the_end'];
    const mapUrl = normalizeMapUrl(body.mapUrl);
    if (mapUrl === null) return { error: eKey('errors.invalidMapUrl') };
    const value = {
      name,
      dir,
      jar,
      javaArgs,
      worlds,
      mcVersion: String(body.mcVersion || '').trim(),
      stopTimeoutSeconds: Number(body.stopTimeoutSeconds) || 30,
      mapUrl,
    };
    if (hasLaunchArgs) value.launchArgs = launchArgs;
    if (body.loader != null && String(body.loader).trim()) value.loader = String(body.loader).trim();
    return { value };
  }

  // Accept an empty string (clears the map) or a http(s) URL. Returns the
  // normalized URL, or null if the input is non-empty but not a valid URL.
  function normalizeMapUrl(raw) {
    if (raw === undefined || raw === null) return '';
    const s = String(raw).trim();
    if (!s) return '';
    try {
      const u = new URL(s);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.toString().replace(/\/$/, '');
    } catch (_) {
      return null;
    }
  }

  function getManagerOr404(req, res, fn) {
    const s = findServer(req.params.id);
    if (!s) { res.status(404); return { error: eKey('errors.serverNotFound') }; }
    return fn(getManager(s.id));
  }

  router.get('/servers', (req, res) => {
    const config = getConfig();
    // SERVER_REGISTER is not grantable at NULL scope, so gating the list on it
    // left an operator who holds per-server grants unable to see the fleet at
    // all. They see exactly the servers they have a per-server grant on; admins
    // (and the guest identity) pass hasAnyPerServerGrant unconditionally.
    res.json({
      activeServerId: config.activeServerId,
      servers: config.servers.filter((s) => foundationCapabilities.hasAnyPerServerGrant(req.user, s.id)).map(serverWithStatus),
    });
  });

  router.post('/servers', requireAdmin, (req, res) => {
    const config = getConfig();
    const v = validateServerInput(req.body || {}, req.user);
    if (v.error) return res.status(400).json({ error: localizeErr(req.user, v.error) });
    const entry = {
      id: genId(),
      watchdog: { enabled: false, maxRestarts: 3, windowMinutes: 10 },
      ...v.value,
    };
    config.servers.push(entry);
    if (!config.activeServerId) config.activeServerId = entry.id;
    saveConfig(config);
    getManager(entry.id);
    addNotification('server_added', 'Server Registered', `Server "${entry.name}" has been registered.`, entry.id);
    res.json({ ok: true, server: serverWithStatus(entry) });
  });

  router.put('/servers/:id', requireAdmin, (req, res) => {
    const config = getConfig();
    const s = findServer(req.params.id);
    if (!s) return res.status(404).json({ error: tErr(req.user, 'errors.serverNotFound') });
    const m = getManager(s.id);
    if (m.isRunning()) return res.status(409).json({ error: tErr(req.user, 'errors.stopBeforeEdit') });
    const v = validateServerInput(req.body || {}, req.user, s);
    if (v.error) return res.status(400).json({ error: localizeErr(req.user, v.error) });
    Object.assign(s, v.value);
    if (req.body.watchdog && typeof req.body.watchdog === 'object' && !Array.isArray(req.body.watchdog)) {
      s.watchdog = {
        enabled: !!req.body.watchdog.enabled,
        maxRestarts: Number(req.body.watchdog.maxRestarts) || 3,
        windowMinutes: Number(req.body.watchdog.windowMinutes) || 10,
      };
    }
    saveConfig(config);
    res.json({ ok: true, server: serverWithStatus(s) });
  });

  // Update only the map URL for a server. The map URL is a panel-UI concern
  // (it's just a link to the web map the user wants to embed) so it can be
  // changed while the Minecraft server is running - unlike the rest of the
  // server settings, which require the server to be stopped.
  router.put('/servers/:id/map', requireAdmin, (req, res) => {
    const config = getConfig();
    const s = findServer(req.params.id);
    if (!s) return res.status(404).json({ error: tErr(req.user, 'errors.serverNotFound') });
    const mapUrl = normalizeMapUrl((req.body || {}).mapUrl);
    if (mapUrl === null) return res.status(400).json({ error: tErr(req.user, 'errors.invalidMapUrl') });
    s.mapUrl = mapUrl;
    saveConfig(config);
    globalBroadcast({ type: 'server', server: serverWithStatus(s) });
    res.json({ ok: true, server: serverWithStatus(s) });
  });

  router.delete('/servers/:id', requireAdmin, (req, res) => {
    const config = getConfig();
    const s = findServer(req.params.id);
    if (!s) return res.status(404).json({ error: tErr(req.user, 'errors.serverNotFound') });
    const m = getManager(s.id);
    if (m.isRunning()) return res.status(409).json({ error: tErr(req.user, 'errors.stopBeforeRemove') });
    // Two separate decisions, two separate audit actions: removing the profile
    // from Hostkind, and moving the server files to trash. `files=trash` is the
    // only value that touches the disk, and it is recoverable - the legacy
    // deleteFiles flag now means the same thing rather than deleting permanently.
    const filesMode = String(req.query.files || '').toLowerCase() === 'trash'
      || req.query.deleteFiles === 'true' || req.query.deleteFiles === '1'
      ? 'trash'
      : 'keep';
    let trashed = null;
    let trashError = null;
    if (filesMode === 'trash' && s.dir) {
      try {
        trashed = trash.moveToTrash({
          target: s.dir,
          kind: 'server-files',
          serverId: s.id,
          label: s.name,
          reason: 'Server removed from Hostkind',
          actorId: req.user.id,
          servers: config.servers,
          selfId: s.id,
        });
      } catch (error) {
        // A failed recoverable delete never becomes a permanent one: the profile
        // stays registered so the operator can retry or fix the cause.
        trashError = error;
      }
      foundationAudit.record({
        actorId: req.user.id,
        actorUsername: req.user.username,
        serverId: s.id,
        action: 'server.files.trash',
        targetType: 'server-files',
        targetId: s.id,
        outcome: trashed ? 'success' : 'failure',
        requestId: req.requestId,
        metadata: trashed
          ? { trashId: trashed.id, location: trashed.location, expiresAt: trashed.expiresAt, fileCount: trashed.fileCount }
          : { code: trashError?.code || 'trash_failed' },
      });
      if (!trashed) {
        return res.status(Number(trashError?.status) || 500).json({
          error: trashError?.message || 'The server files could not be moved to trash.',
          code: trashError?.code || 'trash_failed',
        });
      }
    }
    config.servers = config.servers.filter((x) => x.id !== s.id);
    foundationCapabilities.deleteServerGrants(s.id);
    try { health.deleteServerData(s.id); } catch (err) { log('health: cleanup failed for', s.id, err.message); }
    // Phase 2B: fan-out delete across every server-scoped table (operations,
    // snapshots, world_*, crash_*, content, plans, backups, grants). Health-only
    // cleanup orphaned the rest; the retention module owns the full fan-out and
    // trigger cascades (migration 17) handle DB-parent rows.
    try { require('../retention.cjs').deleteServerData(s.id); } catch (err) { log('retention: cleanup failed for', s.id, err.message); }
    try { crashIntelligence.deleteServerData(s.id); } catch (err) { log('crashes: cleanup failed for', s.id, err.message); }
    deleteManager(s.id);
    if (config.activeServerId === s.id) {
      config.activeServerId = config.servers.length ? config.servers[0].id : null;
    }
    saveConfig(config);
    const filesDeleted = !!trashed;
    foundationAudit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: s.id,
      action: 'server.remove',
      targetType: 'server',
      targetId: s.id,
      outcome: 'success',
      requestId: req.requestId,
      metadata: { filesMode },
    });
    addNotification(
      'server_removed',
      'Server Removed',
      `Server "${s.name}" has been removed${filesDeleted ? ' along with its files' : ''}.`,
      s.id,
      {
        titleKey: 'notifications.serverRemovedTitle',
        messageKey: filesDeleted ? 'notifications.serverRemovedWithFilesMessage' : 'notifications.serverRemovedMessage',
        messageVars: { name: s.name },
      }
    );
    res.json({
      ok: true,
      activeServerId: config.activeServerId,
      filesDeleted,
      trash: trashed
        ? { id: trashed.id, expiresAt: trashed.expiresAt, restorable: trashed.restorable, location: trashed.location }
        : null,
    });
  });

  router.post('/active', (req, res) => {
    const config = getConfig();
    const id = req.body && req.body.serverId;
    // Same visibility rule as the fleet list: a caller cannot point the
    // panel-wide default at a server it has no grant on (and cannot learn
    // whether such a server exists).
    if (!findServer(id) || !foundationCapabilities.hasAnyPerServerGrant(req.user, id)) {
      return res.status(404).json({ error: tErr(req.user, 'errors.serverNotFound') });
    }
    config.activeServerId = id;
    saveConfig(config);
    res.json({ ok: true, activeServerId: id });
  });

  router.post('/servers/:id/start', (req, res) => {
    const s = findServer(req.params.id);
    const r = localizeManagerResult(req, getManagerOr404(req, res, (m) => m.start()));
    if (r && r.ok) {
      addNotification('server_started', 'Server Started', `Server "${s.name}" has been started.`, s.id);
    }
    res.json(r);
  });
  router.post('/servers/:id/stop', (req, res) => {
    const s = findServer(req.params.id);
    const r = localizeManagerResult(req, getManagerOr404(req, res, (m) => m.stop(req.body && req.body.force)));
    if (r && r.ok) {
      addNotification('server_stopped', 'Server Stopped', `Server "${s.name}" has been stopped.`, s.id);
    }
    res.json(r);
  });
  router.post('/servers/:id/restart', async (req, res) => {
    const s = findServer(req.params.id);
    if (!s) return res.status(404).json({ error: tErr(req.user, 'errors.serverNotFound') });
    const r = await getManager(s.id).restart();
    if (r && r.ok) {
      addNotification('server_restarted', 'Server Restarted', `Server "${s.name}" has been restarted.`, s.id);
    }
    res.json(localizeManagerResult(req, r));
  });

  // --- server status / actions (active server, legacy-compatible) ---
  router.get('/status', (req, res) => {
    const m = targetManager(req);
    res.json(m ? m.statusPayload() : { status: 'offline', serverId: null });
  });

  router.post('/server/start', (req, res) => {
    const m = targetManager(req);
    const result = localizeManagerResult(req, m ? m.start() : { ok: false, error: eKey('errors.noActiveServer') });
    res.json(result);
  });
  router.post('/server/stop', (req, res) => {
    const m = targetManager(req);
    const result = localizeManagerResult(req, m ? m.stop(req.body && req.body.force) : { ok: false, error: eKey('errors.noActiveServer') });
    res.json(result);
  });
  router.post('/server/restart', async (req, res) => {
    const m = targetManager(req);
    const result = localizeManagerResult(req, m ? await m.restart() : { ok: false, error: eKey('errors.noActiveServer') });
    res.json(result);
  });

  /*
   * Console command (docs/terraria/02-lifecycle-console.md step 5).
   *
   * The console is the console: there is no Hostkind allowlist of commands,
   * because the `commands.run` capability is the control. What is enforced is
   * that one request is one command - a newline in the text would run a second
   * command on the same authorization and put an unaudited line in the console -
   * and that the request is recorded with the actor who made it.
   */
  router.post('/command', (req, res) => {
    const maxCommandLength = getMaxCommandLength();
    const raw = req.body && req.body.cmd;
    if (!raw || typeof raw !== 'string') return res.status(400).json({ error: tErr(req.user, 'errors.missingCmd') });
    if (/[\r\n\u0000]/.test(raw)) return res.status(400).json({ error: tErr(req.user, 'errors.commandNotSingleLine') });
    const cmd = raw.trim();
    if (!cmd) return res.status(400).json({ error: tErr(req.user, 'errors.missingCmd') });
    if (cmd.length > maxCommandLength) return res.status(400).json({ error: tErr(req.user, 'errors.commandTooLong') });
    const m = targetManager(req);
    const result = localizeManagerResult(req, m ? m.sendCommand(cmd) : { ok: false, error: eKey('errors.noActiveServer') });
    // The command text is redacted by lib/audit.cjs before it is stored, so a
    // `password <secret>` typed at a Terraria console does not become an audit
    // record of the password.
    foundationAudit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: m ? m.id : null,
      action: 'console.command',
      targetType: 'server',
      targetId: m ? m.id : null,
      outcome: result && result.ok ? 'success' : 'failure',
      requestId: req.requestId,
      metadata: { command: cmd },
    });
    res.json(result);
  });

  return router;
};
