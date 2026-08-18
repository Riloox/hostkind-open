import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { DEFAULT_LANG, LANG_LABELS, SUPPORTED_LANGS, t as tRaw } from '@/i18n';

const I18nContext = createContext(null);

const STORAGE_KEY = 'fleetdeck_lang';

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && SUPPORTED_LANGS.includes(v)) return v;
  } catch {}
  return null;
}

function writeStored(lang) {
  try {
    if (lang) localStorage.setItem(STORAGE_KEY, lang);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export function I18nProvider({ initialLang, serverDefaultLang, children }) {
  const [lang, setLangState] = useState(() => {
    if (initialLang && SUPPORTED_LANGS.includes(initialLang)) return initialLang;
    return readStored() || DEFAULT_LANG;
  });

  // Whenever the language coming from the server changes (e.g. right after
  // login we learn the user's chosen/detected language), adopt it - unless
  // the user has explicitly picked one in this browser before, in which case
  // the stored preference wins.
  useEffect(() => {
    if (initialLang && SUPPORTED_LANGS.includes(initialLang) && initialLang !== lang) {
      if (!readStored()) setLangState(initialLang);
    }
    // Intentionally only react to initialLang changes (login flow).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLang]);

  // Pre-login default from the panel's DEFAULT_LANGUAGE env var, learned
  // asynchronously from /api/auth-mode. Applies only before the user has
  // ever picked a language in this browser (readStored()) - once they do,
  // that choice always wins over the server-configured default.
  useEffect(() => {
    if (serverDefaultLang && SUPPORTED_LANGS.includes(serverDefaultLang) && !readStored()) {
      setLangState(serverDefaultLang);
    }
  }, [serverDefaultLang]);

  // Keep <html lang> in sync with the active language.
  useEffect(() => {
    try { document.documentElement.lang = lang; } catch {}
  }, [lang]);

  const setLang = useCallback((next) => {
    if (!SUPPORTED_LANGS.includes(next)) return;
    setLangState(next);
    writeStored(next);
  }, []);

  const t = useCallback((key, vars) => tRaw(lang, key, vars), [lang]);

  const value = useMemo(() => ({
    lang,
    setLang,
    supported: SUPPORTED_LANGS,
    labels: LANG_LABELS,
    t,
  }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}

// Convenience: most components only need the translator.
export function useT() {
  return useI18n().t;
}
