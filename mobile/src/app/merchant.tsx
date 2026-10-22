import React, { useEffect, useRef, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import {
  KeyboardAvoidingView,
  LayoutAnimation,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  UIManager,
  View,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { Tap } from '@/components/Pressable';
import { Text } from '@/components/Text';
import { useToast } from '@/components/Toast';
import { useI18n } from '@/i18n/context';
import { api, type MerchantCredentials } from '@/lib/api';
import { useSession } from '@/lib/session';
import { colors, fonts, GUTTER, radius, space } from '@/theme/tokens';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─── Inline accordion (self-contained, no external dep) ─────────────────────

function InfoAccordion({
  title,
  icon,
  children,
  defaultOpen = false,
}: {
  title: string;
  icon: Parameters<typeof Icon>[0]['name'];
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const angle = useSharedValue(defaultOpen ? 180 : 0);

  const toggle = () => {
    LayoutAnimation.configureNext({
      duration: 250,
      create: { type: 'easeInEaseOut', property: 'opacity' },
      update: { type: 'spring', springDamping: 0.78 },
      delete: { type: 'easeInEaseOut', property: 'opacity' },
    });
    setOpen((v) => {
      angle.value = withSpring(v ? 0 : 180, { damping: 18, stiffness: 160 });
      return !v;
    });
  };

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${angle.value}deg` }],
  }));

  return (
    <View style={[styles.accordion, open && styles.accordionOpen]}>
      <Tap onPress={toggle} style={styles.accordionHeader} scaleTo={0.99} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <View style={styles.accordionIconWrap}>
          <Icon name={icon} size={15} color={open ? colors.accent : colors.textMuted} />
        </View>
        <Text variant="bodyStrong" style={{ flex: 1 }} color={open ? colors.text : colors.textMuted}>
          {title}
        </Text>
        <Animated.View style={chevronStyle}>
          <Icon name="arrow-down" size={15} color={colors.textFaint} />
        </Animated.View>
      </Tap>
      {open ? (
        <Animated.View entering={FadeIn.duration(160)} style={styles.accordionBody}>
          {children}
        </Animated.View>
      ) : null}
    </View>
  );
}

// ─── Main screen ─────────────────────────────────────────────────────────────

export default function MerchantSignIn() {
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { mode } = useLocalSearchParams<{ mode?: 'connect' }>();
  const connecting = mode === 'connect';
  const { signInMerchant, refreshUser, user } = useSession();

  // Sandbox only — Live is hidden until the user is ready to go live.
  const environment: MerchantCredentials['environment'] = 'sandbox';

  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const secretRef = useRef<TextInput>(null);

  const [signingIn, setSigningIn] = useState(false);
  useEffect(() => {
    if (signingIn && user) router.replace('/(tabs)');
  }, [signingIn, user]);

  const valid = appId.trim().length >= 20 && appSecret.trim().length >= 20;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const creds: MerchantCredentials = {
      environment,
      clientId: appId.trim(),
      clientSecret: appSecret.trim(),
      businessName: businessName.trim() || undefined,
    };
    try {
      if (connecting) {
        await api.connectMerchant(creds);
        await refreshUser();
        toast('Merchant account connected', 'success');
        router.back();
      } else {
        setSigningIn(true);
        await signInMerchant(creds);
      }
    } catch (e) {
      setSigningIn(false);
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setAppSecret('');
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: colors.bg }}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingTop: insets.top + 12,
          paddingBottom: insets.bottom + 40,
          paddingHorizontal: GUTTER,
          gap: space.xl,
          maxWidth: 520,
          width: '100%',
          alignSelf: 'center',
        }}
      >
        {/* Back */}
        <Tap
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/sign-in'))}
          style={styles.back}
          accessibilityLabel="Back"
        >
          <Icon name="arrow-left" size={18} color={colors.text} />
        </Tap>

        {/* Header */}
        <Animated.View entering={FadeInDown.duration(320)} style={{ gap: 10 }}>
          <View style={styles.badge}>
            <Icon name="paypal" size={14} color={colors.accent} />
            <Text variant="label" color={colors.accent}>PayPal Business · Sandbox</Text>
          </View>
          <Text variant="title">
            {connecting ? 'Update API credentials' : 'Sign in as a merchant'}
          </Text>
          <Text variant="body" color={colors.textMuted}>
            {connecting
              ? 'Replace your existing REST app credentials. Your secret is stored encrypted and never returned.'
              : 'Paste your PayPal REST app credentials below. Everything is verified with PayPal before saving.'}
          </Text>
        </Animated.View>

        {/* ── Credential fields — always visible ───────────────────────── */}
        <Animated.View entering={FadeInDown.delay(80).duration(320)} style={{ gap: space.lg }}>
          <Field
            label="App ID"
            hint="Your PayPal REST app Client ID"
            value={appId}
            onChange={setAppId}
            placeholder="A…"
            returnKeyType="next"
            onSubmitEditing={() => secretRef.current?.focus()}
          />
          <Field
            ref={secretRef}
            label="App Secret"
            hint="The secret shown in your app's API Credentials panel"
            value={appSecret}
            onChange={setAppSecret}
            placeholder="••••••••••••••••••••••"
            secure
            returnKeyType="done"
            onSubmitEditing={() => { if (valid) void submit(); }}
          />
          {!connecting && (
            <Field
              label="Business name (optional)"
              hint="Shown in the app header — defaults to 'PayPal Merchant'"
              value={businessName}
              onChange={setBusinessName}
              placeholder="Acme Studio"
              returnKeyType="done"
              onSubmitEditing={() => { if (valid) void submit(); }}
            />
          )}
        </Animated.View>

        {/* Error */}
        {error ? (
          <Animated.View entering={FadeIn} style={styles.errorBox}>
            <Icon name="warning" size={16} color={colors.negative} />
            <Text variant="caption" color={colors.negative} style={{ flex: 1 }}>{error}</Text>
          </Animated.View>
        ) : null}

        {/* Submit */}
        <Button
          label={connecting ? 'Verify & update' : 'Verify & sign in'}
          icon="shield"
          variant="primary"
          loading={busy}
          disabled={!valid}
          onPress={() => void submit()}
        />

        {/* ── Collapsible help panels ───────────────────────────────────── */}
        <Animated.View entering={FadeInDown.delay(160).duration(320)} style={{ gap: space.md }}>

          {/* How to get credentials */}
          <InfoAccordion icon="info" title="How to get your App ID & Secret">
            <View style={styles.accordionContent}>
              {STEPS.map((s, i) => (
                <View key={i} style={styles.step}>
                  <View style={styles.stepNum}>
                    <Text variant="tiny" color={colors.accent} style={{ fontFamily: fonts.semibold }}>
                      {i + 1}
                    </Text>
                  </View>
                  <Text variant="caption" color={colors.textMuted} style={{ flex: 1 }}>{s}</Text>
                </View>
              ))}
              <Tap
                onPress={() =>
                  void WebBrowser.openBrowserAsync(
                    'https://developer.paypal.com/dashboard/applications/sandbox',
                  )
                }
                hitSlop={8}
                style={styles.link}
                accessibilityLabel="Open PayPal Developer Dashboard"
              >
                <Icon name="arrow-right" size={13} color={colors.accent} />
                <Text variant="label" color={colors.accent}>Open PayPal Developer Dashboard</Text>
              </Tap>
            </View>
          </InfoAccordion>

          {/* What connects to your account */}
          <InfoAccordion icon="paypal" title="What connects to your PayPal account">
            <View style={styles.accordionContent}>
              {FEATURES.map((f, i) => (
                <View key={i} style={styles.featureRow}>
                  <Icon name="check" size={13} color={colors.positive} />
                  <Text variant="caption" color={colors.textMuted} style={{ flex: 1 }}>{f}</Text>
                </View>
              ))}
              <View style={[styles.featureRow, { marginTop: 4, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline }]}>
                <Icon name="shield" size={13} color={colors.textFaint} />
                <Text variant="caption" color={colors.textFaint} style={{ flex: 1 }}>
                  Your secret is verified with PayPal and stored AES-256 encrypted. It is never logged or returned.
                </Text>
              </View>
            </View>
          </InfoAccordion>

        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ─── Field ───────────────────────────────────────────────────────────────────

const Field = React.forwardRef<
  TextInput,
  {
    label: string;
    hint?: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    secure?: boolean;
    returnKeyType?: 'next' | 'done';
    onSubmitEditing?: () => void;
  }
>(function Field({ label, hint, value, onChange, placeholder, secure, returnKeyType, onSubmitEditing }, ref) {
  const { t } = useI18n();
  return (
    <View style={{ gap: 5 }}>
      <Text variant="label" color={colors.textMuted}>{label}</Text>
      <TextInput
        ref={ref}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder ? t(placeholder) : undefined}
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        secureTextEntry={secure}
        textContentType={secure ? 'password' : 'none'}
        selectionColor={colors.accent}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        blurOnSubmit={returnKeyType === 'done'}
        style={styles.input}
      />
      {hint ? <Text variant="tiny" color={colors.textFaint}>{hint}</Text> : null}
    </View>
  );
});

// ─── Static content ───────────────────────────────────────────────────────────

const STEPS = [
  'Go to developer.paypal.com and sign in with your PayPal business account.',
  'Open Apps & Credentials → Sandbox → select your app (or create one).',
  'Enable the features you need: Transaction Search, Invoicing, Disputes, Payouts.',
  'Copy the Client ID — this is your App ID.',
  'Click Show under the Secret column — this is your App Secret.',
];

const FEATURES = [
  'Live PayPal balance — updated in real time',
  'Transaction Search — full payment history from PayPal',
  'Sales analytics — 30-day chart, fees and refunds',
  'Invoicing — create, send, remind and track payments',
  'Disputes — view and respond to buyer claims',
  'Payouts — send money to any email via PayPal',
  'Virtual cards — DynoPay wallet sub-balances',
];

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  back: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    get backgroundColor() { return colors.accentSoft; },
  },
  input: {
    height: 50,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    color: colors.text,
    fontFamily: fonts.regular,
    fontSize: 15,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    borderRadius: radius.md,
    backgroundColor: colors.negativeSoft,
    borderWidth: 1,
    borderColor: colors.negativeBorder,
  },
  // Accordion
  accordion: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  accordionOpen: {
    borderColor: colors.border,
  },
  accordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  accordionIconWrap: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
    get backgroundColor() { return colors.surfaceHigh; },
    alignItems: 'center',
    justifyContent: 'center',
  },
  accordionBody: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  accordionContent: {
    padding: 14,
    gap: 10,
  },
  // Steps
  step: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  stepNum: {
    width: 20,
    height: 20,
    borderRadius: 10,
    get backgroundColor() { return colors.accentSoft; },
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
    flexShrink: 0,
  },
  link: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  // Features
  featureRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
});
