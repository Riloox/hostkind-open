import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '@/hooks/useApi';
import { usePolling } from '@/hooks/usePolling';
import { useSectionContextFor } from '@/hooks/useSections';
import { useServer } from '@/context/ServerContext';
import { buildAttentionItems, gameUpdateReady, latestBackupAt, nextScheduled } from '@/lib/overview';

const REFRESH_MS = 60_000;

// Each source is read only when the server has it and the user may see it, so
// a restricted account never trips a 403, and a source that fails leaves the
// rest of the list standing.
function sourcesFor(serverId, { supports, can }) {
  const q = `?serverId=${encodeURIComponent(serverId)}`;
  const gameUpdates = supports('palworld-updates') ? '/api/palworld/updates'
    : supports('valheim-updates') ? '/api/valheim/updates' : null;
  return {
    health: can('health.view') ? `/api/health${q}` : null,
    crashes: can('health.view') ? `/api/crashes${q}&acknowledged=false` : null,
    contentUpdates: supports('updates') && supports('content-install') && can('updates.view') ? `/api/updates/summary${q}` : null,
    gameUpdate: gameUpdates && can('updates.view') ? gameUpdates : null,
    backups: supports('backups') && can('backups.view') ? '/api/backups' : null,
    tasks: supports('schedules') && can('schedules.view') ? '/api/tasks' : null,
  };
}

/**
 * Everything a server's Overview needs besides live stats: the Needs
 * attention list (health findings, unacknowledged crashes, available updates,
 * a never-started server, the watchdog giving up) plus the facts line (last
 * backup, next schedule) and the health baselines the KPI cards compare with.
 *
 * `dismiss(id)` drops an item once its inline action succeeded. It stays
 * dropped for this server even if a refresh still lists it.
 */
export function useAttentionItems(serverId) {
  const api = useApi();
  const { servers, statuses, notifications } = useServer();
  const server = servers.find((s) => s.id === serverId);
  // Any server, not only the open one: the all-servers list asks for each row.
  const ctx = useSectionContextFor(server);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(() => new Set());
  const loadId = useRef(0);

  // Keyed by content: a reloaded server list hands out new capability arrays
  // for the same server, which must not restart the fetch and blank the list.
  const sourcesKey = serverId ? JSON.stringify(sourcesFor(serverId, ctx)) : '';
  const sources = useMemo(() => (sourcesKey ? JSON.parse(sourcesKey) : null), [sourcesKey]);

  const load = useCallback(async () => {
    if (!sources) return;
    const id = ++loadId.current;
    const entries = Object.entries(sources);
    const results = await Promise.allSettled(entries.map(([, path]) => (
      path ? api(path, { serverId, silent: true }) : Promise.resolve(null)
    )));
    if (id !== loadId.current) return;
    const got = Object.fromEntries(entries.map(([key], i) => [key, results[i].status === 'fulfilled' ? results[i].value : null]));
    setData({ ...got, fetchedAt: Date.now() });
    setLoading(false);
  }, [api, serverId, sources]);

  useEffect(() => {
    setData(null);
    setLoading(true);
    setDismissed(new Set());
    load();
  }, [load]);

  usePolling(load, { activeInterval: REFRESH_MS, enabled: !!serverId });

  const state = statuses[serverId]?.status || 'offline';
  const running = state !== 'offline';

  const items = useMemo(() => {
    if (!data || !serverId) return [];
    return buildAttentionItems({
      serverId,
      running,
      hasGenerated: server ? server.hasGenerated !== false : true,
      findings: data.health?.findings || [],
      crashes: data.crashes?.items || [],
      contentUpdates: data.contentUpdates?.available || 0,
      gameUpdate: gameUpdateReady(data.gameUpdate?.update),
      notifications,
      tracksTps: ctx.supports('players'),
    }).filter((item) => !dismissed.has(item.id));
  }, [data, serverId, running, server, notifications, ctx, dismissed]);

  const dismiss = useCallback((id) => {
    setDismissed((prev) => new Set(prev).add(id));
  }, []);

  return {
    items,
    loading,
    health: data?.health || null,
    // When the list was last checked: the health analysis when there is one,
    // else when these sources were read.
    checkedAt: data ? (data.health?.computedAt || data.fetchedAt) : null,
    lastBackupAt: data?.backups ? latestBackupAt(data.backups.backups) : null,
    hasBackups: !!data?.backups,
    next: data?.tasks ? nextScheduled(data.tasks.tasks, serverId) : null,
    reload: load,
    dismiss,
  };
}
