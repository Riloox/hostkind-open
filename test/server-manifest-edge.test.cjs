'use strict';

const assert = require('assert');
const { createManifest, validateManifest, manifestFromServer, SCHEMA_VERSION, KIND } = require('../lib/server-manifest.cjs');

const server = {
  id: 'srv-1',
  name: 'Survival',
  type: 'minecraft',
  loader: 'paper',
  mcVersion: '1.21.4',
  worlds: ['world', 'world_nether'],
  dir: 'C:\\Users\\Federico\\secret-server',
  jar: 'C:\\Users\\Federico\\paper.jar',
  javaArgs: ['-Xmx4G'],
  password: 'do-not-export',
  network: { host: '192.168.1.4', port: 25565 },
};

const contentRefs = [{
  path: 'plugins/EssentialsX.jar',
  kind: 'plugin',
  provider: 'modrinth',
  projectId: 'essentials',
  versionId: 'ess-1',
  sha256: 'a'.repeat(64),
}];

const manifest = createManifest({
  server,
  contentRefs,
  schedules: [{ name: 'nightly-backup', type: 'backup', cron: '0 4 * * *' }],
  policy: { backupRequired: true, sleepable: true },
  now: 1700000000000,
});

assert.strictEqual(manifest.schemaVersion, SCHEMA_VERSION);
assert.strictEqual(manifest.kind, KIND);
assert.strictEqual(manifest.server.name, 'Survival');
assert.strictEqual(manifest.server.type, 'minecraft');
assert.deepStrictEqual(manifest.content, contentRefs);
assert.strictEqual(manifest.createdAt, 1700000000000);
const serialized = JSON.stringify(manifest);
assert.doesNotMatch(serialized, /secret-server|paper\.jar|do-not-export|192\.168\.1\.4/);
assert.ok(manifest.server.network.port == null || manifest.server.network.port === '{{SERVER_PORT}}');
assert.ok(manifest.server.network.host == null || manifest.server.network.host === '{{SERVER_IP}}');

const unsafeManifest = createManifest({
  server,
  schedules: [{ name: 'backup', type: 'backup', cron: '0 4 * * *', command: 'curl --header secret-token' }],
  policy: { backupRequired: true, sleepable: true, adminPassword: 'do-not-export' },
  now: 1700000000000,
});
assert.deepStrictEqual(unsafeManifest.schedules, [{ name: 'backup', type: 'backup', cron: '0 4 * * *' }]);
assert.deepStrictEqual(unsafeManifest.policy, { backupRequired: true, sleepable: true });
assert.doesNotMatch(JSON.stringify(unsafeManifest), /secret-token|adminPassword|do-not-export/);
const unsafeRuntimeManifest = createManifest({
  server: { ...server, javaArgs: ['-Xmx4G', '-Dpassword=runtime-secret'] },
  now: 1700000000000,
});
assert.deepStrictEqual(unsafeRuntimeManifest.server.javaArgs, ['-Xmx4G']);
assert.doesNotMatch(JSON.stringify(unsafeRuntimeManifest), /runtime-secret/);

const valid = validateManifest(manifest);
assert.strictEqual(valid.ok, true);
assert.deepStrictEqual(valid.errors, []);
assert.deepStrictEqual(manifestFromServer(server, { now: 1700000000000 }).server, manifest.server);

const invalidPath = { ...manifest, content: [{ ...contentRefs[0], path: '../escape.jar' }] };
const invalidResult = validateManifest(invalidPath);
assert.strictEqual(invalidResult.ok, false);
assert.ok(invalidResult.errors.some((error) => /path/i.test(error)));
assert.throws(() => createManifest({ server, contentRefs: [{ ...contentRefs[0], path: '/absolute.jar' }] }), /path/i);
assert.throws(() => createManifest({ server, contentRefs: [{ ...contentRefs[0], sha256: 'not-a-sha256' }] }), /sha256/i);
assert.throws(() => createManifest({ server: { ...server, name: 'password=must-not-export' } }), /sensitive|portable|password/i);
assert.throws(() => createManifest({ server: { ...server, worlds: ['world', 'secret:must-not-export'] } }), /sensitive|portable|secret/i);

const invalidSchema = { ...manifest, schemaVersion: 99 };
assert.strictEqual(validateManifest(invalidSchema).ok, false);
const invalidMachineField = { ...manifest, server: { ...manifest.server, dir: 'C:\\private\\server' } };
assert.strictEqual(validateManifest(invalidMachineField).ok, false);
const invalidScheduleField = { ...manifest, schedules: [{ name: 'backup', type: 'backup', command: 'secret' }] };
assert.strictEqual(validateManifest(invalidScheduleField).ok, false);
const invalidPolicyField = { ...manifest, policy: { backupRequired: true, adminPassword: 'secret' } };
assert.strictEqual(validateManifest(invalidPolicyField).ok, false);
console.log('PASS server-manifest-edge');
