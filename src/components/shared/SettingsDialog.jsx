import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { PasswordStrength } from '@/components/shared/PasswordStrength';
import { Check, Globe, Keyboard, Languages, Palette, UserCog, KeyRound, Compass, ShieldAlert } from 'lucide-react';
import { useI18n, useT } from '@/context/I18nContext';
import { useAuth } from '@/context/AuthContext';
import { useApi } from '@/hooks/useApi';
import { AccentField } from '@/components/shared/AccentField';
import { ApplicationUpdateSection } from '@/components/shared/ApplicationUpdate';
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

function ComboRow({ combo, altCombo }) {
  return (
    <span className="flex items-center gap-1">
      {combo.map((k, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span className="text-muted-foreground/60 text-label">+</span>}
          <Kbd>{k}</Kbd>
        </span>
      ))}
      {altCombo && (
        <>
          <span className="text-muted-foreground/60 text-label mx-1">/</span>
          {altCombo.map((k, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted-foreground/60 text-label">+</span>}
              <Kbd>{k}</Kbd>
            </span>
          ))}
        </>
      )}
    </span>
  );
}

function SectionHeading({ icon: Icon, children }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{children}</h3>
    </div>
  );
}

function ProfileSection() {
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
    <section>
      <SectionHeading icon={UserCog}>{t('profile.title')}</SectionHeading>
      <p className="mb-3 text-xs text-muted-foreground">{t('profile.desc')}</p>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label>{t('users.fieldName')}</Label>
          <Input value={form.name} onChange={f('name')} placeholder={t('users.namePlaceholder')} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label>{t('users.fieldUsername')}</Label>
            <Input value={form.username} onChange={f('username')} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label>{t('users.fieldEmail')}</Label>
            <Input type="email" value={form.email} onChange={f('email')} autoComplete="off" />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-label text-muted-foreground">
            {t('profile.role')}: <span className="font-medium text-foreground">{user?.role === 'admin' ? t('users.roleAdmin') : t('users.roleOperator')}</span>
          </span>
          <Button size="sm" onClick={save} disabled={saving}>{t('common.save')}</Button>
        </div>
      </div>
    </section>
  );
}

function PasswordSection() {
  const t = useT();
  const api = useApi();
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
      await api('/api/me/password', {
        method: 'PUT',
        body: { currentPassword: form.currentPassword, newPassword: form.newPassword },
      });
      toast.success(t('profile.passwordChanged'));
      setForm({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  }

  return (
    <section>
      <SectionHeading icon={KeyRound}>{t('profile.changePassword')}</SectionHeading>
      <p className="mb-3 text-xs text-muted-foreground">{t('profile.changePasswordDesc')}</p>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label>{t('profile.currentPassword')}</Label>
          <Input type="password" value={form.currentPassword} onChange={f('currentPassword')} autoComplete="current-password" />
        </div>
        <div className="space-y-1.5">
          <Label>{t('profile.newPassword')}</Label>
          <Input type="password" value={form.newPassword} onChange={f('newPassword')} autoComplete="new-password" placeholder={t('users.passwordPlaceholder')} />
          <PasswordStrength password={form.newPassword} />
        </div>
        <div className="space-y-1.5">
          <Label>{t('profile.confirmPassword')}</Label>
          <Input type="password" value={form.confirmPassword} onChange={f('confirmPassword')} autoComplete="new-password" />
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={save} disabled={saving || !form.currentPassword || !form.newPassword}>
            {t('profile.updatePassword')}
          </Button>
        </div>
      </div>
    </section>
  );
}

// The crash-loop guard, panel-wide. It is a supervision setting, so only a
// real admin (never the synthetic guest session) sees it; the endpoint
// enforces the admin rule again server-side.
function WatchdogSection() {
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
    <section>
      <SectionHeading icon={ShieldAlert}>{t('settings.watchdog')}</SectionHeading>
      <p className="mb-3 text-xs text-muted-foreground">{t('settings.watchdogDesc')}</p>
      <div className="space-y-3">
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
            <Label>{t('settings.watchdogMaxRestarts')}</Label>
            <Input type="number" min={0} step={1} value={form.maxRestarts} onChange={(e) => setForm((p) => ({ ...p, maxRestarts: Math.max(0, Math.floor(Number(e.target.value) || 0)) }))} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('settings.watchdogWindow')}</Label>
            <Input type="number" min={1} step={1} value={form.windowMinutes} onChange={(e) => setForm((p) => ({ ...p, windowMinutes: Math.max(1, Math.floor(Number(e.target.value) || 1)) }))} />
          </div>
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={save} disabled={loading || saving}>
            {saving ? t('common.loading') : t('common.save')}
          </Button>
        </div>
      </div>
    </section>
  );
}

function GameColorsSection() {
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
    <section>
      <SectionHeading icon={Palette}>{t('settings.gameColors')}</SectionHeading>
      <p className="mb-3 text-xs text-muted-foreground">{t('settings.gameColorsDesc')}</p>
      <div className="space-y-4">
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
      </div>
    </section>
  );
}

export function SettingsDialog({ open, onOpenChange, onStartTour }) {
  const t = useT();
  const { lang, setLang, supported, labels } = useI18n();
  const { user } = useAuth();
  // The guest account has no profile or password to edit (the API refuses).
  const isGuest = user?.id === 'guest';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md overflow-hidden p-0">
        {/* Stone-tile background, slightly darker than the panel surface. The
            tile photo is cold grey, so it is warmed back onto the ember bed
            with a multiply pass rather than being left to read as the one blue
            surface in the app. */}
        <div
          className="pointer-events-none absolute inset-0 opacity-20 [background-blend-mode:multiply]"
          style={{
            backgroundImage: 'url(/resources/stone_tile.jpg)',
            backgroundRepeat: 'repeat',
            backgroundSize: '120px',
            backgroundColor: 'oklch(var(--ember-2))',
          }}
        />
        <div className="pointer-events-none absolute inset-0 bg-card/85" />

        <div className="relative">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 text-primary">
                <Globe className="h-4 w-4" />
              </span>
              {t('settings.title')}
            </DialogTitle>
          </DialogHeader>

          <DialogBody className="space-y-5 pt-2 max-h-[70vh] overflow-y-auto">
            {!isGuest && <ProfileSection />}
            {!isGuest && <PasswordSection />}
            {!isGuest && user?.role === 'admin' && <WatchdogSection />}
            {!isGuest && user?.role === 'admin' && <GameColorsSection />}
            {!isGuest && user?.role === 'admin' && <ApplicationUpdateSection />}

            {/* Language */}
            <section>
              <SectionHeading icon={Languages}>{t('settings.language')}</SectionHeading>
              <p className="mb-3 text-xs text-muted-foreground">{t('settings.languageDesc')}</p>
              <div className="grid grid-cols-2 gap-2">
                {supported.map((code) => {
                  const active = lang === code;
                  return (
                    <Button
                      key={code}
                      variant={active ? 'default' : 'glass'}
                      size="sm"
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
            </section>

            {/* Hotkeys */}
            <section>
              <SectionHeading icon={Keyboard}>{t('settings.hotkeys')}</SectionHeading>
              <ul className="divide-y divide-border/60 rounded-md border border-border/60 bg-background/40">
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
            </section>

            {/* Onboarding tour */}
            <section>
              <SectionHeading icon={Compass}>{t('settings.tour')}</SectionHeading>
              <p className="mb-3 text-xs text-muted-foreground">{t('settings.tourDesc')}</p>
              <Button variant="glass" size="sm" onClick={onStartTour}>
                <Compass className="h-3.5 w-3.5" /> {t('settings.tourRepeat')}
              </Button>
            </section>
          </DialogBody>
        </div>
      </DialogContent>
    </Dialog>
  );
}
