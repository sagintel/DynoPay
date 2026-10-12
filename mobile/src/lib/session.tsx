import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setHapticsEnabled } from '@/components/Pressable';
import type { User } from '@/genui/types';
import { api, ApiError, session, type MerchantCredentials } from './api';
import { API_URL } from './config';
import { secureStorage } from './storage';

const USER_CACHE = 'dynopay.user';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type SessionValue = {
  ready: boolean;
  user: User | null;
  signInWithPayPal: () => Promise<void>;
  signInDemo: () => Promise<void>;
  /** Merchant sign-in with the business's own PayPal REST app credentials. */
  signInMerchant: (creds: MerchantCredentials) => Promise<void>;
  refreshUser: () => Promise<void>;
  signOut: () => Promise<void>;
  setUser: (u: User) => void;
};

const Ctx = createContext<SessionValue | null>(null);

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used inside <SessionProvider>');
  return v;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    session.onSignedOut(() => setUser(null));
    void (async () => {
      try {
        if (!(await session.load())) return;
        // Show the cached profile immediately; a flaky network must never sign the user out.
        const cached = await secureStorage.get(USER_CACHE);
        if (cached) setUser(JSON.parse(cached) as User);
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            setUser(await api.me());
            return;
          } catch (e) {
            if (e instanceof ApiError && e.status === 401) {
              await session.clear();
              setUser(null);
              return;
            }
            if (!cached && attempt === 3) throw e;
            await sleep(600 * 2 ** attempt);
          }
        }
      } catch {
        /* stay on sign-in; tokens are kept for the next launch */
      } finally {
        setReady(true);
      }
    })();
  }, []);

  /**
   * Log in with PayPal: the API runs the OAuth dance with PayPal and hands the app
   * a one-time code via deep link; tokens never travel through URLs.
   */
  const signInWithPayPal = useCallback(async () => {
    const redirect = Linking.createURL('auth');
    const url = `${API_URL}/v1/auth/paypal/start?redirect=${encodeURIComponent(redirect)}`;
    const result = await WebBrowser.openAuthSessionAsync(url, redirect);
    if (result.type !== 'success') return;
    const { queryParams } = Linking.parse(result.url);
    if (typeof queryParams?.error === 'string') throw new Error(queryParams.error);
    const code = queryParams?.code;
    if (typeof code !== 'string') throw new Error('PayPal sign-in did not complete');
    const res = await api.exchange(code);
    await session.save(res);
    setUser(res.user);
  }, []);

  useEffect(() => {
    setHapticsEnabled(user?.settings.haptics !== false);
    if (user) void secureStorage.set(USER_CACHE, JSON.stringify(user));
  }, [user]);

  const signInDemo = useCallback(async () => {
    const res = await api.devLogin();
    await session.save(res);
    setUser(res.user);
  }, []);

  const signInMerchant = useCallback(async (creds: MerchantCredentials) => {
    const res = await api.merchantSignIn(creds);
    await session.save(res);
    setUser({ ...res.user, merchant: res.merchant });
  }, []);

  const refreshUser = useCallback(async () => {
    setUser(await api.me());
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    await Promise.all([session.clear(), secureStorage.remove(USER_CACHE)]);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ ready, user, signInWithPayPal, signInDemo, signInMerchant, refreshUser, signOut, setUser }),
    [ready, user, signInWithPayPal, signInDemo, signInMerchant, refreshUser, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
