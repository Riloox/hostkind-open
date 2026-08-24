'use strict';

/*
 * Build the release artifact.
 *
 * Produces, in dist/:
 *   hostkind-<version>.zip          the shippable artifact
 *   hostkind-<version>.zip.sha256   sha256 of the archive, for verifying the
 *                                    download (`sha256sum -c <file>` from dist/)
 *   SHA256SUMS                       sha256 of the archive and of every file
 *                                    inside it - the full shipping manifest
 *
 * The artifact is a cross-platform source release with the SPA prebuilt: it
 * contains server.js, lib/, i18n.*, the built public/, resources/ (minus the
 * runtime cache in resources/installers), config.example.json, the license
 * files, README.md, CHANGELOG.md, package.json + package-lock.json, and a
 * generated version.json. A copy of SHA256SUMS ships inside the archive so a
 * customer can verify an extracted tree with `sha256sum -c SHA256SUMS`.
 *
 * Dependencies are not vendored - `npm ci --omit=dev` on the receiving machine
 * installs them from package-lock.json - so the same zip serves Windows, Linux
 * and macOS, and node_modules (with its platform-specific native binaries)
 * never bloats the artifact.
 *
 * Refuses to run when public/ has not been built: the panel serves public/, and
 * shipping an artifact whose panel renders nothing would be worse than refusing
 * to package one. Run `npm run build` first.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const archiver = require('archiver');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const PUBLIC_INDEX = path.join(ROOT, 'public', 'index.html');

// Roots of the shipped tree, relative to ROOT. resources/installers is a
// runtime cache (downloaded SteamCMD, gitignored) and is excluded - the server
// re-downloads it on demand, so it does not belong in a release.
const SHIPPED_ROOTS = [
  'server.js',
  'scripts',
  'lib',
  'i18n.cjs',
  'i18n.json',
  'package.json',
  'package-lock.json',
  'resources',
  'public',
  'LICENSE',  'THIRD_PARTY_NOTICES.md',
  'config.example.json',
  'README.md',
  'CHANGELOG.md',
  'UPGRADING.md',
  'OPERATIONS.md',
];

function toPosix(p) {
  return p.split(path.sep).join('/');
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

// Walk a directory, returning { abs, rel } for every file, where rel uses
// forward slashes and is relative to the walked root.
function walk(dir, rel) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (relPath === 'resources/installers') continue;
      out.push(...walk(abs, relPath));
    } else {
      out.push({ abs, rel: relPath });
    }
  }
  return out;
}

function zipDirectory(sourceDir, outFile) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outFile);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    // destpath false: put the staging contents at the archive root.
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

function parseVersion(argv) {
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version') {
      if (argv[i + 1] == null) throw new Error('--version requires a value');
      return argv[i + 1];
    }
    if (arg.startsWith('--version=')) return arg.slice('--version='.length);
  }
  return null;
}

async function main() {
  if (!fs.existsSync(PUBLIC_INDEX)) {
    console.error('Hostkind: public/index.html is missing - the SPA has not been built.');
    console.error('Run `npm run build` first so the artifact contains the real panel.');
    process.exit(1);
  }

  const pkg = require(path.join(ROOT, 'package.json'));
  const version = parseVersion(process.argv) || pkg.version;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+/.test(version)) {
    throw new Error(`refusing to package a non-semver version: ${version}`);
  }

  const archiveName = `hostkind-${version}.zip`;
  const archivePath = path.join(DIST_DIR, archiveName);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-package-'));

  try {
    for (const root of SHIPPED_ROOTS) {
      const src = path.join(ROOT, root);
      if (!fs.existsSync(src)) {
        console.error(`warning: skipping missing shipped root: ${root}`);
        continue;
      }
      const dest = path.join(staging, root);
      if (fs.statSync(src).isDirectory()) {
        fs.cpSync(src, dest, {
          recursive: true,
          filter: (p) => {
            if (p === src) return true;
            const rel = toPosix(path.relative(src, p));
            if (rel === 'installers' || rel.startsWith('installers/')) return false;
            return true;
          },
        });
      } else {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
      }
    }

    fs.writeFileSync(
      path.join(staging, 'version.json'),
      `${JSON.stringify({
        name: pkg.name,
        version,
        engines: pkg.engines,
        builtAt: new Date().toISOString(),
        node: process.version,
      }, null, 2)}\n`
    );

    const entries = walk(staging, '');
    const lines = [];
    for (const entry of entries) {
      if (entry.rel === 'SHA256SUMS') continue;
      lines.push(`${await sha256File(entry.abs)}  ${entry.rel}`);
    }
    lines.sort();

    // Manifest that ships inside the archive: verify an extracted tree with
    // `sha256sum -c SHA256SUMS`. The manifest deliberately does not list
    // itself.
    fs.writeFileSync(path.join(staging, 'SHA256SUMS'), `${lines.join('\n')}\n`);

    fs.mkdirSync(DIST_DIR, { recursive: true });
    await zipDirectory(staging, archivePath);

    const archiveHash = await sha256File(archivePath);
    const manifestHash = await sha256File(path.join(staging, 'SHA256SUMS'));
    // Sidecar for the download itself; relative name so `sha256sum -c` works
    // when run from dist/.
    fs.writeFileSync(
      path.join(DIST_DIR, `${archiveName}.sha256`),
      `${archiveHash}  ${archiveName}\n`
    );

    // Full shipping manifest: the archive, its sidecar, the in-archive
    // SHA256SUMS, and every file inside the archive.
    const distLines = [
      `${archiveHash}  ${archiveName}`,
      `${manifestHash}  SHA256SUMS`,
      ...lines,
    ];
    fs.writeFileSync(path.join(DIST_DIR, 'SHA256SUMS'), `${distLines.join('\n')}\n`);

    console.log(`packaged ${archivePath}`);
    console.log(`  ${archiveHash}  ${archiveName}`);
    console.log(`  ${await sha256File(path.join(DIST_DIR, `${archiveName}.sha256`))}  ${archiveName}.sha256`);
    console.log(`  sha256 of ${lines.length} shipped files in ${path.join(DIST_DIR, 'SHA256SUMS')}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`package failed: ${err.message}`);
  process.exit(1);
});
