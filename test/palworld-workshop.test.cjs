'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const workshop = require('../lib/palworld-workshop.cjs');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-palworld-workshop-'));

  try {
  const libraries = workshop.parseVdfLibraries(`
    "libraryfolders"
    {
      "0" { "path" "${root.replace(/\\/g, '\\\\')}" }
      "1" { "path" "/srv/steam" }
    }
  `, root);
  assert(libraries.includes(path.resolve(root)));
  assert(libraries.includes(path.resolve('/srv/steam')));

  const info = workshop.normalizeInfo({
    PackageName: 'ServerTools',
    Version: '2026.07',
    MinRevision: 812345,
    Dependencies: [{ PackageName: 'PalSchema' }],
    InstallRule: [
      { Type: 'Lua', Targets: ['./Scripts'] },
      { Type: 'Lua', IsServer: true, Targets: ['./Scripts'] },
      { Type: 'Paks', IsServer: true, Targets: ['./ServerTools.pak'] },
    ],
  });
  assert.equal(info.packageName, 'ServerTools');
  assert.equal(info.serverRules.length, 2);
  assert.deepEqual(info.dependencies, ['PalSchema']);
  assert.throws(() => workshop.normalizeInfo({ PackageName: '../bad', Version: '1', InstallRule: [{ Type: 'Paks', IsServer: true, Targets: ['./x'] }] }), (error) => error.code === 'invalid_package_name');
  assert.throws(() => workshop.normalizeInfo({ PackageName: 'ClientOnly', Version: '1', InstallRule: [{ Type: 'Paks', Targets: ['./x'] }] }), (error) => error.code === 'missing_server_rule');
  assert.throws(() => workshop.normalizeInfo({ PackageName: 'BadType', Version: '1', InstallRule: [{ Type: 'Binary', IsServer: true, Targets: ['./x'] }] }), (error) => error.code === 'invalid_install_type');
  assert.throws(() => workshop.normalizeInfo({ PackageName: 'Traversal', Version: '1', InstallRule: [{ Type: 'Paks', IsServer: true, Targets: ['../x'] }] }), (error) => error.code === 'invalid_targets');

  const parsed = workshop.parseCatalogHtml(`
    <div class="workshopItemPreviewHolder" data-publishedfileid="123">
      <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=123">
        <div class="workshopItemTitle">Useful &amp; Safe</div>
      </a>
    </div>
    <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=456">
      <div class="workshopItemTitle">Second item</div>
    </a>
  `);
  assert.deepEqual(parsed.map((item) => item.workshopId), ['123', '456']);

  const currentMarkup = workshop.parseCatalogHtml(`
    <div class="generated-card-a">
      <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=701"><img alt="First item"></a>
      <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=701">First item</a>
    </div>
    <div class="generated-card-b">
      <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=702"><img alt="Second item"></a>
      <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=702">Second item</a>
    </div>
    <div class="generated-card-c">
      <a href="https://steamcommunity.com/sharedfiles/filedetails/?id=703"><img alt="Third item"></a>
    </div>
  `);
  assert.deepEqual(currentMarkup.map((item) => item.workshopId), ['701', '702', '703']);
  assert.equal(currentMarkup[0].title, 'First item');
  assert.equal(currentMarkup[0].previewUrl, null);

  const server = { id: 'pal', dir: path.join(root, 'server') };
  fs.mkdirSync(path.join(server.dir, 'Mods'), { recursive: true });
  fs.writeFileSync(path.join(server.dir, 'Mods', 'PalModSettings.ini'), '[Other]\nValue=1\n[PalModSettings]\nActiveModList=Old\n');
  const settings = workshop.activeSettings(server, ['One', 'Two']);
  assert(settings.content.includes('ActiveModList=One'));
  assert(settings.content.includes('ActiveModList=Two'));
  assert(!settings.content.includes('ActiveModList=Old'));
  assert(settings.content.includes('[Other]'));

  // The server's own install folder is a Workshop source too: SteamCMD writes
  // workshop_download_item output there, and nothing Hostkind installs on a
  // dedicated server is otherwise reachable through a host Steam client.
  const serverDir = path.join(root, 'installed-server');
  const itemDir = path.join(serverDir, 'steamapps', 'workshop', 'content', '1623730', '777');
  fs.mkdirSync(itemDir, { recursive: true });
  fs.writeFileSync(path.join(itemDir, 'Info.json'), JSON.stringify({
    PackageName: 'ServerTools', Version: '2026.07',
    InstallRule: [{ Type: 'Paks', IsServer: true, Targets: ['./ServerTools.pak'] }],
  }));
  const serverSources = workshop.cachedPackages({ id: 'pal2', dir: serverDir });
  assert(serverSources.some((item) => item.workshopId === '777' && item.source === 'server'));

  const discovered = workshop.discoverLibraries({ serverDir });
  assert(discovered.some((library) => library.source === 'server' && library.exists && library.root === path.resolve(serverDir)));

  const preferred = workshop.discoverLibraries({ manualPaths: [serverDir], serverDir });
  assert(preferred.some((library) => library.source === 'manual' && library.root === path.resolve(serverDir)));

  const previewServer = { id: 'pal-preview', dir: path.join(root, 'preview-server') };
  const previewItem = path.join(previewServer.dir, 'steamapps', 'workshop', 'content', '1623730', '888');
  fs.mkdirSync(previewItem, { recursive: true });
  fs.writeFileSync(path.join(previewItem, 'Info.json'), JSON.stringify({
    PackageName: 'NeedsRevision', Version: '1.0', MinRevision: 900000,
    InstallRule: [{ Type: 'Paks', IsServer: true, Targets: ['./NeedsRevision.pak'] }],
  }));
  fs.writeFileSync(path.join(previewItem, 'NeedsRevision.pak'), 'pak');
  await assert.rejects(
    () => workshop.preview({ server: previewServer, manager: { status: 'offline' }, actorId: 'u', workshopId: '888' }),
    (error) => error.code === 'revision_unknown',
  );
  const unknown = await workshop.preview({
    server: previewServer, manager: { status: 'offline' }, actorId: 'u', workshopId: '888', allowUnknownRevision: true,
  });
  assert.equal(unknown.plan.revisionState, 'unknown');

  const i18n = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'i18n.json'), 'utf8'));
  assert.equal(typeof i18n.dictionaries.en.palworldMods.official.revisionUnknown, 'string');
  assert.equal(typeof i18n.dictionaries.es.palworldMods.official.revisionUnknown, 'string');

  console.log('palworld workshop tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
