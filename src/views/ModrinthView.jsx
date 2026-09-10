import { useState, useEffect, useMemo, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { ViewHeader } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger, DialogBody, DialogFooter } from '@/components/ui/dialog';
import { useApi } from '@/hooks/useApi';
import { useFolderPicker } from '@/hooks/useFolderPicker';
import { useT } from '@/context/I18nContext';
import { useServer } from '@/context/ServerContext';
import { osExamplePath } from '@/lib/utils';
import { jarIsModLoader } from '@/lib/compat';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Search, Download, Check, FolderOpen, Package, Upload } from 'lucide-react';
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
  const [selected, setSelected] = useState(new Set());
  const [batchInstalling, setBatchInstalling] = useState(false);

  async function search() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ q, sort, category, projectType });
      const data = await api(`/api/modrinth/search?${params.toString()}`);
      setNote(data.note || '');
      if (data.categories && !categories.length) setCategories(data.categories);
      setResults(data.hits || []);
      setSelected(new Set());
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

  async function installSelected() {
    const projectIds = results
      .map((item) => item.project_id || item.slug)
      .filter((projectId) => selected.has(projectId) && !installing[projectId]);
    if (!projectIds.length || batchInstalling) return;
    setBatchInstalling(true);
    setInstalling((current) => ({
      ...current,
      ...Object.fromEntries(projectIds.map((projectId) => [projectId, 'downloading'])),
    }));
    try {
      const result = await api('/api/modrinth/install-batch', {
        method: 'POST',
        body: { projectIds, projectType },
      });
      setInstalling((current) => {
        const next = { ...current };
        for (const item of result.results || []) next[item.projectId] = item.status === 'installed' ? 'done' : null;
        return next;
      });
      if (result.installed.length) toast.success(t('minecraft.modrinth.installedSelected', { count: result.installed.length }));
      if (result.failed.length) toast.error(t('minecraft.modrinth.installedSelectedPartial', { count: result.installed.length, failed: result.failed.length }));
      setSelected(new Set());
      onInstalled?.(result);
    } catch (e) {
      toast.error(e.message);
      setInstalling((current) => {
        const next = { ...current };
        for (const projectId of projectIds) next[projectId] = null;
        return next;
      });
    } finally { setBatchInstalling(false); }
  }

  const selectableResults = results.filter((item) => !installing[item.project_id || item.slug]);
  const selectedVisibleCount = selectableResults.filter((item) => selected.has(item.project_id || item.slug)).length;
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
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border/60 bg-secondary/10 px-3 py-2">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Checkbox
                checked={selectableResults.length > 0 && selectedVisibleCount === selectableResults.length}
                onCheckedChange={(checked) => setSelected(new Set(checked ? selectableResults.map((item) => item.project_id || item.slug) : []))}
                aria-label={t('minecraft.modrinth.selectAll')}
              />
              {t('minecraft.modrinth.selectAll')}
            </label>
            <span className="text-xs text-muted-foreground">{t('minecraft.modrinth.selectedCount', { count: selectedVisibleCount })}</span>
            <Button
              type="button"
              size="sm"
              variant="default"
              className="ml-auto"
              disabled={!selectedVisibleCount || batchInstalling || Object.values(installing).some((value) => value === 'downloading' || value === 'finding')}
              onClick={installSelected}
            >
              <Download className="h-3.5 w-3.5" />
              {t('minecraft.modrinth.installSelected')}
            </Button>
          </div>
          {results.map(h => {
            const state = installing[h.project_id || h.slug];
            return (
              <div key={h.project_id || h.slug} className="flex items-center gap-3 rounded-lg border border-border/60 bg-secondary/20 p-3 hover:bg-secondary/40 transition-colors">
                <Checkbox
                  checked={selected.has(h.project_id || h.slug)}
                  disabled={!!state || batchInstalling}
                  onCheckedChange={(checked) => setSelected((current) => {
                    const next = new Set(current);
                    const id = h.project_id || h.slug;
                    if (checked) next.add(id); else next.delete(id);
                    return next;
                  })}
                  aria-label={t('minecraft.modrinth.selectItem', { name: h.title })}
                />
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

function useContentOperation(operationId) {
  const api = useApi();
  const [op, setOp] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    setOp(null);
    if (!operationId) return;
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      try {
        const data = await api(`/api/operations/${encodeURIComponent(operationId)}`);
        if (cancelled) return;
        setOp(data.operation || null);
        const state = data.operation?.state;
        if (state === 'queued' || state === 'running') timer = setTimeout(poll, 1200);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    };
    poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [api, operationId]);
  return { op, error };
}

function UploadSource({ provider, kind, accept, label, fields = {}, disabled = false, onApplied }) {
  const api = useApi();
  const input = useRef(null);
  const [busy, setBusy] = useState(false);
  const [operationId, setOperationId] = useState(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyOpId, setApplyOpId] = useState(null);
  const [eulaAck, setEulaAck] = useState(false);
  const { op, error: inspectionError } = useContentOperation(operationId);
  const { op: applyOp, error: applyError } = useContentOperation(applyOpId);
  const inspecting = !!operationId && (!op || ['queued', 'running'].includes(op.state));
  const applying = !!applyOpId && (!applyOp || ['queued', 'running'].includes(applyOp.state));
  const preview = op?.state === 'succeeded' ? (op.summary || {}) : null;
  const failed = op?.state === 'failed' ? (op.error?.text || op.error?.code || 'Inspection failed') : '';

  const upload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setOperationId(null);
    setApplyOpId(null);
    setEulaAck(false);
    try {
      const form = new FormData();
      form.set('file', file); form.set('provider', provider); form.set('kind', kind);
      for (const [k, v] of Object.entries(fields || {})) if (v !== '' && v != null) form.set(k, String(v));
      const result = await api('/api/minecraft/content/upload-previews', { method: 'POST', body: form });
      setOperationId(result.operationId);
      toast.success(`Inspection started · ${result.operationId}`);
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); event.target.value = ''; }
  };

  const apply = async () => {
    if (!operationId) return;
    setApplyBusy(true);
    try {
      const body = {};
      if (provider === 'ftb') {
        if (!eulaAck) { toast.error('Explicit Minecraft EULA acknowledgement is required.'); setApplyBusy(false); return; }
        body.acceptEula = true;
      }
      const result = await api(`/api/minecraft/content/uploads/${encodeURIComponent(operationId)}/apply`, { method: 'POST', body });
      setApplyOpId(result.operationId);
      toast.success(`Apply started · ${result.operationId}`);
    } catch (error) { toast.error(error.message); }
    finally { setApplyBusy(false); }
  };

  useEffect(() => {
    if (applyOp?.state === 'succeeded') {
      toast.success(provider === 'curseforge' && kind !== 'modpack' ? 'Imported. Restart the server to apply.' : 'Installed.');
      onApplied?.();
    } else if (applyOp?.state === 'failed') {
      toast.error(applyOp.error?.text || 'Apply failed');
    }
  }, [applyOp?.state]);

  const summaryText = preview ? (preview.name || preview.installerName || (preview.files ? `${preview.files.length} files` : preview.sha256 || 'ready')) : '';

  return <div className="flex flex-wrap items-center gap-3" aria-live="polite">
    <input ref={input} type="file" accept={accept} className="hidden" onChange={upload} />
    <Button variant="outline" size="sm" disabled={busy || inspecting || applying || applyBusy || disabled} onClick={() => input.current?.click()}><Upload className="h-3.5 w-3.5" />{busy ? 'Preparing…' : label}</Button>
    {operationId && (!op || op.state === 'queued' || op.state === 'running') && <span className="text-xs text-muted-foreground">Inspecting…</span>}
    {(inspectionError || applyError) && <p role="alert" className="text-xs text-status-error">{inspectionError || applyError}</p>}
    {applyOp?.state === 'failed' && <p role="alert" className="text-xs text-status-error">{applyOp.error?.text || 'Installation failed. Try again.'}</p>}
    {failed && <span role="alert" className="text-xs text-status-error">{failed}</span>}
    {preview && <span className="text-xs text-muted-foreground">Ready · {String(summaryText).slice(0, 80)}</span>}
    {provider === 'ftb' && preview && <label className="flex items-center gap-2 text-xs"><Checkbox checked={eulaAck} onCheckedChange={(v) => setEulaAck(v === true)} />I accept the Minecraft EULA</label>}
    {preview && <Button variant="default" size="default" disabled={applyBusy || applying || applyOp?.state === 'succeeded' || (provider === 'ftb' && !eulaAck)} onClick={apply}>{applyOp?.state === 'succeeded' ? 'Installed' : applyBusy || applying ? 'Installing…' : `Install ${kind}`}</Button>}
    {applyOpId && applyOp && (applyOp.state === 'running' || applyOp.state === 'queued') && <span className="text-xs text-muted-foreground">Applying…</span>}
  </div>;
}

function FtbOfficialPrepare() {
  const api = useApi();
  const [packId, setPackId] = useState('');
  const [versionId, setVersionId] = useState('');
  const [latest, setLatest] = useState(true);
  const [eula, setEula] = useState(false);
  const [operationId, setOperationId] = useState(null);
  const [busy, setBusy] = useState(false);
  const { op } = useContentOperation(operationId);
  const prepare = async () => {
    setBusy(true);
    try {
      const result = await api('/api/minecraft/content/previews', { method: 'POST', body: { provider: 'ftb', packId, versionId: latest ? undefined : versionId, latest, acceptEula: eula } });
      setOperationId(result.operationId);
      toast.success(`FTB prepare started · ${result.operationId}`);
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  };
  return <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 bg-secondary/10 p-2">
    <span className="text-xs font-medium">FTB official</span>
    <Input value={packId} onChange={(e) => setPackId(e.target.value)} placeholder="Pack ID" aria-label="Official FTB pack ID" inputMode="numeric" className="h-10 w-32 text-xs" />
    {!latest && <Input value={versionId} onChange={(e) => setVersionId(e.target.value)} placeholder="Version ID" aria-label="Official FTB version ID" inputMode="numeric" className="h-10 w-32 text-xs" />}
    <label className="flex items-center gap-1 text-xs"><Checkbox checked={latest} onCheckedChange={(v) => setLatest(v === true)} />latest</label>
    <label className="flex items-center gap-1 text-xs"><Checkbox checked={eula} onCheckedChange={(v) => setEula(v === true)} />I accept the Minecraft EULA</label>
    <Button variant="outline" size="sm" disabled={busy || !packId || (!latest && !versionId) || !eula} onClick={prepare}>{busy ? 'Preparing…' : 'Prepare'}</Button>
    {op?.state === 'succeeded' && <span className="text-xs text-muted-foreground">Prepared · upload the matching installer below, then Apply.</span>}
    {op?.state === 'failed' && <span className="text-xs text-status-error">{op.error?.text || 'Prepare failed'}</span>}
  </div>;
}

function ProviderActions({ kind, onApplied }) {
  const [ftbAttested, setFtbAttested] = useState(false);
  const [ftbEula, setFtbEula] = useState(false);
  const [ftbPackId, setFtbPackId] = useState('');
  const [ftbVersionId, setFtbVersionId] = useState('');
  const [ftbLatest, setFtbLatest] = useState(true);
  const isPack = kind === 'modpack';
  const validFtb = /^\d+$/.test(ftbPackId) && (ftbLatest || /^\d+$/.test(ftbVersionId));
  return <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-4">
    <div>
      <p className="text-sm font-semibold">Browse Modrinth</p>
      <p className="mt-1 text-xs text-muted-foreground">{isPack ? 'Find a modpack below, or import one you already have.' : `Find ${kind}s below, or import a JAR from your computer.`}</p>
    </div>
    <Dialog>
      <DialogTrigger asChild><Button variant="outline" size="default"><Upload />Import {isPack ? 'modpack' : `${kind} JAR`}</Button></DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader className="pr-12">
          <DialogTitle>Import {isPack ? 'a modpack' : `a ${kind}`}</DialogTitle>
          <DialogDescription>Choose a file, review the inspection, then install.</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-5">
          {isPack ? <Tabs defaultValue="curseforge">
            <TabsList className="mb-5"><TabsTrigger value="curseforge">CurseForge ZIP</TabsTrigger><TabsTrigger value="ftb">FTB installer</TabsTrigger></TabsList>
            <TabsContent value="curseforge" forceMount className="space-y-4 data-[state=inactive]:hidden">
              <div><h3 className="text-sm font-semibold">Import from CurseForge</h3><p className="mt-2 text-sm text-muted-foreground">Select the modpack ZIP downloaded from CurseForge. Keep it zipped for inspection.</p></div>
              <UploadSource provider="curseforge" kind="modpack" accept=".zip,application/zip" label="Choose ZIP file" onApplied={onApplied} />
            </TabsContent>
            <TabsContent value="ftb" forceMount className="space-y-5 data-[state=inactive]:hidden">
              <div><h3 className="text-sm font-semibold">Import an FTB server installer</h3><p className="mt-2 text-sm text-muted-foreground">Use the server installer from Feed The Beast for this computer (.exe, .sh or .bin). Enter the pack it should install.</p></div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <label className="space-y-2 text-sm font-medium"><span>FTB pack ID</span><Input inputMode="numeric" value={ftbPackId} onChange={(e) => setFtbPackId(e.target.value.trim())} placeholder="Numeric pack ID" /></label>
                <label className="space-y-2 text-sm font-medium"><span>Pack version</span><select aria-label="Pack version" className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={ftbLatest ? 'latest' : 'specific'} onChange={(e) => setFtbLatest(e.target.value === 'latest')}><option value="latest">Latest version</option><option value="specific">Specific version</option></select></label>
                {!ftbLatest && <label className="space-y-2 text-sm font-medium"><span>FTB version ID</span><Input inputMode="numeric" value={ftbVersionId} onChange={(e) => setFtbVersionId(e.target.value.trim())} placeholder="Numeric version ID" /></label>}
              </div>
              <div className="space-y-3 border-t border-border/60 pt-4">
                <label className="flex min-h-11 items-start gap-3 text-sm sm:min-h-0"><Checkbox className="mt-0.5 min-h-4" checked={ftbAttested} onCheckedChange={(v) => setFtbAttested(v === true)} />I downloaded this installer from Feed The Beast.</label>
                <label className="flex min-h-11 items-start gap-3 text-sm sm:min-h-0"><Checkbox className="mt-0.5 min-h-4" checked={ftbEula} onCheckedChange={(v) => setFtbEula(v === true)} /><span>I accept the <a className="text-primary underline underline-offset-4" href="https://www.minecraft.net/eula" target="_blank" rel="noreferrer">Minecraft EULA</a>.</span></label>
              </div>
              <p className="text-xs text-muted-foreground">{!validFtb ? 'Enter a numeric pack ID and choose a version to continue.' : !ftbAttested || !ftbEula ? 'Confirm the installer source and accept the EULA to choose your file.' : 'Choose your installer to inspect it before installation.'}</p>
              <UploadSource provider="ftb" kind="modpack" accept=".exe,.sh,.bin,application/octet-stream" label="Choose FTB installer" disabled={!validFtb || !ftbAttested || !ftbEula} fields={{ attested: 'true', acceptEula: ftbEula ? 'true' : '', packId: ftbPackId, versionId: ftbLatest ? '' : ftbVersionId, latest: ftbLatest ? 'true' : '' }} onApplied={onApplied} />
              <details className="border-t border-border/60 pt-4"><summary className="cursor-pointer text-sm text-muted-foreground">Advanced: prepare an official FTB installer</summary><p className="my-3 text-xs text-muted-foreground">Preparation is separate from installation. You will still need to upload the matching installer.</p><FtbOfficialPrepare /></details>
            </TabsContent>
          </Tabs> : <>
            <div><h3 className="text-sm font-semibold">Choose a {kind} JAR</h3><p className="mt-2 text-sm text-muted-foreground">Upload a .jar file from CurseForge or your computer. Use a {kind} that matches your server software and Minecraft version.</p></div>
            <UploadSource provider="curseforge" kind={kind} accept=".jar,application/java-archive" label="Choose JAR file" onApplied={onApplied} />
          </>}
        </DialogBody>
      </DialogContent>
    </Dialog>
  </div>;
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

function ModpacksInstallDialog({ open, onOpenChange, projectId, onInstalled }) {
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
        <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{item.display_name || item.projectName || item.project_id}</span><Badge variant="softPrimary">{item.provider || 'modrinth'}</Badge><Badge variant="default">{item.verification_status || 'verified'}</Badge><Badge variant="outline">{item.loader}</Badge><Badge variant="default">MC {item.mc_version}</Badge></div>
        <p className="mt-1 text-sm text-muted-foreground">{item.versionName || item.versionNumber || item.version_id}</p>
        <p className="mt-2 text-xs text-muted-foreground">{t('minecraft.modrinth.packFiles', { count: item.file_count })} · {t('minecraft.modrinth.packInstalledAt', { date: new Date(item.installed_at).toLocaleString() })}</p>
      </div>
    </div>
  ))}</div>;
}

export function ContentView() {
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
            <ProviderActions kind="plugin" onApplied={() => setInstalledPackRefreshKey((k) => k + 1)} />
            <ModrinthResults compat={compat} projectType="plugin" />
          </TabsContent>
          <TabsContent value="mods">
            <ProviderActions kind="mod" onApplied={() => setInstalledPackRefreshKey((k) => k + 1)} />
            <ModsTab compat={compat} serverLabel={compat?.label} />
          </TabsContent>
          <TabsContent value="modpacks">
            <ProviderActions kind="modpack" onApplied={() => handleModpackInstalled({}, 'existing')} />
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

export const ModrinthView = ContentView;
