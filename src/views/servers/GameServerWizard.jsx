import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DialogFooter } from '@/components/ui/dialog';
import { useApi } from '@/hooks/useApi';
import { useApiStream } from '@/hooks/useApiStream';
import { useFolderPicker } from '@/hooks/useFolderPicker';
import { useT } from '@/context/I18nContext';
import { cn } from '@/lib/utils';
import { SERVER_NAME_MAX_LENGTH } from '@/lib/limits';
import { friendlyPassword, PALWORLD_DEATH_PENALTIES, presetsFor, VALHEIM_KEYS, VALHEIM_MODIFIERS, VALHEIM_WORLD_PRESETS } from '@/lib/serverPresets';
import { FolderBrowserModal } from './FolderBrowserModal';
import { MoreOptions, PresetPicker, presetName } from './PresetPicker';

const SELECT = 'flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm';

const DEFAULTS = {
  terraria: { port: 7777, maxPlayers: 8 },
  valheim: { port: 2456, maxPlayers: 10 },
  palworld: { port: 8211, maxPlayers: 32 },
};

// One game type, three variants (docs/terraria/README.md). The wizard picks
// which one to install; the descriptor keeps it, and it cannot be changed
// afterwards, so the choice is made here with its trade-off spelled out.
const TERRARIA_VARIANTS = ['vanilla', 'tshock', 'tmodloader'];

export function GameServerWizard({ game, onBack, onCreated }) {
  const api = useApi();
  const stream = useApiStream();
  const t = useT();
  const { picking, pick } = useFolderPicker(api);
  const gameType = ['terraria', 'valheim', 'palworld'].includes(game) ? game : 'terraria';
  const defaults = DEFAULTS[gameType];
  const firstPreset = presetsFor(gameType)[0];
  // The name the current preset suggested. Choosing another preset replaces
  // it, but never a name the user typed.
  const suggestedName = useRef(presetName(t, gameType, firstPreset));
  const [form, setForm] = useState(() => ({
    automatic: true, gameType, type: gameType, name: suggestedName.current, parentDir: '', serverName: '',
    // Valheim refuses to start without a join password, so one is made up
    // front: a preset should install with nothing else to fill in.
    worldName: 'Dedicated', password: gameType === 'valheim' ? friendlyPassword() : '', port: defaults.port, maxPlayers: defaults.maxPlayers,
    public: true, worldSize: 2, difficulty: 0, terrariaVariant: 'vanilla', versionId: '', seed: '', motd: '', valheimPreset: 'normal',
    crossplay: false, valheimModifiers: {}, valheimKeys: [],
    ...firstPreset.values,
  }));
  const [defaultParent, setDefaultParent] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState('');
  const [progress, setProgress] = useState(null);
  const [fsOpen, setFsOpen] = useState(false);
  const [versions, setVersions] = useState(null);
  const [versionsError, setVersionsError] = useState('');
  const [versionsLoading, setVersionsLoading] = useState(false);
  const field = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const toggle = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.checked }));
  const phaseLabel = useMemo(() => phase ? t(`servers.installPhase.${phase}`) : '', [phase, t]);

  useEffect(() => {
    api('/api/create/defaults').then((data) => setDefaultParent(data.parentDir || '')).catch(() => {});
  }, [api]);

  function choosePreset(preset) {
    const keepName = form.name && form.name !== suggestedName.current;
    const name = keepName ? form.name : presetName(t, gameType, preset);
    if (!keepName) suggestedName.current = name;
    setForm((current) => ({
      ...current,
      ...preset.values,
      name,
      versionId: (preset.values.terrariaVariant || current.terrariaVariant) === current.terrariaVariant ? current.versionId : '',
    }));
  }

  /*
   * The installable builds of the selected variant, resolved upstream on every
   * variant change. Unsupported entries are kept and disabled with their
   * reason: "TShock publishes no build for this architecture" is an answer, an
   * empty dropdown is not.
   *
   * Only the latest request may land: switching presets quickly fires one
   * request per variant, and a slow TShock answer arriving after the vanilla
   * one would otherwise submit a TShock tag as the vanilla version.
   */
  const versionsRequest = useRef(0);
  const loadVersions = useCallback(async (variant, force = false) => {
    const request = ++versionsRequest.current;
    setVersionsLoading(true);
    setVersionsError('');
    try {
      const data = await api(`/api/terraria/versions?variant=${encodeURIComponent(variant)}${force ? '&force=1' : ''}`);
      if (request !== versionsRequest.current) return;
      setVersions(data);
      const first = (data.versions || []).find((entry) => entry.supported) || null;
      setForm((current) => ({ ...current, versionId: first ? first.id : '' }));
    } catch (err) {
      if (request !== versionsRequest.current) return;
      setVersions(null);
      setVersionsError(err.message);
    } finally {
      if (request === versionsRequest.current) setVersionsLoading(false);
    }
  }, [api]);

  useEffect(() => {
    if (gameType !== 'terraria') return;
    loadVersions(form.terrariaVariant);
  }, [gameType, form.terrariaVariant, loadVersions]);

  const selectedVersion = useMemo(
    () => (versions?.variant === form.terrariaVariant
      ? (versions.versions || []).find((entry) => entry.id === form.versionId) || null
      : null),
    [versions, form.versionId, form.terrariaVariant],
  );
  const blocked = gameType === 'terraria' && (versionsLoading || !selectedVersion || !selectedVersion.supported);

  async function create() {
    setLoading(true);
    setError('');
    setPhase('resolving');
    try {
      await stream('/api/create', {
        body: { ...form, serverName: form.serverName || form.name },
        onEvent(event) {
          if (event.type === 'phase') setPhase(event.phase);
          if (event.type === 'progress') setProgress({ received: event.received, total: event.total });
          if (event.type === 'error') setError(event.error);
        },
      });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function pickFolder() {
    try {
      const picked = await pick(form.parentDir);
      if (picked) setForm((current) => ({ ...current, parentDir: picked }));
    } catch {
      setFsOpen(true);
    }
  }

  function versionLabel(entry) {
    const game = entry.gameVersion || t('terraria.create.versionUnknown');
    const build = t('terraria.create.versionOption', { build: entry.id, game });
    return entry.supported ? build : `${build} — ${entry.reason}`;
  }

  return <>
    <div className="px-5 py-4 space-y-4">
      <p className="text-xs text-muted-foreground">{t('servers.gameInstallIntro', { game: t(`games.${gameType}`) })}</p>
      <PresetPicker game={gameType} form={form} onChoose={choosePreset} disabled={loading} />
      {gameType === 'terraria' && <div className="space-y-1.5">
        <Label>{t('terraria.create.variant')}</Label>
        <div className="grid gap-2 sm:grid-cols-3">
          {TERRARIA_VARIANTS.map((variant) => (
            <button
              key={variant}
              type="button"
              disabled={loading}
              aria-pressed={form.terrariaVariant === variant}
              onClick={() => setForm((current) => ({ ...current, terrariaVariant: variant, versionId: '' }))}
              className={cn(
                'rounded-md border border-input bg-background/60 px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                form.terrariaVariant === variant && 'border-primary ring-1 ring-primary',
              )}
            >
              <span className="block text-sm font-medium">{t(`terraria.variant.${variant}`)}</span>
              <span className="block text-label leading-tight text-muted-foreground">{t(`terraria.variantHint.${variant}`)}</span>
            </button>
          ))}
        </div>
      </div>}
      {gameType === 'terraria' && <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="terraria-version">{t('terraria.create.version')}</Label>
          <Button variant="glass" size="sm" type="button" disabled={loading || versionsLoading} onClick={() => loadVersions(form.terrariaVariant, true)}>
            <RefreshCw className={cn('h-3.5 w-3.5', versionsLoading && 'animate-spin')} />{t('terraria.create.checkAgain')}
          </Button>
        </div>
        <select
          id="terraria-version"
          className="flex h-9 w-full rounded-md border border-input bg-background/60 px-3 text-sm disabled:opacity-50"
          value={form.versionId}
          onChange={field('versionId')}
          disabled={loading || versionsLoading || !versions?.versions?.length}
        >
          {versionsLoading && <option value="">{t('terraria.create.versionsLoading')}</option>}
          {!versionsLoading && !versions?.versions?.length && <option value="">{t('terraria.create.versionsEmpty')}</option>}
          {(versions?.versions || []).map((entry) => (
            <option key={entry.id} value={entry.id} disabled={!entry.supported}>{versionLabel(entry)}</option>
          ))}
        </select>
        {versions?.stale && <p className="text-label text-status-warn">{versions.error || t('terraria.create.versionsStale')}</p>}
        {versionsError && <p className="text-label text-status-error">{versionsError}</p>}
        {selectedVersion && !selectedVersion.supported && <p className="text-label text-status-error">{selectedVersion.reason}</p>}
      </div>}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5"><Label>{t('servers.fieldName')}</Label><Input value={form.name} onChange={field('name')} maxLength={SERVER_NAME_MAX_LENGTH} disabled={loading} /></div>
        <div className="space-y-1.5"><Label>{t('servers.fieldServerName')}</Label><Input value={form.serverName} onChange={field('serverName')} placeholder={form.name || t('servers.optional')} disabled={loading} /></div>
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-1.5"><Label>{t('servers.fieldWorldName')}</Label><Input value={form.worldName} onChange={field('worldName')} disabled={loading} /></div>
        <div className="space-y-1.5"><Label>{t('servers.fieldPort')}</Label><Input type="number" min="1" max={gameType === 'valheim' ? 65533 : (gameType === 'palworld' ? 65534 : 65535)} value={form.port} onChange={field('port')} disabled={loading} /></div>
        <div className="space-y-1.5"><Label>{t('servers.fieldMaxPlayers')}</Label><Input type="number" min="1" max={gameType === 'terraria' ? 255 : (gameType === 'valheim' ? 10 : 32)} value={form.maxPlayers} onChange={field('maxPlayers')} disabled={loading || gameType === 'valheim'} /></div>
      </div>
      <div className="space-y-1.5"><Label>{t('servers.fieldPassword')}{gameType === 'valheim' ? '' : ` (${t('servers.optional')})`}</Label>{/* A join password is shared with friends, so it is shown, not masked. */}<Input type="text" autoComplete="off" spellCheck={false} value={form.password} onChange={field('password')} minLength={gameType === 'valheim' ? 5 : undefined} disabled={loading} /></div>
      {gameType === 'terraria' && <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5"><Label>{t('servers.fieldWorldSize')}</Label><select className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.worldSize} onChange={field('worldSize')} disabled={loading}><option value="1">{t('servers.worldSmall')}</option><option value="2">{t('servers.worldMedium')}</option><option value="3">{t('servers.worldLarge')}</option></select></div>
        <div className="space-y-1.5"><Label>{t('servers.fieldDifficulty')}</Label><select className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.difficulty} onChange={field('difficulty')} disabled={loading}><option value="0">{t('servers.difficultyClassic')}</option><option value="1">{t('servers.difficultyExpert')}</option><option value="2">{t('servers.difficultyMaster')}</option><option value="3">{t('servers.difficultyJourney')}</option></select></div>
      </div>}
      {gameType === 'valheim' && <div className="space-y-1.5">
        <Label htmlFor="valheim-world-preset">{t('serverPresets.valheimWorld')}</Label>
        <select id="valheim-world-preset" className={SELECT} value={form.valheimPreset} onChange={field('valheimPreset')} disabled={loading}>
          {VALHEIM_WORLD_PRESETS.map((preset) => <option key={preset} value={preset}>{t(`serverPresets.valheimWorldPreset.${preset}`)}</option>)}
        </select>
      </div>}
      {gameType === 'valheim' && <div className="flex flex-wrap gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-primary" checked={form.public} onChange={toggle('public')} disabled={loading} />{t('servers.fieldPublic')}</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-primary" checked={form.crossplay} onChange={toggle('crossplay')} disabled={loading} />{t('serverRules.crossplay')}</label>
      </div>}
      {gameType === 'palworld' && <>
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-1.5"><Label htmlFor="pal-death">{t('serverRules.deathPenalty')}</Label><select id="pal-death" className={SELECT} value={form.deathPenalty} onChange={field('deathPenalty')} disabled={loading}>{PALWORLD_DEATH_PENALTIES.map((option) => <option key={option} value={option}>{t(`serverRules.palworldDeathPenalty.${option}`)}</option>)}</select></div>
          <div className="space-y-1.5"><Label htmlFor="pal-exp">{t('serverRules.expRate')}</Label><Input id="pal-exp" type="number" min="0.1" max="20" step="0.1" value={form.expRate} onChange={field('expRate')} disabled={loading} /></div>
          <div className="space-y-1.5"><Label htmlFor="pal-capture">{t('serverRules.captureRate')}</Label><Input id="pal-capture" type="number" min="0.1" max="20" step="0.1" value={form.captureRate} onChange={field('captureRate')} disabled={loading} /></div>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-primary" checked={form.pvp} onChange={toggle('pvp')} disabled={loading} />{t('serverRules.pvp')}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-primary" checked={form.hardcore} onChange={toggle('hardcore')} disabled={loading} />{t('serverRules.palworldHardcore')}</label>
        </div>
      </>}
      <MoreOptions>
        {gameType === 'terraria' && <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5"><Label htmlFor="terraria-seed">{t('terraria.create.seed')}</Label><Input id="terraria-seed" value={form.seed} onChange={field('seed')} maxLength={64} disabled={loading} placeholder={t('terraria.create.seedPlaceholder')} /></div>
          <div className="space-y-1.5"><Label htmlFor="terraria-motd">{t('serverRules.motd')}</Label><Input id="terraria-motd" value={form.motd} onChange={field('motd')} maxLength={200} disabled={loading} placeholder={t('servers.optional')} /></div>
        </div>}
        {gameType === 'valheim' && <>
          <p className="text-label text-muted-foreground">{t('serverRules.valheimModifiersHint')}</p>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {Object.entries(VALHEIM_MODIFIERS).map(([name, options]) => (
              <div key={name} className="space-y-1.5">
                <Label htmlFor={`valheim-${name}`}>{t(`serverRules.valheimModifier.${name}`)}</Label>
                <select id={`valheim-${name}`} className={SELECT} value={form.valheimModifiers[name] || ''} onChange={(event) => setForm((current) => ({ ...current, valheimModifiers: { ...current.valheimModifiers, [name]: event.target.value } }))} disabled={loading}>
                  <option value="">{t('serverRules.fromPreset')}</option>
                  {options.map((option) => <option key={option} value={option}>{t(`serverRules.valheimLevel.${option}`)}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {VALHEIM_KEYS.map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-primary" checked={form.valheimKeys.includes(key)} disabled={loading} onChange={(event) => setForm((current) => ({ ...current, valheimKeys: event.target.checked ? [...current.valheimKeys, key] : current.valheimKeys.filter((item) => item !== key) }))} />
                {t(`serverRules.valheimKey.${key}`)}
              </label>
            ))}
          </div>
        </>}
        <div className="space-y-1.5">
          <Label>{t('servers.fieldParent')}</Label>
          <div className="flex gap-2"><Input value={form.parentDir} onChange={field('parentDir')} disabled={loading} className="flex-1" placeholder={defaultParent ? t('servers.parentDefault', { path: defaultParent }) : ''} /><Button variant="glass" size="sm" type="button" disabled={loading || picking} className="h-11 shrink-0" onClick={pickFolder}><FolderOpen className="h-3.5 w-3.5" />{t('servers.browse')}</Button></div>
        </div>
      </MoreOptions>
      {loading && <div className="rounded-md border border-border bg-secondary/20 p-3 text-xs"><p>{phaseLabel}</p>{progress?.total > 0 && <progress className="mt-2 w-full" max={progress.total} value={progress.received} />}</div>}
      {error && <p className="text-xs text-status-error">{error}</p>}
    </div>
    <DialogFooter><Button variant="glass" onClick={onBack} disabled={loading}>{t('common.back')}</Button><Button onClick={create} disabled={loading || blocked}>{loading ? t('servers.installingServer') : t('servers.installServer')}</Button></DialogFooter>
    <FolderBrowserModal open={fsOpen} onOpenChange={setFsOpen} initial={form.parentDir} onSelect={(parentDir) => setForm(current => ({ ...current, parentDir }))} />
  </>;
}
