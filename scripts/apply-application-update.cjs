'use strict';

/*
 * Hostkind — safe binary application installer helpers.
 *
 * Owned by the binary/bootstrap agent wave (see
 * .gauntlet/application-updater-contract.md). These helpers implement the
 * "installer" half of the application updater for a Hostkind binary
 * distribution (Windows .exe / Linux executable). There is no npm or Node
 * runtime assumption on the target machine: everything here is standard
 * library only and every process/filesystem seam is injectable for tests.
 *
 * Layout contract (installRoot):
 *
 *   <installRoot>/versions/<version>/   versioned executable directory
 *   <installRoot>/current.json          atomic current-version marker
 *                                       { "version": "x.y.z" }, promoted via
 *                                       temp file + rename so a failed swap
 *                                       leaves the previous selection intact
 *   <installRoot>/data/, <installRoot>/config/
 *                                       preserved user data/config, always
 *                                       outside any versions/<version>/ dir
 *
 * Error contract: every helper failure throws an Error subclass carrying a
 * `.code` property, one of: unsupported_platform, insecure_artifact_url,
 * disallowed_artifact_origin, unsafe_artifact_name, invalid_artifact_sha256,
 * checksum_mismatch, staged_missing, invalid_version, promotion_failed,
 * data_path_inside_install, exit_timeout.
 *
 * This module is inert when required: the CLI entrypoint only runs when the
 * file is executed directly (require.main === module).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SUPPORTED_PLATFORMS = new Set(['windows-x64', 'linux-x64']);
const ALLOWED_RELEASE_ORIGIN_HOST = 'github.com';
const ALLOWED_RELEASE_ORIGIN_PATH = '/Riloox/hostkind-open/releases/download/';
const STRICT_STABLE_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

class UpdaterError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'UpdaterError';
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

function fail(code, message) {
  throw new UpdaterError(code, message);
}

function assertStableVersion(version) {
  if (typeof version !== 'string' || !STRICT_STABLE_SEMVER_RE.test(version)) {
    fail('invalid_version', `version must be strict stable semver (X.Y.Z), got: ${String(version)}`);
  }
}

function randomSuffix() {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * selectPlatformArtifact — pick the release artifact for a supported platform.
 * Supported platform keys are exactly windows-x64 and linux-x64.
 */
function selectPlatformArtifact(artifacts, platformKey) {
  if (
    !SUPPORTED_PLATFORMS.has(platformKey) ||
    !artifacts ||
    typeof artifacts !== 'object' ||
    !artifacts[platformKey]
  ) {
    fail('unsupported_platform', `no artifact for unsupported platform key: ${String(platformKey)}`);
  }
  return artifacts[platformKey];
}

/**
 * validateArtifact — verify release metadata safety: HTTPS-only transport,
 * allowed GitHub release origin, safe basename, 64-lowercase-hex SHA-256.
 * Returns the normalized { name, url, sha256 } on success; throws with a
 * `.code` on any violation (fail closed).
 */
function validateArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    fail('invalid_artifact_sha256', 'artifact metadata is missing');
  }

  // Transport + authority safety.
  let parsed;
  try {
    parsed = new URL(artifact.url);
  } catch (error) {
    fail('insecure_artifact_url', `artifact URL is not a valid URL: ${String(artifact.url)}`);
  }
  if (parsed.protocol !== 'https:') {
    fail('insecure_artifact_url', `artifact URL must use HTTPS: ${artifact.url}`);
  }
  // A malformed authority such as "https:///owner/repo/..." parses with a
  // first path segment as host; reject any URL whose authority is empty
  // (the raw string after "https://" must not begin with "/").
  const authorityText = String(artifact.url).slice('https://'.length);
  if (authorityText.startsWith('/')) {
    fail('insecure_artifact_url', `artifact URL has no host authority: ${artifact.url}`);
  }
  const rawAuthority = authorityText.split(/[/?#]/, 1)[0];
  if (rawAuthority.toLowerCase() !== ALLOWED_RELEASE_ORIGIN_HOST) {
    fail('disallowed_artifact_origin', `artifact URL authority is not allowed: ${artifact.url}`);
  }

  // Allowed GitHub release origin only.
  if (parsed.hostname !== ALLOWED_RELEASE_ORIGIN_HOST) {
    fail('disallowed_artifact_origin', `artifact URL host is not allowed: ${artifact.url}`);
  }
  if (!parsed.pathname.startsWith(ALLOWED_RELEASE_ORIGIN_PATH)) {
    fail('disallowed_artifact_origin', `artifact URL is outside the GitHub release origin: ${artifact.url}`);
  }

  // Safe basename: no path separators, no control characters, not empty.
  const name = artifact.name;
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(name)
  ) {
    fail('unsafe_artifact_name', `artifact name is not a safe basename: ${JSON.stringify(name)}`);
  }

  // SHA-256: exactly 64 lowercase hexadecimal characters.
  const sha256 = artifact.sha256;
  if (typeof sha256 !== 'string' || !SHA256_HEX_RE.test(sha256)) {
    fail('invalid_artifact_sha256', `artifact SHA-256 must be 64 lowercase hex characters: ${String(sha256)}`);
  }

  return { name, url: artifact.url, sha256 };
}

/**
 * verifyStagedChecksum — lowercase SHA-256 of the staged bytes must match the
 * expected value. Returns { ok: true, sha256 } on success; throws
 * staged_missing when the staged file is absent and checksum_mismatch when
 * the digest differs. fsImpl/cryptoImpl are injectable seams (defaults: fs,
 * crypto).
 */
function verifyStagedChecksum({ stagedPath, expectedSha256, fsImpl = fs, cryptoImpl = crypto }) {
  let data;
  try {
    data = fsImpl.readFileSync(stagedPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      fail('staged_missing', `staged artifact is missing: ${stagedPath}`);
    }
    throw error;
  }
  const actual = cryptoImpl.createHash('sha256').update(data).digest('hex');
  if (actual !== expectedSha256) {
    fail('checksum_mismatch', `staged artifact checksum mismatch for ${stagedPath}`);
  }
  return { ok: true, sha256: actual };
}

/**
 * createVersionedInstallDir — create <installRoot>/versions/<version> and
 * return { installDir }. Version must be strict stable semver. fsImpl is an
 * injectable seam (defaults to fs).
 */
function createVersionedInstallDir({ installRoot, version, fsImpl = fs }) {
  assertStableVersion(version);
  const installDir = path.join(installRoot, 'versions', version);
  fsImpl.mkdirSync(installDir, { recursive: true });
  return { installDir };
}

/**
 * readCurrentVersion — read the atomic current-version marker. Returns the
 * version string, or null when no marker exists yet. A corrupt marker fails
 * closed with an error (never silently treated as "no version").
 */
function readCurrentVersion({ installRoot, fsImpl = fs }) {
  const currentPath = path.join(installRoot, 'current.json');
  let raw;
  try {
    raw = fsImpl.readFileSync(currentPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  let marker;
  try {
    marker = JSON.parse(raw);
  } catch (error) {
    throw new Error(`corrupt current.json at ${currentPath}: ${error.message}`);
  }
  if (!marker || typeof marker.version !== 'string') {
    throw new Error(`corrupt current.json at ${currentPath}: missing "version" field`);
  }
  return marker.version;
}

/**
 * promoteVersion — atomically promote the current-version marker to
 * <installRoot>/current.json. The marker is written to a temp file and moved
 * into place with a single rename: a failed swap throws promotion_failed and
 * leaves the previous selection intact. fsImpl is an injectable seam
 * (defaults to fs).
 */
function promoteVersion({ installRoot, version, fsImpl = fs }) {
  assertStableVersion(version);
  const currentPath = path.join(installRoot, 'current.json');
  // Temp name deliberately does NOT start with "current.json" so a leftover
  // temp file can never be mistaken for a marker.
  const tempPath = path.join(installRoot, `.current.json.tmp-${randomSuffix()}`);
  fsImpl.mkdirSync(installRoot, { recursive: true });
  try {
    fsImpl.writeFileSync(tempPath, `${JSON.stringify({ version })}\n`, 'utf8');
    fsImpl.renameSync(tempPath, currentPath);
  } catch (error) {
    try {
      if (typeof fsImpl.rmSync === 'function') {
        fsImpl.rmSync(tempPath, { force: true });
      }
    } catch (cleanupError) {
      // Cleanup must never mask the original promotion failure.
    }
    fail('promotion_failed', `failed to promote current version to ${version}: ${error ? error.message : String(error)}`);
  }
  return { version, currentPath };
}

/**
 * resolveInstallLayout — compute the versioned install directory and the
 * preserved data/config locations. dataPaths may add extra preserved
 * locations; the defaults <installRoot>/data and <installRoot>/config always
 * apply. Every preserved path must resolve OUTSIDE the versioned install
 * directory, otherwise the layout fails closed with data_path_inside_install.
 */
function resolveInstallLayout({ installRoot, version, dataPaths = [] }) {
  assertStableVersion(version);
  const installDir = path.join(installRoot, 'versions', version);
  const preserved = [
    { name: 'data', path: path.join(installRoot, 'data') },
    { name: 'config', path: path.join(installRoot, 'config') }
  ];
  for (const extra of dataPaths) {
    if (!extra || typeof extra !== 'object' || typeof extra.path !== 'string') {
      continue;
    }
    preserved.push({ name: extra.name || path.basename(extra.path), path: extra.path });
  }
  for (const entry of preserved) {
    const relative = path.relative(installDir, entry.path);
    if (!relative.startsWith('..')) {
      fail('data_path_inside_install', `${entry.path} would land inside the versioned install directory ${installDir}`);
    }
  }
  return { installDir, preserved };
}

// --- CLI entrypoint (inert when required as a module) ----------------------

function parseArgv(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      continue;
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = value;
      i += 1;
    }
  }
  return parsed;
}

function defaultPlatformKey() {
  return process.platform === 'win32' ? 'windows-x64' : 'linux-x64';
}

function writeResultFile(installRoot, result) {
  const dir = installRoot || '.';
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'update-result.json');
  const temp = path.join(dir, `.update-result.json.tmp-${randomSuffix()}`);
  fs.writeFileSync(temp, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, target);
}

function promoteStagedBinary({ stagedPath, targetPath, platformKey, fsImpl = fs }) {
  if (!stagedPath || !targetPath) fail('staged_missing', 'stagedPath and targetPath are required');
  fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true });
  fsImpl.copyFileSync(stagedPath, targetPath);
  if (String(platformKey || '').startsWith('linux') && typeof fsImpl.chmodSync === 'function') {
    fsImpl.chmodSync(targetPath, 0o755);
  }
  return { targetPath };
}

function main() {
  const args = parseArgv(process.argv.slice(2));
  const installRoot = args['install-root'];
  const version = args.version;
  const stagedPath = args['staged-path'];
  const expectedSha256 = args['expected-sha256'];
  const platformKey = args['platform-key'] || defaultPlatformKey();
  if (!installRoot || !version || !stagedPath || !expectedSha256) {
    process.stderr.write(
      'usage: node apply-application-update.cjs --install-root <dir> --version <x.y.z> ' +
        '--staged-path <file> --expected-sha256 <hex64> [--platform-key windows-x64|linux-x64]\n'
    );
    process.exitCode = 2;
    return;
  }
  try {
    // 1. Verify the staged bytes before anything is installed.
    verifyStagedChecksum({ stagedPath, expectedSha256 });
    // 2. Preserve data/config outside the versioned install directory.
    const layout = resolveInstallLayout({ installRoot, version, dataPaths: [] });
    for (const entry of layout.preserved) {
      fs.mkdirSync(entry.path, { recursive: true });
    }
    // 3. Place the verified executable into its versioned directory.
    const binaryName = platformKey === 'windows-x64' ? 'hostkind.exe' : 'hostkind';
    const target = path.join(layout.installDir, binaryName);
    promoteStagedBinary({ stagedPath, targetPath: target, platformKey });
    // 4. Atomically promote the current-version marker.
    promoteVersion({ installRoot, version });
    // 5. Record the durable result.
    const result = { ok: true, version };
    writeResultFile(installRoot, result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const result = {
      ok: false,
      failedStep: 'apply',
      error: error && error.message ? error.message : String(error),
      code: error && error.code ? error.code : undefined
    };
    try {
      writeResultFile(installRoot, result);
    } catch (writeError) {
      // Recording failure must never mask the apply failure.
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  selectPlatformArtifact,
  validateArtifact,
  verifyStagedChecksum,
  createVersionedInstallDir,
  readCurrentVersion,
  promoteVersion,
  resolveInstallLayout,
  promoteStagedBinary
};