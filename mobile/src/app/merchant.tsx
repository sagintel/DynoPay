import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
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

/**
 * Merchant sign-in with PayPal REST API credentials (or, when signed in, connecting them).
 * The secret is sent once over HTTPS, verified with PayPal and stored encrypted; it is never shown again.
 */
export default function MerchantSignIn() {
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { mode } = useLocalSearchParams<{ mode?: 'connect' }>();
  const connecting = mode === 'connect';
  const { signInMerchant, refreshUser, user } = useSession();
  const [environment, setEnvironment] = useState<MerchantCredentials['environment']>('sandbox');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track whether we're waiting for a sign-in to complete so we know when to navigate.
  const [signingIn, setSigningIn] = useState(false);

  // Navigate to home once user is set after a merchant sign-in.
  // useEffect fires after React commits the new user state, so the guard is already true.
  useEffect(() => {
    if (signingIn && user) {
      router.replace('/(tabs)');
    }
  }, [signingIn, user]);

  const valid = clientId.trim().length >= 20 && clientSecret.trim().length >= 20;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const creds = { environment, clientId: clientId.trim(), clientSecret: clientSecret.trim(), businessName: businessName.trim() || undefined };
    try {
      if (connecting) {
        await api.connectMerchant(creds);
        await refreshUser();
        toast('Merchant account connected', 'success');
        router.back();
      } else {
        setSigningIn(true);
        await signInMerchant(creds);
        // Navigation is handled by the useEffect above once user state is committed.
      }
    } catch (e) {
      setSigningIn(false);
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setClientSecret('');
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 32, paddingHorizontal: GUTTER, gap: space.xl, maxWidth: 520, width: '100%', alignSelf: 'center' }}
      >
        <Tap onPress={() => router.canGoBack() ? router.back() : router.replace('/sign-in')} style={styles.back} accessibilityLabel="Back">
          <Icon name="arrow-left" size={18} color={colors.text} />
        </Tap>

        <View style={{ gap: 8 }}>
          <View style={styles.badge}>
            <Icon name="paypal" size={14} color={colors.accent} />
            <Text variant="label" color={colors.accent}>PayPal business</Text>
          </View>
          <Text variant="title">{connecting ? 'Connect your merchant account' : 'Sign in as a merchant'}</Text>
          <Text variant="body" color={colors.textMuted}>
            Use the Client ID and Secret of your PayPal REST app. DynoPay then works with your real PayPal balance, sales, invoices, refunds,
            disputes and subscriptions. Money only moves after you confirm.
          </Text>
        </View>

        <View style={styles.segment}>
          {(['sandbox', 'live'] as const).map((env) => (
            <Tap key={env} onPress={() => setEnvironment(env)} style={[styles.segmentItem, environment === env && styles.segmentActive]}>
              <Text variant="label" color={environment === env ? colors.onAccent : colors.text}>{env === 'sandbox' ? 'Sandbox' : 'Live'}</Text>
            </Tap>
          ))}
        </View>

        <Field label="Client ID" value={clientId} onChange={setClientId} placeholder="Your REST app Client ID" />
        <Field label="Secret" value={clientSecret} onChange={setClientSecret} placeholder="••••••••••••••••" secure />
        {!connecting ? <Field label="Business name (optional)" value={businessName} onChange={setBusinessName} placeholder="Acme Studio" /> : null}

        {error ? <Text variant="caption" color={colors.negative}>{error}</Text> : null}

        <Button label={connecting ? 'Verify & connect' : 'Verify & sign in'} icon="shield" variant="primary" loading={busy} disabled={!valid} onPress={() => void submit()} />

        <View style={styles.help}>
          <Text variant="label">Where do I find these?</Text>
          <Text variant="caption" color={colors.textMuted}>
            PayPal Developer Dashboard → Apps & Credentials → your app. Enable the features you want DynoPay to use (Transaction Search,
            Invoicing, Disputes, Subscriptions, Payouts). Your secret is verified with PayPal and stored encrypted.
          </Text>
          <Tap onPress={() => void WebBrowser.openBrowserAsync('https://developer.paypal.com/dashboard/applications')} hitSlop={8}>
            <Text variant="label" color={colors.accent}>Open the PayPal developer dashboard</Text>
          </Tap>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, value, onChange, placeholder, secure }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; secure?: boolean }) {
  const { t } = useI18n();
  return (
    <View style={{ gap: 6 }}>
      <Text variant="label" color={colors.textMuted}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder ? t(placeholder) : undefined}
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={secure}
        textContentType={secure ? 'password' : 'none'}
        selectionColor={colors.accent}
        style={styles.input}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  back: { width: 38, height: 38, borderRadius: 19, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, get backgroundColor() { return colors.accentSoft; } },
  segment: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.md, padding: 4, gap: 4 },
  segmentItem: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: radius.sm },
  segmentActive: { get backgroundColor() { return colors.accent; } },
  input: { height: 50, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, paddingHorizontal: 14, color: colors.text, fontFamily: fonts.regular, fontSize: 15 },
  help: { gap: 8, padding: 16, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.hairline },
});
