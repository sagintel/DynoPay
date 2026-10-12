import { createContext, useContext } from 'react';

/**
 * The language context on its own (no app imports), so low-level components like <Text> and <Tap>
 * can read it without import cycles. The provider lives in ./index.tsx.
 */
export type Dict = Record<string, string>;
export type Vars = Record<string, string | number>;

export type I18nValue = {
  lang: string;
  rtl: boolean;
  /** Translates an app string; `{x}` placeholders are filled from `vars`. */
  t: (text: string, vars?: Vars) => string;
  /** Exact-match lookup used by <Text> (returns the input when it isn't an app string). */
  lookup: (text: string) => string;
  /** Changes the UI language (saved to the account when signed in). */
  setLanguage: (code: string) => Promise<void>;
  /** True while a new language is being prepared. */
  loading: boolean;
};

export function fill(text: string, vars?: Vars) {
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

let currentDict: Dict = {};
export const setCurrentDict = (d: Dict) => {
  currentDict = d;
};

/** Translate outside components (helpers that build labels). Components should prefer useI18n().t. */
export function tr(text: string, vars?: Vars): string {
  return fill(currentDict[text] ?? text, vars);
}

export const I18nContext = createContext<I18nValue>({
  lang: 'en',
  rtl: false,
  t: fill,
  lookup: (s) => s,
  setLanguage: async () => undefined,
  loading: false,
});

export const useI18n = () => useContext(I18nContext);
