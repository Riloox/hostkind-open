// Ready-made starting points for a new server, one set per game. A preset is
// only the wizard's form values: picking one fills the form, and every field
// stays editable afterwards. Titles and hints are i18n keys under
// `serverPresets.<game>.<id>`. The first preset of a game is what its wizard
// opens with.
//
// Values must stay inside what POST /api/create accepts
// (lib/routes/create.cjs); test/server-presets.test.cjs holds them to it.

// Each preset sets the same keys as its siblings, so switching between two
// of them never leaves one's setting behind.
const MINECRAFT_RULES = { gamemode: 'survival', difficulty: 'normal', hardcore: false };
const PALWORLD_RULES = { deathPenalty: 'Item', expRate: 1, captureRate: 1, pvp: false, hardcore: false };

export const SERVER_PRESETS = {
  minecraft: [
    // Paper plays exactly like vanilla, runs faster and takes plugins, which
    // is why it is the default rather than Mojang's own jar.
    { id: 'survival', values: { type: 'paper', javaArgs: '-Xmx4G -Xms4G', ...MINECRAFT_RULES } },
    { id: 'creative', values: { type: 'paper', javaArgs: '-Xmx4G -Xms4G', ...MINECRAFT_RULES, gamemode: 'creative', difficulty: 'peaceful' } },
    { id: 'hardcore', values: { type: 'paper', javaArgs: '-Xmx4G -Xms4G', ...MINECRAFT_RULES, difficulty: 'hard', hardcore: true } },
    { id: 'vanilla', values: { type: 'vanilla', javaArgs: '-Xmx4G -Xms4G', ...MINECRAFT_RULES } },
    // Mod loaders get more memory: a modded server outgrows 4 GB quickly.
    { id: 'fabric', values: { type: 'fabric', javaArgs: '-Xmx6G -Xms6G', ...MINECRAFT_RULES } },
    { id: 'neoforge', values: { type: 'neoforge', javaArgs: '-Xmx6G -Xms6G', ...MINECRAFT_RULES } },
  ],
  terraria: [
    { id: 'classic', values: { terrariaVariant: 'vanilla', worldSize: '2', difficulty: '0', maxPlayers: 8 } },
    { id: 'expert', values: { terrariaVariant: 'vanilla', worldSize: '3', difficulty: '1', maxPlayers: 8 } },
    { id: 'master', values: { terrariaVariant: 'vanilla', worldSize: '3', difficulty: '2', maxPlayers: 8 } },
    { id: 'journey', values: { terrariaVariant: 'vanilla', worldSize: '2', difficulty: '3', maxPlayers: 8 } },
    { id: 'community', values: { terrariaVariant: 'tshock', worldSize: '3', difficulty: '0', maxPlayers: 32 } },
    { id: 'modded', values: { terrariaVariant: 'tmodloader', worldSize: '2', difficulty: '0', maxPlayers: 8 } },
  ],
  valheim: [
    { id: 'friends', values: { public: false, valheimPreset: 'normal' } },
    { id: 'relaxed', values: { public: false, valheimPreset: 'casual' } },
    { id: 'challenge', values: { public: false, valheimPreset: 'hard' } },
    { id: 'hardcore', values: { public: false, valheimPreset: 'hardcore' } },
    { id: 'builder', values: { public: false, valheimPreset: 'hammer' } },
    { id: 'public', values: { public: true, valheimPreset: 'normal' } },
  ],
  palworld: [
    { id: 'friends', values: { maxPlayers: 8, ...PALWORLD_RULES } },
    { id: 'relaxed', values: { maxPlayers: 8, ...PALWORLD_RULES, deathPenalty: 'None', expRate: 2, captureRate: 2 } },
    { id: 'hardcore', values: { maxPlayers: 8, ...PALWORLD_RULES, deathPenalty: 'All', hardcore: true } },
    { id: 'pvp', values: { maxPlayers: 16, ...PALWORLD_RULES, deathPenalty: 'ItemAndEquipment', pvp: true } },
    { id: 'community', values: { maxPlayers: 32, ...PALWORLD_RULES } },
  ],
};

// Valheim's world-modifier presets, as the dedicated server's `-preset` takes
// them.
export const VALHEIM_WORLD_PRESETS = ['casual', 'easy', 'normal', 'hard', 'hardcore', 'immersive', 'hammer'];

// The rest of what a wizard can set, mirroring lib/create-rules.cjs.
export const MINECRAFT_GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'];
export const MINECRAFT_DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard'];
export const MINECRAFT_LEVEL_TYPES = ['default', 'flat', 'largebiomes', 'amplified'];
// Each modifier's normal setting is no flag, so it is the empty choice.
export const VALHEIM_MODIFIERS = {
  combat: ['veryeasy', 'easy', 'hard', 'veryhard'],
  deathpenalty: ['casual', 'veryeasy', 'easy', 'hard', 'hardcore'],
  resources: ['muchless', 'less', 'more', 'muchmore', 'most'],
  raids: ['none', 'muchless', 'less', 'more', 'muchmore'],
  portals: ['casual', 'hard', 'veryhard'],
};
export const VALHEIM_KEYS = ['nobuildcost', 'playerevents', 'passivemobs', 'nomap'];
export const PALWORLD_DEATH_PENALTIES = ['None', 'Item', 'ItemAndEquipment', 'All'];

export function presetsFor(game) {
  return SERVER_PRESETS[game] || [];
}

/** The preset the form still matches, so an edited field un-highlights it. */
export function matchingPreset(game, form) {
  return presetsFor(game).find((preset) => (
    Object.entries(preset.values).every(([key, value]) => String(form[key]) === String(value))
  )) || null;
}

// A join password friends can read out loud: no look-alike characters.
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function friendlyPassword(length = 10) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]).join('');
}
