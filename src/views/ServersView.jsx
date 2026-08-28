import { useState, useEffect, useRef } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { StatusPill } from '@/components/shared/StatusPill';
import { EmptyState } from '@/components/shared/EmptyState';
import { useServer } from '@/context/ServerContext';
import { useAuth } from '@/context/AuthContext';
import { useApi } from '@/hooks/useApi';
import { useApiStream } from '@/hooks/useApiStream';
import { useFolderPicker } from '@/hooks/useFolderPicker';
import { useT } from '@/context/I18nContext';
import { fmtUptime, fmtBytes, fmtBytesRaw, osExamplePath } from '@/lib/utils';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Play, Square, RotateCcw, Star, Pencil, Trash2, FolderOpen, Plus, Server, Package, Search, LayoutTemplate, Download, Upload, Copy, Wrench, FolderInput, MoreHorizontal } from 'lucide-react';
import { Loading } from '@/components/shared/Loading';
import { showModpackProgressToast, dismissModpackProgressToast } from '@/components/shared/ModpackProgressToast';
import { cn } from '@/lib/utils';
import { SERVER_NAME_MAX_LENGTH } from '@/lib/limits';
import { gameForServer } from '@/lib/games';
import { MinecraftWizard } from './servers/MinecraftWizard';
import { CustomProcessWizard } from './servers/CustomProcessWizard';
import { GameServerWizard } from './servers/GameServerWizard';
import { FolderBrowserModal } from './servers/FolderBrowserModal';
import { PalworldAdoptDialog, PalworldImportDialog } from './servers/PalworldPortabilityDialogs';
import { TerrariaImportDialog } from './servers/TerrariaImportDialog';
import { MinecraftAdoptDialog } from './servers/MinecraftAdoptDialog';
import { ServerToolsDialog } from '@/components/shared/ServerToolsDialog';
import { TrashPanel } from '@/components/shared/TrashPanel';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';

function ServerModal({ open, onOpenChange, server, onSaved, servers: allServers }) {
  const api = useApi();
  const t = useT();
  const { picking, pick } = useFolderPicker(api);
  const [form, setForm] = useState({ name: '', dir: '', jar: '', javaArgs: '-Xmx4G -Xms4G', mcVersion: '', worlds: 'world, world_nether, world_the_end', mapUrl: '' });
  const [jars, setJars] = useState([]);
  const [error, setError] = useState('');
  const [fsOpen, setFsOpen] = useState(false);
  // Only Minecraft servers are jar-launched. The other games are installed by
  // the panel (their launch command is internal) and their gameplay settings
  // live in the game's own config files, so editing one is just name + folder.
  const game = server ? gameForServer(server) : 'minecraft';
  const isMinecraft = game === 'minecraft';

  useEffect(() => {
    if (open) {
      setError('');
      if (server) {
        setForm({
          name: server.name || '',
          dir: server.dir || '',
          jar: server.jar || '',
          javaArgs: (server.javaArgs || []).join(' '),
          mcVersion: server.mcVersion || '',
          worlds: (server.worlds || []).join(', '),
          mapUrl: server.mapUrl || '',
        });
        setJars(server.jar ? [server.jar] : []);
      } else {
        setForm({ name: '', dir: '', jar: '', javaArgs: '-Xmx4G -Xms4G', mcVersion: '', worlds: 'world, world_nether, world_the_end', mapUrl: '' });
        setJars([]);
      }
    }
  }, [open, server]);

  // Fill the form from a chosen folder: remember it, name the server after it
  // if the user hasn't typed a name, and preselect the most likely jar.
  function applyDir(dir, j) {
    setForm(f => ({
      ...f,
      dir,
      name: f.name || dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || f.name,
      jar: j.length ? (j.find(x => /spigot|paper|server|bukkit|fabric|forge/i.test(x)) || j[0]) : f.jar,
    }));
    setJars(j);
  }

  async function pickFolder() {
    try {
      const picked = await pick(form.dir);
      if (!picked) return;
      let j = [];
      try {
        const listing = await api(`/api/fs?path=${encodeURIComponent(picked)}`);
        j = listing.jars || [];
      } catch {}
      applyDir(picked, j);
    } catch {
      setFsOpen(true);
    }
  }

  async function save() {
    const body = isMinecraft ? form : { name: form.name, dir: form.dir };
    try {
      if (server?.id) await api(`/api/servers/${server.id}`, { method: 'PUT', body });
      else await api('/api/servers', { method: 'POST', body });
      onSaved(server ? t('servers.updatedToast') : t('servers.registeredToast'));
      onOpenChange(false);
    } catch (e) { setError(e.message); }
  }

  const f = (k) => (e) => setForm(p => ({ ...p, [k]: e.target.value }));

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{server ? t('servers.editTitle') : t('servers.registerTitle')}</DialogTitle>
          </DialogHeader>
          <div className="px-5 py-4 space-y-4">
            {!isMinecraft && (
              <p className="text-xs text-muted-foreground">
                {t('servers.editGameHint', { game: t(`games.${game}`) })}
              </p>
            )}
            <div className="space-y-1.5">
              <Label>{t('servers.fieldName')}</Label>
              <Input value={form.name} onChange={f('name')} maxLength={SERVER_NAME_MAX_LENGTH} placeholder={t('servers.namePlaceholder')} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('servers.fieldFolder')}</Label>
              <div className="flex gap-2">
                <Input value={form.dir} onChange={f('dir')} placeholder={t('servers.folderPlaceholder', { path: osExamplePath('server') })} className="flex-1" />
                <Button variant="glass" size="sm" type="button" disabled={picking} onClick={pickFolder}>
                  <FolderOpen className="h-3.5 w-3.5" />
                  {t('servers.browse')}
                </Button>
              </div>
            </div>
            {isMinecraft && <>
            <div className="space-y-1.5">
              <Label>{t('servers.fieldJar')}</Label>
              <select
                className="flex h-9 w-full items-center rounded-md border border-input bg-background/60 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
                value={form.jar}
                onChange={f('jar')}
              >
                {jars.length === 0 && <option value="">{t('servers.jarPlaceholder')}</option>}
                {jars.map(j => <option key={j} value={j}>{j}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('servers.fieldJavaArgs')}</Label>
              <Input value={form.javaArgs} onChange={f('javaArgs')} placeholder={t('servers.javaArgsPlaceholder')} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>{t('servers.fieldMcVersion')}</Label>
                <Input value={form.mcVersion} onChange={f('mcVersion')} placeholder={t('servers.mcVersionPlaceholder')} />
              </div>
              <div className="space-y-1.5">
                <Label>{t('servers.fieldWorlds')}</Label>
                <Input value={form.worlds} onChange={f('worlds')} placeholder={t('servers.worldsPlaceholder')} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t('servers.fieldMapUrl')}</Label>
              <Input
                value={form.mapUrl}
                onChange={f('mapUrl')}
                placeholder={t('servers.mapUrlPlaceholder')}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            </>}
            {error && <p className="text-xs text-status-error">{error}</p>}
          </div>
          <DialogFooter>
            <Button variant="glass" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button variant="default" onClick={save}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <FolderBrowserModal
        open={fsOpen}
        onOpenChange={setFsOpen}
        initial={form.dir}
        onSelect={(dir, j) => applyDir(dir, j || [])}
      />
    </>
  );
}

function LegacyCreateServerModal({ open, onOpenChange, onCreated }) {
  const api = useApi();
  const stream = useApiStream();
  const t = useT();
  const { picking, pick } = useFolderPicker(api);
  const [form, setForm] = useState({ name: '', type: 'paper', mcVersion: '', parentDir: '', javaArgs: '-Xmx4G -Xms4G', eula: false });
  const [versions, setVersions] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState('');
  const [progress, setProgress] = useState(null); // { received, total }
  const [fsOpen, setFsOpen] = useState(false);
  const abortRef = useRef(null);

  useEffect(() => {
    if (open) {
      setError(''); setProgress(null); setPhase('');
      loadVersions('paper');
    }
  }, [open]);

  async function loadVersions(type) {
    setVersions([]);
    try {
      const { versions: v } = await api(`/api/create/versions?type=${encodeURIComponent(type)}`);
      setVersions(v.slice(0, 60));
      setForm(f => ({ ...f, mcVersion: v[0] || '' }));
    } catch {}
  }

  async function create() {
    if (!form.eula) { setError(t('errors.eulaRequired')); return; }
    setLoading(true); setError(''); setProgress(null);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const phaseKey = {
        resolving: 'servers.phaseResolving',
        downloading: 'servers.phaseDownloading',
        'installing-forge': 'servers.phaseInstallingForge',
        'installing-neoforge': 'servers.phaseInstallingNeoForge',
        finalizing: 'servers.phaseFinalizing',
      };
      const final = await stream('/api/create', {
        body: form,
        signal: ac.signal,
        onEvent: (evt) => {
          if (!evt || !evt.type) return;
          if (evt.type === 'phase') {
            setPhase(phaseKey[evt.phase] ? t(phaseKey[evt.phase]) : evt.phase);
          } else if (evt.type === 'download-start') {
            setProgress({ received: 0, total: evt.total || 0 });
          } else if (evt.type === 'progress') {
            setProgress({ received: evt.received, total: evt.total || 0 });
          }
        },
      });
      onCreated(t('servers.createdToast'));
      onOpenChange(false);
    } catch (e) {
      if (e.name === 'AbortError') {
        setError('');
        setProgress(null);
        setPhase('');
      } else {
        setError(e.message);
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  function cancel() {
    if (abortRef.current) abortRef.current.abort();
  }

  const f = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm(p => ({ ...p, [k]: v }));
    if (k === 'type') loadVersions(e.target.value);
  };

  const pct = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.received / progress.total) * 100))
    : null;
  const indeterminate = loading && (!progress || !progress.total);

  return (
    <>
    <Dialog open={open} onOpenChange={(v) => { if (!loading) onOpenChange(v); }}>
      <DialogContent className="max-w-lg" onPointerDownOutside={(e) => { if (loading) e.preventDefault(); }} onEscapeKeyDown={(e) => { if (loading) e.preventDefault(); }}>
        <DialogHeader><DialogTitle>{t('servers.createTitle')}</DialogTitle></DialogHeader>
        <div className="px-5 py-4 space-y-4">
          <p className="text-xs text-muted-foreground">{t('minecraft.servers.createIntro')}</p>
          <div className="space-y-1.5">
            <Label>{t('servers.fieldName')}</Label>
            <Input value={form.name} onChange={f('name')} maxLength={SERVER_NAME_MAX_LENGTH} disabled={loading} placeholder={t('servers.namePlaceholderCreate')} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>{t('minecraft.servers.fieldType')}</Label>
              <select disabled={loading} className="flex h-9 w-full rounded-md border border-input bg-background/60 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50 disabled:opacity-50" value={form.type} onChange={f('type')}>
                <option value="vanilla">{t('minecraft.servers.typeVanilla')}</option>
                <option value="spigot">{t('minecraft.servers.typeSpigot')}</option>
                <option value="paper">{t('minecraft.servers.typePaper')}</option>
                <option value="fabric">{t('minecraft.servers.typeFabric')}</option>
                <option value="forge">{t('minecraft.servers.typeForge')}</option>
                <option value="neoforge">{t('minecraft.servers.typeNeoForge')}</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('minecraft.servers.fieldMcVersionCreate')}</Label>
              <select disabled={loading} className="flex h-9 w-full rounded-md border border-input bg-background/60 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50 disabled:opacity-50" value={form.mcVersion} onChange={f('mcVersion')}>
                {versions.length === 0 && <option value="">{t('minecraft.servers.loadingVersions')}</option>}
                {versions.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t('servers.fieldParent')}</Label>
            <div className="flex gap-2">
              <Input value={form.parentDir} onChange={f('parentDir')} disabled={loading} placeholder={t('servers.parentPlaceholder', { path: osExamplePath('parent') })} className="flex-1" />
              <Button variant="glass" size="sm" type="button" disabled={loading || picking} className="h-11 shrink-0" onClick={async () => {
                try {
                  const picked = await pick(form.parentDir);
                  if (picked) setForm(f => ({ ...f, parentDir: picked }));
                } catch {
                  setFsOpen(true);
                }
              }}>
                <FolderOpen className="h-3.5 w-3.5" />{t('servers.browse')}
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t('servers.fieldJavaArgs')}</Label>
            <Input value={form.javaArgs} onChange={f('javaArgs')} disabled={loading} placeholder={t('servers.javaArgsPlaceholder')} />
          </div>
          <label className={cn('flex items-center gap-2 text-sm cursor-pointer', loading && 'opacity-60 pointer-events-none')}>
            <input type="checkbox" checked={form.eula} onChange={f('eula')} className="accent-primary" />
            <span className="text-muted-foreground">{(() => {
              const txt = t('minecraft.servers.eula');
              const link = t('minecraft.servers.eulaLink');
              const i = txt.indexOf(link);
              if (i < 0) return txt;
              return <>{txt.slice(0, i)}<a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer" className="text-primary hover:underline">{link}</a>{txt.slice(i + link.length)}</>;
            })()}</span>
          </label>
          {loading && (
            <div className="space-y-2 rounded-md border border-border/60 bg-secondary/30 px-3 py-2.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-foreground/90 truncate">{phase || t('servers.downloading')}</span>
                {pct != null && <span className="text-muted-foreground">{t('servers.progressPercent', { pct })}</span>}
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-border/70">
                <div
                  className={cn('h-full bg-primary transition-[width] duration-150 ease-out', indeterminate && 'animate-pulse w-1/3')}
                  style={indeterminate ? undefined : { width: `${pct}%` }}
                />
              </div>
              {progress && (
                <div className="text-label text-muted-foreground">
                  {progress.total > 0
                    ? t('servers.progressBytes', { received: fmtBytesRaw(progress.received), total: fmtBytesRaw(progress.total) })
                    : t('servers.progressBytesUnknown', { received: fmtBytesRaw(progress.received) })}
                </div>
              )}
            </div>
          )}
          {error && <p className="text-xs text-status-error">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="glass" onClick={loading ? cancel : () => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="default" onClick={create} disabled={loading}>
            {loading ? t('servers.downloading') : t('minecraft.servers.downloadAndCreate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <FolderBrowserModal
      open={fsOpen}
      onOpenChange={setFsOpen}
      initial={form.parentDir}
      onSelect={(dir) => setForm(f => ({ ...f, parentDir: dir }))}
    />
    </>
  );
}

function CreateServerModal({ open, onOpenChange, onCreated }) {
  const t = useT();
  const { currentGame } = useServer();
  const [kind, setKind] = useState(null);

  // Every game goes straight to its own wizard: custom processes have their own
  // section now, so Minecraft no longer has to offer one behind a picker.
  const initialKind = ['terraria', 'valheim', 'palworld'].includes(currentGame)
    ? 'game'
    : (currentGame === 'minecraft' ? 'minecraft' : 'custom');

  useEffect(() => {
    if (open) setKind(initialKind);
  }, [open, currentGame]);

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
        {kind === 'game' && <GameServerWizard onBack={back} onCreated={complete} />}
        {kind === 'custom' && <CustomProcessWizard onBack={back} onCreated={complete} />}
      </DialogContent>
    </Dialog>
  );
}

function CreateFromModpackModal({ open, onOpenChange, onCreated }) {
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

const TERMINAL_OPERATION_STATES = ['succeeded', 'failed', 'cancelled', 'recovery_required'];

async function waitForOperation(api, operationId, { intervalMs = 1500 } = {}) {
  for (;;) {
    const { operation } = await api(`/api/operations/${operationId}`);
    if (TERMINAL_OPERATION_STATES.includes(operation.state)) return operation;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

function TemplateModal({ open, onOpenChange, servers, initialSource, onCreated }) {
  const api = useApi();
  const t = useT();
  const { token } = useAuth();
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
      const response = await fetch(`/api/templates/${item.id}/export`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || t('servers.exportFailed'));
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
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

export function ServersView({ onSetActive, onRefresh, onNavigate }) {
  const api = useApi();
  const t = useT();
  const { servers: allServers, activeServerId, statuses, currentGame } = useServer();
  const servers = currentGame ? allServers.filter(s => gameForServer(s) === currentGame) : allServers;
  const supportsMinecraftServerTools = !currentGame || currentGame === 'minecraft';
  const supportsPalworldPortability = !currentGame || currentGame === 'palworld';
  const supportsTerrariaImport = !currentGame || currentGame === 'terraria';
  const hasAdoptPath = supportsMinecraftServerTools || supportsPalworldPortability || supportsTerrariaImport;
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [registerOpen, setRegisterOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [modpackOpen, setModpackOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templateSource, setTemplateSource] = useState(null);
  const [editServer, setEditServer] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [minecraftAdoptOpen, setMinecraftAdoptOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [terrariaImportOpen, setTerrariaImportOpen] = useState(false);
  const [toolsServer, setToolsServer] = useState(null);
  const [trashVersion, setTrashVersion] = useState(0);

  // One button dispatches to whichever "add a server already on this host"
  // dialog the current game owns. `null` means the game has no adoption path
  // (Valheim, Custom), so the button does not render.
  const addExisting =
    supportsMinecraftServerTools ? () => setMinecraftAdoptOpen(true)
    : supportsPalworldPortability ? () => setAdoptOpen(true)
    : supportsTerrariaImport      ? () => setTerrariaImportOpen(true)
    : null;

  async function action(act, s, opts = {}) {
    try {
      if (act === 'start') await api(`/api/servers/${s.id}/start`, { method: 'POST' });
      else if (act === 'stop') await api(`/api/servers/${s.id}/stop`, { method: 'POST' });
      else if (act === 'restart') await api(`/api/servers/${s.id}/restart`, { method: 'POST' });
      else if (act === 'active') onSetActive(s.id);
      else if (act === 'delete') {
        // Two distinct decisions: remove the profile, and (separately) move the
        // files to trash. Trashed files stay restorable - nothing is deleted.
        const q = opts.deleteFiles ? '?files=trash' : '?files=keep';
        const r = await api(`/api/servers/${s.id}${q}`, { method: 'DELETE' });
        toast.success(r?.filesDeleted ? t('portability.removedWithTrashToast') : t('servers.removedToast'));
        setTrashVersion((value) => value + 1);
        onRefresh?.();
      }
    } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>{t('servers.registeredTitle')}</CardTitle>
          {isAdmin && (
            <div className="flex items-center gap-2">
              <Button data-tour="server-create-new" variant="default" size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-3.5 w-3.5" />
                {t('servers.createNew')}
              </Button>
              {addExisting && (
                <Button variant="glass" size="sm" onClick={addExisting}>
                  <FolderInput className="h-3.5 w-3.5" />
                  {t('servers.addExisting')}
                </Button>
              )}
              {(supportsMinecraftServerTools || supportsPalworldPortability) && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="glass" size="sm" aria-label={t('servers.moreActions')}>
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {supportsMinecraftServerTools && (
                      <>
                        <DropdownMenuItem data-tour="server-create-modpack" onClick={() => setModpackOpen(true)}>
                          <Package className="h-4 w-4" />
                          {t('servers.createFromModpack')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setTemplateSource(null); setTemplatesOpen(true); }}>
                          <LayoutTemplate className="h-4 w-4" />
                          {t('servers.templates')}
                        </DropdownMenuItem>
                      </>
                    )}
                    {supportsPalworldPortability && (
                      <DropdownMenuItem onClick={() => setImportOpen(true)}>
                        <Upload className="h-4 w-4" />
                        {t('portability.importProfile')}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-4">{(() => {
            const txt = t('servers.activeExplainer', { active: t('servers.activeLabel') });
            const active = t('servers.activeLabel');
            const i = txt.indexOf(active);
            if (i < 0) return txt;
            return <>{txt.slice(0, i)}<strong className="text-foreground">{active}</strong>{txt.slice(i + active.length)}</>;
          })()}</p>
          {servers.length === 0 ? (
            <EmptyState
              icon={Server}
              title={t('servers.emptyTitle')}
              message={t(hasAdoptPath ? 'servers.emptyWithAdopt' : 'servers.emptyCreateOnly')}
              action={isAdmin ? <Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="h-3.5 w-3.5" />{t('servers.createNew')}</Button> : null}
            />
          ) : (
            <div className="overflow-x-auto -mx-5">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-label font-semibold uppercase tracking-wider text-muted-foreground">
                    <th className="py-2 pl-4 text-left">{t('servers.colServer')}</th>
                    <th className="py-2 text-left">{t('servers.colStatus')}</th>
                    <th className="py-2 text-left">{t('servers.colPlayers')}</th>
                    <th className="py-2 text-left hidden sm:table-cell">{t('servers.colUptime')}</th>
                    <th className="py-2 text-left hidden sm:table-cell">{t('servers.colVersion')}</th>
                    <th className="py-2 pr-4 text-right">{t('servers.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {servers.map(s => {
                    const st = statuses[s.id] || s.status || { status: 'offline', playerCount: 0, maxPlayers: 0 };
                    const running = st.status !== 'offline';
                    const isActive = s.id === activeServerId;
                    return (
                      <tr key={s.id} className={cn('border-b border-border/50 last:border-0 transition-colors', isActive && 'bg-primary/5')}>
                        <td className="py-3 pl-4 pr-4">
                          <div className="flex items-center gap-3">
                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-border bg-muted/30 text-muted-foreground">
                              <Server className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                              <div className="flex max-w-[240px] items-center gap-1.5 font-medium text-foreground">
                                <span className="truncate hover:text-primary cursor-pointer" title={s.name} onClick={() => onSetActive(s.id)}>
                                  {s.name}
                                </span>
                                {isActive && <Badge variant="active" className="text-label px-1 py-0.5">{t('servers.activeLabel')}</Badge>}
                              </div>
                              <div className="text-xs text-muted-foreground/70 truncate max-w-[180px]">{s.dir || ''}</div>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 pr-4"><StatusPill status={st.status} /></td>
                        <td className="py-3 pr-4 tabular-nums text-muted-foreground">
                          {running && s.type !== 'custom' ? `${st.playerCount}/${st.maxPlayers || '?'}` : t('common.dashPlaceholder')}
                        </td>
                        <td className="py-3 pr-4 hidden sm:table-cell tabular-nums text-muted-foreground">
                          {running ? (fmtUptime(st.uptimeMs) || '0m') : t('common.dashPlaceholder')}
                        </td>
                        <td className="py-3 pr-4 hidden sm:table-cell text-muted-foreground">{s.mcVersion || t('common.dashPlaceholder')}</td>
                        <td className="py-3 pr-4">
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="icon-xs" title={t('servers.btnStart')} disabled={running} onClick={() => action('start', s)}><Play className="h-3.5 w-3.5 text-status-online" /></Button>
                            <Button variant="ghost" size="icon-xs" title={t('servers.btnRestart')} onClick={() => action('restart', s)}><RotateCcw className="h-3.5 w-3.5" /></Button>
                            <Button variant="ghost" size="icon-xs" title={t('servers.btnStop')} disabled={!running} onClick={() => action('stop', s)}><Square className="h-3.5 w-3.5 text-status-error" /></Button>
                            <Button variant="ghost" size="icon-xs" title={t('servers.btnSetActive')} disabled={isActive} onClick={() => action('active', s)}><Star className={cn('h-3.5 w-3.5', isActive && 'text-primary fill-primary')} /></Button>
                            {isAdmin && s.type !== 'custom' && <Button variant="ghost" size="icon-xs" title={t('servers.btnEdit')} onClick={() => { setEditServer(s); setRegisterOpen(true); }}><Pencil className="h-3.5 w-3.5" /></Button>}
                            {isAdmin && <Button variant="ghost" size="icon-xs" title={t('servers.cloneWithoutWorlds')} onClick={() => { setTemplateSource(s); setTemplatesOpen(true); }}><Copy className="h-3.5 w-3.5" /></Button>}
                            {isAdmin && s.type === 'palworld' && <Button variant="ghost" size="icon-xs" title={t('portability.serverTools')} onClick={() => setToolsServer(s)}><Wrench className="h-3.5 w-3.5" /></Button>}
                            {isAdmin && <Button variant="ghost" size="icon-xs" title={t('servers.btnRemove')} onClick={() => setConfirmDelete(s)}><Trash2 className="h-3.5 w-3.5 text-status-error" /></Button>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <ServerModal
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        server={editServer}
        servers={servers}
        onSaved={(msg) => { toast.success(msg); onRefresh?.(); }}
      />
      <CreateServerModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(msg) => { toast.success(msg); onRefresh?.(); }}
      />
      {supportsMinecraftServerTools && (
        <>
          <CreateFromModpackModal
            open={modpackOpen}
            onOpenChange={setModpackOpen}
            onCreated={() => { onRefresh?.(); }}
          />
          <TemplateModal open={templatesOpen} onOpenChange={setTemplatesOpen} servers={servers} initialSource={templateSource} onCreated={() => onRefresh?.()} />
        </>
      )}

      {confirmDelete && (
        <Dialog open onOpenChange={(o) => { if (!o) { setConfirmDelete(null); setDeleteFiles(false); } }}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>{t('servers.removeTitle')}</DialogTitle></DialogHeader>
            <div className="px-5 py-3 space-y-3">
              <p className="break-words text-sm text-muted-foreground">{(() => {
                const txt = t('portability.removeProfileBody', { name: confirmDelete.name });
                const ni = txt.indexOf(confirmDelete.name);
                if (ni < 0) return txt;
                return [
                  txt.slice(0, ni),
                  <strong key="n" className="text-foreground">{confirmDelete.name}</strong>,
                  txt.slice(ni + confirmDelete.name.length),
                ];
              })()}</p>
              {/* A second, separate decision: the files themselves. Choosing it
                  moves them to recoverable trash - it never deletes them. */}
              <label className="flex items-start gap-2 text-sm cursor-pointer rounded border border-border p-3">
                <Checkbox checked={deleteFiles} onCheckedChange={(v) => setDeleteFiles(!!v)} className="mt-0.5" />
                <span>
                  <span className="text-foreground">{t('portability.trashFilesLabel')}</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    {deleteFiles ? t('portability.trashFilesConfirm', { path: confirmDelete.dir || '' }) : t('portability.trashFilesNote')}
                  </span>
                </span>
              </label>
            </div>
            <DialogFooter>
              <Button variant="glass" onClick={() => { setConfirmDelete(null); setDeleteFiles(false); }}>{t('common.cancel')}</Button>
              <Button variant="destructive" onClick={() => { action('delete', confirmDelete, { deleteFiles }); setConfirmDelete(null); setDeleteFiles(false); }}>
                {deleteFiles ? t('portability.removeAndTrash') : t('portability.removeProfile')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {supportsMinecraftServerTools && isAdmin && (
        <MinecraftAdoptDialog open={minecraftAdoptOpen} onOpenChange={setMinecraftAdoptOpen} onAdopted={() => onRefresh?.()} />
      )}
      {supportsPalworldPortability && isAdmin && (
        <>
          <PalworldAdoptDialog open={adoptOpen} onOpenChange={setAdoptOpen} onAdopted={() => onRefresh?.()} />
          <PalworldImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={() => onRefresh?.()} />
        </>
      )}
      {supportsTerrariaImport && isAdmin && (
        <TerrariaImportDialog
          open={terrariaImportOpen}
          onOpenChange={setTerrariaImportOpen}
          onImported={(server, issues) => {
            onSetActive?.(server.id);
            onRefresh?.();
            onNavigate?.('dashboard');
            if (issues.length) toast.warning(t('terraria.import.followUp'));
          }}
        />
      )}
      <ServerToolsDialog open={!!toolsServer} onOpenChange={(o) => { if (!o) setToolsServer(null); }} server={toolsServer} />
      {isAdmin && <TrashPanel key={trashVersion} onRestored={() => onRefresh?.()} />}
    </div>
  );
}
