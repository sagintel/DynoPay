import { useEffect } from 'react';
import { View, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { colors, radius } from '@/theme/tokens';

export function Skeleton({ style }: { style?: ViewStyle }) {
  const o = useSharedValue(0.35);
  useEffect(() => {
    o.value = withRepeat(withTiming(0.8, { duration: 750 }), -1, true);
  }, [o]);
  const a = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[{ backgroundColor: colors.surfaceHigh, borderRadius: radius.sm, height: 14 }, style, a]} />;
}

/** Placeholder canvas shown while the agent composes. */
export function CanvasSkeleton() {
  return (
    <View style={{ gap: 14, paddingTop: 8 }}>
      <Skeleton style={{ width: '45%', height: 40, borderRadius: radius.md }} />
      <Skeleton style={{ width: '70%' }} />
      <Skeleton style={{ height: 120, borderRadius: radius.lg }} />
      {[0, 1, 2].map((i) => (
        <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Skeleton style={{ width: '40%' }} />
          <Skeleton style={{ width: '20%' }} />
        </View>
      ))}
    </View>
  );
}
