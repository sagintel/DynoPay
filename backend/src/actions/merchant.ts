import crypto from 'node:crypto';
import { z } from 'zod';
import type { User } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import * as pp from '../paypal/merchant.js';
import * as m from '../services/merchant.js';
import { initials } from '../services/serialize.js';
import { define, type ActionDef } from './types.js';

/**
 * PayPal merchant capabilities (audience: merchant). They run on the merchant's own PayPal account
 * through their REST credentials. Anything that moves money or contacts a customer requires confirmation.
 */

const amount = z.number().positive().max(1_000_000).describe('Amount in major units, e.g. 49.99');
const pid = (what: string) => z.string().min(3).max(64).describe(`PayPal ${what} id`);
const money = (value: number, currency: string): pp.Money => ({ currency_code: currency, value: value.toFixed(2) });
const newRequestId = () => crypto.randomUUID();

async function ctx(user: User, cap?: m.Capability) {
  const { client, conn } = await m.merchantClient(user, cap);
  return { client, conn, run: <T>(fn: () => Promise<T>) => m.guard(conn, fn) };
}

async function primaryCurrency(user: User): Promise<string> {
  try {
    const { client, conn } = await m.merchantClient(user, 'reporting');
    return (await m.guard(conn, () => m.merchantBalance(client))).primary?.currency ?? user.currency;
  } catch {
    return user.currency;
  }
}

const INVOICE_STATUSES = ['DRAFT', 'SENT', 'SCHEDULED', 'PAID', 'MARKED_AS_PAID', 'CANCELLED', 'REFUNDED', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED', 'UNPAID', 'PAYMENT_PENDING'] as const;

async function invoiceFor(user: User, invoiceId: string) {
  const c = await ctx(user, 'invoicing');
  return { ...c, invoice: m.invoiceView(await c.run(() => pp.getInvoice(c.client, invoiceId))) };
}

const recipientOf = (inv: m.InvoiceView) => ({ name: inv.recipient, initials: initials(inv.recipient), subtitle: inv.recipientEmail ?? 'Customer', verified: false });

/** Capability each tap-confirmed merchant change needs; checked when the confirmation is prepared. */
/** Capability each merchant action needs; actions whose capability isn't granted are never offered (app, agent, MCP). */
const CAP_FOR: Record<string, m.Capability> = {
  merchant_balance: 'reporting', merchant_transactions: 'reporting', merchant_sales: 'reporting',
  list_invoices: 'invoicing', get_invoice: 'invoicing', invoice_qr_code: 'invoicing', create_invoice_draft: 'invoicing',
  create_and_send_invoice: 'invoicing', send_invoice: 'invoicing', remind_invoice: 'invoicing', cancel_invoice: 'invoicing',
  delete_invoice: 'invoicing', record_invoice_payment: 'invoicing',
  list_disputes: 'disputes', get_dispute: 'disputes', accept_dispute_claim: 'disputes', send_dispute_message: 'disputes',
  list_products: 'subscriptions', list_plans: 'subscriptions', get_subscription: 'subscriptions', create_product: 'subscriptions',
  create_plan: 'subscriptions', activate_plan: 'subscriptions', deactivate_plan: 'subscriptions',
  suspend_subscription: 'subscriptions', cancel_subscription: 'subscriptions', activate_subscription: 'subscriptions',
  get_payment: 'payments', create_payment_link: 'payments', capture_payment: 'payments',
  refund_payment: 'refunds', merchant_payout: 'payouts', add_tracking: 'tracking',
};

const merchant = <S extends z.ZodType>(def: ActionDef<S>) => {
  const cap = CAP_FOR[def.name];
  const summary = def.summary;
  return define({
    ...def,
    audience: 'merchant',
    capability: cap,
    // Refuse up front (clear 403) instead of showing a confirmation that can only fail.
    ...(def.risk === 'auto' && cap
      ? { summary: async (u: User, i: z.infer<S>) => (await m.merchantClient(u, cap), (await summary?.(u, i)) ?? {}) }
      : {}),
  });
};

export const MERCHANT_ACTIONS: ActionDef[] = [
  // ─── read ────────────────────────────────────────────────────────────────
  merchant({
    name: 'merchant_overview', risk: 'read', input: z.object({}),
    description: 'Merchant dashboard: PayPal balance, last 30 days of sales, unpaid invoices, open disputes, enabled capabilities.',
    run: (u) => m.merchantOverview(u),
  }),
  merchant({
    name: 'merchant_balance', risk: 'read', input: z.object({}),
    description: "The merchant's real PayPal account balances (all currencies).",
    run: async (u) => {
      const c = await ctx(u, 'reporting');
      return c.run(() => m.merchantBalance(c.client));
    },
  }),
  merchant({
    name: 'merchant_transactions', risk: 'read',
    input: z.object({
      days: z.number().int().min(1).max(90).default(30),
      search: z.string().max(80).optional().describe('Matches payer name/email, subject, note or invoice id'),
      direction: z.enum(['in', 'out']).optional(),
      limit: z.number().int().min(1).max(100).default(25),
    }),
    description: "Transactions on the merchant's PayPal account (Transaction Search). PayPal data can lag up to 3 hours.",
    run: async (u, i) => {
      const c = await ctx(u, 'reporting');
      let items = await c.run(() => m.recentPayPalTransactions(c.client, i.days, 500));
      if (i.direction) items = items.filter((t) => t.direction === i.direction);
      if (i.search) {
        const q = i.search.toLowerCase();
        items = items.filter((t) => [t.counterparty, t.email, t.subject, t.note, t.invoiceId, t.id].some((v) => v?.toLowerCase().includes(q)));
      }
      return { items: items.slice(0, i.limit), total: items.length };
    },
  }),
  merchant({
    name: 'merchant_sales', risk: 'read', input: z.object({ days: z.number().int().min(1).max(90).default(30) }),
    description: 'Sales analytics from PayPal transactions: gross, fees, refunds, net, count, average and per-day totals.',
    run: async (u, i) => {
      const c = await ctx(u, 'reporting');
      const txs = await c.run(() => m.recentPayPalTransactions(c.client, i.days, 500));
      return m.salesSummary(txs, i.days, txs[0]?.currency ?? (await primaryCurrency(u)));
    },
  }),
  merchant({
    name: 'list_invoices', risk: 'read',
    input: z.object({ status: z.enum(INVOICE_STATUSES).optional(), recipient: z.string().max(120).optional().describe('Recipient email'), limit: z.number().int().min(1).max(50).default(20) }),
    description: 'PayPal invoices, newest first. Filter by status or recipient email.',
    run: async (u, i) => {
      const c = await ctx(u, 'invoicing');
      const res = await c.run(() =>
        i.status || i.recipient
          ? pp.searchInvoices(c.client, { ...(i.status ? { status: [i.status] } : {}), ...(i.recipient ? { recipient_email: i.recipient } : {}) }, i.limit)
          : pp.listInvoices(c.client, 1, i.limit),
      );
      return { items: (res.items ?? []).map(m.invoiceView), total: res.total_items ?? res.items?.length ?? 0 };
    },
  }),
  merchant({
    name: 'get_invoice', risk: 'read', input: z.object({ invoiceId: pid('invoice') }),
    description: 'One invoice with items, amounts, due date and the payer link.',
    run: async (u, i) => (await invoiceFor(u, i.invoiceId)).invoice,
  }),
  merchant({
    name: 'invoice_qr_code', risk: 'read', input: z.object({ invoiceId: pid('invoice') }),
    description: 'QR code (base64 PNG) a customer can scan to pay a sent invoice.',
    run: async (u, i) => {
      const c = await ctx(u, 'invoicing');
      return { invoiceId: i.invoiceId, qr: await c.run(() => pp.invoiceQrCode(c.client, i.invoiceId)) };
    },
  }),
  merchant({
    name: 'list_disputes', risk: 'read',
    input: z.object({ status: z.enum(['REQUIRED_ACTION', 'REQUIRED_OTHER_PARTY_ACTION', 'UNDER_PAYPAL_REVIEW', 'RESOLVED', 'OPEN_INQUIRIES', 'APPEALABLE']).optional() }),
    description: 'Customer disputes and claims against the merchant.',
    run: async (u, i) => {
      const c = await ctx(u, 'disputes');
      return ((await c.run(() => pp.listDisputes(c.client, i.status))).items ?? []).map(m.disputeView);
    },
  }),
  merchant({
    name: 'get_dispute', risk: 'read', input: z.object({ disputeId: pid('dispute') }),
    description: 'One dispute with its messages.',
    run: async (u, i) => {
      const c = await ctx(u, 'disputes');
      const d = await c.run(() => pp.getDispute(c.client, i.disputeId));
      return { ...m.disputeView(d), messages: (d.messages ?? []).slice(-10), transactionId: d.disputed_transactions?.[0]?.seller_transaction_id ?? null, buyer: d.disputed_transactions?.[0]?.buyer?.name ?? null };
    },
  }),
  merchant({
    name: 'list_products', risk: 'read', input: z.object({}),
    description: 'Catalog products (used by subscription plans).',
    run: async (u) => {
      const c = await ctx(u, 'subscriptions');
      return (await c.run(() => pp.listProducts(c.client))).products ?? [];
    },
  }),
  merchant({
    name: 'list_plans', risk: 'read', input: z.object({ productId: z.string().max(64).optional() }),
    description: 'Subscription billing plans with price and interval.',
    run: async (u, i) => {
      const c = await ctx(u, 'subscriptions');
      return ((await c.run(() => pp.listPlans(c.client, i.productId))).plans ?? []).map((p) => ({
        id: p.id, name: p.name, status: p.status, productId: p.product_id,
        price: p.billing_cycles?.[0]?.pricing_scheme?.fixed_price ?? null,
        interval: p.billing_cycles?.[0]?.frequency?.interval_unit ?? null,
      }));
    },
  }),
  merchant({
    name: 'get_subscription', risk: 'read', input: z.object({ subscriptionId: pid('subscription') }),
    description: 'A customer subscription: status, plan, subscriber, next billing.',
    run: async (u, i) => {
      const c = await ctx(u, 'subscriptions');
      return c.run(() => pp.getSubscription(c.client, i.subscriptionId));
    },
  }),
  merchant({
    name: 'get_payment', risk: 'read', input: z.object({ orderId: pid('order').optional(), captureId: pid('capture').optional() }),
    description: 'Status of a payment link order or a captured payment.',
    run: async (u, i) => {
      const c = await ctx(u, 'payments');
      if (i.captureId) return c.run(() => pp.getCapture(c.client, i.captureId!));
      if (!i.orderId) throw badRequest('Provide orderId or captureId');
      return c.run(() => pp.getOrderDetails(c.client, i.orderId!));
    },
  }),

  // ─── auto (nothing reaches a customer and no money leaves) ───────────────
  merchant({
    name: 'create_invoice_draft', risk: 'auto',
    input: z.object({
      recipientEmail: z.string().email(),
      recipientName: z.string().max(80).optional(),
      items: z.array(z.object({ name: z.string().min(1).max(200), quantity: z.number().positive().max(100000).default(1), unitAmount: amount })).min(1).max(50),
      note: z.string().max(4000).optional(),
      dueInDays: z.number().int().min(0).max(365).optional().describe('0 = due on receipt'),
      currency: z.string().length(3).optional(),
    }),
    description: 'Create a DRAFT PayPal invoice (not sent). Use send_invoice afterwards to email it.',
    summary: (u, i) => { const total = i.items.reduce((s, it) => s + it.quantity * it.unitAmount, 0); return { title: 'Create invoice draft', amount: total, currency: i.currency ?? u.currency, recipient: { name: i.recipientName ?? i.recipientEmail, initials: (i.recipientName ?? i.recipientEmail).slice(0, 2).toUpperCase(), subtitle: i.recipientEmail, verified: false }, lines: [{ label: 'Items', value: i.items.map((it) => `${it.quantity}× ${it.name}`).join(', ').slice(0, 120) }, { label: 'Sent to customer', value: 'Not yet (draft)' }], confirmLabel: 'Create draft' }; },
    run: async (u, i) => {
      const c = await ctx(u, 'invoicing');
      const currency = i.currency ?? (await primaryCurrency(u));
      const due = i.dueInDays ? new Date(Date.now() + i.dueInDays * 86_400_000).toISOString().slice(0, 10) : undefined;
      const inv = await c.run(() =>
        pp.createDraftInvoice(
          c.client,
          { currency, recipientEmail: i.recipientEmail, recipientName: i.recipientName, items: i.items, note: i.note, dueDate: due, termType: i.dueInDays === 0 ? 'DUE_ON_RECEIPT' : undefined },
          newRequestId(),
        ),
      );
      return m.invoiceView(inv);
    },
  }),
  merchant({
    name: 'create_payment_link', risk: 'auto',
    input: z.object({ amount, description: z.string().max(127).optional(), currency: z.string().length(3).optional() }),
    summary: (u, i) => ({ title: 'Create payment link', amount: i.amount, currency: i.currency ?? u.currency, lines: [...(i.description ? [{ label: 'For', value: i.description }] : []), { label: 'Charged', value: 'Only when the customer approves' }], confirmLabel: 'Create link' }),
    description: 'Create a PayPal checkout link to collect a payment. Nothing is charged until the customer approves; then call capture_payment.',
    run: async (u, i) => {
      const c = await ctx(u, 'payments');
      const order = await c.run(() => pp.createPaymentOrder(c.client, { amount: money(i.amount, i.currency ?? u.currency), description: i.description }, newRequestId()));
      return { orderId: order.id, status: order.status, approveUrl: order.links?.find((l) => l.rel === 'approve' || l.rel === 'payer-action')?.href ?? null };
    },
  }),
  merchant({
    name: 'capture_payment', risk: 'auto', input: z.object({ orderId: pid('order') }),
    description: 'Collect a customer-approved payment link order into the merchant PayPal balance.',
    summary: (_u, i) => ({ title: 'Collect this payment?', lines: [{ label: 'Order', value: i.orderId }, { label: 'Into', value: 'Your PayPal balance' }], confirmLabel: 'Collect payment' }),
    run: async (u, i) => {
      const c = await ctx(u, 'payments');
      const res = await c.run(() => pp.captureOrder(c.client, i.orderId));
      const cap = res.purchase_units?.[0]?.payments?.captures?.[0];
      return { orderId: res.id, status: res.status, captureId: cap?.id ?? null, amount: cap?.amount ?? null };
    },
  }),
  merchant({
    name: 'create_product', risk: 'auto',
    input: z.object({ name: z.string().min(1).max(127), description: z.string().max(256).optional(), type: z.enum(['PHYSICAL', 'DIGITAL', 'SERVICE']).default('SERVICE') }),
    summary: (_u, i) => ({ title: `Add product “${i.name}”`, lines: [{ label: 'Type', value: i.type }, ...(i.description ? [{ label: 'Description', value: i.description }] : [])], confirmLabel: 'Add product' }),
    description: 'Add a catalog product (needed before creating a subscription plan).',
    run: async (u, i) => {
      const c = await ctx(u, 'subscriptions');
      return c.run(() => pp.createProduct(c.client, i, newRequestId()));
    },
  }),
  merchant({
    name: 'create_plan', risk: 'auto',
    input: z.object({ productId: pid('product'), name: z.string().min(1).max(127), price: amount, interval: z.enum(['DAY', 'WEEK', 'MONTH', 'YEAR']).default('MONTH'), currency: z.string().length(3).optional() }),
    description: 'Create an active subscription plan with a fixed price per interval.',
    summary: (u, i) => ({ title: `Create plan “${i.name}”`, amount: i.price, currency: i.currency ?? u.currency, lines: [{ label: 'Billed', value: `Every ${i.interval.toLowerCase()}` }, { label: 'Status', value: 'Active immediately' }], confirmLabel: 'Create plan' }),
    run: async (u, i) => {
      const c = await ctx(u, 'subscriptions');
      return c.run(() => pp.createPlan(c.client, { productId: i.productId, name: i.name, price: money(i.price, i.currency ?? u.currency), intervalUnit: i.interval }, newRequestId()));
    },
  }),
  merchant({
    name: 'activate_plan', risk: 'auto', input: z.object({ planId: pid('plan') }),
    description: 'Re-activate a subscription plan.',
    summary: (_u, i) => ({ title: 'Activate plan?', lines: [{ label: 'Plan', value: i.planId }], confirmLabel: 'Activate' }),
    run: async (u, i) => {
      const c = await ctx(u, 'subscriptions');
      await c.run(() => pp.setPlanActive(c.client, i.planId, true));
      return { planId: i.planId, status: 'ACTIVE' };
    },
  }),
  merchant({
    name: 'add_tracking', risk: 'auto',
    input: z.object({ transactionId: pid('transaction'), trackingNumber: z.string().min(3).max(64), carrier: z.string().min(2).max(40).describe('e.g. UPS, FEDEX, DHL, USPS, OTHER') }),
    description: 'Attach shipment tracking to a PayPal transaction (helps seller protection).',
    summary: (_u, i) => ({ title: 'Add shipment tracking', lines: [{ label: 'Carrier', value: i.carrier.toUpperCase() }, { label: 'Tracking number', value: i.trackingNumber }], confirmLabel: 'Add tracking' }),
    run: async (u, i) => {
      const c = await ctx(u, 'tracking');
      await c.run(() => pp.addTracking(c.client, { transactionId: i.transactionId, trackingNumber: i.trackingNumber, carrier: i.carrier.toUpperCase() }, newRequestId()));
      return { added: true, ...i };
    },
  }),

  // ─── confirm (money, customers or irreversible) ──────────────────────────
  merchant({
    name: 'create_and_send_invoice', risk: 'confirm',
    input: z.object({
      recipientEmail: z.string().email(),
      recipientName: z.string().max(80).optional(),
      items: z.array(z.object({ name: z.string().min(1).max(200), quantity: z.number().positive().max(100000).default(1), unitAmount: amount })).min(1).max(50),
      note: z.string().max(4000).optional(),
      dueInDays: z.number().int().min(0).max(365).optional(),
      currency: z.string().length(3).optional(),
    }),
    description: 'Create a PayPal invoice and email it to the customer in one step (one confirmation).',
    preview: async (u, i) => {
      await m.merchantClient(u, 'invoicing');
      const total = i.items.reduce((s, it) => s + it.quantity * it.unitAmount, 0);
      const name = i.recipientName ?? i.recipientEmail;
      return {
        title: 'Send invoice', amount: total, currency: i.currency ?? (await primaryCurrency(u)),
        recipient: { name, initials: name.slice(0, 2).toUpperCase(), subtitle: i.recipientEmail, verified: false },
        lines: [
          { label: 'Items', value: i.items.map((it) => `${it.quantity}× ${it.name}`).join(', ').slice(0, 120) },
          { label: 'Due', value: i.dueInDays === 0 ? 'On receipt' : i.dueInDays ? `In ${i.dueInDays} days` : 'Net 30' },
          { label: 'Sent by', value: 'PayPal email' },
        ],
        confirmLabel: 'Send invoice', style: 'tap', tone: 'default', biometric: false,
      };
    },
    execute: async (u, i, x) => {
      const c = await ctx(u, 'invoicing');
      const currency = i.currency ?? (await primaryCurrency(u));
      const due = i.dueInDays ? new Date(Date.now() + i.dueInDays * 86_400_000).toISOString().slice(0, 10) : undefined;
      const inv = await c.run(() =>
        pp.createDraftInvoice(c.client, { currency, recipientEmail: i.recipientEmail, recipientName: i.recipientName, items: i.items, note: i.note, dueDate: due, termType: i.dueInDays === 0 ? 'DUE_ON_RECEIPT' : undefined }, `${x.requestId}-create`),
      );
      await c.run(() => pp.sendInvoice(c.client, inv.id, `${x.requestId}-send`));
      return { invoiceId: inv.id, status: 'SENT' };
    },
  }),
  merchant({
    name: 'send_invoice', risk: 'confirm', input: z.object({ invoiceId: pid('invoice'), note: z.string().max(500).optional() }),
    description: 'Email an invoice to the customer.',
    preview: async (u, i) => {
      const { invoice } = await invoiceFor(u, i.invoiceId);
      if (invoice.status !== 'DRAFT' && invoice.status !== 'SCHEDULED') throw badRequest(`Invoice is ${invoice.status.toLowerCase()}, not a draft`);
      return {
        title: `Send invoice ${invoice.number ?? ''}`.trim(), amount: invoice.total, currency: invoice.currency, recipient: recipientOf(invoice),
        lines: [
          { label: 'Items', value: invoice.items.map((it) => `${it.quantity}× ${it.name}`).join(', ').slice(0, 120) || '—' },
          { label: 'Due', value: invoice.dueDate ?? invoice.termType?.replace(/_/g, ' ').toLowerCase() ?? 'On receipt' },
          { label: 'Sent by', value: 'PayPal email' },
        ],
        confirmLabel: 'Send invoice', style: 'tap', tone: 'default', biometric: false,
      };
    },
    execute: async (u, i, x) => {
      const c = await ctx(u, 'invoicing');
      await c.run(() => pp.sendInvoice(c.client, i.invoiceId, x.requestId, i.note));
      return { invoiceId: i.invoiceId, status: 'SENT' };
    },
  }),
  merchant({
    name: 'remind_invoice', risk: 'confirm', input: z.object({ invoiceId: pid('invoice'), note: z.string().max(500).optional() }),
    description: 'Email a payment reminder for an unpaid invoice.',
    preview: async (u, i) => {
      const { invoice } = await invoiceFor(u, i.invoiceId);
      return {
        title: 'Send reminder', amount: invoice.due, currency: invoice.currency, recipient: recipientOf(invoice),
        lines: [{ label: 'Invoice', value: invoice.number ?? invoice.id }, { label: 'Status', value: invoice.status.toLowerCase() }],
        confirmLabel: 'Send reminder', style: 'tap', tone: 'default', biometric: false,
      };
    },
    execute: async (u, i, x) => {
      const c = await ctx(u, 'invoicing');
      await c.run(() => pp.remindInvoice(c.client, i.invoiceId, x.requestId, i.note));
      return { invoiceId: i.invoiceId, reminded: true };
    },
  }),
  merchant({
    name: 'cancel_invoice', risk: 'confirm', input: z.object({ invoiceId: pid('invoice'), note: z.string().max(500).optional() }),
    description: 'Cancel a sent invoice (the customer is notified).',
    preview: async (u, i) => {
      const { invoice } = await invoiceFor(u, i.invoiceId);
      return {
        title: `Cancel invoice ${invoice.number ?? ''}?`.trim(), amount: invoice.total, currency: invoice.currency, recipient: recipientOf(invoice),
        lines: [{ label: 'Status', value: invoice.status.toLowerCase() }, { label: 'Customer is notified', value: 'Yes' }],
        confirmLabel: 'Cancel invoice', style: 'tap', tone: 'danger', biometric: false,
      };
    },
    execute: async (u, i, x) => {
      const c = await ctx(u, 'invoicing');
      await c.run(() => pp.cancelInvoice(c.client, i.invoiceId, x.requestId, i.note));
      return { invoiceId: i.invoiceId, status: 'CANCELLED' };
    },
  }),
  merchant({
    name: 'delete_invoice', risk: 'confirm', input: z.object({ invoiceId: pid('invoice') }),
    description: 'Delete a draft invoice.',
    preview: async (u, i) => {
      const { invoice } = await invoiceFor(u, i.invoiceId);
      if (invoice.status !== 'DRAFT') throw badRequest('Only draft invoices can be deleted; cancel sent ones instead');
      return {
        title: 'Delete draft invoice?', amount: invoice.total, currency: invoice.currency, recipient: recipientOf(invoice),
        lines: [{ label: 'This cannot be undone', value: '' }], confirmLabel: 'Delete', style: 'tap', tone: 'danger', biometric: false,
      };
    },
    execute: async (u, i) => {
      const c = await ctx(u, 'invoicing');
      await c.run(() => pp.deleteInvoice(c.client, i.invoiceId));
      return { invoiceId: i.invoiceId, deleted: true };
    },
  }),
  merchant({
    name: 'record_invoice_payment', risk: 'confirm',
    input: z.object({ invoiceId: pid('invoice'), amount: amount.optional(), method: z.enum(['CASH', 'CHECK', 'BANK_TRANSFER', 'OTHER']).default('OTHER'), note: z.string().max(200).optional() }),
    description: 'Mark an invoice as paid outside PayPal (cash, check, bank transfer).',
    preview: async (u, i) => {
      const { invoice } = await invoiceFor(u, i.invoiceId);
      return {
        title: 'Record payment', amount: i.amount ?? invoice.due, currency: invoice.currency, recipient: recipientOf(invoice),
        lines: [{ label: 'Method', value: i.method.replace('_', ' ').toLowerCase() }, { label: 'Invoice', value: invoice.number ?? invoice.id }],
        confirmLabel: 'Record payment', style: 'tap', tone: 'default', biometric: false,
      };
    },
    execute: async (u, i, x) => {
      const { client, run, invoice } = await invoiceFor(u, i.invoiceId);
      await run(() => pp.recordInvoicePayment(client, i.invoiceId, money(i.amount ?? invoice.due, invoice.currency), i.method, x.requestId, i.note));
      return { invoiceId: i.invoiceId, recorded: true };
    },
  }),
  merchant({
    name: 'refund_payment', risk: 'confirm',
    input: z.object({ captureId: pid('capture/transaction'), amount: amount.optional().describe('Omit for a full refund'), note: z.string().max(255).optional() }),
    description: 'Refund a captured PayPal payment to the customer (full or partial).',
    preview: async (u, i) => {
      const c = await ctx(u, 'refunds');
      const cap = await c.run(() => pp.getCapture(c.client, i.captureId));
      const total = Number(cap.amount.value);
      if (i.amount && i.amount > total) throw badRequest(`Refund can't exceed ${cap.amount.value} ${cap.amount.currency_code}`);
      return {
        title: i.amount && i.amount < total ? 'Partial refund' : 'Full refund', amount: i.amount ?? total, currency: cap.amount.currency_code,
        lines: [
          { label: 'Payment', value: `${cap.amount.value} ${cap.amount.currency_code}` },
          { label: 'Status', value: cap.status.toLowerCase() },
          ...(i.note ? [{ label: 'Note to customer', value: i.note }] : []),
          { label: 'Funds leave', value: 'Your PayPal balance' },
        ],
        confirmLabel: 'Hold to refund', style: 'hold', tone: 'danger', biometric: u.settings.biometricForSensitive !== false,
      };
    },
    execute: async (u, i, x) => {
      const c = await ctx(u, 'refunds');
      const cap = await c.run(() => pp.getCapture(c.client, i.captureId));
      const res = await c.run(() => pp.refundCapture(c.client, i.captureId, x.requestId, i.amount ? money(i.amount, cap.amount.currency_code) : undefined, i.note));
      return { refundId: res.id, status: res.status };
    },
  }),
  merchant({
    name: 'accept_dispute_claim', risk: 'confirm', input: z.object({ disputeId: pid('dispute'), note: z.string().min(1).max(2000).default('Accepting the claim.') }),
    description: 'Accept liability for a dispute; the customer is refunded.',
    preview: async (u, i) => {
      const c = await ctx(u, 'disputes');
      const d = m.disputeView(await c.run(() => pp.getDispute(c.client, i.disputeId)));
      return {
        title: 'Accept claim?', amount: d.amount, currency: d.currency,
        lines: [{ label: 'Reason', value: d.reason }, { label: 'Stage', value: (d.stage ?? '').toLowerCase() }, { label: 'Customer is refunded', value: 'Yes' }],
        confirmLabel: 'Hold to accept', style: 'hold', tone: 'danger', biometric: u.settings.biometricForSensitive !== false,
      };
    },
    execute: async (u, i, x) => {
      const c = await ctx(u, 'disputes');
      await c.run(() => pp.acceptClaim(c.client, i.disputeId, x.requestId, i.note));
      return { disputeId: i.disputeId, accepted: true };
    },
  }),
  merchant({
    name: 'send_dispute_message', risk: 'confirm', input: z.object({ disputeId: pid('dispute'), message: z.string().min(1).max(2000) }),
    description: 'Send a message to the customer about a dispute.',
    preview: async (_u, i) => ({
      title: 'Message the customer', lines: [{ label: 'Dispute', value: i.disputeId }, { label: 'Message', value: i.message.slice(0, 120) }],
      confirmLabel: 'Send message', style: 'tap', tone: 'default', biometric: false,
    }),
    execute: async (u, i, x) => {
      const c = await ctx(u, 'disputes');
      await c.run(() => pp.sendDisputeMessage(c.client, i.disputeId, x.requestId, i.message));
      return { disputeId: i.disputeId, sent: true };
    },
  }),
  merchant({
    name: 'merchant_payout', risk: 'confirm',
    input: z.object({ email: z.string().email(), amount, note: z.string().max(200).optional(), currency: z.string().length(3).optional() }),
    description: "Pay someone by email from the merchant's PayPal balance (Payouts API).",
    preview: async (u, i) => {
      const currency = i.currency ?? (await primaryCurrency(u));
      return {
        title: `Pay ${i.email}`, amount: i.amount, currency,
        recipient: { name: i.email, initials: i.email.slice(0, 2).toUpperCase(), subtitle: 'PayPal payout', verified: false },
        lines: [{ label: 'From', value: 'Your PayPal business balance' }, { label: 'Fee', value: 'Per your PayPal Payouts pricing' }, ...(i.note ? [{ label: 'Note', value: i.note }] : [])],
        confirmLabel: 'Hold to pay', style: 'hold', tone: 'default', biometric: u.settings.biometricForSensitive !== false,
      };
    },
    execute: async (u, i, x) => {
      const c = await ctx(u, 'payouts');
      const currency = i.currency ?? (await primaryCurrency(u));
      const res = await c.run(() => pp.merchantPayout(c.client, { batchId: x.requestId, email: i.email, amount: money(i.amount, currency), note: i.note }));
      return { payoutBatchId: res.batch_header.payout_batch_id, status: res.batch_header.batch_status };
    },
  }),
  ...(['suspend', 'cancel', 'activate'] as const).map((op) =>
    merchant({
      name: `${op}_subscription`, risk: 'confirm',
      input: z.object({ subscriptionId: pid('subscription'), reason: z.string().min(1).max(128).default(`${op} requested by merchant`) }),
      description: `${op[0]!.toUpperCase()}${op.slice(1)} a customer's subscription.`,
      preview: async (u, i) => {
        const c = await ctx(u, 'subscriptions');
        const s = await c.run(() => pp.getSubscription(c.client, i.subscriptionId));
        const who = s.subscriber?.email_address ?? 'Subscriber';
        return {
          title: `${op[0]!.toUpperCase()}${op.slice(1)} subscription?`,
          recipient: { name: who, initials: who.slice(0, 2).toUpperCase(), subtitle: `Plan ${s.plan_id ?? ''}`.trim(), verified: false },
          lines: [{ label: 'Current status', value: s.status.toLowerCase() }, { label: 'Reason', value: i.reason }],
          confirmLabel: `${op[0]!.toUpperCase()}${op.slice(1)}`, style: 'tap', tone: op === 'activate' ? 'default' : 'danger', biometric: false,
        };
      },
      execute: async (u, i, x) => {
        const c = await ctx(u, 'subscriptions');
        await c.run(() => pp.changeSubscription(c.client, i.subscriptionId, op, i.reason, x.requestId));
        return { subscriptionId: i.subscriptionId, op };
      },
    }),
  ),
  merchant({
    name: 'deactivate_plan', risk: 'confirm', input: z.object({ planId: pid('plan') }),
    description: 'Deactivate a subscription plan (no new subscribers).',
    preview: async (_u, i) => ({
      title: 'Deactivate plan?', lines: [{ label: 'Plan', value: i.planId }, { label: 'Existing subscribers', value: 'Unaffected' }],
      confirmLabel: 'Deactivate', style: 'tap', tone: 'danger', biometric: false,
    }),
    execute: async (u, i) => {
      const c = await ctx(u, 'subscriptions');
      await c.run(() => pp.setPlanActive(c.client, i.planId, false));
      return { planId: i.planId, status: 'INACTIVE' };
    },
  }),
];
