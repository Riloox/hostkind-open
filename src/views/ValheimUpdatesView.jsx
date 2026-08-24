import { useCallback, useEffect, useState } from 'react';
import { HardDrive, RefreshCw, RotateCcw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { PageIntro } from '@/components/layout/Page';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Loading } from '@/components/shared/Loading';
import { useApi } from '@/hooks/useApi';
import { useT } from '@/context/I18nContext';
import { useServer } from '@/context/ServerContext';
import { fmtBytes } from '@/lib/utils';

export function ValheimUpdatesView() {
  const api = useApi();
  const t = useT();
  const { activeServerId } = useServer();
  const [update, setUpdate] = useState(null);
  const [plan, setPlan] = useState(null);
  const [rollbackId, setRollbackId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async (force = false) => {
    if (!activeServerId) return;
    setBusy(true);
    try {
      const result = await api(force ? '/api/valheim/updates/check' : '/api/valheim/updates', {
        method: force ? 'POST' : 'GET',
        headers: { 'X-Hostkind-Server-Id': activeServerId },
      });
      setUpdate(result.update);
      setPlan(null);
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }, [activeServerId, api]);

  useEffect(() => { load(false); }, [load]);

  async function preview() {
    setBusy(true);
    try {
      const result = await api('/api/valheim/updates/preview', {
        method: 'POST',
        headers: { 'X-Hostkind-Server-Id': activeServerId },
        body: { restart: true },
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
      const result = await api('/api/valheim/updates/apply', {
        method: 'POST',
        headers: { 'X-Hostkind-Server-Id': activeServerId, 'Idempotency-Key': crypto.randomUUID() },
        body: { previewToken: plan.previewToken, restart: plan.restart },
      });
      setRollbackId(result.rollbackId);
      toast.success(t('valheim.updates.applied'));
      await load(false);
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  async function rollback() {
    setBusy(true);
    try {
      await api(`/api/valheim/updates/${rollbackId}/rollback`, {
        method: 'POST',
        headers: { 'X-Hostkind-Server-Id': activeServerId },
        body: { restart: false },
      });
      setRollbackId(null);
      toast.success(t('valheim.updates.rolledBack'));
      await load(false);
    } catch (error) { toast.error(error.message); }
    finally { setBusy(false); }
  }

  if (!update) return <Loading />;
  const ready = update.state === 'update-ready';
  return (
    <div className="space-y-5">
      <PageIntro
        title={t('valheim.updates.title')}
        description={t('valheim.updates.subtitle')}
        actions={<Button variant="outline" size="sm" disabled={busy} onClick={() => load(true)}><RefreshCw className="h-4 w-4" />{t('valheim.updates.check')}</Button>}
      />
      {update.available?.stale && <Alert variant="warn"><TriangleAlert className="h-4 w-4" />{t('valheim.updates.stale')}</Alert>}
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>{t('valheim.updates.builds')}</CardTitle>
          <Badge variant={ready ? 'softWarn' : update.state === 'current' ? 'softSuccess' : 'default'}>{t(`valheim.updates.state.${update.state}`)}</Badge>
        </CardHeader>
        <CardContent className="grid gap-px bg-border p-0 sm:grid-cols-2">
          <div className="bg-card p-5"><div className="text-xs text-muted-foreground">{t('valheim.updates.installed')}</div><div className="mt-2 text-lg font-semibold">{update.installed.buildId || '—'}</div></div>
          <div className="bg-card p-5"><div className="text-xs text-muted-foreground">{t('valheim.updates.available')}</div><div className="mt-2 text-lg font-semibold">{update.available?.buildId || '—'}</div></div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t('valheim.updates.manual')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-3 text-sm text-muted-foreground"><ShieldCheck className="h-4 w-4 text-status-online" />{t('valheim.updates.preservation')}</div>
          {plan && <div className="flex gap-3 text-sm"><HardDrive className="h-4 w-4" />{t('valheim.updates.disk')}: {fmtBytes(plan.requiredDiskBytes)}</div>}
          <div className="flex gap-2">
            <Button disabled={!ready || busy} onClick={preview}>{t('valheim.updates.preview')}</Button>
            {rollbackId && <Button variant="outline" disabled={busy} onClick={rollback}><RotateCcw className="h-4 w-4" />{t('valheim.updates.rollback')}</Button>}
          </div>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('valheim.updates.confirmTitle')}
        description={t('valheim.updates.confirmBody', { build: plan?.availableBuildId || '' })}
        confirmLabel={t('valheim.updates.apply')}
        onConfirm={apply}
      />
    </div>
  );
}
