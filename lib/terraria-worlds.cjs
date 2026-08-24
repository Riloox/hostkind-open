'use strict';

/*
 * Terraria world operations (docs/terraria/03-worlds.md).
 *
 * `lib/worlds.cjs` is the same feature for Minecraft, and none of its identity
 * model transfers: it keys off `level.dat`, treats a world as a *directory*, and
 * reads registered worlds from `config.servers[].worlds`. A Terraria world is a
 * single `.wld` file with a sibling `.twld` under tModLoader and `.bak`
 * rotations beside it. So this module reuses the shared primitives -
 * `operations`, `snapshots`, `fsTransaction`, `trash`, `archiveGuard`,
 * `safeResolve` - and not the Minecraft module.
 *
 * The governing rule is `lib/worlds.cjs`'s, unchanged: worlds are the only thing
 * on a game server that cannot be re-downloaded. Everything here follows from
 * it.
 *
 *   - The save directory is authoritative. It is `desc.terrariaSaveDir` (stored
 *     server-relative), or the `worldpath` the server's own config declares -
 *     never a Hostkind-side guess about where worlds live.
 *   - A file is a world because its header says so. A file that cannot be parsed
 *     is listed as `unreadable`; it is never silently accepted, and never
 *     deleted to tidy the list.
 *   - Companions travel with the world as one unit. Copying a world without its
 *     `.twld` loses every modded chest and NPC on a tModLoader server.
 *   - Selection, import, generation and deletion all require the server offline,
 *     a verified snapshot, a preview the same actor took, a disk check with
 *     headroom, a staged commit, and an audit event.
 *   - Deletion is quarantine (lib/trash.cjs), never a recursive remove.
 *   - The filesystem and the configuration must agree before an operation may
 *     report success. If they cannot be made to agree, the operation goes to
 *     recovery_required - it never reports `ok`.
 *
 * Absolute paths never leave this module: responses, previews, operation
 * summaries and audit metadata carry world file names and save-dir-relative
 * paths only.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const yauzl = require('yauzl');
const archiver = require('archiver');
const { open, dataDir } = require('./db.cjs');
const { safeResolve } = require('./files.cjs');
const { checkEntry, finalize, ArchiveError } = require('./archiveGuard.cjs');
const { Transaction } = require('./fsTransaction.cjs');
const snapshots = require('./snapshots.cjs');
const operations = require('./operations.cjs');
const trash = require('./trash.cjs');
const terrariaConfig = require('./terraria-config.cjs');
const consoleGrammar = require('./modules/terraria/console.cjs');
const { resolveVariant } = require('./modules/terraria/variants.cjs');

/* --------------------------------------------------------------- constants -- */

const WORLD_EXT = '.wld';
const MOD_EXT = '.twld';
const CONFIG_FILE = 'serverconfig.txt';

// Matching lib/worlds.cjs, which the phase asks for explicitly: a preview is a
// promise about a state of the disk, and fifteen minutes is how long that
// promise is honoured.
const PREVIEW_TTL = 15 * 60 * 1000;

// Names become file names, so they are bounded the way lib/worlds.cjs bounds
// its folder names.
const MAX_NAME_LENGTH = 64;
const MAX_SEED_LENGTH = 64;

// A large Terraria world is tens of megabytes; a modded `.twld` is smaller
// again. This is the per-file ceiling on an upload, generous by two orders of
// magnitude, so a mistake is refused rather than streamed to the disk.
const MAX_WORLD_BYTES = 512 * 1024 * 1024;

// Import ceilings on top of the shared archive guard's own limits. An archive
// holding one world does not need thousands of entries.
const MAX_IMPORT_ENTRIES = 4096;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;

// Require 25% more free space than we expect to use, as lib/worlds.cjs does.
const DISK_HEADROOM = 1.25;

// The worlds a save directory is scanned for in one pass. A directory with more
// files than this is reported truncated rather than walked forever.
const MAX_SCAN_ENTRIES = 5000;

/*
 * World sizes and difficulties, as the `autocreate` and `difficulty` values
 * Terraria's own config takes. These are a fixed part of the game's config
 * format (`lib/dedicatedServerInstaller.cjs` and `lib/terraria-install.cjs`
 * write the same numbers), not a list that grows with releases.
 */
const SIZES = Object.freeze({ small: 1, medium: 2, large: 3 });
const DIFFICULTIES = Object.freeze({ classic: 0, expert: 1, master: 2, journey: 3 });

// Rough on-disk cost of a generated world per size, used only to gate on free
// space before generating. Deliberately over-estimated: refusing a generation
// that would have just fit is a much better outcome than filling the disk.
const SIZE_BYTES = Object.freeze({ small: 32 * 1024 * 1024, medium: 64 * 1024 * 1024, large: 128 * 1024 * 1024 });

// Kinds. Every one contains "world-write", which is what
// operations.isDestructiveKind() looks for: an interrupted run becomes
// recovery_required and never resumes on its own.
const KIND = Object.freeze({
  SELECT:   'world-write.terraria-select',
  IMPORT:   'world-write.terraria-import',
  GENERATE: 'world-write.terraria-generate',
  DELETE:   'world-write.terraria-delete',
});

const ACTIONS = Object.freeze({
  [KIND.SELECT]: 'terraria-select',
  [KIND.IMPORT]: 'terraria-import',
  [KIND.GENERATE]: 'terraria-generate',
  [KIND.DELETE]: 'terraria-delete',
});

// Generation ceilings. The overall deadline is what stops a wedged server from
// holding the per-server lock forever; the silence window is what notices a
// generation that stopped making progress long before the deadline.
const GENERATE_TIMEOUT_MS = 30 * 60 * 1000;
const GENERATE_SILENCE_MS = 5 * 60 * 1000;
const GENERATE_EXIT_TIMEOUT_MS = 60 * 1000;

/*
 * How often generation progress may reach the database and the WebSocket.
 *
 * Terraria narrates worldgen far faster than anything needs to hear it: a small
 * world measured on a real 1.4.5.6 server produced ~31k progress lines in 16
 * seconds (~2k/s), and every one of them would otherwise be a SQLite UPDATE and
 * a frame fanned out to every connected client. The percentage is the only thing
 * the UI draws, so four updates a second is already more than it can show.
 * Stage changes and decile milestones ignore this and always go out.
 */
const PROGRESS_INTERVAL_MS = 250;

class TerrariaWorldError extends Error {
  constructor(message, { status = 400, code = 'terraria_world_error' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class Cancelled extends Error {
  constructor() { super('cancelled'); this.code = 'cancelled'; }
}

const fail = (message, status, code) => { throw new TerrariaWorldError(message, { status, code }); };

/* ------------------------------------------------------------ file headers -- */

/*
 * The world header.
 *
 * The documented layout of every world file since 1.3.0.1 (format version 135,
 * when the signature block was introduced):
 *
 *   0   int32   format version
 *   4   char[7] "relogic"
 *   11  byte    file type    (1 map, 2 world, 3 player)
 *   12  uint32  revision     (how many times this file has been saved)
 *   16  uint64  flags        (bit 0: favorited)
 *
 * That block is the validity marker. Past it comes the section pointer table and
 * then the header section, which is where the world's own name and game mode
 * live; `readWorldDetails` walks it.
 *
 * The display name still comes from the file name. The embedded name is reported
 * beside it, not instead of it: the file is what `world=` points at, so the file
 * is what identity has to follow, and the two differ whenever a world has been
 * renamed on disk.
 */
const SIGNATURE = Buffer.from('relogic', 'ascii');
const FILE_TYPE_WORLD = 2;
const HEADER_BYTES = 24;
const MIN_FORMAT_VERSION = 135;
// A sanity ceiling, not a compatibility gate: the format is at 319 as of
// Terraria 1.4.5.6, and a "version" larger than this is random bytes rather than
// a future release.
const MAX_FORMAT_VERSION = 10000;

/*
 * The header section, confirmed byte-for-byte against worlds generated by a real
 * Terraria 1.4.5.6 dedicated server (format version 319) - one per difficulty,
 * which is what pins the game-mode mapping below:
 *
 *   24                    int16     section count
 *   26                    int32[]   section offsets       (section 0 is the header)
 *   ..                    int16     tile-frame-important bit count, then that many bits
 *   sections[0]           string    world name            (7-bit length, then UTF-8)
 *                         string    seed                  (version >= 179)
 *                         uint64    world generator version (version >= 179)
 *                         byte[16]  guid                  (version >= 181)
 *                         int32     world id
 *                         int32[4]  left, right, top, bottom bounds
 *                         int32     height, then int32 width  (in that order)
 *                         int32     game mode              (version >= 209)
 *
 * The version gates on seed, guid and game mode are the documented conditionals
 * for older formats, and no world old enough to exercise them was available to
 * confirm - so every parsed value is range-checked below, and anything
 * implausible is reported as unknown instead of as a fact.
 */
const DETAIL_VERSION = 209;
const SEED_VERSION = 179;
const GUID_VERSION = 181;
// Section 0 began at byte 167 in the confirmed worlds. 8 KiB leaves room for a
// far larger pointer table and tile mask while still reading only the head of
// the file - a world is hundreds of times this size.
const DETAIL_BYTES = 8192;
// 0 classic, 1 expert, 2 master, 3 journey - the same order `DIFFICULTIES` uses,
// which is what makes a generated world's mode readable back as what was asked
// for. A value outside this set means the walk went wrong.
const GAME_MODES = Object.freeze(['classic', 'expert', 'master', 'journey']);
// Terraria's own small world is 4200x1200 and its large is 8400x2400. These are
// the outer bounds of "a plausible world", not a supported-size list.
const MIN_DIMENSION = 100;
const MAX_DIMENSION = 100000;

/*
 * A .NET `BinaryWriter` string: a 7-bit encoded length, then that many UTF-8
 * bytes. Returns null rather than throwing on anything that runs past the end of
 * the buffer, because every caller here treats "could not read it" as unknown.
 */
function readNetString(buffer, at) {
  let length = 0;
  let shift = 0;
  let cursor = at;
  for (;;) {
    if (cursor >= buffer.length || shift > 28) return null;
    const byte = buffer[cursor];
    cursor += 1;
    length |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  if (length < 0 || cursor + length > buffer.length) return null;
  return { value: buffer.toString('utf8', cursor, cursor + length), next: cursor + length };
}

/*
 * The descriptive half of the header: the name the world calls itself and the
 * mode it was generated in. Every field is optional in the sense that matters
 * here - a truncated read, a version too old for the field, or a value outside
 * its plausible range all report `null`, and no caller may treat that as an
 * error. A world whose header cannot be walked is still a perfectly good world.
 */
function readWorldDetails(buffer, version) {
  const unknown = { worldName: null, gameMode: null, width: null, height: null };
  try {
    let cursor = HEADER_BYTES;
    const sections = buffer.readInt16LE(cursor); cursor += 2;
    if (sections < 1 || sections > 64) return unknown;
    const section0 = buffer.readInt32LE(cursor);
    if (section0 < cursor || section0 >= buffer.length) return unknown;

    cursor = section0;
    const name = readNetString(buffer, cursor);
    if (!name) return unknown;
    cursor = name.next;
    // An empty name, or one holding a control character, is a walk that went
    // wrong rather than a world called that.
    const worldName = !name.value.trim() || /[\u0000-\u001f\u007f]/.test(name.value)
      ? null
      : name.value;
    if (version < DETAIL_VERSION) return { ...unknown, worldName };

    if (version >= SEED_VERSION) {
      const seed = readNetString(buffer, cursor);
      if (!seed) return { ...unknown, worldName };
      cursor = seed.next + 8; // seed, then the world generator version
    }
    if (version >= GUID_VERSION) cursor += 16;
    cursor += 4;      // world id
    cursor += 16;     // left, right, top, bottom
    if (cursor + 12 > buffer.length) return { ...unknown, worldName };
    const height = buffer.readInt32LE(cursor); cursor += 4;
    const width = buffer.readInt32LE(cursor); cursor += 4;
    const mode = buffer.readInt32LE(cursor);

    const plausible = (value) => value >= MIN_DIMENSION && value <= MAX_DIMENSION;
    if (!plausible(width) || !plausible(height) || !GAME_MODES[mode]) {
      return { ...unknown, worldName };
    }
    return { worldName, gameMode: GAME_MODES[mode], width, height };
  } catch (_) {
    // A short buffer reaching a readInt32LE past its end. Unknown, not invalid.
    return unknown;
  }
}

function readWorldHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_BYTES) {
    return { ok: false, reason: 'truncated' };
  }
  // The signature is the discriminator and is checked first: a gzip file
  // (a Minecraft level.dat) has a plausible-looking int32 in the version
  // position, and reporting that as an unsupported *version* would tell an
  // operator their world is too new when it is not a world at all.
  if (!buffer.subarray(4, 4 + SIGNATURE.length).equals(SIGNATURE)) {
    return { ok: false, reason: 'not_a_world' };
  }
  const version = buffer.readInt32LE(0);
  if (version < MIN_FORMAT_VERSION || version > MAX_FORMAT_VERSION) {
    return { ok: false, reason: 'unsupported_version', version };
  }
  const fileType = buffer.readUInt8(11);
  if (fileType !== FILE_TYPE_WORLD) {
    return {
      ok: false,
      reason: fileType === 1 ? 'map_file' : fileType === 3 ? 'player_file' : 'not_a_world',
      fileType,
    };
  }
  // Validity is settled; the descriptive fields are a best effort on top of it,
  // and a buffer holding only the fixed block simply reports them as unknown.
  return {
    ok: true,
    version,
    fileType,
    revision: buffer.readUInt32LE(12),
    favorite: (buffer.readBigUInt64LE(16) & 1n) === 1n,
    ...readWorldDetails(buffer, version),
  };
}

function readHeaderOf(abs) {
  let handle;
  try {
    handle = fs.openSync(abs, 'r');
    const buffer = Buffer.alloc(DETAIL_BYTES);
    const read = fs.readSync(handle, buffer, 0, DETAIL_BYTES, 0);
    return readWorldHeader(buffer.subarray(0, read));
  } catch (_) {
    return { ok: false, reason: 'unreadable' };
  } finally {
    if (handle !== undefined) { try { fs.closeSync(handle); } catch (_) { /* */ } }
  }
}

/* ------------------------------------------------------------------- names -- */

/*
 * A world name is one path segment Hostkind is willing to create on any of the
 * three supported platforms. Anything else is refused rather than repaired: a
 * name in a descriptor always means exactly one file inside the save directory.
 */
const RESERVED = new Set(['con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => [`com${i + 1}`, `lpt${i + 1}`]).flat()]);

function normalizeName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (!name) fail('A world name is required.', 400, 'name_required');
  if (name.length > MAX_NAME_LENGTH) fail(`World names are limited to ${MAX_NAME_LENGTH} characters.`, 400, 'name_too_long');
  if (/[\u0000-\u001f\u007f]/.test(name)) fail('That world name is not a valid file name.', 400, 'name_invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(name)) {
    fail('World names may only contain letters, digits, spaces, dots, dashes and underscores.', 400, 'name_invalid');
  }
  if (name === '.' || name === '..' || name.endsWith('.') || name.endsWith(' ')) {
    fail('That world name is not a valid file name.', 400, 'name_invalid');
  }
  if (RESERVED.has(name.toLowerCase())) fail('That world name is reserved by the operating system.', 400, 'name_reserved');
  return name;
}

// The seed reaches a config file and a command line. Terraria's secret seeds are
// words and digits ("for the worthy", "05162020"); anything that could end a
// config line or start a new key is refused. Same rule as
// lib/terraria-install.cjs, which writes the same key at creation time.
function normalizeSeed(raw) {
  const seed = String(raw == null ? '' : raw).trim();
  if (!seed) return '';
  if (seed.length > MAX_SEED_LENGTH) fail(`Seeds are limited to ${MAX_SEED_LENGTH} characters.`, 400, 'seed_too_long');
  if (!/^[A-Za-z0-9 ._'-]+$/.test(seed)) {
    fail("Seeds may only contain letters, digits, spaces, dots, dashes, underscores and apostrophes.", 400, 'seed_invalid');
  }
  return seed;
}

const worldFileFor = (name) => `${name}${WORLD_EXT}`;
const displayName = (file) => path.basename(String(file), WORLD_EXT);

/*
 * Whether two world file names are the same world.
 *
 * On Windows they are the same file if they differ only in case, so two worlds
 * whose names differ only in case cannot both exist and a name that collides
 * only by case is refused. Elsewhere they are two different files and refusing
 * would be Hostkind inventing a restriction the filesystem does not have.
 * macOS is grouped with Windows: its default filesystem folds case too, and a
 * silent overwrite there loses a world just the same.
 */
const CASE_INSENSITIVE_HOST = process.platform === 'win32' || process.platform === 'darwin';

function sameFile(a, b, { caseInsensitive = CASE_INSENSITIVE_HOST } = {}) {
  const left = String(a == null ? '' : a);
  const right = String(b == null ? '' : b);
  return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/*
 * The name of a world file as it may be used in a request. A caller may only
 * ever name a file inside the save directory: no separators, no traversal, and
 * the `.wld` extension is required so a request can never reach a `.twld`, a
 * `.bak`, or the server's own configuration.
 */
function normalizeFile(raw) {
  const file = String(raw == null ? '' : raw).trim();
  if (!file) fail('A world file is required.', 400, 'file_required');
  if (file !== path.basename(file) || /[\\/]/.test(file)) fail('That is not a world file name.', 400, 'file_invalid');
  if (!file.toLowerCase().endsWith(WORLD_EXT)) fail('A world file must end in .wld.', 400, 'file_invalid');
  normalizeName(displayName(file));
  return file;
}

/* ---------------------------------------------------------- the save directory -- */

function serverDir(desc) {
  const dir = String((desc && (desc.dir || desc.cwd)) || '').trim();
  if (!dir) fail('This server has no folder configured.', 409, 'server_dir_missing');
  return path.resolve(dir);
}

// Server-relative, POSIX-separated, for responses and descriptors. Absolute
// paths never leave this module.
const toRelative = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

/*
 * The configuration file this server launches with.
 *
 * The `-config` argument is what the server actually reads, so that is what is
 * read here - but only when it points inside the server folder. A descriptor is
 * not a licence to read or write an arbitrary path on the host.
 */
function configFileOf(desc) {
  const root = serverDir(desc);
  const args = Array.isArray(desc.args) ? desc.args : [];
  const index = args.findIndex((arg) => String(arg).toLowerCase() === '-config');
  const declared = index >= 0 ? String(args[index + 1] || '') : '';
  if (declared) {
    const abs = path.resolve(declared);
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return { abs, rel: rel.split(path.sep).join('/') };
    }
  }
  return { abs: path.join(root, CONFIG_FILE), rel: CONFIG_FILE };
}

function readConfigDocument(desc) {
  const { abs, rel } = configFileOf(desc);
  if (!fs.existsSync(abs)) return { abs, rel, exists: false, document: terrariaConfig.parse('') };
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); }
  catch (error) { fail(`The server configuration could not be read: ${error.message}`, 500, 'config_unreadable'); }
  return { abs, rel, exists: true, document: terrariaConfig.parse(text) };
}

/*
 * Where this server keeps its worlds.
 *
 * In order: the descriptor's own field, then the server's `worldpath` setting,
 * then a `-worldpath` launch flag. There is deliberately no Hostkind-side
 * default (see lib/modules/terraria/variants.cjs): a folder Hostkind installed
 * and a folder an operator brought from their own machine resolve differently,
 * and inventing a directory is how a world list ends up describing somewhere the
 * server never writes.
 *
 * Whatever the source, the result has to resolve inside the server folder, and
 * the path may not traverse a symlink - following one would let a world "inside"
 * the server folder be written, or deleted, anywhere on the host.
 */
function resolveSaveDir(desc) {
  const root = serverDir(desc);
  const candidates = [];

  const stored = desc && desc.terrariaSaveDir;
  if (stored) candidates.push({ value: String(stored), source: 'descriptor', relative: true });

  try {
    const { document, exists } = readConfigDocument(desc);
    if (exists) {
      const worldpath = terrariaConfig.get(document, 'worldpath');
      if (worldpath && worldpath.trim()) candidates.push({ value: worldpath.trim(), source: 'config', relative: false });
    }
  } catch (_) { /* an unreadable config is not a reason to refuse every other source */ }

  const args = Array.isArray(desc.args) ? desc.args : [];
  const flag = args.findIndex((arg) => String(arg).toLowerCase() === '-worldpath');
  if (flag >= 0 && args[flag + 1]) candidates.push({ value: String(args[flag + 1]), source: 'launch-flag', relative: false });

  for (const candidate of candidates) {
    let abs;
    if (candidate.relative || !path.isAbsolute(candidate.value)) {
      try { abs = safeResolve(root, candidate.value); } catch (_) { continue; }
    } else {
      abs = path.resolve(candidate.value);
      const rel = path.relative(root, abs);
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    }
    assertNoSymlink(root, abs);
    return { abs, rel: toRelative(root, abs), source: candidate.source, root };
  }

  fail(
    'Hostkind cannot tell where this server keeps its worlds. Set its world folder (the "worldpath" setting) and try again.',
    409,
    'save_dir_unknown',
  );
  return null;
}

// Refuse a path that reaches its target through a link. The save directory is
// where every write in this module lands, so a link anywhere along the way is
// refused rather than followed.
function assertNoSymlink(root, abs) {
  let current = path.resolve(root);
  const parts = path.relative(current, abs).split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (_) { return; } // does not exist yet
    if (stat.isSymbolicLink()) fail('The world folder is reached through a link; links are not supported.', 409, 'symlink_path');
  }
}

// One world file inside the save directory, resolved safely.
function worldPath(saveDir, file) {
  let abs;
  try { abs = safeResolve(saveDir.abs, file); }
  catch { fail('That world path is not inside the world folder.', 400, 'path_escape'); }
  if (path.dirname(abs) !== saveDir.abs) fail('That world path is not inside the world folder.', 400, 'path_escape');
  return abs;
}

/*
 * The files that travel with a world.
 *
 * The sibling `.twld` is tModLoader's half of the save; the `.bak` files are
 * Terraria's own rotation. They are handled as one unit everywhere: copying,
 * downloading or deleting a world without them leaves half a save behind.
 */
function companionNames(file) {
  const base = displayName(file);
  return [`${base}${MOD_EXT}`, `${file}.bak`, `${base}${MOD_EXT}.bak`, `${base}.bak`];
}

function existingCompanions(saveDir, file) {
  const out = [];
  for (const name of companionNames(file)) {
    const abs = path.join(saveDir.abs, name);
    let stat;
    try { stat = fs.lstatSync(abs); } catch (_) { continue; }
    if (!stat.isFile()) continue; // a link or a directory is not a companion
    out.push({ file: name, sizeBytes: stat.size });
  }
  return out;
}

/* --------------------------------------------------------------- inventory -- */

function statOf(abs) {
  try {
    const stat = fs.lstatSync(abs);
    return stat.isFile() ? stat : null;
  } catch (_) {
    return null;
  }
}

/*
 * The read model behind GET /api/terraria/worlds.
 *
 * `worlds` are the files whose header parses; `unreadable` are the `.wld` files
 * that are there and cannot be read, each with the reason. An unreadable file is
 * reported, never hidden and never removed: it is far more likely to be a world
 * from a newer Terraria than a stray file, and it is not ours to tidy away.
 */
function inventory(desc, { status = 'offline', activeOperations: active = [], saveDir: known = null } = {}) {
  const saveDir = known || resolveSaveDir(desc);
  const scannedAt = Date.now();
  const selection = currentSelection(desc, saveDir);
  const byFile = new Map();
  for (const op of active) if (op.worldId) byFile.set(op.worldId, op);

  const worlds = [];
  const unreadable = [];
  let truncated = false;

  let entries = [];
  try { entries = fs.readdirSync(saveDir.abs, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') fail(`The world folder could not be read: ${error.message}`, 500, 'save_dir_unreadable');
  }

  for (const entry of entries) {
    if (worlds.length + unreadable.length >= MAX_SCAN_ENTRIES) { truncated = true; break; }
    if (!entry.name.toLowerCase().endsWith(WORLD_EXT)) continue;
    // A link is not a world: following one would take every operation here
    // outside the folder it is allowed to touch.
    if (entry.isSymbolicLink()) { unreadable.push({ file: entry.name, reason: 'symlink' }); continue; }
    if (!entry.isFile()) continue;

    const abs = path.join(saveDir.abs, entry.name);
    const stat = statOf(abs);
    if (!stat) { unreadable.push({ file: entry.name, reason: 'unreadable' }); continue; }
    const header = readHeaderOf(abs);
    if (!header.ok) { unreadable.push({ file: entry.name, reason: header.reason, sizeBytes: stat.size }); continue; }

    const companions = existingCompanions(saveDir, entry.name);
    const op = byFile.get(entry.name) || null;
    worlds.push({
      file: entry.name,
      name: displayName(entry.name),
      sizeBytes: stat.size,
      modifiedAt: Math.round(stat.mtimeMs),
      hasModData: companions.some((c) => c.file.toLowerCase().endsWith(MOD_EXT)),
      hasBackup: companions.some((c) => c.file.toLowerCase().endsWith('.bak')),
      companions: companions.map((c) => c.file),
      header: {
        version: header.version,
        revision: header.revision,
        gameMode: header.gameMode,
        // What the world calls itself, which is only worth showing when it is
        // not what the file is called.
        worldName: header.worldName && header.worldName !== displayName(entry.name) ? header.worldName : null,
        width: header.width,
        height: header.height,
      },
      active: !!selection.file && sameFile(selection.file, entry.name),
      readable: true,
      operation: op ? { id: op.operationId, action: op.action, state: op.state, phase: op.phase, progress: op.progress } : null,
    });
  }

  worlds.sort((a, b) => a.name.localeCompare(b.name));
  unreadable.sort((a, b) => a.file.localeCompare(b.file));

  return {
    serverId: desc.id,
    serverStatus: status,
    saveDir: saveDir.rel,
    saveDirSource: saveDir.source,
    saveDirExists: fs.existsSync(saveDir.abs),
    scannedAt,
    truncated,
    worlds,
    unreadable,
    selection,
  };
}

/*
 * What this server is currently set to load, from both places that have to
 * agree: the descriptor Hostkind owns and the `world=` line the server reads.
 * Publishing the disagreement is the point - an operator who edited the config
 * by hand should see that, not a world list that quietly contradicts it.
 */
function currentSelection(desc, saveDir) {
  const stored = desc && desc.terrariaWorld && desc.terrariaWorld.file
    ? path.basename(String(desc.terrariaWorld.file))
    : null;

  let configured = null;
  try {
    const { document } = readConfigDocument(desc);
    const value = terrariaConfig.get(document, 'world');
    if (value && value.trim()) {
      const abs = path.isAbsolute(value.trim()) ? path.resolve(value.trim()) : path.resolve(saveDir.abs, value.trim());
      // Only a world inside this server's save directory is a selection this
      // module can describe; anything else is reported as disagreeing.
      configured = path.dirname(abs) === saveDir.abs ? path.basename(abs) : null;
    }
  } catch (_) { /* an unreadable or duplicated key shows up as a disagreement */ }

  return {
    file: stored || configured,
    name: stored ? displayName(stored) : configured ? displayName(configured) : null,
    descriptor: stored,
    config: configured,
    // Only a contradiction is a disagreement. A server created by Hostkind has
    // an `autocreate` config and no descriptor world until its first start, and
    // one source naming a world the other has not named yet is not a conflict -
    // two sources naming *different* worlds is.
    disagrees: !!stored && !!configured && !sameFile(stored, configured),
  };
}

/*
 * Refuse a name that is already taken.
 *
 * The check is against the whole save directory, not just the worlds Hostkind
 * could parse: an unreadable `.wld`, a `.twld` or a `.bak` sitting on the name is
 * still a file the import or generation would overwrite. On a case-insensitive
 * host a name that differs only in case is the same file, so it collides too.
 */
function assertNameFree(desc, saveDir, file) {
  const wanted = [file, ...companionNames(file)];
  let entries = [];
  try { entries = fs.readdirSync(saveDir.abs); } catch (_) { return; } // no folder, nothing taken
  for (const existing of entries) {
    const clash = wanted.find((name) => sameFile(name, existing));
    if (clash) {
      fail(`"${existing}" already exists in this server's world folder. Choose another name.`, 409, 'name_collision');
    }
  }
}

/*
 * Resolve a request's world file to something on disk. A file that is not there,
 * or whose header does not parse, is a 404/422 here rather than an operation
 * that discovers the problem after taking a snapshot.
 */
function findWorld(desc, rawFile, { requireReadable = true } = {}) {
  const saveDir = resolveSaveDir(desc);
  const file = normalizeFile(rawFile);
  const abs = worldPath(saveDir, file);
  const stat = statOf(abs);
  if (!stat) fail('That world file does not exist.', 404, 'world_not_found');
  const header = readHeaderOf(abs);
  if (requireReadable && !header.ok) {
    fail(`That file is not a readable Terraria world (${header.reason}).`, 422, 'world_unreadable');
  }
  return {
    saveDir,
    file,
    name: displayName(file),
    abs,
    sizeBytes: stat.size,
    modifiedAt: Math.round(stat.mtimeMs),
    header,
    companions: existingCompanions(saveDir, file),
  };
}

/* -------------------------------------------------------------------- disk -- */

/*
 * Free space on the filesystem holding the save directory. statfs is not
 * available on every mount, and "we do not know" must never read as "there is
 * room": an unknown capacity makes every disk gate fail closed.
 */
function freeBytes(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch (_) {
    return null;
  }
}

function diskPlan(dir, requiredBytes) {
  const available = freeBytes(dir);
  const needed = Math.ceil(requiredBytes * DISK_HEADROOM);
  return {
    requiredBytes,
    neededBytes: needed,
    availableBytes: available,
    sufficient: available == null ? false : available >= needed,
    reason: available == null ? 'capacity_unknown' : (available >= needed ? null : 'insufficient_space'),
  };
}

function assertDisk(plan) {
  if (plan.sufficient) return;
  if (plan.reason === 'capacity_unknown') {
    fail('Free disk space could not be read, so this cannot be done safely.', 409, 'capacity_unknown');
  }
  fail('Not enough free disk space for this operation.', 409, 'insufficient_space');
}

/* ---------------------------------------------------------------- previews -- */

/*
 * The fingerprint is what makes a preview a promise about a specific state of
 * the save directory: every world file, its size and its modification time, plus
 * what the server is currently set to load. If any of it changed since the
 * preview, the impact we showed is no longer the impact we would have, and the
 * mutation refuses to run against it.
 */
function fingerprint(desc) {
  const saveDir = resolveSaveDir(desc);
  const parts = [];
  let entries = [];
  try { entries = fs.readdirSync(saveDir.abs, { withFileTypes: true }); } catch (_) { /* missing folder is a state too */ }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const lower = entry.name.toLowerCase();
    if (!lower.endsWith(WORLD_EXT) && !lower.endsWith(MOD_EXT) && !lower.endsWith('.bak')) continue;
    const stat = statOf(path.join(saveDir.abs, entry.name));
    parts.push(`${entry.name}:${stat ? stat.size : 'x'}:${stat ? Math.round(stat.mtimeMs) : 'x'}`);
  }
  const selection = currentSelection(desc, saveDir);
  parts.push(`selection:${selection.descriptor || ''}:${selection.config || ''}`);
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

/*
 * Previews live in the shared `world_previews` table: it already stores exactly
 * what a preview is (actor, server, action, fingerprint, payload, expiry) and
 * adding a second table with the same columns would only create a second place
 * for consent to be recorded.
 */
function savePreview({ desc, actorId, action, file, payload }) {
  const token = crypto.randomUUID();
  const now = Date.now();
  open().prepare(`
    INSERT INTO world_previews (token, server_id, actor_id, action, world_id, created_at, expires_at, fingerprint, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(token, desc.id, actorId, action, file || null, now, now + PREVIEW_TTL, fingerprint(desc), JSON.stringify(payload));
  return { token, expiresAt: now + PREVIEW_TTL, ...payload };
}

/*
 * Consume a preview. Single-use: the row is deleted as it is read, so a replayed
 * request has to take a fresh preview and see the current impact rather than
 * reusing consent given for a state of the disk that no longer holds.
 */
function consumePreview({ token, desc, actorId, action }) {
  const db = open();
  const row = db.prepare('SELECT * FROM world_previews WHERE token = ?').get(String(token || ''));
  if (!row || row.actor_id !== actorId || row.server_id !== desc.id || row.action !== action) {
    fail('This action needs a current preview.', 409, 'preview_invalid');
  }
  db.prepare('DELETE FROM world_previews WHERE token = ?').run(row.token);
  if (row.expires_at < Date.now()) fail('The preview expired. Review the impact again.', 409, 'preview_expired');
  if (row.fingerprint !== fingerprint(desc)) {
    fail('The worlds changed since the preview was taken. Review the impact again.', 409, 'preview_stale');
  }
  return JSON.parse(row.payload_json);
}

/* ----------------------------------------------------- operation plumbing -- */

function recordOperation({ operationId, serverId, file, action, source, destination }) {
  open().prepare(`
    INSERT INTO world_operations (operation_id, server_id, world_id, action, source_json, destination_json, result_json)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(operation_id) DO NOTHING
  `).run(operationId, serverId, file || null, action, JSON.stringify(source || {}), JSON.stringify(destination || {}));
}

function recordResult(operationId, result) {
  open().prepare('UPDATE world_operations SET result_json = ? WHERE operation_id = ?')
    .run(JSON.stringify(result || {}), operationId);
}

const safeJson = (text) => { try { return text ? JSON.parse(text) : null; } catch (_) { return null; } };

function listOperations(serverId, limit = 25) {
  return open().prepare(`
    SELECT w.operation_id, w.world_id, w.action, w.source_json, w.destination_json, w.result_json,
           o.state, o.phase, o.progress, o.queued_at, o.finished_at, o.error_code, o.error_text
      FROM world_operations w
      JOIN operations o ON o.id = w.operation_id
     WHERE w.server_id = ? AND w.action LIKE 'terraria-%'
     ORDER BY o.queued_at DESC
     LIMIT ?
  `).all(serverId, limit).map((row) => ({
    operationId: row.operation_id,
    worldId: row.world_id,
    action: row.action,
    state: row.state,
    phase: row.phase,
    progress: row.progress,
    queuedAt: row.queued_at,
    finishedAt: row.finished_at,
    error: row.error_code ? { code: row.error_code, text: row.error_text } : null,
    source: safeJson(row.source_json),
    destination: safeJson(row.destination_json),
    result: safeJson(row.result_json),
  }));
}

function activeOperations(serverId) {
  return listOperations(serverId, 50).filter((op) => ['running', 'queued', 'recovery_required'].includes(op.state));
}

function findOperationByKey(actorId, idempotencyKey) {
  if (!actorId || !idempotencyKey) return null;
  const row = open().prepare('SELECT id FROM operations WHERE actor_id = ? AND idempotency_key = ?').get(actorId, idempotencyKey);
  return row ? operations.get(row.id) : null;
}

/*
 * Start a durable operation. The per-server lock keeps two mutations off the
 * same save directory; a replayed Idempotency-Key returns the original operation
 * instead of doing the work twice.
 */
function beginOperation({ kind, actorId, desc, idempotencyKey, summary, file, source, destination }) {
  if (!idempotencyKey) fail('An Idempotency-Key header is required for this request.', 400, 'idempotency_key_required');
  const existing = findOperationByKey(actorId, idempotencyKey);
  if (existing) return { operation: existing, replay: true };

  const op = operations.create({ kind, actorId, serverId: desc.id, idempotencyKey, summary });
  if (!operations.acquireServerLock(op.id, desc.id)) {
    operations.fail(op.id, { code: 'server_busy', text: 'another operation is already running for this server' });
    fail('Another operation is already running for this server.', 409, 'server_busy');
  }
  recordOperation({ operationId: op.id, serverId: desc.id, file, action: ACTIONS[kind] || kind, source, destination });
  return { operation: op, replay: false };
}

// Cancellation may only take effect before a commit. After the promoting rename
// we are past the point where stopping is the safe thing to do, so nothing
// checks this again and the operation runs to a verified end.
function checkpoint(operationId, phase, progress) {
  const op = operations.get(operationId);
  if (!op || op.state === operations.STATES.CANCELLED) throw new Cancelled();
  operations.heartbeat(operationId, { phase, progress });
  operations.appendEvent(operationId, { phase, message: phase, level: 'info' });
}

/*
 * Terminal handling shared by every runner:
 *
 *   cancelled          - stopped before the commit; nothing changed.
 *   failed             - stopped before the commit; nothing changed, with a reason.
 *   recovery_required  - the save directory and the configuration may disagree.
 *                        This never resolves itself and never reports success.
 */
function settle(operationId, err, { compensated }) {
  if (err instanceof Cancelled) {
    operations.cancel(operationId);
    recordResult(operationId, { cancelled: true });
    return;
  }
  const code = err.code || 'terraria_world_operation_failed';
  if (compensated === false) {
    operations.markRecoveryRequired(operationId, {
      code,
      text: err.message,
      recovery: {
        instructions: 'The world folder and this server\'s configuration may disagree. Review the world list, and the world= line in serverconfig.txt, before running further operations.',
      },
    });
  } else {
    operations.fail(operationId, { code, text: err.message });
  }
  recordResult(operationId, { error: code });
}

function requireOffline(manager, what) {
  if (!manager || manager.status !== 'offline') {
    fail(`Stop the server before ${what}.`, 409, 'server_online');
  }
}

// Previews carry POSIX-separated relative paths (they reach the API);
// lib/snapshots.cjs compares scope entries against `path.relative` output, which
// uses the host separator. This is the one place that translates.
const scopeFor = (list) => (Array.isArray(list) ? list : []).map((entry) => String(entry).split('/').join(path.sep));

/* ----------------------------------------------------------------- selection -- */

/*
 * Two writes that must agree: `desc.terrariaWorld` in config.json and the
 * `world=` key in serverconfig.txt.
 *
 * Order: snapshot the config file, write serverconfig.txt, save the descriptor,
 * then verify by re-reading both. If the descriptor save fails after the file
 * write, the file is reverted; if the revert fails, the operation goes to
 * recovery_required with instructions rather than reporting success. This is the
 * exact failure mode lib/worlds.cjs documents, and it applies verbatim here.
 */
function previewSelect({ desc, actorId, file, manager }) {
  const world = findWorld(desc, file);
  const { rel: configRel, document, exists } = readConfigDocument(desc);
  if (!exists) fail(`This server has no ${CONFIG_FILE} to write the selection into.`, 409, 'config_missing');
  const selection = currentSelection(desc, world.saveDir);
  const target = path.join(world.saveDir.abs, world.file);
  const { diff } = terrariaConfig.patch(document, { world: target });

  return savePreview({
    desc, actorId, action: ACTIONS[KIND.SELECT], file: world.file,
    payload: {
      action: ACTIONS[KIND.SELECT],
      world: publicWorld(world),
      current: selection.file ? { file: selection.file, name: selection.name } : null,
      // "Already selected" means both halves say so. A world the config names but
      // the descriptor does not is still worth selecting: that is the write that
      // makes the two agree.
      alreadySelected: !!selection.descriptor && !!selection.config
        && sameFile(selection.descriptor, world.file) && sameFile(selection.config, world.file),
      configFile: configRel,
      // The keys that change, not the values: the value is a path, and paths do
      // not leave this module.
      changes: diff.map((entry) => entry.key),
      requiresOffline: true,
      serverOffline: !manager || manager.status === 'offline',
      // Selection rewrites one config line; the snapshot covers that file. The
      // save directory is not touched, so copying every world to protect a
      // one-line change would only make the operation slower and no safer.
      snapshotScope: [configRel],
      restartRequired: true,
      disk: diskPlan(world.saveDir.abs, 0),
    },
  });
}

// What is safe to publish about a world: names, sizes and a header, never a path.
function publicWorld(world) {
  return {
    file: world.file,
    name: world.name,
    sizeBytes: world.sizeBytes,
    modifiedAt: world.modifiedAt,
    hasModData: world.companions.some((c) => c.file.toLowerCase().endsWith(MOD_EXT)),
    hasBackup: world.companions.some((c) => c.file.toLowerCase().endsWith('.bak')),
    companions: world.companions.map((c) => c.file),
    header: world.header.ok
      ? {
        version: world.header.version,
        revision: world.header.revision,
        gameMode: world.header.gameMode,
        worldName: world.header.worldName && world.header.worldName !== world.name ? world.header.worldName : null,
        width: world.header.width,
        height: world.header.height,
      }
      : null,
    readable: !!world.header.ok,
  };
}

/*
 * The write half of a selection, shared by select, import and generate.
 *
 * Returns a compensation function that puts the configuration file back the way
 * it was, or throws a `compensated: false` error if it cannot - which is the
 * only honest answer when the file and the descriptor may disagree.
 */
function applySelection({ desc, operationId, saveDir, file, name, saveDescriptor, readDescriptor }) {
  const { abs: configAbs, rel: configRel, document, exists } = readConfigDocument(desc);
  if (!exists) fail(`This server has no ${CONFIG_FILE} to write the selection into.`, 409, 'config_missing');
  const before = fs.readFileSync(configAbs);
  const target = path.join(saveDir.abs, file);
  const { document: next } = terrariaConfig.patch(document, { world: target });
  const text = terrariaConfig.serialize(next);

  // Staged and promoted by rename, so a crash mid-write cannot leave a
  // half-written configuration behind.
  const tx = new Transaction({ serverDir: saveDir.root, operationId });
  tx.stageWrite(configRel, text);
  tx.saveJournal();
  tx.commit();

  const descriptorWorld = { file: toRelative(saveDir.root, target), name };
  try {
    saveDescriptor({ terrariaWorld: descriptorWorld, terrariaSaveDir: saveDir.rel });
  } catch (error) {
    try {
      fs.writeFileSync(configAbs, before);
    } catch (_) {
      const err = new TerrariaWorldError(
        `The world was selected in ${configRel} but the panel configuration could not be saved: ${error.message}`,
        { code: 'config_save_failed' },
      );
      err.compensated = false;
      throw err;
    }
    fail(`The panel configuration could not be saved, so the selection was undone: ${error.message}`, 500, 'config_save_failed');
  }

  // Verify by re-reading both. A selection that only half landed is a
  // disagreement, and a disagreement is recovery_required, never success.
  const written = terrariaConfig.get(terrariaConfig.parse(fs.readFileSync(configAbs, 'utf8')), 'world');
  const stored = readDescriptor ? readDescriptor() : null;
  const storedFile = stored && stored.terrariaWorld ? path.basename(String(stored.terrariaWorld.file || '')) : null;
  if (path.resolve(String(written || '')) !== target || !storedFile || !sameFile(storedFile, file)) {
    const err = new TerrariaWorldError(
      'The selection did not verify: the configuration file and the panel configuration do not agree.',
      { code: 'verify_failed' },
    );
    err.compensated = false;
    throw err;
  }
  return { world: descriptorWorld.file, name };
}

/*
 * Every runner does all of its work inside the try, including resolving the save
 * directory. Anything that throws before it - the config edited between the
 * preview and the apply, a descriptor whose save directory no longer resolves -
 * would leave the operation `running`, holding the per-server lock until a boot
 * sweep found it. A failure has to be a *recorded* failure.
 */
async function runSelect({ desc, manager, operationId, preview, saveDescriptor, readDescriptor }) {
  let snapshot = null;
  try {
    checkpoint(operationId, 'preview-revalidate', 0.05);
    const saveDir = resolveSaveDir(desc);
    const world = findWorld(desc, preview.world.file);

    checkpoint(operationId, 'require-offline', 0.15);
    requireOffline(manager, 'selecting a world');

    checkpoint(operationId, 'snapshot', 0.3);
    snapshot = snapshots.take({
      serverId: desc.id, sourceDir: saveDir.root, scope: scopeFor(preview.snapshotScope || [CONFIG_FILE]),
      kind: 'terraria-world-select', reason: `Select "${world.name}"`,
    });
    if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');

    checkpoint(operationId, 'commit', 0.6);
    const applied = applySelection({
      desc, operationId, saveDir, file: world.file, name: world.name, saveDescriptor, readDescriptor,
    });

    operations.heartbeat(operationId, { phase: 'verify', progress: 0.95 });
    const result = { file: world.file, name: world.name, restartRequired: true, selected: applied.name };
    recordResult(operationId, result);
    operations.finish(operationId, result);
    if (snapshot) { try { snapshots.remove(snapshot.id); } catch (_) { /* retention sweeps it */ } }
    return result;
  } catch (err) {
    if (snapshot && err.compensated !== false) { try { snapshots.remove(snapshot.id); } catch (_) { /* keep it */ } }
    settle(operationId, err, { compensated: err.compensated !== false });
    throw err;
  }
}

/* ------------------------------------------------------------------ import -- */

/*
 * Uploads are staged under the Hostkind data directory, never inside a server
 * folder: nothing an operator uploaded reaches a server's own tree until an
 * import commits it. The id is generated by the route and recorded in the
 * preview, so the payload can only be imported by consuming that preview - which
 * is bound to the actor who uploaded it.
 */
function importStagingDir(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9-]/g, '');
  if (!safe) fail('That upload is no longer available. Upload it again.', 409, 'staging_missing');
  return path.join(dataDir(), 'terraria-world-imports', safe);
}

// Abandoned staging payloads are scratch: an upload that was previewed and never
// imported is dropped once its preview could no longer be consumed. Called from
// the panel's boot sweep beside the Minecraft one.
function sweepImportStaging({ now = Date.now(), maxAgeMs = PREVIEW_TTL } = {}) {
  const root = path.join(dataDir(), 'terraria-world-imports');
  if (!fs.existsSync(root)) return [];
  const removed = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    try {
      if (fs.statSync(dir).mtimeMs >= now - maxAgeMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch (_) { /* locked: the next sweep gets it */ }
  }
  return removed;
}

/*
 * yauzl refuses traversing and absolute entry names itself, before our guard
 * sees them - the right order, but it throws plain Errors. Map them onto the
 * guard's vocabulary so a caller only has to understand one set of codes.
 */
function normalizeArchiveError(err) {
  if (err instanceof ArchiveError) return err;
  const message = String((err && err.message) || '');
  if (/invalid relative path|\.\./i.test(message)) return new ArchiveError(`path escapes root: ${message}`, 'path_traversal');
  if (/absolute path/i.test(message)) return new ArchiveError(`absolute path in archive: ${message}`, 'absolute_path');
  if (/invalid characters|malformed|end of central directory|not a zip/i.test(message)) {
    return new ArchiveError('The archive is not a readable zip file.', 'invalid_archive');
  }
  return err;
}

/*
 * Extract the world files out of a zip into a staging directory.
 *
 * Every entry goes through the shared guard before anything is written, and only
 * the world files are extracted: a zip of a whole Terraria save folder carries
 * players, maps and configs, and none of them are ours to write into a server.
 * Two `.wld` entries is an ambiguity nobody may resolve on the operator's
 * behalf, so it is refused.
 */
function extractWorldFromArchive(archivePath, destination, limits = {}) {
  const guard = { maxEntries: MAX_IMPORT_ENTRIES, maxTotalSize: MAX_IMPORT_BYTES, ...limits };
  fs.mkdirSync(destination, { recursive: true });
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (error, zip) => {
      if (error) return reject(new ArchiveError('The archive could not be read.', 'invalid_archive'));
      const state = { entries: 0, totalSize: 0, totalCompressedSize: 0, seen: new Set() };
      const written = [];
      let settled = false;
      const bail = (err) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch (_) { /* */ }
        reject(normalizeArchiveError(err));
      };
      zip.on('error', bail);
      zip.on('entry', (entry) => {
        let rel;
        try {
          if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; }
          rel = checkEntry(entry, state, guard);
        } catch (err) { return bail(err); }

        const base = path.posix.basename(rel);
        const lower = base.toLowerCase();
        const wanted = lower.endsWith(WORLD_EXT) || lower.endsWith(MOD_EXT);
        if (!wanted) { zip.readEntry(); return; }
        if (lower.endsWith(WORLD_EXT) && written.some((name) => name.toLowerCase().endsWith(WORLD_EXT))) {
          return bail(new ArchiveError('The archive contains more than one world.', 'multiple_worlds'));
        }
        if ((entry.uncompressedSize || 0) > MAX_WORLD_BYTES) {
          return bail(new ArchiveError(`${base} is larger than a Terraria world can be.`, 'entry_too_large'));
        }
        let target;
        // The entry name is flattened to its basename on purpose: a world is a
        // file, and the folder it happened to sit in inside the archive is not
        // part of its identity.
        try { target = safeResolve(destination, base); }
        catch { return bail(new ArchiveError(`entry escapes the staging root: ${rel}`, 'path_traversal')); }

        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return bail(streamError);
          // 'wx': a duplicate that slipped past the guard fails loudly rather
          // than overwriting whatever was written first.
          const out = fs.createWriteStream(target, { flags: 'wx' });
          stream.on('error', bail);
          out.on('error', bail);
          out.on('close', () => { written.push(base); zip.readEntry(); });
          stream.pipe(out);
        });
      });
      zip.on('end', () => {
        if (settled) return;
        try {
          finalize(state);
          settled = true;
          resolve(written);
        } catch (err) { bail(err); }
      });
      zip.readEntry();
    });
  });
}

/*
 * Describe what importing a staged payload would do.
 *
 * `staged` is `{ dir, kind, originalName }`: the route has already streamed the
 * upload into a directory under the Hostkind data dir, never into the server
 * folder. By the time this returns, the payload has been unpacked (for an
 * archive) and its header parsed, so "this is not a Terraria world" is answered
 * before any consent is asked for.
 */
async function previewImport({ desc, actorId, staged, requestedName, select = false, manager }) {
  const saveDir = resolveSaveDir(desc);
  const stagingDir = String(staged.dir);

  let files;
  if (staged.kind === 'archive') {
    const extractDir = path.join(stagingDir, 'payload');
    files = await extractWorldFromArchive(path.join(stagingDir, staged.archive), extractDir);
  } else {
    files = fs.readdirSync(path.join(stagingDir, 'payload'));
  }

  const payloadDir = path.join(stagingDir, 'payload');
  const worldFile = files.find((name) => name.toLowerCase().endsWith(WORLD_EXT));
  if (!worldFile) fail('No .wld world file was found in what you uploaded.', 422, 'world_missing');
  const modFile = files.find((name) => name.toLowerCase().endsWith(MOD_EXT)) || null;

  const stagedWorld = path.join(payloadDir, worldFile);
  const header = readHeaderOf(stagedWorld);
  if (!header.ok) {
    fail(importRejection(header.reason), 422, `import_${header.reason}`);
  }
  const stat = statOf(stagedWorld);
  const sizeBytes = (stat ? stat.size : 0) + (modFile ? (statOf(path.join(payloadDir, modFile)) || { size: 0 }).size : 0);

  // The display name is the requested one, or the name the file arrived with.
  const name = normalizeName(requestedName || displayName(worldFile));
  const file = worldFileFor(name);
  worldPath(saveDir, file); // refuses anything that would land outside the save dir

  // An unreadable file occupying the name is still a collision: the import must
  // never overwrite it, whatever it turns out to be.
  assertNameFree(desc, saveDir, file);

  const variant = safeVariant(desc);
  return savePreview({
    desc, actorId, action: ACTIONS[KIND.IMPORT], file,
    payload: {
      action: ACTIONS[KIND.IMPORT],
      source: {
        kind: staged.kind,
        // The name the file arrived with, for the operator's own recognition.
        originalName: path.basename(String(staged.originalName || worldFile)),
        worldFile,
        modFile,
        sizeBytes,
      },
      name,
      file,
      // The name the file calls itself is shown beside the name it will be
      // imported under, so an operator can see they are about to rename it.
      header: {
        version: header.version,
        revision: header.revision,
        gameMode: header.gameMode,
        worldName: header.worldName && header.worldName !== name ? header.worldName : null,
        width: header.width,
        height: header.height,
      },
      // A tModLoader world without its .twld loses the modded half of the save,
      // and the operator is told before the import rather than after.
      modDataMissing: variant === 'tmodloader' && !modFile,
      select: !!select,
      requiresOffline: true,
      serverOffline: !manager || manager.status === 'offline',
      snapshotScope: [saveDir.rel],
      disk: diskPlan(saveDir.abs, sizeBytes),
      staging: path.basename(stagingDir),
    },
  });
}

// "Refused with a reason" is the requirement; "best-effort accept" is not.
function importRejection(reason) {
  switch (reason) {
    case 'truncated': return 'That file is too short to be a Terraria world: it is truncated or empty.';
    case 'not_a_world': return 'That file is not a Terraria world: worlds from Terraria 1.3 and newer start with a version number and the signature "relogic".';
    case 'unsupported_version': return 'That world header carries a format version Hostkind does not recognise, so it will not be imported.';
    case 'map_file': return 'That is a Terraria map file, not a world.';
    case 'player_file': return 'That is a Terraria player file, not a world.';
    default: return 'That file could not be read as a Terraria world.';
  }
}

function safeVariant(desc) {
  try { return resolveVariant(desc); } catch (_) { return null; }
}

async function runImport({ desc, manager, operationId, preview, saveDescriptor, readDescriptor }) {
  let stagingDir = null;
  let snapshot = null;
  let committed = false;

  try {
    checkpoint(operationId, 'preview-revalidate', 0.05);
    const saveDir = resolveSaveDir(desc);
    stagingDir = importStagingDir(preview.staging);
    const payloadDir = path.join(stagingDir, 'payload');
    const targets = [{ from: preview.source.worldFile, to: preview.file }];
    if (preview.source.modFile) targets.push({ from: preview.source.modFile, to: `${preview.name}${MOD_EXT}` });
    if (!fs.existsSync(path.join(payloadDir, preview.source.worldFile))) {
      fail('The uploaded world is no longer available. Upload it again.', 409, 'staging_missing');
    }
    assertDisk(diskPlan(saveDir.abs, preview.disk.requiredBytes));
    for (const target of targets) {
      if (fs.existsSync(path.join(saveDir.abs, target.to))) {
        fail(`"${target.to}" already exists in this server's world folder.`, 409, 'name_collision');
      }
    }

    checkpoint(operationId, 'require-offline', 0.15);
    requireOffline(manager, 'importing a world');

    checkpoint(operationId, 'snapshot', 0.3);
    fs.mkdirSync(saveDir.abs, { recursive: true });
    snapshot = snapshots.take({
      serverId: desc.id, sourceDir: saveDir.root, scope: scopeFor(preview.snapshotScope || [saveDir.rel]),
      kind: 'terraria-world-import', reason: `Import "${preview.name}"`,
    });
    if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');

    checkpoint(operationId, 'validate-header', 0.5);
    const header = readHeaderOf(path.join(payloadDir, preview.source.worldFile));
    if (!header.ok) fail(importRejection(header.reason), 422, `import_${header.reason}`);

    checkpoint(operationId, 'journal', 0.6);
    const tx = new Transaction({ serverDir: saveDir.root, operationId });
    for (const target of targets) {
      tx.stageCopy(path.join(payloadDir, target.from), path.posix.join(saveDir.rel, target.to));
    }
    tx.saveJournal();
    operations.appendEvent(operationId, { phase: 'journal', message: 'commit plan written', level: 'info', metadata: { entries: tx.journal.length } });

    tx.commit();
    committed = true;
    operations.heartbeat(operationId, { phase: 'verify', progress: 0.8 });

    const promoted = readHeaderOf(path.join(saveDir.abs, preview.file));
    if (!promoted.ok) {
      const err = new TerrariaWorldError('The imported world is not readable after the commit.', { code: 'verify_failed' });
      err.compensated = false;
      throw err;
    }

    let selected = null;
    if (preview.select) {
      operations.heartbeat(operationId, { phase: 'select', progress: 0.9 });
      selected = applySelection({
        desc, operationId: `${operationId}-select`, saveDir, file: preview.file, name: preview.name,
        saveDescriptor, readDescriptor,
      });
    }

    operations.heartbeat(operationId, { phase: 'cleanup', progress: 0.97 });
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) { /* swept later */ }
    if (snapshot) { try { snapshots.remove(snapshot.id); } catch (_) { /* retention sweeps it */ } }

    const result = {
      file: preview.file,
      name: preview.name,
      companions: targets.slice(1).map((target) => target.to),
      selected: !!selected,
      restartRequired: !!selected,
    };
    recordResult(operationId, result);
    operations.finish(operationId, result);
    return result;
  } catch (err) {
    if (!committed) {
      if (stagingDir) { try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (_) { /* swept later */ } }
      if (snapshot) { try { snapshots.remove(snapshot.id); } catch (_) { /* keep it */ } }
    }
    settle(operationId, err, { compensated: err.compensated !== false });
    throw err;
  }
}

/* -------------------------------------------------------------- generation -- */

function normalizeGenerateInput(input = {}) {
  const name = normalizeName(input.name);
  const size = String(input.size || 'medium').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(SIZES, size)) fail('Choose a world size: small, medium or large.', 400, 'invalid_size');
  const difficulty = String(input.difficulty || 'classic').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(DIFFICULTIES, difficulty)) {
    fail('Choose a difficulty: classic, expert, master or journey.', 400, 'invalid_difficulty');
  }
  return { name, size, difficulty, seed: normalizeSeed(input.seed), select: input.select !== false };
}

function previewGenerate({ desc, actorId, input, manager }) {
  const saveDir = resolveSaveDir(desc);
  const parsed = normalizeGenerateInput(input);
  const file = worldFileFor(parsed.name);
  worldPath(saveDir, file);

  assertNameFree(desc, saveDir, file);

  // Generation runs the server binary. A variant Hostkind cannot identify has
  // no known launch plan, and guessing one is how the wrong binary gets run.
  const variant = safeVariant(desc);
  if (!variant) fail('This server\'s Terraria edition is not recognised, so Hostkind will not run its binary.', 409, 'unknown_variant');

  return savePreview({
    desc, actorId, action: ACTIONS[KIND.GENERATE], file,
    payload: {
      action: ACTIONS[KIND.GENERATE],
      ...parsed,
      file,
      autocreate: SIZES[parsed.size],
      difficultyValue: DIFFICULTIES[parsed.difficulty],
      variant,
      requiresOffline: true,
      serverOffline: !manager || manager.status === 'offline',
      snapshotScope: [saveDir.rel],
      disk: diskPlan(saveDir.abs, SIZE_BYTES[parsed.size]),
      // Generation is the one world operation that runs a process, and it can
      // take minutes. The UI says so instead of looking hung.
      estimatedMs: { small: 60_000, medium: 180_000, large: 420_000 }[parsed.size],
    },
  });
}

/*
 * The argv a generation runs.
 *
 * The descriptor's own executable and arguments - the ones registration or the
 * installer already validated - with the config path repointed at the staging
 * config and every world-selecting flag stripped, because a launch flag beats a
 * config key in Terraria and a leftover `-world` would generate into the live
 * save directory. An argv array, never a command string; no shell; and a
 * launcher script is refused rather than executed (the same rule
 * lib/terraria-install.cjs enforces at install time).
 */
const WORLD_FLAGS = new Set(['-world', '-worldpath', '-autocreate', '-worldname', '-seed', '-difficulty', '-worldevil', '-config']);
const WRAPPER_EXTENSIONS = new Set(['.sh', '.bat', '.cmd', '.ps1', '.command']);

function generationLaunch(desc, configFile) {
  const executable = String(desc.executable || '').trim();
  if (!executable) fail('This server has no executable configured, so Hostkind cannot generate a world for it.', 409, 'executable_missing');
  if (!fs.existsSync(executable)) fail('This server\'s executable is missing, so Hostkind cannot generate a world for it.', 409, 'executable_missing');
  if (WRAPPER_EXTENSIONS.has(path.extname(executable).toLowerCase())) {
    fail('Hostkind refuses to start a Terraria server through a launcher script.', 409, 'wrapper_refused');
  }
  const source = Array.isArray(desc.args) ? desc.args.map(String) : [];
  const args = [];
  for (let i = 0; i < source.length; i++) {
    if (WORLD_FLAGS.has(source[i].toLowerCase())) { i += 1; continue; } // drop the flag and its value
    args.push(source[i]);
  }
  args.push('-config', configFile);
  const cwd = String(desc.cwd || desc.dir || '');
  return { executable, args, cwd };
}

/*
 * Drive one generation to a produced world file.
 *
 * Completion is the delicate part, and the captures decide it. A world created
 * through the console menu ends by returning to the world prompt
 * (test/fixtures/terraria/vanilla-worldgen.log, tmodloader-worldgen.log); an
 * `autocreate` generation is documented to load the world it just made and print
 * `Server started`. Both are accepted, and so is the process exiting on its own,
 * because all three mean "the generator is done" - and after any of them the
 * produced file is verified before anything is promoted. The world prompt
 * arrives without a trailing newline, so the unterminated tail of the buffer is
 * checked too; waiting for a newline that never comes is how this would hang.
 */
function runGenerationProcess({ operationId, variant, launch, onProgress, timeoutMs, silenceMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(launch.executable, launch.args, {
        cwd: launch.cwd || undefined,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      return reject(new TerrariaWorldError(`The server could not be started to generate a world: ${error.message}`, { code: 'spawn_failed' }));
    }

    let settled = false;
    let generating = false;
    let lastActivity = Date.now();
    let exitRequested = false;
    let pending = '';
    const startedAt = Date.now();

    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      fn(value);
    };

    // Ask the server to leave the way an operator would, then escalate. A
    // generation that will not exit must not hold the per-server lock open.
    const requestExit = () => {
      if (exitRequested) return;
      exitRequested = true;
      operations.appendEvent(operationId, { phase: 'stopping', message: 'sent "exit"', level: 'info' });
      try { child.stdin.write('exit\n'); } catch (_) { /* the escalation below covers it */ }
      setTimeout(() => { if (!child.killed && child.exitCode == null) { try { child.kill('SIGTERM'); } catch (_) { /* */ } } }, GENERATE_EXIT_TIMEOUT_MS / 2);
      setTimeout(() => { if (child.exitCode == null) { try { child.kill('SIGKILL'); } catch (_) { /* */ } } }, GENERATE_EXIT_TIMEOUT_MS);
    };

    const kill = () => {
      try { child.kill('SIGTERM'); } catch (_) { /* */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* */ } }, 5000);
    };

    const consider = (line) => {
      lastActivity = Date.now();
      if (consoleGrammar.isReady(variant, line)) { requestExit(); return; }
      const event = consoleGrammar.inspect(variant, line);
      if (!event) {
        // The menu prompt after generation: the world was written and the server
        // is asking which one to load. Nothing is typed at it (the numbering
        // depends on the world list, and a blind answer loads the wrong world).
        if (generating && consoleGrammar.isWorldSelectionPrompt(variant, line)) requestExit();
        return;
      }
      if (event.kind === 'worldgenStart') { generating = true; onProgress({ percent: 0, stage: null }); return; }
      if (event.kind === 'worldgen') {
        generating = true;
        onProgress({ percent: event.percent, stage: event.stage, stagePercent: event.stagePercent });
      }
    };

    const feed = (chunk) => {
      pending += chunk.toString('utf8');
      let index;
      while ((index = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, index).replace(/\r$/, '');
        pending = pending.slice(index + 1);
        if (line) consider(line);
      }
      // The prompt is flushed without a newline; check the tail as well.
      if (pending.length > consoleGrammar.MAX_LINE_LENGTH) pending = pending.slice(-consoleGrammar.MAX_LINE_LENGTH);
      if (pending && generating && consoleGrammar.isWorldSelectionPrompt(variant, pending)) requestExit();
    };

    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (error) => done(reject, new TerrariaWorldError(`The generation process failed: ${error.message}`, { code: 'spawn_failed' })));
    child.on('exit', (code, signal) => done(resolve, { code, signal, requestedExit: exitRequested, generating }));

    const poll = setInterval(() => {
      const op = operations.get(operationId);
      if (!op || op.state === operations.STATES.CANCELLED) {
        kill();
        return done(reject, new Cancelled());
      }
      if (Date.now() - startedAt > timeoutMs) {
        kill();
        return done(reject, new TerrariaWorldError('World generation took too long and was stopped.', { status: 504, code: 'generate_timeout' }));
      }
      if (Date.now() - lastActivity > silenceMs) {
        kill();
        return done(reject, new TerrariaWorldError('The server stopped reporting progress while generating the world.', { status: 504, code: 'no_progress' }));
      }
      operations.heartbeat(operationId, {});
    }, 2000);
  });
}

async function runGenerate({
  desc, manager, operationId, preview, saveDescriptor, readDescriptor, broadcast,
  timeoutMs = GENERATE_TIMEOUT_MS, silenceMs = GENERATE_SILENCE_MS, spawnGeneration = runGenerationProcess,
}) {
  let tx = null;
  let committed = false;
  let snapshot = null;

  try {
    checkpoint(operationId, 'preview-revalidate', 0.02);
    const saveDir = resolveSaveDir(desc);
    const variant = safeVariant(desc);
    tx = new Transaction({ serverDir: saveDir.root, operationId });
    const stagedDir = path.join(tx.root, 'payload', ...saveDir.rel.split('/'));
    const stagedWorld = path.join(stagedDir, preview.file);
    const stagingConfig = path.join(tx.root, 'serverconfig.generate.txt');
    if (!variant) fail('This server\'s Terraria edition is not recognised, so Hostkind will not run its binary.', 409, 'unknown_variant');
    if (fs.existsSync(path.join(saveDir.abs, preview.file))) {
      fail(`"${preview.file}" already exists in this server's world folder.`, 409, 'name_collision');
    }
    assertDisk(diskPlan(saveDir.abs, preview.disk.requiredBytes));

    checkpoint(operationId, 'require-offline', 0.04);
    requireOffline(manager, 'generating a world');

    checkpoint(operationId, 'snapshot', 0.06);
    fs.mkdirSync(saveDir.abs, { recursive: true });
    snapshot = snapshots.take({
      serverId: desc.id, sourceDir: saveDir.root, scope: scopeFor(preview.snapshotScope || [saveDir.rel]),
      kind: 'terraria-world-generate', reason: `Generate "${preview.name}"`,
    });
    if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');

    /*
     * A temporary config in staging, so the live serverconfig.txt is untouched
     * and the server writes the new world into the staging tree rather than into
     * the save directory. The port is the one this server is configured for: it
     * has to be free, and the server being offline is what makes it free.
     */
    checkpoint(operationId, 'stage-config', 0.08);
    fs.mkdirSync(stagedDir, { recursive: true });
    const live = readConfigDocument(desc);
    const { document: generation } = terrariaConfig.patch(live.document, {
      world: stagedWorld,
      worldpath: stagedDir,
      autocreate: String(preview.autocreate),
      worldname: preview.name,
      difficulty: String(preview.difficultyValue),
      seed: preview.seed,
      maxplayers: '1',
      motd: '',
    });
    fs.writeFileSync(stagingConfig, terrariaConfig.serialize(generation));

    checkpoint(operationId, 'generating', 0.1);
    const launch = generationLaunch(desc, stagingConfig);
    operations.appendEvent(operationId, {
      phase: 'generating',
      message: `generating a ${preview.size} world`,
      level: 'info',
      metadata: { size: preview.size, difficulty: preview.difficulty },
    });

    // A generation prints a progress tick several times a second for minutes on
    // end. The operation's timeline gets one event per decile - enough to narrate
    // what happened, without writing thousands of rows for one world.
    let narrated = -1;
    let lastStage;
    let lastPush = 0;
    const outcome = await spawnGeneration({
      operationId,
      variant,
      launch,
      timeoutMs,
      silenceMs,
      onProgress: ({ percent, stage, stagePercent }) => {
        const decile = Math.floor((percent || 0) / 10);
        // A milestone is worth a write whenever it happens; everything between
        // milestones is the same number moving, and is sampled.
        const milestone = decile > narrated || stage !== lastStage;
        const now = Date.now();
        if (!milestone && now - lastPush < PROGRESS_INTERVAL_MS) return;
        lastPush = now;
        lastStage = stage;

        operations.heartbeat(operationId, { phase: 'generating', progress: 0.1 + 0.6 * Math.min(1, (percent || 0) / 100) });
        if (decile > narrated) {
          narrated = decile;
          operations.appendEvent(operationId, {
            phase: 'generating',
            message: stage ? `${Math.round(percent)}% - ${stage}` : `${Math.round(percent)}%`,
            level: 'info',
            metadata: { percent: Math.round(percent), stage: stage || null },
          });
        }
        // The console is the only source of generation progress, so it is
        // forwarded verbatim - a percentage and the stage name, nothing else.
        if (broadcast) {
          try {
            broadcast({
              type: 'terraria-worldgen',
              serverId: desc.id,
              operationId,
              percent: percent || 0,
              stage: stage || null,
              stagePercent: stagePercent == null ? null : stagePercent,
            });
          } catch (_) { /* a broadcast failure must never fail a generation */ }
        }
      },
    });

    checkpoint(operationId, 'verify', 0.75);
    const stat = statOf(stagedWorld);
    if (!stat || stat.size === 0) {
      fail(
        outcome && outcome.code
          ? `The server exited with code ${outcome.code} without producing a world.`
          : 'The server did not produce a world file.',
        500,
        'generate_failed',
      );
    }
    const header = readHeaderOf(stagedWorld);
    if (!header.ok) fail(`The generated file is not a readable Terraria world (${header.reason}).`, 500, 'generate_unreadable');

    checkpoint(operationId, 'journal', 0.8);
    const produced = [preview.file];
    // tModLoader writes the modded half beside the world; it travels with it.
    const modFile = `${preview.name}${MOD_EXT}`;
    if (fs.existsSync(path.join(stagedDir, modFile))) produced.push(modFile);
    for (const name of produced) tx.stageExisting(path.posix.join(saveDir.rel, name));
    tx.saveJournal();

    tx.commit();
    committed = true;
    operations.heartbeat(operationId, { phase: 'verify', progress: 0.9 });

    const promoted = readHeaderOf(path.join(saveDir.abs, preview.file));
    if (!promoted.ok) {
      const err = new TerrariaWorldError('The generated world is not readable after the commit.', { code: 'verify_failed' });
      err.compensated = false;
      throw err;
    }

    let selected = null;
    if (preview.select) {
      operations.heartbeat(operationId, { phase: 'select', progress: 0.95 });
      selected = applySelection({
        desc, operationId: `${operationId}-select`, saveDir, file: preview.file, name: preview.name,
        saveDescriptor, readDescriptor,
      });
    }

    if (snapshot) { try { snapshots.remove(snapshot.id); } catch (_) { /* retention sweeps it */ } }
    const result = {
      file: preview.file,
      name: preview.name,
      size: preview.size,
      difficulty: preview.difficulty,
      companions: produced.slice(1),
      selected: !!selected,
      restartRequired: !!selected,
    };
    recordResult(operationId, result);
    operations.finish(operationId, result);
    return result;
  } catch (err) {
    // Cancelled, failed or timed out: staging goes, and the save directory has
    // never been touched.
    if (!committed) {
      if (tx) { try { tx.rollback(); } catch (_) { /* swept later */ } }
      if (snapshot) { try { snapshots.remove(snapshot.id); } catch (_) { /* keep it */ } }
    }
    settle(operationId, err, { compensated: err.compensated !== false });
    throw err;
  }
}

/* ------------------------------------------------------------------ delete -- */

function previewDelete({ desc, actorId, file, manager }) {
  const world = findWorld(desc, file, { requireReadable: false });
  const selection = currentSelection(desc, world.saveDir);
  const active = !!selection.file && sameFile(selection.file, world.file);
  const remaining = inventory(desc).worlds.filter((entry) => !sameFile(entry.file, world.file));

  return savePreview({
    desc, actorId, action: ACTIONS[KIND.DELETE], file: world.file,
    payload: {
      action: ACTIONS[KIND.DELETE],
      world: publicWorld(world),
      // Companions are deleted with the world. Leaving a .twld behind would
      // leave the modded half of a save nobody can use.
      companions: world.companions.map((c) => c.file),
      // Deleting the world the server is set to load clears the selection too,
      // so the configuration cannot be left pointing at a file that is gone.
      active,
      clearsSelection: active,
      remaining: remaining.map((entry) => entry.file),
      requiresOffline: true,
      serverOffline: !manager || manager.status === 'offline',
      snapshotScope: [world.saveDir.rel],
      // The snapshot needs the same space again, and the quarantine move is a
      // rename rather than a copy.
      disk: diskPlan(world.saveDir.abs, world.sizeBytes + world.companions.reduce((sum, c) => sum + c.sizeBytes, 0)),
      retentionDays: trash.DEFAULT_RETENTION_DAYS,
    },
  });
}

async function runDelete({ desc, manager, operationId, preview, actorId, saveDescriptor, readDescriptor, servers = [] }) {
  let snapshot = null;
  const moved = [];

  try {
    checkpoint(operationId, 'preview-revalidate', 0.05);
    const saveDir = resolveSaveDir(desc);
    const world = findWorld(desc, preview.world.file, { requireReadable: false });
    assertDisk(diskPlan(saveDir.abs, preview.disk.requiredBytes));

    checkpoint(operationId, 'require-offline', 0.15);
    requireOffline(manager, 'deleting a world');

    checkpoint(operationId, 'snapshot', 0.3);
    snapshot = snapshots.take({
      serverId: desc.id, sourceDir: saveDir.root, scope: scopeFor(preview.snapshotScope || [saveDir.rel]),
      kind: 'terraria-world-delete', reason: `Delete "${world.name}"`,
    });
    if (!snapshots.verify(snapshot.id).ok) fail('The safety snapshot could not be verified.', 500, 'snapshot_unverified');

    /*
     * Quarantine, never a recursive remove. Each file is moved on its own so it
     * can be restored to exactly where it came from; if one move fails, the ones
     * already moved are put back and nothing has been lost.
     */
    checkpoint(operationId, 'quarantine', 0.5);
    const files = [world.file, ...world.companions.map((c) => c.file)];
    try {
      for (const name of files) {
        const target = path.join(saveDir.abs, name);
        if (!fs.existsSync(target)) continue;
        const entry = trash.moveToTrash({
          target,
          kind: 'terraria-world',
          serverId: desc.id,
          label: name,
          reason: `Deleted with world "${world.name}"`,
          actorId: actorId || null,
          scope: 'item',
          servers,
        });
        moved.push({ file: name, trashId: entry ? entry.id : null });
      }
    } catch (error) {
      for (const item of moved.reverse()) {
        if (item.trashId) { try { trash.restore(item.trashId, { servers }); } catch (_) { /* the snapshot is the backstop */ } }
      }
      fail(`The world could not be moved to trash, so nothing was deleted: ${error.message}`, error.status || 500, error.code || 'trash_failed');
    }

    operations.heartbeat(operationId, { phase: 'verify', progress: 0.75 });
    if (fs.existsSync(path.join(saveDir.abs, world.file))) {
      const err = new TerrariaWorldError('The world file is still present after the delete.', { code: 'verify_failed' });
      err.compensated = false;
      throw err;
    }

    // The configuration may not be left pointing at a world that is gone.
    let selectionCleared = false;
    if (preview.clearsSelection) {
      operations.heartbeat(operationId, { phase: 'clear-selection', progress: 0.85 });
      selectionCleared = clearSelection({ desc, operationId, saveDir, saveDescriptor, readDescriptor });
    }

    const result = {
      file: world.file,
      name: world.name,
      companions: moved.filter((item) => item.file !== world.file).map((item) => item.file),
      trash: moved.map((item) => item.trashId).filter(Boolean),
      retentionDays: trash.DEFAULT_RETENTION_DAYS,
      selectionCleared,
      snapshotId: snapshot.id,
    };
    recordResult(operationId, result);
    operations.finish(operationId, result);
    return result;
  } catch (err) {
    if (!moved.length && snapshot) { try { snapshots.remove(snapshot.id); } catch (_) { /* keep it */ } }
    settle(operationId, err, { compensated: err.compensated !== false });
    throw err;
  }
}

/*
 * Remove the selection from both places that hold it. The `world=` line is
 * deleted rather than emptied, which returns the server to its world menu - a
 * state the module already detects and surfaces (`awaitingWorldSelection`) -
 * instead of leaving it pointed at a file that no longer exists.
 */
function clearSelection({ desc, operationId, saveDir, saveDescriptor, readDescriptor }) {
  const { abs: configAbs, rel: configRel, document, exists } = readConfigDocument(desc);
  if (exists) {
    const before = fs.readFileSync(configAbs);
    const { document: next } = terrariaConfig.patch(document, { world: null });
    const tx = new Transaction({ serverDir: saveDir.root, operationId: `${operationId}-clear` });
    tx.stageWrite(configRel, terrariaConfig.serialize(next));
    tx.saveJournal();
    tx.commit();
    try {
      saveDescriptor({ terrariaWorld: null });
    } catch (error) {
      try { fs.writeFileSync(configAbs, before); }
      catch {
        const err = new TerrariaWorldError(
          `The selection was cleared in ${configRel} but the panel configuration could not be saved: ${error.message}`,
          { code: 'config_save_failed' },
        );
        err.compensated = false;
        throw err;
      }
      fail(`The panel configuration could not be saved: ${error.message}`, 500, 'config_save_failed');
    }
  } else {
    saveDescriptor({ terrariaWorld: null });
  }
  const stored = readDescriptor ? readDescriptor() : null;
  if (stored && stored.terrariaWorld && stored.terrariaWorld.file) {
    const err = new TerrariaWorldError('The selection could not be cleared.', { code: 'verify_failed' });
    err.compensated = false;
    throw err;
  }
  return true;
}

/* ---------------------------------------------------------------- download -- */

/*
 * A downloadable name a browser cannot be talked into interpreting: ASCII only,
 * no separators, no quotes, no control characters. Same rule as
 * lib/worlds.cjs's `safeDownloadName`.
 */
function safeDownloadName(serverName, worldName, extension = '.zip') {
  const clean = (value) => String(value || '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48);
  const base = [clean(serverName) || 'server', clean(worldName) || 'world'].join('-');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${base}-${stamp}${extension}`;
}

/*
 * Zip a world and its companions. The `.twld` travels with the `.wld`: a
 * download that loses it is a download of half a modded save.
 */
function zipWorld(desc, rawFile, output) {
  const world = findWorld(desc, rawFile, { requireReadable: false });
  const files = [world.file, ...world.companions.map((c) => c.file)];
  return new Promise((resolve, reject) => {
    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.on('error', reject);
    zip.on('warning', (warning) => { if (warning.code !== 'ENOENT') reject(warning); });
    output.on('error', reject);
    output.on('close', () => resolve({ bytes: zip.pointer(), files }));
    zip.pipe(output);
    for (const name of files) zip.file(path.join(world.saveDir.abs, name), { name });
    zip.finalize();
  });
}

function downloadName(desc, rawFile) {
  const world = findWorld(desc, rawFile, { requireReadable: false });
  return { filename: safeDownloadName(desc.name, world.name), files: [world.file, ...world.companions.map((c) => c.file)] };
}

module.exports = {
  KIND, ACTIONS, SIZES, DIFFICULTIES, PREVIEW_TTL, WORLD_EXT, MOD_EXT, CONFIG_FILE,
  MAX_WORLD_BYTES, MAX_NAME_LENGTH,
  TerrariaWorldError, Cancelled,
  readWorldHeader, readHeaderOf,
  normalizeName, normalizeSeed, normalizeFile, normalizeGenerateInput,
  worldFileFor, displayName, sameFile, companionNames, existingCompanions,
  configFileOf, readConfigDocument, resolveSaveDir, worldPath, currentSelection,
  inventory, findWorld, fingerprint,
  freeBytes, diskPlan, assertDisk,
  savePreview, consumePreview,
  beginOperation, findOperationByKey, recordOperation, recordResult, listOperations, activeOperations, checkpoint,
  importStagingDir, sweepImportStaging, extractWorldFromArchive,
  previewSelect, runSelect, applySelection,
  previewImport, runImport,
  previewGenerate, runGenerate, generationLaunch, runGenerationProcess,
  previewDelete, runDelete, clearSelection,
  zipWorld, downloadName, safeDownloadName,
};
