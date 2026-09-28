import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Trash2, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/context/AuthContext';
import { useServer } from '@/context/ServerContext';
import { useT } from '@/context/I18nContext';
import { gameById } from '@/lib/games';
import { useServerProfileForm, ServerProfileFields, ServerProfileFolderBrowser } from '@/views/servers/ServerProfileForm';
import { RemoveServerDialog } from '@/views/servers/RemoveServerDialog';
import { TemplateModal } from '@/views/servers/TemplateModal';
import { ServerToolsDialog } from '@/components/shared/ServerToolsDialog';
import { SettingsGroup } from '@/components/shared/SettingsGroup';

function Fact({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 py-2 text-sm last:border-0">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-foreground" title={value}>{value}</span>
    </div>
  );
}

/**
 * Settings -> General: the server's profile (name, folder, and for Minecraft
 * how it launches), Palworld's connectivity and profile tools, cloning it, and
 * removing it from the panel. Only admins change any of it; everyone else sees
 * the profile.
 */
export function GeneralSettings({ onRefresh }) {
  const t = useT();
  const { user } = useAuth();
  const { servers, activeServer, currentGame } = useServer();
  const isAdmin = user?.role === 'admin';
  // "Other process" servers are defined by their launch command, which this
  // form does not cover.
  const editable = isAdmin && activeServer?.type !== 'custom';
  const form = useServerProfileForm(activeServer);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const dash = t('common.dashPlaceholder');

  if (!activeServer) return null;

  async function save() {
    if (await form.save()) {
      toast.success(t('serverSettings.saved'));
      onRefresh?.();
    }
  }

  return (
    <div>
      <SettingsGroup
        title={t('serverSettings.profileTitle')}
        hint={editable ? t('serverSettings.profileHint') : t('serverSettings.readOnlyHint')}
      >
        {editable ? (
          <>
            <ServerProfileFields form={form} />
            <div className="flex gap-2">
              <Button onClick={save} disabled={!form.dirty || form.saving}>{t('common.save')}</Button>
              {form.dirty && <Button variant="glass" onClick={form.reset}>{t('common.cancel')}</Button>}
            </div>
            <ServerProfileFolderBrowser form={form} />
          </>
        ) : (
          <div>
            <Fact label={t('serverSettings.name')} value={activeServer.name || dash} />
            <Fact label={t('serverSettings.game')} value={currentGame ? gameById(currentGame).label : dash} />
            <Fact label={t('serverSettings.folder')} value={activeServer.dir || activeServer.cwd || dash} />
            {activeServer.mcVersion && <Fact label={t('serverSettings.version')} value={activeServer.mcVersion} />}
          </div>
        )}
      </SettingsGroup>

      {isAdmin && activeServer.type === 'palworld' && (
        <SettingsGroup title={t('portability.serverTools')} hint={t('serverSettings.toolsHint')}>
          <div>
            <Button variant="glass" onClick={() => setToolsOpen(true)}>
              <Wrench className="h-3.5 w-3.5" />
              {t('serverSettings.openTools')}
            </Button>
          </div>
        </SettingsGroup>
      )}

      {isAdmin && (
        <SettingsGroup title={t('serverSettings.cloneTitle')} hint={t('serverSettings.cloneHint')}>
          <div>
            <Button variant="glass" onClick={() => setCloneOpen(true)}>
              <Copy className="h-3.5 w-3.5" />
              {t('servers.cloneWithoutWorlds')}
            </Button>
          </div>
        </SettingsGroup>
      )}

      {isAdmin && (
        <SettingsGroup title={t('serverSettings.removeTitle')} hint={t('serverSettings.removeHint')}>
          <div>
            <Button variant="destructive" onClick={() => setRemoving(activeServer)}>
              <Trash2 className="h-3.5 w-3.5" />
              {t('servers.btnRemove')}
            </Button>
          </div>
        </SettingsGroup>
      )}

      {isAdmin && (
        <TemplateModal
          open={cloneOpen}
          onOpenChange={setCloneOpen}
          servers={servers}
          initialSource={activeServer}
          onCreated={() => onRefresh?.()}
        />
      )}
      {isAdmin && activeServer.type === 'palworld' && (
        <ServerToolsDialog open={toolsOpen} onOpenChange={setToolsOpen} server={activeServer} />
      )}
      {/* Once the list no longer has this server, the shell takes the user home. */}
      <RemoveServerDialog
        server={removing}
        onOpenChange={(o) => { if (!o) setRemoving(null); }}
        onRemoved={() => onRefresh?.()}
      />
    </div>
  );
}
