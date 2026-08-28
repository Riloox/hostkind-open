'use strict';

const assert = require('assert');
const applyUpdate = require('../scripts/apply-application-update.cjs');

const calls = [];
applyUpdate.promoteStagedBinary({
  stagedPath: 'C:/staging/hostkind',
  targetPath: 'C:/install/versions/1.2.3/hostkind',
  platformKey: 'linux-x64',
  fsImpl: {
    mkdirSync(dir, options) { calls.push(['mkdir', dir, options]); },
    copyFileSync(source, target) { calls.push(['copy', source, target]); },
    chmodSync(target, mode) { calls.push(['chmod', target, mode]); },
  },
});

assert.deepStrictEqual(calls[1], ['copy', 'C:/staging/hostkind', 'C:/install/versions/1.2.3/hostkind']);
assert.deepStrictEqual(calls[2], ['chmod', 'C:/install/versions/1.2.3/hostkind', 0o755]);
console.log('PASS application-update-apply');
