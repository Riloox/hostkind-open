'use strict';

/*
 * Palworld-aware automation (docs/palworld/05-automation.md).
 *
 * This module is pure logic: it never touches the network, the filesystem, or
 * a manager. server.js observes the world (REST health, players, status,
 * update state), hands the observation plus the persisted trigger state here,
 * and executes whatever decision comes back. That keeps every rule in the doc
 * - paused countdowns, cooldowns, catch-up backups, boot reconciliation -
 * testable without a running server.
 */

const crypto = require('crypto');

const TASK_VERSION = 2;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 10080;
const MESSAGE_LIMIT = 256;

const TRIGGER_KINDS = Object.freeze(['cron', 'interval', 'player-joined', 'server-empty', 'update-available']);
const ACTION_KINDS = Object.freeze([
  'command',
  'restart',
  'backup',
  'backup-offline',
  'say',
  'announce',
  'save',
  'graceful-restart',
  'apply-update-policy',
  'stop-when-empty',
]);
// Actions that only exist for Palworld servers: they go through the official
// adapter, never a synthesized console command.
const PALWORLD_ACTIONS = Object.freeze(['announce', 'save', 'graceful-restart', 'apply-update-policy', 'stop-when-empty']);
const PALWORLD_TRIGGERS = Object.freeze(['player-joined', 'server-empty', 'update-available']);

const CAPABILITIES = Object.freeze({
  command: 'commands.run',
  restart: 'server.control',
  backup: 'backups.create',
  'backup-offline': 'backups.create',
  say: 'commands.run',
  announce: 'announcements.send',
  save: 'backups.create',
  'graceful-restart': 'server.control',
  'apply-update-policy': 'updates.apply',
  'stop-when-empty': 'server.control',
});

const DEFAULT_STOP_WHEN_EMPTY = Object.freeze({
  minimumEmptyMinutes: 15,
  graceSeconds: 120,
  minimumUptimeMinutes: 10,
  windows: [],
  sessions: 'all', // all | automatic | manual
  message: 'Server is empty and will shut down in {seconds} seconds.',
});

const CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function safeText(value, limit = MESSAGE_LIMIT) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || CONTROL_CHARACTER_RE.test(text)) return '';
  return text.slice(0, limit);
}

/*
 * Only `{player}` and `{seconds}` are substituted, and the values are inserted
 * literally - a player name containing `{player}` can never expand again.
 */
function renderTemplate(template, vars = {}) {
  const text = typeof template === 'string' ? template : '';
  return text.replace(/\{(player|seconds)\}/g, (match, key) => {
    const value = vars[key];
    return value === undefined || value === null ? match : safeText(String(value), 64) || match;
  }).slice(0, MESSAGE_LIMIT);
}

function timeToMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function safeWindows(value) {
  if (!Array.isArray(value)) return [];
  const windows = [];
  for (const item of value.slice(0, 8)) {
    const start = timeToMinutes(item?.start);
    const end = timeToMinutes(item?.end);
    if (start === null || end === null || start === end) continue;
    windows.push({ start: item.start, end: item.end });
  }
  return windows;
}

function inWindows(windows, date) {
  if (!windows.length) return true;
  const minute = date.getHours() * 60 + date.getMinutes();
  return windows.some((window) => {
    const start = timeToMinutes(window.start);
    const end = timeToMinutes(window.end);
    return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
  });
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// ---------------------------------------------------------------------------
// Cron parsing (preview only - node-cron still owns the actual scheduling)
// ---------------------------------------------------------------------------

function cronField(expression, min, max) {
  const values = new Set();
  for (const part of String(expression).split(',')) {
    const [rangeText, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    let start;
    let end;
    if (rangeText === '*') {
      start = min;
      end = max;
    } else if (rangeText.includes('-')) {
      const [from, to] = rangeText.split('-').map(Number);
      start = from;
      end = to;
    } else {
      start = Number(rangeText);
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size ? values : null;
}

function parseCron(expression) {
  const parts = String(expression || '').trim().split(/\s+/);
  // node-cron accepts an optional leading seconds field; previews work at
  // minute resolution, so the seconds field is dropped.
  const fields = parts.length === 6 ? parts.slice(1) : parts;
  if (fields.length !== 5) return null;
  const minute = cronField(fields[0], 0, 59);
  const hour = cronField(fields[1], 0, 23);
  const dayOfMonth = cronField(fields[2], 1, 31);
  const month = cronField(fields[3], 1, 12);
  const dayOfWeekRaw = cronField(fields[4], 0, 7);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeekRaw) return null;
  const dayOfWeek = new Set([...dayOfWeekRaw].map((day) => (day === 7 ? 0 : day)));
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

function cronMatches(parsed, date) {
  if (!parsed.minute.has(date.getMinutes())) return false;
  if (!parsed.hour.has(date.getHours())) return false;
  if (!parsed.month.has(date.getMonth() + 1)) return false;
  const domHit = parsed.dayOfMonth.has(date.getDate());
  const dowHit = parsed.dayOfWeek.has(date.getDay());
  // Standard cron rule: when both day fields are restricted they are OR'ed.
  if (parsed.domRestricted && parsed.dowRestricted) return domHit || dowHit;
  if (parsed.domRestricted) return domHit;
  if (parsed.dowRestricted) return dowHit;
  return true;
}

function nextCronFires(expression, { from = Date.now(), count = 3, limitDays = 400 } = {}) {
  const parsed = parseCron(expression);
  if (!parsed) return [];
  const fires = [];
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setTime(cursor.getTime() + 60_000);
  const limit = limitDays * 24 * 60;
  for (let step = 0; step < limit && fires.length < count; step += 1) {
    if (cronMatches(parsed, cursor)) fires.push(new Date(cursor.getTime()));
    cursor.setTime(cursor.getTime() + 60_000);
  }
  return fires;
}

// ---------------------------------------------------------------------------
// Task shape: versioned trigger + action, with legacy cron tasks migrated
// ---------------------------------------------------------------------------

/*
 * Legacy tasks are `{ type: command|restart|backup, cron }`. They keep firing
 * exactly as before: the migration only records the same behaviour in the
 * versioned shape, and `type`/`cron` stay on the object so older readers
 * (and node-cron scheduling) are untouched.
 */
function migrateTask(task) {
  const input = task && typeof task === 'object' && !Array.isArray(task) ? task : {};
  if (input.version === TASK_VERSION && input.trigger && input.action) return { ...input };
  const type = ACTION_KINDS.includes(input.type) ? input.type : 'restart';
  return {
    ...input,
    version: TASK_VERSION,
    trigger: { kind: 'cron', expression: String(input.cron || '') },
    action: type === 'command'
      ? { kind: 'command', command: String(input.command || '') }
      : { kind: type },
  };
}

function normalizeTrigger(input, validateCron) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const kind = TRIGGER_KINDS.includes(raw.kind) ? raw.kind : 'cron';
  if (kind === 'cron') {
    const expression = String(raw.expression || '').trim();
    if (!validateCron(expression)) return { error: 'errors.invalidCron' };
    return { value: { kind, expression, catchUp: raw.catchUp === true, maxCatchUpMinutes: clamp(raw.maxCatchUpMinutes, 1, 10080, 120) } };
  }
  if (kind === 'interval') {
    const minutes = clamp(raw.minutes, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES);
    if (Number(raw.minutes) && Number(raw.minutes) < MIN_INTERVAL_MINUTES) return { error: 'errors.intervalTooShort' };
    return { value: { kind, minutes, catchUp: raw.catchUp === true, maxCatchUpMinutes: clamp(raw.maxCatchUpMinutes, 1, 10080, 120) } };
  }
  if (kind === 'player-joined') {
    return {
      value: {
        kind,
        playerId: safeText(raw.playerId, 128) || null,
        delaySeconds: clamp(raw.delaySeconds, 0, 600, 0),
        cooldownMinutes: clamp(raw.cooldownMinutes, 0, 10080, 60),
      },
    };
  }
  if (kind === 'server-empty') {
    return { value: { kind, ...safeStopWhenEmpty(raw.policy || raw) } };
  }
  return { value: { kind: 'update-available' } };
}

function safeStopWhenEmpty(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    minimumEmptyMinutes: clamp(raw.minimumEmptyMinutes, 1, 1440, DEFAULT_STOP_WHEN_EMPTY.minimumEmptyMinutes),
    graceSeconds: clamp(raw.graceSeconds, 0, 3600, DEFAULT_STOP_WHEN_EMPTY.graceSeconds),
    minimumUptimeMinutes: clamp(raw.minimumUptimeMinutes, 0, 1440, DEFAULT_STOP_WHEN_EMPTY.minimumUptimeMinutes),
    windows: safeWindows(raw.windows),
    sessions: ['all', 'automatic', 'manual'].includes(raw.sessions) ? raw.sessions : DEFAULT_STOP_WHEN_EMPTY.sessions,
    message: safeText(raw.message, MESSAGE_LIMIT) || DEFAULT_STOP_WHEN_EMPTY.message,
  };
}

function normalizeAction(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const kind = ACTION_KINDS.includes(raw.kind) ? raw.kind : null;
  if (!kind) return { error: 'errors.unknownTaskType' };
  if (kind === 'command') {
    const command = safeText(raw.command, 512);
    if (!command) return { error: 'errors.commandRequired' };
    return { value: { kind, command } };
  }
  if (kind === 'announce' || kind === 'say') {
    const message = safeText(raw.message, MESSAGE_LIMIT);
    if (!message) return { error: 'errors.announcementRequired' };
    return { value: { kind, message } };
  }
  if (kind === 'backup') {
    const offlineMode = ['skip', 'run', 'catch-up'].includes(raw.offlineMode) ? raw.offlineMode : 'skip';
    return { value: { kind, offlineMode } };
  }
  if (kind === 'graceful-restart') {
    return {
      value: {
        kind,
        announceSeconds: clamp(raw.announceSeconds, 0, 3600, 300),
        message: safeText(raw.message, MESSAGE_LIMIT) || 'Server restarting in {seconds} seconds.',
      },
    };
  }
  if (kind === 'stop-when-empty') {
    return { value: { kind, ...safeStopWhenEmpty(raw) } };
  }
  return { value: { kind } };
}

/*
 * Full task validation. `validateCron` is injected (node-cron's validator in
 * production) so this module stays dependency-free.
 */
function normalizeTask(input, { serverType = null, validateCron = () => true } = {}) {
  const raw = migrateTask(input);
  const trigger = normalizeTrigger(raw.trigger, validateCron);
  if (trigger.error) return { error: trigger.error };
  const action = normalizeAction(raw.action);
  if (action.error) return { error: action.error };
  const palworld = serverType === 'palworld';
  const terraria = serverType === 'terraria';
  if (!palworld && PALWORLD_ACTIONS.includes(action.value.kind)) return { error: 'errors.palworldActionOnly' };
  if (!palworld && PALWORLD_TRIGGERS.includes(trigger.value.kind)) return { error: 'errors.palworldTriggerOnly' };
  if (palworld && action.value.kind === 'command') return { error: 'errors.palworldUseAdapter' };
  if (!terraria && ['backup-offline', 'say'].includes(action.value.kind)) return { error: 'errors.terrariaActionOnly' };
  if (trigger.value.kind === 'server-empty' && action.value.kind !== 'stop-when-empty') {
    return { error: 'errors.emptyTriggerAction' };
  }
  const value = {
    version: TASK_VERSION,
    name: safeText(raw.name, 80) || `${action.value.kind} task`,
    enabled: raw.enabled !== false,
    trigger: trigger.value,
    action: action.value,
    // Legacy mirror: cron scheduling and older readers keep working unchanged.
    type: action.value.kind,
    cron: trigger.value.kind === 'cron' ? trigger.value.expression : '',
    command: action.value.kind === 'command' ? action.value.command : '',
  };
  return { value };
}

function capabilityForAction(action) {
  const kind = typeof action === 'string' ? action : action?.kind;
  return CAPABILITIES[kind] || 'server.control';
}

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

/*
 * A preview explains exactly when a trigger fires. Cron/interval previews list
 * concrete local timestamps and flag UTC-offset changes (DST) between them so
 * the UI can say "this run happens an hour later than the previous one".
 */
function previewTrigger(trigger, { now = Date.now(), count = 3, lastFireAt = null } = {}) {
  const kind = trigger?.kind || 'cron';
  const base = {
    kind,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    utcOffsetMinutes: -new Date(now).getTimezoneOffset(),
    next: [],
    offsetChanges: false,
    condition: null,
  };
  if (kind === 'cron') {
    const fires = nextCronFires(trigger.expression, { from: now, count });
    base.next = fires.map((date) => ({ at: date.toISOString(), utcOffsetMinutes: -date.getTimezoneOffset() }));
  } else if (kind === 'interval') {
    const minutes = Math.max(MIN_INTERVAL_MINUTES, Number(trigger.minutes) || MIN_INTERVAL_MINUTES);
    let cursor = lastFireAt ? Number(lastFireAt) + minutes * 60_000 : now + minutes * 60_000;
    for (let index = 0; index < count; index += 1) {
      if (cursor <= now) cursor = now + minutes * 60_000;
      const date = new Date(cursor);
      base.next.push({ at: date.toISOString(), utcOffsetMinutes: -date.getTimezoneOffset() });
      cursor += minutes * 60_000;
    }
  } else if (kind === 'player-joined') {
    base.condition = trigger.playerId
      ? `When ${trigger.playerId} joins (delay ${trigger.delaySeconds || 0}s, cooldown ${trigger.cooldownMinutes || 0}m).`
      : `When any player joins (delay ${trigger.delaySeconds || 0}s, cooldown ${trigger.cooldownMinutes || 0}m).`;
  } else if (kind === 'server-empty') {
    const policy = safeStopWhenEmpty(trigger);
    base.condition = `After ${policy.minimumEmptyMinutes} continuously empty minutes confirmed by a healthy REST reading`
      + (policy.windows.length ? `, inside ${policy.windows.map((w) => `${w.start}-${w.end}`).join(', ')}` : '')
      + (policy.graceSeconds ? `, with a ${policy.graceSeconds}s grace announcement.` : '.');
  } else {
    base.condition = 'When a new Palworld build becomes available.';
  }
  const offsets = new Set(base.next.map((item) => item.utcOffsetMinutes));
  base.offsetChanges = offsets.size > 1;
  return base;
}

// ---------------------------------------------------------------------------
// Stop-when-empty state machine
// ---------------------------------------------------------------------------

function emptyState(state) {
  const raw = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  return {
    emptySince: Number.isFinite(raw.emptySince) ? raw.emptySince : null,
    pausedAt: Number.isFinite(raw.pausedAt) ? raw.pausedAt : null,
    pendingStopAt: Number.isFinite(raw.pendingStopAt) ? raw.pendingStopAt : null,
    announced: raw.announced === true,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    cancelledReason: typeof raw.cancelledReason === 'string' ? raw.cancelledReason : null,
  };
}

function idleResult(state, reason, action = 'none', extra = {}) {
  return { state: { ...state, reason }, action, reason, ...extra };
}

/*
 * `observation` is what we actually know right now:
 *   { status, healthy, playerCount, sessionOrigin, startedAt }
 * `healthy` is REST health. A false value means "we do not know how many
 * players are online" - the countdown pauses, it never advances.
 */
function emptyDecision({ policy, state, observation, now = Date.now() }) {
  const rules = safeStopWhenEmpty(policy);
  const current = emptyState(state);
  const cancel = (reason) => idleResult(
    { emptySince: null, pausedAt: null, pendingStopAt: null, announced: false, cancelledReason: current.pendingStopAt ? reason : null },
    reason,
  );

  if (!observation || observation.status !== 'online') return cancel('not_online');
  if (rules.sessions !== 'all' && observation.sessionOrigin && observation.sessionOrigin !== rules.sessions) {
    return cancel('session_excluded');
  }

  // REST uncertainty: hold everything exactly where it is.
  if (!observation.healthy) {
    return idleResult({ ...current, pausedAt: current.pausedAt ?? now }, 'rest_uncertain');
  }

  const playerCount = Number(observation.playerCount);
  if (!Number.isFinite(playerCount)) {
    return idleResult({ ...current, pausedAt: current.pausedAt ?? now }, 'rest_uncertain');
  }
  if (playerCount > 0) return cancel('player_online');

  if (rules.minimumUptimeMinutes > 0 && Number.isFinite(observation.startedAt)
      && now - observation.startedAt < rules.minimumUptimeMinutes * 60_000) {
    return cancel('minimum_uptime');
  }
  if (!inWindows(rules.windows, new Date(now))) {
    return idleResult({ ...current, pausedAt: current.pausedAt ?? now }, 'outside_window');
  }

  // Resume: the paused interval never counts toward the empty duration.
  let emptySince = current.emptySince;
  if (emptySince === null) emptySince = now;
  else if (current.pausedAt !== null) emptySince += now - current.pausedAt;

  const next = { ...current, emptySince, pausedAt: null, cancelledReason: null };
  if (now - emptySince < rules.minimumEmptyMinutes * 60_000) {
    return idleResult(next, 'counting');
  }
  if (rules.graceSeconds > 0) {
    if (!next.announced) {
      return {
        state: { ...next, announced: true, pendingStopAt: now + rules.graceSeconds * 1000, reason: 'grace' },
        action: 'announce',
        reason: 'grace',
        message: renderTemplate(rules.message, { seconds: rules.graceSeconds }),
        stopAt: now + rules.graceSeconds * 1000,
      };
    }
    if (next.pendingStopAt !== null && now < next.pendingStopAt) return idleResult(next, 'grace');
  }
  return {
    state: { emptySince: null, pausedAt: null, pendingStopAt: null, announced: false, reason: 'stopping', cancelledReason: null },
    action: 'stop',
    reason: 'empty',
  };
}

// ---------------------------------------------------------------------------
// Join trigger
// ---------------------------------------------------------------------------

function joinState(state) {
  const raw = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  return {
    present: Array.isArray(raw.present) ? raw.present.slice(0, 256) : null,
    cooldowns: raw.cooldowns && typeof raw.cooldowns === 'object' && !Array.isArray(raw.cooldowns) ? { ...raw.cooldowns } : {},
    pending: Array.isArray(raw.pending) ? raw.pending.slice(0, 64) : [],
  };
}

/*
 * Returns the messages that are due now plus the ones that were cancelled and
 * why. The first observation after a panel start only records who is online -
 * players already connected are not "joins".
 */
function joinDecision({ trigger, action, state, observation, now = Date.now() }) {
  const current = joinState(state);
  const delayMs = Math.max(0, Number(trigger?.delaySeconds) || 0) * 1000;
  const cooldownMs = Math.max(0, Number(trigger?.cooldownMinutes) || 0) * 60_000;
  const template = action?.message || '';

  if (!observation || observation.status !== 'online') {
    return {
      state: { ...current, present: null, pending: [] },
      due: [],
      cancelled: current.pending.map((item) => ({ ...item, reason: 'server_offline' })),
      reason: 'not_online',
    };
  }
  if (!observation.healthy) {
    // Uncertainty is never a departure and never a join.
    return { state: current, due: [], cancelled: [], reason: 'rest_uncertain' };
  }

  const players = Array.isArray(observation.players) ? observation.players : [];
  const presentIds = players.map((player) => String(player.userId || '')).filter(Boolean);
  const presentSet = new Set(presentIds);
  const baseline = current.present === null;
  const knownSet = new Set(current.present || presentIds);

  const cancelled = current.pending
    .filter((item) => !presentSet.has(item.userId))
    .map((item) => ({ ...item, reason: 'player_left' }));
  let pending = current.pending.filter((item) => presentSet.has(item.userId));
  const cooldowns = { ...current.cooldowns };

  if (!baseline) {
    for (const player of players) {
      const userId = String(player.userId || '');
      if (!userId || knownSet.has(userId)) continue;
      if (trigger?.playerId && trigger.playerId !== userId && trigger.playerId !== player.name) continue;
      const last = Number(cooldowns[userId]);
      if (Number.isFinite(last) && now - last < cooldownMs) continue;
      if (pending.some((item) => item.userId === userId)) continue;
      cooldowns[userId] = now;
      pending.push({
        userId,
        name: String(player.name || ''),
        dueAt: now + delayMs,
        message: renderTemplate(template, { player: player.name || userId }),
      });
    }
  }

  const due = pending.filter((item) => item.dueAt <= now);
  pending = pending.filter((item) => item.dueAt > now);

  return {
    state: { present: presentIds, cooldowns, pending },
    due,
    cancelled,
    reason: baseline ? 'baseline' : 'observed',
  };
}

// ---------------------------------------------------------------------------
// Backup scheduling semantics
// ---------------------------------------------------------------------------

function backupState(state) {
  const raw = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  return {
    missed: raw.missed === true,
    lastRunAt: Number.isFinite(raw.lastRunAt) ? raw.lastRunAt : null,
    lastSkipAt: Number.isFinite(raw.lastSkipAt) ? raw.lastSkipAt : null,
    lastFingerprint: typeof raw.lastFingerprint === 'string' ? raw.lastFingerprint : null,
  };
}

function backupDecision({ action, state, observation, now = Date.now() }) {
  const current = backupState(state);
  const mode = ['skip', 'run', 'catch-up'].includes(action?.offlineMode) ? action.offlineMode : 'skip';
  const online = observation?.status === 'online';
  if (online) return { state: { ...current, missed: false }, action: 'run', reason: 'online' };
  if (mode === 'run') return { state: { ...current, missed: false }, action: 'run', reason: 'offline_allowed' };
  return {
    state: { ...current, lastSkipAt: now, missed: mode === 'catch-up' },
    action: 'skip',
    reason: mode === 'catch-up' ? 'offline_deferred' : 'offline_skipped',
  };
}

/*
 * Run at most one catch-up once the server is online *and* healthy again.
 */
function backupCatchUp({ state, observation, now = Date.now() }) {
  const current = backupState(state);
  if (!current.missed) return { state: current, action: 'none', reason: 'nothing_missed' };
  if (observation?.status !== 'online' || !observation?.healthy) {
    return { state: current, action: 'none', reason: 'not_healthy' };
  }
  return { state: { ...current, missed: false, lastRunAt: now }, action: 'run', reason: 'catch_up' };
}

function archiveFingerprint(manifest) {
  const entries = Array.isArray(manifest?.entries)
    ? manifest.entries.map((entry) => [
      String(entry.path),
      Number(entry.size) || 0,
      String(entry.sha256 ?? entry.digest ?? ''),
    ])
    : null;
  if (entries) return fingerprint(entries.sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  if (manifest?.sha256) return String(manifest.sha256);
  return null;
}

/*
 * Deduplication uses verified content metadata, never a filename or an mtime:
 * an offline server that produced a byte-identical archive is a duplicate.
 */
function isDuplicateArchive(manifest, state) {
  const current = archiveFingerprint(manifest);
  if (!current) return false;
  return current === backupState(state).lastFingerprint;
}

// ---------------------------------------------------------------------------
// Update-available trigger
// ---------------------------------------------------------------------------

/*
 * Edge-triggered: an update that stays available does not re-fire, and the
 * same build never fires twice even across a panel restart.
 */
function updateDecision({ state, updateState, buildId, now = Date.now() }) {
  const last = typeof state?.lastBuildId === 'string' ? state.lastBuildId : null;
  if (updateState !== 'update-ready' || !buildId) {
    return { state: { ...(state || {}), lastSeenState: updateState || null }, action: 'none', reason: 'no_update' };
  }
  if (last === String(buildId)) {
    return { state: { ...(state || {}), lastSeenState: updateState }, action: 'none', reason: 'already_fired' };
  }
  return {
    state: { ...(state || {}), lastBuildId: String(buildId), lastSeenState: updateState, lastFireAt: now },
    action: 'run',
    reason: 'update_ready',
  };
}

// ---------------------------------------------------------------------------
// Interval scheduling and boot reconciliation
// ---------------------------------------------------------------------------

function intervalDecision({ trigger, state, now = Date.now() }) {
  const minutes = Math.max(MIN_INTERVAL_MINUTES, Number(trigger?.minutes) || MIN_INTERVAL_MINUTES);
  const lastFireAt = Number.isFinite(state?.lastFireAt) ? state.lastFireAt : null;
  if (lastFireAt === null) return { state: { ...(state || {}), lastFireAt: now }, action: 'run', reason: 'first_run' };
  if (now - lastFireAt < minutes * 60_000) return { state: state || {}, action: 'none', reason: 'not_due' };
  return { state: { ...(state || {}), lastFireAt: now }, action: 'run', reason: 'due' };
}

/*
 * At boot we reconcile instead of firing every missed occurrence: at most one
 * catch-up run, and only when the miss is recent enough to still be useful.
 */
function reconcile({ trigger, state, now = Date.now() }) {
  const kind = trigger?.kind;
  if (kind !== 'cron' && kind !== 'interval') return { action: 'none', reason: 'not_time_based', state: state || {} };
  const lastFireAt = Number.isFinite(state?.lastFireAt) ? state.lastFireAt : null;
  if (lastFireAt === null) return { action: 'none', reason: 'no_history', state: { ...(state || {}), lastFireAt: now } };

  let missedAt = null;
  if (kind === 'interval') {
    const minutes = Math.max(MIN_INTERVAL_MINUTES, Number(trigger.minutes) || MIN_INTERVAL_MINUTES);
    const due = lastFireAt + minutes * 60_000;
    if (due <= now) missedAt = due;
  } else {
    const fires = nextCronFires(trigger.expression, { from: lastFireAt, count: 1 });
    if (fires.length && fires[0].getTime() <= now) missedAt = fires[0].getTime();
  }
  if (missedAt === null) return { action: 'none', reason: 'nothing_missed', state: state || {} };
  if (!trigger.catchUp) return { action: 'skip', reason: 'catch_up_disabled', missedAt, state: { ...(state || {}), missedAt } };
  const maxAge = Math.max(1, Number(trigger.maxCatchUpMinutes) || 120) * 60_000;
  if (now - missedAt > maxAge) return { action: 'skip', reason: 'missed_too_old', missedAt, state: { ...(state || {}), missedAt } };
  return { action: 'run', reason: 'catch_up', missedAt, state: { ...(state || {}), lastFireAt: now, missedAt: null } };
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

/*
 * Only the fields the schedulers need across a panel restart are persisted,
 * and they are always plain JSON: last observation, pending-since time, last
 * fire, missed action, and the cancellation reason.
 */
function safeState(state) {
  const raw = state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  return {
    lastObservationAt: Number.isFinite(raw.lastObservationAt) ? raw.lastObservationAt : null,
    lastFireAt: Number.isFinite(raw.lastFireAt) ? raw.lastFireAt : null,
    missedAt: Number.isFinite(raw.missedAt) ? raw.missedAt : null,
    empty: emptyState(raw.empty),
    join: joinState(raw.join),
    backup: backupState(raw.backup),
    update: {
      lastBuildId: typeof raw.update?.lastBuildId === 'string' ? raw.update.lastBuildId : null,
      lastSeenState: typeof raw.update?.lastSeenState === 'string' ? raw.update.lastSeenState : null,
    },
    cancelledReason: typeof raw.cancelledReason === 'string' ? raw.cancelledReason : null,
  };
}

module.exports = {
  TASK_VERSION,
  TRIGGER_KINDS,
  ACTION_KINDS,
  PALWORLD_ACTIONS,
  PALWORLD_TRIGGERS,
  MIN_INTERVAL_MINUTES,
  DEFAULT_STOP_WHEN_EMPTY,
  migrateTask,
  normalizeTask,
  safeStopWhenEmpty,
  capabilityForAction,
  renderTemplate,
  parseCron,
  cronMatches,
  nextCronFires,
  previewTrigger,
  emptyDecision,
  joinDecision,
  backupDecision,
  backupCatchUp,
  archiveFingerprint,
  isDuplicateArchive,
  updateDecision,
  intervalDecision,
  reconcile,
  safeState,
};
