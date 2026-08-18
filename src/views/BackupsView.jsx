import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { ViewHeader } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorState } from '@/components/shared/ErrorState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Loading } from '@/components/shared/Loading';
import { useApi } from '@/hooks/useApi';
import { useT } from '@/context/I18nContext';
import { fmtBytes } from '@/lib/utils';
import { toast } from 'sonner';
import { Download, Trash2, Plus, ShieldCheck, RotateCcw, ListTree, Archive, AlertTriangle } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';

function RetentionCard({ onSaved }) {
  const api = useApi();
  const t = useT();
  const [form, setForm] = useState({ maxCount: 10, maxSizeMB: 0 });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api('/api/config');
        if (cancelled) return;
        setForm({
          maxCount: Number(cfg?.backups?.maxCount ?? cfg?.backups?.retainCount ?? 10) || 0,
          maxSizeMB: Number(cfg?.backups?.maxSizeMB ?? 0) || 0,
        });
      } catch { /* ignore - defaults stay in place */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const f = (k) => (e) => {
    const n = Math.max(0, Math.floor(Number(e.target.value) || 0));
    setForm((p) => ({ ...p, [k]: n }));
  };

  async function save() {
    setLoading(true);
    try {
      await api('/api/config/backups', { method: 'PUT', body: form });
      toast.success(t('backups.savedToast'));
      onSaved?.();
    } catch (e) { toast.error(e.message); }
    finally { setLoading(false); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('backups.retentionTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-4">{t('backups.retentionHint')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>{t('backups.maxCount')}</Label>
            <Input type="number" min="0" step="1" value={form.maxCount} onChange={f('maxCount')} />
            <p className="text-label text-muted-foreground/80">{t('backups.maxCountHint')}</p>
          </div>
          <div className="space-y-1.5">
            <Label>{t('backups.maxSizeMB')}</Label>
            <Input type="number" min="0" step="1" value={form.maxSizeMB} onChange={f('maxSizeMB')} />
            <p className="text-label text-muted-foreground/80">{t('backups.maxSizeMBHint')}</p>
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="default" size="sm" onClick={save} disabled={loading}>
            {loading ? t('common.loading') : t('common.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function BackupsView() {
  const api = useApi();
  const t = useT();
  const { token } = useAuth();
  const [backups, setBackups] = useState([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);
  const [contents, setContents] = useState(null);
  const [impact, setImpact] = useState(null);
  const [action, setAction] = useState('');
  const [options, setOptions] = useState({ terraria: false, variant: null, includeMods: false, modsSizeBytes: 0 });
  const [offline, setOffline] = useState(false);

  async function load() {
    setListLoading(true);
    setListError('');
    try {
      const { backups: b, options: nextOptions } = await api('/api/backups');
      setBackups(b);
      if (nextOptions) setOptions(nextOptions);
    } catch (e) { setListError(e.message); }
    setListLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function backupNow() {
    setLoading(true);
    setStatus(t('backups.creatingStatus'));
    try {
      const r = await api('/api/backups', { method: 'POST', body: { includeMods: options.includeMods, offline } });
      setStatus(t('backups.doneStatus', { name: r.name, size: fmtBytes(r.size) }));
      toast.success(t('backups.createdToast'));
      load();
    } catch (e) {
      setStatus('');
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function setIncludeMods(value) {
    const includeMods = value === true;
    setOptions((current) => ({ ...current, includeMods }));
    try {
      await api('/api/backups/options', { method: 'PUT', body: { includeMods } });
    } catch (e) {
      setOptions((current) => ({ ...current, includeMods: !includeMods }));
      toast.error(e.message);
    }
  }

  async function deleteBackup(name) {
    try {
      await api(`/api/backups/${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast.success(t('backups.deletedToast'));
      load();
    } catch (e) { toast.error(e.message); }
  }

  async function showContents(name) {
    try { setAction(name); const r = await api(`/api/backups/${encodeURIComponent(name)}/contents`); setContents(r.manifest); }
    catch (e) { toast.error(e.message); } finally { setAction(''); }
  }

  async function verify(name) {
    try { setAction(name); await api(`/api/backups/${encodeURIComponent(name)}/verify`, { method: 'POST' }); toast.success(t('backups.verifiedToast')); await load(); }
    catch (e) { toast.error(e.message); } finally { setAction(''); }
  }

  async function previewRestore(name) {
    try { setAction(name); await api(`/api/backups/${encodeURIComponent(name)}/verify`, { method: 'POST' }); const r = await api(`/api/backups/${encodeURIComponent(name)}/impact`, { method: 'POST' }); setImpact({ name, ...r.impact }); await load(); }
    catch (e) { toast.error(e.message); } finally { setAction(''); }
  }

  async function restore() {
    try { setAction(impact.name); const key = crypto.randomUUID(); const r = await api(`/api/backups/${encodeURIComponent(impact.name)}/restore`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: { token: impact.token } }); toast.success(t('backups.restoreQueued', { id: r.operationId })); setImpact(null); }
    catch (e) { toast.error(e.message); } finally { setAction(''); }
  }

  const hint = (() => {
    const h = t('backups.hint');
    const tag = 'save-off/save-all';
    const i = h.indexOf(tag);
    if (i < 0) return h;
    return <>{h.slice(0, i)}<code className="rounded bg-muted px-1 py-0.5 text-xs">{tag}</code>{h.slice(i + tag.length)}</>;
  })();

  return (
    <div className="space-y-6">
      <ViewHeader
        title={t('backups.title')}
        description={hint}
        actions={
          <Button variant="default" size="sm" onClick={backupNow} disabled={loading}>
            <Plus className="h-3.5 w-3.5" />
            {loading ? t('backups.creating') : t('backups.backupNow')}
          </Button>
        }
      />
      {options.terraria && (
        <Card>
          <CardContent className="grid gap-4 py-4 sm:grid-cols-2">
            {options.variant === 'tmodloader' && (
              <label className="flex min-w-0 cursor-pointer items-start gap-3">
                <Checkbox className="mt-0.5" checked={options.includeMods} onCheckedChange={setIncludeMods} />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{t('terraria.backups.includeMods')}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t('terraria.backups.includeModsHint', { size: fmtBytes(options.modsSizeBytes) })}
                  </span>
                </span>
              </label>
            )}
            <label className="flex min-w-0 cursor-pointer items-start gap-3">
              <Checkbox className="mt-0.5" checked={offline} onCheckedChange={(value) => setOffline(value === true)} />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{t('terraria.backups.offline')}</span>
                <span className="block text-xs text-muted-foreground">{t('terraria.backups.offlineHint')}</span>
              </span>
            </label>
            {!offline && (
              <p className="text-xs text-muted-foreground sm:col-span-2">{t('terraria.backups.onlineHint')}</p>
            )}
          </CardContent>
        </Card>
      )}
      {status && <p className="text-xs text-primary">{status}</p>}
      {listLoading ? (
        <Loading />
      ) : listError ? (
        <ErrorState error={listError} onRetry={load} />
      ) : backups.length === 0 ? (
        <Card><CardContent className="py-4"><EmptyState icon={Archive} title={t('backups.title')} message={t('backups.empty')} /></CardContent></Card>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5">{t('backups.title')}</TableHead>
                <TableHead className="text-right">{t('common.size')}</TableHead>
                <TableHead>{t('backups.retentionTitle')}</TableHead>
                <TableHead className="pr-5 text-right">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backups.map(b => (
                <TableRow key={b.name}>
                  <TableCell className="pl-5">
                    <div className="flex items-center gap-2.5">
                      <Archive className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="truncate font-medium text-foreground">{b.name}</div>
                        <div className="text-label text-muted-foreground">{new Date(b.mtime).toLocaleString()}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtBytes(b.size)}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={b.verification?.status === 'verified' ? 'softSuccess' : 'default'}>{t(`backups.${b.verification?.status === 'verified' ? 'verified' : 'unverified'}`)}</Badge>
                      {b.manifest?.metadata?.game === 'terraria' && <>
                        <Badge>{b.manifest.metadata.variant}</Badge>
                        <Badge>{b.manifest.metadata.exact ? t('terraria.backups.exact') : t('terraria.backups.online')}</Badge>
                        {b.manifest.metadata.partial && <Badge variant="softWarning"><AlertTriangle className="mr-1 h-3 w-3" />{t('terraria.backups.partial')}</Badge>}
                      </>}
                      {b.manifest?.worldRoots?.length > 0 && <Badge>{t('backups.worldCount', { count: b.manifest.worldRoots.length })}</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="pr-5">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="icon-xs" title={t('backups.contents')} onClick={() => showContents(b.name)} disabled={action === b.name}><ListTree className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon-xs" title={t('backups.verify')} onClick={() => verify(b.name)} disabled={action === b.name}><ShieldCheck className="h-3.5 w-3.5" /></Button>
                      <Button variant="ghost" size="icon-xs" title={t('backups.restore')} onClick={() => previewRestore(b.name)} disabled={action === b.name}><RotateCcw className="h-3.5 w-3.5" /></Button>
                      <Button variant="glass" size="icon-xs" asChild title={t('common.download')}>
                        <a href={`/api/backups/${encodeURIComponent(b.name)}/download?token=${encodeURIComponent(token)}`} download>
                          <Download className="h-3.5 w-3.5" />
                        </a>
                      </Button>
                      <Button variant="ghost" size="icon-xs" onClick={() => setPendingDelete(b.name)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <RetentionCard onSaved={load} />
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => { if (!o) setPendingDelete(null); }}
        title={t('backups.deleteTitle')}
        description={pendingDelete ? t('backups.deleteBody', { name: pendingDelete, cannotUndo: t('common.cannotUndo') }) : ''}
        confirmLabel={t('common.delete')}
        destructive
        onConfirm={() => { deleteBackup(pendingDelete); setPendingDelete(null); }}
      />
      <Dialog open={!!contents} onOpenChange={(o) => { if (!o) setContents(null); }}>
        <DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>{t('backups.contents')}</DialogTitle></DialogHeader><DialogBody>
          {contents && <><div className="mb-3 text-xs text-muted-foreground">{fmtBytes(contents.sizeBytes)} · SHA-256 <code>{contents.sha256}</code> · {t('backups.fileCount', { count: contents.inventory.length })}</div>
            {contents.metadata?.game === 'terraria' && <div className="mb-3 grid gap-1 border border-border p-3 text-xs sm:grid-cols-2">
              <div>{t('terraria.backups.variant')}: <span>{contents.metadata.variant}</span></div>
              <div>{t('terraria.backups.version')}: <span className="tabular-nums">{contents.metadata.version?.game || '—'}</span></div>
              <div>{t('terraria.backups.world')}: <span>{contents.metadata.world?.file || '—'}</span></div>
              <div>{t('terraria.backups.saveStatus')}: {contents.metadata.saveConfirmed ? t('terraria.backups.confirmed') : t('terraria.backups.notConfirmed')}</div>
            </div>}
            <div className="max-h-80 overflow-auto rounded border p-2 text-xs">{contents.inventory.map((e) => <div key={e.path} className="flex justify-between gap-4"><span className="truncate">{e.path}</span><span>{fmtBytes(e.size)}</span></div>)}</div></>}
        </DialogBody></DialogContent>
      </Dialog>
      <Dialog open={!!impact} onOpenChange={(o) => { if (!o) setImpact(null); }}>
        <DialogContent><DialogHeader><DialogTitle>{t('backups.restorePreview')}</DialogTitle></DialogHeader><DialogBody className="space-y-3">
          {impact && <><p className="text-sm">{t('backups.restoreWarning')}</p><div className="rounded border p-3 text-xs space-y-1"><div>{t('backups.replacements')}: {impact.replacements.map((x) => x.root).join(', ')}</div><div>{t('backups.preserved')}: {impact.preserved.join(', ') || '—'}</div><div>{t('backups.diskRequired')}: {fmtBytes(impact.requiredBytes)}</div><div>{t('backups.rollbackAvailable')}</div></div></>}
        </DialogBody><DialogFooter><Button variant="ghost" onClick={() => setImpact(null)}>{t('common.cancel')}</Button><Button onClick={restore} disabled={!!action}>{t('backups.confirmRestore')}</Button></DialogFooter></DialogContent>
      </Dialog>
    </div>
  );
}
