import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useApi } from '@/hooks/useApi';
import { useT } from '@/context/I18nContext';
import { toast } from 'sonner';

/**
 * Removes a server from the panel. Open while `server` is set. Two separate
 * decisions: remove the profile, and (optionally) move its files to the
 * trash. Trashed files stay restorable - nothing is deleted.
 */
export function RemoveServerDialog({ server, onOpenChange, onRemoved }) {
  const api = useApi();
  const t = useT();
  const [deleteFiles, setDeleteFiles] = useState(false);

  useEffect(() => { if (server) setDeleteFiles(false); }, [server]);

  if (!server) return null;

  const close = () => onOpenChange(false);

  async function remove() {
    const target = server;
    const q = deleteFiles ? '?files=trash' : '?files=keep';
    close();
    try {
      const r = await api(`/api/servers/${target.id}${q}`, { method: 'DELETE' });
      toast.success(r?.filesDeleted ? t('portability.removedWithTrashToast') : t('servers.removedToast'));
      onRemoved?.(target);
    } catch (e) { toast.error(e.message); }
  }

  const body = t('portability.removeProfileBody', { name: server.name });
  const at = body.indexOf(server.name);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{t('servers.removeTitle')}</DialogTitle></DialogHeader>
        <div className="px-5 py-3 space-y-3">
          <p className="break-words text-sm text-muted-foreground">
            {at < 0 ? body : [
              body.slice(0, at),
              <strong key="n" className="text-foreground">{server.name}</strong>,
              body.slice(at + server.name.length),
            ]}
          </p>
          {/* A second, separate decision: the files themselves. Choosing it
              moves them to recoverable trash - it never deletes them. */}
          <label className="flex items-start gap-2 text-sm cursor-pointer rounded border border-border p-3">
            <Checkbox checked={deleteFiles} onCheckedChange={(v) => setDeleteFiles(!!v)} className="mt-0.5" />
            <span>
              <span className="text-foreground">{t('portability.trashFilesLabel')}</span>
              <span className="block text-xs text-muted-foreground mt-0.5">
                {deleteFiles ? t('portability.trashFilesConfirm', { path: server.dir || '' }) : t('portability.trashFilesNote')}
              </span>
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="glass" onClick={close}>{t('common.cancel')}</Button>
          <Button variant="destructive" onClick={remove}>
            {deleteFiles ? t('portability.removeAndTrash') : t('portability.removeProfile')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
