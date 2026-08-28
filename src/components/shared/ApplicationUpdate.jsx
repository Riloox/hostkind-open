import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, ExternalLink, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useApi } from '@/hooks/useApi';
import { useT } from '@/context/I18nContext';
import { useAuth } from '@/context/AuthContext';
import { cn } from '@/lib/utils';

function updateDetails(status) {
  const nested = status?.update || {};
  return {
    version: status?.availableVersion || nested.version || null,
    priority: status?.priority || nested.priority || null,
    releaseNotesUrl: status?.releaseNotesUrl || nested.releaseNotesUrl || null,
  };
}

function StatusLine({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/50 py-2 last:border-b-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold text-foreground">{value || '—'}</span>
    </div>
  );
}

export function ApplicationUpdateSection() {
  const t = useT();
  const api = useApi();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const details = useMemo(() => updateDetails(status), [status]);

  useEffect(() => {
    let alive = true;
    api('/api/application-update/status', { silent: true, serverScoped: false })
      .then((data) => { if (alive) setStatus(data.status || null); })
      .catch((error) => {
        if (alive) setStatus({ state: 'failed', supported: true, error: { code: error.code || 'status_failed', message: error.message } });
      });
    return () => { alive = false; };
  }, [api]);

  async function run(action, body) {
    setBusy(true);
    try {
      const data = await api(`/api/application-update/${action}`, {
        method: 'POST',
        body,
        serverScoped: false,
      });
      setStatus(data.status || null);
      if (action === 'install') toast.success(t('settings.applicationUpdateRestarting'));
    } catch (error) {
      setStatus((previous) => ({
        ...(previous || {}),
        state: previous?.state || 'failed',
        error: { code: error.code || 'update_failed', message: error.message },
      }));
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  const state = status?.state || 'idle';
  const unsupported = status?.supported === false;
  const isRestarting = state === 'restarting' || state === 'installing';
  const isBusy = busy || state === 'checking' || state === 'downloading';

  return (
    <section data-testid="application-update-section">
      <div className="mb-2 flex items-center gap-2">
        <Download className="h-3.5 w-3.5 text-muted-foreground" />
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{t('settings.applicationUpdate')}</h3>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t('settings.applicationUpdateDesc')}</p>

      {status == null ? (
        <div className="rounded-md border border-border/60 bg-background/40 px-3 py-3 text-xs text-muted-foreground">{t('common.loading')}</div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-md border border-border/60 bg-background/40 px-3">
            <StatusLine label={t('settings.applicationUpdateCurrent')} value={status.currentVersion} />
            {details.version && <StatusLine label={t('settings.applicationUpdateLatest')} value={details.version} />}
          </div>

          {unsupported && (
            <div className="flex items-start gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-2.5 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>{t('settings.applicationUpdateUnsupported')}</span>
            </div>
          )}

          {!unsupported && details.priority === 'high' && state === 'available' && (
            <div className="rounded-md border border-status-warn/30 bg-status-warn/10 px-3 py-2 text-xs text-status-warn">
              {t('settings.applicationUpdateHighPriority')}
            </div>
          )}

          {status.error && !unsupported && (
            <div className="rounded-md border border-status-error/30 bg-status-error/10 px-3 py-2 text-xs text-status-error">
              {t('settings.applicationUpdateFailed')}: {status.error.message}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {details.releaseNotesUrl && (
                <Button asChild variant="link" size="xs" className="px-0">
                  <a href={details.releaseNotesUrl} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-3.5 w-3.5" /> {t('settings.applicationUpdateReleaseNotes')}
                  </a>
                </Button>
              )}
              {state === 'ready' && <span className="flex items-center gap-1 text-xs text-status-online"><CheckCircle2 className="h-3.5 w-3.5" />{t('settings.applicationUpdateReady')}</span>}
              {isRestarting && <span className="flex items-center gap-1 text-xs text-primary"><RefreshCw className="h-3.5 w-3.5 animate-spin" />{t('settings.applicationUpdateRestarting')}</span>}
            </div>

            {!unsupported && state === 'available' && (
              <Button size="sm" onClick={() => run('download')} disabled={isBusy}>
                {isBusy ? <RefreshCw className="animate-spin" /> : <Download />}
                {t('settings.applicationUpdateDownload')}
              </Button>
            )}
            {!unsupported && state === 'ready' && (
              <Button size="sm" onClick={() => run('install', { approved: true })} disabled={isBusy}>
                <RefreshCw /> {t('settings.applicationUpdateInstall')}
              </Button>
            )}
            {!unsupported && !['available', 'downloading', 'ready', 'installing', 'restarting'].includes(state) && (
              <Button variant="glass" size="sm" onClick={() => run('check')} disabled={isBusy}>
                <RefreshCw className={cn(isBusy && 'animate-spin')} /> {t('settings.applicationUpdateCheck')}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export function ApplicationUpdateIndicator({ onOpenSettings }) {
  const t = useT();
  const api = useApi();
  const { user } = useAuth();
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    if (user?.role !== 'admin') {
      setAvailable(false);
      return undefined;
    }
    let alive = true;
    api('/api/application-update/status', { silent: true, serverScoped: false })
      .then((data) => {
        if (!alive) return;
        const status = data.status || {};
        setAvailable(status.state === 'available' || status.state === 'ready');
      })
      .catch(() => { if (alive) setAvailable(false); });
    return () => { alive = false; };
  }, [api, user?.role]);

  if (!available) return null;
  return (
    <Button
      data-tour="application-update"
      variant="ghost"
      size="icon-sm"
      title={t('settings.applicationUpdateAvailable')}
      aria-label={t('settings.applicationUpdateAvailable')}
      onClick={onOpenSettings}
    >
      <Download className="text-primary" />
    </Button>
  );
}
