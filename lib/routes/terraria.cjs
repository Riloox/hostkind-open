'use strict';

/*
 * /api/terraria/* - see docs/terraria/03-worlds.md ("API").
 *
 * Worlds, for now. Phases 4, 6 and 7 mount their own routers here beside this
 * one; the capability mapping every path resolves through already lives in
 * lib/modules/terraria/routes.cjs, and an unmapped path there denies by default.
 *
 *   GET    /                          inventory + unreadable files + recent operations
 *   POST   /select/preview            what selecting a world would change
 *   POST   /select                    apply a selection (202 + operationId)
 *   POST   /import/preview            upload a world (or a zip holding one), describe the import
 *   POST   /import                    apply an import (202)
 *   POST   /generate/preview          validate generation inputs, describe the cost
 *   POST   /generate                  generate a world (202)
 *   GET    /:file/download            stream the world and its companions as a zip
 *   POST   /:file/delete/preview      impact of deleting the world
 *   DELETE /:file                     apply a delete (202)
 *
 * Cancellation goes through the shared POST /api/operations/:id/cancel.
 *
 * Every mutation answers 202 { ok: true, operationId }, requires an
 * Idempotency-Key, and requires a token from its own preview endpoint - so
 * nothing runs against an impact the caller never saw. `worlds.pregenerate` is
 * deliberately absent: Terraria has no pre-generation concept, and claiming the
 * capability would put a dead button in the permissions UI.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { dataDir } = require('../db.cjs');
const terrariaWorlds = require('../terraria-worlds.cjs');
const operations = require('../operations.cjs');
const audit = require('../audit.cjs');
const { CAPABILITIES, requireCap, has } = require('../capabilities.cjs');

// Two files at most: a world and its `.twld`, or one zip. The per-file ceiling is
// the world module's, and the archive guard bounds what is inside a zip.
const MAX_FILES = 2;

/*
 * Uploads land in a per-request staging directory under the data dir. The
 * client's filename never reaches the disk - it is attacker-controlled, and the
 * only thing it is used for is a suggested world name - but the extension
 * decides how the payload is read, so it is checked before anything is written.
 */
function uploader() {
  return multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        try {
          if (!req.terrariaStaging) {
            req.terrariaStaging = terrariaWorlds.importStagingDir(crypto.randomUUID());
            fs.mkdirSync(path.join(req.terrariaStaging, 'payload'), { recursive: true });
          }
          cb(null, path.join(req.terrariaStaging, 'payload'));
        } catch (error) { cb(error); }
      },
      filename: (_req, file, cb) => {
        const extension = path.extname(file.originalname || '').toLowerCase();
        // One safe name per kind. A second `.wld` in the same request would
        // collide here, which is the refusal we want rather than a silent pick.
        if (extension === '.zip') return cb(null, 'upload.zip');
        if (extension === '.twld') return cb(null, `world${terrariaWorlds.MOD_EXT}`);
        cb(null, `world${terrariaWorlds.WORLD_EXT}`);
      },
    }),
    limits: { fileSize: terrariaWorlds.MAX_WORLD_BYTES, files: MAX_FILES },
    fileFilter: (_req, file, cb) => {
      const extension = path.extname(file.originalname || '').toLowerCase();
      if (['.wld', '.twld', '.zip'].includes(extension)) return cb(null, true);
      cb(new Error('Upload a .wld world file (with its .twld if it has one), or a .zip containing one world.'));
    },
  }).array('files', MAX_FILES);
}

module.exports = function terrariaWorldsRouter(deps) {
  const { findServer, getManager, saveDescriptor, broadcast, allServers } = deps;

  const router = express.Router();
  const upload = uploader();
  const sid = (req) => (req.query && req.query.serverId) || (req.body && req.body.serverId) || deps.activeServerId();
  const scope = { getServerId: sid };

  // Resolve the target server, or answer 404. Every route starts here, so a
  // caller without a grant on this server never learns whether it exists.
  function serverOf(req, res) {
    const server = findServer(sid(req));
    if (!server) { res.status(404).json({ error: 'Server not found.' }); return null; }
    if (server.type !== 'terraria') { res.status(404).json({ error: 'That server is not a Terraria server.' }); return null; }
    return server;
  }

  const send = (res, err) => res.status(err.status || 500).json({ error: err.message, code: err.code });

  function record(req, server, action, outcome, metadata) {
    audit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: server.id,
      action,
      targetType: 'terraria-world',
      targetId: (metadata && metadata.world) || null,
      outcome,
      requestId: req.requestId,
      operationId: (metadata && metadata.operationId) || null,
      // World names and sizes only. An absolute path in the audit log would leak
      // the host's layout to everyone who can read it.
      metadata,
    });
  }

  const idempotencyKey = (req) => String(req.get('Idempotency-Key') || '').trim();

  /*
   * A replayed request answers with the operation it already started - and it has
   * to do so before anything else looks at the request, because a preview token
   * is single-use: the original call spent it, so re-validating it on the replay
   * would fail a request that has already been accepted.
   */
  function replayed(req, res) {
    const existing = terrariaWorlds.findOperationByKey(req.user.id, idempotencyKey(req));
    if (!existing) return false;
    res.status(202).json({ ok: true, operationId: existing.id, replay: true, state: existing.state });
    return true;
  }

  /*
   * The key is checked before the preview is consumed, not after.
   *
   * `beginOperation` requires it too, but by then the token has been spent - and
   * a caller that forgot a header would be told to take a fresh preview for a
   * request that never ran. Refusing here costs the caller nothing.
   */
  function missingKey(req, res) {
    if (idempotencyKey(req)) return false;
    res.status(400).json({ error: 'An Idempotency-Key header is required for this request.', code: 'idempotency_key_required' });
    return true;
  }

  /*
   * Start a durable operation and answer 202. The work runs after the response:
   * the client follows it through GET /api/operations/:id, and every terminal
   * state is written by the runner itself (see `settle` in
   * lib/terraria-worlds.cjs).
   */
  function dispatch(req, res, server, { kind, file, source, destination, summary }, run) {
    let started;
    try {
      started = terrariaWorlds.beginOperation({
        kind, actorId: req.user.id, desc: server, idempotencyKey: idempotencyKey(req),
        file, source, destination, summary,
      });
    } catch (err) { return send(res, err); }

    const op = started.operation;
    if (started.replay) return res.status(202).json({ ok: true, operationId: op.id, replay: true, state: op.state });

    const action = `terraria.worlds.${terrariaWorlds.ACTIONS[kind].replace(/^terraria-/, '')}`;
    operations.start(op.id, { phase: 'preview-revalidate' });
    record(req, server, action, 'started', { operationId: op.id, world: file || null });

    Promise.resolve()
      .then(() => run(op.id))
      .then((result) => record(req, server, action, 'success', {
        operationId: op.id, world: file || (result && result.file) || null,
      }))
      .catch((err) => record(req, server, action, err instanceof terrariaWorlds.Cancelled ? 'cancelled' : 'failure', {
        operationId: op.id, world: file || null, code: err.code || 'failed',
      }));

    res.status(202).json({ ok: true, operationId: op.id });
  }

  // The descriptor accessors a runner needs: one that persists a change, one that
  // re-reads what was persisted. The verify step compares them, so they must not
  // be the same object.
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
      const inventory = terrariaWorlds.inventory(server, {
        status: manager ? manager.status : 'offline',
        activeOperations: terrariaWorlds.activeOperations(server.id),
      });
      res.json({
        ok: true,
        ...inventory,
        sizes: Object.keys(terrariaWorlds.SIZES),
        difficulties: Object.keys(terrariaWorlds.DIFFICULTIES),
        operations: terrariaWorlds.listOperations(server.id),
      });
    } catch (err) { send(res, err); }
  });

  // --- select -------------------------------------------------------------

  router.post('/select/preview', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      res.json({
        ok: true,
        preview: terrariaWorlds.previewSelect({
          desc: server, actorId: req.user.id, file: req.body && req.body.file, manager: getManager(server.id),
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
      preview = terrariaWorlds.consumePreview({
        token: req.body && req.body.token, desc: server, actorId: req.user.id,
        action: terrariaWorlds.ACTIONS[terrariaWorlds.KIND.SELECT],
      });
      if (!manager || manager.status !== 'offline') {
        throw new terrariaWorlds.TerrariaWorldError('Stop the server before selecting a world.', { status: 409, code: 'server_online' });
      }
    } catch (err) { return send(res, err); }

    dispatch(req, res, server, {
      kind: terrariaWorlds.KIND.SELECT,
      file: preview.world.file,
      source: { file: preview.current ? preview.current.file : null },
      destination: { file: preview.world.file },
      summary: { name: preview.world.name },
    }, (operationId) => terrariaWorlds.runSelect({
      desc: server, manager, operationId, preview, ...descriptorAccess(server.id),
    }));
  });

  // --- import -------------------------------------------------------------

  router.post('/import/preview', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), (req, res) => {
    upload(req, res, async (uploadError) => {
      const cleanup = () => {
        if (req.terrariaStaging) { try { fs.rmSync(req.terrariaStaging, { recursive: true, force: true }); } catch { /* swept later */ } }
      };
      if (uploadError) { cleanup(); return res.status(400).json({ error: uploadError.message }); }
      const server = serverOf(req, res);
      if (!server) { cleanup(); return; }
      const files = Array.isArray(req.files) ? req.files : [];
      if (!files.length) { cleanup(); return res.status(400).json({ error: 'Attach a .wld world file, or a .zip containing one world.' }); }

      const zip = files.find((file) => path.extname(file.originalname || '').toLowerCase() === '.zip');
      if (zip && files.length > 1) {
        cleanup();
        return res.status(400).json({ error: 'Upload either a .zip archive or the world files, not both.' });
      }
      try {
        const preview = await terrariaWorlds.previewImport({
          desc: server,
          actorId: req.user.id,
          staged: {
            dir: req.terrariaStaging,
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
      preview = terrariaWorlds.consumePreview({
        token: req.body && req.body.token, desc: server, actorId: req.user.id,
        action: terrariaWorlds.ACTIONS[terrariaWorlds.KIND.IMPORT],
      });
      if (!manager || manager.status !== 'offline') {
        throw new terrariaWorlds.TerrariaWorldError('Stop the server before importing a world.', { status: 409, code: 'server_online' });
      }
    } catch (err) { return send(res, err); }

    dispatch(req, res, server, {
      kind: terrariaWorlds.KIND.IMPORT,
      file: preview.file,
      source: { kind: preview.source.kind, sizeBytes: preview.source.sizeBytes, modData: !!preview.source.modFile },
      destination: { file: preview.file, select: !!preview.select },
      summary: { name: preview.name, select: !!preview.select },
    }, (operationId) => terrariaWorlds.runImport({
      desc: server, manager, operationId, preview, ...descriptorAccess(server.id),
    }));
  });

  // --- generate -----------------------------------------------------------

  router.post('/generate/preview', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      res.json({
        ok: true,
        preview: terrariaWorlds.previewGenerate({
          desc: server, actorId: req.user.id, input: req.body || {}, manager: getManager(server.id),
        }),
      });
    } catch (err) { send(res, err); }
  });

  router.post('/generate', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    if (replayed(req, res)) return;
    if (missingKey(req, res)) return;
    const manager = getManager(server.id);
    let preview;
    try {
      preview = terrariaWorlds.consumePreview({
        token: req.body && req.body.token, desc: server, actorId: req.user.id,
        action: terrariaWorlds.ACTIONS[terrariaWorlds.KIND.GENERATE],
      });
      if (!manager || manager.status !== 'offline') {
        throw new terrariaWorlds.TerrariaWorldError('Stop the server before generating a world.', { status: 409, code: 'server_online' });
      }
    } catch (err) { return send(res, err); }

    dispatch(req, res, server, {
      kind: terrariaWorlds.KIND.GENERATE,
      file: preview.file,
      source: { size: preview.size, difficulty: preview.difficulty, seeded: !!preview.seed },
      destination: { file: preview.file, select: !!preview.select },
      summary: { name: preview.name, size: preview.size, difficulty: preview.difficulty },
    }, (operationId) => terrariaWorlds.runGenerate({
      desc: server, manager, operationId, preview, broadcast, ...descriptorAccess(server.id),
    }));
  });

  // --- download -----------------------------------------------------------

  /*
   * Reading a world out of the panel is both a world read and a file read, so it
   * takes worlds.view *and* files.view - a grant to see the world list is not on
   * its own a grant to take the world home. The `.twld` travels with it: half a
   * modded save is not a backup of anything.
   */
  router.get('/:file/download', requireCap(CAPABILITIES.WORLDS_VIEW, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    if (!has(req.user, server.id, CAPABILITIES.FILES_VIEW)) {
      return res.status(403).json({ error: 'forbidden', capability: CAPABILITIES.FILES_VIEW });
    }
    let plan;
    try { plan = terrariaWorlds.downloadName(server, decodeURIComponent(req.params.file)); }
    catch (err) { return send(res, err); }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${plan.filename}"; filename*=UTF-8''${encodeURIComponent(plan.filename)}`);
    record(req, server, 'terraria.worlds.download', 'success', { world: decodeURIComponent(req.params.file), files: plan.files.length });
    terrariaWorlds.zipWorld(server, decodeURIComponent(req.params.file), res).catch(() => {
      // Headers are already on the wire; the client sees a truncated zip, which
      // is the honest outcome of a stream that failed halfway.
      res.destroy();
    });
  });

  // --- delete -------------------------------------------------------------

  router.post('/:file/delete/preview', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      res.json({
        ok: true,
        preview: terrariaWorlds.previewDelete({
          desc: server, actorId: req.user.id, file: decodeURIComponent(req.params.file), manager: getManager(server.id),
        }),
      });
    } catch (err) { send(res, err); }
  });

  router.delete('/:file', requireCap(CAPABILITIES.WORLDS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    if (replayed(req, res)) return;
    if (missingKey(req, res)) return;
    const manager = getManager(server.id);
    let preview;
    try {
      preview = terrariaWorlds.consumePreview({
        token: req.body && req.body.token, desc: server, actorId: req.user.id,
        action: terrariaWorlds.ACTIONS[terrariaWorlds.KIND.DELETE],
      });
      if (!manager || manager.status !== 'offline') {
        throw new terrariaWorlds.TerrariaWorldError('Stop the server before deleting a world.', { status: 409, code: 'server_online' });
      }
    } catch (err) { return send(res, err); }

    dispatch(req, res, server, {
      kind: terrariaWorlds.KIND.DELETE,
      file: preview.world.file,
      source: { file: preview.world.file, sizeBytes: preview.world.sizeBytes, companions: preview.companions.length },
      destination: {},
      summary: { name: preview.world.name },
    }, (operationId) => terrariaWorlds.runDelete({
      desc: server, manager, operationId, preview, actorId: req.user.id,
      servers: typeof allServers === 'function' ? allServers() : [],
      ...descriptorAccess(server.id),
    }));
  });

  return router;
};

// The staging root, exported so the panel's boot sweep can find it without
// reaching into the world module.
module.exports.stagingRoot = () => path.join(dataDir(), 'terraria-world-imports');
