import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, useFonts } from '@expo-google-fonts/inter';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router/react-navigation';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useMemo } from 'react';
import { ReducedMotionConfig, ReduceMotion } from 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ToastProvider, useToast } from '@/components/Toast';
import { I18nProvider } from '@/i18n';
import { SessionProvider, useSession } from '@/lib/session';
import { ThemeProvider as AppThemeProvider, useTheme } from '@/theme/context';
import { appearance, colors, lookSignature, type Look } from '@/theme/tokens';

void SplashScreen.preventAutoHideAsync();
void SystemUI.setBackgroundColorAsync(colors.bg);
// Completes the PayPal auth popup when the app runs on the web.
WebBrowser.maybeCompleteAuthSession();

const navTheme = () => {
  const base = appearance.mode === 'light' ? DefaultTheme : DarkTheme;
  return { ...base, colors: { ...base.colors, background: colors.bg, card: colors.bg, text: colors.text, primary: colors.accent, border: colors.hairline } };
};

function RootStack() {
  const { ready, user } = useSession();
  const { themeKey, reapplyLook } = useTheme();
  const toast = useToast();
  const design = user?.settings?.design;
  const look = useMemo<Look | null>(
    () => (design ? { accent: design.accent, density: design.density, motion: design.motion, theme: design.theme ?? null } : null),
    [design],
  );

  // The signed-in user's look (saved on the server) wins.
  // Accent changes apply live; density/motion/theme changes show a restart prompt.
  useEffect(() => {
    if (!look) return;
    const { needsRestart } = reapplyLook(look);
    if (needsRestart) {
      toast('Restart the app to apply this change', 'info');
    }
  }, [look, reapplyLook, toast]);

  const [fontsLoaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold });

  useEffect(() => {
    if (ready && fontsLoaded) void SplashScreen.hideAsync();
  }, [ready, fontsLoaded]);

  if (!ready || !fontsLoaded) return null;

  return (
    <ThemeProvider value={navTheme()}>
    <ReducedMotionConfig mode={appearance.motion === 'reduced' ? ReduceMotion.Always : ReduceMotion.System} />
    <Stack key={themeKey} screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'fade' }}>
      <Stack.Protected guard={!!user}>
        <Stack.Screen name="(tabs)" />
      </Stack.Protected>
      <Stack.Protected guard={!user}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Screen name="merchant" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="auth" />
      <Stack.Screen name="topup" />
    </Stack>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppThemeProvider>
        <SessionProvider>
          <I18nProvider>
            <ToastProvider>
              {/* Light content on dark themes, dark content on light ones. Edge-to-edge: the app's own background shows behind it. */}
              <StatusBar style={appearance.mode === 'light' ? 'dark' : 'light'} />
              <RootStack />
            </ToastProvider>
          </I18nProvider>
        </SessionProvider>
      </AppThemeProvider>
    </SafeAreaProvider>
  );
}
