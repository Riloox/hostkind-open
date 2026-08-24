'use strict';

const fs = require('fs');
const platform = require('../../palworld-platform.cjs');
const {
  createPalworldAdapter,
  normalizePlayers,
  normalizeStatus,
  initialHealth,
  healthFromError,
  healthy,
} = require('./adapter.cjs');
const { createLogTailer, logPath, parseLogLine } = require('./logfile.cjs');

const POLL_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;

function createPalworldModule(deps = {}) {
  const adapter = createPalworldAdapter(deps.palworldAdapter || {});
  // Test seam mirroring terraria's dotnetRoots: the start() wine/headless
  // gates consult the HOST platform, and tests fabricating a Windows install
  // must be able to pin it instead of inheriting the real process.platform
  // (which made them pass on Windows and fail on Linux CI).
  const hostOf = typeof deps.hostPlatform === 'function' ? deps.hostPlatform : platform.hostPlatform;
  // The panel's own name for anything the game server itself may show (the
  // shutdown notice), derived from config so a branded install does not name
  // itself under the stock product.
  const panelName = () => (typeof deps.getConfig === 'function'
    ? (deps.getConfig().appName || 'Hostkind')
    : 'Hostkind');

  async function request(manager, method, endpoint, body) {
    return adapter.request(manager.desc(), method, endpoint, body);
  }

  /*
   * Tail Pal.log into the panel console. The tailer starts at the file's
   * current end, so a restart never replays the previous session; lines are
   * normalized (UE timestamp prefix stripped, Error/Warning classified) and
   * pushed through the manager's normal pipeline (redaction, dedupe, history,
   * broadcast). The tailer object is parked on moduleState so a later
   * resetState/onExit can stop it.
   */
  function startLogTail(manager, { pollMs } = {}) {
    if (manager.moduleState.logTailer) return;
    const desc = manager.desc();
    const cwd = String(desc.cwd || desc.dir || '').trim();
    if (!cwd) return;
    const tailer = createLogTailer({
      file: logPath(cwd),
      pollMs: pollMs || 500,
      onLine: (line) => {
        const parsed = parseLogLine(line);
        if (parsed) manager.pushLine(parsed.text, parsed.level);
      },
    });
    manager.moduleState.logTailer = tailer;
    tailer.start();
  }

  function stopLogTail(manager) {
    const tailer = manager.moduleState.logTailer;
    if (tailer) tailer.stop();
    delete manager.moduleState.logTailer;
  }

  async function refresh(manager) {
    if (manager.moduleState.refreshPromise) return manager.moduleState.refreshPromise;
    manager.moduleState.refreshPromise = (async () => {
      const sampledAt = new Date().toISOString();
      try {
        const [info, metrics, players] = await Promise.all([
          request(manager, 'GET', '/info'),
          request(manager, 'GET', '/metrics'),
          request(manager, 'GET', '/players'),
        ]);
        const normalizedPlayers = normalizePlayers(players, sampledAt);
        const currentIds = new Set(normalizedPlayers.map((player) => player.userId));
        const departedAt = Date.now();
        const newlyDeparted = (manager.moduleState.players || [])
          .filter((player) => !currentIds.has(player.userId))
          .map((player) => ({ ...player, departedAt }));
        manager.moduleState.departedPlayers = [
          ...newlyDeparted,
          ...(manager.moduleState.departedPlayers || []).filter(
            (player) => !currentIds.has(player.userId) && departedAt - player.departedAt < 30_000,
          ),
        ].slice(0, 64);
        manager.moduleState.restHealth = healthy(manager.moduleState.restHealth, sampledAt);
        manager.moduleState.players = normalizedPlayers;
        manager.moduleState.normalizedStatus = normalizeStatus(
          info,
          metrics,
          normalizedPlayers,
          manager.moduleState.restHealth,
          sampledAt,
        );
        manager.moduleState.failures = 0;
        // On Windows the server writes its console to its own window, so the
        // "Running Palworld dedicated server" line never reaches our pipe; a
        // healthy REST answer is the only proof the process is really up.
        if (manager.status === 'starting') manager.setStatus('online');
      } catch (err) {
        manager.moduleState.failures = (manager.moduleState.failures || 0) + 1;
        manager.moduleState.restHealth = healthFromError(err, manager.moduleState.restHealth, sampledAt);
        manager.moduleState.normalizedStatus = {
          ...(manager.moduleState.normalizedStatus || {}),
          adapterVersion: adapter.version,
          restHealth: manager.moduleState.restHealth,
          sampledAt,
        };
      }
      manager.broadcast({ type: 'status', status: manager.statusPayload() });
      return manager.moduleState.normalizedStatus;
    })();
    try {
      return await manager.moduleState.refreshPromise;
    } finally {
      manager.moduleState.refreshPromise = null;
    }
  }

  function scheduleRefresh(manager) {
    if (manager.moduleState.restTimer || (manager.status !== 'online' && manager.status !== 'starting')) return;
    const failures = manager.moduleState.failures || 0;
    const backoff = Math.min(MAX_BACKOFF_MS, POLL_INTERVAL_MS * (2 ** Math.min(failures, 3)));
    const jitter = failures ? Math.floor(backoff * 0.1 * Math.random()) : 0;
    manager.moduleState.restTimer = setTimeout(async () => {
      manager.moduleState.restTimer = null;
      await refresh(manager);
      scheduleRefresh(manager);
    }, backoff + jitter);
  }

  return {
    id: 'palworld',
    capabilities: ['console', 'configs', 'files', 'backups', 'schedules', 'metrics', 'watchdog', 'rest-api', 'players', 'announcements', 'map', 'palworld-map', 'updates', 'palworld-updates', 'addons', 'palworld-mods'],
    metadata: {
      automaticInstallHosts: ['win32', 'linux'],
      manualRegistration: true,
      creationAvailable: ['win32', 'linux'].includes(process.platform),
    },
    start(manager) {
      const desc = manager.desc();
      const cwd = String(desc.cwd || desc.dir || '').trim();
      if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return { ok: false, error: `Working directory not found: ${cwd}` };
      }
      if (!desc.executable || !fs.existsSync(desc.executable)) {
        return { ok: false, error: 'Palworld server executable was not found' };
      }
      // Host and target are modelled separately: a Windows-target server on a
      // Linux host only launches through an explicitly configured Wine runtime,
      // which Hostkind spawns directly (never through a shell).
      const target = platform.targetPlatform(desc);
      const host = hostOf();
      const wine = platform.safeWine(desc.palworldWine);
      if (target === 'windows' && host === 'linux' && !wine.enabled) {
        return { ok: false, error: 'This server targets Windows. Configure a Wine runtime for it before starting it on a Linux host.' };
      }
      if (target === 'linux' && host === 'windows') {
        return { ok: false, error: 'A Linux-target Palworld server cannot run on a Windows host.' };
      }
      const plan = platform.launchPlan({
        executable: desc.executable,
        args: Array.isArray(desc.args) ? desc.args : [],
        wine: desc.palworldWine,
        host,
        target,
      });
      // On native Windows, the registered executable is the launcher
      // (PalServer.exe), which spawns the real server as a grandchild that
      // allocates its own console window - the window that pops up and the
      // reason the stdout pipe stays empty. Launch the inner server binary
      // (console subsystem, so CREATE_NO_WINDOW suppresses its window) with
      // the UE project name as the first argument, exactly as the launcher
      // would have. Falls back to the launcher if the inner binary is absent.
      let bin = plan.bin;
      let args = plan.args;
      if (host === 'windows' && target === 'windows') {
        const inner = platform.innerServerBinary(desc.executable);
        if (inner && fs.existsSync(inner)) {
          bin = inner;
          args = ['Pal', ...plan.args];
        }
      }
      // UE only writes Pal/Saved/Logs/Pal.log when launched with `-log`; the
      // in-app console is fed from that file on Windows, so the flag must be
      // present no matter how the server was registered.
      if (!args.includes('-log')) args = [...args, '-log'];
      const launched = manager._launch(bin, args, { env: plan.env });
      // The REST poll is what proves readiness when the console line never
      // arrives (Windows), so start it as soon as the process is launched
      // rather than waiting for a map/players screen to touch the API.
      refresh(manager);
      scheduleRefresh(manager);
      // Feed the in-app console from Pal.log on Windows targets (native and
      // Wine), where the engine writes to its own console instead of stdout.
      // On native Linux stdout already works, so tailing would duplicate.
      if (target === 'windows' && launched && launched.ok !== false) {
        startLogTail(manager, { pollMs: deps.logPollMs });
      }
      return launched;
    },
    preLaunch() { return { ok: true }; },
    resetState(manager) {
      stopLogTail(manager);
      if (manager.moduleState.restTimer) clearTimeout(manager.moduleState.restTimer);
      const desc = manager.desc();
      manager.moduleState = {
        players: [],
        departedPlayers: [],
        failures: 0,
        restHealth: initialHealth(!!desc.adminPassword && !!desc.restPort),
        normalizedStatus: null,
      };
    },
    detectOnline(line) {
      return /LogHttp: Display: Http server started|LogPal: Display:.*(?:Listening|started)|Running Palworld dedicated server on\s+:/i.test(String(line || ''));
    },
    onOnline(manager) {
      refresh(manager);
      scheduleRefresh(manager);
    },
    onExit(manager) {
      stopLogTail(manager);
      if (manager.moduleState.restTimer) clearTimeout(manager.moduleState.restTimer);
      manager.moduleState.restTimer = null;
      manager.moduleState.restHealth = healthFromError(
        { state: 'unavailable', code: 'process_offline' },
        manager.moduleState.restHealth,
      );
    },
    buildStopSequence(manager) {
      return {
        execute: async () => {
          if (manager.moduleState.restTimer) {
            clearTimeout(manager.moduleState.restTimer);
            manager.moduleState.restTimer = null;
          }
          await request(manager, 'POST', '/shutdown', {
            waittime: 1,
            message: `${panelName()} requested shutdown`,
          });
          manager.pushLine('[Hostkind] Palworld accepted the shutdown request.', 'info');
        },
      };
    },
    statusFields(manager) {
      const state = manager.moduleState || {};
      const status = state.normalizedStatus || {};
      const health = state.restHealth || initialHealth(false);
      return {
        ...status,
        restHealth: health,
        restAvailable: health.state === 'healthy',
        restError: health.state === 'healthy' ? null : health.state,
        maxPlayers: status.maxPlayers ?? (Number(manager.desc().maxPlayers) || 0),
      };
    },
    listPlayers(manager) {
      return [...(manager.moduleState.players || [])];
    },
    listDepartedPlayers(manager) {
      return [...(manager.moduleState.departedPlayers || [])];
    },
    async mutate(manager, action, body) {
      const result = await request(manager, 'POST', `/${action}`, body);
      return { ok: true, result: result && typeof result === 'object' && !Array.isArray(result) ? { accepted: true } : null };
    },
    async backupPrepare(manager) {
      if (manager.status !== 'online') return null;
      await request(manager, 'POST', '/save');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return { saved: true };
    },
    backupSelection() { return ['Pal/Saved']; },
    request,
    refresh,
    adapterVersion: adapter.version,
  };
}

module.exports = createPalworldModule;
