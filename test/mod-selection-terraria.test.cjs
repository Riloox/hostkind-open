'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const terrariaMods = require('../lib/terraria-mods.cjs');

function dotnetString(value) {
  const body = Buffer.from(value);
  const bytes = [];
  let length = body.length;
  do {
    let byte = length & 0x7f;
    length >>>= 7;
    if (length) byte |= 0x80;
    bytes.push(byte);
  } while (length);
  return Buffer.concat([Buffer.from(bytes), body]);
}

function int(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value);
  return buffer;
}

function writeTmod(file, name) {
  const info = Buffer.concat([
    dotnetString('author'), dotnetString('Hostkind'),
    dotnetString('version'), dotnetString('1.0.0'),
    dotnetString('displayName.en-US'), dotnetString(name),
    dotnetString('buildVersion'), dotnetString('2025.6.3.0'),
    dotnetString(''),
  ]);
  const data = Buffer.concat([
    dotnetString(name.replace(/ /g, '')),
    dotnetString('1.0.0'),
    int(1), dotnetString('Info'), int(info.length), int(info.length), info,
  ]);
  const header = Buffer.concat([
    Buffer.from('TMOD'), dotnetString('2025.6.3.0'),
    crypto.createHash('sha1').update(data).digest(), Buffer.alloc(256), int(data.length),
  ]);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

test('Terraria batches selected Workshop mods into one SteamCMD preview', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-terraria-batch-'));
  const desc = { id: 'terraria-batch', dir: root, args: [], version: { variant: '2025.6.3.0' } };
  const manager = { status: 'offline' };
  const roots = {};
  const files = {};
  const calls = [];
  try {
    for (const id of ['701', '702']) {
      const contentRoot = path.join(root, `workshop-${id}`);
      fs.mkdirSync(contentRoot, { recursive: true });
      const file = path.join(contentRoot, `${id}.tmod`);
      writeTmod(file, `Mod ${id}`);
      roots[id] = [contentRoot];
      files[id] = [file];
    }

    const result = await terrariaMods.downloadWorkshopBatch({
      desc,
      actorId: 'operator-1',
      manager,
      values: ['701', '702'],
      cacheDir: root,
      download: async () => {},
      resolveDetail: async (value) => ({ id: String(value), title: `Workshop ${value}`, timeUpdated: 10 }),
      ensureSteamCmdImpl: async () => 'steamcmd',
      runSteamImpl: async (_bin, args) => calls.push(args),
      locateWorkshopContentImpl: (_bin, id) => roots[id],
      selectWorkshopTmodsImpl: (_found, _desc, id) => files[id],
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].filter((value) => value === '+workshop_download_item').length, 2);
    assert.equal(result.details.length, 2);
    assert.equal(result.plan.length, 2);
  } finally {
    terrariaMods.resetPreviews();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Terraria keeps successful Workshop selections when one lookup fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-terraria-partial-'));
  const desc = { id: 'terraria-partial', dir: root, args: [], version: { variant: '2025.6.3.0' } };
  const file = path.join(root, 'good.tmod');
  writeTmod(file, 'Good');
  try {
    const result = await terrariaMods.downloadWorkshopBatch({
      desc,
      actorId: 'operator-1',
      manager: { status: 'offline' },
      values: ['701', '703'],
      cacheDir: root,
      download: async () => {},
      resolveDetail: async (value) => {
        if (String(value) === '703') throw new Error('Workshop lookup failed');
        return { id: '701', title: 'Good', timeUpdated: 10 };
      },
      ensureSteamCmdImpl: async () => 'steamcmd',
      runSteamImpl: async () => {},
      locateWorkshopContentImpl: () => [root],
      selectWorkshopTmodsImpl: () => [file],
    });
    assert.equal(result.details.length, 1);
    assert.deepEqual(result.failed, [{ id: '703', error: 'Workshop lookup failed' }]);
  } finally {
    terrariaMods.resetPreviews();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Terraria previews one batch enable decision for selected mods', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-terraria-enable-batch-'));
  const desc = { id: 'terraria-enable-batch', dir: root, args: [], version: { variant: '2025.6.3.0' } };
  try {
    const modsDir = path.join(root, 'Mods');
    fs.mkdirSync(modsDir, { recursive: true });
    writeTmod(path.join(modsDir, 'alpha.tmod'), 'Alpha');
    writeTmod(path.join(modsDir, 'beta.tmod'), 'Beta');
    fs.writeFileSync(path.join(modsDir, 'enabled.json'), '[]\n');

    const preview = terrariaMods.makeBatchPreview({
      desc,
      actorId: 'operator-1',
      manager: { status: 'offline' },
      names: ['Alpha', 'Beta'],
      enabled: true,
    });

    assert.equal(preview.batch, true);
    assert.equal(preview.action, 'enable');
    assert.deepEqual(preview.plan.enable.map((item) => item.internalName), ['Alpha', 'Beta']);
  } finally {
    terrariaMods.resetPreviews();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
