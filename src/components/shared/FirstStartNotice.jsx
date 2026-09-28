import { Sparkles } from 'lucide-react';
import { useServer } from '@/context/ServerContext';
import { useT } from '@/context/I18nContext';
import { StartServerButton } from '@/components/shared/StartServerButton';

/**
 * Above a content page (Mods, Worlds, Settings → Game or Files) of a server
 * that has never been started: its world, config and folder tree only exist
 * once it has run, so say so and offer Start. It never blocks the page. The
 * shell re-fetches the page once the server is up (App.jsx, onStatus).
 */
export function FirstStartNotice() {
  const t = useT();
  const { activeServer, statuses } = useServer();
  const state = activeServer ? (statuses[activeServer.id]?.status || 'offline') : null;
  if (!activeServer || activeServer.hasGenerated !== false || state !== 'offline') return null;

  return (
    <div data-first-start-notice className="flex flex-wrap items-center gap-3 rounded-md border border-primary/20 bg-primary/10 px-4 py-3">
      <Sparkles className="h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1 basis-56 text-sm">
        <p className="font-medium text-foreground">{t('firstStart.title')}</p>
        <p className="text-muted-foreground">{t('firstStart.description')}</p>
      </div>
      <StartServerButton label={t('firstStart.startNow')} />
    </div>
  );
}
