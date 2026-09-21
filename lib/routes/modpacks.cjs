'use strict';

/*
 * POST /api/minecraft/content/previews                  - prepare a catalog/ftb install
 * POST /api/minecraft/content/upload-previews            - inspect an uploaded zip/jar/installer
 * POST /api/minecraft/content/previews/:previewId/apply  - apply a catalog preview
 * POST /api/minecraft/content/uploads/:operationId/apply - apply an inspected upload
 * GET  /api/minecraft/content/installed                  - provenance + modpack history
 * POST /api/modpacks/import/preview                      - preview a fresh modpack install
 * POST /api/modpacks/import                              - apply a fresh modpack install
 * GET  /api/modpacks/installed                           - managed modpack + history
 * POST /api/modpacks/update/preview                      - preview a modpack update
 * POST /api/modpacks/update                              - apply a modpack update
 * POST /api/modpacks/clone                               - clone a server without operator data
 * POST /api/modpacks/history/:id/rollback                - restore a modpack snapshot
 * GET  /api/modrinth/modpack/versions/:projectId         - modpack version list
 * GET  /api/modrinth/modpack/preview/:versionId          - mrpack spec preview
 * POST /api/modrinth/modpack/install                     - install a modpack (existing/new server)
 *
 * Mounted at /api, so router paths carry the full sub-path.
 * Thin HTTP layer over lib/modpacks.cjs, lib/curseforge-import.cjs,
 * lib/content-apply.cjs, lib/ftb-installer.cjs, and lib/mrpack.cjs; the
 * server registry, operations/snapshot pipeline, and server-creation
 * helpers arrive as injected factory deps so server.js keeps owning them.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const yauzl = require('yauzl');
const archiveGuard = require('../archiveGuard.cjs');
const modpackLifecycle = require('../modpacks.cjs');
const curseforgeImport = require('../curseforge-import.cjs');
const contentApply = require('../content-apply.cjs');
const ftbInstaller = require('../ftb-installer.cjs');
const {
  readMrpackIndex,
  manifestToSpec,
  serverSideFiles,
  fileCountByEnv,
  extractOverrides,
  downloadAndVerify,
  safeResolve: mrpackSafeResolve,
} = require('../mrpack.cjs');
const { open: openDb } = require('../db.cjs');

module.exports = function modpacksRouter(deps) {
  const {
    targetManager, getManager, detectCompat, isAdmin, tErr, httpError,
    sanitizeErrorMessage, log, addNotification, STATUS,
    config, saveConfig, serverWithStatus, slugify, genId,
    foundationOperations, foundationSnapshots,
    MODRINTH, UA, SERVER_NAME_MAX_LENGTH,
    resolveServerJar, downloadToFile, requiredJavaMajor, resolveJavaForServer,
    ensureRuntime, runForgeInstaller, findForgeLaunchTarget,
  } = deps;
  const router = express.Router();

  async function resolveLifecyclePack(versionId, worlds) {
    const response = await fetch(`${MODRINTH}/version/${encodeURIComponent(versionId)}`, { headers: { 'User-Agent': UA } });
    if (!response.ok) throw new Error(`Modrinth version lookup failed: HTTP ${response.status}`);
    const version = await response.json();
    const archive = (version.files || []).find((f) => f.primary) || (version.files || [])[0];
    if (!archive) throw new Error('No version files found');
    const archiveResponse = await fetch(archive.url, { headers: { 'User-Agent': UA } });
    if (!archiveResponse.ok) throw new Error(`Download failed: HTTP ${archiveResponse.status}`);
    const mrpack = Buffer.from(await archiveResponse.arrayBuffer());
    const index = await readMrpackIndex(mrpack);
    const spec = manifestToSpec(index);
    if (spec.unsupported) throw new Error(spec.reason || 'Unsupported modpack');
    const files = [];
    for (const item of serverSideFiles(index)) {
      const url = item.downloads && item.downloads[0];
      if (!url || !item.path) continue;
      const buffer = await downloadAndVerify(url, item.hashes, UA);
      files.push({
        relativePath: item.path,
        sizeBytes: buffer.length,
        sha256: modpackLifecycle.sha256(buffer),
        sourceUrlHash: modpackLifecycle.sha256(url),
        url,
      });
    }
    const validated = modpackLifecycle.validateFiles(files, worlds);
    return { version, index, spec, files: validated.accepted, excluded: validated.excluded };
  }

  async function lifecyclePreview(req, res, kind) {
    try {
      const m = targetManager(req);
      if (!m || !m.dir()) return res.status(400).json({ error: 'No active server.' });
      const versionId = String((req.body || {}).versionId || '');
      if (!versionId) return res.status(400).json({ error: 'A version is required.' });
      const server = m.desc();
      const pack = await resolveLifecyclePack(versionId, server.worlds || []);
      const compat = detectCompat(m);
      if (!compat.loaders.includes(pack.spec.loaderType) || (compat.mcVersion && compat.mcVersion !== pack.spec.mcVersion)) {
        return res.status(409).json({ error: 'This modpack is not compatible with the server.' });
      }
      const previous = modpackLifecycle.latest(m.id);
      if (kind === 'update' && !previous) return res.status(409).json({ error: 'This server has no managed modpack.' });
      const oldFiles = previous ? previous.files.map((f) => ({ relativePath: f.relative_path, sha256: f.sha256, sizeBytes: f.size_bytes })) : [];
      const plan = modpackLifecycle.buildPlan({ root: m.dir(), oldFiles, newFiles: pack.files, worlds: server.worlds || [] });
      const projectId = String(pack.version.project_id || (req.body || {}).projectId || '');
      const previewId = modpackLifecycle.savePreview({ serverId: m.id, actorId: req.user.id, kind, projectId, versionId, mcVersion: pack.spec.mcVersion, loader: pack.spec.loaderType, previousManifestId: previous?.id || null, plan });
      res.json({ ok: true, previewId, projectId, versionId, mcVersion: pack.spec.mcVersion, loader: pack.spec.loaderType, groups: plan.groups, inventoryHash: plan.inventoryHash, compatibility: { ok: true }, downtime: m.status !== STATUS.OFFLINE, snapshot: { required: true } });
    } catch (err) {
      log(`Modpack ${kind} preview failed: ${err.message}`);
      res.status(502).json({ error: sanitizeErrorMessage(err.message) });
    }
  }

  async function lifecycleApply(req, res, kind) {
    const body = req.body || {};
    const loaded = modpackLifecycle.loadPreview(String(body.previewId || ''), req.user.id);
    if (!loaded || loaded.data.kind !== kind) return res.status(409).json({ error: 'Preview expired. Create a new preview.' });
    const m = getManager(loaded.data.serverId);
    if (!m || !m.dir()) return res.status(404).json({ error: 'Server not found.' });
    if (m.status !== STATUS.OFFLINE) return res.status(409).json({ error: 'The server must be offline.' });
    const operation = foundationOperations.create({ kind: `modpack-${kind}`, actorId: req.user.id, serverId: m.id, idempotencyKey: req.get('Idempotency-Key') || null, summary: { versionId: loaded.data.versionId } });
    if (operation.state !== foundationOperations.STATES.QUEUED) return res.status(202).json({ ok: true, operationId: operation.id });
    try {
      foundationOperations.start(operation.id, { phase: 'revalidate' });
      const server = m.desc();
      const pack = await resolveLifecyclePack(loaded.data.versionId, server.worlds || []);
      const previous = modpackLifecycle.latest(m.id);
      const oldFiles = previous ? previous.files.map((f) => ({ relativePath: f.relative_path, sha256: f.sha256, sizeBytes: f.size_bytes })) : [];
      const plan = modpackLifecycle.buildPlan({ root: m.dir(), oldFiles, newFiles: pack.files, worlds: server.worlds || [] });
      if (plan.inventoryHash !== loaded.row.inventory_hash) throw Object.assign(new Error('Server files changed after preview. Create a new preview.'), { status: 409 });
      const decisions = body.decisions && typeof body.decisions === 'object' && !Array.isArray(body.decisions) ? body.decisions : {};
      for (const conflict of plan.groups.conflicts) {
        if (!['keep_local', 'take_pack'].includes(decisions[conflict.relativePath])) throw Object.assign(new Error(`A decision is required for ${conflict.relativePath}.`), { status: 409 });
      }
      const snapshot = foundationSnapshots.take({ serverId: m.id, sourceDir: m.dir(), kind: 'modpack', reason: `${kind} ${loaded.data.versionId}` });
      if (!foundationSnapshots.verify(snapshot.id).ok) throw new Error('Snapshot verification failed.');
      const staging = path.join(m.dir(), '.lodestone', 'staging', operation.id);
      fs.mkdirSync(staging, { recursive: true });
      const incoming = new Map(pack.files.map((f) => [f.relativePath, f]));
      for (const entry of plan.entries) {
        const takePack = entry.state !== 'local_edit' && (entry.state !== 'conflict' || decisions[entry.relativePath] === 'take_pack');
        if (!takePack) continue;
        const item = incoming.get(entry.relativePath);
        if (!item) continue;
        const buffer = await downloadAndVerify(item.url, { sha256: item.sha256 }, UA);
        if (modpackLifecycle.sha256(buffer) !== item.sha256) throw new Error(`SHA-256 mismatch for ${item.relativePath}`);
        const staged = mrpackSafeResolve(staging, entry.relativePath);
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        fs.writeFileSync(staged, buffer);
      }
      if (m.status !== STATUS.OFFLINE) throw Object.assign(new Error('Server started during update.'), { status: 409 });
      const db = openDb();
      const insertDecision = db.prepare('INSERT OR REPLACE INTO modpack_conflict_decisions VALUES (?,?,?,?)');
      for (const [relativePath, decision] of Object.entries(decisions)) insertDecision.run(operation.id, relativePath, decision, req.user.id);
      for (const entry of plan.entries) {
        const takePack = entry.state !== 'local_edit' && (entry.state !== 'conflict' || decisions[entry.relativePath] === 'take_pack');
        if (!takePack) continue;
        const dest = mrpackSafeResolve(m.dir(), entry.relativePath);
        const staged = mrpackSafeResolve(staging, entry.relativePath);
        if (incoming.has(entry.relativePath)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(staged, dest);
        } else if (entry.state === 'safe_removal' && fs.existsSync(dest)) fs.unlinkSync(dest);
      }
      const owned = pack.files.filter((f) => {
        const e = plan.entries.find((x) => x.relativePath === f.relativePath);
        return e && e.state !== 'local_edit' && (e.state !== 'conflict' || decisions[e.relativePath] === 'take_pack');
      });
      const manifest = modpackLifecycle.persistManifest({ serverId: m.id, projectId: loaded.data.projectId, versionId: loaded.data.versionId, mcVersion: loaded.data.mcVersion, loader: loaded.data.loader, operationId: operation.id, snapshotId: snapshot.id, previousManifestId: previous?.id || null }, owned);
      fs.rmSync(staging, { recursive: true, force: true });
      foundationOperations.finish(operation.id, { manifestId: manifest.id });
      res.status(202).json({ ok: true, operationId: operation.id, manifestId: manifest.id });
    } catch (err) {
      foundationOperations.fail(operation.id, { code: 'modpack_apply_failed', text: err.message });
      log('modpack apply failed:', err.message);
      res.status(err.status || 500).json({ error: sanitizeErrorMessage(err.message), operationId: operation.id });
    }
  }

  const contentUploadRoot = path.join(__dirname, '..', '..', 'data', 'content-uploads');
  function cleanupUploadDir(filePath) {
    try {
      if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) return;
      const root = path.resolve(contentUploadRoot);
      const dir = path.resolve(path.dirname(filePath));
      if (dir === root) return;
      if (!dir.startsWith(root + path.sep)) return;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort cleanup only; never throw in guards/catch paths */ }
  }
  const contentUpload = multer({
    storage: multer.diskStorage({
      destination(req, file, cb) {
        const dir = path.join(contentUploadRoot, crypto.randomUUID());
        try { fs.mkdirSync(dir, { recursive: true }); cb(null, dir); } catch (error) { cb(error); }
      },
      filename(req, file, cb) { cb(null, path.basename(String(file.originalname || 'upload.bin')).replace(/[^a-zA-Z0-9._ -]/g, '_')); },
    }),
    limits: { fileSize: modpackLifecycle.MAX_TOTAL_BYTES, files: 1 },
  });

  router.post('/minecraft/content/previews', (req, res) => {
    const body = req.body || {}; const provider = String(body.provider || 'modrinth').toLowerCase();
    if (!['modrinth', 'ftb'].includes(provider)) return res.status(400).json({ error: 'Use upload-previews for imported content.', code: 'upload_required' });
    if (provider === 'ftb' && !isAdmin(req.user)) return res.status(403).json({ error: tErr(req.user, 'errors.forbidden') });
    const m = targetManager(req);
    if (!m || !m.dir()) return res.status(400).json({ error: 'No active server.' });
    const op = foundationOperations.create({ kind: `content-${provider}-prepare`, actorId: req.user.id, serverId: m.id, summary: { provider, sourceKind: provider === 'ftb' ? 'official_installer' : 'catalog' } });
    res.status(202).json({ operationId: op.id });
    setImmediate(async () => {
      try {
        foundationOperations.start(op.id, { phase: 'resolve' });
        if (provider === 'ftb') {
          // Official unattended-installer contract: numeric pack/version plus an
          // explicit Minecraft EULA acknowledgement. Official downloads require
          // release metadata with a published digest; the executable run itself
          // is delegated to the same reviewed runner used for uploaded
          // installers (operation-owned staging, see uploads/:id/apply).
          if (!/^\d+$/.test(String(body.packId || ''))) throw Object.assign(new Error('A numeric FTB pack ID is required.'), { code: 'invalid_pack_id' });
          const latest = body.latest === true || body.latest === 'true';
          if (!latest && !/^\d+$/.test(String(body.versionId || ''))) throw Object.assign(new Error('A numeric FTB version ID or latest is required.'), { code: 'invalid_version_id' });
          if (body.acceptEula !== true) throw Object.assign(new Error('Explicit Minecraft EULA acknowledgement is required.'), { code: 'eula_required' });
          foundationOperations.finish(op.id, { provider, verification: 'verified', sourceKind: 'official_installer', packId: String(body.packId), versionId: latest ? 'latest' : String(body.versionId), acceptEula: true, attestationRequired: true, staging: 'operation-owned', next: 'upload-installer', awaitingInstallerResolution: true });
          return;
        }
        const pack = await resolveLifecyclePack(String(body.versionId || ''), m.desc().worlds || []);
        const previous = modpackLifecycle.latest(m.id); const oldFiles = previous ? previous.files.map((f) => ({ relativePath: f.relative_path, sha256: f.sha256, sizeBytes: f.size_bytes })) : [];
        const plan = modpackLifecycle.buildPlan({ root: m.dir(), oldFiles, newFiles: pack.files, worlds: m.desc().worlds || [] });
        const kind = body.action === 'update' ? 'update' : 'import';
        const previewId = modpackLifecycle.savePreview({ serverId: m.id, actorId: req.user.id, kind, provider: 'modrinth', verificationStatus: 'verified', projectId: String(pack.version.project_id || body.projectId || ''), versionId: String(body.versionId), mcVersion: pack.spec.mcVersion, loader: pack.spec.loaderType, previousManifestId: previous?.id || null, plan });
        foundationOperations.finish(op.id, { previewId, provider: 'modrinth', verification: 'verified', groups: plan.groups, expiresAt: Date.now() + 30 * 60 * 1000, snapshotRequired: true });
      } catch (error) { foundationOperations.fail(op.id, { code: error.code || 'content_prepare_failed', text: sanitizeErrorMessage(error.message) }); }
    });
  });

  router.post('/minecraft/content/upload-previews', contentUpload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'A ZIP, JAR, or FTB installer is required.', code: 'file_required' });
    const provider = String(req.body?.provider || (/\.jar$/i.test(req.file.originalname) ? 'curseforge' : 'curseforge')).toLowerCase();
    if (!['curseforge', 'ftb'].includes(provider)) { cleanupUploadDir(req.file?.path); return res.status(400).json({ error: 'Unsupported upload provider.' }); }
    if (provider === 'ftb' && (!isAdmin(req.user) || req.body?.attested !== 'true')) { cleanupUploadDir(req.file?.path); return res.status(403).json({ error: 'An administrator must attest that the installer came from FTB.', code: 'attestation_required' }); }
    if (provider === 'ftb' && req.body?.acceptEula !== 'true') { cleanupUploadDir(req.file?.path); return res.status(403).json({ error: 'Explicit Minecraft EULA acknowledgement is required.', code: 'eula_required' }); }
    const m = targetManager(req); const op = foundationOperations.create({ kind: `content-${provider}-upload-prepare`, actorId: req.user.id, serverId: m?.id || null, summary: { provider, originalName: path.basename(req.file.originalname) } });
    res.status(202).json({ operationId: op.id });
    setImmediate(async () => {
      try {
        foundationOperations.start(op.id, { phase: 'inspect' });
        let preview;
        if (provider === 'ftb') {
          const latest = req.body.latest === 'true' || req.body.latest === true;
          const packId = req.body.packId != null && String(req.body.packId) !== '' ? String(req.body.packId) : null;
          if (packId !== null && !/^\d+$/.test(packId)) throw Object.assign(new Error('A numeric FTB pack ID is required.'), { code: 'invalid_pack_id' });
          const versionId = latest ? 'latest' : (req.body.versionId != null && String(req.body.versionId) !== '' ? String(req.body.versionId) : null);
          if (versionId !== null && versionId !== 'latest' && !/^\d+$/.test(versionId)) throw Object.assign(new Error('A numeric FTB version ID or latest is required.'), { code: 'invalid_version_id' });
          preview = { provider, sourceKind: 'uploaded_installer', verification: 'user_attested', installerName: path.basename(req.file.originalname), sha256: ftbInstaller.sha256File(req.file.path), packId, versionId, acceptEula: true, attested: true };
        }
        else if (/\.jar$/i.test(req.file.originalname)) preview = curseforgeImport.inspectJar(req.file.path, { kind: req.body.kind, projectId: req.body.projectId, fileId: req.body.fileId });
        else if (/\.zip$/i.test(req.file.originalname)) preview = await curseforgeImport.inspectZip(req.file.path);
        else throw Object.assign(new Error('CurseForge imports must be .jar or .zip files.'), { code: 'invalid_file_type' });
        if (preview.clientOnly) throw Object.assign(new Error(`${preview.error} Unresolved: ${preview.unresolved.join(', ')}`), { code: 'unresolved_curseforge_files' });
        foundationOperations.finish(op.id, { ...preview, uploadPath: req.file.path, expiresAt: Date.now() + 30 * 60 * 1000, snapshotRequired: !!m });
      } catch (error) { cleanupUploadDir(req.file?.path); foundationOperations.fail(op.id, { code: error.code || 'content_upload_invalid', text: sanitizeErrorMessage(error.message) }); }
    });
  });

  router.post('/minecraft/content/previews/:previewId/apply', (req, res) => {
    const loaded = modpackLifecycle.loadPreview(req.params.previewId, req.user.id);
    if (!loaded) return res.status(409).json({ error: 'Preview expired. Create a new preview.' });
    req.body = { ...req.body, previewId: req.params.previewId };
    return lifecycleApply(req, res, loaded.data.kind);
  });

  function recordImportedJar({ serverId, relativePath, kind, projectId, versionId, mcVersion, loader, sha256, displayName, providerMetadata }) {
    const db = openDb();
    db.prepare(`INSERT INTO content_provenance
      (id, server_id, relative_path, kind, provider, project_id, version_id, mc_version, loader, sha256, managed_at, display_name, version_name, provider_metadata_json, source_kind, verification_status)
      VALUES (?, ?, ?, ?, 'curseforge', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'jar_upload', 'user_supplied')
      ON CONFLICT(server_id, relative_path) DO UPDATE SET kind=excluded.kind, provider='curseforge', project_id=excluded.project_id, version_id=excluded.version_id, mc_version=excluded.mc_version, loader=excluded.loader, sha256=excluded.sha256, managed_at=excluded.managed_at, display_name=excluded.display_name, provider_metadata_json=excluded.provider_metadata_json, source_kind='jar_upload', verification_status='user_supplied'`)
      .run(crypto.randomUUID(), serverId, relativePath, kind, String(projectId || ''), String(versionId || ''), mcVersion || null, loader || null, sha256, Date.now(), displayName || null, null, JSON.stringify(providerMetadata || {}));
  }

  function extractCurseZipToStaging(uploadPath, stagingDir, overridesDir, commonRoot) {
    const ZIP_OPTIONS = { maxEntries: modpackLifecycle.MAX_FILES, maxEntrySize: modpackLifecycle.MAX_FILE_BYTES, maxTotalSize: modpackLifecycle.MAX_TOTAL_BYTES };
    return new Promise((resolve, reject) => {
      yauzl.open(uploadPath, { lazyEntries: true, decodeStrings: true }, (openError, zip) => {
        if (openError) return reject(openError);
        const state = {};
        fs.mkdirSync(stagingDir, { recursive: true });
        zip.on('error', reject);
        zip.on('entry', (entry) => {
          let normalized;
          try { normalized = archiveGuard.checkEntry(entry, state, ZIP_OPTIONS); } catch (error) { zip.close(); reject(error); return; }
          if (entry.fileName.endsWith('/')) return zip.readEntry();
          const stripped = curseforgeImport.stripCommonRoot(normalized, commonRoot || '');
          const deployRel = contentApply.curseDeployPath(stripped, overridesDir || 'overrides');
          if (!deployRel) return zip.readEntry();
          const rel = contentApply.normalizeRelative(deployRel);
          if (!rel) { zip.close(); reject(Object.assign(new Error(`Unsafe path in archive: ${deployRel}`), { code: 'unsafe_path' })); return; }
          const dest = contentApply.safeResolve(stagingDir, rel);
          if (!dest) { zip.close(); reject(Object.assign(new Error(`Entry escapes staging: ${deployRel}`), { code: 'unsafe_path' })); return; }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) { zip.close(); reject(streamError); return; }
            const chunks = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => {
              try {
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, Buffer.concat(chunks));
                zip.readEntry();
              } catch (error) { zip.close(); reject(error); }
            });
            stream.on('error', (error) => { zip.close(); reject(error); });
          });
        });
        zip.on('end', () => {
          try { archiveGuard.finalize(state, ZIP_OPTIONS); } catch (error) { reject(error); return; }
          resolve();
        });
        zip.readEntry();
      });
    });
  }

  async function runCurseJarApply({ serverId, summary, uploadPath }) {
    const manager = getManager(serverId);
    const serverDir = manager.dir();
    const kind = summary.kind === 'mod' ? 'mod' : 'plugin';
    const filename = path.basename(String(summary.name || 'import.jar'));
    const compat = detectCompat(manager);
    if (kind === 'mod' && !compat.canMods) throw Object.assign(new Error(`Mods require a Fabric, Forge, or NeoForge server (got ${compat.label}).`), { code: 'incompatible_loader' });
    const folder = kind === 'mod' ? 'mods' : 'plugins';
    const destRel = contentApply.normalizeRelative(`${folder}/${filename}`);
    if (!destRel) throw Object.assign(new Error('Unsafe import path.'), { code: 'unsafe_path' });
    const dest = contentApply.safeResolve(serverDir, destRel);
    if (!dest) throw Object.assign(new Error('Import escapes the server directory.'), { code: 'unsafe_path' });
    if (!fs.existsSync(uploadPath)) throw Object.assign(new Error('Upload expired. Upload again.'), { code: 'upload_expired' });
    const snapshot = foundationSnapshots.take({ serverId, sourceDir: serverDir, scope: [folder], kind: 'content', reason: `curseforge jar ${filename}` });
    if (!foundationSnapshots.verify(snapshot.id).ok) throw new Error('Snapshot verification failed.');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(uploadPath, dest);
    const actual = contentApply.sha256Buffer(fs.readFileSync(dest));
    if (summary.sha256 && summary.sha256 !== actual) throw new Error('SHA-256 mismatch after copy.');
    recordImportedJar({
      serverId, relativePath: destRel, kind,
      projectId: summary.source?.projectId || '', versionId: summary.source?.fileId || '',
      mcVersion: compat.mcVersion || null, loader: compat.loaders[0] || null,
      sha256: actual, displayName: filename,
      providerMetadata: { originalName: filename, uploadSha256: summary.sha256 || null },
    });
    manager.pushLine(`[Hostkind] Imported CurseForge ${kind} into ${destRel} (user-supplied). Restart to apply.`, 'info');
    addNotification('plugin_installed', 'Content imported', `"${filename}" imported into ${folder}/ (user-supplied). Restart the server to apply.`, serverId);
    return { relativePath: destRel, sha256: actual, snapshotId: snapshot.id, restartRequired: true };
  }

  async function promoteStagedPlan({ serverDir, stagingDir, plan, decisions, incomingByPath }) {
    for (const entry of plan.entries) {
      const takePack = entry.state !== 'local_edit' && (entry.state !== 'conflict' || decisions[entry.relativePath] === 'take_pack');
      if (!takePack) continue;
      if (incomingByPath.has(entry.relativePath)) {
        const stagedAbs = contentApply.safeResolve(stagingDir, entry.relativePath);
        const dest = mrpackSafeResolve(serverDir, entry.relativePath);
        if (!stagedAbs || !dest || !fs.existsSync(stagedAbs)) throw new Error(`Staged file missing: ${entry.relativePath}`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(stagedAbs, dest);
      } else if (entry.state === 'safe_removal') {
        const dest = mrpackSafeResolve(serverDir, entry.relativePath);
        if (dest && fs.existsSync(dest)) fs.unlinkSync(dest);
      }
    }
  }

  async function runCurseZipApply({ applyOpId, serverId, summary, uploadPath, decisions }) {
    const manager = getManager(serverId);
    const serverDir = manager.dir();
    const worlds = manager.desc().worlds || [];
    const meta = contentApply.curseManifestMeta(summary.manifest);
    const stagingRoot = path.join(serverDir, '.lodestone', 'staging', applyOpId);
    const stagingDir = path.join(stagingRoot, 'pack');
    fs.mkdirSync(stagingDir, { recursive: true });
    await extractCurseZipToStaging(uploadPath, stagingDir, summary.manifest?.overrides || meta.overridesDir, summary.commonRoot || '');
    const staged = contentApply.walkStaging(stagingDir);
    if (!staged.length) throw Object.assign(new Error('Archive contains no deployable files.'), { code: 'empty_pack' });
    const validated = modpackLifecycle.validateFiles(staged.map((f) => ({ relativePath: f.relativePath, sizeBytes: f.sizeBytes, sha256: f.sha256 })), worlds);
    const previous = modpackLifecycle.latest(serverId);
    const oldFiles = previous ? previous.files.map((f) => ({ relativePath: f.relative_path, sha256: f.sha256, sizeBytes: f.size_bytes })) : [];
    const plan = modpackLifecycle.buildPlan({ root: serverDir, oldFiles, newFiles: validated.accepted, worlds });
    contentApply.checkDecisions(plan, decisions);
    const snapshot = foundationSnapshots.take({ serverId, sourceDir: serverDir, kind: 'modpack', reason: `curseforge import ${meta.displayName || 'pack'}` });
    if (!foundationSnapshots.verify(snapshot.id).ok) throw new Error('Snapshot verification failed.');
    const incomingByPath = new Map(validated.accepted.map((f) => [f.relativePath, f]));
    await promoteStagedPlan({ serverId, serverDir, stagingDir, plan, decisions, incomingByPath });
    const owned = validated.accepted.filter((f) => {
      const e = plan.entries.find((x) => x.relativePath === f.relativePath);
      return e && e.state !== 'local_edit' && (e.state !== 'conflict' || decisions[e.relativePath] === 'take_pack');
    });
    const manifest = modpackLifecycle.persistManifest({
      serverId, provider: 'curseforge', projectId: '', versionId: '',
      mcVersion: meta.mcVersion || '', loader: meta.loader || '',
      operationId: applyOpId, snapshotId: snapshot.id, previousManifestId: previous?.id || null,
      displayName: meta.displayName || 'CurseForge import', versionName: meta.versionName || '',
      providerMetadata: { originalName: summary.originalName || null, zipSha256: summary.sha256 || null, unresolved: summary.unresolved || [], commonRoot: summary.commonRoot || null },
      sourceKind: 'server_pack', verificationStatus: 'user_supplied',
    }, owned);
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    manager.pushLine(`[Hostkind] Imported CurseForge server pack (user-supplied, ${owned.length} files).`, 'info');
    addNotification('modpack_installed', 'Modpack Imported', `CurseForge pack imported into "${manager.name()}" (${owned.length} files, user-supplied).`, serverId);
    return { manifestId: manifest.id, snapshotId: snapshot.id };
  }

  async function runFtbApply({ applyOpId, serverId, summary, uploadPath, decisions, acceptEula }) {
    const manager = getManager(serverId);
    if (manager.status !== STATUS.OFFLINE) throw Object.assign(new Error('The server must be offline.'), { status: 409 });
    const serverDir = manager.dir();
    const worlds = manager.desc().worlds || [];
    const packId = String(summary.packId ?? '');
    const latest = summary.versionId === 'latest';
    const versionId = latest ? undefined : String(summary.versionId ?? '');
    if (!/^\d+$/.test(packId)) throw Object.assign(new Error('A numeric FTB pack ID is required.'), { code: 'invalid_pack_id' });
    if (!latest && !/^\d+$/.test(versionId || '')) throw Object.assign(new Error('A numeric FTB version ID or latest is required.'), { code: 'invalid_version_id' });
    if (!acceptEula) throw Object.assign(new Error('Explicit Minecraft EULA acknowledgement is required.'), { code: 'eula_required' });
    if (!uploadPath || !fs.existsSync(uploadPath)) throw Object.assign(new Error('Upload expired. Upload again.'), { code: 'upload_expired' });
    const stagingRoot = path.join(serverDir, '.lodestone', 'staging', applyOpId);
    const stagingDir = path.join(stagingRoot, 'ftb');
    fs.mkdirSync(stagingDir, { recursive: true });
    if (fs.readdirSync(stagingDir).length) throw Object.assign(new Error('FTB staging directory must be fresh.'), { code: 'staging_not_empty' });
    if (process.platform !== 'win32') { try { fs.chmodSync(uploadPath, 0o755); } catch {} }
    foundationOperations.heartbeat(applyOpId, { phase: 'install', progress: 0.2 });
    const manifestInfo = await ftbInstaller.run({
      executable: uploadPath, stagingDir, packId, versionId, latest, acceptEula: true,
      onLine: (line) => { try { foundationOperations.appendEvent(applyOpId, { phase: 'install', message: String(line).slice(0, 300), level: 'info' }); } catch {} },
    });
    const staged = contentApply.walkStaging(stagingDir).filter((f) => f.relativePath !== '.manifest.json');
    if (!staged.length) throw Object.assign(new Error('FTB installer produced no files.'), { code: 'empty_pack' });
    const validated = modpackLifecycle.validateFiles(staged.map((f) => ({ relativePath: f.relativePath, sizeBytes: f.sizeBytes, sha256: f.sha256 })), worlds);
    const previous = modpackLifecycle.latest(serverId);
    const oldFiles = previous ? previous.files.map((f) => ({ relativePath: f.relative_path, sha256: f.sha256, sizeBytes: f.size_bytes })) : [];
    const plan = modpackLifecycle.buildPlan({ root: serverDir, oldFiles, newFiles: validated.accepted, worlds });
    contentApply.checkDecisions(plan, decisions);
    const snapshot = foundationSnapshots.take({ serverId, sourceDir: serverDir, kind: 'modpack', reason: `ftb ${packId}` });
    if (!foundationSnapshots.verify(snapshot.id).ok) throw new Error('Snapshot verification failed.');
    const incomingByPath = new Map(validated.accepted.map((f) => [f.relativePath, f]));
    await promoteStagedPlan({ serverId, serverDir, stagingDir, plan, decisions, incomingByPath });
    const owned = validated.accepted.filter((f) => {
      const e = plan.entries.find((x) => x.relativePath === f.relativePath);
      return e && e.state !== 'local_edit' && (e.state !== 'conflict' || decisions[e.relativePath] === 'take_pack');
    });
    const manifest = modpackLifecycle.persistManifest({
      serverId, provider: 'ftb', projectId: packId, versionId: manifestInfo.versionId || (latest ? 'latest' : String(versionId || '')),
      mcVersion: manifestInfo.minecraftVersion || '', loader: manifestInfo.loader || '',
      operationId: applyOpId, snapshotId: snapshot.id, previousManifestId: previous?.id || null,
      displayName: manifestInfo.name || `FTB ${packId}`, versionName: manifestInfo.versionName || '',
      providerMetadata: { packId, versionId: latest ? 'latest' : String(versionId || ''), installerName: summary.installerName || null, installerSha256: summary.sha256 || null, javaVersion: manifestInfo.javaVersion || null },
      sourceKind: 'official_installer', verificationStatus: 'user_attested',
    }, owned);
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    manager.pushLine(`[Hostkind] Installed FTB pack ${packId} via official installer (attested).`, 'info');
    addNotification('modpack_installed', 'FTB Pack Installed', `FTB pack ${packId} installed into "${manager.name()}" (${owned.length} files).`, serverId);
    return { manifestId: manifest.id, snapshotId: snapshot.id };
  }

  router.post('/minecraft/content/uploads/:operationId/apply', (req, res) => {
    const prep = foundationOperations.get(String(req.params.operationId || ''));
    if (!prep) return res.status(404).json({ error: 'Upload not found.' });
    if (prep.state !== foundationOperations.STATES.SUCCEEDED) return res.status(409).json({ error: prep.state === foundationOperations.STATES.FAILED ? 'Upload inspection failed.' : 'Upload is not ready.', state: prep.state });
    const summary = (prep.summary && typeof prep.summary === 'object') ? prep.summary : {};
    if (summary.expiresAt && summary.expiresAt < Date.now()) {
      if (summary.uploadPath) fs.rmSync(path.dirname(summary.uploadPath), { recursive: true, force: true });
      return res.status(410).json({ error: 'Upload expired. Upload again.', code: 'upload_expired' });
    }
    const provider = String(summary.provider || '').toLowerCase();
    if (!['curseforge', 'ftb'].includes(provider)) return res.status(400).json({ error: 'Unsupported upload provider.' });
    if (provider === 'ftb' && !isAdmin(req.user)) return res.status(403).json({ error: tErr(req.user, 'errors.forbidden') });
    if (prep.actorId && prep.actorId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: tErr(req.user, 'errors.forbidden') });
    const target = targetManager(req) || (prep.serverId ? getManager(prep.serverId) : null);
    if (!target || !target.dir()) return res.status(400).json({ error: 'No active server.' });
    const isJar = provider === 'curseforge' && /\.jar$/i.test(String(summary.name || summary.uploadPath || ''));
    if (!isJar && target.status !== STATUS.OFFLINE) return res.status(409).json({ error: 'The server must be offline.' });
    if (provider === 'ftb' && (req.body || {}).acceptEula !== true) return res.status(403).json({ error: 'Explicit Minecraft EULA acknowledgement is required.', code: 'eula_required' });
    const decisions = ((req.body || {}).decisions && typeof req.body.decisions === 'object' && !Array.isArray(req.body.decisions)) ? req.body.decisions : {};
    const applyOp = foundationOperations.create({ kind: `content-${provider}-apply`, actorId: req.user.id, serverId: target.id, idempotencyKey: req.get('Idempotency-Key') || null, summary: { prepOperationId: prep.id, provider } });
    if (applyOp.state !== foundationOperations.STATES.QUEUED) return res.status(202).json({ ok: true, operationId: applyOp.id, replay: true });
    if (!foundationOperations.acquireServerLock(applyOp.id, target.id)) {
      foundationOperations.fail(applyOp.id, { code: 'server_busy', text: 'Another operation is running for this server.' });
      return res.status(409).json({ error: 'Another operation is running for this server.' });
    }
    res.status(202).json({ ok: true, operationId: applyOp.id });
    setImmediate(async () => {
      const uploadPath = summary.uploadPath;
      try {
        foundationOperations.start(applyOp.id, { phase: 'apply' });
        let result;
        if (provider === 'curseforge' && isJar) result = await runCurseJarApply({ applyOpId: applyOp.id, serverId: target.id, summary, uploadPath });
        else if (provider === 'curseforge') result = await runCurseZipApply({ applyOpId: applyOp.id, serverId: target.id, summary, uploadPath, decisions });
        else result = await runFtbApply({ applyOpId: applyOp.id, serverId: target.id, summary, uploadPath, decisions, acceptEula: req.body.acceptEula === true });
        if (uploadPath) fs.rmSync(path.dirname(uploadPath), { recursive: true, force: true });
        foundationOperations.finish(applyOp.id, { provider, ...result });
      } catch (error) {
        if (error && error.code === 'conflicts_required') {
          foundationOperations.fail(applyOp.id, { code: 'conflicts_required', text: sanitizeErrorMessage(error.message) });
        } else {
          try { fs.rmSync(path.join(target.dir(), '.lodestone', 'staging', applyOp.id), { recursive: true, force: true }); } catch {}
          foundationOperations.fail(applyOp.id, { code: (error && error.code) || 'content_apply_failed', text: sanitizeErrorMessage((error && error.message) || 'Apply failed') });
        }
        log('content apply failed:', (error && error.message) || error);
      }
    });
  });

  router.get('/minecraft/content/installed', (req, res) => {
    const m = targetManager(req); if (!m) return res.status(400).json({ error: 'No active server.' });
    const db = openDb();
    const artifacts = db.prepare('SELECT * FROM content_provenance WHERE server_id = ? ORDER BY managed_at DESC').all(m.id).map((row) => ({ ...row, providerMetadata: JSON.parse(row.provider_metadata_json || '{}') }));
    const history = modpackLifecycle.history(m.id).map((row) => ({ ...row, providerMetadata: JSON.parse(row.provider_metadata_json || '{}') }));
    res.json({ installed: modpackLifecycle.latest(m.id), artifacts, history });
  });

  router.post('/modpacks/import/preview', (req, res) => lifecyclePreview(req, res, 'import'));
  router.post('/modpacks/import', (req, res) => lifecycleApply(req, res, 'import'));
  router.get('/modpacks/installed', async (req, res) => {
    const m = targetManager(req);
    if (!m) return res.status(400).json({ error: 'No active server.' });
    const installed = modpackLifecycle.latest(m.id);
    const history = modpackLifecycle.history(m.id);
    const records = installed ? [installed, ...history] : history;
    const metadata = new Map();
    await Promise.all(records.map(async (record) => {
      const key = `${record.project_id}:${record.version_id}`;
      if (metadata.has(key)) return;
      try {
        const [projectResponse, versionResponse] = await Promise.all([
          fetch(`${MODRINTH}/project/${encodeURIComponent(record.project_id)}`, { headers: { 'User-Agent': UA } }),
          fetch(`${MODRINTH}/version/${encodeURIComponent(record.version_id)}`, { headers: { 'User-Agent': UA } }),
        ]);
        if (!projectResponse.ok || !versionResponse.ok) return;
        const [project, version] = await Promise.all([projectResponse.json(), versionResponse.json()]);
        metadata.set(key, {
          projectName: project.title || project.slug,
          projectSlug: project.slug,
          iconUrl: project.icon_url || null,
          versionName: version.name || version.version_number,
          versionNumber: version.version_number,
        });
      } catch { /* Stored identifiers remain available when Modrinth is unavailable. */ }
    }));
    const enrich = (record) => record ? {
      ...record,
      file_count: record.file_count ?? record.files?.length ?? 0,
      ...metadata.get(`${record.project_id}:${record.version_id}`),
    } : null;
    res.json({ installed: enrich(installed), history: history.map(enrich) });
  });
  router.post('/modpacks/update/preview', (req, res) => lifecyclePreview(req, res, 'update'));
  router.post('/modpacks/update', (req, res) => lifecycleApply(req, res, 'update'));

  router.post('/modpacks/clone', (req, res) => {
    const body = req.body || {};
    const source = targetManager(req);
    const name = String(body.name || '').trim();
    const parentDir = String(body.parentDir || '').trim();
    if (!source || !source.dir()) return res.status(400).json({ error: 'No active server.' });
    if (!name || !parentDir || !fs.existsSync(parentDir)) return res.status(400).json({ error: 'A name and existing parent folder are required.' });
    const finalDir = path.join(parentDir, slugify(name));
    if (fs.existsSync(finalDir)) return res.status(409).json({ error: 'The clone folder already exists.' });
    const staging = `${finalDir}.lodestone-${crypto.randomUUID()}.staging`;
    const sourceConfig = source.desc();
    try {
      const worlds = sourceConfig.worlds || [];
      function copyClone(src, dest, rel = '') {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (modpackLifecycle.exclusionReason(childRel, worlds)) continue;
          const from = path.join(src, entry.name);
          const to = path.join(dest, entry.name);
          if (entry.isDirectory()) copyClone(from, to, childRel);
          else if (entry.isFile()) fs.copyFileSync(from, to);
        }
      }
      copyClone(source.dir(), staging);
      fs.renameSync(staging, finalDir);
      const entry = { ...sourceConfig, id: genId(), name, dir: finalDir, worlds: [...worlds] };
      config.servers.push(entry);
      saveConfig(config);
      getManager(entry.id);
      const prior = modpackLifecycle.latest(source.id);
      if (prior) {
        const files = prior.files.filter((f) => fs.existsSync(mrpackSafeResolve(finalDir, f.relative_path))).map((f) => ({ relativePath: f.relative_path, sha256: f.sha256, sizeBytes: f.size_bytes, sourceUrlHash: f.source_url_hash }));
        modpackLifecycle.persistManifest({ serverId: entry.id, projectId: prior.project_id, versionId: prior.version_id, mcVersion: prior.mc_version, loader: prior.loader, operationId: crypto.randomUUID() }, files);
      }
      res.status(201).json({ ok: true, server: serverWithStatus(entry) });
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      httpError(res, req, err, 500);
    }
  });

  router.post('/modpacks/history/:id/rollback', (req, res) => {
    const manifest = modpackLifecycle.getManifest(req.params.id);
    if (!manifest || !manifest.snapshot_id) return res.status(404).json({ error: 'Rollback snapshot not found.' });
    const m = getManager(manifest.server_id);
    if (!m || m.status !== STATUS.OFFLINE) return res.status(409).json({ error: 'The server must be offline.' });
    const result = foundationSnapshots.restore({ id: manifest.snapshot_id, targetDir: m.dir() });
    if (!result.ok) return res.status(500).json({ error: 'Snapshot restore verification failed.' });
    const op = foundationOperations.create({ kind: 'modpack-rollback', actorId: req.user.id, serverId: m.id, idempotencyKey: req.get('Idempotency-Key') || null });
    foundationOperations.start(op.id, { phase: 'restore' });
    foundationOperations.finish(op.id, { manifestId: manifest.id });
    res.status(202).json({ ok: true, operationId: op.id, manifestId: manifest.id });
  });

  router.get('/modrinth/modpack/versions/:projectId', async (req, res) => {
    const m = targetManager(req);
    const compat = detectCompat(m);
    const projectId = req.params.projectId;
    const url = `${MODRINTH}/project/${encodeURIComponent(projectId)}/version`;
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      const matched = await r.json();
      res.json({ matched: Array.isArray(matched) ? matched : [], compat });
    } catch (err) {
      httpError(res, req, err, 502);
    }
  });

  router.get('/modrinth/modpack/preview/:versionId', async (req, res) => {
    const versionId = req.params.versionId;
    if (!versionId) return res.status(400).json({ error: tErr(req.user, 'errors.missingVersionId') });
    const m = targetManager(req);
    const compat = detectCompat(m);
    try {
      log(`Modpack preview: resolving version ${versionId}...`);
      const r = await fetch(`${MODRINTH}/version/${encodeURIComponent(versionId)}`, { headers: { 'User-Agent': UA } });
      const version = await r.json();
      const file = (version.files || []).find((f) => f.primary) || (version.files || [])[0];
      if (!file) return res.status(404).json({ error: tErr(req.user, 'errors.noVersionFiles') });
      const dl = await fetch(file.url, { headers: { 'User-Agent': UA } });
      if (!dl.ok) return res.status(502).json({ error: `Download failed: HTTP ${dl.status}` });
      const mrpack = Buffer.from(await dl.arrayBuffer());
      const index = await readMrpackIndex(mrpack);
      const spec = manifestToSpec(index);
      const counts = fileCountByEnv(index);
      const eligibleExisting = !spec.unsupported && compat.loaders.some((l) => l === spec.loaderType) &&
        (!compat.mcVersion || compat.mcVersion === spec.mcVersion);
      res.json({
        name: spec.name || version.name || '',
        versionId,
        mcVersion: spec.mcVersion || '',
        loaderType: spec.loaderType || '',
        loaderVersion: spec.loaderVersion || '',
        unsupported: spec.unsupported,
        unsupportedReason: spec.reason || '',
        fileCount: counts.total,
        serverFileCount: counts.server,
        indexName: index.name || '',
        eligibleExisting,
        compat,
      });
    } catch (err) {
      log(`Modpack preview failed: ${err.message}`);
      res.status(502).json({ error: sanitizeErrorMessage(err.message) });
    }
  });

  router.post('/modrinth/modpack/install', async (req, res) => {
    const body = req.body || {};
    const versionId = String(body.versionId || '');
    const mode = String(body.mode || 'existing').toLowerCase();
    if (!versionId) return res.status(400).json({ error: tErr(req.user, 'errors.missingVersionId') });
    try {
      log(`Modpack install: resolving version ${versionId}...`);
      const r = await fetch(`${MODRINTH}/version/${encodeURIComponent(versionId)}`, { headers: { 'User-Agent': UA } });
      const version = await r.json();
      const file = (version.files || []).find((f) => f.primary) || (version.files || [])[0];
      if (!file) return res.status(404).json({ error: tErr(req.user, 'errors.noVersionFiles') });
      const dl = await fetch(file.url, { headers: { 'User-Agent': UA } });
      if (!dl.ok) return res.status(502).json({ error: `Download failed: HTTP ${dl.status}` });
      const mrpack = Buffer.from(await dl.arrayBuffer());
      const index = await readMrpackIndex(mrpack);
      const spec = manifestToSpec(index);
      if (spec.unsupported) {
        return res.status(400).json({ error: tErr(req.user, 'errors.modpackUnsupportedLoader', { loader: spec.loaderType || 'unknown', reason: spec.reason || '' }) });
      }

      const sFiles = serverSideFiles(index);
      let targetDir;
      let serverName;
      let targetServerId;
      let targetWorlds = [];

      if (mode === 'create') {
        const createName = String(body.name || spec.name || index.name || 'Modpack Server').trim();
        const parentDir = String(body.parentDir || '').trim();
        if (!createName) return res.status(400).json({ error: tErr(req.user, 'errors.nameRequired') });
        if (createName.length > SERVER_NAME_MAX_LENGTH) return res.status(400).json({ error: tErr(req.user, 'errors.nameTooLong', { max: SERVER_NAME_MAX_LENGTH }) });
        if (!parentDir || !fs.existsSync(parentDir)) return res.status(400).json({ error: tErr(req.user, 'errors.pickParentFolder') });

        const dir = path.join(parentDir, slugify(createName));
        if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
          return res.status(400).json({ error: tErr(req.user, 'errors.folderNotEmpty', { path: dir }) });
        }

        const type = spec.loaderType;
        const mcVersion = spec.mcVersion;

        log(`Modpack create: ${type} server "${createName}" (MC ${mcVersion}) -> ${dir}`);

        fs.mkdirSync(dir, { recursive: true });

        const { url, filename } = await resolveServerJar(type, mcVersion);
        log(`Modpack create: resolved -> ${url}`);
        const jarPath = path.join(dir, filename);

        log(`Modpack create: downloading ${filename}...`);
        await downloadToFile(url, jarPath, () => {}, undefined);

        let jarFilename = filename;
        let launchArgs = null;
        if (type === 'forge' || type === 'neoforge') {
          const label = type === 'neoforge' ? 'NeoForge' : 'Forge';
          const major = requiredJavaMajor(mcVersion);
          let javaBin = resolveJavaForServer({ mcVersion }, major);
          if (!javaBin) {
            log(`Modpack create: ${label} installer needs Java ${major}; preparing managed runtime...`);
            javaBin = await ensureRuntime(major, () => {});
          }
          await runForgeInstaller(dir, filename, label, javaBin);
          const produced = findForgeLaunchTarget(dir, type);
          if (!produced) throw new Error(`${label} installer finished but no server jar or launch args file was found in the folder`);
          jarFilename = produced.jar;
          launchArgs = produced.launchArgs;
        }

        fs.writeFileSync(path.join(dir, 'eula.txt'), `# Accepted via Hostkind modpack install on ${new Date().toISOString()}\neula=true\n`, 'utf8');

        targetDir = dir;
        serverName = createName;

        const entry = {
          id: genId(),
          name: createName,
          dir,
          jar: jarFilename,
          loader: type,
          launchArgs,
          javaArgs: ['-Xmx4G', '-Xms4G'],
          mcVersion,
          stopTimeoutSeconds: 30,
          worlds: ['world', 'world_nether', 'world_the_end'],
          watchdog: { enabled: false, maxRestarts: 3, windowMinutes: 10 },
        };
        config.servers.push(entry);
        if (!config.activeServerId) config.activeServerId = entry.id;
        saveConfig(config);
        getManager(entry.id);
        targetServerId = entry.id;
        targetWorlds = entry.worlds;
        addNotification('server_created', 'Modpack Server Created', `Server "${createName}" (${type}, MC ${mcVersion}) created from modpack.`, entry.id);
        log(`Created ${type} server "${createName}" (${mcVersion}) from modpack at ${dir}`);
      } else {
        const m = targetManager(req);
        if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
        const compat = detectCompat(m);
        const loaderOk = compat.loaders.some((l) => l === spec.loaderType);
        const versionOk = !compat.mcVersion || compat.mcVersion === spec.mcVersion;
        if (!loaderOk || !versionOk) {
          return res.status(409).json({ error: tErr(req.user, 'errors.modpackIncompatible', { label: spec.loaderType || '?', version: spec.mcVersion || '' }) });
        }
        targetDir = m.dir();
        serverName = m.name();
        targetServerId = m.id;
        targetWorlds = m.desc().worlds || [];
      }

      fs.mkdirSync(targetDir, { recursive: true });

      let installed = 0;
      const managedFiles = [];
      for (const f of sFiles) {
        const url = f.downloads && f.downloads[0];
        if (!url) continue;
        log(`Modpack: downloading ${f.path}...`);
        const buf = await downloadAndVerify(url, f.hashes, UA);
        if (!f.path || typeof f.path !== 'string') continue;
        const dest = mrpackSafeResolve(targetDir, f.path);
        if (!dest) {
          log(`Modpack: skipping "${f.path}" — escapes server directory`);
          continue;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
        managedFiles.push({
          relativePath: f.path,
          sizeBytes: buf.length,
          sha256: modpackLifecycle.sha256(buf),
          sourceUrlHash: modpackLifecycle.sha256(url),
        });
        installed++;
      }

      const overridesExtracted = await extractOverrides(mrpack, targetDir);
      const trackedFiles = modpackLifecycle.validateFiles(managedFiles, targetWorlds).accepted;
      const previous = modpackLifecycle.latest(targetServerId);
      modpackLifecycle.persistManifest({
        serverId: targetServerId,
        projectId: String(version.project_id || ''),
        versionId,
        mcVersion: spec.mcVersion,
        loader: spec.loaderType,
        operationId: crypto.randomUUID(),
        previousManifestId: previous?.id || null,
      }, trackedFiles);

      log(`Modpack: installed ${installed} files + ${overridesExtracted} overrides into "${serverName}"`);
      if (mode === 'existing') {
        const m = targetManager(req);
        if (m) {
          m.pushLine(`[Hostkind] Installed modpack from Modrinth: ${spec.name || version.name || ''} (${installed} files, ${overridesExtracted} overrides)`, 'info');
          addNotification('modpack_installed', 'Modpack Installed', `Modpack "${spec.name || version.name || ''}" installed into "${serverName}" (${installed} files, ${overridesExtracted} overrides).`, m.id);
        }
      } else {
        addNotification('modpack_installed', 'Modpack Server Created', `Modpack "${spec.name || version.name || ''}" deployed as new server "${serverName}".`);
      }

      res.json({
        ok: true,
        name: spec.name || version.name || '',
        serverId: targetServerId,
        server: config.servers.find((server) => server.id === targetServerId) || null,
        fileCount: installed,
        overrides: overridesExtracted,
        mode,
        note: 'Restart the server to apply.',
      });
    } catch (err) {
      log(`Modpack install failed: ${err.message}`);
      res.status(502).json({ error: sanitizeErrorMessage(err.message) });
    }
  });

  return router;
};
