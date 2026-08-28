import { useState } from 'react';
import { Ban, Gamepad2, LogOut, Users } from 'lucide-react';
import { toast } from 'sonner';
import { ViewHeader, SummaryGrid, SummaryItem } from '@/components/layout/Page';
import { EmptyState } from '@/components/shared/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useApi } from '@/hooks/useApi';
import { useServer } from '@/context/ServerContext';
import { useT } from '@/context/I18nContext';

function CharacterSlot({ label, large = false }) {
  return (
    <div
      data-testid="terraria-player-character"
      aria-label={label}
      className={large
        ? 'flex h-20 w-20 shrink-0 items-center justify-center rounded border-2 border-dashed border-border bg-background/40'
        : 'flex h-12 w-12 shrink-0 items-center justify-center rounded border-2 border-dashed border-border bg-background/40'}
    />
  );
}

function playerName(player) {
  return typeof player === 'string' ? player : player?.name;
}

function PlayerCard({ player, characterLabel, online, onSelect, onlineLabel }) {
  return (
    <button
      type="button"
      data-testid="terraria-player-card"
      onClick={onSelect}
      className="group flex w-full items-center gap-3 rounded border-2 border-border bg-card px-3 py-3 text-left transition-colors hover:border-foreground/50 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <CharacterSlot label={characterLabel} />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{playerName(player)}</span>
      {online && <Badge variant="online">{onlineLabel}</Badge>}
    </button>
  );
}

export function TerrariaPlayersView() {
  const t = useT();
  const api = useApi();
  const { activeServer, activeServerId, statuses, supports } = useServer();
  const [selectedPlayerName, setSelectedPlayerName] = useState(null);
  const [busyAction, setBusyAction] = useState(null);
  const status = statuses[activeServerId] || { players: [], playerCount: 0, maxPlayers: 0, status: 'offline' };
  const processStatus = status.status || 'offline';
  const livePlayers = Array.isArray(status.players) ? status.players : [];
  const players = livePlayers.map(playerName).filter(Boolean);
  const selectedPlayer = players.find((name) => name === selectedPlayerName) || null;
  const isOnline = processStatus === 'online';
  const canManage = isOnline && supports('players') && supports('console');

  const runAction = async (action) => {
    if (!selectedPlayer || !canManage || busyAction) return;
    setBusyAction(action);
    try {
      await api(`/api/terraria/players/${action}`, {
        method: 'POST',
        body: { target: selectedPlayer },
      });
      toast.success(t(`terraria.players.${action}Success`, { name: selectedPlayer }));
      setSelectedPlayerName(null);
    } catch (error) {
      toast.error(error.message || t('terraria.players.actionFailed'));
    } finally {
      setBusyAction(null);
    }
  };

  const statusVariant = processStatus === 'online'
    ? 'online'
    : ['starting', 'stopping'].includes(processStatus) ? 'starting' : 'offline';
  const statusLabel = ['online', 'offline', 'starting', 'stopping'].includes(processStatus)
    ? t(`terraria.players.status.${processStatus}`)
    : processStatus;
  const emptyMessage = processStatus === 'offline'
    ? t('terraria.players.emptyOffline')
    : t('terraria.players.emptyOnline');

  return (
    <div data-testid="terraria-players-view" className="space-y-6">
      <ViewHeader
        title={t('terraria.players.title')}
        description={t('terraria.players.description')}
        actions={<Badge variant={statusVariant}>{statusLabel}</Badge>}
      />

      <SummaryGrid>
        <SummaryItem
          icon={Users}
          label={t('terraria.players.connected')}
          value={`${status.playerCount ?? livePlayers.length}/${status.maxPlayers || '—'}`}
          tone="online"
        />
        <SummaryItem
          icon={Gamepad2}
          label={t('terraria.players.server')}
          value={activeServer?.name || t('terraria.players.noServer')}
          tone="primary"
        />
      </SummaryGrid>

      <section className="surface-heat rounded border-2 border-border bg-card">
        <div className="flex items-center justify-between gap-3 border-b-2 border-border px-4 py-3">
          <div>
            <h2 className="font-display text-base font-extrabold uppercase tracking-tight text-foreground">
              {t('terraria.players.rosterTitle')}
            </h2>
            <p className="text-xs text-muted-foreground">{t('terraria.players.rosterDescription')}</p>
          </div>
          <span className="text-sm font-semibold text-muted-foreground">{players.length}</span>
        </div>
        <div className="p-4">
          {livePlayers.length === 0 ? (
            <div data-testid="terraria-players-empty">
              <EmptyState icon={Users} title={t('terraria.players.emptyTitle')} message={emptyMessage} />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {players.map((name) => (
                <PlayerCard
                  key={name}
                  player={name}
                  characterLabel={t('terraria.players.characterUnavailable')}
                  online={isOnline}
                  onlineLabel={t('terraria.players.online')}
                  onSelect={() => setSelectedPlayerName(name)}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      <Dialog open={Boolean(selectedPlayer)} onOpenChange={(open) => !open && setSelectedPlayerName(null)}>
        <DialogContent>
          <DialogHeader>
            <div className="flex items-center gap-3 pr-6">
              <CharacterSlot large label={t('terraria.players.characterUnavailable')} />
              <div className="min-w-0 space-y-1">
                <DialogTitle className="truncate">{selectedPlayer}</DialogTitle>
                <Badge variant={isOnline ? 'online' : 'offline'}>
                  {t(`terraria.players.status.${isOnline ? 'online' : 'offline'}`)}
                </Badge>
              </div>
            </div>
          </DialogHeader>
          <DialogBody className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('terraria.players.characterUnavailable')}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button
                variant="outline"
                disabled={!canManage || Boolean(busyAction)}
                onClick={() => runAction('kick')}
              >
                <LogOut />
                {t('terraria.players.kick')}
              </Button>
              <Button
                variant="destructive"
                disabled={!canManage || Boolean(busyAction)}
                onClick={() => runAction('ban')}
              >
                <Ban />
                {t('terraria.players.ban')}
              </Button>
            </div>
            {!canManage && (
              <p className="text-xs text-muted-foreground">{t('terraria.players.actionsUnavailable')}</p>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}
