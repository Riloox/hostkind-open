'use strict';

/*
 * Dedicated-server installation for the SteamCMD games (Valheim, Palworld).
 *
 * Terraria used to live here too. It now has its own module,
 * lib/terraria-install.cjs, because it grew three variants, a version list, a
 * validated archive, and a transactional install
 * (docs/terraria/01-installation-versions.md). The Terraria functions below are
 * thin delegations kept at their original names so existing callers - and
 * test/dedicated-server-installer.test.cjs - keep working unchanged.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { extractRuntimeArchive } = require('./runtimeArchive.cjs');
const terrariaInstall = require('./terraria-install.cjs');

const STEAM_APPS = Object.freeze({ valheim: 896660, palworld: 2394010 });

function steamCmdPackage(platform = process.platform) {
  if (platform === 'win32') return { url: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip', ext: 'zip', executable: 'steamcmd.exe' };
  if (platform === 'linux') return { url: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz', ext: 'tar.gz', executable: 'steamcmd.sh' };
  throw new Error('SteamCMD automatic installation is supported on Windows and Linux');
}

function run(bin, args, options, onLine = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const consume = (chunk) => {
      tail += chunk.toString('utf8');
      const lines = tail.split(/\r?\n/);
      tail = lines.pop() || '';
      for (const line of lines) if (line.trim()) onLine(line);
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (tail.trim()) onLine(tail);
      if (code === 0) resolve();
      else reject(new Error(`Installer exited with code ${code}`));
    });
  });
}

/*
 * SteamCMD ships as a self-updating bootstrapper: the archive we download is a
 * ~1.6 MB stub that replaces itself with the real client the first time it
 * runs. That first session never executes the commands it was given - it
 * applies the update, reports `Missing configuration` for the app, and exits 7
 * - so an install that invokes a freshly extracted SteamCMD always fails.
 *
 * The same thing happens again whenever the cached client goes stale, which is
 * why the retry below is not limited to first use.
 */
const STEAM_SELF_UPDATE = /missing configuration|downloading update \(|applying update|update complete, launching/i;

async function runSteam(bin, args, options, onLine = () => {}) {
  let selfUpdated = false;
  try {
    await run(bin, args, options, (line) => {
      if (STEAM_SELF_UPDATE.test(line)) selfUpdated = true;
      onLine(line);
    });
  } catch (error) {
    if (!selfUpdated || options?.signal?.aborted) throw error;
    // The client is up to date now, so the same command runs for real.
    await run(bin, args, options, onLine);
  }
}

async function ensureSteamCmd(cacheDir, download, onProgress = () => {}) {
  const pkg = steamCmdPackage();
  const root = path.join(cacheDir, 'steamcmd');
  const executable = path.join(root, pkg.executable);
  if (fs.existsSync(executable)) return executable;
  fs.mkdirSync(root, { recursive: true });
  const archive = path.join(cacheDir, `steamcmd.${pkg.ext}`);
  await download(pkg.url, archive, onProgress);
  extractRuntimeArchive(archive, root, pkg.ext);
  try { fs.unlinkSync(archive); } catch {}
  if (!fs.existsSync(executable)) throw new Error('SteamCMD was extracted but its executable was not found');
  if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
  // Spend the bootstrapper's self-update on a throwaway session rather than on
  // the caller's install. Its non-zero exit is the expected outcome here.
  try {
    await run(executable, ['+quit'], { cwd: root }, () => {});
  } catch {}
  return executable;
}

async function installSteamGame(type, destination, options) {
  const appId = STEAM_APPS[type];
  if (!appId) throw new Error('Unknown Steam dedicated server type');
  const steamcmd = await ensureSteamCmd(options.cacheDir, options.download, options.onProgress);
  options.onPhase('installing');
  await runSteam(steamcmd, [
    '+force_install_dir', destination,
    '+login', 'anonymous',
    '+app_update', String(appId), 'validate',
    '+quit',
  ], { cwd: path.dirname(steamcmd) }, options.onOutput);
}

/*
 * The current vanilla Terraria dedicated-server download.
 *
 * Kept at this name and shape (`{ url, version }`, where `version` is the
 * packed number in the archive name) because it is the published entry point;
 * lib/terraria-install.cjs owns the resolution and adds the dotted game
 * version alongside it.
 */
async function discoverTerrariaDownload(fetchText) {
  const release = await terrariaInstall.resolveDownload('vanilla', null, { fetchText, force: true });
  return { url: release.url, version: release.versionId, gameVersion: release.gameVersion };
}

function findFile(root, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (wanted.has(entry.name.toLowerCase())) return full;
    }
  }
  return null;
}

function locateExecutable(type, destination) {
  // Terraria's binary names, and the launch plan they belong to, live in
  // lib/terraria-install.cjs - which also resolves tModLoader's runtime, a
  // question a name lookup cannot answer.
  if (type === 'terraria') {
    return terrariaInstall.buildLaunchPlan('vanilla', destination, path.join(destination, 'serverconfig.txt'), {
      platform: process.platform,
      arch: process.arch,
      findRuntime: () => null,
    }).executable;
  }
  const names = type === 'valheim'
    ? (process.platform === 'win32' ? ['valheim_server.exe'] : ['valheim_server.x86_64'])
    : (process.platform === 'win32' ? ['PalServer.exe'] : ['PalServer.sh', 'PalServer-Linux-Shipping']);
  const executable = findFile(destination, names);
  if (!executable) throw new Error(`${type} installed, but its dedicated-server executable was not found`);
  if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
  return executable;
}

function launchArgs(type, input) {
  const port = Number(input.port);
  if (type === 'terraria') return ['-config', path.join(input.destination, 'serverconfig.txt')];
  if (type === 'valheim') return ['-name', input.serverName, '-port', String(port), '-world', input.worldName, '-password', input.password, '-public', input.public ? '1' : '0', '-nographics', '-batchmode'];
  return ['-port=' + port, '-players=' + Number(input.maxPlayers), '-useperfthreads', '-NoAsyncLoadingThread', '-UseMultithreadForDS', '-log'];
}

function writeConfiguration(type, input) {
  if (type === 'terraria') {
    const saveDir = path.join(input.destination, 'worlds');
    fs.mkdirSync(saveDir, { recursive: true });
    terrariaInstall.writeServerConfig(path.join(input.destination, 'serverconfig.txt'), {
      world: path.join(saveDir, `${input.worldName}.wld`),
      worldpath: saveDir,
      autocreate: input.worldSize,
      worldname: input.worldName,
      difficulty: input.difficulty,
      maxplayers: input.maxPlayers,
      port: input.port,
      password: input.password || '',
      secure: 1,
    });
  } else if (type === 'palworld') {
    const source = path.join(input.destination, 'DefaultPalWorldSettings.ini');
    if (!fs.existsSync(source)) throw new Error('Palworld installed without DefaultPalWorldSettings.ini');
    const platformFolder = process.platform === 'win32' ? 'WindowsServer' : 'LinuxServer';
    const target = path.join(input.destination, 'Pal', 'Saved', 'Config', platformFolder, 'PalWorldSettings.ini');
    const quote = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    let contents = fs.readFileSync(source, 'utf8');
    const settings = {
      ServerName: `"${quote(input.serverName)}"`,
      ServerPassword: `"${quote(input.password || '')}"`,
      AdminPassword: `"${quote(input.adminPassword)}"`,
      PublicPort: String(input.port),
      ServerPlayerMaxNum: String(input.maxPlayers),
      RESTAPIEnabled: 'True',
      RESTAPIPort: String(input.restPort),
    };
    for (const [key, value] of Object.entries(settings)) {
      const pattern = new RegExp(`(${key}=)("(?:[^"\\\\]|\\\\.)*"|[^,)]*)`);
      if (pattern.test(contents)) contents = contents.replace(pattern, `$1${value}`);
      else {
        const close = contents.lastIndexOf(')');
        if (close === -1) throw new Error("Palworld's default settings file is invalid");
        contents = `${contents.slice(0, close)},${key}=${value}${contents.slice(close)}`;
      }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, 'utf8');
  }
}

async function installDedicatedServer(type, input, options) {
  // Terraria installs transactionally through its own module: the destination
  // is only created once the whole install succeeded, so it is deliberately
  // not pre-created here.
  if (type === 'terraria') {
    const runtime = await terrariaInstall.install(input.terrariaVariant || 'vanilla', input, options);
    return { executable: runtime.executable, args: runtime.args, cwd: runtime.cwd, version: runtime.version, saveDir: runtime.saveDir };
  }
  if (type === 'valheim') {
    // Lazy loading avoids a CommonJS cycle: the Valheim provider reuses the
    // guarded SteamCMD downloader from this module.
    return require('./valheim-install.cjs').install(input, options);
  }
  fs.mkdirSync(input.destination, { recursive: true });
  options.onPhase('steamcmd');
  await installSteamGame(type, input.destination, options);
  writeConfiguration(type, input);
  const executable = locateExecutable(type, input.destination);
  return { executable, args: launchArgs(type, input) };
}

module.exports = {
  STEAM_APPS,
  steamCmdPackage,
  discoverTerrariaDownload,
  locateExecutable,
  launchArgs,
  writeConfiguration,
  installDedicatedServer,
  installSteamGame,
  ensureSteamCmd,
  run,
  runSteam,
};
