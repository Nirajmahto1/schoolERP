// ──────────────────────────────────────────────
// i18n scaffolding (Phase 8.9)
//
// Deliberately boring — no i18next dependency, because the plan's actual
// requirement is "externalise strings from day one; retrofitting is
// miserable". This module is:
//
//   • one flat dictionary per locale (dot-keys, flat = greppable)
//   • a `useT()` hook returning `t('key')` with English fallback
//   • React context so a language switch re-renders every consumer
//   • `document.documentElement.lang` kept in sync (screen readers + SEO)
//
// Missing keys fall back to English, then to the key itself — so a Hindi
// translation that lags behind never blanks the UI.
// ──────────────────────────────────────────────
'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en } from './locales/en';
import { hi } from './locales/hi';

export type Locale = 'en' | 'hi';

// English is the source of truth; every other locale is Partial<typeof en>.
const dictionaries: Record<Locale, Record<string, string>> = {
  en,
  hi: { ...en, ...hi } as Record<string, string>,
};

export const LOCALES: Array<{ code: Locale; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी' },
];

const STORAGE_KEY = 'erp-locale';

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  /** Translate a dot-key. Falls back: locale → English → key. */
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const dict = dictionaries[locale] ?? dictionaries.en;
  let out = dict[key] ?? dictionaries.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{{${k}}}`, String(v));
  }
  return out;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');

  // Hydrate from localStorage after mount (SSR-safe: first render is 'en').
  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === 'hi' || saved === 'en') setLocaleState(saved);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === 'hi' ? 'hi' : 'en';
  }, [locale]);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    window.localStorage.setItem(STORAGE_KEY, l);
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  // Provider-less fallback (scripts outside the tree): English, never crash.
  if (!ctx) {
    return { locale: 'en', setLocale: () => {}, t: (k, v) => translate('en', k, v) };
  }
  return ctx;
}

/** Convenience hook for pages that only need `t`. */
export function useT() {
  return useI18n().t;
}
