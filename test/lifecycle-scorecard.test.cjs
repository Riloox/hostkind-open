'use strict';

const assert = require('assert');
const { REQUIRED_LIFECYCLE, scoreModule, selectDeepSupport } = require('../lib/lifecycle-scorecard.cjs');

assert.deepStrictEqual(REQUIRED_LIFECYCLE, ['install', 'import', 'update', 'backup', 'restore', 'sleep', 'wake', 'migrate']);
const complete = {
  id: 'minecraft',
  install() {}, import() {}, update() {}, backup() {}, restore() {}, sleep() {}, wake() {}, migrate() {},
};
const partial = { id: 'custom', install() {}, backup() {}, restore() {} };
const completeScore = scoreModule(complete, { type: 'minecraft' });
assert.strictEqual(completeScore.moduleId, 'minecraft');
assert.strictEqual(completeScore.score, 8);
assert.deepStrictEqual(completeScore.missing, []);
assert.ok(REQUIRED_LIFECYCLE.every((key) => completeScore.lifecycle[key] === true));
const partialScore = scoreModule(partial, { type: 'custom' });
assert.strictEqual(partialScore.score, 3);
assert.deepStrictEqual(partialScore.missing, ['import', 'update', 'sleep', 'wake', 'migrate']);
const selected = selectDeepSupport([partial, complete], ['minecraft', 'custom'], { minecraft: {}, custom: {} });
assert.deepStrictEqual(selected.map((item) => item.moduleId), ['minecraft', 'custom']);
console.log('PASS lifecycle-scorecard');
