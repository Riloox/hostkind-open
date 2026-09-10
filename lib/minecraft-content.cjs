'use strict';

const PROVIDERS = Object.freeze({
  modrinth: Object.freeze({
    id: 'modrinth', label: 'Modrinth', verification: 'verified', available: true,
    capabilities: Object.freeze({ catalog: true, plugin: true, mod: true, modpack: true, create: true, update: true, upload: false }),
  }),
  curseforge: Object.freeze({
    id: 'curseforge', label: 'CurseForge Import', verification: 'user_supplied', available: true,
    capabilities: Object.freeze({ catalog: false, plugin: true, mod: true, modpack: true, create: true, update: 'manual', upload: true }),
  }),
  ftb: Object.freeze({
    id: 'ftb', label: 'FTB Installer', verification: 'verified', available: true,
    capabilities: Object.freeze({ catalog: false, plugin: false, mod: false, modpack: true, create: true, update: true, upload: true, executable: true }),
  }),
});

const CONTENT_KINDS = Object.freeze(['plugin', 'mod', 'modpack']);
const VERIFICATION = Object.freeze(['verified', 'user_supplied', 'user_attested', 'unverified']);

function provider(id) { return PROVIDERS[String(id || '').toLowerCase()] || null; }
function listProviders({ isAdmin = false } = {}) {
  return Object.values(PROVIDERS).map((item) => ({
    ...item,
    capabilities: { ...item.capabilities, executeAvailable: item.id !== 'ftb' || isAdmin },
  }));
}
function normalizeProject(raw, providerId = 'modrinth') {
  const p = provider(providerId);
  if (!p) throw Object.assign(new Error('Unknown content provider'), { code: 'unknown_provider' });
  const kind = String(raw.project_type || raw.kind || raw.type || '').toLowerCase();
  return {
    provider: p.id, projectId: String(raw.project_id || raw.id || ''),
    kind: CONTENT_KINDS.includes(kind) ? kind : 'modpack',
    name: String(raw.title || raw.name || ''), description: String(raw.description || raw.summary || ''),
    iconUrl: raw.icon_url || raw.iconUrl || null, downloads: Number(raw.downloads || 0),
    source: { provider: p.id, projectId: String(raw.project_id || raw.id || '') },
    verification: p.verification,
  };
}
function normalizeVersion(raw, providerId = 'modrinth') {
  const p = provider(providerId);
  if (!p) throw Object.assign(new Error('Unknown content provider'), { code: 'unknown_provider' });
  return {
    provider: p.id, projectId: String(raw.project_id || raw.projectId || ''), versionId: String(raw.id || raw.versionId || ''),
    name: String(raw.name || raw.version_name || raw.versionName || ''), versionNumber: String(raw.version_number || raw.versionNumber || ''),
    minecraftVersions: [...(raw.game_versions || raw.minecraftVersions || [])], loaders: [...(raw.loaders || [])],
    files: (raw.files || []).map((f) => ({ name: String(f.filename || f.name || ''), url: f.url || null, size: Number(f.size || 0), primary: !!f.primary, checksums: { ...(f.hashes || f.checksums || {}) } })),
    source: { provider: p.id, projectId: String(raw.project_id || raw.projectId || ''), versionId: String(raw.id || raw.versionId || '') },
    verification: p.verification,
  };
}

module.exports = { PROVIDERS, CONTENT_KINDS, VERIFICATION, provider, listProviders, normalizeProject, normalizeVersion };
