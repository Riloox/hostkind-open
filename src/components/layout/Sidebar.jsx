import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { BrandMark } from '@/components/shared/BrandMark';
import { GameLogo } from '@/components/shared/GameArtwork';
import { useAuth, useBranding } from '@/context/AuthContext';
import { useServer } from '@/context/ServerContext';
import { useT } from '@/context/I18nContext';
import { cn } from '@/lib/utils';
import { gameForServer, gameById } from '@/lib/games';
import {
  LayoutDashboard, Server, BarChart2, Terminal, Users, User, Map,
  Puzzle, Package, FolderOpen, FileText, Database, Clock, Globe2,
  RefreshCw,
  Gamepad2,
  ShieldCheck,
  ChevronDown, ChevronsLeft, ChevronsRight, ChevronsLeftRight,
  LifeBuoy,
} from 'lucide-react';

const NAV_GROUPS = [
  {
    key: 'nav.groupOverview',
    items: [
      { view: 'dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard },
      { view: 'servers',   labelKey: 'nav.servers',   icon: Server },
      { view: 'health',    labelKey: 'nav.health',    icon: BarChart2, requiresServer: true },
    ],
  },
  {
    key: 'nav.groupOperate',
    items: [
      { view: 'console', labelKey: 'nav.console', icon: Terminal, requiresServer: true },
      { view: 'players', labelKey: 'nav.players', icon: Users, requiresServer: true, capability: 'players.view', moduleCapability: ['players', 'terraria-tshock'] },
      { view: 'map',     labelKey: 'nav.map',     icon: Map, requiresServer: true, moduleCapability: 'map' },
    ],
  },
  {
    key: 'nav.groupContent',
    items: [
      { view: 'addons',   labelKey: 'nav.addons',   icon: Puzzle, requiresServer: true, moduleCapability: ['addons', 'terraria-mods'] },
      { view: 'content', labelKey: 'nav.modrinth', icon: Package, requiresServer: true, moduleCapability: 'content-install' },
      { view: 'files',    labelKey: 'nav.files',    icon: FolderOpen, requiresServer: true, moduleCapability: 'files' },
      { view: 'configs',  labelKey: 'nav.configs',  icon: FileText, requiresServer: true, moduleCapability: 'configs' },
      // Two world models, one view: Minecraft's folder-per-world and Terraria's
      // file-per-world. A server declares whichever one it actually has.
      { view: 'worlds',   labelKey: 'nav.worlds',   icon: Globe2, requiresServer: true, capability: 'worlds.view', moduleCapability: ['worlds', 'terraria-worlds', 'valheim-worlds'] },
    ],
  },
  {
    key: 'nav.groupMaintenance',
    items: [
      { view: 'updates', labelKey: 'nav.updates', icon: RefreshCw, requiresServer: true, moduleCapability: 'updates' },
      { view: 'backups', labelKey: 'nav.backups',   icon: Database, requiresServer: true, moduleCapability: 'backups' },
      { view: 'tasks',   labelKey: 'nav.schedules', icon: Clock, requiresServer: true, moduleCapability: 'schedules' },
    ],
  },
  {
    key: 'nav.groupSettings',
    items: [
      { view: 'users', labelKey: 'nav.users', icon: User, capability: 'users.manage' },
      { view: 'audit', labelKey: 'nav.audit', icon: ShieldCheck, capability: 'audit.view' },
    ],
  },
];

// A nav item may name one module capability or any of a list of them.
const supportsAny = (capability, supports) =>
  (Array.isArray(capability) ? capability : [capability]).some((entry) => supports(entry));

function getInitialCollapsed() {
  try {
    const arr = JSON.parse(localStorage.getItem('ls-collapsed-navs') || '[]');
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function getInitialMode() {
  try {
    const m = localStorage.getItem('ls-sidebar-mode');
    return m === 'collapsed' ? 'collapsed' : 'expanded';
  } catch {
    return 'expanded';
  }
}

export function Sidebar({ currentView, onNavigate, onAllGames }) {
  const { user, hasCapability } = useAuth();
  const branding = useBranding();
  const { servers, activeServerId, activeModule, supports, currentGame } = useServer();
  const t = useT();
  const isAdmin = user?.role === 'admin';
  const hasServers = (servers || []).some(server => !currentGame || gameForServer(server) === currentGame);
  const [collapsed, setCollapsed] = useState(getInitialCollapsed);
  const [mode, setMode] = useState(getInitialMode);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setMode(prev => {
          const next = prev === 'expanded' ? 'collapsed' : 'expanded';
          try { localStorage.setItem('ls-sidebar-mode', next); } catch {}
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleMode = () => {
    setMode(prev => {
      const next = prev === 'expanded' ? 'collapsed' : 'expanded';
      try { localStorage.setItem('ls-sidebar-mode', next); } catch {}
      return next;
    });
  };

  const toggleGroup = (key) => {
    if (mode === 'collapsed') return;
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      localStorage.setItem('ls-collapsed-navs', JSON.stringify([...next]));
      return next;
    });
  };

  const isCollapsed = mode === 'collapsed';

  useEffect(() => {
    document.documentElement.style.setProperty('--ls-sidebar-w', isCollapsed ? '48px' : '220px');
  }, [isCollapsed]);

  // The active marker belongs to the rail, not to the item. It travels to
  // whichever station is current, which is what ties the views together into
  // one desk instead of a sequence of pages.
  const railRef = useRef(null);
  const markerRef = useRef(null);
  const lastViewRef = useRef(null);
  const lastPosRef = useRef(null);

  useLayoutEffect(() => {
    const rail = railRef.current;
    const marker = markerRef.current;
    if (!rail || !marker) return;

    // Travel is reserved for actual navigation. A group collapsing, the rail
    // narrowing, or an item appearing once a server exists all move the target
    // without the user having gone anywhere - those are placed, not animated.
    const navigated = lastViewRef.current !== null && lastViewRef.current !== currentView;
    lastViewRef.current = currentView;

    const target = rail.querySelector('[data-nav-item][data-active="true"]');
    if (!target) {
      // Views with no rail entry (the games picker) leave the rail unmarked
      // rather than pointing at a station the user is not on.
      marker.style.setProperty('--marker-opacity', '0');
      lastPosRef.current = null;
      return;
    }

    const pos = `${target.offsetTop}:${target.offsetHeight}`;
    // Nothing moved, so leave the marker completely alone. This effect can run
    // again mid-travel (any dependency changing during a navigation), and
    // re-stamping `instant` on an in-flight marker would kill the transition
    // and snap it to the end.
    if (lastPosRef.current === pos) return;
    lastPosRef.current = pos;

    marker.dataset.instant = navigated ? 'false' : 'true';
    marker.style.setProperty('--marker-y', `${target.offsetTop}px`);
    marker.style.setProperty('--marker-h', String(target.offsetHeight));
    marker.style.setProperty('--marker-opacity', '1');
  }, [currentView, isCollapsed, collapsed, hasServers, activeServerId, currentGame, servers]);

  return (
    <aside data-tour="sidebar" className={cn(
      'fleet-sidebar fixed top-0 left-0 z-20 flex h-screen flex-col overflow-hidden border-r-2 border-sidebar-border bg-sidebar/80 backdrop-blur-xl transition-[width] duration-200',
      isCollapsed ? 'w-sidebar-collapsed' : 'w-sidebar'
    )}>
      {/* Same h-16 as the header, so the brand block's bottom rule lines up
          exactly with the header's across the sidebar seam. */}
      <div className={cn(
        'flex h-16 shrink-0 items-center border-b-2 border-border',
        isCollapsed ? 'justify-center px-2' : 'px-3'
      )}>
        <BrandMark
          collapsed={isCollapsed}
          onClick={onAllGames}
        />
      </div>

      <nav ref={railRef} className="fleet-rail flex-1 overflow-y-auto py-3 px-2">
        <span ref={markerRef} className="fleet-rail-marker" data-instant="true" aria-hidden="true" />
        {currentGame ? (() => {
          const gameIdentityBtn = (
            <button
              type="button"
              onClick={onAllGames}
              title={t('games.switchTitle')}
              className={cn('mb-3 flex min-h-11 w-full items-center rounded-sm border border-transparent text-muted-foreground hover:border-border hover:bg-primary/15 hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring', isCollapsed ? 'justify-center' : 'gap-3 px-3')}
            >
              <GameLogo gameId={currentGame} className="h-4 w-auto max-w-5 shrink-0" />
              {!isCollapsed && (
                <>
                  <span className="truncate">{gameById(currentGame).label}</span>
                  <ChevronsLeftRight className="ml-auto h-3 w-3 opacity-60" />
                </>
              )}
            </button>
          );
          if (!isCollapsed) return gameIdentityBtn;
          return (
            <Tooltip>
              <TooltipTrigger asChild>{gameIdentityBtn}</TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>{gameById(currentGame).label}</TooltipContent>
            </Tooltip>
          );
        })() : (
          <button type="button" onClick={onAllGames} className={cn('mb-3 flex min-h-11 w-full items-center rounded-sm border border-transparent text-muted-foreground hover:border-border hover:bg-primary/15 hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring', isCollapsed ? 'justify-center' : 'gap-3 px-3')}>
            <Gamepad2 className="h-4 w-4 shrink-0" />
            {!isCollapsed && <span className="whitespace-nowrap">{t('games.allGames')}</span>}
          </button>
        )}
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter((it) => (
            !(it.adminOnly && !isAdmin)
            && !(it.game && currentGame !== it.game)
            && !(it.capability && !hasCapability(it.capability, it.requiresServer ? activeServerId : null))
            && !(it.moduleCapability && currentGame && !supportsAny(it.moduleCapability, supports))
          ));
          if (items.length === 0) return null;
          return (
          <div key={group.key} className="mb-1">
            {!isCollapsed && (
              <button
                type="button"
                onClick={() => toggleGroup(group.key)}
                className="flex w-full items-center justify-between px-3 py-1.5 text-label font-semibold uppercase tracking-widest text-muted-foreground/70 hover:text-muted-foreground transition-colors"
              >
                {t(group.key)}
                <ChevronDown className={cn('h-3 w-3 transition-transform', collapsed.has(group.key) && '-rotate-90')} />
              </button>
            )}
            {(isCollapsed || !collapsed.has(group.key)) && items.map(({ view, labelKey, icon: Icon, requiresServer }) => {
              const label = t(labelKey);
              const disabled = requiresServer && !hasServers;
              const isActive = currentView === view;
              const itemBtn = (
                <button
                  key={view}
                  type="button"
                  data-tour={`nav-${view}`}
                  data-nav-item={view}
                  data-active={isActive ? 'true' : 'false'}
                  onClick={() => { if (!disabled) onNavigate(view); }}
                  aria-disabled={disabled}
                  className={cn(
                    'flex min-h-9 w-full items-center border transition-[background-color,color,border-color] duration-100',
                    isCollapsed ? 'justify-center px-0 py-1.5' : 'gap-3 px-3 py-1.5',
                    isCollapsed
                      ? 'rounded-sm'
                      : 'rounded-sm',
                    disabled
                      ? 'border-transparent text-muted-foreground/35 cursor-not-allowed'
                      : isActive
                        // The rail marker now carries the amber edge, so the
                        // item itself does not also outline in amber.
                        ? 'border-transparent bg-primary/15 text-primary font-bold'
                        : 'border-transparent text-muted-foreground hover:border-border hover:bg-secondary hover:text-foreground'
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!isCollapsed && <span className="truncate">{label}</span>}
                </button>
              );
              if (!isCollapsed && !disabled) return itemBtn;
              return (
                <Tooltip key={view}>
                  <TooltipTrigger asChild>{itemBtn}</TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {disabled ? t('nav.requiresServerTip') : label}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
          );
        })}
      </nav>

      <div className="border-t-2 border-border p-3 flex flex-col gap-1">
        {/* A provider's own helpdesk, when they have configured one. Absent by
            default: an empty link to nowhere is worse than no link. */}
        {branding.supportUrl && (
          <Button
            asChild
            variant="ghost"
            size="sm"
            className={cn('text-muted-foreground hover:text-foreground', isCollapsed ? 'justify-center px-0' : 'justify-start gap-3')}
            title={t('sidebar.supportTitle')}
          >
            <a href={branding.supportUrl} target="_blank" rel="noreferrer noopener">
              <LifeBuoy className="h-4 w-4" />
              {!isCollapsed && t('sidebar.supportLabel')}
            </a>
          </Button>
        )}
        {/* A provider's legal line, when they configured one. Plain text only:
            the value is free-form config and is rendered verbatim. */}
        {!isCollapsed && branding.legalFooter && (
          <p className="px-3 text-label text-muted-foreground/60">{branding.legalFooter}</p>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleMode}
          className={cn('text-muted-foreground hover:text-foreground', isCollapsed ? 'justify-center px-0' : 'justify-start gap-3')}
          title={isCollapsed ? t('sidebar.expandTitle') : t('sidebar.collapseTitle')}
        >
          {isCollapsed
            ? <ChevronsRight className="h-4 w-4" />
            : <><ChevronsLeft className="h-4 w-4" /> {t('sidebar.collapseLabel')}</>}
        </Button>
      </div>

    </aside>
  );
}
