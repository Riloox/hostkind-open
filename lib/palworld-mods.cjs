'use strict';

/*
 * Palworld mods and extension frameworks (docs/palworld/06-mods.md).
 *
 * Scope of this module: read-only inventory and diagnostics, importing an
 * already-downloaded Workshop or local package through preview and staging,
 * reversible enable/disable by parking, recoverable removal through trash plus
 * snapshot, dynamic update checks for packages that carry a Workshop
 * provenance, and previewed local-folder installation of UE4SS.
 *
 * Everything the operator hands us is treated as data. Archives are validated
 * by the shared guard, extracted only into staging, verified by hash, and
 * committed with same-filesystem renames. Installer code inside an archive is
 * never executed - executable payloads are a rejection, not a special case.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const { checkEntry, finalize, ArchiveError } = require('./archiveGuard.cjs');
const { safeResolve } = require('./files.cjs');
const operations = require('./operations.cjs');
const snapshots = require('./snapshots.cjs');
const platform = require('./palworld-platform.cjs');

const INVENTORY_VERSION = 1;
const STATE_DIR = path.join('.fleetdeck', 'palworld-mods');
const MAX_ENTRIES = 4000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const PREVIEW_TTL_MS = 15 * 60_000;
const UPDATE_CACHE_TTL_MS = 30 * 60_000;
const UPDATE_MAX_STALE_MS = 24 * 60 * 60 * 1000;
const WORKSHOP_ENDPOINT = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';

/*
 * Where each kind of package is allowed to land, and what it is allowed to
 * contain. An entry with any other extension fails the whole import: an
 * allowlist is the only layout check that stays correct as archives get
 * creative.
 */
const KINDS = Object.freeze({
  pak: {
    id: 'pak',
    root: 'Pal/Content/Paks/~mods',
    extensions: ['.pak', '.ucas', '.utoc', '.sig', '.txt', '.md', '.json'],
    framework: null,
    targets: ['windows', 'linux'],
    restartRequired: true,
  },
  'ue4ss-lua': {
    id: 'ue4ss-lua',
    root: 'Pal/Binaries/Win64/ue4ss/Mods',
    extensions: ['.lua', '.txt', '.md', '.json', '.ini', '.cfg', '.toml'],
    framework: 'ue4ss',
    targets: ['windows'],
    restartRequired: true,
  },
});

/*
 * Frameworks are declared, detected and reported - not installed. Each entry
 * lists the paths whose presence proves the framework is already there, and
 * the authoritative origin an operator should get it from.
 */
const FRAMEWORKS = Object.freeze({
  ue4ss: {
    id: 'ue4ss',
    label: 'UE4SS',
    targets: ['windows'],
    managed: false,
    markers: [
      'Pal/Binaries/Win64/ue4ss/UE4SS.dll',
      'Pal/Binaries/Win64/UE4SS.dll',
      'Pal/Binaries/Win64/ue4ss/UE4SS-settings.ini',
    ],
    origin: 'https://github.com/UE4SS-RE/RE-UE4SS/releases',
  },
});

const BLOCKED_EXTENSIONS = Object.freeze([
  '.exe', '.dll', '.so', '.dylib', '.bat', '.cmd', '.com', '.msi', '.ps1',
  '.sh', '.vbs', '.scr', '.jar', '.py', '.reg', '.lnk', '.app', '.deb', '.rpm',
]);

const previews = new Map();
const frameworkPreviews = new Map();
const replays = new Map();
let updateCache = new Map();

class ModError extends Error {
  constructor(message, status = 400, code = 'mod_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(message, status, code) {
  throw new ModError(message, status, code);
}

// --- paths and inventory --------------------------------------------------

function stateDir(server) {
  return path.join(server.dir, STATE_DIR);
}

function inventoryPath(server) {
  return path.join(stateDir(server), 'inventory.json');
}

function parkedDir(server, packageId) {
  return path.join(stateDir(server), 'parked', packageId);
}

function trashDir(server, trashId) {
  return path.join(stateDir(server), 'trash', trashId);
}

function slugify(value) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return slug || `mod-${crypto.randomBytes(4).toString('hex')}`;
}

function readInventory(server) {
  const file = inventoryPath(server);
  if (!fs.existsSync(file)) return { version: INVENTORY_VERSION, packages: [], readable: true };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const packages = Array.isArray(parsed?.packages) ? parsed.packages : [];
    return { version: Number(parsed?.version) || INVENTORY_VERSION, packages, readable: true };
  } catch (_) {
    // A corrupt inventory must never be interpreted as "nothing is installed";
    // that would let a bulk action treat every managed mod as unmanaged.
    return { version: INVENTORY_VERSION, packages: [], readable: false };
  }
}

function writeInventory(server, inventory) {
  const dir = stateDir(server);
  fs.mkdirSync(dir, { recursive: true });
  const file = inventoryPath(server);
  const temporary = path.join(dir, `.inventory.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify({ version: INVENTORY_VERSION, packages: inventory.packages }, null, 2));
  fs.renameSync(temporary, file);
}

function findPackage(server, packageId) {
  const inventory = readInventory(server);
  if (!inventory.readable) fail('The mod inventory could not be read. Repair it before changing mods.', 409, 'inventory_unreadable');
  const found = inventory.packages.find((item) => item.id === packageId);
  if (!found) fail('That mod is not managed by Hostkind.', 404, 'package_not_found');
  return { inventory, pkg: found };
}

// --- hashing and file walking --------------------------------------------

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walkFiles(root, prefix = '') {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return out; }
  for (const entry of entries) {
    const abs = path.join(root, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(abs, rel));
    else if (entry.isFile()) out.push({ path: rel, bytes: fs.statSync(abs).size });
    // Symbolic links and devices are skipped: nothing we install creates them.
  }
  return out;
}

function manifestOf(root) {
  return walkFiles(root).map((file) => ({ ...file, sha256: hashFile(path.join(root, file.path)) }));
}

function directorySize(root) {
  return walkFiles(root).reduce((total, file) => total + file.bytes, 0);
}

/*
 * Compare what is installed against the manifest recorded at install time.
 * Drift is reported, never silently repaired.
 */
function verifyPackage(server, pkg) {
  const abs = installAbsolute(server, pkg);
  if (!fs.existsSync(abs)) return { ok: false, state: 'missing', missing: (pkg.files || []).map((f) => f.path), modified: [], extra: [] };
  const current = new Map(manifestOf(abs).map((file) => [file.path, file.sha256]));
  const missing = [];
  const modified = [];
  for (const file of pkg.files || []) {
    if (!current.has(file.path)) missing.push(file.path);
    else if (current.get(file.path) !== file.sha256) modified.push(file.path);
    current.delete(file.path);
  }
  const extra = [...current.keys()];
  const ok = !missing.length && !modified.length && !extra.length;
  return { ok, state: ok ? 'verified' : 'drifted', missing, modified, extra };
}

function installRelative(pkg) {
  return `${KINDS[pkg.kind] ? KINDS[pkg.kind].root : pkg.root}/${pkg.slug}`;
}

function installAbsolute(server, pkg) {
  return pkg.enabled
    ? safeResolve(server.dir, installRelative(pkg))
    : parkedDir(server, pkg.id);
}

// --- archives -------------------------------------------------------------

function normalizeArchiveError(error) {
  if (error instanceof ArchiveError) return new ModError(archiveMessage(error), 422, error.code);
  const message = String(error?.message || '');
  if (/invalid relative path|\.\./i.test(message)) return new ModError('The archive contains a path that escapes its root.', 422, 'path_traversal');
  if (/absolute path/i.test(message)) return new ModError('The archive contains an absolute path.', 422, 'absolute_path');
  return new ModError('The archive could not be read.', 422, 'invalid_archive');
}

function archiveMessage(error) {
  switch (error.code) {
    case 'path_traversal': return 'The archive contains a path that escapes its root.';
    case 'absolute_path': return 'The archive contains an absolute path.';
    case 'symlink': return 'The archive contains a link, which is never extracted.';
    case 'duplicate_entry': return 'The archive contains two entries with the same path.';
    case 'entry_too_large': return 'A file in the archive is larger than the import limit.';
    case 'too_large_total': return 'The archive expands beyond the import size limit.';
    case 'too_many_entries': return 'The archive contains more files than the import limit allows.';
    case 'ratio_entry':
    case 'ratio_aggregate': return 'The archive expands suspiciously and was rejected.';
    default: return 'The archive could not be validated.';
  }
}

function scanArchive(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (error, zip) => {
      if (error) return reject(new ModError('The archive could not be read.', 422, 'invalid_archive'));
      const state = { entries: 0, totalSize: 0, totalCompressedSize: 0, seen: new Set() };
      const files = [];
      let settled = false;
      const bail = (err) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch (_) { /* closing a failed zip is best effort */ }
        reject(normalizeArchiveError(err));
      };
      zip.on('error', bail);
      zip.on('entry', (entry) => {
        try {
          if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; }
          const rel = checkEntry(entry, state, { maxEntries: MAX_ENTRIES, maxTotalSize: MAX_BYTES });
          files.push({ path: rel, bytes: entry.uncompressedSize || 0 });
          zip.readEntry();
        } catch (err) { bail(err); }
      });
      zip.on('end', () => {
        if (settled) return;
        try {
          const totals = finalize(state);
          settled = true;
          resolve({ totals, files });
        } catch (err) { bail(err); }
      });
      zip.readEntry();
    });
  });
}

/*
 * Extract the archive into a staging directory, re-validating every entry.
 * The scan and this pass read the same central directory, but only what is
 * re-validated here ever reaches the disk.
 */
function extractArchive(file, strip, destination) {
  fs.mkdirSync(destination, { recursive: true });
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (error, zip) => {
      if (error) return reject(new ModError('The archive could not be read.', 422, 'invalid_archive'));
      const state = { entries: 0, totalSize: 0, totalCompressedSize: 0, seen: new Set() };
      let files = 0;
      let bytes = 0;
      let settled = false;
      const bail = (err) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch (_) { /* best effort */ }
        reject(normalizeArchiveError(err));
      };
      zip.on('error', bail);
      zip.on('entry', (entry) => {
        let rel;
        try {
          if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; }
          rel = checkEntry(entry, state, { maxEntries: MAX_ENTRIES, maxTotalSize: MAX_BYTES });
        } catch (err) { return bail(err); }
        const inside = stripPrefix(rel, strip);
        if (!inside) { zip.readEntry(); return; }
        let target;
        try { target = safeResolve(destination, inside); }
        catch { return bail(new ModError('An archive entry escapes the staging root.', 422, 'path_traversal')); }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return bail(streamError);
          // 'wx': a duplicate that slipped past the guard fails loudly instead
          // of overwriting whatever landed first.
          const out = fs.createWriteStream(target, { flags: 'wx' });
          stream.on('error', bail);
          out.on('error', bail);
          out.on('close', () => {
            files += 1;
            bytes += entry.uncompressedSize || 0;
            zip.readEntry();
          });
          stream.pipe(out);
        });
      });
      zip.on('end', () => {
        if (settled) return;
        try { finalize(state); settled = true; resolve({ files, bytes }); }
        catch (err) { bail(err); }
      });
      zip.readEntry();
    });
  });
}

function stripPrefix(rel, strip) {
  if (!strip) return rel;
  if (rel === strip) return '';
  if (!rel.startsWith(`${strip}/`)) return '';
  return rel.slice(strip.length + 1);
}

function commonPrefix(files) {
  const roots = new Set(files.map((file) => (file.path.includes('/') ? file.path.split('/')[0] : '')));
  return roots.size === 1 && !roots.has('') ? [...roots][0] : '';
}

/*
 * Work out what kind of package this is from its layout. Anything we cannot
 * place confidently is rejected: guessing a target directory is how mods end
 * up scattered through a server folder.
 */
function classify(files) {
  const strip = commonPrefix(files);
  const inside = files
    .map((file) => ({ ...file, inside: stripPrefix(file.path, strip) }))
    .filter((file) => file.inside);
  if (!inside.length) fail('The archive has no files to install.', 422, 'empty_archive');

  const blocked = inside.filter((file) => BLOCKED_EXTENSIONS.includes(path.extname(file.inside).toLowerCase()));
  if (blocked.length) {
    fail(`The archive contains executable content (${blocked[0].inside}). Hostkind never runs installers from an archive.`, 422, 'executable_content');
  }

  const lower = inside.map((file) => file.inside.toLowerCase());
  const kind = lower.some((file) => file.endsWith('.pak')) ? 'pak'
    : lower.some((file) => file.endsWith('.lua')) ? 'ue4ss-lua'
      : null;
  if (!kind) {
    fail('The archive does not look like a supported Palworld mod: no .pak and no Lua script was found.', 422, 'unsupported_layout');
  }

  const spec = KINDS[kind];
  const foreign = inside.filter((file) => !spec.extensions.includes(path.extname(file.inside).toLowerCase()));
  if (foreign.length) {
    fail(`The archive contains a file this package type does not allow: ${foreign[0].inside}`, 422, 'unsupported_layout');
  }

  return {
    kind,
    strip,
    files: inside.map((file) => ({ path: file.inside, bytes: file.bytes })),
    sizeBytes: inside.reduce((total, file) => total + file.bytes, 0),
    framework: spec.framework,
    suggestedName: strip || null,
  };
}

// --- frameworks and compatibility ----------------------------------------

function detectFrameworks(server) {
  return Object.values(FRAMEWORKS).map((framework) => {
    const marker = framework.markers.find((rel) => {
      try { return fs.existsSync(safeResolve(server.dir, rel)); } catch (_) { return false; }
    }) || null;
    return {
      id: framework.id,
      label: framework.label,
      detected: !!marker,
      detectedAt: marker,
      managed: framework.managed,
      targets: framework.targets,
      origin: framework.origin,
      note: framework.id === 'ue4ss' ? 'folder_import_available' : framework.managed ? null : 'install_manually',
    };
  });
}

function frameworkSourceRoot(folder) {
  const root = path.resolve(String(folder || '').trim());
  if (!folder || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    fail('Select an existing UE4SS download folder.', 400, 'framework_folder_missing');
  }
  const direct = fs.readdirSync(root, { withFileTypes: true });
  if (direct.some((entry) => entry.isFile() && entry.name.toLowerCase() === 'ue4ss.dll')) return root;
  const candidates = direct
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.readdirSync(dir, { withFileTypes: true })
      .some((entry) => entry.isFile() && entry.name.toLowerCase() === 'ue4ss.dll'));
  if (candidates.length === 1) return candidates[0];
  fail('That folder does not contain a UE4SS.dll at its root.', 422, 'framework_invalid');
}

function frameworkManifest(root) {
  const files = [];
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) fail('The UE4SS folder contains a symbolic link and cannot be imported.', 422, 'framework_symlink');
      const abs = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) {
        const stat = fs.statSync(abs);
        files.push({ path: rel, bytes: stat.size, sha256: hashFile(abs) });
        if (files.length > MAX_ENTRIES) fail('The UE4SS folder contains too many files.', 413, 'framework_too_many_files');
      }
    }
  };
  walk(root);
  const sizeBytes = files.reduce((total, file) => total + file.bytes, 0);
  if (sizeBytes > MAX_BYTES) fail('The UE4SS folder is too large to import.', 413, 'framework_too_large');
  return { files, sizeBytes };
}

function sameOrInside(candidate, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

async function previewFrameworkFolder({ server, manager, actorId, folder, host = platform.hostPlatform(), detectRun }) {
  const compat = await compatibility({ server, host, detectRun });
  if (!compat.supported || compat.target !== 'windows') {
    fail('UE4SS can only be installed for a supported Windows-target Palworld server.', 422, 'target_unsupported');
  }
  const sourceRoot = frameworkSourceRoot(folder);
  if (sameOrInside(sourceRoot, server.dir) || sameOrInside(server.dir, sourceRoot)) {
    fail('Choose an extracted UE4SS download folder outside the Palworld server folder.', 422, 'framework_source_overlap');
  }
  const manifest = frameworkManifest(sourceRoot);
  const names = new Set(manifest.files.map((file) => file.path.toLowerCase()));
  if (!names.has('ue4ss.dll')) fail('The selected folder does not contain UE4SS.dll.', 422, 'framework_invalid');
  if (!names.has('dwmapi.dll')) fail('The selected folder does not contain the UE4SS dwmapi.dll proxy.', 422, 'framework_loader_missing');

  const targetRoot = safeResolve(server.dir, 'Pal/Binaries/Win64');
  const overwrite = manifest.files
    .filter((file) => fs.existsSync(path.join(targetRoot, ...file.path.split('/'))))
    .map((file) => `Pal/Binaries/Win64/${file.path}`);
  const plan = {
    serverId: server.id,
    framework: 'ue4ss',
    sourceFolder: sourceRoot,
    installPath: 'Pal/Binaries/Win64',
    files: manifest.files,
    sizeBytes: manifest.sizeBytes,
    overwrite,
    mode: detectFrameworks(server).find((item) => item.id === 'ue4ss')?.detected ? 'upgrade' : 'install',
    requiresOffline: true,
    wasRunning: manager ? manager.status !== 'offline' : false,
    createdAt: Date.now(),
  };
  const revision = revisionOf(plan);
  const token = crypto.randomBytes(32).toString('base64url');
  frameworkPreviews.set(token, {
    token, actorId, serverId: server.id, plan, revision, expiresAt: Date.now() + PREVIEW_TTL_MS,
  });
  return { ok: true, previewToken: token, revision, expiresAt: Date.now() + PREVIEW_TTL_MS, plan };
}

async function applyFrameworkFolder({ server, manager, actorId, previewToken, revision }) {
  const preview = frameworkPreviews.get(previewToken);
  if (!preview || preview.actorId !== actorId || preview.serverId !== server.id || preview.expiresAt < Date.now()) {
    fail('The UE4SS preview expired or is invalid. Select the folder again.', 409, 'invalid_preview');
  }
  if (revision !== preview.revision) fail('The UE4SS preview is stale. Select the folder again.', 409, 'stale_preview');
  const plan = preview.plan;
  const current = frameworkManifest(plan.sourceFolder);
  if (revisionOf({ ...plan, files: current.files, sizeBytes: current.sizeBytes }) !== preview.revision) {
    fail('The selected UE4SS folder changed after the preview. Preview it again.', 409, 'source_changed');
  }

  const wasRunning = !!manager && manager.status !== 'offline';
  let snapshot = null;
  let restartAttempted = false;
  try {
    if (wasRunning) {
      manager.stop(false);
      await waitFor(() => manager.status === 'offline', 90_000, 'The Palworld process did not stop in time.');
    }

    snapshot = snapshots.take({
      serverId: server.id,
      sourceDir: server.dir,
      scope: ['Pal/Binaries/Win64'],
      kind: 'palworld-framework',
      reason: `Before ${plan.mode} of UE4SS`,
      retention: 10,
    });
    if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');

    const targetRoot = safeResolve(server.dir, plan.installPath);
    const rollbackRoot = path.join(server.dir, '.fleetdeck', 'staging', `ue4ss-${crypto.randomUUID()}`);
    const written = [];
    try {
      for (const file of current.files) {
        const source = path.join(plan.sourceFolder, ...file.path.split('/'));
        const target = path.join(targetRoot, ...file.path.split('/'));
        const rollback = path.join(rollbackRoot, ...file.path.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (fs.existsSync(target)) {
          fs.mkdirSync(path.dirname(rollback), { recursive: true });
          fs.copyFileSync(target, rollback);
        }
        fs.copyFileSync(source, target);
        written.push({ target, rollback, existed: fs.existsSync(rollback) });
        if (hashFile(target) !== file.sha256) fail(`UE4SS file verification failed: ${file.path}`, 500, 'verify_failed');
      }
    } catch (error) {
      for (const item of written.reverse()) {
        try {
          if (item.existed) fs.copyFileSync(item.rollback, item.target);
          else fs.rmSync(item.target, { force: true });
        } catch (_) { /* the verified snapshot remains available */ }
      }
      throw error;
    } finally {
      fs.rmSync(rollbackRoot, { recursive: true, force: true });
      frameworkPreviews.delete(previewToken);
    }

    if (wasRunning) {
      restartAttempted = true;
      const started = manager.start();
      if (started?.ok === false) fail('UE4SS was installed, but Palworld could not be restarted.', 500, 'restart_failed');
    }
    return {
      ok: true,
      framework: detectFrameworks(server).find((item) => item.id === 'ue4ss'),
      snapshotId: snapshot.id,
      files: current.files.length,
      restarted: wasRunning,
    };
  } catch (error) {
    if (wasRunning && !restartAttempted && manager.status === 'offline') {
      try { manager.start(); } catch (_) { /* preserve the original error */ }
    }
    throw error;
  }
}

async function compatibility({ server, host = platform.hostPlatform(), detectRun } = {}) {
  const wineDetection = await platform.detectWine(server.palworldWine, { platform: process.platform, run: detectRun });
  const verdict = platform.compatibility({ server, wine: server.palworldWine, host, wineDetection });
  const frameworks = detectFrameworks(server);
  return {
    ...verdict,
    frameworks,
    kinds: Object.values(KINDS).map((kind) => {
      const framework = kind.framework ? frameworks.find((item) => item.id === kind.framework) : null;
      const targetOk = kind.targets.includes(verdict.target);
      return {
        id: kind.id,
        root: kind.root,
        targets: kind.targets,
        framework: kind.framework,
        supported: verdict.supported && targetOk && (!framework || framework.detected),
        reason: !verdict.supported ? verdict.reason
          : !targetOk ? 'target_unsupported'
            : framework && !framework.detected ? 'framework_missing'
              : null,
      };
    }),
  };
}

function assertKindSupported(compat, kind) {
  const entry = compat.kinds.find((item) => item.id === kind);
  if (!entry) fail('That package type is not supported.', 422, 'unsupported_kind');
  if (entry.supported) return entry;
  if (entry.reason === 'framework_missing') {
    fail(`This mod needs the ${FRAMEWORKS[KINDS[kind].framework].label} framework, which is not installed on this server.`, 409, 'framework_missing');
  }
  if (entry.reason === 'target_unsupported') {
    fail(`This mod requires a ${KINDS[kind].targets.join(' or ')}-target Palworld server; this server targets ${compat.target}.`, 409, 'target_unsupported');
  }
  fail(compat.explanation || 'This server cannot run mods in its current configuration.', 409, entry.reason || 'unsupported_platform');
  return entry;
}

// --- inventory view -------------------------------------------------------

function publicPackage(server, pkg, { verify = false } = {}) {
  return {
    id: pkg.id,
    name: pkg.name,
    slug: pkg.slug,
    provider: pkg.provider,
    sourceItemId: pkg.sourceItemId || null,
    version: pkg.version || null,
    kind: pkg.kind,
    framework: pkg.framework || null,
    targetPlatform: pkg.targetPlatform,
    installPath: pkg.enabled ? installRelative(pkg) : null,
    enabled: pkg.enabled,
    managed: true,
    fileCount: (pkg.files || []).length,
    sizeBytes: pkg.sizeBytes || 0,
    installedAt: pkg.installedAt,
    updatedAt: pkg.updatedAt || pkg.installedAt,
    restartRequired: KINDS[pkg.kind] ? KINDS[pkg.kind].restartRequired : true,
    clientRequired: pkg.clientRequired ?? null,
    license: pkg.license || null,
    archive: pkg.archive ? { fileName: pkg.archive.fileName, sha256: pkg.archive.sha256, bytes: pkg.archive.bytes } : null,
    update: pkg.update || { state: 'unchecked', checkedAt: null, latestVersion: null, error: null, stale: false },
    integrity: verify ? verifyPackage(server, pkg) : null,
  };
}

/*
 * Anything sitting in a managed root that no package claims. Unmanaged mods
 * are listed for visibility and are never moved, overwritten or deleted by a
 * Hostkind action until the operator adopts them.
 */
function unmanagedEntries(server, packages) {
  const owned = new Set(packages.filter((pkg) => pkg.enabled).map((pkg) => installRelative(pkg).toLowerCase()));
  const out = [];
  for (const kind of Object.values(KINDS)) {
    let root;
    try { root = safeResolve(server.dir, kind.root); } catch (_) { continue; }
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const rel = `${kind.root}/${entry.name}`;
      if (owned.has(rel.toLowerCase())) continue;
      const abs = path.join(root, entry.name);
      const isDir = entry.isDirectory();
      if (!isDir && !entry.isFile()) continue;
      out.push({
        path: rel,
        name: entry.name,
        kind: kind.id,
        managed: false,
        adoptable: isDir,
        fileCount: isDir ? walkFiles(abs).length : 1,
        sizeBytes: isDir ? directorySize(abs) : fs.statSync(abs).size,
      });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function inventory({ server, host = platform.hostPlatform(), verify = false, detectRun } = {}) {
  const state = readInventory(server);
  const compat = await compatibility({ server, host, detectRun });
  return {
    ok: true,
    inventoryVersion: INVENTORY_VERSION,
    readable: state.readable,
    compatibility: compat,
    packages: state.packages.map((pkg) => publicPackage(server, pkg, { verify })),
    unmanaged: unmanagedEntries(server, state.packages),
    trash: listTrash(server),
    restartRequired: state.packages.some((pkg) => pkg.pendingRestart),
  };
}

// --- import ---------------------------------------------------------------

function revisionOf(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sweepPreviews(now = Date.now()) {
  for (const [token, preview] of previews) {
    if (preview.expiresAt <= now) {
      try { if (preview.archivePath && fs.existsSync(preview.archivePath)) fs.unlinkSync(preview.archivePath); } catch (_) { /* swept later */ }
      previews.delete(token);
    }
  }
}

/*
 * Preview an import: what the archive contains, where it would land, what it
 * would overwrite, what it costs, and whether the server has to be stopped.
 * Nothing is written outside the upload staging area.
 */
async function previewImport({ server, manager, actorId, archivePath, fileName, requestedName, provider, sourceItemId, clientRequired, license, announceSeconds = 0, host = platform.hostPlatform(), detectRun }) {
  sweepPreviews();
  if (!archivePath || !fs.existsSync(archivePath)) fail('An uploaded package archive is required.', 400, 'archive_required');
  const scan = await scanArchive(archivePath);
  const classified = classify(scan.files);
  const compat = await compatibility({ server, host, detectRun });
  assertKindSupported(compat, classified.kind);

  const name = String(requestedName || classified.suggestedName || path.basename(fileName || archivePath, path.extname(fileName || archivePath))).trim().slice(0, 120);
  if (!name) fail('A package name is required.', 400, 'name_required');
  const slug = slugify(name);
  const state = readInventory(server);
  if (!state.readable) fail('The mod inventory could not be read. Repair it before importing.', 409, 'inventory_unreadable');

  const kind = KINDS[classified.kind];
  const targetRel = `${kind.root}/${slug}`;
  const existing = state.packages.find((pkg) => pkg.slug === slug && pkg.kind === classified.kind) || null;
  const targetAbs = safeResolve(server.dir, targetRel);
  const occupied = fs.existsSync(targetAbs);
  if (occupied && !existing) {
    fail(`"${slug}" already exists in ${kind.root} and is not managed by Hostkind. Adopt it first, or choose another name.`, 409, 'conflict_unmanaged');
  }

  const overwrite = existing ? (existing.files || []).map((file) => `${targetRel}/${file.path}`) : [];
  const archiveStat = fs.statSync(archivePath);
  const mode = existing ? 'update' : 'install';
  const plan = {
    serverId: server.id,
    mode,
    packageId: existing ? existing.id : crypto.randomUUID(),
    name,
    slug,
    kind: classified.kind,
    framework: classified.framework,
    targetPlatform: compat.target,
    installPath: targetRel,
    provider: provider === 'steam-workshop' ? 'steam-workshop' : 'local-archive',
    sourceItemId: sourceItemId ? String(sourceItemId).replace(/[^0-9]/g, '').slice(0, 24) || null : null,
    clientRequired: clientRequired == null ? null : !!clientRequired,
    license: license ? String(license).slice(0, 200) : null,
    version: String(Date.now()),
    archive: {
      fileName: path.basename(String(fileName || archivePath)).slice(0, 160),
      bytes: archiveStat.size,
      sha256: hashFile(archivePath),
      entries: scan.totals.entries,
      expandedBytes: scan.totals.totalSize,
    },
    files: classified.files,
    sizeBytes: classified.sizeBytes,
    strip: classified.strip,
    overwrite,
    replaces: existing ? { id: existing.id, name: existing.name, version: existing.version, fileCount: (existing.files || []).length } : null,
    diskEstimateBytes: Math.ceil(classified.sizeBytes * 2.2) + 16 * 1024 * 1024,
    restartRequired: kind.restartRequired,
    requiresOffline: true,
    announceSeconds: Math.max(0, Math.min(3600, Number(announceSeconds) || 0)),
    wasRunning: manager ? manager.status !== 'offline' : false,
    playerCount: Number(manager?.moduleState?.normalizedStatus?.playerCount) || 0,
    createdAt: Date.now(),
  };
  if (plan.provider === 'steam-workshop' && !plan.sourceItemId) {
    fail('A Steam Workshop item ID is required for a Workshop package.', 400, 'source_item_required');
  }

  const revision = revisionOf(plan);
  const token = crypto.randomBytes(32).toString('base64url');
  previews.set(token, { token, actorId, serverId: server.id, plan, revision, archivePath, expiresAt: Date.now() + PREVIEW_TTL_MS });
  return { ok: true, previewToken: token, revision, expiresAt: Date.now() + PREVIEW_TTL_MS, plan };
}

function takePreview({ token, actorId, serverId }) {
  sweepPreviews();
  const preview = previews.get(token);
  if (!preview || preview.actorId !== actorId || preview.serverId !== serverId) {
    fail('The import preview expired or is invalid. Preview the package again.', 409, 'invalid_preview');
  }
  return preview;
}

function waitFor(predicate, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    if (predicate()) return resolve();
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started >= timeoutMs) { clearInterval(timer); reject(new ModError(message, 500, 'timeout')); }
    }, 250);
  });
}

function moveInto(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.renameSync(source, destination);
}

/*
 * Apply an import as a durable operation:
 *   revalidate -> announce/stop -> snapshot -> extract to staging -> verify
 *   hashes and layout -> retire the previous version to trash -> commit by
 *   rename -> update the inventory -> validate -> optional restart.
 *
 * Every failure after the snapshot puts the previous version back; only a
 * failure of that compensation escalates to recovery_required.
 */
async function applyImport({ server, manager, actorId, idempotencyKey, previewToken, revision, announce, createBackup, restart = true, backupRequired = false }) {
  if (!idempotencyKey) fail('An Idempotency-Key header is required.', 400, 'idempotency_key_required');
  const replayKey = `${actorId}:${idempotencyKey}`;
  if (replays.has(replayKey)) return { ...replays.get(replayKey), replay: true };
  const preview = takePreview({ token: previewToken, actorId, serverId: server.id });
  if (!revision || revision !== preview.revision) fail('The import preview is stale. Preview the package again.', 409, 'stale_preview');
  const plan = preview.plan;

  const op = operations.create({
    kind: 'palworld-mod-import',
    actorId,
    serverId: server.id,
    idempotencyKey,
    summary: { mode: plan.mode, name: plan.name, kind: plan.kind, provider: plan.provider, installPath: plan.installPath },
  });
  if (op.state !== operations.STATES.QUEUED) return { operation: op, replay: true, completed: Promise.resolve(op) };
  operations.start(op.id, { phase: 'revalidate' });
  if (!operations.acquireServerLock(op.id, server.id)) {
    operations.fail(op.id, { code: 'server_busy', text: 'Another operation is running for this server.' });
    fail('Another operation is running for this server.', 409, 'server_busy');
  }

  const staging = path.join(server.dir, '.fleetdeck', 'staging', op.id, 'payload');
  const targetAbs = safeResolve(server.dir, plan.installPath);
  const trashId = `${Date.now().toString(36)}-${op.id.slice(0, 8)}`;
  let snapshot = null;
  let retired = null;
  let committed = false;

  const completed = (async () => {
    try {
      const compat = await compatibility({ server });
      assertKindSupported(compat, plan.kind);
      const state = readInventory(server);
      if (!state.readable) fail('The mod inventory could not be read.', 409, 'inventory_unreadable');
      const existing = state.packages.find((item) => item.id === plan.packageId) || null;
      if (plan.mode === 'update' && !existing) fail('The package this update replaces is no longer installed.', 409, 'package_not_found');
      if (plan.mode === 'install' && fs.existsSync(targetAbs)) fail('The install path is no longer free.', 409, 'conflict_unmanaged');

      if (manager && manager.status !== 'offline') {
        if (plan.announceSeconds && announce) {
          operations.heartbeat(op.id, { phase: 'announce', progress: 0.05 });
          await announce(plan.announceSeconds);
        }
        operations.heartbeat(op.id, { phase: 'stop', progress: 0.1 });
        manager.stop(false);
        await waitFor(() => manager.status === 'offline', 90_000, 'The Palworld process did not stop in time.');
      }

      if (backupRequired && createBackup) {
        operations.heartbeat(op.id, { phase: 'backup', progress: 0.15 });
        await createBackup();
      }

      operations.heartbeat(op.id, { phase: 'snapshot', progress: 0.2 });
      const scope = existing && existing.enabled ? [installRelative(existing)] : [];
      snapshot = snapshots.take({
        serverId: server.id,
        sourceDir: server.dir,
        scope: scope.length ? scope.map((rel) => rel.split('/').join(path.sep)) : [path.join('Pal', 'Content', 'Paks', '~mods')],
        kind: 'palworld-mod',
        reason: `Before ${plan.mode} of ${plan.name}`,
        retention: 10,
      });
      if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');

      operations.heartbeat(op.id, { phase: 'extract', progress: 0.35 });
      await extractArchive(preview.archivePath, plan.strip, staging);

      operations.heartbeat(op.id, { phase: 'verify', progress: 0.6 });
      const staged = manifestOf(staging);
      const expected = new Map(plan.files.map((file) => [file.path, file.bytes]));
      if (staged.length !== expected.size) fail('The staged package does not match the preview.', 500, 'staging_mismatch');
      for (const file of staged) {
        if (!expected.has(file.path)) fail(`The staged package contains an unexpected file: ${file.path}`, 500, 'staging_mismatch');
        if (expected.get(file.path) !== file.bytes) fail(`The staged file ${file.path} has an unexpected size.`, 500, 'staging_mismatch');
        if (BLOCKED_EXTENSIONS.includes(path.extname(file.path).toLowerCase())) fail(`The staged package contains executable content: ${file.path}`, 422, 'executable_content');
      }

      // Late re-check: a server that came back up while we were staging must
      // not be committed over.
      if (manager && manager.status !== 'offline') fail('The server started while the package was staging. Stop it and try again.', 409, 'server_online');

      operations.heartbeat(op.id, { phase: 'commit', progress: 0.75 });
      if (fs.existsSync(targetAbs)) {
        retired = path.join(trashDir(server, trashId), 'payload');
        moveInto(targetAbs, retired);
      }
      moveInto(staging, targetAbs);
      committed = true;

      const next = {
        id: plan.packageId,
        name: plan.name,
        slug: plan.slug,
        provider: plan.provider,
        sourceItemId: plan.sourceItemId,
        version: plan.version,
        kind: plan.kind,
        framework: plan.framework,
        targetPlatform: plan.targetPlatform,
        enabled: true,
        installedAt: existing?.installedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        actorId,
        archive: plan.archive,
        files: staged,
        sizeBytes: staged.reduce((total, file) => total + file.bytes, 0),
        clientRequired: plan.clientRequired,
        license: plan.license,
        // The operator downloaded this archive just now, so the installed
        // content is at least as new as this moment. A Workshop item whose
        // upstream timestamp moves past it is genuinely a newer release.
        workshopUpdatedAt: Math.floor(Date.now() / 1000),
        update: { state: 'unchecked', checkedAt: null, latestVersion: null, error: null, stale: false },
        pendingRestart: !!plan.wasRunning && !restart,
      };
      const packages = state.packages.filter((item) => item.id !== plan.packageId).concat(next);
      writeInventory(server, { packages });
      if (retired) {
        fs.writeFileSync(path.join(trashDir(server, trashId), 'manifest.json'), JSON.stringify({
          id: trashId, packageId: plan.packageId, name: existing?.name || plan.name, kind: plan.kind,
          slug: plan.slug, reason: 'replaced', removedAt: new Date().toISOString(), package: existing || null,
        }, null, 2));
      }

      operations.heartbeat(op.id, { phase: 'validate', progress: 0.9 });
      const integrity = verifyPackage(server, next);
      if (!integrity.ok) fail('The installed package could not be verified after the commit.', 500, 'verify_failed');

      if (plan.wasRunning && restart && manager) {
        operations.heartbeat(op.id, { phase: 'restart', progress: 0.95 });
        const started = manager.start();
        if (started?.ok === false) fail('Palworld could not be restarted after the mod change.', 500, 'restart_failed');
      }
      operations.finish(op.id, { packageId: plan.packageId, snapshotId: snapshot.id, trashId: retired ? trashId : null, files: staged.length });
      return operations.get(op.id);
    } catch (error) {
      let compensated = true;
      try {
        if (!committed) {
          if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
          if (retired && fs.existsSync(retired)) moveInto(retired, targetAbs);
        }
      } catch (_) { compensated = false; }
      const payload = {
        code: error.code || 'mod_import_failed',
        text: error.message,
        recovery: {
          snapshotId: snapshot?.id || null,
          trashId: retired ? trashId : null,
          instructions: committed
            ? 'The package was committed but a later step failed. The previous version is in the mod trash and the snapshot covers the mod folder; review both before starting the server.'
            : 'Nothing was committed. The staged copy was discarded and the previous version left in place.',
        },
      };
      if (committed || !compensated) operations.markRecoveryRequired(op.id, payload);
      else operations.fail(op.id, payload);
      return operations.get(op.id);
    } finally {
      try { fs.rmSync(path.join(server.dir, '.fleetdeck', 'staging', op.id), { recursive: true, force: true }); } catch (_) { /* swept on boot */ }
      try { if (fs.existsSync(preview.archivePath)) fs.unlinkSync(preview.archivePath); } catch (_) { /* swept later */ }
      previews.delete(preview.token);
    }
  })();

  const result = { operation: operations.get(op.id), replay: false, completed };
  replays.set(replayKey, { operation: result.operation });
  return result;
}

// --- enable / disable (reversible parking) --------------------------------

/*
 * Disabling parks the installed folder under the server's mod state directory
 * instead of deleting it, so re-enabling is a rename back. Both directions
 * need the server stopped: Palworld reads its pak and script folders at start
 * and holds the files open on Windows.
 */
function setEnabled({ server, manager, packageId, enabled }) {
  const { inventory: state, pkg } = findPackage(server, packageId);
  if (manager && manager.status !== 'offline') {
    fail('Stop the server before enabling or disabling mods.', 409, 'server_online');
  }
  if (!!pkg.enabled === !!enabled) return { ok: true, package: publicPackage(server, pkg), changed: false };
  const live = safeResolve(server.dir, installRelative(pkg));
  const parked = parkedDir(server, pkg.id);
  if (enabled) {
    if (!fs.existsSync(parked)) fail('The parked copy of this mod is missing.', 409, 'parked_missing');
    if (fs.existsSync(live)) fail('Something else already occupies the install path.', 409, 'conflict_unmanaged');
    moveInto(parked, live);
  } else {
    if (!fs.existsSync(live)) fail('The installed copy of this mod is missing.', 409, 'install_missing');
    if (fs.existsSync(parked)) fs.rmSync(parked, { recursive: true, force: true });
    moveInto(live, parked);
  }
  const next = { ...pkg, enabled: !!enabled, updatedAt: new Date().toISOString() };
  writeInventory(server, { packages: state.packages.map((item) => (item.id === pkg.id ? next : item)) });
  return { ok: true, package: publicPackage(server, next), changed: true, restartRequired: true };
}

// --- removal (recoverable trash + snapshot) -------------------------------

function listTrash(server) {
  const root = path.join(stateDir(server), 'trash');
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, entry.name, 'manifest.json'), 'utf8'));
      const payload = path.join(root, entry.name, 'payload');
      out.push({
        id: manifest.id || entry.name,
        name: manifest.name,
        kind: manifest.kind,
        slug: manifest.slug,
        reason: manifest.reason,
        removedAt: manifest.removedAt,
        snapshotId: manifest.snapshotId || null,
        sizeBytes: fs.existsSync(payload) ? directorySize(payload) : 0,
        restorable: fs.existsSync(payload),
      });
    } catch (_) { /* a trash entry without a manifest is not offered for restore */ }
  }
  return out.sort((a, b) => String(b.removedAt).localeCompare(String(a.removedAt)));
}

function remove({ server, manager, packageId, reason = 'removed' }) {
  const { inventory: state, pkg } = findPackage(server, packageId);
  if (manager && manager.status !== 'offline') {
    fail('Stop the server before removing mods.', 409, 'server_online');
  }
  const source = installAbsolute(server, pkg);
  const trashId = `${Date.now().toString(36)}-${pkg.id.slice(0, 8)}`;
  const destination = path.join(trashDir(server, trashId), 'payload');
  let snapshot = null;
  if (pkg.enabled && fs.existsSync(source)) {
    snapshot = snapshots.take({
      serverId: server.id,
      sourceDir: server.dir,
      scope: [installRelative(pkg).split('/').join(path.sep)],
      kind: 'palworld-mod',
      reason: `Before removing ${pkg.name}`,
      retention: 10,
    });
    if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');
  }
  if (fs.existsSync(source)) moveInto(source, destination);
  fs.mkdirSync(trashDir(server, trashId), { recursive: true });
  fs.writeFileSync(path.join(trashDir(server, trashId), 'manifest.json'), JSON.stringify({
    id: trashId, packageId: pkg.id, name: pkg.name, kind: pkg.kind, slug: pkg.slug,
    reason, removedAt: new Date().toISOString(), snapshotId: snapshot?.id || null, package: pkg,
  }, null, 2));
  writeInventory(server, { packages: state.packages.filter((item) => item.id !== pkg.id) });
  return { ok: true, trashId, snapshotId: snapshot?.id || null, restartRequired: true };
}

function restoreTrash({ server, manager, trashId }) {
  const dir = trashDir(server, String(trashId || '').replace(/[^a-zA-Z0-9-]/g, ''));
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) fail('That trash entry was not found.', 404, 'trash_not_found');
  if (manager && manager.status !== 'offline') fail('Stop the server before restoring mods.', 409, 'server_online');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const payload = path.join(dir, 'payload');
  if (!fs.existsSync(payload)) fail('That trash entry has no restorable files.', 409, 'trash_empty');
  const pkg = manifest.package;
  if (!pkg) fail('That trash entry has no package record to restore.', 409, 'trash_incomplete');
  const state = readInventory(server);
  if (state.packages.some((item) => item.id === pkg.id)) fail('That package is already installed.', 409, 'already_installed');
  const target = safeResolve(server.dir, installRelative(pkg));
  if (fs.existsSync(target)) fail('Something else already occupies the install path.', 409, 'conflict_unmanaged');
  moveInto(payload, target);
  const restored = { ...pkg, enabled: true, updatedAt: new Date().toISOString() };
  writeInventory(server, { packages: [...state.packages, restored] });
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, package: publicPackage(server, restored), restartRequired: true };
}

// --- adoption of unmanaged mods -------------------------------------------

/*
 * Adoption is the only way an unmanaged mod becomes eligible for updates or
 * removal. It records what is already on disk; it never moves or rewrites it.
 */
function adopt({ server, relPath, name, provider, sourceItemId }) {
  const state = readInventory(server);
  if (!state.readable) fail('The mod inventory could not be read.', 409, 'inventory_unreadable');
  // The negative lookbehind makes the trailing-slash alternative unambiguous,
  // so a run of slashes cannot be split across backtracking positions
  // (CodeQL js/polynomial-redos).
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\/+|(?<!\/)\/+$/g, '');
  const kind = Object.values(KINDS).find((item) => normalized.startsWith(`${item.root}/`) && normalized.split('/').length === item.root.split('/').length + 1);
  if (!kind) fail('Only a top-level folder inside a managed mod directory can be adopted.', 400, 'not_adoptable');
  const abs = safeResolve(server.dir, normalized);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) fail('That mod folder was not found.', 404, 'not_found');
  const slug = normalized.split('/').pop();
  if (state.packages.some((pkg) => pkg.kind === kind.id && pkg.slug === slug)) fail('That mod is already managed.', 409, 'already_managed');
  const files = manifestOf(abs);
  if (!files.length) fail('That folder is empty.', 409, 'empty_folder');
  const blocked = files.find((file) => BLOCKED_EXTENSIONS.includes(path.extname(file.path).toLowerCase()));
  if (blocked) fail(`That folder contains executable content (${blocked.path}) and cannot be managed.`, 422, 'executable_content');
  const pkg = {
    id: crypto.randomUUID(),
    name: String(name || slug).slice(0, 120),
    slug,
    provider: provider === 'steam-workshop' ? 'steam-workshop' : 'adopted',
    sourceItemId: sourceItemId ? String(sourceItemId).replace(/[^0-9]/g, '').slice(0, 24) || null : null,
    version: null,
    kind: kind.id,
    framework: kind.framework,
    targetPlatform: platform.targetPlatform(server),
    enabled: true,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archive: null,
    files,
    sizeBytes: files.reduce((total, file) => total + file.bytes, 0),
    clientRequired: null,
    license: null,
    adopted: true,
    update: { state: 'unchecked', checkedAt: null, latestVersion: null, error: null, stale: false },
  };
  writeInventory(server, { packages: [...state.packages, pkg] });
  return { ok: true, package: publicPackage(server, pkg) };
}

// --- update checks --------------------------------------------------------

function parseWorkshopDetails(body) {
  const details = body?.response?.publishedfiledetails;
  if (!Array.isArray(details)) throw new ModError('Steam returned an unexpected response.', 502, 'workshop_malformed');
  const out = new Map();
  for (const item of details) {
    const id = String(item?.publishedfileid || '');
    if (!id) continue;
    out.set(id, {
      ok: Number(item.result) === 1,
      title: typeof item.title === 'string' ? item.title.slice(0, 160) : null,
      timeUpdated: Number(item.time_updated) || null,
      fileSize: Number(item.file_size) || null,
    });
  }
  return out;
}

async function fetchWorkshopDetails(ids, { fetchImpl = global.fetch, timeoutMs = 8000 } = {}) {
  const body = new URLSearchParams();
  body.set('itemcount', String(ids.length));
  ids.forEach((id, index) => body.set(`publishedfileids[${index}]`, id));
  const response = await fetchImpl(WORKSHOP_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'user-agent': 'Hostkind/1.0' },
    body: body.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new ModError(`Steam Workshop metadata is unavailable (HTTP ${response.status}).`, 502, 'workshop_unavailable');
  return parseWorkshopDetails(await response.json());
}

/*
 * Update freshness. Workshop packages are checked against the authoritative
 * published-file metadata; a package imported from a local archive has no
 * upstream, so it reports `manual` rather than pretending to be current.
 * Outages fall back to the cached answer and are labelled stale.
 */
async function checkUpdates({ server, force = false, now = Date.now(), fetchImpl, timeoutMs }) {
  const state = readInventory(server);
  if (!state.readable) fail('The mod inventory could not be read.', 409, 'inventory_unreadable');
  const workshop = state.packages.filter((pkg) => pkg.provider === 'steam-workshop' && pkg.sourceItemId);
  const ids = [...new Set(workshop.map((pkg) => pkg.sourceItemId))];
  let details = new Map();
  let error = null;
  let stale = false;
  let retrievedAt = now;

  if (ids.length) {
    const cached = updateCache.get(server.id);
    if (!force && cached && now - cached.retrievedAt < UPDATE_CACHE_TTL_MS) {
      details = cached.details;
      retrievedAt = cached.retrievedAt;
    } else {
      try {
        details = await fetchWorkshopDetails(ids, { fetchImpl, timeoutMs });
        updateCache.set(server.id, { details, retrievedAt: now });
      } catch (err) {
        if (cached && now - cached.retrievedAt <= UPDATE_MAX_STALE_MS) {
          details = cached.details;
          retrievedAt = cached.retrievedAt;
          stale = true;
          error = 'Steam Workshop metadata is temporarily unavailable; showing the last known result.';
        } else {
          error = 'Steam Workshop metadata is unavailable.';
          stale = true;
        }
      }
    }
  }

  const checkedAt = new Date(now).toISOString();
  const packages = state.packages.map((pkg) => {
    if (pkg.provider !== 'steam-workshop' || !pkg.sourceItemId) {
      return { ...pkg, update: { state: 'manual', checkedAt, latestVersion: null, title: null, error: null, stale: false, source: 'local-archive' } };
    }
    const detail = details.get(pkg.sourceItemId);
    if (!detail) {
      return { ...pkg, update: { state: 'unavailable', checkedAt, latestVersion: pkg.update?.latestVersion || null, title: null, error: error || 'Steam did not return this Workshop item.', stale: true, source: 'steam-workshop' } };
    }
    if (!detail.ok) {
      return { ...pkg, update: { state: 'unavailable', checkedAt, latestVersion: null, title: detail.title, error: 'The Workshop item is no longer published.', stale, source: 'steam-workshop' } };
    }
    const latest = detail.timeUpdated ? String(detail.timeUpdated) : null;
    const installed = Number(pkg.workshopUpdatedAt || 0);
    // An adopted package has no import baseline, so freshness is reported as
    // unknown rather than guessed in either direction.
    const ready = !!installed && !!detail.timeUpdated && detail.timeUpdated > installed;
    return {
      ...pkg,
      update: {
        state: !installed ? 'unknown' : ready ? 'update-ready' : 'current',
        checkedAt,
        latestVersion: latest,
        title: detail.title,
        error: error || null,
        stale,
        source: 'steam-workshop',
        note: ready ? 'reimport_required' : null,
      },
    };
  });
  writeInventory(server, { packages });
  return {
    ok: true,
    checkedAt,
    retrievedAt: new Date(retrievedAt).toISOString(),
    stale,
    error,
    packages: packages.map((pkg) => publicPackage(server, pkg)),
  };
}

function resetCaches() {
  updateCache = new Map();
  previews.clear();
  frameworkPreviews.clear();
  replays.clear();
}

module.exports = {
  INVENTORY_VERSION, KINDS, FRAMEWORKS, BLOCKED_EXTENSIONS, MAX_ENTRIES, MAX_BYTES, ModError,
  stateDir, inventoryPath, parkedDir, trashDir, slugify,
  readInventory, writeInventory, verifyPackage, installRelative, installAbsolute,
  scanArchive, extractArchive, classify, detectFrameworks, compatibility, assertKindSupported,
  previewFrameworkFolder, applyFrameworkFolder,
  inventory, publicPackage, unmanagedEntries,
  previewImport, applyImport, setEnabled, remove, listTrash, restoreTrash, adopt,
  parseWorkshopDetails, checkUpdates, resetCaches,
};
