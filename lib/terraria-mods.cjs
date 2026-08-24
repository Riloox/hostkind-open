'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const yauzl = require('yauzl');
const snapshots = require('./snapshots.cjs');
const trash = require('./trash.cjs');
const { checkEntry, finalize, ArchiveError } = require('./archiveGuard.cjs');
const { ensureSteamCmd, runSteam: runSteamCmd } = require('./dedicatedServerInstaller.cjs');

const INVENTORY_VERSION = 1;
const MAX_MOD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILES = 100000;
const PREVIEW_TTL_MS = 15 * 60_000;
const previews = new Map();
const WORKSHOP_APP_ID = '1281930';
const WORKSHOP_ENDPOINT = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
const WORKSHOP_BROWSE_URL = 'https://steamcommunity.com/workshop/browse/';
const WORKSHOP_CACHE_TTL_MS = 10 * 60_000;
const WORKSHOP_MAX_STALE_MS = 24 * 60 * 60_000;
const workshopCache = new Map();
const workshopCatalogCache = new Map();

class TerrariaModError extends Error {
  constructor(message, status = 400, code = 'terraria_mod_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(message, status, code) {
  throw new TerrariaModError(message, status, code);
}

function serverDir(desc) {
  const root = path.resolve(String(desc?.dir || ''));
  if (!desc || !desc.id || !path.isAbsolute(root)) fail('This server has no usable folder.', 409, 'server_dir_unknown');
  return root;
}

function relativeInside(root, target, allowRoot = false) {
  const rel = path.relative(root, target);
  if ((!rel && !allowRoot) || rel.startsWith('..') || path.isAbsolute(rel)) fail('The tModLoader save folder must be inside the server folder.', 409, 'save_dir_outside');
  return rel.split(path.sep).join('/');
}

function launchValue(desc, flag) {
  const args = Array.isArray(desc?.args) ? desc.args : [];
  const index = args.findIndex((arg) => String(arg).toLowerCase() === flag);
  return index >= 0 && args[index + 1] ? String(args[index + 1]) : null;
}

function resolveModsDir(desc) {
  const root = serverDir(desc);
  const configured = launchValue(desc, '-tmlsavedirectory');
  const saveRoot = configured
    ? (path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(root, configured))
    : root;
  relativeInside(root, saveRoot, true);
  const modsDir = path.join(saveRoot, 'Mods');
  return { root, saveRoot, abs: modsDir, rel: relativeInside(root, modsDir), source: configured ? 'launch-flag' : 'server-root' };
}

function stateDir(desc) {
  return path.join(serverDir(desc), '.fleetdeck', 'terraria-mods');
}

function inventoryPath(desc) {
  return path.join(stateDir(desc), 'inventory.v1.json');
}

function sourcesPath(desc) {
  return path.join(stateDir(desc), 'sources.v1.json');
}

function packsPath(desc) {
  return path.join(stateDir(desc), 'modpacks.v1.json');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function readSources(desc) {
  const value = readJson(sourcesPath(desc), { version: 1, mods: {} });
  return value?.version === 1 && value.mods && typeof value.mods === 'object' && !Array.isArray(value.mods) ? value : { version: 1, mods: {} };
}

function writeSources(desc, value) {
  atomicWrite(sourcesPath(desc), `${JSON.stringify(value, null, 2)}\n`);
}

function readPacks(desc) {
  const value = readJson(packsPath(desc), { format: 'fleetdeck-terraria-modpacks', version: 1, packs: [] });
  if (value?.format !== 'fleetdeck-terraria-modpacks' || value.version !== 1 || !Array.isArray(value.packs)) {
    fail('The Terraria modpack store is invalid.', 409, 'modpacks_invalid');
  }
  return value;
}

function writePacks(desc, value) {
  atomicWrite(packsPath(desc), `${JSON.stringify(value, null, 2)}\n`);
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

function read7(buffer, state) {
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 5; i += 1) {
    if (state.offset >= buffer.length) fail('The .tmod file is truncated.', 422, 'tmod_truncated');
    const byte = buffer[state.offset++];
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return value;
    shift += 7;
  }
  fail('The .tmod file contains an invalid string length.', 422, 'tmod_invalid');
}

function readString(buffer, state, limit = 1024 * 1024) {
  const length = read7(buffer, state);
  if (length < 0 || length > limit || state.offset + length > buffer.length) fail('The .tmod file contains an invalid string.', 422, 'tmod_invalid');
  const value = buffer.subarray(state.offset, state.offset + length).toString('utf8');
  state.offset += length;
  return value;
}

function readInt(buffer, state) {
  if (state.offset + 4 > buffer.length) fail('The .tmod file is truncated.', 422, 'tmod_truncated');
  const value = buffer.readInt32LE(state.offset);
  state.offset += 4;
  return value;
}

function readInfo(buffer) {
  const state = { offset: 0 };
  const info = { author: '', displayName: '', version: null, buildVersion: null, dependencies: [] };
  const lists = new Set(['dllReferences', 'modReferences', 'weakReferences', 'sortAfter', 'sortBefore']);
  const strings = new Set(['author', 'version', 'displayName', 'homepage', 'description', 'eacPath', 'modSource', 'buildVersion']);
  const flags = new Set(['noCompile', '!playableOnPreview', 'translationMod', '!hideCode', '!hideResources', 'includeSource', 'beta']);
  while (state.offset < buffer.length) {
    const tag = readString(buffer, state, 256);
    if (!tag) break;
    if (lists.has(tag)) {
      const values = [];
      for (;;) {
        const value = readString(buffer, state, 2048);
        if (!value) break;
        values.push(value);
      }
      if (tag === 'modReferences') {
        info.dependencies = values.map((value) => {
          const index = value.indexOf('@');
          return index < 0
            ? { internalName: value, version: null }
            : { internalName: value.slice(0, index), version: value.slice(index + 1) || null };
        });
      }
    } else if (strings.has(tag) || /^displayName\./i.test(tag)) {
      const value = readString(buffer, state);
      if (tag === 'author') info.author = value;
      else if (tag === 'version') info.version = value;
      else if (tag === 'displayName' || tag === 'displayName.en-US') info.displayName = value;
      else if (tag === 'buildVersion') info.buildVersion = value;
    } else if (tag === 'side') {
      if (state.offset >= buffer.length) fail('The .tmod Info entry is truncated.', 422, 'tmod_info_truncated');
      state.offset += 1;
    } else if (!flags.has(tag)) {
      fail(`The .tmod Info entry uses an unsupported field: ${tag}.`, 422, 'tmod_info_unknown');
    }
  }
  return info;
}

function parseTmod(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 300) fail('The .tmod file is truncated.', 422, 'tmod_truncated');
  if (stat.size > MAX_MOD_BYTES) fail('The .tmod file is too large.', 422, 'tmod_too_large');
  const buffer = fs.readFileSync(file);
  const state = { offset: 0 };
  if (buffer.subarray(0, 4).toString('ascii') !== 'TMOD') fail('The file does not have a tModLoader header.', 422, 'tmod_magic');
  state.offset = 4;
  const containerVersion = readString(buffer, state, 128);
  const expectedHash = buffer.subarray(state.offset, state.offset + 20);
  state.offset += 20 + 256;
  const dataLength = readInt(buffer, state);
  const hashStart = state.offset;
  if (dataLength !== buffer.length - hashStart) fail('The .tmod data length does not match the file.', 422, 'tmod_hash_mismatch');
  const actualHash = crypto.createHash('sha1').update(buffer.subarray(hashStart)).digest();
  if (!crypto.timingSafeEqual(expectedHash, actualHash)) fail('The .tmod content hash is invalid.', 422, 'tmod_hash_mismatch');
  const internalName = readString(buffer, state, 256);
  const version = readString(buffer, state, 128);
  const count = readInt(buffer, state);
  if (count < 0 || count > MAX_FILES) fail('The .tmod file table is invalid.', 422, 'tmod_file_table');
  const files = [];
  let payloadBytes = 0;
  for (let i = 0; i < count; i += 1) {
    const name = readString(buffer, state, 4096).replace(/\\/g, '/');
    const length = readInt(buffer, state);
    const compressedLength = readInt(buffer, state);
    if (length < 0 || compressedLength < 0 || compressedLength > length || payloadBytes + compressedLength > buffer.length) {
      fail('The .tmod file table contains an invalid size.', 422, 'tmod_file_table');
    }
    files.push({ name, length, compressedLength });
    payloadBytes += compressedLength;
  }
  let cursor = state.offset;
  let properties = {};
  for (const entry of files) {
    if (cursor + entry.compressedLength > buffer.length) fail('The .tmod payload is truncated.', 422, 'tmod_truncated');
    if (entry.name === 'Info') {
      const raw = buffer.subarray(cursor, cursor + entry.compressedLength);
      let decoded = raw;
      if (entry.length !== entry.compressedLength) {
        try { decoded = zlib.inflateRawSync(raw, { maxOutputLength: Math.min(entry.length, 16 * 1024 * 1024) }); }
        catch { fail('The .tmod Info entry could not be decompressed.', 422, 'tmod_info_invalid'); }
      }
      if (decoded.length !== entry.length) fail('The .tmod Info entry has an invalid size.', 422, 'tmod_info_invalid');
      properties = readInfo(decoded);
    }
    cursor += entry.compressedLength;
  }
  if (cursor !== buffer.length) fail('The .tmod payload size does not match its file table.', 422, 'tmod_file_table');
  return {
    internalName,
    displayName: properties.displayName || internalName,
    version: properties.version || version,
    author: properties.author || '',
    tmlVersion: properties.buildVersion || containerVersion,
    dependencies: properties.dependencies || [],
    sizeBytes: stat.size,
  };
}

function readEnabled(mods) {
  const file = path.join(mods.abs, 'enabled.json');
  if (!fs.existsSync(file)) return { file, values: [], exists: false };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fail('Mods/enabled.json is not valid JSON.', 409, 'enabled_invalid'); }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    fail('Mods/enabled.json must be an array of mod names.', 409, 'enabled_invalid');
  }
  return { file, values: [...new Set(parsed)], exists: true };
}

function fingerprint(result) {
  return crypto.createHash('sha256').update(JSON.stringify([
    result.enabled,
    result.mods.map((mod) => [mod.file, mod.internalName, mod.version, mod.sizeBytes]),
    result.unreadable.map((item) => [item.file, item.reason]),
  ])).digest('hex');
}

function inventory(desc) {
  const mods = resolveModsDir(desc);
  const enabled = readEnabled(mods);
  const rows = [];
  const unreadable = [];
  let entries = [];
  try { entries = fs.readdirSync(mods.abs, { withFileTypes: true }); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const sources = readSources(desc);
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.tmod') continue;
    try {
      const parsed = parseTmod(path.join(mods.abs, entry.name));
      const source = sources.mods[parsed.internalName] || {};
      rows.push({
        ...parsed,
        file: entry.name,
        source: source.provider || 'local',
        enabled: enabled.values.includes(parsed.internalName),
        workshopId: source.workshopId || null,
        workshopUpdatedAt: source.workshopUpdatedAt || null,
      });
    } catch (error) {
      unreadable.push({ file: entry.name, reason: error.message, code: error.code || 'tmod_invalid' });
    }
  }
  rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
  const result = {
    modsDir: mods.rel,
    modsDirSource: mods.source,
    mods: rows,
    enabled: enabled.values,
    unreadable,
    scannedAt: new Date().toISOString(),
  };
  result.fingerprint = fingerprint(result);
  atomicWrite(inventoryPath(desc), JSON.stringify({
    format: 'fleetdeck-terraria-mods',
    version: INVENTORY_VERSION,
    ...result,
  }, null, 2));
  return result;
}

function parseWorkshopId(value) {
  const input = String(value || '').trim();
  const id = /^\d+$/.test(input) ? input : (() => {
    try { return new URL(input).searchParams.get('id') || ''; } catch (_) { return ''; }
  })();
  if (!/^\d{1,24}$/.test(id)) fail('Enter a numeric Workshop item ID or URL.', 400, 'workshop_id_invalid');
  return id;
}

/*
 * Decode HTML entities in one pass. Chained single-entity replacements would
 * re-scan the `&` emitted by an earlier step and double-unescape
 * double-encoded input (CodeQL js/double-escaping).
 */
const HTML_ENTITIES = Object.freeze({ amp: '&', quot: '"', '#39': "'", lt: '<', gt: '>' });

function decodeHtml(value) {
  return String(value || '').replace(/&(amp|quot|#39|lt|gt);/g, (match, name) => HTML_ENTITIES[name] ?? match);
}

function workshopUrl(id) {
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(id)}`;
}

function parseWorkshopCatalogHtml(html) {
  const items = [];
  const seen = new Set();
  const source = String(html || '');
  const pattern = /sharedfiles\/filedetails\/\?[^"'<>]*\bid=(\d+)|data-publishedfileid=["'](\d+)["']/gi;
  for (const match of source.matchAll(pattern)) {
    const id = match[1] || match[2];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const nearby = source.slice(match.index, match.index + 2000);
    const title = nearby.match(/workshopItemTitle[^>]*>([^<]+)/i)?.[1]
      || nearby.match(/<img[^>]+\balt=["']([^"']+)["']/i)?.[1]
      || '';
    const previewUrl = nearby.match(/<img[^>]+\bsrc=["']([^"']+)["']/i)?.[1] || '';
    items.push({
      id,
      title: decodeHtml(title.trim()),
      previewUrl: previewUrl ? decodeHtml(previewUrl) : null,
      url: workshopUrl(id),
    });
  }
  return items;
}

async function fetchWorkshop(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl || global.fetch)(url, { ...options, signal: controller.signal });
    if (!response.ok) fail('Steam Workshop is temporarily unavailable.', 502, 'workshop_unavailable');
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function workshopDetails(ids, { fetchImpl = global.fetch, timeoutMs = 8000 } = {}) {
  if (!ids.length) return new Map();
  const body = new URLSearchParams({ itemcount: String(ids.length) });
  ids.forEach((id, index) => body.set(`publishedfileids[${index}]`, id));
  const response = await fetchWorkshop(WORKSHOP_ENDPOINT, { fetchImpl, method: 'POST', body }, timeoutMs);
  const rows = (await response.json())?.response?.publishedfiledetails;
  if (!Array.isArray(rows)) fail('Steam returned an unexpected Workshop response.', 502, 'workshop_malformed');
  return new Map(rows.map((row) => {
    const id = String(row.publishedfileid);
    return [id, {
      id,
      available: Number(row.result) === 1,
      title: row.title || '',
      description: row.description || '',
      previewUrl: row.preview_url || null,
      authorId: row.creator || null,
      updatedAt: Number(row.time_updated) || null,
      subscriptions: Number(row.subscriptions) || null,
      tags: Array.isArray(row.tags) ? row.tags.map((tag) => tag.tag).filter(Boolean) : [],
      url: workshopUrl(id),
    }];
  }));
}

async function workshopCatalog({ query = '', page = 1, sort = 'trend', tag = '', fetchImpl = global.fetch, timeoutMs = 8000, force = false } = {}) {
  const safePage = Math.max(1, Math.min(1000, Number(page) || 1));
  const sortMap = { trend: 'trend', recent: 'mostrecent', subscribed: 'totaluniquesubscribers', updated: 'lastupdated' };
  const safeSort = sortMap[sort] || sortMap.trend;
  const safeQuery = String(query).slice(0, 100);
  const safeTag = String(tag).slice(0, 80);
  const key = JSON.stringify([safeQuery, safePage, safeSort, safeTag]);
  const cached = workshopCatalogCache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) return { ...cached.value, cached: true };
  const params = new URLSearchParams({
    appid: WORKSHOP_APP_ID,
    searchtext: safeQuery,
    p: String(safePage),
    browsesort: safeSort,
    section: 'readytouseitems',
  });
  if (safeTag) params.set('requiredtags[]', safeTag);
  const fallbackUrl = `${WORKSHOP_BROWSE_URL}?${params}`;
  try {
    const response = await fetchWorkshop(fallbackUrl, { fetchImpl }, timeoutMs);
    const parsed = parseWorkshopCatalogHtml(await response.text());
    let metadata = new Map();
    let partiallyEnriched = false;
    try {
      metadata = await workshopDetails(parsed.map((item) => item.id), {
        fetchImpl,
        timeoutMs: Math.min(timeoutMs, 3500),
      });
    } catch (_) {
      partiallyEnriched = true;
    }
    const value = {
      ok: true,
      items: parsed.map((item) => ({ ...item, ...(metadata.get(item.id) || {}) })),
      page: safePage,
      sort: safeSort,
      query: safeQuery,
      tag: safeTag,
      fallbackUrl,
      stale: false,
      partiallyEnriched,
    };
    workshopCatalogCache.set(key, { value, expiresAt: Date.now() + WORKSHOP_CACHE_TTL_MS });
    return value;
  } catch (error) {
    if (cached) return { ...cached.value, cached: true, stale: true, error: error.message };
    return { ok: true, items: [], page: safePage, sort: safeSort, query: safeQuery, tag: safeTag, fallbackUrl, stale: true, error: error.message };
  }
}

function parseWorkshopDetails(body) {
  const rows = body?.response?.publishedfiledetails;
  if (!Array.isArray(rows) || !rows.length) fail('Steam returned an unexpected Workshop response.', 502, 'workshop_malformed');
  const row = rows[0];
  if (Number(row?.result) !== 1) fail('That Workshop item is unavailable.', 404, 'workshop_not_found');
  return {
    id: String(row.publishedfileid || ''),
    title: String(row.title || 'Workshop item').slice(0, 200),
    description: String(row.description || '').slice(0, 4000),
    fileSize: Number(row.file_size) || null,
    timeUpdated: Number(row.time_updated) || null,
    creator: String(row.creator || '') || null,
    previewUrl: typeof row.preview_url === 'string' ? row.preview_url : null,
  };
}

async function resolveWorkshop(value, { fetchImpl = global.fetch, force = false, now = Date.now() } = {}) {
  const id = parseWorkshopId(value);
  const cached = workshopCache.get(id);
  if (!force && cached && now - cached.retrievedAt < WORKSHOP_CACHE_TTL_MS) return { ...cached.detail, stale: false };
  try {
    const body = new URLSearchParams({ itemcount: '1', 'publishedfileids[0]': id });
    const response = await fetchImpl(WORKSHOP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'user-agent': 'Hostkind/1.0' },
      body: body.toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) fail(`Steam Workshop metadata is unavailable (HTTP ${response.status}).`, 502, 'workshop_unavailable');
    const detail = parseWorkshopDetails(await response.json());
    workshopCache.set(id, { detail, retrievedAt: now });
    return { ...detail, stale: false };
  } catch (error) {
    if (cached && now - cached.retrievedAt <= WORKSHOP_MAX_STALE_MS) {
      return { ...cached.detail, stale: true, warning: 'Steam is unavailable; showing cached metadata.' };
    }
    if (error instanceof TerrariaModError) throw error;
    fail('Steam Workshop metadata is unavailable.', 502, 'workshop_unavailable');
  }
}

function collectTmods(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) fail('Imported content cannot contain links.', 422, 'symlink');
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.tmod') found.push(full);
    }
  };
  walk(root);
  return found;
}

function steamLibraryRoots(steamcmd, { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const roots = new Set([path.dirname(steamcmd)]);
  if (platform === 'win32') {
    if (env['ProgramFiles(x86)']) roots.add(path.join(env['ProgramFiles(x86)'], 'Steam'));
    if (env.ProgramFiles) roots.add(path.join(env.ProgramFiles, 'Steam'));
    if (env.LOCALAPPDATA) roots.add(path.join(env.LOCALAPPDATA, 'Steam'));
  } else if (platform === 'darwin') {
    roots.add(path.join(home, 'Library', 'Application Support', 'Steam'));
  } else {
    roots.add(path.join(home, '.steam', 'steam'));
    roots.add(path.join(home, '.local', 'share', 'Steam'));
    roots.add(path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'));
  }
  for (const root of [...roots]) {
    try {
      const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const match of vdf.matchAll(/"path"\s*"((?:\\.|[^"\\])*)"/gi)) {
        const value = match[1].replace(/\\\\/g, '\\').trim();
        if (value) roots.add(value);
      }
    } catch (_) { /* optional Steam client library */ }
  }
  return [...roots].map((root) => path.resolve(root));
}

function locateWorkshopContent(steamcmd, itemId, options) {
  const matches = [];
  const seen = new Set();
  for (const root of steamLibraryRoots(steamcmd, options)) {
    const candidate = path.join(root, 'steamapps', 'workshop', 'content', WORKSHOP_APP_ID, String(itemId));
    let key = candidate;
    try { key = fs.realpathSync(candidate); } catch (_) {}
    if (seen.has(key) || !fs.existsSync(candidate)) continue;
    seen.add(key);
    matches.push(candidate);
  }
  return matches;
}

function selectWorkshopTmods(contentRoots, desc) {
  const branch = String(desc?.version?.variant || '').match(/^(\d{4}\.\d{1,2})(?:\.|$)/)?.[1] || null;
  const files = contentRoots.flatMap((root) => collectTmods(root).map((file) => ({ root, file })));
  if (!files.length) return [];
  if (branch) {
    const matching = files.filter(({ root, file }) => {
      const relative = path.relative(root, file).split(path.sep);
      return relative.length > 1 && relative[0] === branch;
    });
    if (matching.length) return matching.map((entry) => entry.file);
  }
  const rootFiles = files.filter(({ root, file }) => path.dirname(file) === root);
  if (rootFiles.length) return rootFiles.map((entry) => entry.file);
  if (branch) {
    fail(`This Workshop item has no build for the server's tModLoader ${branch} branch.`, 409, 'workshop_version_unavailable');
  }
  return files.map((entry) => entry.file);
}

function scanZip(file, destination) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError) return reject(new TerrariaModError('The ZIP archive could not be read.', 422, 'archive_invalid'));
      const guard = { entries: 0, totalSize: 0, totalCompressedSize: 0, seen: new Set() };
      const outputs = [];
      const bail = (error) => {
        try { zip.close(); } catch (_) {}
        reject(error instanceof TerrariaModError ? error : new TerrariaModError(error.message, 422, error.code || 'archive_invalid'));
      };
      zip.on('error', bail);
      zip.on('entry', (entry) => {
        let normalized;
        try {
          if (/\/$/.test(entry.fileName)) return zip.readEntry();
          normalized = checkEntry(entry, guard, { maxEntries: 5000, maxTotalSize: MAX_MOD_BYTES });
          if (path.extname(normalized).toLowerCase() !== '.tmod') return zip.readEntry();
        } catch (error) { return bail(error instanceof ArchiveError ? error : new TerrariaModError(error.message)); }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return bail(streamError);
          const target = path.join(destination, `${outputs.length}-${path.basename(normalized)}`);
          const output = fs.createWriteStream(target, { flags: 'wx' });
          stream.pipe(output);
          output.on('error', bail);
          output.on('finish', () => { outputs.push(target); zip.readEntry(); });
        });
      });
      zip.on('end', () => {
        try { finalize(guard, { maxEntries: 5000, maxTotalSize: MAX_MOD_BYTES }); }
        catch (error) { return bail(error); }
        if (!outputs.length) return reject(new TerrariaModError('The ZIP contains no .tmod files.', 422, 'mods_missing'));
        resolve(outputs);
      });
      zip.readEntry();
    });
  });
}

/*
 * multer writes every upload under os.tmpdir() with a server-generated name;
 * the uploaded path is request-adjacent, so re-assert it inside the temporary
 * root before any fs call. realpathSync on both sides keeps the check sound
 * when the temp directory is a symlink (macOS /var -> /private/var). The
 * resolve + startsWith guard is the sanitizer CodeQL js/path-injection
 * recognizes, with the use in the guarded branch.
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

async function previewImport({ desc, actorId, manager, uploadPath, originalName, source = null }) {
  requireOffline(manager);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-terraria-import-'));
  const staged = stagedUploadPath(uploadPath);
  if (!staged) fail('The uploaded file is no longer available.', 400, 'upload_missing');
  let files;
  try {
    if (path.extname(originalName || staged).toLowerCase() === '.zip') files = await scanZip(staged, staging);
    else {
      const target = path.join(staging, path.basename(originalName || 'upload.tmod'));
      fs.copyFileSync(staged, target);
      files = [target];
    }
    const current = inventory(desc);
    const incoming = files.map((file) => ({ ...parseTmod(file), stagedFile: file, file: path.basename(file).replace(/^\d+-/, '') }));
    const duplicate = incoming.find((mod, index) => incoming.some((candidate, other) => other !== index && candidate.internalName === mod.internalName));
    if (duplicate) fail(`The import contains more than one ${duplicate.internalName} mod.`, 409, 'import_duplicate');
    const plan = incoming.map((mod) => {
      const installed = current.mods.find((item) => item.internalName === mod.internalName);
      return { ...mod, stagedFile: undefined, action: installed ? 'replace' : 'add', installedVersion: installed?.version || null };
    });
    const token = crypto.randomUUID();
    previews.set(token, {
      token, action: 'import', serverId: desc.id, actorId, fingerprint: current.fingerprint,
      staging, incoming, plan, source, expiresAt: Date.now() + PREVIEW_TTL_MS,
    });
    return { token, plan, requiresOffline: true, restartRequired: true, expiresAt: Date.now() + PREVIEW_TTL_MS };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function applyImport({ desc, actorId, manager, token, replace = false }) {
  requireOffline(manager);
  const preview = previews.get(String(token || ''));
  if (!preview || preview.action !== 'import' || preview.expiresAt < Date.now()) fail('That import preview expired.', 409, 'preview_expired');
  if (preview.actorId !== actorId || preview.serverId !== desc.id) fail('That preview does not belong to this import.', 403, 'preview_mismatch');
  const state = inventory(desc);
  if (state.fingerprint !== preview.fingerprint) fail('The installed mods changed after the preview.', 409, 'inventory_changed');
  if (!replace && preview.plan.some((item) => item.action === 'replace')) fail('Confirm that existing mod versions may be replaced.', 409, 'replace_confirmation_required');
  const snapshot = snapshotMods(desc, 'Before local mod import');
  const mods = resolveModsDir(desc);
  fs.mkdirSync(mods.abs, { recursive: true });
  try {
    for (const incoming of preview.incoming) {
      const prior = state.mods.find((item) => item.internalName === incoming.internalName);
      const destination = path.join(mods.abs, prior?.file || incoming.file);
      const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
      fs.copyFileSync(incoming.stagedFile, temporary);
      parseTmod(temporary);
      fs.renameSync(temporary, destination);
    }
    const sources = readSources(desc);
    for (const incoming of preview.incoming) {
      sources.mods[incoming.internalName] = preview.source || { provider: 'local', importedAt: new Date().toISOString() };
    }
    writeSources(desc, sources);
  } finally {
    previews.delete(token);
    fs.rmSync(preview.staging, { recursive: true, force: true });
  }
  return { ok: true, snapshotId: snapshot.id, installed: preview.plan, restartRequired: true };
}

async function downloadWorkshop({ desc, actorId, manager, value, cacheDir, download, fetchImpl }) {
  requireOffline(manager);
  const detail = await resolveWorkshop(value, { fetchImpl, force: true });
  const steamcmd = await ensureSteamCmd(cacheDir, download);
  try {
    await runSteamCmd(steamcmd, [
      '+login', 'anonymous', '+workshop_download_item', WORKSHOP_APP_ID, detail.id, 'validate', '+quit',
    ], { cwd: path.dirname(steamcmd) });
  } catch (_) {
    fail('Steam refused the anonymous Workshop download. Use local import with the .tmod file instead.', 409, 'workshop_anonymous_refused');
  }
  const content = locateWorkshopContent(steamcmd, detail.id);
  const files = selectWorkshopTmods(content, desc);
  if (!files.length) fail('Steam downloaded the item, but no .tmod file was found. Use local import instead.', 422, 'workshop_mod_missing');
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-terraria-workshop-'));
  const archive = path.join(staging, 'workshop.zip');
  fs.rmSync(archive, { force: true });
  const copied = files.map((file, index) => {
    const target = path.join(staging, `${index}-${path.basename(file)}`);
    fs.copyFileSync(file, target);
    return target;
  });
  const current = inventory(desc);
  const incoming = copied.map((file) => ({ ...parseTmod(file), stagedFile: file, file: path.basename(file).replace(/^\d+-/, '') }));
  const plan = incoming.map((mod) => {
    const installed = current.mods.find((item) => item.internalName === mod.internalName);
    return { ...mod, stagedFile: undefined, action: installed ? 'replace' : 'add', installedVersion: installed?.version || null };
  });
  const token = crypto.randomUUID();
  previews.set(token, {
    token, action: 'import', serverId: desc.id, actorId, fingerprint: current.fingerprint,
    staging, incoming, plan,
    source: { provider: 'workshop', workshopId: detail.id, workshopUpdatedAt: detail.timeUpdated, importedAt: new Date().toISOString() },
    expiresAt: Date.now() + PREVIEW_TTL_MS,
  });
  return { token, detail, plan, requiresOffline: true, restartRequired: true };
}

async function updates(desc, options = {}) {
  const state = inventory(desc);
  const rows = [];
  for (const mod of state.mods) {
    if (!mod.workshopId) {
      rows.push({ internalName: mod.internalName, displayName: mod.displayName, state: 'manual' });
      continue;
    }
    try {
      const detail = await resolveWorkshop(mod.workshopId, options);
      rows.push({
        internalName: mod.internalName, displayName: mod.displayName, workshopId: mod.workshopId,
        state: detail.timeUpdated > Number(mod.workshopUpdatedAt || 0) ? 'update-ready' : 'current',
        detail,
      });
    } catch (error) {
      rows.push({ internalName: mod.internalName, displayName: mod.displayName, workshopId: mod.workshopId, state: 'unavailable', error: error.message });
    }
  }
  return { updates: rows, checkedAt: new Date().toISOString() };
}

function listPacks(desc) {
  const store = readPacks(desc);
  const current = inventory(desc);
  return store.packs.map((pack) => ({
    ...pack,
    active: pack.mods.length === current.mods.length && pack.mods.every((item) => {
      const found = current.mods.find((mod) => mod.internalName === item.internalName);
      return found && found.version === item.version && found.enabled === item.enabled;
    }),
    modCount: pack.mods.length,
  }));
}

function capturePack(desc, name) {
  const clean = String(name || '').trim().slice(0, 80);
  if (!clean) fail('Enter a modpack name.', 400, 'pack_name_required');
  const state = inventory(desc);
  const store = readPacks(desc);
  const pack = {
    id: crypto.randomUUID(), name: clean, createdAt: new Date().toISOString(),
    mods: state.mods.map((mod) => ({
      internalName: mod.internalName, displayName: mod.displayName, version: mod.version,
      workshopId: mod.workshopId || null, enabled: mod.enabled,
    })),
  };
  store.packs.push(pack);
  writePacks(desc, store);
  return pack;
}

function importPack(desc, input) {
  let document;
  try { document = typeof input === 'string' ? JSON.parse(input) : input; }
  catch { fail('The modpack JSON is invalid.', 422, 'pack_invalid'); }
  if (document?.format !== 'fleetdeck-terraria-modpack' || document.version !== 1 || !document.pack || !Array.isArray(document.pack.mods)) {
    fail('This modpack format is not supported.', 422, 'pack_version_unsupported');
  }
  const pack = {
    id: crypto.randomUUID(), name: String(document.pack.name || 'Imported modpack').slice(0, 80),
    createdAt: new Date().toISOString(),
    mods: document.pack.mods.map((mod) => ({
      internalName: String(mod.internalName || '').slice(0, 256),
      displayName: String(mod.displayName || mod.internalName || '').slice(0, 256),
      version: String(mod.version || '').slice(0, 128),
      workshopId: mod.workshopId ? parseWorkshopId(mod.workshopId) : null,
      enabled: mod.enabled === true,
    })),
  };
  if (pack.mods.some((mod) => !mod.internalName || !mod.version)) fail('The modpack contains an invalid mod entry.', 422, 'pack_invalid');
  const store = readPacks(desc);
  store.packs.push(pack);
  writePacks(desc, store);
  return pack;
}

function exportPack(desc, id) {
  const pack = readPacks(desc).packs.find((item) => item.id === id);
  if (!pack) fail('That modpack was not found.', 404, 'pack_not_found');
  return { format: 'fleetdeck-terraria-modpack', version: 1, exportedAt: new Date().toISOString(), pack: { name: pack.name, mods: pack.mods } };
}

function deletePack(desc, id) {
  const store = readPacks(desc);
  const next = store.packs.filter((item) => item.id !== id);
  if (next.length === store.packs.length) fail('That modpack was not found.', 404, 'pack_not_found');
  writePacks(desc, { ...store, packs: next });
  return { ok: true };
}

function previewPack({ desc, actorId, manager, id }) {
  requireOffline(manager);
  const pack = readPacks(desc).packs.find((item) => item.id === id);
  if (!pack) fail('That modpack was not found.', 404, 'pack_not_found');
  const state = inventory(desc);
  const missing = pack.mods.filter((wanted) => !state.mods.some((mod) => mod.internalName === wanted.internalName && mod.version === wanted.version));
  const plan = {
    add: missing,
    remove: state.mods.filter((mod) => !pack.mods.some((wanted) => wanted.internalName === mod.internalName)),
    enable: pack.mods.filter((wanted) => wanted.enabled && !state.enabled.includes(wanted.internalName) && !missing.includes(wanted)),
    disable: pack.mods.filter((wanted) => !wanted.enabled && state.enabled.includes(wanted.internalName)),
  };
  const token = crypto.randomUUID();
  previews.set(token, {
    token, action: 'pack-apply', packId: id, serverId: desc.id, actorId,
    fingerprint: state.fingerprint, plan, expiresAt: Date.now() + PREVIEW_TTL_MS,
  });
  return { token, pack: { id: pack.id, name: pack.name }, plan, blocked: missing.length > 0, requiresOffline: true, restartRequired: true };
}

function applyPack({ desc, actorId, manager, token, servers = [] }) {
  requireOffline(manager);
  const preview = previews.get(String(token || ''));
  if (!preview || preview.action !== 'pack-apply' || preview.expiresAt < Date.now()) fail('That modpack preview expired.', 409, 'preview_expired');
  if (preview.actorId !== actorId || preview.serverId !== desc.id) fail('That preview does not belong to this modpack.', 403, 'preview_mismatch');
  if (preview.plan.add.length) {
    fail(`Install the missing mods first: ${preview.plan.add.map((mod) => mod.displayName).join(', ')}.`, 409, 'pack_missing_mods');
  }
  const state = inventory(desc);
  if (state.fingerprint !== preview.fingerprint) fail('The installed mods changed after the preview.', 409, 'inventory_changed');
  const snapshot = snapshotMods(desc, `Before applying modpack ${preview.packId}`);
  const removed = [];
  try {
    for (const mod of preview.plan.remove) {
      removed.push(trash.moveToTrash({
        target: path.join(resolveModsDir(desc).abs, mod.file), kind: 'terraria-mod',
        serverId: desc.id, label: mod.displayName, reason: 'modpack', actorId,
        scope: 'item', servers, selfId: desc.id,
      }));
    }
    const pack = readPacks(desc).packs.find((item) => item.id === preview.packId);
    writeEnabled(desc, pack.mods.filter((mod) => mod.enabled).map((mod) => mod.internalName));
  } catch (error) {
    fail(`The modpack could not be applied. Restore snapshot ${snapshot.id} before continuing.`, 500, 'recovery_required');
  }
  previews.delete(token);
  return { ok: true, snapshotId: snapshot.id, removed, restartRequired: true };
}

function versionParts(value) {
  return String(value || '').match(/\d+/g)?.map(Number) || [];
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
  }
  return 0;
}

function diagnostics(desc, known = null) {
  const state = known || inventory(desc);
  const issues = [];
  const byName = new Map();
  for (const mod of state.mods) {
    const group = byName.get(mod.internalName) || [];
    group.push(mod);
    byName.set(mod.internalName, group);
  }
  const installedTml = desc?.version?.variant || desc?.terrariaVersion?.variant || null;
  for (const [name, group] of byName) {
    if (group.length > 1) issues.push({
      code: 'duplicate_internal_name', severity: 'error', mod: name,
      detail: `${group.length} files declare the internal name ${name}.`,
      suggestion: 'Keep one version of this mod and quarantine the duplicates.',
    });
  }
  for (const mod of state.mods) {
    if (installedTml && mod.tmlVersion && compareVersions(mod.tmlVersion, installedTml) > 0) issues.push({
      code: 'tml_too_old', severity: 'error', mod: mod.internalName,
      detail: `${mod.displayName} requires tModLoader ${mod.tmlVersion}, but this server reports ${installedTml}.`,
      suggestion: 'Update tModLoader or install a compatible version of the mod.',
    });
    for (const dependency of mod.dependencies) {
      const found = byName.get(dependency.internalName)?.[0];
      if (!found) issues.push({
        code: 'missing_dependency', severity: mod.enabled ? 'error' : 'warning', mod: mod.internalName,
        detail: `${mod.displayName} requires ${dependency.internalName}${dependency.version ? ` ${dependency.version}` : ''}, which is not installed.`,
        suggestion: `Install ${dependency.internalName} before enabling this mod.`,
      });
      else if (dependency.version && compareVersions(found.version, dependency.version) < 0) issues.push({
        code: 'dependency_version_conflict', severity: 'error', mod: mod.internalName,
        detail: `${mod.displayName} requires ${dependency.internalName} ${dependency.version}, but ${found.version} is installed.`,
        suggestion: `Install a compatible version of ${dependency.internalName}.`,
      });
    }
  }
  for (const name of state.enabled) {
    if (!byName.has(name)) issues.push({
      code: 'enabled_missing', severity: 'error', mod: name,
      detail: `${name} is enabled, but no matching .tmod file is installed.`,
      suggestion: 'Install the missing mod or remove its entry from enabled.json.',
    });
  }
  for (const item of state.unreadable) issues.push({
    code: 'unreadable_mod', severity: 'error', mod: item.file,
    detail: `${item.file} could not be read: ${item.reason}`,
    suggestion: 'Replace or quarantine this file before starting the server.',
  });
  return { issues, scannedAt: state.scannedAt };
}

function requireOffline(manager) {
  if (!manager || manager.status !== 'offline') fail('Stop the server before changing tModLoader mods.', 409, 'server_online');
}

function findMod(desc, name) {
  const state = inventory(desc);
  const matches = state.mods.filter((mod) => mod.internalName === name);
  if (!matches.length) fail('That mod is not installed.', 404, 'mod_not_found');
  if (matches.length > 1) fail('That mod name is duplicated. Quarantine a duplicate before changing it.', 409, 'duplicate_internal_name');
  return { state, mod: matches[0] };
}

function makePreview({ desc, actorId, action, name, manager }) {
  requireOffline(manager);
  const { state, mod } = findMod(desc, name);
  if (action === 'enable') {
    const missing = mod.dependencies.filter((dep) => !state.mods.some((candidate) => candidate.internalName === dep.internalName));
    if (missing.length) fail(`Install the missing dependencies first: ${missing.map((dep) => dep.internalName).join(', ')}.`, 409, 'missing_dependencies');
  }
  const token = crypto.randomUUID();
  const preview = {
    token, serverId: desc.id, actorId, action, internalName: mod.internalName,
    displayName: mod.displayName, file: mod.file, enabled: mod.enabled,
    fingerprint: state.fingerprint, expiresAt: Date.now() + PREVIEW_TTL_MS,
    requiresOffline: true, restartRequired: true,
  };
  previews.set(token, preview);
  return { ...preview, actorId: undefined, fingerprint: undefined };
}

function consumePreview({ desc, actorId, token, action, name, manager }) {
  requireOffline(manager);
  const preview = previews.get(String(token || ''));
  if (!preview || preview.expiresAt < Date.now()) fail('That preview expired. Review the change again.', 409, 'preview_expired');
  if (preview.actorId !== actorId || preview.serverId !== desc.id || preview.action !== action || preview.internalName !== name) {
    fail('That preview does not belong to this change.', 403, 'preview_mismatch');
  }
  const state = inventory(desc);
  if (state.fingerprint !== preview.fingerprint) fail('The installed mods changed after the preview. Review the change again.', 409, 'inventory_changed');
  previews.delete(token);
  return { preview, state };
}

function snapshotMods(desc, reason) {
  const mods = resolveModsDir(desc);
  fs.mkdirSync(mods.abs, { recursive: true });
  const snapshot = snapshots.take({
    serverId: desc.id,
    sourceDir: mods.root,
    scope: [mods.rel.split('/').join(path.sep)],
    kind: 'terraria-mod',
    reason,
    retention: 10,
  });
  if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');
  return snapshot;
}

function writeEnabled(desc, values) {
  const mods = resolveModsDir(desc);
  const file = path.join(mods.abs, 'enabled.json');
  atomicWrite(file, `${JSON.stringify([...new Set(values)], null, 2)}\n`);
  const parsed = readEnabled(mods);
  if (JSON.stringify(parsed.values) !== JSON.stringify([...new Set(values)])) fail('enabled.json could not be verified after writing.', 500, 'enabled_verify_failed');
}

function setEnabled({ desc, actorId, token, name, enabled, manager }) {
  const action = enabled ? 'enable' : 'disable';
  const { state } = consumePreview({ desc, actorId, token, action, name, manager });
  const current = state.enabled.includes(name);
  if (current === enabled) return { ok: true, changed: false, restartRequired: false };
  const snapshot = snapshotMods(desc, `Before ${action} of ${name}`);
  const next = enabled ? [...state.enabled, name] : state.enabled.filter((entry) => entry !== name);
  writeEnabled(desc, next);
  return { ok: true, changed: true, snapshotId: snapshot.id, restartRequired: true };
}

function remove({ desc, actorId, token, name, manager, servers = [] }) {
  const { state, preview } = consumePreview({ desc, actorId, token, action: 'remove', name, manager });
  const snapshot = snapshotMods(desc, `Before removal of ${name}`);
  if (state.enabled.includes(name)) writeEnabled(desc, state.enabled.filter((entry) => entry !== name));
  const target = path.join(resolveModsDir(desc).abs, preview.file);
  let entry;
  try {
    entry = trash.moveToTrash({
      target, kind: 'terraria-mod', serverId: desc.id, label: preview.displayName,
      reason: 'removed', actorId, scope: 'item', servers, selfId: desc.id,
    });
  } catch (error) {
    if (state.enabled.includes(name)) {
      try { writeEnabled(desc, state.enabled); } catch (_) {
        fail('The mod could not be quarantined and enabled.json could not be restored. Recovery is required.', 500, 'recovery_required');
      }
    }
    throw error;
  }
  return { ok: true, trash: entry, snapshotId: snapshot.id, restartRequired: true };
}

function listTrash(desc) {
  return trash.list({ serverId: desc.id, kind: 'terraria-mod' });
}

function restore({ desc, manager, trashId, servers = [] }) {
  requireOffline(manager);
  const entry = trash.get(trashId);
  if (!entry || entry.serverId !== desc.id || entry.kind !== 'terraria-mod') fail('That quarantined mod was not found.', 404, 'trash_not_found');
  const restored = trash.restore(trashId, { servers: servers.filter((server) => server.id !== desc.id) });
  inventory(desc);
  return { ok: true, ...restored, restartRequired: true };
}

function resetPreviews() {
  previews.clear();
  workshopCatalogCache.clear();
}

module.exports = {
  INVENTORY_VERSION,
  TerrariaModError,
  resolveModsDir,
  inventoryPath,
  parseTmod,
  readEnabled,
  inventory,
  diagnostics,
  compareVersions,
  makePreview,
  setEnabled,
  remove,
  listTrash,
  restore,
  parseWorkshopId,
  parseWorkshopCatalogHtml,
  workshopCatalog,
  parseWorkshopDetails,
  steamLibraryRoots,
  locateWorkshopContent,
  selectWorkshopTmods,
  resolveWorkshop,
  previewImport,
  applyImport,
  downloadWorkshop,
  updates,
  listPacks,
  capturePack,
  importPack,
  exportPack,
  deletePack,
  previewPack,
  applyPack,
  resetPreviews,
};
