'use strict';

/*
 * Terraria installation and version selection (docs/terraria/01-installation-versions.md).
 *
 * This module owns everything about *getting a Terraria server onto disk*:
 * resolving what versions exist upstream, downloading one, validating the
 * archive, extracting it, resolving how it is launched, and promoting it into
 * the destination folder. `lib/dedicatedServerInstaller.cjs` keeps the
 * SteamCMD-based games (Valheim, Palworld) and delegates Terraria here.
 *
 * Three rules shape the file:
 *
 *   1. **No version tables.** Every list is resolved at request time from the
 *      upstream source and cached in-process for ten minutes. A cold or
 *      rate-limited source degrades to the last good answer flagged `stale`;
 *      it never turns into a hardcoded fallback list.
 *   2. **No shell.** tModLoader and TShock ship `.sh`/`.bat` wrappers. Hostkind
 *      resolves the real runtime and spawns an argv array. `buildLaunchPlan`
 *      refuses to return a wrapper script as the executable, and there is no
 *      code path here that builds a command string.
 *   3. **Nothing is written to the destination until the install succeeded.**
 *      The archive is validated before a single file is extracted, extraction
 *      goes to a sibling staging directory, and the last step is one rename.
 *      A failure at any phase leaves the destination exactly as it was.
 *
 * Compatibility (which Terraria version a TShock or tModLoader build targets)
 * is read from upstream metadata or reported as `null`. It is never inferred
 * from a version-number heuristic.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const yauzl = require('yauzl');
const { checkEntry, finalize, ArchiveError } = require('./archiveGuard.cjs');
const { extractRuntimeArchive, tarInvocation } = require('./runtimeArchive.cjs');
const { Transaction } = require('./fsTransaction.cjs');
const operations = require('./operations.cjs');
const snapshots = require('./snapshots.cjs');
const { executableOnPath } = require('./modules/registration.cjs');
const dotnetRuntime = require('./dotnetRuntime.cjs');
const { VARIANTS, isVariant, resolveVariant } = require('./modules/terraria/variants.cjs');

const USER_AGENT = 'Hostkind/1.0';
// Mirrors lib/palworld-workshop.cjs's CATALOG_TTL_MS: long enough that opening
// the wizard twice does not hit GitHub twice, short enough that a release
// published minutes ago shows up without restarting the panel.
const CATALOG_TTL_MS = 10 * 60_000;
const RELEASE_PAGE_SIZE = 30;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ARCHIVE_ENTRIES = 200_000;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;

/*
 * Where each variant's truth lives. `kind` selects the parser below; nothing
 * here is a version, a URL to a specific build, or a compatibility mapping -
 * only the endpoint that answers those questions today.
 */
const SOURCES = Object.freeze({
  vanilla: Object.freeze({
    kind: 'terraria.org',
    label: 'terraria.org',
    names: 'https://terraria.org/api/get/dedicated-servers-names',
    download: 'https://terraria.org/api/download/pc-dedicated-server/',
  }),
  tmodloader: Object.freeze({
    kind: 'github',
    label: 'github.com/tModLoader/tModLoader',
    releases: `https://api.github.com/repos/tModLoader/tModLoader/releases?per_page=${RELEASE_PAGE_SIZE}`,
  }),
  tshock: Object.freeze({
    kind: 'github',
    label: 'github.com/Pryaxis/TShock',
    releases: `https://api.github.com/repos/Pryaxis/TShock/releases?per_page=${RELEASE_PAGE_SIZE}`,
  }),
});

// Prerelease markers, matching `isStableNeoForge`'s posture in server.js: a
// build that says it is not finished is not offered, whatever the API's own
// `prerelease` flag says.
const UNSTABLE = /(?:^|[^a-z])(?:alpha|beta|rc|pre|preview|prerelease|snapshot|nightly|dev|test|legacy)(?:[^a-z]|\d|$)/i;

// tModLoader publishes one cross-platform package per release; ExampleMod.zip
// in the same release is a mod, not a server. The name is matched, never a
// position in the asset array.
const TMODLOADER_ASSET = /^tmodloader\.zip$/i;
const TMODLOADER_ENTRY = 'tModLoader.dll';
const TMODLOADER_RUNTIME_CONFIG = 'tModLoader.runtimeconfig.json';

// Launcher wrappers Hostkind must never spawn (docs/terraria/README.md
// "No shell execution"). Enforced in buildLaunchPlan, not just documented.
const WRAPPER_EXTENSIONS = new Set(['.sh', '.bat', '.cmd', '.ps1', '.command']);

const VANILLA_EXECUTABLES = Object.freeze({
  win32: Object.freeze(['TerrariaServer.exe']),
  linux: Object.freeze(['TerrariaServer.bin.x86_64']),
  darwin: Object.freeze(['Terraria Server']),
});

const TSHOCK_EXECUTABLES = Object.freeze({
  win32: Object.freeze(['TShock.Server.exe']),
  linux: Object.freeze(['TShock.Server']),
  darwin: Object.freeze(['TShock.Server']),
});

// TShock names its assets `<name>-<os>-<arch>-Release.zip`. Both halves are
// matched as whole tokens so `linux-arm` never satisfies a `linux-arm64` host.
// The alternatives per host are spelling variants of the same platform - TShock
// 5.2.1 through 5.2.4 say `linux-amd64` where 5.2.0 and 6.x say `linux-x64` -
// not a table of which release supports what.
const TSHOCK_OS = Object.freeze({ win32: ['win', 'windows'], linux: ['linux'], darwin: ['osx', 'macos', 'darwin'] });
const TSHOCK_ARCH = Object.freeze({ x64: ['x64', 'amd64', 'x86_64'], arm64: ['arm64', 'aarch64'], arm: ['arm'] });

// Windows device names, same posture as normalizeName in lib/worlds.cjs.
const RESERVED_NAMES = new Set(['con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);

class TerrariaInstallError extends Error {
  constructor(message, status = 400, code = 'terraria_install_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(message, status, code) {
  throw new TerrariaInstallError(message, status, code);
}

function assertVariant(variant) {
  if (!isVariant(variant)) fail(`Unknown Terraria variant: ${variant}`, 400, 'unknown_variant');
  return variant;
}

/* ------------------------------------------------------------------ host --
 *
 * Everything host-dependent goes through one object so a test can ask "what
 * would this look like on a Windows arm64 box with no .NET?" without touching
 * the real machine.
 */
function hostFrom(options = {}) {
  const host = options.host || {};
  return {
    platform: host.platform || process.platform,
    arch: host.arch || process.arch,
    findRuntime: typeof host.findRuntime === 'function' ? host.findRuntime : executableOnPath,
    // The .NET side of "host-dependent": the environment an apphost would read
    // and, for a test, the OS-wide install locations it would look in.
    env: host.env && typeof host.env === 'object' && !Array.isArray(host.env) ? host.env : process.env,
    dotnetRoots: Array.isArray(host.dotnetRoots) ? host.dotnetRoots : null,
  };
}

/* ------------------------------------------------------------- upstream -- */

function statusFromError(error) {
  if (!error) return null;
  if (Number.isInteger(error.status)) return error.status;
  const match = /\bHTTP (\d{3})\b/.exec(String(error.message || ''));
  return match ? Number(match[1]) : null;
}

// A rate-limited or throttled source is not a broken source: it means "ask me
// later", which is exactly what the stale cache is for.
function isThrottled(error) {
  const status = statusFromError(error);
  return status === 403 || status === 429 || status === 503;
}

async function defaultFetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*' },
    });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} from ${url}`);
      error.status = response.status;
      throw error;
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function requestText(url, options = {}) {
  const impl = typeof options.fetchText === 'function' ? options.fetchText : defaultFetchText;
  return impl(url);
}

/* --------------------------------------------------------- normalization -- */

/*
 * The vanilla archive name carries the packed version: `terraria-server-1449.zip`
 * is 1.4.4.9. Each digit is one component - that is the mapping terraria.org's
 * own download page uses, and it is derived here rather than tabulated.
 */
function unpackVanillaVersion(packed) {
  const digits = String(packed || '').trim();
  if (!/^\d{3,6}$/.test(digits)) return null;
  return digits.split('').join('.');
}

function parseVanillaNames(raw) {
  let names = [];
  try {
    const parsed = JSON.parse(raw);
    names = Array.isArray(parsed) ? parsed.map((value) => String(value || '')) : [];
  } catch (_) { /* the endpoint has served bare text before; fall through */ }
  const filenames = names.filter((name) => /^terraria-server-\d+\.zip$/i.test(name));
  if (!filenames.length) {
    const match = String(raw || '').match(/terraria-server-(\d+)\.zip/i);
    if (match) filenames.push(match[0]);
  }
  // The endpoint has repeated the same name twice; de-duplicate rather than
  // presenting one release as two.
  return [...new Set(filenames)];
}

function vanillaEntries(raw) {
  const entries = [];
  for (const filename of parseVanillaNames(raw)) {
    const packed = (filename.match(/(\d+)/) || [])[1];
    const gameVersion = unpackVanillaVersion(packed);
    if (!packed || !gameVersion) continue;
    entries.push({
      id: packed,
      gameVersion,
      publishedAt: null,
      // terraria.org exposes the current release only; inventing a history of
      // past archives to fill the dropdown is not an option this file has.
      stable: true,
      assets: [{
        name: filename,
        url: `${SOURCES.vanilla.download}${encodeURIComponent(filename)}`,
        size: null,
      }],
    });
  }
  return entries;
}

function releaseIsStable(release) {
  if (release.draft || release.prerelease) return false;
  const tag = String(release.tag_name || '');
  // The tag is the version; the release name is prose that legitimately
  // contains words like "Preview" for the branch it was built from, so only
  // the branch marker in the name is consulted (see gameVersionFromTml).
  return !UNSTABLE.test(tag);
}

/*
 * tModLoader release names read `1.4.4-refs/heads/stable Version Update: v2026.05.3.0`.
 * The leading segment is the Terraria version the build targets, and the branch
 * marker after it says whether the build is a stable or preview line. Both are
 * read from the payload; neither is guessed from the tag's date-based number.
 */
function tmodloaderRelease(release) {
  const name = String(release.name || '');
  const gameVersion = (name.match(/^\s*(\d+(?:\.\d+)+)/) || [])[1] || null;
  const branch = (name.match(/refs\/heads\/([A-Za-z0-9_.-]+)/) || [])[1] || '';
  const asset = (release.assets || []).find((item) => TMODLOADER_ASSET.test(String(item.name || '')));
  return {
    id: String(release.tag_name || ''),
    gameVersion,
    publishedAt: release.published_at || null,
    stable: releaseIsStable(release) && (!branch || branch.toLowerCase() === 'stable'),
    assets: asset ? [{ name: String(asset.name), url: String(asset.browser_download_url || ''), size: asset.size ?? null }] : [],
  };
}

/*
 * TShock states its supported Terraria version in the asset name
 * (`TShock-6.1.0-for-Terraria-1.4.5.6-linux-x64-Release.zip`). When a release
 * does not - the beta assets are named `TShock-Beta-<platform>-Release.zip` -
 * the game version is reported as unknown rather than derived from the TShock
 * version number.
 */
function tshockRelease(release) {
  const assets = (release.assets || [])
    .filter((item) => /\.zip$/i.test(String(item.name || '')))
    .map((item) => ({ name: String(item.name), url: String(item.browser_download_url || ''), size: item.size ?? null }));
  const stated = assets.map((item) => (item.name.match(/for-Terraria-(\d+(?:\.\d+)+)/i) || [])[1]).find(Boolean)
    || (String(release.name || '').match(/Terraria\s+(\d+(?:\.\d+)+)/i) || [])[1]
    || (String(release.body || '').match(/Terraria\s+(\d+(?:\.\d+)+)/i) || [])[1]
    || null;
  return {
    id: String(release.tag_name || ''),
    gameVersion: stated,
    publishedAt: release.published_at || null,
    stable: releaseIsStable(release),
    assets,
  };
}

function parseReleases(variant, raw) {
  let payload;
  try { payload = JSON.parse(raw); }
  catch { fail(`${SOURCES[variant].label} returned a response Hostkind could not read.`, 502, 'invalid_release_payload'); }
  if (!Array.isArray(payload)) {
    // GitHub answers rate limits with a JSON object, not an array.
    const message = payload && payload.message ? String(payload.message) : 'an unexpected response';
    const error = new TerrariaInstallError(`${SOURCES[variant].label} returned ${message}.`, 502, 'invalid_release_payload');
    error.status = 403;
    throw error;
  }
  const mapRelease = variant === 'tmodloader' ? tmodloaderRelease : tshockRelease;
  return payload
    .filter((release) => release && !release.draft)
    .map(mapRelease)
    // Drafts, prereleases and releases without a usable asset never reach the
    // list: an operator cannot install what Hostkind will not offer, and a
    // client-supplied id is checked against this same list.
    .filter((entry) => entry.id && entry.stable && entry.assets.length)
    .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
}

/* ------------------------------------------------------------- catalogue -- */

const catalogue = new Map(); // variant -> { entries, retrievedAt, expiresAt }

async function fetchEntries(variant, options = {}) {
  const source = SOURCES[variant];
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const cached = catalogue.get(variant) || null;
  if (!options.force && cached && cached.expiresAt > now) {
    return { entries: cached.entries, retrievedAt: cached.retrievedAt, stale: false, error: null };
  }
  try {
    const raw = await requestText(source.kind === 'github' ? source.releases : source.names, options);
    const entries = source.kind === 'github' ? parseReleases(variant, raw) : vanillaEntries(raw);
    if (!entries.length) fail(`${source.label} listed no installable ${variant} build.`, 502, 'no_versions');
    catalogue.set(variant, { entries, retrievedAt: now, expiresAt: now + CATALOG_TTL_MS });
    return { entries, retrievedAt: now, stale: false, error: null };
  } catch (error) {
    // Unauthenticated GitHub calls are rate-limited, and terraria.org has bad
    // minutes. Neither may take the create wizard down: the last good answer,
    // clearly labelled stale, beats an error page.
    if (cached) {
      return {
        entries: cached.entries,
        retrievedAt: cached.retrievedAt,
        stale: true,
        error: isThrottled(error)
          ? `${source.label} is rate-limiting Hostkind right now. Showing the list from the last successful check.`
          : `${source.label} could not be reached. Showing the list from the last successful check.`,
      };
    }
    if (isThrottled(error)) {
      return { entries: [], retrievedAt: null, stale: true, error: `${source.label} is rate-limiting Hostkind right now, and Hostkind has no earlier list to fall back on. Try again in a few minutes.` };
    }
    throw error instanceof TerrariaInstallError ? error : new TerrariaInstallError(error.message, 502, 'source_unreachable');
  }
}

/*
 * Whether this host can actually run a build, and why not when it cannot.
 *
 * An unknown game version does not make a build unsupported - it makes it a
 * build whose compatibility Hostkind reports as unknown. Only a missing asset
 * or a missing runtime does.
 */
function supportFor(variant, entry, host) {
  if (variant === 'tshock') {
    if (!selectTshockAsset(entry.assets, host)) {
      return { supported: false, reasonCode: 'no_platform_asset', reason: `No TShock build is published for ${host.platform}/${host.arch}.` };
    }
    // TShock publishes framework-dependent builds: the ZIP contains the server,
    // not the runtime. Which .NET version a given build wants is only knowable
    // from the downloaded binary (buildLaunchPlan reads it), so the list can
    // only answer "is there any .NET here at all" - which is the case that
    // would otherwise end in a downloaded server that cannot start.
    if (!hasDotnet(host)) {
      return {
        supported: false,
        reasonCode: 'runtime_missing',
        reason: 'TShock runs on the .NET runtime, and no .NET installation was found on this host. Install the .NET runtime, then check again.',
      };
    }
    return { supported: true, reasonCode: null, reason: null };
  }
  if (variant === 'tmodloader') {
    if (!entry.assets.length) return { supported: false, reasonCode: 'no_platform_asset', reason: 'This tModLoader release publishes no server package.' };
    if (!host.findRuntime('dotnet')) {
      return {
        supported: false,
        reasonCode: 'runtime_missing',
        reason: 'tModLoader runs on the .NET runtime, and no "dotnet" executable was found on this host. Install the .NET runtime, then check again.',
      };
    }
    return { supported: true, reasonCode: null, reason: null };
  }
  return { supported: entry.assets.length > 0, reasonCode: entry.assets.length ? null : 'no_platform_asset', reason: entry.assets.length ? null : 'This release publishes no dedicated-server download.' };
}

// `dotnet` on PATH is the usual sign, but an operator whose install is only
// registered or in the OS default location has a perfectly usable runtime that
// PATH never mentions, so both are accepted.
function hasDotnet(host) {
  if (host.findRuntime('dotnet')) return true;
  return dotnetRuntime.hasRuntime(dotnetOptions(host));
}

// The host, in the shape lib/dotnetRuntime.cjs takes.
function dotnetOptions(host, extra = {}) {
  const options = {
    platform: host.platform,
    env: host.env,
    findRuntime: host.findRuntime,
  };
  if (host.dotnetRoots) options.roots = host.dotnetRoots;
  return { ...options, ...extra };
}

function selectTshockAsset(assets, host) {
  const osTokens = TSHOCK_OS[host.platform];
  const archTokens = TSHOCK_ARCH[host.arch];
  if (!osTokens || !archTokens) return null;
  // Whole-token match on both halves, so an `arm64` host never accepts a
  // `linux-arm` asset (and vice versa) just because one name is a prefix of
  // the other.
  const pattern = new RegExp(`[-_.](?:${osTokens.join('|')})[-_.](?:${archTokens.join('|')})[-_.]`, 'i');
  return (assets || []).find((asset) => pattern.test(asset.name)) || null;
}

function assetFor(variant, entry, host) {
  if (variant === 'tshock') return selectTshockAsset(entry.assets, host);
  return entry.assets[0] || null;
}

/*
 * The version list for one variant.
 *
 * Unsupported entries stay in the list with their reason: hiding them turns
 * "no TShock build exists for your architecture" into "the panel is broken".
 */
async function listVersions(variant, options = {}) {
  assertVariant(variant);
  const host = hostFrom(options);
  const { entries, retrievedAt, stale, error } = await fetchEntries(variant, options);
  const versions = entries.map((entry) => {
    const support = supportFor(variant, entry, host);
    const asset = assetFor(variant, entry, host);
    return {
      id: entry.id,
      gameVersion: entry.gameVersion,
      publishedAt: entry.publishedAt,
      stable: entry.stable,
      assets: entry.assets.map((item) => ({ name: item.name, size: item.size })),
      filename: asset ? asset.name : null,
      ...support,
    };
  });
  return {
    variant,
    source: SOURCES[variant].label,
    retrievedAt,
    stale,
    error: error || null,
    versions,
  };
}

// Newest stable build this host can run. The default the wizard installs when
// the operator does not pick one.
function newestSupported(list) {
  return list.versions.find((entry) => entry.supported && entry.stable) || null;
}

/*
 * Resolve one download. A client-supplied version id is looked up in the list
 * that was *just* resolved from upstream; a URL from the client is never
 * trusted, and an id outside the list is refused rather than passed through.
 */
async function resolveDownload(variant, versionId, options = {}) {
  assertVariant(variant);
  const host = hostFrom(options);
  const list = await listVersions(variant, options);
  const wanted = String(versionId == null ? '' : versionId).trim();
  const entry = wanted
    ? list.versions.find((item) => item.id === wanted)
    : newestSupported(list);
  if (wanted && !entry) {
    fail(`That ${variant} version is not in the list Hostkind resolved from ${list.source}. Refresh the version list and choose again.`, 400, 'unknown_version');
  }
  if (!entry) {
    fail(list.error || `No installable ${variant} build is available for ${host.platform}/${host.arch}.`, 409, 'no_supported_version');
  }
  if (!entry.supported) fail(entry.reason, 409, entry.reasonCode || 'unsupported_version');
  const source = await fetchEntries(variant, options);
  const raw = source.entries.find((item) => item.id === entry.id);
  const asset = assetFor(variant, raw, host);
  if (!asset || !/^https:\/\//i.test(asset.url)) {
    fail(`The download for ${variant} ${entry.id} is not available over HTTPS.`, 502, 'insecure_download');
  }
  return {
    variant,
    url: asset.url,
    filename: asset.name,
    versionId: entry.id,
    gameVersion: entry.gameVersion,
    publishedAt: entry.publishedAt,
    source: list.source,
    stale: list.stale,
  };
}

/* --------------------------------------------------------------- archive -- */

/*
 * Validate every entry of a ZIP before a byte is written.
 *
 * archiveGuard owns the rules (traversal, symlinks, entry and total size,
 * compression ratio, duplicates); this walks the central directory and feeds
 * them. Directory entries are recognized by their trailing slash and skipped,
 * because the guard treats a directory-flagged *file* entry as an attack.
 */
function validateZip(archive, limits = {}) {
  const options = { maxEntries: MAX_ARCHIVE_ENTRIES, maxTotalSize: MAX_ARCHIVE_BYTES, ...limits };
  return new Promise((resolve, reject) => {
    // `decodeStrings: false` hands us the raw entry names. yauzl would
    // otherwise reject a traversing name itself, with its own message and no
    // code - and the guard in lib/archiveGuard.cjs, which every other archive
    // in Hostkind goes through, would never see it.
    yauzl.open(archive, { lazyEntries: true, validateEntrySizes: true, decodeStrings: false }, (openError, zip) => {
      if (openError) return reject(new TerrariaInstallError('The downloaded archive could not be read.', 422, 'invalid_archive'));
      const state = { entries: 0, totalSize: 0, totalCompressedSize: 0, seen: new Set() };
      const files = [];
      const bail = (error) => {
        try { zip.close(); } catch (_) { /* already closed */ }
        reject(error instanceof ArchiveError
          ? new TerrariaInstallError(`The downloaded archive was refused: ${error.message}`, 422, error.code)
          : error);
      };
      zip.on('error', bail);
      zip.on('entry', (entry) => {
        const name = Buffer.isBuffer(entry.fileName) ? entry.fileName.toString('utf8') : String(entry.fileName || '');
        if (name.endsWith('/')) return zip.readEntry();
        try {
          files.push(checkEntry({
            fileName: name,
            uncompressedSize: entry.uncompressedSize,
            compressedSize: entry.compressedSize,
            externalFileAttributes: entry.externalFileAttributes,
          }, state, options));
          zip.readEntry();
        } catch (error) { bail(error); }
      });
      zip.on('end', () => {
        try { resolve({ files, ...finalize(state, options) }); }
        catch (error) { bail(error); }
      });
      zip.readEntry();
    });
  });
}

/*
 * TShock publishes a ZIP whose single member is a TAR
 * (`TShock-Beta-linux-x64-Release.tar`), so the guarded ZIP walk above is only
 * half the check. `tar -tvf` lists the members without extracting them, which
 * is the only pre-write look at a TAR available without a TAR parser.
 */
function validateTar(archive) {
  // Names come from `-tf`, which prints one member per line and nothing else -
  // the only listing format every tar implementation agrees on. Entry *types*
  // come from `-tvf`, where GNU tar and bsdtar both start the line with the
  // mode string, so its first character identifies links.
  // Named by basename from its own directory, so a Windows drive letter is not
  // mistaken for a remote host - see tarInvocation.
  const tar = tarInvocation(archive);
  const names = spawnSync('tar', ['-tf', tar.name], { encoding: 'utf8', windowsHide: true, cwd: tar.cwd });
  if (names.error || names.status !== 0) fail('The downloaded archive could not be read.', 422, 'invalid_archive');
  const verbose = spawnSync('tar', ['-tvf', tar.name], { encoding: 'utf8', windowsHide: true, cwd: tar.cwd });
  if (verbose.error || verbose.status !== 0) fail('The downloaded archive could not be read.', 422, 'invalid_archive');

  for (const line of String(verbose.stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    // `l` is a symbolic link, `h` a hard link: both can point outside the
    // staging directory once extracted, and neither belongs in a game server.
    if (line[0] === 'l' || line[0] === 'h') fail('The downloaded archive was refused: it contains links.', 422, 'symlink');
  }

  const members = [];
  for (const raw of String(names.stdout || '').split(/\r?\n/)) {
    const name = raw.replace(/\/+$/, '');
    if (!name.trim()) continue;
    if (/\x00/.test(name)) fail('The downloaded archive was refused: an entry name contains a NUL byte.', 422, 'nul_in_name');
    const normalized = name.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) fail('The downloaded archive was refused: it contains an absolute path.', 422, 'absolute_path');
    let depth = 0;
    for (const segment of normalized.split('/').filter(Boolean)) {
      if (segment === '..') { depth -= 1; if (depth < 0) fail('The downloaded archive was refused: an entry escapes the archive root.', 422, 'path_traversal'); }
      else if (segment !== '.') depth += 1;
    }
    members.push(normalized);
  }
  if (!members.length) fail('The downloaded archive was refused: it is empty.', 422, 'empty_archive');
  return members;
}

// A ZIP that wraps a single TAR is unwrapped in place, validated first.
function unwrapNestedTar(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const tars = entries.filter((entry) => entry.isFile() && /\.tar$/i.test(entry.name));
  if (tars.length !== 1 || entries.length !== 1) return false;
  const archive = path.join(root, tars[0].name);
  validateTar(archive);
  extractRuntimeArchive(archive, root, 'tar');
  fs.unlinkSync(archive);
  return true;
}

/* ------------------------------------------------------------- discovery -- */

/*
 * Breadth-first search of the extracted tree for one of `names`.
 *
 * The vanilla archive ships `Windows/`, `Linux/` and `Mac/` side by side, so
 * the host's binary name is what selects the platform folder - Hostkind never
 * assumes `<version>/Linux/...`, because that path shape is the archive's
 * business and it has changed before.
 */
function findFile(root, names, { maxDepth = Infinity } = {}) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && wanted.has(entry.name.toLowerCase())) return full;
    }
    if (depth >= maxDepth) continue;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return null;
}

function makeExecutable(file, host) {
  if (host.platform === 'win32') return;
  try { fs.chmodSync(file, 0o755); } catch (_) { /* a read-only mount fails later, with a better message */ }
}

/*
 * tModLoader's launch plan.
 *
 * The published package ships `start-tModLoaderServer.sh`, whose real work is
 * `exec "$dotnet_dir/dotnet" tModLoader.dll "$@"` (or the system `dotnet`).
 * Hostkind resolves the same two pieces itself: the managed entry point in
 * the extracted tree, and a runtime to run it - a `dotnet` the package brought
 * with it, otherwise one on PATH. The wrapper is never executed.
 */
function resolveTmodloaderRuntime(root, host) {
  const entry = findFile(root, [TMODLOADER_ENTRY]);
  if (!entry) fail('The tModLoader package did not contain tModLoader.dll, so Hostkind cannot tell how to start it.', 422, 'entrypoint_missing');
  const installRoot = path.dirname(entry);

  let framework = null;
  try {
    const config = JSON.parse(fs.readFileSync(path.join(installRoot, TMODLOADER_RUNTIME_CONFIG), 'utf8'));
    framework = String(config?.runtimeOptions?.framework?.version || '') || null;
  } catch (_) { /* the package is allowed not to say; the message degrades */ }
  const major = framework ? framework.split('.')[0] : null;

  const bundled = findFile(installRoot, host.platform === 'win32' ? ['dotnet.exe'] : ['dotnet'], { maxDepth: 2 });
  if (bundled) {
    makeExecutable(bundled, host);
    return { entry, installRoot, runtime: bundled, runtimeSource: 'bundled', framework };
  }
  const onPath = host.findRuntime('dotnet');
  if (onPath) return { entry, installRoot, runtime: onPath, runtimeSource: 'path', framework };
  fail(
    major
      ? `tModLoader needs the .NET ${major} runtime. This package does not bundle one and no "dotnet" executable is on PATH. Install the .NET ${major} runtime and create the server again.`
      : 'tModLoader needs the .NET runtime. This package does not bundle one and no "dotnet" executable is on PATH. Install the .NET runtime and create the server again.',
    409,
    'runtime_missing',
  );
  return null;
}

/*
 * The argv Hostkind will spawn, for one extracted tree.
 *
 * Always `{ executable, args, cwd }` with args as an array. The wrapper check
 * at the end is the enforcement of the no-shell rule: if a future package
 * layout ever led discovery to a `.sh`, this throws instead of spawning it.
 */
function buildLaunchPlan(variant, root, configFile, host) {
  let plan;
  if (variant === 'tmodloader') {
    const resolved = resolveTmodloaderRuntime(root, host);
    plan = {
      executable: resolved.runtime,
      args: [resolved.entry, '-server', '-config', configFile],
      cwd: resolved.installRoot,
      runtime: { kind: 'dotnet', source: resolved.runtimeSource, framework: resolved.framework, path: resolved.runtime },
    };
  } else {
    const names = variant === 'tshock' ? TSHOCK_EXECUTABLES[host.platform] : VANILLA_EXECUTABLES[host.platform];
    if (!names || !names.length) fail(`Hostkind cannot install ${variant} on ${host.platform}.`, 409, 'unsupported_platform');
    const executable = findFile(root, [...names]);
    if (!executable) {
      fail(variant === 'tshock'
        ? 'The TShock package did not contain a TShock.Server binary, so Hostkind cannot tell how to start it.'
        : 'The Terraria package did not contain a dedicated-server binary for this platform.', 422, 'executable_missing');
    }
    makeExecutable(executable, host);
    // TShock's binary is a .NET apphost, and the extracted package is the first
    // moment its runtime requirement is knowable. Refusing here costs a
    // download; not refusing costs a registered server that prints a .NET host
    // error nobody can act on every time it is started.
    const dotnet = variant === 'tshock'
      ? dotnetRuntime.inspect(dotnetOptions(host, { app: executable, label: 'TShock' }))
      : { ok: true, required: null };
    if (dotnet.ok === false) fail(dotnet.error, 409, dotnet.code);
    plan = {
      executable,
      args: ['-config', configFile],
      cwd: path.dirname(executable),
      runtime: dotnet.required && dotnet.required.version
        ? { kind: 'dotnet', source: 'host', framework: dotnet.required.version, path: executable }
        : { kind: 'native', source: 'package', framework: null, path: executable },
    };
  }
  if (WRAPPER_EXTENSIONS.has(path.extname(plan.executable).toLowerCase())) {
    fail('Hostkind refuses to start a Terraria server through a launcher script.', 500, 'wrapper_refused');
  }
  return plan;
}

/* -------------------------------------------------------- configuration -- */

/*
 * World and seed names.
 *
 * Phase 3 owns the full world-name contract; this is the subset creation needs,
 * with the same posture as `normalizeName` in lib/worlds.cjs - the name becomes
 * a file name, so separators, traversal, control characters and Windows device
 * names are refused rather than sanitized into something the operator did not
 * ask for.
 */
function normalizeWorldName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (!name) fail('A world name is required.', 400, 'world_name_required');
  if (name.length > 64) fail('World names are limited to 64 characters.', 400, 'world_name_too_long');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) {
    fail('World names may only contain letters, digits, spaces, dots, dashes and underscores.', 400, 'world_name_invalid');
  }
  if (name.endsWith('.')) fail('That world name is not a valid file name.', 400, 'world_name_invalid');
  if (RESERVED_NAMES.has(name.toLowerCase())) fail('That world name is reserved by the operating system.', 400, 'world_name_reserved');
  return name;
}

// Terraria's secret seeds are words and digits ("for the worthy", "05162020").
// Anything that could end a config line or start a new key is refused.
function normalizeSeed(raw) {
  const seed = String(raw == null ? '' : raw).trim();
  if (!seed) return '';
  if (seed.length > 64) fail('Seeds are limited to 64 characters.', 400, 'seed_too_long');
  if (!/^[A-Za-z0-9 ._'-]+$/.test(seed)) fail('Seeds may only contain letters, digits, spaces, dots, dashes, underscores and apostrophes.', 400, 'seed_invalid');
  return seed;
}

function configValue(value) {
  const text = String(value == null ? '' : value);
  if (/[\r\n]/.test(text)) fail('Server settings may not contain line breaks.', 400, 'invalid_setting');
  return text;
}

/*
 * The initial serverconfig.txt.
 *
 * Phase 4 replaces this with the round-tripping parser/serializer in
 * lib/terraria-config.cjs, which preserves comments, ordering and unknown keys
 * on *edit*. Creation writes a file that does not exist yet, so a plain
 * key=value emitter is the whole job - and it stays here so phase 4 has one
 * caller to redirect rather than a format to reverse-engineer.
 */
function serverConfigText(settings, eol = os.EOL) {
  const lines = [
    '# Written by Hostkind when this server was created.',
    '# Every setting below is editable; unknown keys are preserved.',
  ];
  for (const [key, value] of Object.entries(settings)) {
    if (value == null || value === '') continue;
    lines.push(`${key}=${configValue(value)}`);
  }
  lines.push('');
  return lines.join(eol);
}

function writeServerConfig(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serverConfigText(settings), 'utf8');
}

/* --------------------------------------------------------------- staging -- */

/*
 * A sibling of the destination, so the promoting rename is same-filesystem and
 * therefore atomic. A temp directory under the OS temp root would be a copy
 * across devices, which is exactly the half-written destination this phase
 * exists to prevent.
 */
function stagingPath(destination) {
  return path.join(path.dirname(destination), `.${path.basename(destination)}.fleetdeck-install-${crypto.randomUUID()}`);
}

function removeTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* locked; the sweep gets it */ }
}

/*
 * Promote staging into the destination.
 *
 * The destination is required to be absent or empty (POST /api/create checks
 * this first, and it is re-checked here because the check and the promotion
 * are minutes apart). An empty directory is removed so the rename can take its
 * place, and recreated if the rename fails, so a refused install leaves the
 * folder exactly as it found it.
 */
function promote(staging, destination) {
  let existed = false;
  if (fs.existsSync(destination)) {
    const entries = fs.readdirSync(destination);
    if (entries.length) fail(`${destination} is not empty.`, 409, 'destination_not_empty');
    existed = true;
    fs.rmdirSync(destination);
  }
  try {
    fs.renameSync(staging, destination);
  } catch (error) {
    if (existed) { try { fs.mkdirSync(destination, { recursive: true }); } catch (_) { /* report the original failure */ } }
    fail(`The installed files could not be moved into ${destination}: ${error.message}`, 500, 'promote_failed');
  }
}

/* --------------------------------------------------------------- install -- */

function safeArchiveName(variant, versionId, filename) {
  const base = path.basename(String(filename || '')).replace(/[^A-Za-z0-9._-]/g, '_');
  return `terraria-${variant}-${String(versionId).replace(/[^A-Za-z0-9._-]/g, '_')}-${base || 'download.zip'}`;
}

/*
 * Install one variant into `input.destination`.
 *
 * Phases, in order, all reported through `options.onPhase` so the NDJSON
 * stream in POST /api/create can narrate them: resolving, downloading,
 * verifying, extracting, locating, configuring, promoting.
 */
async function install(variant, input, options = {}) {
  assertVariant(variant);
  const host = hostFrom(options);
  const onPhase = typeof options.onPhase === 'function' ? options.onPhase : () => {};
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const download = typeof options.download === 'function' ? options.download : null;
  if (!download) fail('No download implementation was provided.', 500, 'no_download');

  const destination = path.resolve(String(input.destination || ''));
  if (!destination || destination === path.parse(destination).root) fail('Choose a destination folder for the server.', 400, 'invalid_destination');
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) {
    fail(`${destination} is not empty.`, 409, 'destination_not_empty');
  }
  const worldName = normalizeWorldName(input.worldName);
  const seed = normalizeSeed(input.seed);
  const cacheDir = options.cacheDir || path.join(os.tmpdir(), 'fleetdeck-terraria');

  onPhase('resolving');
  const release = await resolveDownload(variant, input.versionId, options);

  const staging = stagingPath(destination);
  const archive = path.join(cacheDir, safeArchiveName(variant, release.versionId, release.filename));
  let downloaded = false;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    onPhase('downloading');
    await download(release.url, archive, onProgress);
    downloaded = true;

    onPhase('verifying');
    await validateZip(archive);

    onPhase('extracting');
    fs.mkdirSync(staging, { recursive: true });
    extractRuntimeArchive(archive, staging, 'zip');
    unwrapNestedTar(staging);

    onPhase('locating');
    // Paths are resolved inside staging and rewritten to their post-promotion
    // location, so the descriptor and serverconfig.txt only ever carry the
    // final destination - never a staging path that is about to disappear.
    const finalPath = (abs) => path.join(destination, path.relative(staging, abs));
    // A path that is not inside staging is not ours to rewrite: a system
    // `dotnet` lives on PATH and stays where it is.
    const staged = (abs) => typeof abs === 'string' && (abs === staging || abs.startsWith(staging + path.sep));
    const promoted = (abs) => (staged(abs) ? finalPath(abs) : abs);
    const configFile = path.join(destination, 'serverconfig.txt');
    const plan = buildLaunchPlan(variant, staging, configFile, host);

    onPhase('configuring');
    const saveDir = path.join(destination, 'worlds');
    fs.mkdirSync(path.join(staging, 'worlds'), { recursive: true });
    writeServerConfig(path.join(staging, 'serverconfig.txt'), {
      world: path.join(saveDir, `${worldName}.wld`),
      worldpath: saveDir,
      autocreate: [1, 2, 3].includes(Number(input.worldSize)) ? Number(input.worldSize) : 2,
      worldname: worldName,
      seed,
      difficulty: [0, 1, 2, 3].includes(Number(input.difficulty)) ? Number(input.difficulty) : 0,
      maxplayers: Number(input.maxPlayers),
      port: Number(input.port),
      password: input.password || '',
      motd: input.motd || '',
      secure: 1,
      language: 'en-US',
    });

    onPhase('promoting');
    promote(staging, destination);

    return {
      executable: promoted(plan.executable),
      args: plan.args.map(promoted),
      cwd: promoted(plan.cwd),
      saveDir,
      worldName,
      configFile,
      runtime: { ...plan.runtime, path: promoted(plan.runtime.path) },
      version: {
        game: release.gameVersion,
        variant: release.versionId,
        source: release.source,
        resolvedAt: new Date().toISOString(),
      },
      stale: release.stale,
    };
  } catch (error) {
    removeTree(staging);
    throw error;
  } finally {
    if (downloaded && options.keepArchive !== true) { try { fs.unlinkSync(archive); } catch (_) { /* cached copy is harmless */ } }
  }
}

/* ---------------------------------------------------------------- update --
 *
 * An update replaces binaries. Everything that represents the operator's
 * server - worlds, the config they edited, TShock's generated state, the mods
 * they installed - is preserved, because reinstalling a game server should
 * never be a way to lose a save.
 *
 * The preserved set is matched on the first path segment, case-insensitively,
 * plus world files by extension wherever they sit: `worldpath` can point
 * anywhere inside the folder, and a `.wld` is the one file that cannot be
 * downloaded again.
 */
const PRESERVED_ROOTS = Object.freeze(['worlds', 'serverconfig.txt', 'tshock', 'mods', 'logs', '.lodestone', '.fleetdeck']);
const PRESERVED_EXTENSIONS = Object.freeze(['.wld', '.twld', '.bak']);

function isPreserved(relative) {
  const parts = String(relative).split(/[\\/]/).filter(Boolean);
  if (!parts.length) return false;
  if (PRESERVED_ROOTS.includes(parts[0].toLowerCase())) return true;
  return PRESERVED_EXTENSIONS.includes(path.extname(parts[parts.length - 1]).toLowerCase());
}

function walkFiles(root, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...walkFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function versionSummary(entry) {
  return entry && {
    id: entry.id || entry.variant || null,
    gameVersion: entry.gameVersion ?? entry.game ?? null,
    publishedAt: entry.publishedAt || null,
  };
}

/*
 * Is there a newer build than the one this server is running?
 *
 * `desc.terrariaVersion.variant` is the build id the installer recorded. A
 * descriptor without one (an adopted folder, or a server created before this
 * phase) reports `available: false` with `current: null` rather than offering
 * to "update" a server whose current version nobody knows.
 */
async function discoverUpdate(desc, options = {}) {
  const variant = resolveVariant(desc);
  const list = await listVersions(variant, options);
  const latest = newestSupported(list);
  const current = desc && desc.terrariaVersion ? desc.terrariaVersion : null;
  const notes = [];
  if (!current || !current.variant) {
    notes.push('Hostkind does not know which build this server is running, so it cannot tell whether an update exists. Reinstalling through the wizard records the version.');
  }
  if (list.stale) notes.push(list.error || 'The version list is from Hostkind\'s last successful check.');
  if (variant === 'tmodloader' && latest && current && current.game && latest.gameVersion && latest.gameVersion !== current.game) {
    notes.push(`This update moves tModLoader from Terraria ${current.game} to ${latest.gameVersion}. Mods built for ${current.game} will not load until their authors update them.`);
  }
  notes.push('Worlds, serverconfig.txt, tshock/ and Mods/ are preserved by the update.');
  return {
    variant,
    available: !!(latest && current && current.variant && latest.id !== current.variant),
    current: current ? { id: current.variant || null, gameVersion: current.game || null, publishedAt: null } : null,
    latest: versionSummary(latest),
    notes,
    stale: list.stale,
    restartRequired: true,
  };
}

/*
 * Apply an update to an installed server.
 *
 * Order matters and is the whole point: verified snapshot first, then the
 * download and the archive guard, then extraction into the transaction's own
 * staging payload, then a journal, and only then the commit. A failure before
 * the commit leaves the server untouched; a failure *during* the commit is the
 * one case where files are half-replaced, and it becomes `recovery_required`
 * with the snapshot id rather than a retry that would compound the damage.
 */
async function applyUpdate(input, options = {}) {
  const variant = assertVariant(input.variant || resolveVariant(input.desc || {}));
  const host = hostFrom(options);
  const onPhase = typeof options.onPhase === 'function' ? options.onPhase : () => {};
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const download = typeof options.download === 'function' ? options.download : null;
  if (!download) fail('No download implementation was provided.', 500, 'no_download');
  const dir = path.resolve(String(input.dir || ''));
  if (!dir || !fs.existsSync(dir)) fail('The server folder no longer exists.', 404, 'server_missing');
  if (input.offline !== true) fail('Stop the server before updating it.', 409, 'server_online');

  onPhase('resolving');
  const release = await resolveDownload(variant, input.versionId, options);
  const operation = operations.create({
    kind: 'terraria.update',
    actorId: input.actorId || null,
    serverId: input.serverId || null,
    idempotencyKey: input.idempotencyKey || null,
    summary: { variant, versionId: release.versionId, gameVersion: release.gameVersion },
  });
  if (!operations.acquireServerLock(operation.id, input.serverId)) {
    fail('Another operation is already running on this server.', 409, 'server_busy');
  }
  operations.start(operation.id, { phase: 'snapshotting' });

  const cacheDir = options.cacheDir || path.join(os.tmpdir(), 'fleetdeck-terraria');
  const archive = path.join(cacheDir, safeArchiveName(variant, release.versionId, release.filename));
  let snapshot = null;
  let transaction = null;
  let committing = false;
  try {
    snapshot = snapshots.take({
      serverId: input.serverId || dir,
      sourceDir: dir,
      scope: [],
      kind: 'update',
      reason: `${variant} update to ${release.versionId}`,
    });
    if (!snapshots.verify(snapshot.id).ok) {
      fail('The safety snapshot could not be verified, so nothing was changed.', 500, 'snapshot_unverified');
    }

    onPhase('downloading');
    operations.heartbeat(operation.id, { phase: 'downloading', progress: 0.2 });
    fs.mkdirSync(cacheDir, { recursive: true });
    await download(release.url, archive, onProgress);

    onPhase('verifying');
    operations.heartbeat(operation.id, { phase: 'verifying', progress: 0.5 });
    await validateZip(archive);

    onPhase('extracting');
    transaction = new Transaction({ serverDir: dir, operationId: operation.id });
    const payload = path.join(transaction.root, 'payload');
    fs.mkdirSync(payload, { recursive: true });
    extractRuntimeArchive(archive, payload, 'zip');
    unwrapNestedTar(payload);

    onPhase('locating');
    const configFile = path.join(dir, 'serverconfig.txt');
    const plan = buildLaunchPlan(variant, payload, configFile, host);
    const promoted = (abs) => (typeof abs === 'string' && (abs === payload || abs.startsWith(payload + path.sep))
      ? path.join(dir, path.relative(payload, abs))
      : abs);

    let staged = 0;
    for (const relative of walkFiles(payload)) {
      if (isPreserved(relative)) {
        // Dropping it from the payload is what "preserved" means: the commit
        // walks the journal, and a file that never entered it is never touched.
        fs.unlinkSync(path.join(payload, relative));
        continue;
      }
      transaction.stageExisting(relative);
      staged += 1;
    }
    if (!staged) fail('The downloaded package contained nothing to install.', 422, 'empty_archive');

    onPhase('promoting');
    operations.heartbeat(operation.id, { phase: 'promoting', progress: 0.9 });
    transaction.saveJournal();
    committing = true;
    transaction.commit();
    committing = false;

    const executable = promoted(plan.executable);
    if (fs.existsSync(executable)) makeExecutable(executable, host);
    const version = {
      game: release.gameVersion,
      variant: release.versionId,
      source: release.source,
      resolvedAt: new Date().toISOString(),
    };
    operations.finish(operation.id, { variant, versionId: release.versionId, files: staged, snapshotId: snapshot.id });
    return {
      ok: true,
      operationId: operation.id,
      snapshotId: snapshot.id,
      files: staged,
      version,
      executable,
      args: plan.args.map(promoted),
      cwd: promoted(plan.cwd),
      restartRequired: true,
    };
  } catch (error) {
    if (transaction && !committing) transaction.rollback();
    const recovery = { snapshotId: snapshot ? snapshot.id : null, serverId: input.serverId || null, variant, versionId: release.versionId };
    if (committing) {
      operations.markRecoveryRequired(operation.id, {
        code: error.code || 'update_interrupted',
        text: 'The update was interrupted while files were being replaced. Roll back to the snapshot before starting this server.',
        recovery,
      });
    } else {
      operations.fail(operation.id, { code: error.code || 'update_failed', text: error.message, recovery });
    }
    error.operationId = operation.id;
    error.snapshotId = snapshot ? snapshot.id : null;
    throw error;
  } finally {
    if (options.keepArchive !== true) { try { fs.unlinkSync(archive); } catch (_) { /* never downloaded, or already gone */ } }
  }
}

/*
 * Undo an applied or half-applied update by restoring its snapshot. The cause
 * is recorded on the operation timeline so "why is this server back on the old
 * build" has an answer that outlives the session.
 */
function rollbackUpdate({ dir, snapshotId, operationId, cause } = {}) {
  if (!snapshotId) fail('No verified snapshot is available for this update.', 409, 'no_snapshot');
  const target = path.resolve(String(dir || ''));
  if (!target || !fs.existsSync(target)) fail('The server folder no longer exists.', 404, 'server_missing');
  const restored = snapshots.restore({ id: snapshotId, targetDir: target });
  if (!restored || !restored.ok) fail('The snapshot could not be verified, so nothing was restored.', 409, 'snapshot_unverified');
  if (operationId) {
    operations.appendEvent(operationId, {
      phase: 'rolled_back',
      level: 'warn',
      message: cause ? `update rolled back: ${cause}` : 'update rolled back',
    });
  }
  return { ok: true, snapshotId, cause: cause || null };
}

module.exports = {
  VARIANTS,
  SOURCES,
  CATALOG_TTL_MS,
  TerrariaInstallError,
  listVersions,
  newestSupported,
  resolveDownload,
  install,
  discoverUpdate,
  applyUpdate,
  rollbackUpdate,
  isPreserved,
  // Exported for the update path, the compatibility shims in
  // lib/dedicatedServerInstaller.cjs, and the tests.
  buildLaunchPlan,
  findFile,
  normalizeWorldName,
  normalizeSeed,
  serverConfigText,
  writeServerConfig,
  validateZip,
  validateTar,
  unwrapNestedTar,
  promote,
  stagingPath,
  unpackVanillaVersion,
  resolveVariant,
  _resetCatalogue() { catalogue.clear(); },
};
