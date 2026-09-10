'use strict';

/*
 * Palworld host / target platform model (docs/palworld/06-mods.md
 * "Platform compatibility").
 *
 * The host is the machine Hostkind runs on. The target is the platform the
 * installed Palworld dedicated server binary was built for. They are modelled
 * separately on purpose: a Windows-only extension framework needs a
 * Windows-target server, and running that target on a Linux host additionally
 * needs an explicitly configured Wine runtime. Compatibility is never inferred
 * from the host alone, and Hostkind never installs Wine on the operator's
 * behalf - it only detects what is already there.
 */

const path = require('path');
const { execFile } = require('child_process');

const HOSTS = Object.freeze({ win32: 'windows', linux: 'linux', darwin: 'macos' });
const RUNTIMES = Object.freeze({ NATIVE: 'native', WINE: 'wine', NONE: 'none' });
const MAX_WINE_ARGS = 16;
const MAX_WINE_ENV = 24;
// Bare command names are resolved through PATH, so only the well-known Wine
// launchers are allowed. Anything else must be an absolute path. This keeps
// the version probe (and any later spawn) from executing an attacker-chosen
// binary found via PATH hijacking.
const ALLOWED_WINE_COMMANDS = Object.freeze(['wine', 'wine64']);

function isAbsoluteExecutable(raw) {
  return path.isAbsolute(raw) || path.win32.isAbsolute(raw) || path.posix.isAbsolute(raw);
}

// Allowlist gate for anything that ends up as the spawned binary. `execFile`
// never runs a shell, but a user-controlled file path still means arbitrary
// binary execution, so the probe only runs allowlisted bare names or absolute
// paths with no shell metacharacters or control characters.
function isAllowedWineBinary(candidate) {
  if (typeof candidate !== 'string' || !candidate || candidate.length > 4096) return false;
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return false;
  if (/[;&|<>$`\n\r"']/.test(candidate)) return false;
  if (isAbsoluteExecutable(candidate)) return true;
  return ALLOWED_WINE_COMMANDS.includes(candidate);
}

function hostPlatform(platform = process.platform) {
  return HOSTS[platform] || 'unsupported';
}

/*
 * The target is read from the registered executable, which is the only
 * authoritative signal we have: SteamCMD installs PalServer.exe for the
 * Windows build and PalServer.sh for the Linux one.
 */
function targetPlatform(server) {
  const executable = String(server?.executable || '').trim();
  if (!executable) return 'unknown';
  const base = path.basename(executable).toLowerCase();
  if (base.endsWith('.exe') || base.endsWith('.bat') || base.endsWith('.cmd')) return 'windows';
  if (base.endsWith('.sh') || base === 'palserver' || base.endsWith('-linux')) return 'linux';
  return 'unknown';
}

function invalidText(value, max = 512) {
  return typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value);
}

/*
 * Normalize the per-server Wine settings. Anything that fails validation is
 * dropped rather than repaired, and `issues` explains why - a half-understood
 * launch command is worse than no Wine at all. Nothing here is ever passed to
 * a shell: the launch plan spawns the executable directly.
 */
function safeWine(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const issues = [];
  let executable = null;
  if (input.executable != null && input.executable !== '') {
    const raw = String(input.executable);
    if (invalidText(raw, 4096)) issues.push('The Wine executable path is not a usable path.');
    else if (/[;&|<>$`\n\r"']/.test(raw)) issues.push('The Wine executable path contains unsupported characters.');
    else if (!isAbsoluteExecutable(raw) && !ALLOWED_WINE_COMMANDS.includes(raw)) issues.push('Enter an absolute path or a supported Wine command (wine, wine64).');
    else executable = raw;
  }
  let prefix = null;
  if (input.prefix != null && input.prefix !== '') {
    const raw = String(input.prefix);
    if (invalidText(raw, 4096) || !path.isAbsolute(raw)) issues.push('The Wine prefix must be an absolute path.');
    else prefix = raw;
  }
  const args = [];
  for (const item of Array.isArray(input.args) ? input.args.slice(0, MAX_WINE_ARGS) : []) {
    const raw = String(item);
    if (invalidText(raw)) { issues.push('A Wine launch argument contains unsupported characters.'); continue; }
    if (raw.trim()) args.push(raw);
  }
  const env = {};
  const entries = Object.entries(input.env && typeof input.env === 'object' && !Array.isArray(input.env) ? input.env : {}).slice(0, MAX_WINE_ENV);
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key))) { issues.push(`Ignored an invalid environment name: ${String(key).slice(0, 32)}`); continue; }
    if (invalidText(String(raw), 4096)) { issues.push(`Ignored an invalid value for ${key}.`); continue; }
    env[String(key)] = String(raw);
  }
  const enabled = !!input.enabled && !!executable;
  if (input.enabled && !executable) issues.push('Wine cannot be enabled without an executable.');
  return { enabled, executable, prefix, args, env, issues };
}

/*
 * What the API and the UI are allowed to see. Environment values can hold
 * credentials, so only their names leave the process.
 */
function publicWine(wine) {
  const safe = safeWine(wine);
  return {
    enabled: safe.enabled,
    executable: safe.executable,
    prefix: safe.prefix,
    args: safe.args,
    envKeys: Object.keys(safe.env),
    issues: safe.issues,
  };
}

/*
 * Detection only. A missing Wine is reported, never installed.
 */
function detectWine(wine, { platform = process.platform, run } = {}) {
  const safe = safeWine(wine);
  // If the operator explicitly configured an executable but it failed
  // validation, do not fall back to the PATH default - report it as not
  // configured so the UI surfaces the validation issue instead of probing an
  // unrelated binary.
  const rawExecutable = wine && typeof wine === 'object' && !Array.isArray(wine) ? wine.executable : undefined;
  const hadExplicitExecutable = rawExecutable != null && rawExecutable !== '';
  if (hadExplicitExecutable && !safe.executable) {
    return Promise.resolve({ available: false, path: null, version: null, error: 'not_configured' });
  }
  const candidate = safe.executable || (platform === 'linux' ? 'wine' : null);
  if (!candidate) return Promise.resolve({ available: false, path: null, version: null, error: 'not_configured' });
  // Allowlist gate directly before the spawn: CodeQL flags `execFile` with a
  // user-controlled file even when it never uses a shell, because it would
  // still execute an arbitrary binary. Only allowlisted bare names or absolute
  // paths reach the probe; anything else is treated as not configured.
  if (!isAllowedWineBinary(candidate)) {
    return Promise.resolve({ available: false, path: candidate, version: null, error: 'not_configured' });
  }
  const exec = run || ((file, args) => new Promise((resolve) => {
    // Defense in depth: the injectable `run` hook is test-only, but the
    // default runner re-validates so a future caller cannot bypass the gate.
    // `shell: false` is explicit - no shell is ever used - and argv is fixed
    // to `['--version']` by the caller below.
    if (!isAllowedWineBinary(file) || !Array.isArray(args) || args.length !== 1 || args[0] !== '--version') {
      resolve({ ok: false, error: 'not_configured' });
      return;
    }
    execFile(file, args, { timeout: 5000, windowsHide: true, shell: false }, (error, stdout) => {
      resolve(error ? { ok: false, error: error.message } : { ok: true, stdout: String(stdout || '') });
    });
  }));
  return Promise.resolve(exec(candidate, ['--version'])).then((result) => (result && result.ok
    ? { available: true, path: candidate, version: String(result.stdout || '').trim().slice(0, 120) || null, error: null }
    : { available: false, path: candidate, version: null, error: 'not_detected' }));
}

/*
 * The compatibility verdict for one server. `runtime` is what a launch would
 * have to go through; `supported` is whether Hostkind is willing to run it at
 * all. Unsupported combinations are explained, never guessed.
 */
function compatibility({ server, wine, host = hostPlatform(), wineDetection = null } = {}) {
  const target = targetPlatform(server);
  const safe = safeWine(wine ?? server?.palworldWine);
  const detection = wineDetection || { available: false, path: safe.executable, version: null, error: 'unchecked' };
  const base = { host, target, wine: publicWine(safe), wineDetected: detection.available, wineVersion: detection.version || null };
  if (target === 'unknown') {
    return { ...base, runtime: RUNTIMES.NONE, supported: false, reason: 'unknown_target', explanation: 'The server target platform could not be determined from its executable.' };
  }
  if (host === 'unsupported' || host === 'macos') {
    return { ...base, runtime: RUNTIMES.NONE, supported: false, reason: 'unsupported_host', explanation: 'Palworld server management is supported on Windows and Linux hosts.' };
  }
  if (target === host) {
    return { ...base, runtime: RUNTIMES.NATIVE, supported: true, reason: 'native', explanation: null };
  }
  if (target === 'windows' && host === 'linux') {
    if (!safe.enabled) {
      return { ...base, runtime: RUNTIMES.WINE, supported: false, reason: 'wine_not_configured', explanation: 'A Windows-target server on a Linux host needs an explicitly configured Wine runtime.' };
    }
    if (!detection.available) {
      return { ...base, runtime: RUNTIMES.WINE, supported: false, reason: 'wine_not_detected', explanation: 'The configured Wine executable could not be run. Install or correct it; Hostkind does not install Wine.' };
    }
    return { ...base, runtime: RUNTIMES.WINE, supported: true, reason: 'wine', explanation: null };
  }
  return { ...base, runtime: RUNTIMES.NONE, supported: false, reason: 'no_runtime', explanation: 'Running a Linux-target Palworld server on a Windows host is not supported.' };
}

/*
 * Turn the executable plus the verdict into the exact spawn arguments. The
 * caller spawns without a shell, so quoting is never our problem.
 */
function launchPlan({ executable, args = [], wine, host = hostPlatform(), target }) {
  const safe = safeWine(wine);
  const platform = target || (String(executable || '').toLowerCase().endsWith('.exe') ? 'windows' : 'linux');
  if (platform !== 'windows' || host !== 'linux' || !safe.enabled) {
    return { bin: executable, args: [...args], env: null, runtime: RUNTIMES.NATIVE };
  }
  // Never hand an unvetted binary to the spawner, even if validation evolves.
  if (!isAllowedWineBinary(safe.executable)) {
    return { bin: executable, args: [...args], env: null, runtime: RUNTIMES.NATIVE };
  }
  const env = { ...safe.env };
  if (safe.prefix) env.WINEPREFIX = safe.prefix;
  return { bin: safe.executable, args: [...safe.args, executable, ...args], env, runtime: RUNTIMES.WINE };
}

/*
 * The registered Windows executable is normally the launcher (PalServer.exe),
 * a small bootstrap that spawns the real server - PalServer-Win64-Shipping-
 * Cmd.exe - as a grandchild. That grandchild allocates its own console window
 * (the window that pops up on Windows), and writes to the console screen
 * buffer rather than to stdout, so the panel's pipe stays empty.
 *
 * The inner server binary is the plain PalServer-Win64-Shipping.exe, a
 * console-subsystem app: spawned with CREATE_NO_WINDOW it gets no window at
 * all. Launching it directly (with the UE project name as the first argument,
 * exactly as the launcher would) is the headless path.
 *
 * Returns the inner binary path when `executable` is the launcher, or null
 * for anything else (a manually registered inner binary, a Linux target, ...).
 * Existence is the caller's concern - this is pure path logic.
 */
function innerServerBinary(executable) {
  const base = path.basename(String(executable || '')).toLowerCase();
  if (base !== 'palserver.exe') return null;
  return path.join(path.dirname(executable), 'Pal', 'Binaries', 'Win64', 'PalServer-Win64-Shipping.exe');
}

module.exports = {
  HOSTS, RUNTIMES, ALLOWED_WINE_COMMANDS,
  hostPlatform, targetPlatform, safeWine, publicWine, detectWine, compatibility, launchPlan,
  innerServerBinary, isAllowedWineBinary,
};
