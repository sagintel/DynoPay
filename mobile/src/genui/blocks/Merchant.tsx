import { tr } from '@/i18n/context';
import { StyleSheet, View } from 'react-native';
import { Icon } from '@/components/Icon';
import { Tap } from '@/components/Pressable';
import { Text } from '@/components/Text';
import { dayLabel, money, titleCase } from '@/lib/format';
import { colors, fonts, radius, space } from '@/theme/tokens';
import { useCanvas } from '../canvas';
import type { Action, Block, ChartData, Invoice, PayPalTx, SalesSummary } from '../types';
import { ChartFrame } from './Charts';
import { BigAmount, EmptyBlock, KeyValueRow, NoticeBlock, SectionHeader } from './Primitives';

type B<T extends Block['type']> = { block: Extract<Block, { type: T }> };

function Pill({ text, tone = 'accent' }: { text: string; tone?: 'accent' | 'muted' | 'negative' | 'positive' }) {
  const fg = tone === 'negative' ? colors.negative : tone === 'positive' ? colors.positive : tone === 'muted' ? colors.textMuted : colors.accent;
  const bg = tone === 'negative' ? colors.negativeSoft : tone === 'positive' ? colors.positiveSoft : tone === 'muted' ? colors.surfaceHigh : colors.accentSoft;
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text variant="tiny" color={fg}>{text}</Text>
    </View>
  );
}

function Stat({ label, value, onPress }: { label: string; value: string; onPress?: () => void }) {
  const body = (
    <View style={styles.stat}>
      <Text variant="caption" color={colors.textMuted}>{label}</Text>
      <Text style={{ fontFamily: fonts.semibold, fontSize: 18 }}>{value}</Text>
    </View>
  );
  return onPress ? <Tap onPress={onPress} style={{ flex: 1 }} scaleTo={0.98}>{body}</Tap> : <View style={{ flex: 1 }}>{body}</View>;
}

/** Merchant hero: the real PayPal business balance plus the numbers that need attention. */
export function MerchantOverviewBlock({ block }: B<'merchant_overview'>) {
  const { dispatch } = useCanvas();
  const d = block.data;
  if (!d) return null;
  const primary = d.balance?.primary;
  return (
    <View style={{ gap: space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name="paypal" size={16} color={colors.accent} />
          <Text variant="label" color={colors.textMuted}>{d.businessName}</Text>
        </View>
        <Pill text={d.environment === 'live' ? 'Live' : 'Sandbox'} tone={d.environment === 'live' ? 'positive' : 'muted'} />
      </View>
      {primary ? (
        <View style={{ gap: 4 }}>
          <Text variant="caption" color={colors.textMuted}>PayPal balance</Text>
          <BigAmount value={primary.total} currency={primary.currency} size="xl" />
          <Text variant="caption" color={colors.textMuted}>
            {money(primary.available, primary.currency)} available{primary.withheld ? ` · ${money(primary.withheld, primary.currency)} on hold` : ''}
          </Text>
        </View>
      ) : (
        <NoticeBlock block={{ type: 'notice', tone: 'info', text: 'Enable Transaction Search for your REST app to see your PayPal balance and sales here.' }} />
      )}
      <View style={{ flexDirection: 'row', gap: space.sm }}>
        <Stat label="Sales · 30d" value={d.sales30 ? d.sales30.formattedGross : '—'} onPress={() => void dispatch({ type: 'ask', prompt: 'Show my sales for the last 30 days' })} />
        <Stat label="Unpaid invoices" value={d.unpaidInvoices ? String(d.unpaidInvoices.count) : '—'} onPress={() => void dispatch({ type: 'ask', prompt: 'Show my unpaid invoices' })} />
        <Stat label="Disputes" value={d.openDisputes === null ? '—' : String(d.openDisputes)} onPress={() => void dispatch({ type: 'ask', prompt: 'Show my open disputes' })} />
      </View>
    </View>
  );
}

const asChart = (s: SalesSummary): ChartData => ({
  period: `${s.days}d`, groupBy: 'day', direction: 'in', currency: s.currency, total: s.gross, formattedTotal: s.formattedGross, count: s.count, buckets: s.buckets,
});

export function MerchantSalesBlock({ block }: B<'merchant_sales'>) {
  const s = block.data;
  if (!s) return null;
  return (
    <ChartFrame
      title={block.title ?? tr('Sales · last {x} days', { x: s.days })}
      data={asChart(s)}
      kind={block.kind ?? 'bar'}
      headline={
        <View style={{ gap: 2 }}>
          <BigAmount value={s.gross} currency={s.currency} size="md" />
          <Text variant="caption" color={colors.textFaint}>
            {s.count} payments · avg {money(s.average, s.currency)} · net {s.formattedNet}
          </Text>
        </View>
      }
      footer={
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Stat label="Fees" value={money(s.fees, s.currency)} />
          <Stat label="Refunded" value={money(s.refunded, s.currency)} />
        </View>
      }
    />
  );
}

function payPalTxDialog(t: PayPalTx): Action {
  const rows = [
    { label: 'Type', value: t.type },
    { label: 'Status', value: titleCase(t.status) },
    { label: 'Gross', value: money(t.amount, t.currency) },
    { label: 'Fee', value: money(t.fee, t.currency) },
    { label: 'Net', value: money(t.net, t.currency) },
    ...(t.email ? [{ label: 'Email', value: t.email }] : []),
    ...(t.subject ? [{ label: 'Subject', value: t.subject }] : []),
    { label: 'Transaction ID', value: t.id },
  ];
  const canRefund = t.direction === 'in' && t.type === 'Payment' && t.status === 'completed';
  return {
    type: 'dialog',
    dialog: {
      title: t.counterparty,
      icon: 'paypal',
      blocks: [{ type: 'amount', value: t.amount, currency: t.currency, caption: t.date ? new Date(t.date).toLocaleString() : undefined, size: 'lg' }, { type: 'key_values', rows }],
      buttons: canRefund
        ? [
            { label: 'Refund…', icon: 'arrow-up', variant: 'danger', action: { type: 'run', action: 'refund_payment', input: { captureId: t.id } } },
            { label: 'Add tracking', icon: 'receipt', variant: 'secondary', action: { type: 'prefill', text: tr('Add tracking to {x}: ', { x: t.id }) } },
          ]
        : [],
    },
  };
}

export function PayPalTransactionsBlock({ block }: B<'paypal_transactions'>) {
  const { dispatch } = useCanvas();
  const items = block.data?.items ?? [];
  if (!items.length) return <EmptyBlock block={{ type: 'empty', title: 'No PayPal activity yet', text: 'PayPal reporting can lag up to 3 hours.', icon: 'paypal' }} />;
  return (
    <View>
      <SectionHeader title={block.title} />
      {items.map((t, i) => (
        <Tap key={t.id} onPress={() => void dispatch(payPalTxDialog(t))} scaleTo={0.985} style={[styles.row, i < items.length - 1 && styles.divider]}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="bodyStrong" numberOfLines={1}>{t.counterparty}</Text>
            <Text variant="caption" color={colors.textMuted} numberOfLines={1}>
              {[t.type, t.date ? dayLabel(t.date) : null, t.status !== 'completed' ? titleCase(t.status) : null].filter(Boolean).join(' · ')}
            </Text>
          </View>
          <Text variant="bodyStrong" style={{ fontFamily: fonts.semibold }}>{money(t.amount, t.currency, { signed: true })}</Text>
        </Tap>
      ))}
    </View>
  );
}

const INVOICE_TONE: Record<string, 'accent' | 'muted' | 'negative' | 'positive'> = {
  DRAFT: 'muted', SENT: 'accent', UNPAID: 'accent', PARTIALLY_PAID: 'accent', PAID: 'positive', MARKED_AS_PAID: 'positive', CANCELLED: 'negative', REFUNDED: 'muted',
};

function InvoiceRow({ inv, last }: { inv: Invoice; last: boolean }) {
  const { dispatch } = useCanvas();
  return (
    <Tap onPress={() => void dispatch({ type: 'open', kind: 'invoice', id: inv.id })} scaleTo={0.985} style={[styles.row, !last && styles.divider]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyStrong" numberOfLines={1}>{inv.recipient}</Text>
        <Text variant="caption" color={colors.textMuted} numberOfLines={1}>
          {inv.number ? `#${inv.number}` : tr('Draft')}{inv.dueDate ? ` · ${tr('due {x}', { x: inv.dueDate })}` : ''}
        </Text>
      </View>
      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <Text variant="bodyStrong" style={{ fontFamily: fonts.semibold }}>{inv.formatted}</Text>
        <Pill text={titleCase(inv.status.toLowerCase())} tone={INVOICE_TONE[inv.status] ?? 'muted'} />
      </View>
    </Tap>
  );
}

export function InvoicesBlock({ block }: B<'invoices'>) {
  const items = block.data?.items ?? [];
  if (!items.length) return <EmptyBlock block={{ type: 'empty', title: 'No invoices', text: 'Try “Invoice client@example.com 250 for design work”.', icon: 'receipt' }} />;
  return (
    <View>
      <SectionHeader title={block.title} />
      {items.map((inv, i) => <InvoiceRow key={inv.id} inv={inv} last={i === items.length - 1} />)}
    </View>
  );
}

export function InvoiceBlock({ block }: B<'invoice'>) {
  const { dispatch } = useCanvas();
  const inv = block.data;
  if (!inv) return null;
  const draft = inv.status === 'DRAFT';
  const open = ['SENT', 'UNPAID', 'PARTIALLY_PAID'].includes(inv.status);
  const run = (action: string, input: Record<string, unknown> = {}) => () => void dispatch({ type: 'run', action, input: { invoiceId: inv.id, ...input } });
  return (
    <View style={{ gap: space.lg }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ gap: 2, flex: 1 }}>
          <Text variant="heading">{inv.recipient}</Text>
          <Text variant="caption" color={colors.textMuted}>{inv.recipientEmail ?? ''}</Text>
        </View>
        <Pill text={titleCase(inv.status.toLowerCase())} tone={INVOICE_TONE[inv.status] ?? 'muted'} />
      </View>
      <BigAmount value={open ? inv.due : inv.total} currency={inv.currency} size="lg" />
      <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline }}>
        {inv.items.map((it, i) => (
          <KeyValueRow key={i} label={`${it.quantity} × ${it.name}`} value={money(it.quantity * it.unitAmount, inv.currency)} />
        ))}
        <KeyValueRow label="Invoice" value={inv.number ? `#${inv.number}` : '—'} />
        <KeyValueRow label="Due" value={inv.dueDate ?? (inv.termType ? titleCase(inv.termType.toLowerCase()) : 'On receipt')} last={!inv.note} />
        {inv.note ? <KeyValueRow label="Note" value={inv.note} last /> : null}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {draft ? <ActionChip icon="send" label="Send" onPress={run('send_invoice')} primary /> : null}
        {open ? <ActionChip icon="bolt" label="Remind" onPress={run('remind_invoice')} primary /> : null}
        {open ? <ActionChip icon="check" label="Mark paid" onPress={run('record_invoice_payment')} /> : null}
        {open ? <ActionChip icon="close" label="Cancel" onPress={run('cancel_invoice')} /> : null}
        {draft ? <ActionChip icon="trash" label="Delete" onPress={run('delete_invoice')} /> : null}
        {inv.payerUrl ? <ActionChip icon="paypal" label="Payer link" onPress={() => void dispatch({ type: 'open_url', url: inv.payerUrl! })} /> : null}
      </View>
    </View>
  );
}

function ActionChip({ icon, label, onPress, primary }: { icon: Parameters<typeof Icon>[0]['name']; label: string; onPress: () => void; primary?: boolean }) {
  return (
    <Tap onPress={onPress} style={[styles.action, primary && { backgroundColor: colors.accent, borderColor: colors.accent }]}>
      <Icon name={icon} size={14} color={primary ? colors.onAccent : colors.text} />
      <Text variant="label" color={primary ? colors.onAccent : colors.text}>{label}</Text>
    </Tap>
  );
}

export function DisputesBlock({ block }: B<'disputes'>) {
  const { dispatch } = useCanvas();
  const items = block.data ?? [];
  if (!items.length) return <EmptyBlock block={{ type: 'empty', title: 'No disputes', text: 'Nothing needs your attention.', icon: 'shield' }} />;
  return (
    <View>
      <SectionHeader title={block.title} />
      {items.map((d, i) => (
        <Tap key={d.id} onPress={() => void dispatch({ type: 'open', kind: 'dispute', id: d.id })} scaleTo={0.985} style={[styles.row, i < items.length - 1 && styles.divider]}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="bodyStrong" numberOfLines={1}>{titleCase(d.reason)}</Text>
            <Text variant="caption" color={colors.textMuted}>
              {[d.stage ? titleCase(d.stage.toLowerCase()) : null, d.respondBy ? tr('respond by {x}', { x: dayLabel(d.respondBy).toLowerCase() }) : null].filter(Boolean).join(' · ')}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 4 }}>
            <Text variant="bodyStrong" style={{ fontFamily: fonts.semibold }}>{d.formatted}</Text>
            <Pill text={d.needsAction ? 'Action needed' : titleCase(d.status.toLowerCase())} tone={d.needsAction ? 'negative' : 'muted'} />
          </View>
        </Tap>
      ))}
    </View>
  );
}

export function DisputeBlock({ block }: B<'dispute'>) {
  const { dispatch } = useCanvas();
  const d = block.data;
  if (!d) return null;
  const resolved = d.status === 'RESOLVED';
  return (
    <View style={{ gap: space.lg }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text variant="heading" style={{ flex: 1 }}>{titleCase(d.reason)}</Text>
        <Pill text={d.needsAction ? 'Action needed' : titleCase(d.status.toLowerCase())} tone={d.needsAction ? 'negative' : 'muted'} />
      </View>
      <BigAmount value={d.amount} currency={d.currency} size="lg" />
      <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline }}>
        {d.buyer ? <KeyValueRow label="Buyer" value={d.buyer} /> : null}
        <KeyValueRow label="Stage" value={d.stage ? titleCase(d.stage.toLowerCase()) : '—'} />
        {d.respondBy ? <KeyValueRow label="Respond by" value={new Date(d.respondBy).toDateString()} /> : null}
        <KeyValueRow label="Dispute ID" value={d.id} last={!d.transactionId} />
        {d.transactionId ? <KeyValueRow label="Transaction" value={d.transactionId} last /> : null}
      </View>
      {d.messages?.length ? (
        <View style={{ gap: 8 }}>
          <Text variant="label" color={colors.textMuted}>Messages</Text>
          {d.messages.map((msg, i) => (
            <View key={i} style={styles.message}>
              <Text variant="tiny" color={colors.textFaint}>{titleCase((msg.posted_by ?? '').toLowerCase())}</Text>
              <Text variant="body">{msg.content}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {!resolved ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          <ActionChip
            icon="edit"
            label="Message buyer"
            primary
            onPress={() =>
              void dispatch({
                type: 'dialog',
                dialog: {
                  title: 'Message the buyer',
                  fields: [{ name: 'message', label: 'Message', kind: 'text', required: true, placeholder: 'We shipped your order on…' }],
                  buttons: [{ label: 'Review & send', variant: 'primary', action: { type: 'run', action: 'send_dispute_message', input: { disputeId: d.id, message: '$field.message' } } }],
                },
              })
            }
          />
          <ActionChip icon="check" label="Accept claim" onPress={() => void dispatch({ type: 'run', action: 'accept_dispute_claim', input: { disputeId: d.id } })} />
        </View>
      ) : null}
    </View>
  );
}

export function CatalogBlock({ block }: B<'catalog'>) {
  const items = block.data ?? [];
  const plans = block.kind !== 'products';
  if (!items.length) return <EmptyBlock block={{ type: 'empty', title: plans ? 'No subscription plans' : 'No products', text: plans ? 'Try “Create a monthly plan for 9.99”.' : undefined, icon: 'repeat' }} />;
  return (
    <View>
      <SectionHeader title={plans ? 'Subscription plans' : 'Products'} />
      {items.map((it, i) => (
        <View key={it.id} style={[styles.row, i < items.length - 1 && styles.divider]}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="bodyStrong" numberOfLines={1}>{it.name}</Text>
            <Text variant="caption" color={colors.textMuted} numberOfLines={1}>{plans ? it.id : [it.type, it.description].filter(Boolean).join(' · ')}</Text>
          </View>
          {plans && it.price ? (
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <Text variant="bodyStrong" style={{ fontFamily: fonts.semibold }}>
                {money(Number(it.price.value), it.price.currency_code)}/{(it.interval ?? 'month').toLowerCase()}
              </Text>
              {it.status ? <Pill text={titleCase(it.status.toLowerCase())} tone={it.status === 'ACTIVE' ? 'positive' : 'muted'} /> : null}
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill },
  stat: { gap: 4, padding: 12, borderRadius: radius.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.hairline },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.lg, borderWidth: 1, borderColor: colors.hairline },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  action: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 38, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
  message: { padding: 12, borderRadius: radius.md, backgroundColor: colors.surface, gap: 4 },
});
