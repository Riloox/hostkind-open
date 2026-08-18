import { useState, useRef, useEffect, useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Field } from '@/components/ui/field';
import { Loader2, User, Lock, ArrowRight, Eye, EyeOff, AlertCircle, ShieldAlert, Timer } from 'lucide-react';
import { useT } from '@/context/I18nContext';
import { useBranding, useAuth } from '@/context/AuthContext';
import { BrandIcon } from '@/components/shared/BrandMark';

// How long the desk takes to hand the session over to the app shell.
const HANDOFF_MS = 620;

const PANEL_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// What the browser can honestly tell us about this panel before anyone has
// signed in: where it is being served from, and whether the credentials the
// user is about to type will leave the machine in the clear. Nothing here is
// fetched - a pre-auth endpoint that reports node details would be a leak.
function readOrigin() {
  if (typeof window === 'undefined') return { host: '', link: 'loopback' };
  const { hostname, host, protocol } = window.location;
  if (LOOPBACK_HOSTS.has(hostname)) return { host, link: 'loopback' };
  if (protocol === 'https:') return { host, link: 'tls' };
  return { host, link: 'plain' };
}

// Best-effort public IP fetch. Used to make geolocation work even when the
// panel is running on localhost (where req.ip is always 127.0.0.1).
async function fetchPublicIp(timeoutMs = 3000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: ctrl.signal });
    if (!r.ok) return null;
    const d = await r.json();
    return typeof d.ip === 'string' ? d.ip : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function WaveText({ children }) {
  let characterIndex = 0;

  return (
    <>
      <span className="sr-only">{children}</span>
      <span aria-hidden="true">
        {children.split(' ').map((word, wordIndex) => (
          <span className="login-wave-word" key={`${word}-${wordIndex}`}>
            {Array.from(word).map((character) => {
              const index = characterIndex;
              characterIndex += 1;
              return (
                <span
                  key={`${character}-${index}`}
                  className="login-wave-character"
                  style={{ '--wave-index': index }}
                >
                  {character}
                </span>
              );
            })}
            {wordIndex < children.split(' ').length - 1 && <span className="login-wave-space">&nbsp;</span>}
          </span>
        ))}
      </span>
    </>
  );
}

// Label / value rows of machine text. Rendered twice (beside the identity on
// wide screens, under the form on narrow ones) so the facts stay visible
// without the desk pane having to survive a phone viewport.
function SpecPlate({ t, origin }) {
  const link = {
    loopback: { label: t('login.linkLoopback'), tone: 'text-status-online' },
    tls: { label: t('login.linkTls'), tone: 'text-status-online' },
    plain: { label: t('login.linkPlain'), tone: 'text-status-warn' },
  }[origin.link];

  return (
    <dl className="login-plate">
      <div>
        <dt>{t('login.metaNode')}</dt>
        <dd className="text-foreground">{origin.host || '—'}</dd>
      </div>
      {PANEL_VERSION && (
        <div>
          <dt>{t('login.metaBuild')}</dt>
          <dd className="text-foreground">v{PANEL_VERSION}</dd>
        </div>
      )}
      <div>
        <dt>{t('login.metaLink')}</dt>
        <dd className={`flex items-center gap-1.5 ${link.tone}`}>
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
          {link.label}
        </dd>
      </div>
    </dl>
  );
}

export function LoginView({ onLogin }) {
  const t = useT();
  const branding = useBranding();
  const { geoLanguageDetection } = useAuth() || {};
  const [identifier, setIdentifier] = useState('');
  const [pass, setPass] = useState('');
  const [reveal, setReveal] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const screenRef = useRef(null);
  const timerRef = useRef(null);

  const origin = useMemo(readOrigin, []);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const trackCaps = (e) => {
    if (typeof e.getModifierState === 'function') setCapsLock(e.getModifierState('CapsLock'));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setLoading(true);

    const id = identifier.trim();
    // Send as the right field based on whether it looks like an email,
    // so the server can give better feedback. Either works at lookup.
    const loginField = id.includes('@') ? { email: id } : { username: id };

    let data;
    try {
      const clientIp = geoLanguageDetection ? await fetchPublicIp() : null;
      const payload = { ...loginField, password: pass };
      if (clientIp) payload.clientIp = clientIp;
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      data = await r.json();
      if (!r.ok) {
        const err = new Error(data.error || t('errors.loginFailed'));
        // The server locks an account or an IP out for a while after repeated
        // failures. That is a wait, not a mistake - say so in a calmer tone.
        err.locked = r.status === 429;
        throw err;
      }
    } catch (err) {
      setError({ text: err.message, locked: !!err.locked });
      setLoading(false);
      return;
    }

    // Login OK - the desk lights bloom out and the screen dissolves into the
    // app shell, which fades itself in on mount.
    if (screenRef.current) screenRef.current.classList.add('login-leaving');
    timerRef.current = setTimeout(() => onLogin(data.token, data.user || null), HANDOFF_MS);
  };

  return (
    <div
      ref={screenRef}
      className="login-screen fixed inset-0 grid overflow-y-auto bg-background lg:grid-cols-[1fr_minmax(26rem,34rem)]"
    >
      {/* Left: the desk. Identity, and the few facts the browser can vouch for. */}
      <aside className="login-desk relative flex flex-col justify-between gap-10 overflow-hidden border-b-2 border-border px-6 py-8 sm:px-10 lg:border-b-0 lg:border-r-2 lg:px-12 lg:py-12">
        <div className="login-brand-lockup relative flex items-center gap-3">
          <BrandIcon logoUrl={branding.logoUrl} />
          <span className="text-label font-bold uppercase tracking-[0.18em] text-primary">
            {branding.name || t('brand.name')}
          </span>
          <span className="login-brand-line" aria-hidden="true" />
        </div>

        <div className="relative flex flex-[1_0_auto] flex-col justify-center py-2">
          <p
            className="login-tagline max-w-[24ch] font-display text-[clamp(2.35rem,4.5vw+0.4rem,5.25rem)] font-extrabold uppercase leading-[0.92] tracking-[-0.04em] text-foreground"
          >
            <WaveText>{t('login.tagline')}</WaveText>
          </p>
        </div>

        <div className="relative hidden max-w-[30rem] lg:block">
          <SpecPlate t={t} origin={origin} />
        </div>
      </aside>

      {/* Right: the one task. */}
      <main className="relative flex flex-col px-6 py-8 sm:px-10 lg:px-12 lg:py-12 xl:px-16">
        <form onSubmit={handleSubmit} className="login-form flex w-full max-w-[400px] flex-[1_0_auto] flex-col justify-center">
          <header className="mb-8">
            <h1 className="font-display text-2xl font-extrabold uppercase leading-[1.15] tracking-[0.01em] text-foreground">
              {t('login.heading')}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">{t('login.subheading')}</p>
          </header>

          <div className="flex flex-col gap-4">
            <Field label={t('login.identifierLabel')} required>
              <div className="relative">
                <User className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/55" />
                <Input
                  type="text"
                  placeholder={t('login.identifierPlaceholder')}
                  autoComplete="username"
                  autoFocus
                  value={identifier}
                  onChange={e => setIdentifier(e.target.value)}
                  required
                  className="pl-9"
                />
              </div>
            </Field>

            <Field label={t('login.passwordLabel')} required>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/55" />
                <Input
                  type={reveal ? 'text' : 'password'}
                  placeholder={t('login.passwordPlaceholder')}
                  autoComplete="current-password"
                  value={pass}
                  onChange={e => setPass(e.target.value)}
                  onKeyDown={trackCaps}
                  onKeyUp={trackCaps}
                  onBlur={() => setCapsLock(false)}
                  required
                  className="pl-9 pr-11"
                />
                <button
                  type="button"
                  onClick={() => setReveal(v => !v)}
                  aria-label={reveal ? t('login.hidePassword') : t('login.showPassword')}
                  aria-pressed={reveal}
                  className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </Field>

            {capsLock && (
              <p className="flex items-center gap-1.5 text-label text-status-warn">
                <AlertCircle className="h-3 w-3 flex-none" />
                {t('login.capsLock')}
              </p>
            )}

            {error && (
              <Alert variant={error.locked ? 'warn' : 'error'}>
                {error.locked
                  ? <Timer className="mt-px h-3.5 w-3.5 flex-none" />
                  : <AlertCircle className="mt-px h-3.5 w-3.5 flex-none" />}
                <span>{error.text}</span>
              </Alert>
            )}

            <Button
              type="submit"
              variant="default"
              size="default"
              className="mt-1 h-11 w-full font-bold"
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t('login.submitting')}
                </>
              ) : (
                <>
                  {t('login.submit')}
                  <ArrowRight className="h-3.5 w-3.5" />
                </>
              )}
            </Button>

            {origin.link === 'plain' && (
              <p className="flex items-start gap-2 border-t border-border pt-4 text-label leading-relaxed text-status-warn">
                <ShieldAlert className="mt-px h-3.5 w-3.5 flex-none" />
                <span>{t('login.linkPlainHint')}</span>
              </p>
            )}
          </div>

        </form>

        <footer className="w-full max-w-[400px] pt-10 lg:hidden">
          <div className="mb-6">
            <SpecPlate t={t} origin={origin} />
          </div>
        </footer>
      </main>
    </div>
  );
}
