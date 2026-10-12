import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import type { IconName } from '@/genui/types';
import { colors, fonts, radius } from '@/theme/tokens';
import { Icon } from './Icon';
import { haptic, Tap } from './Pressable';
import { Text } from './Text';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ivory';

const VARIANTS: Record<Variant, { bg: string; fg: string; border?: string }> = {
  primary: { get bg() { return colors.accent; }, fg: colors.onAccent },
  ivory: { bg: colors.ivory, fg: colors.onIvory },
  secondary: { bg: colors.surface, fg: colors.text, border: colors.hairline },
  ghost: { bg: 'transparent', fg: colors.text },
  danger: { get bg() { return colors.negativeSoft; }, get fg() { return colors.negative; }, get border() { return colors.negativeBorder; } },
};

export function Button({
  label,
  icon,
  variant = 'secondary',
  onPress,
  loading,
  disabled,
  fullWidth = true,
  size = 'md',
}: {
  label: string;
  icon?: IconName;
  variant?: Variant;
  onPress?: () => void;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  size?: 'md' | 'sm';
}) {
  const v = VARIANTS[variant];
  return (
    <Tap
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityLabel={label}
      style={[
        styles.base,
        size === 'sm' && styles.sm,
        { backgroundColor: v.bg, borderColor: v.border ?? 'transparent', opacity: disabled ? 0.45 : 1, alignSelf: fullWidth ? 'stretch' : 'flex-start' },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={v.fg} />
      ) : (
        <>
          {icon ? <Icon name={icon} size={size === 'sm' ? 15 : 17} color={v.fg} /> : null}
          <Text variant="bodyStrong" color={v.fg} style={[{ fontFamily: fonts.semibold }, size === 'sm' && { fontSize: 13.5 }]}>
            {label}
          </Text>
        </>
      )}
    </Tap>
  );
}

export type HoldState = 'idle' | 'working' | 'done' | 'error';

/**
 * "Hold to send": the user keeps a finger down while the fill sweeps across.
 * Releasing early cancels. Completion calls onConfirm (biometrics + server call happen there).
 */
export function HoldButton({
  label,
  doneLabel = 'Done',
  state,
  danger,
  onConfirm,
  durationMs = 1100,
}: {
  label: string;
  doneLabel?: string;
  state: HoldState;
  danger?: boolean;
  onConfirm: () => void;
  durationMs?: number;
}) {
  const progress = useSharedValue(0);
  const [width, setWidth] = useState(0);
  const fill = danger ? colors.negative : colors.accent;

  useEffect(() => {
    if (state === 'done') progress.value = withTiming(1, { duration: 180 });
    if (state === 'idle' || state === 'error') progress.value = withTiming(0, { duration: 250 });
  }, [state, progress]);

  const fired = useRef(false);
  useEffect(() => {
    if (state === 'idle' || state === 'error') fired.current = false;
  }, [state]);

  const fillStyle = useAnimatedStyle(() => ({ width: progress.value * width }));
  const complete = () => {
    if (fired.current) return;
    fired.current = true;
    progress.value = withTiming(1, { duration: 120 });
    haptic('success');
    onConfirm();
  };

  const busy = state === 'working' || state === 'done';
  const text = state === 'done' ? doneLabel : state === 'working' ? 'Confirming…' : label;
  const fg = state === 'done' ? colors.onAccent : colors.onIvory;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Press and hold to confirm"
      disabled={busy}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      accessibilityActions={[{ name: 'activate', label }]}
      onAccessibilityAction={(e) => e.nativeEvent.actionName === 'activate' && complete()}
      // The long-press timer is the source of truth; the sweep only visualises it.
      delayLongPress={durationMs}
      onLongPress={complete}
      onPressIn={() => {
        haptic('light');
        cancelAnimation(progress);
        progress.value = withTiming(1, { duration: durationMs, easing: Easing.linear });
      }}
      onPressOut={() => {
        if (!fired.current && (state === 'idle' || state === 'error')) {
          cancelAnimation(progress);
          progress.value = withTiming(0, { duration: 220 });
        }
      }}
      style={[styles.hold, { backgroundColor: colors.ivory }]}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: fill, borderRadius: radius.md }, fillStyle]} />
      <View style={styles.holdLabel}>
        {state === 'working' ? <ActivityIndicator color={colors.onIvory} size="small" /> : <Icon name={state === 'done' ? 'check' : 'bolt'} size={16} color={fg} />}
        <Text variant="bodyStrong" color={fg} style={{ fontFamily: fonts.semibold }}>
          {text}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 50,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  sm: { minHeight: 38, paddingHorizontal: 12, borderRadius: radius.sm + 2 },
  hold: { height: 54, borderRadius: radius.md, overflow: 'hidden', justifyContent: 'center' },
  holdLabel: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
});
