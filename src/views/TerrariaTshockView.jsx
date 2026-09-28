import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Ban, Database, LogOut, Plus, RefreshCw, ShieldCheck, UserRound, Users } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorState } from '@/components/shared/ErrorState';
import { Loading } from '@/components/shared/Loading';
import { ViewHeader } from '@/components/layout/Page';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/context/AuthContext';
import { useServer } from '@/context/ServerContext';
import { useT } from '@/context/I18nContext';

const API = '/api/terraria/tshock';

export function TerrariaTshockView() {
  const api = useApi();
  const t = useT();
  const { activeServerId } = useServer();
  const { hasCapability } = useAuth();
  const canManagePlayers = hasCapability('players.manage', activeServerId);
  const canManageGroups = hasCapability('server.manage', activeServerId);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [playerAction, setPlayerAction] = useState(null);
  const [reason, setReason] = useState('');
  const [accountDialog, setAccountDialog] = useState(null);
  const [accountForm, setAccountForm] = useState({ name: '', password: '', group: '' });
  const [deleteAccount, setDeleteAccount] = useState(null);
  const [deleteText, setDeleteText] = useState('');
  const [groupDialog, setGroupDialog] = useState(null);
  const [groupForm, setGroupForm] = useState({ name: '', parent: '', permissions: '' });
  const [preview, setPreview] = useState(null);
  const query = `?serverId=${encodeURIComponent(activeServerId || '')}`;

  const load = useCallback(async () => {
    if (!activeServerId) return;
    setError('');
    try {
      const status = await api(`${API}/status${query}`);
      const settled = await Promise.allSettled([
        api(`${API}/players${query}`),
        api(`${API}/accounts${query}`),
        api(`${API}/groups${query}`),
        api(`${API}/permissions${query}`),
        api(`${API}/bans${query}`),
      ]);
      setData({
        status,
        players: settled[0].status === 'fulfilled' ? settled[0].value.players : [],
        playersUnavailable: settled[0].status !== 'fulfilled',
        accounts: settled[1].status === 'fulfilled' ? settled[1].value.accounts : [],
        groups: settled[2].status === 'fulfilled' ? settled[2].value.groups : [],
        groupsEditable: settled[2].status === 'fulfilled' && settled[2].value.editable,
        groupEditReason: settled[2].status === 'fulfilled' ? settled[2].value.editReason : settled[2].reason?.message,
        permissions: settled[3].status === 'fulfilled' ? settled[3].value.permissions : [],
        bans: settled[4].status === 'fulfilled' ? settled[4].value.bans : [],
      });
    } catch (loadError) { setError(loadError.message); }
  }, [activeServerId, api, query]);

  useEffect(() => { setData(null); load(); }, [load]);

  async function actOnPlayer() {
    if (!playerAction) return;
    setBusy(true);
    try {
      await api(`${API}/players/${playerAction.action}`, {
        method: 'POST',
        body: { serverId: activeServerId, target: playerAction.player.name, reason },
      });
      toast.success(t('terraria.tshock.actionQueued'));
      setPlayerAction(null);
      setReason('');
      await load();
    } catch (actionError) { toast.error(actionError.message); }
    setBusy(false);
  }

  async function saveAccount() {
    setBusy(true);
    try {
      await api(`${API}/accounts`, {
        method: 'POST',
        body: { serverId: activeServerId, action: accountDialog || 'create', ...accountForm },
      });
      toast.success(t('terraria.tshock.accountSaved'));
      setAccountDialog(null);
      setAccountForm({ name: '', password: '', group: '' });
      await load();
    } catch (saveError) { toast.error(saveError.message); }
    setBusy(false);
  }

  async function removeAccount() {
    setBusy(true);
    try {
      await api(`${API}/accounts/${encodeURIComponent(deleteAccount.name)}${query}`, { method: 'DELETE' });
      toast.success(t('terraria.tshock.accountDeleted'));
      setDeleteAccount(null);
      setDeleteText('');
      await load();
    } catch (deleteError) { toast.error(deleteError.message); }
    setBusy(false);
  }

  function editGroup(group) {
    setGroupDialog(group || {});
    setGroupForm({
      name: group?.name || '',
      parent: group?.parent || '',
      permissions: (group?.permissions || []).join('\n'),
    });
  }

  async function reviewGroup() {
    setBusy(true);
    try {
      const result = await api(`${API}/groups/preview`, {
        method: 'POST',
        body: {
          serverId: activeServerId,
          name: groupForm.name,
          parent: groupForm.parent || null,
          permissions: groupForm.permissions.split(/[\n, ]+/).filter(Boolean),
        },
      });
      setPreview(result.preview);
      setGroupDialog(null);
    } catch (reviewError) { toast.error(reviewError.message); }
    setBusy(false);
  }

  async function applyGroup(confirmSelfLockout = false) {
    setBusy(true);
    try {
      await api(`${API}/groups`, {
        method: 'POST',
        body: { serverId: activeServerId, ...preview.after, confirmSelfLockout },
      });
      toast.success(t('terraria.tshock.groupSaved'));
      setPreview(null);
      await load();
    } catch (applyError) { toast.error(applyError.message); }
    setBusy(false);
  }

  async function unban(identifier) {
    setBusy(true);
    try {
      await api(`${API}/bans/${encodeURIComponent(identifier)}${query}`, { method: 'DELETE' });
      toast.success(t('terraria.tshock.unbanned'));
      await load();
    } catch (unbanError) { toast.error(unbanError.message); }
    setBusy(false);
  }

  const transportLabel = useMemo(() => data ? t(`terraria.tshock.transport.${data.status.transport}`) : '', [data, t]);

  if (!data && !error) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={load} />;

  return (
    <div className="space-y-6">
      <ViewHeader
        title={t('nav.players')}
        actions={<Button variant="glass" onClick={load}><RefreshCw className="h-4 w-4" />{t('common.refresh')}</Button>}
      />

      {!data.status.loopbackSafe && (
        <Alert variant="destructive" icon={AlertTriangle} title={t('terraria.tshock.publicRestTitle')}>
          {t('terraria.tshock.publicRestDescription')}
        </Alert>
      )}
      {/* How the panel reaches TShock only matters when it is not the healthy default. */}
      {(data.status.health.state !== 'healthy' || data.status.reason) && (
        <Alert
          variant="softWarning"
          icon={data.status.transport === 'database' ? Database : ShieldCheck}
          title={t('terraria.tshock.transportTitle', { transport: transportLabel })}
        >
          {data.status.reason ? t('terraria.tshock.transportFallback', { reason: data.status.reason }) : t('terraria.tshock.transportReady')}
        </Alert>
      )}

      <Tabs defaultValue="players">
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="players">{t('terraria.tshock.players')}{data.playersUnavailable ? '' : ` (${data.players.length})`}</TabsTrigger>
          <TabsTrigger value="accounts">{t('terraria.tshock.accounts')} ({data.accounts.length})</TabsTrigger>
          <TabsTrigger value="groups">{t('terraria.tshock.groups')} ({data.groups.length})</TabsTrigger>
          <TabsTrigger value="bans">{t('terraria.tshock.bans')} ({data.bans.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="players">
          <Card>
            <CardHeader><CardTitle>{t('terraria.tshock.onlinePlayers')}</CardTitle></CardHeader>
            <CardContent className="p-0">
              {!data.players.length ? <EmptyState icon={Users} title={t('terraria.tshock.noPlayers')} message={data.playersUnavailable ? t('terraria.tshock.playersUnavailable') : t('terraria.tshock.noPlayersDescription')} /> : (
                <Table><TableHeader><TableRow><TableHead>{t('terraria.tshock.player')}</TableHead><TableHead>{t('terraria.tshock.group')}</TableHead><TableHead className="text-right">{t('common.actions')}</TableHead></TableRow></TableHeader>
                  <TableBody>{data.players.map((player) => <TableRow key={player.name}><TableCell className="font-semibold">{player.name}</TableCell><TableCell>{player.group || '—'}</TableCell><TableCell><div className="flex justify-end gap-2">
                    {canManagePlayers && <><Button size="sm" variant="glass" onClick={() => setPlayerAction({ player, action: player.muted ? 'unmute' : 'mute' })}>{player.muted ? t('terraria.tshock.unmute') : t('terraria.tshock.mute')}</Button><Button size="sm" variant="glass" onClick={() => setPlayerAction({ player, action: 'kick' })}><LogOut className="h-3.5 w-3.5" />{t('terraria.tshock.kick')}</Button><Button size="sm" variant="destructive" onClick={() => setPlayerAction({ player, action: 'ban' })}><Ban className="h-3.5 w-3.5" />{t('terraria.tshock.ban')}</Button></>}
                  </div></TableCell></TableRow>)}</TableBody></Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="accounts">
          <Card>
            <CardHeader className="flex-row items-center justify-between"><CardTitle>{t('terraria.tshock.accounts')}</CardTitle>{canManagePlayers && <Button size="sm" onClick={() => setAccountDialog('create')}><Plus className="h-4 w-4" />{t('terraria.tshock.createAccount')}</Button>}</CardHeader>
            <CardContent className="p-0">{!data.accounts.length ? <EmptyState icon={UserRound} title={t('terraria.tshock.noAccounts')} message={t('terraria.tshock.noAccountsHint')} /> : <Table><TableHeader><TableRow><TableHead>{t('terraria.tshock.account')}</TableHead><TableHead>{t('terraria.tshock.group')}</TableHead><TableHead>{t('terraria.tshock.lastLogin')}</TableHead><TableHead /></TableRow></TableHeader><TableBody>
              {data.accounts.map((account) => <TableRow key={account.name}><TableCell className="font-semibold">{account.name}</TableCell><TableCell><Badge variant="outline">{account.group || '—'}</Badge></TableCell><TableCell className="text-xs text-muted-foreground">{account.lastLogin || '—'}</TableCell><TableCell className="text-right">{canManagePlayers && <Button size="sm" variant="destructive" onClick={() => setDeleteAccount(account)}>{t('common.delete')}</Button>}</TableCell></TableRow>)}
            </TableBody></Table>}</CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="groups">
          {!data.groupsEditable && <Alert variant="softWarning" icon={Database} title={t('terraria.tshock.groupEditingUnavailable')}>{data.groupEditReason}</Alert>}
          <Card className="mt-4">
            <CardHeader className="flex-row items-center justify-between"><CardTitle>{t('terraria.tshock.groups')}</CardTitle>{canManageGroups && <Button size="sm" disabled={!data.groupsEditable} onClick={() => editGroup(null)}><Plus className="h-4 w-4" />{t('terraria.tshock.createGroup')}</Button>}</CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{data.groups.map((group) => <button key={group.name} type="button" disabled={!canManageGroups || !data.groupsEditable} onClick={() => editGroup(group)} className="rounded border-2 border-border bg-background p-4 text-left transition-colors enabled:hover:border-primary">
              <div className="flex items-center justify-between"><strong>{group.name}</strong><span className="text-xs text-muted-foreground">{group.parent || t('terraria.tshock.noParent')}</span></div>
              <p className="mt-3 text-xs text-muted-foreground">{t('terraria.tshock.directEffective', { direct: group.permissions.length, effective: group.effectivePermissions.length })}</p>
              <div className="mt-2 flex flex-wrap gap-1">{group.permissions.slice(0, 5).map((permission) => <Badge key={permission} variant="outline">{permission}</Badge>)}</div>
            </button>)}</CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="bans">
          <Card><CardHeader><CardTitle>{t('terraria.tshock.bans')}</CardTitle></CardHeader><CardContent className="p-0">{!data.bans.length ? <EmptyState icon={Ban} title={t('terraria.tshock.noBans')} /> : <Table><TableHeader><TableRow><TableHead>{t('terraria.tshock.identifier')}</TableHead><TableHead>{t('terraria.tshock.reason')}</TableHead><TableHead>{t('terraria.tshock.bannedBy')}</TableHead><TableHead /></TableRow></TableHeader><TableBody>
            {data.bans.map((ban) => <TableRow key={ban.identifier}><TableCell className="tabular-nums">{ban.identifier}</TableCell><TableCell>{ban.reason || '—'}</TableCell><TableCell>{ban.bannedBy || '—'}</TableCell><TableCell className="text-right">{canManagePlayers && <Button size="sm" variant="glass" disabled={busy} onClick={() => unban(ban.identifier)}>{t('terraria.tshock.unban')}</Button>}</TableCell></TableRow>)}
          </TableBody></Table>}</CardContent></Card>
        </TabsContent>
      </Tabs>

      <Dialog open={!!playerAction} onOpenChange={(open) => !open && setPlayerAction(null)}>
        <DialogContent className="max-w-md"><DialogHeader><DialogTitle>{t('terraria.tshock.confirmAction', { action: playerAction?.action, player: playerAction?.player.name })}</DialogTitle></DialogHeader><DialogBody className="space-y-3"><label className="text-xs font-semibold" htmlFor="tshock-reason">{t('terraria.tshock.reasonOptional')}</label><Textarea id="tshock-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={512} /></DialogBody><DialogFooter><Button variant="glass" onClick={() => setPlayerAction(null)}>{t('common.cancel')}</Button><Button variant={playerAction?.action === 'ban' ? 'destructive' : 'default'} disabled={busy} onClick={actOnPlayer}>{t('common.confirm')}</Button></DialogFooter></DialogContent>
      </Dialog>

      <Dialog open={!!accountDialog} onOpenChange={(open) => !open && setAccountDialog(null)}>
        <DialogContent className="max-w-md"><DialogHeader><DialogTitle>{t('terraria.tshock.createAccount')}</DialogTitle></DialogHeader><DialogBody className="space-y-3"><Input placeholder={t('terraria.tshock.accountName')} value={accountForm.name} onChange={(event) => setAccountForm((value) => ({ ...value, name: event.target.value }))} /><Input type="password" autoComplete="new-password" placeholder={t('terraria.tshock.password')} value={accountForm.password} onChange={(event) => setAccountForm((value) => ({ ...value, password: event.target.value }))} /><NativeSelect placeholder={t('terraria.tshock.chooseGroup')} options={data.groups.map((group) => ({ value: group.name, label: group.name }))} value={accountForm.group} onChange={(event) => setAccountForm((value) => ({ ...value, group: event.target.value }))} /><p className="text-xs text-muted-foreground">{t('terraria.tshock.passwordWriteOnly')}</p></DialogBody><DialogFooter><Button variant="glass" onClick={() => setAccountDialog(null)}>{t('common.cancel')}</Button><Button disabled={busy || !accountForm.name || !accountForm.password || !accountForm.group} onClick={saveAccount}>{t('common.save')}</Button></DialogFooter></DialogContent>
      </Dialog>

      <Dialog open={!!deleteAccount} onOpenChange={(open) => !open && setDeleteAccount(null)}>
        <DialogContent className="max-w-md"><DialogHeader><DialogTitle>{t('terraria.tshock.deleteAccountTitle')}</DialogTitle></DialogHeader><DialogBody className="space-y-3"><p className="text-sm text-muted-foreground">{t('terraria.tshock.typeAccountName', { name: deleteAccount?.name })}</p><Input value={deleteText} onChange={(event) => setDeleteText(event.target.value)} /></DialogBody><DialogFooter><Button variant="glass" onClick={() => setDeleteAccount(null)}>{t('common.cancel')}</Button><Button variant="destructive" disabled={busy || deleteText !== deleteAccount?.name} onClick={removeAccount}>{t('common.delete')}</Button></DialogFooter></DialogContent>
      </Dialog>

      <Dialog open={!!groupDialog} onOpenChange={(open) => !open && setGroupDialog(null)}>
        <DialogContent className="max-w-xl"><DialogHeader><DialogTitle>{t('terraria.tshock.groupEditor')}</DialogTitle></DialogHeader><DialogBody className="space-y-4"><Input placeholder={t('terraria.tshock.groupName')} value={groupForm.name} disabled={!!groupDialog?.name} onChange={(event) => setGroupForm((value) => ({ ...value, name: event.target.value }))} /><NativeSelect options={[{ value: '', label: t('terraria.tshock.noParent') }, ...data.groups.filter((group) => group.name !== groupForm.name).map((group) => ({ value: group.name, label: group.name }))]} value={groupForm.parent} onChange={(event) => setGroupForm((value) => ({ ...value, parent: event.target.value }))} /><Textarea className="min-h-40 text-xs" placeholder={t('terraria.tshock.permissionsPlaceholder')} value={groupForm.permissions} onChange={(event) => setGroupForm((value) => ({ ...value, permissions: event.target.value }))} /><p className="text-xs text-muted-foreground">{t('terraria.tshock.permissionsHint')}</p></DialogBody><DialogFooter><Button variant="glass" onClick={() => setGroupDialog(null)}>{t('common.cancel')}</Button><Button disabled={busy || !groupForm.name} onClick={reviewGroup}>{t('terraria.tshock.reviewChanges')}</Button></DialogFooter></DialogContent>
      </Dialog>

      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-lg"><DialogHeader><DialogTitle>{preview?.selfLockout ? t('terraria.tshock.selfLockoutTitle') : t('terraria.tshock.diffTitle')}</DialogTitle></DialogHeader><DialogBody className="space-y-4">{preview?.selfLockout && <Alert variant="destructive" icon={AlertTriangle} title={t('terraria.tshock.selfLockoutTitle')}>{t('terraria.tshock.selfLockoutDescription')}</Alert>}<div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('terraria.tshock.added')}</p><p className="mt-1 text-xs">{preview?.added.join(', ') || '—'}</p></div><div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('terraria.tshock.removed')}</p><p className="mt-1 text-xs">{preview?.removed.join(', ') || '—'}</p></div>{preview?.unknownPermissions.length > 0 && <p className="text-xs text-status-warn">{t('terraria.tshock.unknownPermissions', { count: preview.unknownPermissions.length })}</p>}</DialogBody><DialogFooter><Button variant="glass" onClick={() => setPreview(null)}>{t('common.cancel')}</Button><Button variant={preview?.selfLockout ? 'destructive' : 'default'} disabled={busy} onClick={() => applyGroup(preview?.selfLockout)}>{preview?.selfLockout ? t('terraria.tshock.confirmSelfLockout') : t('common.apply')}</Button></DialogFooter></DialogContent>
      </Dialog>
    </div>
  );
}
