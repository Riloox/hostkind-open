'use strict';

/*
 * GET    /api/addons          - list .jar addons (active + disabled) for ?kind=plugins|mods
 * POST   /api/addons/upload   - upload a .jar (multipart field "addon")
 * POST   /api/addons/enabled  - enable/disable a batch of addons (server must be offline)
 * DELETE /api/addons/:name    - delete one .jar
 *
 * Mounted at /api/addons, so router paths are relative. The /api/addons
 * capability gate registered in server.js precedes this mount and keeps
 * applying first.
 *
 * This router is a thin HTTP layer over lib/addon-state.cjs: listing and
 * enable/disable go through that lib, never duplicated here. Only the upload
 * staging (multer) and single-file delete stay inline, as before.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// Both kinds are just .jar files in a folder; `kind` picks which folder.
function addonKind(req) {
  const raw = (req.query && req.query.kind) || (req.body && req.body.kind) || 'plugins';
  return String(raw).toLowerCase() === 'mods' ? 'mods' : 'plugins';
}

module.exports = function addonsRouter({ targetManager, tErr, httpError, sanitizeErrorMessage, addonState, addNotification }) {
  const router = express.Router();

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const m = targetManager(req);
        if (!m) return cb(new Error('No active server.'));
        const dir = m.addonsDir(addonKind(req));
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* noop */ }
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, path.basename(file.originalname)),
    }),
    fileFilter: (req, file, cb) => {
      if (!file.originalname.toLowerCase().endsWith('.jar')) {
        return cb(new Error('Only .jar files are allowed'));
      }
      cb(null, true);
    },
    limits: { fileSize: 200 * 1024 * 1024 },
  });

  router.get('/', (req, res) => {
    const kind = addonKind(req);
    const m = targetManager(req);
    if (!m) return res.json({ kind, addons: [] });
    try {
      const files = addonState.list({
        activeDir: m.addonsDir(kind),
        disabledDir: addonState.disabledDir(m.dir(), kind),
      });
      res.json({ kind, addons: files });
    } catch (err) {
      httpError(res, req, err, 500);
    }
  });

  router.post('/upload', upload.single('addon'), (req, res) => {
    const m = targetManager(req);
    const label = addonKind(req) === 'mods' ? 'Mod' : 'Plugin';
    if (m && req.file && req.file.filename) {
      addNotification('plugin_uploaded', `${label} Uploaded`, `${label} "${req.file.filename}" uploaded to "${m.name()}". Restart the server to apply.`, m.id);
    }
    res.json({ ok: true, name: req.file && req.file.filename, note: 'Restart the server to apply.' });
  }, (err, req, res, next) => {
    res.status(400).json({ error: tErr(req.user, err.message && err.message.includes('Only') ? 'errors.onlyJar' : 'errors.unknownAction') });
  });

  router.post('/enabled', (req, res) => {
    const m = targetManager(req);
    if (!m) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    if (m.status !== 'offline') return res.status(409).json({ error: 'Stop the server before changing addon state.', code: 'server_online' });
    const body = req.body || {};
    try {
      const result = addonState.setEnabled({
        activeDir: m.addonsDir(addonKind(req)),
        disabledDir: addonState.disabledDir(m.dir(), addonKind(req)),
        names: body.names,
        enabled: body.enabled,
      });
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: sanitizeErrorMessage(err.message), code: err.code || 'addon_state_error' });
    }
  });

  router.delete('/:name', (req, res) => {
    const m = targetManager(req);
    if (!m) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    const name = path.basename(req.params.name);
    if (!name.toLowerCase().endsWith('.jar')) return res.status(400).json({ error: tErr(req.user, 'errors.notAJar') });
    const active = path.join(m.addonsDir(addonKind(req)), name);
    const disabled = path.join(addonState.disabledDir(m.dir(), addonKind(req)), name);
    if (fs.existsSync(active) && fs.existsSync(disabled)) return res.status(409).json({ error: tErr(req.user, 'errors.unknownAction') });
    const full = fs.existsSync(active) ? active : disabled;
    if (!fs.existsSync(full)) return res.status(404).json({ error: tErr(req.user, 'errors.fileDoesNotExist') });
    try {
      fs.unlinkSync(full);
      res.json({ ok: true, note: 'Restart the server to apply.' });
    } catch (err) {
      httpError(res, req, err, 500);
    }
  });

  return router;
};
