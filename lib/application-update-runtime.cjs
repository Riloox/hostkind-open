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
const { createReleaseClient, SUPPORTED_PLATFORMS, DEFAULT_REPOSITORY, normalizeInstalledVersion, isStrictVersion } = require('./application-release.cjs');
const { createApplicationUpdater } = require('./application-updater.cjs');
const { fetchToFile } = require('./downloads.cjs');
const { validateArtifact } = require('../scripts/apply-application-update.cjs');

const DEFAULT_MANIFEST_URL = 'https://github.com/Riloox/hostkind-open/releases/latest/download/hostkind-update.json';
// Built-in Ed25519 release-signing public key. This is public by design and
// ships in the open source tree so installed binaries verify update
// manifests out of the box. HOSTKIND_UPDATE_PUBLIC_KEY (or the injected
// publicKey option) overrides it for rotation and testing. The matching
// private key lives only in the open repo's HOSTKIND_UPDATE_PRIVATE_KEY
// Actions secret and is never shipped.
const BUILTIN_UPDATE_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MCowBQYDK2VwAyEA4N0rX/2SfUBdHYcTdldOfUvpGh6yUgk+5xWXH7htRz0=',
  '-----END PUBLIC KEY-----',
].join('\n');
// Release artifacts are 100+ MB; the shared download helper's timeout covers
// the whole body, so its 30 s default would abort slower connections.
const UPDATE_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
// Electron desktop bridge: the backend runs in a utilityProcess, so it asks
// the main process (electron/main.cjs) to launch the NSIS installer and quit.
const DESKTOP_RUN_INSTALLER = 'hostkind:update:run-installer';
const DESKTOP_RUN_INSTALLER_RESULT = 'hostkind:update:run-installer:result';
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

// Set by electron/main.cjs for packaged desktop builds only.
function isDesktopRuntime(env = process.env) {
  return Boolean(env) && env.HOSTKIND_DESKTOP_UPDATE === '1';
}

function isPackagedRuntime({ platform = process.platform, execPath = process.execPath, packaged = Boolean(process.pkg), env = process.env } = {}) {
  if (env && env.HOSTKIND_BINARY === '1') return true;
  if (isDesktopRuntime(env)) return true;
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
  // Phase 2B: single-flight scoped by caller key (server/user) instead of one
  // global slot, so concurrent checks for different scopes don't serialize
  // behind each other while the same scope still never overlaps itself.
  const inFlightByKey = new Map();

  async function runOnce(scopeKey = 'default') {
    const key = String(scopeKey || 'default');
    const existing = inFlightByKey.get(key);
    if (existing) return existing;
    const task = (async () => {
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
        inFlightByKey.delete(key);
      }
    })();
    inFlightByKey.set(key, task);
    return task;
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
  if (typeof env.HOSTKIND_VERSION === 'string' && isStrictVersion(env.HOSTKIND_VERSION.trim())) {
    return normalizeInstalledVersion(String(env.HOSTKIND_VERSION).trim());
  }
  const candidates = [
    path.join(installRoot, 'version.json'),
    path.join(installRoot, '.hostkind', 'version.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(candidate, 'utf8'));
      if (parsed && typeof parsed.version === 'string' && isStrictVersion(parsed.version.trim())) {
        return normalizeInstalledVersion(String(parsed.version).trim());
      }
    } catch { /* try the next source */ }
  }
  try {
    // Source/dev fallback only; packaged builds should ship version.json or set
    // HOSTKIND_VERSION so the updater never compares against Node's version.
    const pkg = require('../package.json');
    if (typeof pkg.version === 'string' && isStrictVersion(pkg.version.trim())) {
      return normalizeInstalledVersion(pkg.version.trim());
    }
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

async function downloadArtifact({ artifact, stagingDir, fetchImpl, onProgress }) {
  const validated = validateArtifact(artifact);
  const target = path.join(stagingDir, validated.name);
  const result = await fetchToFile(validated.url, target, {
    expectedSha256: validated.sha256,
    fetchImpl,
    timeoutMs: UPDATE_DOWNLOAD_TIMEOUT_MS,
    allowlist: (host) => UPDATE_ORIGIN_HOSTS.has(String(host).toLowerCase()),
    onProgress: (downloadedBytes, totalBytes) => {
      const percent = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : null;
      if (typeof onProgress === 'function') onProgress({ percent, downloadedBytes, totalBytes });
    },
  });
  return { packagePath: result.path };
}

function createBinaryInstaller({ installRoot, platformKey, env = process.env, fetchImpl = globalThis.fetch, fsImpl = fs, spawnImpl = spawn, stateStore = null, now = () => Date.now() } = {}) {
  const stagingDir = path.join(installRoot, '.hostkind', 'staging');
  const helperScript = path.resolve(__dirname, '..', 'scripts', 'hostkind-bootstrap.cjs');
  const helperPath = env.HOSTKIND_UPDATE_HELPER || process.execPath;
  const launcherPath = env.HOSTKIND_LAUNCHER_PATH || (platformKey.startsWith('windows')
    ? path.join(installRoot, 'hostkind-launcher.exe')
    : path.join(installRoot, 'hostkind-launcher'));

  return {
    download({ artifact, onProgress }) {
      return downloadArtifact({ artifact, stagingDir, fetchImpl, onProgress });
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

function sha256File(filePath, fsImpl = fs) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsImpl.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Ask the Electron main process to launch the staged installer. Resolves once
 * the main process confirms the installer started (it then quits the app so
 * NSIS can replace the files); rejects on refusal, spawn failure or timeout.
 * The timeout is generous because the main process confirms only after the
 * user answers the UAC prompt.
 */
function createParentPortInstallRequester({ parentPort = process.parentPort, timeoutMs = 10 * 60_000 } = {}) {
  let seq = 0;
  const pending = new Map();
  if (parentPort && typeof parentPort.on === 'function') {
    parentPort.on('message', (event) => {
      const data = event && Object.prototype.hasOwnProperty.call(event, 'data') ? event.data : event;
      if (!data || data.type !== DESKTOP_RUN_INSTALLER_RESULT) return;
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.ok) entry.resolve();
      else entry.reject(runtimeError('INSTALLER_ERROR', data.error || 'the desktop app could not start the installer'));
    });
  }
  return function requestInstall({ installerPath, sha256, version }) {
    if (!parentPort || typeof parentPort.postMessage !== 'function') {
      return Promise.reject(runtimeError('INSTALLER_ERROR', 'the desktop app bridge is unavailable'));
    }
    seq += 1;
    const id = `install-${process.pid}-${seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(runtimeError('INSTALLER_ERROR', 'the desktop app did not confirm the installer launch'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(id, { resolve, reject, timer });
      parentPort.postMessage({ type: DESKTOP_RUN_INSTALLER, id, installerPath, sha256, version });
    });
  };
}

/**
 * Installer for the Electron desktop build. The app lives in a per-machine
 * NSIS install (Program Files) that a normal user cannot write, so the
 * verified Setup.exe is staged under the user's local data and handed to the
 * Electron main process, which runs it (NSIS elevates itself) and quits.
 * Only the Windows installer is supported in-app; other desktop platforms get
 * a clear error and keep the release-notes link.
 */
function createDesktopInstaller({ stagingDir, platformKey, fetchImpl = globalThis.fetch, fsImpl = fs, requestInstall } = {}) {
  if (!stagingDir) throw new TypeError('desktop installer requires a stagingDir');
  if (typeof requestInstall !== 'function') throw new TypeError('desktop installer requires requestInstall');
  const root = path.resolve(stagingDir);
  return {
    download({ artifact, onProgress }) {
      // Drop installers left from earlier updates (100+ MB each); keep this
      // artifact's own file and resumable .part.
      const keep = artifact && typeof artifact.name === 'string' ? artifact.name : null;
      try {
        for (const entry of fsImpl.readdirSync(root)) {
          if (keep && (entry === keep || entry.startsWith(`${keep}.`))) continue;
          try { fsImpl.rmSync(path.join(root, entry), { force: true, recursive: true }); } catch { /* best effort */ }
        }
      } catch { /* folder not created yet */ }
      return downloadArtifact({ artifact, stagingDir: root, fetchImpl, onProgress });
    },
    async install({ packagePath, version, expectedSha256 }) {
      if (!String(platformKey || '').startsWith('windows')) {
        throw runtimeError('INSTALLER_ERROR', 'In-app installation is only available on Windows. Download the new version from the release page.');
      }
      if (typeof packagePath !== 'string' || path.dirname(path.resolve(packagePath)) !== root) {
        throw runtimeError('INSTALLER_ERROR', 'staged application installer is outside the update folder');
      }
      if (!fsImpl.existsSync(packagePath)) throw runtimeError('INSTALLER_ERROR', 'staged application installer is missing');
      const actual = await sha256File(packagePath, fsImpl);
      if (actual !== String(expectedSha256 || '').toLowerCase()) {
        throw runtimeError('INSTALLER_ERROR', 'staged application installer failed its SHA-256 check');
      }
      await requestInstall({ installerPath: path.resolve(packagePath), sha256: actual, version });
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
  const rawVersion = options.currentVersion || readInstalledVersion({ installRoot, env });
  const currentVersion = typeof rawVersion === 'string' ? normalizeInstalledVersion(rawVersion) : rawVersion;

  if (!platformKey || !SUPPORTED_PLATFORMS.has(platformKey) || !isPackagedRuntime({ platform, execPath, packaged, env })) {
    const reason = !platformKey || !SUPPORTED_PLATFORMS.has(platformKey)
      ? `application updates are not supported on platform ${platform}/${arch}`
      : 'application updates are available only in an installed Hostkind binary';
    return { supported: false, platformKey, installRoot, currentVersion, service: createUnsupportedService({ currentVersion, platformKey, reason }) };
  }

  const statePath = env.HOSTKIND_UPDATE_STATE_PATH || path.join(installRoot, '.hostkind', 'update-state.json');
  const stateStore = options.stateStore || createFileStateStore(statePath);
  const publicKey = options.publicKey || env.HOSTKIND_UPDATE_PUBLIC_KEY || BUILTIN_UPDATE_PUBLIC_KEY;
  const verifyManifest = options.verifyManifest || createManifestVerifier(publicKey);
  const releaseClient = options.releaseClient || createReleaseClient({
    fetchImpl: options.fetchImpl || globalThis.fetch,
    repository: env.HOSTKIND_UPDATE_REPOSITORY || DEFAULT_REPOSITORY,
    manifestUrl: env.HOSTKIND_UPDATE_MANIFEST_URL || DEFAULT_MANIFEST_URL,
    verifyManifest,
  });
  const installer = options.installer || (isDesktopRuntime(env)
    ? createDesktopInstaller({
      stagingDir: env.HOSTKIND_UPDATE_STAGING_DIR || path.join(path.dirname(statePath), 'update-staging'),
      platformKey,
      fetchImpl: options.fetchImpl || globalThis.fetch,
      requestInstall: options.requestInstall || createParentPortInstallRequester(),
    })
    : createBinaryInstaller({
      installRoot,
      platformKey,
      env,
      fetchImpl: options.fetchImpl || globalThis.fetch,
      spawnImpl: options.spawnImpl || spawn,
      stateStore,
    }));
  const service = createApplicationUpdater({
    releaseClient,
    installer,
    stateStore,
    platformKey,
    currentVersion,
    now: options.now || (() => Date.now()),
    logger: options.logger || console,
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
  BUILTIN_UPDATE_PUBLIC_KEY,
  DESKTOP_RUN_INSTALLER,
  DESKTOP_RUN_INSTALLER_RESULT,
  platformKeyFor,
  isDesktopRuntime,
  isPackagedRuntime,
  createFileStateStore,
  readInstalledVersion,
  createManifestVerifier,
  createApplicationUpdateScheduler,
  createBinaryInstaller,
  createDesktopInstaller,
  createParentPortInstallRequester,
  createApplicationUpdateRuntime,
};
