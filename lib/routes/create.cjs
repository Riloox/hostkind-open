'use strict';

/*
 * GET  /api/create/versions - Minecraft version list per server type
 * POST /api/create           - create a server (admin, NDJSON stream)
 *
 * Mounted at /api, so router paths carry the full sub-path.
 * Registration order matches the original inline block in server.js.
 * Jar/version/download/Java-runtime helpers (resolveServerJar,
 * downloadToFile, requiredJavaMajor, resolveJavaForServer, ensureRuntime,
 * runForgeInstaller, findForgeLaunchTarget, listServerVersions, fetchText,
 * probePortInUse, slugify) are shared with schedulers and sibling slices,
 * so they stay in server.js and arrive here as factory deps. `config` is a
 * reassigned `let` in server.js, so live state travels as getConfig /
 * saveConfig getters, mirroring lib/routes/servers.cjs.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { installDedicatedServer } = require('../dedicatedServerInstaller.cjs');
const terrariaInstall = require('../terraria-install.cjs');
const terrariaVariants = require('../modules/terraria/variants.cjs');
const { validateManualRegistration } = require('../modules/registration.cjs');

module.exports = function createRouter({
  getConfig,
  saveConfig,
  getManager,
  serverWithStatus,
  slugify,
  genId,
  addNotification,
  log,
  tErr,
  httpError,
  sanitizeErrorMessage,
  requireAdmin,
  SERVER_TYPES,
  SERVER_NAME_MAX_LENGTH,
  INSTALLER_CACHE_DIR,
  listServerVersions,
  resolveServerJar,
  downloadToFile,
  requiredJavaMajor,
  resolveJavaForServer,
  ensureRuntime,
  runForgeInstaller,
  findForgeLaunchTarget,
  fetchText,
  probePortInUse,
}) {
  const router = express.Router();

  router.get('/create/versions', async (req, res) => {
    const type = String(req.query.type || '').toLowerCase();
    if (!SERVER_TYPES.includes(type)) return res.status(400).json({ error: tErr(req.user, 'errors.unknownServerType') });
    try {
      log(`Fetching ${type} version list...`);
      const versions = await listServerVersions(type);
      log(`${type} versions: ${versions.length} (latest ${versions[0] || 'n/a'})`);
      res.json({ versions });
    } catch (err) {
      log(`Failed to fetch ${type} version list: ${err.message}`);
      res.status(502).json({ error: sanitizeErrorMessage(err.message) });
    }
  });

  router.post('/create', requireAdmin, async (req, res) => {
    const config = getConfig();
    const body = req.body || {};
    const type = String(body.type || '').toLowerCase();
    const gameType = String(body.gameType || (['custom', 'terraria', 'valheim', 'palworld'].includes(type) ? type : 'minecraft')).toLowerCase();
    const name = String(body.name || '').trim();
    if (gameType !== 'minecraft') {
      if (body.automatic && ['terraria', 'valheim', 'palworld'].includes(gameType)) {
        const parentDir = String(body.parentDir || '').trim();
        const port = Number(body.port);
        const maxPlayers = Number(body.maxPlayers);
        const worldName = String(body.worldName || '').trim();
        const serverName = String(body.serverName || name).trim();
        const password = String(body.password || '');
        if (!name) return res.status(400).json({ error: tErr(req.user, 'errors.nameRequired') });
        if (name.length > SERVER_NAME_MAX_LENGTH) return res.status(400).json({ error: tErr(req.user, 'errors.nameTooLong', { max: SERVER_NAME_MAX_LENGTH }) });
        if (!parentDir || !fs.existsSync(parentDir) || !fs.statSync(parentDir).isDirectory()) return res.status(400).json({ error: tErr(req.user, 'errors.pickParentFolder') });
        const maxPort = gameType === 'valheim' ? 65533 : (gameType === 'palworld' ? 65534 : 65535);
        if (!Number.isInteger(port) || port < 1 || port > maxPort) return res.status(400).json({ error: 'Choose a valid server port.' });
        const maxPlayerLimit = gameType === 'terraria' ? 255 : (gameType === 'valheim' ? 10 : 32);
        if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > maxPlayerLimit) return res.status(400).json({ error: 'Choose a valid player limit.' });
        if (!worldName) return res.status(400).json({ error: 'World name is required.' });
        if (gameType === 'valheim' && password.length < 5) return res.status(400).json({ error: 'Valheim requires a password with at least 5 characters.' });

        /*
         * Terraria's extra creation inputs (docs/terraria/01-installation-versions.md
         * step 4). Everything that can be refused is refused here, before the
         * NDJSON stream opens and before anything is downloaded: an omitted
         * variant is the legacy meaning (vanilla), an unknown one is an error,
         * and the world name and seed go through the installer's own rules so
         * the wizard and a scripted POST get the same answer.
         */
        let terraria = null;
        if (gameType === 'terraria') {
          const variant = String(body.terrariaVariant || 'vanilla').toLowerCase();
          if (!terrariaVariants.isVariant(variant)) return res.status(400).json({ error: `Unknown Terraria variant: ${variant}` });
          try {
            terraria = {
              variant,
              versionId: String(body.versionId || '').trim(),
              worldName: terrariaInstall.normalizeWorldName(worldName),
              seed: terrariaInstall.normalizeSeed(body.seed),
              motd: String(body.motd || '').trim(),
            };
          } catch (error) {
            return res.status(error.status || 400).json({ error: error.message, code: error.code });
          }
          if (terraria.motd.length > 200) return res.status(400).json({ error: 'The message of the day is limited to 200 characters.' });
          let portTaken = false;
          try { portTaken = await probePortInUse(port, '0.0.0.0'); } catch (_) { /* a failed probe must not block creation */ }
          if (portTaken) return res.status(400).json({ error: `Port ${port} is already in use. Choose another port.` });
        }

        const dir = path.join(parentDir, slugify(name));
        if (fs.existsSync(dir) && fs.readdirSync(dir).length) return res.status(400).json({ error: tErr(req.user, 'errors.folderNotEmpty', { path: dir }) });
        res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        const send = (event) => { if (!res.writableEnded) res.write(JSON.stringify(event) + '\n'); };
        const cacheDir = INSTALLER_CACHE_DIR;
        fs.mkdirSync(cacheDir, { recursive: true });
        try {
          const adminPassword = gameType === 'palworld' ? crypto.randomBytes(32).toString('base64url') : undefined;
          const restPort = gameType === 'palworld' ? port + 1 : undefined;
          const install = {
            destination: dir, port, maxPlayers, worldName, serverName, password,
            adminPassword, restPort,
            public: body.public !== false,
            worldSize: [1, 2, 3].includes(Number(body.worldSize)) ? Number(body.worldSize) : 2,
            difficulty: [0, 1, 2, 3].includes(Number(body.difficulty)) ? Number(body.difficulty) : 0,
          };
          if (terraria) {
            install.worldName = terraria.worldName;
            install.seed = terraria.seed;
            install.motd = terraria.motd;
            install.versionId = terraria.versionId;
          }
          const installOptions = {
            cacheDir,
            download: (url, target, progress) => downloadToFile(url, target, (received, total) => progress(received, total)),
            onPhase: (phase) => send({ type: 'phase', phase }),
            onProgress: (received, total) => send({ type: 'progress', received, total }),
            onOutput: (line) => send({ type: 'output', line }),
          };
          // Terraria resolves its own versions, so it is given no `fetchText`:
          // the installer's fetch keeps the HTTP status, which is how a GitHub
          // rate limit is told apart from an unreachable source.
          const runtime = terraria
            ? await terrariaInstall.install(terraria.variant, install, installOptions)
            : await installDedicatedServer(gameType, install, { ...installOptions, fetchText });
          const entry = {
            id: genId(), type: gameType, name, dir, cwd: runtime.cwd || path.dirname(runtime.executable),
            executable: runtime.executable, args: runtime.args,
            port, maxPlayers, worldName, serverName,
          };
          if (gameType === 'valheim') {
            entry.valheimSchema = 1;
            entry.password = password;
            entry.valheimSaveDir = 'data';
            entry.valheimBackend = 'steam';
            entry.valheimPublic = body.public !== false;
            entry.valheimInstanceId = null;
            entry.valheimBuildId = runtime.buildId || null;
            entry.valheimSettings = {};
            entry.valheimExtraArgs = ['-nographics', '-batchmode'];
            // New descriptors are generated from structured fields. The
            // installer's argv is not persisted because it contains the
            // password and duplicates Hostkind-owned flags.
            entry.args = [];
          }
          if (gameType === 'palworld') {
            entry.adminPassword = adminPassword;
            entry.restPort = restPort;
          }
          if (terraria) {
            entry.terrariaVariant = terraria.variant;
            entry.terrariaVersion = runtime.version;
            // Server-relative (docs/terraria/00-baseline-contracts.md "Freeze the
            // descriptor"): the installer answers with an absolute path because
            // it is the one writing it into serverconfig.txt, and the descriptor
            // never carries an absolute path.
            entry.terrariaSaveDir = path.relative(dir, runtime.saveDir).split(path.sep).join('/');
            // Deliberately no `file` yet. A freshly created server has an
            // `autocreate` config and no world on disk: the first start makes it.
            // Writing the path here would make `preLaunch` refuse that very first
            // start for a world that is *supposed* to be missing, and the world
            // module reads the selection from serverconfig.txt until a selection
            // (phase 3) writes both halves.
            entry.terrariaWorld = { name: runtime.worldName };
          }
          entry.stopTimeoutSeconds = 30;
          entry.watchdog = { enabled: false, maxRestarts: 3, windowMinutes: 10 };
          const previousActiveServerId = config.activeServerId;
          config.servers.push(entry);
          if (!config.activeServerId) config.activeServerId = entry.id;
          try {
            saveConfig(config);
            runtime.finalize?.();
          } catch (error) {
            config.servers = config.servers.filter((server) => server.id !== entry.id);
            config.activeServerId = previousActiveServerId;
            runtime.rollbackPromotion?.();
            throw error;
          }
          getManager(entry.id);
          addNotification('server_created', 'Server Created', `${gameType} server "${name}" installed.`, entry.id);
          log(`Installed ${gameType} server "${name}"`);
          send({ type: 'done', server: serverWithStatus(entry) });
          return res.end();
        } catch (err) {
          log(`${gameType} install failed:`, err.message);
          send({ type: 'error', error: err.message });
          return res.end();
        }
      }
      let value;
      try {
        value = validateManualRegistration({ ...body, gameType }, { maxNameLength: SERVER_NAME_MAX_LENGTH });
      } catch (err) {
        return httpError(res, req, err, 400);
      }

      const entry = {
        id: genId(),
        ...value,
        watchdog: { enabled: false, maxRestarts: 3, windowMinutes: 10 },
      };
      config.servers.push(entry);
      if (!config.activeServerId) config.activeServerId = entry.id;
      saveConfig(config);
      getManager(entry.id);
      addNotification('server_created', 'Process Created', `${gameType} process "${name}" registered.`, entry.id);
      log(`Registered ${gameType} process "${name}"`);

      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.write(JSON.stringify({ type: 'done', server: serverWithStatus(entry) }) + '\n');
      return res.end();
    }

    const parentDir = String(body.parentDir || '').trim();
    const mcVersion = String(body.mcVersion || '').trim();
    if (!SERVER_TYPES.includes(type)) return res.status(400).json({ error: tErr(req.user, 'errors.pickServerType') });
    if (!name) return res.status(400).json({ error: tErr(req.user, 'errors.nameRequired') });
    if (name.length > SERVER_NAME_MAX_LENGTH) return res.status(400).json({ error: tErr(req.user, 'errors.nameTooLong', { max: SERVER_NAME_MAX_LENGTH }) });
    if (!parentDir || !fs.existsSync(parentDir)) return res.status(400).json({ error: tErr(req.user, 'errors.pickParentFolder') });
    if (!mcVersion) return res.status(400).json({ error: tErr(req.user, 'errors.pickMcVersion') });
    if (!body.eula) return res.status(400).json({ error: tErr(req.user, 'errors.eulaRequired') });

    const dir = path.join(parentDir, slugify(name));
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
      return res.status(400).json({ error: tErr(req.user, 'errors.folderNotEmpty', { path: dir }) });
    }

    // NDJSON stream: each line is a JSON event. Phases:
    //   {type:"start", phase:"resolving"}
    //   {type:"phase", phase:"downloading"}
    //   {type:"download-start", total, filename}
    //   {type:"progress", received, total}    (repeated while downloading)
    //   {type:"phase", phase:"installing-forge"}    (forge only)
    //   {type:"phase", phase:"installing-neoforge"} (neoforge only)
    //   {type:"phase", phase:"finalizing"}
    //   {type:"done", server}                  (terminal)
    //   {type:"error", error}                  (terminal)
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (obj) => {
      if (res.writableEnded) return;
      try { res.write(JSON.stringify(obj) + '\n'); } catch (_) { /* noop */ }
    };

    const ac = new AbortController();
    let clientGone = false;
    // Detect a real client disconnect via the *response* stream. (Listening on
    // req.on('close') is wrong: on Node 18+ the request emits 'close' as soon as
    // its body has been read - immediately for a small POST - which would abort
    // the download before it even starts.)
    res.on('close', () => {
      if (res.writableEnded) return;
      clientGone = true;
      ac.abort();
    });

    const cleanup = (jarName) => {
      try { if (jarName) fs.unlinkSync(path.join(dir, jarName)); } catch (_) { /* ignore */ }
      try { if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch (_) { /* ignore */ }
    };

    try {
      log(`Create: ${type} server "${name}" (MC ${mcVersion}) -> ${dir}`);
      send({ type: 'phase', phase: 'resolving' });
      log(`Create: resolving ${type} ${mcVersion} download...`);
      const { url, filename } = await resolveServerJar(type, mcVersion);
      if (clientGone) return;
      log(`Create: resolved -> ${url}`);

      fs.mkdirSync(dir, { recursive: true });
      const jarPath = path.join(dir, filename);

      send({ type: 'phase', phase: 'downloading' });
      send({ type: 'download-start', total: 0, filename });
      log(`Create: downloading ${filename}...`);
      let nextPct = 0;
      const received = await downloadToFile(url, jarPath, (rec, total) => {
        send({ type: 'progress', received: rec, total });
        if (total) {
          const pct = Math.floor((rec / total) * 100);
          if (pct >= nextPct) { log(`Create: download ${pct}% (${(rec / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`); nextPct += 25; }
        }
      }, ac.signal);
      if (clientGone) { cleanup(filename); return; }
      log(`Create: downloaded "${filename}" (${(received / 1048576).toFixed(1)} MB)`);

      let jarFilename = filename;
      let launchArgs = null;
      if (type === 'forge' || type === 'neoforge') {
        const label = type === 'neoforge' ? 'NeoForge' : 'Forge';
        send({ type: 'phase', phase: type === 'neoforge' ? 'installing-neoforge' : 'installing-forge' });
        const major = requiredJavaMajor(mcVersion);
        let javaBin = resolveJavaForServer({ mcVersion }, major);
        if (!javaBin) {
          log(`Create: ${label} installer needs Java ${major}; preparing managed runtime...`);
          javaBin = await ensureRuntime(major, (rec, total) => {
            if (total) send({ type: 'progress', received: rec, total });
          });
        }
        await runForgeInstaller(dir, filename, label, javaBin);
        if (clientGone) { cleanup(filename); return; }
        const produced = findForgeLaunchTarget(dir, type);
        if (!produced) throw new Error(`${label} installer finished but no server jar or launch args file was found in the folder`);
        jarFilename = produced.jar;
        launchArgs = produced.launchArgs;
      }

      send({ type: 'phase', phase: 'finalizing' });
      log('Create: writing eula.txt and registering server...');
      fs.writeFileSync(path.join(dir, 'eula.txt'), `# Accepted via Hostkind on ${new Date().toISOString()}\neula=true\n`, 'utf8');

      let javaArgs = body.javaArgs;
      if (typeof javaArgs === 'string') javaArgs = javaArgs.trim().split(/\s+/).filter(Boolean);
      if (!Array.isArray(javaArgs) || !javaArgs.length) javaArgs = ['-Xmx4G', '-Xms4G'];

      const entry = {
        id: genId(),
        type: 'minecraft',
        name,
        dir,
        jar: jarFilename,
        loader: type,
        launchArgs,
        javaArgs,
        mcVersion,
        stopTimeoutSeconds: 30,
        worlds: ['world', 'world_nether', 'world_the_end'],
        watchdog: { enabled: false, maxRestarts: 3, windowMinutes: 10 },
      };
      config.servers.push(entry);
      if (!config.activeServerId) config.activeServerId = entry.id;
      saveConfig(config);
      getManager(entry.id);
      addNotification('server_created', 'Server Created', `Server "${name}" (${type}, MC ${mcVersion}) created at ${dir}.`, entry.id);
      log(`Created ${type} server "${name}" (${mcVersion}) at ${dir}`);

      send({ type: 'done', server: serverWithStatus(entry) });
      res.end();
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.message === 'aborted' || clientGone)) {
        // Client disconnected - keep what we have on disk for inspection but
        // don't register the server.
        try { log(`Create aborted by client before completion: ${dir}`); } catch (_) { /* noop */ }
        return;
      }
      log(`Create failed (${type} ${mcVersion}): ${err.message}`);
      send({ type: 'error', error: err.message });
      res.end();
    }
  });

  return router;
};
