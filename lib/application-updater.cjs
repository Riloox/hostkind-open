'use strict';

/*
 * Hostkind application updater state machine (binary distribution updater).
 * Contract: .gauntlet/application-updater-contract.md
 *
 * Owns release selection, state transitions, approval policy, durable state,
 * and API-facing status. The injected installer owns binary staging,
 * checksum/signature verification, atomic promotion and the external
 * bootstrap/relauncher. GET status never performs network I/O and this
 * module never terminates a process.
 *
 * State values: idle | checking | available | downloading | ready |
 * installing | restarting | failed
 */

const STATE_NAMESPACE = 'application-update';
const STATE_KEY = 'state';

const STATES = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  READY: 'ready',
  INSTALLING: 'installing',
  RESTARTING: 'restarting',
  FAILED: 'failed',
});

const CHECKABLE_STATES = new Set([
  STATES.IDLE,
  STATES.AVAILABLE,
  STATES.READY,
  STATES.RESTARTING,
  STATES.FAILED,
]);

function updaterError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  error.isUpdaterError = true;
  return error;
}

function invalidTransition(action, fromState) {
  return updaterError('INVALID_TRANSITION', `Cannot ${action} while state is "${fromState}"`);
}

function createApplicationUpdater({ releaseClient, installer, stateStore, platformKey, currentVersion, now }) {
  if (!releaseClient || typeof releaseClient.getLatest !== 'function') {
    throw new TypeError('createApplicationUpdater requires releaseClient with getLatest()');
  }
  if (!installer || typeof installer.download !== 'function' || typeof installer.install !== 'function') {
    throw new TypeError('createApplicationUpdater requires installer with download() and install()');
  }
  if (typeof now !== 'function') {
    throw new TypeError('createApplicationUpdater requires a now() clock');
  }

  let state = STATES.IDLE;
  let checkedAt = null;
  let updatedAt = null;
  let availableVersion = null;
  let priority = null;
  let manifest = null;
  let artifact = null;
  let packagePath = null;
  let progress = null;
  let lastError = null;

  // -------------------------------------------------------------------------
  // Durable state: the injected stateStore survives process restarts.
  // A persisted record of a busy state (checking/downloading/installing)
  // means the previous process died mid-operation: fail closed so the
  // fresh process can recover via a new check(). Persisted "ready" without
  // a packagePath is equally untrustworthy and fails closed.
  // -------------------------------------------------------------------------
  const persisted = stateStore && typeof stateStore.read === 'function'
    ? stateStore.read(STATE_NAMESPACE, STATE_KEY)
    : null;

  function restoreBaseline(record) {
    availableVersion = record.availableVersion || null;
    priority = record.priority || null;
    artifact = record.artifact || null;
    manifest = record.manifest || null;
    checkedAt = record.checkedAt || null;
    updatedAt = record.updatedAt || null;
  }

  if (persisted && typeof persisted === 'object' && typeof persisted.state === 'string') {
    const previous = persisted.state;
    if (previous === STATES.AVAILABLE) {
      state = STATES.AVAILABLE;
      restoreBaseline(persisted);
    } else if (previous === STATES.READY && typeof persisted.packagePath === 'string') {
      state = STATES.READY;
      restoreBaseline(persisted);
      packagePath = persisted.packagePath;
    } else if (previous === STATES.RESTARTING) {
      state = STATES.RESTARTING;
      updatedAt = persisted.updatedAt || null;
    } else if (previous === STATES.FAILED) {
      state = STATES.FAILED;
      lastError = persisted.error || null;
      updatedAt = persisted.updatedAt || null;
    } else if (previous === STATES.IDLE) {
      state = STATES.IDLE;
      checkedAt = persisted.checkedAt || null;
      updatedAt = persisted.updatedAt || null;
    } else {
      state = STATES.FAILED;
      lastError = { code: 'UPDATER_ERROR', message: 'Update interrupted: previous process exited mid-operation' };
    }
  }

  function persist() {
    if (stateStore && typeof stateStore.write === 'function') {
      stateStore.write(STATE_NAMESPACE, STATE_KEY, {
        state,
        checkedAt,
        updatedAt,
        availableVersion,
        priority,
        artifact,
        manifest,
        packagePath,
        error: lastError,
      });
    }
  }

  /** Enter the failed state, record typed error metadata, rethrow upstream. */
  function fail(cause) {
    state = STATES.FAILED;
    updatedAt = now();
    lastError = {
      code: cause && cause.code ? String(cause.code) : 'UPDATER_ERROR',
      message: cause && cause.message ? String(cause.message) : String(cause),
    };
    persist();
  }

  function getStatus() {
    return {
      state,
      currentVersion,
      availableVersion,
      priority,
      platformKey,
      checkedAt,
      updatedAt,
      progress: progress ? { ...progress } : null,
      error: lastError ? { ...lastError } : null,
      releaseNotesUrl: manifest && typeof manifest.releaseNotesUrl === 'string'
        ? manifest.releaseNotesUrl
        : null,
    };
  }

  /**
   * Refresh release metadata. Never treats a failure as "no update":
   * typed errors propagate and the machine lands in failed so the caller
   * (route layer) can map them to wire errors.
   */
  async function check() {
    if (!CHECKABLE_STATES.has(state)) {
      throw invalidTransition('check', state);
    }
    state = STATES.CHECKING;
    persist();
    try {
      const result = await releaseClient.getLatest({ platformKey, currentVersion });
      checkedAt = now();
      updatedAt = now();
      if (result && result.available) {
        manifest = result.manifest || null;
        artifact = result.artifact || null;
        availableVersion = manifest && typeof manifest.version === 'string' ? manifest.version : null;
        priority = manifest && typeof manifest.priority === 'string' ? manifest.priority : null;
        state = STATES.AVAILABLE;
        lastError = null;
      } else {
        manifest = null;
        artifact = null;
        availableVersion = null;
        priority = null;
        packagePath = null;
        progress = null;
        state = STATES.IDLE;
        lastError = null;
      }
      persist();
      return getStatus();
    } catch (error) {
      fail(error);
      throw error;
    }
  }

  /**
   * Stage the selected artifact via the installer. Downloading never
   * installs; the installer verifies checksum/signature while staging.
   */
  async function download() {
    if (state !== STATES.AVAILABLE) {
      throw invalidTransition('download', state);
    }
    state = STATES.DOWNLOADING;
    progress = null;
    persist();
    try {
      const result = await installer.download({
        artifact,
        onProgress: (update) => {
          if (update && typeof update === 'object') {
            progress = {
              percent: update.percent,
              downloadedBytes: update.downloadedBytes,
              totalBytes: update.totalBytes,
            };
          }
        },
      });
      if (!result || typeof result.packagePath !== 'string' || result.packagePath.length === 0) {
        throw updaterError('INSTALLER_ERROR', 'Installer download() did not return a packagePath');
      }
      packagePath = result.packagePath;
      state = STATES.READY;
      updatedAt = now();
      persist();
      return getStatus();
    } catch (error) {
      fail(error);
      throw error;
    }
  }

  /**
   * Install the staged package. Normal priority requires explicit approval
   * (approved === true); high priority may proceed without it. Either way
   * the installer is always called and owns the safe restart boundary.
   * Approval rejection is non-destructive: state stays ready.
   */
  async function install(options = {}) {
    if (state !== STATES.READY) {
      throw invalidTransition('install', state);
    }
    const { approved } = options;
    if (priority !== 'high' && approved !== true) {
      throw updaterError('APPROVAL_REQUIRED', 'Installation requires explicit approval for normal-priority updates');
    }
    state = STATES.INSTALLING;
    persist();
    try {
      const result = await installer.install({
        packagePath,
        version: availableVersion,
        priority,
        expectedSha256: artifact && artifact.sha256,
      });
      state = STATES.RESTARTING;
      updatedAt = now();
      persist();
      const response = { ...getStatus() };
      if (result && typeof result === 'object') Object.assign(response, result);
      return response;
    } catch (error) {
      fail(error);
      throw error;
    }
  }

  return { getStatus, check, download, install };
}

module.exports = {
  createApplicationUpdater,
  STATES,
};