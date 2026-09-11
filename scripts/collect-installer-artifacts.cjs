'use strict';

/*
 * Collect the 0.1.2.3 desktop installer assets into release artifacts.
 *
 * Two steps, run from the repository root:
 *
 *   node scripts/collect-installer-artifacts.cjs --portable-zip
 *     Zips dist-electron/win-unpacked (emitted alongside the NSIS build)
 *     into dist-electron/Hostkind-<version>-Portable.zip, the fallback for
 *     hosts where Smart App Control blocks the unsigned NSIS installer.
 *     No-op when win-unpacked is absent (e.g. a Linux-only build).
 *
 *   node scripts/collect-installer-artifacts.cjs --manifest \
 *     --tag v0.1.2.3 --repository Riloox/hostkind-open \
 *     --assets-dir dist --output dist/application-artifacts.json
 *     Scans the assets directory for the installer files, hashes each with
 *     SHA-256, writes a `<asset>.sha256` sidecar next to it, and emits the
 *     `{ artifacts: { 'windows-x64': {...}, 'linux-x64': {...} } }` payload
 *     consumed by scripts/create-update-manifest.cjs. URLs point at the
 *     GitHub release download page for the tag, so run this before
 *     `gh release create` with the same tag.
 *
 * The updater manifest carries one artifact per platform: the NSIS setup for
 * windows-x64 and the AppImage for linux-x64. The portable zip and the .deb
 * are published to the release for manual download; they are hashed and
 * listed in the console output but are not updater artifacts.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

const ROOT = path.resolve(__dirname, '..');
const DIST_ELECTRON = path.join(ROOT, 'dist-electron');

function parseArgs(argv) {
  const out = {
    portableZip: false,
    manifest: false,
    tag: null,
    repository: 'Riloox/hostkind-open',
    version: null,
    assetsDir: path.join(ROOT, 'dist'),
    output: path.join(ROOT, 'dist', 'application-artifacts.json'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--portable-zip') out.portableZip = true;
    else if (arg === '--manifest') out.manifest = true;
    else if (arg === '--tag') out.tag = argv[(i += 1)] || null;
    else if (arg.startsWith('--tag=')) out.tag = arg.slice('--tag='.length);
    else if (arg === '--repository') out.repository = argv[(i += 1)] || out.repository;
    else if (arg.startsWith('--repository=')) out.repository = arg.slice('--repository='.length);
    else if (arg === '--version') out.version = argv[(i += 1)] || null;
    else if (arg.startsWith('--version=')) out.version = arg.slice('--version='.length);
    else if (arg === '--assets-dir') out.assetsDir = path.resolve(argv[(i += 1)] || out.assetsDir);
    else if (arg.startsWith('--assets-dir=')) out.assetsDir = path.resolve(arg.slice('--assets-dir='.length));
    else if (arg === '--output') out.output = path.resolve(argv[(i += 1)] || out.output);
    else if (arg.startsWith('--output=')) out.output = path.resolve(arg.slice('--output='.length));
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function readVersion(explicit) {
  if (explicit) return explicit;
  return require(path.join(ROOT, 'package.json')).version;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
    input.on('error', reject);
  });
}

function zipDirectory(sourceDir, outFile) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outFile);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

// Find the installer files electron-builder emitted. Returns at most one
// entry per kind: setupExe, portableZip, appImage, deb.
function findInstallerAssets(dir) {
  const found = { setupExe: null, portableZip: null, appImage: null, deb: null };
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (!fs.statSync(abs).isFile()) continue;
    if (/^Hostkind-.*-Setup\.exe$/.test(entry)) found.setupExe = abs;
    else if (/^Hostkind-.*-Portable\.zip$/.test(entry)) found.portableZip = abs;
    else if (/^Hostkind-.*\.AppImage$/.test(entry)) found.appImage = abs;
    else if (entry.endsWith('.deb')) found.deb = abs;
  }
  return found;
}

function downloadUrl({ repository, tag, name }) {
  return `https://github.com/${repository}/releases/download/${tag}/${name}`;
}

async function writePortableZip({ version, distElectron = DIST_ELECTRON }) {
  const unpacked = path.join(distElectron, 'win-unpacked');
  if (!fs.existsSync(unpacked) || !fs.statSync(unpacked).isDirectory()) {
    console.log('collect-installer-artifacts: no win-unpacked directory, skipping portable zip');
    return null;
  }
  const outFile = path.join(distElectron, `Hostkind-${version}-Portable.zip`);
  await zipDirectory(unpacked, outFile);
  const hash = await sha256File(outFile);
  fs.writeFileSync(`${outFile}.sha256`, `${hash}  ${path.basename(outFile)}\n`);
  console.log(`collect-installer-artifacts: wrote ${outFile}`);
  console.log(`  ${hash}  ${path.basename(outFile)}`);
  return outFile;
}

async function writeManifest({ version, tag, repository, assetsDir, output }) {
  if (!tag) throw new Error('--manifest requires --tag (e.g. v0.1.2.3)');
  // Same convention as scripts/package.cjs: the project versions patch builds
  // with a fourth component (0.1.2.3), so accept X.Y.Z or X.Y.Z.W with no
  // leading zeros. This payload is version-agnostic (names, URLs, hashes);
  // four-part versions are now signable: scripts/create-update-manifest.cjs
  // delegates to validateManifest, which accepts X.Y.Z[.W].
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.test(version)) {
    throw new Error(`refusing to manifest a non-semver version: ${version}`);
  }
  const found = findInstallerAssets(assetsDir);
  const artifacts = {};
  const hashed = [];
  if (found.setupExe) {
    const name = path.basename(found.setupExe);
    const sha256 = await sha256File(found.setupExe);
    fs.writeFileSync(`${found.setupExe}.sha256`, `${sha256}  ${name}\n`);
    artifacts['windows-x64'] = { name, url: downloadUrl({ repository, tag, name }), sha256 };
    hashed.push({ name, sha256 });
  }
  if (found.appImage) {
    const name = path.basename(found.appImage);
    const sha256 = await sha256File(found.appImage);
    fs.writeFileSync(`${found.appImage}.sha256`, `${sha256}  ${name}\n`);
    artifacts['linux-x64'] = { name, url: downloadUrl({ repository, tag, name }), sha256 };
    hashed.push({ name, sha256 });
  }
  // Published for manual download with checksums, but not updater artifacts.
  for (const extra of [found.portableZip, found.deb]) {
    if (!extra) continue;
    const name = path.basename(extra);
    const sha256 = await sha256File(extra);
    fs.writeFileSync(`${extra}.sha256`, `${sha256}  ${name}\n`);
    hashed.push({ name, sha256 });
  }
  if (Object.keys(artifacts).length === 0) {
    throw new Error(`no updater installer assets (Setup.exe or AppImage) found in ${assetsDir}`);
  }
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(path.resolve(output), `${JSON.stringify({ artifacts }, null, 2)}\n`, 'utf8');
  console.log(`collect-installer-artifacts: wrote ${output}`);
  for (const { name, sha256 } of hashed) console.log(`  ${sha256}  ${name}`);
  return { path: path.resolve(output), artifacts };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || (!args.portableZip && !args.manifest)) {
    console.log('Usage: node scripts/collect-installer-artifacts.cjs [--portable-zip] [--manifest --tag vX.Y.Z[.W] [--repository Riloox/hostkind-open] [--version X.Y.Z[.W]] [--assets-dir dist] [--output dist/application-artifacts.json]]');
    return;
  }
  const version = readVersion(args.version);
  if (args.portableZip) await writePortableZip({ version });
  if (args.manifest) {
    await writeManifest({
      version,
      tag: args.tag,
      repository: args.repository,
      assetsDir: args.assetsDir,
      output: args.output,
    });
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`collect-installer-artifacts failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  readVersion,
  sha256File,
  findInstallerAssets,
  downloadUrl,
  writePortableZip,
  writeManifest,
};
