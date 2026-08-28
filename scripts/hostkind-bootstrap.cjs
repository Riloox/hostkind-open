'use strict';

/*
 * Hostkind — bootstrap/relauncher for safe binary application updates.
 *
 * Owned by the binary/bootstrap agent wave (see
 * .gauntlet/application-updater-contract.md). This script is invoked outside
 * the running application process. It must:
 *
 *   1. Wait for the current process to exit.
 *   2. Verify the staged artifact before promotion.
 *   3. Preserve user data/configuration outside the binary version directory.
 *   4. Promote the new executable atomically or leave the old executable
 *      selected.
 *   5. Start the new executable through the stable launcher.
 *   6. Record success/failure in durable update state.
 *
 * Safety rules: launch commands are explicit argument arrays with
 * shell:false — command strings are never built from release metadata or
 * user input, and no step is ever interpolated into a shell. Standard
 * library only; no npm assumption on the target machine. This module is
 * inert when required: the CLI entrypoint only runs when the file is
 * executed directly (require.main === module).
 *
 * Every orchestration step is an injectable seam for tests:
 *   waitForExit, verifyStagedChecksum, preserveData, promoteVersion,
 *   relaunch, recordResult
 * The real default relaunch uses child_process.spawn with an argument array
 * and shell:false.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const applyUpdate = require('./apply-application-update.cjs');

const SUPPORTED_PLATFORMS = new Set(['windows-x64', 'linux-x64']);

class BootstrapError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'BootstrapError';
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

function fail(code, message) {
  throw new BootstrapError(code, message);
}

/**
 * buildLaunchCommand — build an explicit argument array for the launcher.
 * Never a shell string: every element is passed literally to spawn with
 * shell:false. Hostile strings stay literal arguments.
 *
 *   windows-x64: [launcherPath, <installDir>\hostkind.exe, ...args]
 *   linux-x64:   [launcherPath, <installDir>/hostkind, ...args]
 *
 * An installDir that already ends with a path separator is used as-is (the
 * binary is expected to live at exactly that path).
 */
function buildLaunchCommand({ platformKey, launcherPath, installDir, args = [] }) {
  if (!SUPPORTED_PLATFORMS.has(platformKey)) {
    fail('unsupported_platform', `unsupported platform key: ${String(platformKey)}`);
  }
  const binaryName = platformKey === 'windows-x64' ? 'hostkind.exe' : 'hostkind';
  const separator = platformKey === 'windows-x64' ? '\\' : '/';
  let binaryPath;
  if (typeof installDir !== 'string' || installDir.length === 0) {
    binaryPath = binaryName;
  } else if (installDir.endsWith('/') || installDir.endsWith('\\')) {
    binaryPath = installDir;
  } else {
    binaryPath = `${installDir}${separator}${binaryName}`;
  }
  return [launcherPath, binaryPath].concat(Array.isArray(args) ? args : []);
}

function isPidRunning(pid) {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else.
    return error && error.code === 'EPERM';
  }
}

/**
 * waitForProcessExit — poll isRunning() until the process reports exit, or
 * reject with exit_timeout once timeoutMs of polling has elapsed.
 * sleepImpl is an injectable seam (defaults to a setTimeout promise).
 */
async function waitForProcessExit({
  isRunning,
  pollIntervalMs = 250,
  timeoutMs = 60000,
  sleepImpl
}) {
  const sleep = sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (typeof isRunning !== 'function') {
    return;
  }
  let waited = 0;
  for (;;) {
    if (!isRunning()) {
      return;
    }
    if (waited >= timeoutMs) {
      fail('exit_timeout', `current process did not exit within ${timeoutMs}ms`);
    }
    if (pollIntervalMs > 0) {
      await sleep(pollIntervalMs);
    }
    waited += pollIntervalMs;
  }
}

function randomSuffix() {
  return `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// --- default orchestration steps (production behavior) ---------------------

async function defaultWaitForExit(input) {
  const pid = input && input.currentPid;
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    // Nothing recorded to wait for: nothing is blocking the swap.
    return;
  }
  await waitForProcessExit({
    isRunning: () => isPidRunning(pid),
    pollIntervalMs: 250,
    timeoutMs: 60000
  });
  // Give the OS a beat to release file handles to the old executable before
  // promotion.
  await new Promise((resolve) => setTimeout(resolve, 250));
}

function defaultVerifyStagedChecksum(input) {
  if (!input || !input.stagedPath || !input.expectedSha256) {
    fail('staged_missing', 'bootstrap: missing staged artifact or expected SHA-256');
  }
  return applyUpdate.verifyStagedChecksum({
    stagedPath: input.stagedPath,
    expectedSha256: input.expectedSha256
  });
}

async function defaultPreserveData(input) {
  const layout = applyUpdate.resolveInstallLayout({
    installRoot: input.installRoot,
    version: input.version,
    dataPaths: input.dataPaths || []
  });
  for (const entry of layout.preserved) {
    fs.mkdirSync(entry.path, { recursive: true });
  }
}

function defaultPromoteVersion(input) {
  const layout = applyUpdate.resolveInstallLayout({
    installRoot: input.installRoot,
    version: input.version,
    dataPaths: input.dataPaths || [],
  });
  if (!input.stagedPath || !fs.existsSync(input.stagedPath)) {
    fail('staged_missing', `bootstrap: staged artifact is missing: ${input.stagedPath || '<none>'}`);
  }
  const platformKey = input.platformKey || defaultPlatformKey();
  if (!SUPPORTED_PLATFORMS.has(platformKey)) {
    fail('unsupported_platform', `unsupported platform key: ${String(platformKey)}`);
  }
  const binaryName = platformKey === 'windows-x64' ? 'hostkind.exe' : 'hostkind';
  const target = path.join(layout.installDir, binaryName);
  const previousVersion = applyUpdate.readCurrentVersion({ installRoot: input.installRoot });
  fs.mkdirSync(layout.installDir, { recursive: true });
  fs.copyFileSync(input.stagedPath, target);
  if (platformKey === 'linux-x64') fs.chmodSync(target, 0o755);
  // The pointer changes only after the verified executable is in place.
  const promoted = applyUpdate.promoteVersion({ installRoot: input.installRoot, version: input.version });
  return { ...promoted, previousVersion };
}

function defaultRollbackVersion(input) {
  if (!input || !input.version) fail('rollback_unavailable', 'bootstrap: no previous version is available for rollback');
  return applyUpdate.promoteVersion({ installRoot: input.installRoot, version: input.version });
}

async function defaultHealthCheck(input) {
  if (!input || !input.healthUrl) return { ok: true, skipped: true };
  let parsed;
  try { parsed = new URL(input.healthUrl); } catch { fail('health_check_failed', 'bootstrap: health URL is invalid'); }
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (!['http:', 'https:'].includes(parsed.protocol) || !localHosts.has(parsed.hostname)) {
    fail('health_check_failed', 'bootstrap: health URL must target localhost');
  }
  try {
    const response = await fetch(parsed, { redirect: 'error', signal: AbortSignal.timeout(input.healthTimeoutMs || 30000) });
    if (!response || !response.ok) fail('health_check_failed', `bootstrap: health check returned HTTP ${response && response.status}`);
    return { ok: true };
  } catch (error) {
    if (error && error.code === 'health_check_failed') throw error;
    const failure = new Error(`bootstrap: health check failed: ${error && error.message ? error.message : String(error)}`);
    failure.code = 'health_check_failed';
    throw failure;
  }
}

function defaultRelaunch({ command, options }) {
  if (!Array.isArray(command) || command.length === 0) {
    fail('unsupported_platform', 'bootstrap: empty launch command');
  }
  const child = spawn(command[0], command.slice(1), Object.assign({}, options, { shell: false }));
  if (typeof child.unref === 'function') {
    child.unref();
  }
  return child;
}

async function defaultRecordResult(result, input) {
  const installRoot = (input && input.installRoot) || '.';
  const state = Object.assign({}, result, { at: new Date().toISOString() });
  fs.mkdirSync(installRoot, { recursive: true });
  const target = path.join(installRoot, 'update-result.json');
  const temp = path.join(installRoot, `.update-result.json.tmp-${randomSuffix()}`);
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, target);

  const stateDir = path.join(installRoot, '.hostkind');
  const stateTarget = path.join(stateDir, 'update-state.json');
  const stateTemp = `${stateTarget}.tmp-${randomSuffix()}`;
  const reconciled = result && result.ok
    ? { state: 'idle', updatedAt: state.at, error: null }
    : {
      state: 'failed',
      updatedAt: state.at,
      error: {
        code: result && result.code ? String(result.code) : 'UPDATE_FAILED',
        message: result && result.error ? String(result.error) : 'application update failed',
      },
      rolledBack: result && result.rolledBack === true,
    };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateTemp, `${JSON.stringify(reconciled, null, 2)}\n`, 'utf8');
  fs.renameSync(stateTemp, stateTarget);
}

/**
 * createBootstrap({ waitForExit, verifyStagedChecksum, preserveData,
 *   promoteVersion, relaunch, recordResult }) -> { run }
 *
 * run(input) executes the contract steps in order and fails closed: when any
 * step before recordResult throws, no later step runs (nothing is promoted,
 * nothing is relaunched) and the failure is recorded; when recording itself
 * fails it never masks the original failure. input:
 *   { installRoot, version, stagedPath, expectedSha256, currentPid,
 *     command, options, dataPaths }
 * The relaunch step always receives options with shell:false forced on.
 */
function createBootstrap(deps = {}) {
  const steps = {
    waitForExit: deps.waitForExit || defaultWaitForExit,
    verifyStagedChecksum: deps.verifyStagedChecksum || defaultVerifyStagedChecksum,
    preserveData: deps.preserveData || defaultPreserveData,
    promoteVersion: deps.promoteVersion || defaultPromoteVersion,
    relaunch: deps.relaunch || defaultRelaunch,
    healthCheck: deps.healthCheck || defaultHealthCheck,
    rollbackVersion: deps.rollbackVersion || defaultRollbackVersion,
    recordResult: deps.recordResult || defaultRecordResult
  };

  async function run(input = {}) {
    const options = Object.assign({}, input.options || {}, { shell: false });
    let promotionResult = null;
    const ordered = [
      ['waitForExit', () => steps.waitForExit(input)],
      ['verifyStagedChecksum', () => steps.verifyStagedChecksum(input)],
      ['preserveData', () => steps.preserveData(input)],
      ['promoteVersion', () => steps.promoteVersion(input)],
      ['relaunch', () => steps.relaunch({ command: input.command, options })]
    ];

    for (const [stepName, stepFn] of ordered) {
      try {
        const value = await stepFn();
        if (stepName === 'promoteVersion') promotionResult = value || null;
      } catch (error) {
        const failure = {
          ok: false,
          failedStep: stepName,
          error: error && error.message ? error.message : String(error)
        };
        if (error && error.code) {
          failure.code = error.code;
        }
        try {
          await steps.recordResult(failure, input);
        } catch (recordError) {
          // Recording failure must never mask the original failure.
        }
        return failure;
      }
    }

    if (input.healthCheck === true || input.healthUrl) {
      try {
        await steps.healthCheck(input);
      } catch (healthError) {
        const previousVersion = (promotionResult && promotionResult.previousVersion) || input.previousVersion;
        const baseFailure = {
          ok: false,
          failedStep: 'healthCheck',
          error: healthError && healthError.message ? healthError.message : String(healthError),
          code: healthError && healthError.code ? healthError.code : 'health_check_failed',
        };
        if (!previousVersion) {
          try { await steps.recordResult(baseFailure, input); } catch { /* preserve health failure */ }
          return baseFailure;
        }
        try {
          await steps.rollbackVersion({ ...input, version: previousVersion });
          if (!Array.isArray(input.rollbackCommand) || input.rollbackCommand.length === 0) {
            fail('rollback_unavailable', 'bootstrap: no rollback launch command is available');
          }
          await steps.relaunch({ command: input.rollbackCommand, options });
          const rolledBack = { ...baseFailure, rolledBack: true, previousVersion };
          try { await steps.recordResult(rolledBack, input); } catch { /* preserve rollback result */ }
          return rolledBack;
        } catch (rollbackError) {
          const rollbackFailure = {
            ...baseFailure,
            rolledBack: false,
            rollbackError: rollbackError && rollbackError.message ? rollbackError.message : String(rollbackError),
            rollbackCode: rollbackError && rollbackError.code ? rollbackError.code : 'rollback_failed',
          };
          try { await steps.recordResult(rollbackFailure, input); } catch { /* preserve original failure */ }
          return rollbackFailure;
        }
      }
    }

    const success = { ok: true, version: input.version };
    try {
      await steps.recordResult(success, input);
    } catch (error) {
      const failure = {
        ok: false,
        failedStep: 'recordResult',
        error: error && error.message ? error.message : String(error)
      };
      if (error && error.code) {
        failure.code = error.code;
      }
      return failure;
    }
    return success;
  }

  return { run };
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

function main() {
  const args = parseArgv(process.argv.slice(2));
  let state;
  try {
    if (args.state) {
      state = JSON.parse(fs.readFileSync(args.state, 'utf8'));
    } else {
      state = args;
    }
  } catch (error) {
    process.stderr.write(`hostkind-bootstrap: cannot read update state: ${error.message}\n`);
    process.exitCode = 2;
    return;
  }

  const installRoot = state['install-root'] || state.installRoot;
  const version = state.version;
  const stagedPath = state['staged-path'] || state.stagedPath;
  const expectedSha256 = state['expected-sha256'] || state.expectedSha256;
  const platformKey = state['platform-key'] || state.platformKey || defaultPlatformKey();

  if (!installRoot || !version || !stagedPath || !expectedSha256) {
    process.stderr.write(
      'usage: node hostkind-bootstrap.cjs --install-root <dir> --version <x.y.z> ' +
        '--staged-path <file> --expected-sha256 <hex64> [--current-pid <pid>] ' +
        '[--launcher-path <path>] [--platform-key windows-x64|linux-x64] [--arg <value>...]\n'
    );
    process.exitCode = 2;
    return;
  }

  const launcherPath =
    state['launcher-path'] ||
    state.launcherPath ||
    path.join(installRoot, platformKey === 'windows-x64' ? 'launcher.exe' : 'launcher');
  const command = buildLaunchCommand({
    platformKey,
    launcherPath,
    installDir: path.join(installRoot, 'versions', version),
    args: Array.isArray(state.args) ? state.args : []
  });
  const previousVersion = applyUpdate.readCurrentVersion({ installRoot });
  const rollbackCommand = previousVersion
    ? buildLaunchCommand({
      platformKey,
      launcherPath,
      installDir: path.join(installRoot, 'versions', previousVersion),
      args: Array.isArray(state.args) ? state.args : []
    })
    : null;
  const healthUrl = state['health-url'] || state.healthUrl || null;

  const runner = createBootstrap({});
  runner
    .run({
      installRoot,
      version,
      stagedPath,
      expectedSha256,
      currentPid: state['current-pid'] || state.currentPid ? Number(state['current-pid'] || state.currentPid) : undefined,
      previousVersion,
      rollbackCommand,
      healthUrl,
      healthCheck: Boolean(healthUrl),
      command,
      options: { detached: true, stdio: 'ignore' }
    })
    .then((outcome) => {
      process.stdout.write(`${JSON.stringify(outcome)}\n`);
      process.exitCode = outcome.ok ? 0 : 1;
    })
    .catch((error) => {
      process.stderr.write(`hostkind-bootstrap: ${error && error.message ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

if (require.main === module) {
  main();
}

module.exports = {
  buildLaunchCommand,
  createBootstrap,
  waitForProcessExit
};