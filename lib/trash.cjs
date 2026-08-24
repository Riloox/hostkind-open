'use strict';

/*
 * Recoverable deletion (docs/palworld/07-portability-safety.md "Recoverable
 * deletion").
 *
 * Spec contract:
 *   - "Use OS Trash/Recycle Bin when reliably available. If unavailable, use a
 *      documented Hostkind quarantine on the same filesystem with retention
 *      and restore UI; never silently fall back from a recoverable action to
 *      permanent recursive deletion."
 *   - "Backup, mod, save, and profile deletion should follow the same
 *      recoverable-deletion vocabulary."
 *
 * The vocabulary this module owns, and which callers must not paraphrase:
 *
 *   trash   - the files still exist and can be restored (recoverable);
 *   restore - put a trashed payload back where it came from;
 *   purge   - permanent, irreversible, and only ever explicitly requested.
 *
 * There is no code path here that turns a `trash` request into a `purge`. If
 * quarantine cannot be established, the call throws and the files stay where
 * they are - a failed recoverable delete is a much better outcome than a
 * surprise permanent one.
 *
 * Layout. Every entry has its manifest under the Hostkind data directory so a
 * single directory read enumerates the trash:
 *
 *   data/trash/<id>/manifest.json
 *   data/trash/<id>/payload            <- when the data dir is on the same
 *                                         filesystem as the deleted folder
 *   <parent>/.fleetdeck-trash/<id>/payload
 *                                      <- otherwise: quarantine stays on the
 *                                         source filesystem, so the move is a
 *                                         rename and never a half-finished copy
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { dataDir } = require('./db.cjs');
const pathSafety = require('./pathSafety.cjs');

const QUARANTINE_DIR = '.fleetdeck-trash';
const DEFAULT_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 365;

function fail(message, status = 400, code = 'trash_error') {
  return Object.assign(new Error(message), { status, code });
}

function trashRoot() {
  return path.join(dataDir(), 'trash');
}

function entryDir(id) {
  return path.join(trashRoot(), safeId(id));
}

function safeId(id) {
  const value = String(id || '').replace(/[^a-zA-Z0-9-]/g, '');
  if (!value) throw fail('A trash entry id is required.', 400, 'invalid_id');
  return value;
}

function measure(target) {
  let fileCount = 0;
  let sizeBytes = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    let stat;
    try { stat = fs.lstatSync(current); } catch { continue; }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) stack.push(path.join(current, name));
    } else {
      fileCount += 1;
      sizeBytes += stat.size;
    }
  }
  return { fileCount, sizeBytes };
}

/*
 * Detection only, and deliberately conservative: an OS trash we cannot restore
 * from is still recoverable *by the operator*, but Hostkind must be honest
 * that its own restore button will not bring it back.
 */
function detectOsTrash({ platform = process.platform, probe } = {}) {
  const run = probe || ((file, args) => {
    try { execFileSync(file, args, { stdio: 'ignore', timeout: 4000, windowsHide: true }); return true; } catch { return false; }
  });
  if (platform === 'linux') {
    if (run('gio', ['--version'])) return { available: true, method: 'gio', restorable: false };
    if (run('trash-put', ['--version'])) return { available: true, method: 'trash-cli', restorable: false };
    return { available: false, method: null, restorable: false };
  }
  if (platform === 'darwin') {
    if (run('osascript', ['-e', 'return 1'])) return { available: true, method: 'finder', restorable: false };
    return { available: false, method: null, restorable: false };
  }
  if (platform === 'win32') {
    if (run('powershell', ['-NoProfile', '-Command', 'exit 0'])) return { available: true, method: 'recycle-bin', restorable: false };
    return { available: false, method: null, restorable: false };
  }
  return { available: false, method: null, restorable: false };
}

function sendToOsTrash(target, method) {
  if (method === 'gio') execFileSync('gio', ['trash', '--', target], { timeout: 30000, windowsHide: true });
  else if (method === 'trash-cli') execFileSync('trash-put', ['--', target], { timeout: 30000, windowsHide: true });
  else if (method === 'finder') execFileSync('osascript', ['-e', `tell application "Finder" to delete POSIX file ${JSON.stringify(target)}`], { timeout: 30000 });
  else if (method === 'recycle-bin') {
    execFileSync('powershell', ['-NoProfile', '-Command',
      'Add-Type -AssemblyName Microsoft.VisualBasic;'
      + `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(${JSON.stringify(target)},'OnlyErrorDialogs','SendToRecycleBin')`,
    ], { timeout: 60000, windowsHide: true });
  } else throw fail('No OS trash implementation is available.', 500, 'os_trash_unavailable');
}

function writeManifest(manifest) {
  const dir = entryDir(manifest.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

function readManifest(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(entryDir(id), 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

/*
 * Move `target` into recoverable trash. Throws rather than deleting anything
 * when quarantine cannot be established.
 */
function moveToTrash({
  target,
  kind = 'files',
  serverId = null,
  label = null,
  reason = null,
  actorId = null,
  retentionDays = DEFAULT_RETENTION_DAYS,
  useOsTrash = false,
  servers = [],
  selfId = null,
  requireExisting = true,
  detectImpl = detectOsTrash,
  // 'root' is a whole server folder and gets the full protected-root guard.
  // 'item' is a single managed artefact (a backup archive, an exported profile)
  // that legitimately lives inside a Hostkind-owned directory.
  scope = 'root',
} = {}) {
  const resolved = pathSafety.canonical(target);
  if (!fs.existsSync(resolved)) {
    if (requireExisting) throw fail('That path no longer exists.', 404, 'not_found');
    return null;
  }
  if (scope === 'root') {
    // The same guard adoption uses: a drive root, a home root, Hostkind's own
    // data, or another server's folder is never trashable as a whole.
    pathSafety.assertUsableRoot(resolved, { servers, selfId, requireExisting: true });
  } else if (pathSafety.isRoot(resolved)) {
    throw fail('A drive or filesystem root is never trashable.', 409, 'drive_root');
  }

  const id = crypto.randomUUID();
  const stats = measure(resolved);
  const retention = Math.min(MAX_RETENTION_DAYS, Math.max(1, Number(retentionDays) || DEFAULT_RETENTION_DAYS));
  const now = Date.now();
  const base = {
    id,
    kind,
    serverId,
    label: label ? String(label).slice(0, 200) : path.basename(resolved),
    reason: reason ? String(reason).slice(0, 200) : null,
    actorId,
    originalPath: resolved,
    trashedAt: new Date(now).toISOString(),
    retentionDays: retention,
    expiresAt: new Date(now + retention * 86400_000).toISOString(),
    fileCount: stats.fileCount,
    sizeBytes: stats.sizeBytes,
  };

  if (useOsTrash) {
    const os = detectImpl();
    if (!os.available) throw fail('This host has no usable OS trash. Use the Hostkind quarantine instead.', 409, 'os_trash_unavailable');
    sendToOsTrash(resolved, os.method);
    return writeManifest({ ...base, location: 'os', method: os.method, payloadPath: null, restorable: false });
  }

  const dir = entryDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const preferred = path.join(dir, 'payload');
  try {
    fs.renameSync(resolved, preferred);
    return writeManifest({ ...base, location: 'data', method: 'quarantine', payloadPath: preferred, restorable: true });
  } catch (error) {
    if (error.code !== 'EXDEV') {
      fs.rmSync(dir, { recursive: true, force: true });
      throw fail(`The files could not be moved to trash: ${error.message}`, 500, 'trash_failed');
    }
  }
  // Different filesystem: quarantine beside the source so the move stays a
  // rename. A cross-device copy could half-succeed, and a half-copied delete
  // is exactly the outcome this module exists to prevent.
  const fallback = path.join(path.dirname(resolved), QUARANTINE_DIR, id, 'payload');
  try {
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    fs.renameSync(resolved, fallback);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw fail(`The files could not be quarantined: ${error.message}`, 500, 'quarantine_failed');
  }
  return writeManifest({ ...base, location: 'quarantine', method: 'quarantine', payloadPath: fallback, restorable: true });
}

function publicEntry(manifest) {
  if (!manifest) return null;
  return {
    id: manifest.id,
    kind: manifest.kind,
    serverId: manifest.serverId || null,
    label: manifest.label,
    reason: manifest.reason || null,
    trashedAt: manifest.trashedAt,
    expiresAt: manifest.expiresAt,
    retentionDays: manifest.retentionDays,
    fileCount: manifest.fileCount,
    sizeBytes: manifest.sizeBytes,
    location: manifest.location,
    originalPath: manifest.originalPath,
    restorable: !!manifest.restorable && !!manifest.payloadPath && fs.existsSync(manifest.payloadPath),
  };
}

function list({ serverId = null, kind = null } = {}) {
  const root = trashRoot();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = readManifest(entry.name);
    if (!manifest) continue;
    if (serverId && manifest.serverId !== serverId) continue;
    if (kind && manifest.kind !== kind) continue;
    out.push(publicEntry(manifest));
  }
  return out.sort((a, b) => String(b.trashedAt).localeCompare(String(a.trashedAt)));
}

function get(id) {
  return publicEntry(readManifest(id));
}

/*
 * Put a payload back where it came from. Restoring over something that already
 * occupies the original path would be a silent merge, so it is refused.
 */
function restore(id, { servers = [] } = {}) {
  const manifest = readManifest(id);
  if (!manifest) throw fail('That trash entry was not found.', 404, 'not_found');
  if (!manifest.payloadPath || !fs.existsSync(manifest.payloadPath)) {
    throw fail(manifest.location === 'os'
      ? 'This item was sent to the operating system trash. Restore it from there.'
      : 'That trash entry has no restorable files.', 409, 'not_restorable');
  }
  const destination = manifest.originalPath;
  if (fs.existsSync(destination)) throw fail('Something else already occupies the original path.', 409, 'destination_occupied');
  const conflict = servers.find((server) => server && server.dir && pathSafety.overlaps(server.dir, destination));
  if (conflict) throw fail('Another registered server now overlaps that path.', 409, 'server_overlap');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.renameSync(manifest.payloadPath, destination);
  } catch (error) {
    throw fail(`The files could not be restored: ${error.message}`, 500, 'restore_failed');
  }
  cleanupEntry(manifest);
  return { ok: true, restoredTo: destination, entry: publicEntry({ ...manifest, payloadPath: null, restorable: false }) };
}

function cleanupEntry(manifest) {
  fs.rmSync(entryDir(manifest.id), { recursive: true, force: true });
  if (manifest.location === 'quarantine' && manifest.payloadPath) {
    const holder = path.dirname(manifest.payloadPath);
    fs.rmSync(holder, { recursive: true, force: true });
    const quarantine = path.dirname(holder);
    try { if (!fs.readdirSync(quarantine).length) fs.rmdirSync(quarantine); } catch { /* other entries remain */ }
  }
}

/*
 * Permanent and irreversible. Only ever called from an explicit "delete
 * permanently" action or from retention sweeping, never as a fallback.
 */
function purge(id) {
  const manifest = readManifest(id);
  if (!manifest) throw fail('That trash entry was not found.', 404, 'not_found');
  if (manifest.payloadPath) fs.rmSync(manifest.payloadPath, { recursive: true, force: true });
  cleanupEntry(manifest);
  return { ok: true, id: manifest.id, purged: true };
}

/*
 * Retention sweep. Entries older than their documented retention are purged;
 * everything else is left alone.
 */
function sweep({ now = Date.now() } = {}) {
  const purged = [];
  for (const entry of list()) {
    if (!entry.expiresAt || Date.parse(entry.expiresAt) > now) continue;
    try { purge(entry.id); purged.push(entry.id); } catch { /* reported on the next sweep */ }
  }
  return purged;
}

module.exports = {
  DEFAULT_RETENTION_DAYS,
  QUARANTINE_DIR,
  trashRoot,
  detectOsTrash,
  moveToTrash,
  list,
  get,
  restore,
  purge,
  sweep,
  measure,
};
