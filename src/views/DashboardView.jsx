import { useEffect, useRef, useCallback, useState, useMemo, memo } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { AreaChart } from '@/components/ui/chart';
import { useServer } from '@/context/ServerContext';
import { useStats } from '@/context/StatsContext';
import { useT } from '@/context/I18nContext';
import { fmtUptime } from '@/lib/utils';
import { gameById } from '@/lib/games';
import { KpiTile } from '@/components/shared/KpiTile';
import { StatusPill } from '@/components/shared/StatusPill';
import { GameLogo } from '@/components/shared/GameArtwork';
import { EmptyState } from '@/components/shared/EmptyState';
import { Loading } from '@/components/shared/Loading';
import { Server, Users, Activity, Clock, Terminal, FolderOpen, Database, Cpu, MemoryStick, HardDrive, Play, Square } from 'lucide-react';

const MAX_SPARK = 150;

// Server telemetry (proc*) reads at working scale; host telemetry (sys*) sits
// in the resources panel so the two never restate the same number.
export function DashboardView({ active, onNavigate, onServerAction }) {
  const { activeServerId, statuses, servers, supports } = useServer();
  const { subscribe, getLatest } = useStats();
  const t = useT();
  const dash = t('common.dashPlaceholder');
  const status = activeServerId ? (statuses[activeServerId] || { status: 'offline' }) : { status: 'offline' };
  const server = servers.find(s => s.id === activeServerId);
  const gameId = server?.type || 'minecraft';

  const sparkRef = useRef({ procmem: [], proccpu: [], syscpu: [], sysmem: [] });
  const [stats, setStats] = useState(null);

  const onStats = useCallback((s) => {
    setStats(s);
    const sp = sparkRef.current;
    const push = (key, val) => { sp[key] = [...sp[key], val].slice(-MAX_SPARK); };
    push('procmem', s.procMem / 1048576);
    push('proccpu', s.procCpu || 0);
    push('syscpu', s.cpuSystem || 0);
    push('sysmem', s.memSystemUsed / 1073741824);
  }, []);

  // Subscribed only while this view is the shown one, so WS stats ticks update
  // the dashboard only when it is mounted (and active). Catch up on the latest
  // tick on activation in case ticks arrived while another view was shown.
  useEffect(() => {
    if (!active) return undefined;
    const latest = getLatest();
    if (latest) onStats(latest);
    return subscribe(onStats);
  }, [active, onStats, subscribe, getLatest]);

  // Reset the live buffers when the operator switches servers so a new
  // server's charts never inherit the previous one's trend.
  useEffect(() => {
    sparkRef.current = { procmem: [], proccpu: [], syscpu: [], sysmem: [] };
    setStats(null);
  }, [activeServerId]);

  const running = status.status !== 'offline';
  const online = status.status === 'online' || status.status === 'starting';
  const waitingForStats = running && !stats;

  // Scalar derives stay plain consts (cheap arithmetic); the tile *array* is
  // memoized below so a stats tick doesn't rebuild every tile object.
  const uptime = running ? fmtUptime(status.uptimeMs) : dash;
  const procMemMB = stats ? Math.round(stats.procMem / 1048576) : null;
  const procCpu = stats ? Math.round(stats.procCpu || 0) : null;
  const diskUsedGB = stats?.disk?.total ? (stats.disk.total - stats.disk.free) / 1073741824 : null;
  const diskTotalGB = stats?.disk?.total ? stats.disk.total / 1073741824 : null;
  const diskPct = stats?.disk?.total ? ((stats.disk.total - stats.disk.free) / stats.disk.total) * 100 : 0;

  // KPI tiles: server-level live metrics. Sparklines are the trend, the number
  // is the headline. Adapts to whether the module tracks players/TPS.
  // Memoized on the inputs that actually change per stats tick; tiles whose
  // props are unchanged (players/TPS while only CPU/RAM moved) are additionally
  // skipped by memo(KpiTile), so a WS tick doesn't re-render the whole strip.
  // NOTE: this hook must stay above the no-server early return - hooks can't
  // be added or removed when activeServerId toggles.
  const kpiTiles = useMemo(() => {
    const cpuTone = (v) => v == null ? 'neutral' : v >= 85 ? 'error' : v >= 60 ? 'warn' : 'online';
    const tpsTone = status.tps >= 19 ? 'online' : status.tps >= 15 ? 'warn' : status.tps ? 'error' : 'neutral';
    return [
      ...(supports('players') ? [
        {
          icon: Users, label: t('minecraft.dashboard.playersOnline'),
          value: running ? `${status.playerCount || 0}` : dash,
          sub: t('minecraft.dashboard.playersOnlineSub', { max: status.maxPlayers || 0, maxWord: t('common.maxWord') }),
          tone: 'primary',
        },
        {
          icon: Activity, label: t('minecraft.dashboard.tps'),
          value: running && status.tps != null ? Number(status.serverFps ?? status.tps).toFixed(1) : dash,
          tone: tpsTone,
        },
      ] : [
        {
          icon: Clock, label: t('dashboard.uptime'),
          value: uptime, tone: 'neutral',
        },
        ...(diskPct ? [{
          icon: HardDrive, label: t('dashboard.disk'),
          value: `${Math.round(diskPct)} ${t('common.unitPercent')}`, tone: cpuTone(diskPct),
        }] : []),
      ]),
      {
        icon: Cpu, label: t('dashboard.serverCpu'),
        value: procCpu != null ? `${procCpu} ${t('common.unitPercent')}` : dash,
        tone: cpuTone(procCpu), sparkData: sparkRef.current.proccpu,
      },
      {
        icon: MemoryStick, label: t('dashboard.serverRam'),
        value: procMemMB != null ? `${procMemMB} ${t('common.unitMB')}` : dash,
        tone: 'primary', sparkData: sparkRef.current.procmem,
      },
    ].slice(0, 4);
  }, [supports, t, dash, running, status, stats, uptime, procMemMB, procCpu, diskPct]);

  // ── No server selected ────────────────────────────────────────────────
  if (!activeServerId) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-md items-center justify-center">
        <EmptyState
          icon={Server}
          title={t('dashboard.noServerTitle')}
          message={t('dashboard.noServerBody')}
          action={
            <Button variant="default" onClick={() => onNavigate?.('servers')}>
              {t('dashboard.goToServers')}
            </Button>
          }
        />
      </div>
    );
  }

  const serverInfoRows = [
    ...(supports('players') ? [
      { label: t('minecraft.dashboard.version'), value: server?.mcVersion || dash },
      { label: t('minecraft.dashboard.jar'), value: server?.jar || dash },
      { label: t('minecraft.dashboard.worlds'), value: server?.worlds?.join(', ') || dash },
    ] : []),
    { label: t('dashboard.folder'), value: server?.dir || server?.cwd || dash },
  ];

  const quickLinks = [
    { view: 'console', icon: Terminal, label: t('dashboard.quickConsole') },
    ...(supports('players') ? [{ view: 'players', icon: Users, label: t('minecraft.dashboard.quickPlayers') }] : []),
    { view: 'files', icon: FolderOpen, label: t('dashboard.quickFiles') },
    { view: 'backups', icon: Database, label: t('dashboard.quickBackups') },
  ];

  return (
    <div className="space-y-5">
      {/* ── Server-identity hero ─────────────────────────────────────── */}
      <Card>
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-sm border-2 border-border bg-secondary">
              <GameLogo gameId={gameId} className="h-8 w-8" fallbackClassName="text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <p className="text-label font-bold uppercase tracking-[0.16em] text-primary">
                {gameById(gameId).label}
              </p>
              <h1 className="truncate font-display text-2xl font-extrabold uppercase leading-[0.95] tracking-[0.01em] text-foreground">
                {server?.name || dash}
              </h1>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <StatusPill status={status.status} />
                {supports('players') && server?.mcVersion && (
                  <span className="tabular-nums">{server.mcVersion}</span>
                )}
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="h-3 w-3" />
                  <span className="tabular-nums">{uptime}</span>
                </span>
              </div>
            </div>
          </div>
          <div className="shrink-0">
            {running ? (
              <Button variant="destructive" size="lg" onClick={() => onServerAction?.('stop')}>
                <Square className="h-4 w-4 fill-current" />
                {t('header.stop')}
              </Button>
            ) : (
              <Button variant="success" size="lg" onClick={() => onServerAction?.('start')}>
                <Play className="h-4 w-4 fill-current" />
                {t('header.start')}
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* ── KPI strip: server-level live metrics ─────────────────────── */}
      {waitingForStats ? (
        <Loading />
      ) : (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {kpiTiles.map((tile) => <KpiTile key={tile.label} {...tile} />)}
        </div>
      )}

      {/* ── Main split: host resources + server info ─────────────────── */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>{t('dashboard.resourcesTitle')}</CardTitle>
            <span className="text-label uppercase tracking-wider text-muted-foreground">{t('dashboard.last5min')}</span>
          </CardHeader>
          <CardContent>
            {waitingForStats ? (
              <Loading />
            ) : !running ? (
              <EmptyState icon={Activity} message={t('dashboard.offlineHint')} compact />
            ) : (
              <div className="space-y-5">
                <div className="grid gap-5 sm:grid-cols-2">
                  <MetricTrend
                    label={t('dashboard.systemCpu')}
                    value={stats ? `${Math.round(stats.cpuSystem || 0)} ${t('common.unitPercent')}` : dash}
                    data={sparkRef.current.syscpu}
                    max={100}
                  />
                  <MetricTrend
                    label={t('dashboard.systemRam')}
                    value={stats ? `${(stats.memSystemUsed / 1073741824).toFixed(1)} ${t('common.unitGB')}` : dash}
                    data={sparkRef.current.sysmem}
                  />
                </div>
                {diskTotalGB != null && (
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                        <HardDrive className="h-3.5 w-3.5 text-muted-foreground" />
                        {t('dashboard.disk')}
                      </span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {diskUsedGB.toFixed(0)} / {diskTotalGB.toFixed(0)} {t('common.unitGB')}
                      </span>
                    </div>
                    <Progress value={diskPct} tone="utilization" />
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t('dashboard.serverInfo')}</CardTitle></CardHeader>
          <CardContent className="p-0">
            {serverInfoRows.map(({ label, value }) => (
              <div key={label} className="flex items-start justify-between gap-3 border-b border-border px-5 py-3 text-sm last:border-0">
                <span className="shrink-0 text-muted-foreground">{label}</span>
                <span className="max-w-[180px] truncate text-right text-xs text-foreground">{value}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* ── Quick actions ────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>{t('dashboard.quickActions')}</CardTitle>
          <span className="text-xs text-muted-foreground">{t('dashboard.quickActionsHint')}</span>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {quickLinks.map(({ view, icon: Icon, label }) => (
              <Button
                key={view}
                variant="glass"
                className="h-12 justify-start px-3"
                onClick={() => onNavigate?.(view)}
              >
                <Icon className="h-4 w-4" />
                <span className="truncate">{label}</span>
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// A labeled live trend: the current value is the headline, the sparkline is the
// history. Used for host-level telemetry in the resources panel.
// Memoized for the same reason as KpiTile; the point mapping is memoized so it
// is only rebuilt when the underlying samples (or the label) actually change.
const MetricTrend = memo(function MetricTrend({ label, value, data, max }) {
  const series = useMemo(
    () => (data && data.length > 1
      ? [{ name: label, data: data.map((v, i) => ({ x: i, y: Math.round(v * 100) / 100 })) }]
      : []),
    [data, label]
  );
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{value}</span>
      </div>
      <AreaChart
        data={series}
        height={72}
        sparkline
        yMin={0}
        yMax={max}
      />
    </div>
  );
});
