'use strict';

/*
 * Palworld console commands, carried over the REST API.
 *
 * The dedicated server has no console input: on Windows it writes to its own
 * window and never reads stdin, so text typed in the panel console went
 * nowhere. The names below are Palworld's own admin commands (the ones
 * players know from `/Broadcast`, `/ShowPlayers`, ...) plus short aliases,
 * each mapped to the REST endpoint that does the same thing.
 *
 * Shutdown is deliberately absent: stopping goes through the panel's stop
 * action so Hostkind's lifecycle (status, watchdog, backups) sees it.
 */

const palworldOperations = require('../../palworld-operations.cjs');

const HELP = Object.freeze([
  'Palworld commands (sent through the REST API):',
  '  Broadcast <message>          announce to everyone (also: say, announce)',
  '  Save                         save the world',
  '  ShowPlayers                  list online players (also: players)',
  '  Info                         server name and version',
  '  KickPlayer <userId> [reason] (also: kick)',
  '  BanPlayer <userId> [reason]  (also: ban)',
  '  UnBanPlayer <userId>         (also: unban)',
  'Use the Stop button to shut the server down.',
]);

const ALIASES = Object.freeze({
  broadcast: 'broadcast', say: 'broadcast', announce: 'broadcast',
  save: 'save',
  showplayers: 'players', players: 'players', list: 'players',
  info: 'info', version: 'info',
  kickplayer: 'kick', kick: 'kick',
  banplayer: 'ban', ban: 'ban',
  unbanplayer: 'unban', unban: 'unban',
  help: 'help', '?': 'help',
  shutdown: 'shutdown', doexit: 'shutdown', exit: 'shutdown', stop: 'shutdown',
});

function fail(message) {
  const error = new Error(message);
  error.code = 'palworld_command_invalid';
  return error;
}

// "BanPlayer steam_123 griefing the base" -> { name: 'ban', rest: 'steam_123 griefing the base' }
function parse(input) {
  const text = String(input == null ? '' : input).trim().replace(/^\//, '');
  const match = /^(\S+)\s*([\s\S]*)$/.exec(text);
  if (!match) return null;
  return { word: match[1], name: ALIASES[match[1].toLowerCase()] || null, rest: match[2].trim() };
}

function splitTarget(rest) {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(rest);
  if (!match) throw fail('Player ID is required. Use ShowPlayers to find it.');
  const id = palworldOperations.userId(match[1]);
  if (id.error) throw fail(id.error);
  const reason = palworldOperations.text(match[2], { label: 'Reason' });
  if (reason.error) throw fail(reason.error);
  // Same body the players page sends: no `message` key without a reason.
  return reason.value ? { userid: id.value, message: reason.value } : { userid: id.value };
}

/*
 * Run one console line. `request(method, endpoint, body)` is the module's
 * authenticated REST call. Resolves to the lines to print; rejects with a
 * readable message for anything the operator should fix.
 */
async function runCommand(request, input) {
  const command = parse(input);
  if (!command) return [];
  switch (command.name) {
    case 'help':
      return [...HELP];
    case 'broadcast': {
      const message = palworldOperations.text(command.rest, { required: true });
      if (message.error) throw fail(message.error);
      await request('POST', '/announce', { message: message.value });
      return [`Broadcast sent: ${message.value}`];
    }
    case 'save':
      await request('POST', '/save');
      return ['World saved.'];
    case 'players': {
      const body = await request('GET', '/players');
      const players = Array.isArray(body && body.players) ? body.players : [];
      if (!players.length) return ['No players online.'];
      return [
        `${players.length} player${players.length === 1 ? '' : 's'} online:`,
        ...players.map((p) => `  ${p.name || '?'}  userId=${p.userId || p.userid || p.playerId || '?'}${Number.isFinite(Number(p.level)) ? `  level ${p.level}` : ''}`),
      ];
    }
    case 'info': {
      const info = await request('GET', '/info');
      const name = info && (info.servername || info.serverName);
      return [`${name || 'Palworld server'}${info && info.version ? ` - version ${info.version}` : ''}`];
    }
    case 'kick': {
      const body = splitTarget(command.rest);
      await request('POST', '/kick', body);
      return [`Kicked ${body.userid}.`];
    }
    case 'ban': {
      const body = splitTarget(command.rest);
      await request('POST', '/ban', body);
      return [`Banned ${body.userid}.`];
    }
    case 'unban': {
      const { userid } = splitTarget(command.rest);
      await request('POST', '/unban', { userid });
      return [`Unbanned ${userid}.`];
    }
    case 'shutdown':
      throw fail('Use the Stop button to shut the server down, so the panel can track it.');
    default:
      throw fail(`Unknown Palworld command "${command.word}". Type help for the list.`);
  }
}

module.exports = { runCommand, parse, HELP };
