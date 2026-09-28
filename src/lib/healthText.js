// How health findings and crash groups read, shared by Overview (Needs
// attention) and Overview → Details, so both pages say the same thing.

export const num = (value, digits = 1) => (value == null || !Number.isFinite(value) ? null : Number(value).toFixed(digits).replace(/\.0+$/, ''));
export const gb = (mb) => (mb == null ? null : mb >= 1024 ? `${num(mb / 1024)} GB` : `${num(mb, 0)} MB`);
export const pct = (ratio) => (ratio == null ? null : `${Math.round(ratio * 100)}%`);

// TPS is a Minecraft word, so its strings live under the minecraft namespace.
const ruleNamespace = (ruleId) => (ruleId === 'tps.low' ? 'minecraft.' : '');

/** A finding's title, e.g. "No fresh verified backup". */
export const findingTitle = (t, f) => t(`${ruleNamespace(f.ruleId)}health.rules.${f.ruleId}.title`);

/** What to do about a finding, one sentence. */
export const findingAction = (t, f) => t(`${ruleNamespace(f.ruleId)}health.rules.${f.ruleId}.action`);

/** The numbers behind a finding, one sentence. */
export function findingDetail(t, f) {
  const e = f.evidence || {};
  return {
    'cpu.sustained': t('health.finding.cpu', { p95: num(e.p95, 0) ?? '-', threshold: num(e.threshold, 0) ?? '-' }),
    'memory.pressure': t('health.finding.memory', { used: gb(e.p95Mb) ?? '-', heap: gb(e.heapMb) ?? '-', ratio: pct(e.heapRatio) ?? '-' }),
    'tps.low': t('minecraft.health.finding.tps', { p10: num(e.p10) ?? '-', threshold: num(e.threshold) ?? '-' }),
    'disk.forecast': t('health.finding.disk', { days: num(e.daysUntilFull, 0) ?? '-', free: gb(e.freeMb) ?? '-', growth: gb(e.growthMbPerDay) ?? '-' }),
    'backup.stale': e.reason === 'no_backups' ? t('health.finding.backupNone')
      : e.reason === 'no_verified_backup' ? t('health.finding.backupUnverified')
        : t('health.finding.backupStale', { days: num(e.ageDays, 0) ?? '-' }),
  }[f.ruleId] || f.ruleId;
}

/** A crash group's category in words ("Java error", "Plugin or mod"). */
export function categoryLabel(t, category) {
  const minecraftCategory = category === 'java' || category === 'plugin_or_mod';
  const k = `${minecraftCategory ? 'minecraft.' : ''}health.rule.category.${category || 'unknown'}`;
  const v = t(k);
  return v === k ? (category || 'unknown') : v;
}

export const occurrenceLabel = (t, count) => (Number(count) === 1
  ? t('health.occurrence')
  : t('health.occurrences', { count }));
