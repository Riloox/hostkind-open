import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { PasswordStrength } from '@/components/shared/PasswordStrength';
import { SettingsGroup } from '@/components/shared/SettingsGroup';
import { Check, Scale } from 'lucide-react';
import { useI18n, useT } from '@/context/I18nContext';
import { useAuth } from '@/context/AuthContext';
import { useApi } from '@/hooks/useApi';
import { AccentField } from '@/components/shared/AccentField';
import { TermsDialog } from '@/components/shared/TermsDialog';
import { GAMES } from '@/lib/games';
import { cn } from '@/lib/utils';

const HOTKEYS = [
  { combo: ['Ctrl', 'B'], labelKey: 'settings.hotkeyToggleSidebar', hintKey: 'settings.hotkeyToggleSidebarHint', mac: ['Cmd', 'B'] },
  { combo: ['↑'], altCombo: ['↓'], labelKey: 'settings.hotkeyConsoleHistory', hintKey: 'settings.hotkeyConsoleHistoryHint' },
  { combo: ['Esc'], labelKey: 'settings.hotkeyCloseMenu', hintKey: 'settings.hotkeyCloseMenuHint' },
];

function Kbd({ children }) {
  return (
    <kbd className="inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded border border-border/80 bg-background/70 px-1.5 text-label font-medium text-foreground shadow-[inset_0_-1px_0_oklch(var(--ember-7)/0.06)]">
      {children}
    </kbd>
  );
}

function Combo({ keys }) {
  return keys.map((k, i) => (
    <span key={i} className="flex items-center gap-1">
      {i > 0 && <span className="text-muted-foreground/60 text-label">+</span>}
      <Kbd>{k}</Kbd>
    </span>
  ));
}

function ComboRow({ combo, altCombo }) {
  return (
    <span className="flex items-center gap-1">
      <Combo keys={combo} />
      {altCombo && (
        <>
          <span className="text-muted-foreground/60 text-label mx-1">/</span>
          <Combo keys={altCombo} />
        </>
      )}
    </span>
  );
}

function ProfileGroup() {
  const t = useT();
  const api = useApi();
  const { user, setUser } = useAuth();
  const [form, setForm] = useState({ name: '', username: '', email: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm({ name: user?.name || '', username: user?.username || '', email: user?.email || '' });
  }, [user]);

  const f = (k) => (e) => setForm(p => ({ ...p, [k]: e.target.value }));

  async function save() {
    setSaving(true);
    try {
      const { user: updated } = await api('/api/me', { method: 'PUT', body: form });
      setUser(updated);
      toast.success(t('profile.saved'));
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  }

  return (
    <SettingsGroup title={t('profile.title')} hint={t('profile.desc')} data-settings-group="profile">
      <div className="space-y-1.5">
        <Label htmlFor="profile-name">{t('users.fieldName')}</Label>
        <Input id="profile-name" value={form.name} onChange={f('name')} placeholder={t('users.namePlaceholder')} />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="profile-username">{t('users.fieldUsername')}</Label>
          <Input id="profile-username" value={form.username} onChange={f('username')} autoComplete="off" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="profile-email">{t('users.fieldEmail')}</Label>
          <Input id="profile-email" type="email" value={form.email} onChange={f('email')} autoComplete="off" />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-label text-muted-foreground">
          {t('profile.role')}: <span className="font-medium text-foreground">{user?.role === 'admin' ? t('users.roleAdmin') : t('users.roleOperator')}</span>
        </span>
        <Button size="sm" onClick={save} disabled={saving}>{t('common.save')}</Button>
      </div>
    </SettingsGroup>
  );
}

function PasswordGroup() {
  const t = useT();
  const api = useApi();
  const { user, login } = useAuth();
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [saving, setSaving] = useState(false);

  const f = (k) => (e) => setForm(p => ({ ...p, [k]: e.target.value }));

  async function save() {
    if (form.newPassword !== form.confirmPassword) {
      toast.error(t('profile.mismatch'));
      return;
    }
    setSaving(true);
    try {
      const data = await api('/api/me/password', {
        method: 'PUT',
        body: { currentPassword: form.currentPassword, newPassword: form.newPassword },
      });
      // The change signs out every earlier session, this one included; keep
      // working on the replacement token the server issued.
      if (data?.token) login(data.token, user);
      toast.success(t('profile.passwordChanged'));
      setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  }

  return (
    <SettingsGroup title={t('profile.changePassword')} hint={t('profile.changePasswordDesc')} data-settings-group="password">
      <div className="space-y-1.5">
        <Label htmlFor="password-current">{t('profile.currentPassword')}</Label>
        <Input id="password-current" type="password" value={form.currentPassword} onChange={f('currentPassword')} autoComplete="current-password" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password-new">{t('profile.newPassword')}</Label>
        <Input id="password-new" type="password" value={form.newPassword} onChange={f('newPassword')} autoComplete="new-password" placeholder={t('users.passwordPlaceholder')} />
        <PasswordStrength password={form.newPassword} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password-confirm">{t('profile.confirmPassword')}</Label>
        <Input id="password-confirm" type="password" value={form.confirmPassword} onChange={f('confirmPassword')} autoComplete="new-password" />
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={saving || !form.currentPassword || !form.newPassword}>
          {t('profile.updatePassword')}
        </Button>
      </div>
    </SettingsGroup>
  );
}

// The crash-loop guard, panel-wide. It is a supervision setting, so only a
// real admin (never the synthetic guest session) sees it; the endpoint
// enforces the admin rule again server-side.
function WatchdogGroup() {
  const t = useT();
  const api = useApi();
  const [form, setForm] = useState({ enabled: false, maxRestarts: 3, windowMinutes: 10 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api('/api/config', { silent: true })
      .then((cfg) => {
        if (cancelled) return;
        setForm({
          enabled: cfg?.watchdog?.enabled === true,
          maxRestarts: Number(cfg?.watchdog?.maxRestarts ?? 3) || 3,
          windowMinutes: Number(cfg?.watchdog?.windowMinutes ?? 10) || 10,
        });
      })
      .catch(() => { /* defaults stay until the operator saves */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function save() {
    setSaving(true);
    try {
      const data = await api('/api/config/watchdog', { method: 'PUT', body: form });
      setForm({
        enabled: data.watchdog.enabled === true,
        maxRestarts: data.watchdog.maxRestarts,
        windowMinutes: data.watchdog.windowMinutes,
      });
      toast.success(t('settings.watchdogSaved'));
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  }

  return (
    <SettingsGroup title={t('settings.watchdog')} hint={t('settings.watchdogDesc')} data-settings-group="watchdog">
      <label className="flex items-start gap-3 rounded-md border border-border/60 px-3 py-2.5">
        <Checkbox
          className="mt-0.5"
          checked={form.enabled}
          disabled={loading || saving}
          onCheckedChange={(checked) => setForm((p) => ({ ...p, enabled: checked === true }))}
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{t('settings.watchdogEnabled')}</span>
          <span className="block text-xs text-muted-foreground">{t('settings.watchdogEnabledHint')}</span>
        </span>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label htmlFor="watchdog-max">{t('settings.watchdogMaxRestarts')}</Label>
          <Input id="watchdog-max" type="number" min={0} step={1} value={form.maxRestarts} onChange={(e) => setForm((p) => ({ ...p, maxRestarts: Math.max(0, Math.floor(Number(e.target.value) || 0)) }))} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="watchdog-window">{t('settings.watchdogWindow')}</Label>
          <Input id="watchdog-window" type="number" min={1} step={1} value={form.windowMinutes} onChange={(e) => setForm((p) => ({ ...p, windowMinutes: Math.max(1, Math.floor(Number(e.target.value) || 1)) }))} />
        </div>
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={loading || saving}>
          {saving ? t('common.loading') : t('common.save')}
        </Button>
      </div>
    </SettingsGroup>
  );
}

function GameColorsGroup() {
  const t = useT();
  const api = useApi();
  const { gameAccents, setGameAccents, setGameThemes } = useAuth();
  const [busy, setBusy] = useState(false);

  async function save(next) {
    setBusy(true);
    try {
      const state = await api('/api/config/game-accents', { method: 'PUT', body: { accents: next } });
      setGameAccents(state.gameAccents);
      setGameThemes(state.gameThemes);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsGroup title={t('settings.gameColors')} hint={t('settings.gameColorsDesc')} data-settings-group="game-colors">
      {GAMES.map((game) => (
        <div key={game.id} className="space-y-1.5">
          <p className="text-sm font-medium text-foreground">{t(`games.${game.id}`)}</p>
          <AccentField
            accent={gameAccents[game.id] || undefined}
            busy={busy}
            onChange={(hex) => save({ ...gameAccents, [game.id]: hex ?? '' })}
          />
        </div>
      ))}
    </SettingsGroup>
  );
}

function LanguageGroup() {
  const t = useT();
  const { lang, setLang, supported, labels } = useI18n();
  return (
    <SettingsGroup title={t('settings.language')} hint={t('settings.languageDesc')} data-settings-group="language">
      <div className="grid grid-cols-2 gap-2">
        {supported.map((code) => {
          const active = lang === code;
          return (
            <Button
              key={code}
              variant={active ? 'default' : 'glass'}
              size="sm"
              aria-pressed={active}
              onClick={() => setLang(code)}
              className={cn('justify-between px-3', !active && 'text-muted-foreground')}
            >
              <span className="flex items-center gap-2">
                <span className="font-medium">{labels[code] || code}</span>
                <span className="text-label uppercase tracking-wider text-muted-foreground/80">{code}</span>
              </span>
              {active && <Check className="h-3.5 w-3.5" />}
            </Button>
          );
        })}
      </div>
    </SettingsGroup>
  );
}

function HotkeysGroup() {
  const t = useT();
  return (
    <SettingsGroup title={t('settings.hotkeys')} data-settings-group="hotkeys">
      <ul className="divide-y divide-border/60 rounded-md border border-border/60">
        {HOTKEYS.map((h) => (
          <li key={h.labelKey} className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{t(h.labelKey)}</div>
              <div className="text-label text-muted-foreground">{t(h.hintKey)}</div>
            </div>
            <ComboRow combo={h.combo} altCombo={h.altCombo} />
          </li>
        ))}
      </ul>
    </SettingsGroup>
  );
}

/**
 * Hostkind settings → Preferences: the signed-in user's profile, password and
 * language, and (admins) the panel-wide watchdog and game colours.
 */
export function Preferences() {
  const t = useT();
  const { user } = useAuth();
  // The guest account has no profile or password to edit (the API refuses).
  const isGuest = user?.id === 'guest';
  const isAdmin = user?.role === 'admin';
  const [termsOpen, setTermsOpen] = useState(false);

  return (
    <div>
      {!isGuest && <ProfileGroup />}
      {!isGuest && <PasswordGroup />}
      <LanguageGroup />
      {!isGuest && isAdmin && <WatchdogGroup />}
      {!isGuest && isAdmin && <GameColorsGroup />}
      <HotkeysGroup />
      <SettingsGroup title={t('settings.legal')} hint={t('settings.legalDesc')} data-settings-group="legal">
        <div>
          <Button variant="glass" size="sm" onClick={() => setTermsOpen(true)}>
            <Scale className="h-3.5 w-3.5" /> {t('settings.viewTerms')}
          </Button>
        </div>
      </SettingsGroup>
      <TermsDialog open={termsOpen} onOpenChange={setTermsOpen} />
    </div>
  );
}
