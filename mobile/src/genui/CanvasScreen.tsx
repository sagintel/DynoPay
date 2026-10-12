import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { IntentStrip } from '@/components/IntentStrip';
import { PromptBar, type PromptBarHandle } from '@/components/PromptBar';
import { Tap } from '@/components/Pressable';
import { CanvasSkeleton } from '@/components/Skeleton';
import { Text } from '@/components/Text';
import { useI18n } from '@/i18n/context';
import { useSession } from '@/lib/session';
import { colors, fonts, GUTTER, space } from '@/theme/tokens';
import { CanvasProvider, useCanvas } from './canvas';
import { DialogHost } from './Dialog';
import { BlockView, Blocks } from './Renderer';

function Header({ title }: { title?: string }) {
  const { user } = useSession();
  const { dispatch } = useCanvas();
  return (
    <View style={styles.header}>
      <Text style={{ fontFamily: fonts.bold, fontSize: 21, letterSpacing: -0.5 }}>
        {title ?? 'Dyno'}
        <Text style={{ fontFamily: fonts.bold, fontSize: 21 }} color={colors.accent}>.</Text>
      </Text>
      <Tap onPress={() => void dispatch({ type: 'open', kind: 'profile' })} style={styles.me} accessibilityLabel="Your profile">
        <Text variant="label" style={{ fontFamily: fonts.semibold }}>{user?.initials ?? '··'}</Text>
      </Tap>
    </View>
  );
}

function Canvas({ title, placeholder }: { title?: string; placeholder?: string }) {
  const insets = useSafeAreaInsets();
  const c = useCanvas();
  const { t } = useI18n();
  const bar = useRef<PromptBarHandle>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    c.registerPrefill((text) => bar.current?.setText(text));
  }, [c]);

  // Pick up layout changes made elsewhere (e.g. redesigned in Settings) without discarding an agent result.
  const firstFocus = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      if (c.mode === 'default' && !c.loading) void c.reset();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [c.mode, c.loading]),
  );

  // Live agent: debounce keystrokes into preview requests (each new one cancels the previous).
  const { user } = useSession();
  const live = user?.settings.liveAgent !== false;
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeText = useCallback(
    (text: string) => {
      if (debounce.current) clearTimeout(debounce.current);
      const trimmed = text.trim();
      if (!trimmed) {
        void c.preview('');
        return;
      }
      if (!live || trimmed.length < 3) return;
      debounce.current = setTimeout(() => void c.preview(text), 600);
    },
    [c, live],
  );
  useEffect(() => () => void (debounce.current && clearTimeout(debounce.current)), []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await c.refresh();
    setRefreshing(false);
  }, [c]);

  const blocks = c.spec?.blocks ?? [];
  // Like the concept: on the default home the prompt bar sits under the balance arc; results move it to the top.
  const splitAt = c.mode === 'default' && blocks[0]?.type === 'balance' ? 1 : 0;
  const head = blocks.slice(0, splitAt);
  const rest = blocks.slice(splitAt);

  const promptBar = (
    <Animated.View layout={LinearTransition.springify().damping(22)}>
      <PromptBar
        ref={bar}
        onSubmit={(text) => {
          if (debounce.current) clearTimeout(debounce.current);
          void c.ask(text);
        }}
        onChangeText={onChangeText}
        loading={c.loading || c.previewing}
        status={c.error || c.rejection ? null : c.status}
        people={c.people}
        entities={c.entities}
        placeholder={placeholder}
        rejection={c.rejection}
        understood={c.intent}
      />
      {/* What the app understood from the sentence: action, amount, who, what for… */}
      {!c.rejection ? <View style={{ marginTop: space.sm }}><IntentStrip intent={c.intent} /></View> : null}
    </Animated.View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 6, paddingHorizontal: GUTTER, paddingBottom: 120, gap: space.xl, maxWidth: 640, width: '100%', alignSelf: 'center' }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        <Header title={title} />
        {head.map((b, i) => (
          <Animated.View key={`head${i}`} entering={FadeIn.duration(300)}>
            <BlockView block={b} />
          </Animated.View>
        ))}
        {promptBar}

        {c.mode === 'result' && !c.loading && (c.spec?.blocks.length ?? 0) > 0 ? (
          <Animated.View entering={FadeInDown} style={styles.resultBar}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 }}>
              {c.engine && c.engine !== 'none' && c.engine !== 'guard' ? (
                <View style={styles.engine}>
                  <Icon name={c.engine === 'cache' ? 'bolt' : c.engine === 'offline' ? 'shield' : 'sparkle'} size={11} color={colors.accent} />
                  <Text variant="tiny" color={colors.accent}>{c.engine === 'cache' ? 'From cache · 0 tokens' : c.engine === 'offline' ? 'On-device' : 'AI'}</Text>
                </View>
              ) : null}
              {c.spec?.title ? <Text variant="label" color={colors.textMuted} numberOfLines={1}>{c.spec.title}</Text> : null}
            </View>
            <View style={{ flexDirection: 'row', gap: 14 }}>
              <Tap onPress={() => void c.dispatch({ type: 'pin', slot: c.screen })} hitSlop={8} style={styles.resultAction}>
                <Icon name="star" size={13} color={colors.textMuted} />
                <Text variant="tiny" color={colors.textMuted}>{t('Keep as {x}', { x: t(c.screen === 'home' ? 'Home' : 'Cards') })}</Text>
              </Tap>
              <Tap onPress={() => void c.reset({ forget: true })} hitSlop={8} style={styles.resultAction} accessibilityLabel="Back to default view">
                <Icon name="close" size={13} color={colors.textMuted} />
                <Text variant="tiny" color={colors.textMuted}>Clear</Text>
              </Tap>
            </View>
          </Animated.View>
        ) : null}

        {c.error ? (
          <Animated.View entering={FadeIn} style={{ gap: space.md }}>
            <Text variant="body" color={colors.negative} style={{ textAlign: 'center' }}>{c.error}</Text>
            <Button label="Back to overview" variant="secondary" onPress={() => void c.reset({ forget: true })} />
          </Animated.View>
        ) : null}

        {c.loading ? (
          <CanvasSkeleton />
        ) : !c.spec && !c.error ? (
          <CanvasSkeleton />
        ) : (
          <Blocks key={`${c.mode}:${c.spec?.say ?? ''}:${blocks.length}`} blocks={rest} />
        )}
      </ScrollView>
      <DialogHost />
    </View>
  );
}

/** A UI-less screen: the agent decides what appears here. */
export function CanvasScreen({ screen, title, placeholder }: { screen: 'home' | 'cards'; title?: string; placeholder?: string }) {
  return (
    <CanvasProvider screen={screen}>
      <Canvas title={title} placeholder={placeholder} />
    </CanvasProvider>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', height: 44 },
  me: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.border, alignItems: 'center', justifyContent: 'center' },
  resultBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: -8 },
  resultAction: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  engine: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 999, get backgroundColor() { return colors.accentSoft; } },
});
