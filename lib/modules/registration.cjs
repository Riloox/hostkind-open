'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseCommand } = require('./custom/manager.cjs');
const { isVariant } = require('./terraria/variants.cjs');
const valheimLaunch = require('./valheim/launch.cjs');

const GAME_TYPES = new Set(['minecraft', 'terraria', 'valheim', 'palworld', 'custom']);
const SIGNALS = new Set(Object.keys(os.constants.signals));

function validPort(value, label = 'Port') {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
  }
  return port;
}

function existingDirectory(value) {
  const input = String(value || '').trim();
  if (!input) throw new Error('Choose an existing working directory');
  const dir = path.resolve(input);
  let stat;
  try { stat = fs.statSync(dir); } catch (_) {}
  if (!stat?.isDirectory()) throw new Error('Choose an existing working directory');
  return dir;
}

function executableInDirectory(dir, value) {
  const input = String(value || '').trim();
  if (!input) throw new Error('Executable is required');
  const executable = path.isAbsolute(input) ? path.resolve(input) : path.resolve(dir, input);
  const relative = path.relative(dir, executable);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Executable must be inside the working directory');
  }
  let stat;
  try { stat = fs.statSync(executable); } catch (_) {}
  if (!stat?.isFile()) throw new Error('Executable was not found');
  if (process.platform !== 'win32') {
    try { fs.accessSync(executable, fs.constants.X_OK); }
    catch { throw new Error('Executable is not executable'); }
  }
  return executable;
}

function executableOnPath(value) {
  const input = String(value || '').trim();
  if (!input || input.includes('/') || input.includes('\\')) return null;
  const names = process.platform === 'win32'
    ? [input, ...String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map(ext => input + ext.toLowerCase())]
    : [input];
  for (const folder of String(process.env.PATH || '').split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(folder, name);
      try {
        if (fs.statSync(candidate).isFile()) {
          if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        }
      } catch (_) {}
    }
  }
  return null;
}

/*
 * The Terraria variant, validated at registration and immutable afterwards.
 *
 * Omitting it means vanilla - the only Terraria server Hostkind could install
 * or register before variants existed - and the value is written to the
 * descriptor explicitly so nothing downstream has to re-infer it. An
 * unrecognized value is rejected outright: it must never quietly acquire
 * vanilla's binaries and save layout.
 */
function normalizeTerrariaVariant(value) {
  const variant = String(value == null ? '' : value).trim().toLowerCase();
  if (!variant) return 'vanilla';
  if (!isVariant(variant)) throw new Error(`Unknown Terraria variant: ${variant}`);
  return variant;
}

function normalizeArgs(value) {
  if (value == null || value === '') return [];
  const args = Array.isArray(value) ? value : parseCommand(value);
  if (!args.every(arg => typeof arg === 'string' && !/[\r\n\0]/.test(arg))) {
    throw new Error('Arguments must be an array of plain strings');
  }
  return [...args];
}

/*
 * Bound a health-check pattern before it is compiled. The pattern is a real
 * regular expression (it is later matched against server output), so it
 * cannot be escaped; instead, reject patterns whose complexity could turn a
 * log-line match into a denial of service (CodeQL js/regex-injection).
 * Syntax errors still surface from the caller's `new RegExp` with the same
 * error as before.
 */
function sanitizeRegex(value) {
  const source = String(value || '');
  if (source.length > 500) throw new Error('Health check regex is too long (max 500 characters).');
  if (/\([^()]*(?:[+*?]|\{\d+,?\d*\})[^()]*\)\s*[+*?]/.test(source)) {
    throw new Error('Health check regex contains nested repetition.');
  }
  return source;
}

function validateManualRegistration(body, { maxNameLength = 80 } = {}) {
  const type = String(body.gameType || body.type || '').toLowerCase();
  if (!GAME_TYPES.has(type)) throw new Error('Unknown game type');
  const name = String(body.name || '').trim();
  if (!name) throw new Error('Name is required');
  if (name.length > maxNameLength) throw new Error(`Name must be ${maxNameLength} characters or fewer`);
  const dir = existingDirectory(body.cwd || body.dir);

  if (type === 'minecraft') return { type, name, dir };

  let executable;
  let args;
  if (body.executable) {
    executable = type === 'custom'
      ? (executableOnPath(body.executable) || executableInDirectory(dir, body.executable))
      : executableInDirectory(dir, body.executable);
    args = normalizeArgs(body.args);
  } else {
    const command = parseCommand(body.startCommand);
    if (!command.length) throw new Error('Start command is required');
    executable = type === 'custom'
      ? (executableOnPath(command[0]) || executableInDirectory(dir, command[0]))
      : executableInDirectory(dir, command[0]);
    args = command.slice(1);
  }

  const stopCommand = String(body.stopCommand || '').trim();
  const stopSignal = String(body.stopSignal || '').trim() || 'SIGTERM';
  if (!stopCommand && !SIGNALS.has(stopSignal)) throw new Error(`Unknown stop signal: ${stopSignal}`);
  const healthCheckRegex = String(body.healthCheckRegex || '').trim();
  if (healthCheckRegex) new RegExp(sanitizeRegex(healthCheckRegex));

  const value = {
    type, name, dir, cwd: dir, executable, args, stopCommand, stopSignal,
    healthCheckRegex, stopTimeoutSeconds: 30,
  };
  if (type === 'terraria') value.terrariaVariant = normalizeTerrariaVariant(body.terrariaVariant);
  if (body.port != null && body.port !== '') value.port = validPort(body.port);
  if (type === 'valheim' && body.port != null && Number(body.port) > 65533) {
    throw new Error('Valheim requires three consecutive ports within 1..65535');
  }
  if (type === 'valheim') {
    const descriptor = valheimLaunch.migrateDescriptor({
      ...value,
      password: body.password,
      serverName: body.serverName,
      worldName: body.worldName,
      valheimSaveDir: body.valheimSaveDir,
      valheimBackend: body.valheimBackend,
      valheimPublic: body.valheimPublic,
    });
    valheimLaunch.buildLaunch(descriptor);
    return descriptor;
  }
  return value;
}

module.exports = { GAME_TYPES, validPort, existingDirectory, executableInDirectory, executableOnPath, normalizeArgs, normalizeTerrariaVariant, validateManualRegistration };
