import { tr } from '@/i18n/context';
import { StyleSheet, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { Tap } from '@/components/Pressable';
import { Text } from '@/components/Text';
import { dayLabel } from '@/lib/format';
import { colors, fonts, radius } from '@/theme/tokens';
import { useCanvas } from '../canvas';
import type { Block } from '../types';
import { EmptyBlock, SectionHeader } from './Primitives';

export function SchedulesBlock({ block }: { block: Extract<Block, { type: 'schedules' }> }) {
  const { dispatch } = useCanvas();
  const items = block.data ?? [];
  if (!items.length) return <EmptyBlock block={{ type: 'empty', title: 'No scheduled payments', text: 'Try “Pay Ahmed 500 for rent every month”.', icon: 'calendar' }} />;
  return (
    <View>
      <SectionHeader title={block.title ?? 'Scheduled'} />
      {items.map((s, i) => (
        <View key={s.id} style={[styles.row, i < items.length - 1 && styles.divider]}>
          <View style={styles.icon}>
            <Icon name="repeat" size={16} color={colors.accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong">{s.name}</Text>
            <Text variant="caption" color={colors.textMuted}>
              {s.recurrence === 'weekly' ? 'Weekly' : 'Monthly'} · next {dayLabel(s.nextRunAt).toLowerCase()}
              {s.recipientName ? ` · to ${s.recipientName}` : ''}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <Text variant="bodyStrong" style={{ fontFamily: fonts.semibold }}>{s.formatted}</Text>
            <Tap onPress={() => void dispatch({ type: 'run', action: 'cancel_schedule', input: { scheduleId: s.id } })} hitSlop={8}>
              <Text variant="tiny" color={colors.textFaint}>Stop</Text>
            </Tap>
          </View>
        </View>
      ))}
    </View>
  );
}

export function RequestsBlock({ block }: { block: Extract<Block, { type: 'requests' }> }) {
  const { dispatch } = useCanvas();
  const items = block.data ?? [];
  if (!items.length) return <EmptyBlock block={{ type: 'empty', title: 'No requests', text: 'Try “Split 90 with Sara and Ahmed for dinner”.', icon: 'split' }} />;
  return (
    <View>
      <SectionHeader title={block.title ?? 'Requests'} />
      {items.map((r, i) => {
        const incoming = r.perspective === 'incoming';
        const who = incoming ? r.requesterName ?? tr('Someone') : r.payerName;
        return (
          <View key={r.id} style={[styles.row, i < items.length - 1 && styles.divider]}>
            <Avatar initials={who.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase()} size={38} />
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong">{incoming ? tr('{x} asks you', { x: who }) : tr('You asked {x}', { x: who })}</Text>
              <Text variant="caption" color={colors.textMuted}>{[r.note, r.status !== 'pending' ? r.status : dayLabel(r.createdAt)].filter(Boolean).join(' · ')}</Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 6 }}>
              <Text variant="bodyStrong" style={{ fontFamily: fonts.semibold }}>{r.formatted}</Text>
              {incoming && r.status === 'pending' ? (
                <View style={{ flexDirection: 'row', gap: 6 }}>
                  <Tap onPress={() => void dispatch({ type: 'run', action: 'decline_request', input: { requestId: r.id } })} style={[styles.pill, styles.pillGhost]}>
                    <Text variant="tiny">Decline</Text>
                  </Tap>
                  <Tap onPress={() => void dispatch({ type: 'run', action: 'pay_request', input: { requestId: r.id } })} style={styles.pill}>
                    <Text variant="tiny" color={colors.onAccent}>Pay</Text>
                  </Tap>
                </View>
              ) : !incoming && r.status === 'pending' ? (
                <Tap onPress={() => void dispatch({ type: 'run', action: 'cancel_request', input: { requestId: r.id } })} hitSlop={8}>
                  <Text variant="tiny" color={colors.textFaint}>Cancel</Text>
                </Tap>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  icon: { width: 38, height: 38, borderRadius: 19, get backgroundColor() { return colors.accentSoft; }, alignItems: 'center', justifyContent: 'center' },
  pill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, get backgroundColor() { return colors.accent; } },
  pillGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
});
