import { tr } from '@/i18n/context';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { Tap } from '@/components/Pressable';
import { Text } from '@/components/Text';
import { money } from '@/lib/format';
import { colors, radius, space } from '@/theme/tokens';
import { useCanvas } from '../canvas';
import type { Block, Contact } from '../types';
import { EmptyBlock, KeyValueRow, SectionHeader } from './Primitives';

type ContactsT = Extract<Block, { type: 'contacts' }>;

export function ContactsBlock({ block }: { block: ContactsT }) {
  const { dispatch } = useCanvas();
  const contacts = block.data ?? [];
  const select = (c: Contact) =>
    block.onSelect === 'open' ? dispatch({ type: 'open', kind: 'contact', id: c.id }) : dispatch({ type: 'prefill', text: tr('Pay {x} ', { x: c.name.split(' ')[0]! }) });
  const addNew = () => dispatch({ type: 'prefill', text: tr('Pay ') });

  if (!contacts.length && !block.showNew) return <EmptyBlock block={{ type: 'empty', title: 'No contacts yet', icon: 'users' }} />;

  if (block.variant === 'list') {
    return (
      <View>
        <SectionHeader title={block.title} />
        {contacts.map((c, i) => (
          <Tap key={c.id} onPress={() => void select(c)} scaleTo={0.985} style={[styles.listRow, i < contacts.length - 1 && styles.divider]}>
            <Avatar initials={c.initials} size={40} ring={c.favorite} />
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong">{c.name}</Text>
              <Text variant="caption" color={colors.textMuted}>{c.handle ? `@${c.handle} · DynoPay` : c.email ?? ''}</Text>
            </View>
            {c.isDynoPayUser ? <Icon name="shield" size={15} color={colors.accent} /> : null}
          </Tap>
        ))}
        {!contacts.length ? <Text variant="body" color={colors.textMuted}>{tr('Nobody matches “{x}”.', { x: block.search ?? '' })}</Text> : null}
      </View>
    );
  }

  return (
    <View>
      <SectionHeader title={block.title} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 14, paddingRight: 8 }}>
        {contacts.map((c) => (
          <Tap key={c.id} onPress={() => void select(c)} onLongPress={() => void dispatch({ type: 'open', kind: 'contact', id: c.id })} style={styles.avatarItem} accessibilityLabel={c.name}>
            <Avatar initials={c.initials} size={44} ring={c.favorite} />
            <Text variant="tiny" color={colors.textMuted} numberOfLines={1}>{c.name.split(' ')[0]}</Text>
          </Tap>
        ))}
        {block.showNew !== false ? (
          <Tap onPress={() => void addNew()} style={styles.avatarItem} accessibilityLabel="New recipient">
            <View style={styles.newCircle}>
              <Icon name="plus" size={18} color={colors.text} />
            </View>
            <Text variant="tiny" color={colors.textMuted}>New</Text>
          </Tap>
        ) : null}
      </ScrollView>
    </View>
  );
}

export function ContactBlock({ block }: { block: Extract<Block, { type: 'contact' }> }) {
  const { dispatch } = useCanvas();
  const c = block.data;
  if (!c) return null;
  const first = c.name.split(' ')[0];
  return (
    <View style={{ gap: space.lg }}>
      <View style={{ alignItems: 'center', gap: 8 }}>
        <Avatar initials={c.initials} size={block.variant === 'compact' ? 48 : 68} ring={c.isDynoPayUser} />
        <Text variant="title">{c.name}</Text>
        <Text variant="caption" color={colors.textMuted}>{c.handle ? `@${c.handle} · DynoPay account` : c.email ?? ''}</Text>
      </View>
      {block.variant !== 'compact' ? (
        <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline }}>
          <KeyValueRow label="You sent" value={money(c.totals.sent, c.totals.currency)} />
          <KeyValueRow label="You received" value={money(c.totals.received, c.totals.currency)} />
          <KeyValueRow label="Payments" value={String(c.totals.transactions)} last />
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Tap style={styles.action} onPress={() => void dispatch({ type: 'prefill', text: `Pay ${first} ` })}>
          <Icon name="send" size={15} />
          <Text variant="label">Send</Text>
        </Tap>
        <Tap style={styles.action} onPress={() => void dispatch({ type: 'prefill', text: `Request from ${first} ` })}>
          <Icon name="arrow-down" size={15} />
          <Text variant="label">Request</Text>
        </Tap>
        <Tap style={styles.action} onPress={() => void dispatch({ type: 'run', action: 'update_contact', input: { contactId: c.id, favorite: !c.favorite } })}>
          <Icon name="star" size={15} color={c.favorite ? colors.accent : colors.text} />
          <Text variant="label">{c.favorite ? 'Favorite' : 'Pin'}</Text>
        </Tap>
      </View>
      <Tap onPress={() => void dispatch({ type: 'run', action: 'delete_contact', input: { contactId: c.id } })} style={{ alignSelf: 'center', padding: 6 }}>
        <Text variant="label" color={colors.negative}>Remove contact</Text>
      </Tap>
    </View>
  );
}

export function ProfileBlock({ block }: { block: Extract<Block, { type: 'profile' }> }) {
  const u = block.data;
  if (!u) return null;
  return (
    <View style={[styles.profile, block.variant === 'compact' && { padding: 14 }]}>
      <Avatar initials={u.initials} size={block.variant === 'compact' ? 44 : 60} solid />
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="heading">{u.name}</Text>
        <Text variant="caption" color={colors.textMuted}>@{u.handle} · {u.email}</Text>
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
          {u.paypalLinked ? (
            <View style={styles.pill}>
              <Icon name="paypal" size={11} color={colors.accent} />
              <Text variant="tiny" color={colors.accent}>PayPal linked</Text>
            </View>
          ) : null}
          {u.verified ? (
            <View style={styles.pill}>
              <Icon name="shield" size={11} color={colors.accent} />
              <Text variant="tiny" color={colors.accent}>Verified</Text>
            </View>
          ) : null}
          <View style={styles.pill}>
            <Text variant="tiny" color={colors.accent}>{u.currency}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  avatarItem: { alignItems: 'center', gap: 6, width: 52 },
  newCircle: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  action: { flex: 1, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', height: 42, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.hairline },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, get backgroundColor() { return colors.accentSoft; } },
});
