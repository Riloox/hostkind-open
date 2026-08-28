'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_ENTRY = path.join(ROOT, 'electron', 'main.cjs');
const PACKAGED_EXE = process.env.HOSTKIND_PACKAGED_EXE ||
  path.join(ROOT, 'dist-electron', 'win-unpacked', 'Hostkind.exe');
const PACKAGED_ASAR = path.join(ROOT, 'dist-electron', 'win-unpacked', 'resources', 'app.asar');
const PACKAGED_MODE = process.argv.includes('--packaged');
const PACKAGED_ASAR_MODE = process.argv.includes('--packaged-asar');
const TIMEOUT_MS = 90000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonIfReady(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function stopProcessTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    try { child.kill('SIGTERM'); } catch { /* already stopped */ }
  }
}

async function waitForReady(child, readyFile) {
  const deadline = Date.now() + TIMEOUT_MS;
  let childExit = null;
  child.once('exit', (code, signal) => { childExit = { code, signal }; });

  while (Date.now() < deadline) {
    const marker = readJsonIfReady(readyFile);
    if (marker) return marker;
    if (childExit) {
      throw new Error(`Electron exited before readiness (code=${childExit.code}, signal=${childExit.signal})`);
    }
    await sleep(100);
  }

  throw new Error(`Timed out after ${TIMEOUT_MS}ms waiting for ${readyFile}`);
}

async function run() {
  const executable = PACKAGED_ASAR_MODE ? require('electron') :
    (PACKAGED_MODE ? PACKAGED_EXE : require('electron'));
  const args = PACKAGED_ASAR_MODE ? [PACKAGED_ASAR, '--hostkind-smoke'] :
    (PACKAGED_MODE ? ['--hostkind-smoke'] : [ELECTRON_ENTRY, '--hostkind-smoke']);
  const expectedEntry = PACKAGED_ASAR_MODE ? PACKAGED_ASAR :
    (PACKAGED_MODE ? PACKAGED_EXE : ELECTRON_ENTRY);
  if (!fs.existsSync(expectedEntry)) {
    throw new Error(`Missing desktop smoke target: ${expectedEntry}`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-desktop-smoke-'));
  const readyFile = path.join(tempRoot, 'ready.json');
  const userData = path.join(tempRoot, 'user-data');
  const child = spawn(executable, args, {
    cwd: ROOT,
    env: {
      ...process.env,
      HOSTKIND_SMOKE: '1',
      HOSTKIND_READY_FILE: readyFile,
      HOSTKIND_USER_DATA: userData,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  let stdout = '';
  if (child.stdout) {
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(-8000);
    });
  }
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-8000);
    });
  }

  let passed = false;
  try {
    const marker = await waitForReady(child, readyFile);
    if (!marker.ok) {
      throw new Error(`Desktop bootstrap reported failure: ${marker.error || 'unknown error'}`);
    }
    if (marker.host !== '127.0.0.1') {
      throw new Error(`Desktop smoke escaped loopback: ${marker.host}`);
    }
    if (marker.authRequired !== false) {
      throw new Error('Fresh desktop smoke profile did not boot authless');
    }

    const response = await fetch(`${marker.origin}/api/auth-mode`);
    if (!response.ok) {
      throw new Error(`Auth-mode probe returned HTTP ${response.status}`);
    }
    const authMode = await response.json();
    if (authMode.authRequired !== false) {
      throw new Error('Auth-mode endpoint did not report authless desktop mode');
    }

    // The foundation boot is intentionally best-effort, so auth-mode alone can
    // pass even when Electron cannot load better-sqlite3. Probe the same read
    // path used by the Audit view so a native-addon mismatch fails the smoke
    // test instead of reaching users as a delayed toast.
    const auditResponse = await fetch(`${marker.origin}/api/audit?limit=1`);
    if (!auditResponse.ok) {
      const body = await auditResponse.text();
      throw new Error(`Audit probe returned HTTP ${auditResponse.status}: ${body}`);
    }
    const auditBody = await auditResponse.json();
    if (!auditBody || !Array.isArray(auditBody.items)) {
      throw new Error('Audit probe returned an invalid response');
    }

    console.log(`PASS desktop-smoke (${marker.origin})`);
    passed = true;
  } catch (error) {
    const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
    const detail = output.slice(-16000);
    throw new Error(detail ? `${error.message}\n${detail}` : error.message);
  } finally {
    stopProcessTree(child);
    if (passed) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
          break;
        } catch (error) {
          if (attempt === 4) {
            console.warn(`desktop-smoke could not remove temporary diagnostics at ${tempRoot}: ${error.message}`);
          } else {
            await sleep(200);
          }
        }
      }
    } else {
      console.error(`desktop-smoke retained diagnostics at ${tempRoot}`);
    }
  }
}

run().catch((error) => {
  console.error(`desktop-smoke failed: ${error.message}`);
  process.exitCode = 1;
});
