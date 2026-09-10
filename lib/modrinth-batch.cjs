'use strict';

const fs = require('fs');
const path = require('path');
const { fetchToFile } = require('./downloads.cjs');
const { mapConcurrentSettled } = require('./concurrency.cjs');

const API_BASE = 'https://api.modrinth.com/v2';
const MAX_SELECTION = 50;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MODRINTH_HOST = (host) => host === 'cdn.modrinth.com' || host.endsWith('.modrinth.com');

class ModrinthBatchError extends Error {
  constructor(message, code = 'modrinth_batch_error') {
    super(message);
    this.code = code;
  }
}

function fail(message, code) {
  throw new ModrinthBatchError(message, code);
}

function selectionIds(projectIds) {
  if (!Array.isArray(projectIds)) fail('projectIds must be an array.', 'invalid_project_ids');
  const ids = [...new Set(projectIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) fail('Select at least one Modrinth project.', 'empty_selection');
  if (ids.length > MAX_SELECTION) fail(`Select no more than ${MAX_SELECTION} projects at once.`, 'selection_too_large');
  return ids;
}

async function defaultResolveVersions(projectId, compat, fetchImpl = global.fetch) {
  const loaders = JSON.stringify(Array.isArray(compat.loaders) ? compat.loaders : []);
  const gameVersions = JSON.stringify(compat.mcVersion ? [compat.mcVersion] : []);
  const url = `${API_BASE}/project/${encodeURIComponent(projectId)}/version?loaders=${encodeURIComponent(loaders)}&game_versions=${encodeURIComponent(gameVersions)}`;
  const response = await fetchImpl(url, { headers: { 'User-Agent': 'Hostkind/1.0' } });
  if (!response.ok) fail(`Modrinth version lookup failed: HTTP ${response.status}`, 'version_lookup_failed');
  const versions = await response.json();
  return Array.isArray(versions) ? versions : [];
}

function planProject(projectId, versions, compat) {
  const version = Array.isArray(versions) ? versions[0] : null;
  if (!version) fail('No compatible version was found.', 'no_compatible_version');
  const loaderOk = (version.loaders || []).some((loader) => (compat.loaders || []).includes(loader));
  const versionOk = !compat.mcVersion || (version.game_versions || []).includes(compat.mcVersion);
  if (!loaderOk || !versionOk) fail(`The selected project is not compatible with ${compat.label || 'this server'}.`, 'incompatible');
  const file = (version.files || []).find((candidate) => candidate.primary) || (version.files || [])[0];
  if (!file || typeof file.url !== 'string') fail('The selected version has no downloadable file.', 'no_version_file');
  const filename = path.basename(String(file.filename || ''));
  if (!filename || filename === '.' || filename === '..' || filename.includes('\0') || filename !== String(file.filename)) {
    fail('Modrinth returned an unsafe filename.', 'unsafe_filename');
  }
  return {
    projectId,
    version,
    file,
    filename,
    loader: (version.loaders || []).find((loader) => (compat.loaders || []).includes(loader)) || null,
  };
}

async function defaultDownload(url, destination, options = {}) {
  return fetchToFile(url, destination, {
    maxBytes: MAX_DOWNLOAD_BYTES,
    expectedSha256: options.expectedSha256 || null,
    allowlist: MODRINTH_HOST,
    extraHeaders: { 'User-Agent': 'Hostkind/1.0' },
  });
}

function outcomeFor(projectId) {
  return { projectId, status: 'failed', error: null };
}

async function installBatch({
  projectIds,
  compat,
  rootDir,
  resolveVersionsImpl = (projectId, currentCompat) => defaultResolveVersions(projectId, currentCompat),
  downloadImpl = defaultDownload,
  recordImpl = () => {},
  concurrency = 4,
}) {
  if (!compat || !rootDir || !['mods', 'plugins'].includes(compat.folder)) fail('Modrinth compatibility and target directory are required.', 'invalid_install_target');
  const ids = selectionIds(projectIds);
  fs.mkdirSync(path.join(rootDir, compat.folder), { recursive: true });
  const outcomes = ids.map(outcomeFor);
  const resolved = await mapConcurrentSettled(ids, (projectId) => resolveVersionsImpl(projectId, compat), { concurrency });
  const plans = [];
  resolved.forEach((result, index) => {
    if (result.status === 'rejected') {
      outcomes[index].error = result.reason?.message || 'Version lookup failed.';
      return;
    }
    try {
      const plan = planProject(ids[index], result.value, compat);
      plans.push({ index, ...plan, destination: path.join(rootDir, compat.folder, plan.filename) });
    } catch (error) {
      outcomes[index].error = error.message;
    }
  });

  const destinations = new Map();
  for (const plan of plans) {
    const key = process.platform === 'win32' ? plan.destination.toLowerCase() : plan.destination;
    const prior = destinations.get(key);
    if (prior) {
      outcomes[plan.index].error = 'Two selected projects use the same destination filename.';
      outcomes[prior.index].error = 'Two selected projects use the same destination filename.';
    } else destinations.set(key, plan);
  }
  const downloadable = plans.filter((plan) => !outcomes[plan.index].error);
  const downloaded = await mapConcurrentSettled(downloadable, async (plan) => {
    const result = await downloadImpl(plan.file.url, plan.destination, {
      expectedSha256: plan.file.hashes?.sha256 || null,
      projectId: plan.projectId,
      versionId: plan.version.id,
    });
    recordImpl({
      serverId: undefined,
      relativePath: path.relative(rootDir, plan.destination).split(path.sep).join('/'),
      kind: compat.folder === 'mods' ? 'mod' : 'plugin',
      projectId: plan.version.project_id || plan.projectId,
      versionId: plan.version.id,
      mcVersion: compat.mcVersion,
      loader: plan.loader,
      sha256: result?.sha256 || null,
    });
    return { plan, result };
  }, { concurrency });
  downloaded.forEach((result, downloadIndex) => {
    const plan = downloadable[downloadIndex];
    if (result.status === 'fulfilled') {
      outcomes[plan.index] = { projectId: plan.projectId, status: 'installed', name: plan.filename, versionId: plan.version.id };
    } else outcomes[plan.index].error = result.reason?.message || 'Download failed.';
  });
  return {
    ok: outcomes.every((outcome) => outcome.status === 'installed'),
    requested: ids,
    installed: outcomes.filter((outcome) => outcome.status === 'installed').map((outcome) => outcome.projectId),
    failed: outcomes.filter((outcome) => outcome.status !== 'installed').map((outcome) => outcome.projectId),
    results: outcomes,
  };
}

module.exports = { API_BASE, ModrinthBatchError, installBatch, planProject, selectionIds };
