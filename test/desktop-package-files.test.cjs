'use strict';

// 0.1.4.1 regression: the packaged desktop app crashed at boot with
// "Cannot find module '../config/constants.cjs'" because the electron-builder
// `files` allow-list shipped lib/** but not config/**. Walk every relative
// require() reachable from the packaged entry points and assert each target
// is covered by the allow-list, and that the icons it references exist.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const builder = require(path.join(root, 'packaging', 'windows', 'electron-builder.cjs'));
const toPosix = (p) => p.split(path.sep).join('/');

function allowed(rel) {
  return builder.files.some((pattern) => (pattern.endsWith('/**')
    ? rel.startsWith(pattern.slice(0, -2))
    : rel === pattern));
}

function resolveTarget(rel) {
  for (const candidate of [rel, `${rel}.js`, `${rel}.cjs`, `${rel}.json`, `${rel}/index.js`, `${rel}/index.cjs`]) {
    const abs = path.join(root, candidate);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return candidate;
  }
  return null;
}

const entries = [builder.extraMetadata.main, 'server.js', ...builder.files.filter((f) => f.startsWith('scripts/'))];
const queue = [...entries];
const seen = new Set();
const missing = [];

while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of source.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    const rel = toPosix(path.relative(root, path.resolve(path.dirname(path.join(root, file)), match[1])));
    const target = resolveTarget(rel);
    assert.ok(target, `${file} requires ${match[1]}, which does not exist`);
    if (!allowed(target)) missing.push(`${file} -> ${target}`);
    else if (/\.c?js$/.test(target)) queue.push(target);
  }
}

assert.deepStrictEqual(missing, [], `packaged app requires files outside electron-builder files:\n${missing.join('\n')}`);
assert.ok(seen.has('config/constants.cjs'));

// Hostkind logo icons for the executable, installer, Linux packages and window.
for (const icon of [builder.icon, builder.win.icon, builder.linux.icon, builder.nsis.installerIcon, builder.nsis.uninstallerIcon]) {
  assert.ok(icon && fs.existsSync(path.join(root, icon)), `missing icon ${icon}`);
}
assert.ok(fs.existsSync(path.join(root, 'resources', 'hostkind-icon.png')));
assert.match(fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8'), /icon:\s*path\.join\(__dirname, '\.\.', 'resources', 'hostkind-icon\.png'\)/);

console.log(`desktop-package-files: ${seen.size} packaged modules resolve inside the allow-list`);
