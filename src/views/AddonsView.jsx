import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { ViewHeader, useSectionPage } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorState } from '@/components/shared/ErrorState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Loading } from '@/components/shared/Loading';
import { useApi } from '@/hooks/useApi';
import { useServer } from '@/context/ServerContext';
import { useT } from '@/context/I18nContext';
import { serverAddonKind } from '@/lib/compat';
import { fmtBytes } from '@/lib/utils';
import { toast } from 'sonner';
import { RefreshCw, Trash2, Upload, Package, Power, PowerOff, Search } from 'lucide-react';
import { PalworldModsView } from '@/views/PalworldModsView';

export function AddonsView() {
  const api = useApi();
  const t = useT();
  const section = useSectionPage();
  const { servers, activeServerId, getServerStatus } = useServer();
  const [kind, setKind] = useState(null);
  const [addons, setAddons] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);
  const [selected, setSelected] = useState(new Set());

  const activeServer = useMemo(
    () => servers.find(s => s.id === activeServerId) || null,
    [servers, activeServerId]
  );
  const status = getServerStatus(activeServerId).status;
  const offline = status === 'offline';
  // Start on whichever folder this server actually loads from, but leave the
  // other tab reachable: a folder can hold leftovers after a loader change.
  // Palworld has its own package model (paks, script mods, frameworks); the
  // jar-folder view does not apply to it.
  const isPalworld = activeServer?.type === 'palworld';
  const defaultKind = serverAddonKind(activeServer);
  const currentKind = kind || defaultKind;

  useEffect(() => {
    setKind(null);
    setSelected(new Set());
  }, [activeServerId]);

  async function load(k = currentKind) {
    setLoading(true);
    setError('');
    try {
      const { addons: list } = await api(`/api/addons?kind=${k}`);
      setAddons(list);
      setSelected((current) => new Set([...current].filter((name) => list.some((addon) => addon.name === name))));
    } catch (e) { setError(e.message); }
    setLoading(false);
  }

  useEffect(() => { if (!isPalworld) load(currentKind); }, [currentKind, activeServerId, isPalworld]);

  async function deleteAddon(name) {
    try {
      await api(`/api/addons/${encodeURIComponent(name)}?kind=${currentKind}`, { method: 'DELETE' });
      toast.success(t('minecraft.addons.deletedToast'));
      load();
    } catch (e) { toast.error(e.message); }
  }

  async function setEnabled(names, enabled) {
    if (!names.length) return;
    try {
      const result = await api(`/api/addons/enabled?kind=${currentKind}`, {
        method: 'POST',
        body: { names, enabled },
      });
      toast.success(t(enabled ? 'minecraft.addons.enabledSelected' : 'minecraft.addons.disabledSelected', { count: result.changed.length }));
      setSelected((current) => new Set([...current].filter((name) => !names.includes(name))));
      await load();
    } catch (e) { toast.error(e.message); }
  }

  async function upload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('addon', file);
    try {
      await api(`/api/addons/upload?kind=${currentKind}`, { method: 'POST', body: fd });
      toast.success(t('minecraft.addons.uploadedToast'));
      load();
    } catch (e) { toast.error(e.message); }
    e.target.value = '';
  }

  const isMods = currentKind === 'mods';
  const selectedCount = addons.filter((addon) => selected.has(addon.name)).length;

  const uploadButton = (variant) => (
    <Button variant={variant} size="sm" asChild>
      <label className="cursor-pointer">
        <Upload className="h-3.5 w-3.5" />
        {t('minecraft.addons.uploadJar')}
        <input type="file" accept=".jar" hidden onChange={upload} />
      </label>
    </Button>
  );

  if (isPalworld) return <PalworldModsView />;

  return (
    <>
      <div className="space-y-6">
        <ViewHeader
          actions={
            <>
              {uploadButton('default')}
              <Button variant="glass" size="icon-sm" onClick={() => load()} aria-label={t('common.refresh')}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </>
          }
        />

        <Tabs value={currentKind} onValueChange={setKind}>
          <TabsList>
            <TabsTrigger value="plugins">{t('minecraft.addons.tabPlugins')}</TabsTrigger>
            <TabsTrigger value="mods">{t('minecraft.addons.tabMods')}</TabsTrigger>
          </TabsList>
        </Tabs>

        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorState error={error} onRetry={() => load()} />
        ) : addons.length === 0 ? (
          <Card>
            <CardContent className="py-4">
              <EmptyState
                icon={Package}
                title={isMods ? t('minecraft.addons.emptyMods') : t('minecraft.addons.emptyPlugins')}
                message={isMods ? t('minecraft.addons.emptyModsHint') : t('minecraft.addons.emptyPluginsHint')}
                action={(
                  <div className="flex flex-wrap justify-center gap-2">
                    {section?.onTab && (
                      <Button size="sm" onClick={() => section.onTab('browse')}>
                        <Search className="h-3.5 w-3.5" />
                        {t('minecraft.addons.browse')}
                      </Button>
                    )}
                    {uploadButton('glass')}
                  </div>
                )}
              />
            </CardContent>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-3 border-b border-border/60 bg-secondary/10 px-4 py-3">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <Checkbox
                  checked={selectedCount === addons.length}
                  onCheckedChange={(checked) => setSelected(new Set(checked ? addons.map((addon) => addon.name) : []))}
                  aria-label={t('minecraft.addons.selectAll')}
                />
                {t('minecraft.addons.selectAll')}
              </label>
              <span className="text-xs text-muted-foreground">{t('minecraft.addons.selectedCount', { count: selectedCount })}</span>
              {!offline && <span className="text-xs text-status-warn">{t('minecraft.addons.offline')}</span>}
              <div className="ml-auto flex flex-wrap gap-2">
                <Button type="button" variant="glass" size="sm" disabled={!offline || !selectedCount} onClick={() => setEnabled([...selected], true)}>
                  <Power className="h-3.5 w-3.5" />
                  {t('minecraft.addons.enableSelected')}
                </Button>
                <Button type="button" variant="glass" size="sm" disabled={!offline || !selectedCount} onClick={() => setEnabled([...selected], false)}>
                  <PowerOff className="h-3.5 w-3.5" />
                  {t('minecraft.addons.disableSelected')}
                </Button>
              </div>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-5">{isMods ? t('minecraft.addons.tabMods') : t('minecraft.addons.tabPlugins')}</TableHead>
                  <TableHead className="text-right">{t('common.size')}</TableHead>
                  <TableHead className="text-center">{t('minecraft.addons.status')}</TableHead>
                  <TableHead className="pr-5 text-right">{t('common.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {addons.map(a => (
                  <TableRow key={a.name}>
                    <TableCell className="pl-5">
                      <div className="flex items-center gap-2.5">
                        <Checkbox
                          checked={selected.has(a.name)}
                          onCheckedChange={(checked) => setSelected((current) => {
                            const next = new Set(current);
                            if (checked) next.add(a.name); else next.delete(a.name);
                            return next;
                          })}
                          aria-label={t('minecraft.addons.selectItem', { name: a.name })}
                        />
                        <span className="inline-flex items-center gap-2.5 font-medium text-foreground">
                        <Package className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{a.name}</span>
                      </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{fmtBytes(a.size)}</TableCell>
                    <TableCell className="text-center">
                      <Badge variant={a.enabled ? 'softSuccess' : 'default'}>
                        {t(a.enabled ? 'minecraft.addons.enabled' : 'minecraft.addons.disabled')}
                      </Badge>
                    </TableCell>
                    <TableCell className="pr-5">
                      <div className="flex items-center justify-end gap-1">
                        {/* Same rule as the bulk buttons: jars change only while stopped. */}
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={!offline}
                          onClick={() => setEnabled([a.name], !a.enabled)}
                          title={t(a.enabled ? 'minecraft.addons.disableOne' : 'minecraft.addons.enableOne', { name: a.name })}
                          aria-label={t(a.enabled ? 'minecraft.addons.disableOne' : 'minecraft.addons.enableOne', { name: a.name })}
                        >
                          {a.enabled ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => setPendingDelete(a.name)}
                          title={t('minecraft.addons.deleteOne', { name: a.name })}
                          aria-label={t('minecraft.addons.deleteOne', { name: a.name })}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </div>

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => { if (!o) setPendingDelete(null); }}
        title={isMods ? t('minecraft.addons.deleteTitleMod') : t('minecraft.addons.deleteTitlePlugin')}
        description={pendingDelete ? t('minecraft.addons.deleteBody', { name: pendingDelete }) : ''}
        confirmLabel={t('common.delete')}
        destructive
        onConfirm={() => deleteAddon(pendingDelete)}
      />
    </>
  );
}
