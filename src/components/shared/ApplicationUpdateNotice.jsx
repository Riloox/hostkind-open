import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useApi } from '@/hooks/useApi';
import { useT } from '@/context/I18nContext';
import { useAuth } from '@/context/AuthContext';

// Fixed sonner id: every (re-)issue uses it so the notice updates in place
// and never stacks. Only ever dismissed with this id - never bare dismiss().
export const APPLICATION_UPDATE_TOAST_ID = 'app-update-available';

function dismissedKey(version) {
  return `app-update-dismissed:${version || ''}`;
}

function readDismissed(version) {
  try {
    return sessionStorage.getItem(dismissedKey(version)) === '1';
  } catch {
    return false;
  }
}

function markDismissed(version) {
  try {
    sessionStorage.setItem(dismissedKey(version), '1');
  } catch {}
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^[vV]/, '');
}

// True when the reported latest version is actually newer than (or at least
// different from) the running build. Falls back to a plain differs-check
// when either side is not a parseable numeric version.
function isUpdateFor(latest, current) {
  const next = normalizeVersion(latest);
  if (!next) return false;
  const here = normalizeVersion(current);
  if (!here) return true;
  if (next === here) return false;
  const split = (v) => String(v).split(/[.+_-]/);
  const a = split(next);
  const b = split(here);
  const wide = Math.max(a.length, b.length);
  let numeric = true;
  for (let i = 0; i < wide; i += 1) {
    const x = Number.parseInt(a[i] ?? '0', 10);
    const y = Number.parseInt(b[i] ?? '0', 10);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      numeric = false;
      break;
    }
    if (x !== y) return x > y;
  }
  // Numerically identical (or unparseable): any textual difference still
  // counts as an update candidate (e.g. build suffixes).
  return !numeric || next !== here;
}

function updateInfo(status) {
  const nested = status?.update || {};
  return {
    latest: status?.availableVersion || nested.version || null,
    releaseNotesUrl: status?.releaseNotesUrl || nested.releaseNotesUrl || null,
  };
}

// Persistent, closeable, non-invasive update notice. Renders nothing itself:
// everything goes through a single sonner toast with a fixed id so it
// updates in place instead of stacking, and the global <Toaster/> is left
// untouched so every other toast keeps working.
export function ApplicationUpdateNotice({ onOpenSettings }) {
  const t = useT();
  const api = useApi();
  const { user } = useAuth();
  const [status, setStatus] = useState(null);
  const [flow, setFlow] = useState('idle');
  const probed = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Dismiss our own toast when this notice unmounts (e.g. logout) so it
  // never lingers over the login screen. Fixed id only.
  useEffect(() => () => {
    toast.dismiss(APPLICATION_UPDATE_TOAST_ID);
  }, []);

  const isAdmin = user?.role === 'admin';

  // One probe per page load: silent status, then (only when nothing is
  // pending) ONE silent check followed by a status re-read. Any failure
  // stays silent - no toast, no error popup.
  useEffect(() => {
    if (!isAdmin) return undefined;
    if (probed.current) return undefined;
    probed.current = true;
    let cancelled = false;
    (async () => {
      try {
        let data = await api('/api/application-update/status', { silent: true, serverScoped: false });
        let next = data?.status || null;
        if (next?.state !== 'available' && next?.state !== 'ready') {
          try {
            await api('/api/application-update/check', { method: 'POST', silent: true, serverScoped: false });
            data = await api('/api/application-update/status', { silent: true, serverScoped: false });
            next = data?.status || null;
          } catch {
            // Keep the first status; a failed check simply shows nothing.
          }
        }
        if (!cancelled) setStatus(next);
      } catch {
        if (!cancelled) setStatus(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, isAdmin]);

  const state = status?.state || null;
  const { latest, releaseNotesUrl } = updateInfo(status);
  const current = status?.currentVersion || null;
  const supported = status?.supported !== false;
  const showable =
    isAdmin &&
    supported &&
    (state === 'available' || state === 'ready') &&
    isUpdateFor(latest, current) &&
    !readDismissed(latest);

  // One-click flow: download (when needed) then approved install.
  // Success dismisses the persistent toast and shows a transient one;
  // failure shows a transient error while the persistent toast stays.
  const runUpdateNow = useCallback(async () => {
    if (flow !== 'idle') return;
    setFlow('working');
    try {
      let next = status;
      if (next?.state === 'available') {
        const downloaded = await api('/api/application-update/download', {
          method: 'POST',
          serverScoped: false,
        });
        next = downloaded?.status || next;
        if (alive.current) setStatus(next);
      }
      const installed = await api('/api/application-update/install', {
        method: 'POST',
        body: { approved: true },
        serverScoped: false,
      });
      if (alive.current) setStatus(installed?.status || null);
      toast.dismiss(APPLICATION_UPDATE_TOAST_ID);
      toast.success(t('settings.applicationUpdateRestarting'));
    } catch (error) {
      toast.error(error?.message || t('settings.applicationUpdateFailed'));
    } finally {
      if (alive.current) setFlow('idle');
    }
  }, [api, flow, status, t]);

  const dismissForSession = useCallback(() => {
    markDismissed(latest);
    toast.dismiss(APPLICATION_UPDATE_TOAST_ID);
  }, [latest]);

  const openSettings = useCallback(() => {
    if (typeof onOpenSettings === 'function') onOpenSettings();
  }, [onOpenSettings]);

  // (Re-)issue the persistent toast whenever its content changes. Same id
  // every time, so sonner updates it in place instead of stacking.
  useEffect(() => {
    if (!showable) return undefined;
    const inFlight = ['checking', 'downloading', 'installing', 'restarting'].includes(state);
    const working = flow !== 'idle';
    const busy = inFlight || working;

    let primaryLabel = t('settings.applicationUpdateUpdateNow');
    if (state === 'downloading') primaryLabel = t('settings.applicationUpdateDownloading');
    else if (state === 'checking') primaryLabel = t('settings.applicationUpdateCheck');
    else if (state === 'installing' || state === 'restarting') {
      primaryLabel = t('settings.applicationUpdateRestarting');
    }

    toast.custom(
      () => (
        <div
          data-testid="application-update-toast"
          className="pointer-events-auto flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-1.5 rounded-lg border border-border bg-card p-3.5 text-card-foreground shadow-xl"
        >
          <button
            type="button"
            onClick={openSettings}
            title={t('settings.title')}
            className="cursor-pointer text-left text-sm font-semibold leading-snug hover:underline"
          >
            {t('settings.applicationUpdateToastTitle')}
          </button>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('settings.applicationUpdateToastMessage', { current: current || '—', latest: latest || '—' })}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {!busy && (
              <Button size="xs" onClick={runUpdateNow}>
                {t('settings.applicationUpdateUpdateNow')}
              </Button>
            )}
            {busy && (
              <Button size="xs" disabled>
                <RefreshCw className="h-3 w-3 animate-spin" />
                {primaryLabel}
              </Button>
            )}
            {releaseNotesUrl && (
              <Button asChild variant="ghost" size="xs">
                <a href={releaseNotesUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="h-3 w-3" />
                  {t('settings.applicationUpdateReleaseNotes')}
                </a>
              </Button>
            )}
            <Button variant="ghost" size="xs" onClick={dismissForSession}>
              {t('settings.applicationUpdateLater')}
            </Button>
          </div>
        </div>
      ),
      {
        id: APPLICATION_UPDATE_TOAST_ID,
        duration: Infinity,
        dismissible: true,
      },
    );
    return undefined;
  }, [
    showable,
    state,
    flow,
    latest,
    current,
    releaseNotesUrl,
    t,
    runUpdateNow,
    dismissForSession,
    openSettings,
  ]);

  return null;
}
