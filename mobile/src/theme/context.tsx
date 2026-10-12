import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import { saveLook } from './boot';
import { applyAppearance, appearance, lookSignature, type Look } from './tokens';

type ThemeCtxValue = {
  /**
   * A version counter that bumps every time the accent (or any other live-switchable token) changes.
   * Consumers that need to re-render on theme changes should read this value.
   */
  themeKey: number;
  /**
   * Apply a new look. For accent changes the tree re-renders immediately with no reload.
   * For density / motion / full custom theme changes (which affect StyleSheet layout values),
   * the look is persisted and the caller receives `needsRestart: true` so it can inform the user.
   * Returns `{ changed: false }` when the look is identical to the one already applied (no-op).
   */
  reapplyLook: (look: Look) => { needsRestart: boolean; changed: boolean };
};

const ThemeCtx = createContext<ThemeCtxValue>({
  themeKey: 0,
  reapplyLook: () => ({ needsRestart: false, changed: false }),
});

export const useTheme = () => useContext(ThemeCtx);

/** Wraps the app so any component can trigger a live accent re-render. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeKey, setThemeKey] = useState(0);

  // Track the signature of the last look we actually applied so we can skip no-op calls.
  const appliedSignatureRef = useRef(
    lookSignature({
      accent: appearance.accent,
      density: appearance.density,
      motion: appearance.motion,
      theme: null,
    }),
  );

  const reapplyLook = useCallback((next: Look): { needsRestart: boolean; changed: boolean } => {
    const nextSignature = lookSignature(next);

    // Nothing changed — skip entirely to avoid triggering a re-render loop.
    if (nextSignature === appliedSignatureRef.current) {
      return { needsRestart: false, changed: false };
    }

    const prevSignature = appliedSignatureRef.current;

    // Determine which parts changed.
    // density|motion|theme are in positions 1, 2, 3 of the pipe-separated signature.
    const [, prevDensity, prevMotion, prevTheme] = prevSignature.split('|');
    const [, nextDensity, nextMotion, nextTheme] = nextSignature.split('|');
    const layoutChanged =
      nextDensity !== prevDensity ||
      nextMotion !== prevMotion ||
      nextTheme !== prevTheme;

    // Mutate the tokens object in-place.
    applyAppearance(next);
    saveLook(next);
    appliedSignatureRef.current = nextSignature;

    if (layoutChanged && Platform.OS !== 'web') {
      // Layout-affecting changes require a full app restart in production.
      // Surface the requirement to the caller so it can show a toast.
      return { needsRestart: true, changed: true };
    }

    // Bump the counter so React re-renders trees that subscribe to themeKey.
    setThemeKey((k) => k + 1);
    return { needsRestart: false, changed: true };
  }, []);

  return <ThemeCtx.Provider value={{ themeKey, reapplyLook }}>{children}</ThemeCtx.Provider>;
}
