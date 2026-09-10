'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open } = require('./db.cjs');
const { safeResolve } = require('./files.cjs');

const MAX_FILES = 20000;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const EXCLUDED_ROOTS = new Set([
  '.fleetdeck', '.lodestone', 'logs', 'crash-reports', 'cache', 'caches', 'world',
  'world_nether', 'world_the_end', 'backups',
]);
const EXCLUDED_FILES = new Set([
  'server.properties', 'eula.txt', 'ops.json', 'whitelist.json', 'banned-ips.json',
  'banned-players.json', 'usercache.json', 'usernamecache.json',
]);
const SECRET_RE = /(^|\/)(?:\.env(?:\..*)?|.*(?:secret|token|credential|password|private[-_.]?key).*)$/i;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeRelative(input) {
  if (typeof input !== 'string' || !input || input.includes('\0')) return null;
  const rel = input.replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.posix.isAbsolute(rel) || /^[a-z]:/i.test(rel)) return null;
  const normalized = path.posix.normalize(rel);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function exclusionReason(input, worlds = []) {
  const rel = normalizeRelative(input);
  if (!rel) return 'unsafe_path';
  const parts = rel.split('/');
  const root = parts[0].toLowerCase();
  const worldRoots = new Set(worlds.map((w) => normalizeRelative(w)).filter(Boolean).map((w) => w.split('/')[0].toLowerCase()));
  if (EXCLUDED_ROOTS.has(root) || worldRoots.has(root)) return 'operator_data';
  if (EXCLUDED_FILES.has(rel.toLowerCase())) return 'identity_or_secret';
  if (SECRET_RE.test(rel)) return 'secret';
  return null;
}

function validateFiles(files, worlds = []) {
  if (!Array.isArray(files)) throw new Error('Invalid modpack manifest');
  if (files.length > MAX_FILES) throw new Error('Modpack contains too many files');
  let total = 0;
  const seen = new Set();
  const accepted = [];
  const excluded = [];
  for (const raw of files) {
    const relativePath = normalizeRelative(raw.relativePath || raw.path);
    if (!relativePath) throw new Error('Modpack contains an unsafe path');
    if (seen.has(relativePath.toLowerCase())) throw new Error(`Duplicate modpack path: ${relativePath}`);
    seen.add(relativePath.toLowerCase());
    const size = Number(raw.sizeBytes ?? raw.size ?? 0);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw new Error(`Invalid modpack file size: ${relativePath}`);
    total += size;
    if (total > MAX_TOTAL_BYTES) throw new Error('Modpack is too large');
    const reason = exclusionReason(relativePath, worlds);
    const item = { ...raw, relativePath, sizeBytes: size, sha256: String(raw.sha256 || raw.hash || '').toLowerCase() };
    if (!/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error(`Missing verified SHA-256: ${relativePath}`);
    if (reason) excluded.push({ relativePath, reason });
    else accepted.push(item);
  }
  return { accepted, excluded, totalBytes: total };
}

function diskHash(root, relativePath) {
  const full = safeResolve(root, relativePath);
  if (!full || !fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return sha256(fs.readFileSync(full));
}

function classify(oldHash, disk, nextHash) {
  if (oldHash == null) {
    if (disk == null) return 'addition';
    return disk === nextHash ? 'converged' : 'conflict';
  }
  if (nextHash == null) {
    if (disk == null) return 'already_removed';
    return disk === oldHash ? 'safe_removal' : 'local_edit';
  }
  const localChanged = disk !== oldHash;
  const upstreamChanged = nextHash !== oldHash;
  if (!localChanged && !upstreamChanged) return 'unchanged';
  if (!localChanged && upstreamChanged) return 'safe_update';
  if (localChanged && !upstreamChanged) return 'local_edit';
  return disk === nextHash ? 'converged' : 'conflict';
}

function buildPlan({ root, oldFiles = [], newFiles = [], worlds = [] }) {
  const valid = validateFiles(newFiles, worlds);
  const old = new Map(oldFiles.map((f) => [normalizeRelative(f.relativePath), f]));
  const next = new Map(valid.accepted.map((f) => [f.relativePath, f]));
  const paths = [...new Set([...old.keys(), ...next.keys()])].filter(Boolean).sort();
  const groups = { additions: [], safeUpdates: [], safeRemovals: [], localEdits: [], conflicts: [], unchanged: [], converged: [], excluded: valid.excluded };
  const entries = [];
  for (const relativePath of paths) {
    const prior = old.get(relativePath);
    const incoming = next.get(relativePath);
    const currentHash = diskHash(root, relativePath);
    const state = classify(prior?.sha256 || null, currentHash, incoming?.sha256 || null);
    const entry = { relativePath, state, oldHash: prior?.sha256 || null, diskHash: currentHash, newHash: incoming?.sha256 || null, sizeBytes: incoming?.sizeBytes || 0 };
    entries.push(entry);
    const key = ({ addition: 'additions', safe_update: 'safeUpdates', safe_removal: 'safeRemovals', local_edit: 'localEdits', conflict: 'conflicts', unchanged: 'unchanged', converged: 'converged', already_removed: 'unchanged' })[state];
    groups[key].push(entry);
  }
  const inventoryHash = sha256(JSON.stringify(entries.map((e) => [e.relativePath, e.diskHash])));
  return { entries, groups, files: valid.accepted, inventoryHash, totalBytes: valid.totalBytes };
}

function latest(serverId) {
  const db = open();
  const row = db.prepare('SELECT * FROM modpack_manifests WHERE server_id = ? ORDER BY installed_at DESC LIMIT 1').get(serverId);
  return row ? hydrate(row) : null;
}

function hydrate(row) {
  const db = open();
  return { ...row, files: db.prepare('SELECT * FROM modpack_files WHERE manifest_id = ? ORDER BY relative_path').all(row.id) };
}

function history(serverId) {
  return open().prepare(`SELECT m.*,
    (SELECT COUNT(*) FROM modpack_files f WHERE f.manifest_id = m.id) AS file_count
    FROM modpack_manifests m WHERE m.server_id = ? ORDER BY m.installed_at DESC`).all(serverId);
}

function getManifest(id) {
  const row = open().prepare('SELECT * FROM modpack_manifests WHERE id = ?').get(id);
  return row ? hydrate(row) : null;
}

function persistManifest(meta, files) {
  const db = open();
  const id = crypto.randomUUID();
  const installedAt = Date.now();
  const canonical = files.map((f) => [f.relativePath, f.sha256, f.sizeBytes]).sort((a, b) => a[0].localeCompare(b[0]));
  const manifestHash = sha256(JSON.stringify(canonical));
  db.transaction(() => {
    db.prepare(`INSERT INTO modpack_manifests
      (id,server_id,provider,project_id,version_id,mc_version,loader,installed_at,operation_id,manifest_hash,snapshot_id,previous_manifest_id,display_name,version_name,provider_metadata_json,source_kind,verification_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, meta.serverId, meta.provider || 'modrinth', meta.projectId, meta.versionId, meta.mcVersion, meta.loader, installedAt, meta.operationId, manifestHash, meta.snapshotId || null, meta.previousManifestId || null, meta.displayName || null, meta.versionName || null, JSON.stringify(meta.providerMetadata || {}), meta.sourceKind || 'catalog', meta.verificationStatus || (meta.provider && meta.provider !== 'modrinth' ? 'user_supplied' : 'verified'));
    const insert = db.prepare('INSERT INTO modpack_files (manifest_id,relative_path,sha256,size_bytes,source_url_hash,ownership) VALUES (?,?,?,?,?,?)');
    for (const f of files) insert.run(id, f.relativePath, f.sha256, f.sizeBytes, f.sourceUrlHash || null, 'pack');
  })();
  return getManifest(id);
}

function savePreview(data) {
  const db = open();
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare('INSERT INTO modpack_previews VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, data.serverId, data.actorId, data.kind, data.projectId, data.versionId, now, now + PREVIEW_TTL_MS, data.plan.inventoryHash, JSON.stringify(data));
  return id;
}

function loadPreview(id, actorId) {
  const row = open().prepare('SELECT * FROM modpack_previews WHERE id = ? AND actor_id = ?').get(id, actorId);
  if (!row || row.expires_at < Date.now()) return null;
  return { row, data: JSON.parse(row.payload_json) };
}

module.exports = { sha256, normalizeRelative, exclusionReason, validateFiles, diskHash, classify, buildPlan, latest, history, getManifest, persistManifest, savePreview, loadPreview, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES };
