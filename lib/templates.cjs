'use strict';

/*
 * Server templates - see docs/roadmap/09-server-templates.md.
 *
 * Spec contract:
 *   - "Always exclude worlds, logs, crash reports, caches, player identities/
 *      lists, secrets, network bindings, runtime/server binaries, absolute
 *      paths, launch arguments, and machine paths. Unknown files default to
 *      excluded."
 *   - "Managed content is represented by IDs/hashes, not copied binaries, and
 *      is resolved through verified providers at instantiation."
 *   - "Create phases: inventory -> classify/sanitize -> preview ->
 *      snapshot-source-metadata -> stage archive -> archive-guard/self-verify
 *      -> commit version."
 *   - "Instantiate/clone: revalidate template -> select destination/safe slug
 *      -> disk check -> stage new root -> resolve/verify runtime/content ->
 *      apply placeholders -> validate -> atomic promote -> register server."
 *   - "Existing destinations are never merged or overwritten."
 *   - "Imported archives use the shared archive guard, schema validation,
 *      signatures/hashes where supplied, strict limits, and a full preview."
 *
 * This module owns classification, sanitization, the archive format, and the
 * staged-then-promoted materialization. Registration (config.json + the
 * ServerManager) belongs to the caller: see lib/routes/templates.cjs, which
 * drives the operation state machine around these primitives.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const archiver = require('archiver');
const yauzl = require('yauzl');
const { open, dataDir } = require('./db.cjs');
const archiveGuard = require('./archiveGuard.cjs');
const { fetchToFile } = require('./downloads.cjs');

const SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const MAX_CONTENT_BYTES = 512 * 1024 * 1024;
const PREVIEW_TTL = 30 * 60 * 1000;
const MODRINTH = 'https://api.modrinth.com/v2';
const TEMPLATE_DIR = path.join(dataDir(), 'templates');
const IMPORT_DIR = path.join(TEMPLATE_DIR, '.imports');
const STAGING_DIR = '.fleetdeck-staging';

// Placeholder defaults. A template records the *shape* of a network binding,
// never the machine it came from; instantiation substitutes real values.
const PLACEHOLDERS = Object.freeze({
  SERVER_IP: '',
  SERVER_PORT: '25565',
  QUERY_PORT: '25565',
  RCON_PORT: '25575',
});

const SECRET_RE = /(?:password|secret|token|api[_-]?key|private[_-]?key|access[_-]?key)/i;
const SECRET_VALUE_RE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:eyJ[a-zA-Z0-9_-]{10,}\.){2}|[a-f0-9]{48,})/i;
const EXCLUDED_DIRS = new Set([
  'logs', 'crash-reports', 'cache', 'caches', '.cache', '.fleetdeck', '.lodestone',
  'libraries', 'versions', 'runtime', 'runtimes',
]);
// Player identity, machine state, and panel state. Matched at the server root
// only: a mod's own config/foo/whitelist.json is not the server whitelist.
const EXCLUDED_ROOT_FILES = new Set([
  'eula.txt', 'usercache.json', 'whitelist.json', 'ops.json', 'banned-ips.json',
  'banned-players.json', 'session.lock', 'config.json', 'metrics.json', 'running.json',
]);
const RUNTIME_EXTS = new Set(['.jar', '.exe', '.dll', '.so', '.dylib', '.class', '.bat', '.sh']);
const CONFIG_EXTS = ['.json', '.json5', '.yml', '.yaml', '.toml', '.properties', '.conf', '.cfg', '.txt'];
const ROOT_CONFIGS = [
  'server.properties', 'bukkit.yml', 'spigot.yml', 'paper.yml',
  'paper-global.yml', 'paper-world-defaults.yml', 'purpur.yml',
];

function error(message, status = 400, code = 'template_error') {
  return Object.assign(new Error(message), { status, code });
}

function normalizeRel(rel) {
  const value = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!value || value.startsWith('/') || /^[a-z]:/i.test(value) || value.includes('\0')) {
    throw error('Invalid template path.', 400, 'invalid_path');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw error('Invalid template path.', 400, 'invalid_path');
  }
  return parts.join('/');
}

function safeJoin(root, rel) {
  const normalized = normalizeRel(rel);
  // resolve(path.join(...)) puts the tainted suffix in the position the
  // js/path-injection sanitizer blocks; the startsWith guard below is the
  // recognized barrier shape, with the return in the guarded branch.
  const result = path.resolve(path.join(root, ...normalized.split('/')));
  const base = path.resolve(root);
  if (!result.startsWith(base + path.sep)) {
    throw error('Path escapes the template root.', 400, 'path_traversal');
  }
  return result;
}

function slugFor(name, fallback = 'server') {
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || fallback;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function isKnownConfig(rel) {
  const lower = rel.toLowerCase();
  if (ROOT_CONFIGS.includes(lower)) return true;
  if (!lower.startsWith('config/')) return false;
  return CONFIG_EXTS.includes(path.extname(lower));
}

/*
 * Directories are containers, not payload. A directory is either excluded as a
 * whole (and not descended into) or it is transparent: it produces no preview
 * entry of its own, so the preview never claims "config excluded" while listing
 * config/foo.yml as included. Preview parity with the archive depends on this.
 */
function directoryExclusion(rel, stat, worlds) {
  const parts = rel.toLowerCase().split('/');
  if (stat.isSymbolicLink()) return 'symbolic links are not portable';
  if (parts.length === 1 && worlds.some((world) => parts[0] === String(world).toLowerCase())) return 'world data is excluded';
  if (EXCLUDED_DIRS.has(parts[0])) return 'runtime or machine state is excluded';
  return null;
}

function fileExclusion(rel, stat, worlds, managed) {
  const parts = rel.toLowerCase().split('/');
  if (stat.isSymbolicLink()) return 'symbolic links are not portable';
  if (parts.length === 1 && worlds.some((world) => parts[0] === String(world).toLowerCase())) return 'world data is excluded';
  if (EXCLUDED_DIRS.has(parts[0])) return 'runtime or machine state is excluded';
  if (parts.length === 1 && EXCLUDED_ROOT_FILES.has(parts[0])) return 'player identity, secret, or machine state is excluded';
  if (!stat.isFile()) return 'unsupported filesystem entry';
  if (RUNTIME_EXTS.has(path.extname(rel).toLowerCase())) {
    return managed.has(rel)
      ? 'managed content is referenced by provider and hash, not copied'
      : 'runtime binaries and launch scripts are excluded';
  }
  if (stat.size > MAX_FILE_BYTES) return 'configuration file exceeds the safe size limit';
  if (!isKnownConfig(rel)) return 'unknown files default to excluded';
  return null;
}

function sanitizeProperties(text) {
  const transforms = [];
  const lines = String(text).split(/\r?\n/).map((line) => {
    const match = /^([^#!][^=:#]*)([=:])(.*)$/.exec(line);
    if (!match) return line;
    const key = match[1].trim();
    const lower = key.toLowerCase();
    const value = match[3].trim();
    let replacement = null;
    if (lower === 'server-ip') replacement = '{{SERVER_IP}}';
    else if (lower === 'server-port') replacement = '{{SERVER_PORT}}';
    else if (lower === 'query.port') replacement = '{{QUERY_PORT}}';
    else if (lower === 'rcon.port') replacement = '{{RCON_PORT}}';
    else if (SECRET_RE.test(lower)) replacement = '';
    else if (/^(?:level-name|resource-pack|resource-pack-id)$/.test(lower) && isMachinePath(value)) replacement = path.basename(value);
    if (replacement === null) return line;
    transforms.push({
      key,
      reason: SECRET_RE.test(lower) ? 'secret removed' : 'machine or network value replaced',
      placeholder: replacement || null,
    });
    return `${match[1]}${match[2]}${replacement}`;
  });
  return { text: lines.join('\n'), transforms };
}

function isMachinePath(value) {
  return path.isAbsolute(value) || /^[a-z]:[\\/]/i.test(value);
}

function sanitizeJson(text) {
  const transforms = [];
  const visit = (value, key = '') => {
    if (Array.isArray(value)) return value.map((item) => visit(item, key));
    if (value && typeof value === 'object') {
      const result = {};
      for (const [childKey, childValue] of Object.entries(value)) {
        if (SECRET_RE.test(childKey)) {
          result[childKey] = '';
          transforms.push({ key: childKey, reason: 'secret removed' });
        } else if (/^(?:server-?ip|bind(?:-address)?|listen-?address|host|address)$/i.test(childKey)) {
          result[childKey] = '{{SERVER_IP}}';
          transforms.push({ key: childKey, reason: 'network binding replaced' });
        } else if (/^(?:server-?port|port)$/i.test(childKey)) {
          result[childKey] = '{{SERVER_PORT}}';
          transforms.push({ key: childKey, reason: 'network port replaced' });
        } else {
          result[childKey] = visit(childValue, childKey);
        }
      }
      return result;
    }
    if (typeof value === 'string' && isMachinePath(value)) {
      transforms.push({ key, reason: 'absolute path reduced to a portable name' });
      return path.basename(value);
    }
    return value;
  };
  try {
    return { text: `${JSON.stringify(visit(JSON.parse(text)), null, 2)}\n`, transforms };
  } catch (_) {
    return { text: '', transforms: [], invalid: true };
  }
}

function sanitizeLineConfig(text) {
  const transforms = [];
  const lines = String(text).split(/\r?\n/).map((line) => {
    const match = /^(\s*)([^#\s][^:=]*)(\s*[:=]\s*)(.*)$/.exec(line);
    if (!match) return line;
    const key = match[2].trim();
    const value = match[4].trim().replace(/^['"]|['"]$/g, '');
    if (SECRET_RE.test(key)) {
      transforms.push({ key, reason: 'secret removed' });
      return `${match[1]}${key}${match[3]}''`;
    }
    if (/^(?:server-?ip|bind(?:-address)?|listen-?address|host|address)$/i.test(key)) {
      transforms.push({ key, reason: 'network binding replaced' });
      return `${match[1]}${key}${match[3]}'{{SERVER_IP}}'`;
    }
    if (/^(?:server-?port|port)$/i.test(key)) {
      transforms.push({ key, reason: 'network port replaced' });
      return `${match[1]}${key}${match[3]}'{{SERVER_PORT}}'`;
    }
    if (isMachinePath(value)) {
      transforms.push({ key, reason: 'absolute path reduced to a portable name' });
      return `${match[1]}${key}${match[3]}${path.basename(value)}`;
    }
    return line;
  });
  return { text: lines.join('\n'), transforms };
}

function sanitizeStructured(text, rel) {
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.properties' || rel.toLowerCase() === 'server.properties') return sanitizeProperties(text);
  if (ext === '.json' || ext === '.json5') return sanitizeJson(text);
  return sanitizeLineConfig(text);
}

function walk(root, relative = '', out = []) {
  for (const dirent of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = normalizeRel(path.posix.join(relative.replace(/\\/g, '/'), dirent.name));
    out.push({ rel, abs: safeJoin(root, rel), stat: fs.lstatSync(safeJoin(root, rel)) });
  }
  return out;
}

/*
 * Managed content for a server: the provenance rows written when Hostkind
 * installed a plugin/mod on the user's behalf. The template carries the
 * provider/project/version/hash - never the jar.
 */
function managedContent(serverId) {
  if (!serverId) return [];
  const rows = open()
    .prepare('SELECT relative_path, kind, provider, project_id, version_id, mc_version, loader, sha256 FROM content_provenance WHERE server_id = ? ORDER BY relative_path')
    .all(serverId);
  return rows.map((row) => ({
    path: normalizeRel(row.relative_path),
    kind: row.kind,
    provider: row.provider,
    projectId: row.project_id,
    versionId: row.version_id,
    mcVersion: row.mc_version,
    loader: row.loader,
    sha256: row.sha256,
  }));
}

/*
 * Inventory + classify + sanitize. Returns the manifest the user previews and
 * the sanitized file bodies that go into the archive. Walking is breadth-first
 * per directory so an excluded directory is never descended into.
 */
function buildPreview(server, options = {}) {
  if (!server || !server.dir || !fs.existsSync(server.dir)) {
    throw error('Source server folder was not found.', 404, 'source_missing');
  }
  const worlds = Array.isArray(server.worlds) && server.worlds.length
    ? server.worlds
    : ['world', 'world_nether', 'world_the_end'];
  const content = managedContent(server.id);
  const managed = new Map(content.map((item) => [item.path, item]));
  const entries = [];
  const files = [];
  const queue = [''];

  while (queue.length) {
    const relative = queue.shift();
    for (const item of walk(server.dir, relative)) {
      if (item.stat.isDirectory() && !item.stat.isSymbolicLink()) {
        const reason = directoryExclusion(item.rel, item.stat, worlds);
        if (reason) entries.push({ path: item.rel, action: 'excluded', reason });
        else queue.push(item.rel);
        continue;
      }
      const reason = fileExclusion(item.rel, item.stat, worlds, managed);
      if (reason) {
        const entry = { path: item.rel, action: 'excluded', reason };
        if (managed.has(item.rel)) {
          entry.action = 'referenced';
          entry.content = { provider: managed.get(item.rel).provider, projectId: managed.get(item.rel).projectId, versionId: managed.get(item.rel).versionId };
        }
        entries.push(entry);
        continue;
      }
      let text;
      try {
        text = fs.readFileSync(item.abs, 'utf8');
      } catch (_) {
        entries.push({ path: item.rel, action: 'excluded', reason: 'file is not readable text' });
        continue;
      }
      if (text.includes('\u0000')) {
        entries.push({ path: item.rel, action: 'excluded', reason: 'binary content is excluded' });
        continue;
      }
      const clean = sanitizeStructured(text, item.rel);
      if (clean.invalid) {
        entries.push({ path: item.rel, action: 'excluded', reason: 'configuration could not be parsed safely' });
        continue;
      }
      if (SECRET_VALUE_RE.test(clean.text)) {
        entries.push({ path: item.rel, action: 'excluded', reason: 'possible secret remains after sanitization' });
        continue;
      }
      const action = clean.transforms.length ? 'transformed' : 'included';
      entries.push({
        path: item.rel,
        action,
        reason: action === 'included' ? 'portable configuration' : 'machine-specific or secret values sanitized',
        transforms: clean.transforms,
      });
      files.push({
        path: item.rel,
        content: Buffer.from(clean.text, 'utf8'),
        sha256: crypto.createHash('sha256').update(clean.text).digest('hex'),
        size: Buffer.byteLength(clean.text),
      });
    }
  }

  // Managed content whose jar is gone from disk is still a valid reference:
  // the provider resolves it at instantiation.
  for (const item of content) {
    if (!entries.some((entry) => entry.path === item.path)) {
      entries.push({
        path: item.path,
        action: 'referenced',
        reason: 'managed content is referenced by provider and hash, not copied',
        content: { provider: item.provider, projectId: item.projectId, versionId: item.versionId },
      });
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    manifest: {
      schemaVersion: SCHEMA_VERSION,
      name: String(options.name || server.name || 'Server template').trim(),
      description: String(options.description || '').trim(),
      source: { loader: server.loader || null, mcVersion: server.mcVersion || null },
      placeholders: PLACEHOLDERS,
      content,
      entries,
    },
    files,
  };
}

function createArchive(dest, manifest, files) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(dest, { flags: 'wx' });
    const zip = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    zip.on('error', reject);
    zip.pipe(output);
    zip.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    for (const file of files) zip.append(file.content, { name: `files/${file.path}` });
    zip.finalize();
  });
}

function latest(templateId, includeDeleted = false) {
  const db = open();
  return db.prepare(`
    SELECT t.*, v.id version_id, v.version, v.archive_path, v.archive_sha256, v.manifest_json,
           v.source_server_id, v.created_at version_created_at
      FROM templates t
      JOIN template_versions v ON v.template_id = t.id AND v.version = t.latest_version
     WHERE t.id = ? ${includeDeleted ? '' : 'AND t.deleted_at IS NULL'}
  `).get(templateId) || null;
}

/*
 * Cursor pagination ordered by (created_at DESC, id DESC), per the shared
 * collection contract in docs/roadmap/README.md.
 */
function list({ cursor = null, limit = 50 } = {}) {
  sweepExpiredImports();
  const where = ['t.deleted_at IS NULL'];
  const args = [];
  if (cursor) {
    const [ts, id] = String(cursor).split(':');
    if (ts && id) {
      where.push('(t.created_at < ? OR (t.created_at = ? AND t.id < ?))');
      args.push(Number(ts), Number(ts), id);
    }
  }
  const rows = open().prepare(`
    SELECT t.id, t.name, t.description, t.created_by, t.created_at, t.latest_version,
           v.source_server_id, v.created_at version_created_at
      FROM templates t
      JOIN template_versions v ON v.template_id = t.id AND v.version = t.latest_version
     WHERE ${where.join(' AND ')}
     ORDER BY t.created_at DESC, t.id DESC
     LIMIT ?
  `).all(...args, limit + 1);
  const items = rows.length > limit ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit ? `${last.created_at}:${last.id}` : null };
}

async function create({ server, name, description, actorId, templateId = null }) {
  const preview = buildPreview(server, { name, description });
  if (!preview.files.length) throw error('No portable configuration files were found.', 400, 'empty_template');
  const db = open();
  const existing = templateId ? db.prepare('SELECT * FROM templates WHERE id = ? AND deleted_at IS NULL').get(templateId) : null;
  if (templateId && !existing) throw error('Template not found.', 404, 'not_found');
  const id = templateId || crypto.randomUUID();
  const version = existing ? existing.latest_version + 1 : 1;
  const manifest = preview.manifest;
  manifest.templateId = id;
  manifest.version = version;
  manifest.createdAt = Date.now();
  manifest.files = preview.files.map(({ path: rel, sha256, size }) => ({ path: rel, sha256, size }));

  const relArchive = `${id}/v${version}.zip`;
  // The template id is caller-supplied, so pin the archive under TEMPLATE_DIR
  // with the resolve + startsWith guard CodeQL js/path-injection recognizes
  // before any fs call on it.
  const archive = path.resolve(path.join(TEMPLATE_DIR, ...relArchive.split('/')));
  const templateRoot = path.resolve(TEMPLATE_DIR);
  if (!archive.startsWith(templateRoot + path.sep)) {
    throw error('Invalid template id.', 400, 'invalid_path');
  }
  await createArchive(archive, manifest, preview.files);
  // Self-verify: read the archive back through the same guard + validator an
  // untrusted import would face before we commit the version row.
  const loaded = await readZip(archive);
  validateImported(loaded.manifest, loaded.files);
  const digest = sha256File(archive);

  db.transaction(() => {
    if (existing) {
      db.prepare('UPDATE templates SET name = ?, description = ?, latest_version = ? WHERE id = ?')
        .run(manifest.name, manifest.description, version, id);
    } else {
      db.prepare('INSERT INTO templates(id,name,description,created_by,created_at,latest_version) VALUES(?,?,?,?,?,?)')
        .run(id, manifest.name, manifest.description, actorId || null, Date.now(), version);
    }
    db.prepare('INSERT INTO template_versions(id,template_id,version,archive_path,archive_sha256,manifest_json,created_at,source_server_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), id, version, relArchive, digest, JSON.stringify(manifest), Date.now(), server.id || null);
  })();
  return { id, version, manifest };
}

function inspect(id) {
  const row = latest(id);
  if (!row) throw error('Template not found.', 404, 'not_found');
  return {
    template: {
      id: row.id,
      name: row.name,
      description: row.description,
      version: row.version,
      createdAt: row.created_at,
      sourceServerId: row.source_server_id,
    },
    manifest: JSON.parse(row.manifest_json),
  };
}

function versions(id) {
  return open()
    .prepare('SELECT version, archive_sha256, created_at, source_server_id FROM template_versions WHERE template_id = ? ORDER BY version DESC')
    .all(id);
}

function remove(id) {
  const result = open().prepare('UPDATE templates SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(Date.now(), id);
  if (!result.changes) throw error('Template not found.', 404, 'not_found');
}

/*
 * Revalidate: the archive must still be on disk and still hash to what the
 * version row recorded. A template whose bytes drifted is never instantiated.
 */
function archivePath(row) {
  const value = safeJoin(TEMPLATE_DIR, row.archive_path);
  if (!fs.existsSync(value) || sha256File(value) !== row.archive_sha256) {
    throw error('Template archive failed verification.', 409, 'archive_invalid');
  }
  return value;
}

function applyPlaceholders(text, values = {}) {
  return String(text).replace(/\{\{(SERVER_IP|SERVER_PORT|QUERY_PORT|RCON_PORT)\}\}/g, (_, key) => String(values[key] ?? PLACEHOLDERS[key]));
}

function readZip(file) {
  return new Promise((resolve, reject) => {
    const files = new Map();
    const state = {};
    let manifest = null;
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(error('Invalid template archive.', 400, 'invalid_archive'));
      const fail = (e) => { try { zip.close(); } catch (_) { /* */ } reject(e); };
      zip.on('error', fail);
      zip.on('entry', (entry) => {
        let normalized;
        try {
          normalized = archiveGuard.checkEntry(entry, state, {
            maxEntries: 2000,
            maxTotalSize: MAX_IMPORT_BYTES,
            maxEntrySize: MAX_FILE_BYTES,
          });
        } catch (e) {
          return fail(e);
        }
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        if (normalized !== 'manifest.json' && !normalized.startsWith('files/')) {
          return fail(error('Archive contains files outside the template root.', 400, 'archive_scope'));
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return fail(streamErr);
          const chunks = [];
          stream.on('error', fail);
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            const buffer = Buffer.concat(chunks);
            if (normalized === 'manifest.json') {
              try { manifest = JSON.parse(buffer.toString('utf8')); }
              catch { return fail(error('Template manifest is invalid.', 400, 'invalid_manifest')); }
            } else {
              files.set(normalized.slice('files/'.length), buffer);
            }
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => {
        try { archiveGuard.finalize(state, { maxAggregateRatio: 100 }); }
        catch (e) { return reject(e); }
        resolve({ manifest, files });
      });
      zip.readEntry();
    });
  });
}

function validateContentRefs(manifest) {
  const content = manifest.content === undefined ? [] : manifest.content;
  if (!Array.isArray(content)) throw error('Template manifest is incomplete.', 400, 'invalid_manifest');
  for (const item of content) {
    const rel = normalizeRel(item?.path);
    if (item.provider !== 'modrinth') throw error(`Unsupported content provider: ${item?.provider}`, 400, 'unsupported_provider');
    if (!item.projectId || !item.versionId || !/^[a-f0-9]{64}$/i.test(String(item.sha256 || ''))) {
      throw error(`Template content reference is incomplete: ${rel}`, 400, 'invalid_content_ref');
    }
    if (RUNTIME_EXTS.has(path.extname(rel).toLowerCase()) === false) {
      throw error(`Template content reference is not an addon: ${rel}`, 400, 'invalid_content_ref');
    }
  }
  return content;
}

/*
 * An imported archive is untrusted even if Hostkind exported it: the manifest
 * must match the bytes exactly, every path must be unique after case folding,
 * and nothing that looks like a secret survives.
 */
function validateImported(manifest, files) {
  if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION) {
    const newer = Number(manifest?.schemaVersion) > SCHEMA_VERSION;
    throw error(
      newer ? 'Template schema is newer than this Hostkind version.' : 'Unsupported template schema.',
      400,
      'unsupported_schema',
    );
  }
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.entries)) {
    throw error('Template manifest is incomplete.', 400, 'invalid_manifest');
  }
  validateContentRefs(manifest);
  const expected = new Set();
  for (const item of manifest.files) {
    const rel = normalizeRel(item.path);
    if (expected.has(rel.toLowerCase())) throw error('Template has duplicate or case-colliding paths.', 400, 'case_collision');
    expected.add(rel.toLowerCase());
    const content = files.get(rel);
    if (!content || crypto.createHash('sha256').update(content).digest('hex') !== item.sha256) {
      throw error(`Template file verification failed: ${rel}`, 400, 'hash_mismatch');
    }
    if (SECRET_VALUE_RE.test(content.toString('utf8'))) {
      throw error(`Possible secret found in template: ${rel}`, 400, 'secret_detected');
    }
  }
  if (files.size !== expected.size) throw error('Archive contents do not match the manifest.', 400, 'manifest_mismatch');
  return manifest;
}

/*
 * Staging. A new server root is built under <parentDir>/.fleetdeck-staging/<op>
 * - the same filesystem as its destination - and promoted with a single rename.
 * Nothing is ever written into the destination before that promotion, so a
 * crash mid-build leaves no half-built server behind.
 */
function stagingRootFor(parentDir, operationId) {
  const id = String(operationId || '');
  if (!id || /[\\/\0]/.test(id) || id === '.' || id === '..') throw error('Invalid operation id.', 400, 'invalid_operation');
  return path.join(parentDir, STAGING_DIR, id);
}

function sweepStaging(parentDir, isLive) {
  const root = path.join(parentDir, STAGING_DIR);
  if (!fs.existsSync(root)) return;
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory() || isLive(dirent.name)) continue;
    fs.rmSync(path.join(root, dirent.name), { recursive: true, force: true });
  }
}

function freeBytes(dir) {
  try { const stat = fs.statfsSync(dir); return stat.bavail * stat.bsize; }
  catch { return null; }
}

function assertDiskSpace(parentDir, requiredBytes) {
  const free = freeBytes(parentDir);
  if (free != null && free < requiredBytes * 1.2) {
    throw error('Not enough free disk space at the destination.', 507, 'low_disk');
  }
}

function writeStagedFile(root, rel, body) {
  const target = safeJoin(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, { flag: 'wx' });
}

/*
 * Recursive secret scan of the staged result, per the spec's security
 * requirements. Binary payloads (resolved jars) are skipped: they are verified
 * by hash against authoritative provider metadata instead.
 */
function scanStagedForSecrets(root, relative = '') {
  for (const dirent of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = path.posix.join(relative, dirent.name);
    if (dirent.isDirectory()) { scanStagedForSecrets(root, rel); continue; }
    if (RUNTIME_EXTS.has(path.extname(rel).toLowerCase())) continue;
    const text = fs.readFileSync(safeJoin(root, rel), 'utf8');
    if (SECRET_VALUE_RE.test(text)) throw error(`Possible secret found in the staged server: ${rel}`, 500, 'secret_detected');
  }
}

async function modrinthVersion(versionId) {
  const response = await fetch(`${MODRINTH}/version/${encodeURIComponent(versionId)}`, {
    headers: { 'user-agent': 'Hostkind/1.0' },
  });
  if (!response.ok) throw error(`Content provider returned HTTP ${response.status}.`, 502, 'content_unavailable');
  return response.json();
}

/*
 * Resolve every managed-content reference through its provider and verify the
 * bytes against the hash the template recorded. A reference we cannot resolve
 * or cannot verify fails the operation before promotion - we never promote a
 * server that is quietly missing its mods.
 */
async function resolveContent(content, stagedRoot, { fetchVersion = modrinthVersion, onProgress } = {}) {
  const resolved = [];
  for (const [index, item] of content.entries()) {
    if (onProgress) onProgress({ path: item.path, index, total: content.length });
    const meta = await fetchVersion(item.versionId);
    const file = (meta.files || []).find((entry) => entry.primary) || (meta.files || [])[0];
    if (!file || !file.url) throw error(`Content could not be resolved: ${item.path}`, 502, 'content_unresolved');
    const target = safeJoin(stagedRoot, item.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await fetchToFile(file.url, target, {
      maxBytes: MAX_CONTENT_BYTES,
      allowlist: (host) => host === 'cdn.modrinth.com' || host.endsWith('.modrinth.com'),
    });
    if (sha256File(target) !== item.sha256) {
      throw error(`Content failed hash verification: ${item.path}`, 409, 'content_verification_failed');
    }
    resolved.push({ ...item });
  }
  return resolved;
}

/*
 * Build a new server root from either a live preview (clone) or a stored
 * template archive (instantiate), then hand the staged root back to the caller
 * to promote. The caller owns the operation and the registration.
 */
async function stageServer({ parentDir, operationId, files, content, placeholders, resolve = resolveContent, onProgress }) {
  const staged = stagingRootFor(parentDir, operationId);
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(staged, { recursive: true });
  try {
    const bytes = files.reduce((total, file) => total + file.content.length, 0);
    assertDiskSpace(parentDir, bytes + content.length * 8 * 1024 * 1024);
    for (const file of files) {
      writeStagedFile(staged, file.path, applyPlaceholders(file.content.toString('utf8'), placeholders));
    }
    // The EULA is a deliberate exclusion from every template (it is per-machine
    // consent), so an instantiated server needs a fresh one.
    fs.writeFileSync(path.join(staged, 'eula.txt'), 'eula=true\n', { flag: 'wx' });
    const resolved = content.length ? await resolve(content, staged, { onProgress }) : [];
    scanStagedForSecrets(staged);
    return { staged, content: resolved };
  } catch (err) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw err;
  }
}

/*
 * The one and only promotion: a same-filesystem rename onto a destination that
 * must not exist. Merging or overwriting an existing folder is never allowed.
 */
function promote(staged, destination) {
  if (fs.existsSync(destination)) throw error('The destination already exists.', 409, 'destination_exists');
  try {
    fs.renameSync(staged, destination);
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'ENOTEMPTY') throw error('The destination already exists.', 409, 'destination_exists');
    throw err;
  }
}

/*
 * Load a stored template into the same shape buildPreview produces, so
 * instantiate and clone share one staging path.
 */
async function loadForInstantiate(row) {
  const loaded = await readZip(archivePath(row));
  const manifest = validateImported(loaded.manifest, loaded.files);
  const files = manifest.files.map((item) => ({ path: item.path, content: loaded.files.get(item.path) }));
  return { manifest, files, content: manifest.content || [] };
}

function sweepExpiredImports() {
  const db = open();
  const stale = db.prepare('SELECT token, archive_path FROM template_import_previews WHERE expires_at <= ?').all(Date.now());
  for (const row of stale) {
    try { fs.rmSync(safeJoin(TEMPLATE_DIR, row.archive_path), { force: true }); } catch (_) { /* */ }
    db.prepare('DELETE FROM template_import_previews WHERE token = ?').run(row.token);
  }
}

/*
 * multer stages template uploads under os.tmpdir() with a server-generated
 * name; the uploaded path is request-adjacent, so re-assert it inside the
 * temporary root before any fs call. realpathSync on both sides keeps the
 * check sound when the temp directory is a symlink (macOS /var ->
 * /private/var). The resolve + startsWith guard is the sanitizer CodeQL
 * js/path-injection recognizes, with the use in the guarded branch.
 */
function stagedUploadPath(value) {
  const abs = path.resolve(String(value || ''));
  const root = path.resolve(os.tmpdir());
  let real = abs;
  let realRoot = root;
  try { real = fs.realpathSync.native ? fs.realpathSync.native(abs) : fs.realpathSync(abs); } catch (_) { /* missing file: fall back to the resolved path */ }
  try { realRoot = fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root); } catch (_) { /* os.tmpdir() always exists */ }
  if (real.startsWith(realRoot + path.sep)) return abs;
  return null;
}

async function importPreview(file, actorId) {
  const staged = stagedUploadPath(file);
  if (!staged || !fs.existsSync(staged) || fs.statSync(staged).size > MAX_IMPORT_BYTES) {
    throw error('Template archive is missing or too large.', 400, 'import_size');
  }
  const loaded = await readZip(staged);
  validateImported(loaded.manifest, loaded.files);
  sweepExpiredImports();
  fs.mkdirSync(IMPORT_DIR, { recursive: true });
  const token = crypto.randomUUID();
  const stored = path.join(IMPORT_DIR, `${token}.zip`);
  fs.renameSync(staged, stored);
  const payload = {
    name: loaded.manifest.name,
    description: loaded.manifest.description || '',
    manifest: loaded.manifest,
  };
  open().prepare('INSERT INTO template_import_previews(token,actor_id,archive_path,sha256,payload_json,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
    .run(
      token,
      actorId,
      path.relative(TEMPLATE_DIR, stored).replace(/\\/g, '/'),
      sha256File(stored),
      JSON.stringify(payload),
      Date.now(),
      Date.now() + PREVIEW_TTL,
    );
  return { token, ...payload };
}

async function confirmImport(token, actorId, overrides = {}) {
  const db = open();
  const row = db.prepare('SELECT * FROM template_import_previews WHERE token = ? AND actor_id = ? AND expires_at > ?')
    .get(token, actorId, Date.now());
  if (!row) throw error('Import preview expired or was not found.', 404, 'preview_missing');
  const source = safeJoin(TEMPLATE_DIR, row.archive_path);
  if (!fs.existsSync(source) || sha256File(source) !== row.sha256) {
    throw error('Import archive changed after preview.', 409, 'archive_changed');
  }
  const loaded = await readZip(source);
  const manifest = validateImported(loaded.manifest, loaded.files);

  const id = crypto.randomUUID();
  const relArchive = `${id}/v1.zip`;
  const dest = safeJoin(TEMPLATE_DIR, relArchive);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(source, dest);
  const name = String(overrides.name || manifest.name || 'Imported template').trim();
  const description = String(overrides.description ?? manifest.description ?? '').trim();
  manifest.templateId = id;
  manifest.version = 1;
  manifest.name = name;
  manifest.description = description;
  const digest = sha256File(dest);

  db.transaction(() => {
    db.prepare('INSERT INTO templates(id,name,description,created_by,created_at,latest_version) VALUES(?,?,?,?,?,1)')
      .run(id, name, description, actorId, Date.now());
    db.prepare('INSERT INTO template_versions(id,template_id,version,archive_path,archive_sha256,manifest_json,created_at,source_server_id) VALUES(?,?,1,?,?,?,?,NULL)')
      .run(crypto.randomUUID(), id, relArchive, digest, JSON.stringify(manifest), Date.now());
    db.prepare('DELETE FROM template_import_previews WHERE token = ?').run(token);
  })();
  return { id, version: 1, manifest };
}

module.exports = {
  SCHEMA_VERSION,
  TEMPLATE_DIR,
  PLACEHOLDERS,
  buildPreview,
  managedContent,
  create,
  list,
  inspect,
  latest,
  versions,
  archivePath,
  loadForInstantiate,
  stageServer,
  stagingRootFor,
  sweepStaging,
  promote,
  slugFor,
  resolveContent,
  importPreview,
  confirmImport,
  sweepExpiredImports,
  remove,
  readZip,
  validateImported,
  applyPlaceholders,
  sha256File,
};
