import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { Tabs } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Tap } from '@/components/Pressable';
import { Text } from '@/components/Text';
import { colors, fonts, GUTTER } from '@/theme/tokens';

/** Text-only tabs with an amber dot under the active one (as in the concept). */
function TabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
      {state.routes.map((route, index) => {
        const focused = state.index === index;
        const label = descriptors[route.key]?.options.title ?? route.name;
        return (
          <Tap
            key={route.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            onPress={() => {
              const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
              if (!focused && !event.defaultPrevented) navigation.navigate(route.name);
            }}
            style={styles.tab}
          >
            <Text style={{ fontFamily: focused ? fonts.semibold : fonts.medium, fontSize: 15 }} color={focused ? colors.text : colors.textFaint}>
              {label}
            </Text>
            {focused ? <Animated.View entering={FadeIn} style={styles.dot} /> : <View style={[styles.dot, { opacity: 0 }]} />}
          </Tap>
        );
      })}
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs tabBar={(props) => <TabBar {...props} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}>
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="cards" options={{ title: 'Cards' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    gap: 28,
    paddingTop: 12,
    paddingHorizontal: GUTTER + 4,
    backgroundColor: colors.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.hairline,
  },
  tab: { alignItems: 'center', gap: 5, paddingVertical: 2 },
  dot: { width: 5, height: 5, borderRadius: 2.5, get backgroundColor() { return colors.accent; } },
});
