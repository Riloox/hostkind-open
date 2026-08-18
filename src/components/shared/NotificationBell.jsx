import { useState, useEffect, useRef, useCallback } from 'react';
import { useT } from '@/context/I18nContext';
import { useServer } from '@/context/ServerContext';
import { useApi } from '@/hooks/useApi';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Bell, Server, Play, Square, AlertTriangle, AlertCircle, Trash2, RotateCcw, Upload, Package, Archive, Download, RotateCw } from 'lucide-react';
import { cn } from '@/lib/utils';

const TYPE_ICONS = {
  server_created:    Server,
  server_added:      Server,
  server_removed:    Server,
  server_started:    Play,
  server_stopped:    Square,
  server_restarted:  RotateCcw,
  server_crashed:    AlertTriangle,
  watchdog_restart:  RotateCw,
  watchdog_limit:    AlertCircle,
  backup_created:    Archive,
  backup_deleted:    Trash2,
  plugin_installed:  Download,
  plugin_uploaded:   Upload,
  modpack_installed: Package,
};

function timeAgo(ts, t) {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return t('notifications.justNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('notifications.minutesAgo', { m: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('notifications.hoursAgo', { h: hr });
  const d = Math.floor(hr / 24);
  return t('notifications.daysAgo', { d });
}

function notificationText(n, t) {
  return {
    title: n.titleKey ? t(n.titleKey, n.titleVars) : n.title,
    message: n.messageKey ? t(n.messageKey, n.messageVars) : n.message,
  };
}

export function NotificationBell() {
  const t = useT();
  const api = useApi();
  // Notifications live in ServerContext so the WebSocket can push new ones in
  // real time; this component just renders and mutates that shared list.
  const { servers, notifications: items, setNotifications } = useServer();
  const [open, setOpen] = useState(false);
  const unmountedRef = useRef(false);

  const fetchNotifications = useCallback(() => {
    api('/api/notifications').then((data) => {
      if (!unmountedRef.current) setNotifications(data.notifications || []);
    }).catch(() => {});
  }, [api, setNotifications]);

  useEffect(() => {
    unmountedRef.current = false;
    // The WebSocket delivers the list on connect and pushes new ones live, but
    // fetch once on mount (covers the pre-connect gap) and reconcile slowly in
    // case a live frame is ever dropped.
    fetchNotifications();
    const interval = setInterval(fetchNotifications, 20000);
    return () => {
      unmountedRef.current = true;
      clearInterval(interval);
    };
  }, [fetchNotifications]);

  const unread = items.filter((n) => !n.read).length;

  const markRead = useCallback(async (id) => {
    setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, read: true } : n));
    try { await api(`/api/notifications/${id}/read`, { method: 'POST' }); } catch {}
  }, [api, setNotifications]);

  const readAll = useCallback(async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    try { await api('/api/notifications/read-all', { method: 'POST' }); } catch {}
  }, [api, setNotifications]);

  const clearAll = useCallback(async () => {
    setNotifications([]);
    try { await api('/api/notifications/clear', { method: 'POST' }); } catch {}
  }, [api, setNotifications]);

  const serverName = (id) => {
    if (!id) return '';
    const s = servers.find((s) => s.id === id);
    return s ? s.name : '';
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="relative text-muted-foreground hover:text-foreground">
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <>
              <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
                <span className="ping-halo absolute inline-flex h-full w-full rounded-full bg-primary opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
              </span>
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={10} className="w-80 max-h-[28rem] overflow-y-auto">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {t('notifications.title')}
            {unread > 0 && (
              <span className="ml-1.5 text-label font-normal text-primary">({unread})</span>
            )}
          </span>
          <div className="flex gap-1">
            {unread > 0 && (
              <button
                onClick={readAll}
                className="text-label text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-secondary/60"
              >
                {t('notifications.readAll')}
              </button>
            )}
            {items.length > 0 && (
              <button
                onClick={clearAll}
                className="text-label text-muted-foreground hover:text-foreground transition-colors px-1.5 py-0.5 rounded hover:bg-secondary/60"
              >
                {t('notifications.clearAll')}
              </button>
            )}
          </div>
        </div>
        {items.length === 0 ? (
          <div className="px-3 py-8 text-center text-xs text-muted-foreground">
            {t('notifications.empty')}
          </div>
        ) : (
          items.map((n) => {
            const Icon = TYPE_ICONS[n.type] || Bell;
            const sname = serverName(n.serverId);
            const text = notificationText(n, t);
            return (
              <DropdownMenuItem
                key={n.id}
                className={cn(
                  'flex items-start gap-3 px-3 py-2.5 cursor-pointer rounded-none',
                  !n.read && 'bg-primary/[0.03]'
                )}
                onClick={() => markRead(n.id)}
                onPointerLeave={(e) => e.preventDefault()}
              >
                <span className={cn(
                  'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-label',
                  n.read ? 'bg-muted/50 text-muted-foreground' : 'bg-primary/15 text-primary'
                )}>
                  <Icon className="h-3 w-3" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className={cn(
                    'text-xs leading-tight',
                    !n.read ? 'font-semibold text-foreground' : 'text-muted-foreground'
                  )}>
                    {text.title}
                  </div>
                  <div className="text-label text-muted-foreground mt-0.5 line-clamp-2">
                    {text.message}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    {sname && (
                      <span className="text-label text-muted-foreground/60">{sname}</span>
                    )}
                    <span className="text-label text-muted-foreground/40">
                      {timeAgo(n.timestamp, t)}
                    </span>
                  </div>
                </div>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
