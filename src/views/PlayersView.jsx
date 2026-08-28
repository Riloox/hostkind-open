import { useState, useEffect, useMemo, useRef } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { ViewHeader } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorState } from '@/components/shared/ErrorState';
import { Loading } from '@/components/shared/Loading';
import { useApi } from '@/hooks/useApi';
import { useServer } from '@/context/ServerContext';
import { PalworldPlayersView } from '@/views/PalworldPlayersView';
import { TerrariaPlayersView } from '@/views/TerrariaPlayersView';
import { useT } from '@/context/I18nContext';
import { toast } from 'sonner';
import {
  RefreshCw, Crown, Check, Ban, LogOut, Search, Loader2, X, ShieldX,
} from 'lucide-react';

// Per-action friendly confirmation.
const ACTION_MSG = {
  op: 'players.opped',
  deop: 'players.deopped',
  kick: 'players.kicked',
  ban: 'players.banned',
  pardon: 'players.pardoned',
};

const LIST_ACTION_MSG = {
  'whitelist:add': 'players.whitelistAdded',
  'whitelist:remove': 'players.whitelistRemoved',
  'op:add': 'players.opAdded',
  'op:remove': 'players.opRemoved',
  'ban:add': 'players.banAdded',
  'ban:remove': 'players.banRemoved',
};

const headUrl = (name, px) => `https://minotar.net/helm/${encodeURIComponent(name)}/${px}.png`;

function Head({ name, px = 32, className }) {
  return (
    <img
      src={headUrl(name, px)}
      alt=""
      width={px / 2}
      height={px / 2}
      className={className}
      style={{ imageRendering: 'pixelated' }}
      onError={(e) => { e.target.style.visibility = 'hidden'; }}
    />
  );
}

// One clickable player tile: head, name, and tiny state badges.
function PlayerCard({ name, flags, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-left transition-colors hover:bg-secondary/60 hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="relative shrink-0">
        <Head name={name} px={44} className="h-[22px] w-[22px] rounded" />
        {flags.online && (
          <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border border-card bg-status-online" />
        )}
      </div>
      <span className="flex-1 min-w-0 truncate text-sm font-medium text-foreground">{name}</span>
      <span className="flex items-center gap-1 text-muted-foreground">
        {flags.op && <Crown className="h-3.5 w-3.5 text-status-warn" />}
        {flags.whitelisted && <Check className="h-3.5 w-3.5 text-status-online" />}
        {flags.banned && <Ban className="h-3.5 w-3.5 text-status-error" />}
      </span>
    </button>
  );
}

// A titled card holding a responsive grid of player tiles.
function PlayerSection({ title, icon: Icon, count, players, getFlags, onSelect, emptyMessage }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
          {title}
          {count > 0 && <span className="text-xs font-normal text-muted-foreground">({count})</span>}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {players.length === 0 ? (
          <EmptyState message={emptyMessage} />
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {players.map((name) => (
              <PlayerCard key={name} name={name} flags={getFlags(name)} onClick={() => onSelect(name)} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Detail panel for a single player: big head, badges, and state-aware actions.
function PlayerDetail({ name, flags, reason, uuid, onAction, onClose, t }) {
  const [banning, setBanning] = useState(false);
  const [banReason, setBanReason] = useState('');
  useEffect(() => { setBanning(false); setBanReason(''); }, [name]);

  const run = (fn) => fn();

  return (
    <Dialog open={!!name} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <Head name={name || ''} px={72} className="h-9 w-9 rounded" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-foreground">{name}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {flags.online && <Badge variant="online">{t('minecraft.players.badgeOnline')}</Badge>}
                {flags.op && <Badge variant="starting">{t('minecraft.players.badgeOp')}</Badge>}
                {flags.whitelisted && <Badge variant="active">{t('minecraft.players.badgeWhitelisted')}</Badge>}
                {flags.banned && <Badge variant="destructive">{t('minecraft.players.badgeBanned')}</Badge>}
                {!flags.online && !flags.op && !flags.whitelisted && !flags.banned && (
                  <Badge variant="offline">{t('minecraft.players.badgeOffline')}</Badge>
                )}
              </div>
            </div>
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {flags.banned && reason && (
            <p className="rounded bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{t('minecraft.players.reasonLabel')}:</span> {reason}
            </p>
          )}
          {uuid && (
            <p className="select-all break-all text-label text-muted-foreground">{uuid}</p>
          )}

          <div className="grid grid-cols-1 gap-2">
            {flags.online && (
              <Button variant="glass" onClick={() => run(() => onAction.kick(name))} className="justify-start">
                <LogOut className="h-4 w-4" /> {t('minecraft.players.kick')}
              </Button>
            )}

            {flags.op ? (
              <Button variant="glass" onClick={() => run(() => onAction.opRemove(name))} className="justify-start">
                <ShieldX className="h-4 w-4" /> {t('minecraft.players.removeOp')}
              </Button>
            ) : (
              <Button variant="glass" onClick={() => run(() => onAction.opAdd(name))} className="justify-start">
                <Crown className="h-4 w-4" /> {t('minecraft.players.makeOp')}
              </Button>
            )}

            {flags.whitelisted ? (
              <Button variant="glass" onClick={() => run(() => onAction.whitelistRemove(name))} className="justify-start">
                <X className="h-4 w-4" /> {t('minecraft.players.removeWhitelist')}
              </Button>
            ) : (
              <Button variant="glass" onClick={() => run(() => onAction.whitelistAdd(name))} className="justify-start">
                <Check className="h-4 w-4" /> {t('minecraft.players.addWhitelist')}
              </Button>
            )}

            {flags.banned ? (
              <Button variant="glass" onClick={() => run(() => onAction.pardon(name))} className="justify-start">
                <Check className="h-4 w-4" /> {t('minecraft.players.pardon')}
              </Button>
            ) : banning ? (
              <div className="space-y-2 rounded-lg border border-destructive/40 p-2">
                <Input
                  autoFocus
                  value={banReason}
                  onChange={(e) => setBanReason(e.target.value)}
                  placeholder={t('minecraft.players.reasonPlaceholder')}
                  className="h-8 text-xs"
                />
                <div className="flex gap-2">
                  <Button variant="destructive" size="sm" className="flex-1" onClick={() => onAction.ban(name, banReason.trim())}>
                    <Ban className="h-4 w-4" /> {t('minecraft.players.confirmBan')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setBanning(false)}>{t('common.cancel')}</Button>
                </div>
              </div>
            ) : (
              <Button variant="destructive" onClick={() => setBanning(true)} className="justify-start">
                <Ban className="h-4 w-4" /> {t('minecraft.players.ban')}
              </Button>
            )}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

// Top bar: validate a never-before-seen name against Mojang, then add it to a list.
function AddPlayerBar({ onAdd, t }) {
  const api = useApi();
  const [query, setQuery] = useState('');
  const [state, setState] = useState({ status: 'idle' }); // idle | looking | found | notfound
  const timer = useRef(null);

  useEffect(() => {
    const name = query.trim();
    if (timer.current) clearTimeout(timer.current);
    if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) { setState({ status: 'idle' }); return; }
    setState({ status: 'looking' });
    timer.current = setTimeout(async () => {
      try {
        const d = await api(`/api/players/lookup?name=${encodeURIComponent(name)}`, { silent: true });
        setState({ status: 'found', name: d.name, uuid: d.uuid });
      } catch {
        setState({ status: 'notfound' });
      }
    }, 450);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query, api]);

  const found = state.status === 'found';
  const add = async (kind) => {
    await onAdd(kind, state.name);
    setQuery('');
    setState({ status: 'idle' });
  };

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('minecraft.players.addPlaceholder')}
              className="pl-8"
            />
          </div>
          {found && <Head name={state.name} px={48} className="h-6 w-6 rounded" />}
          {found && <span className="text-sm font-medium text-foreground">{state.name}</span>}
          <div className="flex items-center gap-2">
            {state.status === 'looking' && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            {state.status === 'notfound' && <span className="text-xs text-status-error">{t('minecraft.players.notFound')}</span>}
            {found && (
              <>
                <Button variant="glass" size="sm" onClick={() => add('whitelist')}>
                  <Check className="h-4 w-4" /> {t('minecraft.players.whitelistTitle')}
                </Button>
                <Button variant="glass" size="sm" onClick={() => add('op')}>
                  <Crown className="h-4 w-4" /> {t('minecraft.players.op')}
                </Button>
                <Button variant="destructive" size="sm" onClick={() => add('ban')}>
                  <Ban className="h-4 w-4" /> {t('minecraft.players.ban')}
                </Button>
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function PlayersView() {
  const { activeServer, currentGame } = useServer();
  if (activeServer?.type === 'palworld' || (!activeServer && currentGame === 'palworld')) {
    return <PalworldPlayersView />;
  }
  // The server list arrives asynchronously after the URL/game selection. Use
  // the known game during that gap so a Terraria route never mounts the legacy
  // Minecraft player-list effects even briefly.
  if (activeServer?.type === 'terraria' || (!activeServer && currentGame === 'terraria')) {
    return <TerrariaPlayersView />;
  }
  return <LegacyPlayersView />;
}

function LegacyPlayersView() {
  const api = useApi();
  const t = useT();
  const { activeServerId, statuses } = useServer();
  const status = activeServerId ? (statuses[activeServerId] || {}) : {};
  const livePlayers = status.players || [];

  const [lists, setLists] = useState({ online: [], recent: [], whitelist: [], ops: [], banned: [], whitelistEnabled: false });
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [selected, setSelected] = useState(null);

  async function loadLists(silent) {
    if (!silent) { setListLoading(true); setListError(''); }
    try {
      const d = await api('/api/playerlists');
      setLists(d);
    } catch (e) { if (!silent) setListError(e.message); }
    if (!silent) setListLoading(false);
  }

  useEffect(() => { loadLists(); }, [activeServerId]);
  // Refresh lists when the live online set changes (join/leave) — silent, no skeleton.
  useEffect(() => { loadLists(true); }, [livePlayers.join(',')]);

  // Cross-reference sets for badges + state-aware actions.
  const sets = useMemo(() => {
    const lc = (a) => new Set(a.map((x) => x.toLowerCase()));
    const online = lc([...new Set([...livePlayers, ...(lists.online || [])])]);
    const banReason = new Map((lists.banned || []).map((b) => [b.name.toLowerCase(), b.reason || '']));
    return {
      online,
      op: lc(lists.ops || []),
      whitelist: lc(lists.whitelist || []),
      ban: new Set([...banReason.keys()]),
      banReason,
    };
  }, [livePlayers, lists]);

  const getFlags = (name) => {
    const k = name.toLowerCase();
    return {
      online: sets.online.has(k),
      op: sets.op.has(k),
      whitelisted: sets.whitelist.has(k),
      banned: sets.ban.has(k),
    };
  };

  const onlineNames = useMemo(
    () => [...new Set([...livePlayers, ...(lists.online || [])])].sort((a, b) => a.localeCompare(b)),
    [livePlayers, lists.online]
  );

  // --- action helpers ---
  async function playerAction(action, name) {
    try {
      await api(`/api/players/${action}`, { method: 'POST', body: { name } });
      toast.success(t(ACTION_MSG[action] || 'players.actionApplied', { action, name }));
      loadLists();
      setTimeout(loadLists, 1200);
    } catch (e) { toast.error(e.message); }
  }

  async function plAction(kind, op, name, reason) {
    try {
      const r = await api(`/api/playerlists/${kind}/${op}`, { method: 'POST', body: { name, reason } });
      if (r?.error) { toast.error(r.error); return; }
      const noteKey = r?.note === 'Already listed.'
        ? 'players.alreadyListed'
        : r?.note === 'Updated (server offline).'
          ? 'players.updatedOffline'
          : LIST_ACTION_MSG[`${kind}:${op}`] || 'players.listOp';
      toast.success(t(noteKey, { kind, op, name }));
      loadLists();
      setTimeout(loadLists, 1200);
    } catch (e) { toast.error(e.message); }
  }

  // Actions wired for the detail panel.
  const actions = {
    kick: (n) => playerAction('kick', n),
    opAdd: (n) => plAction('op', 'add', n),
    opRemove: (n) => plAction('op', 'remove', n),
    whitelistAdd: (n) => plAction('whitelist', 'add', n),
    whitelistRemove: (n) => plAction('whitelist', 'remove', n),
    ban: (n, reason) => { plAction('ban', 'add', n, reason); setSelected(null); },
    pardon: (n) => plAction('ban', 'remove', n),
  };

  async function toggleWhitelist(e) {
    const enabled = e.target.checked;
    try {
      const r = await api('/api/whitelist/toggle', { method: 'POST', body: { enabled } });
      const key = r?.note === 'Saved. Takes effect on next start.'
        ? 'players.savedNextStart'
        : enabled ? 'players.whitelistEnabled' : 'players.whitelistDisabled';
      toast.success(t(key));
      loadLists();
    } catch (err) { toast.error(err.message); loadLists(); }
  }

  // Add-from-search: route to the right list.
  const addNew = (kind, name) => plAction(kind, 'add', name);

  const selFlags = selected ? getFlags(selected) : {};
  const selReason = selected ? (sets.banReason.get(selected.toLowerCase()) || '') : '';

  return (
    <div className="space-y-5">
      <ViewHeader title={t('nav.players')} />
      {/* Top controls: add new player + whitelist toggle + refresh */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-stretch">
        <div className="flex-1"><AddPlayerBar onAdd={addNew} t={t} /></div>
        <Card className="shrink-0">
          <CardContent className="flex h-full items-center gap-4 py-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={!!lists.whitelistEnabled} onChange={toggleWhitelist} className="accent-primary" />
              {t('minecraft.players.whitelistTitle')}
            </label>
            <Button variant="glass" size="sm" onClick={loadLists}>
              <RefreshCw className="h-3.5 w-3.5" /> {t('minecraft.players.refresh')}
            </Button>
          </CardContent>
        </Card>
      </div>

      {listLoading ? (
        <Loading />
      ) : listError ? (
        <ErrorState error={listError} onRetry={loadLists} />
      ) : (
        <>
          <PlayerSection
            title={t('minecraft.players.onlineTitle')} count={onlineNames.length} players={onlineNames}
            getFlags={getFlags} onSelect={setSelected} emptyMessage={t('minecraft.players.onlineEmpty')}
          />

          <PlayerSection
            title={t('minecraft.players.recentTitle')} count={(lists.recent || []).length}
            players={(lists.recent || []).map((p) => p.name)}
            getFlags={getFlags} onSelect={setSelected} emptyMessage={t('minecraft.players.recentEmpty')}
          />

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <PlayerSection
              title={t('minecraft.players.whitelistTitle')} icon={Check} count={(lists.whitelist || []).length}
              players={lists.whitelist || []} getFlags={getFlags} onSelect={setSelected}
              emptyMessage={t('minecraft.players.whitelistEmpty')}
            />
            <PlayerSection
              title={t('minecraft.players.opsTitle')} icon={Crown} count={(lists.ops || []).length}
              players={lists.ops || []} getFlags={getFlags} onSelect={setSelected}
              emptyMessage={t('minecraft.players.opsEmpty')}
            />
            <PlayerSection
              title={t('minecraft.players.bannedTitle')} icon={Ban} count={(lists.banned || []).length}
              players={(lists.banned || []).map((b) => b.name)} getFlags={getFlags} onSelect={setSelected}
              emptyMessage={t('minecraft.players.bannedEmpty')}
            />
          </div>
        </>
      )}

      {selected && (
        <PlayerDetail
          name={selected} flags={selFlags} reason={selReason}
          uuid={(lists.recent || []).find((p) => p.name === selected)?.uuid || ''}
          onAction={actions} onClose={() => setSelected(null)} t={t}
        />
      )}
    </div>
  );
}
