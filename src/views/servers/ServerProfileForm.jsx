import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useApi } from '@/hooks/useApi';
import { useFolderPicker } from '@/hooks/useFolderPicker';
import { useT } from '@/context/I18nContext';
import { osExamplePath } from '@/lib/utils';
import { SERVER_NAME_MAX_LENGTH } from '@/lib/limits';
import { gameForServer } from '@/lib/games';
import { FolderOpen } from 'lucide-react';
import { FolderBrowserModal } from './FolderBrowserModal';

// A server's profile: its name and folder, and for Minecraft how it is
// launched. Edited from the server list's dialog and from the server's
// Settings -> General page, which share this state and these fields.

const EMPTY = { name: '', dir: '', jar: '', javaArgs: '-Xmx4G -Xms4G', mcVersion: '', worlds: 'world, world_nether, world_the_end', mapUrl: '' };

function formFor(server) {
  if (!server) return EMPTY;
  return {
    name: server.name || '',
    dir: server.dir || '',
    jar: server.jar || '',
    javaArgs: (server.javaArgs || []).join(' '),
    mcVersion: server.mcVersion || '',
    worlds: (server.worlds || []).join(', '),
    mapUrl: server.mapUrl || '',
  };
}

/**
 * Form state for one server. It resets from the server whenever `active`
 * turns on (a dialog opening) or the server itself changes. `save()` resolves
 * true once the panel accepted the change, and leaves the error to show
 * otherwise.
 */
export function useServerProfileForm(server, { active = true } = {}) {
  const api = useApi();
  const { picking, pick } = useFolderPicker(api);
  const [values, setValues] = useState(() => formFor(server));
  const [jars, setJars] = useState(server?.jar ? [server.jar] : []);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [fsOpen, setFsOpen] = useState(false);
  // Only Minecraft servers are jar-launched. The other games are installed by
  // the panel (their launch command is internal) and their gameplay settings
  // live in the game's own config files, so editing one is just name + folder.
  const game = server ? gameForServer(server) : 'minecraft';
  const isMinecraft = game === 'minecraft';

  useEffect(() => {
    if (!active) return;
    setError('');
    setValues(formFor(server));
    setJars(server?.jar ? [server.jar] : []);
  }, [active, server]);

  // Fill the form from a chosen folder: remember it, name the server after it
  // if the user hasn't typed a name, and preselect the most likely jar.
  function applyDir(dir, j) {
    setValues(f => ({
      ...f,
      dir,
      name: f.name || dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || f.name,
      jar: j.length ? (j.find(x => /spigot|paper|server|bukkit|fabric|forge/i.test(x)) || j[0]) : f.jar,
    }));
    setJars(j);
  }

  async function pickFolder() {
    try {
      const picked = await pick(values.dir);
      if (!picked) return;
      let j = [];
      try {
        const listing = await api(`/api/fs?path=${encodeURIComponent(picked)}`);
        j = listing.jars || [];
      } catch {}
      applyDir(picked, j);
    } catch {
      setFsOpen(true);
    }
  }

  async function save() {
    if (!server?.id) return false;
    const body = isMinecraft ? values : { name: values.name, dir: values.dir };
    setSaving(true);
    setError('');
    try {
      await api(`/api/servers/${server.id}`, { method: 'PUT', body });
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  const initial = formFor(server);
  const dirty = Object.keys(initial).some((key) => initial[key] !== values[key]);
  const field = (key) => (e) => setValues(p => ({ ...p, [key]: e.target.value }));

  return {
    values, field, jars, error, saving, dirty, game, isMinecraft,
    picking, pickFolder, fsOpen, setFsOpen, applyDir, save,
    reset: () => { setValues(formFor(server)); setError(''); },
  };
}

/** The profile fields for a form from useServerProfileForm. */
export function ServerProfileFields({ form, showGameHint = true }) {
  const t = useT();
  const { values, field, jars, error, isMinecraft, game, picking, pickFolder } = form;
  return (
    <>
      {showGameHint && !isMinecraft && (
        <p className="text-xs text-muted-foreground">
          {t('servers.editGameHint', { game: t(`games.${game}`) })}
        </p>
      )}
      <div className="space-y-1.5">
        <Label>{t('servers.fieldName')}</Label>
        <Input value={values.name} onChange={field('name')} maxLength={SERVER_NAME_MAX_LENGTH} placeholder={t('servers.namePlaceholder')} />
      </div>
      <div className="space-y-1.5">
        <Label>{t('servers.fieldFolder')}</Label>
        <div className="flex gap-2">
          <Input value={values.dir} onChange={field('dir')} placeholder={t('servers.folderPlaceholder', { path: osExamplePath('server') })} className="flex-1" />
          <Button variant="glass" size="sm" type="button" disabled={picking} onClick={pickFolder}>
            <FolderOpen className="h-3.5 w-3.5" />
            {t('servers.browse')}
          </Button>
        </div>
      </div>
      {isMinecraft && <>
        <div className="space-y-1.5">
          <Label>{t('servers.fieldJar')}</Label>
          <select
            className="flex h-9 w-full items-center rounded-md border border-input bg-background/60 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/50"
            value={values.jar}
            onChange={field('jar')}
          >
            {jars.length === 0 && <option value="">{t('servers.jarPlaceholder')}</option>}
            {jars.map(j => <option key={j} value={j}>{j}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label>{t('servers.fieldJavaArgs')}</Label>
          <Input value={values.javaArgs} onChange={field('javaArgs')} placeholder={t('servers.javaArgsPlaceholder')} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>{t('servers.fieldMcVersion')}</Label>
            <Input value={values.mcVersion} onChange={field('mcVersion')} placeholder={t('servers.mcVersionPlaceholder')} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('servers.fieldWorlds')}</Label>
            <Input value={values.worlds} onChange={field('worlds')} placeholder={t('servers.worldsPlaceholder')} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>{t('servers.fieldMapUrl')}</Label>
          <Input
            value={values.mapUrl}
            onChange={field('mapUrl')}
            placeholder={t('servers.mapUrlPlaceholder')}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </>}
      {error && <p className="text-xs text-status-error">{error}</p>}
    </>
  );
}

/** The in-panel folder browser, for when the native picker is unavailable. */
export function ServerProfileFolderBrowser({ form }) {
  return (
    <FolderBrowserModal
      open={form.fsOpen}
      onOpenChange={form.setFsOpen}
      initial={form.values.dir}
      onSelect={(dir, j) => form.applyDir(dir, j || [])}
    />
  );
}
