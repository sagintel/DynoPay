import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { Tap } from '@/components/Pressable';
import { Text } from '@/components/Text';
import { dayLabel, money, timeLabel, titleCase, txSubtitle } from '@/lib/format';
import { colors, fonts, radius, space } from '@/theme/tokens';
import { useCanvas } from '../canvas';
import type { Block, Tx } from '../types';
import { BigAmount, EmptyBlock, KeyValueRow, SectionHeader } from './Primitives';

type ListBlock = Extract<Block, { type: 'transactions' }>;

export function TxRow({ tx, highlighted, compact, onPress }: { tx: Tx; highlighted?: boolean; compact?: boolean; onPress: () => void }) {
  const amount = money(tx.signedAmount, tx.currency, { signed: true });
  return (
    <Tap onPress={onPress} scaleTo={0.985} accessibilityLabel={`${tx.counterparty.name}, ${amount}`} style={[styles.row, highlighted && styles.highlight]}>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          {highlighted ? <View style={styles.dot} /> : null}
          <Text variant="bodyStrong" numberOfLines={1} style={{ flexShrink: 1 }}>{tx.counterparty.name}</Text>
        </View>
        {!compact ? <Text variant="caption" color={colors.textMuted} numberOfLines={1}>{txSubtitle(tx)}</Text> : null}
      </View>
      <Text
        variant="bodyStrong"
        style={{ fontFamily: fonts.semibold, textDecorationLine: tx.status === 'failed' ? 'line-through' : 'none' }}
        color={tx.status === 'failed' ? colors.textFaint : tx.direction === 'in' ? colors.text : colors.text}
      >
        {amount}
      </Text>
    </Tap>
  );
}

function group(items: Tx[], by: ListBlock['groupBy']) {
  if (by === 'none') return [{ label: '', items }];
  const map = new Map<string, Tx[]>();
  for (const t of items) {
    const key = by === 'category' ? titleCase(t.category) : by === 'counterparty' ? t.counterparty.name : dayLabel(t.createdAt);
    map.set(key, [...(map.get(key) ?? []), t]);
  }
  return [...map.entries()].map(([label, list]) => ({ label, items: list }));
}

export function TransactionsBlock({ block }: { block: ListBlock }) {
  const { dispatch } = useCanvas();
  const items = block.data?.items ?? [];
  if (!items.length) return <EmptyBlock block={{ type: 'empty', title: block.emptyText ?? 'No transactions yet', icon: 'receipt' }} />;
  const groups = group(items, block.groupBy ?? 'day');
  return (
    <View>
      <SectionHeader title={block.title} />
      {groups.map((g, gi) => (
        <View key={g.label || gi} style={{ marginBottom: 6 }}>
          {g.label ? <Text variant="caption" color={colors.textMuted} style={{ marginTop: gi ? 10 : 0, marginBottom: 2 }}>{g.label}</Text> : null}
          {g.items.map((t, i) => (
            <View key={t.id} style={i < g.items.length - 1 ? styles.divider : undefined}>
              <TxRow tx={t} compact={block.variant === 'compact'} highlighted={t.id === block.highlightId} onPress={() => void dispatch({ type: 'open', kind: 'transaction', id: t.id })} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const KIND_LABEL: Record<string, string> = {
  transfer: 'Transfer', payout: 'PayPal payout', topup: 'Top up', card_funding: 'Card', card_spend: 'Card payment',
  refund: 'Refund', request_payment: 'Request', schedule: 'Scheduled',
};

/** One transaction: a receipt (after sending) or a full detail view (in the dialog). */
export function TransactionBlock({ block }: { block: Extract<Block, { type: 'transaction' }> }) {
  const { dispatch } = useCanvas();
  const tx = block.data;
  if (!tx) return null;
  const when = new Date(tx.createdAt);
  return (
    <Animated.View entering={FadeIn} style={{ gap: space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Avatar initials={tx.counterparty.initials} size={48} ring={tx.counterparty.isDynoPayUser} />
        <View style={{ flex: 1 }}>
          <Text variant="heading">{tx.counterparty.name}</Text>
          <Text variant="caption" color={colors.textMuted}>
            {tx.counterparty.handle ? `@${tx.counterparty.handle}` : tx.counterparty.email ?? KIND_LABEL[tx.kind] ?? titleCase(tx.kind)}
          </Text>
        </View>
        <View style={[styles.badge, tx.status === 'failed' && { backgroundColor: colors.negativeSoft }]}>
          <Icon name={tx.status === 'completed' ? 'check' : tx.status === 'failed' ? 'warning' : 'repeat'} size={12} color={tx.status === 'failed' ? colors.negative : colors.accent} />
          <Text variant="tiny" color={tx.status === 'failed' ? colors.negative : colors.accent}>{titleCase(tx.status)}</Text>
        </View>
      </View>
      <BigAmount value={tx.signedAmount} currency={tx.currency} size={block.variant === 'receipt' ? 'xl' : 'lg'} />
      <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline }}>
        <KeyValueRow label="Type" value={KIND_LABEL[tx.kind] ?? titleCase(tx.kind)} />
        <KeyValueRow label="Category" value={titleCase(tx.category)} />
        {tx.note ? <KeyValueRow label="Note" value={tx.note} /> : null}
        <KeyValueRow label="Date" value={`${when.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${timeLabel(tx.createdAt)}`} />
        {tx.balanceAfter !== null ? <KeyValueRow label="Balance after" value={money(tx.balanceAfter, tx.currency)} /> : null}
        <KeyValueRow label="Reference" value={(tx.reference ?? tx.id).slice(0, 18).toUpperCase()} last />
      </View>
      {tx.counterparty.contactId && tx.direction === 'out' ? (
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Tap style={styles.action} onPress={() => void dispatch({ type: 'ask', prompt: `Send ${tx.amount} to ${tx.counterparty.name}${tx.note ? ` for ${tx.note}` : ''}` })}>
            <Icon name="repeat" size={15} />
            <Text variant="label">Send again</Text>
          </Tap>
          <Tap style={styles.action} onPress={() => void dispatch({ type: 'open', kind: 'contact', id: tx.counterparty.contactId! })}>
            <Icon name="user" size={15} />
            <Text variant="label">{tx.counterparty.name.split(' ')[0]}</Text>
          </Tap>
        </View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, gap: 12, borderRadius: radius.sm },
  highlight: { get backgroundColor() { return colors.accentSoft; }, marginHorizontal: -10, paddingHorizontal: 10 },
  dot: { width: 8, height: 8, borderRadius: 4, get backgroundColor() { return colors.accent; } },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.pill, get backgroundColor() { return colors.accentSoft; } },
  action: { flex: 1, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', height: 42, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
});
