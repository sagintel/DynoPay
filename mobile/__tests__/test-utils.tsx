import type { ReactNode } from 'react';
import { fill, I18nContext, setCurrentDict, type I18nValue } from '@/i18n/context';
import { RTL } from '@/i18n/languages';
import { BUILT_IN } from '@/i18n/locales';

/** Renders children in a given UI language with the shipped dictionaries (no network, no session). */
export function InLanguage({ lang = 'en', children }: { lang?: string; children: ReactNode }) {
  const dict = BUILT_IN[lang] ?? {};
  setCurrentDict(dict);
  const value: I18nValue = {
    lang,
    rtl: RTL.has(lang),
    t: (text, vars) => fill(dict[text] ?? text, vars),
    lookup: (text) => dict[text] ?? text,
    setLanguage: async () => undefined,
    loading: false,
  };
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
