import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { EmptyState } from '@/components/shared/EmptyState';
import { useApi } from '@/hooks/useApi';
import { useT } from '@/context/I18nContext';
import { toast } from 'sonner';
import { AlertTriangle, Download, Loader2, Map as MapIcon, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

const DESCRIPTIONS = {
  bluemap: 'minecraft.mapView.descBlueMap',
  dynmap: 'minecraft.mapView.descDynmap',
  squaremap: 'minecraft.mapView.descSquaremap',
  pl3xmap: 'minecraft.mapView.descPl3xMap',
};

// The map is served by the plugin on its own port of the same machine, so
// the address the browser reaches the panel on is the right host for it too.
export function mapUrlFor(port) {
  const host = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  return `http://${host}:${port}`;
}

function Panel({ children }) {
  return (
    <div style={{ minHeight: '74vh' }} className="flex flex-col items-center justify-center gap-6 bg-background/40 px-4 py-10">
      {children}
    </div>
  );
}

function ManualLink({ onConfigure }) {
  const t = useT();
  return (
    <button type="button" onClick={onConfigure} className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
      {t('minecraft.mapView.manualLink')}
    </button>
  );
}

// Shown in place of the map until one is installed and started: pick a plugin
// and install it, point the tab at one that is already installed, or restart
// the server so a freshly installed one loads.
export function MapSetup({ state, loading, error, pending, running, onInstalled, onUseInstalled, onRestart, onConfigure, onRetry }) {
  const api = useApi();
  const t = useT();
  const [installing, setInstalling] = useState(null);
  const [restarting, setRestarting] = useState(false);

  async function install(plugin) {
    setInstalling(plugin.key);
    try {
      const res = await api(`/api/minecraft/content/map-plugins/${plugin.key}/install`, { method: 'POST', timeout: 120000 });
      toast.success(t('minecraft.mapView.installed', { name: plugin.name }));
      await onInstalled({ ...plugin, port: res?.port || plugin.port });
    } catch (e) {
      toast.error(e.message);
    } finally {
      setInstalling(null);
    }
  }

  async function restart() {
    setRestarting(true);
    try {
      await onRestart();
    } finally {
      setRestarting(false);
    }
  }

  if (pending) {
    return (
      <Panel>
        <EmptyState
          icon={MapIcon}
          title={t(running ? 'minecraft.mapView.restartTitle' : 'minecraft.mapView.startTitle', { name: pending.name })}
          message={t('minecraft.mapView.restartBody')}
          className="max-w-md"
          action={running && (
            <Button size="sm" onClick={restart} disabled={restarting}>
              {restarting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {t('minecraft.mapView.restartNow')}
            </Button>
          )}
        />
      </Panel>
    );
  }

  if (loading && !state) {
    return (
      <Panel>
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </Panel>
    );
  }

  if (error || !state) {
    return (
      <Panel>
        <EmptyState
          icon={AlertTriangle}
          title={t('minecraft.mapView.loadError')}
          message={error}
          className="max-w-sm"
          action={<Button variant="glass" size="sm" onClick={onRetry}>{t('common.retry')}</Button>}
        />
        <ManualLink onConfigure={onConfigure} />
      </Panel>
    );
  }

  if (!state.supported) {
    return (
      <Panel>
        <EmptyState
          icon={MapIcon}
          title={t('minecraft.mapView.vanillaTitle')}
          message={t('minecraft.mapView.vanillaBody')}
          className="max-w-md"
          action={<Button variant="glass" size="sm" onClick={onConfigure}>{t('minecraft.mapView.enterAddress')}</Button>}
        />
      </Panel>
    );
  }

  const installed = state.plugins.find((p) => p.installed);
  if (installed) {
    return (
      <Panel>
        <EmptyState
          icon={MapIcon}
          title={t('minecraft.mapView.detectedTitle', { name: installed.name })}
          message={t('minecraft.mapView.detectedBody', { url: mapUrlFor(installed.port) })}
          className="max-w-md"
          action={<Button size="sm" onClick={() => onUseInstalled(installed)}>{t('minecraft.mapView.showMap')}</Button>}
        />
        <ManualLink onConfigure={onConfigure} />
      </Panel>
    );
  }

  const target = [state.compat?.label, state.compat?.mcVersion].filter(Boolean).join(' ');
  return (
    <Panel>
      <div className="max-w-md space-y-1 text-center">
        <h2 className="text-base font-semibold text-foreground">{t('minecraft.mapView.setupTitle')}</h2>
        <p className="text-xs text-muted-foreground">{t('minecraft.mapView.setupBody')}</p>
      </div>
      <ul className="grid w-full max-w-2xl gap-2 sm:grid-cols-2">
        {state.plugins.map((plugin, index) => {
          const unavailable = plugin.available === false;
          const busy = installing === plugin.key;
          return (
            <li
              key={plugin.key}
              data-map-plugin={plugin.key}
              data-available={unavailable ? 'false' : 'true'}
              className={cn(
                'flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3',
                unavailable && 'opacity-60',
              )}
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {plugin.name}
                  {index === 0 && !unavailable && (
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">{t('minecraft.mapView.recommended')}</span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {unavailable ? t('minecraft.mapView.unavailable', { target }) : t(DESCRIPTIONS[plugin.key])}
                </p>
              </div>
              <Button
                size="sm"
                variant={index === 0 ? 'default' : 'glass'}
                disabled={unavailable || Boolean(installing)}
                onClick={() => install(plugin)}
                className="shrink-0"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                {busy ? t('minecraft.mapView.installing') : t('minecraft.mapView.install')}
              </Button>
            </li>
          );
        })}
      </ul>
      <ManualLink onConfigure={onConfigure} />
    </Panel>
  );
}

// BlueMap renders nothing until the owner agrees to it downloading Mojang's
// client resources; say so on the map tab instead of leaving a blank map.
export function BlueMapConsent({ onAccepted }) {
  const api = useApi();
  const t = useT();
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    try {
      await api('/api/minecraft/content/map-plugins/bluemap/accept-download', { method: 'POST' });
      toast.success(t('minecraft.mapView.blueMapConsentDone'));
      onAccepted();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Alert variant="warn" className="items-center">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1">
        <p className="font-semibold">{t('minecraft.mapView.blueMapConsentTitle')}</p>
        <p className="text-muted-foreground">{t('minecraft.mapView.blueMapConsentBody')}</p>
      </div>
      <Button size="sm" variant="glass" onClick={accept} disabled={busy} className="shrink-0">
        {t('minecraft.mapView.blueMapConsentAction')}
      </Button>
    </Alert>
  );
}
