'use strict';

/*
 * The .NET runtime a server binary needs, and whether this host can supply it.
 *
 * TShock and tModLoader are framework-dependent .NET applications: the files
 * Hostkind downloads contain the game, not the runtime that runs it. When the
 * runtime is absent - or present in a version the app does not accept - the
 * process prints the .NET host's own diagnostic and exits before a single line
 * of server output:
 *
 *   You must install .NET to run this application.
 *   .NET location: Not found
 *   Failed to resolve libhostfxr.so [not found]
 *
 * That text names neither the server nor the fix, so this module turns it into
 * a refusal Hostkind can make before spawning, from evidence rather than
 * remembered trivia:
 *
 *   - What the app requires comes from the app itself: its sibling
 *     `*.runtimeconfig.json`, or - for a single-file build like TShock's, where
 *     that file is bundled inside the executable - the same JSON read out of
 *     the binary. No table of "TShock version X needs .NET Y" is kept anywhere;
 *     such a table is wrong the day upstream retargets.
 *   - What the host has comes from the install root's
 *     `shared/Microsoft.NETCore.App` directory, which is what the .NET host
 *     itself reads.
 *
 * The second job is `DOTNET_ROOT`. A .NET apphost does NOT look at `PATH`: it
 * checks `DOTNET_ROOT`, the registered install location, and the OS default
 * directory, in that order. An operator who installed .NET with
 * dotnet-install.sh has it in `~/.dotnet` with a symlink on `PATH` - visible to
 * every `dotnet` command they type, invisible to the apphost. When discovery
 * only finds the runtime through `PATH`, the caller gets a `DOTNET_ROOT` entry
 * to put in the child's environment, which is exactly what the install script's
 * own instructions tell operators to export.
 */

const fs = require('fs');
const path = require('path');
const { executableOnPath } = require('./modules/registration.cjs');

const FRAMEWORK_NAME = 'Microsoft.NETCore.App';

// A single-file bundle stores the app's runtimeconfig as an ordinary member,
// uncompressed by default, so the JSON sits in the file as plain text. The scan
// is bounded on every axis - chunk size, overlap, object size, file size - so a
// binary that never contains the marker costs a linear read and nothing else.
const MARKER = '"runtimeOptions"';
const CHUNK_BYTES = 1024 * 1024;
const OVERLAP_BYTES = 32 * 1024;
const MAX_OBJECT_BYTES = 32 * 1024;
const MAX_SCAN_BYTES = 256 * 1024 * 1024;

/* ------------------------------------------------------------ requirement -- */

function frameworkFromConfig(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { return null; }
  const options = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.runtimeOptions : null;
  if (!options || typeof options !== 'object') return null;
  // A self-contained build carries its own runtime; the host installation is
  // irrelevant to it and must not be used to refuse a start.
  if (Array.isArray(options.includedFrameworks) && options.includedFrameworks.length) {
    return { name: FRAMEWORK_NAME, version: null, selfContained: true };
  }
  const frameworks = Array.isArray(options.frameworks)
    ? options.frameworks
    : (options.framework ? [options.framework] : []);
  // A single unnamed entry is the shared framework: the name is only there to
  // tell several apart, and a config that omits it must not silently skip the
  // check.
  const entry = frameworks.find((item) => item && String(item.name) === FRAMEWORK_NAME)
    || (frameworks.length === 1 && frameworks[0] && frameworks[0].name == null ? frameworks[0] : null);
  if (!entry || !entry.version) return null;
  return { name: FRAMEWORK_NAME, version: String(entry.version), selfContained: false };
}

// The `{ ... }` that encloses `text[index]`, with quotes and escapes respected
// so a brace inside a string cannot end the object early.
function enclosingObject(text, index) {
  let start = index;
  while (start >= 0 && text[start] !== '{') start -= 1;
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  const limit = Math.min(text.length, start + MAX_OBJECT_BYTES);
  for (let i = start; i < limit; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function frameworkFromText(text) {
  let from = 0;
  for (;;) {
    const index = text.indexOf(MARKER, from);
    if (index < 0) return null;
    const object = enclosingObject(text, index);
    const found = object ? frameworkFromConfig(object) : null;
    if (found) return found;
    from = index + MARKER.length;
  }
}

// Read the config out of the executable itself. latin1 keeps string offsets and
// byte offsets aligned; the JSON this looks for is ASCII.
function frameworkFromBundle(file, size) {
  if (size > MAX_SCAN_BYTES) return null;
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (_) { return null; }
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let position = 0;
    let carry = '';
    while (position < size) {
      const read = fs.readSync(fd, buffer, 0, CHUNK_BYTES, position);
      if (read <= 0) break;
      const text = carry + buffer.toString('latin1', 0, read);
      const found = frameworkFromText(text);
      if (found) return found;
      carry = text.slice(-OVERLAP_BYTES);
      position += read;
    }
  } catch (_) { /* an unreadable binary fails later, with the OS's own message */ }
  finally { try { fs.closeSync(fd); } catch (_) { /* already gone */ } }
  return null;
}

function sidecarConfig(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const stem = base.toLowerCase().endsWith('.exe') || base.toLowerCase().endsWith('.dll')
    ? base.slice(0, -4)
    : base;
  try { return fs.readFileSync(path.join(dir, `${stem}.runtimeconfig.json`), 'utf8'); }
  catch { return null; }
}

// Scanning a 20 MB binary on every start would be paid twice per launch (once
// for the environment, once for the pre-flight refusal). Keyed on identity, not
// path, so replacing the file by an update invalidates the entry.
const requirementCache = new Map();

/*
 * What `app` needs from the host, or null when the app does not say.
 *
 * null means "no evidence", never "assume it is fine to guess": callers treat
 * it as a reason to stay out of the way, because a native binary (vanilla
 * Terraria) and a build whose config could not be read are indistinguishable
 * from here.
 */
function requiredFramework(app) {
  const file = String(app == null ? '' : app).trim();
  if (!file) return null;
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return null; }
  if (!stat.isFile()) return null;
  const key = `${path.resolve(file)}|${stat.size}|${stat.mtimeMs}`;
  if (requirementCache.has(key)) return requirementCache.get(key);
  const sidecar = sidecarConfig(file);
  const found = (sidecar ? frameworkFromConfig(sidecar) : null) || frameworkFromBundle(file, stat.size);
  if (requirementCache.size > 64) requirementCache.clear();
  requirementCache.set(key, found);
  return found;
}

/* --------------------------------------------------------------- the host -- */

// An install root is a directory with a host resolver in it. The check keeps a
// stale `DOTNET_ROOT` or a leftover empty folder from being reported as an
// installation the apphost can use.
function isInstallRoot(dir) {
  if (!dir) return false;
  try { return fs.statSync(path.join(dir, 'host', 'fxr')).isDirectory(); }
  catch { return false; }
}

function defaultRoots(platform, env) {
  if (platform === 'win32') {
    return [env.ProgramW6432, env.ProgramFiles, 'C:\\Program Files']
      .filter(Boolean)
      .map((base) => path.join(String(base), 'dotnet'));
  }
  if (platform === 'darwin') return ['/usr/local/share/dotnet'];
  return ['/usr/share/dotnet', '/usr/lib/dotnet'];
}

// The location a .NET installer registers for apphosts to find. Same files the
// host itself reads, in the same order.
function registeredRoots(platform) {
  if (platform === 'win32') return [];
  const roots = [];
  for (const file of ['/etc/dotnet/install_location_x64', '/etc/dotnet/install_location']) {
    try {
      const line = String(fs.readFileSync(file, 'utf8')).split('\n')[0].trim();
      if (line) roots.push(line);
    } catch (_) { /* absent on every host that used the default location */ }
  }
  return roots;
}

function rootFromPath(findRuntime) {
  const lookup = typeof findRuntime === 'function' ? findRuntime : executableOnPath;
  let found;
  try { found = lookup('dotnet'); } catch (_) { return null; }
  if (!found) return null;
  try { return path.dirname(fs.realpathSync(String(found))); }
  catch { return path.dirname(String(found)); }
}

/*
 * The .NET installation this host would use, and how it was found.
 *
 * The order mirrors the apphost's own search, with two additions at the ends: a
 * runtime the package brought with it (tModLoader bundles one) wins outright,
 * and `PATH` is consulted last because the apphost never looks there. `source`
 * is what tells the caller whether the child needs `DOTNET_ROOT`: everything
 * except `path` and `bundled` is somewhere the apphost already looks.
 */
function discoverInstallRoot(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  // `roots` replaces the OS-wide locations. It exists so a test can ask what a
  // host with no system-wide .NET does without depending on the machine it runs
  // on; nothing in the product passes it.
  const systemRoots = Array.isArray(options.roots)
    ? options.roots.map((root) => [root, 'default'])
    : [
      ...registeredRoots(platform).map((root) => [root, 'registered']),
      ...defaultRoots(platform, env).map((root) => [root, 'default']),
    ];
  const candidates = [
    [options.hint, 'bundled'],
    [env.DOTNET_ROOT, 'env'],
    [env.DOTNET_ROOT_X64, 'env'],
    ...systemRoots,
    [rootFromPath(options.findRuntime), 'path'],
  ];
  for (const [candidate, source] of candidates) {
    const root = candidate ? String(candidate).trim() : '';
    if (root && isInstallRoot(root)) {
      return { root, source, injected: source === 'path' || source === 'bundled' };
    }
  }
  return null;
}

function versionParts(version) {
  return String(version).split('-')[0].split('.').map((part) => {
    const value = Number(part);
    return Number.isFinite(value) ? value : 0;
  });
}

function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

// Shared-framework versions installed under a root, newest first.
function installedFrameworks(root) {
  const dir = path.join(String(root || ''), 'shared', FRAMEWORK_NAME);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  return entries
    .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && /^\d+\.\d+/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => compareVersions(b, a));
}

/*
 * Whether an installed runtime can run an app that asks for `required`.
 *
 * This is .NET's default roll-forward (`Minor`): a later patch or minor of the
 * same major rolls forward, an earlier version does not, and a different major
 * never does without the operator opting in. Reproducing the default is the
 * point - Hostkind must refuse exactly what the apphost would refuse, no more.
 */
function satisfies(required, installed) {
  if (!required) return true;
  const major = versionParts(required)[0];
  return (installed || []).some((version) => versionParts(version)[0] === major && compareVersions(version, required) >= 0);
}

/* ------------------------------------------------------------- the verdict -- */

function majorOf(version) {
  return versionParts(version)[0];
}

/*
 * "Can this host run this app, and what does the child need in its
 * environment?"
 *
 * Returns `{ ok: true }` whenever there is no evidence of a problem - an app
 * that states no framework, a self-contained build, a missing file - because a
 * refusal without evidence is worse than the .NET host's own message. When it
 * does refuse, `error` names the server, the version needed, and the version
 * present, which is the whole content of the diagnostic the operator would
 * otherwise have to decode.
 */
function inspect(options = {}) {
  const label = options.label || 'This server';
  const required = requiredFramework(options.app);
  if (!required || required.selfContained || !required.version) {
    return { ok: true, required, root: null, source: null, installed: [], env: null };
  }
  const major = majorOf(required.version);
  const found = discoverInstallRoot(options);
  if (!found) {
    return {
      ok: false,
      code: 'runtime_missing',
      required,
      root: null,
      source: null,
      installed: [],
      env: null,
      error: `${label} runs on the .NET ${major} runtime, and no .NET installation was found on this host. Install the .NET ${major} runtime, then start the server again.`,
    };
  }
  const installed = installedFrameworks(found.root);
  if (!satisfies(required.version, installed)) {
    return {
      ok: false,
      code: 'runtime_version',
      required,
      root: found.root,
      source: found.source,
      installed,
      env: null,
      error: installed.length
        ? `${label} runs on the .NET ${major} runtime, and the .NET installation at ${found.root} has only ${installed.join(', ')}. Install the .NET ${major} runtime, then start the server again.`
        : `${label} runs on the .NET ${major} runtime, and the .NET installation at ${found.root} has no runtime installed. Install the .NET ${major} runtime, then start the server again.`,
    };
  }
  return {
    ok: true,
    required,
    root: found.root,
    source: found.source,
    installed,
    // Only when the apphost would not find this installation by itself.
    env: found.injected ? { DOTNET_ROOT: found.root } : null,
  };
}

// Whether any .NET installation exists at all. Used where there is nothing to
// inspect yet - the version list, before anything is downloaded.
function hasRuntime(options = {}) {
  return !!discoverInstallRoot(options);
}

module.exports = {
  FRAMEWORK_NAME,
  requiredFramework,
  discoverInstallRoot,
  installedFrameworks,
  satisfies,
  compareVersions,
  inspect,
  hasRuntime,
};
