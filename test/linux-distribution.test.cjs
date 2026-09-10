'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const builderSource = fs.readFileSync(
  path.join(root, 'packaging', 'windows', 'electron-builder.cjs'),
  'utf8',
);
const ciWorkflow = fs.readFileSync(
  path.join(root, '.github', 'workflows', 'ci.yml'),
  'utf8',
);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// 0.1.2.3 contract: Linux ships a .deb for Ubuntu/Debian double-click
// installs and an AppImage portable fallback, built from the same Electron
// desktop app as the Windows installer.
assert.match(builderSource, /linux:\s*\{/);
assert.match(builderSource, /target:\s*'AppImage'/);
assert.match(builderSource, /target:\s*'deb'/);
assert.match(builderSource, /appImage:\s*\{/);
assert.match(builderSource, /Hostkind-\$\{version\}\.AppImage/);
assert.match(builderSource, /category:\s*'Utility'/);

assert.match(ciWorkflow, /--linux AppImage deb/);
assert.match(ciWorkflow, /Hostkind-\*\.AppImage/);
assert.match(ciWorkflow, /\.deb/);

assert.ok(packageJson.scripts['desktop:dist:linux']);
assert.match(packageJson.scripts['desktop:dist:linux'], /--linux AppImage deb/);

const linuxDocPath = path.join(root, 'LINUX-DISTRIBUTION.md');
assert.ok(fs.existsSync(linuxDocPath), 'LINUX-DISTRIBUTION.md must exist');
const linuxDoc = fs.readFileSync(linuxDocPath, 'utf8');
assert.match(linuxDoc, /\.deb/i);
assert.match(linuxDoc, /AppImage/i);

console.log('PASS linux-distribution');
