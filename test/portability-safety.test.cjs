'use strict';

/*
 * Path safety, recoverable deletion, connectivity guidance, and panel
 * presentation (docs/palworld/07-portability-safety.md).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setupDataDir, teardown, TMP_ROOT } = require('./_setup.cjs');
setupDataDir();

const migrations = require('../lib/migrations.cjs');
const pathSafety = require('../lib/pathSafety.cjs');
const trash = require('../lib/trash.cjs');
const connectivity = require('../lib/palworld-connectivity.cjs');


migrations.runMigrations();

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function tree(name, files = { 'a.txt': 'a' }) {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

// --- path safety ----------------------------------------------------------

test('a drive or filesystem root is never a usable server root', () => {
  const problem = pathSafety.protectedReason(path.parse(TMP_ROOT).root, {});
  assert.strictEqual(problem.reason, 'drive_root');
});

test('the home root is protected but folders inside it are not', () => {
  assert.strictEqual(pathSafety.protectedReason(os.homedir(), {}).reason, 'home_root');
  assert.strictEqual(pathSafety.protectedReason(path.join(os.homedir(), 'servers', 'pal'), {}), null);
});

test('the Hostkind data directory is protected including everything below it', () => {
  const { dataDir } = require('../lib/db.cjs');
  assert.strictEqual(pathSafety.protectedReason(dataDir(), {}).reason, 'fleetdeck_data');
  assert.strictEqual(pathSafety.protectedReason(path.join(dataDir(), 'anything'), {}).reason, 'fleetdeck_data');
});

test('a folder equal to, inside, or containing another registered server is rejected', () => {
  const servers = [{ id: 'a', name: 'Alpha', dir: path.join(TMP_ROOT, 'fleet', 'alpha') }];
  assert.strictEqual(pathSafety.protectedReason(path.join(TMP_ROOT, 'fleet', 'alpha'), { servers }).reason, 'server_overlap');
  assert.strictEqual(pathSafety.protectedReason(path.join(TMP_ROOT, 'fleet', 'alpha', 'Pal'), { servers }).reason, 'server_overlap');
  assert.strictEqual(pathSafety.protectedReason(path.join(TMP_ROOT, 'fleet'), { servers }).reason, 'server_overlap');
  // A sibling whose name merely starts with the same characters is not inside it.
  assert.strictEqual(pathSafety.protectedReason(path.join(TMP_ROOT, 'fleet', 'alpha-2'), { servers }), null);
  // The server may act on its own folder.
  assert.strictEqual(pathSafety.protectedReason(path.join(TMP_ROOT, 'fleet', 'alpha'), { servers, selfId: 'a' }), null);
});

test('a symlink cannot disguise a protected root', function () {
  const { dataDir } = require('../lib/db.cjs');
  const link = path.join(TMP_ROOT, 'link-to-data');
  try { fs.symlinkSync(dataDir(), link, 'junction'); } catch { return; } // unsupported host: nothing to assert
  assert.strictEqual(pathSafety.protectedReason(link, {}).reason, 'fleetdeck_data');
});

// --- recoverable deletion -------------------------------------------------

test('trashing moves the files instead of deleting them, and restore puts them back', () => {
  const dir = tree('trash-move', { 'world/Level.sav': 'save-bytes', 'note.txt': 'hello' });
  const entry = trash.moveToTrash({ target: dir, kind: 'server-files', serverId: 's1', label: 'Alpha' });
  assert.strictEqual(fs.existsSync(dir), false);
  assert.strictEqual(entry.fileCount, 2);
  const listed = trash.list({ serverId: 's1' });
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].restorable, true);
  const restored = trash.restore(entry.id);
  assert.strictEqual(restored.restoredTo, pathSafety.canonical(dir));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'world', 'Level.sav'), 'utf8'), 'save-bytes');
  assert.strictEqual(trash.list({ serverId: 's1' }).length, 0);
});

test('trashing refuses protected roots and other servers folders', () => {
  const other = tree('trash-other-server');
  assert.throws(
    () => trash.moveToTrash({ target: other, servers: [{ id: 'b', name: 'Beta', dir: other }] }),
    (error) => error.code === 'server_overlap',
  );
  assert.strictEqual(fs.existsSync(other), true);
  assert.throws(() => trash.moveToTrash({ target: os.homedir() }), (error) => error.code === 'home_root');
});

test('restore never merges into an occupied original path', () => {
  const dir = tree('trash-occupied');
  const entry = trash.moveToTrash({ target: dir, serverId: 's2' });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'something-else.txt'), 'x');
  assert.throws(() => trash.restore(entry.id), (error) => error.code === 'destination_occupied');
  assert.strictEqual(trash.get(entry.id).restorable, true);
});

test('a failed quarantine leaves the files in place instead of deleting them', () => {
  const dir = tree('trash-failure');
  const original = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); };
  try {
    assert.throws(() => trash.moveToTrash({ target: dir, serverId: 's3' }), (error) => error.code === 'trash_failed');
  } finally {
    fs.renameSync = original;
  }
  assert.strictEqual(fs.existsSync(path.join(dir, 'a.txt')), true);
  assert.strictEqual(trash.list({ serverId: 's3' }).length, 0);
});

test('retention sweeping purges only entries past their expiry', () => {
  const keep = tree('trash-keep');
  const expire = tree('trash-expire');
  const kept = trash.moveToTrash({ target: keep, serverId: 's4', retentionDays: 30 });
  const gone = trash.moveToTrash({ target: expire, serverId: 's4', retentionDays: 1 });
  const purged = trash.sweep({ now: Date.now() + 2 * 86400_000 });
  assert.deepStrictEqual(purged, [gone.id]);
  assert.strictEqual(trash.get(kept.id).restorable, true);
  assert.strictEqual(trash.get(gone.id), null);
});

test('purge is explicit and permanent', () => {
  const dir = tree('trash-purge');
  const entry = trash.moveToTrash({ target: dir, serverId: 's5' });
  const payload = trash.get(entry.id);
  assert.strictEqual(payload.restorable, true);
  trash.purge(entry.id);
  assert.strictEqual(trash.get(entry.id), null);
  assert.strictEqual(fs.existsSync(dir), false);
});

test('a managed artefact such as a backup archive trashes and restores as one item', () => {
  const { dataDir } = require('../lib/db.cjs');
  const backups = path.join(dataDir(), 'backups');
  fs.mkdirSync(backups, { recursive: true });
  const archive = path.join(backups, 'world-2026-07-24.zip');
  fs.writeFileSync(archive, 'archive-bytes');
  // The whole-folder guard refuses a single file outright, which is exactly
  // why item scope exists.
  assert.throws(() => trash.moveToTrash({ target: archive, kind: 'backup' }), (error) => error.code === 'not_a_directory');
  const entry = trash.moveToTrash({ target: archive, kind: 'backup', scope: 'item', serverId: 's6', label: 'world backup' });
  assert.strictEqual(fs.existsSync(archive), false);
  assert.strictEqual(trash.list({ kind: 'backup' })[0].label, 'world backup');
  trash.restore(entry.id);
  assert.strictEqual(fs.readFileSync(archive, 'utf8'), 'archive-bytes');
});

test('OS trash detection reports unavailability instead of falling back to deletion', () => {
  const dir = tree('trash-no-os');
  const detected = trash.detectOsTrash({ platform: 'linux', probe: () => false });
  assert.deepStrictEqual(detected, { available: false, method: null, restorable: false });
  assert.throws(
    () => trash.moveToTrash({ target: dir, useOsTrash: true, detectImpl: () => detected }),
    (error) => error.code === 'os_trash_unavailable',
  );
  assert.strictEqual(fs.existsSync(dir), true);
});

// --- connectivity ---------------------------------------------------------

function palServer(name, ini) {
  const dir = path.join(TMP_ROOT, name);
  const file = path.join(dir, 'Pal', 'Saved', 'Config', 'LinuxServer', 'PalWorldSettings.ini');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, ini);
  return { id: name, name, type: 'palworld', dir, executable: path.join(dir, 'PalServer.sh') };
}

const INI = (extra = '') => `[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(Difficulty=None,ServerName="Test",AdminPassword="hunter2hunter2hunter2hunter2",PublicPort=8211,PublicIP="",RESTAPIEnabled=True,RESTAPIPort=8212${extra})\n`;

test('connectivity separates observed listeners from configured values and instructions', async () => {
  const server = { ...palServer('conn-basic', INI()), port: 8211, restPort: 8212, queryPort: 27015 };
  const report = await connectivity.report({
    server,
    online: true,
    probeUdpImpl: async (port) => ({ port, protocol: 'udp', state: port === 8211 ? 'in_use' : 'free', evidence: connectivity.EVIDENCE.INFERRED }),
    probeTcpImpl: async (port) => ({ port, protocol: 'tcp', state: 'listening', evidence: connectivity.EVIDENCE.OBSERVED }),
  });
  assert.strictEqual(report.ports.game.value, 8211);
  assert.strictEqual(report.ports.rest.loopbackOnly, true);
  assert.strictEqual(report.publicAddress.state, 'not_configured');
  assert.strictEqual(report.listeners.length, 3);
  assert.strictEqual(report.listeners.find((item) => item.port === 8211).evidence, 'inferred');
  assert.strictEqual(report.listeners.find((item) => item.port === 8212).evidence, 'observed');
  const forward = report.checklist.find((item) => item.id === 'port_forward');
  assert.strictEqual(forward.evidence, 'instruction');
  assert.ok(/never changes router configuration/i.test(forward.message));
});

test('a port disagreement between registration and settings is reported, not silently picked', async () => {
  const server = { ...palServer('conn-mismatch', INI()), port: 9000, restPort: 8212 };
  const report = await connectivity.report({ server, probe: false });
  assert.deepStrictEqual(report.mismatch, [{ field: 'gamePort', descriptor: 9000, settings: 8211 }]);
  assert.ok(report.checklist.some((item) => item.id === 'port_mismatch'));
});

test('an unreadable settings file never reads as "no ports configured"', async () => {
  const server = palServer('conn-broken', 'OptionSettings=(broken');
  const report = await connectivity.report({ server, probe: false });
  assert.strictEqual(report.settingsReadable, false);
  assert.ok(report.checklist.some((item) => item.id === 'settings_unreadable'));
});

test('a failed public probe never claims the router is misconfigured', async () => {
  const result = await connectivity.testEndpoint({
    host: 'example.invalid',
    port: 8211,
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    probeTcpImpl: async () => ({ state: 'closed', detail: 'ECONNREFUSED' }),
  });
  assert.strictEqual(result.result, 'closed');
  assert.ok(/does not prove/i.test(result.interpretation));
  let resolvedHost = null;
  await connectivity.testEndpoint({
    host: 'public.example',
    port: 8211,
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    probeTcpImpl: async (_port, options) => {
      resolvedHost = options.host;
      return { state: 'closed', detail: 'ECONNREFUSED' };
    },
  });
  assert.strictEqual(resolvedHost, '93.184.216.34');
  await assert.rejects(
    async () => connectivity.testEndpoint({
      host: 'public.example',
      port: 8211,
      lookupImpl: async () => [{ address: '10.0.0.8', family: 4 }],
      probeTcpImpl: async () => ({ state: 'listening' }),
    }),
    (error) => error.code === 'invalid_host',
  );
  await assert.rejects(async () => connectivity.testEndpoint({ host: 'bad host!', port: 1 }), (error) => error.code === 'invalid_host');
});

(async () => {
  for (const [name, fn] of tests) {
    await fn();
    console.log(`  ok  ${name}`);
  }
  console.log('portability safety tests passed');
  teardown();
})().catch((error) => {
  console.error(error);
  teardown();
  process.exitCode = 1;
});
