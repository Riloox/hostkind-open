'use strict';

/*
 * GET  /api/configs               - list editable config files in server root
 * GET  /api/configs/:name         - read one allowlisted config file
 * PUT  /api/configs/:name         - save a config file (writes a .bak snapshot)
 * GET  /api/configs/:name/backups - list .bak snapshots for one file
 * POST /api/configs/:name/restore - roll back to one snapshot (undoable)
 *
 * Mounted at /api/configs, so router paths are relative.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

function editableFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const allowed = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const lower = e.name.toLowerCase();
    if (lower.endsWith('.yml') || lower.endsWith('.yaml')
        || lower.endsWith('.xml') || lower.endsWith('.json')
        || lower.endsWith('.properties')) {
      allowed.push(e.name);
    }
  }
  return allowed.sort();
}

function resolveEditable(dir, name) {
  const base = path.basename(name);
  const allowed = editableFiles(dir);
  if (!allowed.includes(base)) return null;
  return path.join(dir, base);
}

// The PUT /:name route below writes a timestamped .bak on every save. The
// backups/restore routes let the UI surface that history as a "History"
// dropdown and let the user roll back to any of those snapshots. Both reuse
// resolveEditable so only allowlisted files can be snapshotted/restored. The
// restore endpoint writes a fresh .bak of the state it is about to overwrite,
// so the user can undo the restore itself.
const BAK_SUFFIX_RE = /\.[0-9TZ-]+\.bak$/i;

function bakStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

module.exports = function configsRouter({ targetManager, tErr, httpError }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const m = targetManager(req);
    if (!m || !m.dir()) return res.json({ files: [] });
    try {
      res.json({ files: editableFiles(m.dir()) });
    } catch (err) {
      httpError(res, req, err, 500);
    }
  });

  router.get('/:name', (req, res) => {
    const m = targetManager(req);
    if (!m) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    const full = resolveEditable(m.dir(), req.params.name);
    if (!full) return res.status(404).json({ error: tErr(req.user, 'errors.fileNotAllowed') });
    try {
      res.json({ name: path.basename(full), content: fs.readFileSync(full, 'utf8') });
    } catch (err) {
      httpError(res, req, err, 500);
    }
  });

  router.put('/:name', (req, res) => {
    const m = targetManager(req);
    if (!m) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    const full = resolveEditable(m.dir(), req.params.name);
    if (!full) return res.status(404).json({ error: tErr(req.user, 'errors.fileNotAllowed') });
    const content = req.body && req.body.content;
    if (typeof content !== 'string') return res.status(400).json({ error: tErr(req.user, 'errors.missingContent') });
    try {
      if (fs.existsSync(full)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(full, `${full}.${stamp}.bak`);
      }
      fs.writeFileSync(full, content, 'utf8');
      res.json({ ok: true, note: 'Saved. Restart the server to apply.' });
    } catch (err) {
      httpError(res, req, err, 500);
    }
  });

  router.get('/:name/backups', (req, res) => {
    const m = targetManager(req);
    if (!m) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    const full = resolveEditable(m.dir(), req.params.name);
    if (!full) return res.status(404).json({ error: tErr(req.user, 'errors.fileNotAllowed') });
    try {
      const base = path.basename(full);
      const parentDir = path.dirname(full);
      const entries = fs.readdirSync(parentDir, { withFileTypes: true });
      const prefix = `${base}.`;
      const backups = entries
        .filter((e) => e.isFile() && e.name.startsWith(prefix) && e.name.endsWith('.bak'))
        .map((e) => {
          const stamp = e.name.slice(prefix.length, -'.bak'.length);
          if (!BAK_SUFFIX_RE.test('.' + stamp)) return null;
          const fullPath = path.join(parentDir, e.name);
          let st;
          try { st = fs.statSync(fullPath); } catch (_) { return null; }
          return { name: e.name, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
        })
        .filter(Boolean)
        .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
      res.json({ ok: true, backups });
    } catch (err) {
      httpError(res, req, err, 500);
    }
  });

  router.post('/:name/restore', (req, res) => {
    const m = targetManager(req);
    if (!m) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    const full = resolveEditable(m.dir(), req.params.name);
    if (!full) return res.status(404).json({ error: tErr(req.user, 'errors.fileNotAllowed') });
    const backupName = path.basename(String((req.body && req.body.backup) || ''));
    const base = path.basename(full);
    // Only allow backups of THIS file, with the matching "<base>.<stamp>.bak"
    // shape that PUT writes. Reject anything else (path traversal, foreign
    // files, oddly named snapshots). `path.basename` already strips any
    // directory part, so a request like ".." or "foo/../bar" can never reach
    // the disk.
    if (!backupName || !backupName.startsWith(`${base}.`) || !backupName.endsWith('.bak')
        || !BAK_SUFFIX_RE.test(backupName.slice(base.length))) {
      return res.status(400).json({ error: 'invalidBackup' });
    }
    const bakPath = path.join(path.dirname(full), backupName);
    if (!fs.existsSync(bakPath)) return res.status(404).json({ error: 'backupNotFound' });
    try {
      let content;
      if (fs.existsSync(full)) {
        // Snapshot the state we are about to overwrite so the user can undo
        // the restore itself (same .bak naming as the PUT route).
        const stamp = bakStamp();
        fs.copyFileSync(full, `${full}.${stamp}.bak`);
        content = fs.readFileSync(full, 'utf8');
      } else {
        content = '';
      }
      fs.copyFileSync(bakPath, full);
      res.json({ ok: true, content, note: 'Restored. Restart the server to apply.' });
    } catch (err) {
      httpError(res, req, err, 500);
    }
  });

  return router;
};
