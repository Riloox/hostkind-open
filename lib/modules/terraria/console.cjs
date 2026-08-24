'use strict';

/*
 * Terraria console grammar (docs/terraria/02-lifecycle-console.md).
 *
 * Every pattern below was read off a capture in `test/fixtures/terraria/`, and
 * every pattern names the fixture it came from. `test/terraria-lifecycle.test.cjs`
 * walks this table and fails if a pattern matches nothing in the fixture it
 * claims - which is how "a pattern without a fixture does not ship" is enforced
 * rather than merely promised.
 *
 * Two findings from the captures shaped this file:
 *
 *   1. `Listening on port <n>` is NOT readiness. A vanilla server whose port is
 *      already bound prints that line, prints the help hint, and exits without
 *      ever printing `Server started` (port-in-use.log). The shipped stub
 *      matched `/Listening on port|Server started/i`, so it reported a server
 *      that was already gone as `online`. Readiness is the started line alone.
 *   2. The dedicated server writes its prompt (`: `) without a newline, so a
 *      line can arrive as `: Server started` or as `Server started` depending
 *      on whether anything was typed first. Every pattern here tolerates the
 *      prompt prefix instead of anchoring at the start of the line.
 *
 * One thing the phase asked for is deliberately not here: a rule for the loaded
 * world's name. No variant prints one. A vanilla, TShock or tModLoader server
 * loads its world in silence - the captures go straight from "Loading world
 * data: 100%" to the listening line - and the only place a world name appears
 * on the console is the selection menu, which lists every world rather than
 * naming the loaded one. `statusFields().terrariaWorld` therefore stays sourced
 * from the descriptor (phase 3), because inventing a pattern for a line that
 * does not exist is exactly what this phase is written to prevent.
 *
 * The module is pure: no state, no I/O, no manager. The manager owns the state
 * machine, this owns "what does this line mean".
 */

const { isVariant } = require('./variants.cjs');

// A console line longer than this is not parsed. Terraria prints stack traces
// and tile dumps that no pattern here should ever be run against, and an
// unbounded regex over an unbounded line is how a console pump stalls.
const MAX_LINE_LENGTH = 512;

// The tracked roster is capped. A server can be configured for at most 255
// slots; anything past this is a parse gone wrong, not a full server.
const MAX_PLAYERS = 255;

// Terraria refuses names longer than 20 characters, but a modded or spoofed
// client can send more, and the name reaches the UI. Cap what we keep.
const MAX_NAME_LENGTH = 64;

// The prompt the dedicated server leaves on the line before its own output.
const PROMPT = '(?::\\s*)?';

/*
 * The pattern table.
 *
 * `variants` is which variants a rule applies to; `fixtures` is the captures
 * that prove it. A rule with no fixture cannot exist - the test enumerates
 * this array.
 */
const RULES = Object.freeze([
  // -- readiness ------------------------------------------------------------
  {
    id: 'ready',
    variants: ['vanilla', 'tshock', 'tmodloader'],
    pattern: new RegExp(`^${PROMPT}Server started\\s*$`),
    fixtures: ['vanilla-start.log', 'tshock-start.log', 'tmodloader-start.log'],
  },

  // -- identity -------------------------------------------------------------
  {
    id: 'version',
    variants: ['vanilla', 'tshock', 'tmodloader'],
    // "Terraria Server v1.4.5.6" and, under tModLoader,
    // "Terraria Server v1.4.4.9 - tModLoader v2026.5.3.0".
    pattern: new RegExp(`^${PROMPT}Terraria Server v(\\d[\\w.]*)(?: - tModLoader v(\\S+))?\\s*$`),
    fixtures: ['vanilla-start.log', 'tshock-start.log', 'tmodloader-start.log'],
  },
  {
    id: 'tshock-version',
    variants: ['tshock'],
    // "TShock 6.1.0.0 (Profoundly Collaborative (3.11)) now running."
    pattern: /^TShock (\d[\w.]*) \(.*\) now running\.\s*$/,
    fixtures: ['tshock-start.log'],
  },

  // -- the interactive-menu trap -------------------------------------------
  {
    id: 'menu',
    variants: ['vanilla', 'tshock', 'tmodloader'],
    // The prompt the server blocks on when no world is configured. It arrives
    // without a trailing newline, so it is the tail of whatever line is
    // flushed - hence no end anchor.
    pattern: /Choose World:\s*$/,
    fixtures: ['interactive-menu.log', 'vanilla-worldgen.log', 'tmodloader-worldgen.log'],
  },

  // -- world generation -----------------------------------------------------
  {
    id: 'worldgen',
    variants: ['vanilla', 'tshock', 'tmodloader'],
    // "12.3% - Generating world terrain - 45.6%": overall, stage, stage share.
    pattern: /^([\d.]+)% - (.*?) - ([\d.]+)%\s*$/,
    fixtures: ['vanilla-worldgen.log', 'tmodloader-worldgen.log'],
  },
  {
    id: 'worldgen-start',
    variants: ['vanilla', 'tshock', 'tmodloader'],
    // "Creating world - Seed: fleetdeck, Width: 4200, Height: 1200, ..."
    pattern: /^Creating world - Seed: /,
    fixtures: ['vanilla-worldgen.log', 'tmodloader-worldgen.log'],
  },

  // -- tModLoader mod loading ----------------------------------------------
  {
    id: 'modload-phase',
    variants: ['tmodloader'],
    // "Finding Mods...", "Constructing Mods...", "Adding Recipes..."
    pattern: /^(Finding Mods|Constructing Mods|Adding Recipes|Resizing)\.\.\.\s*$/,
    fixtures: ['tmodloader-start.log', 'tmodloader-modload.log'],
  },
  {
    id: 'modload-mod',
    variants: ['tmodloader'],
    // "Adding Content: tModLoader v2026.5.3.0" - the mod currently loading.
    pattern: /^(?:Adding Content|Configuring Content|Finalizing Content|Loading): (.+?)\s*$/,
    fixtures: ['tmodloader-start.log', 'tmodloader-modload.log'],
  },

  // -- players --------------------------------------------------------------
  {
    id: 'join',
    variants: ['vanilla', 'tshock', 'tmodloader'],
    // Vanilla and tModLoader: "Hostkind Guest has joined."
    // TShock also logs "Hostkind Guest has joined. IP: 127.0.0.1" and the
    // group form "Hostkind Guest (N/A) has joined."; both are handled by
    // `parseJoin` rather than by widening this pattern.
    //
    // There is no tModLoader capture of a join: a tModLoader server refuses
    // unmodded clients ("You cannot connect to a tModLoader Server with an
    // unmodded client" - tmodloader-start.log), and Hostkind has no modded
    // client to connect with. The line is the same one because tModLoader
    // ships the same string: `Game.19` is "{0} has joined." in the localization
    // embedded in tModLoader.dll, the same key vanilla prints from. That is a
    // shipped artifact, not a memory, and it is why tModLoader is listed here.
    pattern: new RegExp(`^${PROMPT}(.+?) has joined\\.\\s*(?:IP: \\S+\\s*)?$`),
    fixtures: ['vanilla-players.log', 'tshock-players.log'],
  },
  {
    id: 'leave',
    variants: ['vanilla', 'tshock', 'tmodloader'],
    pattern: new RegExp(`^${PROMPT}(.+?) has left\\.\\s*$`),
    fixtures: ['vanilla-players.log', 'tshock-players.log'],
  },
  // -- `playing` replies ----------------------------------------------------
  {
    id: 'roster-empty',
    variants: ['vanilla', 'tshock', 'tmodloader'],
    // Vanilla/tModLoader: "No players connected."
    // TShock:             "There are currently no players online."
    pattern: new RegExp(`^${PROMPT}(?:No players connected\\.|There are currently no players online\\.)\\s*$`),
    fixtures: ['vanilla-players.log', 'tshock-players.log', 'tmodloader-start.log'],
  },
  {
    id: 'roster-entry',
    variants: ['vanilla', 'tmodloader'],
    // "Hostkind Guest (127.0.0.1:44768)" - one line per player, address last.
    // The address is parsed only so it can be dropped: it never reaches the
    // player list (docs/terraria/02-lifecycle-console.md step 4).
    //
    // tModLoader shares the reason given on the join rule: its `playing` reply
    // with nobody online is captured (tmodloader-start.log) and is vanilla's,
    // and the populated form comes from the same vanilla command handler.
    pattern: new RegExp(`^${PROMPT}(.+?) \\(([^()]*)\\)\\s*$`),
    fixtures: ['vanilla-players.log'],
  },
  {
    id: 'roster-count',
    variants: ['vanilla', 'tmodloader'],
    // "2 players connected." / "1 player connected."
    pattern: new RegExp(`^${PROMPT}(\\d+) players? connected\\.\\s*$`),
    fixtures: ['vanilla-players.log'],
  },
  {
    id: 'player-limit',
    variants: ['vanilla', 'tshock', 'tmodloader'],
    // The reply to the `maxplayers` console command. Hostkind does not poll
    // it - the roster poll is one command - but an operator who types it is
    // telling us something worth keeping.
    pattern: new RegExp(`^${PROMPT}Player limit: (\\d+)\\s*$`),
    fixtures: ['vanilla-start.log'],
  },
  {
    id: 'tshock-roster-header',
    variants: ['tshock'],
    // "Online Players (2/8)", followed by one comma-separated names line.
    pattern: /^Online Players \((\d+)\/(\d+)\)\s*$/,
    fixtures: ['tshock-players.log'],
  },

  // -- saving and shutdown --------------------------------------------------
  {
    id: 'saved',
    variants: ['vanilla', 'tshock'],
    // The last line of a save cycle. "Saving world data:" and "Validating
    // world save:" are progress; the backup is what says the save landed.
    pattern: new RegExp(`^${PROMPT}Backing up world file\\s*$`),
    fixtures: ['vanilla-start.log', 'tshock-stop.log'],
  },
  {
    id: 'saved-modded',
    variants: ['tmodloader'],
    // tModLoader ends a save with the modded half of the world instead - a
    // world is a .wld plus its sibling .twld - and does not print the backup
    // line at all. Phase 5 waits on the line that means the whole save is on
    // disk, so for tModLoader that is this one.
    pattern: new RegExp(`^${PROMPT}Saving modded world data\\s*$`),
    fixtures: ['tmodloader-start.log'],
  },
  {
    id: 'shutdown',
    variants: ['vanilla', 'tshock', 'tmodloader'],
    // Vanilla and tModLoader print "Saving before exit..."; TShock prints
    // "Server shutting down!" first and then the same line.
    pattern: new RegExp(`^${PROMPT}(?:Saving before exit\\.\\.\\.|Server shutting down!)\\s*$`),
    fixtures: ['vanilla-stop.log', 'tshock-stop.log', 'tmodloader-stop.log'],
  },

  // -- failures the operator has to be told about ---------------------------
  {
    id: 'world-load-failed',
    variants: ['vanilla', 'tshock', 'tmodloader'],
    // "Load failed!  No backup found." - the world named in the config is not
    // there. Vanilla then exits; tModLoader crashes on the same path.
    pattern: /^Load failed!\s+No backup found\.\s*$/,
    fixtures: ['missing-world.log'],
  },
]);

const BY_ID = Object.freeze(Object.fromEntries(RULES.map((rule) => [rule.id, rule])));

function rule(id) {
  const found = BY_ID[id];
  if (!found) throw new Error(`Unknown Terraria console rule: ${id}`);
  return found;
}

// Does `id` apply to `variant`? An unrecognized variant matches nothing: the
// module fails closed rather than falling back to vanilla's grammar.
function applies(id, variant) {
  return isVariant(variant) && rule(id).variants.includes(variant);
}

function match(id, variant, line) {
  if (!applies(id, variant)) return null;
  return rule(id).pattern.exec(line);
}

// A console line is only parsed if it is short enough to be console output.
function usable(line) {
  const text = typeof line === 'string' ? line : String(line == null ? '' : line);
  return text.length <= MAX_LINE_LENGTH ? text : null;
}

// Player names arrive from the network. Keep them printable and bounded before
// they reach a roster, a status payload, or a UI.
function safeName(raw) {
  const name = String(raw == null ? '' : raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!name || name.length > MAX_NAME_LENGTH) return null;
  return name;
}

/*
 * Readiness.
 *
 * `Server started` is the only line that means the server is accepting
 * players, for all three variants. TShock prints its own banner earlier
 * (during plugin init, before the world is even loaded), so TShock's banner is
 * identity, not readiness - see tshock-start.log.
 */
function isReady(variant, line) {
  const text = usable(line);
  if (text == null) return false;
  return !!match('ready', variant, text);
}

/*
 * "The server is asking a question and will wait forever."
 *
 * Detected on the world-selection prompt, which is what an unconfigured server
 * blocks on. Nothing is written to stdin in response: the numbering depends on
 * the world list, and answering blind is how the wrong world gets loaded
 * (docs/terraria/02-lifecycle-console.md step 2).
 */
function isWorldSelectionPrompt(variant, line) {
  const text = usable(line);
  if (text == null) return false;
  return !!match('menu', variant, text);
}

/*
 * Classify one console line.
 *
 * Returns an event object or null. Callers switch on `kind`; the manager owns
 * what each one does to the roster and the status payload.
 */
function inspect(variant, line) {
  const text = usable(line);
  if (text == null) return null;

  let m = match('version', variant, text);
  if (m) return { kind: 'version', game: m[1], loader: m[2] || null };

  m = match('tshock-version', variant, text);
  if (m) return { kind: 'variantVersion', version: m[1] };

  m = match('modload-mod', variant, text);
  if (m) {
    const mod = safeName(m[1]);
    return mod ? { kind: 'modLoading', mod } : null;
  }

  m = match('modload-phase', variant, text);
  if (m) return { kind: 'modLoading', mod: null, phase: m[1] };

  m = match('worldgen', variant, text);
  if (m) {
    const overall = Number(m[1]);
    const stagePercent = Number(m[3]);
    if (!Number.isFinite(overall) || !Number.isFinite(stagePercent)) return null;
    return {
      kind: 'worldgen',
      percent: Math.max(0, Math.min(100, overall)),
      stage: safeName(m[2]) || null,
      stagePercent: Math.max(0, Math.min(100, stagePercent)),
    };
  }

  m = match('worldgen-start', variant, text);
  if (m) return { kind: 'worldgenStart' };

  m = match('join', variant, text);
  if (m) {
    const name = parseJoin(m[1]);
    if (name) return { kind: 'join', name };
    return null;
  }

  m = match('leave', variant, text);
  if (m) {
    const name = safeName(m[1]);
    if (name) return { kind: 'leave', name };
    return null;
  }

  m = match('roster-empty', variant, text);
  if (m) return { kind: 'rosterEmpty' };

  m = match('tshock-roster-header', variant, text);
  if (m) return { kind: 'rosterHeader', count: Number(m[1]), max: Number(m[2]) };

  m = match('roster-count', variant, text);
  if (m) return { kind: 'rosterEnd', count: Number(m[1]) };

  m = match('player-limit', variant, text);
  if (m) return { kind: 'playerLimit', limit: Number(m[1]) };

  m = match('roster-entry', variant, text);
  if (m) {
    const name = safeName(m[1]);
    // The parenthesised half is the client's address. It is matched so the
    // name can be separated from it, and then thrown away.
    if (name) return { kind: 'rosterEntry', name };
    return null;
  }

  m = match('saved', variant, text) || match('saved-modded', variant, text);
  if (m) return { kind: 'saved' };

  m = match('shutdown', variant, text);
  if (m) return { kind: 'shutdown' };

  m = match('world-load-failed', variant, text);
  if (m) return { kind: 'worldLoadFailed' };

  return null;
}

/*
 * The name out of a join line.
 *
 * TShock announces a join twice: once as chat with the player's group in
 * parentheses ("Hostkind Guest (N/A) has joined.") and once as a log line
 * with the address ("Hostkind Guest has joined. IP: 127.0.0.1"). Both name
 * the same player, so both are parsed to the same name and the manager's
 * roster (a set) collapses them.
 */
function parseJoin(raw) {
  const trimmed = String(raw == null ? '' : raw).trim();
  const grouped = /^(.*?) \(([^()]*)\)$/.exec(trimmed);
  return safeName(grouped ? grouped[1] : trimmed);
}

/*
 * The comma-separated names line TShock prints under "Online Players (n/m)".
 *
 * TShock joins names with ", " and does not escape a comma inside a name, so a
 * name containing one splits. That ambiguity is TShock's, and phase 7's
 * adapter - which returns a real list - is what resolves it; until then the
 * console roster is the best available answer and the manager reconciles it
 * against join/leave lines rather than trusting it blindly.
 */
function parseTshockRoster(line) {
  const text = usable(line);
  if (text == null) return [];
  return text
    .split(',')
    .map((part) => safeName(part))
    .filter(Boolean)
    .slice(0, MAX_PLAYERS);
}

module.exports = {
  MAX_LINE_LENGTH,
  MAX_PLAYERS,
  MAX_NAME_LENGTH,
  RULES,
  isReady,
  isWorldSelectionPrompt,
  inspect,
  parseTshockRoster,
};
