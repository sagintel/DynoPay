import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Switch, TextInput, View } from 'react-native';
import type { ChartStyle, Design, SettingsPatch, UsageReport, User } from '@/genui/types';
import { useI18n } from '@/i18n/context';
import { api } from '@/lib/api';
import { ACCENTS, colors, fonts, radius, type AccentName } from '@/theme/tokens';
import { Button } from './Button';
import { Icon } from './Icon';
import { Tap } from './Pressable';
import { Row, Section, Segment, settingsStyles } from './SettingsUI';
import { Text } from './Text';
import { useToast } from './Toast';

type Update = (patch: SettingsPatch) => Promise<void>;
/** activeThumbColor is the web (react-native-web) prop; native uses thumbColor. */
const switchColors = () => ({ trackColor: { true: colors.accent, false: colors.border }, thumbColor: colors.ivory, activeThumbColor: colors.ivory }) as object;
const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Assistant: provider, live typing, on-device first, answer cache and usage. */
export function AssistantSettings({
  user,
  providers,
  update,
}: {
  user: User;
  providers: { id: string; available: boolean; model: string; default: boolean }[];
  update: Update;
}) {
  const toast = useToast();
  const { t } = useI18n();
  const s = user.settings;
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const loadUsage = useCallback(() => api.usage().then(setUsage).catch(() => undefined), []);
  useEffect(() => void loadUsage(), [loadUsage]);
  // Show the provider actually in use: an unavailable choice (no API key on the server) falls back to on-device.
  const chosen = s.aiProvider ?? providers.find((p) => p.default)?.id ?? 'offline';
  const available = (id: string) => providers.find((p) => p.id === id)?.available ?? id === 'offline';
  const active = available(chosen) ? chosen : providers.find((p) => p.available && p.id !== 'offline')?.id ?? 'offline';
  const noAI = !providers.some((p) => p.available && p.id !== 'offline');
  const reuse = s.cacheMaxReuse;

  return (
    <>
      <Section title="Assistant" footer="Only reading your data happens on its own. Every change (send, freeze, delete, update…) waits for your confirmation.">
        <View style={[settingsStyles.padded, settingsStyles.rowBorder]}>
          <Text variant="caption" color={colors.textMuted}>Model that composes your screens.</Text>
          <Segment
            value={active as 'gemini'}
            options={(providers.length ? providers : [{ id: 'gemini', available: true }, { id: 'cloudflare', available: true }, { id: 'offline', available: true }]).map((p) => ({
              value: p.id as 'gemini',
              label: p.id === 'offline' ? 'On-device' : p.id === 'gemini' ? 'Gemini' : 'Cloudflare',
              disabled: !p.available,
            }))}
            onChange={(v) => void update({ aiProvider: v })}
          />
          <Text variant="tiny" color={colors.textFaint}>
            {noAI && providers.length ? 'No AI key on the server yet: requests use on-device rules.' : active === 'offline' ? 'Rules on the server, no AI tokens.' : providers.find((p) => p.id === active)?.model ?? ''}
          </Text>
        </View>
        <Row
          icon="bolt"
          title="Live as you type"
          subtitle="The screen follows your sentence. Previews only; nothing runs."
          right={<Switch value={s.liveAgent} onValueChange={(v) => void update({ liveAgent: v })} {...switchColors()} />}
        />
        <Row
          icon="shield"
          title="On-device first"
          subtitle="Answer common requests without AI (saves tokens)"
          last
          right={<Switch value={s.preferOffline} onValueChange={(v) => void update({ preferOffline: v })} {...switchColors()} />}
        />
      </Section>

      <Section title="Answer cache" footer="Repeat requests reuse the last AI answer with fresh data. After the reuse limit, the next one asks the AI again and the count restarts.">
        <View style={[settingsStyles.padded, settingsStyles.rowBorder]}>
          <Segment
            value={s.cacheMode}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'exact', label: 'Same sentence' },
              { value: 'similar', label: 'Similar' },
            ]}
            onChange={(v) => void update({ cacheMode: v })}
          />
          <Text variant="tiny" color={colors.textFaint}>
            {s.cacheMode === 'similar' ? '“Send 50 to Sara” also answers “send 120 to John”.' : s.cacheMode === 'exact' ? 'Only identical sentences are reused.' : 'Every request is answered fresh.'}
          </Text>
        </View>
        <Row
          icon="repeat"
          title="Reuse limit"
          subtitle={reuse === 0 ? t('Unlimited reuse') : reuse === 1 ? t('Refresh with AI after 1 reuse') : t('Refresh with AI after {x} reuses', { x: reuse })}
          right={
            <View style={styles.stepper}>
              <Tap disabled={s.cacheMode === 'off' || reuse <= 0} onPress={() => void update({ cacheMaxReuse: Math.max(0, reuse - 1) })} style={styles.stepBtn} accessibilityLabel="Fewer reuses">
                <Text variant="heading">−</Text>
              </Tap>
              <Text variant="bodyStrong" style={{ minWidth: 28, textAlign: 'center' }}>{reuse === 0 ? '∞' : reuse}</Text>
              <Tap disabled={s.cacheMode === 'off' || reuse >= 100} onPress={() => void update({ cacheMaxReuse: Math.min(100, reuse + 1) })} style={styles.stepBtn} accessibilityLabel="More reuses">
                <Text variant="heading">+</Text>
              </Tap>
            </View>
          }
        />
        {usage ? (
          <View style={[settingsStyles.padded, settingsStyles.rowBorder]}>
            <Text variant="label" color={colors.textMuted}>{t('Last {x} days', { x: usage.usage.days })}</Text>
            <View style={styles.stats}>
              <Stat label="AI calls" value={String(usage.usage.llmRuns)} />
              <Stat label="Tokens used" value={compact(usage.usage.inputTokens + usage.usage.outputTokens)} />
              <Stat label="Calls avoided" value={String(usage.usage.cacheHits + usage.usage.offlineRuns)} />
              <Stat label="Tokens saved" value={`~${compact(usage.usage.tokensSaved)}`} />
            </View>
            <Text variant="tiny" color={colors.textFaint}>
              {t('{x}% answered without AI', { x: usage.usage.savingsRate })} · {t('{x} cached answers ({y} reusable)', { x: usage.cache.plans, y: usage.cache.reusable })}
            </Text>
          </View>
        ) : null}
        <Row
          icon="trash"
          title="Clear cached answers"
          last
          onPress={async () => {
            const res = await api.clearCache().catch(() => null);
            if (res) toast(t('{x} cached answers cleared', { x: res.cleared }), 'success');
            void loadUsage();
          }}
        />
      </Section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={{ fontFamily: fonts.semibold, fontSize: 17 }}>{value}</Text>
      <Text variant="tiny" color={colors.textMuted}>{label}</Text>
    </View>
  );
}

const CHART_STYLES: { value: ChartStyle; label: string }[] = [
  { value: 'auto', label: 'Auto' }, { value: 'bar', label: 'Bars' }, { value: 'hbar', label: 'Ranked' }, { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' }, { value: 'donut', label: 'Donut' }, { value: 'pie', label: 'Pie' }, { value: 'progress', label: 'Progress' },
  { value: 'heatmap', label: 'Heatmap' }, { value: 'sparkline', label: 'Sparkline' },
];

/** Look & feel: deterministic preferences, applied everywhere without AI. */
export function LookAndFeel({ design, update }: { design: Design; update: Update }) {
  const set = (patch: Partial<Design>) => update({ design: patch });
  return (
    <Section title="Look & feel">
      <View style={[settingsStyles.padded, settingsStyles.rowBorder]}>
        <Text variant="caption" color={colors.textMuted}>Accent</Text>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          {(Object.keys(ACCENTS) as AccentName[]).map((name) => (
            <Tap
              key={name}
              onPress={() => void set({ accent: name })}
              accessibilityRole="radio"
              accessibilityLabel={name}
              accessibilityState={{ selected: design.accent === name }}
              style={[styles.swatch, { backgroundColor: ACCENTS[name].accent }, design.accent === name && styles.swatchActive]}
            >
              {design.accent === name ? <Icon name="check" size={16} color={colors.onAccent} /> : null}
            </Tap>
          ))}
        </View>
      </View>
      <View style={[settingsStyles.padded, settingsStyles.rowBorder]}>
        <Text variant="caption" color={colors.textMuted}>Density</Text>
        <Segment value={design.density} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} onChange={(v) => void set({ density: v })} />
        <Text variant="caption" color={colors.textMuted}>Motion</Text>
        <Segment value={design.motion} options={[{ value: 'full', label: 'Full' }, { value: 'reduced', label: 'Reduced' }]} onChange={(v) => void set({ motion: v })} />
        <Text variant="caption" color={colors.textMuted}>Balance</Text>
        <Segment value={design.balanceStyle} options={[{ value: 'arc', label: 'Sun arc' }, { value: 'compact', label: 'Compact' }, { value: 'minimal', label: 'Minimal' }]} onChange={(v) => void set({ balanceStyle: v })} />
      </View>
      <View style={settingsStyles.padded}>
        <Text variant="caption" color={colors.textMuted}>Preferred chart (used where it fits the data)</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {CHART_STYLES.map((c) => {
            const active = design.chartStyle === c.value;
            return (
              <Tap key={c.value} onPress={() => void set({ chartStyle: c.value })} style={[styles.chip, active && { backgroundColor: colors.accent, borderColor: colors.accent }]}>
                <Text variant="label" color={active ? colors.onAccent : colors.text}>{c.label}</Text>
              </Tap>
            );
          })}
        </View>
      </View>
    </Section>
  );
}

/** The free-text design brief the AI follows on every render (within what the app supports). */
export function DesignBrief({ design, update, onApplyToScreens }: { design: Design; update: Update; onApplyToScreens: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(design.brief);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(design.brief), [design.brief]);
  const dirty = draft.trim() !== design.brief.trim();
  return (
    <Section
      title="Design brief"
      footer="The assistant follows this on every screen it composes, using only the app's own components, colors and rules. Payments always keep their confirmation."
    >
      <Row
        icon="sparkle"
        title="Use my design brief"
        subtitle={design.enabled ? 'Applied to every AI render' : 'Off: default style'}
        right={<Switch value={design.enabled} onValueChange={(v) => void update({ design: { enabled: v } })} {...switchColors()} />}
      />
      <View style={settingsStyles.padded}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={t('e.g. Keep screens minimal. Big numbers first, charts as lines, show at most 5 transactions, put people before activity.')}
          placeholderTextColor={colors.textFaint}
          multiline
          maxLength={1500}
          selectionColor={colors.accent}
          style={styles.brief}
          accessibilityLabel="Design brief"
        />
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text variant="tiny" color={colors.textFaint}>{draft.length}/1500</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label="Save" size="sm" variant="primary" fullWidth={false} disabled={!dirty} loading={saving} onPress={async () => {
              setSaving(true);
              await update({ design: { brief: draft.trim(), enabled: draft.trim() ? true : design.enabled } });
              setSaving(false);
            }} />
            <Button label="Apply to Home & Cards" size="sm" variant="secondary" fullWidth={false} disabled={!design.enabled || !design.brief.trim() || dirty} onPress={onApplyToScreens} />
          </View>
        </View>
      </View>
    </Section>
  );
}

const styles = StyleSheet.create({
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stepBtn: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stat: { flexGrow: 1, flexBasis: '45%', padding: 10, borderRadius: radius.md, backgroundColor: colors.bg, gap: 2 },
  swatch: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  swatchActive: { borderWidth: 2, borderColor: colors.text },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  brief: { minHeight: 110, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, padding: 12, color: colors.text, fontFamily: fonts.regular, fontSize: 15, textAlignVertical: 'top' },
});
