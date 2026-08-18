'use strict';

/*
 * Minecraft server directory detection for the adopt/import flow.
 * Mirrors lib/palworld-portability.cjs's inspectAdoption pattern:
 *   - 'returns a descriptor, never registers/writes config/never starts anything'
 *   - so it is testable without a running panel.
 *
 * Detects:
 *   - server.properties (ports, motd, level-name, level-seed, max-players, etc.)
 *   - eula.txt
 *   - world folder(s)
 *   - jar/loader type (vanilla/paper/forge/fabric from jar filename or libraries/)
 *   - Java availability (stub — actual resolution is a panel concern)
 *   - conflicting registered roots
 */

const fs = require('fs');
const path = require('path');
const pathSafety = require('./pathSafety.cjs');

const SERVER_PROPERTIES_DEFAULTS = Object.freeze({
  'server-port': 25565,
  'server-portv6': 25566,
  'query.port': 25565,
  'rcon.port': 5575,
  'motd': 'A Minecraft Server',
  'level-name': 'world',
  'level-seed': '',
  'max-players': 20,
  'online-mode': true,
  'gamemode': 'survival',
  'difficulty': 'easy',
  'pvp': true,
  'allow-flight': false,
  'spawn-protection': 16,
  'view-distance': 10,
  'simulation-distance': 10,
  'white-list': false,
  'enforce-whitelist': false,
  'enable-command-block': false,
  'level-type': 'minecraft\\:normal',
  'level-generator-settings': '{}',
});

const JAR_PATTERNS = [
  { re: /paper[-_].*\.jar$/i, type: 'paper', label: 'Paper' },
  { re: /spigot[-_].*\.jar$/i, type: 'spigot', label: 'Spigot' },
  { re: /bukkit[-_].*\.jar$/i, type: 'bukkit', label: 'Bukkit' },
  { re: /forge[-_].*\.jar$/i, type: 'forge', label: 'Forge' },
  { re: /fabric[-_].*\.jar$/i, type: 'fabric', label: 'Fabric' },
  { re: /neoforge[-_].*\.jar$/i, type: 'neoforge', label: 'NeoForge' },
  { re: /purpur[-_].*\.jar$/i, type: 'purpur', label: 'Purpur' },
  { re: /server[-_]?.*\.jar$/i, type: 'vanilla', label: 'Vanilla' },
  { re: /minecraft[-_].*\.jar$/i, type: 'vanilla', label: 'Vanilla' },
];

function parseServerProperties(filePath) {
  if (!fs.existsSync(filePath)) return null;
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  const props = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    const idx = trimmed.indexOf('=');
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const raw = trimmed.slice(idx + 1).trim();
    // Strip surrounding quotes
    const value = /^"(.*)"$/.test(raw) ? raw.slice(1, -1) : raw;
    props[key] = value;
  }
  return props;
}

function detectJarLoader(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }

  // Check root for jars
  const rootJars = entries
    .filter((e) => e.isFile() && /\.jar$/i.test(e.name))
    .map((e) => e.name);

  // Check for libraries/ directory (mod loaders put their deps there)
  const hasLibraries = entries.some((e) => e.isDirectory() && e.name === 'libraries');
  const hasVersions = entries.some((e) => e.isDirectory() && e.name === 'versions');
  const hasMods = entries.some((e) => e.isDirectory() && e.name === 'mods');
  const hasPlugins = entries.some((e) => e.isDirectory() && e.name === 'plugins');

  // Classify the primary jar
  let detected = null;
  for (const jar of rootJars) {
    for (const pattern of JAR_PATTERNS) {
      if (pattern.re.test(jar)) {
        detected = { jar, type: pattern.type, label: pattern.label };
        break;
      }
    }
    if (detected) break;
  }

  // Heuristic: if no jar matched but we have libraries + mods, it's likely a mod loader
  if (!detected && rootJars.length > 0) {
    if (hasLibraries && hasMods) {
      detected = { jar: rootJars[0], type: 'modded', label: 'Modded (unknown loader)' };
    } else {
      detected = { jar: rootJars[0], type: 'unknown', label: 'Unknown jar' };
    }
  }

  return {
    jar: detected,
    jars: rootJars,
    hasLibraries,
    hasVersions,
    hasMods,
    hasPlugins,
  };
}

function detectWorlds(dir, levelName) {
  const worlds = [];
  const candidates = [levelName || 'world', 'world_nether', 'world_the_end', 'world_the_end'];
  const seen = new Set();
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (seen.has(entry.name)) continue;
      // A world dir typically has level.dat
      const levelDat = path.join(dir, entry.name, 'level.dat');
      if (fs.existsSync(levelDat)) {
        const stat = fs.statSync(levelDat);
        worlds.push({ name: entry.name, levelDatModifiedAt: stat.mtime.toISOString() });
        seen.add(entry.name);
      }
    }
  } catch {}
  return worlds;
}

function detectEula(dir) {
  const eulaPath = path.join(dir, 'eula.txt');
  if (!fs.existsSync(eulaPath)) return { present: false, accepted: false };
  try {
    const text = fs.readFileSync(eulaPath, 'utf8');
    const accepted = /eula\s*=\s*true/i.test(text);
    return { present: true, accepted };
  } catch {
    return { present: true, accepted: false };
  }
}

function detectJavaAvailability() {
  // Stub: actual Java resolution is a panel concern (resolveJavaForServer).
  // The lib module reports whether Java is likely available on PATH.
  const { execFileSync } = require('child_process');
  try {
    const output = execFileSync('java', ['-version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
    const match = String(output).match(/version\s+"?(\d+)/);
    return { available: true, majorVersion: match ? parseInt(match[1], 10) : null };
  } catch {
    return { available: false, majorVersion: null };
  }
}

/*
 * Detect an existing Minecraft server directory without writing anything.
 * Returns a descriptor identical in shape to what inspectAdoption returns
 * for Palworld, so the dialog can render it with the same pattern.
 */
function detectServer({ dir, servers = [] }) {
  const raw = String(dir || '').trim();
  const blocked = pathSafety.protectedReason(raw, { servers, requireExisting: true });
  if (blocked) {
    return { ok: false, dir: raw, blocked, ready: false, issues: [blocked.message] };
  }
  const root = pathSafety.canonical(raw);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { ok: false, dir: raw, blocked: null, ready: false, issues: ['The path does not exist or is not a directory.'] };
  }

  const issues = [];
  const propsFile = path.join(root, 'server.properties');
  const props = parseServerProperties(propsFile);
  if (!props) issues.push('server.properties was not found. The server may not have been started yet.');

  const port = props ? Number(props['server-port'] || SERVER_PROPERTIES_DEFAULTS['server-port']) : null;
  const queryPort = props ? Number(props['query.port'] || SERVER_PROPERTIES_DEFAULTS['query.port']) : null;
  const rconPort = props ? Number(props['rcon.port'] || SERVER_PROPERTIES_DEFAULTS['rcon.port']) : null;
  const motd = props ? (props['motd'] || '') : '';
  const levelName = props ? (props['level-name'] || 'world') : 'world';
  const levelSeed = props ? (props['level-seed'] || '') : '';
  const maxPlayers = props ? Number(props['max-players'] || 20) : null;
  const gamemode = props ? (props['gamemode'] || 'survival') : null;
  const difficulty = props ? (props['difficulty'] || 'easy') : null;
  const onlineMode = props ? (props['online-mode'] !== 'false') : true;
  const pvp = props ? (props['pvp'] !== 'false') : true;

  const eula = detectEula(root);
  if (!eula.present) issues.push('eula.txt was not found. Players cannot join until EULA is accepted.');
  else if (!eula.accepted) issues.push('eula.txt exists but EULA is not accepted (eula=false).');

  const jarLoader = detectJarLoader(root);
  const worlds = detectWorlds(root, levelName);
  const java = detectJavaAvailability();

  return {
    ok: true,
    dir: root,
    blocked: null,
    serverProperties: props ? {
      present: true,
      port,
      queryPort,
      rconPort,
      motd,
      levelName,
      levelSeed,
      maxPlayers,
      gamemode,
      difficulty,
      onlineMode,
      pvp,
    } : { present: false },
    eula,
    jarLoader,
    worlds,
    java,
    ready: !!jarLoader?.jar && issues.length === 0,
    issues,
    preserves: ['world data', 'server.properties', 'eula.txt', 'unrelated files in this folder'],
  };
}

/*
 * Build a registration descriptor from a detection result.
 * This is what the dialog sends to POST /api/servers (the existing API).
 * The lib module itself never writes anything.
 */
function buildDescriptor({ detection, name }) {
  if (!detection.ok) return null;
  const serverName = String(name || detection.dir.split(path.sep).pop() || 'Minecraft Server').trim().slice(0, 80);
  const sp = detection.serverProperties;
  return {
    type: 'minecraft',
    name: serverName,
    dir: detection.dir,
    jar: detection.jarLoader?.jar?.jar || '',
    mcVersion: detection.jarLoader?.jar?.type === 'vanilla' ? '' : '',
    javaArgs: ['-Xmx4G', '-Xms4G'],
    worlds: detection.worlds.map((w) => w.name),
    mapUrl: '',
    port: sp?.port || 25565,
  };
}

module.exports = {
  parseServerProperties,
  detectJarLoader,
  detectWorlds,
  detectEula,
  detectJavaAvailability,
  detectServer,
  buildDescriptor,
  SERVER_PROPERTIES_DEFAULTS,
};
