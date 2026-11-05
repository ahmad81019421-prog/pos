/**
 * Internationalization (i18n) for the Local POS renderer.
 *
 * PRD section 8: All UI text must be externalized; Arabic uses RTL layout.
 *
 * Usage:
 *   const { t, dir, lang } = useI18n();
 *   <h1>{t('pos.title')}</h1>
 *
 * Language switching: store.currentLang = 'ar' flips document.dir to 'rtl'.
 */

import { useSyncExternalStore } from 'react';
import type { Language } from '@shared/types/index';

import { en } from './en';
import { ar } from './ar';

type Dict = typeof en;

const dictionaries: Record<Language, Dict> = {
  en,
  ar: ar as Dict,
};

let currentLang: Language = 'en';
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): Language {
  return currentLang;
}

export function setLanguage(lang: Language): void {
  if (lang === currentLang) return;
  currentLang = lang;
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.documentElement.lang = lang;
  document.documentElement.dir = dir;
  document.body.classList.toggle('rtl', lang === 'ar');
  listeners.forEach((l) => l());
}

export function getLanguage(): Language {
  return currentLang;
}

export function getDir(): 'rtl' | 'ltr' {
  return currentLang === 'ar' ? 'rtl' : 'ltr';
}

export function translate(key: string, vars?: Record<string, string | number>): string {
  const dict = dictionaries[currentLang] as Record<string, string>;
  let value: string = dict[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return value;
}

export function useI18n() {
  const lang = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    t: (key: string, vars?: Record<string, string | number>) => translate(key, vars),
    lang,
    dir: lang === 'ar' ? 'rtl' : 'ltr',
    isRtl: lang === 'ar',
  };
}
