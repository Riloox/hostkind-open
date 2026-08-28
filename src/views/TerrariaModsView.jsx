import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle, ArchiveRestore, ArrowUpRight, CheckCircle2, Clock3, Download,
  FileJson, FileUp, FileWarning, FolderSearch, PackageOpen, Plus, Power,
  PowerOff, RefreshCw, Save, Search, ShieldAlert, ShieldCheck, Trash2,
} from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorState } from '@/components/shared/ErrorState';
import { PromptDialog } from '@/components/shared/PromptDialog';
import { Loading } from '@/components/shared/Loading';
import { ViewHeader } from '@/components/layout/Page';
import { useApi } from '@/hooks/useApi';
import { useT } from '@/context/I18nContext';
import { useServer } from '@/context/ServerContext';
import { useAuth } from '@/context/AuthContext';
import { fmtBytes } from '@/lib/utils';

const API = '/api/terraria/mods';
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

// Matches the raw <select> styling the Modrinth browser uses for its filters.
const SELECT_CLASS = 'h-9 rounded-md border border-input bg-background/60 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50';

function issueVariant(severity) {
  return severity === 'error' ? 'destructive' : 'softWarn';
}

function previewPlanItems(plan) {
  if (Array.isArray(plan)) {
    return plan.filter(Boolean).map((item) => ({ ...item, change: item.action || 'add' }));
  }
  if (!plan) return [];
  return [
    ...(plan.add || []).map((item) => ({ ...item, change: 'missing' })),
    ...(plan.remove || []).map((item) => ({ ...item, change: 'remove' })),
    ...(plan.enable || []).map((item) => ({ ...item, change: 'enable' })),
    ...(plan.disable || []).map((item) => ({ ...item, change: 'disable' })),
  ];
}

function previewChangeVariant(change) {
  if (change === 'replace') return 'softWarn';
  if (change === 'remove' || change === 'missing') return 'destructive';
  if (change === 'add' || change === 'enable') return 'softSuccess';
  return 'default';
}

function PreviewChangeIcon({ change }) {
  if (change === 'add') return <Plus className="h-4 w-4" />;
  if (change === 'replace') return <RefreshCw className="h-4 w-4" />;
  if (change === 'remove') return <Trash2 className="h-4 w-4" />;
  if (change === 'enable') return <Power className="h-4 w-4" />;
  if (change === 'disable') return <PowerOff className="h-4 w-4" />;
  return <FileWarning className="h-4 w-4" />;
}

function previewSummaryKey(change) {
  return {
    add: 'added',
    replace: 'replaced',
    missing: 'missing',
    remove: 'removed',
    enable: 'enabled',
    disable: 'disabled',
  }[change] || 'changed';
}

function previewConfirmKey(action, hasReplacement) {
  if (action === 'import') return hasReplacement ? 'confirmImportReplace' : 'confirmImport';
  if (action === 'pack-apply') return 'confirmPack';
  if (action === 'remove') return 'confirmRemove';
  if (action === 'disable') return 'confirmDisable';
  return 'confirmEnable';
}

export function TerrariaModsView() {
  const api = useApi();
  const t = useT();
  const { activeServerId, getServerStatus } = useServer();
  const { hasCapability } = useAuth();
  const canManage = hasCapability('plugins.manage', activeServerId);
  const status = activeServerId ? getServerStatus(activeServerId) : null;
  const offline = status?.status === 'offline';
  const [tab, setTab] = useState('workshop');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [workshopValue, setWorkshopValue] = useState('');
  const [workshopItem, setWorkshopItem] = useState(null);
  const [updates, setUpdates] = useState([]);
  const [packs, setPacks] = useState([]);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [catalog, setCatalog] = useState(null);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogSort, setCatalogSort] = useState('trend');
  const [catalogTag, setCatalogTag] = useState('');
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);

  useEffect(() => {
    setReplaceConfirmed(false);
  }, [preview?.token]);

  const load = useCallback(async () => {
    if (!activeServerId) return;
    setError('');
    try {
      const [inventory, packData] = await Promise.all([
        api(`${API}?serverId=${encodeURIComponent(activeServerId)}`),
        api(`${API}/modpacks?serverId=${encodeURIComponent(activeServerId)}`),
      ]);
      setData(inventory);
      setPacks(packData.packs || []);
    }
    catch (loadError) {
      setError(loadError.message);
      toast.error(loadError.message);
    }
  }, [activeServerId, api]);

  const browse = useCallback(async (force = false, overrides = {}) => {
    if (!activeServerId) return;
    setBusy('catalog');
    try {
      const params = new URLSearchParams({
        serverId: activeServerId,
        q: overrides.q ?? catalogQuery,
        sort: overrides.sort ?? catalogSort,
        tag: overrides.tag ?? catalogTag,
        page: '1',
      });
      if (force) params.set('force', '1');
      setCatalog(await api(`${API}/workshop/catalog?${params}`));
    } catch (browseError) { toast.error(browseError.message); }
    setBusy('');
  }, [activeServerId, api, catalogQuery, catalogSort, catalogTag]);

  useEffect(() => {
    setData(null);
    setCatalog(null);
    setRestartRequired(false);
    load();
    browse();
  }, [activeServerId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-run the catalog search when the sort changes, like the Modrinth browser
  // does - but not on the first render, where the mount effect already fetched.
  const skipSortBrowse = useRef(true);
  useEffect(() => {
    if (skipSortBrowse.current) { skipSortBrowse.current = false; return; }
    browse();
  }, [catalogSort]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clicking a tag chip filters the catalog by that tag immediately.
  function filterByTag(tag) {
    setCatalogTag(tag);
    browse(false, { tag });
  }

  const issuesByMod = useMemo(() => {
    const result = new Map();
    for (const issue of data?.diagnostics?.issues || []) {
      const rows = result.get(issue.mod) || [];
      rows.push(issue);
      result.set(issue.mod, rows);
    }
    return result;
  }, [data]);

  async function stopServer() {
    setBusy('stop');
    try {
      await api('/api/server/stop', { method: 'POST' });
      toast.success(t('terraria.mods.stopRequested'));
    } catch (stopError) { toast.error(stopError.message); }
    setBusy('');
  }

  async function review(mod, action) {
    setBusy(`${action}:${mod.internalName}`);
    try {
      const result = await api(`${API}/${encodeURIComponent(mod.internalName)}/${action}`, {
        method: 'POST',
        body: { serverId: activeServerId },
      });
      setPreview({ ...result.preview, action });
    } catch (reviewError) { toast.error(reviewError.message); }
    setBusy('');
  }

  async function reviewRemove(mod) {
    setBusy(`remove:${mod.internalName}`);
    try {
      const result = await api(`${API}/${encodeURIComponent(mod.internalName)}`, {
        method: 'DELETE',
        body: { serverId: activeServerId },
      });
      setPreview({ ...result.preview, action: 'remove' });
    } catch (reviewError) { toast.error(reviewError.message); }
    setBusy('');
  }

  async function apply() {
    if (!preview) return;
    const items = previewPlanItems(preview.plan);
    const hasReplacement = preview.action === 'import' && items.some((item) => item.change === 'replace');
    if (hasReplacement && !replaceConfirmed) return;
    setBusy('apply');
    try {
      if (preview.action === 'import') {
        const result = await api(`${API}/import`, {
          method: 'POST', headers: { 'Idempotency-Key': uuid() },
          body: { serverId: activeServerId, token: preview.token, replace: hasReplacement && replaceConfirmed },
        });
        setRestartRequired(Boolean(result.restartRequired));
        setPreview(null);
        toast.success(t('terraria.mods.importDone'));
        await load();
        setBusy('');
        return;
      }
      if (preview.action === 'pack-apply') {
        const result = await api(`${API}/modpacks/${encodeURIComponent(preview.pack.id)}/apply`, {
          method: 'POST', headers: { 'Idempotency-Key': uuid() },
          body: { serverId: activeServerId, token: preview.token },
        });
        setRestartRequired(Boolean(result.restartRequired));
        setPreview(null);
        toast.success(t('terraria.mods.packApplied'));
        await load();
        setBusy('');
        return;
      }
      const url = preview.action === 'remove'
        ? `${API}/${encodeURIComponent(preview.internalName)}`
        : `${API}/${encodeURIComponent(preview.internalName)}/${preview.action}`;
      const result = await api(url, {
        method: preview.action === 'remove' ? 'DELETE' : 'POST',
        headers: { 'Idempotency-Key': uuid() },
        body: { serverId: activeServerId, token: preview.token },
      });
      setRestartRequired(Boolean(result.restartRequired));
      setPreview(null);
      toast.success(t(`terraria.mods.${preview.action}Done`));
      await load();
    } catch (applyError) { toast.error(applyError.message); }
    setBusy('');
  }

  async function importFile(file) {
    if (!file) return;
    setBusy('import');
    try {
      const body = new FormData();
      body.append('file', file);
      const result = await api(`${API}/import/preview?serverId=${encodeURIComponent(activeServerId)}`, { method: 'POST', body });
      setPreview({ ...result.preview, action: 'import' });
    } catch (importError) { toast.error(importError.message); }
    setBusy('');
  }

  async function resolveWorkshop() {
    setBusy('workshop-resolve');
    try {
      const result = await api(`${API}/workshop/resolve`, { method: 'POST', body: { serverId: activeServerId, value: workshopValue } });
      setWorkshopItem(result.item);
    } catch (resolveError) { toast.error(resolveError.message); }
    setBusy('');
  }

  async function installWorkshop(value = workshopItem?.id) {
    setBusy('workshop-install');
    try {
      const result = await api(`${API}/workshop/install`, { method: 'POST', body: { serverId: activeServerId, value } });
      setPreview({ ...result.preview, action: 'import' });
    } catch (installError) { toast.error(installError.message); }
    setBusy('');
  }

  async function checkUpdates() {
    setBusy('updates');
    try {
      const result = await api(`${API}/updates?serverId=${encodeURIComponent(activeServerId)}&force=true`);
      setUpdates(result.updates || []);
    } catch (updateError) { toast.error(updateError.message); }
    setBusy('');
  }

  async function capturePack(name) {
    setBusy('pack-capture');
    try {
      await api(`${API}/modpacks`, { method: 'POST', body: { serverId: activeServerId, name } });
      toast.success(t('terraria.mods.packCaptured'));
      await load();
    } catch (packError) { toast.error(packError.message); }
    setBusy('');
  }

  async function importPack(file) {
    if (!file) return;
    setBusy('pack-import');
    try {
      const document = JSON.parse(await file.text());
      await api(`${API}/modpacks`, { method: 'POST', body: { serverId: activeServerId, document } });
      toast.success(t('terraria.mods.packImported'));
      await load();
    } catch (packError) { toast.error(packError.message); }
    setBusy('');
  }

  async function reviewPack(pack) {
    setBusy(`pack:${pack.id}`);
    try {
      const result = await api(`${API}/modpacks/${encodeURIComponent(pack.id)}/apply/preview`, {
        method: 'POST', body: { serverId: activeServerId },
      });
      setPreview({ ...result.preview, action: 'pack-apply' });
    } catch (packError) { toast.error(packError.message); }
    setBusy('');
  }

  async function exportPack(pack) {
    try {
      const exported = await api(`${API}/modpacks/${encodeURIComponent(pack.id)}/export?serverId=${encodeURIComponent(activeServerId)}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }));
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = `${pack.name.replace(/[^a-z0-9_-]+/gi, '-')}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (exportError) { toast.error(exportError.message); }
  }

  async function deletePack(pack) {
    setBusy(`pack-delete:${pack.id}`);
    try {
      await api(`${API}/modpacks/${encodeURIComponent(pack.id)}`, { method: 'DELETE', body: { serverId: activeServerId } });
      await load();
    } catch (packError) { toast.error(packError.message); }
    setBusy('');
  }

  async function restore(entry) {
    setBusy(`restore:${entry.id}`);
    try {
      const result = await api(`${API}/trash/${encodeURIComponent(entry.id)}/restore`, {
        method: 'POST',
        body: { serverId: activeServerId },
      });
      setRestartRequired(Boolean(result.restartRequired));
      toast.success(t('terraria.mods.restoreDone'));
      await load();
    } catch (restoreError) { toast.error(restoreError.message); }
    setBusy('');
  }

  if (!data && !error) return <Loading />;
  if (error && !data) return <ErrorState error={error} onRetry={load} />;

  const issues = data?.diagnostics?.issues || [];
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const planItems = previewPlanItems(preview?.plan);
  const hasReplacement = preview?.action === 'import' && planItems.some((item) => item.change === 'replace');
  const summaryItems = [...new Set(planItems.map((item) => item.change))]
    .map((change) => ({ change, count: planItems.filter((item) => item.change === change).length }));
  const applyLabel = t(`terraria.mods.review.${previewConfirmKey(preview?.action, hasReplacement)}`);

  return (
    <div className="space-y-6">
      <ViewHeader
        title={t('terraria.mods.title')}
        actions={<Button variant="glass" size="sm" onClick={() => { load(); browse(true); }}><RefreshCw className="h-3.5 w-3.5" />{t('common.refresh')}</Button>}
      />

      {!offline && (
        <Alert variant="warn">
          <AlertTriangle className="h-4 w-4" />
          <div className="flex flex-1 flex-wrap items-center justify-between gap-3">
            <div><strong>{t('terraria.mods.offlineTitle')}</strong><p>{t('terraria.mods.offlineHelp')}</p></div>
            <Button variant="glass" size="sm" onClick={stopServer} disabled={!canManage || busy === 'stop'}>
              <PowerOff className="h-4 w-4" />{t('terraria.mods.stopServer')}
            </Button>
          </div>
        </Alert>
      )}

      {!canManage && (
        <Alert variant="info"><ShieldAlert className="h-4 w-4" />{t('terraria.mods.readOnly')}</Alert>
      )}

      {error && data && (
        <Alert variant="error"><AlertTriangle className="h-4 w-4" />{error}</Alert>
      )}

      {restartRequired && (
        <Alert variant="info"><RefreshCw className="h-4 w-4" /><div><strong>{t('terraria.mods.restartTitle')}</strong><p>{t('terraria.mods.restartHelp')}</p></div></Alert>
      )}

      <Card>
        <CardContent>
          <Tabs value={tab} onValueChange={setTab}>
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1.5">
                <div className="px-1 text-label font-medium uppercase tracking-wider text-muted-foreground">
                  {t('terraria.mods.browseGroup')}
                </div>
                <TabsList>
                  <TabsTrigger value="workshop">{t('terraria.mods.tabWorkshop')}</TabsTrigger>
                  <TabsTrigger value="add">{t('terraria.mods.addTitle')}</TabsTrigger>
                </TabsList>
              </div>
              <div className="space-y-1.5 sm:border-l sm:border-border sm:pl-4">
                <div className="px-1 text-label font-medium uppercase tracking-wider text-muted-foreground">
                  {t('terraria.mods.manageGroup')}
                </div>
                <TabsList>
                  <TabsTrigger value="installed">{t('terraria.mods.installed')}</TabsTrigger>
                  <TabsTrigger value="updates">{t('terraria.mods.updatesTitle')}</TabsTrigger>
                  <TabsTrigger value="modpacks">{t('terraria.mods.modpacksTitle')}</TabsTrigger>
                  <TabsTrigger value="quarantine">{t('terraria.mods.tabQuarantine')}</TabsTrigger>
                </TabsList>
              </div>
            </div>

            <TabsContent value="workshop">
              <form onSubmit={(event) => { event.preventDefault(); browse(true); }} className="flex flex-wrap gap-2 mb-5">
                <div className="flex items-center gap-2 flex-1 min-w-48">
                  <Input
                    value={catalogQuery}
                    onChange={(event) => setCatalogQuery(event.target.value)}
                    placeholder={t('terraria.mods.catalog.searchPlaceholder')}
                    aria-label={t('terraria.mods.catalog.searchPlaceholder')}
                    className="flex-1"
                  />
                </div>
                <Input
                  value={catalogTag}
                  onChange={(event) => setCatalogTag(event.target.value)}
                  placeholder={t('terraria.mods.catalog.tagPlaceholder')}
                  aria-label={t('terraria.mods.catalog.tagPlaceholder')}
                  className="w-36"
                />
                <select
                  className={SELECT_CLASS}
                  value={catalogSort}
                  onChange={(event) => setCatalogSort(event.target.value)}
                  aria-label={t('terraria.mods.catalog.sort')}
                >
                  <option value="trend">{t('terraria.mods.catalog.sortTrending')}</option>
                  <option value="recent">{t('terraria.mods.catalog.sortRecent')}</option>
                  <option value="updated">{t('terraria.mods.catalog.sortUpdated')}</option>
                  <option value="subscribed">{t('terraria.mods.catalog.sortSubscribed')}</option>
                </select>
                <Button type="submit" variant="default" disabled={busy === 'catalog'}>
                  <Search className="h-3.5 w-3.5" />
                  {t('terraria.mods.catalog.search')}
                </Button>
              </form>

              {catalog?.stale && (
                <Alert variant="warn" className="mb-4"><Clock3 className="h-4 w-4" />{t('terraria.mods.catalog.fallback')}</Alert>
              )}

              {!catalog ? (
                <Loading />
              ) : catalog.items?.length > 0 ? (
                <div className="space-y-2">
                  {catalog.items.map((item) => (
                    <div key={item.id} className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/20 p-3 hover:bg-secondary/40 transition-colors">
                      {item.previewUrl ? (
                        <img src={item.previewUrl} alt="" loading="lazy" className="h-12 w-12 rounded shrink-0 object-cover"
                          onError={(event) => { event.target.style.visibility = 'hidden'; }} />
                      ) : (
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                          <PackageOpen className="h-5 w-5" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm text-foreground truncate">{item.title || t('terraria.mods.catalog.untitled', { id: item.id })}</div>
                        <div className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{item.description || t('terraria.mods.catalog.noDescription')}</div>
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
                        <Button variant="default" size="sm" disabled={!canManage || !offline || Boolean(busy)} onClick={() => installWorkshop(item.id)}>
                          <Download className="h-3.5 w-3.5" />
                          {t('terraria.mods.catalog.review')}
                        </Button>
                        <Button asChild variant="glass" size="sm">
                          <a href={item.url} target="_blank" rel="noreferrer">
                            <ArrowUpRight className="h-3.5 w-3.5" />
                            {t('terraria.mods.catalog.details')}
                          </a>
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={FolderSearch}
                  title={t('terraria.mods.catalog.noResults')}
                  message={t('terraria.mods.catalog.noResultsHelp')}
                  action={(
                    <Button asChild variant="glass">
                      <a href={catalog.fallbackUrl} target="_blank" rel="noreferrer">
                        <ArrowUpRight className="h-3.5 w-3.5" />
                        {t('terraria.mods.catalog.openWorkshop')}
                      </a>
                    </Button>
                  )}
                />
              )}
            </TabsContent>

            <TabsContent value="add">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-lg border border-border/60 bg-secondary/10 p-4">
                  <p className="mb-3 text-xs text-muted-foreground">{t('terraria.mods.localHelp')}</p>
                  <Button asChild variant="glass" className="w-full" disabled={!canManage || !offline || Boolean(busy)}>
                    <label>
                      <FileUp className="h-4 w-4" />
                      {t('terraria.mods.localImport')}
                      <input className="sr-only" type="file" accept=".tmod,.zip" onChange={(event) => importFile(event.target.files?.[0])} />
                    </label>
                  </Button>
                </div>
                <div className="rounded-lg border border-border/60 bg-secondary/10 p-4">
                  <p className="mb-3 text-xs text-muted-foreground">{t('terraria.mods.workshopHelp')}</p>
                  <div className="flex gap-2">
                    <Input
                      value={workshopValue}
                      onChange={(event) => { setWorkshopValue(event.target.value); setWorkshopItem(null); }}
                      placeholder={t('terraria.mods.workshopPlaceholder')}
                    />
                    <Button variant="glass" onClick={resolveWorkshop} disabled={!workshopValue.trim() || busy === 'workshop-resolve'}>
                      {t('terraria.mods.resolveWorkshop')}
                    </Button>
                  </div>
                  {workshopItem && (
                    <div className="mt-3 rounded-md border border-border/60 bg-secondary/20 p-3">
                      <strong className="text-sm">{workshopItem.title}</strong>
                      <p className="mt-1 text-xs text-muted-foreground">#{workshopItem.id} · {workshopItem.fileSize ? fmtBytes(workshopItem.fileSize) : '—'}</p>
                      <Button variant="default" size="sm" className="mt-3 w-full" onClick={() => installWorkshop()} disabled={!canManage || !offline || Boolean(busy)}>
                        <Download className="h-3.5 w-3.5" />
                        {t('terraria.mods.workshopInstall')}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="installed">
              {!data.mods.length && !data.unreadable.length ? (
                <p className="text-sm text-muted-foreground italic">{t('terraria.mods.empty')} · {t('terraria.mods.emptyHelp')}</p>
              ) : (
                <div className="space-y-2">
                  {data.mods.map((mod) => {
                    const modIssues = issuesByMod.get(mod.internalName) || [];
                    return (
                      <div key={mod.file} className="rounded-lg border border-border/60 bg-secondary/20 p-3 hover:bg-secondary/40 transition-colors">
                        <div className="flex items-center gap-3">
                          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                            <PackageOpen className="h-5 w-5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-sm text-foreground truncate">{mod.displayName}</span>
                              <Badge variant={mod.enabled ? 'online' : 'offline'}>{mod.enabled ? t('terraria.mods.enabled') : t('terraria.mods.disabled')}</Badge>
                              <Badge variant="default">{t(`terraria.mods.source.${mod.source}`)}</Badge>
                              {modIssues.length > 0 && <Badge variant="destructive">{t('terraria.mods.issueCount', { count: modIssues.length })}</Badge>}
                            </div>
                            <div className="text-xs text-muted-foreground/60 mt-1 truncate">
                              {mod.internalName} · v{mod.version} · tML {mod.tmlVersion} · {fmtBytes(mod.sizeBytes)}{mod.author ? ` · ${t('terraria.mods.by', { author: mod.author })}` : ''}
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-2">
                            <Button
                              variant="glass"
                              size="sm"
                              disabled={!canManage || !offline || Boolean(busy)}
                              onClick={() => review(mod, mod.enabled ? 'disable' : 'enable')}
                            >
                              {mod.enabled ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                              {t(`terraria.mods.${mod.enabled ? 'disable' : 'enable'}`)}
                            </Button>
                            <Button variant="destructive" size="sm" disabled={!canManage || !offline || Boolean(busy)} onClick={() => reviewRemove(mod)}>
                              <Trash2 className="h-3.5 w-3.5" />
                              {t('common.remove')}
                            </Button>
                          </div>
                        </div>
                        {modIssues.length > 0 && (
                          <div className="mt-3 space-y-2 border-t border-border/60 pt-2">
                            {modIssues.map((issue, index) => (
                              <div key={`${issue.code}:${index}`} className="text-xs">
                                <p className="font-medium text-status-error">{issue.detail}</p>
                                <p className="text-muted-foreground">{issue.suggestion}</p>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {data.unreadable.map((item) => (
                    <div key={item.file} className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/20 p-3">
                      <FileWarning className="h-5 w-5 shrink-0 text-status-error" />
                      <div className="min-w-0">
                        <div className="break-all font-semibold text-sm text-foreground">{item.file}</div>
                        <div className="mt-0.5 break-words text-xs text-muted-foreground">{item.reason}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-label text-muted-foreground/70 pt-2 break-all">{data.modsDir}</p>
            </TabsContent>

            <TabsContent value="updates">
              <p className="mb-3 text-xs text-muted-foreground">{t('terraria.mods.updatesHelp')}</p>
              <Button variant="default" size="sm" onClick={checkUpdates} disabled={busy === 'updates'}>
                <RefreshCw className="h-3.5 w-3.5" />
                {t('terraria.mods.checkUpdates')}
              </Button>
              {updates.length > 0 && (
                <div className="mt-4 space-y-2">
                  {updates.map((update) => (
                    <div key={update.internalName} className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/20 p-3 hover:bg-secondary/40 transition-colors">
                      <div className="flex-1 min-w-0">
                        <span className="font-semibold text-sm text-foreground truncate">{update.displayName}</span>
                      </div>
                      <Badge variant={update.state === 'update-ready' ? 'softWarn' : 'default'}>{t(`terraria.mods.updateState.${update.state}`)}</Badge>
                      {update.state === 'update-ready' && (
                        <Button size="sm" variant="default" onClick={() => installWorkshop(update.workshopId)} disabled={!canManage || !offline || Boolean(busy)}>
                          <Download className="h-3.5 w-3.5" />
                          {t('terraria.mods.reviewUpdate')}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="modpacks">
              <p className="mb-3 text-xs text-muted-foreground">{t('terraria.mods.modpacksHelp')}</p>
              <div className="mb-4 flex flex-wrap gap-2">
                <Button variant="default" size="sm" onClick={() => setCaptureOpen(true)} disabled={!canManage || Boolean(busy)}>
                  <Save className="h-3.5 w-3.5" />
                  {t('terraria.mods.capturePack')}
                </Button>
                <Button asChild variant="glass" size="sm" disabled={!canManage || Boolean(busy)}>
                  <label>
                    <FileUp className="h-3.5 w-3.5" />
                    {t('terraria.mods.importPack')}
                    <input className="sr-only" type="file" accept=".json" onChange={(event) => importPack(event.target.files?.[0])} />
                  </label>
                </Button>
              </div>
              {!packs.length ? (
                <p className="text-sm text-muted-foreground italic">{t('terraria.mods.noPacks')}</p>
              ) : (
                <div className="space-y-2">
                  {packs.map((pack) => (
                    <div key={pack.id} className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/20 p-3 hover:bg-secondary/40 transition-colors">
                      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground">
                        <FileJson className="h-5 w-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-sm text-foreground truncate">{pack.name}</span>
                          {pack.active && <Badge variant="online">{t('terraria.mods.activePack')}</Badge>}
                        </div>
                        <div className="text-xs text-muted-foreground/60 mt-1">{t('terraria.mods.packCount', { count: pack.modCount })}</div>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button size="sm" variant="default" onClick={() => reviewPack(pack)} disabled={!canManage || !offline || Boolean(busy)}>
                          {t('terraria.mods.applyPack')}
                        </Button>
                        <Button size="sm" variant="glass" onClick={() => exportPack(pack)} aria-label={t('terraria.mods.exportPack')}>
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => deletePack(pack)} disabled={!canManage || Boolean(busy)} aria-label={t('common.remove')}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>

            <TabsContent value="quarantine">
              {!data.trash.length ? (
                <p className="text-sm text-muted-foreground italic">{t('terraria.mods.quarantineEmpty')}</p>
              ) : (
                <div className="space-y-2">
                  {data.trash.map((entry) => (
                    <div key={entry.id} className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/20 p-3 hover:bg-secondary/40 transition-colors">
                      <div className="flex-1 min-w-0">
                        <div className="break-all font-semibold text-sm text-foreground">{entry.label}</div>
                        <div className="text-xs text-muted-foreground/60 mt-1">{fmtBytes(entry.sizeBytes)} · {new Date(entry.trashedAt).toLocaleString()}</div>
                      </div>
                      <Button variant="glass" size="sm" disabled={!canManage || !offline || !entry.restorable || Boolean(busy)} onClick={() => restore(entry)}>
                        <ArchiveRestore className="h-3.5 w-3.5" />
                        {t('terraria.mods.restore')}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {issues.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><ShieldAlert className="h-4 w-4" />{t('terraria.mods.diagnostics')}</CardTitle>
            <Badge variant={errors ? 'destructive' : 'softWarn'}>{t('terraria.mods.issueCount', { count: issues.length })}</Badge>
          </CardHeader>
          <CardContent className="divide-y divide-border p-0">
            {issues.map((issue, index) => (
              <div key={`${issue.code}:${issue.mod}:${index}`} className="grid gap-1 px-5 py-3 sm:grid-cols-[auto_1fr]">
                <Badge className="w-fit" variant={issueVariant(issue.severity)}>{t(`terraria.mods.severity.${issue.severity}`)}</Badge>
                <div>
                  <p className="text-sm font-medium">{issue.detail}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{issue.suggestion}</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={Boolean(preview)} onOpenChange={(open) => { if (!open && !busy) setPreview(null); }}>
        <DialogContent className="flex max-w-2xl flex-col !overflow-hidden">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t(`terraria.mods.preview.${preview?.action || 'enable'}`)}</DialogTitle>
            <DialogDescription>
              {preview?.action === 'import'
                ? t('terraria.mods.review.importIntro')
                : preview?.action === 'pack-apply'
                  ? t('terraria.mods.packPreviewHelp', { name: preview?.pack?.name || '' })
                  : t('terraria.mods.previewHelp', { name: preview?.displayName || '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="min-h-0 flex-1 space-y-4">
            <div className="flex items-start gap-3 border-2 border-primary/35 bg-primary/10 p-4">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              <div className="min-w-0">
                <p className="font-semibold text-foreground">{t('terraria.mods.review.notApplied')}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{t('terraria.mods.review.reviewStep')}</p>
              </div>
            </div>

            {preview?.action === 'import' && (
              <div className="flex flex-wrap items-center gap-2 border border-border bg-secondary/20 px-3 py-2 text-xs">
                <Badge variant="default"><Download className="h-3.5 w-3.5" />{preview.detail ? t('terraria.mods.review.sourceWorkshop') : t('terraria.mods.review.sourceLocal')}</Badge>
                {preview.detail?.id && <span className="text-muted-foreground">{t('terraria.mods.review.workshopItem', { id: preview.detail.id })}</span>}
                {preview.detail?.title && <span className="min-w-0 truncate font-semibold text-foreground">{preview.detail.title}</span>}
              </div>
            )}

            {planItems.length > 0 && (
              <>
                <div className="flex items-end justify-between gap-3">
                  <h3 className="font-display text-sm font-extrabold uppercase tracking-wide">{t('terraria.mods.review.changeList')}</h3>
                  <span className="text-xs text-muted-foreground">{planItems.length}</span>
                </div>
                <div className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4">
                  {summaryItems.map(({ change, count }) => (
                    <div key={change} className="bg-card px-3 py-2.5">
                      <strong className="block text-lg leading-none text-foreground">{count}</strong>
                      <span className="mt-1 block text-label font-semibold uppercase tracking-wider text-muted-foreground">{t(`terraria.mods.review.summary.${previewSummaryKey(change)}`)}</span>
                    </div>
                  ))}
                </div>
                <div role="list" aria-label={t('terraria.mods.review.changeList')} className="max-h-72 divide-y divide-border overflow-auto border border-border">
                  {planItems.map((item, index) => (
                    <div key={`${item.internalName || item.displayName || 'mod'}:${item.change}:${index}`} role="listitem" className="flex items-start gap-3 p-3">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-secondary text-muted-foreground">
                        <PreviewChangeIcon change={item.change} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="min-w-0 break-words font-semibold text-sm text-foreground">{item.displayName || item.internalName}</span>
                          <Badge variant={previewChangeVariant(item.change)}>{t(`terraria.mods.review.change.${item.change}`)}</Badge>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          {item.internalName && <code>{item.internalName}</code>}
                          {item.change === 'replace' && item.installedVersion && item.version
                            ? <span>{t('terraria.mods.review.versionChange', { current: item.installedVersion, next: item.version })}</span>
                            : item.version
                              ? <span>{t('terraria.mods.review.versionOnly', { version: item.version })}</span>
                              : <span>{t('terraria.mods.review.versionUnknown')}</span>}
                          {item.author && <span>{t('terraria.mods.by', { author: item.author })}</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {!planItems.length && preview?.displayName && (
              <div className="border border-border bg-secondary/20 p-3">
                <p className="font-semibold text-foreground">{preview.displayName}</p>
                {preview.internalName && <code className="mt-1 block text-xs text-muted-foreground">{preview.internalName}</code>}
                {preview.file && <p className="mt-1 text-xs text-muted-foreground">{preview.file}</p>}
              </div>
            )}

            {hasReplacement && (
              <div className="space-y-3 border border-status-warn/35 bg-status-warn/10 p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" />
                  <div>
                    <p className="text-sm font-semibold text-foreground">{t('terraria.mods.review.replaceNotice')}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t('terraria.mods.review.replaceHelp')}</p>
                  </div>
                </div>
                <label className="flex cursor-pointer items-start gap-3 border-t border-status-warn/25 pt-3">
                  <Checkbox checked={replaceConfirmed} onCheckedChange={(checked) => setReplaceConfirmed(checked === true)} />
                  <span className="text-sm text-foreground">{t('terraria.mods.review.confirmReplaceLabel')}</span>
                </label>
              </div>
            )}

            {preview?.blocked && (
              <Alert variant="warn"><AlertTriangle className="h-4 w-4" /><div><strong>{t('terraria.mods.review.blockedTitle')}</strong><p>{t('terraria.mods.review.blockedHelp')}</p></div></Alert>
            )}

            <div className="grid gap-px border border-border bg-border sm:grid-cols-2">
              <div className="flex items-start gap-2 bg-secondary/20 p-3">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-status-online" />
                <div><p className="text-sm font-semibold text-foreground">{t('terraria.mods.review.snapshotTitle')}</p><p className="mt-0.5 text-xs text-muted-foreground">{t('terraria.mods.review.snapshotHelp')}</p></div>
              </div>
              <div className="flex items-start gap-2 bg-secondary/20 p-3">
                <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div><p className="text-sm font-semibold text-foreground">{t('terraria.mods.review.restartTitle')}</p><p className="mt-0.5 text-xs text-muted-foreground">{t('terraria.mods.review.restartHelp')}</p></div>
              </div>
            </div>
          </DialogBody>
          <DialogFooter className="shrink-0">
            <Button variant="glass" onClick={() => setPreview(null)} disabled={busy === 'apply'}>{t('common.cancel')}</Button>
            <Button variant={preview?.action === 'remove' ? 'destructive' : 'default'} onClick={apply} disabled={!canManage || busy === 'apply' || preview?.blocked || (hasReplacement && !replaceConfirmed)}>
              <CheckCircle2 className="h-4 w-4" />
              {applyLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <PromptDialog
        open={captureOpen}
        onOpenChange={setCaptureOpen}
        title={t('terraria.mods.capturePack')}
        label={t('terraria.mods.packName')}
        placeholder={t('terraria.mods.packName')}
        confirmLabel={t('terraria.mods.capturePack')}
        onSubmit={capturePack}
      />
    </div>
  );
}
