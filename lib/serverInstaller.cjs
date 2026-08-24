'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function installerFailureMessage(label, javaBin, stderr, err) {
  const detail = (stderr || '').toString().trim();
  if (detail) return `${label} installer failed: ${detail}`;
  if (err && err.code === 'ENOENT') {
    return `${label} installer failed: Java runtime not found at "${javaBin}". Hostkind could not run the installer.`;
  }
  return `${label} installer failed: ${err ? err.message : 'unknown error'}`;
}

function runForgeInstaller(dir, installerFilename, label = 'Forge', javaBin = 'java', logFn = () => {}) {
  return new Promise((resolve, reject) => {
    const installerPath = path.join(dir, installerFilename);
    logFn(`Running ${label} installer: ${javaBin} -jar ${installerFilename} --installServer in ${dir}`);
    const proc = execFile(javaBin, ['-jar', installerFilename, '--installServer'], {
      cwd: dir,
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024,
    }, (err, _stdout, stderr) => {
      try { fs.unlinkSync(installerPath); } catch { /* ignore */ }
      if (err) return reject(new Error(installerFailureMessage(label, javaBin, stderr, err)));
      resolve();
    });
    proc.stdout && proc.stdout.on('data', () => {});
    proc.stderr && proc.stderr.on('data', () => {});
  });
}

function findRelativeFile(dir, filename) {
  const out = [];
  function walk(current) {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name === filename) out.push(path.relative(dir, full));
    }
  }
  walk(dir);
  out.sort((a, b) => a.localeCompare(b));
  return out[0] || null;
}

function findForgeLaunchTarget(dir, loader = 'forge', platform = process.platform) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jar'));
  const modern = files.find((f) => /^\d+\.\d+(?:\.\d+)?-\d+\.\d+\.\d+(\.\d+)?\.jar$/.test(f));
  if (modern) return { jar: modern, launchArgs: null };
  const neo = files.find((f) => /^\d+(\.\d+){1,3}\.jar$/.test(f));
  if (neo) return { jar: neo, launchArgs: null };
  const universal = files.find((f) => f.includes('minecraftforge-universal'));
  if (universal) return { jar: universal, launchArgs: null };
  if (files.length === 1) return { jar: files[0], launchArgs: null };

  const argName = platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
  const argFile = findRelativeFile(dir, argName);
  if (argFile) {
    return {
      jar: `${loader}-server`,
      // `platform` picks which argfile the installer produced, so the
      // reference must not also pick up this host's separator: it is stored in
      // the descriptor, and java reads '/' on Windows too.
      launchArgs: [`@${argFile.split(path.sep).join('/')}`, 'nogui'],
    };
  }
  return null;
}

module.exports = {
  findForgeLaunchTarget,
  findRelativeFile,
  installerFailureMessage,
  runForgeInstaller,
};
