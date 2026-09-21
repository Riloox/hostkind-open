import { AlertTriangle } from 'lucide-react';
import { useT } from '@/context/I18nContext';
import { cn } from '@/lib/utils';

// Compact yellow Issues panel used by ConfigsView to surface validation
// results from the active editor. Each issue has { severity, message }.
// The Save button in the view is disabled when any error is present.

export function ValidationPanel({ issues = [] }) {
  const t = useT();
  const has = issues.length > 0;
  const tone = issues.some((i) => i.severity === 'error')
    ? 'border-status-error/40 bg-status-error/15 text-status-error'
    : 'border-status-warn/40 bg-status-warn/15 text-status-warn';
  return (
    <div className={cn(
      'mt-3 rounded-md border px-3 py-2 text-xs',
      has ? tone : 'border-border bg-secondary/20 text-muted-foreground'
    )}>
      <div className="flex items-center gap-2 font-semibold uppercase tracking-wide text-label">
        {has && <AlertTriangle className="h-3.5 w-3.5" />}
        <span>{t('configs.issuesTitle')}</span>
      </div>
      {has ? (
        <ul className="mt-1.5 space-y-0.5">
          {issues.map((i, idx) => (
            <li key={`${i.severity || 'info'}-${String(i.message || '').slice(0, 64)}-${idx}`} className="flex items-start gap-1.5">
              <span className="text-current/70">•</span>
              <span>{i.message}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-label">{t('configs.issuesEmpty')}</p>
      )}
    </div>
  );
}
