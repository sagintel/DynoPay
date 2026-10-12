import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { applyAppearance, type Look } from './tokens';

/**
 * Runs before any screen module is loaded (see index.js): style sheets read the colour tokens when
 * their modules load, so the saved look (accent, density, motion, custom theme) must be applied
 * first. A change of look saves it and reloads the app (see app/_layout.tsx).
 */
export const LOOK_KEY = 'dynopay.look';

export function readSavedLook(): Look | null {
  try {
    const raw = Platform.OS === 'web' ? globalThis.localStorage?.getItem(LOOK_KEY) : SecureStore.getItem(LOOK_KEY);
    return raw ? (JSON.parse(raw) as Look) : null;
  } catch {
    return null;
  }
}

export function saveLook(look: Look | null) {
  try {
    const raw = look ? JSON.stringify(look) : null;
    if (Platform.OS === 'web') {
      if (raw) globalThis.localStorage?.setItem(LOOK_KEY, raw);
      else globalThis.localStorage?.removeItem(LOOK_KEY);
    } else if (raw) SecureStore.setItem(LOOK_KEY, raw);
    else void SecureStore.deleteItemAsync(LOOK_KEY);
  } catch {
    /* storage unavailable: the default look is used next launch */
  }
}

const saved = readSavedLook();
if (saved) applyAppearance(saved);
