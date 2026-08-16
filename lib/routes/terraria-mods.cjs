'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const terrariaMods = require('../terraria-mods.cjs');
const audit = require('../audit.cjs');
const operations = require('../operations.cjs');
const { CAPABILITIES, requireCap } = require('../capabilities.cjs');

module.exports = function terrariaModsRouter(deps) {
  const router = express.Router();
  const sid = (req) => (req.query && req.query.serverId) || (req.body && req.body.serverId) || deps.activeServerId();
  const scope = { getServerId: sid };
  const send = (res, error) => res.status(error.status || 500).json({ error: error.message, code: error.code });
  const keyOf = (req) => String(req.get('Idempotency-Key') || '').trim();
  const uploadRoot = path.join(os.tmpdir(), 'fleetdeck-terraria-uploads');
  fs.mkdirSync(uploadRoot, { recursive: true });
  const upload = multer({
    dest: uploadRoot,
    limits: { files: 1, fileSize: 2 * 1024 * 1024 * 1024 },
    fileFilter: (_req, file, done) => done(null, /\.(?:tmod|zip)$/i.test(file.originalname)),
  });
  // multer writes every upload under uploadRoot with a random 32-hex name.
  // Cleanup (rate-limit rejection and the handler's finally) must stay inside
  // that directory; the resolve + startsWith guard is the sanitizer CodeQL
  // js/path-injection recognizes at the unlink sink.
  function stagedUploadPath(file) {
    if (!file || typeof file.path !== 'string' || !file.path) return null;
    const candidate = path.resolve(file.path);
    const root = path.resolve(uploadRoot);
    if (candidate.startsWith(root + path.sep)) return candidate;
    return null;
  }
  function rateLimited(req, res) {
    const info = req.rateLimit;
    const ms = info && info.resetTime ? info.resetTime.getTime() - Date.now() : 60_000;
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(ms / 1000))));
    res.status(429).json({ error: 'Too many import previews. Try again shortly.', code: 'rate_limited' });
  }
  // Import previews write the uploaded file to disk (multer) before parsing;
  // bound how often one account may stage an upload (CodeQL js/missing-rate-limiting).
  // Runs after multer so req.file (and its cleanup) and the parsed form body
  // are available; the handler removes the staged file on rejection so a
  // rate-limited request cannot leak disk.
  const limitImportPreviews = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const server = deps.findServer(sid(req));
      return `${req.user.id}:${server ? server.id : 'unknown'}`;
    },
    handler: (req, res) => {
      const staged = stagedUploadPath(req.file);
      if (staged) { try { fs.unlinkSync(staged); } catch (_) { /* best effort */ } }
      rateLimited(req, res);
    },
  });

  function mutate(req, res, server, kind, summary, run) {
    if (!keyOf(req)) {
      res.status(400).json({ error: 'An Idempotency-Key header is required for this request.', code: 'idempotency_key_required' });
      return null;
    }
    const existing = operations.create({
      kind, actorId: req.user.id, serverId: server.id, idempotencyKey: keyOf(req), summary,
    });
    if (existing.state !== 'queued') {
      res.status(202).json({ ok: true, operationId: existing.id, replay: true, state: existing.state });
      return null;
    }
    operations.start(existing.id, { phase: 'snapshot' });
    try {
      const result = run();
      operations.finish(existing.id, { ...summary, restartRequired: Boolean(result.restartRequired) });
      return { ...result, operationId: existing.id };
    } catch (error) {
      operations.fail(existing.id, { code: error.code || 'terraria_mod_failed', text: error.message });
      throw error;
    }
  }

  function serverOf(req, res) {
    const server = deps.findServer(sid(req));
    if (!server || server.type !== 'terraria' || server.terrariaVariant !== 'tmodloader') {
      res.status(404).json({ error: 'tModLoader server not found.' });
      return null;
    }
    return server;
  }

  function record(req, server, action, outcome, metadata = {}) {
    audit.record({
      actorId: req.user.id,
      actorUsername: req.user.username,
      serverId: server.id,
      action,
      targetType: 'terraria-mod',
      targetId: metadata.mod || null,
      outcome,
      requestId: req.requestId,
      metadata,
    });
  }

  router.get('/', requireCap(CAPABILITIES.CONTENT_VIEW, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      const inventory = terrariaMods.inventory(server);
      res.json({ ok: true, ...inventory, diagnostics: terrariaMods.diagnostics(server, inventory), trash: terrariaMods.listTrash(server) });
    } catch (error) { send(res, error); }
  });

  router.get('/diagnostics', requireCap(CAPABILITIES.CONTENT_VIEW, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try { res.json({ ok: true, ...terrariaMods.diagnostics(server) }); }
    catch (error) { send(res, error); }
  });

  router.post('/import/preview', upload.single('file'), requireCap(CAPABILITIES.PLUGINS_MANAGE, scope), limitImportPreviews, async (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    if (!req.file) return res.status(400).json({ error: 'Choose a .tmod or .zip file.', code: 'file_required' });
    try {
      const preview = await terrariaMods.previewImport({
        desc: server, actorId: req.user.id, manager: deps.getManager(server.id),
        uploadPath: req.file.path, originalName: req.file.originalname,
      });
      res.json({ ok: true, preview });
    } catch (error) { send(res, error); }
    finally {
      const staged = stagedUploadPath(req.file);
      if (staged) { try { fs.unlinkSync(staged); } catch (_) { /* best effort */ } }
    }
  });

  router.post('/import', requireCap(CAPABILITIES.PLUGINS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      const result = mutate(req, res, server, 'terraria-mod-import', { action: 'import' }, () => (
        terrariaMods.applyImport({
          desc: server, actorId: req.user.id, manager: deps.getManager(server.id),
          token: req.body?.token, replace: req.body?.replace === true,
        })
      ));
      if (!result) return;
      record(req, server, 'terraria.mods.import', 'success', { count: result.installed.length });
      res.status(202).json(result);
    } catch (error) { send(res, error); }
  });

  router.post('/workshop/resolve', requireCap(CAPABILITIES.CONTENT_VIEW, scope), async (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try { res.json({ ok: true, item: await terrariaMods.resolveWorkshop(req.body?.value) }); }
    catch (error) { send(res, error); }
  });

  router.get('/workshop/catalog', requireCap(CAPABILITIES.CONTENT_VIEW, scope), async (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      res.json(await terrariaMods.workshopCatalog({
        query: req.query.q,
        page: req.query.page,
        sort: req.query.sort,
        tag: req.query.tag,
        force: req.query.force === '1',
      }));
    } catch (error) { send(res, error); }
  });

  router.post('/workshop/install', requireCap(CAPABILITIES.PLUGINS_MANAGE, scope), async (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      const preview = await terrariaMods.downloadWorkshop({
        desc: server, actorId: req.user.id, manager: deps.getManager(server.id),
        value: req.body?.value, cacheDir: deps.cacheDir(), download: deps.download,
      });
      record(req, server, 'terraria.mods.workshop.preview', 'success', { workshopId: preview.detail.id });
      res.json({ ok: true, preview });
    } catch (error) { send(res, error); }
  });

  router.get('/updates', requireCap(CAPABILITIES.CONTENT_VIEW, scope), async (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try { res.json({ ok: true, ...await terrariaMods.updates(server, { force: req.query.force === 'true' }) }); }
    catch (error) { send(res, error); }
  });

  router.get('/modpacks', requireCap(CAPABILITIES.CONTENT_VIEW, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try { res.json({ ok: true, packs: terrariaMods.listPacks(server) }); }
    catch (error) { send(res, error); }
  });

  router.post('/modpacks', requireCap(CAPABILITIES.PLUGINS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      const pack = req.body?.document
        ? terrariaMods.importPack(server, req.body.document)
        : terrariaMods.capturePack(server, req.body?.name);
      record(req, server, 'terraria.modpacks.create', 'success', { packId: pack.id });
      res.status(201).json({ ok: true, pack });
    } catch (error) { send(res, error); }
  });

  router.get('/modpacks/:id/export', requireCap(CAPABILITIES.CONTENT_VIEW, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      const document = terrariaMods.exportPack(server, req.params.id);
      res.setHeader('Content-Disposition', `attachment; filename="${String(document.pack.name).replace(/[^a-z0-9_-]+/gi, '-')}.json"`);
      res.json(document);
    } catch (error) { send(res, error); }
  });

  router.post('/modpacks/:id/apply/preview', requireCap(CAPABILITIES.PLUGINS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      res.json({ ok: true, preview: terrariaMods.previewPack({
        desc: server, actorId: req.user.id, manager: deps.getManager(server.id), id: req.params.id,
      }) });
    } catch (error) { send(res, error); }
  });

  router.post('/modpacks/:id/apply', requireCap(CAPABILITIES.PLUGINS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      const result = mutate(req, res, server, 'terraria-modpack-apply', { packId: req.params.id }, () => (
        terrariaMods.applyPack({
          desc: server, actorId: req.user.id, manager: deps.getManager(server.id),
          token: req.body?.token, servers: deps.allServers(),
        })
      ));
      if (!result) return;
      record(req, server, 'terraria.modpacks.apply', 'success', { packId: req.params.id });
      res.status(202).json(result);
    } catch (error) { send(res, error); }
  });

  router.delete('/modpacks/:id', requireCap(CAPABILITIES.PLUGINS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      const result = terrariaMods.deletePack(server, req.params.id);
      record(req, server, 'terraria.modpacks.delete', 'success', { packId: req.params.id });
      res.json(result);
    } catch (error) { send(res, error); }
  });

  function enabledHandler(enabled) {
    return (req, res) => {
      const server = serverOf(req, res);
      if (!server) return;
      const action = enabled ? 'enable' : 'disable';
      try {
        if (!req.body?.token) {
          return res.json({ ok: true, preview: terrariaMods.makePreview({
            desc: server, actorId: req.user.id, action, name: req.params.name, manager: deps.getManager(server.id),
          }) });
        }
        const result = mutate(req, res, server, `terraria-mod-${action}`, { mod: req.params.name, action }, () => (
          terrariaMods.setEnabled({
            desc: server, actorId: req.user.id, token: req.body.token, name: req.params.name,
            enabled, manager: deps.getManager(server.id),
          })
        ));
        if (!result) return;
        record(req, server, `terraria.mods.${action}`, 'success', { mod: req.params.name });
        res.status(202).json(result);
      } catch (error) {
        record(req, server, `terraria.mods.${action}`, 'failure', { mod: req.params.name, code: error.code || 'failed' });
        send(res, error);
      }
    };
  }

  router.post('/:name/enable', requireCap(CAPABILITIES.PLUGINS_MANAGE, scope), enabledHandler(true));
  router.post('/:name/disable', requireCap(CAPABILITIES.PLUGINS_MANAGE, scope), enabledHandler(false));

  router.delete('/:name', requireCap(CAPABILITIES.PLUGINS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      if (!req.body?.token) {
        return res.json({ ok: true, preview: terrariaMods.makePreview({
          desc: server, actorId: req.user.id, action: 'remove', name: req.params.name, manager: deps.getManager(server.id),
        }) });
      }
      const result = mutate(req, res, server, 'terraria-mod-remove', { mod: req.params.name, action: 'remove' }, () => (
        terrariaMods.remove({
          desc: server, actorId: req.user.id, token: req.body.token, name: req.params.name,
          manager: deps.getManager(server.id), servers: deps.allServers(),
        })
      ));
      if (!result) return;
      record(req, server, 'terraria.mods.remove', 'success', { mod: req.params.name, trashId: result.trash.id });
      res.status(202).json(result);
    } catch (error) {
      record(req, server, 'terraria.mods.remove', 'failure', { mod: req.params.name, code: error.code || 'failed' });
      send(res, error);
    }
  });

  router.post('/trash/:id/restore', requireCap(CAPABILITIES.PLUGINS_MANAGE, scope), (req, res) => {
    const server = serverOf(req, res);
    if (!server) return;
    try {
      const result = terrariaMods.restore({
        desc: server, manager: deps.getManager(server.id), trashId: req.params.id, servers: deps.allServers(),
      });
      record(req, server, 'terraria.mods.restore', 'success', { trashId: req.params.id });
      res.json(result);
    } catch (error) { send(res, error); }
  });

  return router;
};
