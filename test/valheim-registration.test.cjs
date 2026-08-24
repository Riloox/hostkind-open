'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createValheimModule = require('../lib/modules/valheim/manager.cjs');
const { validateManualRegistration } = require('../lib/modules/registration.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-valheim-registration-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-valheim-outside-'));
const executable = path.join(root, process.platform === 'win32' ? 'valheim_server.exe' : 'valheim_server.x86_64');
fs.writeFileSync(executable, 'fixture');
if (process.platform !== 'win32') fs.chmodSync(executable, 0o755);
const mod = createValheimModule();
const legacy = {
  type: 'valheim', dir: root, cwd: root, executable,
  args: ['-nographics', '-name', 'Old server', '-mystery=one two', '-port', '2456',
    '-world', 'Old world', '-password', 'secret5', '-public', '0', '-batchmode'],
};

async function run() {
  try {
    const migrated = mod.migrateDescriptor(legacy);
    assert.equal(migrated.valheimSchema, 1);
    assert.deepEqual(migrated.args, legacy.args);
    assert.deepEqual(migrated.valheimExtraArgs, ['-nographics', '-mystery=one two', '-batchmode']);
    assert.equal(migrated.serverName, 'Old server');
    assert.equal(migrated.worldName, 'Old world');
    assert.equal(migrated.password, 'secret5');
    assert.equal(migrated.valheimPublic, false);
    assert.deepEqual(mod.migrateDescriptor(migrated), migrated);
    const registered = validateManualRegistration({
      gameType: 'valheim', name: 'Adopted Valheim', cwd: root, executable,
      args: legacy.args, port: 2456,
    });
    assert.equal(registered.valheimSchema, 1);
    assert.deepEqual(registered.args, legacy.args);

    assert.throws(() => mod.migrateDescriptor({ ...legacy, args: [...legacy.args, '-port', '2457'] }), /Duplicate/);
    assert.throws(() => mod.buildLaunch({ ...migrated, executable: path.join(outside, path.basename(executable)) }), /inside the server folder/);
    assert.throws(() => mod.buildLaunch({ ...migrated, executable: path.join(root, 'start_server.sh') }), /wrappers/);
    assert.throws(() => mod.buildLaunch({ ...migrated, serverName: '-bad' }), /Server name is invalid/);
    assert.throws(() => mod.buildLaunch({ ...migrated, worldName: 'bad\nworld' }), /unsafe character/);
    // docs/valheim/03-worlds.md: deleting the selected world may leave the
    // server explicitly unconfigured, but it must never point -world at
    // missing data - a clear, specific error is the mechanism for that.
    assert.throws(() => mod.buildLaunch({ ...migrated, worldName: '' }), (err) => err.code === 'world_unselected');
    assert.throws(() => mod.buildLaunch({ ...migrated, worldName: null }), (err) => err.code === 'world_unselected');
    assert.throws(() => mod.buildLaunch({ ...migrated, password: 'four' }), /5 to 64/);
    assert.throws(() => mod.buildLaunch({ ...migrated, password: 'bad pass' }), /whitespace/);
    assert.throws(() => mod.buildLaunch({ ...migrated, port: 65534 }), /three consecutive ports/);
    assert.throws(() => mod.buildLaunch({ ...migrated, valheimExtraArgs: ['-port', '3000'] }), /Hostkind-owned/);
    assert.throws(() => mod.buildLaunch({ ...migrated, valheimExtraArgs: ['bad\0arg'] }), /unsafe character/);
    assert.throws(() => mod.buildLaunch({ ...migrated, valheimSaveDir: '../escape' }), /inside the server folder/);
    if (process.platform !== 'win32') {
      fs.symlinkSync(outside, path.join(root, 'linked-data'), 'dir');
      assert.throws(() => mod.buildLaunch({ ...migrated, valheimSaveDir: 'linked-data' }), /through a link/);
    }

    assert.deepEqual(mod.portPlan({ port: 2456 }).ports, [2456, 2457, 2458]);
    const collision = createValheimModule({
      getConfig: () => ({ servers: [{ id: 'other', type: 'custom', port: 2458 }] }),
    });
    assert.equal((await collision.preLaunch({ desc: () => ({ ...migrated, id: 'current' }) })).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
}

run().then(() => console.log('valheim registration tests passed'))
  .catch((err) => { console.error(err); process.exitCode = 1; });
