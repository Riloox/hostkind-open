'use strict';

/*
 * Configs created before the public relay existed never delivered a report:
 * the private template shipped a placeholder host and the open edition shipped
 * relayUrl: null. Booting server.js must point both at the public relay, and
 * must leave an operator's own relay URL alone.
 *
 * Like config-boot, the migration runs synchronously during module load, so
 * the child is killed as soon as the file reflects the expected value.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT, 'server.js');
const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
const PUBLIC_RELAY = 'https://bugs.hostkind.site/v1/reports';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bootWith(relayUrl) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-relay-migration-'));
  const configPath = path.join(tmp, 'config.json');
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  const config = {
    ...template,
    jwtSecret: 'x'.repeat(64),
    bugReports: { ...template.bugReports, mode: 'upstream-relay', relayUrl },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: { ...process.env, FLEETDECK_CONFIG: configPath, FLEETDECK_DATA_DIR: path.join(tmp, 'data') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stdout += c; });
  try {
    // The migration (or its absence) is settled once the panel logs past
    // config loading; poll for either the rewrite or the first boot output.
    const deadline = Date.now() + 10_000;
    let current = relayUrl;
    while (Date.now() < deadline) {
      current = JSON.parse(fs.readFileSync(configPath, 'utf8')).bugReports.relayUrl;
      if (current !== relayUrl || /foundation|listening|EADDRINUSE/i.test(stdout)) break;
      await sleep(50);
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf8')).bugReports.relayUrl;
  } finally {
    child.kill();
    await Promise.race([new Promise((r) => child.once('exit', r)), sleep(2000)]);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* */ }
  }
}

async function main() {
  let failed = 0;
  const cases = [
    ['private placeholder host', 'https://reports.example.com/v1/reports', PUBLIC_RELAY],
    ['open edition null url', null, PUBLIC_RELAY],
    ['operator relay kept', 'https://relay.example.org/v1/reports', 'https://relay.example.org/v1/reports'],
  ];
  for (const [name, input, expected] of cases) {
    try {
      assert.strictEqual(await bootWith(input), expected);
      console.log(`ok  relay-migration: ${name}`);
    } catch (e) {
      failed++;
      console.error(`FAIL  relay-migration: ${name}: ${e.message}`);
    }
  }
  if (failed) process.exit(1);
  console.log('PASS  bug-report-relay-migration');
}

main();
