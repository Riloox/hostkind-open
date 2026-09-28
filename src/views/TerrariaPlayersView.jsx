import { useState } from 'react';
import { Ban, LogOut, Users } from 'lucide-react';
import { toast } from 'sonner';
import { ViewHeader } from '@/components/layout/Page';
import { EmptyState } from '@/components/shared/EmptyState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { StartServerButton } from '@/components/shared/StartServerButton';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useApi } from '@/hooks/useApi';
import { useServer } from '@/context/ServerContext';
import { useT } from '@/context/I18nContext';

function playerName(player) {
  return typeof player === 'string' ? player : player?.name;
}

export function TerrariaPlayersView() {
  const t = useT();
  const api = useApi();
  const { activeServerId, statuses, supports } = useServer();
  const [busy, setBusy] = useState(null);
  const [pendingBan, setPendingBan] = useState(null);
  const status = statuses[activeServerId] || { players: [], playerCount: 0, maxPlayers: 0, status: 'offline' };
  const processStatus = status.status || 'offline';
  const livePlayers = Array.isArray(status.players) ? status.players : [];
  const players = livePlayers.map(playerName).filter(Boolean);
  const isOnline = processStatus === 'online';
  const canManage = isOnline && supports('players') && supports('console');

  const runAction = async (action, name) => {
    if (!canManage || busy) return;
    setBusy(`${action}:${name}`);
    try {
      await api(`/api/terraria/players/${action}`, {
        method: 'POST',
        body: { target: name },
      });
      toast.success(t(`terraria.players.${action}Success`, { name }));
    } catch (error) {
      toast.error(error.message || t('terraria.players.actionFailed'));
    } finally {
      setBusy(null);
    }
  };

  const count = status.playerCount ?? players.length;

  return (
    <div data-testid="terraria-players-view" className="space-y-6">
      <ViewHeader title={t('nav.players')} />

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            {t('terraria.players.onlineNow')}
          </CardTitle>
          <span className="text-sm tabular-nums text-muted-foreground">
            {status.maxPlayers ? t('players.countOf', { count, max: status.maxPlayers }) : count}
          </span>
        </CardHeader>
        {players.length === 0 ? (
          <CardContent data-testid="terraria-players-empty">
            <EmptyState
              icon={Users}
              title={t('terraria.players.emptyTitle')}
              message={processStatus === 'offline' ? t('players.offlineHint') : t('terraria.players.emptyOnline')}
              action={processStatus === 'offline' ? <StartServerButton /> : null}
            />
          </CardContent>
        ) : (
          <ul className="divide-y divide-border">
            {players.map((name) => (
              <li key={name} data-testid="terraria-player-row" className="flex items-center gap-3 px-5 py-2.5">
                <span className="h-2 w-2 shrink-0 rounded-full bg-status-online" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{name}</span>
                <Button
                  variant="glass"
                  size="xs"
                  disabled={!canManage || Boolean(busy)}
                  onClick={() => runAction('kick', name)}
                  aria-label={t('terraria.players.kickNamed', { name })}
                >
                  <LogOut className="h-3 w-3" />
                  {t('terraria.players.kick')}
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-status-error hover:text-status-error"
                  disabled={!canManage || Boolean(busy)}
                  onClick={() => setPendingBan(name)}
                  aria-label={t('terraria.players.banNamed', { name })}
                >
                  <Ban className="h-3 w-3" />
                  {t('terraria.players.ban')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={!!pendingBan}
        onOpenChange={(open) => { if (!open) setPendingBan(null); }}
        title={t('terraria.players.banTitle', { name: pendingBan || '' })}
        description={t('terraria.players.banBody')}
        confirmLabel={t('terraria.players.ban')}
        destructive
        onConfirm={() => runAction('ban', pendingBan)}
      />
    </div>
  );
}
