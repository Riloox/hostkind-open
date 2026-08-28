'use strict';

const assert = require('assert');
const { isPublicApiPath } = require('../lib/api-public.cjs');

assert.strictEqual(isPublicApiPath('/login'), true);
assert.strictEqual(isPublicApiPath('/auth-mode'), true);
assert.strictEqual(isPublicApiPath('/product/pairing/consume'), true);
assert.strictEqual(isPublicApiPath('/product/pairing/consume/extra'), false);
assert.strictEqual(isPublicApiPath('/product/byoc/targets'), false);
assert.strictEqual(isPublicApiPath('/product/events'), false);
assert.strictEqual(isPublicApiPath('/api-keys'), false);

console.log('PASS product-pairing-public');
