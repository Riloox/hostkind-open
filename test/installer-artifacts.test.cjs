'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseArgs,
  findInstallerAssets,
  downloadUrl,
  writeManifest,
  writePortableZip,
} = require('../scripts/collect-installer-artifacts.cjs');
const { validateManifest } = require('../lib/application-release.cjs');

async function main() {
  // parseArgs defaults keep the release repository and dist layout.
  const defaults = parseArgs([]);
  assert.strictEqual(defaults.repository, 'Riloox/hostkind-open');
  assert.strictEqual(defaults.portableZip, false);
  assert.strictEqual(defaults.manifest, false);
  assert.strictEqual(parseArgs(['--portable-zip']).portableZip, true);
  assert.strictEqual(parseArgs(['--tag', 'v0.1.2.3']).tag, 'v0.1.2.3');

  assert.strictEqual(
    downloadUrl({ repository: 'Riloox/hostkind-open', tag: 'v0.1.2.3', name: 'Hostkind-0.1.2.3-Setup.exe' }),
    'https://github.com/Riloox/hostkind-open/releases/download/v0.1.2.3/Hostkind-0.1.2.3-Setup.exe',
  );

  // Fixture tree: installer assets are picked up, the source zip is ignored.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-installers-'));
  try {
    const files = {
      'Hostkind-0.1.2.3-Setup.exe': 'fake-setup',
      'Hostkind-0.1.2.3-Portable.zip': 'fake-portable',
      'Hostkind-0.1.2.3.AppImage': 'fake-appimage',
      'hostkind_0.1.2.3_amd64.deb': 'fake-deb',
      'hostkind-0.1.2.3.zip': 'source-zip-is-not-an-installer',
    };
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(staging, name), content);
    }

    const found = findInstallerAssets(staging);
    assert.strictEqual(path.basename(found.setupExe), 'Hostkind-0.1.2.3-Setup.exe');
    assert.strictEqual(path.basename(found.portableZip), 'Hostkind-0.1.2.3-Portable.zip');
    assert.strictEqual(path.basename(found.appImage), 'Hostkind-0.1.2.3.AppImage');
    assert.strictEqual(path.basename(found.deb), 'hostkind_0.1.2.3_amd64.deb');

    const output = path.join(staging, 'out', 'application-artifacts.json');
    const { artifacts } = await writeManifest({
      version: '0.1.2.3',
      tag: 'v0.1.2.3',
      repository: 'Riloox/hostkind-open',
      assetsDir: staging,
      output,
    });

    // Updater platforms point at the NSIS setup and the AppImage.
    assert.strictEqual(
      artifacts['windows-x64'].url,
      'https://github.com/Riloox/hostkind-open/releases/download/v0.1.2.3/Hostkind-0.1.2.3-Setup.exe',
    );
    assert.strictEqual(
      artifacts['linux-x64'].url,
      'https://github.com/Riloox/hostkind-open/releases/download/v0.1.2.3/Hostkind-0.1.2.3.AppImage',
    );
    assert.match(artifacts['windows-x64'].sha256, /^[0-9a-f]{64}$/);
    assert.match(artifacts['linux-x64'].sha256, /^[0-9a-f]{64}$/);

    // Every installer asset gets a checksum sidecar.
    for (const name of Object.keys(files).slice(0, 4)) {
      assert.ok(fs.existsSync(path.join(staging, `${name}.sha256`)), `missing sidecar for ${name}`);
    }

    // The emitted payload satisfies the updater's fail-closed artifact shape.
    // Note the manifest version here is strict X.Y.Z while the file names
    // carry the project's four-part patch version. Four-part releases
    // (X.Y.Z.W) also validate and receive a signed updater manifest; older
    // 0.1.2.x installers shipped for manual download only (see UPGRADING.md).
    const manifest = {
      schema: 1,
      product: 'hostkind',
      edition: 'open',
      version: '0.1.2',
      channel: 'stable',
      priority: 'normal',
      releaseNotesUrl: 'https://github.com/Riloox/hostkind-open/releases/tag/v0.1.2.3',
      artifacts,
    };
    validateManifest(manifest, { platformKey: 'windows-x64' });
    validateManifest(manifest, { platformKey: 'linux-x64' });

    // Non-semver versions and empty asset dirs fail loudly, never silently.
    await assert.rejects(
      () => writeManifest({
        version: 'not-a-version', tag: 'v0.1.2.3', repository: 'Riloox/hostkind-open',
        assetsDir: staging, output: path.join(staging, 'bad.json'),
      }),
      /semver/,
    );
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-installers-empty-'));
    await assert.rejects(
      () => writeManifest({
        version: '0.1.2.3', tag: 'v0.1.2.3', repository: 'Riloox/hostkind-open',
        assetsDir: empty, output: path.join(empty, 'application-artifacts.json'),
      }),
      /no updater installer assets/,
    );
    fs.rmSync(empty, { recursive: true, force: true });

    // Portable-zip step: absent win-unpacked is a no-op, present it zips.
    const noUnpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-nounpacked-'));
    assert.strictEqual(await writePortableZip({ version: '0.1.2.3', distElectron: noUnpacked }), null);
    const withUnpacked = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-unpacked-'));
    fs.mkdirSync(path.join(withUnpacked, 'win-unpacked'));
    fs.writeFileSync(path.join(withUnpacked, 'win-unpacked', 'Hostkind.exe'), 'fake-exe');
    const zipPath = await writePortableZip({ version: '0.1.2.3', distElectron: withUnpacked });
    assert.strictEqual(path.basename(zipPath), 'Hostkind-0.1.2.3-Portable.zip');
    assert.ok(fs.existsSync(`${zipPath}.sha256`));
    fs.rmSync(noUnpacked, { recursive: true, force: true });
    fs.rmSync(withUnpacked, { recursive: true, force: true });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }

  console.log('PASS installer-artifacts');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
