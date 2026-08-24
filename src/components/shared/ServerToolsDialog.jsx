import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Check, ChevronDown, Copy, Download, Image as ImageIcon, Info, Radio, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { NativeSelect } from '@/components/ui/native-select';
import { StatusPill } from '@/components/shared/StatusPill';
import { AccentField } from '@/components/shared/AccentField';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/context/AuthContext';
import { useServer } from '@/context/ServerContext';
import { useT } from '@/context/I18nContext';
import { cn, fmtBytes, fmtBytesRaw } from '@/lib/utils';

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

// A transparent icon on a flat dark panel reads as "the upload lost its
// edges". The checker says the transparency is the image's, not a rendering
// bug, without needing an asset.
const CHECKER = {
  backgroundImage:
    'linear-gradient(45deg, hsl(0 0% 100% / 0.04) 25%, transparent 25%, transparent 75%, hsl(0 0% 100% / 0.04) 75%),'
    + 'linear-gradient(45deg, hsl(0 0% 100% / 0.04) 25%, transparent 25%, transparent 75%, hsl(0 0% 100% / 0.04) 75%)',
  backgroundSize: '12px 12px',
  backgroundPosition: '0 0, 6px 6px',
};

// The tile is the control: it is the drop target, the file picker, and the
// preview of what is already stored. A bare "Choose image" button showed the
// operator nothing about the asset they had just uploaded.
function AssetTile({ kind, asset, src, busy, onFile, onClear }) {
  const t = useT();
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const wide = kind === 'banner';

  function drop(event) {
    event.preventDefault();
    setDragging(false);
    onFile(event.dataTransfer.files?.[0]);
  }

  return (
    <div className="space-y-1.5" data-asset={kind}>
      <div className="flex items-center justify-between gap-2">
        <Label>{t(`portability.${kind}`)}</Label>
        {asset && (
          <Button variant="ghost" size="xs" disabled={busy} onClick={onClear}>
            <X className="h-3.5 w-3.5" />{t('common.remove')}
          </Button>
        )}
      </div>
      <div className={cn('flex gap-3', wide ? 'flex-col' : 'items-center')}>
        <input
          ref={inputRef}
          className="hidden"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={drop}
          aria-label={t('portability.chooseImage')}
          className={cn(
            'group relative flex shrink-0 items-center justify-center overflow-hidden rounded-sm border-2 border-dashed border-border',
            'text-muted-foreground transition-[border-color,background-color,color]',
            'hover:border-primary/60 hover:bg-primary/5 hover:text-primary',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            'disabled:pointer-events-none disabled:opacity-50',
            asset && 'border-solid bg-background',
            dragging && 'border-primary bg-primary/10 text-primary',
            wide ? 'h-24 w-full' : 'h-20 w-20',
          )}
        >
          {asset ? (
            <>
              <img alt="" src={src} style={CHECKER} className="h-full w-auto max-w-full object-contain" />
              <span className={cn(
                'absolute inset-0 flex items-center justify-center gap-1.5 bg-background/85 text-label font-bold uppercase tracking-wider text-primary',
                'opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100',
              )}>
                <Upload className="h-3.5 w-3.5" />{t('portability.replaceImage')}
              </span>
            </>
          ) : (
            <span className="flex flex-col items-center gap-1.5 px-2 text-center">
              <ImageIcon className="h-5 w-5" aria-hidden="true" />
              {/* The square is too narrow to hold the words without wrapping
                  them to three lines; the tile's aria-label still carries it. */}
              {wide && <span className="text-label font-bold uppercase tracking-wider">{t('portability.chooseImage')}</span>}
            </span>
          )}
        </button>
        <div className={cn('min-w-0 space-y-0.5', wide ? '' : 'flex-1')}>
          <p className="text-label leading-snug text-muted-foreground">{t(`portability.${kind}Hint`)}</p>
          <p className="text-label leading-snug text-muted-foreground/70">
            {asset
              ? `${asset.width}×${asset.height} · ${fmtBytesRaw(asset.bytes)} · ${t('portability.metadataStripped')}`
              : t('portability.imageDropHint')}
          </p>
        </div>
      </div>
    </div>
  );
}

function PresentationTab({ server }) {
  const api = useApi();
  const t = useT();
  const { token } = useAuth();
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    try { setState(await api(`/api/servers/${server.id}/presentation`)); }
    catch (error) { toast.error(error.message); }
  }, [api, server.id]);

  useEffect(() => { load(); }, [load]);

  async function upload(kind, file) {
    if (!file) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append('image', file);
      setState(await api(`/api/servers/${server.id}/presentation/${kind}`, { method: 'POST', body }));
      setVersion((value) => value + 1);
      toast.success(t('portability.presentationSaved'));
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  async function clear(kind) {
    setBusy(true);
    try {
      setState(await api(`/api/servers/${server.id}/presentation/${kind}`, { method: 'DELETE' }));
      setVersion((value) => value + 1);
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  const saveAccent = useCallback(async (accent) => {
    setBusy(true);
    try { setState(await api(`/api/servers/${server.id}/presentation/accent`, { method: 'PUT', body: { accent } })); }
    catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }, [api, server.id]);

  if (!state) return <p className="text-xs text-muted-foreground">{t('common.loading')}</p>;

  const pristine = !state.icon && !state.banner && !state.accent;

  return (
    <div className="space-y-5">
      <Alert variant="info">
        <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{t('portability.presentationScope')}</span>
      </Alert>

      {/* Stacked, not side by side: a banner squeezed into half the dialog
          previews at an aspect nothing will ever render it at. */}
      <div className="space-y-5">
        {['icon', 'banner'].map((kind) => (
          <AssetTile
            key={kind}
            kind={kind}
            asset={state[kind]}
            busy={busy}
            src={`/api/servers/${server.id}/presentation/${kind}/image?token=${encodeURIComponent(token)}&v=${version}`}
            onFile={(file) => upload(kind, file)}
            onClear={() => clear(kind)}
          />
        ))}
      </div>

      <AccentField accent={state.accent} busy={busy} onChange={saveAccent} />

      <div className="flex justify-end border-t border-border pt-3">
        <Button variant="ghost" size="sm" disabled={busy || pristine} onClick={() => clear('all')}>
          <Trash2 className="h-3.5 w-3.5" />{t('portability.resetPresentation')}
        </Button>
      </div>
    </div>
  );
}

export function ServerToolsDialog({ open, onOpenChange, server }) {
  const t = useT();
  const isPalworld = server?.type === 'palworld';
  const [tab, setTab] = useState(isPalworld ? 'connectivity' : 'presentation');

  useEffect(() => { setTab(isPalworld ? 'connectivity' : 'presentation'); }, [isPalworld, server?.id]);

  if (!server) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{t('portability.toolsTitle', { name: server.name })}</DialogTitle></DialogHeader>
        <DialogBody>
          <Tabs value={tab} onValueChange={setTab}>
            {/* A tab strip with one tab is a control that cannot do anything:
                every game but Palworld gets presentation on its own. */}
            {isPalworld && (
              <TabsList className="flex-wrap">
                <TabsTrigger value="connectivity">{t('portability.tabConnectivity')}</TabsTrigger>
                <TabsTrigger value="profile">{t('portability.tabProfile')}</TabsTrigger>
                <TabsTrigger value="presentation">{t('portability.tabPresentation')}</TabsTrigger>
              </TabsList>
            )}
            {isPalworld && <TabsContent value="connectivity"><ConnectivityTab server={server} /></TabsContent>}
            {isPalworld && <TabsContent value="profile"><ProfileTab server={server} /></TabsContent>}
            <TabsContent value="presentation" className={cn(!isPalworld && 'mt-0')}><PresentationTab server={server} /></TabsContent>
          </Tabs>
        </DialogBody>
        <DialogFooter>
          <Button variant="glass" onClick={() => onOpenChange(false)}>{t('common.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
