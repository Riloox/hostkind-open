// What a server's Overview says: the Needs attention list and how each KPI
// reads against what is normal for the server. Pure functions over what the
// APIs return, so the rules can be tested without a browser; the Overview and
// useAttentionItems only fetch and render.

const SEVERITY_RANK = { critical: 0, warning: 1, notice: 2 };

// Where a health finding's fix lives.
const FINDING_ACTIONS = {
  'backup.stale': 'backup',
  'disk.forecast': 'backups',
};

/**
 * One list, most severe first, newest first within a severity.
 *
 * Every item is `{ id, kind, severity, at, action, ...detail }`, where
 * `action` names the inline button the Overview draws:
 *   start    · start the server          backup   · create a backup now
 *   backups  · open Backups              details  · open Overview → Details
 *   crash    · open the crash (+ dismiss) console  · open Console
 *   mods     · open Mods → Updates       version  · open Settings → Version
 *
 * @param {object}  input
 * @param {string}  input.serverId
 * @param {boolean} input.running          the server is up or coming up
 * @param {boolean} input.hasGenerated     it has been started at least once
 * @param {Array}   [input.findings]       /api/health findings
 * @param {Array}   [input.crashes]        /api/crashes groups
 * @param {number}  [input.contentUpdates] plugin/mod updates available
 * @param {boolean} [input.gameUpdate]     a newer game server build is out
 * @param {Array}   [input.notifications]  the bell's notifications
 * @param {boolean} [input.tracksTps]      the server reports TPS
 */
export function buildAttentionItems({
  serverId,
  running = false,
  hasGenerated = true,
  findings = [],
  crashes = [],
  contentUpdates = 0,
  gameUpdate = false,
  notifications = [],
  tracksTps = true,
}) {
  const items = [];

  if (!hasGenerated && !running) {
    items.push({ id: 'first-start', kind: 'first-start', severity: 'warning', at: 0, action: 'start' });
  }

  // The watchdog gave up on this server and it is still down. Once it runs
  // again the notification is history, not something that needs anyone.
  if (!running) {
    const limit = notifications
      .filter((n) => n && n.type === 'watchdog_limit' && n.serverId === serverId && !n.read)
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
    if (limit) {
      items.push({ id: `watchdog:${limit.id}`, kind: 'watchdog', severity: 'critical', at: limit.timestamp || 0, action: 'console', notification: limit });
    }
  }

  for (const group of crashes) {
    if (!group || group.acknowledgedAt) continue;
    if (group.serverId && group.serverId !== serverId) continue;
    items.push({ id: `crash:${group.id}`, kind: 'crash', severity: 'critical', at: group.lastSeenAt || 0, action: 'crash', crash: group });
  }

  for (const finding of findings) {
    if (!finding || finding.suppressed || finding.state === 'resolved') continue;
    if (finding.ruleId === 'tps.low' && !tracksTps) continue;
    items.push({
      id: `finding:${finding.id || finding.ruleId}`,
      kind: 'finding',
      severity: finding.severity === 'critical' ? 'critical' : 'warning',
      at: finding.lastSeenAt || 0,
      action: FINDING_ACTIONS[finding.ruleId] || 'details',
      finding,
    });
  }

  if (contentUpdates > 0) {
    items.push({ id: 'content-updates', kind: 'content-updates', severity: 'notice', at: 0, action: 'mods', count: contentUpdates });
  }
  if (gameUpdate) {
    items.push({ id: 'game-update', kind: 'game-update', severity: 'notice', at: 0, action: 'version' });
  }

  return items.sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) || (b.at - a.at));
}

/** Whether a game build update status (Palworld or Valheim) means one is ready. */
export function gameUpdateReady(update) {
  return !!update && update.state === 'update-ready';
}

// Above this much CPU the server is short of headroom whatever its history.
export const CPU_HIGH = 85;

/**
 * How a CPU reading compares with what is normal for this server: its 95th
 * percentile over the health baseline. Colour only when it is out of the
 * ordinary, so a busy-but-usual server stays neutral.
 *
 * @returns {{ tone: 'neutral'|'warn'|'error', state: 'normal'|'high'|'learning'|null }}
 */
export function cpuReading(value, baseline) {
  if (value == null) return { tone: 'neutral', state: null };
  if (value >= CPU_HIGH) return { tone: 'error', state: 'high' };
  if (!baseline || !baseline.available || baseline.p95 == null) return { tone: 'neutral', state: 'learning' };
  if (value > baseline.p95) return { tone: 'warn', state: 'high' };
  return { tone: 'neutral', state: 'normal' };
}

/** TPS thresholds, as the health rule and the old dashboard drew them. */
export function tpsTone(tps) {
  if (tps == null || !Number.isFinite(Number(tps))) return 'neutral';
  if (tps < 15) return 'error';
  if (tps < 19) return 'warn';
  return 'neutral';
}

/**
 * The KPI cards, in order, at most four. Status first, then Players, CPU and
 * Memory. Performance (TPS) takes CPU's place only while the server lags, so
 * a healthy server shows the numbers people check most.
 */
export function pickKpis({ tracksPlayers, tracksTps, tps }) {
  const lagging = tracksTps && tpsTone(tps) !== 'neutral';
  return [
    'status',
    ...(tracksPlayers ? ['players'] : []),
    lagging ? 'performance' : 'cpu',
    'memory',
  ].slice(0, 4);
}

/** The newest backup's time, from /api/backups, or null when there is none. */
export function latestBackupAt(backups) {
  let latest = null;
  for (const backup of backups || []) {
    const at = backup?.mtime;
    if (Number.isFinite(at) && (latest == null || at > latest)) latest = at;
  }
  return latest;
}

/**
 * The next time a schedule runs something on this server, from /api/tasks.
 * Paused schedules and ones without a clock (player-joined) do not count.
 *
 * @returns {{ at: number, task: object } | null}
 */
export function nextScheduled(tasks, serverId, now = Date.now()) {
  let next = null;
  for (const task of tasks || []) {
    if (!task || task.serverId !== serverId || task.enabled === false) continue;
    for (const fire of task.preview?.next || []) {
      const at = Date.parse(fire?.at);
      if (!Number.isFinite(at) || at < now) continue;
      if (!next || at < next.at) next = { at, task };
      break;
    }
  }
  return next;
}

/**
 * What one row of the all-servers list says about a server's attention list:
 * how many items, whether any is critical, and whether the backup is stale
 * (the row colours its "last backup" cell then).
 *
 * @returns {{ count: number, critical: boolean, backupStale: boolean }}
 */
export function attentionSummary(items) {
  const list = items || [];
  return {
    count: list.length,
    critical: list.some((item) => item.severity === 'critical'),
    backupStale: list.some((item) => item.finding?.ruleId === 'backup.stale'),
  };
}
