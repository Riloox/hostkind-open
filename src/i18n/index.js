// Served by the i18n-split plugin in vite.config.js: only the default
// language ships in the entry chunk, the others load on demand.
import {
  SUPPORTED_LANGS,
  DEFAULT_LANG,
  SPANISH_COUNTRIES as SPANISH_COUNTRY_LIST,
  defaultDictionary,
  loaders,
} from 'virtual:i18n';

const SPANISH_COUNTRIES = new Set(SPANISH_COUNTRY_LIST);

// Filled as languages load. t() reads it synchronously, so callers must await
// loadDictionary(lang) before translating into a non-default language
// (I18nProvider does); until then lookups fall back to the default language.
const dictionaries = { [DEFAULT_LANG]: defaultDictionary };
const pending = {};

function isDictionaryLoaded(lang) {
  return Object.hasOwn(dictionaries, lang);
}

function loadDictionary(lang) {
  if (isDictionaryLoaded(lang)) return Promise.resolve();
  if (!loaders[lang]) return Promise.reject(new Error(`[i18n] unknown language "${lang}"`));
  pending[lang] ??= loaders[lang]()
    .then((mod) => { dictionaries[lang] = mod.default; })
    .finally(() => { delete pending[lang]; });
  return pending[lang];
}

function countryToLanguage(countryCode) {
  if (!countryCode) return DEFAULT_LANG;
  return SPANISH_COUNTRIES.has(String(countryCode).toUpperCase()) ? 'es' : 'en';
}

function normalizeLang(lang) {
  if (!lang) return DEFAULT_LANG;
  const s = String(lang).toLowerCase().slice(0, 2);
  return SUPPORTED_LANGS.includes(s) ? s : DEFAULT_LANG;
}

function lookup(dict, key) {
  if (!key) return '';
  const parts = String(key).split('.');
  let cur = dict;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && p in cur) cur = cur[p];
    else return undefined;
  }
  return typeof cur === 'string' ? cur : undefined;
}

function format(template, vars) {
  if (!vars) return template;
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
}

// Missing keys fall back to the key itself (so the UI never renders blank),
// but they are warned about once per key so gaps surface in the console
// instead of hiding silently. Some callers intentionally probe candidate keys
// (HealthView rule/category labels), hence the once-per-key dedupe.
const warnedMissingKeys = new Set();

function warnMissing(lang, key) {
  const id = `${lang}:${key}`;
  if (warnedMissingKeys.has(id)) return;
  warnedMissingKeys.add(id);
  // eslint-disable-next-line no-console
  console.warn(`[i18n] missing key "${key}" for language "${lang}"`);
}

function t(lang, key, vars) {
  const l = normalizeLang(lang);
  let v = lookup(dictionaries[l], key);
  if (v === undefined && l !== DEFAULT_LANG) v = lookup(dictionaries[DEFAULT_LANG], key);
  if (v === undefined) {
    warnMissing(l, key);
    v = key;
  }
  return format(v, vars);
}

export {
  SUPPORTED_LANGS, DEFAULT_LANG, dictionaries, countryToLanguage, normalizeLang, lookup, format, t,
  isDictionaryLoaded, loadDictionary,
};

export const LANG_LABELS = {
  en: 'English',
  es: 'Español',
};
