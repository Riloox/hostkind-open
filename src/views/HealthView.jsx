import { useEffect, useState } from 'react';
import { AlertTriangle, Check, ChevronLeft, Activity, HardDrive, Archive, Info, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { MetricsView } from './MetricsView';
import { useApi } from '@/hooks/useApi';
import { useServer } from '@/context/ServerContext';
import { useT } from '@/context/I18nContext';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ViewHeader } from '@/components/layout/Page';
import { ErrorState } from '@/components/shared/ErrorState';

const fmt = (value) => value ? new Date(value).toLocaleString() : '-';

// Translate a crash-rule field item; fall back to the stored English string if no key exists.
const ruleKey = (t, ruleId, field, i, fallback) => {
  const keys = ruleId.startsWith('terraria.') || ruleId.startsWith('tmodloader.') || ruleId.startsWith('tshock.')
    ? [`terraria.crashes.rule.${ruleId}.${field}.${i}`, `health.rule.${ruleId}.${field}.${i}`]
    : [`health.rule.${ruleId}.${field}.${i}`];
  for (const k of keys) {
    const v = t(k);
    if (v !== k) return v;
  }
  return fallback;
};

const categoryLabel = (t, category) => {
  const minecraftCategory = category === 'java' || category === 'plugin_or_mod';
  const k = `${minecraftCategory ? 'minecraft.' : ''}health.rule.category.${category || 'unknown'}`;
  const v = t(k);
  return v === k ? (category || 'unknown') : v;
};

const occurrenceLabel = (t, count) => Number(count) === 1
  ? t('health.occurrence')
  : t('health.occurrences', { count });

export function HealthView({ onNavigate }) {
  const t = useT();
  return (
    <div className="space-y-6">
      <ViewHeader title={t('nav.health')} />
      <Tabs defaultValue="overview" className="space-y-5">
        <TabsList>
          <TabsTrigger value="overview">{t('health.overview')}</TabsTrigger>
          <TabsTrigger value="resources">{t('health.resources')}</TabsTrigger>
          <TabsTrigger value="crashes">{t('health.crashes')}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview"><Overview /></TabsContent>
        <TabsContent value="resources"><MetricsView /></TabsContent>
          <TabsContent value="crashes"><Crashes onNavigate={onNavigate} /></TabsContent>
      </Tabs>
    </div>
  );
}

const num = (value, digits = 1) => (value == null || !Number.isFinite(value) ? null : Number(value).toFixed(digits).replace(/\.0+$/, ''));
const gb = (mb) => (mb == null ? null : mb >= 1024 ? `${num(mb / 1024)} GB` : `${num(mb, 0)} MB`);
const pct = (ratio) => (ratio == null ? null : `${Math.round(ratio * 100)}%`);

// Why a card is missing is more useful than a fabricated card. Every
// insufficiency reason from the analyzer has a plain-English explanation.
function Insufficient({ t, detail }) {
  const reason = detail?.reason || 'insufficient_samples';
  const hint = {
    insufficient_samples: t('health.reason.samples', { have: detail?.sampleCount ?? 0, need: detail?.requiredSamples ?? '-' }),
    insufficient_coverage: t('health.reason.coverage'),
    capacity_unavailable: t('health.reason.capacity'),
    no_growth: t('health.reason.noGrowth'),
    poor_fit: t('health.reason.poorFit'),
    beyond_horizon: t('health.reason.beyondHorizon', { days: num(detail?.daysUntilFull, 0) ?? '-' }),
    heap_unknown: t('health.reason.heapUnknown'),
    insufficient_pairs: t('health.reason.pairs'),
    no_variance: t('health.reason.noVariance'),
  }[reason] || t('health.reason.unknown');
  return <p className="text-sm text-muted-foreground">{hint}</p>;
}

// One finding. Severity, the numbers it was derived from (window, samples,
// coverage, spread), whether it is currently suppressed, and what to do next.
function Finding({ f, t }) {
  const e = f.evidence || {};
  const detail = {
    'cpu.sustained': t('health.finding.cpu', { p95: num(e.p95, 0) ?? '-', threshold: num(e.threshold, 0) ?? '-' }),
    'memory.pressure': t('health.finding.memory', { used: gb(e.p95Mb) ?? '-', heap: gb(e.heapMb) ?? '-', ratio: pct(e.heapRatio) ?? '-' }),
    'tps.low': t('minecraft.health.finding.tps', { p10: num(e.p10) ?? '-', threshold: num(e.threshold) ?? '-' }),
    'disk.forecast': t('health.finding.disk', { days: num(e.daysUntilFull, 0) ?? '-', free: gb(e.freeMb) ?? '-', growth: gb(e.growthMbPerDay) ?? '-' }),
    'backup.stale': e.reason === 'no_backups' ? t('health.finding.backupNone')
      : e.reason === 'no_verified_backup' ? t('health.finding.backupUnverified')
        : t('health.finding.backupStale', { days: num(e.ageDays, 0) ?? '-' }),
  }[f.ruleId] || f.ruleId;

  const support = [
    e.window ? t('health.support.window', { window: e.window }) : null,
    e.sampleCount != null ? t('health.support.samples', { count: e.sampleCount }) : null,
    e.coverage != null ? t('health.support.coverage', { pct: pct(e.coverage) }) : null,
    e.iqr != null ? t('health.support.spread', { iqr: num(e.iqr) }) : null,
    e.fitQuality != null ? t('health.support.fit', { pct: pct(e.fitQuality) }) : null,
    Array.isArray(e.daysUntilFullRange) && e.daysUntilFullRange[0] != null
      ? t('health.support.range', { low: num(e.daysUntilFullRange[0], 0), high: num(e.daysUntilFullRange[1], 0) })
      : null,
  ].filter(Boolean);

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className={f.severity === 'critical' ? 'h-4 w-4 text-status-error' : 'h-4 w-4 text-status-warn'} />
        <span className="font-medium">{t(`${f.ruleId === 'tps.low' ? 'minecraft.' : ''}health.rules.${f.ruleId}.title`)}</span>
        <Badge variant={f.severity === 'critical' ? 'destructive' : 'secondary'}>{t(`health.severity.${f.severity}`)}</Badge>
        {f.suppressed && <Badge variant="outline">{t('health.suppressed', { until: fmt(f.cooldownUntil) })}</Badge>}
      </div>
      <p className="mt-2 text-sm">{detail}</p>
      <p className="mt-2 text-xs text-muted-foreground">{t('health.nextAction')}: {t(`${f.ruleId === 'tps.low' ? 'minecraft.' : ''}health.rules.${f.ruleId}.action`)}</p>
      {support.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{support.join(' · ')}</p>}
      <p className="mt-1 text-xs text-muted-foreground">{t('health.seenSince', { first: fmt(f.firstSeenAt), last: fmt(f.lastSeenAt) })}</p>
    </div>
  );
}

function Overview() {
  const api = useApi(); const t = useT(); const { activeServerId, supports } = useServer();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try {
      const q = activeServerId ? `?serverId=${encodeURIComponent(activeServerId)}` : '';
      setData(await api(`/api/health${q}`));
    } catch (e) { setError(e.message); }
    setLoading(false);
  };
  useEffect(() => { load(); }, [activeServerId]);

  if (error && !data) return <ErrorState error={error} onRetry={load} />;
  if (loading && !data) return <div className="py-12 text-center text-sm text-muted-foreground">{t('common.loading')}</div>;
  if (!data) return null;

  const { forecast, backups, correlations, baselines } = data;
  const findings = supports('players')
    ? (data.findings || [])
    : (data.findings || []).filter((finding) => finding.ruleId !== 'tps.low');
  const active = findings.filter((f) => !f.suppressed);

  return (
    <div className="space-y-5">
      {data.stale && (
        <div className="flex items-start gap-2 rounded-lg border border-status-warn/40 bg-status-warn/15 p-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" />
          <span>{t('health.staleNotice', { at: fmt(data.computedAt) })}</span>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('health.findings')}</CardTitle>
          <span className="text-xs text-muted-foreground">
            {data.computedAt ? t('health.computedAt', { at: fmt(data.computedAt) }) : t('health.notAnalyzed')}
          </span>
        </CardHeader>
        <CardContent className="space-y-3">
          {!findings.length ? (
            <p className="text-sm text-muted-foreground">
              {active.length === 0 && data.status === 'pending' ? t('health.gathering') : t('health.noFindings')}
            </p>
          ) : findings.map((f) => <Finding key={f.id} f={f} t={t} />)}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><HardDrive className="h-4 w-4" />{t('health.capacity')}</CardTitle></CardHeader>
          <CardContent>
            {forecast?.available ? (
              <div className="space-y-1 text-sm">
                <p>{t('health.diskFull', { days: num(forecast.daysUntilFull, 0) })}</p>
                <p className="text-xs text-muted-foreground">
                  {t('health.diskDetail', { free: gb(forecast.freeMb), total: gb(forecast.totalMb), growth: gb(forecast.growthMbPerDay) })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('health.support.range', { low: num(forecast.daysUntilFullRange?.[0], 0), high: num(forecast.daysUntilFullRange?.[1], 0) })}
                  {' · '}{t('health.support.fit', { pct: pct(forecast.fitQuality) })}
                  {' · '}{t('health.support.samples', { count: forecast.sampleCount })}
                </p>
              </div>
            ) : <Insufficient t={t} detail={forecast} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Archive className="h-4 w-4" />{t('health.backupFreshness')}</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {backups?.verifiedBackup ? (
              <>
                <p>{t('health.backupVerifiedAgo', { days: num(backups.ageDays, 1) })}</p>
                <p className="text-xs text-muted-foreground">{t('health.backupVerifiedAt', { at: fmt(backups.verifiedBackup.verifiedAt) })}</p>
              </>
            ) : (
              <p className="text-muted-foreground">{backups?.reason === 'no_backups' ? t('health.finding.backupNone') : t('health.finding.backupUnverified')}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Activity className="h-4 w-4" />{t('health.baselines')}</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {[
              ['cpu', baselines?.cpu],
              ['memory', baselines?.memory?.baseline || baselines?.memory],
              ...(supports('players') ? [['tps', baselines?.tps]] : []),
            ].map(([key, base]) => (
              <div key={key} className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{t(`${key === 'tps' ? 'minecraft.' : ''}health.baseline.${key}`)}</span>
                {base?.available
                  ? <span>{t('health.baselineValue', { p50: num(base.p50), p95: num(base.p95), count: base.sampleCount })}</span>
                  : <span className="text-xs text-muted-foreground">{t('health.notEnoughData')}</span>}
              </div>
            ))}
          </CardContent>
        </Card>

        {supports('players') && <Card>
          <CardHeader className="flex-col items-start">
            <CardTitle>{t('health.correlations')}</CardTitle>
            <span className="text-xs text-muted-foreground">{t('health.associationNotice')}</span>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {[['tpsPlayers', correlations?.tpsPlayers], ['tpsCpu', correlations?.tpsCpu]].map(([key, c]) => (
              <div key={key} className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{t(`minecraft.health.correlation.${key}`)}</span>
                {c?.available
                  ? <span>{t('health.correlationValue', { r: num(c.coefficient, 2), pairs: c.pairs })}</span>
                  : <span className="text-xs text-muted-foreground">{t('health.notEnoughData')}</span>}
              </div>
            ))}
          </CardContent>
        </Card>}
      </div>
    </div>
  );
}

function Crashes({ onNavigate }) {
  const api = useApi(); const t = useT(); const { activeServerId, servers } = useServer();
  const [items, setItems] = useState([]); const [detail, setDetail] = useState(null); const [loading, setLoading] = useState(true);
  const load = async () => { setLoading(true); try { const q = activeServerId ? `?serverId=${encodeURIComponent(activeServerId)}` : ''; setItems((await api(`/api/crashes${q}`)).items || []); } catch (e) { toast.error(e.message); } setLoading(false); };
  useEffect(() => { setDetail(null); load(); }, [activeServerId]);
  const open = async (id) => { try { setDetail(await api(`/api/crashes/${encodeURIComponent(id)}`)); } catch (e) { toast.error(e.message); } };
  const toggle = async () => { const g = detail.group; const action = g.acknowledgedAt ? 'unacknowledge' : 'acknowledge'; try { await api(`/api/crashes/groups/${g.id}/${action}`, { method: 'POST' }); await open(g.id); await load(); } catch (e) { toast.error(e.message); } };
  if (detail) return <CrashDetail data={detail} onBack={() => setDetail(null)} onToggle={toggle} onNavigate={onNavigate} t={t} />;
  if (loading) return <div className="py-12 text-center text-sm text-muted-foreground">{t('common.loading')}</div>;
  if (!items.length) return <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">{t('health.noCrashes')}</CardContent></Card>;
  return <div className="space-y-3">{items.map((g) => <button type="button" key={g.id} onClick={() => open(g.id)} className="w-full rounded-lg border bg-card p-4 text-left hover:border-primary/50"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-status-warn"/><span className="font-medium">{categoryLabel(t, g.category)}</span><Badge variant="secondary">{occurrenceLabel(t, g.count)}</Badge>{g.acknowledgedAt && <Badge variant="outline"><Check className="mr-1 h-3 w-3"/>{t('health.acknowledged')}</Badge>}</div><span className="text-xs text-muted-foreground">{fmt(g.lastSeenAt)}</span></div><div className="mt-2 text-xs text-muted-foreground">{servers.find((s) => s.id === g.serverId)?.name || g.serverId}</div></button>)}</div>;
}

function IncidentDatum({ label, children }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-label font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm font-semibold leading-6 text-foreground">{children}</dd>
    </div>
  );
}

function CrashDetail({ data, onBack, onToggle, onNavigate, t }) {
  const { group, incident, conclusions, backupBeforeIncident } = data;
  const sources = Object.entries(incident.evidence).filter(([key, value]) => key !== 'version' && key !== 'console' && key !== 'storageTruncated' && value && typeof value === 'object' && !Array.isArray(value));
  const summary = conclusions.length ? ruleKey(t, conclusions[0].ruleId, 'reasoning', 0, conclusions[0].reasoning[0]) : t('health.unknown');
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" />
          {t('common.back')}
        </Button>
        <Button variant="outline" onClick={onToggle}>
          {group.acknowledgedAt ? t('health.unacknowledge') : t('health.acknowledge')}
        </Button>
      </div>

      <Card>
        <CardHeader className="flex-col items-start gap-4">
          <CardTitle className="max-w-4xl font-sans text-xl font-semibold normal-case leading-tight tracking-normal">
            {summary}
          </CardTitle>
          <dl className="grid w-full gap-4 border-t border-border/80 pt-4 sm:grid-cols-3">
            <IncidentDatum label={t('health.occurrenceLabel')}>{occurrenceLabel(t, group.count)}</IncidentDatum>
            <IncidentDatum label={t('health.firstSeen')}><time dateTime={group.firstSeenAt}>{fmt(group.firstSeenAt)}</time></IncidentDatum>
            <IncidentDatum label={t('health.lastSeen')}><time dateTime={group.lastSeenAt}>{fmt(group.lastSeenAt)}</time></IncidentDatum>
          </dl>
        </CardHeader>
        <CardContent>
          {backupBeforeIncident ? (
            <div className="flex items-start gap-3 rounded border border-status-online/35 bg-status-online/10 p-4">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-status-online" aria-hidden="true" />
              <p className="text-sm font-semibold leading-6 text-foreground">
                {t('health.backupBeforeIncident', { age: formatAge(backupBeforeIncident.ageMs) })}
              </p>
            </div>
          ) : (
            <div className="flex items-start gap-3 rounded border border-status-warn/40 bg-status-warn/10 p-4">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" aria-hidden="true" />
              <p className="text-sm font-semibold leading-6 text-foreground">
                {t('health.noBackupBeforeIncident')}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {conclusions.length > 0 && (
        <Card>
          <CardHeader className="flex-col items-start gap-1.5">
            <CardTitle>{t('health.conclusions')}</CardTitle>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t('health.heuristicNotice')}</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {conclusions.map((c) => (
              <div key={c.id} className="rounded border border-border/80 bg-muted/30 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{categoryLabel(t, c.category)}</span>
                  <Badge variant="secondary">{t(`health.confidence.${c.confidence}`)}</Badge>
                </div>
                <h4 className="mt-4 text-label font-semibold uppercase tracking-[0.12em] text-muted-foreground">{t('health.suggestedChecks')}</h4>
                <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-6">
                  {c.suggestions.map((x, i) => <li key={i}>{ruleKey(t, c.ruleId, 'suggestions', i, x)}</li>)}
                </ul>
                {actionFor(c.ruleId) && (
                  <Button className="mt-4" size="sm" variant="outline" onClick={() => onNavigate(actionFor(c.ruleId))}>
                    {t('health.openAction')}
                    <ArrowRight className="h-3 w-3" />
                  </Button>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-col items-start gap-1.5">
          <CardTitle>{t('health.evidence')}</CardTitle>
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{t('health.evidenceImmutable')}</p>
        </CardHeader>
        <CardContent className="space-y-6">
          <dl className="grid gap-4 sm:grid-cols-3">
            <IncidentDatum label={t('health.occurred')}><time dateTime={incident.occurredAt}>{fmt(incident.occurredAt)}</time></IncidentDatum>
            <IncidentDatum label={t('health.exitCode')}>{incident.exitCode ?? '-'}</IncidentDatum>
            <IncidentDatum label={t('health.signal')}>{incident.signal || '-'}</IncidentDatum>
          </dl>

          {incident.evidence.console?.length > 0 && (
            <Evidence title={t('health.consoleTail')} text={incident.evidence.console.map((l) => l.text).join('\n')} />
          )}

          {sources.map(([key, source]) => source.status === 'captured'
            ? <Evidence key={key} title={source.path || key} text={source.text} />
            : (
              <p key={key} className="rounded border border-border/80 bg-muted/30 p-3 text-sm leading-6 text-muted-foreground">
                <span className="font-semibold text-foreground">{key}</span>: {source.reason || t('health.unavailable')}
              </p>
            ))}
        </CardContent>
      </Card>
    </div>
  );
}
const formatAge = (ms) => ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))}m` : ms < 86400000 ? `${Math.round(ms / 3600000)}h` : `${Math.round(ms / 86400000)}d`;
const actionFor = (ruleId) => ({
  'terraria.port.in-use': 'configs', 'terraria.world.missing': 'worlds', 'terraria.world.corrupt': 'backups',
  'terraria.world.version': 'worlds', 'terraria.awaiting-input': 'worlds', 'tmodloader.mod.missing-dependency': 'addons',
  'tmodloader.mod.version': 'addons', 'tmodloader.mod.exception': 'addons', 'tshock.config.invalid': 'configs',
}[ruleId] || null);
function Evidence({ title, text }) {
  return (
    <div className="space-y-2">
      <h4 className="font-display text-title font-extrabold uppercase tracking-[0.03em] text-foreground">{title}</h4>
      <pre
        tabIndex="0"
        aria-label={title}
        className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-console px-4 py-3 font-mono text-[13px] leading-6 text-foreground"
      >
        {text}
      </pre>
    </div>
  );
}
