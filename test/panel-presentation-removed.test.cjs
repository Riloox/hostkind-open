'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function source(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

assert.strictEqual(
  fs.existsSync(path.join(ROOT, 'lib', 'serverPresentation.cjs')),
  false,
  'the unused presentation storage module should be removed',
);

const server = source('server.js');
assert.strictEqual(server.includes('serverPresentation'), false);
assert.strictEqual(server.includes('/presentation'), false);
assert.strictEqual(server.includes('presentationUpload'), false);

const tools = source('src/components/shared/ServerToolsDialog.jsx');
assert.strictEqual(tools.includes('PresentationTab'), false);
assert.strictEqual(tools.includes('AccentField'), false);
assert.strictEqual(tools.includes('/presentation'), false);

console.log('panel presentation removal tests passed');
