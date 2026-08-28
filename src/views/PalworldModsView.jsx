import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowUpRight, Clock3, Download, FolderSearch,
  Info, RefreshCw, Search, ShieldAlert, ShieldCheck, Trash2, Upload,
} from 'lucide-react';
import { ViewHeader } from '@/components/layout/Page';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { EmptyState } from '@/components/shared/EmptyState';
import { Loading } from '@/components/shared/Loading';
import { useApi } from '@/hooks/useApi';
import { useT } from '@/context/I18nContext';
import { useServer } from '@/context/ServerContext';
import { useAuth } from '@/context/AuthContext';
import { fmtBytes } from '@/lib/utils';

const TERMINAL = ['succeeded', 'failed', 'recovery_required', 'cancelled'];
const EMPTY_CATALOG = {
  items: [],
  stale: false,
  fallbackUrl: 'https://steamcommunity.com/app/1623730/workshop/',
};

// Matches the raw <select> styling the Modrinth browser uses for its filters.
const SELECT_CLASS = 'h-9 rounded-md border border-input bg-background/60 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50';

export function PalworldModsView() {
  const api = useApi();
  const t = useT();
  const { activeServerId } = useServer();
  const { hasCapability } = useAuth();
  const uploadRef = useRef(null);
  const [tab, setTab] = useState('browse');
  const [data, setData] = useState(null);
  const [catalog, setCatalog] = useState(EMPTY_CATALOG);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('trend');
  const [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState(null);
  const [operation, setOperation] = useState(null);
  const [manualPath, setManualPath] = useState('');
  const [pendingRemove, setPendingRemove] = useState(null);
  const canManage = hasCapability('plugins.manage', activeServerId);

  const load = useCallback(async () => {
    if (!activeServerId) return;
    try { setData(await api('/api/palworld/mods/official')); }
    catch (error) { toast.error(error.message); }
  }, [activeServerId, api]);

  const browse = useCallback(async (force = false, overrides = {}) => {
    setBusy(true);
    try {
      const params = new URLSearchParams({
        q: overrides.q ?? query,
        sort: overrides.sort ?? sort,
        tag: overrides.tag ?? tag,
        page: '1',
      });
      if (force) params.set('force', '1');
      setCatalog(await api(`/api/palworld/mods/catalog?${params}`));
    } catch (error) {
      setCatalog((current) => ({ ...current, stale: true }));
      toast.error(error.message);
    }
    finally { setBusy(false); }
  }, [api, query, sort, tag]);

  useEffect(() => { load(); browse(); }, [activeServerId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-run the catalog search when the sort changes, like the Modrinth browser
  // does - but not on the first render, where the mount effect already fetched.
  const skipSortBrowse = useRef(true);
  useEffect(() => {
    if (skipSortBrowse.current) { skipSortBrowse.current = false; return; }
    browse();
  }, [sort]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clicking a tag chip filters the catalog by that tag immediately.
  function filterByTag(nextTag) {
    setTag(nextTag);
    browse(false, { tag: nextTag });
  }

  useEffect(() => {
    if (!operation?.id || TERMINAL.includes(operation.state)) return undefined;
    const timer = setInterval(async () => {
      try {
        const result = await api(`/api/operations/${operation.id}`);
        setOperation(result.operation);
        if (result.operation.state === 'succeeded') { toast.success(t('palworldMods.official.installed')); load(); }
        if (result.operation.state === 'failed') toast.error(result.operation.error?.text || t('palworldMods.importFailed'));
      } catch { /* retry on the next poll */ }
    }, 1500);
    return () => clearInterval(timer);
  }, [operation?.id, operation?.state, api, load, t]);

  async function previewWorkshop(item, allowUnknownRevision = false) {
    if (!item.cached) {
      window.open(item.url, '_blank', 'noopener,noreferrer');
      toast.info(t('palworldMods.official.waitingForSteam'));
      return;
    }
    setBusy(true);
    try {
      setPlan(await api('/api/palworld/mods/preview', {
        method: 'POST',
        body: { workshopId: item.workshopId, allowUnknownRevision },
      }));
    } catch (error) {
      if (error.code === 'revision_unknown' && !allowUnknownRevision) return previewWorkshop(item, true);
      toast.error(error.message);
    } finally { setBusy(false); }
  }

  async function previewUpload(event) {
    event.preventDefault();
    const file = uploadRef.current?.files?.[0];
    if (!file) return toast.error(t('palworldMods.chooseFile'));
    const body = new FormData();
    body.append('package', file);
    setBusy(true);
    try { setPlan(await api('/api/palworld/mods/preview', { method: 'POST', body })); }
    catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  async function install() {
    const current = plan;
    setPlan(null);
    setBusy(true);
    try {
      const result = await api('/api/palworld/mods/install', {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: { previewToken: current.previewToken, revision: current.revision },
      });
      setOperation({ id: result.operationId, state: 'queued', phase: 'queued', progress: 0 });
      if (uploadRef.current) uploadRef.current.value = '';
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  async function addSource(event) {
    event.preventDefault();
    if (!manualPath.trim()) return;
    setBusy(true);
    try {
      await api('/api/palworld/mods/sources', {
        method: 'PUT',
        body: { manualPaths: [...(data.sources.manualPaths || []), manualPath.trim()] },
      });
      setManualPath('');
      await load();
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  async function lifecycle(url, options, message) {
    setBusy(true);
    try {
      await api(url, options);
      toast.success(message);
      await load();
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  if (!data) return <Loading />;
  const eligible = data.compatibility?.supported && data.compatibility?.target === 'windows';
  const cachedIds = new Set(data.cached.map((item) => item.workshopId));
  const catalogItems = catalog.items.map((item) => ({ ...item, cached: cachedIds.has(item.workshopId) }));
  const downloaded = data.cached.filter((item) => !data.packages.some((pkg) => pkg.workshopId === item.workshopId));

  return (
    <div className="space-y-6">
      <ViewHeader
        title={t('palworldMods.title')}
        actions={<Button variant="glass" size="sm" disabled={busy} onClick={() => { load(); browse(true); }}><RefreshCw className="h-3.5 w-3.5" />{t('common.refresh')}</Button>}
      />

      {!eligible && <Alert variant="warn"><ShieldAlert className="h-4 w-4" />{t('palworldMods.official.windowsOnly')}</Alert>}
      {eligible && (
        <Alert variant="info">
          <Info className="h-4 w-4 shrink-0" />
          <div className="space-y-1.5">
            <div className="font-medium">{t('palworldMods.official.howTitle')}</div>
            <ol className="list-decimal space-y-1 pl-4">
              <li>{t('palworldMods.official.howStep1')}</li>
              <li>{t('palworldMods.official.howStep2')}</li>
              <li>{t('palworldMods.official.howStep3')}</li>
              <li>{t('palworldMods.official.howStep4')}</li>
            </ol>
          </div>
        </Alert>
      )}
      {data.legacyPaths.length > 0 && (
        <Alert variant="warn"><ShieldAlert className="h-4 w-4" />{t('palworldMods.official.legacyWarning', { count: data.legacyPaths.length })}</Alert>
      )}
      {operation && !TERMINAL.includes(operation.state) && (
        <Alert variant="info"><Clock3 className="h-4 w-4" />{t('palworldMods.operation', { phase: operation.phase || operation.state, progress: Math.round((operation.progress || 0) * 100) })}</Alert>
      )}

      <Card>
        <CardContent>
          <Tabs value={tab} onValueChange={setTab}>
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1.5">
                <div className="px-1 text-label font-medium uppercase tracking-wider text-muted-foreground">
                  {t('palworldMods.official.browseGroup')}
                </div>
                <TabsList>
                  <TabsTrigger value="browse">{t('palworldMods.official.browse')}</TabsTrigger>
                </TabsList>
              </div>
              <div className="space-y-1.5 sm:border-l sm:border-border sm:pl-4">
                <div className="px-1 text-label font-medium uppercase tracking-wider text-muted-foreground">
                  {t('palworldMods.official.manageGroup')}
                </div>
                <TabsList>
                  <TabsTrigger value="installed">{t('palworldMods.official.installedTab')}</TabsTrigger>
                  <TabsTrigger value="sources">{t('palworldMods.official.sources')}</TabsTrigger>
                </TabsList>
              </div>
            </div>

            <TabsContent value="browse">
              <form onSubmit={(event) => { event.preventDefault(); browse(true); }} className="flex flex-wrap gap-2 mb-5">
                <div className="flex items-center gap-2 flex-1 min-w-48">
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('palworldMods.official.searchPlaceholder')}
                    aria-label={t('palworldMods.official.searchPlaceholder')}
                    className="flex-1"
                  />
                </div>
                <Input
                  value={tag}
                  onChange={(event) => setTag(event.target.value)}
                  placeholder={t('palworldMods.official.tagPlaceholder')}
                  aria-label={t('palworldMods.official.tagPlaceholder')}
                  className="w-36"
                />
                <select
                  className={SELECT_CLASS}
                  value={sort}
                  onChange={(event) => setSort(event.target.value)}
                  aria-label={t('palworldMods.official.sort')}
                >
                  <option value="trend">{t('palworldMods.official.sortTrending')}</option>
                  <option value="recent">{t('palworldMods.official.sortRecent')}</option>
                  <option value="updated">{t('palworldMods.official.sortUpdated')}</option>
                  <option value="subscribed">{t('palworldMods.official.sortSubscribed')}</option>
                </select>
                <Button type="submit" variant="default" disabled={busy}>
                  <Search className="h-3.5 w-3.5" />
                  {t('palworldMods.official.search')}
                </Button>
              </form>

              {catalog.stale && (
                <Alert variant="warn" className="mb-4"><Clock3 className="h-4 w-4" />{t('palworldMods.official.catalogFallback')}</Alert>
              )}

              {catalogItems.length ? (
                <div className="space-y-2">
                  {catalogItems.map((item) => (
                    <div key={item.workshopId} className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/20 p-3 hover:bg-secondary/40 transition-colors">
                      {item.previewUrl ? (
                        <img src={item.previewUrl} alt="" loading="lazy" className="h-12 w-12 rounded shrink-0 object-cover"
                          onError={(event) => { event.target.style.visibility = 'hidden'; }} />
                      ) : (
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                          <ShieldCheck className="h-5 w-5" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-sm text-foreground truncate">{item.title || `Workshop ${item.workshopId}`}</span>
                          <Badge variant={item.cached ? 'softSuccess' : 'default'}>{t(item.cached ? 'palworldMods.official.cached' : 'palworldMods.official.steamRequired')}</Badge>
                        </div>
                        <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{item.description || t('palworldMods.official.noDescription')}</div>
                        {(item.tags || []).length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {(item.tags || []).slice(0, 4).map((itemTag) => (
                              <button key={itemTag} type="button" onClick={() => filterByTag(itemTag)}>
                                <Badge variant="default">{itemTag}</Badge>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button variant="default" size="sm" disabled={!canManage || !eligible || busy} onClick={() => previewWorkshop(item)}>
                          {item.cached ? <Download className="h-3.5 w-3.5" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
                          {t(item.cached ? 'palworldMods.official.preview' : 'palworldMods.official.openSteam')}
                        </Button>
                        <Button asChild variant="glass" size="sm">
                          <a href={item.url} target="_blank" rel="noreferrer">
                            <ArrowUpRight className="h-3.5 w-3.5" />
                            {t('palworldMods.official.details')}
                          </a>
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={FolderSearch}
                  title={t('palworldMods.official.noResults')}
                  message={t('palworldMods.official.catalogFallback')}
                  action={(
                    <Button asChild variant="glass">
                      <a href={catalog.fallbackUrl} target="_blank" rel="noreferrer">
                        <ArrowUpRight className="h-3.5 w-3.5" />
                        {t('palworldMods.official.openWorkshop')}
                      </a>
                    </Button>
                  )}
                />
              )}
            </TabsContent>

            <TabsContent value="installed">
              {downloaded.length > 0 && (
                <div className="mb-5">
                  <div className="px-1 text-label font-medium uppercase tracking-wider text-muted-foreground">
                    {t('palworldMods.official.downloadedTitle')}
                  </div>
                  <p className="mt-1 px-1 text-xs text-muted-foreground">{t('palworldMods.official.downloadedHint')}</p>
                  <div className="mt-2 space-y-2">
                    {downloaded.map((item) => (
                      <div key={item.workshopId} className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/20 p-3 hover:bg-secondary/40 transition-colors">
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                          <Download className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold text-foreground">Workshop {item.workshopId}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">{item.source === 'server' ? t('palworldMods.official.serverSource') : item.library}</div>
                        </div>
                        <Button variant="default" size="sm" disabled={!canManage || !eligible || busy} onClick={() => previewWorkshop({ ...item, cached: true })}>
                          <Download className="h-3.5 w-3.5" />
                          {t('palworldMods.official.reviewInstall')}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {data.packages.length ? (
                <div className="space-y-2">
                  {data.packages.map((pkg) => (
                    <div key={pkg.workshopId} className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/20 p-3 hover:bg-secondary/40 transition-colors">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                        <ShieldCheck className="h-5 w-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-sm text-foreground truncate">{pkg.packageName}</span>
                          <Badge variant={pkg.enabled ? 'softSuccess' : 'default'}>{t(pkg.enabled ? 'palworldMods.enabled' : 'palworldMods.disabled')}</Badge>
                          <Badge variant={pkg.updateState === 'ready' ? 'softWarn' : 'default'}>{t(`palworldMods.official.update.${pkg.updateState}`)}</Badge>
                          <Badge variant={pkg.integrity === 'verified' ? 'softSuccess' : 'softWarn'}>{t(`palworldMods.official.integrity.${pkg.integrity}`)}</Badge>
                        </div>
                        <div className="text-xs text-muted-foreground/60 mt-1">{pkg.version} · {pkg.workshopId}</div>
                        <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                          {pkg.workshop?.description || t('palworldMods.official.noDescription')}
                        </div>
                        {pkg.dependencies.length > 0 && (
                          <div className="mt-1 text-xs text-muted-foreground">{t('palworldMods.official.dependencies')}: {pkg.dependencies.join(', ')}</div>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <Button variant="glass" size="sm" onClick={() => window.open(`https://steamcommunity.com/sharedfiles/filedetails/?id=${pkg.workshopId}`, '_blank', 'noopener,noreferrer')}>
                          <ArrowUpRight className="h-3.5 w-3.5" />
                          {t('palworldMods.official.details')}
                        </Button>
                        <Button
                          variant="glass"
                          size="sm"
                          disabled={!canManage || busy}
                          onClick={() => lifecycle(`/api/palworld/mods/${pkg.workshopId}/enabled`, { method: 'POST', body: { enabled: !pkg.enabled } }, t(pkg.enabled ? 'palworldMods.disabled' : 'palworldMods.enabled'))}
                        >
                          {t(pkg.enabled ? 'palworldMods.disable' : 'palworldMods.enable')}
                        </Button>
                        <Button variant="destructive" size="sm" disabled={!canManage || busy} onClick={() => setPendingRemove(pkg)}>
                          <Trash2 className="h-3.5 w-3.5" />
                          {t('palworldMods.remove')}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground italic">{t('palworldMods.official.noneInstalled')} · {t('palworldMods.official.noneInstalledHint')}</p>
              )}

              {data.trash?.length > 0 && (
                <div className="mt-5">
                  <div className="px-1 text-label font-medium uppercase tracking-wider text-muted-foreground">
                    {t('palworldMods.trash')}
                  </div>
                  <div className="mt-2 space-y-2">
                    {data.trash.map((item) => (
                      <div key={item.trashId} className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/20 p-3 hover:bg-secondary/40 transition-colors">
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-sm text-foreground truncate">{item.package.packageName}</div>
                          <div className="text-xs text-muted-foreground/60 mt-1">{item.package.version}</div>
                        </div>
                        <Button variant="glass" size="sm" disabled={!canManage || busy} onClick={() => lifecycle(`/api/palworld/mods/trash/${item.trashId}/restore`, { method: 'POST' }, t('palworldMods.restored'))}>
                          {t('palworldMods.restore')}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="sources">
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="rounded-lg border border-border/60 bg-secondary/10 p-4">
                  <h3 className="text-label font-medium uppercase tracking-wider text-muted-foreground">
                    {t('palworldMods.official.steamLibraries')}
                  </h3>
                  <div className="mt-3 space-y-2">
                    {data.sources.libraries.map((library) => (
                      <div key={library.workshopPath} className="flex items-center gap-3 rounded-md border border-border/60 bg-secondary/20 p-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs">{library.workshopPath}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">{t(library.source === 'server' ? 'palworldMods.official.serverSourceHint' : 'palworldMods.official.readOnlySource')}</div>
                        </div>
                        <Badge variant={library.source === 'server' ? 'softInfo' : library.exists ? 'softSuccess' : 'default'}>
                          {library.source === 'server' ? t('palworldMods.official.serverSource') : t(library.exists ? 'palworldMods.official.detected' : 'palworldMods.official.notFound')}
                        </Badge>
                      </div>
                    ))}
                  </div>
                  <form className="mt-4 space-y-2" onSubmit={addSource}>
                    <Label htmlFor="steam-library">{t('palworldMods.official.manualLibrary')}</Label>
                    <div className="flex gap-2">
                      <Input id="steam-library" value={manualPath} onChange={(event) => setManualPath(event.target.value)} placeholder={t('palworldMods.official.pathPlaceholder')} />
                      <Button type="submit" variant="glass" disabled={!canManage || busy}>{t('common.add')}</Button>
                    </div>
                  </form>
                </div>
                <div className="rounded-lg border border-border/60 bg-secondary/10 p-4">
                  <h3 className="text-label font-medium uppercase tracking-wider text-muted-foreground">
                    {t('palworldMods.official.uploadTitle')}
                  </h3>
                  <p className="mt-3 text-xs text-muted-foreground">{t('palworldMods.official.uploadHint')}</p>
                  <form className="mt-4 space-y-3" onSubmit={previewUpload}>
                    <Input ref={uploadRef} type="file" accept=".zip,application/zip" disabled={!canManage || !eligible} />
                    <Button type="submit" variant="default" disabled={!canManage || !eligible || busy}>
                      <Upload className="h-3.5 w-3.5" />
                      {t('palworldMods.official.previewUpload')}
                    </Button>
                  </form>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!plan}
        onOpenChange={(open) => { if (!open) setPlan(null); }}
        title={t('palworldMods.official.confirmTitle')}
        description={plan ? (
          <div className="space-y-3">
            <p>{t('palworldMods.official.confirmBody', {
              packageName: plan.plan.packageName,
              version: plan.plan.version,
              files: plan.plan.fileCount,
              size: fmtBytes(plan.plan.sizeBytes),
            })}</p>
            {plan.plan.revisionState === 'unknown' && (
              <Alert variant="warn">
                <ShieldAlert className="h-4 w-4 shrink-0" />
                {t('palworldMods.official.revisionUnknown')}
              </Alert>
            )}
          </div>
        ) : ''}
        confirmLabel={t('palworldMods.official.install')}
        onConfirm={install}
      />
      <ConfirmDialog
        open={!!pendingRemove}
        onOpenChange={(open) => { if (!open) setPendingRemove(null); }}
        title={t('palworldMods.removeTitle')}
        description={pendingRemove ? t('palworldMods.removeBody', { name: pendingRemove.packageName }) : ''}
        confirmLabel={t('palworldMods.remove')}
        destructive
        onConfirm={() => {
          const current = pendingRemove;
          setPendingRemove(null);
          lifecycle(`/api/palworld/mods/${current.workshopId}`, { method: 'DELETE' }, t('palworldMods.removed'));
        }}
      />
    </div>
  );
}
