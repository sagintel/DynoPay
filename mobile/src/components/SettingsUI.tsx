import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { colors, radius } from '@/theme/tokens';
import { Icon } from './Icon';
import { Tap } from './Pressable';
import { Text } from './Text';

export function Section({ title, footer, children }: { title: string; footer?: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text variant="label" color={colors.textMuted}>{title}</Text>
      <View style={styles.group}>{children}</View>
      {footer ? <Text variant="caption" color={colors.textFaint}>{footer}</Text> : null}
    </View>
  );
}

export function Row({
  icon,
  title,
  subtitle,
  right,
  onPress,
  last,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  title: string;
  subtitle?: string;
  right?: ReactNode;
  onPress?: () => void;
  last?: boolean;
}) {
  const body = (
    <View style={[styles.row, !last && styles.rowBorder]}>
      <Icon name={icon} size={18} color={colors.textMuted} />
      <View style={{ flex: 1, gap: 1 }}>
        <Text variant="bodyStrong">{title}</Text>
        {subtitle ? <Text variant="caption" color={colors.textMuted}>{subtitle}</Text> : null}
      </View>
      {right ?? (onPress ? <Icon name="chevron-right" size={16} color={colors.textFaint} /> : null)}
    </View>
  );
  return onPress ? <Tap onPress={onPress} scaleTo={0.99}>{body}</Tap> : body;
}

/** Segmented control (one choice among a few). */
export function Segment<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string; disabled?: boolean }[]; onChange: (v: T) => void }) {
  return (
    <View style={styles.segment} accessibilityRole="radiogroup">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <Tap
            key={o.value}
            disabled={o.disabled}
            accessibilityRole="radio"
            accessibilityState={{ selected: active, disabled: o.disabled }}
            onPress={() => onChange(o.value)}
            style={[styles.segmentItem, active && { backgroundColor: colors.accent }, o.disabled && { opacity: 0.35 }]}
          >
            <Text variant="label" color={active ? colors.onAccent : colors.text} numberOfLines={1}>{o.label}</Text>
          </Tap>
        );
      })}
    </View>
  );
}

export const settingsStyles = StyleSheet.create({
  padded: { padding: 14, gap: 10 },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
});

const styles = StyleSheet.create({
  group: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.hairline, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 14 },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  segment: { flexDirection: 'row', backgroundColor: colors.bg, borderRadius: radius.md, padding: 4, gap: 4 },
  segmentItem: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: radius.sm },
});
