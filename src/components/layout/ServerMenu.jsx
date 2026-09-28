import { lazy, Suspense, useState } from 'react';
import { Copy, MoreHorizontal, Settings2, Trash2 } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { useServer } from '@/context/ServerContext';
import { useT } from '@/context/I18nContext';

// Rarely opened, so they load on first use rather than with the shell.
const TemplateModal = lazy(() => import('@/views/servers/TemplateModal').then((m) => ({ default: m.TemplateModal })));
const RemoveServerDialog = lazy(() => import('@/views/servers/RemoveServerDialog').then((m) => ({ default: m.RemoveServerDialog })));

/**
 * The header's `⋯` for the open server (admins): its settings, cloning it and
 * removing it. The same actions sit on Settings -> General; this is the short
 * way to them from any of the server's pages.
 */
export function ServerMenu({ onNavigate, onRefresh }) {
  const t = useT();
  const { servers, activeServer } = useServer();
  const [cloneOpen, setCloneOpen] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [loaded, setLoaded] = useState(false);

  if (!activeServer) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" data-server-menu aria-label={t('servers.moreActions')}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onClick={() => onNavigate('settings', 'general')}>
            <Settings2 className="h-4 w-4" />
            {t('servers.menuSettings')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => { setLoaded(true); setCloneOpen(true); }}>
            <Copy className="h-4 w-4" />
            {t('servers.cloneWithoutWorlds')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-status-error" onClick={() => { setLoaded(true); setRemoving(activeServer); }}>
            <Trash2 className="h-4 w-4" />
            {t('servers.btnRemove')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {loaded && (
        <Suspense fallback={null}>
          <TemplateModal
            open={cloneOpen}
            onOpenChange={setCloneOpen}
            servers={servers}
            initialSource={activeServer}
            onCreated={() => onRefresh?.()}
          />
          {/* Once the list no longer has this server, the shell takes the user home. */}
          <RemoveServerDialog
            server={removing}
            onOpenChange={(open) => { if (!open) setRemoving(null); }}
            onRemoved={() => onRefresh?.()}
          />
        </Suspense>
      )}
    </>
  );
}
