'use strict';

const fs = require('fs');
const path = require('path');
const consoleGrammar = require('./console.cjs');
const launch = require('./launch.cjs');

const CAPABILITIES = Object.freeze([
  'console', 'files', 'schedules', 'metrics', 'watchdog', 'valheim-status',
  'updates', 'valheim-updates', 'valheim-worlds',
]);

function state(manager) {
  const value = manager.moduleState || (manager.moduleState = {});
  if (value.gameVersion === undefined) value.gameVersion = null;
  if (value.lastObservedAt === undefined) value.lastObservedAt = null;
  if (value.readyEvidence === undefined) value.readyEvidence = null;
  if (value.lifecycle === undefined) value.lifecycle = consoleGrammar.initialState();
  if (value.readinessTimedOut === undefined) value.readinessTimedOut = false;
  if (value.integrityWarning === undefined) value.integrityWarning = null;
  return value;
}

function normalizeStatus(manager) {
  const desc = manager.desc();
  const st = state(manager);
  let range = null;
  try { range = launch.portPlan(desc).range; } catch {}
  const backend = ['steam', 'crossplay'].includes(desc.valheimBackend) ? desc.valheimBackend : 'unknown';
  return {
    buildId: desc.valheimBuildId == null ? null : String(desc.valheimBuildId),
    gameVersion: st.gameVersion,
    world: {
      name: desc.worldName == null ? null : String(desc.worldName),
      saveDir: desc.valheimSaveDir == null ? null : String(desc.valheimSaveDir),
    },
    backend,
    public: typeof desc.valheimPublic === 'boolean' ? desc.valheimPublic : null,
    port: Number.isInteger(Number(desc.port)) ? Number(desc.port) : null,
    portRange: range,
    save: {
      lastObservedAt: st.lastObservedAt,
      inProgress: !!(st.lifecycle.lastSaveStartedAt && st.lifecycle.lastSaveStartedAt > (st.lifecycle.lastSaveCompletedAt || 0)),
    },
    observedConnections: (st.lifecycle.observed || []).map((item, index) => ({
      identity: `Observed connection ${index + 1}`,
      lastSeenAt: new Date(item.lastSeenAt).toISOString(),
      stale: !item.connected || Date.now() - item.lastSeenAt > 5 * 60 * 1000,
    })),
    observedIdentitiesStale: true,
    readyEvidence: st.readyEvidence,
    readinessTimedOut: st.readinessTimedOut,
    integrityWarning: st.integrityWarning,
    lifecycleEvidence: st.lifecycleEvidence || null,
    commandInput: false,
    degraded: !!st.degradedReason || (range && range[1] - range[0] === 2),
    degradedReason: st.degradedReason || (range ? 'Valheim port-span evidence is not settled; Hostkind reserves three ports conservatively.' : null),
  };
}

function createValheimModule(deps = {}) {
  const probePortInUse = typeof deps.probePortInUse === 'function' ? deps.probePortInUse : null;
  const getConfig = typeof deps.getConfig === 'function' ? deps.getConfig : () => ({ servers: [] });

  return {
    id: 'valheim',
    capabilities: [...CAPABILITIES],
    metadata: {
      automaticInstallHosts: ['win32', 'linux'],
      manualRegistration: true,
      creationAvailable: ['win32', 'linux'].includes(process.platform),
    },
    start(manager) {
      let plan;
      try { plan = launch.buildLaunch(manager.desc()); }
      catch (err) { return { ok: false, error: err.message }; }
      if (!fs.existsSync(plan.cwd)) return { ok: false, error: `Working directory not found: ${plan.cwd}` };
      if (!fs.existsSync(plan.executable)) return { ok: false, error: `Valheim server executable was not found: ${plan.executable}` };
      if (process.platform !== 'win32') {
        try { fs.chmodSync(plan.executable, 0o755); } catch (err) { return { ok: false, error: `Valheim server executable is not executable: ${err.message}` }; }
      }
      const saveRoot = path.join(manager.desc().dir, launch.normalizeRelativeDir(manager.desc().valheimSaveDir || 'data'));
      const worlds = path.join(saveRoot, 'worlds_local');
      const world = String(manager.desc().worldName || '');
      const db = fs.existsSync(path.join(worlds, `${world}.db`));
      const fwl = fs.existsSync(path.join(worlds, `${world}.fwl`));
      if (db !== fwl) return { ok: false, error: `Valheim world "${world}" is incomplete; both .db and .fwl files are required.` };
      return manager._launch(plan.executable, plan.args, { env: plan.env });
    },
    async preLaunch(manager) {
      const plan = launch.portPlan(manager.desc());
      const currentId = manager.desc().id;
      for (const other of getConfig().servers || []) {
        if (other.id === currentId) continue;
        let otherPorts = [];
        if (other.type === 'valheim') {
          try { otherPorts = launch.portPlan(other).ports; } catch { continue; }
        } else {
          const base = Number(other.port);
          if (!Number.isInteger(base) || base < 1 || base > 65535) continue;
          // Palworld owns its REST port in addition to the game port. Other
          // descriptors currently expose one registered port.
          otherPorts = other.type === 'palworld' && Number.isInteger(Number(other.restPort))
            ? [base, Number(other.restPort)]
            : [base];
        }
        if (plan.ports.some((port) => otherPorts.includes(port))) {
          return { ok: false, error: `Valheim port range ${plan.first}-${plan.last} overlaps another registered server.` };
        }
      }
      if (!probePortInUse) return { ok: true };
      for (const port of plan.ports) {
        let used = false;
        try { used = await probePortInUse(port, '0.0.0.0'); } catch { continue; }
        if (used) return { ok: false, error: `Port ${port} is already in use.` };
      }
      return { ok: true };
    },
    resetState(manager) {
      const previous = manager.moduleState || {};
      manager.moduleState = {
        gameVersion: null, lastObservedAt: null, readyEvidence: null, degradedReason: null,
        lifecycle: consoleGrammar.initialState(), readinessTimedOut: false,
        integrityWarning: previous.integrityWarning || null,
        lifecycleEvidence: previous.lifecycleEvidence || null,
      };
    },
    detectOnline(line, manager) {
      const result = consoleGrammar.inspect(line);
      if (result.ready && manager) state(manager).readyEvidence = String(line);
      return result.ready;
    },
    inspectLine(line, manager) {
      const st = state(manager);
      const result = consoleGrammar.inspectLine(st.lifecycle, line, Date.now());
      st.lifecycle = result.state;
      for (const event of result.events) {
        if (event.type === 'version') st.gameVersion = event.version;
        if (event.type === 'save-complete') st.lastObservedAt = new Date(event.at).toISOString();
        if (event.type === 'fatal') st.failureEvidence = consoleGrammar.redactLine(line);
      }
      if (result.events.length && manager._afterPlayerChange) manager._afterPlayerChange();
    },
    buildStopSequence(manager) {
      return {
        signal: 'SIGINT',
        execute() {
          if (!manager.proc?.pid) throw new Error('Valheim process is unavailable');
          if (process.platform === 'win32') {
            // Node cannot generate CTRL_C_EVENT for an arbitrary console group.
            // Refuse to pretend that proc.kill('SIGINT') is equivalent; the
            // generic manager visibly escalates to SIGTERM.
            throw new Error('Windows console control is unavailable for this process');
          }
          process.kill(-manager.proc.pid, 'SIGINT');
        },
      };
    },
    spawnOptions() { return process.platform === 'win32' ? {} : { detached: true }; },
    redactLine: consoleGrammar.redactLine,
    readinessTimeoutMs: 5 * 60 * 1000,
    onReadinessTimeout(manager) {
      state(manager).readinessTimedOut = true;
      manager.pushLine('[Hostkind] Valheim startup timed out. The process is still running; inspect its logs or stop it explicitly.', 'warn');
    },
    onForcedStop(manager) {
      state(manager).integrityWarning = 'Valheim was force-stopped. Verify the world before the next start and restore the latest verified backup if needed.';
    },
    onExit(manager, details = {}) {
      const st = state(manager);
      st.readyEvidence = null;
      st.lifecycleEvidence = {
        outcome: details.manual ? 'stopped' : (details.statusBeforeExit === 'starting' ? 'failed' : 'crashed'),
        exitCode: details.code == null ? null : details.code,
        signal: details.signal || null,
        at: new Date().toISOString(),
      };
    },
    onAdopt(manager) {
      state(manager).lifecycleEvidence = {
        outcome: 'detached', at: new Date().toISOString(),
        guidance: 'Console attachment is unavailable. Stop or restart the proven process before launching another.',
      };
    },
    statusFields(manager) { return { valheim: normalizeStatus(manager) }; },
    normalizeStatus,
    backupSelection(desc) {
      return [launch.normalizeRelativeDir(desc.valheimSaveDir || 'data')];
    },
    validateRegistration(input, host) {
      const desc = launch.migrateDescriptor({ ...input, type: 'valheim', valheimSchema: 0 });
      launch.buildLaunch(desc, host);
      return desc;
    },
    buildLaunch: launch.buildLaunch,
    displayLaunchArgs: launch.displayLaunch,
    portPlan: launch.portPlan,
    migrateDescriptor: launch.migrateDescriptor,
  };
}

module.exports = createValheimModule;
module.exports.CAPABILITIES = CAPABILITIES;
