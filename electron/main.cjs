'use strict';

/*
 * Hostkind desktop entry point (Electron .exe release plan, Task 2).
 *
 * The Electron main process:
 *   1. takes a single-instance lock (a second launch focuses the window);
 *   2. points Electron's userData at HOSTKIND_USER_DATA before ready when the
 *      smoke harness asks for isolation;
 *   3. resolves per-user paths, allocates a free loopback port, materialises
 *      the desktop config (authless on 127.0.0.1 for a fresh profile), and
 *      starts the existing server.js backend in Electron's own
 *      utilityProcess - never through a system node or a shell;
 *   4. polls /api/auth-mode before showing anything, failing a fresh profile
 *      that did not boot authless;
 *   5. serves the panel in a hardened BrowserWindow (contextIsolation,
 *      sandbox, no preload, loopback-only navigation, validated external
 *      links via shell.openExternal);
 *   6. in --hostkind-smoke / HOSTKIND_SMOKE=1 mode skips the window, writes a
 *      machine-readable ready marker, and stays alive until the harness ends
 *      it so the smoke script can exercise HTTP and WebSocket endpoints.
 *
 * Electron is required lazily: requiring this module from plain Node (the
 * focused runtime tests, node --check) must not start or load Electron.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const rt = require('./runtime.cjs');

// Mirrors lib/application-update-runtime.cjs (DESKTOP_RUN_INSTALLER*).
const RUN_INSTALLER = 'hostkind:update:run-installer';
const RUN_INSTALLER_RESULT = 'hostkind:update:run-installer:result';
// Lets the backend's HTTP reply reach the panel before the app quits.
const QUIT_FOR_UPDATE_DELAY_MS = 1500;

let _electron = null;
function electron() {
  if (!_electron) _electron = require('electron');
  return _electron;
}

const SMOKE_FLAG = '--hostkind-smoke';

/**
 * Smoke mode is recognised from the CLI flag or the environment. It is a
 * test-only path: no visible window is required, readiness is published as a
 * machine-readable marker, and the process stays alive until the harness
 * terminates it.
 */
function isSmokeMode(argv = process.argv, env = process.env) {
  return (Array.isArray(argv) && argv.includes(SMOKE_FLAG)) || env.HOSTKIND_SMOKE === '1';
}

/** http://127.0.0.1:<port> - the only origin the window may ever load. */
function buildOrigin(host, port) {
  return `http://${host}:${port}`;
}

/**
 * Atomic JSON marker write (temp file + rename): the smoke harness polls the
 * target path and must never observe a partial file.
 */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

let logPathHolder = '';
function writeLog(text) {
  const line = `[${new Date().toISOString()}] ${text}`;
  if (logPathHolder) {
    try { fs.appendFileSync(logPathHolder, `${line}\n`, 'utf8'); } catch { /* logging must never crash the app */ }
  }
}

function captureTail(text, cap = 8000) {
  if (text.length <= cap) return text;
  return text.slice(text.length - cap);
}

/**
 * Electron reports the directory containing an explicitly launched entry file
 * as appPath during source development (`...\\electron`). Packaged builds
 * report the application root (`...\\resources\\app.asar`). Normalize both
 * shapes before resolving config, backend, and resource paths.
 */
function applicationRoot(app) {
  const appPath = app.getAppPath();
  const sourceRoot = path.dirname(appPath);
  if (
    path.basename(appPath).toLowerCase() === 'electron' &&
    fs.existsSync(path.join(sourceRoot, 'server.js'))
  ) {
    return sourceRoot;
  }
  return appPath;
}

/**
 * The backend child's working directory. In development app.getAppPath() is
 * the electron entry directory when the entry is launched explicitly. In a
 * packaged build it is resources/app.asar, a virtual filesystem that cannot
 * be a real process cwd, so fall back to the real resources/ directory.
 */
function backendCwd(app) {
  const appDir = applicationRoot(app);
  if (String(appDir).toLowerCase().endsWith('.asar')) return path.dirname(appDir);
  return appDir;
}

/** True when `url` is the exact local panel origin (any path on it). */
function isLocalPanelUrl(url, origin) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  return `${parsed.protocol}//${parsed.host}` === origin;
}

/**
 * Startup-failure path: log, kill the backend if one was started, show a
 * native error dialog naming the log file (normal mode), then exit cleanly.
 */
async function failStartup({ app, backend, message, detail }, state) {
  if (state.fatalShown) return;
  state.fatalShown = true;
  writeLog(`FATAL ${message}${detail ? ` :: ${detail}` : ''}`);
  try { if (backend) backend.kill(); } catch { /* already gone */ }
  const e = electron();
  if (isSmokeMode()) {
    const readyFile = process.env.HOSTKIND_READY_FILE;
    if (readyFile) {
      try {
        writeJsonAtomic(readyFile, {
          ok: false,
          error: message,
          detail: detail || null,
          pid: process.pid,
          time: new Date().toISOString(),
        });
      } catch { /* best effort */ }
    }
  } else {
    try {
      await e.dialog.showMessageBox({
        type: 'error',
        title: 'Hostkind could not start',
        message,
        detail: `${detail || ''}\n\nLog file: ${logPathHolder}`,
        buttons: ['Quit'],
        defaultId: 0,
        noLink: true,
      });
    } catch { /* dialog unavailable; exit anyway */ }
  }
  app.exit(1);
}

/**
 * Start the installer through ShellExecute. The per-machine Setup.exe is
 * marked requireAdministrator, so CreateProcess (child_process.spawn) fails
 * with EACCES from this non-elevated app; Start-Process raises the UAC prompt
 * instead. PowerShell exits 0 once the installer is running and non-zero when
 * the prompt is declined. The path travels in an environment variable so it
 * never has to be quoted into the command line.
 */
function launchElevatedInstaller(installerPath) {
  return new Promise((resolve, reject) => {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      "Start-Process -FilePath $env:HOSTKIND_UPDATE_INSTALLER -ArgumentList '--updated' -ErrorAction Stop",
    ], {
      env: { ...process.env, HOSTKIND_UPDATE_INSTALLER: installerPath },
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error('the installer did not start (the administrator prompt was declined or failed)'));
    });
  });
}

/**
 * In-app update install: the backend has downloaded and verified the NSIS
 * Setup.exe into the user's update folder. Re-validate it here, launch it
 * elevated (NSIS relaunches Hostkind when done), confirm to the backend, then
 * quit so NSIS can replace the files. A refusal, a declined UAC prompt or a
 * launch failure is reported back and the app stays up.
 */
async function runUpdateInstaller({ app, backend, message, stagingDir }, state) {
  const reply = (ok, error) => {
    try { backend.postMessage({ type: RUN_INSTALLER_RESULT, id: message.id, ok, error: error || null }); } catch { /* backend gone */ }
  };
  if (state.installingUpdate) return reply(false, 'an update installation is already starting');
  let installerPath;
  try {
    installerPath = await rt.validateInstallerRequest({ message, stagingDir });
  } catch (err) {
    writeLog(`refused update installer request: ${err.message}`);
    return reply(false, err.message);
  }
  state.installingUpdate = true;
  writeLog(`launching update installer ${installerPath} (version ${message.version || 'unknown'})`);
  try {
    await launchElevatedInstaller(installerPath);
  } catch (err) {
    state.installingUpdate = false;
    writeLog(`update installer launch failed: ${err.message}`);
    return reply(false, err.message);
  }
  reply(true);
  setTimeout(() => app.quit(), QUIT_FOR_UPDATE_DELAY_MS);
}

/**
 * The whole desktop bootstrap. Exported separately (and only run through
 * Electron) so the module stays require-safe under plain Node.
 */
async function bootstrap(app, e, state) {
  // --- paths -----------------------------------------------------------
  let localData;
  try {
    localData = process.env.LOCALAPPDATA || app.getPath('cache');
  } catch { localData = app.getPath('cache'); }
  let documents;
  try {
    documents = app.getPath('documents');
  } catch {
    documents = path.join(app.getPath('home'), 'Documents');
  }
  const paths = rt.resolveDesktopPaths({
    userData: app.getPath('userData'),
    localData,
    documents,
  });

  // --- mutable directories ---------------------------------------------
  const dirs = [
    path.dirname(paths.configPath),
    paths.dataDir,
    paths.logDir,
    paths.installerCache,
    paths.runtimesDir,
    paths.updateStagingDir,
    paths.serverDir,
    paths.backupsDir,
  ];
  for (const dir of dirs) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {
      return failStartup({ app, backend: null, message: `Could not create data directory ${dir}`, detail: err.message }, state);
    }
  }

  logPathHolder = path.join(paths.logDir, 'desktop.log');
  writeLog(`Hostkind desktop boot (pid ${process.pid}, smoke=${isSmokeMode()})`);
  writeLog(`paths: ${JSON.stringify(paths)}`);

  // --- free loopback port + desktop config -----------------------------
  let port;
  try {
    port = await rt.findFreeLoopbackPort();
  } catch (err) {
    return failStartup({ app, backend: null, message: 'Could not allocate a free loopback port', detail: err.message }, state);
  }
  writeLog(`selected loopback port ${port}`);

  let configResult;
  try {
    configResult = await rt.ensureDesktopConfig({
      configPath: paths.configPath,
      templatePath: path.join(applicationRoot(app), 'config.example.json'),
      port,
      paths,
      fsImpl: fs,
    });
  } catch (err) {
    return failStartup({ app, backend: null, message: 'Could not prepare the Hostkind config', detail: err.message }, state);
  }
  const freshConfig = configResult.created;
  writeLog(`desktop config ready (created=${configResult.created}, changed=${configResult.changed}) at ${paths.configPath}`);

  // --- backend child ----------------------------------------------------
  const origin = buildOrigin(rt.LOOPBACK_HOST, port);
  const backendEnv = { ...process.env, ...rt.desktopEnvironment({ paths, configPath: paths.configPath, packaged: app.isPackaged }) };
  let backend = null;
  try {
    backend = e.utilityProcess.fork(
      path.join(applicationRoot(app), 'server.js'),
      [],
      {
        cwd: backendCwd(app),
        env: backendEnv,
        stdio: 'pipe',
        serviceName: 'Hostkind backend',
      }
    );
  } catch (err) {
    return failStartup({ app, backend: null, message: 'Could not start the Hostkind backend', detail: err.message }, state);
  }
  state.backend = backend;

  let stderrTail = '';
  if (backend.stdout) {
    backend.stdout.on('data', (chunk) => {
      writeLog(`[backend] ${String(chunk).replace(/\s+$/, '')}`);
    });
  }
  if (backend.stderr) {
    backend.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderrTail = captureTail(stderrTail + text);
      writeLog(`[backend stderr] ${text.replace(/\s+$/, '')}`);
    });
  }

  // A backend that dies before readiness must fail startup (waitForPanel
  // rejects on 'exit'; this listener also covers the post-readiness case).
  backend.on('message', (message) => {
    if (message && message.type === RUN_INSTALLER) {
      runUpdateInstaller({ app, backend, message, stagingDir: paths.updateStagingDir }, state);
    }
  });

  backend.on('exit', (code) => {
    if (state.backendKilled) return;
    writeLog(`backend exited unexpectedly (code ${code})`);
    if (state.readied) {
      if (!state.fatalShown) {
        state.fatalShown = true;
        const msg = `The Hostkind backend stopped unexpectedly (exit code ${code}).\n\nLog file: ${logPathHolder}`;
        if (isSmokeMode()) {
          const readyFile = process.env.HOSTKIND_READY_FILE;
          if (readyFile) { try { writeJsonAtomic(readyFile, { ok: false, error: msg, pid: process.pid, time: new Date().toISOString() }); } catch { /* */ } }
          app.quit();
        } else {
          e.dialog.showMessageBox({ type: 'error', title: 'Hostkind backend stopped', message: msg, buttons: ['Quit'], noLink: true })
            .then(() => app.quit())
            .catch(() => app.quit());
        }
      }
    }
  });

  // --- readiness gate ----------------------------------------------------
  let authMode;
  try {
    authMode = await rt.waitForPanel({ origin, child: backend, timeoutMs: 90000, fetchImpl: globalThis.fetch });
  } catch (err) {
    return failStartup({
      app,
      backend,
      message: 'The Hostkind backend did not become ready',
      detail: `${err.message}${stderrTail ? `\n\nBackend output:\n${stderrTail}` : ''}`,
    }, state);
  }
  state.readied = true;
  writeLog(`panel ready: ${JSON.stringify(authMode)}`);

  // A fresh desktop profile must boot authless; anything else is a broken
  // bootstrap and must not show the window.
  if (freshConfig && authMode.authRequired !== false) {
    return failStartup({
      app,
      backend,
      message: 'Refusing to start: a fresh desktop install must boot without authentication',
      detail: `auth-mode reported authRequired=${authMode.authRequired} on first launch. Check ${paths.configPath} and the log file.`,
    }, state);
  }

  // --- smoke mode: publish readiness, no window, stay alive --------------
  if (isSmokeMode()) {
    const marker = {
      ok: true,
      app: 'Hostkind',
      pid: process.pid,
      origin,
      host: rt.LOOPBACK_HOST,
      port,
      authRequired: authMode.authRequired !== false,
      configPath: paths.configPath,
      paths: { ...paths },
      logPath: logPathHolder,
      readyAt: new Date().toISOString(),
    };
    const readyFile = process.env.HOSTKIND_READY_FILE;
    if (readyFile) {
      try {
        writeJsonAtomic(readyFile, marker);
        writeLog(`ready marker written to ${readyFile}`);
      } catch (err) {
        return failStartup({ app, backend, message: 'Could not write the smoke ready marker', detail: err.message }, state);
      }
    }
    console.log(`HOSTKIND_READY ${JSON.stringify(marker)}`);
    writeLog(`HOSTKIND_READY ${JSON.stringify(marker)}`);
    // No window in smoke mode: the process stays alive until the smoke
    // harness terminates it so it can exercise HTTP and WebSocket endpoints.
    return;
  }

  // --- window -------------------------------------------------------------
  const win = new e.BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'Hostkind',
    icon: path.join(__dirname, '..', 'resources', 'hostkind-icon.png'),
    backgroundColor: '#0b0f14',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: undefined,
      webSecurity: true,
    },
  });
  state.mainWindow = win;
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { state.mainWindow = null; });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isLocalPanelUrl(url, origin)) {
      writeLog(`blocked navigation to ${url}`);
      event.preventDefault();
    }
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isLocalPanelUrl(url, origin)) {
      writeLog(`blocked redirect to ${url}`);
      event.preventDefault();
    }
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      // Validated scheme only (never file:, javascript:, data:); the OS
      // default browser handles it and no in-app window is created.
      e.shell.openExternal(url).catch((err) => writeLog(`openExternal failed for ${url}: ${err.message}`));
    }
    return { action: 'deny' };
  });
  win.loadURL(origin).catch((err) => {
    failStartup({ app, backend, message: 'Could not load the Hostkind panel', detail: err.message }, state);
  });
}

module.exports = {
  isSmokeMode,
  buildOrigin,
  writeJsonAtomic,
  backendCwd,
  isLocalPanelUrl,
  bootstrap,
};

// Electron loads the configured app entry through its browser module rather
// than making that file `require.main`. Use the process identity instead, so
// Electron 43+ actually runs the lifecycle while plain Node stays require-safe.
if (process.versions && process.versions.electron && process.type === 'browser') {
  const { app } = electron();

  // Smoke isolation: relocate Electron's userData before the app is ready so
  // a harness run never touches the real profile.
  if (process.env.HOSTKIND_USER_DATA) {
    try {
      app.setPath('userData', process.env.HOSTKIND_USER_DATA);
    } catch (err) {
      console.error(`could not set userData to ${process.env.HOSTKIND_USER_DATA}: ${err.message}`);
    }
  }

  // Single instance: a second launch focuses the existing window instead of
  // starting a second backend or using a second config.
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    const state = { mainWindow: null, backend: null, readied: false, fatalShown: false, installingUpdate: false };
    app.on('second-instance', () => {
      if (state.mainWindow) {
        if (state.mainWindow.isMinimized()) state.mainWindow.restore();
        state.mainWindow.focus();
      }
    });
    app.on('window-all-closed', () => {
      if (!isSmokeMode()) app.quit();
    });
    // On quit, stop only the backend child. server.js's own shutdown keeps
    // intentionally running managed game processes alive; killing the child
    // never touches them, so re-launching Hostkind re-adopts them.
    app.on('before-quit', () => {
      if (state.backend && !state.backendKilled) {
        state.backendKilled = true;
        try { state.backend.kill(); } catch (err) { writeLog(`backend kill failed: ${err.message}`); }
      }
    });
    app.whenReady()
      .then(() => bootstrap(app, electron(), state))
      .catch((err) => failStartup({ app, backend: state.backend, message: 'Unexpected desktop startup error', detail: err && (err.stack || err.message) }, state));
  }
}