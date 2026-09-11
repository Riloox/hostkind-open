'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yauzl = require('yauzl');
const archiveGuard = require('./archiveGuard.cjs');
const modpacks = require('./modpacks.cjs');

const ZIP_OPTIONS = { maxEntries: modpacks.MAX_FILES, maxEntrySize: modpacks.MAX_FILE_BYTES, maxTotalSize: modpacks.MAX_TOTAL_BYTES };
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Multer stages uploads under <repo>/data/content-uploads/<uuid>/<basename>.
// Pin reads to that root so user-influenced paths cannot escape (CodeQL js/path-injection).
// NOTE: the containment check must stay INLINE in inspectZip/inspectJar —
// CodeQL does not model custom helper-call sanitizers.
const UPLOAD_ROOT = path.resolve(__dirname, '..', 'data', 'content-uploads');

function unresolvedReferences(manifest) {
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  return files.filter((f) => f && f.projectID != null && f.fileID != null).map((f) => `${f.projectID}:${f.fileID}`);
}
function commonRoot(names) {
  const parts = names.filter(Boolean).map((n) => n.replace(/\\/g, '/').split('/').filter(Boolean));
  if (!parts.length || parts.some((p) => p.length < 2)) return '';
  const candidate = parts[0][0];
  return parts.every((p) => p[0].toLowerCase() === candidate.toLowerCase()) ? candidate : '';
}
function stripCommonRoot(name, root) {
  const normalized = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
  return root && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? normalized.slice(root.length + 1) : normalized;
}

function inspectZip(filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) throw Object.assign(new Error('Invalid upload path.'), { code: 'invalid_path' });
  filePath = path.resolve(filePath);
  if (filePath !== UPLOAD_ROOT && !filePath.startsWith(UPLOAD_ROOT + path.sep)) throw Object.assign(new Error('Invalid upload path.'), { code: 'invalid_path' });
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, decodeStrings: true }, (openError, zip) => {
      if (openError) return reject(openError);
      const state = {}; const entries = []; const contents = new Map();
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        let normalized;
        try { normalized = archiveGuard.checkEntry(entry, state, ZIP_OPTIONS); } catch (error) { zip.close(); reject(error); return; }
        entries.push({ entry, name: normalized });
        if (/\/$/.test(entry.fileName)) return zip.readEntry();
        if (!/(^|\/)manifest\.json$/i.test(normalized)) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = []; let bytes = 0;
          stream.on('data', (chunk) => { bytes += chunk.length; if (bytes <= 2 * 1024 * 1024) chunks.push(chunk); });
          stream.on('end', () => { if (bytes > 2 * 1024 * 1024) return reject(Object.assign(new Error('manifest.json is too large'), { code: 'manifest_too_large' })); contents.set(normalized, Buffer.concat(chunks)); zip.readEntry(); });
          stream.on('error', reject);
        });
      });
      zip.on('end', () => {
        try { archiveGuard.finalize(state, ZIP_OPTIONS); } catch (error) { reject(error); return; }
        const root = commonRoot(entries.map((e) => e.name));
        const manifestEntry = [...contents.entries()].find(([name]) => stripCommonRoot(name, root).toLowerCase() === 'manifest.json');
        let manifest = null;
        if (manifestEntry) { try { manifest = JSON.parse(manifestEntry[1].toString('utf8')); } catch { return reject(Object.assign(new Error('Malformed CurseForge manifest.json'), { code: 'malformed_manifest' })); } }
        const files = entries.filter((e) => !/\/$/.test(e.name)).map((e) => stripCommonRoot(e.name, root));
        const payloadFiles = files.filter((name) => name.toLowerCase() !== 'manifest.json' && !/^overrides\//i.test(name));
        const embeddedServerPayload = files.filter((name) => /(?:^|\/)(?:server\.properties|run\.(?:sh|bat)|.*\.jar|libraries\/|mods\/)/i.test(name.replace(/^overrides\//i, '')));
        const unresolved = unresolvedReferences(manifest);
        const clientOnly = !!manifest && unresolved.length > 0 && payloadFiles.length === 0 && embeddedServerPayload.length === 0;
        resolve({ kind: 'modpack', provider: 'curseforge', verification: 'user_supplied', sha256: sha256(fs.readFileSync(filePath)), commonRoot: root || null, files, manifest, unresolved, selfContained: !clientOnly && (payloadFiles.length > 0 || embeddedServerPayload.length > 0), clientOnly, error: clientOnly ? 'This is a client export containing only CurseForge references and overrides. API-free installation is impossible.' : null });
      });
      zip.readEntry();
    });
  });
}

function inspectJar(filePath, metadata = {}) {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('\0')) throw Object.assign(new Error('Invalid upload path.'), { code: 'invalid_path' });
  filePath = path.resolve(filePath);
  if (filePath !== UPLOAD_ROOT && !filePath.startsWith(UPLOAD_ROOT + path.sep)) throw Object.assign(new Error('Invalid upload path.'), { code: 'invalid_path' });
  const name = path.basename(filePath);
  if (!/\.jar$/i.test(name)) throw Object.assign(new Error('Only .jar files are accepted'), { code: 'invalid_file_type' });
  return { kind: metadata.kind === 'mod' ? 'mod' : 'plugin', provider: 'curseforge', name, sha256: sha256(fs.readFileSync(filePath)), verification: 'user_supplied', source: { provider: 'curseforge', projectId: metadata.projectId ? String(metadata.projectId) : null, fileId: metadata.fileId ? String(metadata.fileId) : null, sourceKind: 'jar_upload' }, updateMode: 'manual_replacement' };
}

module.exports = { ZIP_OPTIONS, unresolvedReferences, commonRoot, stripCommonRoot, inspectZip, inspectJar };
