import { type ReactNode, useCallback, useRef, useState } from 'react';
import { LayoutAnimation, Platform, StyleSheet, UIManager, View } from 'react-native';
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { colors, fonts, radius } from '@/theme/tokens';
import { Icon } from './Icon';
import { Tap } from './Pressable';
import { Text } from './Text';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ─── Accordion ───────────────────────────────────────────────────────────────

type AccordionProps = {
  /** Short label shown in the collapsed header. */
  title: string;
  /** Small subtitle shown in the header (e.g. current value summary). */
  subtitle?: string;
  /** Icon name for the left side of the header. */
  icon: Parameters<typeof Icon>[0]['name'];
  /** Start expanded. */
  defaultOpen?: boolean;
  children: ReactNode;
};

/**
 * Animated expand / collapse panel.
 * Uses LayoutAnimation for height (works on both platforms without measuring)
 * and a Reanimated shared value for the chevron rotation only.
 */
export function Accordion({ title, subtitle, icon, defaultOpen = false, children }: AccordionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const chevronAngle = useSharedValue(defaultOpen ? 180 : 0);

  const toggle = useCallback(() => {
    LayoutAnimation.configureNext({
      duration: 260,
      create: { type: 'easeInEaseOut', property: 'opacity' },
      update: { type: 'spring', springDamping: 0.78 },
      delete: { type: 'easeInEaseOut', property: 'opacity' },
    });
    setOpen((v) => {
      chevronAngle.value = withSpring(v ? 0 : 180, { damping: 18, stiffness: 160 });
      return !v;
    });
  }, [chevronAngle]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${chevronAngle.value}deg` }],
  }));

  return (
    <View style={[styles.accordion, open && styles.accordionOpen]}>
      {/* Header — always visible */}
      <Tap onPress={toggle} style={styles.accordionHeader} scaleTo={0.99} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <View style={styles.accordionIcon}>
          <Icon name={icon} size={17} color={open ? colors.accent : colors.textMuted} />
        </View>
        <View style={{ flex: 1, gap: 1 }}>
          <Text variant="bodyStrong" color={open ? colors.text : colors.text}>{title}</Text>
          {subtitle ? <Text variant="caption" color={colors.textFaint} numberOfLines={1}>{subtitle}</Text> : null}
        </View>
        <Animated.View style={chevronStyle}>
          <Icon name="arrow-down" size={16} color={colors.textFaint} />
        </Animated.View>
      </Tap>

      {/* Body — shown only when open */}
      {open ? (
        <Animated.View entering={FadeIn.duration(180)} style={styles.accordionBody}>
          {children}
        </Animated.View>
      ) : null}
    </View>
  );
}

// ─── Section ─────────────────────────────────────────────────────────────────

export function Section({ title, footer, children }: { title: string; footer?: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text variant="label" color={colors.textMuted}>{title}</Text>
      <View style={styles.group}>{children}</View>
      {footer ? <Text variant="caption" color={colors.textFaint}>{footer}</Text> : null}
    </View>
  );
}

// ─── Row ─────────────────────────────────────────────────────────────────────

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

// ─── Segment ─────────────────────────────────────────────────────────────────

/** Segmented control (one choice among a few). */
export function Segment<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
}) {
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

// ─── Shared padded / border helpers ──────────────────────────────────────────

export const settingsStyles = StyleSheet.create({
  padded: { padding: 14, gap: 10 },
  rowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
});

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
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
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  accordionIcon: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    get backgroundColor() { return colors.surfaceHigh; },
    alignItems: 'center',
    justifyContent: 'center',
  },
  accordionBody: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  // Section (inside accordion body)
  group: {
    backgroundColor: colors.bgRaised,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.hairline,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  // Segment
  segment: {
    flexDirection: 'row',
    get backgroundColor() { return colors.bg; },
    borderRadius: radius.md,
    padding: 4,
    gap: 4,
  },
  segmentItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 9,
    borderRadius: radius.sm,
  },
});
