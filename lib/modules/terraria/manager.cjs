'use strict';

/*
 * Terraria server module (docs/terraria/00-baseline-contracts.md,
 * docs/terraria/02-lifecycle-console.md).
 *
 * Replaces the `createGenericGameModule('terraria')` stub. Phase 0 made the
 * variant (vanilla / TShock / tModLoader) a first-class descriptor field and
 * computed capabilities per descriptor. Phase 2 adds the lifecycle: readiness,
 * the interactive-menu trap, line inspection, the player roster, and the
 * pre-launch checks. Every pattern it relies on lives in `console.cjs` and is
 * pinned to a capture in `test/fixtures/terraria/`.
 *
 * Hooks owned by later phases are deliberately ABSENT, not stubbed: an absent
 * hook plus a withheld capability is the honest representation of "not yet"
 * (see lib/modules/base.cjs). What is missing and where it lands:
 *
 *   playerAction                                                  -> landed here
 *   configSchema / readConfig / writeConfig                       -> phase 4
 *   backupPrepare / backupCleanup / backupRestartPolicy           -> phase 5
 *   validateRegistration / buildLaunch                            -> phase 9
 *
 * discoverUpdate / applyUpdate / rollbackUpdate landed with phase 1 and
 * delegate to lib/terraria-install.cjs.
 */

const fs = require('fs');
const path = require('path');
const terrariaInstall = require('../../terraria-install.cjs');
const terrariaConfig = require('../../terraria-config.cjs');
const terrariaCrashes = require('../../terraria-crashes.cjs');
const dotnetRuntime = require('../../dotnetRuntime.cjs');
const consoleGrammar = require('./console.cjs');
const {
  VARIANTS,
  BASE_CAPABILITIES,
  resolveVariant,
  variantInfo,
  capabilitiesForVariant,
} = require('./variants.cjs');

// Terraria binds every interface, so probing the IPv4 wildcard is what tells us
// whether the port is genuinely taken (see probePortInUse in server.js for why
// the host matters).
const PROBE_HOST = '0.0.0.0';

// Launch arguments that carry the server password. It reaches the console line
// and the panel log otherwise, and secrets stay server-side.
const SECRET_FLAGS = new Set(['-password']);
const BACKUP_SAVE_TIMEOUT_MS = 30_000;

function relativeFiles(root, rel, accept = () => true) {
  const base = path.resolve(root);
  const start = path.resolve(base, rel);
  if (start !== base && !start.startsWith(base + path.sep)) return [];
  const found = [];
  const walk = (full) => {
    let entries;
    try { entries = fs.readdirSync(full, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const child = path.join(full, entry.name);
      const childRel = path.relative(base, child).split(path.sep).join('/');
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && accept(childRel)) found.push(childRel);
    }
  };
  try {
    const stat = fs.statSync(start);
    if (stat.isDirectory()) walk(start);
    else if (stat.isFile() && accept(rel)) found.push(rel.split(path.sep).join('/'));
  } catch (_) { /* A missing optional backup path is simply omitted. */ }
  return found;
}

function descPort(desc) {
  const direct = Number(desc.port);
  if (Number.isInteger(direct) && direct > 0 && direct < 65536) return direct;
  const args = Array.isArray(desc.args) ? desc.args : [];
  const index = args.findIndex((arg) => String(arg).toLowerCase() === '-port');
  const parsed = index >= 0 ? Number(args[index + 1]) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : null;
}

// The variant of a manager's descriptor, or null when the stored value is not a
// variant Hostkind knows. Callers that gate behavior fail closed on null; they
// never substitute vanilla.
function safeVariant(desc) {
  try { return resolveVariant(desc); } catch (_) { return null; }
}

/*
 * The one command Hostkind types at a Terraria console on a timer.
 *
 * Join and leave lines maintain the roster between polls, but a connection
 * that drops does not always emit a leave line (see the captures: a save cycle
 * follows a leave, and a client that vanishes mid-handshake produces neither),
 * so the roster is reconciled against the server's own answer on the same
 * cadence Minecraft polls `list`/`tps`.
 */
const POLL_COMMAND = 'playing';

const PLAYER_ACTIONS = Object.freeze({ kick: 'kick', ban: 'ban' });

function playerActionError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizePlayerTarget(target) {
  if (typeof target !== 'string') {
    throw playerActionError('invalid_target', 'A Terraria player name is required.');
  }
  const name = target.trim();
  const hasUnsafeCharacter = [...name].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || code === 34 || code === 92;
  });
  if (!name || name.length > 64 || hasUnsafeCharacter) {
    throw playerActionError('invalid_target', 'The Terraria player name is invalid.');
  }
  return name;
}

function runPlayerAction(manager, action, target) {
  const command = PLAYER_ACTIONS[String(action || '').trim().toLowerCase()];
  if (!command) {
    throw playerActionError('unsupported_action', 'Terraria only supports kick and ban for console players.');
  }

  const descriptor = manager && typeof manager.desc === 'function' ? manager.desc() : null;
  const variant = safeVariant(descriptor);
  if (!variant || variant === 'tshock') {
    throw playerActionError('unsupported_action', 'This Terraria player action is not available for the selected server variant.');
  }
  if (!manager || manager.status !== 'online') {
    throw playerActionError('server_offline', 'The Terraria server must be online to manage a player.', 409);
  }

  const name = normalizePlayerTarget(target);
  const sent = manager.sendCommand(`${command} ${name}`, true);
  if (sent && sent.ok === false) return { ...sent, source: 'console' };
  return { ...(sent && typeof sent === 'object' ? sent : {}), ok: true, source: 'console' };
}

// How long a `playing` reply is allowed to take before the partial roster it
// was building is discarded. The reply is a handful of lines written in one
// go; anything still open at the next poll was never going to arrive.
const ROSTER_TIMEOUT_MS = 15_000;

function ensureState(manager) {
  const st = manager.moduleState || (manager.moduleState = {});
  // A Set of names, deliberately the same shape Minecraft's module uses, so
  // GET /api/players keeps working without a Terraria special case.
  if (!(st.players instanceof Set)) st.players = new Set();
  if (!(st.playerSince instanceof Map)) st.playerSince = new Map();
  if (st.maxPlayers == null) st.maxPlayers = 0;
  if (st.roster === undefined) st.roster = null;
  if (st.awaitingWorldSelection === undefined) st.awaitingWorldSelection = false;
  if (st.version === undefined) st.version = null;
  if (st.variantVersion === undefined) st.variantVersion = null;
  if (st.modLoading === undefined) st.modLoading = null;
  if (st.worldgen === undefined) st.worldgen = null;
  if (st.lastSavedAt === undefined) st.lastSavedAt = null;
  if (st.shutdownConfirmed === undefined) st.shutdownConfirmed = false;
  if (st.lastStop === undefined) st.lastStop = null;
  return st;
}

function clearState(st) {
  st.players.clear();
  st.playerSince.clear();
  st.roster = null;
  st.awaitingWorldSelection = false;
  st.modLoading = null;
  st.worldgen = null;
  st.shutdownConfirmed = false;
}

// Replace the roster with what the server just reported, keeping the join
// time of anyone who was already known. A player the server no longer lists is
// gone whether or not a leave line ever arrived.
function reconcile(manager, st, names) {
  const next = new Set(names.slice(0, consoleGrammar.MAX_PLAYERS));
  const changed = next.size !== st.players.size || [...next].some((name) => !st.players.has(name));
  for (const name of st.playerSince.keys()) if (!next.has(name)) st.playerSince.delete(name);
  for (const name of next) if (!st.playerSince.has(name)) st.playerSince.set(name, Date.now());
  st.players = next;
  if (changed) manager._afterPlayerChange();
}

function addPlayer(manager, st, name) {
  if (st.players.has(name) || st.players.size >= consoleGrammar.MAX_PLAYERS) return;
  st.players.add(name);
  st.playerSince.set(name, Date.now());
  manager._afterPlayerChange();
}

function removePlayer(manager, st, name) {
  if (!st.players.delete(name)) return;
  st.playerSince.delete(name);
  manager._afterPlayerChange();
}

// Open a roster read. Called right before `playing` goes out so a stale read
// from a poll that never got an answer cannot absorb the next one's lines.
function beginRoster(st) {
  st.roster = { names: [], startedAt: Date.now(), tshockNamesNext: false };
}

function rosterExpired(st) {
  return !!st.roster && Date.now() - st.roster.startedAt > ROSTER_TIMEOUT_MS;
}

/*
 * "The thing that runs this server is not there."
 *
 * For vanilla and TShock that is the server binary. For tModLoader the
 * descriptor's executable is the .NET runtime and the first argument is
 * `tModLoader.dll` (see buildLaunchPlan in lib/terraria-install.cjs), so both
 * halves have to exist or the failure is a .NET host error nobody can read.
 */
function missingRuntime(desc) {
  const executable = String(desc.executable || '').trim();
  if (!executable) return 'No Terraria server executable is configured for this server.';
  if (!fs.existsSync(executable)) {
    return safeVariant(desc) === 'tmodloader'
      ? `tModLoader needs its .NET runtime, and the configured runtime is missing: ${path.basename(executable)}`
      : `The Terraria server executable is missing: ${path.basename(executable)}`;
  }
  if (safeVariant(desc) !== 'tmodloader') return null;
  const entry = (Array.isArray(desc.args) ? desc.args : []).find((arg) => /\.dll$/i.test(String(arg)));
  if (entry && !fs.existsSync(entry)) {
    return `The tModLoader entry point is missing: ${path.basename(entry)}`;
  }
  return null;
}

/*
 * "The runtime that runs this is there, but it is the wrong one - or the
 * process will never find it."
 *
 * TShock and tModLoader are framework-dependent .NET applications, so the
 * binary existing says nothing about whether it can start: a host without the
 * major version they target prints the .NET host's own diagnostic and exits
 * with no server output at all. lib/dotnetRuntime.cjs reads what the app
 * requires out of the app and what the host has out of the install root, and
 * hands back both the refusal and the `DOTNET_ROOT` the child needs when the
 * runtime is somewhere an apphost would not look (a `~/.dotnet` install that is
 * only on `PATH`).
 *
 * Vanilla is native and never consults this.
 */
function dotnetPlan(desc, roots) {
  const variant = safeVariant(desc);
  const executable = String(desc.executable || '').trim();
  // `roots` is a test seam that replaces the OS-wide install locations (see
  // dotnetRuntime.discoverInstallRoot); nothing in the product passes it.
  const runtime = (extra) => (roots ? { ...extra, roots } : extra);
  if (variant === 'tshock') {
    return dotnetRuntime.inspect(runtime({ app: executable, label: 'TShock' }));
  }
  if (variant === 'tmodloader') {
    // The app is the managed entry point; the descriptor's executable is the
    // runtime that runs it, so a runtime the package bundled is where this host
    // should look first.
    const entry = (Array.isArray(desc.args) ? desc.args : []).find((arg) => /\.dll$/i.test(String(arg)));
    if (!entry) return { ok: true, env: null };
    return dotnetRuntime.inspect(runtime({ app: String(entry), label: 'tModLoader', hint: executable ? path.dirname(executable) : null }));
  }
  return { ok: true, env: null };
}

/*
 * "The world this server is configured to open is not there."
 *
 * Phase 3 owns the `terrariaWorld` field; the check belongs here because this
 * is where a start is refused. The stored path is server-relative, so it is
 * resolved under the installation and never followed outside it - a descriptor
 * is not a licence to stat an arbitrary path.
 */
function missingWorld(desc) {
  const world = desc.terrariaWorld;
  const file = world && typeof world.file === 'string' ? world.file.trim() : '';
  if (!file) return null;
  const root = String(desc.dir || desc.cwd || '').trim();
  if (!root) return null;
  const resolved = path.resolve(root, file);
  if (resolved !== path.resolve(root) && !resolved.startsWith(path.resolve(root) + path.sep)) {
    return 'The world configured for this server is outside the server folder.';
  }
  if (fs.existsSync(resolved)) return null;
  return `The world configured for this server is missing: ${world.name || path.basename(file)}`;
}

function createTerrariaModule(deps = {}) {
  const probePortInUse = typeof deps.probePortInUse === 'function' ? deps.probePortInUse : null;
  const downloadToFile = typeof deps.downloadToFile === 'function' ? deps.downloadToFile : null;
  const installerCacheDir = deps.installerCacheDir || null;
  const backupSaveTimeoutMs = Number.isFinite(deps.backupSaveTimeoutMs)
    ? Math.max(0, deps.backupSaveTimeoutMs)
    : BACKUP_SAVE_TIMEOUT_MS;
  // Test seam: the OS-wide .NET install locations discovery consults, replacing
  // the host's real ones (registered + default). Nothing in the product passes
  // it; it lets a test exercise PATH-only discovery on a host that has .NET
  // installed system-wide - a GitHub Actions runner ships /usr/share/dotnet.
  const dotnetRoots = deps.dotnetRoots;

  // The injection shape lib/terraria-install.cjs expects, built once from the
  // panel's own downloader so an update uses the same progress plumbing as an
  // install. `fetchText` is deliberately not injected: the module's own fetch
  // keeps the HTTP status, which is how a GitHub rate limit is told apart from
  // a broken source.
  function installerOptions(progress = () => {}) {
    const options = {};
    if (installerCacheDir) options.cacheDir = installerCacheDir;
    options.download = downloadToFile
      ? (url, dest, onProgress) => downloadToFile(url, dest, onProgress)
      : undefined;
    options.onPhase = (phase) => progress({ phase });
    options.onProgress = (received, total) => progress({ received, total });
    return options;
  }

  return {
    crashEvidence: terrariaCrashes.crashEvidence,
    crashRules: terrariaCrashes.crashRules,
    id: 'terraria',
    variants: VARIANTS,

    // The variant-independent set. Route gating uses capabilitiesFor(desc)
    // instead; this is what /api/modules advertises for the game type as a
    // whole, so it must not promise anything a vanilla server lacks.
    capabilities: [...BASE_CAPABILITIES],

    /*
     * Capabilities for one registered server. A tModLoader server exposes mods
     * and a vanilla one does not, so gating that reads the game type alone is
     * wrong for Terraria.
     */
    capabilitiesFor(desc) {
      return capabilitiesForVariant(safeVariant(desc));
    },

    metadata: {
      automaticInstallHosts: ['win32', 'linux', 'darwin'],
      manualRegistration: true,
      creationAvailable: ['win32', 'linux', 'darwin'].includes(process.platform),
    },

    start(manager) {
      const desc = manager.desc();
      const cwd = String(desc.cwd || desc.dir || '').trim();
      if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return { ok: false, error: `Working directory not found: ${cwd}` };
      }
      // An unrecognized variant stops the launch here: the binaries and save
      // layout differ per variant, so running one as another corrupts a world.
      try { resolveVariant(desc); }
      catch (err) { return { ok: false, error: err.message }; }
      // Phase 1 owns per-variant launch resolution (tModLoader ships .sh/.bat
      // wrappers whose real runtime has to be resolved). Until it lands, the
      // only argv launched is the one registration or the installer already
      // validated - an argv array, never a command string re-parsed at spawn
      // time.
      const executable = String(desc.executable || '').trim();
      if (!executable) return { ok: false, error: 'No Terraria server executable is configured' };
      if (!fs.existsSync(executable)) return { ok: false, error: 'Terraria server executable was not found' };
      const args = Array.isArray(desc.args) ? [...desc.args] : [];
      // A .NET apphost ignores PATH, so a runtime Hostkind could only find
      // there has to be named in the child's environment or the process cannot
      // start. preLaunch refuses the cases this cannot fix.
      const dotnet = dotnetPlan(desc, dotnetRoots);
      return manager._launch(executable, args, dotnet.env ? { env: dotnet.env } : {});
    },

    /*
     * The checks that turn most "it won't start" reports into one sentence
     * (docs/terraria/02-lifecycle-console.md step 7): missing binary, missing
     * or mismatched .NET runtime, missing world, bound port. Each has its own
     * message, because "it did not start" is the useless version of all four.
     *
     * A bound port is the common one, and the captures show why it has to be
     * caught before spawn: a vanilla server whose port is taken prints
     * `Listening on port <n>` and then exits, so the failure looks like a
     * successful start followed by a mystery crash (port-in-use.log).
     */
    async preLaunch(manager) {
      const desc = manager.desc();

      const runtime = missingRuntime(desc);
      if (runtime) return { ok: false, error: runtime };

      const dotnet = dotnetPlan(desc, dotnetRoots);
      if (dotnet.ok === false) return { ok: false, error: dotnet.error };

      const world = missingWorld(desc);
      if (world) return { ok: false, error: world };

      const port = descPort(desc);
      if (!probePortInUse || !port) return { ok: true };
      let inUse = false;
      try { inUse = await probePortInUse(port, PROBE_HOST); }
      catch { return { ok: true }; } // A failed probe must never block a legitimate start.
      if (!inUse) return { ok: true };
      return { ok: false, error: `Port ${port} is already in use. Stop whatever is using it, or change this server's port.` };
    },

    displayLaunchArgs(args) {
      return args.map((arg, index) => (SECRET_FLAGS.has(String(args[index - 1]).toLowerCase()) ? '********' : arg));
    },

    resetState(manager) {
      clearState(ensureState(manager));
    },

    /*
     * Readiness.
     *
     * `Server started` and nothing else. The stub also matched
     * `Listening on port <n>`, which port-in-use.log shows a server prints on
     * its way out the door.
     */
    detectOnline(line, manager) {
      const variant = safeVariant(manager ? manager.desc() : null);
      if (!variant) return false;
      return consoleGrammar.isReady(variant, line);
    },

    onOnline(manager) {
      const st = ensureState(manager);
      st.configRestartRequired = false;
      // A server that reached `Server started` is not waiting on the menu, no
      // matter what it printed on the way there.
      st.awaitingWorldSelection = false;
      st.worldgen = null;
      st.modLoading = null;
      manager._startModulePolling();
      beginRoster(st);
      manager.sendCommand(POLL_COMMAND, true);
    },

    pollCommands(manager) {
      const st = ensureState(manager);
      // A reply that never came does not get to swallow the next one.
      if (rosterExpired(st)) st.roster = null;
      beginRoster(st);
      return [POLL_COMMAND];
    },

    /*
     * Line inspection (docs/terraria/02-lifecycle-console.md step 3).
     *
     * Everything here is bounded: `console.cjs` ignores over-long lines, caps
     * names, and caps the roster. Console retention is `lib/consoleHistory.cjs`;
     * this keeps no second buffer of lines.
     */
    inspectLine(line, manager) {
      const variant = safeVariant(manager.desc());
      if (!variant) return;
      const st = ensureState(manager);

      // The interactive-menu trap. The server has printed a numbered world
      // prompt and is blocked on stdin; without saying so, the watchdog
      // eventually kills a server that was only asking a question.
      if (consoleGrammar.isWorldSelectionPrompt(variant, line)) {
        if (!st.awaitingWorldSelection) {
          st.awaitingWorldSelection = true;
          manager.pushLine('[Hostkind] This server is waiting for a world to be selected on its console and will not finish starting until one is. Hostkind will not answer the prompt for you: the menu is numbered by the world list, so a blind answer can load the wrong world. Choose a world from the worlds view.', 'warn');
          manager.broadcast({ type: 'status', status: manager.statusPayload() });
        }
        return;
      }

      const event = consoleGrammar.inspect(variant, line);

      // TShock prints its roster as a header line and then one line of
      // comma-separated names, so the names line is claimed by position - a
      // pattern for "a line of names" would match ordinary chat. A line that
      // is some other known event is not the names line: something arrived in
      // between, and the roster read is abandoned rather than filled with it.
      if (st.roster && st.roster.tshockNamesNext) {
        st.roster.tshockNamesNext = false;
        if (!event) {
          reconcile(manager, st, consoleGrammar.parseTshockRoster(line));
          st.roster = null;
          return;
        }
        st.roster = null;
      }

      if (!event) return;

      switch (event.kind) {
        case 'version':
          // tModLoader prints its combined banner while loading mods and the
          // plain Terraria one once the world is up, so a later line without a
          // loader must not erase the loader an earlier line reported.
          st.version = {
            game: event.game || (st.version && st.version.game) || null,
            loader: event.loader || (st.version && st.version.loader) || null,
          };
          manager.broadcast({ type: 'status', status: manager.statusPayload() });
          break;

        case 'variantVersion':
          st.variantVersion = event.version;
          manager.broadcast({ type: 'status', status: manager.statusPayload() });
          break;

        case 'modLoading':
          // A mod-loading line means the start is progressing, never that it
          // finished: readiness is `Server started` and nothing else.
          st.modLoading = event.mod || event.phase || null;
          manager.broadcast({ type: 'status', status: manager.statusPayload() });
          break;

        case 'worldgenStart':
          st.worldgen = { percent: 0, stage: null, stagePercent: 0 };
          break;

        case 'worldgen':
          // Generation answers the menu prompt: the server is busy, not stuck.
          st.awaitingWorldSelection = false;
          st.worldgen = { percent: event.percent, stage: event.stage, stagePercent: event.stagePercent };
          break;

        case 'join':
          addPlayer(manager, st, event.name);
          break;

        case 'leave':
          removePlayer(manager, st, event.name);
          break;

        case 'rosterEmpty':
          reconcile(manager, st, []);
          st.roster = null;
          break;

        case 'rosterHeader':
          if (Number.isFinite(event.max) && event.max > 0) st.maxPlayers = event.max;
          if (st.roster) st.roster.tshockNamesNext = true;
          break;

        case 'rosterEntry':
          // Only inside a reply we asked for. Outside one, a chat line of the
          // same shape would silently become a player.
          if (st.roster) st.roster.names.push(event.name);
          break;

        case 'rosterEnd':
          if (st.roster) {
            reconcile(manager, st, st.roster.names);
            st.roster = null;
          }
          break;

        case 'playerLimit':
          st.maxPlayers = event.limit;
          manager.broadcast({ type: 'status', status: manager.statusPayload() });
          break;

        case 'saved':
          // Phase 5's backupPrepare waits on this line.
          st.lastSavedAt = Date.now();
          break;

        case 'shutdown':
          st.shutdownConfirmed = true;
          break;

        case 'worldLoadFailed':
          manager.pushLine('[Hostkind] The server could not open its world file. Check the world configured for this server.', 'error');
          break;

        default:
          break;
      }
    },

    listPlayers(manager) {
      const st = ensureState(manager);
      // Terraria has no persistent player id on the console - a name is the
      // only identity the server ever prints - so the name is the id, and the
      // shape still matches the `{ id, name }` contract /api/players uses.
      // No addresses: the `playing` reply carries them and they are dropped.
      return [...st.players].sort().map((name) => ({
        id: name,
        name,
        since: st.playerSince.get(name) || null,
      }));
    },

    playerAction(manager, action, target) {
      return runPlayerAction(manager, action, target);
    },

    onExit(manager) {
      const st = ensureState(manager);
      // A stop that never printed its shutdown line is an unclean stop. The
      // process exit is authoritative either way; the line is the confirmation
      // (docs/terraria/02-lifecycle-console.md step 6), and phase 8 reads this
      // to conclude "unclean shutdown" rather than "crash".
      const clean = st.shutdownConfirmed;
      st.lastStop = { clean, at: Date.now() };
      if (!clean && manager.manualStop) {
        manager.pushLine('[Hostkind] The server exited without confirming that it saved and shut down cleanly.', 'warn');
      }
      clearState(st);
    },

    buildStopSequence(manager) {
      const variant = safeVariant(manager ? manager.desc() : null);
      // No variant means no known console dialect, so fall back to the signal
      // rather than typing a command at a server we cannot identify.
      if (!variant) return { signal: 'SIGTERM' };
      return { command: variantInfo(variant).stop.command };
    },

    /*
     * Merged into the generic status payload. No absolute paths, no secrets:
     * this reaches every WebSocket client and GET /api/status.
     */
    statusFields(manager) {
      const desc = manager.desc();
      const variant = safeVariant(desc);
      if (!variant) {
        return { terrariaVariant: null, degraded: true, moduleError: 'unknown_terraria_variant' };
      }
      const st = ensureState(manager);
      const stored = desc.terrariaVersion || null;
      // The install recorded a version; the running server printed one. They
      // are the same fact from two sources, and the console wins because it is
      // what is actually running - but only for the halves it reported.
      const version = {
        game: (st.version && st.version.game) || (stored && stored.game) || null,
        variant: st.variantVersion || (st.version && st.version.loader) || (stored && stored.variant) || null,
        source: st.version ? 'console' : (stored && stored.source) || null,
        resolvedAt: (stored && stored.resolvedAt) || null,
      };
      return {
        terrariaVariant: variant,
        terrariaVersion: version.game || version.variant ? version : null,
        // Phase 3 resolves the world; the descriptor only ever stores the
        // server-relative path, so the name is what is safe to surface.
        terrariaWorld: desc.terrariaWorld && desc.terrariaWorld.name ? { name: desc.terrariaWorld.name } : null,
        // The console is blocked on a numbered world prompt. The frontend
        // turns this into a call to action instead of a server that looks hung.
        awaitingWorldSelection: !!st.awaitingWorldSelection,
        // A long start is legible rather than looking stuck.
        terrariaModLoading: st.modLoading || null,
        terrariaWorldgen: st.worldgen || null,
        terrariaLastStop: st.lastStop || null,
        // Same shape the Minecraft module publishes, so the players view and
        // the dashboard counters work without a Terraria special case.
        players: [...st.players].sort(),
        playerCount: st.players.size,
        maxPlayers: st.maxPlayers || 0,
        configRestartRequired: !!st.configRestartRequired,
        tshockHealth: variant === 'tshock'
          ? (st.tshockHealth || { state: 'unavailable', code: 'not_polled', lastOkAt: null, lastErrorAt: null })
          : undefined,
      };
    },

    configSchema(desc) {
      return terrariaConfig.configSchema(desc);
    },

    backupSelection(desc, options = {}) {
      const root = String(desc.dir || desc.cwd || '');
      const saveDir = String(desc.terrariaSaveDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!root || !saveDir) return [];
      const variant = safeVariant(desc);
      const selected = [
        ...relativeFiles(root, saveDir),
        ...relativeFiles(root, 'serverconfig.txt'),
      ];
      if (variant === 'tshock') {
        selected.push(...relativeFiles(root, 'tshock', (rel) => {
          const lower = rel.toLowerCase();
          return !lower.startsWith('tshock/logs/')
            && !/(?:-wal|-journal|-shm)$/i.test(rel);
        }));
      }
      if (variant === 'tmodloader') {
        selected.push(...relativeFiles(root, 'Mods', (rel) => {
          const name = path.posix.basename(rel).toLowerCase();
          if (name === 'enabled.json') return true;
          if (/(?:modpack|pack).*\.json$/i.test(name)) return true;
          return options.includeMods === true && name.endsWith('.tmod');
        }));
      }
      return [...new Set(selected)].sort();
    },

    async backupPrepare(manager) {
      if (!manager || manager.status !== 'online') return null;
      const st = ensureState(manager);
      const before = Number(st.lastSavedAt) || 0;
      const sent = manager.sendCommand(variantInfo(safeVariant(manager.desc())).saveCommand, true);
      if (!sent || sent.ok === false) return { saved: false, reason: 'save_command_failed' };
      const deadline = Date.now() + backupSaveTimeoutMs;
      while (Date.now() <= deadline) {
        if ((Number(st.lastSavedAt) || 0) > before) {
          return { saved: true, confirmedAt: st.lastSavedAt };
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
      }
      return { saved: false, reason: 'save_not_confirmed' };
    },

    backupCleanup(_manager, state, outcome = {}) {
      return { ...(state || {}), outcome: outcome.ok === false ? 'failed' : 'completed' };
    },

    backupRestartPolicy() {
      return false;
    },

    /*
     * Update lifecycle (docs/terraria/01-installation-versions.md step 5).
     *
     * The module is the seam; lib/terraria-install.cjs does the work, so the
     * version resolution, archive guard, snapshot, and transaction are the
     * same code an install runs.
     */
    discoverUpdate(desc) {
      return terrariaInstall.discoverUpdate(desc, {});
    },

    async applyUpdate(manager, plan = {}, progress = () => {}) {
      const desc = manager.desc();
      const result = await terrariaInstall.applyUpdate({
        desc,
        serverId: desc.id,
        dir: String(desc.dir || desc.cwd || ''),
        versionId: plan.versionId || null,
        actorId: plan.actorId || null,
        idempotencyKey: plan.idempotencyKey || null,
        // Read here rather than trusted from the plan: a plan built a minute
        // ago says nothing about whether the server is running right now.
        offline: manager.status === 'offline',
      }, installerOptions(progress));
      return result;
    },

    rollbackUpdate(manager, plan = {}, cause = null) {
      const desc = manager.desc();
      return terrariaInstall.rollbackUpdate({
        dir: String(desc.dir || desc.cwd || ''),
        snapshotId: plan.snapshotId || null,
        operationId: plan.operationId || null,
        cause,
      });
    },
  };
}

module.exports = createTerrariaModule;
