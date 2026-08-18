import { useEffect, useRef, useState } from 'react';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DialogFooter } from '@/components/ui/dialog';
import { useApi } from '@/hooks/useApi';
import { useApiStream } from '@/hooks/useApiStream';
import { useFolderPicker } from '@/hooks/useFolderPicker';
import { useT } from '@/context/I18nContext';
import { cn, fmtBytesRaw, osExamplePath } from '@/lib/utils';
import { SERVER_NAME_MAX_LENGTH } from '@/lib/limits';
import { FolderBrowserModal } from './FolderBrowserModal';

export function MinecraftWizard({ onBack, onCreated }) {
  const api = useApi();
  const stream = useApiStream();
  const t = useT();
  const { picking, pick } = useFolderPicker(api);
  const [form, setForm] = useState({ name: '', type: 'paper', mcVersion: '', parentDir: '', javaArgs: '-Xmx4G -Xms4G', eula: false });
  const [versions, setVersions] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState('');
  const [progress, setProgress] = useState(null);
  const [fsOpen, setFsOpen] = useState(false);
  const [versionsLoading, setVersionsLoading] = useState(true);
  const [versionsError, setVersionsError] = useState('');
  const abortRef = useRef(null);
  const versionsRef = useRef(0);

  useEffect(() => { loadVersions('paper'); }, []);

  /*
   * The list is resolved upstream on every type change, and that call is slow
   * enough to be visible - so the wizard has to say it is busy rather than
   * render an empty dropdown that looks ready. `mcVersion` only exists once
   * this resolves, and posting without one is a 400 from /api/create.
   *
   * The token discards a reply that lost the race: switching type twice in
   * quick succession would otherwise let the first request overwrite the
   * second's list.
   */
  async function loadVersions(type) {
    const token = ++versionsRef.current;
    setVersions([]);
    setVersionsLoading(true);
    setVersionsError('');
    setForm((current) => ({ ...current, mcVersion: '' }));
    try {
      const { versions: next } = await api(`/api/create/versions?type=${encodeURIComponent(type)}`);
      if (token !== versionsRef.current) return;
      setVersions(next.slice(0, 60));
      setForm((current) => ({ ...current, mcVersion: next[0] || '' }));
    } catch (err) {
      if (token !== versionsRef.current) return;
      setVersionsError(err?.message || t('minecraft.servers.versionsFailed'));
    } finally {
      if (token === versionsRef.current) setVersionsLoading(false);
    }
  }

  async function create() {
    if (!form.eula) { setError(t('errors.eulaRequired')); return; }
    setLoading(true);
    setError('');
    setProgress(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const phaseKey = {
        resolving: 'minecraft.servers.phaseResolving',
        downloading: 'minecraft.servers.phaseDownloading',
        'installing-forge': 'minecraft.servers.phaseInstallingForge',
        'installing-neoforge': 'minecraft.servers.phaseInstallingNeoForge',
        finalizing: 'servers.phaseFinalizing',
      };
      await stream('/api/create', {
        body: form,
        signal: ac.signal,
        onEvent: (event) => {
          if (event?.type === 'phase') setPhase(phaseKey[event.phase] ? t(phaseKey[event.phase]) : event.phase);
          if (event?.type === 'download-start') setProgress({ received: 0, total: event.total || 0 });
          if (event?.type === 'progress') setProgress({ received: event.received, total: event.total || 0 });
        },
      });
      onCreated();
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message);
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  const field = (key) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setForm((current) => ({ ...current, [key]: value }));
    if (key === 'type') loadVersions(value);
  };
  const pct = progress?.total > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : null;
  const indeterminate = loading && (!progress || !progress.total);

  return (
    <>
      <div className="px-5 py-4 space-y-4">
        <p className="text-xs text-muted-foreground">{t('minecraft.servers.createIntro')}</p>
        <div className="space-y-1.5">
          <Label>{t('servers.fieldName')}</Label>
          <Input value={form.name} onChange={field('name')} maxLength={SERVER_NAME_MAX_LENGTH} disabled={loading} placeholder={t('servers.namePlaceholderCreate')} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>{t('minecraft.servers.fieldType')}</Label>
            <select disabled={loading} className="flex h-9 w-full rounded-md border border-input bg-background/60 px-3 py-2 text-sm disabled:opacity-50" value={form.type} onChange={field('type')}>
              {['vanilla', 'spigot', 'paper', 'fabric', 'forge', 'neoforge'].map((type) => (
                <option key={type} value={type}>{t(`minecraft.servers.type${type === 'neoforge' ? 'NeoForge' : type[0].toUpperCase() + type.slice(1)}`)}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mc-version">{t('minecraft.servers.fieldMcVersionCreate')}</Label>
            <select id="mc-version" disabled={loading || versionsLoading || !versions.length} className="flex h-9 w-full rounded-md border border-input bg-background/60 px-3 py-2 text-sm disabled:opacity-50" value={form.mcVersion} onChange={field('mcVersion')}>
              {!versions.length && <option value="">{t(versionsLoading ? 'minecraft.servers.loadingVersions' : 'minecraft.servers.versionsUnavailable')}</option>}
              {versions.map((version) => <option key={version} value={version}>{version}</option>)}
            </select>
          </div>
        </div>
        {versionsError && (
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-status-error">{versionsError}</p>
            <Button variant="glass" size="sm" type="button" disabled={loading || versionsLoading} onClick={() => loadVersions(form.type)}>
              <RefreshCw className={cn('h-3.5 w-3.5', versionsLoading && 'animate-spin')} />{t('common.retry')}
            </Button>
          </div>
        )}
        <div className="space-y-1.5">
          <Label>{t('servers.fieldParent')}</Label>
          <div className="flex gap-2">
            <Input value={form.parentDir} onChange={field('parentDir')} disabled={loading} placeholder={t('servers.parentPlaceholder', { path: osExamplePath('parent') })} />
            <Button variant="glass" size="sm" type="button" disabled={loading || picking} className="h-11 shrink-0" onClick={async () => {
              try {
                const picked = await pick(form.parentDir);
                if (picked) setForm((current) => ({ ...current, parentDir: picked }));
              } catch { setFsOpen(true); }
            }}><FolderOpen className="h-3.5 w-3.5" />{t('servers.browse')}</Button>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>{t('servers.fieldJavaArgs')}</Label>
          <Input value={form.javaArgs} onChange={field('javaArgs')} disabled={loading} placeholder={t('servers.javaArgsPlaceholder')} />
        </div>
        <label className={cn('flex items-center gap-2 text-sm cursor-pointer', loading && 'opacity-60 pointer-events-none')}>
          <input type="checkbox" checked={form.eula} onChange={field('eula')} className="accent-primary" />
          <span className="text-muted-foreground">{t('minecraft.servers.eula')}</span>
        </label>
        {loading && (
          <div className="space-y-2 rounded-md border border-border/60 bg-secondary/30 px-3 py-2.5">
            <div className="flex justify-between text-xs"><span>{phase || t('servers.downloading')}</span>{pct != null && <span>{t('servers.progressPercent', { pct })}</span>}</div>
            <div className="h-2 overflow-hidden rounded-full bg-border/70"><div className={cn('h-full bg-primary', indeterminate && 'animate-pulse w-1/3')} style={indeterminate ? undefined : { width: `${pct}%` }} /></div>
            {progress && <div className="text-label text-muted-foreground">{progress.total > 0 ? t('servers.progressBytes', { received: fmtBytesRaw(progress.received), total: fmtBytesRaw(progress.total) }) : t('servers.progressBytesUnknown', { received: fmtBytesRaw(progress.received) })}</div>}
          </div>
        )}
        {error && <p className="text-xs text-status-error">{error}</p>}
      </div>
      <DialogFooter>
        <Button variant="glass" onClick={loading ? () => abortRef.current?.abort() : onBack}>{loading ? t('common.cancel') : t('common.back')}</Button>
        <Button onClick={create} disabled={loading || versionsLoading || !form.mcVersion}>{loading ? t('servers.downloading') : t('minecraft.servers.downloadAndCreate')}</Button>
      </DialogFooter>
      <FolderBrowserModal open={fsOpen} onOpenChange={setFsOpen} initial={form.parentDir} onSelect={(dir) => setForm((current) => ({ ...current, parentDir: dir }))} />
    </>
  );
}
