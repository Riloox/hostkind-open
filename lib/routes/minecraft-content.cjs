'use strict';

/*
 * GET  /api/minecraft/content/providers                       - content providers
 * GET  /api/minecraft/content/search                          - Modrinth catalog search
 * GET  /api/minecraft/content/projects/:provider/:projectId/versions - catalog versions
 * GET  /api/modrinth/search                                   - loader-aware Modrinth search
 * GET  /api/modrinth/versions/:projectId                      - loader-aware version list
 * POST /api/modrinth/install-batch                            - multi-project install
 * POST /api/modrinth/install                                  - single-version install
 *
 * Mounted at /api, so router paths carry the full sub-path.
 * Thin HTTP layer over lib/minecraft-content.cjs and lib/modrinth-batch.cjs;
 * the server registry, compat detection, and Modrinth constants arrive as
 * injected factory deps so server.js keeps owning them.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const minecraftContent = require('../minecraft-content.cjs');
const { installBatch: installModrinthBatch } = require('../modrinth-batch.cjs');
const updateCenter = require('../updates.cjs');

module.exports = function minecraftContentRouter(deps) {
  const {
    targetManager, detectCompat, isAdmin, tErr, httpError,
    sanitizeErrorMessage, log, addNotification,
    MODRINTH, UA, MODRINTH_SORTS, MODRINTH_CATEGORIES,
  } = deps;
  const router = express.Router();

  // Provider-neutral Minecraft content API. Modrinth remains the only catalog
  // provider; CurseForge and FTB deliberately expose import/install
  // capabilities without pretending that Hostkind has catalog credentials.
  router.get('/minecraft/content/providers', (req, res) => {
    res.json({ providers: minecraftContent.listProviders({ isAdmin: isAdmin(req.user) }) });
  });

  router.get('/minecraft/content/search', async (req, res) => {
    const providerId = String(req.query.provider || 'modrinth').toLowerCase();
    if (providerId !== 'modrinth') return res.status(400).json({ error: 'Catalog browsing is available only for Modrinth.', code: 'catalog_unavailable' });
    const m = targetManager(req); const compat = detectCompat(m);
    const kind = ['plugin', 'mod', 'modpack'].includes(String(req.query.kind || req.query.projectType)) ? String(req.query.kind || req.query.projectType) : compat.projectType;
    if (!kind) return res.json({ hits: [], compat, provider: 'modrinth' });
    const facets = [[`project_type:${kind}`]];
    if (kind !== 'modpack') {
      const loaders = kind === 'plugin' ? ['paper', 'spigot', 'bukkit'] : (compat.canMods ? compat.loaders : ['fabric', 'forge', 'neoforge', 'quilt']);
      facets.push(loaders.map((loader) => `categories:${loader}`));
      if (compat.mcVersion) facets.push([`versions:${compat.mcVersion}`]);
    }
    const sort = MODRINTH_SORTS.includes(req.query.sort) ? req.query.sort : 'downloads';
    const url = `${MODRINTH}/search?query=${encodeURIComponent(req.query.q || '')}&facets=${encodeURIComponent(JSON.stringify(facets))}&index=${sort}&limit=30`;
    try {
      const response = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!response.ok) throw new Error(`Modrinth returned HTTP ${response.status}`);
      const data = await response.json();
      res.json({ provider: 'modrinth', projects: (data.hits || []).map((item) => minecraftContent.normalizeProject(item)), pagination: { offset: data.offset || 0, limit: data.limit || 30, total: data.total_hits || 0 }, compat });
    } catch (error) { httpError(res, req, error, 502); }
  });

  router.get('/minecraft/content/projects/:provider/:projectId/versions', async (req, res) => {
    if (String(req.params.provider).toLowerCase() !== 'modrinth') return res.status(400).json({ error: 'Catalog versions are available only for Modrinth.', code: 'catalog_unavailable' });
    const compat = detectCompat(targetManager(req));
    const query = new URLSearchParams();
    if (compat.loaders.length) query.set('loaders', JSON.stringify(compat.loaders));
    if (compat.mcVersion) query.set('game_versions', JSON.stringify([compat.mcVersion]));
    try {
      const response = await fetch(`${MODRINTH}/project/${encodeURIComponent(req.params.projectId)}/version?${query}`, { headers: { 'User-Agent': UA } });
      if (!response.ok) throw new Error(`Modrinth returned HTTP ${response.status}`);
      const versions = await response.json();
      res.json({ provider: 'modrinth', versions: (Array.isArray(versions) ? versions : []).map((item) => minecraftContent.normalizeVersion(item)) });
    } catch (error) { httpError(res, req, error, 502); }
  });

  router.get('/modrinth/search', async (req, res) => {
    const m = targetManager(req);
    const compat = detectCompat(m);
    // `projectType` (optional) lets the caller force 'mod', 'plugin', or
    // 'modpack' so all tabs of the content view can reuse this endpoint
    // regardless of the active server's loader. Without an override we keep
    // the historical behaviour of matching the server's own project type.
    const overrideType = String(req.query.projectType || '');
    const projectType = overrideType === 'mod' || overrideType === 'plugin' || overrideType === 'modpack' ? overrideType : compat.projectType;
    if (!projectType) {
      return res.json({ hits: [], compat, note: tErr(req.user, 'errors.vanillaNoPlugins') });
    }
    // Pick the loader facet for the requested project type: when the user is
    // looking at the Mods tab on a Paper server (e.g. browsing a Fabric mod
    // pack reference) we fall back to the full mod-loader union so they still
    // see fabric/forge/neoforge results. The Modpacks tab omits the loader
    // facet entirely so modpacks for any loader surface.
    let loadersForQuery = compat.loaders;
    if (projectType === 'mod') {
      loadersForQuery = compat.canMods ? compat.loaders : ['fabric', 'forge', 'neoforge', 'quilt'];
    } else if (projectType === 'plugin') {
      loadersForQuery = ['paper', 'spigot', 'bukkit'];
    }
    const q = req.query.q || '';
    const sort = MODRINTH_SORTS.includes(req.query.sort) ? req.query.sort : 'downloads';
    const facets = [
      [`project_type:${projectType}`],
    ];
    if (projectType !== 'modpack') {
      facets.push(loadersForQuery.map((l) => `categories:${l}`));
      if (compat.mcVersion) facets.push([`versions:${compat.mcVersion}`]);
    }
    if (req.query.category && MODRINTH_CATEGORIES.includes(req.query.category)) {
      facets.push([`categories:${req.query.category}`]);
    }
    const url = `${MODRINTH}/search?query=${encodeURIComponent(q)}&facets=${encodeURIComponent(JSON.stringify(facets))}&index=${sort}&limit=30`;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      const data = await r.json();
      res.json({ ...data, compat, projectType, categories: MODRINTH_CATEGORIES });
    } catch (err) {
      httpError(res, req, err, 502);
    }
  });

  router.get('/modrinth/versions/:projectId', async (req, res) => {
    const m = targetManager(req);
    const compat = detectCompat(m);
    const loaders = JSON.stringify(compat.loaders);
    const gv = JSON.stringify(compat.mcVersion ? [compat.mcVersion] : []);
    const url = `${MODRINTH}/project/${encodeURIComponent(req.params.projectId)}/version?loaders=${encodeURIComponent(loaders)}&game_versions=${encodeURIComponent(gv)}`;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      const matched = await r.json();
      res.json({ matched: Array.isArray(matched) ? matched : [], compat });
    } catch (err) {
      httpError(res, req, err, 502);
    }
  });

  router.post('/modrinth/install-batch', async (req, res) => {
    const m = targetManager(req);
    if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    const body = req.body || {};
    const compat = detectCompat(m);
    const requestedType = String(body.projectType || '');
    if (requestedType === 'mod' && !compat.canMods) {
      return res.status(409).json({ error: tErr(req.user, 'minecraft.modrinth.tabModsDisabledBody', { label: compat.label }) });
    }
    try {
      const result = await installModrinthBatch({
        projectIds: body.projectIds,
        compat,
        rootDir: m.dir(),
        recordImpl: (entry) => updateCenter.recordModrinth({ ...entry, serverId: m.id }),
      });
      for (const item of result.results.filter((candidate) => candidate.status === 'installed')) {
        log(`Modrinth: installed ${item.name} into ${compat.folder}/ for "${m.name()}"`);
        m.pushLine(`[Hostkind] Installed from Modrinth into ${compat.folder}/: ${item.name}`, 'info');
      }
      if (result.installed.length) {
        addNotification('plugin_installed', 'Content installed', `${result.installed.length} selected Modrinth item(s) installed for "${m.name()}". Restart the server to apply.`, m.id);
      }
      res.json({ ...result, note: 'Restart the server to apply.' });
    } catch (err) {
      log(`Modrinth batch install failed: ${err.message}`);
      const clientError = ['invalid_project_ids', 'empty_selection', 'selection_too_large', 'invalid_install_target'].includes(err.code);
      res.status(clientError ? 400 : 502).json({ error: sanitizeErrorMessage(err.message), code: err.code || 'modrinth_batch_failed' });
    }
  });

  router.post('/modrinth/install', async (req, res) => {
    const { versionId } = req.body || {};
    if (!versionId) return res.status(400).json({ error: tErr(req.user, 'errors.missingVersionId') });
    const m = targetManager(req);
    if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    const compat = detectCompat(m);
    try {
      log(`Modrinth: resolving version ${versionId} for "${m.name()}" (${compat.label})...`);
      const r = await fetch(`${MODRINTH}/version/${encodeURIComponent(versionId)}`, { headers: { 'User-Agent': UA } });
      const version = await r.json();
      // Compatibility guard: refuse anything that doesn't match this server's
      // loader and Minecraft version, so an incompatible jar can't be installed.
      const loaderOk = (version.loaders || []).some((l) => compat.loaders.includes(l));
      const versionOk = !compat.mcVersion || (version.game_versions || []).includes(compat.mcVersion);
      if (!loaderOk || !versionOk) {
        return res.status(409).json({ error: tErr(req.user, 'errors.incompatible', { label: compat.label, version: compat.mcVersion || '' }) });
      }
      const file = (version.files || []).find((f) => f.primary) || (version.files || [])[0];
      if (!file) return res.status(404).json({ error: tErr(req.user, 'errors.noVersionFiles') });
      log(`Modrinth: downloading ${file.filename}...`);
      const dl = await fetch(file.url, { headers: { 'User-Agent': UA } });
      if (!dl.ok) return res.status(502).json({ error: `Download failed: HTTP ${dl.status}` });
      const buf = Buffer.from(await dl.arrayBuffer());
      const pdir = path.join(m.dir(), compat.folder);
      fs.mkdirSync(pdir, { recursive: true });
      const dest = path.join(pdir, path.basename(file.filename));
      fs.writeFileSync(dest, buf);
      updateCenter.recordModrinth({
        serverId: m.id,
        relativePath: path.relative(m.dir(), dest).split(path.sep).join('/'),
        kind: compat.folder === 'mods' ? 'mod' : 'plugin',
        projectId: version.project_id,
        versionId: version.id,
        mcVersion: compat.mcVersion,
        loader: (version.loaders || []).find((l) => compat.loaders.includes(l)),
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      });
      log(`Modrinth: installed ${file.filename} into ${compat.folder}/ for "${m.name()}"`);
      m.pushLine(`[Hostkind] Installed from Modrinth into ${compat.folder}/: ${file.filename}`, 'info');
      addNotification('plugin_installed', 'Plugin Installed', `"${file.filename}" installed into ${compat.folder}/ for "${m.name()}". Restart the server to apply.`, m.id);
      res.json({ ok: true, name: file.filename, note: 'Restart the server to apply.' });
    } catch (err) {
      log(`Modrinth install failed: ${err.message}`);
      res.status(502).json({ error: sanitizeErrorMessage(err.message) });
    }
  });

  return router;
};
