'use strict';

/*
 * Palworld profile export/import and adoption
 * (docs/palworld/07-portability-safety.md "Profile export and import" and
 * "Adoption").
 *
 * Spec contract:
 *   - "Define a versioned Hostkind Palworld profile archive containing:
 *      redacted server metadata and target platform; selected settings and save
 *      data; mod provenance/manifests where available; schedule and policy
 *      definitions; checksummed manifest with format version."
 *   - "Secrets are excluded by default. Import generates a new administration
 *      password and asks separately about optional secret-bearing integration
 *      settings."
 *   - "Import always scans/previews, reports disk needs and collisions, stages
 *      extraction, allows renaming/port reassignment, and creates a registered
 *      server only after validation succeeds."
 *   - "Adopting an existing installation detects target platform, executable,
 *      save/config location, installed build metadata, ports, and conflicting
 *      registered roots."
 *
 * What a profile is *not*: it is not a copy of the dedicated server binaries.
 * Those are large, platform-specific, and already reproducible through
 * SteamCMD, so an imported profile always ends with "install the server files
 * into this folder" rather than pretending to be a full install. Callers must
 * surface that instead of hiding it.
 *
 * Nothing in this module registers a server, writes to config.json, or starts
 * anything: it returns a descriptor and lets the route own registration, so the
 * whole file is testable without a running panel.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const yauzl = require('yauzl');
const archiveGuard = require('./archiveGuard.cjs');
const { dataDir } = require('./db.cjs');
const pathSafety = require('./pathSafety.cjs');
const redact = require('./redact.cjs');
const settings = require('./palworld-settings.cjs');
const updates = require('./palworld-updates.cjs');
const platform = require('./palworld-platform.cjs');
const snapshots = require('./snapshots.cjs');

const FORMAT = 'fleetdeck-palworld-profile';
const PROFILE_VERSION = 1;
const SELECTIONS = Object.freeze(['configuration', 'world', 'mods', 'complete']);
const PREVIEW_TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 20000;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;
const STAGING_DIR = '.fleetdeck-staging';
const SAVE_RELATIVE = path.join('Pal', 'Saved', 'SaveGames');
const MODS_INVENTORY = path.join('.fleetdeck', 'palworld-mods', 'inventory.json');
const PROFILE_RECORD_DIR = path.join('.fleetdeck', 'palworld-profile');

// Settings keys that never leave this process, and the encoded value they are
// replaced with in an export. Blanking rather than deleting keeps the file
// shape intact so the importing side still sees which keys existed.
const SECRET_SETTINGS = Object.freeze(['AdminPassword', 'ServerPassword', 'RCONPassword', 'RESTAPIPassword']);
// A last-resort tripwire on the bytes we are about to hand to the operator.
const SECRET_VALUE_RE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:eyJ[a-zA-Z0-9_-]{10,}\.){2}|[A-Za-z0-9+/_-]{40,}={0,2}\s*$)/m;

const previews = new Map();

class ProfileError extends Error {
  constructor(message, status = 400, code = 'profile_error') {
    super(message);
    this.name = 'ProfileError';
    this.status = status;
    this.code = code;
  }
}

function fail(message, status, code) {
  throw new ProfileError(message, status, code);
}

function profileDir() {
  return path.join(dataDir(), 'palworld-profiles');
}

function importDir() {
  return path.join(dataDir(), 'palworld-profile-imports');
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/*
 * Archive-relative paths are always POSIX, always relative, and never contain
 * a traversal segment. Everything that reads or writes an entry goes through
 * here so there is one definition of "safe path" in the format.
 */
function normalizeEntry(rel) {
  const value = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = value.split('/');
  if (!value || value.startsWith('/') || /^[a-z]:/i.test(value) || value.includes('\0')
    || parts.some((part) => !part || part === '.' || part === '..')) {
    fail('The profile contains an invalid path.', 400, 'invalid_path');
  }
  return parts.join('/');
}

function walkFiles(root, prefix = '') {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(abs, rel));
    else if (entry.isFile()) out.push({ rel, abs, bytes: fs.statSync(abs).size });
    // Links and devices are skipped: a profile carries data, not filesystem tricks.
  }
  return out;
}

function freeBytes(dir) {
  try { const stat = fs.statfsSync(dir); return stat.bavail * stat.bsize; } catch (_) { return null; }
}

// --- settings helpers ------------------------------------------------------

function encodeValue(value) {
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/*
 * Rewrite whole member values in PalWorldSettings.ini without touching
 * anything else in the file. Unknown keys and unknown values are preserved:
 * Hostkind never regenerates the file from a template.
 */
function setMembers(buffer, patch) {
  const parsed = settings.parse(buffer);
  if (parsed.errors.length) fail('The settings file could not be parsed.', 409, 'malformed_settings');
  const byKey = new Map(parsed.members.map((member) => [member.key, member]));
  const edits = [];
  let appended = '';
  for (const [key, value] of Object.entries(patch)) {
    const encoded = encodeValue(value);
    const member = byKey.get(key);
    if (member) edits.push({ start: member.valueStart, end: member.valueEnd, text: encoded });
    else appended += `${parsed.members.length || appended ? ',' : ''}${key}=${encoded}`;
  }
  let text = parsed.text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }
  if (appended) text = text.slice(0, parsed.tupleEnd) + appended + text.slice(parsed.tupleEnd);
  const result = Buffer.from(text, 'utf8');
  if (settings.parse(result).errors.length) fail('The rewritten settings file could not be verified.', 500, 'verification_failed');
  return result;
}

function settingsValues(buffer) {
  const parsed = settings.parse(buffer);
  return {
    readable: parsed.errors.length === 0,
    revision: parsed.revision,
    values: new Map(parsed.members.map((member) => [member.key, settings.decode(member.rawValue)])),
  };
}

function redactSettings(buffer) {
  const parsed = settings.parse(buffer);
  if (parsed.errors.length) fail('The settings file could not be parsed, so it cannot be exported safely.', 409, 'malformed_settings');
  const present = SECRET_SETTINGS.filter((key) => parsed.members.some((member) => member.key === key));
  if (!present.length) return { buffer, redacted: [] };
  return {
    buffer: setMembers(buffer, Object.fromEntries(present.map((key) => [key, '']))),
    redacted: present,
  };
}

function assertNoSecrets(rel, buffer) {
  const text = buffer.toString('utf8');
  if (SECRET_VALUE_RE.test(text)) fail(`Export stopped: ${rel} still looks like it contains a secret.`, 500, 'secret_detected');
  for (const key of SECRET_SETTINGS) {
    const match = text.match(new RegExp(`${key}\\s*=\\s*"([^"]+)"`));
    if (match) fail(`Export stopped: ${rel} still contains ${key}.`, 500, 'secret_detected');
  }
}

// --- export ----------------------------------------------------------------

function normalizeSelection(value) {
  const selection = String(value || 'complete').toLowerCase();
  if (!SELECTIONS.includes(selection)) fail(`Unsupported export selection: ${selection}`, 400, 'invalid_selection');
  return selection;
}

function sections(selection) {
  return {
    configuration: true,
    world: selection === 'world' || selection === 'complete',
    mods: selection === 'mods' || selection === 'complete',
    schedules: selection === 'configuration' || selection === 'complete',
  };
}

/*
 * The metadata a profile is allowed to carry. Machine paths, launch arguments,
 * the administration password, and the REST credentials are all left behind on
 * purpose: what travels is the *shape* of the server, not this machine.
 */
function redactedMetadata(server, extras = {}) {
  return {
    name: String(server.name || '').slice(0, 200),
    serverName: server.serverName ? String(server.serverName).slice(0, 200) : null,
    worldName: server.worldName ? String(server.worldName).slice(0, 200) : null,
    maxPlayers: Number(server.maxPlayers) || null,
    gamePort: Number(server.port) || null,
    restPort: Number(server.restPort) || null,
    targetPlatform: platform.targetPlatform(server),
    stopTimeoutSeconds: Number(server.stopTimeoutSeconds) || null,
    watchdog: server.watchdog && typeof server.watchdog === 'object' && !Array.isArray(server.watchdog)
      ? {
        enabled: !!server.watchdog.enabled,
        maxRestarts: Number(server.watchdog.maxRestarts) || null,
        windowMinutes: Number(server.watchdog.windowMinutes) || null,
      }
      : null,
    build: extras.build || null,
  };
}

function collectSources({ server, selection, tasks = [], updatePolicy = null }) {
  const chosen = sections(selection);
  const files = [];
  const warnings = [];

  const settingsFile = settings.configPath(server.dir);
  if (fs.existsSync(settingsFile)) {
    const { buffer, redacted } = redactSettings(fs.readFileSync(settingsFile));
    files.push({ rel: 'config/PalWorldSettings.ini', content: buffer, bytes: buffer.length, section: 'configuration' });
    if (redacted.length) warnings.push({ code: 'secrets_excluded', keys: redacted });
  } else {
    warnings.push({ code: 'settings_missing' });
  }

  if (chosen.world) {
    const saveRoot = path.join(server.dir, SAVE_RELATIVE);
    const saves = walkFiles(saveRoot);
    if (!saves.length) warnings.push({ code: 'no_save_data' });
    for (const file of saves) files.push({ rel: `save/${file.rel}`, source: file.abs, bytes: file.bytes, section: 'world' });
  }

  if (chosen.mods) {
    const inventory = path.join(server.dir, MODS_INVENTORY);
    if (fs.existsSync(inventory)) {
      // Provenance and manifests only. Mod payloads are never copied: they
      // belong to their providers and their licenses.
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(inventory, 'utf8')); } catch (_) { parsed = null; }
      const packages = Array.isArray(parsed?.packages) ? parsed.packages : [];
      const content = Buffer.from(JSON.stringify({
        version: 1,
        packages: packages.map((pkg) => ({
          name: pkg.name, slug: pkg.slug, kind: pkg.kind, framework: pkg.framework,
          provider: pkg.provider, sourceItemId: pkg.sourceItemId || null, version: pkg.version || null,
          license: pkg.license || null, clientRequired: pkg.clientRequired ?? null,
          files: Array.isArray(pkg.files) ? pkg.files.length : 0,
          sizeBytes: Number(pkg.sizeBytes) || 0,
        })),
      }, null, 2), 'utf8');
      files.push({ rel: 'mods/manifest.json', content, bytes: content.length, section: 'mods' });
      if (packages.length) warnings.push({ code: 'mod_payloads_excluded', count: packages.length });
    } else {
      warnings.push({ code: 'no_mods' });
    }
  }

  if (chosen.schedules) {
    const content = Buffer.from(JSON.stringify({
      version: 1,
      // Schedules travel as definitions, not as identities: no server id, no
      // actor, and every value passes through the shared redactor because a
      // console-command action can carry anything the operator typed.
      tasks: (Array.isArray(tasks) ? tasks : []).map((task) => redact.redactObject({
        name: task.name || null,
        enabled: task.enabled !== false,
        trigger: task.trigger || (task.cron ? { kind: 'cron', expression: task.cron } : null),
        action: task.action || (task.type ? { kind: task.type } : null),
      })),
      updatePolicy: updatePolicy ? updates.safePolicy(updatePolicy) : null,
    }, null, 2), 'utf8');
    files.push({ rel: 'schedules.json', content, bytes: content.length, section: 'schedules' });
  }

  return { files, warnings, chosen };
}

function exportPreview({ server, selection = 'complete', tasks = [], updatePolicy = null }) {
  const normalized = normalizeSelection(selection);
  const { files, warnings, chosen } = collectSources({ server, selection: normalized, tasks, updatePolicy });
  const bySection = {};
  for (const file of files) {
    const entry = bySection[file.section] || (bySection[file.section] = { files: 0, bytes: 0 });
    entry.files += 1;
    entry.bytes += file.bytes;
  }
  return {
    ok: true,
    format: FORMAT,
    version: PROFILE_VERSION,
    selection: normalized,
    sections: chosen,
    totals: { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) },
    bySection,
    warnings,
    excluded: ['administration password', 'server password', 'REST credentials', 'machine paths', 'launch arguments', 'dedicated server binaries'],
  };
}

/*
 * Build the archive. Entries are hashed as they are collected, the manifest
 * records every hash, and a digest over the sorted hash list is what an
 * importer checks first - one changed byte anywhere fails the whole profile.
 */
async function exportProfile({ server, selection = 'complete', actorId = null, tasks = [], updatePolicy = null, build = null }) {
  const normalized = normalizeSelection(selection);
  const { files, warnings, chosen } = collectSources({ server, selection: normalized, tasks, updatePolicy });
  const entries = [];
  for (const file of files) {
    const rel = normalizeEntry(file.rel);
    const digest = file.content ? sha256(file.content) : sha256File(file.source);
    if (file.content) assertNoSecrets(rel, file.content);
    entries.push({ path: rel, bytes: file.bytes, sha256: digest });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    format: FORMAT,
    version: PROFILE_VERSION,
    createdAt: new Date().toISOString(),
    selection: normalized,
    sections: chosen,
    server: redactedMetadata(server, { build: build || updates.installedBuild(server.dir) }),
    entries,
    entriesDigest: sha256(Buffer.from(entries.map((entry) => `${entry.path}:${entry.sha256}`).join('\n'), 'utf8')),
    secretsExcluded: true,
  };
  assertNoSecrets('manifest.json', Buffer.from(JSON.stringify(manifest)));

  const id = crypto.randomUUID();
  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${id}.fdprofile.zip`);
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(dest, { flags: 'wx' });
    const zip = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    output.on('error', reject);
    zip.on('error', reject);
    zip.pipe(output);
    zip.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    for (const file of files) {
      if (file.content) zip.append(file.content, { name: normalizeEntry(file.rel) });
      else zip.file(file.source, { name: normalizeEntry(file.rel) });
    }
    zip.finalize();
  });
  const stat = fs.statSync(dest);
  return {
    ok: true,
    id,
    file: dest,
    fileName: `${(server.name || 'palworld').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'palworld'}-${normalized}.fdprofile.zip`,
    bytes: stat.size,
    sha256: sha256File(dest),
    manifest,
    warnings,
    actorId,
  };
}

function exportFile(id) {
  const safe = String(id || '').replace(/[^a-zA-Z0-9-]/g, '');
  if (!safe) fail('Invalid export id.', 400, 'invalid_id');
  const file = path.join(profileDir(), `${safe}.fdprofile.zip`);
  if (!fs.existsSync(file)) fail('That export is no longer available.', 404, 'export_not_found');
  return file;
}

// --- import ----------------------------------------------------------------

function sweepPreviews(now = Date.now()) {
  for (const [token, preview] of previews) {
    if (preview.expiresAt > now) continue;
    previews.delete(token);
    fs.rmSync(path.join(importDir(), token), { recursive: true, force: true });
  }
}

/*
 * Extract an untrusted archive into staging, streaming every entry to disk and
 * hashing it on the way. Nothing is trusted until the manifest and the bytes
 * agree, which is why extraction happens before validation and *only* into the
 * import staging directory.
 */
function extractToStaging(file, stagingRoot) {
  return new Promise((resolve, reject) => {
    const state = {};
    const written = new Map();
    let manifest = null;
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (openError, zip) => {
      if (openError) return reject(new ProfileError('That file is not a readable profile archive.', 400, 'invalid_archive'));
      const abort = (error) => { try { zip.close(); } catch (_) { /* already closed */ } reject(error); };
      zip.on('error', abort);
      zip.on('entry', (entry) => {
        let normalized;
        try {
          normalized = archiveGuard.checkEntry(entry, state, {
            maxEntries: MAX_ENTRIES,
            maxTotalSize: MAX_TOTAL_BYTES,
            maxEntrySize: MAX_ENTRY_BYTES,
          });
        } catch (error) {
          return abort(new ProfileError(`The profile archive was rejected: ${error.message}`, 400, error.code || 'archive_rejected'));
        }
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        let rel;
        try { rel = normalizeEntry(normalized); } catch (error) { return abort(error); }
        if (rel !== 'manifest.json' && !/^(?:config|save|mods)\//.test(rel) && rel !== 'schedules.json') {
          return abort(new ProfileError(`The profile contains an unexpected entry: ${rel}`, 400, 'archive_scope'));
        }
        const target = path.join(stagingRoot, ...rel.split('/'));
        if (!target.startsWith(stagingRoot + path.sep)) return abort(new ProfileError('The profile contains an invalid path.', 400, 'invalid_path'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return abort(streamError);
          const hash = crypto.createHash('sha256');
          const out = fs.createWriteStream(target, { flags: 'wx' });
          stream.on('error', abort);
          out.on('error', abort);
          stream.on('data', (chunk) => hash.update(chunk));
          stream.pipe(out);
          out.on('close', () => {
            written.set(rel, { sha256: hash.digest('hex'), bytes: fs.statSync(target).size });
            if (rel === 'manifest.json') {
              try { manifest = JSON.parse(fs.readFileSync(target, 'utf8')); }
              catch { return abort(new ProfileError('The profile manifest is not valid JSON.', 400, 'invalid_manifest')); }
            }
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => {
        try { archiveGuard.finalize(state, { maxAggregateRatio: 100 }); }
        catch (error) { return reject(new ProfileError(`The profile archive was rejected: ${error.message}`, 400, error.code || 'archive_rejected')); }
        resolve({ manifest, written });
      });
      zip.readEntry();
    });
  });
}

function validateManifest(manifest, written) {
  if (!manifest || manifest.format !== FORMAT) fail('That archive is not a Hostkind Palworld profile.', 400, 'unsupported_format');
  const version = Number(manifest.version);
  if (!Number.isInteger(version) || version < 1) fail('The profile manifest is incomplete.', 400, 'invalid_manifest');
  if (version > PROFILE_VERSION) fail('This profile was written by a newer Hostkind version.', 400, 'unsupported_version');
  if (!Array.isArray(manifest.entries)) fail('The profile manifest is incomplete.', 400, 'invalid_manifest');
  const seen = new Set();
  for (const entry of manifest.entries) {
    const rel = normalizeEntry(entry?.path);
    const folded = rel.toLowerCase();
    if (seen.has(folded)) fail('The profile has duplicate or case-colliding paths.', 400, 'case_collision');
    seen.add(folded);
    const actual = written.get(rel);
    if (!actual) fail(`The profile is missing a file it declares: ${rel}`, 400, 'missing_entry');
    if (actual.sha256 !== String(entry.sha256 || '').toLowerCase()) fail(`Profile verification failed: ${rel}`, 400, 'hash_mismatch');
  }
  const extras = [...written.keys()].filter((rel) => rel !== 'manifest.json' && !seen.has(rel.toLowerCase()));
  if (extras.length) fail(`The profile contains undeclared files: ${extras[0]}`, 400, 'manifest_mismatch');
  const digest = sha256(Buffer.from(manifest.entries
    .map((entry) => `${normalizeEntry(entry.path)}:${String(entry.sha256).toLowerCase()}`)
    .sort()
    .join('\n'), 'utf8'));
  if (manifest.entriesDigest && manifest.entriesDigest !== digest) fail('The profile manifest digest does not match its contents.', 400, 'digest_mismatch');
  return manifest;
}

function portInUse(servers, port, exceptId = null) {
  if (!port) return null;
  return servers.find((server) => server && server.id !== exceptId
    && (Number(server.port) === Number(port) || Number(server.restPort) === Number(port))) || null;
}

async function importPreview({ file, actorId = null, servers = [], now = Date.now() }) {
  sweepPreviews(now);
  const token = crypto.randomUUID();
  const stagingRoot = path.join(importDir(), token, 'payload');
  fs.mkdirSync(stagingRoot, { recursive: true });
  let scanned;
  try {
    scanned = await extractToStaging(file, stagingRoot);
    validateManifest(scanned.manifest, scanned.written);
  } catch (error) {
    fs.rmSync(path.join(importDir(), token), { recursive: true, force: true });
    throw error;
  }
  const manifest = scanned.manifest;
  const totals = [...scanned.written.entries()]
    .filter(([rel]) => rel !== 'manifest.json')
    .reduce((sum, [, value]) => ({ files: sum.files + 1, bytes: sum.bytes + value.bytes }), { files: 0, bytes: 0 });
  const collisions = [];
  const nameTaken = servers.find((server) => String(server?.name || '').toLowerCase() === String(manifest.server?.name || '').toLowerCase());
  if (nameTaken) collisions.push({ kind: 'name', value: manifest.server.name });
  const gameConflict = portInUse(servers, manifest.server?.gamePort);
  if (gameConflict) collisions.push({ kind: 'port', value: manifest.server.gamePort, server: gameConflict.name || gameConflict.id });
  const restConflict = portInUse(servers, manifest.server?.restPort);
  if (restConflict) collisions.push({ kind: 'restPort', value: manifest.server.restPort, server: restConflict.name || restConflict.id });

  previews.set(token, {
    token,
    actorId,
    stagingRoot,
    manifest,
    bytes: totals.bytes,
    expiresAt: now + PREVIEW_TTL_MS,
  });
  return {
    ok: true,
    token,
    expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
    manifest: {
      format: manifest.format,
      version: manifest.version,
      createdAt: manifest.createdAt,
      selection: manifest.selection,
      sections: manifest.sections,
      server: manifest.server,
    },
    totals,
    requiredBytes: Math.ceil(totals.bytes * 1.2),
    collisions,
    suggestedName: manifest.server?.name || 'Imported Palworld server',
    suggestedPorts: { game: manifest.server?.gamePort || null, rest: manifest.server?.restPort || null },
    generatesNewAdminPassword: true,
    requiresServerFiles: true,
    nextSteps: [
      'Choose an empty destination folder, a name, and ports.',
      'Hostkind generates a new administration password; the profile never carried one.',
      'Install the Palworld dedicated server files into the folder after import.',
    ],
  };
}

function takePreview({ token, actorId, now = Date.now() }) {
  sweepPreviews(now);
  const preview = previews.get(String(token || ''));
  if (!preview) fail('That import preview expired or is invalid. Preview the file again.', 409, 'stale_preview');
  if (preview.actorId && actorId && preview.actorId !== actorId) fail('That import preview belongs to another session.', 403, 'preview_owner_mismatch');
  if (preview.expiresAt <= now) {
    previews.delete(preview.token);
    fs.rmSync(path.join(importDir(), preview.token), { recursive: true, force: true });
    fail('That import preview expired. Preview the file again.', 409, 'stale_preview');
  }
  return preview;
}

function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

/*
 * Turn a validated preview into a new server root. The destination is built in
 * staging on the destination filesystem and promoted with a single rename, so
 * an interrupted import never leaves a half-built server behind, and an
 * existing destination is never merged into.
 */
function confirmImport({
  token, actorId = null, name, dir, port, restPort, servers = [], now = Date.now(),
  generatePassword = () => crypto.randomBytes(32).toString('base64url'),
}) {
  const preview = takePreview({ token, actorId, now });
  const manifest = preview.manifest;

  const serverName = String(name || '').trim();
  if (!serverName) fail('Enter a name for the imported server.', 400, 'name_required');
  if (serverName.length > 80) fail('That name is too long.', 400, 'name_too_long');
  if (servers.some((server) => String(server?.name || '').toLowerCase() === serverName.toLowerCase())) {
    fail('Another registered server already uses that name.', 409, 'name_collision');
  }
  const gamePort = Number(port || manifest.server?.gamePort);
  const apiPort = Number(restPort || manifest.server?.restPort || (gamePort ? gamePort + 1 : 0));
  for (const [label, value] of [['game', gamePort], ['REST', apiPort]]) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) fail(`Choose a valid ${label} port.`, 400, 'invalid_port');
  }
  if (gamePort === apiPort) fail('The game port and the REST port must differ.', 400, 'invalid_port');
  const conflict = portInUse(servers, gamePort) || portInUse(servers, apiPort);
  if (conflict) fail(`Those ports are already used by "${conflict.name || conflict.id}".`, 409, 'port_collision');

  const destination = pathSafety.assertUsableRoot(dir, { servers });
  const parent = path.dirname(destination);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) fail('The destination parent folder does not exist.', 400, 'parent_missing');
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) {
    fail('The destination folder is not empty. Imports never merge into an existing folder.', 409, 'destination_not_empty');
  }
  const free = freeBytes(parent);
  const required = Math.ceil(preview.bytes * 1.2);
  if (free != null && free < required) fail('Not enough free disk space at the destination.', 507, 'low_disk');

  const staged = path.join(parent, STAGING_DIR, preview.token);
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(staged, { recursive: true });
  const adminPassword = generatePassword();
  try {
    const stagedSettings = path.join(preview.stagingRoot, 'config', 'PalWorldSettings.ini');
    if (fs.existsSync(stagedSettings)) {
      const rewritten = setMembers(fs.readFileSync(stagedSettings), {
        AdminPassword: adminPassword,
        RESTAPIEnabled: true,
        RESTAPIPort: apiPort,
        PublicPort: gamePort,
        ServerName: manifest.server?.serverName || serverName,
      });
      const target = path.join(staged, 'Pal', 'Saved', 'Config',
        process.platform === 'win32' ? 'WindowsServer' : 'LinuxServer', 'PalWorldSettings.ini');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, rewritten);
    }
    const stagedSave = path.join(preview.stagingRoot, 'save');
    if (fs.existsSync(stagedSave)) copyTree(stagedSave, path.join(staged, SAVE_RELATIVE));

    const record = path.join(staged, PROFILE_RECORD_DIR);
    fs.mkdirSync(record, { recursive: true });
    fs.writeFileSync(path.join(record, 'imported-profile.json'), JSON.stringify({
      importedAt: new Date(now).toISOString(),
      actorId,
      format: manifest.format,
      version: manifest.version,
      selection: manifest.selection,
      sections: manifest.sections,
      entriesDigest: manifest.entriesDigest,
      sourceName: manifest.server?.name || null,
    }, null, 2));
    for (const [rel, name2] of [['mods/manifest.json', 'mods-manifest.json'], ['schedules.json', 'schedules.json']]) {
      const from = path.join(preview.stagingRoot, ...rel.split('/'));
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(record, name2));
    }

    if (fs.existsSync(destination)) fs.rmdirSync(destination);
    fs.renameSync(staged, destination);
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    if (error instanceof ProfileError) throw error;
    fail(`The import could not be completed: ${error.message}`, 500, 'import_failed');
  }
  previews.delete(preview.token);
  fs.rmSync(path.join(importDir(), preview.token), { recursive: true, force: true });

  let schedules = null;
  try { schedules = JSON.parse(fs.readFileSync(path.join(destination, PROFILE_RECORD_DIR, 'schedules.json'), 'utf8')); } catch (_) { /* optional */ }
  return {
    ok: true,
    descriptor: {
      type: 'palworld',
      name: serverName,
      dir: destination,
      serverName: manifest.server?.serverName || serverName,
      worldName: manifest.server?.worldName || null,
      maxPlayers: manifest.server?.maxPlayers || null,
      port: gamePort,
      restPort: apiPort,
      adminPassword,
      stopTimeoutSeconds: manifest.server?.stopTimeoutSeconds || 30,
      watchdog: manifest.server?.watchdog || { enabled: false, maxRestarts: 3, windowMinutes: 10 },
    },
    requiresServerFiles: true,
    schedules: schedules?.tasks || [],
    updatePolicy: schedules?.updatePolicy || null,
    nextSteps: [
      'Install the Palworld dedicated server files into the imported folder before starting it.',
      'A new administration password was generated for this server.',
    ],
  };
}

// --- adoption --------------------------------------------------------------

function findExecutable(dir) {
  const candidates = ['PalServer.exe', 'PalServer.sh', 'PalServer-Linux-Shipping', 'PalServer'];
  for (const name of candidates) {
    const abs = path.join(dir, name);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return { path: abs, relative: name };
  }
  const binaries = path.join(dir, 'Pal', 'Binaries');
  if (fs.existsSync(binaries)) {
    for (const entry of fs.readdirSync(binaries, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const name of candidates) {
        const abs = path.join(binaries, entry.name, name);
        if (fs.existsSync(abs)) return { path: abs, relative: path.relative(dir, abs) };
      }
    }
  }
  return null;
}

function listSaves(dir) {
  const root = path.join(dir, SAVE_RELATIVE);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const stack = [{ abs: root, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    if (current.depth > 2) continue;
    for (const entry of fs.readdirSync(current.abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const abs = path.join(current.abs, entry.name);
      const hasSave = fs.existsSync(path.join(abs, 'Level.sav'));
      if (hasSave) {
        const stat = fs.statSync(abs);
        out.push({ name: entry.name, relative: path.relative(dir, abs), modifiedAt: stat.mtime.toISOString() });
      } else {
        stack.push({ abs, depth: current.depth + 1 });
      }
    }
  }
  return out;
}

/*
 * Everything Hostkind can learn about an existing installation without
 * changing a single byte of it. `reconcile` is the honest part: the REST
 * settings Hostkind needs are listed *before* adoption so the operator can see
 * what would change, including the case where an existing administration
 * password would be replaced.
 */
function inspectAdoption({ dir, servers = [], desiredRestPort = null }) {
  const raw = String(dir || '').trim();
  const blocked = pathSafety.protectedReason(raw, { servers, requireExisting: true });
  if (blocked) {
    return { ok: false, dir: raw, blocked, ready: false, issues: [blocked.message] };
  }
  const root = pathSafety.canonical(raw);
  const issues = [];
  const executable = findExecutable(root);
  if (!executable) issues.push('No Palworld dedicated server executable was found in this folder.');
  const target = executable ? platform.targetPlatform({ executable: executable.path }) : 'unknown';
  const host = platform.hostPlatform();
  const compatibility = executable
    ? platform.compatibility({ server: { executable: executable.path }, host })
    : { supported: false, reason: 'unknown_target', runtime: 'none' };
  if (executable && !compatibility.supported && compatibility.reason !== 'wine_not_detected' && compatibility.reason !== 'wine_not_configured') {
    issues.push(compatibility.explanation || 'This installation cannot run on this host.');
  }

  const settingsFile = settings.configPath(root);
  const hasSettings = fs.existsSync(settingsFile);
  let parsed = { readable: false, revision: null, values: new Map() };
  if (hasSettings) {
    try { parsed = settingsValues(fs.readFileSync(settingsFile)); } catch (_) { parsed = { readable: false, revision: null, values: new Map() }; }
    if (!parsed.readable) issues.push('PalWorldSettings.ini exists but could not be parsed.');
  } else {
    issues.push('PalWorldSettings.ini was not found. It is created the first time the server runs.');
  }

  const publicPort = Number(parsed.values.get('PublicPort')) || null;
  const restPort = Number(parsed.values.get('RESTAPIPort')) || null;
  const restEnabled = parsed.values.get('RESTAPIEnabled') === true;
  const adminPassword = String(parsed.values.get('AdminPassword') || '');
  const wantedRestPort = Number(desiredRestPort) || restPort || (publicPort ? publicPort + 1 : null);

  const reconcile = [];
  if (!restEnabled) {
    reconcile.push({ key: 'RESTAPIEnabled', current: false, next: true, why: 'Hostkind manages Palworld through the loopback REST API.' });
  }
  if (!restPort || (wantedRestPort && restPort !== wantedRestPort)) {
    reconcile.push({ key: 'RESTAPIPort', current: restPort, next: wantedRestPort, why: 'Hostkind needs a known REST port to reach this server.' });
  }
  if (!adminPassword) {
    reconcile.push({ key: 'AdminPassword', current: null, next: 'generated', why: 'No administration password is set. Hostkind generates one and keeps it out of the browser.' });
  } else {
    reconcile.push({ key: 'AdminPassword', current: 'set', next: 'unchanged', why: 'The existing administration password is preserved and never shown.' });
  }

  const portConflict = servers.find((server) => server && (Number(server.port) === publicPort || Number(server.restPort) === wantedRestPort));
  if (portConflict) issues.push(`Ports overlap the registered server "${portConflict.name || portConflict.id}".`);

  const saves = listSaves(root);
  const build = updates.installedBuild(root);
  const mods = fs.existsSync(path.join(root, MODS_INVENTORY));

  return {
    ok: true,
    dir: root,
    blocked: null,
    executable: executable ? { relative: executable.relative } : null,
    targetPlatform: target,
    host,
    compatibility: { supported: compatibility.supported, runtime: compatibility.runtime, reason: compatibility.reason, explanation: compatibility.explanation || null },
    settings: { present: hasSettings, readable: parsed.readable, file: hasSettings ? path.relative(root, settingsFile) : null, revision: parsed.revision },
    ports: { publicPort, restPort, restEnabled, proposedRestPort: wantedRestPort },
    build,
    saves,
    modsInventoryPresent: mods,
    reconcile,
    preserves: ['existing world saves', 'server identity and settings', 'unrelated files in this folder'],
    ready: !!executable && issues.length === 0,
    issues,
  };
}

/*
 * Adopt. The only writes are the REST settings the inspection already showed
 * the operator, taken behind a verified snapshot. Saves, identity, and unrelated
 * files are untouched, and the returned descriptor is what the caller registers.
 */
function adopt({ dir, name, servers = [], desiredRestPort = null, serverId = null, generatePassword = () => crypto.randomBytes(32).toString('base64url') }) {
  const inspection = inspectAdoption({ dir, servers, desiredRestPort });
  if (!inspection.ok) fail(inspection.blocked?.message || 'That folder cannot be adopted.', 409, inspection.blocked?.reason || 'not_adoptable');
  if (!inspection.executable) fail('No Palworld dedicated server executable was found in this folder.', 422, 'executable_missing');
  if (!inspection.settings.present) fail('PalWorldSettings.ini was not found. Start the server once, then adopt it.', 422, 'settings_missing');
  if (!inspection.settings.readable) fail('PalWorldSettings.ini could not be parsed, so it cannot be reconciled.', 409, 'malformed_settings');
  const serverName = String(name || inspection.dir.split(path.sep).pop()).trim().slice(0, 80);
  if (servers.some((server) => String(server?.name || '').toLowerCase() === serverName.toLowerCase())) {
    fail('Another registered server already uses that name.', 409, 'name_collision');
  }

  const root = inspection.dir;
  const file = settings.configPath(root);
  const before = fs.readFileSync(file);
  const parsed = settingsValues(before);
  const existingPassword = String(parsed.values.get('AdminPassword') || '');
  const adminPassword = existingPassword || generatePassword();
  const restPort = inspection.ports.proposedRestPort;
  if (!Number.isInteger(restPort) || restPort < 1 || restPort > 65535) fail('Choose a valid REST port for this server.', 400, 'invalid_port');

  const relative = path.relative(root, file);
  const snapshot = snapshots.take({
    serverId: serverId || `adopt-${crypto.randomUUID()}`,
    sourceDir: root,
    scope: [relative],
    kind: 'palworld-adoption',
    reason: `Before adopting ${serverName}`,
    retention: 10,
  });
  if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');

  const patch = { RESTAPIEnabled: true, RESTAPIPort: restPort };
  if (!existingPassword) patch.AdminPassword = adminPassword;
  const rewritten = setMembers(before, patch);
  const temporary = path.join(path.dirname(file), `.PalWorldSettings.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, rewritten);
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    fail(`The settings file could not be updated: ${error.message}`, 500, 'reconcile_failed');
  }

  return {
    ok: true,
    snapshotId: snapshot.id,
    reconciled: Object.keys(patch),
    descriptor: {
      type: 'palworld',
      name: serverName,
      dir: root,
      cwd: path.dirname(path.join(root, inspection.executable.relative)),
      executable: path.join(root, inspection.executable.relative),
      args: [`-port=${inspection.ports.publicPort || 8211}`, '-useperfthreads', '-NoAsyncLoadingThread', '-UseMultithreadForDS', '-log'],
      port: inspection.ports.publicPort || 8211,
      restPort,
      adminPassword,
      maxPlayers: Number(parsed.values.get('ServerPlayerMaxNum')) || 32,
      serverName: String(parsed.values.get('ServerName') || serverName).slice(0, 200),
      stopTimeoutSeconds: 30,
      watchdog: { enabled: false, maxRestarts: 3, windowMinutes: 10 },
    },
    preserved: inspection.preserves,
    build: inspection.build,
  };
}

function resetCaches() {
  previews.clear();
}

module.exports = {
  FORMAT,
  PROFILE_VERSION,
  SELECTIONS,
  ProfileError,
  normalizeEntry,
  setMembers,
  redactSettings,
  sections,
  redactedMetadata,
  exportPreview,
  exportProfile,
  exportFile,
  importPreview,
  confirmImport,
  takePreview,
  validateManifest,
  inspectAdoption,
  adopt,
  findExecutable,
  listSaves,
  resetCaches,
};
