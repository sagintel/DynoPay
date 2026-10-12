import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { Tap } from '@/components/Pressable';
import { Text } from '@/components/Text';
import { splitMoney } from '@/lib/format';
import { colors, fonts, radius, space, toneColor, type } from '@/theme/tokens';
import { useCanvas } from '../canvas';
import type { Block } from '../types';

type B<T extends Block['type']> = { block: Extract<Block, { type: T }> };

const TEXT_VARIANT = { display: 'display', title: 'title', heading: 'heading', body: 'body', caption: 'caption', label: 'label' } as const;

export function TextBlock({ block }: B<'text'>) {
  return (
    <Text variant={TEXT_VARIANT[block.variant ?? 'body']} color={toneColor(block.tone)} style={{ textAlign: block.align ?? 'left' }}>
      {block.text}
    </Text>
  );
}

/** The big money figure: symbol, whole part large, cents small and muted. */
export function BigAmount({ value, currency, size = 'xl', color = colors.text }: { value: number; currency?: string; size?: 'xl' | 'lg' | 'md'; color?: string }) {
  const { sign, symbol, whole, cents } = splitMoney(value, currency);
  const big = size === 'xl' ? 44 : size === 'lg' ? 34 : 26;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
      <Text style={{ fontFamily: fonts.semibold, fontSize: big * 0.62, marginRight: 6 }} color={color}>
        {sign}
        {symbol.trim()}
      </Text>
      <Text style={{ fontFamily: fonts.bold, fontSize: big, letterSpacing: -1.2, lineHeight: big * 1.12 }} color={color}>
        {whole}
      </Text>
      <Text style={{ fontFamily: fonts.medium, fontSize: big * 0.45, marginLeft: 2 }} color={colors.textMuted}>
        {cents}
      </Text>
    </View>
  );
}

export function AmountBlock({ block }: B<'amount'>) {
  const { currency: fallback } = useCanvas().spec ?? {};
  return (
    <View style={{ gap: 4 }}>
      <BigAmount value={block.value} currency={block.currency ?? fallback} size={block.size} color={toneColor(block.tone)} />
      {block.caption ? <Text variant="caption" color={colors.textMuted}>{block.caption}</Text> : null}
    </View>
  );
}

export function KeyValueRow({ label, value, tone, onPress, last }: { label: string; value: string; tone?: string; onPress?: () => void; last?: boolean }) {
  const content = (
    <View style={[styles.kv, !last && styles.kvBorder]}>
      <Text variant="body" color={colors.textMuted}>{label}</Text>
      <Text variant="bodyStrong" color={toneColor(tone)} style={{ fontFamily: fonts.semibold, flexShrink: 1, textAlign: 'right' }} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
  return onPress ? <Tap onPress={onPress} scaleTo={0.99}>{content}</Tap> : content;
}

export function KeyValuesBlock({ block }: B<'key_values'>) {
  const { dispatch } = useCanvas();
  return (
    <View style={styles.kvWrap}>
      {block.rows.map((r, i) => (
        <KeyValueRow key={i} label={r.label} value={r.value} tone={r.tone} last={i === block.rows.length - 1} onPress={r.action ? () => void dispatch(r.action!) : undefined} />
      ))}
    </View>
  );
}

export function ButtonBlock({ block }: B<'button'>) {
  const { dispatch } = useCanvas();
  return <Button label={block.label} icon={block.icon} variant={block.variant ?? 'secondary'} fullWidth={block.fullWidth ?? true} onPress={() => void dispatch(block.action)} />;
}

export function ButtonsBlock({ block }: B<'buttons'>) {
  const { dispatch } = useCanvas();
  const row = (block.layout ?? 'row') === 'row';
  return (
    <View style={{ flexDirection: row ? 'row' : 'column', gap: space.sm }}>
      {block.items.map((b, i) => (
        <View key={i} style={row ? { flex: 1 } : undefined}>
          <Button label={b.label} icon={b.icon} variant={b.variant ?? 'secondary'} onPress={() => void dispatch(b.action)} />
        </View>
      ))}
    </View>
  );
}

export function ChipsBlock({ block }: B<'chips'>) {
  const { dispatch } = useCanvas();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={{ marginHorizontal: -20 }}>
      {block.items.map((c, i) => (
        <Tap key={i} onPress={() => void dispatch(c.action)} style={styles.chip} accessibilityLabel={c.label}>
          {c.icon ? <Icon name={c.icon} size={13} color={colors.text} /> : null}
          <Text variant="label">{c.label}</Text>
        </Tap>
      ))}
    </ScrollView>
  );
}

const NOTICE = {
  info: { icon: 'info', color: colors.info },
  success: { icon: 'check', color: colors.positive },
  warning: { icon: 'warning', color: colors.warning },
  error: { icon: 'warning', color: colors.negative },
} as const;

export function NoticeBlock({ block }: B<'notice'>) {
  const n = NOTICE[block.tone ?? 'info'];
  return (
    <View style={styles.notice}>
      <Icon name={n.icon} size={17} color={n.color} />
      <View style={{ flex: 1, gap: 2 }}>
        {block.title ? <Text variant="bodyStrong">{block.title}</Text> : null}
        <Text variant="body" color={colors.textMuted}>{block.text}</Text>
      </View>
    </View>
  );
}

export function ErrorBlock({ message }: { message: string }) {
  return <NoticeBlock block={{ type: 'notice', tone: 'warning', text: message }} />;
}

export function StatGridBlock({ block }: B<'stat_grid'>) {
  return (
    <View style={styles.grid}>
      {block.items.map((s, i) => (
        <View key={i} style={styles.stat}>
          <Text variant="caption" color={colors.textMuted}>{s.label}</Text>
          <Text style={{ ...type.title, fontSize: 22 }} color={toneColor(s.tone)}>{s.value}</Text>
          {s.caption ? <Text variant="caption" color={colors.textFaint}>{s.caption}</Text> : null}
        </View>
      ))}
    </View>
  );
}

export function EmptyBlock({ block }: B<'empty'>) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Icon name={block.icon ?? 'sparkle'} size={20} color={colors.accent} />
      </View>
      <Text variant="heading" style={{ textAlign: 'center' }}>{block.title}</Text>
      {block.text ? <Text variant="body" color={colors.textMuted} style={{ textAlign: 'center' }}>{block.text}</Text> : null}
    </View>
  );
}

export const DividerBlock = () => <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline }} />;
export const SpacerBlock = ({ block }: B<'spacer'>) => <View style={{ height: block.size === 'sm' ? 4 : block.size === 'lg' ? 28 : 14 }} />;

export function SectionHeader({ title, subtitle, trailing }: { title?: string; subtitle?: string; trailing?: { label: string; onPress: () => void } }) {
  if (!title && !trailing) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: space.sm }}>
      <View style={{ gap: 2, flex: 1 }}>
        {title ? <Text variant="label" color={colors.textMuted}>{title}</Text> : null}
        {subtitle ? <Text variant="caption" color={colors.textFaint}>{subtitle}</Text> : null}
      </View>
      {trailing ? (
        <Tap onPress={trailing.onPress} hitSlop={10}>
          <Text variant="label" color={colors.accent}>{trailing.label}</Text>
        </Tap>
      ) : null}
    </View>
  );
}

export function SectionBlock({ block, children }: B<'section'> & { children: ReactNode }) {
  const { dispatch } = useCanvas();
  return (
    <View>
      <SectionHeader
        title={block.title}
        subtitle={block.subtitle}
        trailing={block.trailing ? { label: block.trailing.label, onPress: () => void dispatch(block.trailing!.action) } : undefined}
      />
      <View style={block.style === 'card' ? styles.card : undefined}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  kvWrap: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 13, gap: 16 },
  kvBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  chips: { flexDirection: 'row', gap: space.sm, paddingHorizontal: 20 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, height: 34,
    borderRadius: radius.sm + 2, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgRaised,
  },
  notice: { flexDirection: 'row', gap: 12, padding: 14, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.hairline },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  stat: { flexGrow: 1, flexBasis: '45%', gap: 4, padding: 14, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.hairline },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 28, paddingHorizontal: 20 },
  emptyIcon: { width: 44, height: 44, borderRadius: 22, get backgroundColor() { return colors.accentSoft; }, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, borderWidth: 1, borderColor: colors.hairline, gap: space.lg },
});
