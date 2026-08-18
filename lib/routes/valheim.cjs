'use strict';

/*
 * /api/valheim/worlds/* - see docs/valheim/03-worlds.md ("API and frontend").
 *
 *   GET    /                          inventory + recent operations
 *   POST   /select/preview            what selecting a world would change
 *   POST   /select                    apply a selection (202 + operationId)
 *   POST   /import/preview            upload a world pair (or a zip holding one), describe the import
 *   POST   /import                    apply an import (202)
 *   POST   /rename/preview            what renaming a world would change
 *   POST   /rename                    apply a rename (202)
 *   GET    /:name/download            stream the world pair and its backups as a zip
 *   POST   /:name/delete/preview      impact of deleting the world
 *   DELETE /:name                     apply a delete (202)
 *
 * Cancellation goes through the shared POST /api/operations/:id/cancel.
 *
 * Every mutation answers 202 { ok: true, operationId }, requires an
 * Idempotency-Key, and requires a token from its own preview endpoint - so
 * nothing runs against an impact the caller never saw.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { dataDir } = require('../db.cjs');
const valheimWorlds = require('../valheim-worlds.cjs');
const operations = require('../operations.cjs');
const audit = require('../audit.cjs');
const { CAPABILITIES, requireCap, has } = require('../capabilities.cjs');

// A pair at most: `.fwl` + `.db`, or one zip. The per-file ceiling is the
// world module's, and the archive guard bounds what is inside a zip.
const MAX_FILES = 2;

/*
 * Uploads land in a per-request staging directory under the data dir. The
 * client's filename never reaches the disk - it is attacker-controlled, and
 * the only thing it is used for is a suggested world name - but the
 * extension decides how the payload is read, so it is checked before
 * anything is written.
 */
function uploader() {
  return multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        try {
          if (!req.valheimStaging) {
            req.valheimStaging = valheimWorlds.importStagingDir(crypto.randomUUID());
            fs.mkdirSync(path.join(req.valheimStaging, 'payload'), { recursive: true });
          }
          cb(null, path.join(req.valheimStaging, 'payload'));
        } catch (error) { cb(error); }
      },
      filename: (_req, file, cb) => {
        const extension = path.extname(file.originalname || '').toLowerCase();
        if (extension === '.zip') return cb(null, 'upload.zip');
        if (extension === valheimWorlds.DATA_EXT) return cb(null, `world${valheimWorlds.DATA_EXT}`);
        cb(null, `world${valheimWorlds.META_EXT}`);
      },
    }),
    limits: { fileSize: 512 * 1024 * 1024, files: MAX_FILES },
    fileFilter: (_req, file, cb) => {
      const extension = path.extname(file.originalname || '').toLowerCase();
      if (['.fwl', '.db', '.zip'].includes(extension)) return cb(null, true);
      cb(new Error('Upload a .fwl world file with its matching .db, or a .zip containing one world pair.'));
    },
  }).array('files', MAX_FILES);
}

module.exports = function valheimWorldsRouter(deps) {
  const { findServer, getManager, saveDescriptor, allServers } = deps;

  const router = express.Router();
  const upload = uploader();
  const sid = (req) => (req.query && req.query.serverId) || (req.body && req.body.serverId) || deps.activeServerId();
  const scope = { getServerId: sid };

  // Resolve the target server, or answer 404. Every route starts here, so a
  // caller without a grant on this server never learns whether it exists.
  function serverOf(req, res) {
    const server = findServer(sid(req));
    if (!server) { res.status(404).json({ error: 'Server not found.' }); return null; }
    if (server.type !== 'valheim') { res.status(404).json({ error: 'That server is not a Valheim server.' }); return null; }
    return server;
  }

  const send = (res, err) => res.status(err.status || 500).json({ error: err.message, code: err.code });

  function record(req, server, action, outcome, metadata) {
    audit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: server.id,
      action,
      targetType: 'valheim-world',
      targetId: (metadata && metadata.world) || null,
      outcome,
      requestId: req.requestId,
      operationId: (metadata && metadata.operationId) || null,
      // World names and sizes only. An absolute path in the audit log would
      // leak the host's layout to everyone who can read it.
      metadata,
    });
  }

  const idempotencyKey = (req) => String(req.get('Idempotency-Key') || '').trim();

  /*
   * A replayed request answers with the operation it already started - and it
   * has to do so before anything else looks at the request, because a
   * preview token is single-use: the original call spent it, so
   * re-validating it on the replay would fail a request that has already
   * been accepted.
   */
  function replayed(req, res) {
    const existing = valheimWorlds.findOperationByKey(req.user.id, idempotencyKey(req));
    if (!existing) return false;
    res.status(202).json({ ok: true, operationId: existing.id, replay: true, state: existing.state });
    return true;
  }

  function missingKey(req, res) {
    if (idempotencyKey(req)) return false;
    res.status(400).json({ error: 'An Idempotency-Key header is required for this request.', code: 'idempotency_key_required' });
    return true;
  }

  /*
   * Start a durable operation and answer 202. The work runs after the
   * response: the client follows it through GET /api/operations/:id, and
   * every terminal state is written by the runner itself (see `settle` in
   * lib/valheim-worlds.cjs).
   */
  function dispatch(req, res, server, { kind, name, source, destination, summary }, run) {
    let started;
    try {
      started = valheimWorlds.beginOperation({
        kind, actorId: req.user.id, desc: server, idempotencyKey: idempotencyKey(req),
        name, source, destination, summary,
      });
    } catch (err) { return send(res, err); }

    const op = started.operation;
    if (started.replay) return res.status(202).json({ ok: true, operationId: op.id, replay: true, state: op.state });

    const action = `valheim.worlds.${valheimWorlds.ACTIONS[kind].replace(/^valheim-/, '')}`;
    operations.start(op.id, { phase: 'preview-revalidate' });
    record(req, server, action, 'started', { operationId: op.id, world: name || null });

    Promise.resolve()
      .then(() => run(op.id))
      .then((result) => record(req, server, action, 'success', {
        operationId: op.id, world: name || (result && result.name) || null,
      }))
      .catch((err) => record(req, server, action, err instanceof valheimWorlds.Cancelled ? 'cancelled' : 'failure', {
        operationId: op.id, world: name || null, code: err.code || 'failed',
      }));

    res.status(202).json({ ok: true, operationId: op.id });
  }

  // The descriptor accessors a runner needs: one that persists a change, one
  // that re-reads what was persisted. The verify step compares them, so they
  // must not be the same object.
  function descriptorAccess(serverId) {
    return {
      saveDescriptor: (fields) => saveDescriptor(serverId, fields),
      readDescriptor: () => findServer(serverId),
    };
  }

  // --- read ---------------------------------------------------------------

  router.get('/', requireCap(CAPABILITIES.WORLDS_VIEW, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      const manager = getManager(server.id);
      const inventory = valheimWorlds.inventory(server, {
        status: manager ? manager.status : 'offline',
        activeOperations: valheimWorlds.activeOperations(server.id),
      });
      res.json({ ok: true, ...inventory, operations: valheimWorlds.listOperations(server.id) });
    } catch (err) { send(res, err); }
  });

  // --- select -------------------------------------------------------------

  router.post('/select/preview', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      res.json({
        ok: true,
        preview: valheimWorlds.previewSelect({
          desc: server, actorId: req.user.id, name: req.body && req.body.name, manager: getManager(server.id),
        }),
      });
    } catch (err) { send(res, err); }
  });

  router.post('/select', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    if (replayed(req, res)) return;
    if (missingKey(req, res)) return;
    const manager = getManager(server.id);
    let preview;
    try {
      preview = valheimWorlds.consumePreview({
        token: req.body && req.body.token, desc: server, actorId: req.user.id,
        action: valheimWorlds.ACTIONS[valheimWorlds.KIND.SELECT],
      });
      if (!manager || manager.status !== 'offline') {
        throw new valheimWorlds.ValheimWorldError('Stop the server before selecting a world.', { status: 409, code: 'server_online' });
      }
    } catch (err) { return send(res, err); }

    dispatch(req, res, server, {
      kind: valheimWorlds.KIND.SELECT,
      name: preview.name,
      source: { name: preview.current || null },
      destination: { name: preview.name },
      summary: { name: preview.name },
    }, (operationId) => valheimWorlds.runSelect({
      desc: server, manager, operationId, preview, ...descriptorAccess(server.id),
    }));
  });

  // --- import -------------------------------------------------------------

  router.post('/import/preview', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), (req, res) => {
    upload(req, res, async (uploadError) => {
      const cleanup = () => {
        if (req.valheimStaging) { try { fs.rmSync(req.valheimStaging, { recursive: true, force: true }); } catch { /* swept later */ } }
      };
      if (uploadError) { cleanup(); return res.status(400).json({ error: uploadError.message }); }
      const server = serverOf(req, res);
      if (!server) { cleanup(); return; }
      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) { cleanup(); return res.status(400).json({ error: 'Attach a .fwl file with its matching .db, or a .zip containing one world pair.' }); }

      const zip = files.find((file) => path.extname(file.originalname || '').toLowerCase() === '.zip');
      if (zip && files.length > 1) {
        cleanup();
        return res.status(400).json({ error: 'Upload either a .zip archive or the world pair, not both.' });
      }
      try {
        const preview = await valheimWorlds.previewImport({
          desc: server,
          actorId: req.user.id,
          staged: {
            dir: req.valheimStaging,
            kind: zip ? 'archive' : 'upload',
            archive: zip ? path.join('payload', 'upload.zip') : null,
            originalName: files[0].originalname,
          },
          requestedName: req.body && req.body.name,
          select: req.body ? req.body.select === 'true' || req.body.select === true : false,
          manager: getManager(server.id),
        });
        res.json({ ok: true, preview });
      } catch (err) {
        cleanup();
        send(res, err);
      }
    });
  });

  router.post('/import', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    if (replayed(req, res)) return;
    if (missingKey(req, res)) return;
    const manager = getManager(server.id);
    let preview;
    try {
      preview = valheimWorlds.consumePreview({
        token: req.body && req.body.token, desc: server, actorId: req.user.id,
        action: valheimWorlds.ACTIONS[valheimWorlds.KIND.IMPORT],
      });
      if (!manager || manager.status !== 'offline') {
        throw new valheimWorlds.ValheimWorldError('Stop the server before importing a world.', { status: 409, code: 'server_online' });
      }
    } catch (err) { return send(res, err); }

    dispatch(req, res, server, {
      kind: valheimWorlds.KIND.IMPORT,
      name: preview.name,
      source: { kind: preview.source.kind, sizeBytes: preview.source.sizeBytes, backups: preview.source.backups.length },
      destination: { name: preview.name, select: !!preview.select },
      summary: { name: preview.name, select: !!preview.select },
    }, (operationId) => valheimWorlds.runImport({
      desc: server, manager, operationId, preview, ...descriptorAccess(server.id),
    }));
  });

  // --- rename ---------------------------------------------------------------

  router.post('/rename/preview', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      res.json({
        ok: true,
        preview: valheimWorlds.previewRename({
          desc: server, actorId: req.user.id, from: req.body && req.body.from, to: req.body && req.body.to, manager: getManager(server.id),
        }),
      });
    } catch (err) { send(res, err); }
  });

  router.post('/rename', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    if (replayed(req, res)) return;
    if (missingKey(req, res)) return;
    const manager = getManager(server.id);
    let preview;
    try {
      preview = valheimWorlds.consumePreview({
        token: req.body && req.body.token, desc: server, actorId: req.user.id,
        action: valheimWorlds.ACTIONS[valheimWorlds.KIND.RENAME],
      });
      if (!manager || manager.status !== 'offline') {
        throw new valheimWorlds.ValheimWorldError('Stop the server before renaming a world.', { status: 409, code: 'server_online' });
      }
    } catch (err) { return send(res, err); }

    dispatch(req, res, server, {
      kind: valheimWorlds.KIND.RENAME,
      name: preview.from,
      source: { name: preview.from },
      destination: { name: preview.to },
      summary: { from: preview.from, to: preview.to },
    }, (operationId) => valheimWorlds.runRename({
      desc: server, manager, operationId, preview, ...descriptorAccess(server.id),
    }));
  });

  // --- download -----------------------------------------------------------

  /*
   * Reading a world out of the panel is both a world read and a file read, so
   * it takes worlds.view *and* files.view - a grant to see the world list is
   * not on its own a grant to take the world home.
   */
  router.get('/:name/download', requireCap(CAPABILITIES.WORLDS_VIEW, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    if (!has(req.user, server.id, CAPABILITIES.FILES_VIEW)) {
      return res.status(403).json({ error: 'forbidden', capability: CAPABILITIES.FILES_VIEW });
    }
    let plan;
    try { plan = valheimWorlds.downloadName(server, decodeURIComponent(req.params.name)); }
    catch (err) { return send(res, err); }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${plan.filename}"; filename*=UTF-8''${encodeURIComponent(plan.filename)}`);
    record(req, server, 'valheim.worlds.download', 'success', { world: decodeURIComponent(req.params.name), files: plan.files.length });
    valheimWorlds.archive(server, decodeURIComponent(req.params.name), res).catch(() => {
      // Headers are already on the wire; the client sees a truncated zip,
      // which is the honest outcome of a stream that failed halfway.
      res.destroy();
    });
  });

  // --- delete -------------------------------------------------------------

  router.post('/:name/delete/preview', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      res.json({
        ok: true,
        preview: valheimWorlds.previewDelete({
          desc: server, actorId: req.user.id, name: decodeURIComponent(req.params.name), manager: getManager(server.id),
        }),
      });
    } catch (err) { send(res, err); }
  });

  router.delete('/:name', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    if (replayed(req, res)) return;
    if (missingKey(req, res)) return;
    const manager = getManager(server.id);
    let preview;
    try {
      preview = valheimWorlds.consumePreview({
        token: req.body && req.body.token, desc: server, actorId: req.user.id,
        action: valheimWorlds.ACTIONS[valheimWorlds.KIND.DELETE],
      });
      if (!manager || manager.status !== 'offline') {
        throw new valheimWorlds.ValheimWorldError('Stop the server before deleting a world.', { status: 409, code: 'server_online' });
      }
    } catch (err) { return send(res, err); }

    dispatch(req, res, server, {
      kind: valheimWorlds.KIND.DELETE,
      name: preview.world.name,
      source: { name: preview.world.name, sizeBytes: preview.world.sizeBytes, backups: preview.backups.length },
      destination: {},
      summary: { name: preview.world.name },
    }, (operationId) => valheimWorlds.runDelete({
      desc: server, manager, operationId, preview, actorId: req.user.id,
      servers: typeof allServers === 'function' ? allServers() : [],
      ...descriptorAccess(server.id),
    }));
  });

  return router;
};

// The staging root, exported so the panel's boot sweep can find it without
// reaching into the world module.
module.exports.stagingRoot = () => path.join(dataDir(), 'valheim-world-imports');
