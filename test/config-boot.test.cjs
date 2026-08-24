'use strict';

/*
 * A bare boot with no config anywhere (fresh clone, the open edition which
 * git-ignores config.json, a packaged install, or CI): server.js must
 * materialise config.json from the shipped config.example.json template
 * instead of crashing, and rotate the placeholder jwtSecret before it signs
 * anything.
 *
 * Regression test for the DAST (ZAP) workflow, which boots `node server.js`
 * on a fresh checkout and previously died on ENOENT.
 *
 * The config is written synchronously during module load, before the panel
 * binds its port, so this test needs no free port: whether the child goes on
 * to bind 127.0.0.1:2121, hits EADDRINUSE, or is killed by us, the file must
 * already exist with the rotated secret by the time we assert on it.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT, 'server.js');
const TEMPLATE = path.join(ROOT, 'config.example.json');
const template = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-noconfig-'));
const configPath = path.join(tmp, 'config.json');
fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let failed = 0;
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, FLEETDECK_CONFIG: configPath, FLEETDECK_DATA_DIR: path.join(tmp, 'data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });

  try {
    // 1. the boot log announces the materialisation.
    const deadline = Date.now() + 10_000;
    while (stdout.indexOf('no config at') === -1 && Date.now() < deadline) await sleep(50);
    assert.ok(stdout.includes('no config at'),
      'boot must announce the missing config and its creation\n' + stdout + stderr);

    // 2. the config file now exists, copied from the template.
    assert.ok(fs.existsSync(configPath), `config.json should have been created at ${configPath}`);

    // 3. the placeholder secret was rotated before anything could be signed.
    // The child writes the template, then rotates the secret, in two separate
    // synchronous writes. The 'no config at' line above is emitted before the
    // first write lands, so a single read here can catch the placeholder in
    // the gap between the two writes (seen on loaded Linux CI runners). Poll
    // the file until the rotation lands instead of asserting on first read.
    const rotDeadline = Date.now() + 10_000;
    let config;
    while (Date.now() < rotDeadline) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (typeof config.jwtSecret === 'string' &&
          config.jwtSecret !== template.jwtSecret &&
          config.jwtSecret.length >= 32) break;
      await sleep(50);
    }
    assert.strictEqual(config.appName, template.appName, 'template fields carried over');
    assert.strictEqual(config.panelPort, template.panelPort, 'template fields carried over');
    assert.notStrictEqual(config.jwtSecret, template.jwtSecret,
      'placeholder jwtSecret must be regenerated on first boot');
    assert.ok(typeof config.jwtSecret === 'string' && config.jwtSecret.length >= 32,
      'rotated jwtSecret must meet the length floor');

    // 4. nothing on the boot path died from the missing config.
    assert.ok(!/ENOENT/.test(stderr), 'no ENOENT on the boot path\n' + stderr);
  } catch (e) {
    failed++;
    console.error(`FAIL  config-boot: ${e.message}\n${e.stack}`);
  } finally {
    child.kill();
    await Promise.race([
      new Promise((r) => child.once('exit', r)),
      sleep(2000),
    ]);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* */ }
  }

  if (failed) { process.exit(1); }
  console.log('PASS  config-boot');
}

main();