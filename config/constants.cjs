'use strict';

/*
 * Phase 2A: centralized backend constants.
 *
 * Previously scattered as magic numbers across server.js (and the
 * DESTRUCTIVE_KIND_HINTS list in lib/operations.cjs). Behavior is unchanged:
 * every value below matches the literal it replaces.
 */

const JSON_BODY_LIMIT = '24mb';

const RATE_LIMIT_WINDOW_MS = 60_000;
const PALWORLD_ANNOUNCE_LIMIT = 5;
const PALWORLD_PLAYERS_LIMIT = 10;

const ADOPTED_WATCH_INTERVAL_MS = 3000;
const PID_MATCH_TOLERANCE_MS = 5 * 60 * 1000;

const MIN_JWT_SECRET_LENGTH = 32;

const WATCHDOG_WINDOW_MINUTES_MAX = 100000;

const METRICS_RETAIN_MS = 7 * 24 * 3600 * 1000;
const METRICS_SAVE_INTERVAL_MS = 5 * 60 * 1000;

const PREVIEW_TTL_MS_DEFAULT = 15 * 60_000;
const PREVIEW_TTL_MS_SHORT = 10 * 60_000;
const PREVIEW_TTL_MS_LONG = 30 * 60_000;

const SNAPSHOT_RETENTION_DEFAULT = 10;
const SNAPSHOT_RETENTION_SETTINGS = 20;

const DESTRUCTIVE_KIND_HINTS = Object.freeze([
  'snapshot',
  'install',
  'create',
  'update',
  'restore',
  'pack',
  'template',
  'world-write',
  'purge',
  'replace',
]);

module.exports = {
  JSON_BODY_LIMIT,
  RATE_LIMIT_WINDOW_MS,
  PALWORLD_ANNOUNCE_LIMIT,
  PALWORLD_PLAYERS_LIMIT,
  ADOPTED_WATCH_INTERVAL_MS,
  PID_MATCH_TOLERANCE_MS,
  MIN_JWT_SECRET_LENGTH,
  WATCHDOG_WINDOW_MINUTES_MAX,
  METRICS_RETAIN_MS,
  METRICS_SAVE_INTERVAL_MS,
  PREVIEW_TTL_MS_DEFAULT,
  PREVIEW_TTL_MS_SHORT,
  PREVIEW_TTL_MS_LONG,
  SNAPSHOT_RETENTION_DEFAULT,
  SNAPSHOT_RETENTION_SETTINGS,
  DESTRUCTIVE_KIND_HINTS,
};
