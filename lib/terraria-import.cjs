'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const pathSafety = require('./pathSafety.cjs');
const snapshots = require('./snapshots.cjs');
const worlds = require('./terraria-worlds.cjs');
const mods = require('./terraria-mods.cjs');
const { validateManualRegistration } = require('./modules/registration.cjs');

const PREVIEW_TTL_MS = 15 * 60_000;
const previews = new Map();

class TerrariaImportError extends Error {
  constructor(message, status = 400, code = 'terraria_import_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(message, status, code) {
  throw new TerrariaImportError(message, status, code);
}

function existsFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function existsDir(file) {
  try { return fs.statSync(file).isDirectory(); } catch { return false; }
}

function relativeInside(root, target, code = 'save_dir_outside') {
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    fail('The configured save folder is outside the server folder. Move the worlds into this folder or register their common parent.', 409, code);
  }
  return rel.split(path.sep).join('/') || '.';
}

function readConfig(file) {
  if (!existsFile(file)) return { present: false, values: {}, evidence: [] };
  const values = {};
  const evidence = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    values[key] = value;
    if (['port', 'maxplayers', 'world', 'worldpath'].includes(key)) evidence.push(`serverconfig.txt: ${key}`);
  }
  return { present: true, values, evidence };
}

function marker(root, relative, kind = 'file') {
  const absolute = path.join(root, relative);
  return (kind === 'dir' ? existsDir(absolute) : existsFile(absolute)) ? relative : null;
}

function detectVariants(root) {
  const found = [];
  const vanilla = ['TerrariaServer.exe', 'TerrariaServer.bin.x86_64', 'Terraria Server']
    .filter((name) => marker(root, name));
  const tshock = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^TShock\.Server(?:\.exe)?$/i.test(entry.name))
    .map((entry) => entry.name);
  if (marker(root, 'tshock/config.json')) tshock.push('tshock/config.json');
  const tmod = [
    'start-tModLoaderServer.sh', 'start-tModLoaderServer.bat',
    'tModLoader.dll',
  ].filter((name) => marker(root, name));
  if (marker(root, 'Mods', 'dir')) tmod.push('Mods/');
  if (marker(root, 'Mods/enabled.json')) tmod.push('Mods/enabled.json');
  if (tshock.length) found.push({ value: 'tshock', evidence: [...new Set(tshock)] });
  if (tmod.length) found.push({ value: 'tmodloader', evidence: [...new Set(tmod)] });
  if (!tshock.length && !tmod.length && vanilla.length) found.push({ value: 'vanilla', evidence: vanilla });
  return found;
}

function executableFor(root, variant) {
  if (variant === 'tmodloader') {
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length) {
      const current = queue.shift();
      for (const entry of fs.readdirSync(current.dir, { withFileTypes: true })) {
        const absolute = path.join(current.dir, entry.name);
        if (entry.isFile() && (entry.name === 'dotnet' || entry.name === 'dotnet.exe')) {
          return { relative: path.relative(root, absolute).split(path.sep).join('/'), absolute };
        }
        if (entry.isDirectory() && current.depth < 3) queue.push({ dir: absolute, depth: current.depth + 1 });
      }
    }
    return null;
  }
  const candidates = variant === 'tshock'
    ? ['TShock.Server.exe', 'TShock.Server']
    : ['TerrariaServer.exe', 'TerrariaServer.bin.x86_64', 'Terraria Server'];
  for (const relative of candidates) {
    if (existsFile(path.join(root, relative))) return { relative, absolute: path.join(root, relative) };
  }
  return null;
}

function versionOf(root) {
  for (const relative of ['version.txt', 'VERSION', 'release_extras/version.txt']) {
    const file = path.join(root, relative);
    if (!existsFile(file)) continue;
    const value = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)[0].slice(0, 80);
    if (value) return { value, evidence: [relative] };
  }
  return { value: null, evidence: [] };
}

function scanWorlds(saveDir) {
  if (!existsDir(saveDir)) return [];
  return fs.readdirSync(saveDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.wld')
    .slice(0, 5000)
    .map((entry) => {
      const stat = fs.statSync(path.join(saveDir, entry.name));
      const header = worlds.readHeaderOf(path.join(saveDir, entry.name));
      return {
        file: entry.name,
        name: header.ok && header.name ? header.name : path.basename(entry.name, '.wld'),
        readable: header.ok,
        headerVersion: header.ok ? header.version : null,
        sizeBytes: stat.size,
      };
    });
}

function inspect(dir, { servers = [], variant = null } = {}) {
  const blocked = pathSafety.protectedReason(dir, { servers, requireExisting: true });
  if (blocked) fail(blocked.message, 409, blocked.reason);
  const root = pathSafety.canonical(dir);
  const detected = detectVariants(root);
  if (!detected.length) fail('No Terraria server files were recognized. Use generic manual registration or Other Processes for this folder.', 422, 'not_terraria');
  const choices = detected.map((item) => item.value);
  const selected = variant ? String(variant).toLowerCase() : (detected.length === 1 ? detected[0].value : null);
  if (selected && !choices.includes(selected)) fail('The selected variant is not supported by the evidence in this folder.', 409, 'variant_not_evidenced');
  const executable = selected ? executableFor(root, selected) : null;
  const configFile = path.join(root, 'serverconfig.txt');
  const config = readConfig(configFile);
  const configuredSave = config.values.worldpath || (config.values.world ? path.dirname(config.values.world) : '.');
  const saveDir = path.isAbsolute(configuredSave) ? path.resolve(configuredSave) : path.resolve(root, configuredSave);
  const saveRelative = relativeInside(root, saveDir);
  const foundWorlds = scanWorlds(saveDir);
  const configuredWorld = config.values.world
    ? (path.isAbsolute(config.values.world)
      ? path.resolve(config.values.world)
      : path.resolve(config.values.worldpath ? saveDir : root, config.values.world))
    : null;
  if (configuredWorld) relativeInside(root, configuredWorld, 'world_outside');
  const active = configuredWorld ? foundWorlds.find((item) => path.resolve(saveDir, item.file) === configuredWorld) || null : null;
  const issues = [];
  if (detected.length > 1 && !selected) issues.push({ code: 'variant_ambiguous', severity: 'error', detail: `Markers for ${choices.join(' and ')} are both present. Choose which runtime Hostkind should launch.` });
  if (selected && !executable) issues.push({ code: 'executable_missing', severity: 'error', detail: `No ${selected} server entry point was found.` });
  if (configuredWorld && !existsFile(configuredWorld)) issues.push({ code: 'world_missing', severity: 'warning', detail: 'The configured world does not exist. Select or create a world after adoption.' });
  const port = Number(config.values.port);
  const maxPlayers = Number(config.values.maxplayers);
  let modInventory = [];
  if (selected === 'tmodloader') {
    try {
      modInventory = mods.inventory({ id: 'inspection', dir: root, args: [], terrariaVariant: selected }).mods || [];
    } catch {
      modInventory = (existsDir(path.join(root, 'Mods')) ? fs.readdirSync(path.join(root, 'Mods'), { withFileTypes: true }) : [])
        .filter((entry) => entry.isFile() && /\.tmod$/i.test(entry.name))
        .map((entry) => ({ file: entry.name }));
    }
  }
  const stat = executable ? fs.statSync(executable.absolute) : null;
  const fixes = [];
  if (!config.present) fixes.push({ id: 'writeConfig', detail: 'Create serverconfig.txt with the detected port and selected world. An existing file is never overwritten.' });
  if (executable && process.platform !== 'win32' && !(stat.mode & 0o111)) fixes.push({ id: 'makeExecutable', detail: 'Set the executable bit on the detected server entry point.' });
  if (!configuredWorld && foundWorlds.length === 1) fixes.push({ id: 'selectWorld', detail: `Select ${foundWorlds[0].file} as the active world.` });
  const version = versionOf(root);
  const inspection = {
    variant: {
      value: selected,
      confidence: detected.length === 1 ? 'high' : 'ambiguous',
      evidence: detected.flatMap((item) => item.evidence.map((source) => ({ variant: item.value, source }))),
      choices,
    },
    executable: executable ? executable.relative : null,
    launchPlan: executable ? {
      executable: executable.relative,
      args: selected === 'tmodloader'
        ? [path.join(root, 'tModLoader.dll'), '-server', '-config', configFile]
        : (config.present ? ['-config', 'serverconfig.txt'] : []),
    } : null,
    version,
    port: Number.isInteger(port) && port > 0 ? { value: port, evidence: ['serverconfig.txt: port'] } : { value: 7777, evidence: ['Terraria default'] },
    maxPlayers: Number.isInteger(maxPlayers) && maxPlayers > 0 ? { value: maxPlayers, evidence: ['serverconfig.txt: maxplayers'] } : { value: 8, evidence: ['Terraria default'] },
    saveDir: { value: saveRelative, evidence: config.values.worldpath ? ['serverconfig.txt: worldpath'] : ['server root'] },
    worlds: foundWorlds,
    activeWorld: active,
    configFiles: config.present ? ['serverconfig.txt'] : [],
    mods: modInventory,
    tshock: { present: choices.includes('tshock'), restConfigured: existsFile(path.join(root, 'tshock', 'config.json')) },
    issues,
    optionalFixes: fixes,
    readOnly: true,
    dir: root,
  };
  inspection.fingerprint = fingerprint(inspection);
  return inspection;
}

function fingerprint(inspection) {
  const root = inspection.dir;
  const files = new Set([
    ...inspection.variant.choices.map((choice) => executableFor(root, choice)?.relative),
    ...inspection.configFiles,
    ...inspection.variant.evidence.map((item) => item.source.replace(/\/$/, '')),
    ...inspection.worlds.map((item) => path.join(inspection.saveDir.value, item.file)),
  ].filter(Boolean));
  const evidence = [...files].sort().map((relative) => {
    const absolute = path.join(root, relative);
    try {
      const stat = fs.statSync(absolute);
      return [relative, stat.size, stat.mtimeMs, stat.mode, stat.isDirectory() ? 'dir' : crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')];
    } catch { return [relative, null]; }
  });
  return crypto.createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

function preview({ dir, actorId, servers = [], variant = null }) {
  const inspection = inspect(dir, { servers, variant });
  const token = crypto.randomBytes(24).toString('base64url');
  previews.set(token, { actorId: String(actorId), dir: inspection.dir, fingerprint: inspection.fingerprint, variant: inspection.variant.value, expiresAt: Date.now() + PREVIEW_TTL_MS });
  const descriptor = {
    variant: inspection.variant.value,
    port: inspection.port.value,
    world: inspection.activeWorld?.file || null,
    saveDirectory: inspection.saveDir.value,
    launchPlan: inspection.launchPlan,
  };
  return { ok: true, inspection, descriptor, untouched: 'No file in this folder will be modified.', optionalFixes: inspection.optionalFixes, token };
}

function consumePreview({ token, actorId, servers = [], variant = null }) {
  const saved = previews.get(String(token || ''));
  previews.delete(String(token || ''));
  if (!saved) fail('This import preview is missing or has already been used.', 409, 'preview_missing');
  if (saved.expiresAt < Date.now()) fail('This import preview has expired. Inspect the folder again.', 409, 'preview_expired');
  if (saved.actorId !== String(actorId)) fail('This import preview belongs to another user.', 403, 'preview_actor');
  const chosen = variant || saved.variant;
  const current = inspect(saved.dir, { servers, variant: chosen });
  if (current.fingerprint !== saved.fingerprint) fail('The folder changed after it was inspected. Preview it again.', 409, 'preview_stale');
  if (!chosen) fail('Choose a Terraria variant before adopting this folder.', 400, 'variant_required');
  if (!current.executable) fail('The selected Terraria executable was not found.', 422, 'executable_missing');
  return current;
}

function adopt({ token, actorId, name, servers = [], variant = null, fixes = [] }) {
  const inspection = consumePreview({ token, actorId, servers, variant });
  const selectedFixes = new Set(Array.isArray(fixes) ? fixes : []);
  const offered = new Set(inspection.optionalFixes.map((item) => item.id));
  for (const fix of selectedFixes) if (!offered.has(fix)) fail(`The fix "${fix}" was not offered by this preview.`, 400, 'fix_not_offered');
  const root = inspection.dir;
  const backups = [];
  const changed = [];
  const configFile = path.join(root, 'serverconfig.txt');
  try {
    if (selectedFixes.has('writeConfig') || selectedFixes.has('selectWorld')) {
      if (existsFile(configFile) && selectedFixes.has('writeConfig')) fail('serverconfig.txt now exists and will not be overwritten.', 409, 'config_exists');
      const scope = existsFile(configFile) ? ['serverconfig.txt'] : [];
      if (scope.length) {
        const snapshot = snapshots.take({ serverId: `terraria-adopt-${crypto.randomUUID()}`, sourceDir: root, scope, kind: 'terraria-adoption', reason: 'Before Terraria adoption fix', retention: 10 });
        if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');
      }
      const original = existsFile(configFile) ? fs.readFileSync(configFile) : null;
      backups.push({ file: configFile, content: original });
      let text = original ? original.toString('utf8') : `port=${inspection.port.value}\nmaxplayers=${inspection.maxPlayers.value}\n`;
      if (selectedFixes.has('selectWorld')) {
        const world = inspection.worlds[0];
        text = text.replace(/^world=.*$/mi, '').trimEnd() + `\nworld=${path.join(inspection.saveDir.value === '.' ? '' : inspection.saveDir.value, world.file).split(path.sep).join('/')}\n`;
      }
      fs.writeFileSync(configFile, text);
      changed.push('serverconfig.txt');
    }
    const executable = path.join(root, inspection.executable);
    if (selectedFixes.has('makeExecutable')) {
      const mode = fs.statSync(executable).mode;
      backups.push({ file: executable, mode });
      fs.chmodSync(executable, mode | 0o111);
      changed.push('executable-bit');
    }
    const descriptor = validateManualRegistration({
      gameType: 'terraria',
      name: String(name || path.basename(root)).trim(),
      dir: root,
      executable: inspection.executable,
      args: inspection.variant.value === 'tmodloader'
        ? inspection.launchPlan.args
        : ((inspection.configFiles.length || selectedFixes.has('writeConfig') || selectedFixes.has('selectWorld')) ? ['-config', 'serverconfig.txt'] : []),
      stopCommand: 'exit',
      terrariaVariant: inspection.variant.value,
      port: inspection.port.value,
    });
    descriptor.terrariaVersion = inspection.version.value;
    descriptor.terrariaSaveDir = inspection.saveDir.value;
    const selectedWorld = inspection.activeWorld || (selectedFixes.has('selectWorld') ? inspection.worlds[0] : null);
    if (selectedWorld) descriptor.terrariaWorld = { name: selectedWorld.name, file: path.posix.join(inspection.saveDir.value === '.' ? '' : inspection.saveDir.value, selectedWorld.file) };
    return { ok: true, descriptor, inspection, appliedFixes: changed, rollback: () => rollback(backups) };
  } catch (error) {
    rollback(backups);
    throw error;
  }
}

function rollback(backups) {
  for (const item of [...backups].reverse()) {
    try {
      if ('content' in item) {
        if (item.content == null) fs.rmSync(item.file, { force: true });
        else fs.writeFileSync(item.file, item.content);
      } else if (item.mode != null) fs.chmodSync(item.file, item.mode);
    } catch {}
  }
}

function resetPreviews() {
  previews.clear();
}

module.exports = { PREVIEW_TTL_MS, TerrariaImportError, inspect, fingerprint, preview, consumePreview, adopt, resetPreviews };
