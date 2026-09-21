'use strict';

/*
 * Palworld mods, platform, profile portability and connectivity.
 *
 * GET  /api/palworld/mods                        - installed mod inventory
 * GET  /api/palworld/mods/catalog                - Workshop catalog search
 * POST /api/palworld/mods/catalog/download       - batch-download Workshop items
 * GET  /api/palworld/mods/catalog/:workshopId    - Workshop item details
 * GET  /api/palworld/mods/sources                - Workshop source config + libraries
 * PUT  /api/palworld/mods/sources                - save Workshop source config
 * GET  /api/palworld/mods/official               - official-package update check
 * POST /api/palworld/mods/preview                - preview a package install (upload or cached)
 * POST /api/palworld/mods/install                - install a previewed package
 * POST /api/palworld/mods/import                 - apply a previewed legacy import
 * POST /api/palworld/mods/enabled-batch          - enable/disable a batch of mods
 * POST /api/palworld/mods/:id/enabled            - enable/disable one mod
 * DELETE /api/palworld/mods/:id                  - remove a mod (to trash)
 * POST /api/palworld/mods/trash/:id/restore      - restore a trashed mod
 * POST /api/palworld/mods/adopt                  - adopt an unmanaged mod folder
 * POST /api/palworld/mods/updates/check          - check for mod updates
 * GET  /api/palworld/platform                    - Wine/runtime compatibility
 * PUT  /api/palworld/platform/wine               - save the Wine runtime config
 * GET  /api/palworld/profile/preview             - profile export preview
 * POST /api/palworld/profile/export              - build a profile export archive
 * GET  /api/palworld/profile/export/:id/download - download a profile export archive
 * GET  /api/palworld/connectivity                - connectivity report
 * POST /api/palworld/connectivity/test           - probe one host:port endpoint
 * POST /api/portability/palworld/adopt/preview   - inspect an existing server dir (admin)
 * POST /api/portability/palworld/adopt           - adopt an existing server dir (admin)
 * POST /api/portability/palworld/import/preview  - preview a profile archive (admin)
 * POST /api/portability/palworld/import          - import a previewed profile (admin)
 *
 * Mounted at /api with fully-qualified subpaths so the /api/palworld and
 * /api/portability surfaces share one router: both groups resolve the same
 * Palworld target and the portability half cannot live under /api/palworld
 * (adopts/imports create a *new* server, so they sit next to registration).
 * This mirrors lib/routes/palworld-updates.cjs, which likewise mounts at
 * /api for a mixed-prefix group. steamUpdateDeps stays owned by server.js
 * (the automation scheduler also calls it) and arrives as an injected dep.
 * Thin HTTP layer over lib/palworld-mods.cjs, lib/palworld-workshop.cjs,
 * lib/palworld-platform.cjs, lib/palworld-portability.cjs and
 * lib/palworld-connectivity.cjs.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db.cjs');

module.exports = function palworldModsRouter({
  targetManager,
  findServer,
  palworldMods,
  palworldWorkshop,
  palworldPlatform,
  palworldPortability,
  palworldConnectivity,
  steamUpdateDeps,
  createBackup,
  audit,
  requireAdmin,
  getConfig,
  persistConfig,
  genId,
  getManager,
  serverWithStatus,
  addNotification,
  log,
  sanitizeErrorMessage,
  automation,
}) {
  const router = express.Router();

  function palworldModTarget(req, res) {
    const manager = targetManager(req);
    const server = manager && findServer(manager.id);
    if (!manager || !server || server.type !== 'palworld') {
      res.status(404).json({ error: 'Palworld mods are not available for this server.' });
      return null;
    }
    return { server: { ...server, dir: manager.dir() }, manager };
  }

  function sendPalworldModError(res, error) {
    res.status(Number(error?.status) || 500).json({ error: error?.message || 'The mod request failed.', code: error?.code || 'mod_error' });
  }

  function sendPortabilityError(res, error) {
    res.status(Number(error?.status) || 500).json({
      error: error?.message || 'The request failed.',
      code: error?.code || 'portability_error',
      conflict: error?.conflict || undefined,
    });
  }

  function tasksForServer(serverId) {
    return (getConfig().tasks || []).filter((task) => task.serverId === serverId).map((task) => automation.migrateTask(task));
  }

  // Uploaded packages are data, never programs: the archive lands in a scratch
  // directory, the guard validates it, and only a previewed, staged, hash-verified
  // copy is ever committed into the server folder.
  const palworldModUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(db.dataDir(), 'palworld-mod-imports');
        try { fs.mkdirSync(dir, { recursive: true }); } catch { /* reported by multer */ }
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.zip`),
    }),
    fileFilter: (req, file, cb) => {
      if (!/\.zip$/i.test(file.originalname || '')) return cb(new Error('Only .zip mod packages can be imported.'));
      cb(null, true);
    },
    limits: { fileSize: 512 * 1024 * 1024, files: 1 },
  });

  const palworldProfileUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(db.dataDir(), 'palworld-profile-uploads');
        try { fs.mkdirSync(dir, { recursive: true }); } catch { /* reported by multer */ }
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.zip`),
    }),
    fileFilter: (req, file, cb) => {
      if (!/\.(?:zip|fdprofile\.zip)$/i.test(file.originalname || '')) return cb(new Error('Only a Hostkind profile archive can be imported.'));
      cb(null, true);
    },
    limits: { fileSize: 8 * 1024 * 1024 * 1024, files: 1 },
  });

  router.get('/palworld/mods', async (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      res.json(await palworldMods.inventory({ server: target.server, verify: req.query.verify === '1' }));
    } catch (error) { sendPalworldModError(res, error); }
  });

  router.get('/palworld/mods/catalog', async (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      res.json(await palworldWorkshop.catalog({
        query: req.query.q,
        page: req.query.page,
        sort: req.query.sort,
        tag: req.query.tag,
        force: req.query.force === '1',
      }));
    } catch (error) { sendPalworldModError(res, error); }
  });

  router.post('/palworld/mods/catalog/download', async (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      const result = await palworldWorkshop.downloadBatch({
        server: target.server,
        workshopIds: req.body?.workshopIds,
        ...steamUpdateDeps(),
      });
      audit.record({
        actorId: req.user.id,
        actorUsername: req.user.username,
        serverId: target.server.id,
        action: 'palworld.mods.workshop.batch-download',
        targetType: 'palworld-mod',
        targetId: target.server.id,
        outcome: result.ok ? 'success' : 'partial',
        requestId: req.requestId,
        metadata: { requested: result.requested.length, downloaded: result.downloaded.length },
      });
      res.json(result);
    } catch (error) { sendPalworldModError(res, error); }
  });

  router.get('/palworld/mods/catalog/:workshopId', async (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      const items = await palworldWorkshop.details([req.params.workshopId]);
      const item = items.get(String(req.params.workshopId));
      if (!item?.ok) return res.status(404).json({ error: 'That Workshop item is unavailable.', code: 'workshop_item_unavailable' });
      res.json({ ok: true, item, cached: palworldWorkshop.cachedPackages(target.server).some((entry) => entry.workshopId === item.workshopId) });
    } catch (error) { sendPalworldModError(res, error); }
  });

  router.get('/palworld/mods/sources', (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      const source = palworldWorkshop.sourceConfig(target.server);
      res.json({ ok: true, ...source, libraries: palworldWorkshop.discoverLibraries({ manualPaths: source.manualPaths, serverDir: target.server.dir }) });
    } catch (error) { sendPalworldModError(res, error); }
  });

  router.put('/palworld/mods/sources', (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try { res.json({ ok: true, ...palworldWorkshop.saveSources(target.server, req.body || {}) }); }
    catch (error) { sendPalworldModError(res, error); }
  });

  router.get('/palworld/mods/official', async (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      const compatibility = await palworldMods.compatibility({ server: target.server });
      res.json({ ...(await palworldWorkshop.checkUpdates(target.server)), compatibility });
    } catch (error) { sendPalworldModError(res, error); }
  });

  router.post('/palworld/mods/preview', palworldModUpload.single('package'), async (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    if (!req.file && !req.body?.workshopId) return res.status(400).json({ error: 'Choose a cached Workshop item or upload an official package ZIP.', code: 'package_required' });
    try {
      const result = await palworldWorkshop.preview({
        server: target.server,
        manager: target.manager,
        actorId: req.user.id,
        archivePath: req.file?.path,
        workshopId: req.body?.workshopId,
        serverRevision: req.body?.serverRevision == null ? null : Number(req.body.serverRevision),
        allowUnknownRevision: req.body?.allowUnknownRevision === true || req.body?.allowUnknownRevision === 'true',
      });
      res.json(result);
    } catch (error) {
      try {
        const staged = stagedUploadPath(req.file, palworldModImportsDir());
        if (staged) {
          // Inline resolve + startsWith barrier at the cleanup sink
          // (js/path-injection); stagedUploadPath already proved containment,
          // this restates it on the sink's own taint path.
          const uploadsRoot = path.resolve(palworldModImportsDir());
          const stagedResolved = path.resolve(staged);
          if (stagedResolved.startsWith(uploadsRoot + path.sep)) {
            fs.unlinkSync(stagedResolved);
          }
        }
      } catch { /* swept later */ }    sendPalworldModError(res, error);
    }
  }, (err, req, res, _next) => {
    log('upload failed:', err.message);
    res.status(400).json({ error: sanitizeErrorMessage(err.message || 'The upload failed.'), code: 'upload_failed' });
  });

  router.post('/palworld/mods/install', async (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      const result = await palworldWorkshop.install({
        server: target.server,
        manager: target.manager,
        actorId: req.user.id,
        idempotencyKey: req.get('Idempotency-Key'),
        previewToken: req.body?.previewToken,
        revision: req.body?.revision,
      });
      audit.record({
        actorId: req.user.id,
        actorUsername: req.user.username,
        serverId: target.server.id,
        action: 'palworld.mods.install',
        targetType: 'palworld-mod',
        targetId: result.operation.summary?.workshopId || target.server.id,
        outcome: result.replay ? 'replayed' : 'started',
        requestId: req.requestId,
        operationId: result.operation.id,
        metadata: { summary: result.operation.summary },
      });
      res.status(202).json({ ok: true, operationId: result.operation.id, replay: !!result.replay });
    } catch (error) { sendPalworldModError(res, error); }
  });

  router.post('/palworld/mods/import', async (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      const result = await palworldMods.applyImport({
        server: target.server,
        manager: target.manager,
        actorId: req.user.id,
        idempotencyKey: req.get('Idempotency-Key'),
        previewToken: req.body?.previewToken,
        revision: req.body?.revision,
        restart: req.body?.restart !== false,
        backupRequired: req.body?.backupRequired === true,
        announce: async (seconds) => {
          await target.manager.module().request(target.manager, 'POST', '/announce', {
            message: `Server maintenance in ${seconds} seconds. Please move to a safe location.`,
          });
          await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        },
        createBackup: () => createBackup(target.manager, { applyRetention: false }),
      });
      audit.record({
        actorId: req.user.id,
        actorUsername: req.user.username,
        serverId: target.server.id,
        action: 'palworld.mods.import',
        targetType: 'server',
        targetId: target.server.id,
        outcome: result.replay ? 'replayed' : 'started',
        requestId: req.requestId,
        operationId: result.operation.id,
        metadata: { summary: result.operation.summary },
      });
      res.status(202).json({ ok: true, operationId: result.operation.id, replay: !!result.replay });
    } catch (error) { sendPalworldModError(res, error); }
  });

  router.post('/palworld/mods/enabled-batch', (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean.', code: 'invalid_enabled' });
      const result = palworldWorkshop.setEnabledBatch({
        server: target.server,
        manager: target.manager,
        workshopIds: req.body?.workshopIds,
        enabled,
      });
      audit.record({
        actorId: req.user.id,
        actorUsername: req.user.username,
        serverId: target.server.id,
        action: enabled ? 'palworld.mods.batch-enable' : 'palworld.mods.batch-disable',
        targetType: 'palworld-mod',
        targetId: target.server.id,
        outcome: 'success',
        requestId: req.requestId,
        metadata: { count: result.changed.length },
      });
      res.json(result);
    } catch (error) { sendPalworldModError(res, error); }
  });

  router.post('/palworld/mods/:id/enabled', (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      const result = palworldWorkshop.setEnabled({
        server: target.server,
        manager: target.manager,
        workshopId: req.params.id,
        enabled: req.body?.enabled === true,
      });
      audit.record({
        actorId: req.user.id,
        actorUsername: req.user.username,
        serverId: target.server.id,
        action: req.body?.enabled === true ? 'palworld.mods.enable' : 'palworld.mods.disable',
        targetType: 'palworld-mod',
        targetId: req.params.id,
        outcome: 'success',
        requestId: req.requestId,
      });
      res.json(result);
    } catch (error) { sendPalworldModError(res, error); }
  });

  router.delete('/palworld/mods/:id', (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      const result = palworldWorkshop.remove({ server: target.server, manager: target.manager, workshopId: req.params.id });
      audit.record({
        actorId: req.user.id,
        actorUsername: req.user.username,
        serverId: target.server.id,
        action: 'palworld.mods.remove',
        targetType: 'palworld-mod',
        targetId: req.params.id,
        outcome: 'success',
        requestId: req.requestId,
        metadata: { trashId: result.trashId, snapshotId: result.snapshotId },
      });
      res.json(result);
    } catch (error) { sendPalworldModError(res, error); }
  });

  router.post('/palworld/mods/trash/:id/restore', (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      res.json(palworldWorkshop.restore({ server: target.server, manager: target.manager, trashId: req.params.id }));
    } catch (error) { sendPalworldModError(res, error); }
  });

  router.post('/palworld/mods/adopt', (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      res.json(palworldMods.adopt({
        server: target.server,
        relPath: req.body?.path,
        name: req.body?.name,
        provider: req.body?.provider,
        sourceItemId: req.body?.sourceItemId,
      }));
    } catch (error) { sendPalworldModError(res, error); }
  });

  router.post('/palworld/mods/updates/check', async (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      res.json(await palworldWorkshop.checkUpdates(target.server));
    } catch (error) { sendPalworldModError(res, error); }
  });

  // The Wine runtime is an advanced per-server setting. Environment values are
  // stored in the ignored configuration and never returned to a browser.
  router.get('/palworld/platform', async (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      res.json({ ok: true, compatibility: await palworldMods.compatibility({ server: target.server }) });
    } catch (error) { sendPalworldModError(res, error); }
  });

  router.put('/palworld/platform/wine', async (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    const server = findServer(target.server.id);
    const safe = palworldPlatform.safeWine(req.body || {});
    server.palworldWine = { enabled: safe.enabled, executable: safe.executable, prefix: safe.prefix, args: safe.args, env: safe.env };
    persistConfig();
    audit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: server.id,
      action: 'palworld.platform.wine',
      targetType: 'server',
      targetId: server.id,
      outcome: 'success',
      requestId: req.requestId,
      metadata: { enabled: safe.enabled, executable: safe.executable, envKeys: Object.keys(safe.env) },
    });
    try {
      res.json({ ok: true, compatibility: await palworldMods.compatibility({ server: { ...server, dir: target.manager.dir() } }) });
    } catch (error) { sendPalworldModError(res, error); }
  });

  // Exports are built from the registered server; imports and adoption create a
  // *new* server and therefore live outside /api/palworld (which requires an
  // active REST-capable server) under /api/portability, next to registration.
  router.get('/palworld/profile/preview', (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      res.json(palworldPortability.exportPreview({
        server: target.server,
        selection: req.query.selection,
        tasks: tasksForServer(target.server.id),
        updatePolicy: target.server.palworldUpdatePolicy || null,
      }));
    } catch (error) { sendPortabilityError(res, error); }
  });

  router.post('/palworld/profile/export', async (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      const result = await palworldPortability.exportProfile({
        server: target.server,
        selection: req.body?.selection,
        actorId: req.user.id,
        tasks: tasksForServer(target.server.id),
        updatePolicy: target.server.palworldUpdatePolicy || null,
      });
      audit.record({
        actorId: req.user.id,
        actorUsername: req.user.username,
        serverId: target.server.id,
        action: 'palworld.profile.export',
        targetType: 'server',
        targetId: target.server.id,
        outcome: 'success',
        requestId: req.requestId,
        metadata: { selection: result.manifest.selection, files: result.manifest.entries.length, bytes: result.bytes },
      });
      res.json({
        ok: true,
        id: result.id,
        fileName: result.fileName,
        bytes: result.bytes,
        sha256: result.sha256,
        manifest: result.manifest,
        warnings: result.warnings,
      });
    } catch (error) { sendPortabilityError(res, error); }
  });

  router.get('/palworld/profile/export/:id/download', (req, res) => {
    try {
      const file = palworldPortability.exportFile(req.params.id);
      res.download(file, `${path.basename(file)}`);
    } catch (error) { sendPortabilityError(res, error); }
  });

  router.get('/palworld/connectivity', async (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      res.json(await palworldConnectivity.report({
        server: target.server,
        online: target.manager.status === 'online',
      }));
    } catch (error) { sendPortabilityError(res, error); }
  });

  // An external probe only ever runs when the operator asks for one, and its
  // result is reported as an observation, never as a verdict on their router.
  router.post('/palworld/connectivity/test', async (req, res) => {
    const target = palworldModTarget(req, res);
    if (!target) return;
    try {
      res.json(await palworldConnectivity.testEndpoint({ host: req.body?.host, port: req.body?.port }));
    } catch (error) { sendPortabilityError(res, error); }
  });

  router.post('/portability/palworld/adopt/preview', requireAdmin, (req, res) => {
    try {
      res.json(palworldPortability.inspectAdoption({
        dir: req.body?.dir,
        servers: getConfig().servers,
        desiredRestPort: req.body?.restPort,
      }));
    } catch (error) { sendPortabilityError(res, error); }
  });

  router.post('/portability/palworld/adopt', requireAdmin, (req, res) => {
    try {
      const config = getConfig();
      const result = palworldPortability.adopt({
        dir: req.body?.dir,
        name: req.body?.name,
        servers: config.servers,
        desiredRestPort: req.body?.restPort,
      });
      const entry = { id: genId(), ...result.descriptor };
      config.servers.push(entry);
      if (!config.activeServerId) config.activeServerId = entry.id;
      persistConfig();
      getManager(entry.id);
      audit.record({
        actorId: req.user.id,
        actorUsername: req.user.username,
        serverId: entry.id,
        action: 'palworld.adopt',
        targetType: 'server',
        targetId: entry.id,
        outcome: 'success',
        requestId: req.requestId,
        metadata: { reconciled: result.reconciled, snapshotId: result.snapshotId, buildId: result.build?.buildId || null },
      });
      addNotification('server_added', 'Server Adopted', `Existing Palworld server "${entry.name}" has been adopted.`, entry.id);
      res.json({
        ok: true,
        server: serverWithStatus(entry),
        reconciled: result.reconciled,
        snapshotId: result.snapshotId,
        preserved: result.preserved,
      });
    } catch (error) { sendPortabilityError(res, error); }
  });

  router.post('/portability/palworld/import/preview', requireAdmin, palworldProfileUpload.single('profile'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'A Hostkind profile archive is required.', code: 'archive_required' });
    try {
      res.json(await palworldPortability.importPreview({
        file: req.file.path,
        actorId: req.user.id,
        servers: getConfig().servers,
      }));
    } catch (error) {
      sendPortabilityError(res, error);
    } finally {
      try {
        const staged = stagedUploadPath(req.file, palworldProfileUploadsDir());
        if (staged) {
          // Inline resolve + startsWith barrier at the cleanup sink
          // (js/path-injection); stagedUploadPath already proved containment,
          // this restates it on the sink's own taint path.
          const uploadsRoot = path.resolve(palworldProfileUploadsDir());
          const stagedResolved = path.resolve(staged);
          if (stagedResolved.startsWith(uploadsRoot + path.sep)) {
            fs.rmSync(stagedResolved, { force: true });
          }
        }
      } catch { /* swept on restart */ }  }
  });

  router.post('/portability/palworld/import', requireAdmin, (req, res) => {
    try {
      const config = getConfig();
      const result = palworldPortability.confirmImport({
        token: req.body?.token,
        actorId: req.user.id,
        name: req.body?.name,
        dir: req.body?.dir,
        port: req.body?.port,
        restPort: req.body?.restPort,
        servers: config.servers,
      });
      const entry = { id: genId(), ...result.descriptor };
      config.servers.push(entry);
      if (!config.activeServerId) config.activeServerId = entry.id;
      persistConfig();
      getManager(entry.id);
      audit.record({
        actorId: req.user.id,
        actorUsername: req.user.username,
        serverId: entry.id,
        action: 'palworld.profile.import',
        targetType: 'server',
        targetId: entry.id,
        outcome: 'success',
        requestId: req.requestId,
        metadata: { requiresServerFiles: result.requiresServerFiles, schedules: result.schedules.length },
      });
      addNotification('server_added', 'Profile Imported', `Palworld server "${entry.name}" has been imported.`, entry.id);
      res.json({
        ok: true,
        server: serverWithStatus(entry),
        requiresServerFiles: result.requiresServerFiles,
        schedules: result.schedules,
        updatePolicy: result.updatePolicy,
        nextSteps: result.nextSteps,
      });
    } catch (error) { sendPortabilityError(res, error); }
  });

  return router;
};
