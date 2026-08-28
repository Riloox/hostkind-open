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
const distributionDocPath = path.join(root, 'WINDOWS-DISTRIBUTION.md');
const distributionDoc = fs.existsSync(distributionDocPath)
  ? fs.readFileSync(distributionDocPath, 'utf8')
  : '';

assert.match(builderSource, /target:\s*\[\s*\{\s*target:\s*'nsis'/s);
assert.match(builderSource, /signExecutable:\s*false/);
assert.match(builderSource, /verifyUpdateCodeSignature:\s*false/);
assert.match(builderSource, /forceCodeSigning:\s*false/);
assert.doesNotMatch(
  builderSource,
  /azureSignOptions|Artifact Signing|TrustedSigning|HOSTKIND_ARTIFACT_SIGNING|AZURE_/i,
);

assert.match(ciWorkflow, /release:/);
assert.match(ciWorkflow, /gh release create/);
assert.match(ciWorkflow, /dist\/hostkind-\*\.zip/);
assert.doesNotMatch(
  ciWorkflow,
  /desktop-release:|azure\/login|id-token:\s*write|AZURE_|HOSTKIND_ARTIFACT_SIGNING|dist-electron|Hostkind-\*-Setup\.exe/i,
);

assert.ok(packageJson.scripts['desktop:pack']);
assert.ok(packageJson.scripts['desktop:dist']);
assert.match(packageJson.scripts['desktop:dev'], /desktop:install-app-deps/);
assert.match(packageJson.scripts['desktop:smoke'], /desktop:install-app-deps/);
assert.strictEqual(packageJson.devDependencies['@electron/rebuild'], '4.2.0');
assert.strictEqual(
  packageJson.scripts['desktop:install-app-deps'],
  'electron-rebuild --force --which-module better-sqlite3 --sequential',
);
assert.match(packageJson.scripts.test, /windows-distribution\.test\.cjs/);
assert.doesNotMatch(packageJson.scripts.test, /windows-signing\.test\.cjs/);

assert.match(distributionDoc, /unsigned/i);
assert.match(distributionDoc, /Smart App Control/i);
assert.match(distributionDoc, /source|web/i);
assert.doesNotMatch(distributionDoc, /HOSTKIND_WINDOWS_PFX|CSC_LINK|Azure Trusted Signing|Artifact Signing/i);

assert.ok(!fs.existsSync(path.join(root, 'scripts', 'sign-windows-artifacts.ps1')));
assert.ok(!fs.existsSync(path.join(root, '.github', 'workflows', 'windows-signed-artifact-gate.yml')));
assert.ok(!fs.existsSync(path.join(root, 'test', 'windows-signing.test.cjs')));
assert.ok(!fs.existsSync(path.join(root, 'WINDOWS-SIGNING.md')));

console.log('PASS windows-distribution');
