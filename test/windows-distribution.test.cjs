'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const builderSource = fs.readFileSync(
  path.join(root, 'packaging', 'windows', 'electron-builder.cjs'),
  'utf8',
);
const ciWorkflow = fs.readFileSync(
  path.join(root, '.github', 'workflows', 'ci.yml'),
  'utf8',
);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lockJson = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const distributionDocPath = path.join(root, 'WINDOWS-DISTRIBUTION.md');
const distributionDoc = fs.existsSync(distributionDocPath)
  ? fs.readFileSync(distributionDocPath, 'utf8')
  : '';

// 0.1.2.3 contract: the NSIS installer is published unsigned, with a
// portable-zip fallback for hosts where Smart App Control blocks it.
assert.match(builderSource, /target:\s*\[\s*\{\s*target:\s*'nsis'/s);
assert.match(builderSource, /signExecutable:\s*false/);
assert.match(builderSource, /verifyUpdateCodeSignature:\s*false/);
assert.match(builderSource, /forceCodeSigning:\s*false/);
assert.doesNotMatch(
  builderSource,
  /azureSignOptions|Artifact Signing|TrustedSigning|HOSTKIND_ARTIFACT_SIGNING|AZURE_/i,
);

// The portable fallback is produced by scripts/collect-installer-artifacts.cjs
// from win-unpacked, not by a second electron-builder target.
const collectSource = fs.readFileSync(
  path.join(root, 'scripts', 'collect-installer-artifacts.cjs'),
  'utf8',
);
assert.match(collectSource, /win-unpacked/);
assert.match(collectSource, /Portable\.zip/);

assert.match(ciWorkflow, /build-installer-windows:/);
assert.match(ciWorkflow, /build-installer-linux:/);
assert.match(ciWorkflow, /--win nsis/);
assert.match(ciWorkflow, /Hostkind-\*-Setup\.exe/);
assert.match(ciWorkflow, /Hostkind-\*-Portable\.zip/);
assert.match(ciWorkflow, /needs:\s*\[test,\s*test-windows,\s*build-installer-windows,\s*build-installer-linux\]/);
assert.match(ciWorkflow, /release:/);
assert.match(ciWorkflow, /gh release create/);
assert.match(ciWorkflow, /dist\/hostkind-\*\.zip/);
assert.doesNotMatch(
  ciWorkflow,
  /azure\/login|id-token:\s*write|AZURE_|HOSTKIND_ARTIFACT_SIGNING/i,
);

assert.ok(packageJson.scripts['desktop:pack']);
assert.ok(packageJson.scripts['desktop:dist']);
assert.ok(packageJson.scripts['desktop:dist:win']);
assert.ok(packageJson.scripts['desktop:dist:linux']);
assert.ok(packageJson.scripts['installer:manifest']);
assert.match(packageJson.scripts['desktop:dev'], /desktop:install-app-deps/);
assert.match(packageJson.scripts['desktop:smoke'], /desktop:install-app-deps/);
assert.strictEqual(packageJson.devDependencies['@electron/rebuild'], '4.2.0');
assert.strictEqual(
  packageJson.scripts['desktop:install-app-deps'],
  'electron-rebuild --force --which-module better-sqlite3 --sequential',
);
assert.match(packageJson.scripts.test, /(test:windows-distribution|windows-distribution\.test\.cjs)/);
assert.doesNotMatch(packageJson.scripts.test, /windows-signing\.test\.cjs/);

// Release tag must match the packaged version on both manifests. The project
// versions patch builds with a fourth component (0.1.2.3), same convention
// as scripts/package.cjs, so assert a leading X.Y.Z rather than strict semver.
assert.match(packageJson.version, /^[0-9]+\.[0-9]+\.[0-9]+/);
assert.strictEqual(lockJson.version, packageJson.version);

assert.match(distributionDoc, /unsigned/i);
assert.match(distributionDoc, /Smart App Control/i);
assert.match(distributionDoc, /portable/i);
assert.doesNotMatch(distributionDoc, /HOSTKIND_WINDOWS_PFX|CSC_LINK|Azure Trusted Signing|Artifact Signing/i);

assert.ok(!fs.existsSync(path.join(root, 'scripts', 'sign-windows-artifacts.ps1')));
assert.ok(!fs.existsSync(path.join(root, '.github', 'workflows', 'windows-signed-artifact-gate.yml')));
assert.ok(!fs.existsSync(path.join(root, 'test', 'windows-signing.test.cjs')));
assert.ok(!fs.existsSync(path.join(root, 'WINDOWS-SIGNING.md')));

console.log('PASS windows-distribution');
