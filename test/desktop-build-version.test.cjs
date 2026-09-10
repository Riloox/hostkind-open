'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { buildDesktop } = require('../scripts/build-desktop.cjs');

function fixture(t, version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-build-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'package.json');
  const original = JSON.stringify({ name: 'hostkind', version, description: 'Hostkind', author: 'Hostkind' });
  fs.writeFileSync(file, original);
  return { root, file, original };
}

test('four-part releases pass real builder validation and retain app/Windows versions', (t) => {
  const { root, file, original } = fixture(t, '0.1.2.3');
  const status = buildDesktop(['--win', 'nsis'], { root, run(exe, args) {
    assert.equal(JSON.parse(fs.readFileSync(file)).version, '0.1.2');
    assert.ok(args.includes('--config.extraMetadata.version=0.1.2.3'));
    assert.ok(args.includes('--config.buildNumber=3'));
    const script = `
      const assert = require('node:assert/strict');
      const { Packager } = require(${JSON.stringify(require.resolve('app-builder-lib/out/packager'))});
      const { AppInfo } = require(${JSON.stringify(require.resolve('app-builder-lib/out/appInfo'))});
      (async () => {
        const packager = new Packager({ projectDir: ${JSON.stringify(root)}, config: {
          extraMetadata: { version: '0.1.2.3' }, buildVersion: '0.1.2.3', buildNumber: '3'
        }});
        await packager.validateConfig();
        const info = new AppInfo(packager);
        assert.equal(info.version, '0.1.2.3');
        assert.equal(info.getVersionInWeirdWindowsForm(), '0.1.2.3');
      })().catch(e => { console.error(e); process.exitCode = 1; });
    `;
    return spawnSync(exe, ['-e', script], { encoding: 'utf8', stdio: 'inherit' });
  }});
  assert.equal(status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('failed builds restore the original package verbatim', (t) => {
  const { root, file, original } = fixture(t, '0.1.2.3');
  assert.equal(buildDesktop([], { root, run: () => ({ status: 7 }) }), 7);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.throws(() => buildDesktop([], { root, run: () => { throw new Error('spawn failed'); } }), /spawn failed/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('strict-semver releases pass through without version overrides', (t) => {
  const { root, file, original } = fixture(t, '0.1.3');
  assert.equal(buildDesktop(['--linux', 'deb'], { root, run(exe, args) {
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(args.some(arg => arg.startsWith('--config.')), false);
    return { status: 0 };
  }}), 0);
});
