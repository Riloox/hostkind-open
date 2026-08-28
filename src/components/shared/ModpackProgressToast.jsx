import { toast } from 'sonner';
import { Package } from 'lucide-react';

function ProgressToast({ t }) {
  return (
    <div className="w-[356px] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card/95 p-4 shadow-xl backdrop-blur-sm">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Package className="h-4 w-4 shrink-0 text-primary" />
        {t('minecraft.modrinth.modpackProgress')}
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={t('minecraft.modrinth.modpackProgress')}>
        <div className="modpack-progress-indeterminate h-full rounded-full bg-primary" />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{t('minecraft.modrinth.modpackProgressBackground')}</p>
    </div>
  );
}

// Persistent, manually dismissible toast shown while a modpack install runs
// in the background. Closing it only hides the status; it does not cancel the
// install.
export function showModpackProgressToast(t) {
  const id = toast.custom(() => <ProgressToast t={t} />, {
    duration: Infinity,
    dismissible: true,
    closeButton: true,
  });
  return id;
}

// Remove the progress status once the API has confirmed that installation
// finished. A separate success toast is emitted by the caller afterwards.
export function dismissModpackProgressToast(id) {
  if (id === undefined || id === null) return;
  toast.dismiss(id);
}
