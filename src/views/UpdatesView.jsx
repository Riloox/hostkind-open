import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowRight, CheckCircle2, ChevronDown, ChevronRight, CircleDashed,
  PackageSearch, Power, RefreshCw, RotateCcw, Search, ShieldCheck, TriangleAlert,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorState } from '@/components/shared/ErrorState';
import { Loading } from '@/components/shared/Loading';
import { useApi } from '@/hooks/useApi';
import { useT } from '@/context/I18nContext';
import { useServer } from '@/context/ServerContext';
import { fmtBytes, cn } from '@/lib/utils';
import { ViewHeader, useSectionPage } from '@/components/layout/Page';
import { PalworldUpdatesView } from '@/views/PalworldUpdatesView';
import { ValheimUpdatesView } from '@/views/ValheimUpdatesView';

const STATUS_TONE = {
  planned: 'softInfo',
  applying: 'softWarn',
  succeeded: 'softSuccess',
  failed: 'softError',
  rollback_available: 'softWarn',
  rolled_back: 'default',
};

const fileName = (p) => String(p || '').split('/').pop();
const folderOf = (p) => String(p || '').split('/')[0];

export function UpdatesView() {
  const { activeServer } = useServer();
  if (activeServer?.type === 'palworld') return <PalworldUpdatesView />;
  if (activeServer?.type === 'valheim') return <ValheimUpdatesView />;
  return <ManagedContentUpdatesView />;
}

function ManagedContentUpdatesView() {
  const api = useApi();
  const t = useT();
  const { activeServerId, getServerStatus } = useServer();
  const section = useSectionPage();

  const [data, setData] = useState(null);
  const [scanError, setScanError] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [plan, setPlan] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showUnmanaged, setShowUnmanaged] = useState(false);

  const offline = getServerStatus(activeServerId).status === 'offline';

  async function scan() {
    if (!activeServerId) { setData(null); return; }
    setScanning(true);
    setScanError('');
    try {
      const r = await api('/api/updates/scan', { method: 'POST', body: { serverId: activeServerId } });
      setData(r);
      setSelected(new Set());
    } catch (e) {
      setScanError(e.message);
      toast.error(e.message);
    } finally {
      setScanning(false);
    }
  }

  // Scanning is read-only, so run it as soon as a server is in focus instead of
  // making the user press a button before the tab shows anything.
  useEffect(() => { setPlan(null); setData(null); scan(); }, [activeServerId]);

  async function createPlan() {
    setBusy(true);
    try {
      const r = await api('/api/updates/plan', { method: 'POST', body: { serverId: activeServerId, artifactIds: [...selected] } });
      setPlan(r.plan);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function run(action, id) {
    setBusy(true);
    try {
      const r = await api(`/api/updates/plans/${id}/${action}`, { method: 'POST' });
      setPlan(r.plan);
      toast.success(t(action === 'apply' ? 'updates.applied' : 'updates.rolledBack'));
      await scan();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function stopServer() {
    try {
      await api(`/api/servers/${activeServerId}/stop`, { method: 'POST' });
    } catch (e) {
      toast.error(e.message);
    }
  }

  const artifacts = data?.scan?.artifacts || [];
  const unmanaged = data?.scan?.unmanaged || [];
  const { updatable, attention, current } = useMemo(() => ({
    updatable: artifacts.filter((a) => a.update && a.selectable),
    attention: artifacts.filter((a) => !a.selectable && a.reason),
    current: artifacts.filter((a) => !a.update && !a.reason),
  }), [artifacts]);

  const allSelected = updatable.length > 0 && updatable.every((a) => selected.has(a.id));
  const toggle = (id, on) => setSelected((prev) => {
    const next = new Set(prev);
    on ? next.add(id) : next.delete(id);
    return next;
  });
  const toggleAll = (on) => setSelected(on ? new Set(updatable.map((a) => a.id)) : new Set());
  const selectedSize = updatable.filter((a) => selected.has(a.id)).reduce((n, a) => n + Number(a.update.size || 0), 0);

  return (
    <div className="space-y-5">
      <ViewHeader
        actions={<div className="flex items-center gap-3">
          {data?.scan && (
            <span className="text-xs text-muted-foreground">
              {t('updates.lastScan')}: {new Date(data.scan.scannedAt).toLocaleTimeString()}
              {data.scan.freshness?.stale ? ` · ${t('updates.stale')}` : ''}
            </span>
          )}
          <Button size="sm" variant="glass" onClick={scan} disabled={scanning || busy || !activeServerId}>
            <RefreshCw className={cn('h-3.5 w-3.5', scanning && 'animate-spin')} />
            {scanning ? t('updates.scanning') : t('updates.scan')}
          </Button>
        </div>}
      />

      {scanning && !data ? (
        <Card><CardContent className="pt-6"><Loading /></CardContent></Card>
      ) : !data ? (
        scanError ? <ErrorState error={scanError} onRetry={scan} /> : null
      ) : (
        <>
          {updatable.length > 0 && !offline && (
            <Alert variant="warn" className="items-center justify-between">
              <span className="flex items-center gap-2">
                <TriangleAlert className="h-4 w-4 shrink-0" />
                {t('updates.mustBeOffline')}
              </span>
              <Button size="sm" variant="glass" onClick={stopServer}>
                <Power className="h-3.5 w-3.5" />{t('updates.stopServer')}
              </Button>
            </Alert>
          )}

          {updatable.length > 0 && (
            <Card>
              <CardHeader className="gap-3">
                <CardTitle className="flex items-center gap-2">
                  {t('updates.available')}
                  <Badge variant="softPrimary">{updatable.length}</Badge>
                </CardTitle>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                  <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                  {t('updates.selectAll')}
                </label>
              </CardHeader>
              <CardContent className="space-y-2">
                {updatable.map((a) => (
                  <label
                    key={a.id}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors',
                      selected.has(a.id) ? 'border-primary/40 bg-primary/5' : 'hover:border-primary/30'
                    )}
                  >
                    <Checkbox checked={selected.has(a.id)} onCheckedChange={(on) => toggle(a.id, !!on)} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{fileName(a.relativePath)}</span>
                        <Badge variant="default">{folderOf(a.relativePath)}</Badge>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <ArrowRight className="h-3 w-3 shrink-0 text-primary" />
                        <span className="truncate text-foreground">{a.update.versionNumber}</span>
                        <span className="truncate">· {a.update.filename}</span>
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{fmtBytes(a.update.size)}</span>
                    <ShieldCheck className="h-4 w-4 shrink-0 text-status-online" />
                  </label>
                ))}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                  <span className="text-xs text-muted-foreground">
                    {selected.size ? `${t('updates.selectedCount', { count: selected.size })} · ${fmtBytes(selectedSize)}` : t('updates.snapshotNote')}
                  </span>
                  <Button size="sm" disabled={!selected.size || busy} onClick={createPlan}>{t('updates.createPlan')}</Button>
                </div>
              </CardContent>
            </Card>
          )}

          {attention.length > 0 && (
            <Card>
              <CardHeader className="flex-col items-start gap-1">
                <CardTitle className="flex items-center gap-2">
                  <TriangleAlert className="h-4 w-4 text-status-warn" />
                  {t('updates.attention')}
                </CardTitle>
                <p className="text-xs text-muted-foreground">{t('updates.attentionHint')}</p>
              </CardHeader>
              <CardContent className="space-y-2">
                {attention.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 rounded-lg border border-status-warn/25 bg-status-warn/5 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{fileName(a.relativePath)}</div>
                      <div className="truncate text-xs text-muted-foreground">{a.error || t(`updates.reason.${a.reason}`)}</div>
                    </div>
                    <Badge variant="softWarn">{folderOf(a.relativePath)}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {!artifacts.length && (
            <Card>
              <CardContent>
                <EmptyState
                  icon={PackageSearch}
                  title={t('updates.noManaged')}
                  message={t('updates.noManagedHint')}
                  action={section?.onTab && (
                    <Button size="sm" onClick={() => section.onTab('browse')}>
                      <Search className="h-3.5 w-3.5" />
                      {t('minecraft.addons.browse')}
                    </Button>
                  )}
                />
              </CardContent>
            </Card>
          )}

          {artifacts.length > 0 && !updatable.length && !attention.length && (
            <Card>
              <CardContent>
                <EmptyState icon={CheckCircle2} title={t('updates.allCurrent')} message={t('updates.allCurrentHint')} />
              </CardContent>
            </Card>
          )}

          {current.length > 0 && (
            <Disclosure
              open={showCurrent}
              onToggle={() => setShowCurrent((v) => !v)}
              title={`${t('updates.upToDate')} (${current.length})`}
            >
              {current.map((a) => (
                <div key={a.id} className="flex items-center gap-2 py-1.5 text-xs">
                  <CircleDashed className="h-3.5 w-3.5 shrink-0 text-status-online" />
                  <span className="truncate">{a.relativePath}</span>
                </div>
              ))}
            </Disclosure>
          )}

          {unmanaged.length > 0 && (
            <Disclosure
              open={showUnmanaged}
              onToggle={() => setShowUnmanaged((v) => !v)}
              title={`${t('updates.unmanaged')} (${unmanaged.length})`}
              subtitle={t('updates.unmanagedHint')}
            >
              {unmanaged.map((x) => (
                <div key={x.relativePath} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                  <span className="truncate text-muted-foreground">{x.relativePath}</span>
                  <span className="shrink-0 text-muted-foreground">{fmtBytes(x.size)}</span>
                </div>
              ))}
            </Disclosure>
          )}
        </>
      )}

      {plan && (
        <PlanCard
          plan={plan}
          t={t}
          busy={busy}
          offline={offline}
          onApply={() => setConfirm('apply')}
          onRollback={() => setConfirm('rollback')}
        />
      )}

      {data?.plans?.length > 0 && (
        <Card>
          <CardHeader><CardTitle>{t('updates.history')}</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {data.plans.map((p) => (
              <button
                type="button"
                key={p.id}
                onClick={() => setPlan(p)}
                className={cn(
                  'flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-xs hover:bg-secondary/50',
                  plan?.id === p.id && 'bg-secondary/50'
                )}
              >
                <span className="text-muted-foreground">{new Date(p.createdAt).toLocaleString()}</span>
                <span className="flex items-center gap-2">
                  <span className="text-muted-foreground">{t('updates.itemCount', { count: (p.items || []).length })}</span>
                  <Badge variant={STATUS_TONE[p.status] || 'default'}>{t(`updates.state.${p.status}`)}</Badge>
                </span>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={confirm === 'apply'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('updates.apply')}
        description={t('updates.applyConfirm')}
        confirmLabel={t('updates.apply')}
        onConfirm={() => run('apply', plan.id)}
      />
      <ConfirmDialog
        open={confirm === 'rollback'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('updates.rollback')}
        description={t('updates.rollbackConfirm')}
        confirmLabel={t('updates.rollback')}
        destructive
        onConfirm={() => run('rollback', plan.id)}
      />
    </div>
  );
}

function Disclosure({ open, onToggle, title, subtitle, children }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <Card>
      <CardContent className="pt-4">
        <button type="button" onClick={onToggle} className="flex w-full items-center gap-2 text-left">
          <Chevron className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{title}</span>
        </button>
        {open && (
          <div className="mt-3 border-t pt-3">
            {subtitle && <p className="mb-2 text-xs text-muted-foreground">{subtitle}</p>}
            {children}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PlanCard({ plan, t, busy, offline, onApply, onRollback }) {
  const items = plan.items || [];
  const canApply = plan.status === 'planned';
  const canRollback = !!plan.snapshotId && plan.status !== 'rolled_back';
  return (
    <Card className="border-primary/30">
      <CardHeader className="gap-3">
        <CardTitle>{t('updates.plan')}</CardTitle>
        <Badge variant={STATUS_TONE[plan.status] || 'default'}>{t(`updates.state.${plan.status}`)}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          {items.map((x) => (
            <div key={x.id} className="flex items-center justify-between gap-3 rounded-md border p-2.5 text-xs">
              <span className="truncate">{fileName(x.relativePath)}</span>
              <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                <ArrowRight className="h-3 w-3 text-primary" />
                <span className="text-foreground">{x.update?.versionNumber}</span>
              </span>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <span>{t('updates.diskNeed')}: {fmtBytes(plan.diskNeed)}</span>
          <span>{t('updates.offlineSnapshot')}</span>
        </div>

        {plan.error && <Alert variant="error">{plan.error}</Alert>}
        {canApply && !offline && <Alert variant="warn">{t('updates.mustBeOffline')}</Alert>}

        <div className="flex justify-end gap-2">
          {canRollback && (
            <Button variant="glass" size="sm" disabled={busy || !offline} onClick={onRollback}>
              <RotateCcw className="h-3.5 w-3.5" />{t('updates.rollback')}
            </Button>
          )}
          {canApply && (
            <Button size="sm" disabled={busy || !offline} onClick={onApply}>
              <HardDriveDownload className="h-3.5 w-3.5" />{t('updates.apply')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
