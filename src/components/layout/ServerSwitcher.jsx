import { useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChevronsUpDown, LayoutList, Plus, Search } from 'lucide-react';
import { useServer } from '@/context/ServerContext';
import { StatusDot } from '@/components/shared/StatusPill';
import { useAddServer } from '@/components/shared/AddServer';
import { useT } from '@/context/I18nContext';
import { cn, fmtUptime } from '@/lib/utils';
import { gameById, gameForServer } from '@/lib/games';
import { GameIcon } from '@/components/shared/GameArtwork';

// A search box earns its place only once the list is longer than a glance.
const SEARCH_THRESHOLD = 6;

function serverStatus(server, statuses) {
  const raw = statuses[server.id] || server.status;
  if (typeof raw === 'string') return { status: raw };
  return raw || { status: 'offline', playerCount: 0, maxPlayers: 0 };
}

function statusLabel(t, status) {
  const key = `status.${status}`;
  const translated = t(key);
  return translated === key ? status : translated;
}

/**
 * The sidebar's top block: which server the pages below act on, and the way to
 * any other one. The list portals to <body> because the sidebar clips its
 * overflow (and is 48px wide when collapsed).
 *
 * @param {boolean}  collapsed      Render the trigger as the game logo alone.
 * @param {function} onSwitch       Opens a server by id.
 * @param {function} onAllServers   Opens the list of every server.
 */
export function ServerSwitcher({ collapsed = false, onSwitch, onAllServers }) {
  const { servers, activeServerId, statuses } = useServer();
  const { canAddServer, openAddServer } = useAddServer();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [anchor, setAnchor] = useState(null);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const searchRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (triggerRef.current?.contains(e.target) || popoverRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); } };
    const onResize = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) { setQuery(''); return; }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.bottom + 4, left: rect.left });
    window.requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  const active = servers.find(s => s.id === activeServerId);
  const activeStatus = active ? serverStatus(active, statuses).status || 'offline' : null;
  const showSearch = servers.length > SEARCH_THRESHOLD;
  const normalizedQuery = query.trim().toLowerCase();
  const filteredServers = useMemo(() => {
    if (!normalizedQuery) return servers;
    return servers.filter(s => {
      const st = serverStatus(s, statuses).status || 'offline';
      return [s.name, s.mcVersion, s.type, gameById(gameForServer(s)).label, statusLabel(t, st)]
        .filter(Boolean).some(value => String(value).toLowerCase().includes(normalizedQuery));
    });
  }, [normalizedQuery, servers, statuses, t]);

  const close = () => setOpen(false);
  // On the list or an app page no server is open; that is a choice to make,
  // not an empty panel.
  const label = active ? active.name : t(servers.length ? 'serverSelector.choose' : 'serverSelector.noServers');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-server-switcher
        onClick={() => setOpen(o => !o)}
        className={cn(
          'flex w-full min-w-0 items-center rounded-sm border border-border/60 bg-secondary/40 text-left transition-colors hover:bg-secondary',
          collapsed ? 'justify-center px-0 py-2' : 'gap-2.5 px-2.5 py-2',
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={collapsed ? label : undefined}
      >
        {active ? (
          <GameIcon gameId={gameForServer(active)} className="h-5 w-auto max-w-6 shrink-0" fallbackClassName="h-5 w-5 text-muted-foreground" />
        ) : null}
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-foreground">{label}</span>
              {active && (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <StatusDot status={activeStatus} decorative />
                  {statusLabel(t, activeStatus)}
                </span>
              )}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </>
        )}
      </button>

      {open && anchor && createPortal(
        <div
          ref={popoverRef}
          style={{ top: anchor.top, left: anchor.left }}
          className="fixed z-50 w-[280px] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-popover shadow-xl animate-in fade-in-0 zoom-in-95 slide-in-from-top-2"
        >
          {showSearch && (
            <div className="border-b border-border/60 p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder={t('serverSelector.searchPlaceholder')}
                  className="h-8 w-full rounded-md border border-input bg-background/60 pl-8 pr-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-ring/50 focus:outline-none focus:ring-2 focus:ring-ring/50"
                />
              </div>
            </div>
          )}
          <div role="listbox" aria-label={t('nav.servers')} className="max-h-72 overflow-y-auto py-1">
            {servers.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">{t('serverSelector.noServers')}</div>
            ) : filteredServers.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">{t('serverSelector.noResults')}</div>
            ) : filteredServers.map(s => {
              const status = serverStatus(s, statuses);
              const st = status.status || 'offline';
              const running = st !== 'offline';
              const isActive = s.id === activeServerId;
              const meta = [
                statusLabel(t, st),
                running ? `${status.playerCount || 0}/${status.maxPlayers || '?'}` : null,
                running ? fmtUptime(status.uptimeMs) : null,
                s.mcVersion,
              ].filter(Boolean);
              return (
                <button
                  key={s.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => { close(); onSwitch(s.id); }}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors',
                    isActive ? 'bg-primary/15 text-primary' : 'text-foreground hover:bg-secondary'
                  )}
                >
                  <StatusDot status={st} />
                  <GameIcon gameId={gameForServer(s)} className="h-6 w-auto max-w-7 shrink-0" fallbackClassName="h-6 w-6 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{s.name}</span>
                    <span className={cn('block truncate text-xs', isActive ? 'text-primary/75' : 'text-muted-foreground')}>
                      {meta.join(' · ')}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {(servers.length > 0 || canAddServer) && (
            <div className="border-t border-border/60 py-1">
              {servers.length > 0 && (
                <button
                  type="button"
                  onClick={() => { close(); onAllServers(); }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-secondary"
                >
                  <LayoutList className="h-4 w-4 text-muted-foreground" />
                  {t('nav.allServers')}
                </button>
              )}
              {canAddServer && (
                <button
                  type="button"
                  onClick={() => { close(); openAddServer(); }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-secondary"
                >
                  <Plus className="h-4 w-4 text-muted-foreground" />
                  {t('addServer.button')}
                </button>
              )}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}
