'use strict';

const fs = require('fs');
const path = require('path');

const OWNED_FLAGS = Object.freeze(new Set([
  '-name', '-port', '-world', '-password', '-savedir', '-public', '-crossplay',
]));
const VALUE_FLAGS = Object.freeze(new Set(['-name', '-port', '-world', '-password', '-savedir', '-public']));
const SAFE_NAME = /^[^\r\n\0]{1,64}$/;

function invalidText(value, label) {
  const text = String(value == null ? '' : value);
  if (/[\r\n\0]/.test(text)) throw new Error(`${label} contains an unsafe character`);
  return text;
}

function normalizeRelativeDir(value) {
  const rel = invalidText(value == null ? 'data' : value, 'Save directory').trim() || 'data';
  if (path.isAbsolute(rel)) throw new Error('Valheim save directory must be server-relative');
  const normalized = path.normalize(rel);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error('Valheim save directory must stay inside the server folder');
  }
  return normalized.split(path.sep).join('/');
}

function inside(root, candidate, label) {
  const base = path.resolve(root);
  const resolved = path.resolve(candidate);
  const rel = path.relative(base, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${label} must be inside the server folder`);
  return resolved;
}

function realInside(root, candidate, label, allowMissing = false) {
  const resolved = inside(root, candidate, label);
  let realRoot = path.resolve(root);
  let realCandidate = resolved;
  try { realRoot = fs.realpathSync.native(root); } catch {}
  try {
    realCandidate = fs.realpathSync.native(resolved);
  } catch (err) {
    if (!allowMissing) throw err;
    let ancestor = path.dirname(resolved);
    while (ancestor !== path.dirname(ancestor) && !fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const realAncestor = fs.realpathSync.native(ancestor);
    realCandidate = path.join(realAncestor, path.relative(ancestor, resolved));
  }
  const rel = path.relative(realRoot, realCandidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${label} must not escape the server folder through a link`);
  if (process.platform === 'win32' && realCandidate.toLowerCase() !== path.resolve(realRoot, rel).toLowerCase()) {
    throw new Error(`${label} has an unsafe case-folded path`);
  }
  return resolved;
}

function normalizeBackend(value) {
  const backend = String(value || 'steam').toLowerCase();
  if (backend !== 'steam' && backend !== 'crossplay') throw new Error('Valheim backend must be steam or crossplay');
  return backend;
}

function normalizePublic(value) {
  return value == null ? true : !!value;
}

function validateName(value, label) {
  const name = invalidText(value, label).trim();
  if (!SAFE_NAME.test(name) || name.startsWith('-')) throw new Error(`${label} is invalid`);
  return name;
}

function validatePassword(value) {
  const password = invalidText(value, 'Password');
  if (password.length < 5 || password.length > 64) throw new Error('Valheim password must be 5 to 64 characters');
  if (/\s/.test(password)) throw new Error('Valheim password must not contain whitespace');
  return password;
}

function parseArgs(args) {
  const values = {};
  const unknown = [];
  const seen = new Set();
  const input = Array.isArray(args) ? args : [];
  for (let i = 0; i < input.length; i++) {
    const raw = invalidText(input[i], 'Argument');
    const flag = raw.toLowerCase();
    if (!OWNED_FLAGS.has(flag)) {
      unknown.push(raw);
      continue;
    }
    if (seen.has(flag)) throw new Error(`Duplicate Valheim option: ${raw}`);
    seen.add(flag);
    if (flag === '-crossplay') {
      values.valheimBackend = 'crossplay';
      continue;
    }
    const next = input[++i];
    if (next == null) throw new Error(`Missing value for Valheim option: ${raw}`);
    const value = invalidText(next, `${raw} value`);
    if (flag === '-name') values.serverName = value;
    else if (flag === '-port') values.port = Number(value);
    else if (flag === '-world') values.worldName = value;
    else if (flag === '-password') values.password = value;
    else if (flag === '-savedir') values.valheimSaveDir = value;
    else if (flag === '-public') values.valheimPublic = value !== '0';
  }
  return { values, unknown };
}

function portPlan(desc) {
  const port = Number(desc.port);
  if (!Number.isInteger(port) || port < 1 || port > 65533) {
    throw new Error('Valheim requires three consecutive ports within 1..65535');
  }
  return Object.freeze({
    base: port,
    first: port,
    last: port + 2,
    ports: Object.freeze([port, port + 1, port + 2]),
    range: Object.freeze([port, port + 2]),
    evidenceSettled: false,
  });
}

function migrateDescriptor(input) {
  const original = { ...input, args: Array.isArray(input.args) ? [...input.args] : [] };
  if (input.valheimSchema === 1) return original;
  const parsed = parseArgs(original.args);
  const dir = path.resolve(String(input.dir || input.cwd || ''));
  return {
    ...original,
    ...parsed.values,
    type: 'valheim',
    valheimSchema: 1,
    dir,
    cwd: path.resolve(String(input.cwd || dir)),
    executable: path.resolve(String(input.executable || '')),
    args: original.args,
    port: Number(parsed.values.port ?? input.port ?? 2456),
    serverName: parsed.values.serverName ?? input.serverName ?? 'Hostkind server',
    worldName: parsed.values.worldName ?? input.worldName ?? 'Dedicated',
    valheimSaveDir: normalizeRelativeDir(parsed.values.valheimSaveDir ?? input.valheimSaveDir ?? 'data'),
    valheimBackend: normalizeBackend(parsed.values.valheimBackend ?? input.valheimBackend ?? 'steam'),
    valheimPublic: normalizePublic(parsed.values.valheimPublic ?? input.valheimPublic),
    valheimInstanceId: input.valheimInstanceId ?? null,
    valheimBuildId: input.valheimBuildId == null ? null : String(input.valheimBuildId),
    stopTimeoutSeconds: Number(input.stopTimeoutSeconds) || 90,
    valheimSettings: { ...(input.valheimSettings || {}) },
    valheimExtraArgs: Array.isArray(input.valheimExtraArgs) ? [...input.valheimExtraArgs] : parsed.unknown,
  };
}

function executableFor(desc, host = process.platform) {
  const root = path.resolve(desc.dir);
  const configured = String(desc.executable || '').trim();
  if (configured && /\.(?:bat|cmd|ps1|sh)$/i.test(configured)) throw new Error('Valheim launch wrappers are not supported');
  const expected = host === 'win32' ? 'valheim_server.exe' : 'valheim_server.x86_64';
  const candidate = configured || path.join(root, expected);
  const executable = realInside(root, candidate, 'Valheim executable');
  if (path.basename(executable).toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Unsupported Valheim executable; expected ${expected}`);
  }
  return executable;
}

function buildLaunch(input, host = process.platform) {
  const desc = migrateDescriptor(input);
  const executable = executableFor(desc, host);
  const cwd = realInside(desc.dir, desc.cwd || path.dirname(executable), 'Valheim working directory');
  const saveDir = normalizeRelativeDir(desc.valheimSaveDir);
  realInside(desc.dir, path.join(desc.dir, saveDir), 'Valheim save directory', true);
  const serverName = validateName(desc.serverName, 'Server name');
  // A clearer error than validateName's generic "invalid" message: this is
  // the state deleting the selected world (docs/valheim/03-worlds.md) leaves
  // a server in when no replacement was chosen, and the concrete mechanism
  // behind "it never points -world at missing data".
  if (!String(desc.worldName || '').trim()) {
    const err = new Error('No world is selected for this server. Choose a world before starting.');
    err.code = 'world_unselected';
    throw err;
  }
  const worldName = validateName(desc.worldName, 'World name');
  const password = validatePassword(desc.password);
  const backend = normalizeBackend(desc.valheimBackend);
  const ports = portPlan(desc);
  const parsed = parseArgs(desc.args);
  const extra = Array.isArray(desc.valheimExtraArgs) ? desc.valheimExtraArgs : parsed.unknown;
  for (const arg of extra) {
    const text = invalidText(arg, 'Argument');
    if (OWNED_FLAGS.has(text.toLowerCase())) throw new Error(`Hostkind-owned option cannot appear in extra arguments: ${text}`);
  }
  const args = [
    '-name', serverName,
    '-port', String(ports.base),
    '-world', worldName,
    '-password', password,
    '-savedir', path.join(desc.dir, saveDir),
    '-public', desc.valheimPublic ? '1' : '0',
    ...(backend === 'crossplay' ? ['-crossplay'] : []),
    ...extra,
  ];
  const env = {};
  if (host === 'linux') {
    const lib64 = path.join(desc.dir, 'linux64');
    if (fs.existsSync(lib64)) env.LD_LIBRARY_PATH = lib64;
  }
  return { executable, args, cwd, env };
}

function displayLaunch(planOrArgs) {
  const args = Array.isArray(planOrArgs) ? planOrArgs : planOrArgs.args;
  return args.map((arg, index) => String(args[index - 1]).toLowerCase() === '-password' ? '********' : arg);
}

module.exports = {
  OWNED_FLAGS, VALUE_FLAGS, normalizeRelativeDir, parseArgs, portPlan, migrateDescriptor,
  validatePassword, buildLaunch, displayLaunch, realInside,
};
