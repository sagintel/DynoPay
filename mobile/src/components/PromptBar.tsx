import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Text as RNText, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import type { Entity, Intent } from '@/genui/types';
import { useI18n } from '@/i18n/context';
import { colors, fonts, radius } from '@/theme/tokens';
import { Icon } from './Icon';
import { Tap } from './Pressable';
import { Text } from './Text';

export type PromptBarHandle = { focus: () => void; setText: (t: string) => void; clear: () => void };

type Span = { text: string; kind?: Entity['kind'] };

/** Splits the sentence into styled spans: amounts and people get a soft amber chip, the purpose an underline. */
function highlight(value: string, people: string[], serverEntities: Entity[], understood: Intent | null): Span[] {
  const marks: { start: number; end: number; kind: Entity['kind'] }[] = [];
  const add = (start: number, end: number, kind: Entity['kind']) => {
    if (end > start && !marks.some((m) => start < m.end && end > m.start)) marks.push({ start, end, kind });
  };
  const lower = value.toLowerCase();
  // What the server understood points at the exact words typed (any language).
  for (const part of understood?.parts ?? []) {
    if (!('text' in part) || !part.text || part.kind === 'action') continue;
    const i = lower.indexOf(part.text.toLowerCase());
    if (i >= 0) add(i, i + part.text.length, part.kind === 'amount' ? 'amount' : part.kind === 'person' ? 'person' : part.kind === 'card' ? 'card' : 'purpose');
  }
  for (const e of serverEntities) {
    const i = lower.indexOf(e.text.toLowerCase());
    if (i >= 0) add(i, i + e.text.length, e.kind);
  }
  for (const m of value.matchAll(/(?<![\w.])\d{1,3}(?:[,\d]{0,12})(?:\.\d{1,2})?(?![\w])/g)) add(m.index!, m.index! + m[0].length, 'amount');
  for (const name of people) {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const m = re.exec(value);
    if (m) add(m.index, m.index + m[0].length, 'person');
  }
  const purpose = /\bfor\s+(.+)$/i.exec(value);
  if (purpose) add(purpose.index + purpose[0].length - purpose[1]!.length, value.length, 'purpose');

  marks.sort((a, b) => a.start - b.start);
  const spans: Span[] = [];
  let cursor = 0;
  for (const m of marks) {
    if (m.start > cursor) spans.push({ text: value.slice(cursor, m.start) });
    spans.push({ text: value.slice(m.start, m.end), kind: m.kind });
    cursor = m.end;
  }
  if (cursor < value.length) spans.push({ text: value.slice(cursor) });
  return spans;
}

export const PromptBar = forwardRef<
  PromptBarHandle,
  {
    onSubmit: (text: string) => void;
    /** Every change of the text (drives the live, as-you-type agent). */
    onChangeText?: (text: string) => void;
    loading?: boolean;
    status?: string | null;
    people?: string[];
    entities?: Entity[];
    placeholder?: string;
    /** The request can't be fulfilled: red border and this message under the bar (nothing ran). */
    rejection?: string | null;
    /** What the app understood (its words are highlighted in the sentence). */
    understood?: Intent | null;
  }
>(function PromptBar({ onSubmit, onChangeText, loading, status, people = [], entities = [], placeholder = 'Write what happens next', rejection, understood = null }, ref) {
  const { t, rtl } = useI18n();
  const input = useRef<TextInput>(null);
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);

  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    setText: (t: string) => {
      setValue(t);
      onChangeText?.(t);
      setTimeout(() => input.current?.focus(), 30);
    },
    clear: () => {
      setValue('');
      onChangeText?.('');
    },
  }));

  const spans = useMemo(() => highlight(value, people, entities, understood), [value, people, entities, understood]);
  // Web inputs can't style their own text: the highlighted sentence is drawn behind a transparent
  // input (same font and padding) and follows its horizontal scroll.
  const overlay = Platform.OS === 'web' && !rtl && !!value;
  const [scrollX, setScrollX] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const el = input.current as unknown as HTMLInputElement | null;
    if (!el?.addEventListener) return;
    const sync = () => setScrollX(el.scrollLeft);
    el.addEventListener('scroll', sync);
    el.addEventListener('input', sync);
    el.addEventListener('keyup', sync);
    return () => {
      el.removeEventListener('scroll', sync);
      el.removeEventListener('input', sync);
      el.removeEventListener('keyup', sync);
    };
  }, []);
  const active = focused || !!value;
  const rejected = !!rejection;
  const [accent, negative, idle] = [colors.accent, colors.negative, colors.border];
  const border = useAnimatedStyle(() => ({
    borderColor: withTiming(rejected ? negative : active ? accent : idle, { duration: 180 }),
    shadowColor: rejected ? negative : accent,
    shadowOpacity: withTiming(rejected || active ? 0.45 : 0, { duration: 180 }),
  }));

  const submit = () => {
    const text = value.trim();
    if (!text || loading) return;
    input.current?.blur();
    onSubmit(text);
  };

  return (
    <View style={{ gap: 8 }}>
      <Animated.View style={[styles.bar, border]}>
        <View style={styles.field}>
        {overlay ? (
          <View pointerEvents="none" style={styles.overlay} aria-hidden>
            <RNText numberOfLines={1} style={[styles.inputText, styles.overlayText, { transform: [{ translateX: -scrollX }] }]}>
              {spans.map((s, i) => (
                <RNText key={i} style={s.kind === 'amount' || s.kind === 'person' || s.kind === 'card' ? styles.chip : s.kind === 'purpose' ? styles.purpose : null}>
                  {s.text}
                </RNText>
              ))}
            </RNText>
          </View>
        ) : null}
        <TextInput
          ref={input}
          onChangeText={(t) => {
            setValue(t);
            onChangeText?.(t);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onSubmitEditing={submit}
          placeholder={t(placeholder)}
          placeholderTextColor={colors.textMuted}
          returnKeyType="send"
          enterKeyHint="send"
          autoCorrect={false}
          selectionColor={colors.accent}
          cursorColor={colors.accent}
          maxLength={500}
          accessibilityLabel={t('Tell DynoPay what to do')}
          accessibilityHint={rejection ?? undefined}
          style={[styles.input, rtl && { textAlign: 'right', writingDirection: 'rtl' }, overlay && styles.inputOverlaid]}
          {...(Platform.OS === 'web' ? { value } : {})}
        >
          {Platform.OS === 'web'
            ? undefined
            : spans.map((s, i) => (
                // Plain RN text: what the user typed is never translated.
                <RNText
                  key={i}
                  style={[
                    styles.inputText,
                    s.kind === 'amount' || s.kind === 'person' || s.kind === 'card' ? styles.chip : null,
                    s.kind === 'purpose' ? styles.purpose : null,
                  ]}
                >
                  {s.text}
                </RNText>
              ))}
        </TextInput>
        </View>
        <Tap onPress={submit} disabled={!value.trim() || loading} style={[styles.send, value.trim() ? styles.sendActive : null]} accessibilityLabel="Send">
          {loading ? <ActivityIndicator size="small" color={colors.onAccent} /> : <Icon name={value.trim() ? 'arrow-up' : 'sparkle'} size={16} color={value.trim() ? colors.onAccent : colors.textMuted} />}
        </Tap>
      </Animated.View>
      {rejection ? (
        <Animated.View key={`r:${rejection}`} entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)} style={styles.rejection} accessibilityLiveRegion="polite" accessibilityRole="alert">
          <Icon name="warning" size={14} color={colors.negative} />
          <Text variant="caption" color={colors.negative} style={{ flex: 1 }}>
            {rejection}
          </Text>
        </Animated.View>
      ) : status ? (
        <Animated.View key={status} entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)} style={styles.status}>
          {loading ? <View style={styles.dot} /> : null}
          <Text variant="caption" color={colors.textMuted} style={{ textAlign: 'center' }}>
            {status}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 54,
    borderRadius: radius.lg,
    borderWidth: 1,
    backgroundColor: colors.surface,
    paddingLeft: 16,
    paddingRight: 7,
    get shadowColor() { return colors.accent; },
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
  },
  input: { flex: 1, color: colors.text, fontFamily: fonts.regular, fontSize: 16.5, paddingVertical: 14, ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : {}) },
  inputText: { color: colors.text, fontFamily: fonts.regular, fontSize: 16.5 },
  field: { flex: 1, position: 'relative', overflow: 'hidden' },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'center' },
  overlayText: { ...(Platform.OS === 'web' ? ({ whiteSpace: 'pre' } as object) : {}) },
  // The real input stays on top for typing and the caret; its own text is drawn by the overlay.
  inputOverlaid: { color: 'transparent', ...(Platform.OS === 'web' ? ({ caretColor: colors.accent } as object) : {}) },
  chip: { get backgroundColor() { return colors.chip; }, color: colors.text, borderRadius: 4 },
  purpose: { textDecorationLine: 'underline', get textDecorationColor() { return colors.accent; } },
  send: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  sendActive: { get backgroundColor() { return colors.accent; } },
  status: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3, get backgroundColor() { return colors.accent; } },
  rejection: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingHorizontal: 4 },
});
