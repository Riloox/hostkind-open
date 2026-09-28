'use strict';

/*
 * Who sees each tab of Hostkind settings (src/lib/panel.js). The page's tab
 * bar and the shell's URL guard both ask this, so it is pinned here.
 *
 * panel.js is browser ESM in a CommonJS package, so it is copied to a
 * temporary .mjs and imported from there.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

async function loadPanel() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'panel.js'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostkind-panel-'));
  const file = path.join(dir, 'panel.mjs');
  fs.writeFileSync(file, source);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  const { panelTabAllowed, visiblePanelTabs } = await loadPanel();
  const TABS = ['preferences', 'users', 'audit', 'updates'];
  const grants = (...held) => ({ isAdmin: false, can: (capability) => held.includes(capability) });

  assert.deepStrictEqual(visiblePanelTabs(TABS, { isAdmin: true, can: () => false }), TABS, 'admins see every tab');
  assert.deepStrictEqual(visiblePanelTabs(TABS, grants()), ['preferences'], 'an operator with no grants sees Preferences');
  assert.deepStrictEqual(visiblePanelTabs(TABS, grants('users.manage')), ['preferences', 'users']);
  assert.deepStrictEqual(visiblePanelTabs(TABS, grants('audit.view')), ['preferences', 'audit']);
  assert.strictEqual(panelTabAllowed('updates', grants('users.manage', 'audit.view')), false,
    'app updates need the admin role, not a grant');
  assert.strictEqual(panelTabAllowed('something-else', grants()), true, 'a tab with no rule is for everyone');

  console.log('panel tabs tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
