'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Parse a CurseForge manifest.json into deploy metadata. Never throws for
// missing fields; returns empty strings so callers can persist honestly.
function curseManifestMeta(manifest) {
  const mc = manifest && typeof manifest === 'object' ? manifest.minecraft || {} : {};
  const loaders = Array.isArray(mc.modLoaders) ? mc.modLoaders : [];
  const firstLoaderId = loaders.find((l) => l && l.id) ? String(loaders.find((l) => l && l.id).id) : '';
  const loader = firstLoaderId.split('-')[0].toLowerCase();
  return {
    displayName: String((manifest && (manifest.name || manifest.title)) || ''),
    versionName: String((manifest && (manifest.version || manifest.versionName)) || ''),
    mcVersion: String(mc.version || ''),
    loader: ['fabric', 'forge', 'neoforge', 'quilt'].includes(loader) ? loader : loader,
    overridesDir: String((manifest && manifest.overrides) || 'overrides'),
  };
}

// Map a stripped ZIP entry to its deploy path. CurseForge server packs keep
// payload at the root and user content under overrides/. Returns null for
// manifest.json (metadata only).
function curseDeployPath(stripped, overridesDir = 'overrides') {
  const rel = String(stripped || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.toLowerCase() === 'manifest.json') return null;
  const prefix = `${String(overridesDir || 'overrides').replace(/\/+$/, '')}/`.toLowerCase();
  if (rel.toLowerCase().startsWith(prefix)) return rel.slice(prefix.length);
  return rel;
}

function normalizeRelative(input) {
  if (typeof input !== 'string' || !input || input.includes('\0')) return null;
  const rel = input.replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.posix.isAbsolute(rel) || /^[a-z]:/i.test(rel)) return null;
  const normalized = path.posix.normalize(rel);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function safeResolve(baseDir, relativePath) {
  const resolved = path.resolve(baseDir, relativePath);
  const base = path.resolve(baseDir);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

// Walk a staging dir into [{relativePath(posix), sizeBytes, sha256, abs}].
function walkStaging(stagingDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        const rel = path.relative(stagingDir, abs).split(path.sep).join('/');
        const buf = fs.readFileSync(abs);
        out.push({ relativePath: rel, sizeBytes: buf.length, sha256: sha256Buffer(buf), abs });
      }
    }
  };
  if (fs.existsSync(stagingDir)) walk(stagingDir);
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function checkDecisions(plan, decisions) {
  const missing = (plan.groups.conflicts || []).filter((c) => !['keep_local', 'take_pack'].includes(decisions[c.relativePath]));
  if (missing.length) {
    throw Object.assign(new Error(`A decision is required for ${missing[0].relativePath}.`), {
      code: 'conflicts_required',
      status: 409,
      conflicts: missing.map((c) => c.relativePath),
    });
  }
}

module.exports = { sha256Buffer, curseManifestMeta, curseDeployPath, normalizeRelative, safeResolve, walkStaging, checkDecisions };
