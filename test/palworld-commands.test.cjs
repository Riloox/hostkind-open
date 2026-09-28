'use strict';

// Palworld console commands are translated to REST calls: the server reads
// no stdin, so this translation is the only way the console input does
// anything.

const assert = require('assert');
const { runCommand } = require('../lib/modules/palworld/commands.cjs');

function recorder(responses = {}) {
  const calls = [];
  const request = async (method, endpoint, body) => {
    calls.push(body === undefined ? [method, endpoint] : [method, endpoint, body]);
    return responses[endpoint] || {};
  };
  return { calls, request };
}

async function rejects(input, pattern) {
  const { calls, request } = recorder();
  await assert.rejects(runCommand(request, input), pattern, input);
  assert.deepEqual(calls, [], `${input} must not reach the API`);
}

async function main() {
  let r = recorder();
  assert.deepEqual(await runCommand(r.request, 'Broadcast Server restarting soon'), ['Broadcast sent: Server restarting soon']);
  assert.deepEqual(r.calls, [['POST', '/announce', { message: 'Server restarting soon' }]]);

  // Aliases, a leading slash and any case reach the same endpoint.
  for (const input of ['say hi', '/announce hi', 'BROADCAST hi']) {
    r = recorder();
    await runCommand(r.request, input);
    assert.deepEqual(r.calls, [['POST', '/announce', { message: 'hi' }]], input);
  }

  r = recorder();
  assert.deepEqual(await runCommand(r.request, 'save'), ['World saved.']);
  assert.deepEqual(r.calls, [['POST', '/save']]);

  r = recorder({ '/players': { players: [{ name: 'Ana', userId: 'steam_1', level: 12 }] } });
  assert.deepEqual(await runCommand(r.request, 'ShowPlayers'), ['1 player online:', '  Ana  userId=steam_1  level 12']);
  r = recorder({ '/players': { players: [] } });
  assert.deepEqual(await runCommand(r.request, 'players'), ['No players online.']);

  r = recorder({ '/info': { servername: 'Pals', version: 'v0.6.1' } });
  assert.deepEqual(await runCommand(r.request, 'info'), ['Pals - version v0.6.1']);

  // Kick/ban carry a reason only when one is given, like the players page.
  r = recorder();
  await runCommand(r.request, 'KickPlayer steam_1 stop griefing');
  await runCommand(r.request, 'ban steam_2');
  await runCommand(r.request, 'UnBanPlayer steam_2 ignored words');
  assert.deepEqual(r.calls, [
    ['POST', '/kick', { userid: 'steam_1', message: 'stop griefing' }],
    ['POST', '/ban', { userid: 'steam_2' }],
    ['POST', '/unban', { userid: 'steam_2' }],
  ]);

  r = recorder();
  assert.ok((await runCommand(r.request, 'help')).some((line) => /ShowPlayers/.test(line)));
  assert.deepEqual(await runCommand(r.request, '   '), []);

  await rejects('Broadcast', /Message is required/);
  await rejects('kick', /Player ID is required/);
  await rejects('Shutdown 10 bye', /Stop button/);
  await rejects('time set day', /Unknown Palworld command "time"/);

  // A REST failure reaches the caller untouched (the manager prints it).
  const failing = async () => { throw new Error('Palworld REST API is unavailable'); };
  await assert.rejects(runCommand(failing, 'save'), /REST API is unavailable/);

  console.log('PASS  palworld-commands');
}

main().catch((err) => { console.error(err); process.exit(1); });
