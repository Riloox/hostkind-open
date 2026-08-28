'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const auditIndex = serverSource.indexOf('const sensitiveRead');
const updaterMount = "app.use('/api', applicationUpdateRouter({ service: applicationUpdater }));";
const updaterIndex = serverSource.indexOf(updaterMount);
assert.ok(auditIndex >= 0, 'server must retain the shared API audit middleware');
assert.ok(updaterIndex >= 0, 'server must mount the application updater router');
assert.ok(updaterIndex > auditIndex, 'updater mutations must pass through the shared audit middleware');

console.log('PASS application-update-audit-wiring');
