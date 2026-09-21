'use strict';

/*
 * GET    /api/files          - list directory entries (sandboxed to server folder)
 * GET    /api/files/read     - read a text file
 * PUT    /api/files/write    - write a text file (palworld protected-setting guard)
 * POST   /api/files/mkdir    - create a directory
 * POST   /api/files/rename   - rename a file or directory
 * DELETE /api/files          - delete a file or directory (never the server root)
 * GET    /api/files/download - download a file
 * POST   /api/files/upload   - upload files (multipart, multer)
 *
 * Mounted at /api/files, so router paths are relative.
 *
 * The traversal guards below (safeResolve / safeResolveNoFollow) were moved
 * verbatim out of server.js. They are intentionally NOT the lib/files.cjs
 * variants: these return null on escape (CodeQL js/path-injection barrier
 * shape, see comments) while lib/files.cjs throws. Keep the exact shape.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const pathSafety = require('../pathSafety.cjs');
const palworldSettings = require('../palworld-settings.cjs');

// Resolve a user-supplied relative path against the server root, refusing any
// path that would escape the root (path traversal guard).
function safeResolve(root, rel) {
  const base = path.resolve(root);
  // CodeQL's js/path-injection barrier keys on the FIRST argument of
  // path.resolve (or the last argument of a path.join nested as its first
  // argument). The tainted relative path must therefore enter through
  // path.join - a resolve(base, taintedSuffix) shape is logically correct
  // but invisible to the query, leaving every downstream fs sink flagged.
  const target = path.resolve(path.join(base, '.' + path.sep + (rel || '').replace(/^[\\/]+/, '')));
  const rootWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  if (target !== base && !target.startsWith(rootWithSep)) return null;
  return target;
}

// The prefix check above is lexical, so a symlink (or Windows junction) inside
// the server folder can reach the host through it. Re-prove containment on the
// real paths: canonical() resolves every existing link on both sides, so a
// link pointing outside the root fails the relation check here. The sandbox is
// "the server folder", links included - reads, writes, renames, and deletes
// through a link must never leave it.
function safeResolveNoFollow(root, rel) {
  const abs = safeResolve(root, rel);
  if (!abs) return null;
  const how = pathSafety.relation(abs, root);
  return how === 'same' || how === 'inside' ? abs : null;
}

const TEXT_EXTS = new Set([
  '.txt', '.properties', '.yml', '.yaml', '.json', '.json5', '.toml', '.conf', '.cfg',
  '.ini', '.log', '.md', '.sh', '.bat', '.csv', '.xml', '.mcmeta', '.lang', '.sk',
]);
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

function isTextFile(name) {
  const ext = path.extname(name).toLowerCase();
  return TEXT_EXTS.has(ext) || name.toLowerCase() === 'eula.txt' || !ext;
}

module.exports = function filesRouter({ targetManager, tErr, httpError }) {
  const router = express.Router();

  const fileUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const m = targetManager(req);
        if (!m || !m.dir()) return cb(new Error('No active server.'));
        const dest = safeResolveNoFollow(m.dir(), req.query.path || '');
        if (!dest) return cb(new Error('Invalid path'));
        const uploadsRoot = path.resolve(m.dir());
        const destResolved = path.resolve(dest);
        if (destResolved !== uploadsRoot && !destResolved.startsWith(uploadsRoot + path.sep)) return cb(new Error('Invalid path'));
        try { fs.mkdirSync(destResolved, { recursive: true }); } catch {}
        cb(null, destResolved);
      },
      filename: (req, file, cb) => cb(null, path.basename(file.originalname)),
    }),
    limits: { fileSize: 500 * 1024 * 1024 },
  });

  router.get('/', (req, res) => {
    const m = targetManager(req);
    if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    const abs = safeResolveNoFollow(m.dir(), req.query.path || '');
    if (!abs) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
    // Inline prefix + startsWith barrier at the fs sinks (js/path-injection).
    // safeResolveNoFollow already proved containment; this restates it on the
    // sink's own taint path in the positive-startsWith shape CodeQL 2.26.3
    // registers (negated or compound guard conditions are invisible to the
    // query). The prefix is checked without a trailing separator so the server
    // root itself stays reachable, matching the resolver contract.
    const filesRoot = path.resolve(m.dir());
    const absResolved = path.resolve(abs);
    if (absResolved.startsWith(filesRoot)) {
      try {
        const entries = fs.readdirSync(absResolved, { withFileTypes: true });
        const out = entries.map((e) => {
          let size = 0, mtime = 0;
          const child = path.join(absResolved, e.name);
          if (child.startsWith(filesRoot)) {
            try { const st = fs.statSync(child); size = st.size; mtime = st.mtimeMs; } catch {}
          }
          return { name: e.name, dir: e.isDirectory(), size, mtime, editable: e.isFile() && isTextFile(e.name) };
        }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
        res.json({ path: path.relative(m.dir(), abs).replace(/\\/g, '/'), entries: out });
      } catch (err) {
        httpError(res, req, err, 400);
      }
    } else {
      return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
    }
  });

  router.get('/read', (req, res) => {
    const m = targetManager(req);
    if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    const abs = safeResolveNoFollow(m.dir(), req.query.path || '');
    if (!abs) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
    const filesRoot = path.resolve(m.dir());
    const absResolved = path.resolve(abs);
    if (absResolved.startsWith(filesRoot)) {
      try {
        const st = fs.statSync(absResolved);
        if (st.isDirectory()) return res.status(400).json({ error: tErr(req.user, 'errors.isAFolder') });
        if (st.size > MAX_EDIT_BYTES) return res.status(413).json({ error: tErr(req.user, 'errors.fileTooLarge') });
        if (!isTextFile(path.basename(absResolved))) return res.status(415).json({ error: tErr(req.user, 'errors.notATextFile') });
        res.json({ content: fs.readFileSync(absResolved, 'utf8') });
      } catch (err) {
        httpError(res, req, err, 400);
      }
    } else {
      return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
    }
  });

  router.put('/write', (req, res) => {
    const m = targetManager(req);
    if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    const abs = safeResolveNoFollow(m.dir(), req.body && req.body.path);
    if (!abs) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
    const content = req.body && req.body.content;
    if (typeof content !== 'string') return res.status(400).json({ error: tErr(req.user, 'errors.missingContent') });
    const filesRoot = path.resolve(m.dir());
    const absResolved = path.resolve(abs);
    if (absResolved.startsWith(filesRoot)) {
      try {
        if (m.desc().type === 'palworld' && absResolved === path.resolve(palworldSettings.configPath(m.dir()))) {
          const guarded = palworldSettings.validateProtectedRaw(content, m.desc());
          if (!guarded.ok) return res.status(409).json({ error: guarded.error, code: 'protected_palworld_setting' });
        }
        fs.writeFileSync(absResolved, content, 'utf8');
        res.json({ ok: true });
      } catch (err) {
        httpError(res, req, err, 500);
      }
    } else {
      return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
    }
  });

  router.post('/mkdir', (req, res) => {
    const m = targetManager(req);
    if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    const name = path.basename(String((req.body && req.body.name) || '').trim());
    if (!name) return res.status(400).json({ error: tErr(req.user, 'errors.nameRequiredShort') });
    const abs = safeResolveNoFollow(m.dir(), path.join(req.body.path || '', name));
    if (!abs) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
    const filesRoot = path.resolve(m.dir());
    const absResolved = path.resolve(abs);
    if (absResolved.startsWith(filesRoot)) {
      try {
        fs.mkdirSync(absResolved, { recursive: true });
        res.json({ ok: true });
      } catch (err) {
        httpError(res, req, err, 500);
      }
    } else {
      return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
    }
  });

  router.post('/rename', (req, res) => {
    const m = targetManager(req);
    if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    const from = safeResolveNoFollow(m.dir(), req.body && req.body.path);
    const newName = path.basename(String((req.body && req.body.name) || '').trim());
    if (!from || !newName) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
    const to = path.join(path.dirname(from), newName);
    // The destination is the sibling of an allowed source, so it is canonically
    // inside the root whenever `from` is - but check it anyway so a rename can
    // never land on a symlink pointing out of the sandbox.
    const toRel = pathSafety.relation(to, m.dir());
    if (toRel !== 'same' && toRel !== 'inside') return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
    // The source and destination are both user-influenced; restate containment
    // in the positive-startsWith shape at the rename sink (js/path-injection).
    // CodeQL 2.26.3 registers positive startsWith guards with the use in the
    // true branch (negated/compound conditions are invisible to the query).
    const filesRoot = path.resolve(m.dir());
    const fromResolved = path.resolve(from);
    const toResolved = path.resolve(to);
    if (fromResolved.startsWith(filesRoot) && toResolved.startsWith(filesRoot)) {
      try {
        fs.renameSync(fromResolved, toResolved);
        res.json({ ok: true });
      } catch (err) {
        httpError(res, req, err, 500);
      }
    } else {
      return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
    }
  });

  router.delete('/', (req, res) => {
    const m = targetManager(req);
    if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    const abs = safeResolveNoFollow(m.dir(), req.query.path || '');
    if (!abs || abs === path.resolve(m.dir())) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
    const filesRoot = path.resolve(m.dir());
    const absResolved = path.resolve(abs);
    if (absResolved.startsWith(filesRoot)) {
      try {
        fs.rmSync(absResolved, { recursive: true, force: true });
        res.json({ ok: true });
      } catch (err) {
        httpError(res, req, err, 500);
      }
    } else {
      return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
    }
  });

  router.get('/download', (req, res) => {
    const m = targetManager(req);
    if (!m || !m.dir()) return res.status(400).json({ error: tErr(req.user, 'errors.noActiveServer') });
    const abs = safeResolveNoFollow(m.dir(), req.query.path || '');
    if (!abs) return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
    const filesRoot = path.resolve(m.dir());
    const absResolved = path.resolve(abs);
    if (absResolved.startsWith(filesRoot)) {
      try {
        if (fs.statSync(absResolved).isDirectory()) return res.status(400).json({ error: tErr(req.user, 'errors.cannotDownloadFolder') });
        res.download(absResolved, path.basename(absResolved));
      } catch {
        res.status(404).json({ error: tErr(req.user, 'errors.fileDoesNotExist') });
      }
    } else {
      return res.status(400).json({ error: tErr(req.user, 'errors.invalidPath') });
    }
  });

  router.post('/upload', fileUpload.array('files'), (req, res) => {
    res.json({ ok: true, count: Array.isArray(req.files) ? req.files.length : 0 });
  }, (err, req, res, _next) => {
    httpError(res, req, err, 400);
  });

  return router;
};
