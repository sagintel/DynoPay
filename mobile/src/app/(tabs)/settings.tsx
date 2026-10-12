import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { Tap } from '@/components/Pressable';
import { Text } from '@/components/Text';
import { useToast } from '@/components/Toast';
import { AssistantSettings, DesignBrief, LookAndFeel } from '@/components/AISettings';
import { LanguageSettings, McpTokens, PayPalSettings, ThemeSettings } from '@/components/MoreSettings';
import { useI18n } from '@/i18n/context';
import { Row, Section } from '@/components/SettingsUI';
import type { Block, SettingsPatch } from '@/genui/types';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { colors, fonts, GUTTER, radius, space } from '@/theme/tokens';

const SLOT_LABEL: Record<string, { title: string; hint: string }> = {
  home: { title: 'Home', hint: 'e.g. “Minimal: balance, my top 3 people and a spending donut”' },
  cards: { title: 'Cards', hint: 'e.g. “Cards as a list with this month’s spend per card”' },
  'detail:transaction': { title: 'Transaction details', hint: 'e.g. “Show the receipt style with the person’s history below”' },
  'detail:card': { title: 'Card details', hint: 'e.g. “Card, limit progress, then last 10 payments”' },
  'detail:contact': { title: 'Contact details', hint: 'e.g. “Profile plus a chart of what I sent them per month”' },
  'detail:profile': { title: 'Your profile', hint: 'e.g. “Profile card with my balance and cards”' },
  'detail:invoice': { title: 'Invoice details', hint: 'e.g. “Amount first, then items and a big Remind button”' },
  'detail:dispute': { title: 'Dispute details', hint: 'e.g. “Show the buyer messages first”' },
};

const MERCHANT_SLOTS = new Set(['detail:invoice', 'detail:dispute']);

export default function Settings() {
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { t } = useI18n();
  const { user, setUser, signOut, refreshUser } = useSession();
  const [providers, setProviders] = useState<{ id: string; available: boolean; model: string; default: boolean }[]>([]);
  const [layouts, setLayouts] = useState<{ slot: string; custom: boolean; instruction: string | null }[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [working, setWorking] = useState<string | null>(null);
  /** Redesigns proposed by the assistant, waiting for the user to apply them (saving a layout is a change). */
  const [proposals, setProposals] = useState<Record<string, { pendingId: string; title: string }>>({});

  const load = useCallback(async () => {
    const [p, l] = await Promise.all([api.providers(), api.layouts()]);
    setProviders(p.providers);
    setLayouts(l.layouts);
  }, []);
  useEffect(() => {
    load().catch(() => toast('Could not load settings', 'error'));
    refreshUser().catch(() => undefined); // picks up the merchant connection details
  }, [load, toast, refreshUser]);

  if (!user) return null;

  const update = async (patch: Parameters<typeof api.updateMe>[0]) => {
    try {
      setUser(await api.updateMe(patch));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const updateSettings = (settings: SettingsPatch) => update({ settings });

  /** Asks the assistant for a layout; it comes back as a proposal the user applies (never saved silently). */
  const proposeLayout = async (slot: string, wish: string): Promise<boolean> => {
    const res = await api.agent({
      screen: 'settings',
      prompt: `Redesign my "${SLOT_LABEL[slot]?.title ?? slot}" layout (slot "${slot}"): ${wish}. Compose it from the catalog${slot.startsWith('detail:') ? ' using "$id" for the entity id' : ''} and save it with save_layout.`,
    });
    const flat = (blocks: Block[]): Block[] => blocks.flatMap((b) => (b.type === 'section' || b.type === 'row' ? flat(b.children) : [b]));
    const proposal = flat(res.spec.blocks).find((b) => b.type === 'confirmation' && b.data?.action === 'save_layout') as Extract<Block, { type: 'confirmation' }> | undefined;
    if (!proposal?.data) return false;
    setProposals((p) => ({ ...p, [slot]: { pendingId: proposal.pendingId, title: proposal.data!.summary.title } }));
    return true;
  };

  const redesign = async (slot: string) => {
    if (!instruction.trim()) return;
    setWorking(slot);
    try {
      const ok = await proposeLayout(slot, instruction.trim());
      if (!ok) {
        toast(user.settings.aiProvider === 'offline' || !providers.some((p) => p.available && p.id !== 'offline') ? 'Redesign needs Gemini or Cloudflare enabled' : 'The assistant could not design that layout. Try rephrasing.', 'error');
        return;
      }
      setEditing(null);
      setInstruction('');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setWorking(null);
    }
  };

  const applyProposal = async (slot: string) => {
    const proposal = proposals[slot];
    if (!proposal) return;
    setWorking(slot);
    try {
      const res = await api.confirm(proposal.pendingId);
      if (res.status !== 'executed') throw new Error(res.error ?? t('This proposal is {x}', { x: t(res.status) }));
      setProposals(({ [slot]: _done, ...rest }) => rest);
      await load();
      toast(t('{x} updated', { x: t(SLOT_LABEL[slot]?.title ?? slot) }), 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setWorking(null);
    }
  };

  const discardProposal = (slot: string) => {
    const proposal = proposals[slot];
    if (proposal) void api.cancel(proposal.pendingId).catch(() => undefined);
    setProposals(({ [slot]: _gone, ...rest }) => rest);
  };

  /** The design brief, applied to Home and Cards as two proposals. */
  const applyBriefToScreens = async () => {
    const brief = user.settings.design.brief.trim();
    setWorking('home');
    try {
      const results = await Promise.all(['home', 'cards'].map((slot) => proposeLayout(slot, `Follow my design brief: ${brief}`).catch(() => false)));
      toast(results.some(Boolean) ? 'Review the proposed layouts below and apply them' : 'The assistant could not design these screens', results.some(Boolean) ? 'info' : 'error');
    } finally {
      setWorking(null);
    }
  };

  const reset = async (slot: string) => {
    setWorking(slot);
    try {
      await api.resetLayout(slot);
      await load();
      toast('Back to the original layout', 'success');
    } finally {
      setWorking(null);
    }
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ paddingTop: insets.top + 6, paddingHorizontal: GUTTER, paddingBottom: 120, gap: space.xxl, maxWidth: 640, width: '100%', alignSelf: 'center' }}>
      <View style={{ height: 44, justifyContent: 'center' }}>
        <Text style={{ fontFamily: fonts.bold, fontSize: 21, letterSpacing: -0.5 }}>
          Settings<Text style={{ fontFamily: fonts.bold, fontSize: 21 }} color={colors.accent}>.</Text>
        </Text>
      </View>

      <View style={styles.profile}>
        <Avatar initials={user.initials} size={56} solid />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="heading">{user.name}</Text>
          <Text variant="caption" color={colors.textMuted}>@{user.handle} · {user.email}</Text>
          <Text variant="caption" color={user.paypalLinked ? colors.accent : colors.textFaint}>{user.paypalLinked ? 'PayPal account connected' : 'Demo account'}</Text>
        </View>
      </View>

      <Section title="Account">
        <Row
          icon={user.accountType === 'business' ? 'paypal' : 'user'}
          title={user.accountType === 'business' ? 'Business · PayPal merchant' : 'Personal'}
          subtitle={
            user.accountType === 'business'
              ? `${user.merchant?.businessName ?? user.name} · ${t(user.merchant?.environment === 'live' ? 'Live' : 'Sandbox')} · ${user.merchant?.clientId ?? ''}`
              : 'DynoPay wallet with Log in with PayPal'
          }
          last={user.accountType !== 'business'}
        />
        {user.accountType === 'business' && user.merchant ? (
          <View style={{ padding: 14, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline }}>
            {user.merchant.status !== 'active' ? (
              <Text variant="caption" color={colors.negative}>PayPal rejected these credentials. Reconnect them below.</Text>
            ) : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {user.merchant.capabilities.map((c) => (
                <View key={c.key} style={[styles.cap, !c.enabled && { opacity: 0.4 }]}>
                  <Icon name={c.enabled ? 'check' : 'close'} size={11} color={c.enabled ? colors.accent : colors.textMuted} />
                  <Text variant="tiny" color={c.enabled ? colors.text : colors.textMuted}>{c.label}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
        {user.accountType === 'business' ? (
          <>
            <Row icon="repeat" title="Update API credentials" subtitle="Rotate the secret or switch sandbox / live" onPress={() => router.push('/merchant?mode=connect')} last={!user.paypalLinked} />
            {user.paypalLinked ? (
              <Row
                icon="close"
                title="Disconnect merchant account"
                subtitle="Back to a personal account; your wallet stays"
                last
                onPress={async () => {
                  try {
                    await api.disconnectMerchant();
                    await refreshUser();
                    toast('Merchant account disconnected', 'success');
                  } catch (e) {
                    toast((e as Error).message, 'error');
                  }
                }}
              />
            ) : null}
          </>
        ) : (
          <Row icon="paypal" title="Connect a PayPal business account" subtitle="Use your REST API credentials for merchant features" onPress={() => router.push('/merchant?mode=connect')} last />
        )}
      </Section>

      <PayPalSettings user={user} />

      <LanguageSettings user={user} update={updateSettings} />

      <AssistantSettings user={user} providers={providers} update={updateSettings} />

      <ThemeSettings user={user} update={updateSettings} />

      <LookAndFeel design={user.settings.design} update={updateSettings} />

      <DesignBrief design={user.settings.design} update={updateSettings} onApplyToScreens={() => void applyBriefToScreens()} />

      <Section title="Your layouts">
        {layouts.filter((l) => user.accountType === 'business' || !MERCHANT_SLOTS.has(l.slot)).map((l, i, shown) => (
          <View key={l.slot} style={i < shown.length - 1 ? styles.rowBorder : undefined}>
            <Row
              icon={l.slot.startsWith('detail') ? 'receipt' : l.slot === 'cards' ? 'card' : 'wallet'}
              title={SLOT_LABEL[l.slot]?.title ?? l.slot}
              subtitle={l.custom ? `${t('Custom')} · ${l.instruction ?? t('designed with the assistant')}` : t('Original')}
              last
              right={
                working === l.slot ? (
                  <ActivityIndicator color={colors.accent} />
                ) : (
                  <View style={{ flexDirection: 'row', gap: 12 }}>
                    {l.custom ? (
                      <Tap onPress={() => void reset(l.slot)} hitSlop={8}>
                        <Text variant="label" color={colors.textMuted}>Reset</Text>
                      </Tap>
                    ) : null}
                    <Tap onPress={() => { setEditing(editing === l.slot ? null : l.slot); setInstruction(''); }} hitSlop={8}>
                      <Text variant="label" color={colors.accent}>Redesign</Text>
                    </Tap>
                  </View>
                )
              }
            />
            {proposals[l.slot] ? (
              <Animated.View entering={FadeIn} style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 10 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Icon name="sparkle" size={14} color={colors.accent} />
                  <Text variant="label" style={{ flex: 1 }}>{t('{x}: ready to apply', { x: proposals[l.slot]!.title })}</Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Button label="Apply" icon="check" variant="primary" size="sm" loading={working === l.slot} onPress={() => void applyProposal(l.slot)} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button label="Discard" variant="secondary" size="sm" onPress={() => discardProposal(l.slot)} />
                  </View>
                </View>
              </Animated.View>
            ) : null}
            {editing === l.slot ? (
              <Animated.View entering={FadeIn} style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 10 }}>
                <TextInput
                  value={instruction}
                  onChangeText={setInstruction}
                  placeholder={t(SLOT_LABEL[l.slot]?.hint ?? '')}
                  placeholderTextColor={colors.textFaint}
                  multiline
                  autoFocus
                  selectionColor={colors.accent}
                  style={styles.input}
                />
                <Button label="Redesign with the assistant" icon="sparkle" variant="primary" size="sm" loading={working === l.slot} disabled={!instruction.trim()} onPress={() => void redesign(l.slot)} />
              </Animated.View>
            ) : null}
          </View>
        ))}
      </Section>

      <Section title="Security">
        <Row
          icon="shield"
          title="Face ID / fingerprint"
          subtitle="Required before money moves"
          right={<Switch value={user.settings.biometricForSensitive !== false} onValueChange={(v) => void update({ settings: { biometricForSensitive: v } })} trackColor={{ true: colors.accent, false: colors.border }} thumbColor={colors.ivory} {...({ activeThumbColor: colors.ivory } as object)} />}
        />
        <Row
          icon="bolt"
          title="Haptics"
          last
          right={<Switch value={user.settings.haptics !== false} onValueChange={(v) => void update({ settings: { haptics: v } })} trackColor={{ true: colors.accent, false: colors.border }} thumbColor={colors.ivory} {...({ activeThumbColor: colors.ivory } as object)} />}
        />
      </Section>

      <McpTokens />

      <Button label="Sign out" icon="logout" variant="danger" onPress={() => void signOut()} />
      <Text variant="tiny" color={colors.textFaint} style={{ textAlign: 'center' }}>DynoPay 1.0 · Payments via PayPal</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  group: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.hairline, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 14 },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  segment: { flexDirection: 'row', backgroundColor: colors.bg, borderRadius: radius.md, padding: 4, gap: 4 },
  segmentItem: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: radius.sm },
  segmentActive: { get backgroundColor() { return colors.accent; } },
  cap: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.pill, backgroundColor: colors.bg },
  input: { minHeight: 70, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, padding: 12, color: colors.text, fontFamily: fonts.regular, fontSize: 15, textAlignVertical: 'top' },
});
