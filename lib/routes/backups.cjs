'use strict';

/*
 * GET    /api/backups                    - list backups + terraria options
 * POST   /api/backups                    - create a backup
 * PUT    /api/backups/options            - terraria includeMods option
 * DELETE /api/backups/:name              - move a backup archive to trash
 * GET    /api/backups/:name/download     - stream a backup archive
 * GET    /api/backups/:name/contents     - inspect a backup manifest
 * POST   /api/backups/:name/verify       - verify a backup
 * POST   /api/backups/:name/impact       - preview a restore (returns a token)
 * POST   /api/backups/:name/restore      - restore a backup (202 + operationId)
 *
 * Mounted at /api/backups, so router paths are relative. The /api/backups
 * rate-limit and idempotency prefix middleware registered in server.js run
 * before this mount; keep the mount in place so that ordering is unchanged.
 *
 * backupServerId / backupFile / recoveryArgs moved verbatim out of server.js;
 * they are only used by these routes. listBackups / createBackup /
 * parseBackupName stay in server.js because other flows (palworld updates,
 * world operations, scheduled backups, retention sweeps) call them too, so
 * they arrive as injected dependencies.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { CAPABILITIES, requireCap } = require('../capabilities.cjs');

module.exports = function backupsRouter({
  targetManager,
  listBackups,
  createBackup,
  parseBackupName,
  backupsDir,
  slugify,
  findServer,
  persistConfig,
  STATUS,
  foundationOperations,
  recovery,
  trash,
  addNotification,
  sanitizeErrorMessage,
  httpError,
  log,
}) {
  const router = express.Router();

  const backupServerId = (req) => (targetManager(req) || {}).id;
  const scope = { getServerId: backupServerId };

  function backupFile(name) {
    const safe = path.basename(name);
    if (safe !== name || !safe.toLowerCase().endsWith('.zip')) throw Object.assign(new Error('Invalid backup name.'), { status: 400 });
    const file = path.join(backupsDir(), safe);
    if (!fs.existsSync(file)) throw Object.assign(new Error('Backup does not exist.'), { status: 404 });
    return { name: safe, file };
  }

  function recoveryArgs(req) {
    const m = targetManager(req); if (!m) throw Object.assign(new Error('No server selected.'), { status: 400 });
    const b = backupFile(req.params.name);
    const known = recovery.findManifest(b.name);
    const parsed = parseBackupName(b.name);
    if ((known && known.serverId !== m.id) || (!known && parsed.slug && parsed.slug !== slugify(m.name()))) {
      throw Object.assign(new Error('Backup does not belong to this server.'), { status: 404 });
    }
    const selection = m.module().backupSelection
      ? m.module().backupSelection(m.desc(), { includeMods: true })
      : (m.desc().worlds || ['world', 'world_nether', 'world_the_end']);
    const worlds = [...new Set(selection.map((item) => String(item).replace(/\\/g, '/').split('/')[0]).filter(Boolean))];
    return { ...b, filename: b.name, serverId: m.id, worlds, createdAt: fs.statSync(b.file).mtimeMs, m };
  }

  router.get('/', requireCap(CAPABILITIES.BACKUPS_VIEW, scope), (req, res) => {
    try {
      const m = targetManager(req);
      let modsSizeBytes = 0;
      if (m.module().id === 'terraria' && m.desc().terrariaVariant === 'tmodloader') {
        const base = m.module().backupSelection(m.desc(), { includeMods: false });
        const full = m.module().backupSelection(m.desc(), { includeMods: true });
        for (const item of full.filter((entry) => !base.includes(entry) && /\.tmod$/i.test(entry))) {
          try { modsSizeBytes += fs.statSync(path.join(m.dir(), item)).size; } catch (_) { /* vanished */ }
        }
      }
      res.json({
        backups: listBackups().filter((b) => (b.manifest ? b.manifest.serverId === m.id : b.slug === slugify(m.name()))),
        options: {
          terraria: m.module().id === 'terraria',
          variant: m.desc().terrariaVariant || null,
          includeMods: !!m.desc().backups?.includeMods,
          modsSizeBytes,
        },
      });
    } catch (err) {
      httpError(res, req, err, 500);
    }
  });

  router.post('/', requireCap(CAPABILITIES.BACKUPS_CREATE, scope), async (req, res) => {
    try {
      const r = await createBackup(targetManager(req), {
        includeMods: req.body && typeof req.body.includeMods === 'boolean'
          ? req.body.includeMods
          : !!targetManager(req).desc().backups?.includeMods,
        offline: req.body && req.body.offline === true,
      });
      res.json({ ok: true, ...r });
    } catch (err) {
      httpError(res, req, err, 500);
    }
  });

  router.put('/options', requireCap(CAPABILITIES.BACKUPS_CREATE, scope), (req, res) => {
    try {
      const m = targetManager(req);
      if (!m || m.module().id !== 'terraria') return res.status(400).json({ error: 'Backup options are only available for Terraria servers.' });
      const server = findServer(m.id);
      server.backups = { ...(server.backups || {}), includeMods: req.body && req.body.includeMods === true };
      persistConfig();
      res.json({ ok: true, backups: server.backups });
    } catch (err) {
      httpError(res, req, err, 500);
    }
  });

  router.delete('/:name', requireCap(CAPABILITIES.BACKUPS_DELETE, scope), (req, res) => {
    try {
      const owned = recoveryArgs(req); const name = owned.name; const full = owned.file;
      // Backups use the same recoverable-deletion vocabulary as everything else:
      // the archive moves to trash and stays restorable until it is purged.
      const entry = trash.moveToTrash({
        target: full,
        kind: 'backup',
        scope: 'item',
        serverId: backupServerId(req) || null,
        label: name,
        reason: 'Backup deleted',
        actorId: req.user.id,
      });
      const manifest = recovery.findManifest(name);
      if (manifest) require('../db.cjs').open().prepare('DELETE FROM backup_manifests WHERE id=?').run(manifest.id);
      addNotification('backup_deleted', 'Backup Deleted', `Backup "${name}" has been moved to trash.`);
      res.json({ ok: true, trash: { id: entry.id, expiresAt: entry.expiresAt, restorable: entry.restorable } });
    } catch (err) {
      httpError(res, req, err, 500);
    }
  });

  router.get('/:name/download', requireCap(CAPABILITIES.BACKUPS_VIEW, scope), (req, res) => {
    try { const owned = recoveryArgs(req); res.download(owned.file, owned.name); }
    catch (err) { httpError(res, req, err, err.status || 400); }
  });

  router.get('/:name/contents', requireCap(CAPABILITIES.BACKUPS_VIEW, scope), async (req, res) => {
    try { const a = recoveryArgs(req); const manifest = await recovery.ensureManifest(a); res.json({ ok: true, manifest }); }
    catch (err) { log('backup error:', err.message); res.status(err.status || 422).json({ error: sanitizeErrorMessage(err.message), code: err.code }); }
  });

  router.post('/:name/verify', requireCap(CAPABILITIES.BACKUPS_VIEW, scope), async (req, res) => {
    try { const result = await recovery.verify(recoveryArgs(req)); res.json({ ok: true, verification: result }); }
    catch (err) { log('backup verify error:', err.message); res.status(err.status || 422).json({ error: sanitizeErrorMessage(err.message), code: err.code || 'verification_failed' }); }
  });

  router.post('/:name/impact', requireCap(CAPABILITIES.BACKUPS_RESTORE, scope), async (req, res) => {
    try {
      const a = recoveryArgs(req); const manifest = await recovery.ensureManifest(a);
      if (a.m.module().id === 'terraria' && a.m.status !== STATUS.OFFLINE) {
        return res.status(409).json({ error: 'Terraria backups can only be restored while the server is offline.' });
      }
      if (manifest.metadata?.game === 'terraria'
          && manifest.metadata.variant !== (a.m.desc().terrariaVariant || 'vanilla')) {
        return res.status(409).json({ error: 'This backup belongs to a different Terraria variant.', code: 'variant_mismatch' });
      }
      if (manifest.metadata?.game === 'terraria' && Number.isInteger(manifest.metadata.world?.headerVersion)) {
        const currentFile = a.m.desc().terrariaWorld?.file;
        if (currentFile) {
          try {
            const current = require('../terraria-worlds.cjs').readHeaderOf(path.join(a.m.dir(), currentFile));
            if (current.ok && manifest.metadata.world.headerVersion > current.version) {
              return res.status(409).json({
                error: 'This world was saved by a newer Terraria version than this server has opened.',
                code: 'world_version_newer',
              });
            }
          } catch (_) { /* No readable local world means there is no safe version comparison. */ }
        }
      }
      const verification = recovery.summaries(manifest).verification;
      if (verification.status !== 'verified') return res.status(409).json({ error: 'Verify this backup before restoring it.' });
      const server = { id: a.m.id, dir: a.m.dir(), worlds: a.worlds };
      res.json({ ok: true, impact: recovery.makeImpact({ manifest, server, actorId: req.user.id }) });
    } catch (err) { log('backup error:', err.message); res.status(err.status || 422).json({ error: sanitizeErrorMessage(err.message), code: err.code }); }
  });

  router.post('/:name/restore', requireCap(CAPABILITIES.BACKUPS_RESTORE, scope), async (req, res) => {
    const idem = req.get('Idempotency-Key'); if (!idem) return res.status(400).json({ error: 'Idempotency-Key header is required.' });
    let a, preview; try { a = recoveryArgs(req); preview = recovery.consumePreview({ token: req.body && req.body.token, actorId: req.user.id, server: { id: a.m.id, dir: a.m.dir(), worlds: a.worlds } }); }
    catch (err) { return httpError(res, req, err, err.status || 409); }
    const op = foundationOperations.create({ kind: 'backup-restore', actorId: req.user.id, serverId: a.m.id, idempotencyKey: idem, summary: { backup: a.name } });
    res.status(202).json({ ok: true, operationId: op.id }); if (op.state !== foundationOperations.STATES.QUEUED) return;
    setImmediate(async () => {
      const staging = path.join(a.m.dir(), '.lodestone', 'staging', op.id); const rollback = path.join(a.m.dir(), '.lodestone', 'rollback', op.id); const moved = [];
      try {
        foundationOperations.start(op.id, { phase: 'verify' }); await recovery.verify({ ...a, operationId: op.id });
        foundationOperations.heartbeat(op.id, { phase: 'pre-restore-backup', progress: .2 }); const snapshot = await createBackup(a.m, { applyRetention: false }); await recovery.verify({ file: path.join(backupsDir(), snapshot.name), filename: snapshot.name, serverId: a.m.id, worlds: a.worlds, operationId: op.id });
        const disk = await new Promise((resolve) => fs.statfs(a.m.dir(), (e, s) => resolve(e ? null : s.bavail * s.bsize)));
        if (disk != null && disk < preview.payload.requiredBytes * 1.1) throw Object.assign(new Error('Insufficient disk space for restore.'), { code: 'insufficient_disk' });
        foundationOperations.heartbeat(op.id, { phase: 'extract-staging', progress: .4 }); await recovery.extract(a.file, staging, a.worlds);
        foundationOperations.heartbeat(op.id, { phase: 'wait-offline', progress: .6 }); if (a.m.status !== STATUS.OFFLINE) throw Object.assign(new Error('Server must be offline before restore commit.'), { code: 'server_online' });
        fs.mkdirSync(rollback, { recursive: true }); foundationOperations.heartbeat(op.id, { phase: 'commit', progress: .75 });
        for (const root of preview.manifest.worldRoots) { if (a.m.status !== STATUS.OFFLINE) throw Object.assign(new Error('Server came online during restore.'), { code: 'server_online_race' }); const live = path.join(a.m.dir(), root); const old = path.join(rollback, root); const fresh = path.join(staging, root); if (fs.existsSync(live)) fs.renameSync(live, old); moved.push({ live, old }); fs.renameSync(fresh, live); }
        fs.rmSync(staging, { recursive: true, force: true }); foundationOperations.finish(op.id, { backup: a.name, snapshot: snapshot.name, rollbackAvailable: true });
      } catch (err) {
        if (moved.length) foundationOperations.markRecoveryRequired(op.id, { code: err.code || 'commit_failed', text: err.message, recovery: { rollbackPath: rollback, roots: moved } });
        else { fs.rmSync(staging, { recursive: true, force: true }); foundationOperations.fail(op.id, { code: err.code || 'restore_failed', text: err.message }); }
      }
    });
  });

  return router;
};
