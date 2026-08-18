import data from '../../i18n.json';

const { SUPPORTED_LANGS, DEFAULT_LANG, dictionaries } = data;
const SPANISH_COUNTRIES = new Set(data.SPANISH_COUNTRIES);

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

function t(lang, key, vars) {
  const l = normalizeLang(lang);
  let v = lookup(dictionaries[l], key);
  if (v === undefined && l !== DEFAULT_LANG) v = lookup(dictionaries[DEFAULT_LANG], key);
  if (v === undefined) v = key;
  return format(v, vars);
}

export { SUPPORTED_LANGS, DEFAULT_LANG, dictionaries, countryToLanguage, normalizeLang, lookup, format, t };

export const LANG_LABELS = {
  en: 'English',
  es: 'Español',
};
