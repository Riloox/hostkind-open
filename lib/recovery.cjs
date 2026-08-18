'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');
const { open } = require('./db.cjs');
const { checkEntry, finalize, ArchiveError } = require('./archiveGuard.cjs');

const PREVIEW_TTL = 10 * 60 * 1000;
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); return c >>> 0; });
function crcUpdate(crc, chunk) { let c = crc; for (const byte of chunk) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return c >>> 0; }

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('error', reject); input.on('data', (b) => h.update(b)); input.on('end', () => resolve(h.digest('hex')));
  });
}

function zipEntries(file, { decompress = false } = {}) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (error, zip) => {
      if (error) return reject(error);
      const state = { entries: 0, totalSize: 0, totalCompressedSize: 0, seen: new Set() };
      const inventory = [];
      let settled = false;
      const fail = (err) => { if (settled) return; settled = true; try { zip.close(); } catch {} reject(err); };
      zip.on('error', fail);
      zip.on('entry', (entry) => {
        try {
          const directory = /\/$/.test(entry.fileName);
          if (directory) { zip.readEntry(); return; }
          const normalized = checkEntry(entry, state);
          inventory.push({ path: normalized, size: entry.uncompressedSize, compressedSize: entry.compressedSize });
          if (!decompress) { zip.readEntry(); return; }
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return fail(streamError);
            let crc = 0xffffffff;
            stream.on('error', fail); stream.on('data', (chunk) => { crc = crcUpdate(crc, chunk); }); stream.on('end', () => {
              if (((crc ^ 0xffffffff) >>> 0) !== (entry.crc32 >>> 0)) return fail(Object.assign(new Error(`CRC mismatch: ${entry.fileName}`), { code: 'crc_mismatch' }));
              zip.readEntry();
            });
          });
        } catch (err) { fail(err); }
      });
      zip.on('end', () => {
        if (settled) return;
        try { finalize(state); settled = true; resolve({ inventory, totals: { files: inventory.length, ...finalize(state) } }); }
        catch (err) { fail(err); }
      });
      zip.readEntry();
    });
  });
}

function detectWorlds(inventory, configuredWorlds) {
  const roots = new Set(inventory.map((x) => x.path.split('/')[0]).filter(Boolean));
  return configuredWorlds.filter((w) => roots.has(w));
}

function latestSummary(backupId, table, order) {
  return open().prepare(`SELECT * FROM ${table} WHERE backup_id=? ORDER BY ${order} DESC LIMIT 1`).get(backupId) || null;
}

function publicManifest(row) {
  if (!row) return null;
  return { id: row.id, serverId: row.server_id, filename: row.filename, sizeBytes: row.size_bytes, sha256: row.sha256,
    createdAt: row.created_at, inventory: JSON.parse(row.inventory_json), worldRoots: JSON.parse(row.world_roots_json),
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null };
}

async function inspect({ file, filename, serverId, worlds, createdAt, metadata = null, persist = true }) {
  if (!file || !filename || !serverId || !Array.isArray(worlds)) {
    throw Object.assign(new Error('Backup inspection context is incomplete.'), { code: 'invalid_backup_context' });
  }
  const [scan, sha256] = await Promise.all([zipEntries(file), hashFile(file)]);
  const st = fs.statSync(file);
  const manifest = { id: crypto.randomUUID(), serverId, filename, sizeBytes: st.size, sha256, createdAt: createdAt || st.mtimeMs,
    inventory: scan.inventory, worldRoots: detectWorlds(scan.inventory, worlds), metadata };
  if (persist) open().prepare(`INSERT INTO backup_manifests
    (id,server_id,filename,size_bytes,sha256,created_at,inventory_json,world_roots_json) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(filename) DO UPDATE SET server_id=excluded.server_id,size_bytes=excluded.size_bytes,sha256=excluded.sha256,
    inventory_json=excluded.inventory_json,world_roots_json=excluded.world_roots_json`).run(manifest.id, serverId, filename, st.size, sha256,
    manifest.createdAt, JSON.stringify(manifest.inventory), JSON.stringify(manifest.worldRoots));
  if (persist && metadata) {
    const stored = open().prepare('SELECT id FROM backup_manifests WHERE filename=?').get(filename);
    open().prepare(`INSERT INTO backup_game_metadata (backup_id,metadata_json) VALUES (?,?)
      ON CONFLICT(backup_id) DO UPDATE SET metadata_json=excluded.metadata_json`).run(stored.id, JSON.stringify(metadata));
  }
  return manifest;
}

function findManifest(filename) {
  return publicManifest(open().prepare(`SELECT bm.*, gm.metadata_json
    FROM backup_manifests bm LEFT JOIN backup_game_metadata gm ON gm.backup_id=bm.id
    WHERE bm.filename=?`).get(filename));
}

async function ensureManifest(args) { return findManifest(args.filename) || inspect(args); }

async function verify(args) {
  const manifest = await ensureManifest(args);
  const id = crypto.randomUUID();
  try {
    await zipEntries(args.file, { decompress: true });
    const sha256 = await hashFile(args.file);
    if (sha256 !== manifest.sha256) throw Object.assign(new Error('Backup checksum changed.'), { code: 'checksum_mismatch' });
    open().prepare('INSERT INTO backup_verifications VALUES (?,?,?,?,?,?,?,?)').run(id, manifest.id, args.operationId || null, 'verified', 1, sha256, Date.now(), null);
    return { status: 'verified', crcOk: true, sha256, verifiedAt: Date.now() };
  } catch (err) {
    open().prepare('INSERT INTO backup_verifications VALUES (?,?,?,?,?,?,?,?)').run(id, manifest.id, args.operationId || null, 'failed', 0, null, Date.now(), err.code || 'invalid_archive');
    throw err;
  }
}

function summaries(manifest) {
  if (!manifest) return { verification: { status: 'unverified' } };
  const v = latestSummary(manifest.id, 'backup_verifications', 'verified_at');
  return { verification: v ? { status: v.status, crcOk: !!v.crc_ok, sha256: v.sha256, verifiedAt: v.verified_at, errorCode: v.error_code } : { status: 'unverified' } };
}

function fingerprint(serverDir, worlds) {
  return crypto.createHash('sha256').update(worlds.map((w) => { try { const s = fs.statSync(path.join(serverDir, w)); return `${w}:${s.mtimeMs}:${s.size}`; } catch { return `${w}:missing`; } }).join('|')).digest('hex');
}

function makeImpact({ manifest, server, actorId }) {
  if (!manifest.worldRoots.length || manifest.worldRoots.some((w) => !server.worlds.includes(w))) throw Object.assign(new Error('Backup worlds do not map to configured worlds.'), { status: 409 });
  const replacements = manifest.worldRoots.map((root) => ({ root, exists: fs.existsSync(path.join(server.dir, root)) }));
  const preserved = server.worlds.filter((w) => !manifest.worldRoots.includes(w));
  const payload = { backup: manifest.filename, replacements, preserved, requiredBytes: manifest.inventory.reduce((n, x) => n + x.size, 0), rollbackAvailable: true };
  const token = crypto.randomUUID(); const now = Date.now();
  open().prepare('INSERT INTO backup_previews VALUES (?,?,?,?,?,?,?,?)').run(token, manifest.id, server.id, actorId, now, now + PREVIEW_TTL, fingerprint(server.dir, server.worlds), JSON.stringify(payload));
  return { token, expiresAt: now + PREVIEW_TTL, ...payload };
}

function consumePreview({ token, actorId, server }) {
  const row = open().prepare('SELECT * FROM backup_previews WHERE token=?').get(token);
  if (!row || row.actor_id !== actorId || row.server_id !== server.id || row.expires_at < Date.now()) throw Object.assign(new Error('Restore preview expired or invalid.'), { status: 409 });
  if (row.server_fingerprint !== fingerprint(server.dir, server.worlds)) throw Object.assign(new Error('Server files changed since the preview.'), { status: 409 });
  return { manifest: publicManifest(open().prepare('SELECT * FROM backup_manifests WHERE id=?').get(row.backup_id)), payload: JSON.parse(row.payload_json) };
}

function extract(file, destination, allowedRoots) {
  fs.mkdirSync(destination, { recursive: true });
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error); const state = { seen: new Set() }; let files = 0; let bytes = 0;
      const fail = (e) => { try { zip.close(); } catch {} reject(e); };
      zip.on('error', fail); zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; }
        let rel; try { rel = checkEntry(entry, state); } catch (e) { return fail(e); }
        if (!allowedRoots.includes(rel.split('/')[0])) return fail(new ArchiveError(`entry outside configured worlds: ${rel}`, 'outside_worlds'));
        const target = path.join(destination, ...rel.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        zip.openReadStream(entry, (e, stream) => { if (e) return fail(e); const out = fs.createWriteStream(target, { flags: 'wx' });
          stream.on('error', fail); out.on('error', fail); out.on('close', () => { files++; bytes += entry.uncompressedSize; zip.readEntry(); }); stream.pipe(out); });
      });
      zip.on('end', () => { try { finalize(state); resolve({ files, bytes }); } catch (e) { fail(e); } }); zip.readEntry();
    });
  });
}

module.exports = { hashFile, zipEntries, inspect, ensureManifest, findManifest, verify, summaries, makeImpact, consumePreview, extract, publicManifest };
