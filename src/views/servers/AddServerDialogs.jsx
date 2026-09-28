import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ChevronLeft, Download, FolderInput, LayoutTemplate, Package, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { GameChoices } from '@/components/shared/AddServer';
import { GameIcon } from '@/components/shared/GameArtwork';
import { useServer } from '@/context/ServerContext';
import { useT } from '@/context/I18nContext';
import { CreateServerModal, CreateFromModpackModal } from './CreateServerModals';
import { MinecraftAdoptDialog } from './MinecraftAdoptDialog';
import { PalworldAdoptDialog, PalworldImportDialog } from './PalworldPortabilityDialogs';
import { TerrariaImportDialog } from './TerrariaImportDialog';
import { TemplateModal } from './TemplateModal';

// How each game can be added, in the order they are offered. The first is the
// default; a game with a single way skips straight to it.
const METHODS = {
  minecraft: ['install', 'existing', 'modpack', 'template'],
  terraria: ['install', 'import'],
  valheim: ['install'],
  palworld: ['install', 'existing', 'importProfile'],
  custom: ['install'],
};

const METHOD_ICONS = {
  install: Download,
  existing: FolderInput,
  modpack: Package,
  template: LayoutTemplate,
  import: Upload,
  importProfile: Upload,
};

const methodsFor = (game) => METHODS[game] || ['install'];

/**
 * The Add-server flow: pick a game, pick how, then hand off to that game's
 * existing wizard or import dialog. Opened through useAddServer().
 */
export function AddServerDialogs({ request, onClose, onAdded, onOpenServer }) {
  const t = useT();
  const { servers } = useServer();
  const [step, setStep] = useState(null); // 'game' | 'method' | null
  const [game, setGame] = useState(null);
  const [method, setMethod] = useState(null); // the hand-off dialog that is open
  // The servers that existed when the flow opened, so the one it added can be
  // told apart afterwards and opened.
  const knownIds = useRef(new Set());

  const choose = (nextGame, nextMethod) => {
    setGame(nextGame);
    setStep(null);
    setMethod(nextMethod);
  };

  const chooseGame = (nextGame) => {
    const methods = methodsFor(nextGame);
    if (methods.length === 1) choose(nextGame, methods[0]);
    else { setGame(nextGame); setStep('method'); }
  };

  useEffect(() => {
    if (!request) return;
    knownIds.current = new Set(servers.map((server) => server.id));
    setMethod(null);
    if (request.game) chooseGame(request.game);
    else { setGame(null); setStep('game'); }
    // Only a new request restarts the flow; the server list changing under an
    // open flow must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const close = () => {
    setStep(null);
    setMethod(null);
    onClose();
  };

  // A hand-off dialog closing on its own (cancel, X, Escape) ends the flow.
  const onHandoffOpenChange = (open) => { if (!open) close(); };

  const finish = async (addedId) => {
    close();
    const list = await onAdded?.();
    const fresh = addedId || (Array.isArray(list) ? list.find((server) => !knownIds.current.has(server.id))?.id : null);
    if (fresh) onOpenServer?.(fresh);
  };

  const methods = methodsFor(game);

  return (
    <>
      <Dialog open={step !== null} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent className={step === 'game' ? 'max-w-3xl' : 'max-w-lg'}>
          <DialogHeader>
            <DialogTitle>{t('addServer.title')}</DialogTitle>
            <DialogDescription>
              {step === 'game' ? t('addServer.chooseGame') : t('addServer.chooseMethod', { game: t(`games.${game}`) })}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {step === 'game' && <GameChoices onChoose={chooseGame} />}
            {step === 'method' && (
              <div className="space-y-2">
                {methods.map((key) => {
                  const Icon = METHOD_ICONS[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      data-add-method={key}
                      onClick={() => choose(game, key)}
                      className="flex w-full items-start gap-3 rounded border-2 border-border bg-card p-4 text-left transition-colors hover:border-primary/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <span className="min-w-0">
                        <span className="block font-semibold text-foreground">{t(`addServer.method.${key}`)}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{t(`addServer.methodHint.${game}.${key}`)}</span>
                      </span>
                    </button>
                  );
                })}
                {!request?.game && (
                  <Button variant="ghost" size="sm" className="mt-2" onClick={() => setStep('game')}>
                    <ChevronLeft className="h-4 w-4" />
                    <GameIcon gameId={game} className="h-4 w-auto max-w-5" fallbackClassName="h-4 w-4" />
                    {t('addServer.otherGame')}
                  </Button>
                )}
              </div>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>

      <CreateServerModal
        open={method === 'install'}
        game={game}
        onOpenChange={onHandoffOpenChange}
        onCreated={(message) => { toast.success(message); finish(); }}
      />
      {game === 'minecraft' && (
        <>
          <MinecraftAdoptDialog open={method === 'existing'} onOpenChange={onHandoffOpenChange} onAdopted={() => finish()} />
          <CreateFromModpackModal open={method === 'modpack'} onOpenChange={onHandoffOpenChange} onCreated={() => finish()} />
          {/* Templates live here: making a server from one is adding a server.
              Saving a server as a template starts from its Settings -> General. */}
          <TemplateModal open={method === 'template'} onOpenChange={onHandoffOpenChange} servers={servers} onCreated={() => finish()} />
        </>
      )}
      {game === 'palworld' && (
        <>
          <PalworldAdoptDialog open={method === 'existing'} onOpenChange={onHandoffOpenChange} onAdopted={() => finish()} />
          <PalworldImportDialog open={method === 'importProfile'} onOpenChange={onHandoffOpenChange} onImported={() => finish()} />
        </>
      )}
      {game === 'terraria' && (
        <TerrariaImportDialog
          open={method === 'import'}
          onOpenChange={onHandoffOpenChange}
          onImported={(server, issues) => {
            finish(server?.id);
            if (issues?.length) toast.warning(t('terraria.import.followUp'));
          }}
        />
      )}
    </>
  );
}
