import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { LanguageList } from '@/components/MoreSettings';
import { Tap } from '@/components/Pressable';
import { Text } from '@/components/Text';
import { useI18n } from '@/i18n/context';
import { languageName } from '@/i18n/languages';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { colors, fonts, GUTTER, radius, space } from '@/theme/tokens';

export default function SignIn() {
  const insets = useSafeAreaInsets();
  const { signInWithPayPal, signInDemo } = useSession();
  const [config, setConfig] = useState<{ paypal: boolean; devLogin: boolean; merchantSignIn: boolean } | null>(null);
  const [busy, setBusy] = useState<'paypal' | 'demo' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { lang, setLanguage } = useI18n();
  const [languages, setLanguages] = useState(false);

  useEffect(() => {
    api.authConfig().then(setConfig).catch(() => setError("Can't reach the DynoPay server."));
  }, []);

  const run = async (kind: 'paypal' | 'demo') => {
    setBusy(kind);
    setError(null);
    try {
      await (kind === 'paypal' ? signInWithPayPal() : signInDemo());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <RadialGradient id="glow" cx="50%" cy="42%" r="55%">
            <Stop offset="0" stopColor="#2A3A8C" stopOpacity="0.35" />
            <Stop offset="1" stopColor={colors.bg} stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#glow)" />
      </Svg>

      {/* Language: pick one, or reset to English (the default). It applies to the account that signs in. */}
      <View style={styles.langBar}>
        {lang !== 'en' ? (
          <Tap onPress={() => void setLanguage('en')} hitSlop={8} style={styles.langButton} accessibilityLabel="Reset to English">
            <Icon name="repeat" size={13} color={colors.textMuted} />
            <Text variant="label" color={colors.textMuted}>English</Text>
          </Tap>
        ) : null}
        <Tap onPress={() => setLanguages((v) => !v)} hitSlop={8} style={styles.langButton} accessibilityLabel="Language">
          <Icon name="sparkle" size={13} color={colors.accent} />
          <Text variant="label">{languageName(lang)}</Text>
        </Tap>
      </View>

      <Animated.View entering={FadeIn.duration(600)} style={styles.center}>
        <View style={styles.dot} />
        <Text style={styles.title}>Write what{'\n'}happens next.</Text>
        <Text variant="body" color={colors.textMuted} style={{ textAlign: 'center' }}>
          Banking without forms. Say it, review it, hold to confirm.
        </Text>
      </Animated.View>

      <Animated.View entering={FadeInDown.delay(250).duration(500)} style={{ gap: space.md, width: '100%', maxWidth: 420, alignSelf: 'center' }}>
        <Text variant="label" color={colors.textMuted} style={{ textAlign: 'center' }}>Business</Text>
        <Button label="Sign in as a merchant (REST API)" icon="shield" variant="secondary" disabled={!!busy} onPress={() => router.push('/merchant')} />
        {config?.devLogin ? <Button label="Explore the demo account" variant="ghost" loading={busy === 'demo'} disabled={!!busy} onPress={() => void run('demo')} /> : null}
        {/* PayPal personal sign-in is temporarily disabled */}
        {/* config?.paypal && <Button label="Continue with PayPal" icon="paypal" variant="ivory" loading={busy === 'paypal'} disabled={!config?.paypal || !!busy} onPress={() => void run('paypal')} /> */}
        {error ? <Text variant="caption" color={colors.negative} style={{ textAlign: 'center' }}>{error}</Text> : null}
        <Text variant="caption" color={colors.textFaint} style={{ textAlign: 'center', marginTop: 8 }}>
          Dyno<Text variant="caption" color={colors.accent}>.</Text> · <Text variant="caption" color={colors.textFaint}>Every payment needs your confirmation.</Text>
        </Text>
      </Animated.View>
      {/* Last in the tree (above the animated content). The backdrop comes first inside the overlay, so the
          panel always draws above it whatever z-index the platform gives animated views. */}
      {languages ? (
        <View style={styles.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setLanguages(false)} accessibilityLabel="Close" />
          <View style={styles.langPanel}>
            <LanguageList
              value={lang}
              onPick={(code) => {
                setLanguages(false);
                void setLanguage(code);
              }}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: GUTTER, justifyContent: 'space-between' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 18 },
  dot: { width: 10, height: 10, borderRadius: 5, get backgroundColor() { return colors.accent; } },
  langBar: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, zIndex: 2 },
  langButton: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 10 },
  langPanel: { position: 'absolute', top: 90, left: GUTTER, right: GUTTER, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgRaised, maxWidth: 520, alignSelf: 'center' },
  title: { fontFamily: fonts.medium, fontSize: 40, lineHeight: 46, letterSpacing: -1, color: colors.text, textAlign: 'center' },
});
