'use strict';

/*
 * Web map plugins for Minecraft servers: which ones Hostkind knows how to
 * install, whether one is already on disk, and which port its web panel
 * listens on. Installation itself goes through lib/modrinth-batch.cjs; this
 * module only reads the server folder (plus one opt-in edit to BlueMap's
 * core.conf, see acceptBlueMapDownload).
 *
 * Plugin servers keep plugin data in plugins/<Name>/, mod loaders in
 * config/<name>/ (Dynmap uses dynmap/ at the server root on mod loaders).
 * Folder names are matched case-insensitively because the plugins disagree.
 */

const fs = require('fs');
const path = require('path');

const YAML_PORT = /^\s*port\s*:\s*(\d{2,5})\b/m;

const MAP_PLUGINS = [
  {
    key: 'bluemap',
    name: 'BlueMap',
    projectId: 'bluemap',
    defaultPort: 8100,
    jar: /bluemap/i,
    dataDirs: ['plugins/bluemap', 'config/bluemap'],
    portFile: 'webserver.conf',
    portPattern: YAML_PORT,
  },
  {
    key: 'dynmap',
    name: 'Dynmap',
    projectId: 'dynmap',
    defaultPort: 8123,
    jar: /dynmap/i,
    dataDirs: ['plugins/dynmap', 'dynmap'],
    portFile: 'configuration.txt',
    portPattern: /^\s*webserver-port\s*:\s*(\d{2,5})\b/m,
  },
  {
    key: 'squaremap',
    name: 'squaremap',
    projectId: 'squaremap',
    defaultPort: 8080,
    jar: /squaremap/i,
    dataDirs: ['plugins/squaremap', 'config/squaremap'],
    portFile: 'config.yml',
    portPattern: YAML_PORT,
  },
  {
    key: 'pl3xmap',
    name: 'Pl3xMap',
    projectId: 'pl3xmap',
    defaultPort: 8080,
    jar: /pl3xmap/i,
    dataDirs: ['plugins/pl3xmap', 'config/pl3xmap'],
    portFile: 'config.yml',
    portPattern: YAML_PORT,
  },
];

function plugin(key) {
  return MAP_PLUGINS.find((p) => p.key === String(key || '').toLowerCase()) || null;
}

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

// Resolve a relative path whose segments may differ in case from what we
// expect (plugins/BlueMap vs plugins/bluemap). Returns null when absent.
function findCaseInsensitive(rootDir, relative) {
  let current = rootDir;
  for (const segment of relative.split('/')) {
    const hit = listDir(current).find((entry) => entry.name.toLowerCase() === segment.toLowerCase());
    if (!hit) return null;
    current = path.join(current, hit.name);
  }
  return current;
}

function installedJar(rootDir, folder, entry) {
  const hit = listDir(path.join(rootDir, folder))
    .find((item) => item.isFile() && /\.jar$/i.test(item.name) && entry.jar.test(item.name));
  return hit ? hit.name : null;
}

function dataFile(rootDir, entry, name) {
  for (const dir of entry.dataDirs) {
    const found = findCaseInsensitive(rootDir, `${dir}/${name}`);
    if (found) return found;
  }
  return null;
}

function readPort(rootDir, entry) {
  const file = dataFile(rootDir, entry, entry.portFile);
  if (!file) return entry.defaultPort;
  try {
    const match = fs.readFileSync(file, 'utf8').match(entry.portPattern);
    const port = match ? Number(match[1]) : NaN;
    return port > 0 && port < 65536 ? port : entry.defaultPort;
  } catch {
    return entry.defaultPort;
  }
}

// BlueMap will not render until the owner agrees to it downloading Mojang's
// client resources. 'pending' means core.conf exists and still says false;
// null means BlueMap has not written core.conf yet (first start pending).
function blueMapDownloadState(rootDir) {
  const file = dataFile(rootDir, plugin('bluemap'), 'core.conf');
  if (!file) return null;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(/^\s*accept-download\s*:\s*(true|false)\b/m);
    if (!match) return null;
    return match[1] === 'true' ? 'accepted' : 'pending';
  } catch {
    return null;
  }
}

function acceptBlueMapDownload(rootDir) {
  const file = dataFile(rootDir, plugin('bluemap'), 'core.conf');
  if (!file) return false;
  const text = fs.readFileSync(file, 'utf8');
  const next = text.replace(/^(\s*accept-download\s*:\s*)false\b/m, '$1true');
  if (next === text) return false;
  fs.writeFileSync(file, next);
  return true;
}

// What the map tab needs to know about one server, without network access.
function status(rootDir, compat) {
  const supported = Boolean(compat && compat.projectType);
  const plugins = MAP_PLUGINS.map((entry) => {
    const file = supported && rootDir ? installedJar(rootDir, compat.folder, entry) : null;
    return {
      key: entry.key,
      name: entry.name,
      installed: Boolean(file),
      file,
      port: file ? readPort(rootDir, entry) : entry.defaultPort,
    };
  });
  const blueMap = plugins.find((p) => p.key === 'bluemap');
  return {
    supported,
    reason: supported ? null : 'vanilla',
    plugins,
    blueMapDownload: blueMap.installed ? blueMapDownloadState(rootDir) : null,
  };
}

module.exports = {
  MAP_PLUGINS,
  plugin,
  readPort,
  status,
  blueMapDownloadState,
  acceptBlueMapDownload,
};
