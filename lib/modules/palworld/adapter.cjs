'use strict';

const ADAPTER_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const REST_HEALTH_STATES = Object.freeze([
  'healthy',
  'disabled',
  'unauthorized',
  'timeout',
  'malformed',
  'unavailable',
]);
const PALWORLD_CAPABILITIES = Object.freeze({
  PLAYERS: 'players',
  ANNOUNCEMENTS: 'announcements',
  SETTINGS: 'palworld-settings',
  MAP: 'palworld-map',
  UPDATES: 'palworld-updates',
  MODS: 'palworld-mods',
  CHAT: 'palworld-chat',
});

class PalworldRestError extends Error {
  constructor(state, code, message) {
    super(message);
    this.name = 'PalworldRestError';
    this.state = state;
    this.code = code;
  }
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requireRecord(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PalworldRestError('malformed', code, 'Palworld REST API returned an invalid response');
  }
  return value;
}

function normalizePlayer(value, sampledAt = new Date().toISOString()) {
  const player = requireRecord(value, 'invalid_player');
  const userId = optionalString(player.userid ?? player.userId ?? player.playerId);
  const name = optionalString(player.name);
  if (!userId || !name) {
    throw new PalworldRestError('malformed', 'invalid_player', 'Palworld REST API returned an invalid player');
  }
  const rawLocation = player.location && typeof player.location === 'object' && !Array.isArray(player.location)
    ? player.location
    : {
        x: player.location_x ?? player.locationX,
        y: player.location_y ?? player.locationY,
        z: player.location_z ?? player.locationZ,
      };
  const coordinates = {
    x: finiteNumber(rawLocation.x),
    y: finiteNumber(rawLocation.y),
    z: finiteNumber(rawLocation.z),
  };
  // The live REST payload guarantees the horizontal plane (location_x /
  // location_y) but omits location_z entirely; the map projects x/y only, so
  // a missing vertical coordinate must not drop the whole location.
  const location = Number.isFinite(coordinates.x) && Number.isFinite(coordinates.y)
    ? coordinates
    : null;
  return {
    userId,
    name,
    accountId: optionalString(player.accountName ?? player.accountId ?? player.platformId),
    location,
    level: finiteNumber(player.level),
    ping: finiteNumber(player.ping),
    observedAt: sampledAt,
  };
}

function normalizePlayers(value, sampledAt = new Date().toISOString()) {
  const body = requireRecord(value, 'invalid_players');
  if (!Array.isArray(body.players)) {
    throw new PalworldRestError('malformed', 'invalid_players', 'Palworld REST API returned an invalid player list');
  }
  return body.players.map((player) => normalizePlayer(player, sampledAt));
}

function normalizeStatus(infoValue, metricsValue, players, health, sampledAt = new Date().toISOString()) {
  const info = requireRecord(infoValue, 'invalid_info');
  const metrics = requireRecord(metricsValue, 'invalid_metrics');
  const playerList = Array.isArray(players) ? players : [];
  return {
    adapterVersion: ADAPTER_VERSION,
    version: optionalString(info.version),
    serverName: optionalString(info.servername ?? info.serverName),
    description: optionalString(info.description),
    days: finiteNumber(metrics.days),
    uptime: finiteNumber(metrics.uptime),
    playerCount: finiteNumber(metrics.currentplayernum) ?? playerList.length,
    maxPlayers: finiteNumber(metrics.maxplayernum),
    serverFps: finiteNumber(metrics.serverfps),
    frameTime: finiteNumber(metrics.serverframetime),
    baseCount: finiteNumber(metrics.basecampnum),
    restHealth: health,
    sampledAt,
  };
}

function initialHealth(configured = false) {
  return {
    state: configured ? 'unavailable' : 'disabled',
    lastSuccessAt: null,
    lastErrorAt: null,
    errorCode: configured ? 'not_polled' : 'not_configured',
    restartRequired: !configured,
  };
}

function healthFromError(error, previous, at = new Date().toISOString()) {
  const state = REST_HEALTH_STATES.includes(error?.state) ? error.state : 'unavailable';
  return {
    state,
    lastSuccessAt: previous?.lastSuccessAt || null,
    lastErrorAt: at,
    errorCode: optionalString(error?.code) || 'request_failed',
    restartRequired: state === 'disabled',
  };
}

function healthy(previous, at = new Date().toISOString()) {
  return {
    state: 'healthy',
    lastSuccessAt: at,
    lastErrorAt: previous?.lastErrorAt || null,
    errorCode: null,
    restartRequired: false,
  };
}

function createPalworldAdapter(options = {}) {
  const fetchImpl = options.fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES;

  async function request(config, method, endpoint, body) {
    const restPort = Number(config?.restPort);
    if (!config?.adminPassword || !Number.isInteger(restPort) || restPort < 1 || restPort > 65535) {
      throw new PalworldRestError('disabled', 'not_configured', 'Palworld REST API is not configured');
    }
    if (!/^\/[a-z0-9/-]*$/i.test(endpoint)) {
      throw new PalworldRestError('unavailable', 'invalid_endpoint', 'Invalid Palworld REST endpoint');
    }
    const auth = Buffer.from(`admin:${config.adminPassword}`).toString('base64');
    let response;
    try {
      const headers = { Authorization: `Basic ${auth}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      response = await (fetchImpl || global.fetch)(`http://127.0.0.1:${restPort}/v1/api${endpoint}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new PalworldRestError(
        timedOut ? 'timeout' : 'unavailable',
        timedOut ? 'request_timeout' : 'connection_failed',
        timedOut ? 'Palworld REST API timed out' : 'Palworld REST API is unavailable',
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new PalworldRestError('unauthorized', 'authentication_failed', 'Palworld REST API rejected authentication');
    }
    if (!response.ok) {
      throw new PalworldRestError('unavailable', `http_${response.status}`, 'Palworld REST API request failed');
    }
    if (response.status === 204) return {};
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
      throw new PalworldRestError('malformed', 'response_too_large', 'Palworld REST API response is too large');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxResponseBytes) {
      throw new PalworldRestError('malformed', 'response_too_large', 'Palworld REST API response is too large');
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new PalworldRestError('malformed', 'invalid_json', 'Palworld REST API returned invalid JSON');
    }
  }

  return { version: ADAPTER_VERSION, request };
}

module.exports = {
  ADAPTER_VERSION,
  PALWORLD_CAPABILITIES,
  REST_HEALTH_STATES,
  PalworldRestError,
  createPalworldAdapter,
  normalizePlayer,
  normalizePlayers,
  normalizeStatus,
  initialHealth,
  healthFromError,
  healthy,
};
