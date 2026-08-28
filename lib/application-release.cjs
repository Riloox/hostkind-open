'use strict';

/*
 * Hostkind application release client (binary distribution updater).
 * Contract: .gauntlet/application-updater-contract.md
 *
 * Owns strict stable-semver comparison, fail-closed manifest validation,
 * HTTPS GitHub release-origin enforcement, and the release lookup flow.
 * Detached-signature verification is injected as verifyManifest so callers
 * (and tests) never need real key material inside this module.
 *
 * Every failure surfaces as a typed updater error: an Error whose `code` is
 * one of VALIDATION_ERROR / NETWORK_ERROR / JSON_ERROR / VERIFICATION_ERROR
 * and whose `isUpdaterError` flag is true. Availability is never reported as
 * "no update" when anything fails - errors always propagate.
 */

const DEFAULT_REPOSITORY = 'Riloox/hostkind-open';
const SUPPORTED_PLATFORMS = new Set(['windows-x64', 'linux-x64']);
// Strict stable semver: X.Y.Z, no prerelease/build suffix, no leading zeros.
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function updaterError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  error.isUpdaterError = true;
  return error;
}

function parseVersion(value) {
  if (typeof value !== 'string' || !STRICT_SEMVER.test(value)) {
    throw new Error(`Invalid version string: ${JSON.stringify(value)}`);
  }
  return value.split('.').map(Number);
}

/**
 * Numeric strict-semver comparison (never lexicographic): returns <0, 0, >0.
 * Throws on anything that is not strict stable X.Y.Z.
 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

function isHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Artifact URLs must be HTTPS and live under an allowed GitHub release
 * origin for the first release source: https://github.com/<repository>/releases/
 */
function isAllowedGithubReleaseUrl(value, repository) {
  if (typeof value !== 'string' || !isHttpsUrl(value)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hostname !== 'github.com') return false;
  const authority = value.slice('https://'.length).split(/[/?#]/, 1)[0];
  if (authority.toLowerCase() !== 'github.com') return false;
  const repo = String(repository || DEFAULT_REPOSITORY).replace(/^\/+|\/+$/g, '');
  const prefix = `/${repo}/releases/`.toLowerCase();
  return url.pathname.toLowerCase().startsWith(prefix);
}

/** Artifact names must be plain basenames: no path separators, no control chars. */
function isSafeBasename(value) {
  if (value.length === 0 || value === '.' || value === '..') return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false; // control characters
    const ch = value[i];
    if (ch === '/' || ch === '\\') return false; // path separators
  }
  return true;
}

function validateArtifact(platformKey, artifact, repository) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw updaterError('VALIDATION_ERROR', `Invalid release manifest: artifact for platform "${platformKey}" must be an object`);
  }
  if (!isAllowedGithubReleaseUrl(artifact.url, repository)) {
    throw updaterError('VALIDATION_ERROR', `Invalid release manifest: artifact URL for "${platformKey}" must be an HTTPS GitHub release URL for ${repository}`);
  }
  if (typeof artifact.name !== 'string' || !isSafeBasename(artifact.name)) {
    throw updaterError('VALIDATION_ERROR', `Invalid release manifest: artifact name for "${platformKey}" must be a plain basename`);
  }
  if (typeof artifact.sha256 !== 'string' || !SHA256_RE.test(artifact.sha256)) {
    throw updaterError('VALIDATION_ERROR', `Invalid release manifest: artifact sha256 for "${platformKey}" must be 64 lowercase hexadecimal characters`);
  }
}

/**
 * Fail-closed manifest validation. Throws VALIDATION_ERROR (typed updater
 * error) on any deviation from the release metadata contract. Returns the
 * manifest unchanged when it is trustworthy.
 *
 * @param {object} manifest parsed manifest JSON
 * @param {{platformKey: string, repository?: string}} options
 */
function validateManifest(manifest, options = {}) {
  const { platformKey } = options;
  const repository = options.repository || DEFAULT_REPOSITORY;
  const fail = (reason) => {
    throw updaterError('VALIDATION_ERROR', `Invalid release manifest: ${reason}`);
  };

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('manifest must be an object');
  }
  if (manifest.schema !== 1) {
    fail(`unsupported schema ${JSON.stringify(manifest.schema)}`);
  }
  if (manifest.product !== 'hostkind') {
    fail(`product must be "hostkind", got ${JSON.stringify(manifest.product)}`);
  }
  if (manifest.edition !== 'open') {
    fail(`edition must be "open", got ${JSON.stringify(manifest.edition)}`);
  }
  if (manifest.channel !== 'stable') {
    fail(`channel must be "stable", got ${JSON.stringify(manifest.channel)}`);
  }
  try {
    parseVersion(manifest.version);
  } catch {
    fail(`version must be strict stable semver X.Y.Z (no prerelease/build/v prefix), got ${JSON.stringify(manifest.version)}`);
  }
  if (manifest.priority !== 'normal' && manifest.priority !== 'high') {
    fail(`priority must be "normal" or "high", got ${JSON.stringify(manifest.priority)}`);
  }
  if (!isHttpsUrl(manifest.releaseNotesUrl)) {
    fail('releaseNotesUrl must be an HTTPS URL');
  }
  if (!manifest.artifacts || typeof manifest.artifacts !== 'object' || Array.isArray(manifest.artifacts)) {
    fail('artifacts must be an object');
  }
  if (!SUPPORTED_PLATFORMS.has(platformKey)) {
    fail(`unsupported platform key ${JSON.stringify(platformKey)}`);
  }
  if (!manifest.artifacts[platformKey]) {
    fail(`no artifact declared for platform ${JSON.stringify(platformKey)}`);
  }
  // Fail closed on every declared artifact, not just the selected one.
  for (const [key, artifact] of Object.entries(manifest.artifacts)) {
    validateArtifact(key, artifact, repository);
  }
  return manifest;
}

/**
 * Release lookup flow: fetch manifest over HTTPS -> parse JSON -> validate
 * (fail closed) -> detached-signature verify (injected) -> semver-aware
 * availability decision. Errors are typed and never masquerade as
 * "no update".
 */
function createReleaseClient({ fetchImpl, repository, manifestUrl, verifyManifest }) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('createReleaseClient requires a fetchImpl function');
  }
  if (typeof verifyManifest !== 'function') {
    throw new TypeError('createReleaseClient requires a verifyManifest function');
  }
  const repo = String(repository || DEFAULT_REPOSITORY).replace(/^\/+|\/+$/g, '');
  if (!isAllowedGithubReleaseUrl(manifestUrl, repo)) {
    throw updaterError('VALIDATION_ERROR', `manifestUrl must be an HTTPS GitHub release URL for ${repo}`);
  }

  let etag = null;
  let cachedManifest = null;

  async function getLatest({ platformKey, currentVersion }) {
    let response;
    try {
      const headers = {
        Accept: 'application/json',
        'User-Agent': 'Hostkind-Application-Updater',
      };
      if (etag) headers['If-None-Match'] = etag;
      response = await fetchImpl(manifestUrl, { headers });
    } catch (error) {
      throw updaterError('NETWORK_ERROR', `Failed to fetch release manifest from ${manifestUrl}: ${error && error.message ? error.message : String(error)}`, error);
    }
    if (!response || typeof response.json !== 'function') {
      throw updaterError('NETWORK_ERROR', 'Release manifest fetch returned an unusable response');
    }
    const status = typeof response.status === 'number' ? response.status : 200;
    if (status === 304) {
      if (!cachedManifest) {
        throw updaterError('NETWORK_ERROR', 'Release manifest returned HTTP 304 without a verified cached manifest');
      }
    } else if (response.ok === false || status < 200 || status >= 300) {
      const error = updaterError('NETWORK_ERROR', `Release manifest fetch failed with HTTP status ${status}`);
      error.status = status;
      throw error;
    }
    let manifest;
    if (status === 304) {
      manifest = typeof structuredClone === 'function'
        ? structuredClone(cachedManifest)
        : JSON.parse(JSON.stringify(cachedManifest));
    } else {
      if (!response || typeof response.json !== 'function') {
        throw updaterError('NETWORK_ERROR', 'Release manifest fetch returned an unusable response');
      }
      try {
        manifest = await response.json();
      } catch (error) {
        throw updaterError('JSON_ERROR', 'Release manifest is not valid JSON', error);
      }
      try {
        const receivedEtag = response.headers && typeof response.headers.get === 'function'
          ? response.headers.get('etag')
          : null;
        if (receivedEtag) etag = receivedEtag;
      } catch { /* cache metadata is optional */ }
    }
    try {
      parseVersion(currentVersion);
    } catch (error) {
      throw updaterError('VALIDATION_ERROR', `currentVersion must be strict stable semver, got ${JSON.stringify(currentVersion)}`, error);
    }
    const validated = validateManifest(manifest, { platformKey, repository: repo });
    try {
      await verifyManifest(validated);
    } catch (error) {
      throw updaterError('VERIFICATION_ERROR', `Release manifest verification failed: ${error && error.message ? error.message : String(error)}`, error);
    }
    cachedManifest = validated;
    const checkedAt = Date.now();
    if (compareVersions(validated.version, currentVersion) <= 0) {
      return { available: false, currentVersion, checkedAt };
    }
    return {
      available: true,
      currentVersion,
      checkedAt,
      manifest: validated,
      artifact: validated.artifacts[platformKey],
      platformKey,
    };
  }

  return { getLatest };
}

module.exports = {
  createReleaseClient,
  validateManifest,
  compareVersions,
  SUPPORTED_PLATFORMS,
  DEFAULT_REPOSITORY,
};