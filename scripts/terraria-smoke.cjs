'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const archiver = require('archiver');
const terrariaInstall = require('../lib/terraria-install.cjs');
const terrariaConsole = require('../lib/modules/terraria/console.cjs');

const OPT_IN = 'FLEETDECK_TERRARIA_SMOKE';

function elapsed(started) {
  return Date.now() - started;
}

async function download(url, destination, progress = () => {}) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || null;
  const output = fs.createWriteStream(destination, { flags: 'wx' });
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve));
    progress(received, total);
  }
  await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
}

function waitForServer(child, variant, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Terraria readiness')), timeoutMs);
    const inspect = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (terrariaConsole.isReady(variant, line)) {
          clearTimeout(timer);
          resolve(line);
          return;
        }
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Terraria exited before readiness (${code})`)); });
  });
}

async function zipDirectory(source, destination) {
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
    archive.pipe(output);
    archive.directory(source, false);
    archive.finalize();
  });
}

async function main() {
  if (process.env[OPT_IN] !== '1') {
    console.error(`Refusing to run: set ${OPT_IN}=1 for an opt-in disposable-server check.`);
    process.exitCode = 2;
    return;
  }

  const variant = String(process.env.TERRARIA_VARIANT || 'vanilla').toLowerCase();
  assert(terrariaInstall.VARIANTS.includes(variant), `TERRARIA_VARIANT must be one of ${terrariaInstall.VARIANTS.join(', ')}`);
  const port = Number(process.env.TERRARIA_SMOKE_PORT || 17777);
  assert(Number.isInteger(port) && port >= 1024 && port <= 65535, 'TERRARIA_SMOKE_PORT must be an unprivileged port');
  const timeoutMs = Number(process.env.TERRARIA_SMOKE_TIMEOUT_MS || 180_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-terraria-smoke-'));
  const destination = path.join(root, 'server');
  const timings = {};
  let child = null;

  try {
    let started = Date.now();
    const versions = await terrariaInstall.listVersions(variant);
    const version = terrariaInstall.newestSupported(versions);
    assert(version, `No stable ${variant} version is currently available`);
    const runtime = await terrariaInstall.install(variant, {
      destination,
      versionId: version.id || version.versionId,
      worldName: 'HostkindSmoke',
      worldSize: 1,
      difficulty: 0,
      maxPlayers: 2,
      port,
      password: '',
      motd: 'Hostkind disposable smoke test',
    }, { download });
    timings.installMs = elapsed(started);

    started = Date.now();
    child = spawn(runtime.executable, runtime.args, {
      cwd: runtime.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    await waitForServer(child, variant, timeoutMs);
    timings.startMs = elapsed(started);

    child.stdin.write('playing\n');
    child.stdin.write('save\n');
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    started = Date.now();
    const backup = path.join(root, 'terraria-smoke-backup.zip');
    await zipDirectory(destination, backup);
    assert(fs.statSync(backup).size > 0, 'The smoke backup is empty');
    timings.backupMs = elapsed(started);

    started = Date.now();
    child.stdin.write('exit\n');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Terraria did not stop cleanly')), 30_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`Terraria stopped with exit code ${code}`));
      });
    });
    child = null;
    timings.stopMs = elapsed(started);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      variant,
      version: runtime.version,
      command: 'playing',
      backupBytes: fs.statSync(backup).size,
      timings,
    }, null, 2)}\n`);
  } finally {
    if (child && !child.killed) child.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Terraria smoke check failed: ${error.message}`);
  process.exitCode = 1;
});
