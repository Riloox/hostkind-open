import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, Check, Clock3, Copy, HeartPulse, LogOut, Megaphone, RefreshCw, Search, UserRoundX, Users } from 'lucide-react';
import { toast } from 'sonner';
import { ViewHeader } from '@/components/layout/Page';
import { PalworldAnnouncementDialog } from '@/components/shared/PalworldAnnouncementDialog';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorState } from '@/components/shared/ErrorState';
import { Loading } from '@/components/shared/Loading';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/context/AuthContext';
import { useServer } from '@/context/ServerContext';
import { useT } from '@/context/I18nContext';
import { useApi } from '@/hooks/useApi';
import { usePolling } from '@/hooks/usePolling';

const STALE_MS = 30_000;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function ageLabel(observedAt, t) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(observedAt)) / 1000));
  return t('palworld.observedSecondsAgo', { seconds });
}

function CopyValue({ label, value, t }) {
  if (!value) return null;
  async function copy() {
    await navigator.clipboard.writeText(value);
    toast.success(t('palworld.copied'));
  }
  return (
    <div>
      <p className="mb-1 text-label font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2 border border-border bg-background p-2">
        <code className="min-w-0 flex-1 truncate text-xs text-foreground">{value}</code>
        <Button variant="ghost" size="icon" onClick={copy} aria-label={t('palworld.copyValue', { label })}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function PalworldPlayersView() {
  const api = useApi();
  const t = useT();
  const { hasCapability } = useAuth();
  const { activeServer, activeServerId, statuses } = useServer();
  const processStatus = statuses[activeServerId]?.status || 'offline';
  const canManage = hasCapability('players.manage', activeServerId);
  const canAnnounce = hasCapability('announcements.send', activeServerId);
  const [data, setData] = useState({ players: [], playerCount: 0, maxPlayers: 0, restHealth: null, sampledAt: null });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [action, setAction] = useState(null);
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState(false);
  const [announceOpen, setAnnounceOpen] = useState(false);
  const [unbanOpen, setUnbanOpen] = useState(false);
  const [unbanId, setUnbanId] = useState('');

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      setData(await api('/api/palworld/players'));
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load, activeServerId]);
  usePolling(() => load(true), { activeInterval: 10_000, hiddenInterval: 30_000 });

  const players = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.players.filter((player) => (
      !needle
      || player.name.toLowerCase().includes(needle)
      || player.userId.toLowerCase().includes(needle)
      || (player.accountId || '').toLowerCase().includes(needle)
    ));
  }, [data.players, query]);
  const healthy = data.restHealth?.state === 'healthy' && !error;
  const selectedStale = selected && Date.now() - Date.parse(selected.observedAt) > STALE_MS;
  const actionsDisabled = processStatus !== 'online' || !healthy || selectedStale;

  async function runPlayerAction(kind, userId = selected?.userId) {
    if (!userId || working) return;
    setWorking(true);
    try {
      const path = kind === 'unban'
        ? '/api/palworld/players/unban'
        : `/api/palworld/players/${encodeURIComponent(userId)}/${kind}`;
      await api(path, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: kind === 'unban' ? { userId } : { reason },
      });
      toast.success(t(`palworld.${kind}Accepted`));
      setAction(null);
      setReason('');
      setSelected(null);
      setUnbanOpen(false);
      setUnbanId('');
      await load(true);
    } catch (actionError) {
      toast.error(actionError.message);
    } finally {
      setWorking(false);
    }
  }

  const location = selected?.location;
  const invalidReason = CONTROL_RE.test(reason) || reason.length > 512;

  return (
    <div className="space-y-5">
      <ViewHeader
        title={t('palworld.playersTitle')}
        description={t('palworld.playersSubtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            {canManage && (
              <Button variant="glass" onClick={() => setUnbanOpen(true)} disabled={processStatus !== 'online' || !healthy}>
                <UserRoundX className="h-4 w-4" />{t('palworld.unban')}
              </Button>
            )}
            {canAnnounce && (
              <Button onClick={() => setAnnounceOpen(true)} disabled={processStatus !== 'online' || !healthy}>
                <Megaphone className="h-4 w-4" />{t('palworld.announcement')}
              </Button>
            )}
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex items-center gap-3 border-2 border-border bg-card p-4">
          <HeartPulse className={`h-5 w-5 ${healthy ? 'text-status-online' : 'text-status-error'}`} />
          <div><p className="text-label font-semibold uppercase tracking-wider text-muted-foreground">{t('palworld.restHealth')}</p><p className="text-sm font-semibold">{healthy ? t('palworld.healthy') : t(`palworld.health_${data.restHealth?.state || 'unavailable'}`)}</p></div>
        </div>
        <div className="flex items-center gap-3 border-2 border-border bg-card p-4">
          <Users className="h-5 w-5 text-primary" />
          <div><p className="text-label font-semibold uppercase tracking-wider text-muted-foreground">{t('palworld.playerCount')}</p><p className="text-sm font-semibold tabular-nums">{data.playerCount} / {data.maxPlayers || '—'}</p></div>
        </div>
        <div className="flex items-center gap-3 border-2 border-border bg-card p-4">
          <Clock3 className="h-5 w-5 text-muted-foreground" />
          <div><p className="text-label font-semibold uppercase tracking-wider text-muted-foreground">{t('palworld.lastRefresh')}</p><p className="text-sm font-semibold">{data.sampledAt ? ageLabel(data.sampledAt, t) : '—'}</p></div>
        </div>
      </div>

      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-center">
          <CardTitle className="flex-1">{t('palworld.onlinePlayers')}</CardTitle>
          <div className="flex w-full gap-2 sm:w-auto">
            <div className="relative min-w-0 flex-1 sm:w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('palworld.searchPlayers')} className="pl-9" />
            </div>
            <Button variant="glass" size="icon" onClick={() => load(true)} disabled={refreshing} aria-label={t('palworld.refresh')}>
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? <Loading /> : error ? <ErrorState error={error} onRetry={() => load()} /> : players.length === 0 ? (
            <EmptyState icon={Users} title={query ? t('palworld.noMatches') : t('palworld.noPlayers')} message={query ? t('palworld.tryAnotherSearch') : t('palworld.noPlayersHint')} />
          ) : (
            <div className="divide-y divide-border border-y border-border">
              {players.map((player) => (
                <button key={player.userId} type="button" onClick={() => setSelected(player)} className="grid w-full gap-2 px-3 py-3 text-left hover:bg-secondary/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto] sm:items-center">
                  <span className="truncate text-sm font-semibold text-foreground">{player.name}</span>
                  <code className="truncate text-xs text-muted-foreground">{player.userId}</code>
                  <span className="text-xs text-muted-foreground">{ageLabel(player.observedAt, t)}</span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{selected?.name}</DialogTitle></DialogHeader>
          {selected && <DialogBody className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Badge variant={selectedStale ? 'starting' : 'online'}>{selectedStale ? t('palworld.stale') : t('palworld.observedNow')}</Badge>
              {selected.level != null && <Badge>{t('palworld.level', { level: selected.level })}</Badge>}
              {selected.ping != null && <Badge>{t('palworld.ping', { ping: selected.ping })}</Badge>}
            </div>
            <CopyValue label={t('palworld.playerId')} value={selected.userId} t={t} />
            <CopyValue label={t('palworld.platformId')} value={selected.accountId} t={t} />
            <div>
              <p className="mb-1 text-label font-semibold uppercase tracking-wider text-muted-foreground">{t('palworld.location')}</p>
              <p className="text-xs text-foreground">{location ? [location.x, location.y, location.z].map((value) => value ?? '—').join(', ') : t('palworld.locationUnavailable')}</p>
            </div>
            <p className="text-xs text-muted-foreground">{t('palworld.observedAt', { time: new Date(selected.observedAt).toLocaleString() })}</p>
            {!canManage && <p className="border border-border bg-secondary/30 p-3 text-xs text-muted-foreground">{t('palworld.readOnly')}</p>}
            {canManage && actionsDisabled && <p className="border border-status-warn/40 bg-status-warn/5 p-3 text-xs text-status-warn">{t('palworld.actionsUnavailable')}</p>}
          </DialogBody>}
          {canManage && <DialogFooter>
            <Button variant="glass" disabled={actionsDisabled} onClick={() => setAction('kick')}><LogOut className="h-4 w-4" />{t('palworld.kick')}</Button>
            <Button variant="destructive" disabled={actionsDisabled} onClick={() => setAction('ban')}><Ban className="h-4 w-4" />{t('palworld.ban')}</Button>
          </DialogFooter>}
        </DialogContent>
      </Dialog>

      <Dialog open={!!action} onOpenChange={(open) => { if (!open) { setAction(null); setReason(''); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{action === 'ban' ? t('palworld.confirmBanTitle') : t('palworld.confirmKickTitle')}</DialogTitle></DialogHeader>
          <DialogBody className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('palworld.confirmPlayerAction', { action: action === 'ban' ? t('palworld.ban') : t('palworld.kick'), player: selected?.name, server: activeServer?.name })}</p>
            <div><label htmlFor="palworld-reason" className="mb-2 block text-xs font-semibold">{t('palworld.reasonOptional')}</label><Textarea id="palworld-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={513} /></div>
            {invalidReason && <p className="text-xs text-status-error">{t('palworld.reasonInvalid')}</p>}
          </DialogBody>
          <DialogFooter><Button variant="glass" onClick={() => setAction(null)}>{t('common.cancel')}</Button><Button variant="destructive" disabled={working || invalidReason} onClick={() => runPlayerAction(action)}>{working ? t('palworld.applying') : t('common.confirm')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={unbanOpen} onOpenChange={setUnbanOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{t('palworld.unbanTitle')}</DialogTitle></DialogHeader>
          <DialogBody className="space-y-4"><p className="text-sm text-muted-foreground">{t('palworld.unbanWarning')}</p><div><label htmlFor="palworld-unban-id" className="mb-2 block text-xs font-semibold">{t('palworld.playerId')}</label><Input id="palworld-unban-id" value={unbanId} onChange={(event) => setUnbanId(event.target.value)} /></div><p className="text-xs text-muted-foreground">{t('palworld.confirmUnban', { server: activeServer?.name })}</p></DialogBody>
          <DialogFooter><Button variant="glass" onClick={() => setUnbanOpen(false)}>{t('common.cancel')}</Button><Button disabled={!unbanId.trim() || working} onClick={() => runPlayerAction('unban', unbanId.trim())}><Check className="h-4 w-4" />{t('palworld.unban')}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <PalworldAnnouncementDialog open={announceOpen} onOpenChange={setAnnounceOpen} disabled={processStatus !== 'online' || !healthy} />
    </div>
  );
}
