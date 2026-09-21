import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  CalendarClock, CheckCircle2, Database, Download, Ellipsis, FileArchive, FileBox, FileWarning,
  Globe2, HardDrive, Info, Loader2, Power, Puzzle, Sparkles, Square, Trash2, TriangleAlert, Upload,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { NativeSelect } from '@/components/ui/native-select';
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
const API = '/api/terraria/worlds';

/*
 * The panel follows a running operation rather than holding the request open: a
 * world generation outlives any one HTTP call, and a reload has to pick it back
 * up. The operation's own event log is what narrates it, so the progress panel
 * shows the last event rather than inventing a description of the phase.
 * Shared via useWorldOperation (see src/hooks/useWorldOperation.js).
 */

// Every mutation shows what it would do before it does it: impact, disk, and why
// it might be refused - the same payload the backend re-validates at commit time.
function Impact({ preview, t }) {
  if (!preview) return null;
  const disk = preview.disk || {};
  const rows = [
    preview.world && [t('terraria.worlds.impact.world'), `${preview.world.name} · ${fmtBytes(preview.world.sizeBytes)}`],
    preview.name && !preview.world && [t('terraria.worlds.impact.name'), preview.name],
    preview.current && [t('terraria.worlds.impact.current'), preview.current.name],
    preview.source && [t('terraria.worlds.impact.source'), `${preview.source.originalName} · ${fmtBytes(preview.source.sizeBytes)}`],
    preview.companions?.length && [t('terraria.worlds.impact.companions'), preview.companions.join(', ')],
    preview.size && [t('terraria.worlds.impact.size'), t(`terraria.worlds.size.${preview.size}`)],
    preview.difficulty && [t('terraria.worlds.impact.difficulty'), t(`terraria.worlds.difficulty.${preview.difficulty}`)],
    preview.seed && [t('terraria.worlds.impact.seed'), preview.seed],
    preview.remaining && [t('terraria.worlds.impact.remaining'), preview.remaining.length ? preview.remaining.join(', ') : t('terraria.worlds.impact.none')],
    disk.requiredBytes > 0 && [
      t('terraria.worlds.impact.disk'),
      disk.availableBytes == null
        ? t('terraria.worlds.diskUnknown')
        : t('terraria.worlds.diskNeed', { need: fmtBytes(disk.neededBytes), free: fmtBytes(disk.availableBytes) }),
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

      {disk.sufficient === false && (
        <p className="flex items-start gap-2 rounded-md border border-status-error/40 bg-status-error/15 p-2 text-xs">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-error" />
          {disk.reason === 'capacity_unknown' ? t('terraria.worlds.diskUnknownBlocked') : t('terraria.worlds.diskShort')}
        </p>
      )}
      {preview.requiresOffline && !preview.serverOffline && (
        <p className="flex items-start gap-2 rounded-md border border-status-warn/40 bg-status-warn/15 p-2 text-xs">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warn" />
          {t('terraria.worlds.needsOffline')}
        </p>
      )}
      {preview.modDataMissing && (
        <p className="flex items-start gap-2 rounded-md border border-status-warn/40 bg-status-warn/15 p-2 text-xs">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warn" />
          {t('terraria.worlds.modDataMissing')}
        </p>
      )}
      {preview.clearsSelection && (
        <p className="flex items-start gap-2 rounded-md border border-status-warn/40 bg-status-warn/15 p-2 text-xs">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warn" />
          {t('terraria.worlds.clearsSelection')}
        </p>
      )}
      {preview.restartRequired && (
        <p className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 p-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t('terraria.worlds.restartNote')}
        </p>
      )}
    </div>
  );
}

/*
 * Generation is the only world operation that runs the server binary, and it can
 * take minutes. The dialog collects the four inputs Terraria's own `autocreate`
 * takes, and the impact panel says what it will cost before it starts.
 */
function GenerateDialog({ open, onClose, serverId, api, t, onStarted, sizes, difficulties }) {
  const [form, setForm] = useState({ name: '', size: 'medium', difficulty: 'classic', seed: '', select: true });
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) { setForm({ name: '', size: 'medium', difficulty: 'classic', seed: '', select: true }); setPreview(null); setError(''); }
  }, [open]);

  const set = (key) => (value) => { setForm((prev) => ({ ...prev, [key]: value })); setPreview(null); setError(''); };

  async function runPreview() {
    setBusy(true);
    try {
      const r = await api(`${API}/generate/preview`, { method: 'POST', body: { serverId, ...form } });
      setPreview(r.preview);
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function apply() {
    setBusy(true);
    try {
      const r = await api(`${API}/generate`, {
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
          <DialogTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" />{t('terraria.worlds.generate')}</DialogTitle>
          <DialogDescription>{t('terraria.worlds.generateHelp')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="terraria-world-name">{t('terraria.worlds.worldName')}</Label>
            <Input
              id="terraria-world-name"
              value={form.name}
              onChange={(e) => set('name')(e.target.value)}
              placeholder={t('terraria.worlds.namePlaceholder')}
              aria-invalid={!!error}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="terraria-world-size">{t('terraria.worlds.size.label')}</Label>
              <NativeSelect
                id="terraria-world-size"
                value={form.size}
                onChange={(e) => set('size')(e.target.value)}
                options={sizes.map((size) => ({ value: size, label: t(`terraria.worlds.size.${size}`) }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="terraria-world-difficulty">{t('terraria.worlds.difficulty.label')}</Label>
              <NativeSelect
                id="terraria-world-difficulty"
                value={form.difficulty}
                onChange={(e) => set('difficulty')(e.target.value)}
                options={difficulties.map((value) => ({ value, label: t(`terraria.worlds.difficulty.${value}`) }))}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="terraria-world-seed">{t('terraria.worlds.seed')}</Label>
            <Input
              id="terraria-world-seed"
              value={form.seed}
              onChange={(e) => set('seed')(e.target.value)}
              placeholder={t('terraria.worlds.seedPlaceholder')}
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={form.select} onCheckedChange={(value) => set('select')(value === true)} className="mt-0.5" />
            <span>{t('terraria.worlds.selectAfter')}</span>
          </label>

          {error && <p className="text-xs text-status-error">{error}</p>}
          {preview && <div className="rounded-lg border p-3"><Impact preview={preview} t={t} /></div>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          {!preview
            ? <Button onClick={runPreview} disabled={busy || !form.name.trim()}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('terraria.worlds.previewImpact')}</Button>
            : <Button onClick={apply} disabled={busy || preview.disk?.sufficient === false || !preview.serverOffline}>{t('terraria.worlds.generateStart')}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/*
 * Import takes either the world files themselves or a zip holding one world. Both
 * are checked - header parsed, archive walked entry by entry - before the dialog
 * offers to commit anything.
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
          <DialogTitle className="flex items-center gap-2"><Upload className="h-4 w-4 text-primary" />{t('terraria.worlds.import')}</DialogTitle>
          <DialogDescription>{t('terraria.worlds.importHelp')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          <label className="group flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/15 px-5 py-6 text-center transition-colors hover:border-primary/50 hover:bg-primary/5">
            <input
              type="file"
              accept=".wld,.twld,.zip"
              multiple
              className="sr-only"
              onChange={(e) => { setFiles([...(e.target.files || [])].slice(0, 2)); setPreview(null); setError(''); }}
            />
            <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15 text-primary">
              {files.length ? <CheckCircle2 className="h-5 w-5" /> : <FileArchive className="h-5 w-5" />}
            </span>
            <span className="max-w-full truncate text-sm font-medium">
              {files.length ? files.map((file) => file.name).join(', ') : t('terraria.worlds.chooseFiles')}
            </span>
            <span className="mt-1 text-xs text-muted-foreground">
              {files.length ? fmtBytes(files.reduce((sum, file) => sum + file.size, 0)) : t('terraria.worlds.chooseFilesHint')}
            </span>
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="terraria-import-name">{t('terraria.worlds.worldName')}</Label>
            <Input
              id="terraria-import-name"
              value={name}
              onChange={(e) => { setName(e.target.value); setPreview(null); }}
              placeholder={t('terraria.worlds.namePlaceholder')}
            />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={select} onCheckedChange={(value) => { setSelect(value === true); setPreview(null); }} className="mt-0.5" />
            <span>{t('terraria.worlds.selectAfter')}</span>
          </label>

          {error && <p className="text-xs text-status-error">{error}</p>}
          {preview && <div className="rounded-lg border p-3"><Impact preview={preview} t={t} /></div>}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          {!preview
            ? <Button onClick={runPreview} disabled={busy || !files.length}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('terraria.worlds.previewImpact')}</Button>
            : <Button onClick={apply} disabled={busy || preview.disk?.sufficient === false || !preview.serverOffline}>{t('terraria.worlds.importConfirm')}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Select and delete are both describe-then-confirm, so they share one dialog.
function ActionDialog({ action, world, onClose, serverId, api, t, onStarted }) {
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = action === 'select'
          ? await api(`${API}/select/preview`, { method: 'POST', body: { serverId, file: world.file } })
          : await api(`${API}/${encodeURIComponent(world.file)}/delete/preview`, { method: 'POST', body: { serverId } });
        if (!cancelled) setPreview(r.preview);
      } catch (e) {
        if (!cancelled) { toast.error(e.message); onClose(); }
      }
    })();
    return () => { cancelled = true; };
  }, [action, api, serverId, world.file, onClose]);

  async function apply() {
    setBusy(true);
    try {
      const headers = { 'Idempotency-Key': uuid() };
      const r = action === 'select'
        ? await api(`${API}/select`, { method: 'POST', headers, body: { serverId, token: preview.token } })
        : await api(`${API}/${encodeURIComponent(world.file)}`, { method: 'DELETE', headers, body: { serverId, token: preview.token } });
      onStarted(r.operationId);
      onClose();
    } catch (e) { toast.error(e.message); setBusy(false); }
  }

  const Icon = action === 'delete' ? Trash2 : CheckCircle2;
  const blocked = !preview || preview.disk?.sufficient === false || !preview.serverOffline;

  return (
    <Dialog open onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className={`h-4 w-4 ${action === 'delete' ? 'text-destructive' : 'text-primary'}`} />
            {t(`terraria.worlds.${action}`)} · {world.name}
          </DialogTitle>
          <DialogDescription>{t(`terraria.worlds.${action}Help`)}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {action === 'delete' && (
            <p className="flex items-start gap-2 rounded-md border border-status-warn/40 bg-status-warn/15 p-2 text-xs">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warn" />
              {t('terraria.worlds.deleteWarning', { days: preview?.retentionDays ?? 30 })}
            </p>
          )}
          {action === 'select' && preview?.alreadySelected && (
            <p className="text-xs text-muted-foreground">{t('terraria.worlds.alreadySelected')}</p>
          )}
          {!preview ? <Loading size="sm" className="py-6" /> : <Impact preview={preview} t={t} />}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>{t('common.cancel')}</Button>
          <Button
            variant={action === 'delete' ? 'destructive' : 'default'}
            onClick={apply}
            disabled={busy || blocked}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t(`terraria.worlds.${action}Confirm`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TerrariaWorldsView() {
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
    successKey: 'terraria.worlds.opDone',
    cancelledKey: 'terraria.worlds.opCancelled',
    failedKey: 'terraria.worlds.opFailed',
    clearDelay: 3000,
  });
  const operationStarted = useCallback((operationId) => { follow(operationId); load(); }, [follow, load]);

  // A world download is a plain GET, so it goes through the browser with the
  // token in the query string, the way the other download routes work.
  const download = (world) => {
    window.location.href = `${API}/${encodeURIComponent(world.file)}/download`
      + `?serverId=${encodeURIComponent(activeServerId)}&token=${encodeURIComponent(token)}`;
  };

  async function stopServer() {
    setStopping(true);
    try {
      await api('/api/server/stop', { method: 'POST', body: { serverId: activeServerId } });
      toast.success(t('terraria.worlds.stopping'));
    } catch (e) { toast.error(e.message); }
    setStopping(false);
  }

  if (loading) return <Loading />;
  if (error && !data) return <ErrorState error={error} onRetry={load} />;
  if (!data) return <EmptyState icon={Globe2} title={t('terraria.worlds.noServer')} />;

  const live = activeServerId ? getServerStatus(activeServerId) : null;
  const offline = !live || live.status === 'offline';
  const busy = !!op && ['queued', 'running'].includes(op.state);
  const totalSize = data.worlds.reduce((sum, world) => sum + (world.sizeBytes || 0), 0);
  const latestChange = data.worlds.reduce((latest, world) => Math.max(latest, world.modifiedAt || 0), 0);
  // A selection takes effect at the next start, and the operation says so in its
  // own result rather than the view guessing from what it just did.
  const restartRequired = offline && op?.state === 'succeeded' && op.summary?.restartRequired === true;
  // The running operation names itself through its kind, so the panel heading is
  // the operation's own word for what it is doing.
  const runningAction = String(op?.kind || '').split('.').pop().replace(/^terraria-/, '');
  const lastEvent = events.length ? events[events.length - 1] : null;

  return (
    <div className="space-y-5">
      <PageIntro
        title={t('terraria.worlds.title')}
        description={t('terraria.worlds.subtitle')}
        actions={
          <>
            <Button variant="glass" onClick={() => setDialog({ action: 'import' })} disabled={busy || !offline}>
              <Upload className="h-4 w-4" />{t('terraria.worlds.import')}
            </Button>
            <Button onClick={() => setDialog({ action: 'generate' })} disabled={busy || !offline}>
              <Sparkles className="h-4 w-4" />{t('terraria.worlds.generate')}
            </Button>
          </>
        }
      />

      {/* Every world mutation needs the server stopped, so the notice carries the
          button that gets it there instead of sending the operator elsewhere. */}
      {!offline && (
        <Card className="border-status-warn/40 bg-status-warn/5">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
            <div className="flex items-start gap-2 text-sm">
              <Power className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" />
              <div>
                <p className="font-medium">{t('terraria.worlds.offlineRequired')}</p>
                <p className="text-xs text-muted-foreground">{t('terraria.worlds.offlineRequiredHelp')}</p>
              </div>
            </div>
            <Button variant="destructive" size="sm" onClick={stopServer} disabled={stopping}>
              {stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5 fill-current" />}
              {t('terraria.worlds.stopServer')}
            </Button>
          </CardContent>
        </Card>
      )}

      {restartRequired && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="flex items-start gap-2 py-4 text-sm">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div>
              <p className="font-medium">{t('terraria.worlds.restartRequired')}</p>
              <p className="text-xs text-muted-foreground">{t('terraria.worlds.restartRequiredHelp')}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* The descriptor and serverconfig.txt must agree. When they do not, the
          panel says which is which rather than quietly showing one of them. */}
      {data.selection?.disagrees && (
        <Card className="border-status-error/40 bg-status-error/5">
          <CardContent className="flex items-start gap-2 py-4 text-sm">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-status-error" />
            <div>
              <p className="font-medium">{t('terraria.worlds.disagreement')}</p>
              <p className="text-xs text-muted-foreground">
                {t('terraria.worlds.disagreementHelp', { panel: data.selection.descriptor, config: data.selection.config })}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {busy && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              {t(`terraria.worlds.op.${runningAction}`, {})}
            </CardTitle>
            <Badge variant="outline">{Math.round((op.progress || 0) * 100)}%</Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            <Progress value={Math.round((op.progress || 0) * 100)} />
            <p className="text-xs text-muted-foreground">
              {t(`terraria.worlds.phase.${op.phase}`, {})}
              {lastEvent?.metadata?.stage ? ` · ${lastEvent.metadata.stage}` : ''}
            </p>
          </CardContent>
        </Card>
      )}

      <SummaryGrid className="sm:grid-cols-3 xl:grid-cols-3">
        {[
          { icon: Database, label: t('terraria.worlds.summaryWorlds'), value: data.worlds.length },
          { icon: HardDrive, label: t('terraria.worlds.summaryStorage'), value: fmtBytes(totalSize) },
          { icon: CalendarClock, label: t('terraria.worlds.summaryUpdated'), value: latestChange ? fmtDate(latestChange) : '-' },
        ].map(({ icon, label, value }) => <SummaryItem key={label} icon={icon} label={label} value={value} />)}
      </SummaryGrid>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FileBox className="h-4 w-4" />{t('terraria.worlds.list')}</CardTitle>
          <span className="text-label text-muted-foreground">{data.saveDir}</span>
        </CardHeader>
        <CardContent className="grid gap-3 lg:grid-cols-2">
          {data.worlds.length === 0 && (
            <div className="col-span-full rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              {t('terraria.worlds.empty')}
            </div>
          )}
          {data.worlds.map((world) => (
            <div key={world.file} className="group flex min-h-40 flex-col rounded-xl border bg-background/35 p-4 transition-colors hover:border-primary/30 hover:bg-background/60">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-semibold">{world.name}</span>
                    {world.active && <Badge variant="secondary">{t('terraria.worlds.active')}</Badge>}
                    {world.header?.gameMode && (
                      <Badge variant="outline">{t(`terraria.worlds.difficulty.${world.header.gameMode}`)}</Badge>
                    )}
                    {world.hasModData && (
                      <Badge variant="outline" className="gap-1">
                        <Puzzle className="h-3 w-3" />{t('terraria.worlds.modData')}
                      </Badge>
                    )}
                    {world.hasBackup && <Badge variant="outline">{t('terraria.worlds.hasBackup')}</Badge>}
                  </div>
                  <p className="mt-1 truncate text-label text-muted-foreground">{world.file}</p>
                  {/* Only set when the world calls itself something other than
                      its file name, which is what a rename on disk looks like. */}
                  {world.header?.worldName && (
                    <p className="mt-0.5 truncate text-label text-muted-foreground">
                      {t('terraria.worlds.embeddedName', { name: world.header.worldName })}
                    </p>
                  )}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={t('terraria.worlds.moreActions')}><Ellipsis className="h-4 w-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem disabled={busy || !offline || world.active} onSelect={() => setDialog({ action: 'select', world })}>
                      <CheckCircle2 className="h-4 w-4" />{t('terraria.worlds.select')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => download(world)}>
                      <Download className="h-4 w-4" />{t('terraria.worlds.download')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      disabled={busy || !offline}
                      onSelect={() => setDialog({ action: 'delete', world })}
                    >
                      <Trash2 className="h-4 w-4" />{t('terraria.worlds.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
                <div className="rounded-lg bg-muted/35 p-2">
                  <span className="block text-muted-foreground">{t('terraria.worlds.summaryStorage')}</span>
                  <strong>{fmtBytes(world.sizeBytes)}</strong>
                </div>
                <div className="rounded-lg bg-muted/35 p-2">
                  <span className="block text-muted-foreground">{t('terraria.worlds.format')}</span>
                  <strong>{world.header?.version ?? '-'}</strong>
                  {world.header?.width && world.header?.height && (
                    <span className="block text-label text-muted-foreground">
                      {world.header.width} × {world.header.height}
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-auto flex items-end justify-between gap-3 pt-4">
                <span className="text-label text-muted-foreground">
                  {world.modifiedAt ? t('terraria.worlds.modified', { at: fmtDate(world.modifiedAt) }) : '-'}
                </span>
                {!world.active && (
                  <Button variant="outline" size="sm" disabled={busy || !offline} onClick={() => setDialog({ action: 'select', world })}>
                    <CheckCircle2 className="h-3.5 w-3.5" />{t('terraria.worlds.select')}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* An unreadable file is reported with its reason, never hidden and never
          tidied away: it is far more likely to be a world from a newer Terraria
          than a stray file. */}
      {data.unreadable.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><FileWarning className="h-4 w-4" />{t('terraria.worlds.unreadable')}</CardTitle>
            <span className="text-xs text-muted-foreground">{t('terraria.worlds.unreadableHelp')}</span>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.unreadable.map((entry) => (
              <div key={entry.file} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-xs">{entry.file}</span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {entry.sizeBytes != null && fmtBytes(entry.sizeBytes)}
                  <Badge variant="destructive">{t(`terraria.worlds.reason.${entry.reason}`, {})}</Badge>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {data.operations.length > 0 && (
        <Card>
          <CardHeader><CardTitle>{t('terraria.worlds.history')}</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {data.operations.slice(0, 10).map((entry) => (
              <div key={entry.operationId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  {t(`terraria.worlds.op.${entry.action.replace(/^terraria-/, '')}`, {})}
                  {entry.worldId ? ` · ${entry.worldId}` : ''}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {fmtDate(entry.queuedAt)}
                  <Badge variant={entry.state === 'succeeded' ? 'secondary' : entry.state === 'running' ? 'outline' : 'destructive'}>
                    {t(`terraria.worlds.state.${entry.state}`)}
                  </Badge>
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <GenerateDialog
        open={dialog?.action === 'generate'}
        onClose={() => setDialog(null)}
        serverId={activeServerId}
        api={api}
        t={t}
        onStarted={operationStarted}
        sizes={data.sizes || ['small', 'medium', 'large']}
        difficulties={data.difficulties || ['classic', 'expert', 'master', 'journey']}
      />
      <ImportDialog
        open={dialog?.action === 'import'}
        onClose={() => setDialog(null)}
        serverId={activeServerId}
        api={api}
        t={t}
        onStarted={operationStarted}
      />
      {(dialog?.action === 'select' || dialog?.action === 'delete') && (
        <ActionDialog
          action={dialog.action}
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
