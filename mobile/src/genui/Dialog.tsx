import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { Tap } from '@/components/Pressable';
import { CanvasSkeleton } from '@/components/Skeleton';
import { Text } from '@/components/Text';
import { colors, fonts, radius, space } from '@/theme/tokens';
import { useCanvas } from './canvas';
import { Blocks } from './Renderer';
import type { Field } from './types';

function initialValues(fields: Field[] = []) {
  return Object.fromEntries(fields.map((f) => [f.name, f.value ?? (f.kind === 'toggle' ? false : '')]));
}

/** Converts raw input to what actions expect: numbers for amount/number, null for an empty amount. */
function typed(fields: Field[] = [], values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.name];
    if (f.kind === 'amount' || f.kind === 'number') {
      const s = String(v ?? '').replace(/[^\d.]/g, '');
      out[f.name] = s === '' ? null : Number(s);
    } else out[f.name] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

/** The one dialog of the app. Its content (blocks, fields, buttons) is chosen by the agent or by a template. */
export function DialogHost() {
  const { dialog, closeDialog, dispatch } = useCanvas();
  const insets = useSafeAreaInsets();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    setValues(initialValues(dialog?.fields));
    setBusy(null);
  }, [dialog]);

  const missing = (dialog?.fields ?? []).some((f) => f.required && (values[f.name] === '' || values[f.name] === undefined));
  const danger = dialog?.tone === 'danger';

  return (
    <Modal visible={!!dialog} transparent animationType="slide" onRequestClose={closeDialog} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={closeDialog} accessibilityLabel="Close" />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetWrap} pointerEvents="box-none">
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
          <View style={styles.handle} />
          <View style={styles.header}>
            {dialog?.icon ? (
              <View style={[styles.iconWrap, danger && { backgroundColor: colors.negativeSoft }]}>
                <Icon name={dialog.icon} size={18} color={danger ? colors.negative : colors.accent} />
              </View>
            ) : null}
            <Text variant="heading" style={{ flex: 1 }} numberOfLines={2}>{dialog?.title}</Text>
            <Tap onPress={closeDialog} hitSlop={12} style={styles.close} accessibilityLabel="Close">
              <Icon name="close" size={16} color={colors.textMuted} />
            </Tap>
          </View>
          <ScrollView style={{ maxHeight: 620 }} contentContainerStyle={{ gap: space.lg, paddingBottom: 4 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            {dialog?.loading ? <CanvasSkeleton /> : null}
            {dialog?.message ? <Text variant="body" color={colors.textMuted}>{dialog.message}</Text> : null}
            {dialog?.blocks?.length ? <Blocks blocks={dialog.blocks} gap={space.xl} animate={false} /> : null}

            {(dialog?.fields ?? []).map((f) => (
              <View key={f.name} style={{ gap: 6 }}>
                <Text variant="label" color={colors.textMuted}>{f.label}</Text>
                {f.kind === 'toggle' ? (
                  <Switch value={!!values[f.name]} onValueChange={(v) => setValues((s) => ({ ...s, [f.name]: v }))} trackColor={{ true: colors.accent, false: colors.border }} thumbColor={colors.ivory} {...({ activeThumbColor: colors.ivory } as object)} />
                ) : f.kind === 'select' ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {(f.options ?? []).map((o) => (
                      <Tap key={o.value} onPress={() => setValues((s) => ({ ...s, [f.name]: o.value }))} style={[styles.option, values[f.name] === o.value && styles.optionActive]}>
                        <Text variant="label" color={values[f.name] === o.value ? colors.onAccent : colors.text}>{o.label}</Text>
                      </Tap>
                    ))}
                  </View>
                ) : (
                  <TextInput
                    value={String(values[f.name] ?? '')}
                    onChangeText={(t) => setValues((s) => ({ ...s, [f.name]: t }))}
                    placeholder={f.placeholder}
                    placeholderTextColor={colors.textFaint}
                    keyboardType={f.kind === 'amount' ? 'decimal-pad' : f.kind === 'number' ? 'number-pad' : f.kind === 'email' ? 'email-address' : 'default'}
                    autoCapitalize={f.kind === 'email' ? 'none' : 'sentences'}
                    selectionColor={colors.accent}
                    style={styles.input}
                  />
                )}
              </View>
            ))}

            {dialog?.buttons?.length ? (
              <View style={{ gap: space.sm, marginTop: 4 }}>
                {dialog.buttons.map((b, i) => (
                  <Button
                    key={i}
                    label={b.label}
                    icon={b.icon}
                    variant={b.variant ?? (i === 0 ? 'primary' : 'secondary')}
                    loading={busy === i}
                    disabled={missing && b.action.type === 'run'}
                    onPress={async () => {
                      setBusy(i);
                      try {
                        await dispatch(b.action, typed(dialog.fields, values));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  />
                ))}
              </View>
            ) : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.overlay },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.bgRaised,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    borderWidth: 1,
    borderColor: colors.hairline,
    paddingHorizontal: 20,
    paddingTop: 10,
    gap: space.lg,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  handle: { alignSelf: 'center', width: 38, height: 4, borderRadius: 2, backgroundColor: colors.border },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconWrap: { width: 34, height: 34, borderRadius: 17, get backgroundColor() { return colors.accentSoft; }, alignItems: 'center', justifyContent: 'center' },
  close: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  input: {
    height: 50, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    paddingHorizontal: 14, color: colors.text, fontFamily: fonts.regular, fontSize: 16,
  },
  option: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  optionActive: { get backgroundColor() { return colors.accent; }, get borderColor() { return colors.accent; } },
});
