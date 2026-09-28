'use strict';

/*
 * The game rules a new server can be created with, beyond what every game
 * shares (name, port, players, password). POST /api/create runs these before
 * its NDJSON stream opens, so a bad value is a plain 400 and nothing is
 * downloaded. src/lib/serverPresets.js mirrors the option lists for the
 * wizards; test/server-presets.test.cjs keeps the two in step.
 *
 * Every field is optional: an omitted one is the game's own default, which is
 * what a scripted POST from before these existed gets.
 */

const { WORLD_PRESETS: VALHEIM_PRESETS } = require('./modules/valheim/launch.cjs');

class RuleError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.code = 'invalid_game_rules';
  }
}

function pick(value, options, label, fallback) {
  if (value == null || value === '') return fallback;
  const text = String(value).toLowerCase();
  if (!options.includes(text)) throw new RuleError(`Unknown ${label}: ${value}`);
  return text;
}

function flag(value, fallback) {
  if (value == null || value === '') return fallback;
  return value === true || value === 'true' || value === 1 || value === '1';
}

function line(value, max, label) {
  const text = String(value == null ? '' : value).trim();
  if (/[\r\n\0]/.test(text)) throw new RuleError(`${label} must be a single line`);
  if (text.length > max) throw new RuleError(`${label} is limited to ${max} characters`);
  return text;
}

function number(value, min, max, label, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new RuleError(`${label} must be between ${min} and ${max}`);
  return n;
}

// --- Minecraft: written to server.properties before the first start --------

const MINECRAFT_GAMEMODES = Object.freeze(['survival', 'creative', 'adventure', 'spectator']);
const MINECRAFT_DIFFICULTIES = Object.freeze(['peaceful', 'easy', 'normal', 'hard']);
// The pre-1.19 names: every version since reads them too ("default" and
// "largebiomes" through a legacy map, the rest as minecraft:<name>).
const MINECRAFT_LEVEL_TYPES = Object.freeze(['default', 'flat', 'largebiomes', 'amplified']);
const MINECRAFT_MAX_PLAYERS = 500;

function minecraftRules(body = {}) {
  const hardcore = flag(body.hardcore, false);
  return {
    // Hardcore is survival on hard whatever else was picked; the server
    // forces that too, this just keeps the file honest.
    gamemode: hardcore ? 'survival' : pick(body.gamemode, MINECRAFT_GAMEMODES, 'game mode', 'survival'),
    difficulty: hardcore ? 'hard' : pick(body.difficulty, MINECRAFT_DIFFICULTIES, 'difficulty', 'easy'),
    hardcore,
    pvp: flag(body.pvp, true),
    maxPlayers: Math.round(number(body.maxPlayers, 1, MINECRAFT_MAX_PLAYERS, 'Max players', 20)),
    motd: line(body.motd, 150, 'The message of the day'),
    seed: line(body.seed, 64, 'The world seed'),
    levelType: pick(body.levelType, MINECRAFT_LEVEL_TYPES, 'world type', 'default'),
  };
}

// Java properties escaping, with everything outside ASCII as \uXXXX so the
// file reads the same on servers that load it as Latin-1 and as UTF-8.
function propertyValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/^ /, '\\ ')
    .replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * A starting server.properties. Only the keys chosen here: the server fills
 * in the rest on its first start and keeps these. Game mode and difficulty
 * go in as numbers, the one spelling every server version accepts.
 */
function renderServerProperties(rules) {
  const values = {
    gamemode: MINECRAFT_GAMEMODES.indexOf(rules.gamemode),
    difficulty: MINECRAFT_DIFFICULTIES.indexOf(rules.difficulty),
    hardcore: rules.hardcore,
    pvp: rules.pvp,
    'max-players': rules.maxPlayers,
    motd: rules.motd || 'A Minecraft Server',
    'level-seed': rules.seed,
    'level-type': rules.levelType,
  };
  const lines = Object.entries(values).map(([key, value]) => `${key}=${propertyValue(value)}`);
  return `#Minecraft server properties\n#Written by Hostkind when the server was created\n${lines.join('\n')}\n`;
}

// --- Valheim: -preset, -modifier and -setkey launch options ----------------

// The dedicated server's world modifiers. Each one's normal setting is no
// flag at all, so it is not listed.
const VALHEIM_MODIFIERS = Object.freeze({
  combat: Object.freeze(['veryeasy', 'easy', 'hard', 'veryhard']),
  deathpenalty: Object.freeze(['casual', 'veryeasy', 'easy', 'hard', 'hardcore']),
  resources: Object.freeze(['muchless', 'less', 'more', 'muchmore', 'most']),
  raids: Object.freeze(['none', 'muchless', 'less', 'more', 'muchmore']),
  portals: Object.freeze(['casual', 'hard', 'veryhard']),
});
const VALHEIM_KEYS = Object.freeze(['nobuildcost', 'playerevents', 'passivemobs', 'nomap']);

function valheimRules(body = {}) {
  const preset = pick(body.valheimPreset, VALHEIM_PRESETS, 'Valheim world preset', 'normal');
  const modifiers = {};
  const given = body.valheimModifiers && typeof body.valheimModifiers === 'object' ? body.valheimModifiers : {};
  for (const [name, options] of Object.entries(VALHEIM_MODIFIERS)) {
    const value = pick(given[name], options, `Valheim ${name} setting`, null);
    if (value) modifiers[name] = value;
  }
  const keys = [...new Set((Array.isArray(body.valheimKeys) ? body.valheimKeys : []).map((key) => pick(key, VALHEIM_KEYS, 'Valheim world option', null)).filter(Boolean))];
  return { preset, modifiers, keys, crossplay: flag(body.crossplay, false) };
}

/** The launch options for a world: the preset first, modifiers override it. */
function valheimWorldArgs(rules) {
  return [
    ...(rules.preset === 'normal' ? [] : ['-preset', rules.preset]),
    ...Object.entries(rules.modifiers).flatMap(([name, value]) => ['-modifier', name, value]),
    ...rules.keys.flatMap((key) => ['-setkey', key]),
  ];
}

// --- Palworld: PalWorldSettings.ini keys -----------------------------------

const PALWORLD_DEATH_PENALTIES = Object.freeze(['None', 'Item', 'ItemAndEquipment', 'All']);

function palworldRules(body = {}) {
  const penalty = body.deathPenalty == null || body.deathPenalty === ''
    ? 'All'
    : PALWORLD_DEATH_PENALTIES.find((option) => option.toLowerCase() === String(body.deathPenalty).toLowerCase());
  if (!penalty) throw new RuleError(`Unknown death penalty: ${body.deathPenalty}`);
  return {
    deathPenalty: penalty,
    expRate: number(body.expRate, 0.1, 20, 'Experience rate', 1),
    captureRate: number(body.captureRate, 0.1, 20, 'Capture rate', 1),
    pvp: flag(body.pvp, false),
    hardcore: flag(body.hardcore, false),
  };
}

/** The ini values for these rules, as writeConfiguration merges them. */
function palworldSettings(rules) {
  const bool = (value) => (value ? 'True' : 'False');
  return {
    DeathPenalty: rules.deathPenalty,
    ExpRate: rules.expRate.toFixed(6),
    PalCaptureRate: rules.captureRate.toFixed(6),
    bEnablePlayerToPlayerDamage: bool(rules.pvp),
    bEnableFriendlyFire: bool(rules.pvp),
    bHardcore: bool(rules.hardcore),
  };
}

module.exports = {
  RuleError,
  MINECRAFT_GAMEMODES, MINECRAFT_DIFFICULTIES, MINECRAFT_LEVEL_TYPES, MINECRAFT_MAX_PLAYERS,
  minecraftRules, renderServerProperties,
  VALHEIM_MODIFIERS, VALHEIM_KEYS, valheimRules, valheimWorldArgs,
  PALWORLD_DEATH_PENALTIES, palworldRules, palworldSettings,
};
