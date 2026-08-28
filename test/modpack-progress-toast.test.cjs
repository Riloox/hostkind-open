'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const toast = source('src/components/shared/ModpackProgressToast.jsx');
assert.match(toast, /dismissible:\s*true/, 'the progress toast must be manually dismissible');
assert.match(toast, /closeButton:\s*true/, 'the progress toast must expose a close button');
assert.match(toast, /export function dismissModpackProgressToast\s*\(/, 'completed installs must dismiss the existing toast instead of recreating it');
assert.doesNotMatch(toast, /dismissible:\s*false/, 'the progress toast must not disable dismissal');
assert.doesNotMatch(toast, /closeButton:\s*false/, 'the progress toast must not hide its close button');

for (const relative of ['src/views/ModrinthView.jsx', 'src/views/ServersView.jsx']) {
  const view = source(relative);
  assert.match(view, /dismissModpackProgressToast/, `${relative} must dismiss the progress toast on completion`);
  assert.match(
    view,
    /dismissModpackProgressToast\(progressToast\)[\s\S]{0,300}toast\.success/,
    `${relative} must show a separate success toast after the install completes`,
  );
  assert.doesNotMatch(view, /settleModpackProgressToast/, `${relative} must not recreate a toast the user already closed`);
}

console.log('modpack progress toast tests passed');
