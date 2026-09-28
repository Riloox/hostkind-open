'use strict';

/*
 * src/lib/serverPresets.js: the ready-made starting points each install
 * wizard offers, held to what POST /api/create accepts. And
 * lib/server-destination.cjs: where a server goes when no folder is picked,
 * which is what lets a preset install with only a name.
 *
 * serverPresets.js is browser ESM in a CommonJS package, so it is copied to a
 * temporary .mjs and imported from there.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const i18n = require('../i18n.json');
const terrariaVariants = require('../lib/modules/terraria/variants.cjs');
const valheimLaunch = require('../lib/modules/valheim/launch.cjs');
const { resolveDestination } = require('../lib/server-destination.cjs');
const rules = require('../lib/create-rules.cjs');

async function loadPresets() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'serverPresets.js'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-presets-'));
  const file = path.join(dir, 'serverPresets.mjs');
  fs.writeFileSync(file, source);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const lookup = (dict, key) => key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), dict);
const MINECRAFT_TYPES = ['vanilla', 'spigot', 'paper', 'fabric', 'forge', 'neoforge'];
const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

(async () => {
  const presets = await loadPresets();
  const { SERVER_PRESETS, VALHEIM_WORLD_PRESETS, matchingPreset, friendlyPassword } = presets;

  // The wizards offer exactly what the create route accepts.
  assert.deepEqual(presets.MINECRAFT_GAMEMODES, [...rules.MINECRAFT_GAMEMODES]);
  assert.deepEqual(presets.MINECRAFT_DIFFICULTIES, [...rules.MINECRAFT_DIFFICULTIES]);
  assert.deepEqual(presets.MINECRAFT_LEVEL_TYPES, [...rules.MINECRAFT_LEVEL_TYPES]);
  assert.deepEqual(presets.VALHEIM_MODIFIERS, JSON.parse(JSON.stringify(rules.VALHEIM_MODIFIERS)));
  assert.deepEqual(presets.VALHEIM_KEYS, [...rules.VALHEIM_KEYS]);
  assert.deepEqual(presets.PALWORLD_DEATH_PENALTIES, [...rules.PALWORLD_DEATH_PENALTIES]);

  // Every installable game has presets, with unique ids and both languages.
  for (const game of ['minecraft', 'terraria', 'valheim', 'palworld']) {
    const list = SERVER_PRESETS[game];
    assert.ok(list && list.length >= 2, `${game} has presets`);
    assert.equal(new Set(list.map((p) => p.id)).size, list.length, `${game} preset ids are unique`);
    for (const preset of list) {
      for (const lang of i18n.SUPPORTED_LANGS) {
        for (const part of ['title', 'hint']) {
          const key = `serverPresets.${game}.${preset.id}.${part}`;
          assert.equal(typeof lookup(i18n.dictionaries[lang], key), 'string', `${lang} has ${key}`);
        }
      }
    }
  }

  // Values the create route accepts.
  for (const { values } of SERVER_PRESETS.minecraft) {
    assert.ok(MINECRAFT_TYPES.includes(values.type), `minecraft type ${values.type}`);
    assert.match(values.javaArgs, /^-Xmx\d+G -Xms\d+G$/);
    const parsed = rules.minecraftRules(values);
    if (!values.hardcore) assert.equal(parsed.gamemode, values.gamemode);
  }
  assert.ok(SERVER_PRESETS.terraria.some((p) => p.values.difficulty === '2'), 'terraria offers Master');
  for (const { values } of SERVER_PRESETS.terraria) {
    assert.ok(terrariaVariants.isVariant(values.terrariaVariant), `terraria variant ${values.terrariaVariant}`);
    assert.ok([1, 2, 3].includes(Number(values.worldSize)));
    assert.ok([0, 1, 2, 3].includes(Number(values.difficulty)));
    assert.ok(values.maxPlayers >= 1 && values.maxPlayers <= 255);
  }
  for (const { values } of SERVER_PRESETS.valheim) {
    assert.ok(valheimLaunch.WORLD_PRESETS.includes(values.valheimPreset), `valheim preset ${values.valheimPreset}`);
    assert.equal(typeof values.public, 'boolean');
  }
  for (const { values } of SERVER_PRESETS.palworld) {
    assert.ok(values.maxPlayers >= 1 && values.maxPlayers <= 32);
    assert.equal(rules.palworldRules(values).deathPenalty, values.deathPenalty);
  }
  // Every option label exists in both languages.
  const ruleKeys = [
    ...rules.MINECRAFT_GAMEMODES.map((k) => `minecraftGamemode.${k}`),
    ...rules.MINECRAFT_DIFFICULTIES.map((k) => `minecraftDifficulty.${k}`),
    ...rules.MINECRAFT_LEVEL_TYPES.map((k) => `minecraftLevelType.${k}`),
    ...Object.keys(rules.VALHEIM_MODIFIERS).map((k) => `valheimModifier.${k}`),
    ...Object.values(rules.VALHEIM_MODIFIERS).flat().map((k) => `valheimLevel.${k}`),
    ...rules.VALHEIM_KEYS.map((k) => `valheimKey.${k}`),
    ...rules.PALWORLD_DEATH_PENALTIES.map((k) => `palworldDeathPenalty.${k}`),
  ];
  for (const lang of i18n.SUPPORTED_LANGS) {
    for (const key of ruleKeys) assert.equal(typeof lookup(i18n.dictionaries[lang], `serverRules.${key}`), 'string', `${lang} has serverRules.${key}`);
  }

  // Minecraft rules: defaults, hardcore overrides, and a server.properties
  // every version reads (numbers for mode and difficulty, ASCII only).
  assert.deepEqual(rules.minecraftRules({}), { gamemode: 'survival', difficulty: 'easy', hardcore: false, pvp: true, maxPlayers: 20, motd: '', seed: '', levelType: 'default' });
  const hc = rules.minecraftRules({ gamemode: 'creative', difficulty: 'peaceful', hardcore: true, pvp: false, maxPlayers: '4', motd: 'Hola ñ \\ mundo', seed: '-42', levelType: 'amplified' });
  assert.equal(hc.gamemode, 'survival');
  assert.equal(hc.difficulty, 'hard');
  const props = rules.renderServerProperties(hc);
  assert.match(props, /^gamemode=0$/m);
  assert.match(props, /^difficulty=3$/m);
  assert.match(props, /^hardcore=true$/m);
  assert.match(props, /^pvp=false$/m);
  assert.match(props, /^max-players=4$/m);
  assert.match(props, /^level-seed=-42$/m);
  assert.match(props, /^level-type=amplified$/m);
  assert.ok(props.includes('motd=Hola \\u00f1 \\\\ mundo'), props);
  assert.doesNotMatch(props, /[^\n\x20-\x7e]/);
  assert.throws(() => rules.minecraftRules({ gamemode: 'god' }), /game mode/);
  assert.throws(() => rules.minecraftRules({ motd: 'a\nb' }), /single line/);
  assert.throws(() => rules.minecraftRules({ maxPlayers: 0 }), /Max players/);

  // Valheim: preset first, modifiers override it, keys last; the normal
  // choices add nothing.
  assert.deepEqual(rules.valheimWorldArgs(rules.valheimRules({})), []);
  const vh = rules.valheimRules({ valheimPreset: 'hard', valheimModifiers: { combat: 'veryhard', raids: '' }, valheimKeys: ['nomap', 'nomap'], crossplay: true });
  assert.equal(vh.crossplay, true);
  assert.deepEqual(rules.valheimWorldArgs(vh), ['-preset', 'hard', '-modifier', 'combat', 'veryhard', '-setkey', 'nomap']);
  assert.throws(() => rules.valheimRules({ valheimModifiers: { combat: 'normal' } }), /combat/);
  assert.throws(() => rules.valheimRules({ valheimKeys: ['-password'] }), /world option/);
  for (const arg of rules.valheimWorldArgs(vh)) assert.ok(!valheimLaunch.OWNED_FLAGS.has(arg), `${arg} is not Hostkind-owned`);

  // Palworld: ini values in the file's own spelling.
  assert.deepEqual(rules.palworldSettings(rules.palworldRules({ deathPenalty: 'none', expRate: '2', pvp: true, hardcore: false })), {
    DeathPenalty: 'None', ExpRate: '2.000000', PalCaptureRate: '1.000000',
    bEnablePlayerToPlayerDamage: 'True', bEnableFriendlyFire: 'True', bHardcore: 'False',
  });
  assert.throws(() => rules.palworldRules({ expRate: 50 }), /Experience rate/);
  assert.throws(() => rules.palworldRules({ deathPenalty: 'Pals' }), /death penalty/);
  assert.deepEqual([...VALHEIM_WORLD_PRESETS], [...valheimLaunch.WORLD_PRESETS], 'the wizard offers what the server accepts');
  for (const lang of i18n.SUPPORTED_LANGS) {
    for (const preset of VALHEIM_WORLD_PRESETS) {
      assert.equal(typeof lookup(i18n.dictionaries[lang], `serverPresets.valheimWorldPreset.${preset}`), 'string');
    }
  }

  // The highlighted preset follows the form: string form values from inputs
  // still match, an edited field clears it.
  const expert = SERVER_PRESETS.terraria.find((p) => p.id === 'expert');
  const form = { name: 'x', ...expert.values, maxPlayers: String(expert.values.maxPlayers) };
  assert.equal(matchingPreset('terraria', form).id, 'expert');
  assert.equal(matchingPreset('terraria', { ...form, worldSize: '1' }), null);
  assert.equal(matchingPreset('custom', {}), null);

  // A generated Valheim password is one Valheim takes.
  for (let i = 0; i < 50; i++) {
    const password = friendlyPassword();
    assert.match(password, /^[a-z2-9]{10}$/);
    assert.doesNotMatch(password, /[ilo01]/);
    assert.equal(valheimLaunch.validatePassword(password), password);
  }

  // Destination: a picked folder is used as-is, even if taken (the route
  // refuses that); no folder means the default root, created on demand, with
  // the next free name when one is taken.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-destination-'));
  try {
    const picked = resolveDestination({ parentDir: ` ${tmp} `, name: 'My Server', slugify });
    assert.deepEqual(picked, { parentDir: tmp, dir: path.join(tmp, 'my-server'), defaulted: false });

    const root = path.join(tmp, 'Hostkind Servers');
    const first = resolveDestination({ parentDir: '', name: 'My Server', slugify, root });
    assert.equal(first.dir, path.join(root, 'my-server'));
    assert.equal(first.defaulted, true);
    assert.ok(fs.statSync(root).isDirectory(), 'default root is created');

    fs.mkdirSync(path.join(root, 'my-server'));
    assert.equal(resolveDestination({ name: 'My Server', slugify, root }).dir, path.join(root, 'my-server'), 'an empty folder is reused');
    fs.writeFileSync(path.join(root, 'my-server', 'world.wld'), 'x');
    assert.equal(resolveDestination({ name: 'My Server', slugify, root }).dir, path.join(root, 'my-server-2'));
    fs.writeFileSync(path.join(root, 'my-server-2'), 'a file, not a folder');
    assert.equal(resolveDestination({ name: 'My Server', slugify, root }).dir, path.join(root, 'my-server-3'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('server-presets: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
