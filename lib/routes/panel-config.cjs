'use strict';

/*
 * GET  /api/config                 - panel config without secrets
 * PUT  /api/config/backups         - backup-retention settings (admin)
 * PUT  /api/config/auth            - turn password sign-in on/off (admin)
 * PUT  /api/config/watchdog        - crash-loop guard settings (admin)
 * PUT  /api/config/game-accents    - per-game accent colors (admin)
 * GET  /api/fs                     - admin dir listing for server registration
 * GET  /api/pick-folder            - native OS folder dialog
 *
 * Mounted at /api, so router paths are relative (e.g. '/config', '/fs').
 * Registration order matches the original inline block in server.js.
 * Auth gates are unchanged: requireAdmin travels with each writer route and
 * the /fs browser, while GET /config and GET /pick-folder keep the shared
 * /api auth behavior they had inline (no extra gate).
 *
 * `config` in server.js is a reassigned `let`, so the panel config is read
 * through getConfig() and persisted through saveConfig(next) instead of a
 * captured reference (same live-binding technique as lib/routes/users.cjs).
 */

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The "roots" shown when the folder browser is at the top level. On Windows
// these are the drive letters (C:\, D:\, ...). On POSIX there are no drive
// letters, so we offer the user's home folder and the filesystem root as
// jumping-off points; navigation from there walks the tree normally.
function listDrives() {
  if (process.platform === 'win32') {
    const drives = [];
    for (const c of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') {
      const root = `${c}:\\`;
      try {
        fs.accessSync(root);
        drives.push(root);
      } catch (_) { /* not present */ }
    }
    return drives;
  }
  const roots = [];
  const home = os.homedir();
  if (home && home !== '/') roots.push(home);
  roots.push('/');
  return roots;
}

module.exports = function panelConfigRouter({
  getConfig,
  saveConfig,
  requireAdmin,
  branding,
  pruneBackups,
  slugify,
  pickFolder,
  PICKER_BUSY,
  PICKER_UNAVAILABLE,
  PICKER_TIMEOUT,
  WATCHDOG_WINDOW_MINUTES_MAX,
  tErr,
  httpError,
  sanitizeErrorMessage,
  log,
}) {
  const router = express.Router();

  // --- config (without secrets) ---
  function publicConfig() {
    const c = JSON.parse(JSON.stringify(getConfig()));
    delete c.password;
    delete c.jwtSecret;
    delete c.users;
    
    for (const server of c.servers || []) {
      delete server.adminPassword;
      delete server.palworldIntegrations;
    }
    delete c.palworldIntegrations;
    return c;
  }

  router.get('/config', (req, res) => res.json(publicConfig()));

  // Update only the backup-retention settings. After saving, prune every
  // server's existing backups so a newly-lowered limit takes effect right
  // away (not just on the next backup).
  router.put('/config/backups', requireAdmin, (req, res) => {
    const b = req.body || {};
    const toNonNegInt = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return null;
      return Math.floor(n);
    };
    const maxCount = toNonNegInt(b.maxCount);
    const maxSizeMB = toNonNegInt(b.maxSizeMB);
    if (maxCount === null || maxSizeMB === null) {
      return res.status(400).json({ error: tErr(req.user, 'errors.invalidBackupsConfig') });
    }
    const config = getConfig();
    if (!config.backups) config.backups = {};
    config.backups.maxCount = maxCount;
    config.backups.maxSizeMB = maxSizeMB;
    saveConfig(config);
    for (const s of config.servers) {
      try { pruneBackups(slugify(s.name)); } catch (_) { /* noop */ }
    }
    res.json({ ok: true, backups: config.backups });
  });

  // Turn password sign-in on or off (admin-only). While off, requests fall back
  // to the synthetic guest admin (see authMiddleware), so the panel stays fully
  // usable and the setting can be flipped back on at any time - including by an
  // unsigned visitor, which is exactly what "off" means.
  router.put('/config/auth', requireAdmin, (req, res) => {
    const { requireAuth } = req.body || {};
    if (typeof requireAuth !== 'boolean') {
      return res.status(400).json({ error: tErr(req.user, 'errors.invalidAuthConfig') });
    }
    const config = getConfig();
    config.requireAuth = requireAuth;
    saveConfig(config);
    log(`auth: sign-in ${requireAuth ? 'enabled' : 'disabled'} by ${req.user.username || req.user.id}`);
    res.json({ ok: true, requireAuth: config.requireAuth });
  });

  // The watchdog (crash-loop guard) is a panel-level switch; servers without
  // their own watchdog block inherit it (ServerManager.watchdogCfg). Same
  // admin-only contract as the other config writers, and the general audit
  // middleware records every config PUT, so the change is traceable.
  router.put('/config/watchdog', requireAdmin, (req, res) => {
    const b = req.body || {};
    const maxRestarts = Number(b.maxRestarts);
    const windowMinutes = Number(b.windowMinutes);
    if (!Number.isFinite(maxRestarts) || maxRestarts < 0 || maxRestarts > 1000) {
      return res.status(400).json({ error: tErr(req.user, 'errors.invalidWatchdogConfig') });
    }
    if (!Number.isFinite(windowMinutes) || windowMinutes < 1 || windowMinutes > WATCHDOG_WINDOW_MINUTES_MAX) {
      return res.status(400).json({ error: tErr(req.user, 'errors.invalidWatchdogConfig') });
    }
    const config = getConfig();
    config.watchdog = {
      enabled: b.enabled === true,
      maxRestarts: Math.floor(maxRestarts),
      windowMinutes: Math.floor(windowMinutes),
    };
    saveConfig(config);
    log(`watchdog: ${config.watchdog.enabled ? 'enabled' : 'disabled'} by ${req.user.username || req.user.id} (max ${config.watchdog.maxRestarts} / ${config.watchdog.windowMinutes}m)`);
    res.json({ ok: true, watchdog: config.watchdog });
  });

  router.put('/config/game-accents', requireAdmin, (req, res) => {
    const config = getConfig();
    config.gameAccents = branding.normalizeGameAccents(req.body?.accents);
    saveConfig(config);
    log(`game accents updated by ${req.user.username || req.user.id}`);
    res.json({
      ok: true,
      gameAccents: config.gameAccents,
      gameThemes: branding.resolveGameAccents(config),
    });
  });

  // ---------------------------------------------------------------------------
  // Filesystem browser (for registering a server)
  // ---------------------------------------------------------------------------
  router.get('/fs', requireAdmin, (req, res) => {
    const requestedPath = req.query.path;
    if (requestedPath !== undefined && typeof requestedPath !== 'string') {
      return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
    }
    const p = (requestedPath || '').trim();
    try {
      if (!p) {
        return res.json({ path: '', parent: null, drives: listDrives(), dirs: [], jars: [], sep: path.sep });
      }
      const abs = path.resolve(p);
      const allowedRoot = listDrives()
        .map((root) => path.resolve(root))
        .find((root) => abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
      if (!allowedRoot) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
      let entries;
      if (abs.startsWith(allowedRoot)) entries = fs.readdirSync(abs, { withFileTypes: true });
      else return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
      const dirs = [];
      const jars = [];
      for (const e of entries) {
        try {
          if (e.isDirectory()) dirs.push(e.name);
          else if (e.isFile() && e.name.toLowerCase().endsWith('.jar')) jars.push(e.name);
        } catch (_) { /* skip unreadable entry */ }
      }
      dirs.sort((a, b) => a.localeCompare(b));
      jars.sort((a, b) => a.localeCompare(b));
      const parentCandidate = path.dirname(abs);
      const parent = parentCandidate === abs ? '' : parentCandidate; // '' => back to drive list
      res.json({ path: abs, parent, drives: [], dirs, jars, sep: path.sep });
    } catch (err) {
      httpError(res, req, err, 400);
    }
  });

  // ---------------------------------------------------------------------------
  // Native folder picker - pops the real OS folder dialog (Windows Explorer /
  // Linux zenity / macOS Finder) and returns the chosen absolute path. The
  // in-browser custom folder browser is still used for "Register server" but
  // the "Create a new server" flow uses this so the user gets the familiar
  // native dialog. The implementation lives in lib/folderPicker.cjs: it spawns
  // asynchronously (the panel stays responsive while the dialog is open),
  // compiles the Windows dialog's C# helper once and caches the DLL, and
  // refuses a second dialog (409) while one is already open.
  // ---------------------------------------------------------------------------
  router.get('/pick-folder', async (req, res) => {
    const def = String(req.query.defaultPath || '').trim();
    const title = String(req.query.title || 'Select the parent folder for the new server').trim().slice(0, 100);
    try {
      const result = await pickFolder(def, title);
      if (res.destroyed) return;
      if (result.cancelled) return res.json({ path: null, cancelled: true });
      if (!fs.existsSync(result.path) || !fs.statSync(result.path).isDirectory()) {
        return res.status(400).json({ error: `Picked path is not a folder: ${result.path}` });
      }
      return res.json({ path: result.path });
    } catch (err) {
      if (res.destroyed) return;
      if (err.code === PICKER_BUSY) {
        return res.status(409).json({ error: tErr(req.user, 'errors.pickFolderBusy') });
      }
      log('pick-folder error:', err.message);
      // The dialog never came back and was killed. Answering is the point: the
      // caller's Browse button is disabled until this request resolves, and it
      // falls back to the in-panel folder browser on any error.
      if (err.code === PICKER_TIMEOUT) {
        return res.status(504).json({ error: tErr(req.user, 'errors.pickFolderTimeout') });
      }
      if (err.code === PICKER_UNAVAILABLE) {
        return res.status(500).json({ error: tErr(req.user, 'errors.pickFolderUnavailable', { error: sanitizeErrorMessage(err.message) }) });
      }
      return httpError(res, req, err, 500);
    }
  });

  return router;
};
