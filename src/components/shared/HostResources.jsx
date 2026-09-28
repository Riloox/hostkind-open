import { useEffect, useRef, useCallback, useState, useMemo, memo } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { AreaChart } from '@/components/ui/chart';
import { useServer } from '@/context/ServerContext';
import { useStats } from '@/context/StatsContext';
import { useT } from '@/context/I18nContext';
import { EmptyState } from '@/components/shared/EmptyState';
import { Loading } from '@/components/shared/Loading';
import { Activity, HardDrive } from 'lucide-react';

const MAX_SPARK = 150;

/**
 * The machine the server runs on: system CPU and memory over the last few
 * minutes, and disk use. Live, from the stats stream. It explains a server's
 * numbers rather than being one of them, so it lives on the details page.
 */
export function HostResources() {
  const { activeServerId, statuses } = useServer();
  const { subscribe, getLatest } = useStats();
  const t = useT();
  const status = activeServerId ? (statuses[activeServerId] || { status: 'offline' }) : { status: 'offline' };
  const running = status.status !== 'offline';

  const sparkRef = useRef({ syscpu: [], sysmem: [] });
  const [stats, setStats] = useState(null);

  const onStats = useCallback((s) => {
    setStats(s);
    const sp = sparkRef.current;
    const push = (key, val) => { sp[key] = [...sp[key], val].slice(-MAX_SPARK); };
    push('syscpu', s.cpuSystem || 0);
    push('sysmem', s.memSystemUsed / 1073741824);
  }, []);

  // A new server's charts never inherit the previous one's trend.
  useEffect(() => {
    sparkRef.current = { syscpu: [], sysmem: [] };
    setStats(null);
    const latest = getLatest();
    if (latest) onStats(latest);
    return subscribe(onStats);
  }, [activeServerId, onStats, subscribe, getLatest]);

  const diskUsedGB = stats?.disk?.total ? (stats.disk.total - stats.disk.free) / 1073741824 : null;
  const diskTotalGB = stats?.disk?.total ? stats.disk.total / 1073741824 : null;
  const diskPct = stats?.disk?.total ? ((stats.disk.total - stats.disk.free) / stats.disk.total) * 100 : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('details.hostTitle')}</CardTitle>
        <span className="text-label uppercase tracking-wider text-muted-foreground">{t('dashboard.last5min')}</span>
      </CardHeader>
      <CardContent>
        {running && !stats ? (
          <Loading />
        ) : !running ? (
          <EmptyState icon={Activity} message={t('dashboard.offlineHint')} compact />
        ) : (
          <div className="space-y-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <MetricTrend
                label={t('dashboard.systemCpu')}
                value={`${Math.round(stats.cpuSystem || 0)} ${t('common.unitPercent')}`}
                data={sparkRef.current.syscpu}
                max={100}
              />
              <MetricTrend
                label={t('dashboard.systemRam')}
                value={`${(stats.memSystemUsed / 1073741824).toFixed(1)} ${t('common.unitGB')}`}
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
  );
}

// A labeled live trend: the current value is the headline, the sparkline is the
// history. Memoized so a stats tick only rebuilds the points that changed.
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
