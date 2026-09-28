import { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { toast } from 'sonner';
import {
  Power, Users, Activity, Cpu, MemoryStick, AlertTriangle, AlertOctagon, Info, CheckCircle2, ArrowRight, Play, Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useServer } from '@/context/ServerContext';
import { useStats } from '@/context/StatsContext';
import { useI18n } from '@/context/I18nContext';
import { useApi } from '@/hooks/useApi';
import { useSectionContext } from '@/hooks/useSections';
import { useAttentionItems } from '@/hooks/useAttentionItems';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import { fmtUptime, fmtMB, cn } from '@/lib/utils';
import { cpuReading, tpsTone, pickKpis } from '@/lib/overview';
import { findingTitle, findingDetail, categoryLabel } from '@/lib/healthText';
import { KpiTile } from '@/components/shared/KpiTile';

const MAX_SPARK = 150;
const STATUS_TONES = { online: 'online', starting: 'warn', stopping: 'warn', offline: 'neutral' };

/**
 * A server's Overview: is it running, and does anything need you. Four KPI
 * cards with their context, one Needs attention list with the button that
 * fixes each item, and a facts line. Everything else is behind "Details".
 */
export function OverviewView({ active, onNavigate, onServerAction }) {
  const { activeServerId, statuses, servers, supports } = useServer();
  const { subscribe, getLatest } = useStats();
  const { t } = useI18n();
  const dash = t('common.dashPlaceholder');
  const status = (activeServerId && statuses[activeServerId]) || { status: 'offline' };
  const state = status.status || 'offline';
  const running = state !== 'offline';
  const server = servers.find((s) => s.id === activeServerId);
  const attention = useAttentionItems(activeServerId);
  const { ago, when } = useRelativeTime();

  const sparkRef = useRef({ procmem: [], proccpu: [] });
  const [stats, setStats] = useState(null);

  const onStats = useCallback((s) => {
    setStats(s);
    const sp = sparkRef.current;
    const push = (key, val) => { sp[key] = [...sp[key], val].slice(-MAX_SPARK); };
    push('procmem', s.procMem / 1048576);
    push('proccpu', s.procCpu || 0);
  }, []);

  // Subscribed only while this view is the one shown; catch up on the latest
  // tick on activation in case ticks arrived while another view was shown.
  useEffect(() => {
    if (!active) return undefined;
    const latest = getLatest();
    if (latest) onStats(latest);
    return subscribe(onStats);
  }, [active, onStats, subscribe, getLatest]);

  // A new server's cards never inherit the previous one's trend.
  useEffect(() => {
    sparkRef.current = { procmem: [], proccpu: [] };
    setStats(null);
  }, [activeServerId]);

  const baselines = attention.health?.baselines || null;
  const memoryPressure = attention.items.some((item) => item.finding?.ruleId === 'memory.pressure');
  const procCpu = running && stats ? Math.round(stats.procCpu || 0) : null;
  const procMemMb = running && stats ? stats.procMem / 1048576 : null;
  const tps = status.serverFps ?? status.tps;
  const tracksTps = running && tps != null;

  // The tile *array* is memoized so a stats tick doesn't rebuild every tile
  // object; memo(KpiTile) then skips tiles whose props did not change.
  const tiles = useMemo(() => {
    const waiting = running && !stats;
    const all = {
      status: {
        icon: Power,
        label: t('overview.status'),
        value: t(`overview.state.${state}`),
        sub: running ? (status.uptimeMs ? t('overview.upFor', { uptime: fmtUptime(status.uptimeMs) }) : null) : t('overview.notRunning'),
        tone: STATUS_TONES[state] || 'neutral',
        action: state === 'offline' && onServerAction ? (
          <Button variant="success" size="sm" onClick={() => onServerAction('start')}>
            <Play className="h-3.5 w-3.5 fill-current" />
            {t('header.start')}
          </Button>
        ) : null,
      },
      players: {
        icon: Users,
        label: t('overview.players'),
        value: running
          ? (status.maxPlayers ? t('overview.playersOf', { count: status.playerCount || 0, max: status.maxPlayers }) : `${status.playerCount || 0}`)
          : dash,
        sub: running ? t('overview.playersNow') : null,
      },
      performance: {
        icon: Activity,
        label: t('minecraft.dashboard.tps'),
        value: tracksTps ? Number(tps).toFixed(1) : dash,
        sub: tracksTps ? t('overview.tpsLagging') : null,
        tone: tpsTone(tps),
      },
      cpu: (() => {
        const reading = cpuReading(procCpu, baselines?.cpu);
        const p95 = baselines?.cpu?.available ? Math.round(baselines.cpu.p95) : null;
        const sub = {
          normal: t('overview.cpuNormal', { p95 }),
          high: p95 != null ? t('overview.cpuHigh', { p95 }) : t('overview.cpuHighNoBaseline'),
          learning: t('overview.cpuLearning'),
        }[reading.state] || null;
        return {
          icon: Cpu,
          label: t('overview.cpu'),
          value: procCpu != null ? `${procCpu} ${t('common.unitPercent')}` : dash,
          sub,
          tone: reading.tone,
          loading: waiting,
          sparkData: sparkRef.current.proccpu,
        };
      })(),
      memory: (() => {
        const heapMb = baselines?.memory?.heapMb || null;
        const heapPct = procMemMb != null && heapMb ? Math.round((procMemMb / heapMb) * 100) : null;
        return {
          icon: MemoryStick,
          label: t('overview.memory'),
          value: procMemMb == null ? dash
            : heapMb ? t('overview.memoryOf', { used: fmtMB(procMemMb), heap: fmtMB(heapMb) }) : fmtMB(procMemMb),
          sub: procMemMb == null ? null
            : memoryPressure ? t('overview.memoryPressure')
              : heapPct != null ? t('overview.memoryPct', { pct: heapPct }) : t('overview.memoryUsed'),
          tone: memoryPressure && running ? 'warn' : 'neutral',
          loading: waiting,
          sparkData: sparkRef.current.procmem,
        };
      })(),
    };
    return pickKpis({ tracksPlayers: supports('players'), tracksTps, tps })
      .map((key) => ({ key, ...all[key] }));
  }, [t, dash, state, running, status, stats, tps, tracksTps, procCpu, procMemMb, baselines, memoryPressure, supports, onServerAction]);

  if (!activeServerId) return null;

  const facts = [
    server?.mcVersion ? t('overview.factVersion', { version: server.mcVersion }) : null,
    attention.hasBackups
      ? (attention.lastBackupAt ? t('overview.factLastBackup', { ago: ago(attention.lastBackupAt) }) : t('overview.factNoBackup'))
      : null,
    attention.next ? t('overview.factNext', { task: attention.next.task.name || t('nav.schedules'), when: when(attention.next.at) }) : null,
  ].filter(Boolean);

  return (
    <div className="space-y-6">
      <div className={cn('grid grid-cols-1 gap-4 sm:grid-cols-2', tiles.length === 4 ? 'xl:grid-cols-4' : 'xl:grid-cols-3')}>
        {tiles.map(({ key, ...tile }) => <KpiTile key={key} testId={key} {...tile} />)}
      </div>

      <NeedsAttention attention={attention} onNavigate={onNavigate} onServerAction={onServerAction} ago={ago} />

      <div data-overview-facts className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        {facts.map((fact) => <span key={fact}>{fact}</span>)}
        <Button variant="link" size="sm" className="ml-auto h-auto px-0" onClick={() => onNavigate('details')}>
          {t('details.link')}
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

const SEVERITY_ICONS = {
  critical: { icon: AlertOctagon, className: 'text-status-error' },
  warning: { icon: AlertTriangle, className: 'text-status-warn' },
  notice: { icon: Info, className: 'text-muted-foreground' },
};

function NeedsAttention({ attention, onNavigate, onServerAction, ago }) {
  const { t } = useI18n();
  const { items, loading, checkedAt } = attention;
  return (
    <section data-attention aria-labelledby="attention-title" className="space-y-3">
      <h2 id="attention-title" className="font-display text-title font-extrabold uppercase tracking-[0.03em] text-foreground">
        {items.length ? t('overview.attentionCount', { count: items.length }) : t('overview.attention')}
      </h2>
      <div className="overflow-hidden rounded border-2 border-border bg-card">
        {loading ? (
          <div aria-busy="true" className="space-y-3 p-4">
            <span className="block h-4 w-2/3 animate-pulse rounded-sm bg-muted/60" />
            <span className="block h-4 w-1/2 animate-pulse rounded-sm bg-muted/40" />
          </div>
        ) : items.length === 0 ? (
          <p data-attention-clear className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-status-online" />
            <span className="font-medium text-foreground">{t('overview.allClear')}</span>
            {checkedAt && <span>· {t('overview.checkedAgo', { ago: ago(checkedAt) })}</span>}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((item, index) => (
              <AttentionRow
                key={item.id}
                item={item}
                lead={index === 0}
                attention={attention}
                onNavigate={onNavigate}
                onServerAction={onServerAction}
                ago={ago}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function itemText(t, item, ago) {
  switch (item.kind) {
    case 'first-start':
      return { title: t('overview.item.firstStart') };
    case 'watchdog':
      return { title: t('notifications.watchdog_limitTitle'), detail: t('overview.item.watchdogDetail') };
    case 'crash': {
      const { count, lastSeenAt, category } = item.crash;
      return {
        title: Number(count) > 1
          ? t('overview.item.crash', { count, ago: ago(lastSeenAt) })
          : t('overview.item.crashOnce', { ago: ago(lastSeenAt) }),
        detail: categoryLabel(t, category),
      };
    }
    case 'finding':
      return { title: findingTitle(t, item.finding), detail: findingDetail(t, item.finding) };
    case 'content-updates':
      return { title: item.count === 1 ? t('overview.item.contentUpdate') : t('overview.item.contentUpdates', { count: item.count }) };
    case 'game-update':
      return { title: t('overview.item.gameUpdate') };
    default:
      return { title: item.kind };
  }
}

// Only the first item's main button is filled: one primary action per region,
// and the list is already sorted most urgent first.
function AttentionRow({ item, lead, attention, onNavigate, onServerAction, ago }) {
  const { t } = useI18n();
  const api = useApi();
  const { can } = useSectionContext();
  const [busy, setBusy] = useState(false);
  const { icon: Icon, className } = SEVERITY_ICONS[item.severity] || SEVERITY_ICONS.notice;
  const { title, detail } = itemText(t, item, ago);

  const run = async (work) => {
    setBusy(true);
    try { await work(); } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  // The server verifies the new backup and re-runs the health analysis before
  // answering, so a reload is enough to clear the finding.
  const backUpNow = () => run(async () => {
    await api('/api/backups', { method: 'POST', body: {} });
    toast.success(t('backups.createdToast'));
    attention.reload();
  });
  const dismissCrash = () => run(async () => {
    await api(`/api/crashes/groups/${encodeURIComponent(item.crash.id)}/acknowledge`, { method: 'POST' });
    attention.dismiss(item.id);
  });

  const go = (view, tab) => () => onNavigate(view, tab);
  const buttons = {
    start: [{ label: t('header.start'), onClick: () => onServerAction?.('start'), primary: true }],
    backup: can('backups.create')
      ? [{ label: t('overview.action.backup'), onClick: backUpNow, primary: true }]
      : [{ label: t('overview.action.backups'), onClick: go('backups') }],
    backups: [{ label: t('overview.action.backups'), onClick: go('backups') }],
    details: [{ label: t('overview.action.details'), onClick: go('details') }],
    crash: [
      { label: t('overview.action.crash'), onClick: go('crashes', item.crash?.id) },
      ...(can('health.manage') ? [{ label: t('overview.action.dismiss'), onClick: dismissCrash, ghost: true }] : []),
    ],
    console: [{ label: t('overview.action.console'), onClick: go('console') }],
    mods: [{ label: t('overview.action.review'), onClick: go('mods', 'updates') }],
    version: [{ label: t('overview.action.review'), onClick: go('settings', 'version') }],
  }[item.action] || [];

  return (
    <li data-attention-item={item.kind} data-severity={item.severity} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', className)} aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
        </div>
      </div>
      {buttons.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 pl-7 sm:pl-0">
          {buttons.map(({ label, onClick, primary, ghost }) => (
            <Button
              key={label}
              size="sm"
              variant={primary && lead ? 'default' : ghost ? 'ghost' : 'outline'}
              disabled={busy}
              onClick={onClick}
            >
              {busy && primary && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {label}
            </Button>
          ))}
        </div>
      )}
    </li>
  );
}
