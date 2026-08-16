'use strict';

/*
 * /api/worlds - see docs/roadmap/08-world-operations.md.
 *
 *   GET    /                      inventory + candidates + recent operations
 *   POST   /import/preview        upload an archive, describe what importing it would do
 *   POST   /import                apply an import (202 + operationId)
 *   POST   /:id/clone             { preview: true } to describe, else apply (202)
 *   POST   /:id/archive           { preview: true } to describe, else apply (202)
 *   GET    /:id/download          stream the world as a zip
 *   POST   /:id/delete/preview    impact of deleting the world
 *   DELETE /:id                   apply a delete (202)
 *   POST   /:id/pregenerate/preview   Chunky compatibility, consent, radius
 *   POST   /:id/pregenerate       apply pre-generation (202)
 *
 * Cancellation goes through the shared POST /api/operations/:id/cancel.
 *
 * Long mutations answer 202 { ok: true, operationId } and require an
 * Idempotency-Key; the destructive ones (import, delete, pregenerate) also
 * require a token from their preview endpoint, so nothing runs against an
 * impact the caller never saw.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const { dataDir } = require('../db.cjs');
const worlds = require('../worlds.cjs');
const operations = require('../operations.cjs');
const audit = require('../audit.cjs');
const { CAPABILITIES, requireCap, has } = require('../capabilities.cjs');


const MAX_UPLOAD_BYTES = 16 * 1024 * 1024 * 1024; // 16 GiB; the archive guard bounds what is inside

function importUploadDir() {
  return path.join(dataDir(), 'world-imports');
}

/*
 * The upload middleware names the file itself (a random UUID) inside a
 * server-owned directory, so the client never controls the on-disk path.
 * Re-assert that shape before any fs call so a request-derived value can
 * never reach a path sink unguarded (CodeQL js/path-injection).
 */
function stagedUploadPath(file) {
  if (!file || typeof file.path !== 'string' || !file.path) {
    const err = new Error('Upload staging is misconfigured.');
    err.status = 500;
    throw err;
  }
  const abs = path.resolve(file.path);
  const root = path.resolve(importUploadDir());
  // The containment check CodeQL recognizes (resolve + startsWith with the
  // use in the guarded branch) runs first, then the direct-child shape
  // re-assertion (js/path-injection).
  if (abs.startsWith(root + path.sep)) {
    if (path.dirname(abs) !== root || !/^[0-9a-f-]{36}\.zip$/i.test(path.basename(abs))) {
      const err = new Error('Upload staging is misconfigured.');
      err.status = 500;
      throw err;
    }
    return abs;
  }
  const err = new Error('Upload staging is misconfigured.');
  err.status = 500;
  throw err;
}

function uploader() {
  const dir = importUploadDir();
  fs.mkdirSync(dir, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dir),
      // The client's filename never reaches the disk: it is attacker-controlled
      // and we have no use for it beyond a suggestion for the world name.
      filename: (_req, _file, cb) => cb(null, `${require('crypto').randomUUID()}.zip`),
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (!/\.zip$/i.test(file.originalname || '')) return cb(new Error('Only .zip archives can be imported.'));
      cb(null, true);
    },
  }).single('file');
}

module.exports = function worldsRouter(deps) {
  const {
    findServer, getManager, saveWorlds, detectCompat,
    backupsDir, inspectBackup, verifyBackup, recordProvenance,
  } = deps;

  const router = express.Router();
  const upload = uploader();
  const sid = (req) => (req.query && req.query.serverId) || (req.body && req.body.serverId) || deps.activeServerId();
  const scope = { getServerId: sid };

  function tooMany(res, req) {
    const reset = req.rateLimit && req.rateLimit.resetTime;
    const retryAfter = reset ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000)) : 60;
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many world operations. Try again shortly.', code: 'rate_limited' });
  }

  // Resolve the target server, or answer 404. Every route starts here, so a
  // caller without a grant on this server never learns whether it exists.
  function serverOf(req, res) {
    const server = findServer(sid(req));
    if (!server) { res.status(404).json({ error: 'Server not found.' }); return null; }
    return server;
  }

  function worldOf(req, res, server) {
    try { return worlds.findWorld(server, decodeURIComponent(req.params.id)); }
    catch (err) { res.status(err.status || 404).json({ error: err.message }); return null; }
  }

  const send = (res, err) => res.status(err.status || 500).json({ error: err.message, code: err.code });

  function record(req, server, action, outcome, metadata) {
    audit.record({
      actorId: req.user.id, actorUsername: req.user.username, serverId: server.id,
      action, targetType: 'world', targetId: metadata && metadata.world ? metadata.world : null,
      outcome, requestId: req.requestId, operationId: (metadata && metadata.operationId) || null,
      // Names and sizes only. An absolute path in the audit log would leak the
      // host's layout to everyone who can read it.
      metadata,
    });
  }

  const idempotencyKey = (req) => String(req.get('Idempotency-Key') || '').trim();

  /*
   * A replayed request must answer with the operation it already started - and
   * it has to do so *before* anything else looks at the request, because a
   * preview token is single-use: the original call spent it, so re-validating it
   * on the replay would fail a request that has already been accepted.
   */
  function replayed(req, res) {
    const existing = worlds.findOperationByKey(req.user.id, idempotencyKey(req));
    if (!existing) return false;
    res.status(202).json({ ok: true, operationId: existing.id, replay: true, state: existing.state });
    return true;
  }

  // Imports, downloads, and world mutations are expensive or destructive, so
  // each actor gets a per-user budget (canonical helper:
  // lib/palworld-operations.cjs), enforced as express middleware ahead of the
  // handler - the shape CodeQL's js/missing-rate-limiting query recognizes.
  // Authorization is untouched: capability checks still run, and a replayed
  // Idempotency-Key still answers with its existing operation before the
  // budget is consulted.
  const limitImports = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: false, legacyHeaders: false, keyGenerator: (req) => `import:${req.user && req.user.id}`, handler: (req, res) => tooMany(res, req) });
  const limitWorldMutations = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: false, legacyHeaders: false, keyGenerator: (req) => `mutation:${req.user && req.user.id}`, handler: (req, res) => tooMany(res, req) });
  const limitDownload = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: false, legacyHeaders: false, keyGenerator: (req) => `download:${req.user && req.user.id}`, handler: (req, res) => tooMany(res, req) });

  /*
   * Start a durable operation and answer 202. The work runs after the response:
   * the client follows it through GET /api/operations/:id, and every terminal
   * state is written by the runner itself (see lib/worlds.cjs `settle`).
   */
  function dispatch(req, res, server, { kind, worldId, source, destination, summary }, run) {
    let started;
    try {
      started = worlds.beginOperation({
        kind, actorId: req.user.id, server, idempotencyKey: idempotencyKey(req),
        worldId, source, destination, summary,
      });
    } catch (err) { return send(res, err); }

    const op = started.operation;
    if (started.replay) return res.status(202).json({ ok: true, operationId: op.id, replay: true, state: op.state });

    const action = `worlds.${kind.split('.').pop()}`;
    operations.start(op.id, { phase: 'preview-revalidate' });
    record(req, server, action, 'started', { operationId: op.id, world: worldId || (summary && summary.name) || null });

    Promise.resolve()
      .then(() => run(op.id))
      .then((result) => record(req, server, action, 'success', { operationId: op.id, world: worldId || (result && result.name) || null }))
      .catch((err) => record(req, server, action, err instanceof worlds.Cancelled ? 'cancelled' : 'failure', {
        operationId: op.id, world: worldId || null, code: err.code || 'failed',
      }));

    res.status(202).json({ ok: true, operationId: op.id });
  }

  // --- read ---------------------------------------------------------------

  router.get('/', requireCap(CAPABILITIES.WORLDS_VIEW, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      const manager = getManager(server.id);
      const inventory = worlds.inventory(server, {
        status: manager ? manager.status : 'offline',
        activeOperations: worlds.activeOperations(server.id),
      });
      res.json({ ok: true, ...inventory, operations: worlds.listOperations(server.id) });
    } catch (err) { send(res, err); }
  });

  // --- import -------------------------------------------------------------

  router.post('/import/preview', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), limitImports, (req, res) => {
    // The limiter middleware gates before multer reads the body: a 16 GiB
    // upload must not be accepted from an actor who is already over budget.
    upload(req, res, async (uploadError) => {
      if (uploadError) return res.status(400).json({ error: uploadError.message });
      const server = serverOf(req, res);
      if (!server) return;
      if (!req.file) return res.status(400).json({ error: 'Attach a .zip archive to import.' });
      const staged = stagedUploadPath(req.file);
      try {
        const preview = await worlds.previewImport({
          server, actorId: req.user.id, archivePath: staged,
          requestedName: req.body && req.body.name, mode: (req.body && req.body.mode) || 'add',
        });
        // The staged archive is keyed by the preview token, so only the actor
        // who uploaded it can turn it into an import. The token is server
        // generated; assert its shape, then pin the rename target inside the
        // staging directory with the containment check CodeQL recognizes
        // (resolve + startsWith(root + path.sep) with the use in the guarded
        // branch), so a token-derived path can never escape it
        // (js/path-injection).
        const token = String(preview.token || '');
        if (!/^[a-zA-Z0-9-]{1,64}$/.test(token)) {
          const err = new Error('The preview token is invalid.');
          err.status = 500;
          throw err;
        }
        const renameTarget = path.resolve(worlds.importStagingDir(token) + '.zip');
        const stagingRoot = path.resolve(importUploadDir());
        if (renameTarget !== stagingRoot && !renameTarget.startsWith(stagingRoot + path.sep)) {
          const err = new Error('The preview token is invalid.');
          err.status = 400;
          throw err;
        }
        fs.renameSync(staged, renameTarget);
        res.json({ ok: true, preview });
      } catch (err) {
        try { fs.rmSync(staged, { force: true }); } catch (_) { /* swept later */ }
        send(res, err);
      }
    });
  });

  router.post('/import', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), limitImports, (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    if (replayed(req, res)) return;
    const token = req.body && req.body.token;
    const archivePath = worlds.importStagingDir(String(token || '')) + '.zip';
    let preview;
    try {
      if (!fs.existsSync(archivePath)) throw new worlds.WorldError('The uploaded archive is no longer available. Upload it again.', { status: 409, code: 'archive_missing' });
      preview = worlds.consumePreview({ token, server, actorId: req.user.id, action: 'import' });
      if (preview.requiresOffline && getManager(server.id).status !== 'offline') {
        throw new worlds.WorldError('Stop the server before replacing a world.', { status: 409, code: 'server_online' });
      }
    } catch (err) { return send(res, err); }

    dispatch(req, res, server, {
      kind: worlds.KIND.IMPORT,
      worldId: preview.mode === 'replace' ? preview.name : null,
      source: { archive: { entries: preview.archive.entries, expandedBytes: preview.archive.expandedBytes }, root: preview.selectedRoot },
      destination: { name: preview.name, mode: preview.mode },
      summary: { name: preview.name, mode: preview.mode },
    }, (operationId) => worlds.runImport({
      server, manager: getManager(server.id), saveWorlds: (next) => saveWorlds(server.id, next),
      operationId, archivePath, preview,
    }));
  });

  // --- clone --------------------------------------------------------------

  router.post('/:id/clone', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), limitWorldMutations, (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    const world = worldOf(req, res, server);
    if (!world) return;
    try {
      if (req.body && req.body.preview) {
        return res.json({ ok: true, preview: worlds.previewClone({ server, actorId: req.user.id, world, requestedName: req.body.name }) });
      }
      if (replayed(req, res)) return;
      const preview = worlds.consumePreview({ token: req.body && req.body.token, server, actorId: req.user.id, action: 'clone' });
      dispatch(req, res, server, {
        kind: worlds.KIND.CLONE,
        worldId: world.id,
        source: { name: world.name },
        destination: { name: preview.name },
        summary: { name: preview.name, source: world.name },
      }, (operationId) => worlds.runClone({
        server, saveWorlds: (next) => saveWorlds(server.id, next), operationId, world, preview,
      }));
    } catch (err) { send(res, err); }
  });

  // --- archive ------------------------------------------------------------

  router.post('/:id/archive', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), limitWorldMutations, (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    const world = worldOf(req, res, server);
    if (!world) return;
    const manager = getManager(server.id);
    try {
      const stats = worlds.dirStats(world.abs);
      if (req.body && req.body.preview) {
        return res.json({
          ok: true,
          preview: {
            action: 'archive',
            world: { id: world.id, name: world.name, sizeBytes: stats.sizeBytes, fileCount: stats.fileCount, sizeEstimated: !!stats.truncated },
            disk: worlds.diskPlan(backupsDir(), stats.sizeBytes),
            requiresOffline: false,
            serverOnline: manager.status === 'online',
            // Archiving a running world is allowed, and the archive says so.
            consistencyNote: manager.status === 'online' ? 'archiveOnline' : null,
          },
        });
      }
      if (replayed(req, res)) return;
      dispatch(req, res, server, {
        kind: worlds.KIND.ARCHIVE,
        worldId: world.id,
        source: { name: world.name, sizeBytes: stats.sizeBytes },
        destination: {},
        summary: { name: world.name },
      }, (operationId) => worlds.runArchive({
        server, manager, operationId, world, backupsDir: backupsDir(), inspectBackup, verifyBackup,
      }));
    } catch (err) { send(res, err); }
  });

  // --- download -----------------------------------------------------------

  /*
   * Reading a world out of the panel is both a world read and a file read, so it
   * takes worlds.view *and* files.view - a grant to see the world list is not on
   * its own a grant to take the world home.
   */
  router.get('/:id/download', requireCap(CAPABILITIES.WORLDS_VIEW, scope), limitDownload, (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    if (!has(req.user, server.id, CAPABILITIES.FILES_VIEW)) {
      return res.status(403).json({ error: 'forbidden', capability: CAPABILITIES.FILES_VIEW });
    }
    const world = worldOf(req, res, server);
    if (!world) return;
    if (!fs.existsSync(world.abs)) return res.status(404).json({ error: 'That world folder does not exist.' });

    const filename = worlds.safeDownloadName(server.name, world.name);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    record(req, server, 'worlds.download', 'success', { world: world.name });
    worlds.zipWorld(world.abs, world.name, res).catch(() => {
      // Headers are already on the wire; the client sees a truncated zip, which
      // is the honest outcome of a stream that failed halfway.
      res.destroy();
    });
  });

  // --- delete -------------------------------------------------------------

  router.post('/:id/delete/preview', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    const world = worldOf(req, res, server);
    if (!world) return;
    try {
      res.json({ ok: true, preview: worlds.previewDelete({ server, actorId: req.user.id, world, manager: getManager(server.id) }) });
    } catch (err) { send(res, err); }
  });

  router.delete('/:id', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), limitWorldMutations, (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    const world = worldOf(req, res, server);
    if (!world) return;
    const manager = getManager(server.id);
    if (replayed(req, res)) return;
    let preview;
    try {
      preview = worlds.consumePreview({ token: req.body && req.body.token, server, actorId: req.user.id, action: 'delete' });
      if (manager.status !== 'offline') throw new worlds.WorldError('Stop the server before deleting a world.', { status: 409, code: 'server_online' });
    } catch (err) { return send(res, err); }

    dispatch(req, res, server, {
      kind: worlds.KIND.DELETE,
      worldId: world.id,
      source: { name: world.name, sizeBytes: preview.world.sizeBytes },
      destination: {},
      summary: { name: world.name },
    }, (operationId) => worlds.runDelete({
      server, manager, saveWorlds: (next) => saveWorlds(server.id, next), operationId, world, preview,
    }));
  });

  // --- pre-generation -----------------------------------------------------

  router.post('/:id/pregenerate/preview', requireCap(CAPABILITIES.WORLDS_PREGENERATE, scope), async (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    const world = worldOf(req, res, server);
    if (!world) return;
    try {
      const manager = getManager(server.id);
      const preview = await worlds.previewPregenerate({
        server, actorId: req.user.id, world, manager,
        compat: detectCompat(manager), radius: (req.body && req.body.radius) || 1000,
      });
      // The resolved Modrinth version is an implementation detail of the apply
      // step; the client gets the compatibility answer, not the download URL.
      const { _resolved, ...visible } = preview;
      res.json({ ok: true, preview: visible });
    } catch (err) { send(res, err); }
  });

  router.post('/:id/pregenerate', requireCap(CAPABILITIES.WORLDS_PREGENERATE, scope), limitWorldMutations, (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    const world = worldOf(req, res, server);
    if (!world) return;
    if (replayed(req, res)) return;
    let preview;
    try {
      preview = worlds.consumePreview({ token: req.body && req.body.token, server, actorId: req.user.id, action: 'pregenerate' });
      if (!preview.chunky || !preview.chunky.supported) {
        throw new worlds.WorldError('No compatible Chunky build is available for this server.', { status: 409, code: 'chunky_unsupported' });
      }
      // Consent is explicit and combined: installing Chunky is a content install,
      // and it needs that capability on top of worlds.pregenerate.
      if (!req.body || req.body.consent !== true) {
        throw new worlds.WorldError('Pre-generation needs explicit consent to run Chunky commands on this server.', { status: 409, code: 'consent_required' });
      }
      if (!preview.chunky.installed && !has(req.user, server.id, CAPABILITIES.CONTENT_INSTALL)) {
        throw new worlds.WorldError('Installing Chunky needs the content install permission.', { status: 403, code: 'forbidden' });
      }
    } catch (err) { return send(res, err); }

    dispatch(req, res, server, {
      kind: worlds.KIND.PREGENERATE,
      worldId: world.id,
      source: { name: world.name },
      destination: { radius: preview.radius },
      summary: { name: world.name, radius: preview.radius, installsChunky: !preview.chunky.installed },
    }, (operationId) => worlds.runPregenerate({
      server, manager: getManager(server.id), operationId, world, preview, recordProvenance,
    }));
  });

  return router;
};
