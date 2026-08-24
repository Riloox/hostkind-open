'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mods = require('../lib/terraria-mods.cjs');

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

function infoEntry({ author = 'Hostkind', version = '1.2.3', buildVersion = '2025.6.3.0', dependencies = [] } = {}) {
  const parts = [];
  if (dependencies.length) {
    parts.push(dotnetString('modReferences'));
    dependencies.forEach((dependency) => parts.push(dotnetString(dependency)));
    parts.push(dotnetString(''));
  }
  parts.push(
    dotnetString('author'), dotnetString(author),
    dotnetString('version'), dotnetString(version),
    dotnetString('displayName.en-US'), dotnetString('Example Mod'),
    dotnetString('buildVersion'), dotnetString(buildVersion),
    dotnetString(''),
  );
  return Buffer.concat(parts);
}

function writeTmod(file, options = {}) {
  const info = infoEntry(options);
  const data = Buffer.concat([
    dotnetString(options.name || 'ExampleMod'),
    dotnetString(options.version || '1.2.3'),
    int(1),
    dotnetString('Info'),
    int(info.length),
    int(info.length),
    info,
  ]);
  const header = Buffer.concat([
    Buffer.from('TMOD'),
    dotnetString(options.containerVersion || '2025.6.3.0'),
    crypto.createHash('sha1').update(data).digest(),
    Buffer.alloc(256),
    int(data.length),
  ]);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-terraria-mods-'));
const desc = {
  id: 'terraria-test',
  dir: root,
  terrariaVariant: 'tmodloader',
  args: ['-tmlsavedirectory', root],
  version: { variant: '2025.6.3.0' },
};

try {
  const modsDir = path.join(root, 'Mods');
  fs.mkdirSync(modsDir);
  writeTmod(path.join(modsDir, 'example.tmod'), { dependencies: ['LibraryMod@2.0'] });
  fs.writeFileSync(path.join(modsDir, 'broken.tmod'), Buffer.from('TMOD'));
  fs.writeFileSync(path.join(modsDir, 'enabled.json'), '[\n  \"ExampleMod\",\n  \"MissingMod\"\n]\n');

  const parsed = mods.parseTmod(path.join(modsDir, 'example.tmod'));
  assert.equal(parsed.internalName, 'ExampleMod');
  assert.equal(parsed.displayName, 'Example Mod');
  assert.equal(parsed.author, 'Hostkind');
  assert.deepEqual(parsed.dependencies, [{ internalName: 'LibraryMod', version: '2.0' }]);

  const before = fs.readFileSync(path.join(modsDir, 'enabled.json'));
  const inventory = mods.inventory(desc);
  assert.equal(inventory.mods.length, 1);
  assert.equal(inventory.unreadable.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(modsDir, 'enabled.json')), before, 'read-only inventory must not rewrite enabled.json');

  const issues = mods.diagnostics(desc, inventory).issues;
  assert(issues.some((issue) => issue.code === 'missing_dependency'));
  assert(issues.some((issue) => issue.code === 'enabled_missing'));
  assert(issues.some((issue) => issue.code === 'unreadable_mod'));

  writeTmod(path.join(modsDir, 'duplicate.tmod'));
  assert(mods.diagnostics(desc).issues.some((issue) => issue.code === 'duplicate_internal_name'));

  const newer = { ...desc, version: { variant: '2024.1.1.0' } };
  assert(mods.diagnostics(newer).issues.some((issue) => issue.code === 'tml_too_old'));
  assert.equal(mods.compareVersions('2.10', '2.9'), 1);
  assert.equal(mods.parseWorkshopId('https://steamcommunity.com/sharedfiles/filedetails/?id=2563309347'), '2563309347');
  assert.equal(mods.parseWorkshopId('2563309347'), '2563309347');
  assert.throws(() => mods.parseWorkshopId('not-an-item'), (error) => error.code === 'workshop_id_invalid');
  const workshop = mods.parseWorkshopDetails({
    response: { publishedfiledetails: [{ result: 1, publishedfileid: '2563309347', title: 'Example', time_updated: 123 }] },
  });
  assert.equal(workshop.title, 'Example');
  const catalog = mods.parseWorkshopCatalogHtml(`
    <div data-publishedfileid="701">
      <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=701">
        <div class="workshopItemTitle">Magic &amp; Storage</div>
        <img src="https://example.test/701.jpg" alt="Magic &amp; Storage">
      </a>
    </div>
    <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=702"><img alt="Boss Checklist"></a>
  `);
  assert.deepEqual(catalog.map((item) => item.id), ['701', '702']);
  assert.equal(catalog[0].title, 'Magic & Storage');
  assert.equal(catalog[0].previewUrl, 'https://example.test/701.jpg');

  const steamRoot = path.join(root, 'steam');
  const secondLibrary = path.join(root, 'second-library');
  const itemRoot = path.join(secondLibrary, 'steamapps', 'workshop', 'content', '1281930', '701');
  fs.mkdirSync(path.join(steamRoot, 'steamapps'), { recursive: true });
  fs.mkdirSync(path.join(itemRoot, '2025.6'), { recursive: true });
  fs.mkdirSync(path.join(itemRoot, '2024.10'), { recursive: true });
  fs.writeFileSync(path.join(steamRoot, 'steamapps', 'libraryfolders.vdf'), `"path" "${secondLibrary.replace(/\\/g, '\\\\')}"`);
  writeTmod(path.join(itemRoot, '2025.6', 'current.tmod'));
  writeTmod(path.join(itemRoot, '2024.10', 'old.tmod'), { buildVersion: '2024.10.1.0' });
  const workshopRoots = mods.locateWorkshopContent(path.join(steamRoot, 'steamcmd.sh'), '701', {
    platform: 'linux', env: {}, home: path.join(root, 'empty-home'),
  });
  assert.deepEqual(workshopRoots, [itemRoot]);
  assert.deepEqual(mods.selectWorkshopTmods(workshopRoots, desc), [path.join(itemRoot, '2025.6', 'current.tmod')]);

  const pack = mods.capturePack(desc, 'Test pack');
  const exported = mods.exportPack(desc, pack.id);
  assert.equal(exported.format, 'fleetdeck-terraria-modpack');
  assert.equal(exported.version, 1);
  assert(!JSON.stringify(exported).includes(root), 'portable modpacks must not contain absolute server paths');
  const imported = mods.importPack(desc, exported);
  assert.equal(imported.name, 'Test pack');
  assert.equal(mods.listPacks(desc).length, 2);
  mods.deletePack(desc, pack.id);
  assert.equal(mods.listPacks(desc).length, 1);
  assert.throws(
    () => mods.importPack(desc, { format: 'fleetdeck-terraria-modpack', version: 99, pack: { mods: [] } }),
    (error) => error.code === 'pack_version_unsupported',
  );

  console.log('terraria mods tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
