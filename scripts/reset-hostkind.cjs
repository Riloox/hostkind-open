'use strict';

// SPDX-License-Identifier: AGPL-3.0-only

/*
 * Reset a Hostkind installation back to its first-run state.
 *
 * The application keeps credentials/configuration in config.json, operational
 * state in data/, and downloaded installers/runtimes in cache directories. A
 * reset removes those items but deliberately leaves registered server folders
 * alone unless --include-servers is explicitly selected.
 *
 * This is intentionally a standalone Node script: release archives can run it
 * without npm, and every process launch uses an argument array with shell:false.
 * The CLI never offers a non-interactive confirmation bypass.
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline/promises');
const { spawn } = require('child_process');

const RESET_CONFIRMATION = 'RESET HOSTKIND';
const SERVER_DELETE_CONFIRMATION = 'DELETE SERVERS';
const FOLDER_PICKER_CACHE_NAME = 'fleetdeck-folder-picker';

const PROTECTED_RELATIVE_PATHS = [
  'server.js',
  'lib',
  'public',
  'scripts',
  'electron',
  'resources',
  'package.json',
  'package-lock.json',
  'config.example.json',
  'i18n.cjs',
  'i18n.json',
  'README.md',
  'LICENSE',
];

function detectInstallRoot() {
  return path.resolve(__dirname, '..');
}

function resolvePath(value, fallback) {
  return path.resolve(String(value || fallback));
}

function comparisonKey(value) {
  const resolved = path.resolve(String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return comparisonKey(left) === comparisonKey(right);
}

function isWithin(candidate, parent) {
  const child = path.resolve(String(candidate));
  const base = path.resolve(String(parent));
  const relative = path.relative(base, child);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

function isFilesystemRoot(candidate) {
  const resolved = path.resolve(String(candidate));
  return samePath(path.parse(resolved).root, resolved);
}

function uniquePaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const resolved = path.resolve(String(value));
    const key = comparisonKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

/**
 * Resolve the paths used by both the source distribution and Electron's
 * external user-data layout. The environment variables mirror server.js and
 * electron/runtime.cjs, so the reset cannot accidentally target a second copy.
 */
function resolveResetPaths({ root = detectInstallRoot(), env = process.env, osImpl = os } = {}) {
  const installRoot = path.resolve(String(root));
  const userData = env.HOSTKIND_USER_DATA ? path.resolve(env.HOSTKIND_USER_DATA) : null;
  const localData = env.LOCALAPPDATA ? path.resolve(env.LOCALAPPDATA) : null;
  const desktopCacheRoot = userData && localData ? path.join(localData, 'Hostkind') : null;
  const configPath = resolvePath(
    env.FLEETDECK_CONFIG,
    userData ? path.join(userData, 'config.json') : path.join(installRoot, 'config.json'),
  );
  const dataDir = resolvePath(
    env.FLEETDECK_DATA_DIR || env.LODESTONE_DATA_DIR,
    userData ? path.join(userData, 'data') : path.join(installRoot, 'data'),
  );
  const installerCache = resolvePath(
    env.FLEETDECK_INSTALLER_CACHE,
    desktopCacheRoot ? path.join(desktopCacheRoot, 'installer-cache') : path.join(installRoot, 'resources', 'installers'),
  );
  const runtimesDir = resolvePath(
    env.FLEETDECK_RUNTIMES_DIR,
    desktopCacheRoot ? path.join(desktopCacheRoot, 'runtimes') : path.join(installRoot, 'runtimes'),
  );
  const folderPickerCacheDir = resolvePath(
    env.FLEETDECK_FOLDER_PICKER_CACHE,
    path.join(osImpl.tmpdir(), FOLDER_PICKER_CACHE_NAME),
  );
  const configDir = path.dirname(configPath);

  return {
    root: installRoot,
    configPath,
    dataDir,
    installerCache,
    runtimesDir,
    metricsPath: path.join(installRoot, 'metrics.json'),
    runningPath: path.join(configDir, 'running.json'),
    initialPasswordPath: path.join(configDir, 'initial-admin-password.txt'),
    folderPickerCacheDir,
    buildCacheDir: path.join(installRoot, '.cache'),
    parcelCacheDir: path.join(installRoot, '.parcel-cache'),
    eslintCachePath: path.join(installRoot, '.eslintcache'),
  };
}

function normalizeResetPaths(input = {}) {
  const root = path.resolve(String(input.root || detectInstallRoot()));
  const configPath = resolvePath(input.configPath, path.join(root, 'config.json'));
  const configDir = path.dirname(configPath);
  return {
    root,
    configPath,
    dataDir: resolvePath(input.dataDir, path.join(root, 'data')),
    installerCache: resolvePath(input.installerCache, path.join(root, 'resources', 'installers')),
    runtimesDir: resolvePath(input.runtimesDir, path.join(root, 'runtimes')),
    metricsPath: resolvePath(input.metricsPath, path.join(root, 'metrics.json')),
    runningPath: resolvePath(input.runningPath, path.join(configDir, 'running.json')),
    initialPasswordPath: resolvePath(input.initialPasswordPath, path.join(configDir, 'initial-admin-password.txt')),
    folderPickerCacheDir: resolvePath(input.folderPickerCacheDir, path.join(os.tmpdir(), FOLDER_PICKER_CACHE_NAME)),
    buildCacheDir: resolvePath(input.buildCacheDir, path.join(root, '.cache')),
    parcelCacheDir: resolvePath(input.parcelCacheDir, path.join(root, '.parcel-cache')),
    eslintCachePath: resolvePath(input.eslintCachePath, path.join(root, '.eslintcache')),
  };
}

function protectedPaths(root) {
  return PROTECTED_RELATIVE_PATHS.map((relative) => path.join(root, relative));
}

function lstatIfPresent(target, fsImpl) {
  try {
    return fsImpl.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

// Refuse links in every existing component, not only at the final target. A
// junction or symlink in a user-controlled path must not redirect rmSync.
function assertNoSymlinkInPath(target, fsImpl) {
  const resolved = path.resolve(String(target));
  const root = path.parse(resolved).root;
  let current = root;
  const relative = path.relative(root, resolved);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatIfPresent(current, fsImpl);
    if (stat && stat.isSymbolicLink()) {
      throw new Error(`refusing to reset a path that traverses a symbolic link: ${resolved}`);
    }
  }
}

function assertPathSafe(candidate, {
  kind,
  paths,
  fsImpl = fs,
  osImpl = os,
  allowedDirectory = null,
} = {}) {
  const resolved = path.resolve(String(candidate));
  if (!resolved || isFilesystemRoot(resolved)) {
    throw new Error(`refusing unsafe ${kind} path: ${resolved || '<empty>'}`);
  }

  const shipped = protectedPaths(paths.root);
  for (const protectedPath of shipped) {
    const candidateContainsShipped = isWithin(protectedPath, resolved);
    const candidateIsInsideShipped = isWithin(resolved, protectedPath);

    if (kind === 'server') {
      if (candidateContainsShipped || candidateIsInsideShipped) {
        throw new Error(`unsafe server directory: ${resolved} overlaps the Hostkind install path ${protectedPath}`);
      }
      continue;
    }

    if (candidateContainsShipped) {
      throw new Error(`refusing unsafe reset target: ${resolved} would include shipped Hostkind files`);
    }
    if (candidateIsInsideShipped && !(
      kind === 'directory' &&
      allowedDirectory &&
      samePath(resolved, allowedDirectory) &&
      !samePath(resolved, protectedPath)
    )) {
      throw new Error(`refusing unsafe reset target inside the shipped Hostkind tree: ${resolved}`);
    }
  }

  if (kind === 'server' && isWithin(osImpl.homedir(), resolved)) {
    throw new Error(`unsafe server directory: ${resolved} would include the user home directory`);
  }

  assertNoSymlinkInPath(resolved, fsImpl);
  const stat = lstatIfPresent(resolved, fsImpl);
  if (stat && stat.isSymbolicLink()) {
    throw new Error(`refusing to reset a symbolic link: ${resolved}`);
  }
  if (kind === 'file' && stat && stat.isDirectory()) {
    throw new Error(`refusing to reset a directory where a file was expected: ${resolved}`);
  }
  if ((kind === 'directory' || kind === 'server') && stat && !stat.isDirectory()) {
    throw new Error(`refusing to reset a file where a directory was expected: ${resolved}`);
  }
}

function readConfig(configPath, fsImpl = fs) {
  const stat = lstatIfPresent(configPath, fsImpl);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`cannot read Hostkind configuration file: ${configPath}`);
  }
  let raw;
  try {
    raw = fsImpl.readFileSync(configPath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read Hostkind configuration file ${configPath}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`cannot parse Hostkind configuration file ${configPath}: ${error.message}`);
  }
}

function collectServerDirectories(config, { root } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return [];
  const raw = [];
  if (typeof config.serverDir === 'string' && config.serverDir.trim()) {
    raw.push(config.serverDir.trim());
  }
  if (Array.isArray(config.servers)) {
    for (const server of config.servers) {
      if (server && typeof server.dir === 'string' && server.dir.trim()) {
        raw.push(server.dir.trim());
      }
    }
  }
  return uniquePaths(raw.map((value) => path.resolve(root || detectInstallRoot(), value)));
}

function environmentCredentialPaths(root, fsImpl = fs) {
  let entries;
  try {
    entries = fsImpl.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .map((entry) => entry.name)
    .filter((name) => name === '.env' || name.startsWith('.env.'))
    .filter((name) => name !== '.env.example' && name !== '.env.sample')
    .map((name) => path.join(root, name));
}

function targetEntries(paths, fsImpl = fs) {
  return {
    files: [
      { label: 'config, users, and credentials', path: paths.configPath, kind: 'file' },
      ...environmentCredentialPaths(paths.root, fsImpl).map((filePath) => ({
        label: 'local environment credentials',
        path: filePath,
        kind: 'file',
      })),
      { label: 'running-server state', path: paths.runningPath, kind: 'file' },
      { label: 'initial admin credential file', path: paths.initialPasswordPath, kind: 'file' },
      { label: 'metrics cache', path: paths.metricsPath, kind: 'file' },
      { label: 'eslint cache', path: paths.eslintCachePath, kind: 'file' },
    ],
    directories: [
      { label: 'application database and state', path: paths.dataDir, kind: 'directory' },
      { label: 'dedicated-server installer cache', path: paths.installerCache, kind: 'directory' },
      { label: 'managed runtime cache', path: paths.runtimesDir, kind: 'directory' },
      { label: 'build cache', path: paths.buildCacheDir, kind: 'directory' },
      { label: 'folder-picker cache', path: paths.folderPickerCacheDir, kind: 'directory' },
      { label: 'parcel cache', path: paths.parcelCacheDir, kind: 'directory' },
    ],
  };
}

function assertNoTargetOverlap(entries) {
  const all = [...entries.files, ...entries.directories];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      if (pathsOverlap(all[i].path, all[j].path)) {
        throw new Error(`reset targets overlap: ${all[i].path} and ${all[j].path}`);
      }
    }
  }
}

/**
 * Build and validate the complete deletion plan without changing the disk.
 * Server directories enter the plan only when includeServers is true.
 */
function buildResetPlan({ paths: inputPaths, config = null, includeServers = false, fsImpl = fs, osImpl = os } = {}) {
  const paths = normalizeResetPaths(inputPaths || {});
  const entries = targetEntries(paths, fsImpl);
  assertNoTargetOverlap(entries);

  for (const entry of [...entries.files, ...entries.directories]) {
    assertPathSafe(entry.path, {
      kind: entry.kind,
      paths,
      fsImpl,
      osImpl,
      allowedDirectory: paths.installerCache,
    });
  }

  const configuredServerDirs = collectServerDirectories(config, { root: paths.root });
  for (const configuredServerDir of configuredServerDirs) {
    for (const entry of [...entries.files, ...entries.directories]) {
      if (pathsOverlap(configuredServerDir, entry.path)) {
        throw new Error(`unsafe server directory: ${configuredServerDir} overlaps reset target ${entry.path}`);
      }
    }
  }

  const serverDirs = includeServers ? configuredServerDirs : [];
  for (const serverDir of serverDirs) {
    assertPathSafe(serverDir, { kind: 'server', paths, fsImpl, osImpl });
  }
  for (let i = 0; i < serverDirs.length; i += 1) {
    for (let j = i + 1; j < serverDirs.length; j += 1) {
      if (pathsOverlap(serverDirs[i], serverDirs[j])) {
        throw new Error(`unsafe server directory overlap: ${serverDirs[i]} and ${serverDirs[j]}`);
      }
    }
  }

  return {
    paths,
    files: entries.files,
    directories: entries.directories,
    serverDirs,
    includeServers: Boolean(includeServers),
  };
}

function readRunningState(runningPath, fsImpl = fs) {
  const stat = lstatIfPresent(runningPath, fsImpl);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`cannot inspect running-server state: ${runningPath}`);
  }
  try {
    return JSON.parse(fsImpl.readFileSync(runningPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot parse running-server state ${runningPath}: ${error.message}`);
  }
}

function findLiveServerPids(state, isRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}) {
  if (!state || typeof state !== 'object') return [];
  const records = Array.isArray(state) ? state : Object.values(state);
  const pids = [];
  for (const record of records) {
    const pid = record && Number(record.pid);
    if (!Number.isInteger(pid) || pid <= 0 || !isRunning(pid)) continue;
    if (!pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

function isPortListening({ port, host = '127.0.0.1', netImpl = net, timeoutMs = 750 } = {}) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    let socket;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { if (socket) socket.destroy(); } catch { /* best effort */ }
      resolve(value);
    };
    try {
      socket = netImpl.createConnection({ host, port: numericPort });
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('timeout', () => finish(false));
      socket.setTimeout(timeoutMs);
    } catch {
      finish(false);
    }
  });
}

async function assertHostkindStopped(config, { netImpl = net } = {}) {
  if (!config || typeof config !== 'object') return;
  const panelPort = Number(config.panelPort);
  if (!Number.isInteger(panelPort) || panelPort < 1 || panelPort > 65535) return;
  let host = typeof config.panelHost === 'string' && config.panelHost.trim()
    ? config.panelHost.trim()
    : '127.0.0.1';
  if (host === '0.0.0.0' || host === '::' || host === '::0') host = '127.0.0.1';
  if (await isPortListening({ port: panelPort, host, netImpl })) {
    throw new Error(`Hostkind appears to be running on ${host}:${panelPort}; stop the panel before resetting it`);
  }
}

function formatResetPlan(plan, step) {
  const lines = [];
  if (step === 'servers') {
    lines.push('This will permanently delete the registered Hostkind server folders below.');
    if (plan.serverDirs.length) {
      for (const serverDir of plan.serverDirs) lines.push(`  - ${serverDir}`);
    } else {
      lines.push('  - No registered server folders were found.');
    }
    lines.push('Server files, worlds, saves, mods, and plugins in these folders cannot be recovered by Hostkind.');
    return lines.join('\n');
  }

  lines.push('This will permanently reset Hostkind credentials, configuration, application state, and caches.');
  lines.push('The following will be removed:');
  for (const entry of [...plan.files, ...plan.directories]) {
    lines.push(`  - ${entry.label}: ${entry.path}`);
  }
  if (plan.includeServers) {
    lines.push('Registered server folders are also selected for deletion; a second confirmation is required.');
  } else {
    lines.push('Registered server folders will be preserved.');
  }
  lines.push('Stop Hostkind and all game servers before continuing.');
  return lines.join('\n');
}

function createInteractiveConfirm({ input = process.stdin, output = process.stdout } = {}) {
  return async ({ expectedToken, message }) => {
    if (!input.isTTY || !output.isTTY) {
      throw new Error('reset requires an interactive terminal; no files were changed');
    }
    const prompt = readline.createInterface({ input, output });
    try {
      const answer = await prompt.question(`\n${message}\n\nType ${expectedToken} to continue: `);
      return answer.trim() === expectedToken;
    } finally {
      prompt.close();
    }
  };
}

function removeEntry(entry, plan, fsImpl) {
  // Re-check immediately before each sink so a race that replaces a target
  // with a link or broadens its scope fails closed instead of following it.
  assertPathSafe(entry.path, {
    kind: entry.kind,
    paths: plan.paths,
    fsImpl,
    allowedDirectory: plan.paths.installerCache,
  });
  if (!fsImpl.existsSync(entry.path)) return false;
  fsImpl.rmSync(entry.path, { recursive: entry.kind !== 'file', force: true });
  return true;
}

function startPanel({ root, env = process.env, fsImpl = fs, spawnImpl = spawn } = {}) {
  const serverPath = path.join(root, 'server.js');
  const stat = lstatIfPresent(serverPath, fsImpl);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`cannot restart Hostkind: server.js is missing from ${root}`);
  }
  return new Promise((resolve, reject) => {
    let child;
    const options = {
      cwd: root,
      env: { ...env },
      shell: false,
      detached: true,
      stdio: 'inherit',
    };
    try {
      child = spawnImpl(process.execPath, [serverPath], options);
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('spawn', () => {
      if (settled) return;
      try {
        child.unref();
      } catch (error) {
        settled = true;
        reject(error);
        return;
      }
      settled = true;
      resolve({ started: true, pid: child.pid, code: null, signal: null });
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ started: false, pid: child.pid, code, signal });
    });
  });
}

/**
 * Reset Hostkind after the complete plan has been confirmed. `start` defaults
 * to true for the CLI's restart behavior; tests and operators doing a staged
 * reset can pass start:false.
 */
async function resetHostkind({
  paths: inputPaths,
  root = detectInstallRoot(),
  env = process.env,
  config: suppliedConfig,
  includeServers = false,
  start = true,
  confirm,
  fsImpl = fs,
  osImpl = os,
  netImpl = net,
  isRunning,
  spawnImpl = spawn,
} = {}) {
  const paths = inputPaths
    ? normalizeResetPaths(inputPaths)
    : resolveResetPaths({ root, env, osImpl });
  const config = Object.prototype.hasOwnProperty.call(arguments[0] || {}, 'config')
    ? suppliedConfig
    : readConfig(paths.configPath, fsImpl);
  const plan = buildResetPlan({ paths, config, includeServers, fsImpl, osImpl });

  const runningState = readRunningState(paths.runningPath, fsImpl);
  const livePids = findLiveServerPids(runningState, isRunning);
  if (livePids.length) {
    throw new Error(`game servers are still running (PID${livePids.length === 1 ? '' : 's'} ${livePids.join(', ')}); stop them before resetting Hostkind`);
  }
  await assertHostkindStopped(config, { netImpl });

  const ask = confirm || createInteractiveConfirm();
  const firstToken = await ask({
    expectedToken: RESET_CONFIRMATION,
    step: 'reset',
    plan,
    message: formatResetPlan(plan, 'reset'),
  });
  if (!firstToken) return { ok: false, cancelled: true, started: false };

  const secondExpected = plan.includeServers ? SERVER_DELETE_CONFIRMATION : RESET_CONFIRMATION;
  const secondToken = await ask({
    expectedToken: secondExpected,
    step: plan.includeServers ? 'servers' : 'reset-again',
    plan,
    message: formatResetPlan(plan, plan.includeServers ? 'servers' : 'reset'),
  });
  if (!secondToken) return { ok: false, cancelled: true, started: false };

  const removed = [];
  for (const entry of plan.files) {
    if (removeEntry(entry, plan, fsImpl)) removed.push(entry.path);
  }
  for (const entry of plan.directories) {
    if (removeEntry(entry, plan, fsImpl)) removed.push(entry.path);
  }
  const removedServers = [];
  for (const serverDir of plan.serverDirs) {
    const entry = { label: 'registered server directory', path: serverDir, kind: 'server' };
    if (removeEntry(entry, plan, fsImpl)) {
      removed.push(serverDir);
      removedServers.push(serverDir);
    }
  }

  if (start === false) {
    return {
      ok: true,
      cancelled: false,
      started: false,
      removed,
      removedServers,
    };
  }

  const startResult = await startPanel({
    root: paths.root,
    env,
    fsImpl,
    spawnImpl,
  });
  const startedCleanly = startResult.started === true || (startResult.code === 0 && !startResult.signal);
  return {
    ok: startedCleanly,
    cancelled: false,
    started: true,
    startResult,
    removed,
    removedServers,
  };
}

function parseArgs(argv) {
  const parsed = { includeServers: false, start: true, help: false };
  for (const arg of argv) {
    if (arg === '--include-servers' || arg === '--delete-servers' || arg === '--servers') {
      parsed.includeServers = true;
    } else if (arg === '--no-start') {
      parsed.start = false;
    } else if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return parsed;
}

function printHelp() {
  console.log('Usage: node scripts/reset-hostkind.cjs [--include-servers] [--no-start]');
  console.log('');
  console.log('Resets credentials, config, application state, and caches, then restarts Hostkind.');
  console.log('Server folders are preserved unless --include-servers is selected.');
  console.log('Both modes require two exact confirmations. The server mode uses a separate deletion token.');
  console.log('Use --no-start to reset without launching server.js afterwards.');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`reset-hostkind: ${error.message}`);
    console.error('Use --help for usage.');
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    printHelp();
    return;
  }

  try {
    const result = await resetHostkind({
      includeServers: args.includeServers,
      start: args.start,
    });
    if (result.cancelled) {
      console.log('Reset cancelled. No files were changed.');
      return;
    }
    if (!result.ok) {
      console.error(`Hostkind reset completed, but the restarted panel exited unsuccessfully (code=${result.startResult.code}, signal=${result.startResult.signal || 'none'}).`);
      process.exitCode = 1;
      return;
    }
    console.log('Hostkind reset complete.');
    if (result.started) {
      console.log(`The fresh panel process was started in the background (PID ${result.startResult.pid}).`);
    } else {
      console.log('Hostkind was not started. Run npm start when ready.');
    }
  } catch (error) {
    console.error(`reset-hostkind: ${error && error.message ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  RESET_CONFIRMATION,
  SERVER_DELETE_CONFIRMATION,
  resolveResetPaths,
  normalizeResetPaths,
  collectServerDirectories,
  buildResetPlan,
  findLiveServerPids,
  isPortListening,
  formatResetPlan,
  parseArgs,
  resetHostkind,
  startPanel,
};
