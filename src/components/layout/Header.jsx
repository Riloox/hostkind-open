import { useEffect } from 'react';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
  DropdownMenuRadioGroup, DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { useI18n, useT } from '@/context/I18nContext';
import { useAuth, useBranding } from '@/context/AuthContext';
import { useServer } from '@/context/ServerContext';
import { NotificationBell } from '@/components/shared/NotificationBell';
import { ApplicationUpdateIndicator } from '@/components/shared/ApplicationUpdate';
import { StatusPill } from '@/components/shared/StatusPill';
import { ServerMenu } from '@/components/layout/ServerMenu';
import { GameIcon } from '@/components/shared/GameArtwork';
import { gameById, gameForServer } from '@/lib/games';
import { cn, fmtUptime } from '@/lib/utils';
import { SERVER_VIEWS } from '@/lib/routes';
import { panelTabAllowed } from '@/lib/panel';
import { Settings, LogOut, ChevronDown, Play, RotateCcw, Square, Sparkles, Languages, Bug, Menu, SlidersHorizontal, Users } from 'lucide-react';

const VIEW_KEYS = {
  home:     'nav.home',
  servers:  'nav.allServers',
  dashboard:'nav.dashboard',
  details:  'nav.details',
  crashes:  'nav.crash',
  console:  'nav.console',
  players:  'nav.players',
  worlds:   'nav.worlds',
  mods:     'nav.mods',
  backups:  'nav.backups',
  tasks:    'nav.schedules',
  settings: 'nav.settings',
  panel:    'nav.panelSettings',
};

// Vertical hairline between topbar zones. Purely decorative.
function ZoneDivider({ className }) {
  return <span aria-hidden="true" className={cn('h-6 w-px shrink-0 bg-border', className)} />;
}

export function Header({ currentView, onOpenNav, onOpenSettings, onOpenUpdates, whatsNewUnread, onOpenChangelog, onReportProblem, onServerAction, onNavigate, onRefresh }) {
  const t = useT();
  const { lang, setLang, supported, labels } = useI18n();
  const { user, logout, authDisabled, hasCapability } = useAuth();
  const branding = useBranding();
  const { currentGame, activeServer, statuses, servers } = useServer();
  const isGuest = user?.id === 'guest';
  const isAdmin = user?.role === 'admin';
  const canSeeUsers = panelTabAllowed('users', { isAdmin, can: (c) => hasCapability(c) });

  const initials = user?.name
    ? user.name.split(/\s+/).map(s => s[0]).join('').toUpperCase().slice(0, 2)
    : user?.username?.slice(0, 2).toUpperCase() || '?';

  const panelName = branding.name || t('brand.name');
  // Home with several servers is the list of them, and says so.
  const viewKey = currentView === 'home' && servers.length > 1 ? 'nav.allServers' : VIEW_KEYS[currentView];
  const viewLabel = currentView && viewKey ? t(viewKey, { name: panelName }) : currentView;
  // On a server's pages the header is about that server: its name, whether it
  // is up, and the controls that change that. Home, the server list and users
  // are not about any one server and just carry their title.
  const server = activeServer && SERVER_VIEWS.has(currentView) ? activeServer : null;
  const status = server ? (statuses[server.id] || { status: 'offline' }) : null;
  const state = status?.status || 'offline';
  const running = state === 'online' || state === 'starting';
  const uptime = running ? fmtUptime(status.uptimeMs) : '';
  const gameLabel = server && currentGame ? gameById(currentGame).label : null;
  const facts = [gameLabel, server?.mcVersion].filter(Boolean).join(' · ');

  // Every captured page otherwise reports the same title, which makes browser
  // tabs and window lists useless for telling two servers apart. The suffix
  // is the panel's configured name, not a literal - a white-labelled panel that
  // still says "Hostkind" in the tab has not been white-labelled.
  const serverName = server?.name || null;
  useEffect(() => {
    document.title = serverName ? `${viewLabel} · ${serverName} — ${panelName}` : `${viewLabel} — ${panelName}`;
  }, [serverName, viewLabel, panelName]);

  return (
    /* Part of the page, not a card on it: the page's own background, a
       hairline underneath, and the same side padding as <main> so the name
       lines up with the content below. */
    <header data-app-header className="sticky top-0 z-40 h-16 shrink-0 border-b-2 border-border bg-background/85 backdrop-blur-xl">
      <div className="flex h-full items-center gap-3 px-4 sm:px-6 lg:px-8">
        {/* Phones have no sidebar on screen; this opens it as a drawer. */}
        <Button
          data-nav-toggle
          variant="ghost"
          size="icon-sm"
          className="shrink-0 md:hidden"
          onClick={onOpenNav}
          aria-label={t('header.openMenu')}
        >
          <Menu className="h-5 w-5" />
        </Button>

        {server ? (
          /* Who: game mark, name, and one quiet line of status + facts.
             Switching servers lives in the sidebar, so it is not repeated
             here. The StatusPill keeps its class and text (e2e reads it). */
          <button
            type="button"
            onClick={() => onNavigate('dashboard')}
            title={server.name}
            className="-ml-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-sm px-1 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <GameIcon gameId={gameForServer(server)} className="h-7 w-7 shrink-0 object-contain" fallbackClassName="h-5 w-5 text-muted-foreground" />
            <span className="min-w-0">
              <h1 className="truncate font-display text-base font-extrabold leading-tight tracking-tight text-foreground">
                {server.name}
              </h1>
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <StatusPill status={state} className="shrink-0 border-0 bg-transparent p-0 text-xs font-medium normal-case tracking-normal" />
                {facts && <span className="hidden truncate sm:inline">· {facts}</span>}
                {uptime && <span className="hidden shrink-0 tabular-nums lg:inline">· {uptime}</span>}
              </span>
            </span>
          </button>
        ) : (
          <h1 className="min-w-0 flex-1 truncate font-display text-sm font-extrabold uppercase tracking-tight text-foreground">
            {viewLabel}
          </h1>
        )}

        {server && (
          <>
            <ServerControls state={state} onServerAction={onServerAction} />
            <ZoneDivider className="hidden sm:block" />
          </>
        )}

        {/* Utilities: same size, same ghost style, no box around them. */}
        <div className="flex shrink-0 items-center gap-1">
          {server && isAdmin && <ServerMenu onNavigate={onNavigate} onRefresh={onRefresh} />}
          <ApplicationUpdateIndicator onOpenSettings={onOpenUpdates} />
          <NotificationBell />
          {/* Settings one click away, not only inside the profile menu. */}
          <Button
            data-header-settings
            variant="ghost"
            size="icon-sm"
            className={cn('text-muted-foreground hover:text-foreground', currentView === 'panel' && 'bg-secondary text-foreground')}
            onClick={() => onOpenSettings()}
            title={t('nav.panelSettings', { name: panelName })}
            aria-label={t('nav.panelSettings', { name: panelName })}
          >
            <Settings className="h-4 w-4" />
          </Button>
        </div>

        <ZoneDivider className="hidden sm:block" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              data-profile-menu
              variant="ghost"
              size="sm"
              className="shrink-0 gap-2 px-1.5 text-muted-foreground hover:text-foreground"
            >
              <span className="relative flex h-7 w-7 items-center justify-center rounded-sm border border-primary/50 bg-primary/15 text-label font-bold text-primary">
                {initials}
                {/* A newer build's changelog is unread (see src/lib/changelog.js). */}
                {whatsNewUnread && <span data-whats-new-dot className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-background bg-primary" />}
              </span>
              <span className="hidden text-xs font-medium md:inline">{user?.name || user?.username}</span>
              <ChevronDown className="hidden h-3 w-3 text-muted-foreground/60 sm:block" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              {user?.name || user?.username}
              <span className="block text-label font-normal text-muted-foreground">
                {isGuest ? t('security.guestDesc') : user?.role === 'admin' ? 'Admin' : 'Operator'}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {/* Straight to the tab people want, then the whole page. */}
            <DropdownMenuItem onClick={() => onOpenSettings('preferences')}>
              <SlidersHorizontal className="h-4 w-4" />
              {t('panelSettings.preferences')}
            </DropdownMenuItem>
            {canSeeUsers && (
              <DropdownMenuItem onClick={() => onOpenSettings('users')}>
                <Users className="h-4 w-4" />
                {t('nav.users')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => onOpenSettings()}>
              <Settings className="h-4 w-4" />
              {t('nav.panelSettings', { name: panelName })}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Languages className="h-4 w-4" />
                {t('settings.language')}
                <span className="ml-auto pl-2 text-label uppercase tracking-wider text-muted-foreground">{lang}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={lang} onValueChange={setLang}>
                  {supported.map((code) => (
                    <DropdownMenuRadioItem key={code} value={code}>{labels[code] || code}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onOpenChangelog} data-whats-new-unread={whatsNewUnread ? 'true' : 'false'}>
              <Sparkles className="h-4 w-4" />
              {t('whatsNew.title')}
              {whatsNewUnread && (
                <>
                  <span aria-hidden className="ml-auto h-2 w-2 rounded-full bg-primary" />
                  <span className="sr-only">{t('whatsNew.unread')}</span>
                </>
              )}
            </DropdownMenuItem>
            {/* A report carries who filed it; wait until the user has loaded. */}
            {user?.id && (
              <DropdownMenuItem onClick={onReportProblem}>
                <Bug className="h-4 w-4" />
                {t('bugReport.menu')}
              </DropdownMenuItem>
            )}
            {/* No session to end while sign-in is off. */}
            {!authDisabled && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={logout}>
                  <LogOut className="h-4 w-4" />
                  {t('sidebar.logout')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

/* Start, or Restart + Stop, for the open server. Stopping (or any state that
   is not up) offers Start: that is what the user reaches for next. Restart asks first (App owns
   that confirmation). Labels hide on narrow screens; the accessible name
   stays. */
function ServerControls({ state, onServerAction }) {
  const t = useT();
  const showRestartStop = state === 'online' || state === 'starting';
  const showStart = !showRestartStop;
  const label = 'hidden lg:inline';
  return (
    <div data-server-controls role="group" aria-label={t('header.controls')} className="flex shrink-0 items-center gap-2">
      {showStart && (
        <Button variant="success" size="sm" onClick={() => onServerAction('start')} aria-label={t('header.start')}>
          <Play className="h-3.5 w-3.5 fill-current" />
          <span className={label}>{t('header.start')}</span>
        </Button>
      )}
      {showRestartStop && (
        <>
          <Button variant="glass" size="sm" onClick={() => onServerAction('restart')} aria-label={t('header.restart')}>
            <RotateCcw className="h-3.5 w-3.5" />
            <span className={label}>{t('header.restart')}</span>
          </Button>
          <Button variant="destructive" size="sm" onClick={() => onServerAction('stop')} aria-label={t('header.stop')}>
            <Square className="h-3 w-3 fill-current" />
            <span className={label}>{t('header.stop')}</span>
          </Button>
        </>
      )}
    </div>
  );
}
