'use strict';

const assert = require('assert');
const {
  PalworldRestError, PALWORLD_CAPABILITIES, createPalworldAdapter, normalizePlayers, normalizeStatus,
  initialHealth, healthFromError, healthy,
} = require('../lib/modules/palworld/adapter.cjs');

const sampledAt = '2026-07-23T12:00:00.000Z';
assert.deepEqual(Object.values(PALWORLD_CAPABILITIES), [
  'players', 'announcements', 'palworld-settings', 'palworld-map',
  'palworld-updates', 'palworld-mods', 'palworld-chat',
]);
const players = normalizePlayers({ players: [{
  name: 'Lamball', userid: 'steam_1', accountName: 'steam_account',
  location: { x: 10.5, y: '20', z: -4 }, level: 12, ping: 42,
}] }, sampledAt);
assert.deepEqual(players[0], {
  userId: 'steam_1', name: 'Lamball', accountId: 'steam_account',
  location: { x: 10.5, y: 20, z: -4 }, level: 12, ping: 42, observedAt: sampledAt,
});

// The live REST payload (v1.0.2.x) sends flat location_x/location_y and
// OMITS location_z entirely. A missing vertical coordinate must not drop the
// whole location - the map projects the horizontal plane (x/y) only.
const flat = normalizePlayers({ players: [{
  name: 'DOOM', userId: 'steam_76561198289613464', accountName: 'DOOM',
  playerId: 'EE6773E7000000000000000000000000', iP: '192.168.1.6',
  ping: 16.28, location_x: -341605.84375, location_y: 236988.578125, level: 2,
}] }, sampledAt);
assert.deepEqual(flat[0].location, { x: -341605.84375, y: 236988.578125, z: null });
assert.equal(flat[0].userId, 'steam_76561198289613464');

// The documented flat shape that DOES carry z keeps it.
const withZ = normalizePlayers({ players: [{
  name: 'Lamball', userid: 'steam_2', location_x: 1, location_y: 2, location_z: 3,
}] }, sampledAt);
assert.deepEqual(withZ[0].location, { x: 1, y: 2, z: 3 });

// Without the horizontal plane there is nothing to project - location is null.
const noXY = normalizePlayers({ players: [{
  name: 'Ghost', userid: 'steam_3', location_z: 9,
}] }, sampledAt);
assert.equal(noXY[0].location, null);

const health = healthy(initialHealth(true), sampledAt);
const status = normalizeStatus(
  { version: 'v0.6', servername: 'Hostkind', description: 'Fixture' },
  { days: 5, uptime: 100, currentplayernum: 1, maxplayernum: 32, serverfps: 60, serverframetime: 16.6, basecampnum: 2 },
  players, health, sampledAt,
);
assert.equal(status.adapterVersion, 1);
assert.equal(status.serverName, 'Hostkind');
assert.equal(status.playerCount, 1);
assert.equal(status.restHealth.state, 'healthy');
assert.throws(() => normalizePlayers({ players: [{}] }), (error) => error instanceof PalworldRestError && error.state === 'malformed');
assert.equal(healthFromError(new PalworldRestError('unauthorized', 'authentication_failed', 'safe'), health, sampledAt).state, 'unauthorized');
assert.equal(healthFromError(new PalworldRestError('disabled', 'not_configured', 'safe'), health, sampledAt).restartRequired, true);

async function requestCases() {
  const config = { restPort: 8212, adminPassword: 'never-return-this' };
  const response = (status, text, headers) => ({
    ok: status >= 200 && status < 300, status,
    headers: { get: (name) => headers?.[name.toLowerCase()] || null },
    text: async () => text,
  });
  let target;
  const adapter = createPalworldAdapter({ fetch: async (url) => {
    target = url;
    return response(200, '{"version":"fixture"}');
  } });
  assert.deepEqual(await adapter.request(config, 'GET', '/info'), { version: 'fixture' });
  assert.equal(target, 'http://127.0.0.1:8212/v1/api/info');
  await assert.rejects(() => adapter.request({ restHost: '203.0.113.1' }, 'GET', '/info'), (error) => error.state === 'disabled');

  for (const [code, expected] of [[401, 'unauthorized'], [403, 'unauthorized'], [500, 'unavailable']]) {
    const failing = createPalworldAdapter({ fetch: async () => response(code, '{}') });
    await assert.rejects(() => failing.request(config, 'GET', '/info'), (error) => error.state === expected);
  }
  const malformed = createPalworldAdapter({ fetch: async () => response(200, '{') });
  await assert.rejects(() => malformed.request(config, 'GET', '/info'), (error) => error.state === 'malformed');
  const oversized = createPalworldAdapter({ maxResponseBytes: 4, fetch: async () => response(200, '{}', { 'content-length': '5' }) });
  await assert.rejects(() => oversized.request(config, 'GET', '/info'), (error) => error.code === 'response_too_large');
  const timedOut = createPalworldAdapter({ fetch: async () => {
    const error = new Error('secret URL');
    error.name = 'TimeoutError';
    throw error;
  } });
  await assert.rejects(() => timedOut.request(config, 'GET', '/info'), (error) => error.state === 'timeout' && !error.message.includes(config.adminPassword));
}

requestCases()
  .then(() => console.log('palworld adapter tests passed'))
  .catch((error) => { console.error(error); process.exitCode = 1; });
