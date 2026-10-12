import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import type { Intent, IntentPart } from '@/genui/types';
import { useI18n } from '@/i18n/context';
import { appearance, colors, fonts, radius } from '@/theme/tokens';
import { Icon } from './Icon';
import { Text } from './Text';

/**
 * The main elements the app understood from the sentence, as the user types it:
 *   [ Send ]  [ $500.00 ]  [ (SN) Sara Nasser ]  [ for Dinner ]
 * People are resolved against the user's contacts (or shown as a PayPal email), and anything
 * still missing is shown as a dashed chip (“How much?”), so the user feels understood before confirming.
 */
export function IntentStrip({ intent }: { intent: Intent | null }) {
  const { t } = useI18n();
  if (!intent?.parts.length) return null;
  const reduced = appearance.motion === 'reduced';
  return (
    <View style={styles.row} accessibilityRole="summary" accessibilityLabel={t('Understood')}>
      {intent.parts.map((part, i) => (
        <Animated.View
          key={`${part.kind}:${part.label}`}
          entering={reduced ? undefined : FadeIn.duration(220).delay(i * 50)}
          exiting={reduced ? undefined : FadeOut.duration(120)}
          layout={reduced ? undefined : LinearTransition.springify().damping(20)}
        >
          <Chip part={part} />
        </Animated.View>
      ))}
    </View>
  );
}

function Chip({ part }: { part: IntentPart }) {
  const { t } = useI18n();
  switch (part.kind) {
    case 'action':
      return (
        <View style={[styles.chip, styles.action]}>
          <Icon name="send" size={13} color={colors.onAccent} />
          <Text variant="label" color={colors.onAccent} style={styles.strong}>{part.label}</Text>
        </View>
      );
    case 'amount':
      return (
        <View style={[styles.chip, styles.filled]}>
          <Text style={styles.amount}>{part.label}</Text>
        </View>
      );
    case 'person': {
      const unsure = part.status === 'ambiguous' || part.status === 'unknown';
      return (
        <View style={[styles.chip, styles.filled, unsure && styles.unsure]}>
          {part.status === 'email' ? (
            <Icon name="paypal" size={14} color={colors.accent} />
          ) : (
            <View style={styles.avatar}>
              <Text style={styles.initials}>{part.initials ?? part.label.slice(0, 2).toUpperCase()}</Text>
            </View>
          )}
          <View>
            <Text variant="label" style={styles.strong} numberOfLines={1}>{part.label}</Text>
            {part.status === 'ambiguous' ? (
              <Text variant="tiny" color={colors.warning}>{t('{x} matches · pick below', { x: part.candidates ?? 2 })}</Text>
            ) : part.status === 'unknown' ? (
              <Text variant="tiny" color={colors.warning}>{t('Not in your contacts')}</Text>
            ) : part.subtitle ? (
              <Text variant="tiny" color={colors.textMuted} numberOfLines={1}>{part.subtitle}</Text>
            ) : null}
          </View>
        </View>
      );
    }
    case 'card':
      return (
        <View style={[styles.chip, styles.filled]}>
          <Icon name="card" size={14} color={colors.accent} />
          <Text variant="label" style={styles.strong}>{part.label}</Text>
          {part.subtitle ? <Text variant="tiny" color={colors.textMuted}>{part.subtitle}</Text> : null}
        </View>
      );
    case 'purpose':
      return (
        <View style={[styles.chip, styles.outline]}>
          <Text variant="label" color={colors.textMuted}>{t('for')}</Text>
          <Text variant="label" style={[styles.strong, styles.underline]}>{part.label}</Text>
        </View>
      );
    case 'missing':
      return (
        <View style={[styles.chip, styles.missing]}>
          <Text variant="label" color={colors.textMuted}>{part.label}</Text>
        </View>
      );
  }
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32, paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill },
  action: { get backgroundColor() { return colors.accent; } },
  filled: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.hairline },
  outline: { borderWidth: 1, borderColor: colors.hairline },
  missing: { borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border },
  unsure: { borderColor: colors.warning },
  strong: { fontFamily: fonts.semibold },
  amount: { fontFamily: fonts.bold, fontSize: 15, letterSpacing: -0.2, color: colors.text },
  underline: { textDecorationLine: 'underline', get textDecorationColor() { return colors.accent; } },
  avatar: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
  initials: { fontFamily: fonts.semibold, fontSize: 9.5, color: colors.accent },
});
