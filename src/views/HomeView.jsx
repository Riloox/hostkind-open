import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, ArrowRight, Play, Plus, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { GameChoices, useAddServer } from '@/components/shared/AddServer';
import { GameIcon } from '@/components/shared/GameArtwork';
import { StatusPill } from '@/components/shared/StatusPill';
import { TrashPanel } from '@/components/shared/TrashPanel';
import { useServer } from '@/context/ServerContext';
import { useT } from '@/context/I18nContext';
import { useApi } from '@/hooks/useApi';
import { usePolling } from '@/hooks/usePolling';
import { useSectionContextFor } from '@/hooks/useSections';
import { useAttentionItems } from '@/hooks/useAttentionItems';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import { attentionSummary } from '@/lib/overview';
import { gameForServer } from '@/lib/games';
import { cn, fmtMB, fmtUptime } from '@/lib/utils';

// The list is not the open server, so it gets no live stats stream; a
// snapshot this often is enough to see which server is busy.
const RESOURCES_MS = 15_000;

/**
 * Where `/` lands, and what `/servers` shows. With one server `/` never shows
 * this - the shell opens that server instead. With none, it is the first step
 * of adding one: pick the game. Otherwise it is every server side by side,
 * each with what says whether it is OK and the button that starts or stops it.
 */
export function HomeView({ onOpenServer, onRefresh }) {
  const t = useT();
  const { servers } = useServer();
  const { canAddServer, openAddServer } = useAddServer();

  if (servers.length === 0) {
    return (
      <div className="mx-auto max-w-4xl space-y-6 py-4">
        <div className="space-y-1.5">
          <h1 className="font-display text-2xl font-extrabold uppercase tracking-[0.01em] text-foreground">
            {t('home.firstTitle')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {canAddServer ? t('home.firstBody') : t('home.firstBodyViewer')}
          </p>
        </div>
        {canAddServer && <GameChoices onChoose={(game) => openAddServer(game)} />}
        {/* A server removed with its files can come back from here. */}
        {canAddServer && <TrashPanel onRestored={() => onRefresh?.()} />}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {canAddServer && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => openAddServer()}>
            <Plus className="h-3.5 w-3.5" />
            {t('addServer.button')}
          </Button>
        </div>
      )}
      <div className="overflow-x-auto rounded border-2 border-border bg-card">
        <table data-server-list className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-label font-semibold uppercase tracking-wider text-muted-foreground">
              <th className="py-2.5 pl-4 pr-4">{t('servers.colServer')}</th>
              <th className="py-2.5 pr-4">{t('servers.colStatus')}</th>
              <th className="py-2.5 pr-4">{t('servers.colPlayers')}</th>
              <th className="hidden py-2.5 pr-4 md:table-cell">{t('servers.colResources')}</th>
              <th className="hidden py-2.5 pr-4 md:table-cell">{t('servers.colLastBackup')}</th>
              <th className="py-2.5 pr-4">{t('servers.colAttention')}</th>
              <th className="py-2.5 pr-4"><span className="sr-only">{t('servers.colActions')}</span></th>
            </tr>
          </thead>
          <tbody>
            {servers.map((server) => (
              <ServerRow key={server.id} server={server} onOpen={() => onOpenServer(server.id)} />
            ))}
          </tbody>
        </table>
      </div>
      {canAddServer && <TrashPanel onRestored={() => onRefresh?.()} />}
    </div>
  );
}

// A point-in-time CPU and memory reading for a running server.
function useServerResources(serverId, running) {
  const api = useApi();
  const [stats, setStats] = useState(null);

  const load = useCallback(async () => {
    try { setStats(await api('/api/system', { serverId, silent: true })); }
    catch { setStats(null); }
  }, [api, serverId]);

  useEffect(() => {
    setStats(null);
    if (running) load();
  }, [running, load]);

  usePolling(load, { activeInterval: RESOURCES_MS, enabled: running });
  return running ? stats : null;
}

/* One server: who it is, whether it is up, how busy, when it was last backed
   up and how much needs attention. The whole row opens it; Start/Stop act in
   place. */
function ServerRow({ server, onOpen }) {
  const t = useT();
  const api = useApi();
  const { statuses } = useServer();
  const { ago } = useRelativeTime();
  const ctx = useSectionContextFor(server);
  const attention = useAttentionItems(server.id);
  const summary = attentionSummary(attention.items);
  const [pending, setPending] = useState(false);
  const dash = t('common.dashPlaceholder');

  const status = statuses[server.id] || server.status || { status: 'offline' };
  const state = status.status || 'offline';
  const running = state !== 'offline';
  const stats = useServerResources(server.id, running);
  const game = gameForServer(server);

  const players = running && ctx.supports('players')
    ? (status.maxPlayers
      ? t('overview.playersOf', { count: status.playerCount || 0, max: status.maxPlayers })
      : `${status.playerCount || 0}`)
    : dash;
  const resources = stats
    ? `${Math.round(stats.procCpu || 0)}% · ${fmtMB((stats.procMem || 0) / 1048576)}`
    : dash;
  const lastBackup = !attention.hasBackups ? dash
    : attention.lastBackupAt ? ago(attention.lastBackupAt) : t('servers.noBackupYet');

  async function lifecycle(event, action) {
    event.stopPropagation();
    setPending(true);
    try { await api(`/api/servers/${server.id}/${action}`, { method: 'POST' }); }
    catch (e) { toast.error(e.message); }
    finally { setPending(false); }
  }

  return (
    <tr
      onClick={onOpen}
      className="cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-muted/30"
    >
      <td className="py-3 pl-4 pr-4">
        <div className="flex min-w-0 items-center gap-3">
          <GameIcon gameId={game} className="h-6 w-auto max-w-7 shrink-0" fallbackClassName="h-6 w-6 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="max-w-[240px] truncate font-medium text-foreground" title={server.name}>{server.name}</div>
            <div className="text-xs text-muted-foreground">{t(`games.${game}`)}</div>
          </div>
        </div>
      </td>
      <td className="py-3 pr-4">
        <div className="flex items-center gap-2 whitespace-nowrap">
          <StatusPill status={state} />
          {running && status.uptimeMs ? (
            <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">{fmtUptime(status.uptimeMs)}</span>
          ) : null}
        </div>
      </td>
      <td className="whitespace-nowrap py-3 pr-4 tabular-nums text-muted-foreground">{players}</td>
      <td className="hidden whitespace-nowrap py-3 pr-4 tabular-nums text-muted-foreground md:table-cell">{resources}</td>
      <td
        data-backup-stale={summary.backupStale || undefined}
        className={cn('hidden whitespace-nowrap py-3 pr-4 md:table-cell', summary.backupStale ? 'text-status-warn' : 'text-muted-foreground')}
      >
        {summary.backupStale && <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden="true" />}
        {lastBackup}
      </td>
      <td className="py-3 pr-4">
        {summary.count > 0 ? (
          <span
            data-attention-count={summary.count}
            title={t('servers.attentionCount', { count: summary.count })}
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums',
              summary.critical ? 'bg-status-error/15 text-status-error' : 'bg-status-warn/15 text-status-warn',
            )}
          >
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            {summary.count}
            <span className="sr-only">{t('servers.attentionCount', { count: summary.count })}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">{attention.loading ? '' : dash}</span>
        )}
      </td>
      <td className="py-3 pr-4">
        <div className="flex items-center justify-end gap-1.5">
          {running ? (
            <Button variant="glass" size="sm" disabled={pending} onClick={(e) => lifecycle(e, 'stop')} aria-label={t('servers.btnStop')}>
              <Square className="h-3 w-3 fill-current text-status-error" />
              <span className="hidden lg:inline">{t('servers.btnStop')}</span>
            </Button>
          ) : (
            <Button variant="glass" size="sm" disabled={pending} onClick={(e) => lifecycle(e, 'start')} aria-label={t('servers.btnStart')}>
              <Play className="h-3 w-3 fill-current text-status-online" />
              <span className="hidden lg:inline">{t('servers.btnStart')}</span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            aria-label={t('servers.btnOpenNamed', { name: server.name })}
          >
            <span className="hidden sm:inline">{t('servers.btnOpen')}</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </td>
    </tr>
  );
}
