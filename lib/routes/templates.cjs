'use strict';

/*
 * /api/templates and the clone routes on /api/servers - see
 * docs/roadmap/09-server-templates.md.
 *
 * The HTTP layer owns the operation state machine; lib/templates.cjs owns the
 * bytes. Instantiate and clone are the same pipeline over two different
 * sources (a stored archive vs. a live server), so they run through one
 * `dispatch`:
 *
 *   revalidate -> destination/slug -> disk check -> stage new root ->
 *   resolve/verify runtime+content -> validate -> atomic promote -> register
 *
 * Registration is last and is compensated: if the registry write fails after
 * the promotion, the operation becomes `recovery_required` and the promoted
 * folder is left on disk for the user to register or discard. We never delete
 * a server folder that already exists outside our staging area.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const multer = require('multer');
const templates = require('../templates.cjs');
const capabilities = require('../capabilities.cjs');
const operations = require('../operations.cjs');
const audit = require('../audit.cjs');

const { CAPABILITIES } = capabilities;
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const upload = multer({
  dest: path.join(os.tmpdir(), 'fleetdeck-template-imports'),
  limits: { files: 1, fileSize: MAX_IMPORT_BYTES },
});

function sendError(res, err) {
  res.status(err.status || 500).json({ error: err.message, code: err.code });
}

function deny(res, capability) {
  return res.status(403).json({ error: 'Forbidden.', capability });
}

function idempotencyKey(req) {
  return req.get('Idempotency-Key') || null;
}

function build(deps) {
  const { findServer, prepareRuntime, registerCreated, recordProvenance } = deps;

  const permitted = (user, serverId, capability) => capabilities.has(user, serverId, capability);
  // Seeing that a template exists means seeing something about the server it
  // came from, so listing is filtered by server.view on the source.
  const sourceAllowed = (user, serverId) => user?.role === 'admin' || (!!serverId && permitted(user, serverId, CAPABILITIES.SERVER_VIEW));
  // Instantiate/clone: server.manage on the source. A template with no source
  // server (an import) can only be instantiated by an admin, because there is
  // no server to scope the grant to and registering a server is admin-only.
  const canManage = (user, serverId) => user?.role === 'admin' || (!!serverId && permitted(user, serverId, CAPABILITIES.SERVER_MANAGE));
  // Create/export/delete: content.view plus admin-level server.manage.
  const canCurate = (user, serverId) => user?.role === 'admin'
    || (!!serverId && permitted(user, serverId, CAPABILITIES.CONTENT_VIEW) && permitted(user, serverId, CAPABILITIES.SERVER_MANAGE));

  function record(req, { serverId, action, outcome, target, operationId }) {
    audit.record({
      actorId: req.user && req.user.id,
      actorUsername: req.user && req.user.username,
      serverId: serverId || null,
      action,
      target: target || {},
      outcome,
      requestId: req.requestId,
      operationId: operationId || null,
    });
  }

  /*
   * An operation that is still queued or running owns its staging directory;
   * everything else in .fleetdeck-staging is debris from an interrupted build
   * and is discarded. Spec: "Interrupted source creation discards staging."
   */
  function isLiveOperation(id) {
    const op = operations.get(id);
    return !!op && (op.state === operations.STATES.QUEUED || op.state === operations.STATES.RUNNING);
  }

  function cancelled(operationId) {
    const op = operations.get(operationId);
    return !!op && op.state === operations.STATES.CANCELLED;
  }

  /*
   * The shared instantiate/clone runner. `load()` yields the sanitized files
   * and content references, whether they came from an archive or a live server.
   */
  async function run({ operationId, load, parentDir, name, placeholders, sourceServerId, templateId }) {
    const destination = path.join(parentDir, templates.slugFor(name));
    if (fs.existsSync(destination)) {
      throw Object.assign(new Error('The destination already exists.'), { status: 409, code: 'destination_exists' });
    }
    templates.sweepStaging(parentDir, isLiveOperation);

    operations.heartbeat(operationId, { phase: 'revalidate', progress: 0.05 });
    const loaded = await load();

    operations.heartbeat(operationId, { phase: 'stage', progress: 0.2 });
    const staged = await templates.stageServer({
      parentDir,
      operationId,
      files: loaded.files,
      content: loaded.content,
      placeholders,
      onProgress: ({ index, total }) => operations.heartbeat(operationId, {
        phase: 'resolve-content',
        progress: 0.2 + (0.4 * ((index + 1) / Math.max(1, total))),
      }),
    });

    try {
      operations.heartbeat(operationId, { phase: 'resolve-runtime', progress: 0.65 });
      const runtime = await prepareRuntime(staged.staged, loaded.manifest);

      // Cooperative cancellation: this is the last point before the commit
      // boundary, so it is the last point we advertise cancellation.
      if (cancelled(operationId)) {
        fs.rmSync(staged.staged, { recursive: true, force: true });
        return { cancelled: true };
      }

      operations.heartbeat(operationId, { phase: 'promote', progress: 0.85 });
      templates.promote(staged.staged, destination);

      try {
        operations.heartbeat(operationId, { phase: 'register', progress: 0.95 });
        const server = registerCreated({ name, dir: destination, manifest: loaded.manifest, runtime });
        for (const item of staged.content) {
          recordProvenance({
            serverId: server.id,
            relativePath: item.path,
            kind: item.kind,
            projectId: item.projectId,
            versionId: item.versionId,
            mcVersion: item.mcVersion,
            loader: item.loader,
            sha256: item.sha256,
          });
        }
        operations.finish(operationId, { templateId: templateId || null, sourceServerId: sourceServerId || null, serverId: server.id });
        return { server };
      } catch (err) {
        // Promoted but not registered. The folder on disk is a real, complete
        // server root - deleting it would destroy work the user can still use,
        // so we hand it to the recovery flow instead.
        operations.markRecoveryRequired(operationId, {
          code: err.code || 'registration_failed',
          text: 'The server folder was created but could not be registered.',
          recovery: {
            action: 'register-or-discard',
            promotedDir: destination,
            name,
            templateId: templateId || null,
            instructions: 'Register the created folder after validation, or discard it.',
          },
        });
        return { recoveryRequired: true, destination };
      }
    } catch (err) {
      fs.rmSync(staged.staged, { recursive: true, force: true });
      throw err;
    }
  }

  /*
   * Start the operation, answer 202, and let the runner drive it to a terminal
   * state. A replayed Idempotency-Key answers with the operation it already
   * started rather than building a second server.
   */
  function dispatch(req, res, { kind, action, sourceServerId, templateId, load, summary }) {
    const key = idempotencyKey(req);
    if (!key) {
      return res.status(400).json({ error: 'This request requires an Idempotency-Key header.', code: 'idempotency_key_required' });
    }
    const parentDir = String(req.body?.parentDir || '');
    if (!parentDir || !fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) {
      return res.status(400).json({ error: 'Destination folder was not found.', code: 'destination_missing' });
    }
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Give the new server a name.', code: 'name_required' });

    const op = operations.create({ kind, actorId: req.user.id, serverId: sourceServerId || null, idempotencyKey: key, summary });
    if (op.state !== operations.STATES.QUEUED) {
      return res.status(202).json({ ok: true, operationId: op.id, replay: true, state: op.state });
    }
    if (!operations.acquireServerLock(op.id, sourceServerId || null)) {
      operations.fail(op.id, { code: 'server_busy', text: 'Another operation is running on this server.' });
      return res.status(409).json({ error: 'Another operation is running on this server.', code: 'server_busy' });
    }

    operations.start(op.id, { phase: 'revalidate' });
    record(req, { serverId: sourceServerId, action, outcome: 'started', operationId: op.id, target: { templateId: templateId || null, name } });

    run({
      operationId: op.id,
      load,
      parentDir,
      name,
      placeholders: req.body?.placeholders,
      sourceServerId,
      templateId,
    })
      .then((result) => record(req, {
        serverId: sourceServerId,
        action,
        outcome: result.cancelled ? 'cancelled' : result.recoveryRequired ? 'recovery_required' : 'success',
        operationId: op.id,
        target: { templateId: templateId || null, name, serverId: result.server ? result.server.id : null },
      }))
      .catch((err) => {
        operations.fail(op.id, { code: err.code || 'template_failed', text: err.message });
        record(req, {
          serverId: sourceServerId,
          action,
          outcome: 'failure',
          operationId: op.id,
          target: { templateId: templateId || null, name, code: err.code || 'template_failed' },
        });
      });

    res.status(202).json({ ok: true, operationId: op.id });
  }

  return { sourceAllowed, canManage, canCurate, dispatch, record, isLiveOperation };
}

/*
 * /api/templates
 */
function router(deps) {
  const r = express.Router();
  const { sourceAllowed, canManage, canCurate, dispatch, record } = build(deps);

  r.get('/', (req, res) => {
    const { items, nextCursor } = templates.list({ cursor: req.query.cursor, limit: Math.min(200, parseInt(req.query.limit, 10) || 50) });
    res.json({
      templates: items.filter((item) => !item.source_server_id || sourceAllowed(req.user, item.source_server_id)),
      nextCursor,
    });
  });

  r.get('/:id/preview', (req, res) => {
    try {
      const result = templates.inspect(req.params.id);
      if (result.template.sourceServerId && !sourceAllowed(req.user, result.template.sourceServerId)) {
        return deny(res, CAPABILITIES.SERVER_VIEW);
      }
      result.versions = templates.versions(req.params.id);
      res.json(result);
    } catch (err) { sendError(res, err); }
  });

  r.post('/preview', (req, res) => {
    try {
      const server = deps.findServer(String(req.body?.serverId || ''));
      if (!server) return res.status(404).json({ error: 'Server not found.' });
      if (!canCurate(req.user, server.id)) return deny(res, CAPABILITIES.CONTENT_VIEW);
      res.json({ manifest: templates.buildPreview(server, req.body || {}).manifest });
    } catch (err) { sendError(res, err); }
  });

  r.post('/', async (req, res) => {
    try {
      const server = deps.findServer(String(req.body?.serverId || ''));
      if (!server) return res.status(404).json({ error: 'Server not found.' });
      if (!canCurate(req.user, server.id)) return deny(res, CAPABILITIES.CONTENT_VIEW);
      const result = await templates.create({
        server,
        name: req.body?.name,
        description: req.body?.description,
        actorId: req.user.id,
        templateId: req.body?.templateId || null,
      });
      res.status(201).json({ ok: true, template: result });
    } catch (err) { sendError(res, err); }
  });

  r.get('/:id/export', (req, res) => {
    try {
      const row = templates.latest(req.params.id);
      if (!row) return res.status(404).json({ error: 'Template not found.' });
      if (!canCurate(req.user, row.source_server_id)) return deny(res, CAPABILITIES.CONTENT_VIEW);
      const file = templates.archivePath(row);
      const safeName = String(row.name).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'template';
      record(req, {
        serverId: row.source_server_id,
        action: 'templates.export',
        outcome: 'success',
        target: { templateId: row.id, version: row.version },
      });
      res.download(file, `${safeName}-v${row.version}-template.zip`);
    } catch (err) { sendError(res, err); }
  });

  r.post('/import/preview', upload.single('file'), async (req, res) => {
    const discard = () => { if (req.file?.path) fs.rmSync(req.file.path, { force: true }); };
    if (req.user?.role !== 'admin') { discard(); return deny(res, CAPABILITIES.SERVER_MANAGE); }
    try {
      res.json(await templates.importPreview(req.file?.path, req.user.id));
    } catch (err) { discard(); sendError(res, err); }
  });

  r.post('/import', async (req, res) => {
    if (req.user?.role !== 'admin') return deny(res, CAPABILITIES.SERVER_MANAGE);
    try {
      const result = await templates.confirmImport(String(req.body?.token || ''), req.user.id, req.body || {});
      res.status(201).json({ ok: true, template: result });
    } catch (err) { sendError(res, err); }
  });

  r.post('/:id/instantiate', (req, res) => {
    const row = templates.latest(req.params.id);
    if (!row) return res.status(404).json({ error: 'Template not found.' });
    if (row.source_server_id && !sourceAllowed(req.user, row.source_server_id)) return deny(res, CAPABILITIES.SERVER_VIEW);
    if (!canManage(req.user, row.source_server_id)) return deny(res, CAPABILITIES.SERVER_MANAGE);
    dispatch(req, res, {
      kind: 'template-instantiate',
      action: 'templates.instantiate',
      sourceServerId: row.source_server_id,
      templateId: row.id,
      summary: { templateId: row.id, version: row.version },
      load: () => templates.loadForInstantiate(row),
    });
  });

  /*
   * Recovery for an instantiation that promoted its folder but failed to
   * register it. `register` re-runs registration against the folder on disk;
   * `discard` deletes the folder we created. Nothing else may be targeted:
   * the path comes from the operation's own recovery record, never the request.
   */
  r.post('/operations/:id/recover', (req, res) => {
    const op = operations.get(req.params.id);
    if (!op || !op.recovery || !op.recovery.promotedDir) return res.status(404).json({ error: 'No recoverable operation was found.' });
    if (op.state !== operations.STATES.RECOVERY_REQUIRED) return res.status(409).json({ error: 'This operation does not need recovery.', state: op.state });
    if (req.user?.role !== 'admin' && op.actorId !== req.user?.id) return deny(res, CAPABILITIES.SERVER_MANAGE);
    if (!canManage(req.user, op.serverId)) return deny(res, CAPABILITIES.SERVER_MANAGE);

    const action = String(req.body?.action || '');
    const dir = op.recovery.promotedDir;
    try {
      if (action === 'register') {
        if (!fs.existsSync(dir)) return res.status(409).json({ error: 'The created folder is no longer on disk.', code: 'promoted_dir_missing' });
        if (deps.isRegisteredDir(dir)) return res.status(409).json({ error: 'That folder is already registered.', code: 'already_registered' });
        const manifest = op.summary && op.summary.manifest ? op.summary.manifest : {};
        operations.start(op.id, { phase: 'register' });
        const server = deps.registerExisting({ name: op.recovery.name, dir, manifest });
        operations.finish(op.id, { serverId: server.id, recovered: true });
        record(req, { serverId: op.serverId, action: 'templates.recover', outcome: 'success', operationId: op.id, target: { mode: 'register', serverId: server.id } });
        return res.json({ ok: true, server });
      }
      if (action === 'discard') {
        if (deps.isRegisteredDir(dir)) return res.status(409).json({ error: 'That folder is registered; delete the server instead.', code: 'already_registered' });
        fs.rmSync(dir, { recursive: true, force: true });
        // Re-enter the state machine so a recovery_required operation can reach
        // a terminal state: cancel() only accepts a queued or running operation.
        operations.start(op.id, { phase: 'discard' });
        operations.cancel(op.id);
        record(req, { serverId: op.serverId, action: 'templates.recover', outcome: 'discarded', operationId: op.id, target: { mode: 'discard' } });
        return res.json({ ok: true });
      }
      return res.status(400).json({ error: 'Choose register or discard.', code: 'invalid_action' });
    } catch (err) { sendError(res, err); }
  });

  r.delete('/:id', (req, res) => {
    try {
      const row = templates.latest(req.params.id);
      if (!row) return res.status(404).json({ error: 'Template not found.' });
      if (!canCurate(req.user, row.source_server_id)) return deny(res, CAPABILITIES.CONTENT_VIEW);
      templates.remove(req.params.id);
      res.json({ ok: true });
    } catch (err) { sendError(res, err); }
  });

  return r;
}

/*
 * The clone routes live under /api/servers/:id, because that is what they act
 * on, but they are the same pipeline: a clone is an unnamed template that is
 * built and instantiated in one step.
 */
function cloneRouter(deps) {
  const r = express.Router();
  const { canManage, dispatch } = build(deps);

  r.post('/:id/clone-preview', (req, res) => {
    try {
      const source = deps.findServer(req.params.id);
      if (!source) return res.status(404).json({ error: 'Server not found.' });
      if (!canManage(req.user, source.id)) return deny(res, CAPABILITIES.SERVER_MANAGE);
      const name = String(req.body?.name || `${source.name} clone`);
      res.json({ manifest: templates.buildPreview(source, { name }).manifest });
    } catch (err) { sendError(res, err); }
  });

  r.post('/:id/clone', (req, res) => {
    const source = deps.findServer(req.params.id);
    if (!source) return res.status(404).json({ error: 'Server not found.' });
    if (!canManage(req.user, source.id)) return deny(res, CAPABILITIES.SERVER_MANAGE);
    dispatch(req, res, {
      kind: 'template-clone',
      action: 'servers.clone',
      sourceServerId: source.id,
      summary: { sourceServerId: source.id },
      load: async () => {
        const preview = templates.buildPreview(source, { name: req.body?.name });
        if (!preview.files.length) {
          throw Object.assign(new Error('No portable configuration files were found.'), { status: 400, code: 'empty_template' });
        }
        return { manifest: preview.manifest, files: preview.files, content: preview.manifest.content || [] };
      },
    });
  });

  return r;
}

module.exports = { router, cloneRouter };
