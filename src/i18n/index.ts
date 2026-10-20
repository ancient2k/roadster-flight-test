// UI localisation: t(key, vars) with {name} interpolation, CLDR plurals and locale-aware numbers.
// English (locales/en.ts) is the source and the fallback. DOM-free apart from optional reads of
// location/navigator/document, so the sim and the unit tests can import it under Node.
import { en, type Messages, type MsgKey, type Msg, type PluralMsg } from './locales/en';
import { de } from './locales/de';
import { fr } from './locales/fr';
import { es } from './locales/es';
import { it } from './locales/it';
import { ptBR } from './locales/pt-BR';
import { nl } from './locales/nl';
import { pl } from './locales/pl';
import { ru } from './locales/ru';
import { uk } from './locales/uk';
import { tr } from './locales/tr';
import { ja } from './locales/ja';
import { ko } from './locales/ko';
import { zhHans } from './locales/zh-Hans';

export type { MsgKey, Msg, PluralMsg, Messages };

export const LOCALE_CODES = ['en', 'de', 'fr', 'es', 'it', 'pt-BR', 'nl', 'pl', 'ru', 'uk', 'tr', 'ja', 'ko', 'zh-Hans'] as const;
export type LocaleCode = (typeof LOCALE_CODES)[number];
export type LanguageSetting = 'auto' | LocaleCode;

/** Native language names for the language picker (never translated). */
export const LOCALE_NAMES: Record<LocaleCode, string> = {
  en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', it: 'Italiano', 'pt-BR': 'Português (Brasil)',
  nl: 'Nederlands', pl: 'Polski', ru: 'Русский', uk: 'Українська', tr: 'Türkçe', ja: '日本語', ko: '한국어', 'zh-Hans': '简体中文',
};

export const MESSAGES: Record<LocaleCode, Messages> = {
  en, de, fr, es, it, 'pt-BR': ptBR, nl, pl, ru, uk, tr, ja, ko, 'zh-Hans': zhHans,
};

/**
 * Best match of a browser preference list (navigator.languages) against the shipped locales:
 * exact tag, then the base language (pt-PT -> pt-BR, zh-TW/zh-Hant -> zh-Hans, en-GB -> en). Fallback en.
 */
export function matchLocale(prefs: readonly string[] | null | undefined): LocaleCode {
  for (const raw of prefs ?? []) {
    if (!raw) continue;
    const tag = raw.trim().replace(/_/g, '-').toLowerCase();
    const exact = LOCALE_CODES.find((c) => c.toLowerCase() === tag);
    if (exact) return exact;
    const base = tag.split('-')[0];
    const byBase = LOCALE_CODES.find((c) => c.split('-')[0].toLowerCase() === base);
    if (byBase) return byBase;
  }
  return 'en';
}

export const isLocale = (v: unknown): v is LocaleCode => typeof v === 'string' && (LOCALE_CODES as readonly string[]).includes(v);

/** ?lang=xx from the page URL (tests, links); accepts any tag matchLocale understands. */
export function urlLocale(): LocaleCode | null {
  try {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('lang') : null;
    return q ? matchLocale([q]) : null;
  } catch { return null; }
}

/** Browser preferences; only in a real document (Node exposes navigator.language too, tests must not depend on it). */
function browserPrefs(): readonly string[] {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
}

/** Priority: ?lang= > explicit setting > navigator.languages > en. */
export function resolveLocale(setting: LanguageSetting = 'auto'): LocaleCode {
  return urlLocale() ?? (setting !== 'auto' && isLocale(setting) ? setting : matchLocale(browserPrefs()));
}

let current: LocaleCode = 'en';
const listeners = new Set<(l: LocaleCode) => void>();

export const getLocale = (): LocaleCode => current;

export function setLocale(code: LocaleCode): void {
  const changed = code !== current;
  current = code;
  try { if (typeof document !== 'undefined') document.documentElement.lang = code; } catch { /* no DOM */ }
  if (changed) for (const l of listeners) l(code);
}

/** Apply the persisted language setting (?lang= still wins). */
export const applyLanguageSetting = (setting: LanguageSetting): void => setLocale(resolveLocale(setting));

setLocale(resolveLocale()); // first guess before the settings are read (?lang= / browser)

export function onLocaleChange(fn: (l: LocaleCode) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

type Vars = Record<string, string | number>;

const plurals = new Map<LocaleCode, Intl.PluralRules>();
function pluralCategory(n: number, loc: LocaleCode): Intl.LDMLPluralRule {
  let pr = plurals.get(loc);
  if (!pr) plurals.set(loc, (pr = new Intl.PluralRules(loc)));
  return pr.select(n);
}

function lookup(key: MsgKey, loc: LocaleCode): Msg {
  return MESSAGES[loc]?.[key] ?? en[key] ?? key;
}

function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Translated string for `key` in the current locale ({name} placeholders filled from vars). */
export function t(key: MsgKey, vars?: Vars, loc: LocaleCode = current): string {
  const m = lookup(key, loc);
  return interpolate(typeof m === 'string' ? m : m.other, vars);
}

/** Plural form for `n` (CLDR category of the locale); {n} is the formatted number unless vars.n is given. */
export function tn(key: MsgKey, n: number, vars?: Vars, loc: LocaleCode = current): string {
  const m = lookup(key, loc);
  if (typeof m === 'string') return interpolate(m, { n, ...vars });
  const cat = pluralCategory(n, loc);
  return interpolate(m[cat] ?? m.other, { n, ...vars });
}

/** Optional lookup for dynamic ids (phase names, check names); null when the key does not exist. */
export function tMaybe(key: string, vars?: Vars, loc: LocaleCode = current): string | null {
  return key in en ? t(key as MsgKey, vars, loc) : null;
}

const numberFormats = new Map<string, Intl.NumberFormat>();
function nf(loc: LocaleCode, min: number, max: number, grouping: boolean): Intl.NumberFormat {
  const k = `${loc}|${min}|${max}|${grouping ? 1 : 0}`;
  let f = numberFormats.get(k);
  if (!f) numberFormats.set(k, (f = new Intl.NumberFormat(loc, { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: grouping })));
  return f;
}

/** Locale number with exactly `digits` decimals ("1,62" in de, "1.62" in en); '–' for NaN/∞. Formatters are cached. */
export function fmtNum(v: number, digits = 1, loc: LocaleCode = current): string {
  return Number.isFinite(v) ? nf(loc, digits, digits, true).format(v) : '–';
}

/** Locale number with up to `maxDigits` decimals (axis ticks). */
export function fmtNumMax(v: number, maxDigits = 2, loc: LocaleCode = current): string {
  return Number.isFinite(v) ? nf(loc, 0, maxDigits, true).format(v) : '–';
}

/** Locale-aware upper case (Turkish i -> İ). */
export const upper = (s: string, loc: LocaleCode = current): string => s.toLocaleUpperCase(loc);

/** Percentage of a 0..1 fraction in the locale's style ("42 %" in de/fr, "42%" in en); sign: '+5 %' / '−5 %'. */
export function fmtPct(fraction: number, opts: { digits?: number; sign?: boolean } = {}, loc: LocaleCode = current): string {
  if (!Number.isFinite(fraction)) return '–';
  const d = opts.digits ?? 0;
  const k = `pct|${loc}|${d}|${opts.sign ? 1 : 0}`;
  let f = numberFormats.get(k);
  if (!f) numberFormats.set(k, (f = new Intl.NumberFormat(loc, { style: 'percent', minimumFractionDigits: d, maximumFractionDigits: d, signDisplay: opts.sign ? 'exceptZero' : 'auto' })));
  return f.format(fraction).replace('-', '−');
}

/** Locale date (e.g. the livestream date 2026-10-15). */
export function fmtDate(isoDate: string, loc: LocaleCode = current): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Intl.DateTimeFormat(loc, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}
