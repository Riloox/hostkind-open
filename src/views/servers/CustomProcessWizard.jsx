import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DialogFooter } from '@/components/ui/dialog';
import { useApi } from '@/hooks/useApi';
import { useApiStream } from '@/hooks/useApiStream';
import { useFolderPicker } from '@/hooks/useFolderPicker';
import { useT } from '@/context/I18nContext';
import { SERVER_NAME_MAX_LENGTH } from '@/lib/limits';
import { FolderBrowserModal } from './FolderBrowserModal';
import { useServer } from '@/context/ServerContext';

export function CustomProcessWizard({ onBack, onCreated }) {
  const api = useApi();
  const stream = useApiStream();
  const t = useT();
  const { picking, pick } = useFolderPicker(api);
  const { currentGame } = useServer();
  const gameType = ['terraria', 'valheim', 'palworld', 'custom'].includes(currentGame) ? currentGame : 'custom';
  const [form, setForm] = useState({ gameType, type: gameType, name: '', cwd: '', startCommand: '', stopCommand: '', stopSignal: 'SIGTERM', healthCheckRegex: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [fsOpen, setFsOpen] = useState(false);
  const field = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  async function create() {
    setLoading(true);
    setError('');
    try {
      await stream('/api/create', { body: form });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function pickFolder() {
    try {
      const picked = await pick(form.cwd);
      if (picked) setForm((current) => ({ ...current, cwd: picked }));
    } catch {
      setFsOpen(true);
    }
  }

  return (
    <>
      <div className="px-5 py-4 space-y-4">
        <p className="text-xs text-muted-foreground">{t('servers.customIntro')}</p>
        <div className="space-y-1.5">
          <Label>{t('servers.fieldName')}</Label>
          <Input value={form.name} onChange={field('name')} maxLength={SERVER_NAME_MAX_LENGTH} disabled={loading} />
        </div>
        <div className="space-y-1.5">
          <Label>{t('servers.fieldWorkingDirectory')}</Label>
          <div className="flex gap-2">
            <Input value={form.cwd} onChange={field('cwd')} disabled={loading} className="flex-1" />
            <Button variant="glass" size="sm" type="button" disabled={loading || picking} className="h-11 shrink-0" onClick={pickFolder}><FolderOpen className="h-3.5 w-3.5" />{t('servers.browse')}</Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>{t('servers.fieldStartCommand')}</Label>
          <Input value={form.startCommand} onChange={field('startCommand')} disabled={loading} placeholder={t('servers.startCommandPlaceholder')} spellCheck={false} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>{t('servers.fieldStopCommand')}</Label>
            <Input value={form.stopCommand} onChange={field('stopCommand')} disabled={loading} placeholder={t('servers.optional')} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('servers.fieldStopSignal')}</Label>
            <Input value={form.stopSignal} onChange={field('stopSignal')} disabled={loading || !!form.stopCommand} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>{t('servers.fieldHealthCheckRegex')}</Label>
          <Input value={form.healthCheckRegex} onChange={field('healthCheckRegex')} disabled={loading} placeholder={t('servers.healthCheckPlaceholder')} spellCheck={false} />
          <p className="text-label text-muted-foreground">{t('servers.healthCheckHelp')}</p>
        </div>
        {error && <p className="text-xs text-status-error">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="glass" onClick={onBack} disabled={loading}>{t('common.back')}</Button>
        <Button onClick={create} disabled={loading}>{loading ? t('common.loading') : t('servers.createProcess')}</Button>
      </DialogFooter>
      <FolderBrowserModal open={fsOpen} onOpenChange={setFsOpen} initial={form.cwd} onSelect={(cwd) => setForm((current) => ({ ...current, cwd }))} />
    </>
  );
}
