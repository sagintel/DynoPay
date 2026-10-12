import * as Haptics from 'expo-haptics';
import { Platform, Pressable as RNPressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useI18n } from '@/i18n/context';

const AnimatedPressable = Animated.createAnimatedComponent(RNPressable);

let hapticsEnabled = true;
export const setHapticsEnabled = (on: boolean) => {
  hapticsEnabled = on;
};

export function haptic(kind: 'light' | 'success' | 'warning' | 'error' | 'select' = 'light') {
  if (Platform.OS === 'web' || !hapticsEnabled) return;
  if (kind === 'select') void Haptics.selectionAsync();
  else if (kind === 'light') void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  else void Haptics.notificationAsync(kind === 'success' ? Haptics.NotificationFeedbackType.Success : kind === 'warning' ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Error);
}

/** Pressable with a subtle spring scale and haptic tick — the single touch primitive of the app. */
export function Tap({ style, scaleTo = 0.97, onPressIn, onPressOut, onPress, haptics = true, accessibilityLabel, ...rest }: Omit<PressableProps, 'style'> & { style?: StyleProp<ViewStyle>; scaleTo?: number; haptics?: boolean }) {
  const { lookup } = useI18n();
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ? lookup(accessibilityLabel) : undefined}
      {...rest}
      onPressIn={(e) => {
        scale.value = withSpring(scaleTo, { damping: 20, stiffness: 400 });
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.value = withSpring(1, { damping: 18, stiffness: 300 });
        onPressOut?.(e);
      }}
      onPress={(e) => {
        if (haptics) haptic('light');
        onPress?.(e);
      }}
      style={[style, animated]}
    />
  );
}
