import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useApi } from '@/hooks/useApi';
import { useFolderPicker } from '@/hooks/useFolderPicker';
import { useT } from '@/context/I18nContext';
import { osExamplePath } from '@/lib/utils';
import { toast } from 'sonner';
import { FolderOpen, Plus, Download, Upload, Copy } from 'lucide-react';
import { FolderBrowserModal } from './FolderBrowserModal';

// Server templates, and cloning a server without its worlds. Opened from the
// server list, and from a server's Settings -> General with that server as
// the source.
const TERMINAL_OPERATION_STATES = ['succeeded', 'failed', 'cancelled', 'recovery_required'];

async function waitForOperation(api, operationId, { intervalMs = 1500 } = {}) {
  for (;;) {
    const { operation } = await api(`/api/operations/${operationId}`);
    if (TERMINAL_OPERATION_STATES.includes(operation.state)) return operation;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

export function TemplateModal({ open, onOpenChange, servers, initialSource, onCreated }) {
  const api = useApi();
  const t = useT();
  const { picking, pick } = useFolderPicker(api);
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [sourceId, setSourceId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fsOpen, setFsOpen] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const source = initialSource || servers[0];
    setSourceId(source?.id || '');
    setName(source ? `${source.name} template` : '');
    setPreview(null);
    load();
  }, [open, initialSource]);

  async function load() {
    try { const data = await api('/api/templates'); setItems(data.templates || []); }
    catch (e) { toast.error(e.message); }
  }
  async function inspect(item) {
    try { const data = await api(`/api/templates/${item.id}/preview`); setSelected(data); setPreview(data.manifest); setName(item.name); setDescription(item.description || ''); }
    catch (e) { toast.error(e.message); }
  }
  async function previewSource() {
    if (!sourceId) return;
    try { setBusy(true); const data = await api('/api/templates/preview', { method: 'POST', body: { serverId: sourceId, name, description } }); setPreview(data.manifest); setSelected(null); }
    catch (e) { toast.error(e.message); } finally { setBusy(false); }
  }
  async function saveTemplate() {
    try { setBusy(true); await api('/api/templates', { method: 'POST', body: { serverId: sourceId, name, description, templateId: selected?.template?.id || undefined } }); toast.success(t('servers.templateSaved')); setPreview(null); setSelected(null); await load(); }
    catch (e) { toast.error(e.message); } finally { setBusy(false); }
  }
  // Instantiate and clone are durable operations: the backend answers 202 with
  // an operation id and does the work (download, staging, promotion) behind it.
  async function runOperation(path, body, successKey) {
    setBusy(true);
    const toastId = toast.loading(t('servers.templateWorking'));
    try {
      const started = await api(path, { method: 'POST', body, headers: { 'Idempotency-Key': crypto.randomUUID() } });
      const op = await waitForOperation(api, started.operationId);
      if (op.state === 'succeeded') {
        toast.success(t(successKey), { id: toastId });
        onCreated?.();
        onOpenChange(false);
      } else if (op.state === 'recovery_required') {
        toast.error(t('servers.templateRecovery'), { id: toastId });
      } else {
        toast.error(op.error?.text || t('servers.templateFailed'), { id: toastId });
      }
    } catch (e) {
      toast.error(e.message, { id: toastId });
    } finally {
      setBusy(false);
    }
  }
  async function instantiate() {
    if (!selected?.template?.id) return;
    await runOperation(`/api/templates/${selected.template.id}/instantiate`, { name, parentDir }, 'servers.templateInstantiated');
  }
  async function cloneSource() {
    if (!sourceId) return;
    await runOperation(`/api/servers/${sourceId}/clone`, { name, parentDir }, 'servers.cloneCreated');
  }
  async function removeTemplate() {
    if (!selected?.template?.id) return;
    try { await api(`/api/templates/${selected.template.id}`, { method: 'DELETE' }); setSelected(null); setPreview(null); await load(); toast.success(t('servers.templateDeleted')); }
    catch (e) { toast.error(e.message); }
  }
  async function exportTemplate() {
    const item = selected?.template;
    if (!item) return;
    try {
      // Blob through the shared client: same bearer header as the manual fetch
      // it replaces, and no server header (the export is addressed by template
      // id, not by the active server).
      const blob = await api(`/api/templates/${item.id}/export`, { responseType: 'blob', serverScoped: false });
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `${item.name}-v${item.version}-template.zip`; anchor.click(); URL.revokeObjectURL(url);
    } catch (e) { toast.error(e.message); }
  }
  async function importFile(event) {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      setBusy(true); const body = new FormData(); body.append('file', file);
      const data = await api('/api/templates/import/preview', { method: 'POST', body });
      setPreview(data.manifest); setName(data.name || ''); setDescription(data.description || ''); setSelected({ importToken: data.token });
    } catch (e) { toast.error(e.message); } finally { setBusy(false); event.target.value = ''; }
  }
  async function confirmImport() {
    try { setBusy(true); await api('/api/templates/import', { method: 'POST', body: { token: selected.importToken, name, description } }); toast.success(t('servers.templateImported')); setSelected(null); setPreview(null); await load(); }
    catch (e) { toast.error(e.message); } finally { setBusy(false); }
  }
  async function pickFolder() {
    try {
      const picked = await pick(parentDir);
      if (picked) setParentDir(picked);
    } catch {
      setFsOpen(true);
    }
  }

  return <>
    <Dialog open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value); }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader><DialogTitle>{t('servers.templatesTitle')}</DialogTitle></DialogHeader>
        <div className="grid gap-4 px-5 py-4 md:grid-cols-[240px_1fr]">
          <div className="space-y-2">
            <div className="flex gap-2">
              <Button size="sm" variant="glass" className="flex-1" onClick={() => { setSelected(null); setPreview(null); }}><Plus className="h-3.5 w-3.5" />{t('servers.newTemplate')}</Button>
              <Button size="icon-sm" variant="glass" title={t('servers.importTemplate')} onClick={() => fileRef.current?.click()}><Upload className="h-3.5 w-3.5" /></Button>
              <input ref={fileRef} className="hidden" type="file" accept=".zip" onChange={importFile} />
            </div>
            <div className="max-h-72 overflow-y-auto rounded-md border border-border">
              {items.length === 0 && <p className="p-3 text-xs text-muted-foreground">{t('servers.noTemplates')}</p>}
              {items.map(item => <button key={item.id} onClick={() => inspect(item)} className="block w-full border-b border-border px-3 py-2 text-left last:border-0 hover:bg-secondary">
                <span className="block truncate text-sm font-medium">{item.name}</span><span className="text-label text-muted-foreground">v{item.latest_version}</span>
              </button>)}
            </div>
          </div>
          <div className="space-y-3">
            {!selected?.template && !selected?.importToken && <div className="space-y-1.5"><Label>{t('servers.templateSource')}</Label><select className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={sourceId} onChange={e => { setSourceId(e.target.value); setPreview(null); }}>{servers.map(server => <option key={server.id} value={server.id}>{server.name}</option>)}</select></div>}
            <div className="grid grid-cols-2 gap-3"><div className="space-y-1.5"><Label>{t('servers.fieldName')}</Label><Input value={name} onChange={e => setName(e.target.value)} /></div><div className="space-y-1.5"><Label>{t('servers.templateDescription')}</Label><Input value={description} onChange={e => setDescription(e.target.value)} /></div></div>
            {!selected?.importToken && <div className="space-y-1.5"><Label>{t('servers.fieldParent')}</Label><div className="flex gap-2"><Input value={parentDir} onChange={e => setParentDir(e.target.value)} placeholder={t('servers.parentPlaceholder', { path: osExamplePath('parent') })} /><Button variant="glass" disabled={busy || picking} className="h-11 shrink-0" onClick={pickFolder}><FolderOpen className="h-3.5 w-3.5" /></Button></div></div>}
            {preview && <div className="max-h-64 overflow-y-auto rounded-md border border-border bg-background/40">
              {(preview.entries || []).map(entry => <div key={entry.path} className="flex gap-3 border-b border-border/60 px-3 py-2 text-xs last:border-0"><Badge variant={entry.action === 'excluded' ? 'destructive' : entry.action === 'transformed' ? 'softWarn' : 'default'} className="h-fit">{entry.action}</Badge><div className="min-w-0"><p className="truncate text-foreground">{entry.path}</p><p className="text-muted-foreground">{entry.reason}</p></div></div>)}
            </div>}
            {selected?.versions?.length > 0 && <p className="text-xs text-muted-foreground">{t('servers.templateVersions')}: {selected.versions.map(version => `v${version.version}`).join(', ')}</p>}
          </div>
        </div>
        <DialogFooter>
          {selected?.template && <><Button variant="destructive" onClick={removeTemplate}>{t('common.delete')}</Button><Button variant="glass" onClick={exportTemplate}><Download className="h-3.5 w-3.5" />{t('servers.exportTemplate')}</Button><Button onClick={instantiate} disabled={busy || !parentDir || !name}>{t('servers.createFromTemplate')}</Button></>}
          {selected?.importToken && <Button onClick={confirmImport} disabled={busy}>{t('servers.confirmImport')}</Button>}
          {!selected && <><Button variant="glass" onClick={previewSource} disabled={busy || !sourceId}>{t('servers.previewTemplate')}</Button>{preview && <><Button variant="glass" onClick={cloneSource} disabled={busy || !parentDir}><Copy className="h-3.5 w-3.5" />{t('servers.cloneWithoutWorlds')}</Button><Button onClick={saveTemplate} disabled={busy || !name}>{t('servers.saveTemplate')}</Button></>}</>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <FolderBrowserModal open={fsOpen} onOpenChange={setFsOpen} initial={parentDir} onSelect={setParentDir} />
  </>;
}
