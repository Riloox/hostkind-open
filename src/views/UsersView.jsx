import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorState } from '@/components/shared/ErrorState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Loading } from '@/components/shared/Loading';
import { PasswordStrength } from '@/components/shared/PasswordStrength';
import { PermissionModal } from './users/PermissionModal';
import { ApiKeysCard } from './users/ApiKeysCard';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/context/AuthContext';
import { useT } from '@/context/I18nContext';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Pencil, Trash2, Plus, ShieldCheck, Wrench, KeyRound } from 'lucide-react';

function RoleBadge({ role }) {
  const t = useT();
  const admin = role === 'admin';

  return (
    <Badge variant={admin ? 'softPrimary' : 'default'} className="gap-1 px-1.5 py-0.5 text-label">
      {admin ? <ShieldCheck className="h-2.5 w-2.5" /> : <Wrench className="h-2.5 w-2.5" />}
      {admin ? t('users.roleAdmin') : t('users.roleOperator')}
    </Badge>
  );
}

function UserModal({ open, onOpenChange, user, currentUser, onSaved }) {
  const api = useApi();
  const t = useT();
  const [form, setForm] = useState({ name: '', email: '', username: '', password: '', role: 'operator' });
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setError('');
      setForm({
        name: user?.name || '',
        email: user?.email || '',
        username: user?.username || '',
        password: '',
        role: user?.role || 'operator',
      });
    }
  }, [open, user]);

  const isSelf = user && currentUser && user.id === currentUser.id;

  async function save() {
    const body = { name: form.name, email: form.email, username: form.username };
    if (form.password || !user) body.password = form.password;
    // Never send a role change for your own account (the server rejects it
    // anyway); editing yourself can only touch profile fields and password.
    if (!isSelf) body.role = form.role;
    try {
      if (user?.id) await api(`/api/users/${user.id}`, { method: 'PUT', body });
      else await api('/api/users', { method: 'POST', body });
      onSaved(user ? t('users.updatedToast') : t('users.createdToast'));
      onOpenChange(false);
    } catch (e) { setError(e.message); }
  }

  const f = (k) => (e) => setForm(p => ({ ...p, [k]: e.target.value }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{user ? t('users.editTitle') : t('users.addTitle')}</DialogTitle></DialogHeader>
        <div className="px-5 py-4 space-y-4">
          <div className="space-y-1.5">
            <Label>{t('users.fieldName')}</Label>
            <Input value={form.name} onChange={f('name')} placeholder={t('users.namePlaceholder')} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('users.fieldUsername')}</Label>
            <Input value={form.username} onChange={f('username')} placeholder={t('users.usernamePlaceholder')} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label>{t('users.fieldEmail')}</Label>
            <Input type="email" value={form.email} onChange={f('email')} placeholder={t('users.emailPlaceholder')} autoComplete="off" />
          </div>
          {!isSelf && (
            <div className="space-y-1.5">
              <Label>{t('users.fieldRole')}</Label>
              <NativeSelect
                value={form.role}
                onChange={f('role')}
                options={[
                  { value: 'operator', label: t('users.roleOperator') },
                  { value: 'admin', label: t('users.roleAdmin') },
                ]}
              />
              <p className="text-label text-muted-foreground">
                {form.role === 'admin' ? t('users.roleAdminDesc') : t('users.roleOperatorDesc')}
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{user ? t('users.fieldPasswordEdit') : t('users.fieldPasswordNew')}</Label>
            <Input type="password" value={form.password} onChange={f('password')} placeholder={t('users.passwordPlaceholder')} autoComplete="new-password" />
            <PasswordStrength password={form.password} />
          </div>
          {error && <p className="text-xs text-status-error">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="glass" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button variant="default" onClick={save}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Panel-wide sign-in switch. Admin-only because the whole Users view is
// gated behind users.manage; the endpoint enforces it again server-side.
function SecurityCard() {
  const api = useApi();
  const t = useT();
  const { token, logout } = useAuth();
  const [requireAuth, setRequireAuth] = useState(null);
  const [pendingChange, setPendingChange] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api('/api/config')
      .then((cfg) => setRequireAuth(cfg.requireAuth !== false))
      .catch((e) => toast.error(e.message));
  }, []);

  async function applyChange(next) {
    setSaving(true);
    try {
      const data = await api('/api/config/auth', { method: 'PUT', body: { requireAuth: next } });
      const on = data.requireAuth !== false;
      setRequireAuth(on);
      toast.success(on ? t('security.enabledToast') : t('security.disabledToast'));
      // Turning sign-in back on ends every guest session, including this one:
      // with no token to fall back on, land on the login screen.
      if (on && !token) logout();
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); setPendingChange(null); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('security.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <label className="flex items-start gap-3 rounded-md border border-border/60 px-3 py-2.5">
          <Checkbox
            className="mt-0.5"
            checked={requireAuth !== false}
            disabled={requireAuth === null || saving}
            onCheckedChange={(checked) => setPendingChange(checked === true)}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">{t('security.requireAuthLabel')}</span>
            <span className="block text-xs text-muted-foreground">{t('security.requireAuthDesc')}</span>
          </span>
        </label>
      </CardContent>
      <ConfirmDialog
        open={pendingChange !== null}
        onOpenChange={(o) => { if (!o) setPendingChange(null); }}
        title={pendingChange ? t('security.enableTitle') : t('security.disableTitle')}
        description={pendingChange ? t('security.enableBody') : t('security.disableBody')}
        confirmLabel={t('common.save')}
        destructive={pendingChange === false}
        onConfirm={() => applyChange(pendingChange)}
      />
    </Card>
  );
}

export function UsersView() {
  const api = useApi();
  const t = useT();
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [permissionUser, setPermissionUser] = useState(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const { users: list } = await api('/api/users');
      setUsers(list);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function deleteUser(id) {
    try {
      await api(`/api/users/${id}`, { method: 'DELETE' });
      toast.success(t('users.deletedToast'));
      load();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="space-y-6">
      <SecurityCard />
      <Card>
        <CardHeader>
          <CardTitle>{t('users.title')}</CardTitle>
          <Button variant="default" size="sm" onClick={() => { setEditUser(null); setModalOpen(true); }}>
            <Plus className="h-3.5 w-3.5" />
            {t('users.addUser')}
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Loading />
          ) : error ? (
            <ErrorState error={error} onRetry={load} />
          ) : users.length === 0 ? (
            <EmptyState message={t('users.empty')} />
          ) : (
            <div className="space-y-1.5">
              {users.map(u => {
                const isSelf = currentUser && u.id === currentUser.id;
                const primary = u.username || u.email;
                const secondary = u.username && u.email ? u.email : null;
                return (
                  <div key={u.id} className="flex items-center gap-3 rounded-md border border-border/60 bg-secondary/20 px-3 py-2.5 hover:bg-secondary/40 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground truncate">{primary}</span>
                        <RoleBadge role={u.role} />
                        {isSelf && <Badge variant="active" className="text-label px-1 py-0.5">{t('users.youBadge')}</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {secondary ? <span>{secondary}</span> : <span>{u.name || t('common.dashPlaceholder')}</span>}
                      </div>
                    </div>
                    <Button variant="glass" size="xs" onClick={() => { setEditUser(u); setModalOpen(true); }}>
                      <Pencil className="h-3 w-3" />{t('common.edit')}
                    </Button>
                    {u.role !== 'admin' && (
                      <Button variant="glass" size="xs" onClick={() => setPermissionUser(u)}>
                        <KeyRound className="h-3 w-3" />{t('users.permissions')}
                      </Button>
                    )}
                    <Button variant="ghost" size="icon-xs"
                      disabled={isSelf}
                      title={t('common.delete')}
                      aria-label={t('common.delete')}
                      onClick={() => setPendingDelete(u)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
      <ApiKeysCard language={currentUser?.language} />
      <UserModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        user={editUser}
        currentUser={currentUser}
        onSaved={(msg) => { toast.success(msg); load(); }}
      />
      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => { if (!o) setPendingDelete(null); }}
        title={t('users.deleteTitle')}
        description={pendingDelete ? t('users.deleteBody', { identifier: pendingDelete.username || pendingDelete.email, cannotUndo: t('common.cannotUndo') }) : ''}
        confirmLabel={t('common.delete')}
        destructive
        onConfirm={() => { deleteUser(pendingDelete.id); setPendingDelete(null); }}
      />
      <PermissionModal
        open={!!permissionUser}
        onOpenChange={(value) => { if (!value) setPermissionUser(null); }}
        basePath={permissionUser ? `/api/users/${permissionUser.id}` : ''}
        subject={permissionUser?.username || permissionUser?.email}
        onSaved={load}
      />
    </div>
  );
}
