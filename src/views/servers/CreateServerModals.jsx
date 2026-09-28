import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Loading } from '@/components/shared/Loading';
import { showModpackProgressToast, dismissModpackProgressToast } from '@/components/shared/ModpackProgressToast';
import { useApi } from '@/hooks/useApi';
import { useFolderPicker } from '@/hooks/useFolderPicker';
import { useT } from '@/context/I18nContext';
import { SERVER_NAME_MAX_LENGTH } from '@/lib/limits';
import { osExamplePath } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { FolderOpen, Package, Search } from 'lucide-react';
import { MinecraftWizard } from './MinecraftWizard';
import { CustomProcessWizard } from './CustomProcessWizard';
import { GameServerWizard } from './GameServerWizard';
import { FolderBrowserModal } from './FolderBrowserModal';

// The "install something new" dialogs. They live apart from the server list so
// the Add-server flow can load them on demand.

// `game` is the game the new server is for, chosen in the Add-server flow.
export function CreateServerModal({ open, onOpenChange, onCreated, game }) {
  const t = useT();
  const [kind, setKind] = useState(null);

  // Every game goes straight to its own wizard.
  const initialKind = ['terraria', 'valheim', 'palworld'].includes(game)
    ? 'game'
    : (game === 'minecraft' ? 'minecraft' : 'custom');

  useEffect(() => {
    if (open) setKind(initialKind);
  }, [open, initialKind]);

  const back = () => onOpenChange(false);

  const complete = () => {
    onCreated(t(kind === 'custom' ? 'servers.processCreatedToast' : 'servers.createdToast'));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{t('servers.createTitle')}</DialogTitle></DialogHeader>
        {kind === 'minecraft' && <MinecraftWizard onBack={back} onCreated={complete} />}
        {kind === 'game' && <GameServerWizard game={game} onBack={back} onCreated={complete} />}
        {kind === 'custom' && <CustomProcessWizard game="custom" onBack={back} onCreated={complete} />}
      </DialogContent>
    </Dialog>
  );
}

export function CreateFromModpackModal({ open, onOpenChange, onCreated }) {
  const api = useApi();
  const t = useT();
  const { picking, pick } = useFolderPicker(api);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('downloads');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  // Selection / preview step
  const [selected, setSelected] = useState(null); // hit chosen from the list
  const [preview, setPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [name, setName] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [installing, setInstalling] = useState(false);
  const [fsOpen, setFsOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setQ(''); setSort('downloads'); setResults([]);
      setSelected(null); setPreview(null); setPreviewError('');
      setName(''); setParentDir(''); setInstalling(false);
      search('');
    }
  }, [open]);

  useEffect(() => { if (open) search(q); /* re-search on sort change */ }, [sort]);

  async function search(query) {
    setSearching(true);
    try {
      const params = new URLSearchParams({ q: query ?? q, sort, projectType: 'modpack' });
      const data = await api(`/api/modrinth/search?${params.toString()}`);
      setResults(data.hits || []);
    } catch (e) { toast.error(e.message); }
    setSearching(false);
  }

  async function selectModpack(hit) {
    setSelected(hit);
    setPreview(null);
    setPreviewError('');
    setLoadingPreview(true);
    setName('');
    try {
      const projectId = hit.project_id || hit.slug;
      const { matched } = await api(`/api/modrinth/modpack/versions/${encodeURIComponent(projectId)}`);
      const version = matched?.[0];
      if (!version) { setPreviewError(t('minecraft.modrinth.noCompatibleVersion')); setLoadingPreview(false); return; }
      const data = await api(`/api/modrinth/modpack/preview/${encodeURIComponent(version.id)}`);
      setPreview(data);
      setName(data.name || data.indexName || hit.title || '');
    } catch (e) {
      setPreviewError(e.message);
    }
    setLoadingPreview(false);
  }

  async function pickFolder() {
    try {
      const picked = await pick(parentDir);
      if (picked) setParentDir(picked);
    } catch {
      setFsOpen(true);
    }
  }

  async function create() {
    if (!preview || preview.unsupported) return;
    if (!name.trim()) { toast.error(t('minecraft.modrinth.modpackCreateName')); return; }
    if (!parentDir.trim()) { toast.error(t('minecraft.modrinth.modpackCreateFolder')); return; }
    setInstalling(true);
    let progressToast;
    try {
      progressToast = showModpackProgressToast(t);
      const r = await api('/api/modrinth/modpack/install', {
        method: 'POST',
        body: { versionId: preview.versionId, mode: 'create', name, parentDir },
      });
      dismissModpackProgressToast(progressToast);
      toast.success(t('minecraft.modrinth.modpackCreated', { name: name || r.name }));
      onOpenChange(false);
      onCreated?.();
    } catch (e) {
      if (progressToast) toast.dismiss(progressToast);
      toast.error(e.message);
    }
    setInstalling(false);
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{t('servers.createFromModpack')}</DialogTitle></DialogHeader>
        <div className="px-5 py-4 space-y-4">
          {!selected ? (
            <>
              <p className="text-xs text-muted-foreground">{t('servers.createModpackIntro')}</p>
              <form onSubmit={e => { e.preventDefault(); search(q); }} className="flex flex-wrap gap-2">
                <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t('minecraft.modrinth.searchPlaceholder')} className="flex-1 min-w-40" />
                <select
                  className="h-9 rounded-md border border-input bg-background/60 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
                  value={sort}
                  onChange={e => setSort(e.target.value)}
                >
                  <option value="downloads">{t('minecraft.modrinth.sortDownloads')}</option>
                  <option value="follows">{t('minecraft.modrinth.sortFollows')}</option>
                  <option value="relevance">{t('minecraft.modrinth.sortRelevance')}</option>
                  <option value="updated">{t('minecraft.modrinth.sortUpdated')}</option>
                  <option value="newest">{t('minecraft.modrinth.sortNewest')}</option>
                </select>
                <Button type="submit" variant="default">
                  <Search className="h-3.5 w-3.5" />
                  {t('minecraft.modrinth.search')}
                </Button>
              </form>
              {searching ? (
                <Loading size="sm" className="py-6" />
              ) : results.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">{t('minecraft.modrinth.empty')}</p>
              ) : (
                <div className="space-y-2 max-h-72 overflow-y-auto -mx-1 px-1">
                  {results.map(h => (
                    <button
                      type="button"
                      key={h.project_id || h.slug}
                      onClick={() => selectModpack(h)}
                      className="flex w-full items-center gap-3 rounded-lg border border-border/60 bg-secondary/20 p-3 text-left hover:bg-secondary/40 transition-colors"
                    >
                      {h.icon_url && (
                        <img src={h.icon_url} alt="" className="h-11 w-11 rounded shrink-0 object-cover"
                          onError={e => { e.target.style.visibility = 'hidden'; }} />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm text-foreground truncate">{h.title}</div>
                        <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{(h.description || '').slice(0, 140)}</div>
                        <div className="text-xs text-muted-foreground/60 mt-1">
                          ⬇ {Number(h.downloads).toLocaleString()} · ♥ {Number(h.follows || 0).toLocaleString()} · {h.author || ''}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => { if (!installing) { setSelected(null); setPreview(null); setPreviewError(''); } }}
                disabled={installing}
                className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                {t('servers.backToModpacks')}
              </button>
              {loadingPreview ? <Loading size="sm" className="py-6" /> : null}
              {!loadingPreview && previewError && <p className="text-sm text-status-error">{previewError}</p>}
              {preview && preview.unsupported && (
                <div className="rounded-md border border-status-warn/30 bg-status-warn/15 p-3 text-sm text-status-warn">
                  {t('minecraft.modrinth.modpackUnsupportedToast', { loader: preview.loaderType || 'unknown' })}
                </div>
              )}
              {preview && !preview.unsupported && (
                <>
                  <div className="rounded-md border border-border/60 bg-secondary/20 p-3 space-y-1">
                    <p className="text-sm font-semibold text-foreground">{preview.name || preview.indexName || selected.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {preview.loaderType && (
                        <Badge variant="softPrimary" className="mr-1">
                          {preview.loaderType}
                        </Badge>
                      )}
                      {preview.mcVersion && (
                        <Badge variant="default" className="mr-1">
                          MC {preview.mcVersion}
                        </Badge>
                      )}
                      {preview.loaderVersion && <span className="text-label">loader {preview.loaderVersion}</span>}
                    </p>
                    <p className="text-label text-muted-foreground">{preview.serverFileCount} files</p>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('servers.fieldName')}</Label>
                    <Input value={name} onChange={e => setName(e.target.value)} maxLength={SERVER_NAME_MAX_LENGTH} disabled={installing} placeholder={t('minecraft.modrinth.modpackCreateName')} autoFocus />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('servers.fieldParent')}</Label>
                    <div className="flex gap-2">
                      <Input value={parentDir} onChange={e => setParentDir(e.target.value)} disabled={installing} placeholder={t('servers.parentPlaceholder', { path: osExamplePath('parent') })} className="flex-1" />
                      <Button variant="glass" size="sm" type="button" disabled={installing || picking} className="h-11 shrink-0" onClick={pickFolder}>
                        <FolderOpen className="h-3.5 w-3.5" />{t('servers.browse')}
                      </Button>
                    </div>
                  </div>
                  {installing && (
                    <div className="rounded-md border border-border/60 bg-secondary/30 px-3 py-2.5 text-xs text-foreground/90">
                      <div className="flex items-center gap-2">
                        <Package className="h-3.5 w-3.5" />
                        {t('minecraft.modrinth.modpackProgress')}
                      </div>
                      {/* One live signal, matching the background toast: the
                          bar reports the work, so the icon does not also throb. */}
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={t('minecraft.modrinth.modpackProgress')}>
                        <div className="modpack-progress-indeterminate h-full rounded-full bg-primary" />
                      </div>
                      <p className="mt-1.5 text-label text-muted-foreground">{t('minecraft.modrinth.modpackProgressBackground')}</p>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="glass" onClick={() => onOpenChange(false)}>{installing ? t('common.close') : t('common.cancel')}</Button>
          {selected && preview && !preview.unsupported && (
            <Button variant="default" onClick={create} disabled={installing || !name.trim() || !parentDir.trim()}>
              {installing ? t('minecraft.modrinth.installing') : t('servers.createFromModpack')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <FolderBrowserModal
      open={fsOpen}
      onOpenChange={setFsOpen}
      initial={parentDir}
      onSelect={(dir) => setParentDir(dir)}
    />
    </>
  );
}
