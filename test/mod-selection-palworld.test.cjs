'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const workshop = require('../lib/palworld-workshop.cjs');

function tempServer() {
  return { id: `pal-${Date.now()}`, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-pal-selection-')) };
}

test('Palworld downloads selected Workshop IDs in one SteamCMD session', async () => {
  const server = tempServer();
  const calls = [];
  try {
    const result = await workshop.downloadBatch({
      server,
      workshopIds: ['101', '202'],
      cacheDir: server.dir,
      download: async () => {},
      ensureSteamCmdImpl: async () => 'steamcmd',
      runSteamImpl: async (_binary, args) => { calls.push(args); },
      cachedPackagesImpl: () => [
        { workshopId: '101', path: 'one' },
        { workshopId: '202', path: 'two' },
      ],
    });
    assert.deepStrictEqual(result.downloaded, ['101', '202']);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].slice(0, 3), ['+force_install_dir', server.dir, '+login']);
    assert.strictEqual(calls[0].filter((value) => value === '+workshop_download_item').length, 2);
  } finally {
    fs.rmSync(server.dir, { recursive: true, force: true });
  }
});

test('Palworld changes the enabled state for a selected package set once', () => {
  const server = tempServer();
  try {
    workshop.writeInventory(server, {
      packages: [
        { workshopId: '101', packageName: 'One', enabled: true },
        { workshopId: '202', packageName: 'Two', enabled: true },
      ],
    });
    const result = workshop.setEnabledBatch({ server, manager: { status: 'offline' }, workshopIds: ['101', '202'], enabled: false });
    assert.deepStrictEqual(result.changed, ['101', '202']);
    assert.ok(workshop.readInventory(server).packages.every((item) => item.enabled === false));
  } finally {
    fs.rmSync(server.dir, { recursive: true, force: true });
  }
});

test('Palworld rejects malformed Workshop selections instead of dropping them', async () => {
  const server = tempServer();
  try {
    await assert.rejects(
      workshop.downloadBatch({
        server,
        workshopIds: ['101', 'not-a-workshop-id'],
        cacheDir: server.dir,
        ensureSteamCmdImpl: async () => 'steamcmd',
        runSteamImpl: async () => {},
      }),
      (error) => error.code === 'invalid_workshop_ids'
    );
  } finally {
    fs.rmSync(server.dir, { recursive: true, force: true });
  }
});
