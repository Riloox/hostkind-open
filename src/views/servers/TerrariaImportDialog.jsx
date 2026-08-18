import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, FolderInput, FolderOpen, Search } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/context/I18nContext';
import { useApi } from '@/hooks/useApi';
import { useFolderPicker } from '@/hooks/useFolderPicker';
import { FolderBrowserModal } from './FolderBrowserModal';

export function TerrariaImportDialog({ open, onOpenChange, onImported }) {
  const api = useApi();
  const t = useT();
  const { picking, pick } = useFolderPicker(api);
  const [dir, setDir] = useState('');
  const [name, setName] = useState('');
  const [preview, setPreview] = useState(null);
  const [variant, setVariant] = useState('');
  const [fixes, setFixes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [fsOpen, setFsOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setVariant('');
    setFixes([]);
  }, [open]);

  function chooseDir(value) {
    setDir(value);
    setName((current) => current || value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '');
    setPreview(null);
  }

  async function browse() {
    try {
      const picked = await pick(dir, t('terraria.import.pickFolder'));
      if (picked) chooseDir(picked);
    } catch {
      setFsOpen(true);
    }
  }

  async function inspect(selectedVariant = variant) {
    try {
      setBusy(true);
      const result = await api('/api/terraria/import/preview', {
        method: 'POST',
        body: { dir, variant: selectedVariant || undefined },
      });
      setPreview(result);
      setVariant(result.inspection.variant.value || selectedVariant || '');
      setFixes([]);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function changeVariant(value) {
    setVariant(value);
    await inspect(value);
  }

  async function adopt() {
    try {
      setBusy(true);
      const result = await api('/api/terraria/import', {
        method: 'POST',
        body: { token: preview.token, name, variant, fixes },
      });
      toast.success(t('terraria.import.success'));
      onImported?.(result.server, result.issues || []);
      onOpenChange(false);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  const inspection = preview?.inspection;
  const rows = inspection ? [
    [t('terraria.import.variant'), variant ? t(`terraria.variant.${variant}`) : t('terraria.import.chooseVariant')],
    [t('terraria.import.version'), inspection.version.value || t('terraria.import.unknown')],
    [t('terraria.import.port'), inspection.port.value],
    [t('terraria.import.saveDir'), inspection.saveDir.value],
    [t('terraria.import.worlds'), inspection.worlds.length],
    [t('terraria.import.mods'), inspection.mods.length],
    [t('terraria.import.launch'), inspection.launchPlan?.executable || '—'],
  ] : [];

  return <>
    <Dialog open={open} onOpenChange={(value) => { if (!busy) onOpenChange(value); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>{t('terraria.import.title')}</DialogTitle></DialogHeader>
        <div className="space-y-5 px-5 py-4">
          <p className="max-w-2xl text-sm text-muted-foreground">{t('terraria.import.intro')}</p>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="space-y-1.5">
              <Label htmlFor="terraria-import-folder">{t('terraria.import.folder')}</Label>
              <Input id="terraria-import-folder" value={dir} onChange={(event) => chooseDir(event.target.value)} />
            </div>
            <Button className="self-end h-11" variant="glass" onClick={browse} disabled={busy || picking}>
              <FolderOpen className="h-4 w-4" />{t('servers.browse')}
            </Button>
          </div>
          {!inspection && <Button onClick={() => inspect()} disabled={!dir || busy}><Search className="h-4 w-4" />{t('terraria.import.inspect')}</Button>}

          {inspection && <>
            <div className="grid border border-border sm:grid-cols-2">
              {rows.map(([label, value]) => <div key={label} className="border-b border-border px-4 py-3 last:border-b-0 sm:odd:border-r">
                <span className="block text-label font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
                <span className="mt-1 block text-sm text-foreground">{value}</span>
              </div>)}
            </div>

            {inspection.variant.choices.length > 1 && <div className="space-y-1.5">
              <Label htmlFor="terraria-import-variant">{t('terraria.import.chooseVariant')}</Label>
              <select id="terraria-import-variant" value={variant} onChange={(event) => changeVariant(event.target.value)} className="flex h-11 w-full border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50">
                <option value="">{t('terraria.import.chooseVariant')}</option>
                {inspection.variant.choices.map((choice) => <option key={choice} value={choice}>{t(`terraria.variant.${choice}`)}</option>)}
              </select>
            </div>}

            <div>
              <h3 className="font-display text-sm font-extrabold uppercase">{t('terraria.import.evidence')}</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {inspection.variant.evidence.map((item) => <Badge key={`${item.variant}-${item.source}`} variant="outline">{t(`terraria.variant.${item.variant}`)} · <span>{item.source}</span></Badge>)}
              </div>
            </div>

            {inspection.issues.map((issue) => <Alert key={issue.code} variant={issue.severity === 'error' ? 'error' : 'warning'}>
              <AlertTriangle className="h-4 w-4" /><div><strong>{t(`terraria.import.issue.${issue.code}`)}</strong><p>{issue.detail}</p></div>
            </Alert>)}

            {preview.optionalFixes.length > 0 && <div>
              <h3 className="font-display text-sm font-extrabold uppercase">{t('terraria.import.optionalFixes')}</h3>
              <div className="mt-2 divide-y divide-border border border-border">
                {preview.optionalFixes.map((fix) => <label key={fix.id} className="flex cursor-pointer items-start gap-3 p-3">
                  <Checkbox checked={fixes.includes(fix.id)} onCheckedChange={(checked) => setFixes((current) => checked ? [...current, fix.id] : current.filter((item) => item !== fix.id))} />
                  <span><strong className="block text-sm">{t(`terraria.import.fix.${fix.id}`)}</strong><span className="text-xs text-muted-foreground">{fix.detail}</span></span>
                </label>)}
              </div>
            </div>}

            <Alert variant="info"><CheckCircle2 className="h-4 w-4" />{t('terraria.import.untouched')}</Alert>
            <div className="space-y-1.5"><Label htmlFor="terraria-import-name">{t('servers.fieldName')}</Label><Input id="terraria-import-name" value={name} onChange={(event) => setName(event.target.value)} /></div>
          </>}
        </div>
        <DialogFooter>
          <Button variant="glass" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          {inspection && <Button onClick={adopt} disabled={busy || !name.trim() || !variant || inspection.issues.some((issue) => issue.severity === 'error')}>
            <FolderInput className="h-4 w-4" />{t('terraria.import.adopt')}
          </Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <FolderBrowserModal open={fsOpen} onOpenChange={setFsOpen} initial={dir} onSelect={chooseDir} />
  </>;
}
