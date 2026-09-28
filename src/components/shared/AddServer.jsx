import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useState } from 'react';
import { GameArtwork, GameIcon } from '@/components/shared/GameArtwork';
import { useT } from '@/context/I18nContext';
import { GAMES } from '@/lib/games';
import { cn } from '@/lib/utils';

// The wizards and import dialogs are heavy and rarely opened, so they load on
// the first "Add server" rather than with the shell.
const AddServerDialogs = lazy(() => import('@/views/servers/AddServerDialogs').then((m) => ({ default: m.AddServerDialogs })));

const AddServerContext = createContext({ canAddServer: false, openAddServer: () => {} });

/**
 * Owns the Add-server flow for the whole shell: choose a game, choose how
 * (install, use an existing folder, import), then the game's own wizard.
 *
 * @param {boolean}  canAddServer  Whether this user may add servers at all.
 * @param {function} onAdded       Called after a server was added. Resolves to
 *                                 the fresh server list, so the flow can open
 *                                 whichever server is new.
 * @param {function} onOpenServer  Opens a server by id.
 */
export function AddServerProvider({ canAddServer, onAdded, onOpenServer, children }) {
  // `request` is what the flow was opened with; `null` is closed. The dialogs
  // stay mounted after the first open so their close animation can play.
  const [request, setRequest] = useState(null);
  const [mounted, setMounted] = useState(false);

  const openAddServer = useCallback((game = null) => {
    if (!canAddServer) return;
    setMounted(true);
    setRequest({ game });
  }, [canAddServer]);

  const value = useMemo(() => ({ canAddServer, openAddServer }), [canAddServer, openAddServer]);

  return (
    <AddServerContext.Provider value={value}>
      {children}
      {mounted && (
        <Suspense fallback={null}>
          <AddServerDialogs
            request={request}
            onClose={() => setRequest(null)}
            onAdded={onAdded}
            onOpenServer={onOpenServer}
          />
        </Suspense>
      )}
    </AddServerContext.Provider>
  );
}

export function useAddServer() {
  return useContext(AddServerContext);
}

/**
 * One card per game. Used as the first step of the flow and, on its own, as
 * the home screen of a panel with no servers yet.
 */
export function GameChoices({ onChoose, className }) {
  const t = useT();
  return (
    <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {GAMES.map((game) => (
        <button
          key={game.id}
          type="button"
          data-game-choice={game.id}
          onClick={() => onChoose(game.id)}
          className="group relative flex min-h-28 flex-col justify-end overflow-hidden rounded border-2 border-border bg-card p-4 text-left transition-colors hover:border-primary/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          <GameArtwork
            gameId={game.id}
            className={cn('absolute inset-0 opacity-25 transition-opacity group-hover:opacity-40', game.id === 'custom' && 'grayscale')}
          />
          <span className="absolute inset-0 bg-gradient-to-t from-card via-card/80 to-transparent" aria-hidden="true" />
          <span className="relative flex items-center gap-2">
            <GameIcon gameId={game.id} className="h-5 w-auto max-w-6" fallbackClassName="h-5 w-5 text-muted-foreground" />
            <span className="font-semibold text-foreground">{t(`games.${game.id}`)}</span>
          </span>
          <span className="relative mt-1 min-h-8 text-xs text-muted-foreground">{t(`addServer.gameHint.${game.id}`)}</span>
        </button>
      ))}
    </div>
  );
}
