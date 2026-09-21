import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useT } from '@/context/I18nContext';
import { joinDiff } from '@/lib/diff';
import { cn } from '@/lib/utils';
import { Plus, Minus, AlertTriangle } from 'lucide-react';

// Modal diff preview shown before saving a config file. Renders the line
// diff (added in green, removed in red) and lets the user confirm or
// cancel. When `after === before` Save is disabled. Optional `warnings`
// are surfaced above the diff as a yellow banner so the user is told
// about destructive changes (e.g. world type regenerating the world)
// before they confirm.

export function DiffPreview({ open, onOpenChange, before, after, filename, warnings, onConfirm }) {
  const t = useT();
  const [showSame, setShowSame] = useState(false);
  const lines = joinDiff(before || '', after || '');
  const added = lines.filter((l) => l.kind === 'added').length;
  const removed = lines.filter((l) => l.kind === 'removed').length;
  const same = lines.filter((l) => l.kind === 'same').length;
  const noChanges = added === 0 && removed === 0;
  const hasWarnings = Array.isArray(warnings) && warnings.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('configs.diffTitle', { file: filename })}</DialogTitle>
          <div className="flex items-center gap-3 mt-1 text-label text-muted-foreground">
            <span className="inline-flex items-center gap-1 text-status-online">
              <Plus className="h-3 w-3" />{added} {t('configs.diffAdded')}
            </span>
            <span className="inline-flex items-center gap-1 text-status-error">
              <Minus className="h-3 w-3" />{removed} {t('configs.diffRemoved')}
            </span>
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              {same} {t('configs.diffUnchanged')}
            </span>
            <label className="ml-auto inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={showSame}
                onChange={(e) => setShowSame(e.target.checked)}
                className="h-3 w-3"
              />
              {t('configs.diffShowUnchanged')}
            </label>
          </div>
        </DialogHeader>
        {hasWarnings && (
          <div
            role="alert"
            className="mx-4 mt-3 rounded-md border border-status-warn/50 bg-status-warn/15 px-3 py-2 text-label text-status-warn"
          >
            <div className="flex items-center gap-1.5 font-semibold uppercase tracking-wide text-label">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>{t('configs.diffWarnings')}</span>
            </div>
            <ul className="mt-1 space-y-0.5">
              {warnings.map((w, i) => (
                <li key={`warning-${i}-${String(w).slice(0, 48)}`} className="flex items-start gap-1.5 text-status-warn/90">
                  <span className="opacity-70">•</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <DialogBody className="p-0">
          <pre className="max-h-[55vh] overflow-auto px-4 py-3 font-mono text-[13px] leading-5 bg-console/40">
            {lines.map((l, i) => {
              if (l.kind === 'same' && !showSame) return null;
              const prefix = l.kind === 'added' ? '+ ' : l.kind === 'removed' ? '- ' : '  ';
              return (
                <div
                  key={`${l.kind}-${i}-${String(l.text || '').slice(0, 32)}`}
                  className={cn(
                    'whitespace-pre-wrap break-all px-2 -mx-2 rounded-sm',
                    l.kind === 'added'   && 'bg-status-online/15 text-status-online',
                    l.kind === 'removed' && 'bg-status-error/15 text-status-error line-through decoration-1',
                    l.kind === 'same'    && 'text-muted-foreground/80'
                  )}
                >
                  <span className="select-none opacity-60 mr-1.5">{prefix}</span>
                  {l.text || '\u00A0'}
                </div>
              );
            })}
            {noChanges && (
              <div className="text-muted-foreground text-center py-4">-</div>
            )}
          </pre>
        </DialogBody>
        <DialogFooter>
          <Button variant="glass" onClick={() => onOpenChange(false)}>{t('configs.diffCancel')}</Button>
          <Button variant="default" onClick={onConfirm} disabled={noChanges}>
            {t('configs.diffSave')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
