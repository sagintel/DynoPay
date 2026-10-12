import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Switch, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import type { McpScope, McpToken, SettingsPatch, Theme, ThemeAudit, User } from '@/genui/types';
import { useI18n } from '@/i18n/context';
import { LANGUAGES, languageName } from '@/i18n/languages';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/config';
import { dayLabel } from '@/lib/format';
import { colors, fonts, radius } from '@/theme/tokens';
import { Button } from './Button';
import { Icon } from './Icon';
import { Tap } from './Pressable';
import { Row, Section, Segment, settingsStyles } from './SettingsUI';
import { Text } from './Text';
import { useToast } from './Toast';

type Update = (patch: SettingsPatch) => Promise<void>;
const switchColors = () => ({ trackColor: { true: colors.accent, false: colors.border }, thumbColor: colors.ivory, activeThumbColor: colors.ivory }) as object;

// ─── Language ───────────────────────────────────────────────────────────────

/** Picks a language from the list (search by native or English name, or type any ISO code). */
export function LanguageList({ value, onPick }: { value: string; onPick: (code: string) => void }) {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const shown = useMemo(
    () => (q ? LANGUAGES.filter((l) => l.name.toLowerCase().includes(q) || l.english.toLowerCase().includes(q) || l.code === q) : LANGUAGES),
    [q],
  );
  const customCode = /^[a-z]{2,3}$/.test(q) && !LANGUAGES.some((l) => l.code === q) ? q : null;
  return (
    <View style={{ gap: 8 }}>
      <TextInput
        value={search}
        onChangeText={setSearch}
        placeholder={t('Search a language or type its code')}
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        selectionColor={colors.accent}
        style={styles.input}
      />
      <View style={styles.langGrid}>
        {shown.map((l) => {
          const active = l.code === value;
          return (
            <Tap key={l.code} onPress={() => onPick(l.code)} style={[styles.chip, active && styles.chipActive]} accessibilityRole="radio" accessibilityState={{ selected: active }}>
              <Text variant="label" color={active ? colors.onAccent : colors.text}>{l.name}</Text>
            </Tap>
          );
        })}
        {customCode ? (
          <Tap onPress={() => onPick(customCode)} style={styles.chip}>
            <Text variant="label">{t('Use “{x}”', { x: customCode })}</Text>
          </Tap>
        ) : null}
      </View>
    </View>
  );
}

export function LanguageSettings({ user, update }: { user: User; update: Update }) {
  const { lang, setLanguage, loading } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Section title="Language" footer="English is the default. Write in any language: the assistant understands it, and with “Follow my language” every screen, button and dialog switches to it.">
      <Row
        icon="sparkle"
        title="App language"
        subtitle={languageName(lang)}
        right={loading ? <ActivityIndicator color={colors.accent} /> : <Icon name={open ? 'arrow-down' : 'chevron-right'} size={16} color={colors.textFaint} />}
        onPress={() => setOpen((o) => !o)}
      />
      {open ? (
        <Animated.View entering={FadeIn} style={[settingsStyles.padded, settingsStyles.rowBorder]}>
          <LanguageList
            value={lang}
            onPick={(code) => {
              setOpen(false);
              void setLanguage(code);
            }}
          />
        </Animated.View>
      ) : null}
      <Row
        icon="repeat"
        title="Follow my language"
        subtitle="Switch the app to the language you write in"
        last
        right={<Switch value={user.settings.autoLanguage !== false} onValueChange={(v) => void update({ autoLanguage: v })} {...switchColors()} />}
      />
    </Section>
  );
}

// ─── Theme ──────────────────────────────────────────────────────────────────

/** A miniature screen drawn with the proposed colours (independent of the current theme). */
function ThemePreview({ theme, audit }: { theme: Theme; audit: ThemeAudit }) {
  const { t } = useI18n();
  const c = theme.colors;
  const pass = (v: number, min: number) => `${v.toFixed(1)}:1 ${v >= min ? '✓' : '✗'}`;
  return (
    <View style={{ gap: 8 }}>
      <View style={[styles.preview, { backgroundColor: c.bg, borderColor: c.border }]}>
        <Text variant="tiny" color={c.textMuted}>{t('Balance')}</Text>
        <Text style={{ fontFamily: fonts.bold, fontSize: 28, letterSpacing: -0.6 }} color={c.text}>$12,480<Text color={c.textFaint} style={{ fontSize: 18 }}>.50</Text></Text>
        <View style={[styles.previewCard, { backgroundColor: c.surface, borderColor: c.hairline }]}>
          <View style={[styles.previewDot, { backgroundColor: c.accent }]} />
          <View style={{ flex: 1 }}>
            <Text variant="label" color={c.text}>Sara Malik</Text>
            <Text variant="tiny" color={c.textMuted}>{t('Dinner')}</Text>
          </View>
          <Text variant="label" color={c.negative}>– $50.00</Text>
          <Text variant="label" color={c.positive}>+ $20.00</Text>
        </View>
        <View style={[styles.previewButton, { backgroundColor: c.accent }]}>
          <Text variant="label" color={c.onAccent} style={{ fontFamily: fonts.semibold }}>{t('Hold to send')}</Text>
        </View>
        <View style={[styles.previewButton, { backgroundColor: c.inverse }]}>
          <Text variant="label" color={c.onInverse} style={{ fontFamily: fonts.semibold }}>{t('Continue with PayPal')}</Text>
        </View>
      </View>
      <Text variant="tiny" color={colors.textFaint}>
        {t('Contrast')} · {t('Text')} {pass(audit.text, 7)} · {t('Secondary')} {pass(audit.textMuted, 4.5)} · {t('Buttons')} {pass(audit.onAccent, 4.5)}
      </Text>
    </View>
  );
}

export function ThemeSettings({ user, update }: { user: User; update: Update }) {
  const { t } = useI18n();
  const toast = useToast();
  const current = user.settings.design.theme;
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [proposal, setProposal] = useState<{ theme: Theme; audit: ThemeAudit } | null>(null);

  const preview = async () => {
    if (!prompt.trim()) return;
    setBusy('preview');
    try {
      const res = await api.generateTheme(prompt.trim());
      setProposal({ theme: res.theme, audit: res.audit });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const apply = async (theme: Theme | null) => {
    setBusy('apply');
    // Saving the theme rebuilds every screen with it (the app reloads on the same screen).
    await update({ design: { theme } });
    setBusy(null);
    setProposal(null);
  };

  return (
    <Section title="Theme" footer="Describe colours or a mood in any language. Every screen, button, dialog and the status bar follow it; text and buttons always keep strong contrast, so nothing becomes unreadable.">
      <Row
        icon="sparkle"
        title={current ? current.name : t('DynoPay dark (default)')}
        subtitle={current ? `${current.mode === 'light' ? t('Light') : t('Dark')} · “${current.prompt}”` : t('Amber on near-black')}
        last={!current}
        right={
          current ? (
            <Tap onPress={() => void apply(null)} hitSlop={8}>
              <Text variant="label" color={colors.textMuted}>Reset</Text>
            </Tap>
          ) : undefined
        }
      />
      <View style={settingsStyles.padded}>
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          placeholder={t('e.g. “dark forest green with gold accents” or “light and calm, ocean blue”')}
          placeholderTextColor={colors.textFaint}
          multiline
          maxLength={300}
          selectionColor={colors.accent}
          style={styles.input}
          accessibilityLabel={t('Describe your theme')}
        />
        <Button label="Preview theme" icon="sparkle" variant="primary" size="sm" disabled={!prompt.trim()} loading={busy === 'preview'} onPress={() => void preview()} />
        {proposal ? (
          <Animated.View entering={FadeIn} style={{ gap: 10 }}>
            <ThemePreview theme={proposal.theme} audit={proposal.audit} />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button label="Apply theme" icon="check" variant="primary" size="sm" loading={busy === 'apply'} onPress={() => void apply(proposal.theme)} />
              </View>
              <View style={{ flex: 1 }}>
                <Button label="Discard" variant="secondary" size="sm" onPress={() => setProposal(null)} />
              </View>
            </View>
          </Animated.View>
        ) : null}
      </View>
    </Section>
  );
}

// ─── Connected agents (MCP) ─────────────────────────────────────────────────

const EXPIRY: { value: '30' | '90' | '365' | 'never'; label: string }[] = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
];

export function McpTokens() {
  const { t } = useI18n();
  const toast = useToast();
  const [tokens, setTokens] = useState<McpToken[] | null>(null);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'read' | 'propose'>('read');
  const [expiry, setExpiry] = useState<(typeof EXPIRY)[number]['value']>('90');
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const url = `${API_URL}/mcp`;

  const load = useCallback(() => api.mcpTokens().then((r) => setTokens(r.tokens)).catch(() => setTokens([])), []);
  useEffect(() => void load(), [load]);

  const create = async () => {
    setCreating(true);
    try {
      const scopes: McpScope[] = scope === 'propose' ? ['read', 'propose'] : ['read'];
      const res = await api.createMcpToken({ name: name.trim() || 'My agent', scopes, days: expiry === 'never' ? null : Number(expiry) });
      setSecret(res.token);
      setName('');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await api.revokeMcpToken(id);
      setRevoking(null);
      toast('Token revoked', 'success');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Section title="Connected agents (MCP)" footer="Agents only see what this account may use, and only through a token you create here. Changes they prepare still wait for your confirmation in DynoPay. Revoke a token to cut access at once.">
      <Row
        icon="sparkle"
        title={url}
        subtitle="Streamable HTTP · Authorization: Bearer <token>"
        onPress={async () => {
          await Clipboard.setStringAsync(url);
          toast('MCP URL copied', 'success');
        }}
      />
      {secret ? (
        <Animated.View entering={FadeIn} style={[settingsStyles.padded, settingsStyles.rowBorder]}>
          <Text variant="label" color={colors.accent}>{"Copy your token now. It won't be shown again."}</Text>
          <Text variant="caption" selectable style={styles.secret}>{secret}</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button label="Copy token" icon="receipt" variant="primary" size="sm" onPress={async () => {
                await Clipboard.setStringAsync(secret);
                toast('Token copied', 'success');
              }} />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Done" variant="secondary" size="sm" onPress={() => setSecret(null)} />
            </View>
          </View>
        </Animated.View>
      ) : null}
      {(tokens ?? []).map((tok) => (
        <View key={tok.id} style={[styles.tokenRow, settingsStyles.rowBorder]}>
          <Icon name="shield" size={18} color={colors.textMuted} />
          <View style={{ flex: 1, gap: 1 }}>
            <Text variant="bodyStrong">{tok.name}</Text>
            <Text variant="caption" color={colors.textMuted}>
              {tok.scopes.includes('propose') ? t('Read + propose changes') : t('Read only')} · {tok.hint}
            </Text>
            <Text variant="tiny" color={colors.textFaint}>
              {tok.lastUsedAt ? t('Last used {x}', { x: dayLabel(tok.lastUsedAt) }) : t('Never used')}
              {tok.expiresAt ? ` · ${t('Expires {x}', { x: dayLabel(tok.expiresAt) })}` : ''}
            </Text>
          </View>
          {revoking === tok.id ? (
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Tap onPress={() => setRevoking(null)} hitSlop={8}>
                <Text variant="label" color={colors.textMuted}>Cancel</Text>
              </Tap>
              <Tap onPress={() => void revoke(tok.id)} hitSlop={8}>
                <Text variant="label" color={colors.negative}>Confirm revoke</Text>
              </Tap>
            </View>
          ) : (
            <Tap onPress={() => setRevoking(tok.id)} hitSlop={8}>
              <Text variant="label" color={colors.negative}>Revoke</Text>
            </Tap>
          )}
        </View>
      ))}
      <View style={settingsStyles.padded}>
        <Text variant="caption" color={colors.textMuted}>New token</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={t('Name, e.g. “Claude on my laptop”')}
          placeholderTextColor={colors.textFaint}
          maxLength={60}
          selectionColor={colors.accent}
          style={[styles.input, { minHeight: 44 }]}
        />
        <Segment value={scope} options={[{ value: 'read', label: t('Read only') }, { value: 'propose', label: t('Read + propose') }]} onChange={setScope} />
        <Segment value={expiry} options={EXPIRY.map((e) => ({ value: e.value, label: t(e.label) }))} onChange={setExpiry} />
        <Button label="Create token" icon="plus" variant="secondary" size="sm" loading={creating} onPress={() => void create()} />
      </View>
    </Section>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: 64, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, padding: 12, color: colors.text, fontFamily: fonts.regular, fontSize: 15, textAlignVertical: 'top' },
  langGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  preview: { borderRadius: radius.lg, borderWidth: 1, padding: 14, gap: 10 },
  previewCard: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: radius.md, borderWidth: 1 },
  previewDot: { width: 26, height: 26, borderRadius: 13 },
  previewButton: { alignItems: 'center', paddingVertical: 11, borderRadius: radius.md },
  tokenRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  secret: { fontFamily: fonts.medium, padding: 10, borderRadius: radius.sm, backgroundColor: colors.bg, color: colors.text },
});

// ─── PayPal ─────────────────────────────────────────────────────────────────

type PayPalStatus = Awaited<ReturnType<typeof api.paypalStatus>>;

function Check({ ok, label, hint }: { ok: boolean | null; label: string; hint?: string }) {
  return (
    <View style={styles.checkRow}>
      <Icon name={ok ? 'check' : ok === null ? 'info' : 'close'} size={14} color={ok ? colors.positive : ok === null ? colors.textMuted : colors.negative} />
      <View style={{ flex: 1 }}>
        <Text variant="label">{label}</Text>
        {hint ? <Text variant="tiny" color={colors.textFaint}>{hint}</Text> : null}
      </View>
    </View>
  );
}

/** What PayPal can do for this account right now, with a live re-check (for testers and support). */
export function PayPalSettings({ user }: { user: User }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<PayPalStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const load = useCallback(async (refresh = false) => {
    setChecking(refresh);
    try {
      setStatus(await api.paypalStatus(refresh));
    } catch {
      /* offline: keep the last result */
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => void load(false), [load]);
  const p = status?.platform;
  const env = p ? (p.environment === 'live' ? t('Live') : t('Sandbox')) : '';
  return (
    <Section title="PayPal" footer="Personal accounts use DynoPay's PayPal app: Log in with PayPal, top-ups paid from your PayPal, and payouts to any email. Merchants use their own REST app and its permissions.">
      <View style={[settingsStyles.padded, settingsStyles.rowBorder]}>
        {!status ? (
          <ActivityIndicator color={colors.accent} />
        ) : (
          <>
            <Text variant="caption" color={colors.textMuted}>
              {p?.configured ? t('Platform app · {x}', { x: env }) : t('Platform app not configured')}
              {p?.checkedAt ? ` · ${t('checked {x}', { x: dayLabel(p.checkedAt) })}` : ''}
            </Text>
            <Check ok={p?.configured ? p.features.login : false} label={t('Log in with PayPal')} />
            <Check ok={p?.configured && p.reachable !== false ? p.features.topUps : false} label={t('Top up from PayPal')} />
            <Check ok={p?.configured && p.reachable !== false ? p.features.payouts : false} label={t('Pay anyone by email (Payouts)')} hint={t('People who are not on DynoPay')} />
            <Check ok={p?.features.webhooks ?? false} label={t('Webhooks')} hint={t('Instant updates for top-ups and payouts')} />
            {p?.error ? <Text variant="caption" color={colors.negative}>{p.error}</Text> : null}
            {status.accountType === 'personal' ? (
              <Check ok={status.personal.linked} label={status.personal.linked ? t('Your PayPal: {x}', { x: status.personal.email }) : t('Your PayPal is not linked (demo account)')} />
            ) : status.merchant ? (
              <>
                <Check
                  ok={status.merchant.verified ?? status.merchant.status === 'active'}
                  label={t('Your REST app · {x}', { x: status.merchant.environment === 'live' ? t('Live') : t('Sandbox') })}
                  hint={status.merchant.error ?? `${status.merchant.capabilities.filter((c) => c.enabled).length}/${status.merchant.capabilities.length} ${t('features enabled')}`}
                />
              </>
            ) : null}
          </>
        )}
      </View>
      <Row icon="repeat" title="Check connection" subtitle={user.accountType === 'business' ? 'Re-verify both apps with PayPal' : 'Re-verify with PayPal'} last right={checking ? <ActivityIndicator color={colors.accent} /> : undefined} onPress={() => void load(true)} />
    </Section>
  );
}
