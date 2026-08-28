'use strict';

/*
 * Runtime composition for the application updater.
 *
 * The browser/API can be present in a Node development checkout, but binary
 * installation is only enabled when the process is a packaged Hostkind runtime
 * (or explicitly marked HOSTKIND_BINARY=1 by the binary launcher). This keeps
 * the source tree and its test fixtures safe while giving the installed .exe /
 * Linux executable a real release-client + installer composition.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createReleaseClient, SUPPORTED_PLATFORMS, DEFAULT_REPOSITORY } = require('./application-release.cjs');
const { createApplicationUpdater } = require('./application-updater.cjs');
const { fetchToFile } = require('./downloads.cjs');
const { validateArtifact } = require('../scripts/apply-application-update.cjs');

const DEFAULT_MANIFEST_URL = 'https://github.com/Riloox/hostkind-open/releases/latest/download/hostkind-update.json';
const UPDATE_ORIGIN_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

function platformKeyFor(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return 'windows-x64';
  if (platform === 'win32' && arch === 'arm64') return 'windows-arm64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  return null;
}

function isPackagedRuntime({ platform = process.platform, execPath = process.execPath, packaged = Boolean(process.pkg), env = process.env } = {}) {
  if (env && env.HOSTKIND_BINARY === '1') return true;
  if (packaged === true) return true;
  const base = path.basename(String(execPath || '')).toLowerCase();
  return platform === 'win32' ? base === 'hostkind.exe' : base === 'hostkind';
}

function runtimeError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.isUpdaterError = true;
  return error;
}

function createApplicationUpdateScheduler({
  service,
  intervalMs = 6 * 60 * 60 * 1000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  logger = console,
} = {}) {
  if (!service || typeof service.check !== 'function') {
    throw new TypeError('application update scheduler requires a service');
  }
  let timer = null;
  let inFlight = null;

  async function runOnce() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const checked = await service.check();
        const status = checked && checked.state
          ? checked
          : (typeof service.getStatus === 'function' ? service.getStatus() : checked);
        if (!status || status.state !== 'available' || status.priority !== 'high') return status;
        await service.download();
        const ready = typeof service.getStatus === 'function' ? service.getStatus() : null;
        if (!ready || ready.state !== 'ready') return ready;
        return service.install({ approved: false });
      } catch (error) {
        try {
          if (logger && typeof logger.warn === 'function') logger.warn('[application-updater] scheduled check failed', error);
        } catch { /* scheduler errors must not take down the panel */ }
        return typeof service.getStatus === 'function' ? service.getStatus() : { state: 'failed' };
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  function start({ runImmediately = true } = {}) {
    if (timer) return stop;
    if (runImmediately) void runOnce();
    timer = setIntervalImpl(() => { void runOnce(); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return stop;
  }

  function stop() {
    if (!timer) return;
    clearIntervalImpl(timer);
    timer = null;
  }

  return { runOnce, start, stop };
}

function createFileStateStore(filePath, { fsImpl = fs } = {}) {
  const target = path.resolve(filePath);
  return {
    read() {
      try {
        return JSON.parse(fsImpl.readFileSync(target, 'utf8'));
      } catch (error) {
        if (error && error.code === 'ENOENT') return null;
        // A corrupt local update record is not trusted. The next check can
        // recover, while the status remains deterministic rather than crashing
        // the panel boot.
        return null;
      }
    },
    write(_namespace, _key, value) {
      fsImpl.mkdirSync(path.dirname(target), { recursive: true });
      const temp = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`;
      fsImpl.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      fsImpl.renameSync(temp, target);
    },
  };
}

function readInstalledVersion({ installRoot, env = process.env, fsImpl = fs } = {}) {
  if (env.HOSTKIND_VERSION && /^\d+\.\d+\.\d+$/.test(String(env.HOSTKIND_VERSION))) return String(env.HOSTKIND_VERSION);
  const candidates = [
    path.join(installRoot, 'version.json'),
    path.join(installRoot, '.hostkind', 'version.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(candidate, 'utf8'));
      if (parsed && /^\d+\.\d+\.\d+$/.test(String(parsed.version))) return String(parsed.version);
    } catch { /* try the next source */ }
  }
  try {
    // Source/dev fallback only; packaged builds should ship version.json or set
    // HOSTKIND_VERSION so the updater never compares against Node's version.
    const pkg = require('../package.json');
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

function createUnsupportedService({ currentVersion, platformKey, reason }) {
  const status = {
    supported: false,
    state: 'idle',
    currentVersion,
    availableVersion: null,
    update: null,
    priority: null,
    platformKey,
    checkedAt: null,
    updatedAt: null,
    progress: null,
    releaseNotesUrl: null,
    error: { code: 'UNSUPPORTED_RUNTIME', message: reason },
  };
  const fail = async () => { throw runtimeError('UNSUPPORTED_RUNTIME', reason); };
  return {
    getStatus: () => ({ ...status, error: status.error ? { ...status.error } : null }),
    check: fail,
    download: fail,
    install: fail,
  };
}

function createManifestVerifier(publicKey) {
  let key = null;
  let keyError = null;
  if (publicKey) {
    try {
      key = publicKey && typeof publicKey === 'object' && publicKey.type
        ? publicKey
        : crypto.createPublicKey(String(publicKey));
    } catch (error) {
      keyError = runtimeError('VERIFICATION_ERROR', `Invalid application update public key: ${error.message}`);
    }
    if (key && key.asymmetricKeyType !== 'ed25519') {
      key = null;
      keyError = runtimeError('VERIFICATION_ERROR', 'Application update public key must be Ed25519');
    }
  }
  return async (manifest) => {
    if (keyError) throw keyError;
    if (!key) throw runtimeError('VERIFICATION_ERROR', 'Application update public key is not configured');
    if (!manifest || typeof manifest.manifestSignature !== 'string') {
      throw runtimeError('VERIFICATION_ERROR', 'Release manifest has no detached signature');
    }
    let signature;
    try { signature = Buffer.from(manifest.manifestSignature, 'base64'); }
    catch { throw runtimeError('VERIFICATION_ERROR', 'Release manifest signature is not valid base64'); }
    const unsigned = { ...manifest };
    delete unsigned.manifestSignature;
    const canonical = JSON.stringify(sortCanonical(unsigned));
    if (!crypto.verify(null, Buffer.from(canonical), key, signature)) {
      throw runtimeError('VERIFICATION_ERROR', 'Release manifest signature does not match the trusted public key');
    }
    return manifest;
  };
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = sortCanonical(value[key]);
      return out;
    }, {});
  }
  return value;
}

function createBinaryInstaller({ installRoot, platformKey, env = process.env, fetchImpl = globalThis.fetch, fsImpl = fs, spawnImpl = spawn, stateStore = null, now = () => Date.now() } = {}) {
  const stagingDir = path.join(installRoot, '.hostkind', 'staging');
  const helperScript = path.resolve(__dirname, '..', 'scripts', 'hostkind-bootstrap.cjs');
  const helperPath = env.HOSTKIND_UPDATE_HELPER || process.execPath;
  const launcherPath = env.HOSTKIND_LAUNCHER_PATH || (platformKey.startsWith('windows')
    ? path.join(installRoot, 'hostkind-launcher.exe')
    : path.join(installRoot, 'hostkind-launcher'));

  return {
    async download({ artifact, onProgress }) {
      const validated = validateArtifact(artifact);
      const target = path.join(stagingDir, validated.name);
      const result = await fetchToFile(validated.url, target, {
        expectedSha256: validated.sha256,
        fetchImpl,
        allowlist: (host) => UPDATE_ORIGIN_HOSTS.has(String(host).toLowerCase()),
        onProgress: (downloadedBytes, totalBytes) => {
          const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : null;
          if (typeof onProgress === 'function') onProgress({ percent, downloadedBytes, totalBytes });
        },
      });
      return { packagePath: result.path };
    },
    async install({ packagePath, version, priority, expectedSha256 }) {
      if (typeof packagePath !== 'string' || !packagePath) throw runtimeError('INSTALLER_ERROR', 'staged application package is missing');
      const args = [
        ...(env.HOSTKIND_UPDATE_HELPER ? [] : [helperScript]),
        '--install-root', installRoot,
        '--version', version,
        '--staged-path', packagePath,
        '--expected-sha256', expectedSha256,
        '--platform-key', platformKey,
        '--launcher-path', launcherPath,
        '--current-pid', String(process.pid),
      ];
      if (env.HOSTKIND_UPDATE_HEALTH_URL) args.push('--health-url', env.HOSTKIND_UPDATE_HEALTH_URL);
      const child = spawnImpl(helperPath, args, {
        cwd: installRoot,
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
        env: { ...env, HOSTKIND_UPDATE_PRIORITY: priority || 'normal' },
      });
      const handleHelperError = (error) => {
        if (!stateStore || typeof stateStore.write !== 'function') return;
        try {
          stateStore.write('application-update', 'state', {
            state: 'failed',
            updatedAt: now(),
            error: {
              code: 'HELPER_SPAWN_FAILED',
              message: error && error.message ? error.message : String(error),
            },
          });
        } catch { /* a logging failure must not crash the running panel */ }
      };
      if (child && typeof child.once === 'function') child.once('error', handleHelperError);
      else if (child && typeof child.on === 'function') child.on('error', handleHelperError);
      if (child && typeof child.unref === 'function') child.unref();
      return { ok: true, restarting: true };
    },
  };
}

function createApplicationUpdateRuntime(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const execPath = options.execPath || process.execPath;
  const packaged = options.packaged === undefined ? Boolean(process.pkg) : options.packaged;
  const platformKey = options.platformKey || platformKeyFor(platform, arch);
  const installRoot = options.installRoot || env.HOSTKIND_INSTALL_ROOT || path.dirname(execPath);
  const currentVersion = options.currentVersion || readInstalledVersion({ installRoot, env });

  if (!platformKey || !SUPPORTED_PLATFORMS.has(platformKey) || !isPackagedRuntime({ platform, execPath, packaged, env })) {
    const reason = !platformKey || !SUPPORTED_PLATFORMS.has(platformKey)
      ? `application updates are not supported on platform ${platform}/${arch}`
      : 'application updates are available only in an installed Hostkind binary';
    return { supported: false, platformKey, installRoot, currentVersion, service: createUnsupportedService({ currentVersion, platformKey, reason }) };
  }

  const statePath = env.HOSTKIND_UPDATE_STATE_PATH || path.join(installRoot, '.hostkind', 'update-state.json');
  const stateStore = options.stateStore || createFileStateStore(statePath);
  const publicKey = options.publicKey || env.HOSTKIND_UPDATE_PUBLIC_KEY;
  const verifyManifest = options.verifyManifest || createManifestVerifier(publicKey);
  const releaseClient = options.releaseClient || createReleaseClient({
    fetchImpl: options.fetchImpl || globalThis.fetch,
    repository: env.HOSTKIND_UPDATE_REPOSITORY || DEFAULT_REPOSITORY,
    manifestUrl: env.HOSTKIND_UPDATE_MANIFEST_URL || DEFAULT_MANIFEST_URL,
    verifyManifest,
  });
  const installer = options.installer || createBinaryInstaller({
    installRoot,
    platformKey,
    env,
    fetchImpl: options.fetchImpl || globalThis.fetch,
    spawnImpl: options.spawnImpl || spawn,
    stateStore,
  });
  const service = createApplicationUpdater({
    releaseClient,
    installer,
    stateStore,
    platformKey,
    currentVersion,
    now: options.now || (() => Date.now()),
  });
  return {
    supported: true,
    platformKey,
    installRoot,
    currentVersion,
    service,
    scheduler: createApplicationUpdateScheduler({
      service,
      intervalMs: Number(env.HOSTKIND_UPDATE_CHECK_INTERVAL_MS) > 0 ? Number(env.HOSTKIND_UPDATE_CHECK_INTERVAL_MS) : undefined,
      logger: options.logger || console,
    }),
  };
}

module.exports = {
  DEFAULT_MANIFEST_URL,
  platformKeyFor,
  isPackagedRuntime,
  createFileStateStore,
  readInstalledVersion,
  createManifestVerifier,
  createApplicationUpdateScheduler,
  createBinaryInstaller,
  createApplicationUpdateRuntime,
};
