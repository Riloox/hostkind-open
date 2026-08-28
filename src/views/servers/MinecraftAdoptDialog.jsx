import { useState } from 'react';
import { toast } from 'sonner';
import { FolderOpen } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { useApi } from '@/hooks/useApi';
import { useFolderPicker } from '@/hooks/useFolderPicker';
import { useT } from '@/context/I18nContext';
import { FolderBrowserModal } from './FolderBrowserModal';

/*
 * Minecraft server adoption: inspect first, register second (via the
 * existing POST /api/servers API). Mirrors PalworldAdoptDialog.
 */
export function MinecraftAdoptDialog({ open, onOpenChange, onAdopted }) {
  const api = useApi();
  const t = useT();
  const { picking, pick } = useFolderPicker(api);
  const [dir, setDir] = useState('');
  const [name, setName] = useState('');
  const [detection, setDetection] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fsOpen, setFsOpen] = useState(false);

  async function pickFolder() {
    try {
      const picked = await pick(dir, t('portability.minecraftAdoptTitle'));
      if (!picked) return;
      setDir(picked);
      setDetection(null);
      await inspect(picked);
    } catch {
      setFsOpen(true);
    }
  }

  async function inspect(target = dir) {
    setBusy(true);
    try {
      const result = await api('/api/portability/minecraft/adopt/preview', { method: 'POST', body: { dir: target }, serverScoped: false });
      setDetection(result);
      if (result.ok && !name) setName(String(target).split(/[\\/]/).filter(Boolean).pop() || '');
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  async function adopt() {
    setBusy(true);
    try {
      const body = {
        name,
        dir: detection.dir,
        jar: detection.jarLoader?.jar?.jar || '',
        javaArgs: '-Xmx4G -Xms4G',
        mcVersion: '',
        worlds: detection.worlds.map((w) => w.name).join(', '),
        mapUrl: '',
      };
      await api('/api/servers', { method: 'POST', body, serverScoped: false });
      toast.success(t('portability.minecraftAdoptDone', { name }));
      onAdopted?.();
      onOpenChange(false);
      setDir(''); setName(''); setDetection(null);
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  const sp = detection?.serverProperties;
  const jarLoader = detection?.jarLoader;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>{t('portability.minecraftAdoptTitle')}</DialogTitle></DialogHeader>
          <DialogBody className="space-y-4">
            <p className="text-xs text-muted-foreground">{t('portability.minecraftAdoptIntro')}</p>
            <div className="space-y-1.5">
              <Label>{t('portability.folder')}</Label>
              <div className="flex gap-2">
                <Input value={dir} onChange={(e) => { setDir(e.target.value); setDetection(null); }} placeholder="/srv/minecraft" />
                <Button
                  variant="glass"
                  className="h-11 shrink-0"
                  type="button"
                  aria-label={t('servers.browse')}
                  disabled={busy || picking}
                  onClick={pickFolder}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            <Button variant="glass" size="sm" disabled={busy || !dir} onClick={() => inspect()}>{t('portability.inspect')}</Button>

            {detection && !detection.ok && (
              <Alert variant="error">{detection.blocked?.message}{detection.blocked?.conflict ? ` (${detection.blocked.conflict})` : ''}</Alert>
            )}

            {detection?.ok && (
              <div className="space-y-3">
                <dl className="grid grid-cols-2 gap-2 text-xs">
                  <div><dt className="text-muted-foreground">{t('portability.minecraftServerProperties')}</dt><dd>{sp?.present ? t('portability.found') : t('portability.notFound')}</dd></div>
                  <div><dt className="text-muted-foreground">{t('portability.gamePort')}</dt><dd className="tabular-nums">{sp?.port ?? t('common.dashPlaceholder')}</dd></div>
                  <div><dt className="text-muted-foreground">{t('portability.minecraftMotd')}</dt><dd>{sp?.motd || t('common.dashPlaceholder')}</dd></div>
                  <div><dt className="text-muted-foreground">{t('portability.minecraftLevelName')}</dt><dd>{sp?.levelName || t('common.dashPlaceholder')}</dd></div>
                  <div><dt className="text-muted-foreground">{t('portability.minecraftJarType')}</dt><dd>{jarLoader?.jar?.label || t('common.dashPlaceholder')}</dd></div>
                  <div><dt className="text-muted-foreground">{t('portability.minecraftJarFile')}</dt><dd className="truncate">{jarLoader?.jar?.jar || t('common.dashPlaceholder')}</dd></div>
                  <div><dt className="text-muted-foreground">{t('portability.minecraftWorlds')}</dt><dd>{detection.worlds.length}</dd></div>
                  <div><dt className="text-muted-foreground">{t('portability.minecraftEula')}</dt><dd>{detection.eula?.accepted ? t('portability.accepted') : t('portability.notAccepted')}</dd></div>
                  <div><dt className="text-muted-foreground">{t('portability.minecraftMaxPlayers')}</dt><dd className="tabular-nums">{sp?.maxPlayers ?? t('common.dashPlaceholder')}</dd></div>
                  <div><dt className="text-muted-foreground">{t('portability.minecraftJava')}</dt><dd>{detection.java?.available ? `Java ${detection.java.majorVersion || '?'}` : t('portability.minecraftJavaNotFound')}</dd></div>
                </dl>

                {detection.issues.map((issue) => <Alert key={issue} variant="warn">{issue}</Alert>)}

                <Alert variant="info">{t('portability.adoptPreserves', { list: detection.preserves.join(', ') })}</Alert>

                <div className="space-y-1.5">
                  <Label>{t('portability.name')}</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </div>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="glass" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button disabled={busy || !detection?.ok || !detection?.jarLoader?.jar || !name} onClick={adopt}>{t('portability.minecraftAdopt')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <FolderBrowserModal open={fsOpen} onOpenChange={setFsOpen} initial={dir} onSelect={(picked) => { setDir(picked); setDetection(null); inspect(picked); }} />
    </>
  );
}
