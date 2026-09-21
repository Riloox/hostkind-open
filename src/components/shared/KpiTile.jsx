import { memo, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { AreaChart } from '@/components/ui/chart';

const TONE_CLASSES = {
  online:  'border-status-online/50',
  warn:    'border-status-warn/50',
  error:   'border-status-error/50',
  primary: 'border-primary/50',
  neutral: 'border-border',
};

const ICON_BG = {
  online:  'bg-status-online/15 text-status-online',
  warn:    'bg-status-warn/15 text-status-warn',
  error:   'bg-status-error/15 text-status-error',
  primary: 'bg-primary/15 text-primary',
  neutral: 'bg-muted/40 text-muted-foreground',
};

const DELTA_VARIANTS = {
  up: 'softSuccess',
  down: 'softError',
  neutral: 'softInfo',
};

// Memoized: the dashboard re-renders on every stats tick, but tiles whose
// props didn't change (players/TPS while only CPU/RAM moved) skip rendering.
// The sparkline point mapping is memoized alongside so it isn't rebuilt when
// the tile re-renders for an unrelated reason.
export const KpiTile = memo(function KpiTile({ icon: Icon, label, value, sub, tone = 'neutral', delta, sparkData }) {
  const deltaVariant = delta?.direction || 'neutral';
  // Truncated text needs a title so the full value stays reachable on hover.
  const valueTitle = typeof value === 'string' ? value : undefined;
  const subTitle = typeof sub === 'string' ? sub : undefined;
  const series = useMemo(
    () => (sparkData && sparkData.length > 1
      ? [{ name: label, data: sparkData.map((v, i) => ({ x: i, y: v })) }]
      : []),
    [sparkData, label]
  );
  return (
    <div className={cn(
      'surface-heat flex items-start gap-4 rounded border-2 bg-card p-4 shadow-md',
      'transition-[border-color,background-color]',
      TONE_CLASSES[tone]
    )}>
      <div className={cn(
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-current/20',
        ICON_BG[tone]
      )}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-label font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
        <div className="flex items-baseline gap-2 mt-0.5">
          <p className="text-xl font-semibold text-foreground truncate" title={valueTitle}>{value}</p>
          {delta && (
            <Badge variant={DELTA_VARIANTS[deltaVariant]} className="text-label">
              {deltaVariant === 'up' ? '↑' : deltaVariant === 'down' ? '↓' : '→'} {delta.value}
            </Badge>
          )}
        </div>
        {sub && <p className="text-xs text-muted-foreground truncate mt-0.5" title={subTitle}>{sub}</p>}
        {series.length > 0 && (
          <div className="mt-2 -mx-1">
            <AreaChart
              data={series}
              height={40}
              sparkline
            />
          </div>
        )}
      </div>
    </div>
  );
});
