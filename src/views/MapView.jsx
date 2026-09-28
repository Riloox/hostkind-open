import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { ViewHeader } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { MapConfigDialog } from '@/components/shared/MapConfigDialog';
import { BlueMapConsent, MapSetup, mapUrlFor } from '@/components/shared/MapSetup';
import { useServer } from '@/context/ServerContext';
import { useT } from '@/context/I18nContext';
import { useApi } from '@/hooks/useApi';
import { toast } from 'sonner';
import { ExternalLink, RefreshCw, Settings } from 'lucide-react';
import { PalworldMapView } from '@/views/PalworldMapView';

export function MapView() {
  const { activeServer } = useServer();
  if (activeServer?.type === 'palworld') return <PalworldMapView />;
  return <MinecraftMapView key={activeServer?.id} />;
}

function MinecraftMapView() {
  const { mapUrl, activeServer, statuses, setServers } = useServer();
  const api = useApi();
  const t = useT();
  const [configOpen, setConfigOpen] = useState(false);
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // A plugin installed from this tab only loads on the next server start, so
  // the tab explains that instead of showing a map that isn't serving yet.
  const [pending, setPending] = useState(null);
  const [frameKey, setFrameKey] = useState(0);

  const serverState = statuses?.[activeServer?.id]?.status || 'offline';
  const running = serverState === 'online' || serverState === 'starting';

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setState(await api('/api/minecraft/content/map-plugins'));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  // Once the server has gone down and come back up (from here or from the
  // header controls), the new plugin is loaded and the map is live.
  useEffect(() => {
    if (!pending) return;
    if (serverState !== 'online' && pending.wasRunning) setPending({ ...pending, wasRunning: false });
    else if (serverState === 'online' && !pending.wasRunning) setPending(null);
  }, [pending, serverState]);

  async function saveUrl(url) {
    const res = await api(`/api/servers/${activeServer.id}/map`, { method: 'PUT', body: { mapUrl: url } });
    if (res?.server) setServers((prev) => prev.map((s) => (s.id === res.server.id ? { ...s, ...res.server } : s)));
  }

  async function onInstalled(plugin) {
    setPending({ name: plugin.name, wasRunning: running });
    // Point the tab at the new plugin unless the owner already set an address.
    if (!mapUrl) await saveUrl(mapUrlFor(plugin.port)).catch(() => {});
    load();
  }

  async function onUseInstalled(plugin) {
    try {
      await saveUrl(mapUrlFor(plugin.port));
    } catch (e) {
      toast.error(e.message);
    }
  }

  async function onRestart() {
    try {
      await api('/api/server/restart', { method: 'POST' });
      toast.success(t('minecraft.mapView.restarted'));
      setPending(null);
      setFrameKey((k) => k + 1);
      load();
    } catch (e) {
      toast.error(e.message);
    }
  }

  const configured = Boolean(mapUrl);
  const showMap = configured && !pending;

  return (
    <>
      <div className="space-y-6">
        <ViewHeader
          actions={
            <>
              {showMap && (
                <Button variant="glass" size="sm" onClick={() => setFrameKey((k) => k + 1)} aria-label={t('minecraft.mapView.reload')}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t('minecraft.mapView.reload')}
                </Button>
              )}
              <Button variant="glass" size="sm" onClick={() => setConfigOpen(true)}>
                <Settings className="h-3.5 w-3.5" />
                {t('minecraft.mapView.settings')}
              </Button>
              <Button
                variant="glass"
                size="sm"
                disabled={!configured}
                onClick={() => configured && window.open(mapUrl, '_blank', 'noopener,noreferrer')}
              >
                <ExternalLink className="h-3.5 w-3.5" />
                {t('minecraft.mapView.openInNewTab')}
              </Button>
            </>
          }
        />
        {state?.blueMapDownload === 'pending' && <BlueMapConsent onAccepted={load} />}
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {showMap ? (
              <iframe
                key={`${mapUrl}#${frameKey}`}
                src={mapUrl}
                referrerPolicy="no-referrer"
                title={t('minecraft.mapView.title')}
                className="block w-full border-0 bg-background"
                style={{ height: '74vh' }}
              />
            ) : (
              <MapSetup
                state={state}
                loading={loading}
                error={error}
                pending={pending}
                running={running}
                onInstalled={onInstalled}
                onUseInstalled={onUseInstalled}
                onRestart={onRestart}
                onConfigure={() => setConfigOpen(true)}
                onRetry={load}
              />
            )}
          </CardContent>
        </Card>
      </div>
      <MapConfigDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        server={activeServer}
      />
    </>
  );
}
