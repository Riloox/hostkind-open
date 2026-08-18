'use strict';

const MAX_IDENTITIES = 64;
const IDENTITY_TTL_MS = 30 * 60 * 1000;

const RULES = Object.freeze([
  ['ready', /\bGame server connected(?: to backend)?\b/i],
  ['save-started', /\b(?:World save writing started|Saving world(?:\s|$))/i],
  ['save-complete', /\b(?:World saved(?: in\b.*)?|Saving world.*\bdone)\b/i],
  ['world-loaded', /\b(?:Loaded \d+ (?:locations|zones)|World load completed|Loading world .* done)\b/i],
  ['connect-observed', /\bGot character ZDOID from (?<identity>.+?)(?:\s*:\s*\d+)?$/i],
  ['connect-observed', /\b(?:Peer connected|Got connection SteamID)\b.*?(?<identity>\b\d{6,20}\b)?/i],
  ['disconnect-observed', /\b(?:Closing socket|Peer disconnected|Disconnected peer)\b.*?(?<identity>\b\d{6,20}\b)?/i],
  ['shutdown-started', /\b(?:OnApplicationQuit|Shutting down|Shutdown started)\b/i],
  ['shutdown-complete', /\b(?:World saved.*(?:shutdown|closing)|Shutdown complete|Game server disconnected)\b/i],
  ['fatal', /\b(?:Address already in use|Failed to bind|DllNotFoundException|missing shared object|password.{0,20}(?:invalid|too short)|world.{0,30}(?:corrupt|missing))\b/i],
  ['warning', /\b(?:warning|failed to connect|retrying)\b/i],
]);

const VERSION_PATTERN = /\b(?:Valheim version|version)\s*[:=]?\s*(\d+(?:\.\d+)+)\b/i;

function initialState() {
  return { observed: [], lastSaveStartedAt: null, lastSaveCompletedAt: null };
}

function cleanIdentity(value) {
  const text = String(value || '').trim().replace(/[),;]+$/, '');
  if (!text || text.length > 96) return null;
  return text;
}

function inspectLine(inputState, line, now = Date.now()) {
  const state = inputState && typeof inputState === 'object' && !Array.isArray(inputState) ? inputState : initialState();
  const text = String(line || '');
  const timestamp = now instanceof Date ? now.getTime() : Number(now);
  const events = [];
  const version = VERSION_PATTERN.exec(text);
  if (version) events.push({ type: 'version', version: version[1], at: timestamp });

  for (const [type, pattern] of RULES) {
    const match = pattern.exec(text);
    if (!match) continue;
    const event = { type, at: timestamp };
    const identity = cleanIdentity(match.groups && match.groups.identity);
    if (identity) event.identity = identity;
    events.push(event);
    break;
  }

  let observed = Array.isArray(state.observed) ? state.observed : [];
  observed = observed.filter((item) => timestamp - Number(item.lastSeenAt) <= IDENTITY_TTL_MS);
  for (const event of events) {
    if (!event.identity) continue;
    const prior = observed.find((item) => item.identity === event.identity);
    if (prior) {
      prior.lastSeenAt = timestamp;
      prior.connected = event.type === 'connect-observed';
    } else {
      observed.push({ identity: event.identity, lastSeenAt: timestamp, connected: event.type === 'connect-observed' });
    }
  }
  observed.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  state.observed = observed.slice(0, MAX_IDENTITIES);
  if (events.some((event) => event.type === 'save-started')) state.lastSaveStartedAt = timestamp;
  if (events.some((event) => event.type === 'save-complete')) state.lastSaveCompletedAt = timestamp;
  return { state, events };
}

function redactLine(line) {
  return String(line || '')
    .replace(/((?:-password|password)\s*(?:[:=]\s*|\s+))(?:".*?"|'[^']*'|\S+)/gi, '$1[REDACTED]')
    .replace(/\b(?:join code|joincode)\s*[:=]\s*\S+/gi, 'join code: [REDACTED]')
    .replace(/(\b(?:PlayFab|entity|platform|SteamID|ZDOID)\s*[:=]\s*)[A-Za-z0-9:_-]+/gi, '$1[REDACTED]')
    .replace(/(\bGot character ZDOID from\s+).+?(?=\s*:\s*\d+\s*$|$)/gi, '$1[REDACTED]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '[REDACTED IP]')
    .replace(/(?:[A-Za-z]:\\|\/(?:home|Users)\/)[^\s"'<>]+/g, '[REDACTED PATH]');
}

function inspect(line) {
  const result = inspectLine(initialState(), line);
  return {
    ready: result.events.some((event) => event.type === 'ready'),
    gameVersion: result.events.find((event) => event.type === 'version')?.version || null,
    saved: result.events.some((event) => event.type === 'save-complete'),
  };
}

module.exports = {
  MAX_IDENTITIES, IDENTITY_TTL_MS, RULES, VERSION_PATTERN,
  initialState, inspectLine, redactLine, inspect,
};
