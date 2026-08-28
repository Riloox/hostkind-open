import { useEffect } from 'react';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { useT } from '@/context/I18nContext';
import { useAuth, useBranding } from '@/context/AuthContext';
import { useServer } from '@/context/ServerContext';
import { NotificationBell } from '@/components/shared/NotificationBell';
import { ApplicationUpdateIndicator } from '@/components/shared/ApplicationUpdate';
import { gameById } from '@/lib/games';
import { Settings, LogOut, User, ChevronDown } from 'lucide-react';

const VIEW_KEYS = {
  servers:  'nav.servers',
  dashboard:'nav.dashboard',
  health:   'nav.health',
  console:  'nav.console',
  players:  'nav.players',
  addons:   'nav.addons',
  configs:  'nav.configs',
  files:    'nav.files',
  tasks:    'nav.schedules',
  backups:  'nav.backups',
  modrinth: 'nav.modrinth',
  map:      'nav.map',
  users:    'nav.users',
  worlds:   'nav.worlds',
  updates:  'nav.updates',
  audit:    'nav.audit',
};

export function Header({ currentView, onOpenSettings }) {
  const t = useT();
  const { user, logout, authDisabled } = useAuth();
  const branding = useBranding();
  const { currentGame } = useServer();
  const isGuest = user?.id === 'guest';

  const initials = user?.name
    ? user.name.split(/\s+/).map(s => s[0]).join('').toUpperCase().slice(0, 2)
    : user?.username?.slice(0, 2).toUpperCase() || '?';

  const viewLabel = currentView && VIEW_KEYS[currentView] ? t(VIEW_KEYS[currentView]) : currentView;
  const gameLabel = currentGame ? gameById(currentGame).label : null;
  const panelName = branding.name || t('brand.name');

  // Every captured page otherwise reports the same title, which makes browser
  // tabs and window lists useless for telling two game panels apart. The suffix
  // is the panel's configured name, not a literal - a white-labelled panel that
  // still says "Hostkind" in the tab has not been white-labelled.
  useEffect(() => {
    document.title = gameLabel ? `${gameLabel} · ${viewLabel} — ${panelName}` : panelName;
  }, [gameLabel, viewLabel, panelName]);

  return (
    <header data-tour="header" className="sticky top-0 z-40 flex h-16 items-center justify-between border-b-2 border-border bg-background/72 px-4 backdrop-blur-xl sm:px-6 relative">
      <div className="flex items-center gap-3">
        <h1 className="font-display text-sm font-extrabold uppercase tracking-tight text-foreground">
          {gameLabel && (
            <>
              <span className="text-muted-foreground">{gameLabel}</span>
              <span className="mx-2 text-muted-foreground/40" aria-hidden="true">/</span>
            </>
          )}
          {viewLabel}
        </h1>
      </div>

      <div className="flex items-center gap-2">
        <ApplicationUpdateIndicator onOpenSettings={onOpenSettings} />
        {/* Notifications */}
        <div data-tour="notifications"><NotificationBell /></div>

        {/* Profile dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              data-tour="profile"
              variant="ghost"
              size="sm"
              className="gap-2 px-2 text-muted-foreground hover:text-foreground"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-sm border border-primary/50 bg-primary/15 text-label font-bold text-primary">
                {initials}
              </span>
              <span className="hidden md:inline text-xs font-medium">{user?.name || user?.username}</span>
              <ChevronDown className="h-3 w-3 text-muted-foreground/60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel>
              {user?.name || user?.username}
              <span className="block text-label font-normal text-muted-foreground">
                {isGuest ? t('security.guestDesc') : user?.role === 'admin' ? 'Admin' : 'Operator'}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onOpenSettings}>
              <Settings className="h-4 w-4" />
              {t('sidebar.settings')}
            </DropdownMenuItem>
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
