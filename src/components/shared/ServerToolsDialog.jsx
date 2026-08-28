import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Check, ChevronDown, Copy, Download, Info, Radio, RefreshCw } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { NativeSelect } from '@/components/ui/native-select';
import { StatusPill } from '@/components/shared/StatusPill';

import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/context/AuthContext';
import { useServer } from '@/context/ServerContext';
import { useT } from '@/context/I18nContext';
import { cn, fmtBytes } from '@/lib/utils';

// How Hostkind knows each connectivity fact. The badge tone is the whole
// point of the panel: an operator must be able to tell a measurement from an
// inference from an instruction at a glance.
const EVIDENCE_TONE = {
  observed: 'softSuccess',
  configured: 'softInfo',
  inferred: 'softWarn',
  instruction: 'default',
};

function EvidenceBadge({ evidence, t }) {
  return (
    <Badge variant={EVIDENCE_TONE[evidence] || 'secondary'} className="px-1.5 py-0.5 uppercase">
      {t(`portability.evidence.${evidence}`)}
    </Badge>
  );
}

// An address players type into the game: IPv6 needs brackets around the host.
function formatEndpoint(address, port) {
  if (!address || !port) return null;
  return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`;
}

// The one thing most operators open this tab for: an address they can hand to
// a friend. Copying it must be a single click.
function CopyEndpoint({ value, t }) {
  async function copy() {
    await navigator.clipboard.writeText(value);
    toast.success(t('portability.copied'));
  }
  return (
    <div className="flex items-center gap-2 rounded-sm border border-border bg-background px-2.5 py-2">
      <code className="min-w-0 flex-1 truncate text-sm text-foreground">{value}</code>
      <Button variant="ghost" size="icon" onClick={copy} aria-label={t('portability.copyAddress')}>
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// Checklist facts Hostkind can verify itself, keyed by the state the report
// assigns them. Colour is always paired with an icon, never alone.
const CHECK_TONE = {
  ok: { Icon: Check, className: 'text-status-online' },
  attention: { Icon: AlertTriangle, className: 'text-status-warn' },
  info: { Icon: Info, className: 'text-muted-foreground' },
};

function CheckRow({ item }) {
  const { Icon, className } = CHECK_TONE[item.state] || CHECK_TONE.info;
  return (
    <li className="flex items-start gap-2 text-xs">
      <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', className)} aria-hidden="true" />
      <span className={item.state === 'attention' ? 'text-status-warn' : 'text-muted-foreground'}>{item.message}</span>
    </li>
  );
}

function ConnectivityTab({ server }) {
  const api = useApi();
  const t = useT();
  const { getServerStatus } = useServer();
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [probe, setProbe] = useState(null);
  const [showDetails, setShowDetails] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setReport(await api('/api/palworld/connectivity', { headers: { 'X-Hostkind-Server-Id': server.id } }));
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }, [api, server.id]);

  useEffect(() => { load(); }, [load]);

  // The probe form defaults to the game port - the port operators actually
  // forward - so the common test is host-only.
  useEffect(() => {
    const gamePort = report?.ports?.game?.value;
    if (gamePort) setPort((current) => current || String(gamePort));
  }, [report]);

  async function test() {
    setBusy(true);
    try {
      setProbe(await api('/api/palworld/connectivity/test', {
        method: 'POST',
        headers: { 'X-Hostkind-Server-Id': server.id },
        body: { host, port: Number(port) },
      }));
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  if (!report) return <p className="text-xs text-muted-foreground">{t('common.loading')}</p>;

  const status = getServerStatus(server.id).status;
  const gamePort = report.ports.game.value;
  const ipv4 = report.addresses.filter((item) => item.family === 'ipv4');
  const primary = ipv4[0] || report.addresses[0] || null;
  const alternates = (ipv4.length > 0 ? ipv4 : report.addresses).slice(1);
  const lanEndpoint = primary ? formatEndpoint(primary.address, gamePort) : null;
  const publicEndpoint = formatEndpoint(report.publicAddress.value, gamePort);
  const lanInfo = report.checklist.find((item) => item.id === 'lan_address');
  // Instructions are the operator's to-do list; everything else is a fact
  // Hostkind established. server_running, port_mismatch and lan_address get
  // louder or more useful treatments (the status pill / the alerts / the LAN
  // caption) and are not repeated here.
  const steps = report.checklist.filter((item) => item.evidence === 'instruction');
  const checked = report.checklist.filter((item) => (
    item.evidence !== 'instruction'
    && item.id !== 'server_running' && item.id !== 'port_mismatch' && item.id !== 'lan_address'
  ));

  return (
    <div className="space-y-5">
      {status === 'offline' && <Alert variant="warn">{t('portability.offlineBanner')}</Alert>}
      {report.mismatch.length > 0 && (
        <Alert variant="warn">{t('portability.portMismatch')}</Alert>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label>{t('portability.lanTitle')}</Label>
            <StatusPill status={status} />
          </div>
          {lanEndpoint
            ? <CopyEndpoint value={lanEndpoint} t={t} />
            : <p className="text-xs text-muted-foreground">{t('portability.noAddresses')}</p>}
          {lanInfo && <p className="text-label leading-snug text-muted-foreground">{lanInfo.message}</p>}
          {alternates.length > 0 && (
            <p className="text-label text-muted-foreground">
              {t('portability.alsoOnMachine')}:{' '}
              <span className="tabular-nums">{alternates.map((item) => formatEndpoint(item.address, gamePort)).join(' · ')}</span>
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label>{t('portability.internetTitle')}</Label>
          {publicEndpoint
            ? <CopyEndpoint value={publicEndpoint} t={t} />
            : <p className="text-xs text-muted-foreground">{t('portability.publicAddressNotConfigured')}</p>}
        </div>
      </div>

      {steps.length > 0 && (
        <div>
          <Label>{t('portability.internetSteps')}</Label>
          <ol className="mt-2 space-y-2">
            {steps.map((item, index) => (
              <li key={item.id} className="flex items-start gap-2.5 text-xs">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border border-border text-label text-muted-foreground" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="pt-0.5 text-foreground">{item.message}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between gap-2">
          <Label>{t('portability.checkedTitle')}</Label>
          <Button variant="ghost" size="sm" disabled={busy} onClick={load}>
            <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />{t('common.refresh')}
          </Button>
        </div>
        <ul className="mt-2 space-y-1.5">
          {checked.map((item) => <CheckRow key={item.id} item={item} />)}
        </ul>
      </div>

      <div className="rounded border border-border">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
          onClick={() => setShowDetails((value) => !value)}
          aria-expanded={showDetails}
        >
          <span className="text-label font-semibold uppercase tracking-wider text-muted-foreground">{t('portability.technicalDetails')}</span>
          <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', showDetails && 'rotate-180')} aria-hidden="true" />
        </button>
        {showDetails && (
          <div className="space-y-4 border-t border-border px-3 py-3">
            <div>
              <Label>{t('portability.localAddresses')}</Label>
              <div className="mt-1 space-y-1 text-xs text-muted-foreground">
                {report.addresses.length === 0 && <div>{t('portability.noAddresses')}</div>}
                {report.addresses.map((item) => (
                  <div key={`${item.interface}-${item.address}`} className="break-all">
                    {item.address}<span className="text-muted-foreground/60"> · {item.interface}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {['game', 'query', 'rest'].map((key) => (
                <div key={key} className="rounded border border-border p-2">
                  <div className="text-label font-semibold uppercase tracking-wider text-muted-foreground">{t(`portability.port.${key}`)}</div>
                  <div className="text-sm text-foreground">{report.ports[key].value || t('common.dashPlaceholder')}</div>
                  <div className="text-label uppercase text-muted-foreground/70">
                    {report.ports[key].protocol} · {t(`portability.portSource.${report.ports[key].source}`)}
                  </div>
                </div>
              ))}
            </div>

            <div>
              <Label>{t('portability.publicAddress')}</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                {report.publicAddress.value || t('portability.publicAddressNotConfigured')}
              </p>
            </div>

            <div>
              <Label>{t('portability.listeners')}</Label>
              <div className="mt-1 space-y-1">
                {report.listeners.map((item) => (
                  <div key={`${item.protocol}-${item.port}`} className="flex items-center gap-2 text-xs">
                    <span className="tabular-nums">{item.port}/{item.protocol}</span>
                    <span className="text-muted-foreground">{t(`portability.listenerState.${item.state}`)}</span>
                    <EvidenceBadge evidence={item.evidence} t={t} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2 rounded border border-border p-3">
        <Label>{t('portability.testEndpoint')}</Label>
        <p className="text-xs text-muted-foreground">{t('portability.testEndpointNote')}</p>
        <div className="flex flex-wrap gap-2">
          <Input className="min-w-[10rem] flex-1" value={host} onChange={(e) => setHost(e.target.value)} placeholder={t('portability.testHostPlaceholder')} />
          <Input className="w-24" value={port} onChange={(e) => setPort(e.target.value)} placeholder="8211" inputMode="numeric" />
          <Button variant="glass" size="sm" disabled={busy || !host || !port} className="h-11 shrink-0" onClick={test}>
            <Radio className="h-3.5 w-3.5" />{t('portability.test')}
          </Button>
        </div>
        {probe && (
          <Alert variant="info">
            <span>{t(`portability.probeResult.${probe.result}`)} — {probe.interpretation}</span>
          </Alert>
        )}
      </div>
    </div>
  );
}

function ProfileTab({ server }) {
  const api = useApi();
  const t = useT();
  const { token } = useAuth();
  const [selection, setSelection] = useState('complete');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (value) => {
    setBusy(true);
    try {
      setPreview(await api(`/api/palworld/profile/preview?selection=${encodeURIComponent(value)}`, {
        headers: { 'X-Hostkind-Server-Id': server.id },
      }));
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }, [api, server.id]);

  useEffect(() => { load(selection); }, [load, selection]);

  async function exportProfile() {
    setBusy(true);
    try {
      const data = await api('/api/palworld/profile/export', {
        method: 'POST',
        headers: { 'X-Hostkind-Server-Id': server.id },
        body: { selection },
      });
      setResult(data);
      toast.success(t('portability.exportReady'));
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-4">
      <Alert variant="info">{t('portability.exportSecretsNote')}</Alert>
      <div className="space-y-1.5">
        <Label>{t('portability.selection')}</Label>
        <NativeSelect
          value={selection}
          onChange={(e) => { setSelection(e.target.value); setResult(null); }}
          options={[
            { value: 'configuration', label: t('portability.selectionConfiguration') },
            { value: 'world', label: t('portability.selectionWorld') },
            { value: 'mods', label: t('portability.selectionMods') },
            { value: 'complete', label: t('portability.selectionComplete') },
          ]}
        />
      </div>

      {preview && (
        <div className="space-y-2 text-xs text-muted-foreground">
          <div>{t('portability.exportTotals', { files: preview.totals.files, size: fmtBytes(preview.totals.bytes) })}</div>
          <ul className="space-y-0.5">
            {Object.entries(preview.bySection).map(([section, value]) => (
              <li key={section}>
                <span className="text-foreground">{t(`portability.section.${section}`)}</span>
                {' — '}{t('portability.exportTotals', { files: value.files, size: fmtBytes(value.bytes) })}
              </li>
            ))}
          </ul>
          <div>{t('portability.excluded')}: {preview.excluded.join(', ')}</div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy} onClick={exportProfile}>
          <Download className="h-3.5 w-3.5" />{t('portability.export')}
        </Button>
        {result && (
          <a
            className="text-xs font-semibold text-primary underline"
            href={`/api/palworld/profile/export/${result.id}/download?serverId=${encodeURIComponent(server.id)}&token=${encodeURIComponent(token)}`}
            download={result.fileName}
          >
            {t('portability.download', { size: fmtBytes(result.bytes) })}
          </a>
        )}
      </div>
      {result && <p className="break-all text-label text-muted-foreground">sha256 {result.sha256}</p>}
    </div>
  );
}

export function ServerToolsDialog({ open, onOpenChange, server }) {
  const t = useT();
  const [tab, setTab] = useState('connectivity');

  useEffect(() => { setTab('connectivity'); }, [server?.id]);

  if (!server || server.type !== 'palworld') return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{t('portability.toolsTitle', { name: server.name })}</DialogTitle></DialogHeader>
        <DialogBody>
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="flex-wrap">
              <TabsTrigger value="connectivity">{t('portability.tabConnectivity')}</TabsTrigger>
              <TabsTrigger value="profile">{t('portability.tabProfile')}</TabsTrigger>
            </TabsList>
            <TabsContent value="connectivity"><ConnectivityTab server={server} /></TabsContent>
            <TabsContent value="profile"><ProfileTab server={server} /></TabsContent>
          </Tabs>
        </DialogBody>
        <DialogFooter>
          <Button variant="glass" onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
