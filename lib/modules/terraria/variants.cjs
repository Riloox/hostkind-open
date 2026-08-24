'use strict';

/*
 * Per-variant facts for the Terraria module (docs/terraria/00-baseline-contracts.md
 * "Define the variant model").
 *
 * One game type, three variants. Vanilla, TShock, and tModLoader are not new
 * game IDs: they are a `terrariaVariant` field on the descriptor, because the
 * catalogue is a fixed five-entry set. What differs between them - binaries,
 * readiness lines, config files, log locations, world layout - is declared here
 * as data so the module never branches on remembered trivia.
 *
 * `terrariaVariant` is immutable after registration. Changing a variant is
 * "register a new server", not "edit a field": the binaries, save layout, and
 * config files all differ, and silently reinterpreting an existing folder is
 * exactly the class of guess this roadmap forbids.
 *
 * Fields that need a captured fixture to be honest are `null` until the phase
 * that captures the fixture ships. `null` means "no evidence yet" and the
 * module declines the capability; it never means "use the vanilla value and
 * hope".
 */

const VARIANTS = Object.freeze(['vanilla', 'tshock', 'tmodloader']);

/*
 * Readiness moved out.
 *
 * Phase 0 carried the stub's `/Listening on port|Server started/i` here as the
 * shipped baseline, with the variant half left `null` until fixtures existed.
 * Phase 2 captured them, and the captures showed the listening line is not
 * readiness at all: a server whose port is already bound prints it and then
 * exits (test/fixtures/terraria/port-in-use.log). Readiness now lives in
 * console.cjs next to the rest of the fixture-derived grammar, so there is one
 * place a pattern can be, and it is the place that names its fixture.
 */

/*
 * Where a variant keeps its worlds. Terraria's authoritative answer is the
 * `worldpath` setting (or the `-worldpath` launch flag), not an OS convention:
 * a server folder Hostkind installed and a folder an operator brings from
 * their own machine resolve differently. Phase 3 reads it; there is deliberately
 * no Hostkind-side default directory to fall back to.
 */
const WORLD_PATH_SOURCE = Object.freeze({
  configKey: 'worldpath',
  launchFlag: '-worldpath',
  defaultRelative: null,
});

const ENTRIES = Object.freeze({
  vanilla: Object.freeze({
    id: 'vanilla',
    label: 'Vanilla',
    // Matches lib/dedicatedServerInstaller.cjs `locateExecutable`, which is the
    // code that actually unpacks the official archive.
    executableNames: Object.freeze({
      win32: Object.freeze(['TerrariaServer.exe']),
      linux: Object.freeze(['TerrariaServer.bin.x86_64']),
      darwin: Object.freeze(['Terraria Server']),
    }),
    stop: Object.freeze({ command: 'exit' }),
    saveCommand: 'save',
    configFiles: Object.freeze(['serverconfig.txt']),
    evidence: Object.freeze(['ServerLog.txt']),
    worldExtensions: Object.freeze(['.wld']),
    worldPath: WORLD_PATH_SOURCE,
    modsDir: null,
  }),
  tshock: Object.freeze({
    id: 'tshock',
    label: 'TShock',
    executableNames: Object.freeze({
      win32: Object.freeze(['TShock.Server.exe']),
      linux: Object.freeze(['TShock.Server']),
      darwin: Object.freeze(['TShock.Server']),
    }),
    // TShock also accepts `/off` through its own command layer; `exit` on stdin
    // is the sequence phase 2 pins against a fixture.
    stop: Object.freeze({ command: 'exit' }),
    saveCommand: 'save',
    configFiles: Object.freeze(['serverconfig.txt', 'tshock/config.json']),
    evidence: Object.freeze(['tshock/logs']),
    worldExtensions: Object.freeze(['.wld']),
    worldPath: WORLD_PATH_SOURCE,
    modsDir: null,
  }),
  tmodloader: Object.freeze({
    id: 'tmodloader',
    label: 'tModLoader',
    // tModLoader ships .sh/.bat launcher wrappers that Hostkind must never
    // execute. Phase 1 resolves the real runtime and argv from the install.
    executableNames: null,
    stop: Object.freeze({ command: 'exit' }),
    saveCommand: 'save',
    configFiles: Object.freeze(['serverconfig.txt']),
    evidence: Object.freeze(['Logs/server.log', 'Logs/Launch.txt']),
    // A tModLoader world is a .wld plus its sibling .twld; moving one without
    // the other loses the modded half of the save.
    worldExtensions: Object.freeze(['.wld', '.twld']),
    worldPath: WORLD_PATH_SOURCE,
    modsDir: 'Mods',
  }),
});

// Capabilities every Terraria server has, regardless of variant.
//
// Capabilities named in the phase-0 contract that are deliberately withheld,
// because a declared capability that resolves to a Minecraft-shaped route is
// worse than a 404:
//   - `worlds` stays withheld for good. Phase 3 shipped Terraria worlds as their
//     own surface (`terraria-worlds` -> /api/terraria/worlds, a world is a single
//     file there), so /api/worlds - lib/routes/worlds.cjs, which reads level.dat
//     and treats a world as a directory - must keep answering 404 for Terraria.
//     The frontend routes its worlds view on either capability.
//   - `addons` / `content-install` -> phase 6. /api/addons defaults to a
//     <dir>/mods folder with a .jar-only upload filter, and /api/modrinth is
//     Minecraft-only. tModLoader declares `terraria-mods` instead.
const BASE_CAPABILITIES = Object.freeze([
  'console',
  'files',
  'backups',
  'schedules',
  'metrics',
  'watchdog',
  'updates',
  'players',
  'configs',
  'terraria-worlds',
  'terraria-config',
]);

const VARIANT_CAPABILITIES = Object.freeze({
  vanilla: Object.freeze([]),
  tshock: Object.freeze(['terraria-tshock']),
  tmodloader: Object.freeze(['terraria-mods']),
});

function isVariant(value) {
  return VARIANTS.includes(value);
}

/*
 * The variant of a descriptor.
 *
 * A missing value means the descriptor predates variants, and the only Terraria
 * server Hostkind could register back then was vanilla - so that is a
 * migration, not a guess. A present but unrecognized value is an error: it must
 * never quietly acquire vanilla's binaries and save layout.
 */
function resolveVariant(desc) {
  const value = desc == null ? '' : String(desc.terrariaVariant == null ? '' : desc.terrariaVariant).trim();
  if (!value) return 'vanilla';
  if (!isVariant(value)) throw new Error(`Unknown Terraria variant: ${value}`);
  return value;
}

function variantInfo(variant) {
  if (!isVariant(variant)) throw new Error(`Unknown Terraria variant: ${variant}`);
  return ENTRIES[variant];
}

function capabilitiesForVariant(variant) {
  if (!isVariant(variant)) return [...BASE_CAPABILITIES];
  return [...BASE_CAPABILITIES, ...VARIANT_CAPABILITIES[variant]];
}

// Executable candidates for the host platform, or null when the variant needs a
// resolver rather than a name lookup (tModLoader, phase 1).
function executableCandidates(variant, platform = process.platform) {
  const names = variantInfo(variant).executableNames;
  if (!names) return null;
  return [...(names[platform] || [])];
}

module.exports = {
  VARIANTS,
  BASE_CAPABILITIES,
  VARIANT_CAPABILITIES,
  isVariant,
  resolveVariant,
  variantInfo,
  capabilitiesForVariant,
  executableCandidates,
};
