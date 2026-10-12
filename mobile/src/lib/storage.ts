import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/** Tokens live in the Keychain/Keystore on device; web falls back to localStorage. */
export const secureStorage = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    }
    return SecureStore.getItemAsync(key);
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        /* storage unavailable (private mode) */
      }
      return;
    }
    await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  },
  async remove(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        /* ignore */
      }
      return;
    }
    await SecureStore.deleteItemAsync(key);
  },
};
