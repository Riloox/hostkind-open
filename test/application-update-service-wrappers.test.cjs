'use strict';

const assert = require('assert');
const { systemdUnit, schtasksCreateCommand } = require('../scripts/install-service.cjs');

const linux = systemdUnit({
  name: 'hostkind',
  installDir: '/opt/hostkind',
  launcherPath: '/opt/hostkind/hostkind-launcher',
  launcherArgs: ['--service'],
  nodePath: '/usr/bin/node',
  configPath: '/opt/hostkind/config.json',
});
assert.ok(linux.includes('ExecStart=/opt/hostkind/hostkind-launcher --service'));
assert.ok(!linux.includes('/usr/bin/node /opt/hostkind/server.js'));

const windows = schtasksCreateCommand({
  name: 'hostkind',
  installDir: 'C:\\hostkind',
  launcherPath: 'C:\\hostkind\\hostkind-launcher.exe',
  launcherArgs: ['--service'],
  nodePath: 'C:\\node\\node.exe',
  configPath: 'C:\\hostkind\\config.json',
});
const taskRun = windows.args[windows.args.indexOf('/TR') + 1];
assert.ok(taskRun.includes('"C:\\hostkind\\hostkind-launcher.exe" --service'));
assert.ok(!taskRun.includes('node.exe'));
console.log('PASS application-update-service-wrappers');
