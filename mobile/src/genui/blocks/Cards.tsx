import { tr } from '@/i18n/context';
import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { Tap } from '@/components/Pressable';
import { Text } from '@/components/Text';
import { money } from '@/lib/format';
import { cardThemes, colors, fonts, radius, shadow, space } from '@/theme/tokens';
import { useCanvas } from '../canvas';
import type { Action, Block, Card } from '../types';
import { EmptyBlock, KeyValueRow } from './Primitives';

export function CardFace({ card, width }: { card: Card; width: number }) {
  const t = cardThemes[card.color] ?? cardThemes.graphite!;
  const frozen = card.status === 'frozen';
  return (
    <View style={[{ width, height: width / 1.586, borderRadius: radius.xl, overflow: 'hidden' }, shadow]}>
      <LinearGradient colors={[t.from, t.to]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[StyleSheet.absoluteFill, { padding: 20, justifyContent: 'space-between' }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontFamily: fonts.bold, fontSize: 18, letterSpacing: -0.4 }} color={t.text}>
            Dyno<Text style={{ fontFamily: fonts.bold, fontSize: 18 }} color={card.color === 'amber' ? t.text : colors.accent}>.</Text>
          </Text>
          <Text variant="label" color={t.muted}>{card.label}</Text>
        </View>
        <View style={{ gap: 4 }}>
          <Text variant="caption" color={t.muted}>Balance</Text>
          <Text style={{ fontFamily: fonts.bold, fontSize: 24, letterSpacing: -0.6 }} color={t.text}>{card.formattedBalance}</Text>
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Text style={{ fontFamily: fonts.medium, fontSize: 15, letterSpacing: 2 }} color={t.text}>•••• {card.last4}</Text>
          <Text variant="label" color={t.muted}>{card.expiry}</Text>
        </View>
      </LinearGradient>
      {frozen ? (
        <View style={[StyleSheet.absoluteFill, styles.frozen]}>
          <View style={styles.frozenPill}>
            <Icon name="lock" size={14} color={colors.text} />
            <Text variant="label">Frozen</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function cardActions(card: Card): { label: string; icon: 'lock' | 'unlock' | 'plus' | 'shield' | 'card'; action: Action }[] {
  return [
    card.status === 'frozen'
      ? { label: 'Unfreeze', icon: 'unlock', action: { type: 'run', action: 'unfreeze_card', input: { cardId: card.id } } }
      : { label: 'Freeze', icon: 'lock', action: { type: 'run', action: 'freeze_card', input: { cardId: card.id } } },
    { label: 'Add money', icon: 'plus', action: { type: 'prefill', text: tr('Fund {x} with ', { x: card.label }) } },
    {
      label: 'Limit',
      icon: 'shield',
      action: {
        type: 'dialog',
        dialog: {
          title: 'Monthly limit',
          message: tr('Spending cap for {x}. Leave empty for no limit.', { x: card.label }),
          fields: [{ name: 'limit', label: tr('Limit'), kind: 'amount', value: card.monthlyLimit ?? undefined, placeholder: tr('No limit') }],
          buttons: [{ label: 'Save limit', variant: 'primary', action: { type: 'run', action: 'update_card', input: { cardId: card.id, monthlyLimit: '$field.limit' } } }],
        },
      },
    },
    { label: 'Details', icon: 'card', action: { type: 'open', kind: 'card', id: card.id } },
  ];
}

function ActionRow({ card }: { card: Card }) {
  const { dispatch } = useCanvas();
  return (
    <View style={styles.actions}>
      {cardActions(card).map((a) => (
        <Tap key={a.label} onPress={() => void dispatch(a.action)} style={styles.actionItem} accessibilityLabel={a.label}>
          <View style={styles.actionIcon}>
            <Icon name={a.icon} size={17} />
          </View>
          <Text variant="tiny" color={colors.textMuted}>{a.label}</Text>
        </Tap>
      ))}
    </View>
  );
}

export function CardsBlock({ block }: { block: Extract<Block, { type: 'cards' }> }) {
  const { dispatch } = useCanvas();
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(0);
  const cards = block.data ?? [];
  if (!cards.length) {
    return (
      <Tap onPress={() => void dispatch({ type: 'ask', prompt: 'Create a new virtual card' })}>
        <EmptyBlock block={{ type: 'empty', title: 'No cards yet', text: 'Tap to create your first virtual card.', icon: 'card' }} />
      </Tap>
    );
  }
  const variant = block.variant ?? 'carousel';

  if (variant === 'list') {
    return (
      <View>
        {cards.map((c, i) => (
          <Tap key={c.id} onPress={() => void dispatch({ type: 'open', kind: 'card', id: c.id })} style={[styles.listRow, i < cards.length - 1 && styles.divider]}>
            <View style={[styles.swatch, { backgroundColor: (cardThemes[c.color] ?? cardThemes.graphite!).from }]} />
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong">{c.label} ·· {c.last4}</Text>
              <Text variant="caption" color={colors.textMuted}>{c.status === 'frozen' ? 'Frozen' : c.monthlyLimit ? `${money(c.spentThisMonth, c.currency)} of ${money(c.monthlyLimit, c.currency)} this month` : 'No limit'}</Text>
            </View>
            <Text variant="bodyStrong">{c.formattedBalance}</Text>
          </Tap>
        ))}
      </View>
    );
  }

  if (variant === 'stack') {
    return (
      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ height: width ? width / 1.586 + (cards.length - 1) * 46 : 0 }}>
        {width > 0
          ? cards.map((c, i) => (
              <Tap key={c.id} onPress={() => void dispatch({ type: 'open', kind: 'card', id: c.id })} style={{ position: 'absolute', top: i * 46, left: 0 }}>
                <CardFace card={c} width={width} />
              </Tap>
            ))
          : null}
      </View>
    );
  }

  const cardWidth = width - 28;
  const current = cards[Math.min(index, cards.length - 1)]!;
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ gap: space.lg }}>
      {width > 0 ? (
        <FlatList
          data={cards}
          horizontal
          keyExtractor={(c) => c.id}
          showsHorizontalScrollIndicator={false}
          snapToInterval={cardWidth + 12}
          decelerationRate="fast"
          contentContainerStyle={{ gap: 12 }}
          onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / (cardWidth + 12)))}
          renderItem={({ item }) => (
            <Tap onPress={() => void dispatch({ type: 'open', kind: 'card', id: item.id })} scaleTo={0.985}>
              <CardFace card={item} width={cardWidth} />
            </Tap>
          )}
        />
      ) : null}
      {cards.length > 1 ? (
        <View style={styles.dots}>
          {cards.map((c, i) => (
            <View key={c.id} style={[styles.pageDot, i === index && styles.pageDotActive]} />
          ))}
        </View>
      ) : null}
      {block.showActions !== false ? <ActionRow card={current} /> : null}
    </View>
  );
}

export function CardBlock({ block }: { block: Extract<Block, { type: 'card' }> }) {
  const [width, setWidth] = useState(0);
  const { dispatch } = useCanvas();
  const card = block.data;
  if (!card) return null;
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ gap: space.lg }}>
      {width > 0 ? <CardFace card={card} width={width} /> : null}
      {block.showActions !== false ? <ActionRow card={card} /> : null}
      {block.showDetails !== false ? (
        <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline }}>
          <KeyValueRow label="Status" value={card.status === 'frozen' ? 'Frozen' : 'Active'} tone={card.status === 'frozen' ? 'negative' : undefined} />
          <KeyValueRow label="Spent this month" value={money(card.spentThisMonth, card.currency)} />
          <KeyValueRow label="Monthly limit" value={card.monthlyLimit ? money(card.monthlyLimit, card.currency) : 'None'} />
          <KeyValueRow label="Expires" value={card.expiry} last />
        </View>
      ) : null}
      {block.showDetails !== false ? (
        <Tap onPress={() => void dispatch({ type: 'run', action: 'close_card', input: { cardId: card.id } })} style={{ alignSelf: 'center', padding: 6 }}>
          <Text variant="label" color={colors.negative}>Close card</Text>
        </Tap>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frozen: { backgroundColor: colors.scrim, alignItems: 'center', justifyContent: 'center' },
  frozenPill: { flexDirection: 'row', gap: 6, alignItems: 'center', paddingHorizontal: 12, paddingVertical: 7, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  actions: { flexDirection: 'row', justifyContent: 'space-between' },
  actionItem: { alignItems: 'center', gap: 6, flex: 1 },
  actionIcon: { width: 48, height: 48, borderRadius: 24, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bgRaised, alignItems: 'center', justifyContent: 'center' },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6 },
  pageDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.border },
  pageDotActive: { width: 18, get backgroundColor() { return colors.accent; } },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  swatch: { width: 36, height: 24, borderRadius: 5 },
});
