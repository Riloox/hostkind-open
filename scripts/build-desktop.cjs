'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// electron-builder validates the source package before applying extraMetadata.
// Normalize only that input; keep the four-part release version in the packaged
// app, installer names, and OS metadata. Always restore the source verbatim.
function buildDesktop(args, { root = path.resolve(__dirname, '..'), run = spawnSync } = {}) {
  const packageFile = path.join(root, 'package.json');
  const original = fs.readFileSync(packageFile, 'utf8');
  const pkg = JSON.parse(original);
  const patchBuild = /^(\d+\.\d+\.\d+)\.(\d+)$/.exec(pkg.version);
  const extra = patchBuild ? [
    `--config.extraMetadata.version=${pkg.version}`,
    `--config.buildVersion=${pkg.version}`,
    `--config.buildNumber=${patchBuild[2]}`,
  ] : [];
  try {
    if (patchBuild) {
      fs.writeFileSync(packageFile, `${JSON.stringify({ ...pkg, version: patchBuild[1] }, null, 2)}\n`);
    }
    const result = run(process.execPath, [require.resolve('electron-builder/out/cli/cli.js'), ...args, ...extra], {
      cwd: root, stdio: 'inherit', windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`electron-builder terminated by ${result.signal}`);
    return result.status ?? 1;
  } finally {
    if (patchBuild) fs.writeFileSync(packageFile, original);
  }
}

if (require.main === module) {
  try { process.exitCode = buildDesktop(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { buildDesktop };
