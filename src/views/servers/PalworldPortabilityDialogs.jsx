import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { FolderOpen, Upload } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { useApi } from '@/hooks/useApi';
import { useT } from '@/context/I18nContext';
import { fmtBytes } from '@/lib/utils';
import { FolderBrowserModal } from './FolderBrowserModal';

/*
 * Adoption: inspect first, register second. The inspection panel is the whole
 * point - the operator sees the detected install and the exact REST settings
 * Hostkind would reconcile before anything is written.
 */
export function PalworldAdoptDialog({ open, onOpenChange, onAdopted }) {
  const api = useApi();
  const t = useT();
  const [dir, setDir] = useState('');
  const [name, setName] = useState('');
  const [inspection, setInspection] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fsOpen, setFsOpen] = useState(false);

  async function inspect(target = dir) {
    setBusy(true);
    try {
      const result = await api('/api/portability/palworld/adopt/preview', { method: 'POST', body: { dir: target }, serverScoped: false });
      setInspection(result);
      if (result.ok && !name) setName(String(target).split(/[\\/]/).filter(Boolean).pop() || '');
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  async function adopt() {
    setBusy(true);
    try {
      const result = await api('/api/portability/palworld/adopt', { method: 'POST', body: { dir, name }, serverScoped: false });
      toast.success(t('portability.adoptDone', { name: result.server.name }));
      onAdopted?.();
      onOpenChange(false);
      setDir(''); setName(''); setInspection(null);
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>{t('portability.adoptTitle')}</DialogTitle></DialogHeader>
          <DialogBody className="space-y-4">
            <p className="text-xs text-muted-foreground">{t('portability.adoptIntro')}</p>
            <div className="space-y-1.5">
              <Label>{t('portability.folder')}</Label>
              <div className="flex gap-2">
                <Input value={dir} onChange={(e) => { setDir(e.target.value); setInspection(null); }} placeholder="/srv/palworld" />
                <Button variant="glass" className="h-11 shrink-0" onClick={() => setFsOpen(true)}><FolderOpen className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
            <Button variant="glass" size="sm" disabled={busy || !dir} onClick={() => inspect()}>{t('portability.inspect')}</Button>

            {inspection && !inspection.ok && (
              <Alert variant="error">{inspection.blocked?.message}{inspection.blocked?.conflict ? ` (${inspection.blocked.conflict})` : ''}</Alert>
            )}

            {inspection?.ok && (
              <div className="space-y-3">
                <dl className="grid grid-cols-2 gap-2 text-xs">
                  <div><dt className="text-muted-foreground">{t('portability.executable')}</dt><dd>{inspection.executable?.relative || t('common.dashPlaceholder')}</dd></div>
                  <div><dt className="text-muted-foreground">{t('portability.targetPlatform')}</dt><dd>{inspection.targetPlatform}</dd></div>
                  <div><dt className="text-muted-foreground">{t('portability.gamePort')}</dt><dd className="tabular-nums">{inspection.ports.publicPort || t('common.dashPlaceholder')}</dd></div>
                  <div><dt className="text-muted-foreground">{t('portability.restPort')}</dt><dd className="tabular-nums">{inspection.ports.proposedRestPort || t('common.dashPlaceholder')}</dd></div>
                  <div><dt className="text-muted-foreground">{t('portability.build')}</dt><dd className="tabular-nums">{inspection.build?.buildId || t('common.dashPlaceholder')}</dd></div>
                  <div><dt className="text-muted-foreground">{t('portability.saves')}</dt><dd>{inspection.saves.length}</dd></div>
                </dl>

                <div>
                  <Label>{t('portability.reconcile')}</Label>
                  <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                    {inspection.reconcile.map((item) => (
                      <li key={item.key}>
                        <span className="text-foreground">{item.key}</span>: {String(item.current)} → {String(item.next)} — {item.why}
                      </li>
                    ))}
                  </ul>
                </div>

                <Alert variant="info">{t('portability.adoptPreserves', { list: inspection.preserves.join(', ') })}</Alert>
                {inspection.issues.map((issue) => <Alert key={issue} variant="warn">{issue}</Alert>)}

                <div className="space-y-1.5">
                  <Label>{t('portability.name')}</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </div>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="glass" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button disabled={busy || !inspection?.ok || !inspection?.executable || !name} onClick={adopt}>{t('portability.adopt')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <FolderBrowserModal open={fsOpen} onOpenChange={setFsOpen} initial={dir} onSelect={(picked) => { setDir(picked); setInspection(null); inspect(picked); }} />
    </>
  );
}

/*
 * Profile import: scan and preview, then rename/reassign ports, then create.
 * The dialog states plainly that the archive carries no password and no server
 * binaries, because both are follow-up work for the operator.
 */
export function PalworldImportDialog({ open, onOpenChange, onImported }) {
  const api = useApi();
  const t = useT();
  const fileRef = useRef(null);
  const [preview, setPreview] = useState(null);
  const [form, setForm] = useState({ name: '', dir: '', port: '', restPort: '' });
  const [busy, setBusy] = useState(false);
  const [fsOpen, setFsOpen] = useState(false);

  async function choose(file) {
    if (!file) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append('profile', file);
      const result = await api('/api/portability/palworld/import/preview', { method: 'POST', body, serverScoped: false });
      setPreview(result);
      setForm({
        name: result.suggestedName || '',
        dir: '',
        port: result.suggestedPorts.game ? String(result.suggestedPorts.game) : '',
        restPort: result.suggestedPorts.rest ? String(result.suggestedPorts.rest) : '',
      });
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  async function confirm() {
    setBusy(true);
    try {
      const result = await api('/api/portability/palworld/import', {
        method: 'POST',
        serverScoped: false,
        body: { token: preview.token, name: form.name, dir: form.dir, port: Number(form.port), restPort: Number(form.restPort) },
      });
      toast.success(t('portability.importDone', { name: result.server.name }));
      onImported?.();
      onOpenChange(false);
      setPreview(null);
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>{t('portability.importTitle')}</DialogTitle></DialogHeader>
          <DialogBody className="space-y-4">
            <p className="text-xs text-muted-foreground">{t('portability.importIntro')}</p>
            <input ref={fileRef} className="hidden" type="file" accept=".zip" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} />
            <Button variant="glass" size="sm" disabled={busy} onClick={() => fileRef.current?.click()}>
              <Upload className="h-3.5 w-3.5" />{t('portability.chooseProfile')}
            </Button>

            {preview && (
              <div className="space-y-3">
                <dl className="grid grid-cols-2 gap-2 text-xs">
                  <div><dt className="text-muted-foreground">{t('portability.selection')}</dt><dd>{t(`portability.selection${preview.manifest.selection.charAt(0).toUpperCase()}${preview.manifest.selection.slice(1)}`)}</dd></div>
                  <div><dt className="text-muted-foreground">{t('portability.created')}</dt><dd>{new Date(preview.manifest.createdAt).toLocaleString()}</dd></div>
                  <div><dt className="text-muted-foreground">{t('portability.files')}</dt><dd>{preview.totals.files}</dd></div>
                  <div><dt className="text-muted-foreground">{t('portability.diskNeeded')}</dt><dd>{fmtBytes(preview.requiredBytes)}</dd></div>
                </dl>

                {preview.collisions.map((item) => (
                  <Alert key={`${item.kind}-${item.value}`} variant="warn">
                    {t(`portability.collision.${item.kind}`, { value: item.value, server: item.server || '' })}
                  </Alert>
                ))}
                <Alert variant="info">{preview.nextSteps.join(' ')}</Alert>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label>{t('portability.name')}</Label>
                    <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label>{t('portability.destination')}</Label>
                    <div className="flex gap-2">
                      <Input value={form.dir} onChange={(e) => setForm({ ...form, dir: e.target.value })} placeholder="/srv/palworld-imported" />
                      <Button variant="glass" className="h-11 shrink-0" onClick={() => setFsOpen(true)}><FolderOpen className="h-3.5 w-3.5" /></Button>
                    </div>
                    <p className="text-label text-muted-foreground">{t('portability.destinationNote')}</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('portability.gamePort')}</Label>
                    <Input value={form.port} inputMode="numeric" onChange={(e) => setForm({ ...form, port: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('portability.restPort')}</Label>
                    <Input value={form.restPort} inputMode="numeric" onChange={(e) => setForm({ ...form, restPort: e.target.value })} />
                  </div>
                </div>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="glass" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button disabled={busy || !preview || !form.name || !form.dir} onClick={confirm}>{t('portability.import')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <FolderBrowserModal open={fsOpen} onOpenChange={setFsOpen} initial={form.dir} onSelect={(picked) => setForm((value) => ({ ...value, dir: picked }))} />
    </>
  );
}
