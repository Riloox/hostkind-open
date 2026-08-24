import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CalendarClock, CheckCircle2, HardDrive, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { PageIntro } from '@/components/layout/Page';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Loading } from '@/components/shared/Loading';
import { useApi } from '@/hooks/useApi';
import { useT } from '@/context/I18nContext';
import { useServer } from '@/context/ServerContext';
import { useAuth } from '@/context/AuthContext';
import { fmtBytes } from '@/lib/utils';

const build = (value) => value || '—';

export function PalworldUpdatesView() {
  const api = useApi();
  const t = useT();
  const { activeServerId } = useServer();
  const { hasCapability } = useAuth();
  const [update, setUpdate] = useState(null);
  const [policy, setPolicy] = useState(null);
  const [plan, setPlan] = useState(null);
  const [operation, setOperation] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const canApply = hasCapability('updates.apply', activeServerId);
  const canPolicy = hasCapability('updates.policy', activeServerId);

  const load = useCallback(async (force = false) => {
    if (!activeServerId) return;
    setBusy(true);
    try {
      const [result, policyResult] = await Promise.all([
        api(force ? '/api/palworld/updates/check' : '/api/palworld/updates', {
          method: force ? 'POST' : 'GET',
          body: force ? { serverId: activeServerId } : undefined,
          headers: { 'X-Hostkind-Server-Id': activeServerId },
        }),
        api('/api/palworld/updates/policy', { headers: { 'X-Hostkind-Server-Id': activeServerId } }),
      ]);
      setUpdate(result.update);
      setPolicy(policyResult.policy);
      setPlan(null);
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }, [activeServerId, api]);

  useEffect(() => { load(false); }, [load]);

  useEffect(() => {
    if (!operation?.id || ['succeeded', 'failed', 'recovery_required', 'cancelled'].includes(operation.state)) return;
    const timer = setInterval(async () => {
      try {
        const result = await api(`/api/operations/${operation.id}`);
        setOperation(result.operation);
        if (result.operation.state === 'succeeded') { toast.success(t('palworldUpdates.applied')); load(false); }
      } catch {}
    }, 1500);
    return () => clearInterval(timer);
  }, [operation?.id, operation?.state, api, load, t]);

  async function preview() {
    setBusy(true);
    try {
      const result = await api('/api/palworld/updates/preview', {
        method: 'POST',
        headers: { 'X-Hostkind-Server-Id': activeServerId },
        body: { restart: true, backupRequired: true, announceSeconds: update?.running?.version ? 300 : 0 },
      });
      setPlan(result.plan);
      setConfirm(true);
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  async function apply() {
    setConfirm(false);
    setBusy(true);
    try {
      const result = await api('/api/palworld/updates/apply', {
        method: 'POST',
        headers: {
          'X-Hostkind-Server-Id': activeServerId,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: { plan, revision: plan.revision },
      });
      setOperation({ id: result.operationId, state: 'queued', phase: 'queued', progress: 0 });
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  async function savePolicy() {
    setBusy(true);
    try {
      const result = await api('/api/palworld/updates/policy', {
        method: 'PUT',
        headers: { 'X-Hostkind-Server-Id': activeServerId },
        body: policy,
      });
      setPolicy(result.policy);
      toast.success(t('palworldUpdates.policySaved'));
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  if (!update || !policy) return <Loading />;
  const ready = update.state === 'update-ready';
  const uncertain = update.state === 'unknown' || update.state === 'installed-unknown';

  return (
    <div className="space-y-5">
      <PageIntro
        title={t('palworldUpdates.title')}
        description={t('palworldUpdates.subtitle')}
        actions={<Button variant="outline" size="sm" disabled={busy} onClick={() => load(true)}><RefreshCw className="h-4 w-4" />{t('palworldUpdates.forceCheck')}</Button>}
      />

      {update.latest.stale && <Alert variant="warn"><TriangleAlert className="h-4 w-4" />{t('palworldUpdates.stale')}</Alert>}
      {operation?.state === 'recovery_required' && (
        <Alert variant="destructive"><TriangleAlert className="h-4 w-4" />{t('palworldUpdates.recovery')}</Alert>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <div>
            <CardTitle>{t('palworldUpdates.builds')}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">{t('palworldUpdates.checked', { date: new Date(update.checkedAt).toLocaleString() })}</p>
          </div>
          <Badge variant={ready ? 'softWarn' : uncertain ? 'default' : 'softSuccess'}>
            {t(`palworldUpdates.state.${update.state}`)}
          </Badge>
        </CardHeader>
        <CardContent className="grid gap-px bg-border p-0 sm:grid-cols-3">
          {[
            [t('palworldUpdates.installed'), build(update.installed.buildId), update.installed.source],
            [t('palworldUpdates.running'), build(update.running.version), update.running.source],
            [t('palworldUpdates.latest'), build(update.latest.buildId), update.latest.source],
          ].map(([label, value, source]) => (
            <div key={label} className="bg-card p-5">
              <div className="text-label font-semibold uppercase tracking-[.12em] text-muted-foreground">{label}</div>
              <div className="mt-2 text-lg font-semibold text-foreground">{value}</div>
              <div className="mt-1 text-xs text-muted-foreground">{source}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[1.25fr_.75fr]">
        <Card>
          <CardHeader><CardTitle>{t('palworldUpdates.manual')}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3 border-y py-3 text-sm">
              <HardDrive className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1">{t('palworldUpdates.disk')}</span>
              <span className="tabular-nums">{fmtBytes(update.diskEstimateBytes)}</span>
            </div>
            <div className="flex items-start gap-3 text-sm">
              <ShieldCheck className="mt-0.5 h-4 w-4 text-status-online" />
              <p className="text-muted-foreground">{t('palworldUpdates.safety')}</p>
            </div>
            {operation && (
              <div className="border bg-background p-3">
                <div className="flex justify-between text-xs"><span>{t('palworldUpdates.operation')}</span><span>{operation.phase || operation.state}</span></div>
                <div className="mt-2 h-1 bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round((operation.progress || 0) * 100)}%` }} /></div>
              </div>
            )}
            <Button disabled={!ready || !canApply || busy || !!operation && !['succeeded', 'failed', 'recovery_required', 'cancelled'].includes(operation.state)} onClick={preview}>
              {ready ? t('palworldUpdates.review') : t('palworldUpdates.noUpdate')}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t('palworldUpdates.automatic')}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-center gap-3 text-sm">
              <Checkbox checked={policy.enabled} onCheckedChange={(value) => setPolicy({ ...policy, enabled: !!value })} disabled={!canPolicy} />
              <span><strong className="block">{t('palworldUpdates.enable')}</strong><span className="text-xs text-muted-foreground">{t('palworldUpdates.disabledDefault')}</span></span>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>{t('palworldUpdates.windowStart')}</Label><Input type="time" value={policy.maintenanceWindow.start} onChange={(e) => setPolicy({ ...policy, maintenanceWindow: { ...policy.maintenanceWindow, start: e.target.value } })} disabled={!canPolicy} /></div>
              <div><Label>{t('palworldUpdates.windowEnd')}</Label><Input type="time" value={policy.maintenanceWindow.end} onChange={(e) => setPolicy({ ...policy, maintenanceWindow: { ...policy.maintenanceWindow, end: e.target.value } })} disabled={!canPolicy} /></div>
            </div>
            <div className="flex items-start gap-3 text-xs text-muted-foreground"><CalendarClock className="mt-0.5 h-4 w-4 shrink-0" />{t('palworldUpdates.playerPolicy')}</div>
            <Button variant="outline" disabled={!canPolicy || busy} onClick={savePolicy}>{t('palworldUpdates.savePolicy')}</Button>
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('palworldUpdates.confirmTitle')}
        description={t('palworldUpdates.confirmBody', { build: plan?.targetBuildId || '' })}
        confirmLabel={t('palworldUpdates.apply')}
        onConfirm={apply}
      />
    </div>
  );
}
