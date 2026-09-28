import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { BrandMark } from '@/components/shared/BrandMark';
import { useBranding } from '@/context/AuthContext';
import { useServer } from '@/context/ServerContext';
import { useT } from '@/context/I18nContext';
import { cn } from '@/lib/utils';
import { viewAvailable } from '@/lib/sections';
import { useSectionContext } from '@/hooks/useSections';
import { useNarrowScreen } from '@/hooks/useNarrowScreen';
import { ServerSwitcher } from './ServerSwitcher';
import {
  LayoutDashboard, Terminal, Users,
  Puzzle, Database, Clock, Globe2, Settings,
  ChevronsLeft, ChevronsRight,
  LifeBuoy,
} from 'lucide-react';

// One flat list of what the open server has. No group headings: a list short
// enough to read at a glance does not need sorting into drawers. Each item is
// shown only when the server has that section (src/lib/sections.js). Details
// and crash pages are reached from the overview and mark it as current.
const SERVER_NAV = [
  { view: 'dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard, also: ['details', 'crashes'] },
  { view: 'console',   labelKey: 'nav.console',   icon: Terminal },
  { view: 'players',   labelKey: 'nav.players',   icon: Users },
  { view: 'worlds',    labelKey: 'nav.worlds',    icon: Globe2 },
  { view: 'mods',      labelKey: 'nav.mods',      icon: Puzzle },
  { view: 'backups',   labelKey: 'nav.backups',   icon: Database },
  { view: 'tasks',     labelKey: 'nav.schedules', icon: Clock },
  { view: 'settings',  labelKey: 'nav.settings',  icon: Settings },
];

function getInitialMode() {
  try {
    const m = localStorage.getItem('ls-sidebar-mode');
    return m === 'collapsed' ? 'collapsed' : 'expanded';
  } catch {
    return 'expanded';
  }
}

function storeMode(mode) {
  try { localStorage.setItem('ls-sidebar-mode', mode); } catch {}
}

/**
 * The app's left rail. On a phone (useNarrowScreen) it is a drawer instead:
 * off screen until the header's menu button opens it (`drawerOpen`), over the
 * page with a scrim, and closed again by the scrim, Escape or any navigation
 * (App closes it on every route change).
 */
export function Sidebar({ currentView, onNavigate, onHome, onSwitchServer, onAllServers, drawerOpen = false, onDrawerClose }) {
  const branding = useBranding();
  const { servers, activeServerId, moduleCapabilities } = useServer();
  const sectionContext = useSectionContext();
  const t = useT();
  const [mode, setMode] = useState(getInitialMode);
  const narrow = useNarrowScreen();
  const drawerHidden = narrow && !drawerOpen;

  const toggleMode = () => {
    setMode(prev => {
      const next = prev === 'expanded' ? 'collapsed' : 'expanded';
      storeMode(next);
      return next;
    });
  };

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setMode(prev => {
          const next = prev === 'expanded' ? 'collapsed' : 'expanded';
          storeMode(next);
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The drawer always opens full width; the collapsed rail is a desktop choice.
  const isCollapsed = !narrow && mode === 'collapsed';

  useEffect(() => {
    document.documentElement.style.setProperty('--ls-sidebar-w', narrow ? '0px' : isCollapsed ? '48px' : '220px');
  }, [isCollapsed, narrow]);

  useEffect(() => {
    if (!narrow || !drawerOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onDrawerClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [narrow, drawerOpen, onDrawerClose]);

  // With no server open there is nothing for the server's sections to act on,
  // so they are not offered at all rather than shown disabled.
  const hasServer = !!activeServerId && servers.some((s) => s.id === activeServerId);
  const serverItems = hasServer ? SERVER_NAV.filter((it) => viewAvailable(it.view, sectionContext)) : [];

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

    // Travel is reserved for actual navigation. The rail narrowing, or an item
    // appearing once a server is open, move the target without the user having
    // gone anywhere - those are placed, not animated.
    const navigated = lastViewRef.current !== null && lastViewRef.current !== currentView;
    lastViewRef.current = currentView;

    const target = rail.querySelector('[data-nav-item][data-active="true"]');
    if (!target) {
      // Pages with no rail entry (home, the server list, Hostkind settings) leave the rail
      // unmarked rather than pointing at a station the user is not on.
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
  }, [currentView, isCollapsed, activeServerId, moduleCapabilities, servers]);

  const renderItem = ({ view, labelKey, icon: Icon, also }) => {
    const label = t(labelKey);
    const isActive = currentView === view || !!also?.includes(currentView);
    const itemBtn = (
      <button
        key={view}
        type="button"
        data-nav-item={view}
        data-active={isActive ? 'true' : 'false'}
        aria-current={isActive ? 'page' : undefined}
        onClick={() => onNavigate(view)}
        className={cn(
          'flex min-h-9 w-full items-center rounded-sm border transition-[background-color,color,border-color] duration-100',
          isCollapsed ? 'justify-center px-0 py-1.5' : 'gap-3 px-3 py-1.5',
          isActive
            // The rail marker carries the accent edge, so the item itself
            // does not also outline.
            ? 'border-transparent bg-primary/15 text-primary font-bold'
            : 'border-transparent text-muted-foreground hover:border-border hover:bg-secondary hover:text-foreground'
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {!isCollapsed && <span className="truncate">{label}</span>}
      </button>
    );
    if (!isCollapsed) return itemBtn;
    return (
      <Tooltip key={view}>
        <TooltipTrigger asChild>{itemBtn}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>{label}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    <>
    {narrow && drawerOpen && (
      <div data-sidebar-scrim aria-hidden className="fixed inset-0 z-40 bg-background/70 backdrop-blur-sm" onClick={onDrawerClose} />
    )}
    <aside
      data-app-sidebar
      data-drawer={narrow ? (drawerOpen ? 'open' : 'closed') : undefined}
      // Off screen is out of the tab order and the accessibility tree too.
      {...(drawerHidden ? { inert: '', 'aria-hidden': true } : {})}
      className={cn(
        'fleet-sidebar fixed top-0 left-0 flex h-screen flex-col overflow-hidden border-r-2 border-sidebar-border backdrop-blur-xl duration-200',
        narrow
          ? cn('z-50 w-sidebar bg-sidebar transition-transform', drawerOpen ? 'translate-x-0' : '-translate-x-full')
          : cn('z-20 bg-sidebar/80 transition-[width]', isCollapsed ? 'w-sidebar-collapsed' : 'w-sidebar'),
      )}
    >
      {/* Same h-16 as the header, so the brand block's bottom rule lines up
          exactly with the header's across the sidebar seam. */}
      <div className={cn(
        'flex h-16 shrink-0 items-center border-b-2 border-border',
        isCollapsed ? 'justify-center px-2' : 'px-3'
      )}>
        <BrandMark
          collapsed={isCollapsed}
          onClick={onHome}
        />
      </div>

      {servers.length > 0 && (
        <div className={cn('shrink-0 border-b-2 border-border', isCollapsed ? 'p-1.5' : 'p-2')}>
          <ServerSwitcher collapsed={isCollapsed} onSwitch={onSwitchServer} onAllServers={onAllServers} />
        </div>
      )}

      <nav ref={railRef} className="fleet-rail flex-1 overflow-y-auto py-3 px-2">
        <span ref={markerRef} className="fleet-rail-marker" data-instant="true" aria-hidden="true" />
        {serverItems.map(renderItem)}
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
        {!narrow && <Button
          variant="ghost"
          size="sm"
          onClick={toggleMode}
          className={cn('text-muted-foreground hover:text-foreground', isCollapsed ? 'justify-center px-0' : 'justify-start gap-3')}
          title={isCollapsed ? t('sidebar.expandTitle') : t('sidebar.collapseTitle')}
        >
          {isCollapsed
            ? <ChevronsRight className="h-4 w-4" />
            : <><ChevronsLeft className="h-4 w-4" /> {t('sidebar.collapseLabel')}</>}
        </Button>}
      </div>

    </aside>
    </>
  );
}
