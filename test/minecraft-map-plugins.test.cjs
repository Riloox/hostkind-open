'use strict';

/*
 * lib/minecraft-map-plugins.cjs: detecting an installed web map plugin from
 * the server folder, reading its port, and BlueMap's download consent.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mapPlugins = require('../lib/minecraft-map-plugins.cjs');

const paper = { projectType: 'plugin', folder: 'plugins', loaders: ['paper'], label: 'Paper', mcVersion: '1.21.1' };
const fabric = { projectType: 'mod', folder: 'mods', loaders: ['fabric'], label: 'Fabric', mcVersion: '1.21.1' };
const vanilla = { projectType: null, folder: 'plugins', loaders: [], label: 'Vanilla', mcVersion: '1.21.1' };

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-map-')); }
function write(root, rel, text) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const byKey = (state, key) => state.plugins.find((p) => p.key === key);

// Nothing installed: every plugin offered at its default port.
{
  const root = tmp();
  const state = mapPlugins.status(root, paper);
  assert.strictEqual(state.supported, true);
  assert.deepStrictEqual(state.plugins.map((p) => p.key), ['bluemap', 'dynmap', 'squaremap', 'pl3xmap']);
  assert.ok(state.plugins.every((p) => !p.installed));
  assert.strictEqual(byKey(state, 'dynmap').port, 8123);
  assert.strictEqual(state.blueMapDownload, null);
  fs.rmSync(root, { recursive: true, force: true });
}

// Vanilla cannot run plugins.
{
  const state = mapPlugins.status(tmp(), vanilla);
  assert.strictEqual(state.supported, false);
  assert.strictEqual(state.reason, 'vanilla');
}

// Paper: jar detected case-insensitively, port read from the plugin's config.
{
  const root = tmp();
  write(root, 'plugins/Dynmap-3.7-beta-6-spigot.jar', '');
  write(root, 'plugins/dynmap/configuration.txt', 'deftemplatesuffix: hires\nwebserver-port: 8200\n');
  write(root, 'plugins/BlueMap-5.4-paper.jar', '');
  write(root, 'plugins/BlueMap/webserver.conf', 'enabled: true\nport: 8101\n');
  write(root, 'plugins/BlueMap/core.conf', 'accept-download: false\nrender-thread-count: 1\n');
  const state = mapPlugins.status(root, paper);
  assert.strictEqual(byKey(state, 'dynmap').installed, true);
  assert.strictEqual(byKey(state, 'dynmap').port, 8200);
  assert.strictEqual(byKey(state, 'bluemap').port, 8101);
  assert.strictEqual(byKey(state, 'squaremap').installed, false);
  assert.strictEqual(state.blueMapDownload, 'pending');

  assert.strictEqual(mapPlugins.acceptBlueMapDownload(root), true);
  assert.strictEqual(mapPlugins.blueMapDownloadState(root), 'accepted');
  assert.match(fs.readFileSync(path.join(root, 'plugins', 'BlueMap', 'core.conf'), 'utf8'), /accept-download: true\nrender-thread-count: 1/);
  assert.strictEqual(mapPlugins.acceptBlueMapDownload(root), false);
  fs.rmSync(root, { recursive: true, force: true });
}

// Fabric: jars in mods/, config under config/<name>/; a bad port falls back.
{
  const root = tmp();
  write(root, 'mods/squaremap-fabric-mc1.21.1-1.3.2.jar', '');
  write(root, 'config/squaremap/config.yml', 'settings:\n  internal-webserver:\n    enabled: true\n    port: 99999\n');
  write(root, 'plugins/pl3xmap-1.21.jar', '');
  const state = mapPlugins.status(root, fabric);
  assert.strictEqual(byKey(state, 'squaremap').installed, true);
  assert.strictEqual(byKey(state, 'squaremap').port, 8080);
  assert.strictEqual(byKey(state, 'pl3xmap').installed, false, 'only the loader folder counts');
  fs.rmSync(root, { recursive: true, force: true });
}

assert.strictEqual(mapPlugins.plugin('BlueMap').projectId, 'bluemap');
assert.strictEqual(mapPlugins.plugin('../etc'), null);

console.log('minecraft-map-plugins: ok');
