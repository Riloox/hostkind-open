'use strict';

/*
 * Registered servers, with content on disk.
 *
 * Most of the panel is a view onto files: worlds are folders, configs are
 * files, backups are archives. So rather than mock the API, these builders lay
 * down a realistic tree in the instance's temp directory and register a server
 * that points at it. The panel then reads, writes, and deletes for real, and a
 * spec can assert on what actually landed on disk.
 *
 * Used through startInstance({ servers: (dirs) => [...] }), where `dirs.servers`
 * is a temp directory that goes away with the instance:
 *
 *   const panel = await startInstance({
 *     servers: (dirs) => [
 *       seed.minecraft(dirs, { name: 'Survival' }),
 *       seed.custom(dirs, { name: 'Worker' }),
 *     ],
 *   });
 *
 * Ids are derived from the slug ("srv-survival") so a spec can address a
 * server without digging it out of the config first.
 */

const fs = require('fs');
const path = require('path');

const FAKE_PROCESS = path.join(__dirname, 'fake-process.cjs');
const FAKE_PALWORLD = path.join(__dirname, 'fake-palworld.cjs');

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

/**
 * Materialize a directory tree from a plain object.
 *   { 'server.properties': 'text', world: { 'level.dat': Buffer } }
 * A string or Buffer value is a file; an object is a directory.
 */
function writeTree(root, tree) {
  fs.mkdirSync(root, { recursive: true });
  for (const [name, value] of Object.entries(tree || {})) {
    const target = path.join(root, name);
    if (value && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)) {
      writeTree(target, value);
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.isBuffer(value) ? value : String(value));
    }
  }
  return root;
}

// Create <dirs.servers>/<slug> and return its absolute path.
function serverDir(dirs, slug) {
  const dir = path.join(dirs.servers, slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* -------------------------------------------------------------- Minecraft -- */

const SERVER_PROPERTIES = [
  '#Minecraft server properties',
  'motd=A Hostkind test server',
  'server-port=25565',
  'max-players=20',
  'difficulty=normal',
  'gamemode=survival',
  'pvp=true',
  'level-name=world',
  'online-mode=true',
  'view-distance=10',
  '',
].join('\n');

/**
 * A Minecraft server that looks like it has been started once: server.properties
 * exists (which is what the panel reads as "the tree is generated"), the
 * configured worlds are on disk, and there are plugins and a log to list.
 */
function minecraft(dirs, options = {}) {
  const { name = 'Minecraft Server', worlds = ['world', 'world_nether', 'world_the_end'], generated = true, extra = {} } = options;
  const slug = slugify(name);
  const dir = serverDir(dirs, slug);

  const tree = {
    'server.jar': 'not a real jar, and never launched',
    'eula.txt': 'eula=true\n',
    'ops.json': '[]\n',
    'whitelist.json': '[]\n',
    'banned-players.json': '[]\n',
    plugins: {
      'EssentialsX.jar': 'plugin',
      'Vault.jar': 'plugin',
    },
    logs: {
      'latest.log': '[12:00:00] [Server thread/INFO]: Done (1.234s)! For help, type "help"\n',
    },
    ...extra,
  };
  if (generated) tree['server.properties'] = SERVER_PROPERTIES;
  for (const world of worlds) {
    tree[world] = {
      'level.dat': Buffer.alloc(64, 1),
      'session.lock': Buffer.alloc(8, 2),
      region: { 'r.0.0.mca': Buffer.alloc(256, 3) },
    };
  }
  writeTree(dir, tree);

  return {
    id: `srv-${slug}`,
    type: 'minecraft',
    name,
    dir,
    jar: 'server.jar',
    javaArgs: ['-Xmx1G', '-Xms1G'],
    worlds,
    mcVersion: '1.20.4',
    stopTimeoutSeconds: 30,
    mapUrl: '',
    hasStarted: generated,
    watchdog: { enabled: false, maxRestarts: 3, windowMinutes: 10 },
  };
}

/* ----------------------------------------------------------------- custom -- */

/**
 * An "Other Processes" server wired to e2e/support/fake-process.cjs. This one
 * really runs: start it from the UI and the console fills with its stdout.
 *
 * `healthCheckRegex` is what promotes it from starting to online, and
 * `stopCommand` is written to its stdin on stop - both are the module's own
 * mechanisms, not test-only hooks.
 */
function custom(dirs, options = {}) {
  const { name = 'Worker', bootMs = 0, autoStop = true, extra = {} } = options;
  const slug = slugify(name);
  const dir = serverDir(dirs, slug);

  writeTree(dir, {
    'notes.txt': 'A file for the file manager to list.\n',
    data: { 'state.json': '{"runs":0}\n' },
    ...extra,
  });

  return {
    id: `srv-${slug}`,
    type: 'custom',
    name,
    dir,
    cwd: dir,
    // executable + args skips the panel's command-line parser, so a temp path
    // containing spaces cannot break the fixture.
    executable: process.execPath,
    args: [FAKE_PROCESS],
    env: bootMs ? { FAKE_BOOT_MS: String(bootMs) } : undefined,
    healthCheckRegex: '\\[fake\\] ready',
    stopCommand: autoStop ? 'stop' : '',
    stopSignal: 'SIGTERM',
    hasStarted: options.started !== false,
    stopTimeoutSeconds: 10,
    watchdog: { enabled: false, maxRestarts: 3, windowMinutes: 10 },
  };
}

/**
 * Put a runnable process *inside* `dir` and return the start command for it.
 *
 * The create wizard refuses an executable outside the working directory
 * (lib/modules/registration.cjs) - a real rule, not a quirk - so a test that
 * registers a process through the UI has to plant one there. The node binary
 * is hard-linked where the filesystem allows it, which costs nothing; copying
 * is the fallback across volumes.
 */
function plantRunnable(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const executable = path.join(dir, path.basename(process.execPath));
  if (!fs.existsSync(executable)) {
    try { fs.linkSync(process.execPath, executable); }
    catch { fs.copyFileSync(process.execPath, executable); }
  }
  const script = path.join(dir, 'fake-process.cjs');
  fs.copyFileSync(FAKE_PROCESS, script);
  return { executable, script, startCommand: `"${executable}" "${script}"` };
}

/* --------------------------------------------------------------- Terraria -- */

// Length-prefixed string, as .NET's BinaryWriter writes one.
function netString(text) {
  const body = Buffer.from(String(text), 'utf8');
  const length = [];
  let remaining = body.length;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) byte |= 0x80;
    length.push(byte);
  } while (remaining);
  return Buffer.concat([Buffer.from(length), body]);
}

/*
 * A .wld file with a header the panel can actually parse, so the worlds view
 * shows a real name, size, and difficulty rather than "unreadable".
 * Mirrors the fixture builder in test/terraria-worlds.test.cjs - if the header
 * reader changes, both move together.
 */
function terrariaWorldFile({ name = 'Fixture', seed = 'seed', gameMode = 0, width = 4200, height = 1200 } = {}) {
  const sections = 11;
  const tileMaskBits = 753;
  const preamble = Buffer.alloc(24 + 2 + 4 * sections + 2 + Math.ceil(tileMaskBits / 8));
  preamble.writeInt32LE(319, 0);
  Buffer.from('relogic', 'ascii').copy(preamble, 4);
  preamble.writeUInt8(2, 11);
  preamble.writeUInt32LE(2, 12);
  preamble.writeBigUInt64LE(0n, 16);
  preamble.writeInt16LE(sections, 24);
  preamble.writeInt32LE(preamble.length, 26);
  preamble.writeInt16LE(tileMaskBits, 26 + 4 * sections);

  const numbers = Buffer.alloc(8 + 16 + 4 + 16 + 12);
  let at = 0;
  numbers.writeBigUInt64LE(1370094567425n, at); at += 8;
  at += 16;                                       // guid
  numbers.writeInt32LE(17750398, at); at += 4;    // world id
  numbers.writeInt32LE(0, at); at += 4;           // left
  numbers.writeInt32LE(width * 16, at); at += 4;  // right
  numbers.writeInt32LE(0, at); at += 4;           // top
  numbers.writeInt32LE(height * 16, at); at += 4; // bottom
  numbers.writeInt32LE(height, at); at += 4;      // height precedes width
  numbers.writeInt32LE(width, at); at += 4;
  numbers.writeInt32LE(gameMode, at);

  return Buffer.concat([preamble, netString(name), netString(seed), numbers, Buffer.alloc(512, 0x2a)]);
}

function terraria(dirs, options = {}) {
  const { name = 'Terraria Server', variant = 'vanilla', worlds = ['Fixture'], saveDir = 'worlds', extra = {} } = options;
  const slug = slugify(name);
  const dir = serverDir(dirs, slug);
  const savePath = path.join(dir, saveDir);

  const executable = path.join(dir, process.platform === 'win32' ? 'TerrariaServer.exe' : 'TerrariaServer.bin.x86_64');
  const configFile = path.join(dir, 'serverconfig.txt');

  const worldFiles = {};
  for (const world of worlds) worldFiles[`${world}.wld`] = terrariaWorldFile({ name: world });

  writeTree(dir, {
    [path.basename(executable)]: 'not a real binary',
    'serverconfig.txt': [
      '# Hostkind test config',
      `worldpath=${savePath}`,
      worlds.length ? `world=${path.join(savePath, `${worlds[0]}.wld`)}` : '',
      worlds.length ? `worldname=${worlds[0]}` : '',
      'maxplayers=8',
      'port=7777',
      'autocreate=2',
      'difficulty=0',
      '',
    ].join('\n'),
    [saveDir]: worldFiles,
    ...extra,
  });

  return {
    id: `srv-${slug}`,
    type: 'terraria',
    name,
    dir,
    cwd: dir,
    executable,
    args: ['-config', configFile],
    port: 7777,
    terrariaVariant: variant,
    terrariaSaveDir: saveDir,
    terrariaWorld: worlds.length ? { file: `${saveDir}/${worlds[0]}.wld`, name: worlds[0] } : null,
    // An installed server that has been run before. Without this the panel
    // treats every content view (mods, files, configs) as a first start and
    // interrupts with the "start the server first" prompt.
    hasStarted: options.started !== false,
    stopTimeoutSeconds: 30,
    watchdog: { enabled: false, maxRestarts: 3, windowMinutes: 10 },
  };
}

/* ---------------------------------------------------------------- Valheim -- */

function valheim(dirs, options = {}) {
  const { name = 'Valheim Server', worlds = ['Midgard'], saveDir = 'data', extra = {} } = options;
  const slug = slugify(name);
  const dir = serverDir(dirs, slug);

  const worldFiles = {};
  for (const world of worlds) {
    worldFiles[`${world}.fwl`] = Buffer.alloc(96, 5);   // metadata
    worldFiles[`${world}.db`] = Buffer.alloc(4096, 6);  // world data
  }

  const executable = path.join(dir, process.platform === 'win32' ? 'valheim_server.exe' : 'valheim_server.x86_64');
  writeTree(dir, {
    [path.basename(executable)]: 'not a real binary',
    [saveDir]: { worlds_local: worldFiles },
    ...extra,
  });

  return {
    id: `srv-${slug}`,
    type: 'valheim',
    name,
    dir,
    cwd: dir,
    executable,
    args: ['-nographics', '-batchmode'],
    valheimSchema: 1,
    valheimSaveDir: saveDir,
    valheimWorld: worlds[0] || '',
    valheimServerName: name,
    port: 2456,
    hasStarted: options.started !== false,
    stopTimeoutSeconds: 30,
    watchdog: { enabled: false, maxRestarts: 3, windowMinutes: 10 },
  };
}

/* --------------------------------------------------------------- Palworld -- */

const PALWORLD_SETTINGS = [
  '[/Script/Pal.PalGameWorldSettings]',
  'OptionSettings=(Difficulty=None,DayTimeSpeedRate=1.000000,ServerName="Hostkind test",ServerPlayerMaxNum=32,PublicPort=8211,RESTAPIEnabled=True,RESTAPIPort=8212,AdminPassword="test-admin")',
  '',
].join('\n');

function palworld(dirs, options = {}) {
  const { name = 'Palworld Server', extra = {} } = options;
  const slug = slugify(name);
  const dir = serverDir(dirs, slug);
  const platformFolder = process.platform === 'win32' ? 'WindowsServer' : 'LinuxServer';

  const executable = path.join(dir, process.platform === 'win32' ? 'PalServer.exe' : 'PalServer.sh');
  writeTree(dir, {
    [path.basename(executable)]: 'not a real binary',
    Pal: {
      Saved: {
        Config: { [platformFolder]: { 'PalWorldSettings.ini': PALWORLD_SETTINGS } },
        SaveGames: { '0': { A1B2C3: { 'Level.sav': Buffer.alloc(256, 7) } } },
      },
    },
    ...extra,
  });

  return {
    id: `srv-${slug}`,
    type: 'palworld',
    name,
    dir,
    cwd: dir,
    executable,
    args: ['-publiclobby'],
    port: 8211,
    restPort: 8212,
    restPassword: 'test-admin',
    hasStarted: options.started !== false,
    stopTimeoutSeconds: 30,
    watchdog: { enabled: false, maxRestarts: 3, windowMinutes: 10 },
  };
}

/**
 * A Palworld server that actually runs: a real child process pointed at
 * e2e/support/fake-palworld.cjs. The fake never prints the console readiness
 * line (that is the Windows case this module now covers), so a start here only
 * reaches online through the REST API the fake serves on `restPort`.
 */
function palworldRunnable(dirs, options = {}) {
  const { name = 'Palworld Server', restPort = 8212, bootMs = 0, extra = {} } = options;
  const slug = slugify(name);
  const dir = serverDir(dirs, slug);

  writeTree(dir, {
    'notes.txt': 'A file for the file manager to list.\n',
    Pal: {
      Saved: {
        Config: { WindowsServer: { 'PalWorldSettings.ini': PALWORLD_SETTINGS } },
        SaveGames: { '0': { A1B2C3: { 'Level.sav': Buffer.alloc(256, 7) } } },
      },
    },
    ...extra,
  });

  return {
    id: `srv-${slug}`,
    type: 'palworld',
    name,
    dir,
    cwd: dir,
    // executable + args skips the panel's command-line parser, so a temp path
    // containing spaces cannot break the fixture.
    executable: process.execPath,
    args: [FAKE_PALWORLD],
    port: 8211,
    restPort,
    adminPassword: 'test-admin',
    env: bootMs ? { FAKE_BOOT_MS: String(bootMs) } : undefined,
    hasStarted: options.started !== false,
    stopTimeoutSeconds: 30,
    watchdog: { enabled: false, maxRestarts: 3, windowMinutes: 10 },
  };
}

module.exports = {
  writeTree, slugify, plantRunnable,
  minecraft, custom, terraria, valheim, palworld, palworldRunnable,
  terrariaWorldFile,
  FAKE_PROCESS,
};
