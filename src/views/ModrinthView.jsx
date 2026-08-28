import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { ViewHeader } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { useApi } from '@/hooks/useApi';
import { useFolderPicker } from '@/hooks/useFolderPicker';
import { useT } from '@/context/I18nContext';
import { useServer } from '@/context/ServerContext';
import { osExamplePath } from '@/lib/utils';
import { jarIsModLoader } from '@/lib/compat';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Search, Download, Check, FolderOpen, Package } from 'lucide-react';
import { ErrorState } from '@/components/shared/ErrorState';
import { Loading } from '@/components/shared/Loading';
import { showModpackProgressToast, dismissModpackProgressToast } from '@/components/shared/ModpackProgressToast';

function ModrinthResults({ compat, projectType, onInstalled }) {
  const api = useApi();
  const t = useT();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('downloads');
  const [category, setCategory] = useState('');
  const [categories, setCategories] = useState([]);
  const [results, setResults] = useState([]);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState({});

  async function search() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ q, sort, category, projectType });
      const data = await api(`/api/modrinth/search?${params.toString()}`);
      setNote(data.note || '');
      if (data.categories && !categories.length) setCategories(data.categories);
      setResults(data.hits || []);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }

  useEffect(() => { search(); }, [projectType]);
  useEffect(() => { search(); }, [sort, category]);

  async function install(projectId) {
    setInstalling(p => ({ ...p, [projectId]: 'finding' }));
    try {
      const { matched } = await api(`/api/modrinth/versions/${encodeURIComponent(projectId)}`);
      const version = matched?.[0];
      if (!version) {
        toast.error(t('minecraft.modrinth.noCompatibleVersion'));
        setInstalling(p => ({ ...p, [projectId]: null }));
        return;
      }
      setInstalling(p => ({ ...p, [projectId]: 'downloading' }));
      const r = await api('/api/modrinth/install', { method: 'POST', body: { versionId: version.id } });
      toast.success(t('minecraft.modrinth.installedToast', { name: r.name }));
      setInstalling(p => ({ ...p, [projectId]: 'done' }));
      onInstalled?.();
    } catch (e) {
      toast.error(e.message);
      setInstalling(p => ({ ...p, [projectId]: null }));
    }
  }

  const compatText = compat?.projectType
    ? `${compat.label} · ${projectType === 'mod' ? t('minecraft.modrinth.compatMod') : t('minecraft.modrinth.compatPlugin')}${compat.mcVersion ? ' · ' + compat.mcVersion : ''}`
    : note || t('minecraft.modrinth.compatNone');

  return (
    <>
      <form onSubmit={e => { e.preventDefault(); search(); }} className="flex flex-wrap gap-2 mb-5">
        <div className="flex items-center gap-2 flex-1 min-w-48">
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t('minecraft.modrinth.searchPlaceholder')} className="flex-1" />
        </div>
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
        <select
          className="h-9 rounded-md border border-input bg-background/60 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
          value={category}
          onChange={e => setCategory(e.target.value)}
        >
          <option value="">{t('minecraft.modrinth.allCategories')}</option>
          {categories.map(c => (
            <option key={c} value={c}>{c.replace(/-/g, ' ').replace(/\b\w/g, m => m.toUpperCase())}</option>
          ))}
        </select>
        <Button type="submit" variant="default">
          <Search className="h-3.5 w-3.5" />
          {t('minecraft.modrinth.search')}
        </Button>
      </form>

      {loading ? (
        <Loading />
      ) : error && !results.length ? (
        <ErrorState error={error} onRetry={search} />
      ) : results.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">{note || t('minecraft.modrinth.empty')}</p>
      ) : (
        <div className="space-y-2">
          {results.map(h => {
            const state = installing[h.project_id || h.slug];
            return (
              <div key={h.project_id || h.slug} className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/20 p-3 hover:bg-secondary/40 transition-colors">
                {h.icon_url && (
                  <img src={h.icon_url} alt="" className="h-12 w-12 rounded shrink-0 object-cover"
                    onError={e => { e.target.style.visibility = 'hidden'; }} />
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-sm text-foreground truncate">{h.title}</div>
                  <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{(h.description || '').slice(0, 140)}</div>
                  <div className="text-xs text-muted-foreground/60 mt-1">
                    ⬇ {Number(h.downloads).toLocaleString()} · ♥ {Number(h.follows || 0).toLocaleString()} · {h.author || ''}
                  </div>
                </div>
                <Button
                  variant={state === 'done' ? 'glass' : 'default'}
                  size="sm"
                  disabled={!!state}
                  onClick={() => install(h.project_id || h.slug)}
                  className="shrink-0"
                >
                  {state === 'done' ? <><Check className="h-3.5 w-3.5" />{t('minecraft.modrinth.installed')}</> :
                   state ? <>{t('minecraft.modrinth.installing')}</> :
                   <><Download className="h-3.5 w-3.5" />{t('minecraft.modrinth.install')}</>}
                </Button>
              </div>
            );
          })}
          <p className="text-label text-muted-foreground/70 pt-1">{compatText}</p>
        </div>
      )}
    </>
  );
}

function ModsTab({ compat, serverLabel, onInstalled }) {
  const t = useT();

  if (!compat?.canMods) {
    return (
      <div className="rounded-lg border border-border/60 bg-secondary/15 p-5 text-sm text-muted-foreground">
        {t('minecraft.modrinth.tabModsDisabledBody', { label: serverLabel || compat?.label || 'this server' })}
      </div>
    );
  }

  return <ModrinthResults compat={compat} projectType="mod" onInstalled={onInstalled} />;
}

function ModpacksInstallDialog({ open, onOpenChange, projectId, compat, onInstalled }) {
  const api = useApi();
  const t = useT();
  const { picking, pick } = useFolderPicker(api);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState(null);
  const [name, setName] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (!open || !projectId) return;
    setLoading(true);
    setError('');
    setPreview(null);
    setMode(null);
    setInstalling(false);
    loadPreview(projectId);
  }, [open, projectId]);

  async function loadPreview(pid) {
    try {
      const { matched } = await api(`/api/modrinth/modpack/versions/${encodeURIComponent(pid)}`);
      const version = matched?.[0];
      if (!version) {
        setError(t('minecraft.modrinth.noCompatibleVersion'));
        setLoading(false);
        return;
      }
      const data = await api(`/api/modrinth/modpack/preview/${encodeURIComponent(version.id)}`);
      setPreview(data);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }

  async function installModpack(installMode) {
    if (!preview) return;
    setInstalling(true);
    let progressToast;
    try {
      const body = { versionId: preview.versionId, mode: installMode };
      if (installMode === 'create') {
        body.name = name;
        body.parentDir = parentDir;
        if (!body.name.trim()) { toast.error(t('minecraft.modrinth.modpackCreateName')); setInstalling(false); return; }
        if (!body.parentDir.trim()) { toast.error(t('minecraft.modrinth.modpackCreateFolder')); setInstalling(false); return; }
      }
      progressToast = showModpackProgressToast(t);
      const r = await api('/api/modrinth/modpack/install', { method: 'POST', body });
      dismissModpackProgressToast(progressToast);
      if (installMode === 'create') {
        toast.success(t('minecraft.modrinth.modpackCreated', { name: name || r.name }));
      } else {
        toast.success(t('minecraft.modrinth.installedToast', { name: r.name }));
      }
      onOpenChange(false);
      onInstalled?.(r, installMode);
    } catch (e) {
      if (progressToast) toast.dismiss(progressToast);
      toast.error(e.message);
    }
    setInstalling(false);
  }

  async function pickFolder() {
    try {
      const picked = await pick(parentDir);
      if (picked) setParentDir(picked);
    } catch (e) { toast.error(e.message); }
  }

  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('minecraft.modrinth.modpacksTitle')}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {loading ? <Loading size="sm" className="py-6" /> : null}
          {!loading && error && <p className="text-sm text-status-error">{error}</p>}
          {preview && preview.unsupported && (
            <div className="rounded-md border border-status-warn/30 bg-status-warn/15 p-3 text-sm text-status-warn">
              {t('minecraft.modrinth.modpackUnsupportedToast', { loader: preview.loaderType || 'unknown' })}
            </div>
          )}
          {preview && !preview.unsupported && (
            <>
              <div className="rounded-md border border-border/60 bg-secondary/20 p-3 space-y-1">
                <p className="text-sm font-semibold text-foreground">{preview.name || preview.indexName}</p>
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
                  {t('minecraft.modrinth.modpackReady', { name: `${preview.serverFileCount}` })}
                </p>
                <p className="text-label text-muted-foreground">{preview.serverFileCount} files · {preview.loaderVersion && `loader ${preview.loaderVersion}`}</p>
              </div>

              <div className="space-y-3">
                <div className="rounded-md border border-border/60 bg-secondary/10 p-3">
                  <p className="text-xs text-muted-foreground mb-2">{t('minecraft.modrinth.modpackExisting')}</p>
                  {preview.eligibleExisting ? (
                    <Button
                      variant="default"
                      size="sm"
                      className="w-full"
                      disabled={installing}
                      onClick={() => installModpack('existing')}
                    >
                      {installing ? t('minecraft.modrinth.installing') : t('minecraft.modrinth.install')}
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground italic">{t('minecraft.modrinth.modpackNotEligible')}</p>
                  )}
                </div>

                <div className="rounded-md border border-border/60 bg-secondary/10 p-3">
                  <p className="text-xs text-muted-foreground mb-2">{t('minecraft.modrinth.modpackCreate')}</p>
                  {mode === 'create' ? (
                    <div className="space-y-2">
                      <Input
                        placeholder={t('minecraft.modrinth.modpackCreateName')}
                        value={name}
                        onChange={e => setName(e.target.value)}
                        className="h-8 text-sm"
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <Input
                          placeholder={osExamplePath('parent')}
                          value={parentDir}
                          onChange={e => setParentDir(e.target.value)}
                          className="flex-1 h-8 text-sm"
                        />
                        <Button variant="glass" size="sm" onClick={pickFolder} disabled={installing || picking} className="h-8 shrink-0">
                          <FolderOpen className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <div className="flex gap-2 pt-1">
                        <Button variant="ghost" size="sm" onClick={() => setMode(null)} className="flex-1">
                          {t('common.cancel')}
                        </Button>
                        <Button
                          variant="default"
                          size="sm"
                          className="flex-1"
                          disabled={installing || !name.trim() || !parentDir.trim()}
                          onClick={() => installModpack('create')}
                        >
                          {installing ? t('minecraft.modrinth.installing') : t('minecraft.modrinth.modpackCreate')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => setMode('create')}
                    >
                      {t('minecraft.modrinth.modpackCreate')}
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="glass" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModpacksTab({ compat, onInstalled }) {
  const api = useApi();
  const t = useT();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('downloads');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState(null);

  async function search() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ q, sort, projectType: 'modpack' });
      const data = await api(`/api/modrinth/search?${params.toString()}`);
      setResults(data.hits || []);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }

  useEffect(() => { search(); }, []);
  useEffect(() => { search(); }, [sort]);

  function openInstall(projectId) {
    setSelectedProjectId(projectId);
    setDialogOpen(true);
  }

  return (
    <>
      <form onSubmit={e => { e.preventDefault(); search(); }} className="flex flex-wrap gap-2 mb-5">
        <div className="flex items-center gap-2 flex-1 min-w-48">
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t('minecraft.modrinth.searchPlaceholder')} className="flex-1" />
        </div>
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

      {loading ? (
        <Loading />
      ) : error && !results.length ? (
        <ErrorState error={error} onRetry={search} />
      ) : results.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">{t('minecraft.modrinth.empty')}</p>
      ) : (
        <div className="space-y-2">
          {results.map(h => (
            <div key={h.project_id || h.slug} className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/20 p-3 hover:bg-secondary/40 transition-colors">
              {h.icon_url && (
                <img src={h.icon_url} alt="" className="h-12 w-12 rounded shrink-0 object-cover"
                  onError={e => { e.target.style.visibility = 'hidden'; }} />
              )}
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm text-foreground truncate">{h.title}</div>
                <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{(h.description || '').slice(0, 140)}</div>
                <div className="text-xs text-muted-foreground/60 mt-1">
                  ⬇ {Number(h.downloads).toLocaleString()} · ♥ {Number(h.follows || 0).toLocaleString()} · {h.author || ''}
                </div>
              </div>
              <Button
                variant="default"
                size="sm"
                onClick={() => openInstall(h.project_id || h.slug)}
                className="shrink-0"
              >
                <Package className="h-3.5 w-3.5" />
                {t('minecraft.modrinth.install')}
              </Button>
            </div>
          ))}
        </div>
      )}

      <ModpacksInstallDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        projectId={selectedProjectId}
        compat={compat}
        onInstalled={onInstalled}
      />
    </>
  );
}

function InstalledPackTab({ history = false, refreshKey = 0 }) {
  const api = useApi();
  const t = useT();
  const { activeServerId } = useServer();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!activeServerId) return;
    api(`/api/modpacks/installed?serverId=${encodeURIComponent(activeServerId)}`).then(setData).catch(e => setError(e.message));
  }, [api, activeServerId, refreshKey]);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading size="sm" className="py-6" />;
  const items = history ? data.history : (data.installed ? [data.installed] : []);
  if (!items.length) return <p className="text-sm text-muted-foreground italic">{t('minecraft.modrinth.noInstalledPack')}</p>;
  return <div className="space-y-2">{items.map(item => (
    <div key={item.id} className="flex gap-4 rounded-lg border border-border/60 bg-secondary/20 p-4">
      {item.iconUrl && <img src={item.iconUrl} alt="" className="h-14 w-14 shrink-0 rounded-lg object-cover" />}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{item.projectName || item.project_id}</span><Badge variant="softPrimary">{item.loader}</Badge><Badge variant="default">MC {item.mc_version}</Badge></div>
        <p className="mt-1 text-sm text-muted-foreground">{item.versionName || item.versionNumber || item.version_id}</p>
        <p className="mt-2 text-xs text-muted-foreground">{t('minecraft.modrinth.packFiles', { count: item.file_count })} · {t('minecraft.modrinth.packInstalledAt', { date: new Date(item.installed_at).toLocaleString() })}</p>
      </div>
    </div>
  ))}</div>;
}

export function ModrinthView() {
  const api = useApi();
  const t = useT();
  const { servers, setServers, activeServerId, setActiveServerId } = useServer();

  const activeServer = useMemo(
    () => servers.find(s => s.id === activeServerId) || null,
    [servers, activeServerId]
  );
  const compat = useMemo(() => {
    if (!activeServer) return null;
    const jar = activeServer.jar || '';
    const loader = (activeServer.loader || '').toLowerCase();
    const canMods = jarIsModLoader(jar, loader);
    const projectType = canMods ? 'mod' : 'plugin';
    const folder = canMods ? 'mods' : 'plugins';
    const label = canMods
      ? (loader === 'fabric' || jar.toLowerCase().includes('fabric') ? 'Fabric'
        : loader === 'quilt' || jar.toLowerCase().includes('quilt') ? 'Quilt'
        : loader === 'neoforge' || jar.toLowerCase().includes('neoforge') ? 'NeoForge'
        : 'Forge')
      : (jar.toLowerCase().includes('paper') ? 'Paper'
        : jar.toLowerCase().includes('spigot') ? 'Spigot'
        : jar.toLowerCase().includes('bukkit') ? 'Bukkit'
        : jar.toLowerCase().includes('vanilla') || jar.toLowerCase().includes('minecraft_server') ? 'Vanilla'
        : 'Paper/Spigot');
    let loaders = ['paper', 'spigot', 'bukkit'];
    if (canMods) {
      const j = jar.toLowerCase();
      if (loader === 'fabric' || j.includes('fabric')) loaders = ['fabric'];
      else if (loader === 'quilt' || j.includes('quilt')) loaders = ['quilt', 'fabric'];
      else if (loader === 'neoforge' || j.includes('neoforge')) loaders = ['neoforge'];
      else if (loader === 'forge' || j.includes('forge')) loaders = ['forge'];
    }
    return { projectType, loaders, folder, label, mcVersion: activeServer.mcVersion || '', canMods };
  }, [activeServer]);

  const [tab, setTab] = useState('plugins');
  const [installedPackRefreshKey, setInstalledPackRefreshKey] = useState(0);

  const handleModpackInstalled = async (result, mode) => {
    if (mode === 'create' && result?.serverId) {
      if (result.server) {
        setServers(current => current.some(server => server.id === result.serverId)
          ? current.map(server => server.id === result.serverId ? result.server : server)
          : [...current, result.server]);
      }
      await api('/api/active', { method: 'POST', body: { serverId: result.serverId } });
      setActiveServerId(result.serverId);
    }
    setInstalledPackRefreshKey(key => key + 1);
    setTab('installed');
  };

  useEffect(() => {
    if (!compat?.canMods && tab === 'mods') setTab('plugins');
  }, [compat?.canMods, tab]);

  return (
    <div className="space-y-6">
      <ViewHeader title={t('minecraft.modrinth.title')} />
      <Card>
      <CardContent>
        <Tabs value={tab} onValueChange={setTab}>
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <div className="px-1 text-label font-medium uppercase tracking-wider text-muted-foreground">
                {t('minecraft.modrinth.browseGroup')}
              </div>
              <TabsList>
                <TabsTrigger value="plugins">{t('minecraft.modrinth.tabPlugins')}</TabsTrigger>
                <TabsTrigger value="mods" disabled={!compat?.canMods}>
                  {compat?.canMods ? t('minecraft.modrinth.tabMods') : t('minecraft.modrinth.tabModsDisabled')}
                </TabsTrigger>
                <TabsTrigger value="modpacks">{t('minecraft.modrinth.tabModpacks')}</TabsTrigger>
              </TabsList>
            </div>
            <div className="space-y-1.5 sm:border-l sm:border-border sm:pl-4">
              <div className="px-1 text-label font-medium uppercase tracking-wider text-muted-foreground">
                {t('minecraft.modrinth.manageGroup')}
              </div>
              <TabsList>
                <TabsTrigger value="installed">{t('minecraft.modrinth.tabInstalledPack')}</TabsTrigger>
                <TabsTrigger value="history">{t('minecraft.modrinth.tabHistory')}</TabsTrigger>
              </TabsList>
            </div>
          </div>
          <TabsContent value="plugins">
            <ModrinthResults compat={compat} projectType="plugin" />
          </TabsContent>
          <TabsContent value="mods">
            <ModsTab compat={compat} serverLabel={compat?.label} />
          </TabsContent>
          <TabsContent value="modpacks">
            <ModpacksTab
              compat={compat}
              onInstalled={handleModpackInstalled}
            />
          </TabsContent>
          <TabsContent value="installed"><InstalledPackTab refreshKey={installedPackRefreshKey} /></TabsContent>
          <TabsContent value="history"><InstalledPackTab history refreshKey={installedPackRefreshKey} /></TabsContent>
        </Tabs>
      </CardContent>
      </Card>
    </div>
  );
}
