import { useMemo, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { Tap } from '@/components/Pressable';
import { Text } from '@/components/Text';
import { useI18n } from '@/i18n/context';
import { cardThemes, colors, fonts, radius, space } from '@/theme/tokens';
import { useCanvas } from '../canvas';
import type { Block, PickerItem } from '../types';
import { SectionHeader } from './Primitives';

type PickerT = Extract<Block, { type: 'picker' }>;

const DEFAULT_TITLE: Record<PickerT['kind'], string> = {
  contact: 'Who is it for?',
  card: 'Which card?',
  schedule: 'Which scheduled payment?',
  request: 'Which request?',
};

/**
 * Choose the target first (recipient, card, item to remove…), then Continue prepares the action,
 * which still opens its confirmation. The server computes each item's input and eligibility;
 * the app only sends back the chosen item's ready-made patch.
 */
export function PickerBlock({ block }: { block: PickerT }) {
  const { dispatch } = useCanvas();
  const { t } = useI18n();
  const data = block.data;
  const items = useMemo(() => data?.items ?? [], [data]);
  const [selected, setSelected] = useState<string | null>(() => {
    const pre = data?.preselect ?? block.preselect ?? null;
    return pre && items.some((i) => i.id === pre && !i.disabled) ? pre : items.filter((i) => !i.disabled).length === 1 ? items.find((i) => !i.disabled)!.id : null;
  });
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? items.filter((i) => `${i.title} ${i.subtitle}`.toLowerCase().includes(q)) : items;
  }, [items, filter]);

  const chosen = items.find((i) => i.id === selected) ?? null;
  const go = async () => {
    if (!chosen || chosen.disabled) return;
    setBusy(true);
    await dispatch({ type: 'run', action: data?.action ?? block.action, input: { ...(data?.input ?? block.input), ...chosen.patch } });
    setBusy(false);
  };

  return (
    <View style={styles.wrap}>
      <SectionHeader title={block.title ?? t(DEFAULT_TITLE[block.kind])} />
      {data?.searchMiss && block.search ? (
        <Text variant="caption" color={colors.textMuted}>{t('Nobody matches “{x}”. Pick someone below.', { x: block.search })}</Text>
      ) : null}
      {items.length > 6 ? (
        <TextInput
          value={filter}
          onChangeText={setFilter}
          placeholder={t('Search')}
          placeholderTextColor={colors.textFaint}
          selectionColor={colors.accent}
          style={styles.filter}
        />
      ) : null}
      {!items.length ? (
        <Text variant="body" color={colors.textMuted}>{t('Nothing to choose from yet.')}</Text>
      ) : (
        <View style={styles.list} accessibilityRole="radiogroup">
          {shown.slice(0, 30).map((item, i) => (
            <Item key={item.id} item={item} kind={block.kind} active={item.id === selected} last={i === Math.min(shown.length, 30) - 1} onPress={() => setSelected(item.id)} />
          ))}
        </View>
      )}
      {items.length ? (
        <Button label={chosen ? t('Continue with {x}', { x: chosen.title }) : t('Choose one to continue')} icon="arrow-right" variant="primary" disabled={!chosen} loading={busy} onPress={() => void go()} />
      ) : null}
    </View>
  );
}

function Item({ item, kind, active, last, onPress }: { item: PickerItem; kind: PickerT['kind']; active: boolean; last: boolean; onPress: () => void }) {
  const card = kind === 'card' && item.badge ? cardThemes[item.badge] : undefined;
  return (
    <Tap
      onPress={onPress}
      disabled={item.disabled}
      scaleTo={0.985}
      accessibilityRole="radio"
      accessibilityState={{ selected: active, disabled: item.disabled }}
      accessibilityLabel={`${item.title}, ${item.subtitle}${item.reason ? `, ${item.reason}` : ''}`}
      style={[styles.row, !last && styles.divider, active && styles.rowActive, item.disabled && { opacity: 0.45 }]}
    >
      {card ? (
        <View style={[styles.cardSwatch, { backgroundColor: card.from }]} />
      ) : (
        <Avatar initials={item.initials ?? item.title.slice(0, 2).toUpperCase()} size={38} />
      )}
      <View style={{ flex: 1, gap: 1 }}>
        <Text variant="bodyStrong" numberOfLines={1}>{item.title}</Text>
        <Text variant="caption" color={item.reason ? colors.negative : colors.textMuted} numberOfLines={1}>
          {item.reason ?? item.subtitle}
        </Text>
      </View>
      {item.badge && kind === 'contact' ? (
        <View style={styles.badge}>
          <Text variant="tiny" color={colors.accent}>{item.badge}</Text>
        </View>
      ) : null}
      <View style={[styles.radio, active && styles.radioActive]}>{active ? <Icon name="check" size={12} color={colors.onAccent} /> : null}</View>
    </Tap>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.md },
  list: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.hairline, backgroundColor: colors.surface, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 11 },
  rowActive: { backgroundColor: colors.accentSoft },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  cardSwatch: { width: 38, height: 26, borderRadius: 5 },
  badge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: colors.accentSoft },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  radioActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  filter: { minHeight: 42, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, paddingHorizontal: 12, color: colors.text, fontFamily: fonts.regular, fontSize: 15 },
});
