'use strict';

/*
 * Capability mapping for `/api/terraria/*` (docs/terraria/00-baseline-contracts.md
 * "Route surface reservation").
 *
 * server.js's `capabilityForRequest` funnels every Terraria path through here so
 * the mapping is one table a test can enumerate, rather than a run of regexes
 * mixed into a 7000-line file. The rule that makes it worth its own module: an
 * unmapped Terraria path must never default to a weaker capability. Palworld's
 * block falls through to `commands.run`; a new Terraria route that nobody
 * mapped falls through to `server.manage`, the strongest per-server grant, so
 * forgetting an entry fails closed instead of opening a hole.
 *
 * No new constants are added to lib/capabilities.cjs for the MVP. Finer TShock
 * separation (a dedicated `tshock.admin`) is deferred until an operator needs
 * group editing without `server.manage`.
 */

const { CAPABILITIES } = require('../../capabilities.cjs');

// `get` applies to GET/HEAD, `mutate` to everything else. `null` means the verb
// has no route on that path, so it falls through to the deny-by-default
// capability rather than being silently allowed.
const RULES = Object.freeze([
  { pattern: /^\/terraria\/config\/history(?:\/|$)/, get: CAPABILITIES.CONFIGS_VIEW, mutate: CAPABILITIES.CONFIGS_RESTORE },
  { pattern: /^\/terraria\/config(?:\/|$)/, get: CAPABILITIES.CONFIGS_VIEW, mutate: CAPABILITIES.CONFIGS_EDIT },
  { pattern: /^\/terraria\/worlds(?:\/|$)/, get: CAPABILITIES.WORLDS_VIEW, mutate: CAPABILITIES.WORLDS_MANAGE },
  { pattern: /^\/terraria\/mods(?:\/|$)/, get: CAPABILITIES.CONTENT_VIEW, mutate: CAPABILITIES.PLUGINS_MANAGE },
  { pattern: /^\/terraria\/players(?:\/|$)/, get: CAPABILITIES.PLAYERS_VIEW, mutate: CAPABILITIES.PLAYERS_MANAGE },
  { pattern: /^\/terraria\/tshock\/players(?:\/|$)/, get: CAPABILITIES.PLAYERS_VIEW, mutate: CAPABILITIES.PLAYERS_MANAGE },
  { pattern: /^\/terraria\/tshock\/accounts(?:\/|$)/, get: CAPABILITIES.PLAYERS_VIEW, mutate: CAPABILITIES.PLAYERS_MANAGE },
  { pattern: /^\/terraria\/tshock\/groups(?:\/|$)/, get: CAPABILITIES.PLAYERS_VIEW, mutate: CAPABILITIES.SERVER_MANAGE },
  { pattern: /^\/terraria\/tshock\/permissions(?:\/|$)/, get: CAPABILITIES.PLAYERS_VIEW, mutate: null },
  { pattern: /^\/terraria\/tshock\/bans(?:\/|$)/, get: CAPABILITIES.PLAYERS_VIEW, mutate: CAPABILITIES.PLAYERS_MANAGE },
  { pattern: /^\/terraria\/tshock\/status(?:\/|$)/, get: CAPABILITIES.SERVER_VIEW, mutate: null },
  { pattern: /^\/terraria\/versions(?:\/|$)/, get: CAPABILITIES.UPDATES_VIEW, mutate: null },
  { pattern: /^\/terraria\/import(?:\/|$)/, get: CAPABILITIES.SERVER_VIEW, mutate: CAPABILITIES.SERVER_REGISTER },
]);

const FALLBACK_CAPABILITY = CAPABILITIES.SERVER_MANAGE;

/*
 * Resolve a Terraria API path to the capability it requires.
 *
 * Returns `{ capability, explicit }` for any `/terraria` path and `null` for
 * anything else, so callers can tell "not mine" from "mine, and deny-by-default
 * applies". `explicit: false` is what the coverage test fails on.
 */
function matchTerrariaRoute(path, method = 'GET') {
  const p = String(path || '');
  if (!/^\/terraria(?:\/|$)/.test(p)) return null;
  const rule = RULES.find((entry) => entry.pattern.test(p));
  if (!rule) return { capability: FALLBACK_CAPABILITY, explicit: false };
  const read = method === 'GET' || method === 'HEAD';
  const capability = read ? rule.get : rule.mutate;
  return { capability: capability || FALLBACK_CAPABILITY, explicit: !!capability };
}

function terrariaRouteCapability(path, method) {
  const match = matchTerrariaRoute(path, method);
  return match ? match.capability : null;
}

module.exports = { RULES, FALLBACK_CAPABILITY, matchTerrariaRoute, terrariaRouteCapability };
