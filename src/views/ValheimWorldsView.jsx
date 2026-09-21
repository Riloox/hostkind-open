import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  CalendarClock, CheckCircle2, Database, Download, Ellipsis, FileArchive, FileBox,
  Globe2, HardDrive, Info, Loader2, Pencil, Power, Sparkles, Square, Trash2, TriangleAlert, Upload,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorState } from '@/components/shared/ErrorState';
import { Loading } from '@/components/shared/Loading';
import { PageIntro, SummaryGrid, SummaryItem } from '@/components/layout/Page';
import { useApi } from '@/hooks/useApi';
import { useWorldOperation } from '@/hooks/useWorldOperation';
import { useAuth } from '@/context/AuthContext';
import { useT } from '@/context/I18nContext';
import { useServer } from '@/context/ServerContext';
import { fmtBytes } from '@/lib/utils';

const fmtDate = (value) => (value ? new Date(value).toLocaleString() : '-');
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
const API = '/api/valheim/worlds';

/*
 * The panel follows a running operation rather than holding the request open,
 * the same way TerrariaWorldsView does: a mutation outlives any one HTTP
 * call, and a reload has to pick it back up.
 * Shared via useWorldOperation (see src/hooks/useWorldOperation.js).
 */

// Every mutation shows what it would do before it does it: impact, disk, and
// why it might be refused - the same payload the backend re-validates at
// commit time.
function Impact({ preview, t }) {
  if (!preview) return null;
  const disk = preview.disk || {};
  const rows = [
    preview.world && [t('valheim.worlds.impact.world'), `${preview.world.name} · ${fmtBytes(preview.world.sizeBytes)}`],
    preview.name && !preview.world && [t('valheim.worlds.impact.name'), preview.name],
    preview.from && [t('valheim.worlds.impact.from'), preview.from],
    preview.to && [t('valheim.worlds.impact.to'), preview.to],
    preview.current && [t('valheim.worlds.impact.current'), preview.current],
    preview.source && [t('valheim.worlds.impact.source'), `${preview.source.originalName} · ${fmtBytes(preview.source.sizeBytes)}`],
    (preview.source?.backups?.length > 0 || preview.backups?.length > 0)
      && [t('valheim.worlds.impact.backups'), String((preview.source?.backups || preview.backups || []).length)],
    disk.requiredBytes > 0 && [
      t('valheim.worlds.impact.disk'),
      disk.availableBytes == null
        ? t('valheim.worlds.diskUnknown')
        : t('valheim.worlds.diskNeed', { need: fmtBytes(disk.neededBytes), free: fmtBytes(disk.availableBytes) }),
    ],
  ].filter(Boolean);

  return (
    <div className="space-y-3">
      <dl className="space-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right font-medium break-all">{value}</dd>
          </div>
        ))}
      </dl>

      {preview.willCreate && (
        <p className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 p-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('valheim.worlds.willCreate')}
        </p>
      )}
      {disk.sufficient === false && (
        <p className="flex items-start gap-2 rounded-md border border-status-error/40 bg-status-error/15 p-2 text-xs">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-error" />
          {disk.reason === 'capacity_unknown' ? t('valheim.worlds.diskUnknownBlocked') : t('valheim.worlds.diskShort')}
        </p>
      )}
      {preview.requiresOffline && !preview.serverOffline && (
        <p className="flex items-start gap-2 rounded-md border border-status-warn/40 bg-status-warn/15 p-2 text-xs">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warn" />
          {t('valheim.worlds.needsOffline')}
        </p>
      )}
      {preview.clearsSelection && (
        <p className="flex items-start gap-2 rounded-md border border-status-warn/40 bg-status-warn/15 p-2 text-xs">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warn" />
          {t('valheim.worlds.clearsSelection')}
        </p>
      )}
      {(preview.restartRequired || preview.selected || preview.select) && (
        <p className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 p-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('valheim.worlds.restartNote')}
        </p>
      )}
    </div>
  );
}

/*
 * Selection also covers "create a new world": a name that does not exist yet
 * is a valid, willCreate-flagged target - Valheim's own dedicated server
 * generates it on first connect, so there is no generation pipeline to watch.
 * Triggered from a world card, `world` is fixed and previewed immediately;
 * triggered from the "New world" button, `world` is null and the operator
 * types any validated, unused name.
 */
function SelectDialog({ world, onClose, serverId, api, t, onStarted }) {
  const locked = !!world;
  const [name, setName] = useState(world?.name || '');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const runPreview = useCallback(async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const r = await api(`${API}/select/preview`, { method: 'POST', body: { serverId, name: name.trim() } });
      setPreview(r.preview);
    } catch (e) { setError(e.message); }
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, serverId, name]);

  useEffect(() => { if (locked) runPreview(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function apply() {
    setBusy(true);
    try {
      const r = await api(`${API}/select`, {
        method: 'POST', headers: { 'Idempotency-Key': uuid() }, body: { serverId, token: preview.token },
      });
      onStarted(r.operationId);
      onClose();
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-primary" />
            {locked ? `${t('valheim.worlds.select')} · ${world.name}` : t('valheim.worlds.newWorld')}
          </DialogTitle>
          <DialogDescription>{locked ? t('valheim.worlds.selectHelp') : t('valheim.worlds.newWorldHelp')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {!locked && (
            <div className="space-y-1.5">
              <Label htmlFor="valheim-select-name">{t('valheim.worlds.worldName')}</Label>
              <Input
                id="valheim-select-name"
                value={name}
                onChange={(e) => { setName(e.target.value); setPreview(null); setError(''); }}
                placeholder={t('valheim.worlds.namePlaceholder')}
                aria-invalid={!!error}
              />
            </div>
          )}
          {error && <p className="text-xs text-status-error">{error}</p>}
          {preview?.alreadySelected && <p className="text-xs text-muted-foreground">{t('valheim.worlds.alreadySelected')}</p>}
          {preview && <Impact preview={preview} t={t} />}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          {!preview
            ? <Button onClick={runPreview} disabled={busy || !name.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('valheim.worlds.previewImpact')}</Button>
            : <Button onClick={apply} disabled={busy || !preview.serverOffline}>{t('valheim.worlds.selectConfirm')}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Rename has no size/generation concept to speak of - just a validated new
// name for both files and every recognized backup together.
function RenameDialog({ world, onClose, serverId, api, t, onStarted }) {
  const [to, setTo] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function runPreview() {
    if (!to.trim()) return;
    setBusy(true);
    setError('');
    try {
      const r = await api(`${API}/rename/preview`, { method: 'POST', body: { serverId, from: world.name, to: to.trim() } });
      setPreview(r.preview);
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function apply() {
    setBusy(true);
    try {
      const r = await api(`${API}/rename`, {
        method: 'POST', headers: { 'Idempotency-Key': uuid() }, body: { serverId, token: preview.token },
      });
      onStarted(r.operationId);
      onClose();
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Pencil className="h-4 w-4 text-primary" />{t('valheim.worlds.rename')} · {world.name}</DialogTitle>
          <DialogDescription>{t('valheim.worlds.renameHelp')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="valheim-rename-to">{t('valheim.worlds.newName')}</Label>
            <Input
              id="valheim-rename-to"
              value={to}
              onChange={(e) => { setTo(e.target.value); setPreview(null); setError(''); }}
              placeholder={t('valheim.worlds.namePlaceholder')}
              aria-invalid={!!error}
            />
          </div>
          {error && <p className="text-xs text-status-error">{error}</p>}
          {preview && <Impact preview={preview} t={t} />}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          {!preview
            ? <Button onClick={runPreview} disabled={busy || !to.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('valheim.worlds.previewImpact')}</Button>
            : <Button onClick={apply} disabled={busy || !preview.serverOffline}>{t('valheim.worlds.renameConfirm')}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/*
 * Import takes either the raw `.fwl` + `.db` pair or a zip holding one world
 * pair (with its recognized backups). Both are checked - the pair is
 * completeness-verified, the archive is walked entry by entry - before the
 * dialog offers to commit anything.
 */
function ImportDialog({ open, onClose, serverId, api, t, onStarted }) {
  const [files, setFiles] = useState([]);
  const [name, setName] = useState('');
  const [select, setSelect] = useState(false);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!open) { setFiles([]); setName(''); setSelect(false); setPreview(null); setError(''); } }, [open]);

  async function runPreview() {
    if (!files.length) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      for (const file of files) form.append('files', file);
      if (name.trim()) form.append('name', name.trim());
      form.append('select', String(select));
      const r = await api(`${API}/import/preview?serverId=${encodeURIComponent(serverId)}`, { method: 'POST', body: form });
      setPreview(r.preview);
      setName(r.preview.name);
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function apply() {
    setBusy(true);
    try {
      const r = await api(`${API}/import`, {
        method: 'POST', headers: { 'Idempotency-Key': uuid() }, body: { serverId, token: preview.token },
      });
      onStarted(r.operationId);
      onClose();
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Upload className="h-4 w-4 text-primary" />{t('valheim.worlds.import')}</DialogTitle>
          <DialogDescription>{t('valheim.worlds.importHelp')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <label className="group flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/15 px-5 py-6 text-center transition-colors hover:border-primary/50 hover:bg-primary/5">
            <input
              type="file"
              accept=".fwl,.db,.zip"
              multiple
              className="sr-only"
              onChange={(e) => { setFiles([...(e.target.files || [])].slice(0, 2)); setPreview(null); setError(''); }}
            />
            <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
              {files.length ? <CheckCircle2 className="h-5 w-5" /> : <FileArchive className="h-5 w-5" />}
            </span>
            <span className="max-w-full truncate text-sm font-medium">
              {files.length ? files.map((file) => file.name).join(', ') : t('valheim.worlds.chooseFiles')}
            </span>
            <span className="mt-1 text-xs text-muted-foreground">
              {files.length ? fmtBytes(files.reduce((sum, file) => sum + file.size, 0)) : t('valheim.worlds.chooseFilesHint')}
            </span>
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="valheim-import-name">{t('valheim.worlds.worldName')}</Label>
            <Input
              id="valheim-import-name"
              value={name}
              onChange={(e) => { setName(e.target.value); setPreview(null); }}
              placeholder={t('valheim.worlds.namePlaceholder')}
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={select}
              onChange={(e) => { setSelect(e.target.checked); setPreview(null); }}
            />
            <span>{t('valheim.worlds.selectAfter')}</span>
          </label>

          {error && <p className="text-xs text-status-error">{error}</p>}
          {preview && <div className="rounded-lg border p-3"><Impact preview={preview} t={t} /></div>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          {!preview
            ? <Button onClick={runPreview} disabled={busy || !files.length}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('valheim.worlds.previewImpact')}</Button>
            : <Button onClick={apply} disabled={busy || preview.disk?.sufficient === false || !preview.serverOffline}>{t('valheim.worlds.importConfirm')}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ world, onClose, serverId, api, t, onStarted }) {
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api(`${API}/${encodeURIComponent(world.name)}/delete/preview`, { method: 'POST', body: { serverId } });
        if (!cancelled) setPreview(r.preview);
      } catch (e) {
        if (!cancelled) { toast.error(e.message); onClose(); }
      }
    })();
    return () => { cancelled = true; };
  }, [api, serverId, world.name, onClose]);

  async function apply() {
    setBusy(true);
    try {
      const headers = { 'Idempotency-Key': uuid() };
      const r = await api(`${API}/${encodeURIComponent(world.name)}`, { method: 'DELETE', headers, body: { serverId, token: preview.token } });
      onStarted(r.operationId);
      onClose();
    } catch (e) { toast.error(e.message); setBusy(false); }
  }

  const blocked = !preview || !preview.serverOffline;

  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Trash2 className="h-4 w-4 text-destructive" />{t('valheim.worlds.delete')} · {world.name}</DialogTitle>
          <DialogDescription>{t('valheim.worlds.deleteHelp')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <p className="flex items-start gap-2 rounded-md border border-status-warn/40 bg-status-warn/15 p-2 text-xs">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warn" />
            {t('valheim.worlds.deleteWarning', { days: preview?.retentionDays ?? 30 })}
          </p>
          {!preview ? <Loading size="sm" className="py-6" /> : <Impact preview={preview} t={t} />}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button variant="destructive" onClick={apply} disabled={busy || blocked}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('valheim.worlds.deleteConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ValheimWorldsView() {
  const api = useApi();
  const t = useT();
  const { token } = useAuth();
  const { activeServerId, getServerStatus } = useServer();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState(null); // { action, world }
  const [stopping, setStopping] = useState(false);

  const load = useCallback(async () => {
    if (!activeServerId) { setData(null); setLoading(false); return; }
    setError('');
    try {
      setData(await api(`${API}?serverId=${encodeURIComponent(activeServerId)}`));
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [api, activeServerId]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const { op, events, follow } = useWorldOperation(api, t, load, {
    successKey: 'valheim.worlds.opDone',
    cancelledKey: 'valheim.worlds.opCancelled',
    failedKey: 'valheim.worlds.opFailed',
    clearDelay: 3000,
  });
  const operationStarted = useCallback((operationId) => { follow(operationId); load(); }, [follow, load]);

  // A world download is a plain GET, so it goes through the browser with the
  // token in the query string, the way the other download routes work.
  const download = (world) => {
    window.location.href = `${API}/${encodeURIComponent(world.name)}/download`
      + `?serverId=${encodeURIComponent(activeServerId)}&token=${encodeURIComponent(token)}`;
  };

  async function stopServer() {
    setStopping(true);
    try {
      await api('/api/server/stop', { method: 'POST', body: { serverId: activeServerId } });
      toast.success(t('valheim.worlds.stopping'));
    } catch (e) { toast.error(e.message); }
    setStopping(false);
  }

  if (loading) return <Loading />;
  if (error && !data) return <ErrorState error={error} onRetry={load} />;
  if (!data) return <EmptyState icon={Globe2} title={t('valheim.worlds.noServer')} />;

  const live = activeServerId ? getServerStatus(activeServerId) : null;
  const offline = !live || live.status === 'offline';
  const busy = !!op && ['queued', 'running'].includes(op.state);
  const totalSize = data.worlds.reduce((sum, world) => sum + (world.sizeBytes || 0), 0);
  const latestChange = data.worlds.reduce((latest, world) => Math.max(latest, world.modifiedAt || 0), 0);
  // A selection or rename takes effect at the next start, and the operation
  // says so in its own result rather than the view guessing from what it did.
  const restartRequired = offline && op?.state === 'succeeded' && op.summary?.restartRequired === true;
  const runningAction = String(op?.kind || '').split('.').pop().replace(/^valheim-/, '');
  const lastEvent = events.length ? events[events.length - 1] : null;

  return (
    <div className="space-y-5">
      <PageIntro
        title={t('valheim.worlds.title')}
        description={t('valheim.worlds.subtitle')}
        actions={
          <>
            <Button variant="glass" onClick={() => setDialog({ action: 'import' })} disabled={busy || !offline}>
              <Upload className="h-4 w-4" />{t('valheim.worlds.import')}
            </Button>
            <Button onClick={() => setDialog({ action: 'new' })} disabled={busy || !offline}>
              <Sparkles className="h-4 w-4" />{t('valheim.worlds.newWorld')}
            </Button>
          </>
        }
      />

      {/* Every world mutation needs the server stopped, so the notice carries
          the button that gets it there instead of sending the operator
          elsewhere. */}
      {!offline && (
        <Card className="border-status-warn/40 bg-status-warn/5">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="flex items-start gap-2 text-sm">
              <Power className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" />
              <div>
                <p className="font-medium">{t('valheim.worlds.offlineRequired')}</p>
                <p className="text-xs text-muted-foreground">{t('valheim.worlds.offlineRequiredHelp')}</p>
              </div>
            </div>
            <Button variant="destructive" size="sm" onClick={stopServer} disabled={stopping}>
              {stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5 fill-current" />}
              {t('valheim.worlds.stopServer')}
            </Button>
          </CardContent>
        </Card>
      )}

      {restartRequired && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="flex items-start gap-2 py-4 text-sm">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div>
              <p className="font-medium">{t('valheim.worlds.restartRequired')}</p>
              <p className="text-xs text-muted-foreground">{t('valheim.worlds.restartRequiredHelp')}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {busy && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              {t(`valheim.worlds.op.${runningAction}`, {})}
            </CardTitle>
            <Badge variant="outline">{Math.round((op.progress || 0) * 100)}%</Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            <Progress value={Math.round((op.progress || 0) * 100)} />
            <p className="text-xs text-muted-foreground">
              {t(`valheim.worlds.phase.${op.phase}`, {})}
              {lastEvent?.metadata?.stage ? ` · ${lastEvent.metadata.stage}` : ''}
            </p>
          </CardContent>
        </Card>
      )}

      <SummaryGrid className="sm:grid-cols-3 xl:grid-cols-3">
        {[
          { icon: Database, label: t('valheim.worlds.summaryWorlds'), value: data.worlds.length },
          { icon: HardDrive, label: t('valheim.worlds.summaryStorage'), value: fmtBytes(totalSize) },
          { icon: CalendarClock, label: t('valheim.worlds.summaryUpdated'), value: latestChange ? fmtDate(latestChange) : '-' },
        ].map(({ icon, label, value }) => <SummaryItem key={label} icon={icon} label={label} value={value} />)}
      </SummaryGrid>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FileBox className="h-4 w-4" />{t('valheim.worlds.list')}</CardTitle>
          <span className="text-label text-muted-foreground">{data.saveDir}</span>
        </CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-2">
          {data.worlds.length === 0 && (
            <div className="col-span-full rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              {t('valheim.worlds.empty')}
            </div>
          )}
          {data.worlds.map((world) => (
            <div key={world.name} className="group flex min-h-40 flex-col rounded-xl border bg-background/35 p-4 transition-colors hover:border-primary/30 hover:bg-background/60">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-semibold">{world.name}</span>
                    {world.active && <Badge variant="secondary">{t('valheim.worlds.active')}</Badge>}
                    {world.health !== 'healthy' && (
                      <Badge variant={world.health === 'incomplete' ? 'outline' : 'destructive'}>
                        {t(`valheim.worlds.health.${world.health}`)}
                      </Badge>
                    )}
                    {world.files.backups > 0 && (
                      <Badge variant="outline">{t('valheim.worlds.hasBackup', { count: world.files.backups })}</Badge>
                    )}
                  </div>
                  {world.reason && (
                    <p className="mt-1 truncate text-label text-muted-foreground">{t(`valheim.worlds.reason.${world.reason}`, {})}</p>
                  )}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={t('valheim.worlds.moreActions')}><Ellipsis className="h-4 w-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={busy || !offline || world.active || !world.complete}
                      onSelect={() => setDialog({ action: 'select', world })}
                    >
                      <CheckCircle2 className="h-4 w-4" />{t('valheim.worlds.select')}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={busy || !offline} onSelect={() => setDialog({ action: 'rename', world })}>
                      <Pencil className="h-4 w-4" />{t('valheim.worlds.rename')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => download(world)}>
                      <Download className="h-4 w-4" />{t('valheim.worlds.download')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      disabled={busy || !offline}
                      onSelect={() => setDialog({ action: 'delete', world })}
                    >
                      <Trash2 className="h-4 w-4" />{t('valheim.worlds.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg bg-muted/35 p-2">
                  <span className="block text-muted-foreground">{t('valheim.worlds.summaryStorage')}</span>
                  <strong>{fmtBytes(world.sizeBytes)}</strong>
                </div>
                <div className="rounded-lg bg-muted/35 p-2">
                  <span className="block text-muted-foreground">{t('valheim.worlds.files')}</span>
                  <strong>{[world.files.metadata && '.fwl', world.files.database && '.db'].filter(Boolean).join(' + ') || '-'}</strong>
                </div>
              </div>
              <div className="mt-auto flex items-end justify-between gap-3 pt-4">
                <span className="text-label text-muted-foreground">
                  {world.modifiedAt ? t('valheim.worlds.modified', { at: fmtDate(world.modifiedAt) }) : '-'}
                </span>
                {!world.active && world.complete && (
                  <Button variant="outline" size="sm" disabled={busy || !offline} onClick={() => setDialog({ action: 'select', world })}>
                    <CheckCircle2 className="h-3.5 w-3.5" />{t('valheim.worlds.select')}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {data.operations.length > 0 && (
        <Card>
          <CardHeader><CardTitle>{t('valheim.worlds.history')}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {data.operations.slice(0, 10).map((entry) => (
              <div key={entry.operationId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  {t(`valheim.worlds.op.${entry.action.replace(/^valheim-/, '')}`, {})}
                  {entry.worldId ? ` · ${entry.worldId}` : ''}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {fmtDate(entry.queuedAt)}
                  <Badge variant={entry.state === 'succeeded' ? 'secondary' : entry.state === 'running' ? 'outline' : 'destructive'}>
                    {t(`valheim.worlds.state.${entry.state}`)}
                  </Badge>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <ImportDialog
        open={dialog?.action === 'import'}
        onClose={() => setDialog(null)}
        serverId={activeServerId}
        api={api}
        t={t}
        onStarted={operationStarted}
      />
      {(dialog?.action === 'select' || dialog?.action === 'new') && (
        <SelectDialog
          world={dialog.action === 'select' ? dialog.world : null}
          onClose={() => setDialog(null)}
          serverId={activeServerId}
          api={api}
          t={t}
          onStarted={operationStarted}
        />
      )}
      {dialog?.action === 'rename' && (
        <RenameDialog
          world={dialog.world}
          onClose={() => setDialog(null)}
          serverId={activeServerId}
          api={api}
          t={t}
          onStarted={operationStarted}
        />
      )}
      {dialog?.action === 'delete' && (
        <DeleteDialog
          world={dialog.world}
          onClose={() => setDialog(null)}
          serverId={activeServerId}
          api={api}
          t={t}
          onStarted={operationStarted}
        />
      )}
    </div>
  );
}
