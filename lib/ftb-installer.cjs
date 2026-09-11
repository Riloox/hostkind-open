'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TIMEOUT_MS = 60 * 60 * 1000;
// Multer stages FTB installers under <repo>/data/content-uploads/<uuid>/<basename>.
// Re-assert containment before any fs call (CodeQL js/path-injection).
const INSTALLER_UPLOAD_ROOT = path.resolve(__dirname, '..', 'data', 'content-uploads');
function resolveInstallerUploadPath(file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw Object.assign(new Error('Invalid installer path.'), { code: 'invalid_path' });
  const resolved = path.resolve(file);
  if (resolved !== INSTALLER_UPLOAD_ROOT && !resolved.startsWith(INSTALLER_UPLOAD_ROOT + path.sep)) throw Object.assign(new Error('Invalid installer path.'), { code: 'invalid_path' });
  return resolved;
}
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(resolveInstallerUploadPath(file))).digest('hex');
function platformAsset({ platform = process.platform, arch = process.arch } = {}) {
  const os = platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : null;
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (!os || !cpu) throw Object.assign(new Error(`Unsupported FTB installer platform: ${platform}/${arch}`), { code: 'unsupported_platform' });
  return { os, arch: cpu, matcher: new RegExp(`${os}[-_.].*${cpu}|${cpu}[-_.].*${os}`, 'i') };
}
function selectReleaseAsset(release, runtime = {}) {
  const target = platformAsset(runtime); const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find((a) => target.matcher.test(a.name || '') && !/sha(?:256)?|checksum/i.test(a.name || ''));
  if (!asset) throw Object.assign(new Error('No FTB installer asset exists for this platform'), { code: 'asset_not_found' });
  const digestAsset = assets.find((a) => /sha256|checksums?/i.test(a.name || ''));
  if (!asset.digest && !digestAsset) throw Object.assign(new Error('FTB did not publish a SHA-256 digest for this installer'), { code: 'digest_required' });
  return { asset, digestAsset: digestAsset || null, target };
}
function buildArgs({ stagingDir, packId, versionId, latest = false, acceptEula = false }) {
  if (!/^\d+$/.test(String(packId || ''))) throw Object.assign(new Error('A numeric FTB pack ID is required'), { code: 'invalid_pack_id' });
  if (!latest && !/^\d+$/.test(String(versionId || ''))) throw Object.assign(new Error('A numeric FTB version ID or latest is required'), { code: 'invalid_version_id' });
  const args = ['-auto', '-validate', '-no-colours', '-dir', path.resolve(stagingDir), '-pack', String(packId), latest ? '-latest' : '-version'];
  if (!latest) args.push(String(versionId));
  if (acceptEula) args.push('-accept-eula');
  return args;
}
function readManifest(stagingDir) {
  const file = path.join(stagingDir, '.manifest.json');
  if (!fs.existsSync(file)) throw Object.assign(new Error('FTB installer did not create .manifest.json'), { code: 'manifest_missing' });
  let raw; try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw Object.assign(new Error('FTB .manifest.json is malformed'), { code: 'manifest_malformed' }); }
  return { raw, packId: String(raw.id ?? raw.packId ?? raw.pack?.id ?? ''), name: String(raw.name ?? raw.pack?.name ?? ''), versionId: String(raw.versionId ?? raw.version?.id ?? ''), versionName: String(raw.versionName ?? raw.version?.name ?? ''), minecraftVersion: String(raw.minecraftVersion ?? raw.minecraft?.version ?? ''), loader: String(raw.loader ?? raw.modLoader?.name ?? '').toLowerCase(), javaVersion: Number(raw.javaVersion ?? raw.java?.version ?? 0) || null, files: Array.isArray(raw.files) ? raw.files : [] };
}
function run({ executable, stagingDir, packId, versionId, latest, acceptEula, timeoutMs = TIMEOUT_MS, signal, onLine = () => {} }) {
  fs.mkdirSync(stagingDir, { recursive: true });
  if (fs.readdirSync(stagingDir).length) throw Object.assign(new Error('FTB staging directory must be fresh'), { code: 'staging_not_empty' });
  const args = buildArgs({ stagingDir, packId, versionId, latest, acceptEula });
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: stagingDir, shell: false, windowsHide: true }); let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
    const emit = (stream) => (chunk) => String(chunk).split(/\r?\n/).filter(Boolean).forEach((line) => onLine(line));
    child.stdout.on('data', emit('stdout')); child.stderr.on('data', emit('stderr'));
    const abort = () => { try { process.kill(child.pid, 'SIGTERM'); } catch {} finish(reject, Object.assign(new Error('FTB installer cancelled'), { code: 'cancelled' })); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { try { process.kill(child.pid, 'SIGTERM'); } catch {} finish(reject, Object.assign(new Error('FTB installer timed out'), { code: 'timeout' })); }, timeoutMs);
    child.on('error', (error) => finish(reject, error));
    child.on('exit', (code) => code === 0 ? finish(resolve, readManifest(stagingDir)) : finish(reject, Object.assign(new Error(`FTB installer exited with code ${code}`), { code: 'nonzero_exit', exitCode: code })));
  });
}

module.exports = { TIMEOUT_MS, sha256File, platformAsset, selectReleaseAsset, buildArgs, readManifest, run };
