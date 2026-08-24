'use strict';

const fs = require('fs');
const path = require('path');

// The Minecraft server module. Everything here used to live directly inside
// ServerManager; it's extracted so ServerManager can supervise any kind of
// process while Minecraft servers keep behaving exactly as before.
//
// `deps` is injected by server.js at startup (see the `createRegistry(...)`
// call near the ServerManager class) rather than required directly, because
// these helpers close over server.js's module-level `config`/`saveConfig`
// state and are easiest to keep in one place.
function createMinecraftModule(deps) {
  const {
    requiredJavaMajor,
    jarJavaMajor,
    resolveJavaForServer,
    ensureRuntime,
    readServerBind,
    probePortInUse,
    eKey,
    getConfig,
    notifyDiscord,
  } = deps;

  function ensureState(manager) {
    const st = manager.moduleState || (manager.moduleState = {});
    if (!(st.players instanceof Set)) st.players = new Set();
    if (st.maxPlayers == null) st.maxPlayers = 0;
    if (st.tpsSupported === undefined) st.tpsSupported = null;
    if (st.lastTps === undefined) st.lastTps = null;
    return st;
  }

  return {
    id: 'minecraft',
    capabilities: ['console', 'players', 'addons', 'content-install', 'worlds', 'map', 'configs', 'files', 'backups', 'schedules', 'metrics', 'watchdog', 'updates'],
    metadata: {
      automaticInstallHosts: ['win32', 'linux', 'darwin'],
      manualRegistration: true,
      creationAvailable: true,
    },
    createWizard: true,

    addonsDir(desc, kind) {
      return path.join(desc.dir, kind === 'mods' ? 'mods' : 'plugins');
    },

    resetState(manager) {
      const st = ensureState(manager);
      st.players.clear();
      st.tpsSupported = null;
      st.lastTps = null;
    },

    // Resolves the jar/launchArgs + Java runtime to launch, downloading a
    // managed JRE first if needed. Mirrors the original ServerManager.start().
    start(manager) {
      const d = manager.desc();
      const hasLaunchArgs = Array.isArray(d.launchArgs) && d.launchArgs.length > 0;
      if (!d.dir) return { ok: false, error: eKey('errors.noFolderConfigured') };
      if (!hasLaunchArgs && !d.jar) return { ok: false, error: eKey('errors.noJarConfigured') };
      if (!fs.existsSync(d.dir)) return { ok: false, error: eKey('errors.folderNotFound', { path: d.dir }) };

      let jarPath = null;
      if (hasLaunchArgs) {
        for (const arg of d.launchArgs) {
          if (typeof arg !== 'string' || !arg.startsWith('@')) continue;
          const argPath = path.resolve(d.dir, arg.slice(1));
          if (!argPath.startsWith(path.resolve(d.dir) + path.sep) || !fs.existsSync(argPath)) {
            return { ok: false, error: eKey('errors.jarMissing', { path: argPath }) };
          }
        }
      } else {
        jarPath = path.join(d.dir, d.jar);
        if (!fs.existsSync(jarPath)) {
          return { ok: false, error: eKey('errors.jarMissing', { path: jarPath }) };
        }
      }

      const args = hasLaunchArgs
        ? [...(d.javaArgs || []), ...d.launchArgs]
        : [...(d.javaArgs || []), '-jar', d.jar, 'nogui'];

      const major = hasLaunchArgs
        ? requiredJavaMajor(d.mcVersion)
        : Math.max(jarJavaMajor(jarPath) || 0, requiredJavaMajor(d.mcVersion));
      const javaBin = resolveJavaForServer(d, major);
      if (javaBin) return manager._launch(javaBin, args);

      if (manager._runtimeFetching) return { ok: true };
      manager._runtimeFetching = true;
      this.resetState(manager);
      manager.manualStop = false;
      manager.setStatus('starting');
      manager.pushLine(`[Hostkind] Minecraft ${d.mcVersion || '?'} needs Java ${major}. Downloading runtime (one-time)...`, 'info');
      let lastPct = -1;
      ensureRuntime(major, (rec, total) => {
        if (!total) return;
        const pct = Math.floor((rec / total) * 100);
        if (pct >= lastPct + 10) { lastPct = pct; manager.pushLine(`[Hostkind] Downloading Java ${major}: ${pct}%`, 'info'); }
      }).then((bin) => {
        manager._runtimeFetching = false;
        manager.pushLine(`[Hostkind] Java ${major} runtime ready.`, 'info');
        const r = manager._launch(bin, args);
        if (!r.ok) { manager.setStatus('offline'); manager.pushLine(`[Hostkind] Could not launch java: ${r.error}`, 'error'); }
      }).catch((err) => {
        manager._runtimeFetching = false;
        manager.setStatus('offline');
        manager.pushLine(`[Hostkind] Could not prepare Java ${major}: ${err.message}`, 'error');
      });
      return { ok: true };
    },

    // Pre-flight check run right before spawn: refuse to launch if the
    // server's port is already bound (orphaned process, or a crashed-but-
    // lingering server still holding it).
    async preLaunch(manager) {
      const d = manager.desc();
      const { host, port } = readServerBind(d.dir);
      try {
        const inUse = await probePortInUse(port, host);
        if (inUse) {
          return {
            ok: false,
            error: `Port ${port} is already in use — another server (possibly an orphaned process from a previous session) is still holding it. Stop that process first, or change server-port in server.properties.`,
          };
        }
      } catch {
        // Probe itself failed: don't block the launch, just try.
      }
      return { ok: true };
    },

    detectOnline(line) {
      return /Done \([\d.]+s\)!/.test(line);
    },

    onOnline(manager) {
      ensureState(manager);
      manager._startModulePolling();
      manager.sendCommand('list', true);
    },

    pollCommands(manager) {
      const st = ensureState(manager);
      const cmds = ['list'];
      if (st.tpsSupported !== false) cmds.push('tps');
      return cmds;
    },

    inspectLine(line, manager) {
      const st = ensureState(manager);
      const config = getConfig();

      let m = line.match(/]: ([A-Za-z0-9_]{1,16}) joined the game/);
      if (m) {
        const before = st.players.size;
        st.players.add(m[1]);
        manager._afterPlayerChange();
        if (config.discord?.notifyOnJoinLeave) notifyDiscord(`+ **${m[1]}** joined "${manager.name()}" (${st.players.size}/${st.maxPlayers || '?'})`);
        if (st.maxPlayers && st.players.size >= st.maxPlayers && before < st.maxPlayers && config.discord?.notifyOnFull) {
          notifyDiscord(`:warning: "${manager.name()}" is **full** (${st.players.size}/${st.maxPlayers}).`);
        }
        return;
      }
      m = line.match(/]: ([A-Za-z0-9_]{1,16}) left the game/);
      if (m) {
        st.players.delete(m[1]);
        manager._afterPlayerChange();
        if (config.discord?.notifyOnJoinLeave) notifyDiscord(`- **${m[1]}** left "${manager.name()}" (${st.players.size}/${st.maxPlayers || '?'})`);
        return;
      }

      m = line.match(/There are (\d+) of a max of (\d+) players online:?\s*(.*)$/i)
        || line.match(/There are (\d+)\/(\d+) players online:?\s*(.*)$/i);
      if (m) {
        st.maxPlayers = parseInt(m[2], 10);
        const names = (m[3] || '')
          .replace(/§./g, '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => {
            const mm = s.match(/[A-Za-z0-9_]{1,16}/);
            return mm ? mm[0] : null;
          })
          .filter(Boolean);
        st.players = new Set(names);
        manager._afterPlayerChange();
        return;
      }

      m = line.match(/TPS from last [^:]*:\s*([0-9.,*]+)/i);
      if (m) {
        st.tpsSupported = true;
        const first = m[1].split(/[ ,]+/)[0].replace(/[*]/g, '');
        const val = parseFloat(first);
        if (!Number.isNaN(val)) {
          st.lastTps = val;
          manager.broadcast({ type: 'status', status: manager.statusPayload() });
        }
      }
      if (/Unknown command|Unknown or incomplete command/i.test(line) && st.tpsSupported === null) {
        st.tpsSupported = false;
      }
    },

    buildStopSequence() {
      return { command: 'stop' };
    },

    statusFields(manager) {
      const st = ensureState(manager);
      return {
        players: [...st.players].sort(),
        playerCount: st.players.size,
        maxPlayers: st.maxPlayers || 0,
        tps: st.lastTps,
      };
    },

    onExit(manager) {
      if (!manager.moduleState) return;
      manager.moduleState.players.clear();
      manager.moduleState.lastTps = null;
    },
  };
}

module.exports = createMinecraftModule;
