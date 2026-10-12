import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DevSettings, I18nManager, Platform } from 'react-native';
import { api } from '@/lib/api';
import { setUiLocale } from '@/lib/format';
import { useSession } from '@/lib/session';
import { secureStorage } from '@/lib/storage';
import { BUILT_IN } from './locales';
import { RTL } from './languages';
import { UI_STRINGS } from './strings.gen';
import { fill, I18nContext, setCurrentDict, type Dict, type I18nValue, type Vars } from './context';

/**
 * The app speaks the user's language. English is the source: every UI string is its own key
 * (`t('Hold to send')`). French, Swahili and Spanish ship with the app; any other language is
 * translated once by the server (built-in packs → cache → AI) and cached here.
 * <Text> translates exact app strings automatically, so data (names, notes, amounts) is never touched.
 */
export { tr, useI18n } from './context';

const LOCAL_KEY = 'dynopay.lang';
const CACHE_KEY = (lang: string) => `dynopay.i18n.${lang}`;
const memory = new Map<string, Dict>();

/** Reads a cached dictionary (web keeps it across launches; native keeps it for the session — the server caches too). */
function cachedDict(lang: string): Dict | null {
  if (memory.has(lang)) return memory.get(lang)!;
  if (Platform.OS === 'web') {
    try {
      const raw = globalThis.localStorage?.getItem(CACHE_KEY(lang));
      if (raw) {
        const d = JSON.parse(raw) as Dict;
        memory.set(lang, d);
        return d;
      }
    } catch {
      /* no cache */
    }
  }
  return null;
}

function storeDict(lang: string, d: Dict) {
  memory.set(lang, d);
  if (Platform.OS === 'web') {
    try {
      globalThis.localStorage?.setItem(CACHE_KEY(lang), JSON.stringify(d));
    } catch {
      /* quota: memory only */
    }
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const { user, setUser, ready } = useSession();
  const [localLoaded, setLocalLoaded] = useState(false);
  const [localLang, setLocalLang] = useState('en');
  const [dict, setDict] = useState<Dict>({});
  const [loading, setLoading] = useState(false);
  // Profiles cached by an older app version have no language yet.
  const lang = user?.settings.language || localLang || 'en';
  const signedIn = !!user;

  // The language chosen before signing in (or the last account's) is remembered on this device.
  useEffect(() => {
    void secureStorage
      .get(LOCAL_KEY)
      .then((v) => v && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(v) && setLocalLang(v))
      .finally(() => setLocalLoaded(true));
  }, []);
  // A language picked on the sign-in screen (e.g. reset to English) applies to the account that signs in.
  const chosenSignedOut = useRef(false);
  useEffect(() => {
    if (!user) return;
    if (chosenSignedOut.current) {
      chosenSignedOut.current = false;
      if (user.settings.language !== localLang) {
        setUser({ ...user, settings: { ...user.settings, language: localLang } });
        void api.updateMe({ settings: { language: localLang } }).then(setUser).catch(() => undefined);
        return;
      }
    }
    if (!user.settings.language) return;
    setLocalLang(user.settings.language);
    void secureStorage.set(LOCAL_KEY, user.settings.language);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, user?.settings.language]);

  // Load the dictionary: shipped → cached → server (only app strings are ever sent).
  const requested = useRef<string | null>(null);
  useEffect(() => {
    if (lang === 'en') {
      setDict({});
      return;
    }
    const base = BUILT_IN[lang] ?? {};
    const cached = cachedDict(lang);
    setDict({ ...base, ...(cached ?? {}) });
    const missing = UI_STRINGS.filter((s) => !(s in base) && !(cached && s in cached));
    if (!missing.length || !signedIn || requested.current === lang) return;
    requested.current = lang;
    setLoading(true);
    void (async () => {
      const out: Dict = { ...(cached ?? {}) };
      try {
        for (let i = 0; i < missing.length; i += 200) {
          const { translations } = await api.translate(lang, missing.slice(i, i + 200));
          for (const [k, v] of Object.entries(translations)) if (v && v !== k) out[k] = v;
        }
        storeDict(lang, out);
        setDict({ ...base, ...out });
      } catch {
        requested.current = null; // retry on the next change
      } finally {
        setLoading(false);
      }
    })();
  }, [lang, signedIn]);

  // Helpers and date formatting read these synchronously during this render.
  setCurrentDict(dict);
  setUiLocale(lang);
  const lookup = useCallback((text: string) => dict[text] ?? text, [dict]);
  const t = useCallback((text: string, vars?: Vars) => fill(dict[text] ?? text, vars), [dict]);

  const setLanguage = useCallback(
    async (code: string) => {
      const next = code.trim().toLowerCase() || 'en';
      setLocalLang(next);
      if (!user) chosenSignedOut.current = true;
      await secureStorage.set(LOCAL_KEY, next);
      if (user && user.settings.language !== next) {
        // Optimistic: the whole UI switches at once; the server keeps it for the next sessions.
        setUser({ ...user, settings: { ...user.settings, language: next } });
        try {
          setUser(await api.updateMe({ settings: { language: next } }));
        } catch {
          /* stays switched locally; saved next time */
        }
      }
    },
    [user, setUser],
  );

  // Right-to-left languages mirror the whole layout, not just the text.
  const rtl = RTL.has(lang.split('-')[0]!);
  useEffect(() => {
    if (Platform.OS === 'web') {
      if (typeof document !== 'undefined') {
        document.documentElement.dir = rtl ? 'rtl' : 'ltr';
        document.documentElement.lang = lang;
      }
      return;
    }
    // Only once the real language is known (otherwise startup would flip to LTR and back).
    if (!ready || !localLoaded) return;
    I18nManager.allowRTL(true);
    if (I18nManager.isRTL !== rtl) {
      I18nManager.forceRTL(rtl);
      I18nManager.swapLeftAndRightInRTL(true);
      DevSettings.reload(rtl ? 'Right-to-left language' : 'Left-to-right language');
    }
  }, [rtl, lang, ready, localLoaded]);

  const value = useMemo<I18nValue>(() => ({ lang, rtl, t, lookup, setLanguage, loading }), [lang, rtl, t, lookup, setLanguage, loading]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
