import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { NativeSelect } from '@/components/ui/native-select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/EmptyState';
import { ErrorState } from '@/components/shared/ErrorState';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Loading } from '@/components/shared/Loading';
import { PermissionModal } from './PermissionModal';
import { useApi } from '@/hooks/useApi';
import { useT } from '@/context/I18nContext';
import { toast } from 'sonner';
import { Plus, Trash2, KeyRound, Copy, ShieldCheck, Wrench } from 'lucide-react';

function formatDate(ts, language) {
  if (!ts) return null;
  return new Intl.DateTimeFormat(language === 'es' ? 'es' : 'en', { dateStyle: 'medium' }).format(new Date(ts));
}

/*
 * Shown once, immediately after a key is created. The panel cannot show this
 * again - only the hash is stored - so the dialog says so plainly and does not
 * offer a "close" that looks like "later".
 */
function TokenDialog({ token, onClose }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      // Clipboard access can be refused (insecure origin, denied permission).
      // The token is on screen and selectable, so this is not a failure worth
      // an error toast - it just means they copy it by hand.
      toast.message(t('apiKeys.copyManually'));
    }
  }

  return (
    <Dialog open={!!token} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{t('apiKeys.createdTitle')}</DialogTitle></DialogHeader>
        <div className="space-y-3 px-5 py-4">
          <p className="text-xs text-muted-foreground">{t('apiKeys.createdHint')}</p>
          <code
            data-testid="api-key-token"
            className="block select-all break-all rounded-md border border-border bg-secondary/40 px-3 py-2.5 font-mono text-xs text-foreground"
          >
            {token}
          </code>
          <Button variant="glass" size="sm" onClick={copy}>
            <Copy className="h-3 w-3" />
            {copied ? t('apiKeys.copied') : t('apiKeys.copy')}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t('apiKeys.savedIt')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateKeyDialog({ open, onOpenChange, onCreated }) {
  const api = useApi();
  const t = useT();
  const [form, setForm] = useState({ name: '', role: 'operator', expiresAt: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) { setForm({ name: '', role: 'operator', expiresAt: '' }); setError(''); }
  }, [open]);

  async function save() {
    setSaving(true);
    setError('');
    try {
      const body = { name: form.name, role: form.role };
      // A date input gives midnight local time; the key should live through
      // that whole day, so expire it at the end of it.
      if (form.expiresAt) body.expiresAt = new Date(`${form.expiresAt}T23:59:59`).getTime();
      const data = await api('/api/api-keys', { method: 'POST', body });
      onCreated(data);
      onOpenChange(false);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  const f = (k) => (e) => setForm((p) => ({ ...p, [k]: e.target.value }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{t('apiKeys.addTitle')}</DialogTitle></DialogHeader>
        <div className="space-y-4 px-5 py-4">
          <div className="space-y-1.5">
            <Label>{t('apiKeys.fieldName')}</Label>
            <Input value={form.name} onChange={f('name')} placeholder={t('apiKeys.namePlaceholder')} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label>{t('apiKeys.fieldRole')}</Label>
            <NativeSelect
              value={form.role}
              onChange={f('role')}
              options={[
                { value: 'operator', label: t('users.roleOperator') },
                { value: 'admin', label: t('users.roleAdmin') },
              ]}
            />
            <p className="text-label text-muted-foreground">
              {form.role === 'admin' ? t('apiKeys.roleAdminDesc') : t('apiKeys.roleOperatorDesc')}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>{t('apiKeys.fieldExpiry')}</Label>
            <Input type="date" value={form.expiresAt} onChange={f('expiresAt')} />
            <p className="text-label text-muted-foreground">{t('apiKeys.expiryHint')}</p>
          </div>
          {error && <p className="text-xs text-status-error">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="glass" onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button onClick={save} disabled={saving}>{t('common.save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * API keys: the non-interactive way into the panel, for a billing system or a
 * provisioning script. Sits alongside the user list because it is the same
 * question - who may do what - answered for machines instead of people.
 */
export function ApiKeysCard({ language }) {
  const api = useApi();
  const t = useT();
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [freshToken, setFreshToken] = useState('');
  const [pendingRevoke, setPendingRevoke] = useState(null);
  const [permissionKey, setPermissionKey] = useState(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const { keys: list } = await api('/api/api-keys');
      setKeys(list);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function revoke(id) {
    try {
      await api(`/api/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast.success(t('apiKeys.revokedToast'));
      load();
    } catch (e) { toast.error(e.message); }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('apiKeys.title')}</CardTitle>
        <Button variant="default" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          {t('apiKeys.addKey')}
        </Button>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-xs text-muted-foreground">{t('apiKeys.hint')}</p>
        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorState error={error} onRetry={load} />
        ) : keys.length === 0 ? (
          <EmptyState message={t('apiKeys.empty')} />
        ) : (
          <div className="space-y-1.5">
            {keys.map((key) => {
              const expired = !key.revokedAt && key.expiresAt && key.expiresAt <= Date.now();
              const inactive = !!key.revokedAt || expired;
              const lastUsed = formatDate(key.lastUsedAt, language);
              return (
                <div
                  key={key.id}
                  data-api-key-row={key.name}
                  className="flex items-center gap-3 rounded-md border border-border/60 bg-secondary/20 px-3 py-2.5 transition-colors hover:bg-secondary/40"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`truncate text-sm font-medium ${inactive ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                        {key.name}
                      </span>
                      <Badge variant={key.role === 'admin' ? 'softPrimary' : 'default'} className="gap-1 px-1.5 py-0.5 text-label">
                        {key.role === 'admin' ? <ShieldCheck className="h-2.5 w-2.5" /> : <Wrench className="h-2.5 w-2.5" />}
                        {key.role === 'admin' ? t('users.roleAdmin') : t('users.roleOperator')}
                      </Badge>
                      {key.revokedAt && <Badge variant="default" className="px-1 py-0.5 text-label">{t('apiKeys.revokedBadge')}</Badge>}
                      {expired && <Badge variant="default" className="px-1 py-0.5 text-label">{t('apiKeys.expiredBadge')}</Badge>}
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {key.id}
                      {lastUsed
                        ? ` · ${t('apiKeys.lastUsed', { date: lastUsed })}`
                        : ` · ${t('apiKeys.neverUsed')}`}
                    </div>
                  </div>
                  {!inactive && key.role !== 'admin' && (
                    <Button variant="glass" size="xs" onClick={() => setPermissionKey(key)}>
                      <KeyRound className="h-3 w-3" />{t('users.permissions')}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={!!key.revokedAt}
                    title={t('apiKeys.revoke')}
                    onClick={() => setPendingRevoke(key)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <CreateKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(data) => { setFreshToken(data.token); load(); }}
      />
      <TokenDialog token={freshToken} onClose={() => setFreshToken('')} />
      <ConfirmDialog
        open={!!pendingRevoke}
        onOpenChange={(open) => { if (!open) setPendingRevoke(null); }}
        title={t('apiKeys.revokeTitle')}
        description={pendingRevoke ? t('apiKeys.revokeBody', { name: pendingRevoke.name, cannotUndo: t('common.cannotUndo') }) : ''}
        confirmLabel={t('apiKeys.revoke')}
        destructive
        onConfirm={() => { revoke(pendingRevoke.id); setPendingRevoke(null); }}
      />
      <PermissionModal
        open={!!permissionKey}
        onOpenChange={(open) => { if (!open) setPermissionKey(null); }}
        basePath={permissionKey ? `/api/api-keys/${encodeURIComponent(permissionKey.id)}` : ''}
        subject={permissionKey?.name}
        onSaved={load}
      />
    </Card>
  );
}
