'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const workflow = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'),
  'utf8',
);
const publish = workflow.indexOf('- name: Publish GitHub release');
const generate = workflow.indexOf('- name: Generate signed binary update manifest');
const upload = workflow.indexOf('- name: Upload signed binary update manifest');

assert.ok(publish >= 0, 'release publish step must remain present');
assert.ok(generate >= 0 && generate < publish, 'signed manifest must be generated before release creation');
assert.ok(upload > publish, 'signed manifest upload must follow release creation');

console.log('PASS application-update-workflow');
