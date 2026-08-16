'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yauzl = require('yauzl');
const { checkEntry, finalize, ArchiveError } = require('./archiveGuard.cjs');
const { safeResolve } = require('./files.cjs');
const operations = require('./operations.cjs');
const snapshots = require('./snapshots.cjs');

const APP_ID = '1623730';
const INVENTORY_VERSION = 2;
const MAX_ENTRIES = 4000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const PREVIEW_TTL_MS = 15 * 60_000;
const CATALOG_TTL_MS = 10 * 60_000;
const DETAIL_ENDPOINT = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/';
const BROWSE_URL = 'https://steamcommunity.com/workshop/browse/';
const TYPES = new Set(['UE4SS', 'Lua', 'PalSchema', 'LogicMods', 'Paks']);
const previews = new Map();
const catalogCache = new Map();
const detailCache = new Map();

class WorkshopError extends Error {
  constructor(message, status = 400, code = 'workshop_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(message, status, code) {
  throw new WorkshopError(message, status, code);
}

function stateDir(server) {
  return path.join(server.dir, '.fleetdeck', 'palworld-workshop');
}

function inventoryPath(server) {
  return path.join(stateDir(server), 'inventory.v2.json');
}

function readInventory(server) {
  try {
    const parsed = JSON.parse(fs.readFileSync(inventoryPath(server), 'utf8'));
    if (parsed?.version !== INVENTORY_VERSION || !Array.isArray(parsed.packages)) {
      return { version: INVENTORY_VERSION, packages: [], readable: false };
    }
    return { ...parsed, readable: true };
  } catch (error) {
    if (error.code === 'ENOENT') return { version: INVENTORY_VERSION, packages: [], readable: true };
    return { version: INVENTORY_VERSION, packages: [], readable: false };
  }
}

function writeInventory(server, inventory) {
  const dir = stateDir(server);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = path.join(dir, `.inventory.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify({
    format: 'fleetdeck-palworld-workshop',
    version: INVENTORY_VERSION,
    packages: inventory.packages,
  }, null, 2));
  fs.renameSync(temporary, inventoryPath(server));
}

function parseVdfLibraries(text, steamRoot) {
  const roots = new Set([path.resolve(steamRoot)]);
  for (const match of String(text || '').matchAll(/"path"\s*"((?:\\.|[^"\\])*)"/gi)) {
    const value = match[1].replace(/\\\\/g, '\\').trim();
    if (value) roots.add(path.resolve(value));
  }
  return [...roots];
}

function standardSteamRoots(platform = process.platform, env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (platform === 'win32') {
    return [
      env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Steam'),
      env.ProgramFiles && path.join(env.ProgramFiles, 'Steam'),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Steam'),
    ].filter(Boolean);
  }
  if (platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Steam')];
  return [
    path.join(home, '.steam', 'steam'),
    path.join(home, '.local', 'share', 'Steam'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
  ];
}

function discoverLibraries({ platform = process.platform, env = process.env, manualPaths = [], serverDir = null } = {}) {
  const libraries = [];
  const seen = new Set();
  const roots = [...standardSteamRoots(platform, env), ...manualPaths];
  if (serverDir) roots.push(serverDir);
  for (const root of roots) {
    if (!root) continue;
    let libraryRoots = [path.resolve(root)];
    const vdf = path.join(root, 'steamapps', 'libraryfolders.vdf');
    try { libraryRoots = parseVdfLibraries(fs.readFileSync(vdf, 'utf8'), root); } catch (_) { /* optional client */ }
    for (const libraryRoot of libraryRoots) {
      const workshopPath = path.join(libraryRoot, 'steamapps', 'workshop', 'content', APP_ID);
      const key = process.platform === 'win32' ? workshopPath.toLowerCase() : workshopPath;
      if (seen.has(key)) continue;
      seen.add(key);
      const isManual = manualPaths.some((item) => path.resolve(item) === libraryRoot);
      const isServer = serverDir != null && path.resolve(serverDir) === libraryRoot;
      libraries.push({
        root: libraryRoot,
        workshopPath,
        exists: fs.existsSync(workshopPath),
        writable: false,
        source: isManual ? 'manual' : isServer ? 'server' : 'detected',
      });
    }
  }
  return libraries;
}

function sourceConfig(server) {
  const file = path.join(stateDir(server), 'sources.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { manualPaths: Array.isArray(parsed.manualPaths) ? parsed.manualPaths.filter((item) => typeof item === 'string') : [] };
  } catch (_) {
    return { manualPaths: [] };
  }
}

function saveSources(server, input) {
  const manualPaths = [...new Set((input?.manualPaths || []).map((item) => path.resolve(String(item).trim())).filter(Boolean))];
  if (manualPaths.length > 20) fail('No more than 20 Steam library paths can be configured.', 400, 'too_many_sources');
  fs.mkdirSync(stateDir(server), { recursive: true });
  const file = path.join(stateDir(server), 'sources.json');
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, manualPaths }, null, 2));
  fs.renameSync(temporary, file);
  return { manualPaths, libraries: discoverLibraries({ manualPaths, serverDir: server.dir }) };
}

function cachedPackages(server) {
  const config = sourceConfig(server);
  const found = [];
  for (const library of discoverLibraries({ manualPaths: config.manualPaths, serverDir: server.dir })) {
    if (!library.exists) continue;
    for (const entry of fs.readdirSync(library.workshopPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const packagePath = path.join(library.workshopPath, entry.name);
      if (fs.existsSync(path.join(packagePath, 'Info.json'))) {
        found.push({ workshopId: entry.name, path: packagePath, library: library.root, source: library.source, modifiedAt: fs.statSync(packagePath).mtimeMs });
      }
    }
  }
  return found;
}

function parseCatalogHtml(html) {
  const items = [];
  const seen = new Set();
  const source = String(html || '');
  const itemPattern = /sharedfiles\/filedetails\/\?[^"'<>]*\bid=(\d+)|data-publishedfileid=["'](\d+)["']/gi;
  for (const match of source.matchAll(itemPattern)) {
    const id = match[1] || match[2];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const nearby = source.slice(match.index, match.index + 2000);
    const rawTitle = nearby.match(/workshopItemTitle[^>]*>([^<]+)/i)?.[1]
      || nearby.match(/<img[^>]+\balt=["']([^"']+)["']/i)?.[1]
      || '';
    const rawPreviewUrl = nearby.match(/<img[^>]+\bsrc=["']([^"']+)["']/i)?.[1] || '';
    items.push({
      workshopId: id,
      title: decodeHtml(rawTitle.trim()),
      previewUrl: rawPreviewUrl ? decodeHtml(rawPreviewUrl) : null,
      url: officialUrl(id),
    });
  }
  return items;
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

function officialUrl(id) {
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${encodeURIComponent(id)}`;
}

async function fetchJson(url, options, timeoutMs) {
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

async function details(ids, { fetchImpl = global.fetch, timeoutMs = 8000 } = {}) {
  if (!ids.length) return new Map();
  const now = Date.now();
  const answer = new Map();
  const missing = [];
  for (const id of ids) {
    const cached = detailCache.get(String(id));
    if (cached && cached.expiresAt > now) answer.set(String(id), cached.value);
    else missing.push(String(id));
  }
  if (!missing.length) return answer;
  const body = new URLSearchParams({ itemcount: String(missing.length) });
  missing.forEach((id, index) => body.set(`publishedfileids[${index}]`, id));
  const response = await fetchJson(DETAIL_ENDPOINT, { fetchImpl, method: 'POST', body }, timeoutMs);
  const json = await response.json();
  const rows = json?.response?.publishedfiledetails;
  if (!Array.isArray(rows)) fail('Steam returned an invalid Workshop response.', 502, 'workshop_malformed');
  for (const row of rows) {
    const id = String(row.publishedfileid);
    const value = {
      ok: row.result === 1, workshopId: id, title: row.title || '',
      description: row.description || '', previewUrl: row.preview_url || null,
      authorId: row.creator || null, updatedAt: Number(row.time_updated) || null,
      subscriptions: Number(row.subscriptions) || null,
      tags: Array.isArray(row.tags) ? row.tags.map((tag) => tag.tag).filter(Boolean) : [],
      url: officialUrl(id),
    };
    answer.set(id, value);
    detailCache.set(id, { value, expiresAt: now + CATALOG_TTL_MS });
  }
  return answer;
}

async function catalog({ query = '', page = 1, sort = 'trend', tag = '', fetchImpl = global.fetch, timeoutMs = 8000, force = false } = {}) {
  const safePage = Math.max(1, Math.min(1000, Number(page) || 1));
  const sortMap = { trend: 'trend', recent: 'mostrecent', subscribed: 'totaluniquesubscribers', updated: 'lastupdated' };
  const safeSort = sortMap[sort] || sortMap.trend;
  const key = JSON.stringify([query, safePage, safeSort, tag]);
  const cached = catalogCache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) return { ...cached.value, cached: true };
  const params = new URLSearchParams({ appid: APP_ID, searchtext: String(query).slice(0, 100), p: String(safePage), browsesort: safeSort, section: 'readytouseitems' });
  if (tag) params.set('requiredtags[]', String(tag).slice(0, 80));
  try {
    const response = await fetchJson(`${BROWSE_URL}?${params}`, { fetchImpl }, timeoutMs);
    const html = await response.text();
    const parsed = parseCatalogHtml(html);
    let metadata = new Map();
    let enrichmentError = null;
    try {
      metadata = await details(parsed.map((item) => item.workshopId), {
        fetchImpl,
        timeoutMs: Math.min(timeoutMs, 3500),
      });
    } catch (error) {
      enrichmentError = error;
    }
    const items = parsed.map((item) => ({ ...item, ...(metadata.get(item.workshopId) || {}) }));
    const value = {
      ok: true,
      items,
      page: safePage,
      sort: safeSort,
      query,
      tag,
      fallbackUrl: `${BROWSE_URL}?${params}`,
      stale: false,
      partiallyEnriched: !!enrichmentError,
    };
    catalogCache.set(key, { value, expiresAt: Date.now() + CATALOG_TTL_MS });
    return value;
  } catch (error) {
    if (cached) return { ...cached.value, cached: true, stale: true, error: error.message };
    return { ok: true, items: [], page: safePage, sort: safeSort, query, tag, fallbackUrl: `${BROWSE_URL}?${params}`, stale: true, error: error.message };
  }
}

function normalizeInfo(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Info.json must contain an object.', 422, 'invalid_info');
  const declaredApp = raw.AppId ?? raw.AppID ?? raw.SteamAppId ?? raw.SteamAppID;
  if (declaredApp != null && String(declaredApp) !== APP_ID) fail('This package belongs to another Steam app.', 422, 'wrong_steam_app');
  const packageName = String(raw.PackageName || '').trim();
  const version = String(raw.Version ?? '').trim();
  const rules = raw.InstallRule;
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(packageName)) fail('Info.json has an invalid PackageName.', 422, 'invalid_package_name');
  if (!version || version.length > 128) fail('Info.json has an invalid Version.', 422, 'invalid_version');
  if (!Array.isArray(rules) || !rules.length) fail('Info.json must contain InstallRule entries.', 422, 'missing_install_rules');
  const serverRules = rules.filter((rule) => rule?.IsServer === true).map((rule) => {
    if (!TYPES.has(rule.Type)) fail(`Info.json uses unsupported install type: ${rule.Type || 'unknown'}.`, 422, 'invalid_install_type');
    if (!Array.isArray(rule.Targets) || !rule.Targets.length) fail('Every server install rule must contain Targets.', 422, 'invalid_targets');
    const targets = rule.Targets.map((target) => {
      const value = String(target || '').replace(/\\/g, '/');
      if (!value || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').includes('..')) {
        fail('Info.json contains an unsafe install target.', 422, 'invalid_targets');
      }
      return value.replace(/^\.\//, '');
    });
    return { type: rule.Type, targets };
  });
  if (!serverRules.length) fail('This package has no server-compatible install rule.', 422, 'missing_server_rule');
  const dependencies = (Array.isArray(raw.Dependencies) ? raw.Dependencies : Array.isArray(raw.Dependency) ? raw.Dependency : [])
    .map((value) => typeof value === 'string' ? value : value?.PackageName)
    .map((value) => String(value || '').trim()).filter(Boolean);
  return {
    packageName,
    version,
    minRevision: Number.isFinite(Number(raw.MinRevision)) ? Number(raw.MinRevision) : null,
    dependencies: [...new Set(dependencies)],
    serverRules,
    debugMode: raw.DebugMode === true,
  };
}

function scanZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(new WorkshopError('The package ZIP could not be read.', 422, 'invalid_archive'));
      const state = { entries: 0, totalSize: 0, totalCompressedSize: 0, seen: new Set() };
      const entries = [];
      let infoEntry = null;
      const bail = (err) => { try { zip.close(); } catch (_) {} reject(err instanceof WorkshopError ? err : new WorkshopError(err.message, 422, err.code || 'invalid_archive')); };
      zip.on('error', bail);
      zip.on('entry', (entry) => {
        try {
          const checked = checkEntry({
            name: entry.fileName, externalAttributes: entry.externalFileAttributes,
            uncompressedSize: entry.uncompressedSize, compressedSize: entry.compressedSize,
          }, state, { maxEntries: MAX_ENTRIES, maxTotalSize: MAX_BYTES });
          if (!checked.directory) {
            entries.push({ path: checked.path, bytes: entry.uncompressedSize });
            if (checked.path === 'Info.json') infoEntry = entry;
          }
          zip.readEntry();
        } catch (err) { bail(err instanceof ArchiveError ? new WorkshopError(err.message, 422, err.code) : err); }
      });
      zip.on('end', () => {
        try { finalize(state, { maxEntries: MAX_ENTRIES, maxTotalSize: MAX_BYTES }); } catch (err) { return bail(err); }
        if (!infoEntry) return reject(new WorkshopError('The package must contain Info.json at the ZIP root.', 422, 'info_required'));
        yauzl.open(file, { lazyEntries: true }, (openError, reader) => {
          if (openError) return reject(openError);
          reader.readEntry();
          reader.on('entry', (entry) => {
            if (entry.fileName !== 'Info.json') return reader.readEntry();
            reader.openReadStream(entry, (streamError, stream) => {
              if (streamError) return reject(streamError);
              const chunks = [];
              stream.on('data', (chunk) => chunks.push(chunk));
              stream.on('end', () => {
                try { resolve({ entries, info: normalizeInfo(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }); }
                catch (err) { reject(err instanceof WorkshopError ? err : new WorkshopError('Info.json is not valid JSON.', 422, 'invalid_info')); }
                reader.close();
              });
            });
          });
        });
      });
      zip.readEntry();
    });
  });
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail('Workshop packages containing links are not supported.', 422, 'symlink');
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function hashDirectory(root, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail('Workshop packages containing links are not supported.', 422, 'symlink');
    const absolute = path.join(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...hashDirectory(absolute, relative));
    else if (entry.isFile()) files.push({
      path: relative,
      bytes: fs.statSync(absolute).size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
    });
  }
  return files;
}

function manifestRevision(files) {
  return crypto.createHash('sha256').update(JSON.stringify(files.map((file) => [file.path, file.bytes, file.sha256 || null]))).digest('hex');
}

function packageFromSource(server, workshopId) {
  const source = cachedPackages(server).find((item) => item.workshopId === String(workshopId));
  if (!source) fail('Waiting for Steam to download this Workshop item.', 409, 'waiting_for_steam');
  let info;
  try { info = normalizeInfo(JSON.parse(fs.readFileSync(path.join(source.path, 'Info.json'), 'utf8'))); }
  catch (error) { if (error instanceof WorkshopError) throw error; fail('The cached Info.json is invalid.', 422, 'invalid_info'); }
  return { ...source, info, files: hashDirectory(source.path) };
}

function activeSettings(server, packageNames) {
  const file = safeResolve(server.dir, 'Mods/PalModSettings.ini');
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch (_) {}
  const kept = lines.filter((line) => !/^\s*(?:bGlobalEnableMod|WorkshopRootDir|ActiveModList)\s*=/i.test(line));
  let section = kept.findIndex((line) => /^\s*\[PalModSettings\]\s*$/i.test(line));
  if (section < 0) { kept.push('[PalModSettings]'); section = kept.length - 1; }
  const insert = ['bGlobalEnableMod=True', ...packageNames.map((name) => `ActiveModList=${name}`)];
  kept.splice(section + 1, 0, ...insert);
  return { file, content: `${kept.join(os.EOL).replace(/(?:\r?\n)*$/, '')}${os.EOL}` };
}

function requireOffline(manager) {
  if (manager?.status !== 'offline') fail('Stop Palworld before changing official mods.', 409, 'server_online');
}

function updateSettingsAndInventory(server, packages) {
  const settings = activeSettings(server, packages.filter((pkg) => pkg.enabled).map((pkg) => pkg.packageName));
  fs.mkdirSync(path.dirname(settings.file), { recursive: true });
  const temporary = `${settings.file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, settings.content);
  fs.renameSync(temporary, settings.file);
  writeInventory(server, { packages });
}

function setEnabled({ server, manager, workshopId, enabled }) {
  requireOffline(manager);
  const inventory = readInventory(server);
  if (!inventory.readable) fail('The official mod inventory cannot be read.', 409, 'inventory_unreadable');
  const pkg = inventory.packages.find((item) => item.workshopId === String(workshopId));
  if (!pkg) fail('That official package is not installed.', 404, 'package_not_found');
  pkg.enabled = enabled === true;
  pkg.updatedAt = new Date().toISOString();
  updateSettingsAndInventory(server, inventory.packages);
  return { ok: true, package: pkg, restartRequired: true };
}

function remove({ server, manager, workshopId }) {
  requireOffline(manager);
  const inventory = readInventory(server);
  if (!inventory.readable) fail('The official mod inventory cannot be read.', 409, 'inventory_unreadable');
  const pkg = inventory.packages.find((item) => item.workshopId === String(workshopId));
  if (!pkg) fail('That official package is not installed.', 404, 'package_not_found');
  const target = safeResolve(server.dir, `Mods/Workshop/${pkg.workshopId}`);
  const trashId = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const trash = path.join(stateDir(server), 'trash', trashId);
  const snapshot = snapshots.take({
    serverId: server.id, sourceDir: server.dir,
    scope: ['Mods'],
    kind: 'palworld-workshop', reason: `Before removal of ${pkg.packageName}`, retention: 10,
  });
  if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');
  fs.mkdirSync(trash, { recursive: true });
  if (fs.existsSync(target)) fs.renameSync(target, path.join(trash, 'package'));
  fs.writeFileSync(path.join(trash, 'manifest.json'), JSON.stringify({ version: 1, trashId, package: pkg, removedAt: new Date().toISOString() }, null, 2));
  updateSettingsAndInventory(server, inventory.packages.filter((item) => item.workshopId !== pkg.workshopId));
  return { ok: true, trashId, snapshotId: snapshot.id, restartRequired: true };
}

function listTrash(server) {
  const root = path.join(stateDir(server), 'trash');
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
      try { return [JSON.parse(fs.readFileSync(path.join(root, entry.name, 'manifest.json'), 'utf8'))]; } catch (_) { return []; }
    });
  } catch (_) { return []; }
}

function restore({ server, manager, trashId }) {
  requireOffline(manager);
  const root = path.join(stateDir(server), 'trash', String(trashId));
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); }
  catch (_) { fail('That removed package is unavailable.', 404, 'trash_not_found'); }
  const inventory = readInventory(server);
  if (!inventory.readable) fail('The official mod inventory cannot be read.', 409, 'inventory_unreadable');
  if (inventory.packages.some((pkg) => pkg.workshopId === manifest.package.workshopId || pkg.packageName === manifest.package.packageName)) {
    fail('An installed package conflicts with this removed package.', 409, 'restore_conflict');
  }
  const target = safeResolve(server.dir, `Mods/Workshop/${manifest.package.workshopId}`);
  if (fs.existsSync(target)) fail('The Workshop mirror destination is occupied.', 409, 'restore_conflict');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(path.join(root, 'package'), target);
  const packages = inventory.packages.concat({ ...manifest.package, enabled: true, restoredAt: new Date().toISOString() });
  updateSettingsAndInventory(server, packages);
  fs.rmSync(root, { recursive: true, force: true });
  return { ok: true, package: manifest.package, restartRequired: true };
}

function inspect(server, { serverRevision = null } = {}) {
  const inventory = readInventory(server);
  const cached = cachedPackages(server);
  const byId = new Map(cached.map((item) => [item.workshopId, item]));
  const packages = inventory.packages.map((pkg) => {
    const source = byId.get(pkg.workshopId);
    let cachedVersion = null;
    try { if (source) cachedVersion = normalizeInfo(JSON.parse(fs.readFileSync(path.join(source.path, 'Info.json'), 'utf8'))).version; } catch (_) {}
    const mirror = safeResolve(server.dir, `Mods/Workshop/${pkg.workshopId}`);
    let integrity = 'missing';
    try {
      const current = hashDirectory(mirror);
      integrity = manifestRevision(current) === manifestRevision(pkg.files || []) ? 'verified' : 'drifted';
    } catch (_) { /* missing or unreadable mirror */ }
    return { ...pkg, integrity, sourceAvailable: !!source, cachedVersion, updateState: source && cachedVersion !== pkg.version ? 'ready' : pkg.sourceUpdatedAt && source && source.modifiedAt > pkg.sourceUpdatedAt ? 'waiting-for-steam' : 'current' };
  });
  const legacyPaths = [
    'Pal/Content/Paks/~mods',
    'Pal/Binaries/Win64/ue4ss',
    '.fleetdeck/palworld-mods/inventory.json',
  ].filter((relative) => fs.existsSync(safeResolve(server.dir, relative)));
  return {
    ok: true, inventoryVersion: INVENTORY_VERSION, readable: inventory.readable, packages,
    cached: cached.map(({ path: sourcePath, ...item }) => ({ ...item, sourcePath })),
    sources: { ...sourceConfig(server), libraries: discoverLibraries({ manualPaths: sourceConfig(server).manualPaths, serverDir: server.dir }) },
    legacyPaths, trash: listTrash(server), serverRevision,
  };
}

async function checkUpdates(server, options = {}) {
  const result = inspect(server);
  const ids = result.packages.map((pkg) => pkg.workshopId).filter((id) => /^\d+$/.test(id));
  let remote = new Map();
  try { remote = await details(ids, options); }
  catch (error) { return { ...result, stale: true, error: error.message }; }
  return {
    ...result,
    packages: result.packages.map((pkg) => {
      const item = remote.get(pkg.workshopId);
      if (!item?.ok) return { ...pkg, updateState: 'unavailable', workshop: item || null };
      const remoteMs = item.updatedAt ? item.updatedAt * 1000 : 0;
      const sourceIsNewer = remoteMs > Number(pkg.sourceUpdatedAt || 0);
      const updateState = pkg.cachedVersion && pkg.cachedVersion !== pkg.version
        ? 'ready'
        : sourceIsNewer
          ? 'waiting-for-steam'
          : 'current';
      return { ...pkg, updateState, workshop: item };
    }),
    stale: false,
  };
}

async function preview({ server, manager, actorId, archivePath, workshopId, serverRevision = null, allowUnknownRevision = false }) {
  let source;
  if (archivePath) {
    const scanned = await scanZip(archivePath);
    source = { workshopId: String(workshopId || `upload-${crypto.randomUUID()}`), info: scanned.info, entries: scanned.entries, archivePath, source: 'upload', sourceUpdatedAt: Date.now() };
  } else {
    source = { ...packageFromSource(server, workshopId), source: 'steam-cache', sourceUpdatedAt: packageFromSource(server, workshopId).modifiedAt };
  }
  const inventory = readInventory(server);
  if (!inventory.readable) fail('The official mod inventory cannot be read.', 409, 'inventory_unreadable');
  const duplicate = inventory.packages.find((pkg) => pkg.packageName === source.info.packageName && pkg.workshopId !== source.workshopId);
  if (duplicate) fail('Another Workshop item already uses this PackageName.', 409, 'duplicate_package_name');
  const missingDependencies = source.info.dependencies.filter((name) => !inventory.packages.some((pkg) => pkg.packageName === name));
  if (missingDependencies.length) fail(`Missing dependencies: ${missingDependencies.join(', ')}.`, 409, 'missing_dependencies');
  let revisionState = 'compatible';
  if (source.info.minRevision != null && serverRevision != null && source.info.minRevision > serverRevision) {
    fail('This package requires a newer Palworld server revision.', 409, 'minimum_revision');
  }
  if (source.info.minRevision != null && serverRevision == null) {
    revisionState = 'unknown';
    if (!allowUnknownRevision) fail('The server revision could not be verified. Confirm compatibility to continue.', 409, 'revision_unknown');
  }
  const plan = {
    serverId: server.id, workshopId: source.workshopId, ...source.info,
    source: source.source, sourceUpdatedAt: source.sourceUpdatedAt, archivePath: source.archivePath || null,
    sourcePath: source.path || null, fileCount: source.files?.length || source.entries?.length || 0,
    sizeBytes: (source.files || source.entries || []).reduce((sum, file) => sum + file.bytes, 0),
    sourceRevision: source.files ? manifestRevision(source.files) : null,
    revisionState, wasRunning: manager?.status !== 'offline', mode: inventory.packages.some((pkg) => pkg.workshopId === source.workshopId) ? 'update' : 'install',
  };
  const revision = crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
  const previewToken = crypto.randomBytes(32).toString('base64url');
  previews.set(previewToken, { actorId, serverId: server.id, revision, plan, expiresAt: Date.now() + PREVIEW_TTL_MS });
  return { ok: true, previewToken, revision, expiresAt: Date.now() + PREVIEW_TTL_MS, plan };
}

function extractZip(file, destination) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      zip.readEntry();
      zip.on('entry', (entry) => {
        const target = safeResolve(destination, entry.fileName);
        if (/\/$/.test(entry.fileName)) { fs.mkdirSync(target, { recursive: true }); zip.readEntry(); return; }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const output = fs.createWriteStream(target, { flags: 'wx' });
          stream.pipe(output);
          output.on('close', () => zip.readEntry());
          output.on('error', reject);
        });
      });
      zip.on('end', resolve);
      zip.on('error', reject);
    });
  });
}

async function install({ server, manager, actorId, idempotencyKey, previewToken, revision }) {
  if (!idempotencyKey) fail('An Idempotency-Key header is required.', 400, 'idempotency_key_required');
  const previewState = previews.get(previewToken);
  if (!previewState || previewState.actorId !== actorId || previewState.serverId !== server.id || previewState.expiresAt < Date.now()) fail('The preview expired. Preview the package again.', 409, 'invalid_preview');
  if (previewState.revision !== revision) fail('The preview is stale. Preview the package again.', 409, 'stale_preview');
  const plan = previewState.plan;
  const op = operations.create({ kind: 'palworld-workshop-install', actorId, serverId: server.id, idempotencyKey, summary: { workshopId: plan.workshopId, packageName: plan.packageName, mode: plan.mode } });
  if (op.state !== operations.STATES.QUEUED) return { operation: op, replay: true };
  operations.start(op.id, { phase: 'stop' });
  if (!operations.acquireServerLock(op.id, server.id)) { operations.fail(op.id, { code: 'server_busy', text: 'Another operation is running for this server.' }); fail('Another operation is running for this server.', 409, 'server_busy'); }
  const completed = (async () => {
    const workshopRoot = safeResolve(server.dir, 'Mods/Workshop');
    const target = safeResolve(workshopRoot, plan.workshopId);
    const staging = path.join(stateDir(server), 'staging', op.id);
    const rollback = path.join(stateDir(server), 'rollback', op.id);
    const wasRunning = manager?.status !== 'offline';
    const previousInventory = readInventory(server);
    const settingsFile = safeResolve(server.dir, 'Mods/PalModSettings.ini');
    const previousSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile) : null;
    let snapshot = null;
    let committed = false;
    try {
      if (wasRunning) {
        manager.stop(false);
        const started = Date.now();
        while (manager.status !== 'offline' && Date.now() - started < 90_000) await new Promise((resolve) => setTimeout(resolve, 250));
        if (manager.status !== 'offline') fail('The Palworld process did not stop in time.', 500, 'stop_timeout');
      }
      operations.heartbeat(op.id, { phase: 'snapshot', progress: 0.2 });
      snapshot = snapshots.take({ serverId: server.id, sourceDir: server.dir, scope: ['Mods'], kind: 'palworld-workshop', reason: `Before ${plan.mode} of ${plan.packageName}`, retention: 10 });
      if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');
      operations.heartbeat(op.id, { phase: 'stage', progress: 0.4 });
      fs.mkdirSync(staging, { recursive: true });
      if (plan.archivePath) await extractZip(plan.archivePath, staging);
      else copyDirectory(plan.sourcePath, staging);
      const info = normalizeInfo(JSON.parse(fs.readFileSync(path.join(staging, 'Info.json'), 'utf8')));
      if (info.packageName !== plan.packageName || info.version !== plan.version) fail('The source package changed after preview.', 409, 'source_changed');
      const files = hashDirectory(staging);
      if (plan.sourceRevision && manifestRevision(files) !== plan.sourceRevision) fail('The source package changed after preview.', 409, 'source_changed');
      operations.heartbeat(op.id, { phase: 'commit', progress: 0.7 });
      fs.mkdirSync(workshopRoot, { recursive: true });
      if (fs.existsSync(target)) { fs.mkdirSync(path.dirname(rollback), { recursive: true }); fs.renameSync(target, rollback); }
      fs.renameSync(staging, target);
      committed = true;
      const inventory = readInventory(server);
      const next = {
        workshopId: plan.workshopId, packageName: plan.packageName, version: plan.version,
        minRevision: plan.minRevision, dependencies: plan.dependencies, serverRules: plan.serverRules,
        source: plan.source, sourceUpdatedAt: plan.sourceUpdatedAt, tags: [], enabled: true,
        installedAt: new Date().toISOString(), actorId, operationId: op.id, files,
      };
      const packages = inventory.packages.filter((pkg) => pkg.workshopId !== plan.workshopId);
      packages.push(next);
      const settings = activeSettings(server, packages.filter((pkg) => pkg.enabled).map((pkg) => pkg.packageName));
      fs.mkdirSync(path.dirname(settings.file), { recursive: true });
      const settingsTemp = `${settings.file}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(settingsTemp, settings.content);
      fs.renameSync(settingsTemp, settings.file);
      writeInventory(server, { packages });
      if (wasRunning) {
        operations.heartbeat(op.id, { phase: 'restart', progress: 0.9 });
        const started = manager.start();
        if (started?.ok === false) fail('Palworld could not be restarted.', 500, 'restart_failed');
        const deploymentManifest = safeResolve(server.dir, `Mods/ManagedMods/${plan.packageName}/InstallManifest.json`);
        const deadline = Date.now() + 90_000;
        while (!fs.existsSync(deploymentManifest) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (!fs.existsSync(deploymentManifest)) fail('Palworld did not create the package deployment manifest.', 500, 'deployment_manifest_missing');
      }
      operations.finish(op.id, { workshopId: plan.workshopId, packageName: plan.packageName, snapshotId: snapshot.id, files: files.length });
      return operations.get(op.id);
    } catch (error) {
      let recovered = true;
      try {
        if (committed) fs.rmSync(target, { recursive: true, force: true });
        if (fs.existsSync(rollback)) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.renameSync(rollback, target); }
        if (previousSettings) {
          fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
          fs.writeFileSync(settingsFile, previousSettings);
        } else {
          fs.rmSync(settingsFile, { force: true });
        }
        if (previousInventory.readable) writeInventory(server, previousInventory);
      } catch (_) { recovered = false; }
      const payload = { code: error.code || 'install_failed', text: error.message, recovery: { snapshotId: snapshot?.id || null, instructions: 'Review the Workshop mirror and restore the verified snapshot before starting Palworld.' } };
      if (!recovered) operations.markRecoveryRequired(op.id, payload); else operations.fail(op.id, payload);
      if (wasRunning && manager.status === 'offline') { try { manager.start(); } catch (_) {} }
      return operations.get(op.id);
    } finally {
      operations.releaseServerLock(op.id);
      fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(rollback, { recursive: true, force: true });
      if (plan.archivePath) { try { fs.unlinkSync(plan.archivePath); } catch (_) {} }
      previews.delete(previewToken);
    }
  })();
  return { operation: operations.get(op.id), completed, replay: false };
}

module.exports = {
  APP_ID, INVENTORY_VERSION, TYPES, WorkshopError,
  stateDir, inventoryPath, readInventory, writeInventory,
  parseVdfLibraries, standardSteamRoots, discoverLibraries, sourceConfig, saveSources, cachedPackages,
  parseCatalogHtml, details, catalog, officialUrl, normalizeInfo, scanZip,
  packageFromSource, activeSettings, inspect, checkUpdates, preview, install,
  setEnabled, remove, listTrash, restore,
  resetCaches() { previews.clear(); catalogCache.clear(); detailCache.clear(); },
};
