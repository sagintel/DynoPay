import crypto from 'node:crypto';
import { MerchantConnection, User } from '../db/index.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { AppError, badRequest, conflict, forbidden } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { formatMoney, toMinor } from '../lib/money.js';
import { PayPalClient, type PayPalEnv } from '../paypal/client.js';
import * as pp from '../paypal/merchant.js';
import { createUser } from './users.js';

// ─── Capabilities (from the scopes PayPal granted the merchant's REST app) ──

export const CAPABILITIES = {
  reporting: { label: 'Balance & transaction reporting', scopes: ['reporting/search/read'] },
  invoicing: { label: 'Invoicing', scopes: ['services/invoicing'] },
  payments: { label: 'Payment links & captures', scopes: ['payments/payment', 'checkout'] },
  refunds: { label: 'Refunds', scopes: ['payments/refund'] },
  disputes: { label: 'Disputes', scopes: ['disputes/read-seller'] },
  subscriptions: { label: 'Catalog & subscriptions', scopes: ['services/subscriptions'] },
  payouts: { label: 'Payouts', scopes: ['payments/payouts'] },
  tracking: { label: 'Shipment tracking', scopes: ['shipping/trackers'] },
} as const;
export type Capability = keyof typeof CAPABILITIES;

/** If PayPal returned no scope list we can't know, so we allow the call and surface any 403 clearly. */
export function hasCapability(scopes: string[], cap: Capability): boolean {
  if (!scopes.length) return true;
  return CAPABILITIES[cap].scopes.some((needle) => scopes.some((s) => s.includes(needle)));
}

export function capabilityList(scopes: string[]) {
  return (Object.keys(CAPABILITIES) as Capability[]).map((key) => ({ key, label: CAPABILITIES[key].label, enabled: hasCapability(scopes, key) }));
}

// ─── Clients ───────────────────────────────────────────────────────────────

const clients = new Map<string, PayPalClient>();

function clientFromConnection(conn: MerchantConnection): PayPalClient {
  const cacheKey = `${conn.id}:${conn.updatedAt.getTime()}`;
  let client = clients.get(cacheKey);
  if (!client) {
    for (const k of clients.keys()) if (k.startsWith(`${conn.id}:`)) clients.delete(k);
    client = new PayPalClient(conn.clientId, decryptSecret(conn.secretEnc), conn.environment, 'PayPal');
    clients.set(cacheKey, client);
  }
  return client;
}

export async function getConnection(user: User): Promise<MerchantConnection | null> {
  return MerchantConnection.findOne({ where: { userId: user.id } });
}

/** The PayPal client for this merchant, or a clear error if the user isn't a connected merchant. */
export async function merchantClient(user: User, cap?: Capability): Promise<{ client: PayPalClient; conn: MerchantConnection }> {
  const conn = await getConnection(user);
  if (!conn) throw forbidden('Connect your PayPal business REST credentials to use merchant features');
  if (conn.status !== 'active') throw new AppError('unauthorized', 'Your PayPal API credentials stopped working. Reconnect them in Settings.');
  if (cap && !hasCapability(conn.scopes, cap)) {
    throw forbidden(`${CAPABILITIES[cap].label} isn't enabled for your PayPal REST app. Turn it on in the PayPal developer dashboard, then reconnect.`);
  }
  return { client: clientFromConnection(conn), conn };
}

// ─── Verify / connect / sign in ────────────────────────────────────────────

export type MerchantCredentials = { clientId: string; clientSecret: string; environment: PayPalEnv; businessName?: string };

function validate(creds: MerchantCredentials) {
  const clientId = creds.clientId.trim();
  const clientSecret = creds.clientSecret.trim();
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(clientId)) throw badRequest('That does not look like a PayPal Client ID');
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(clientSecret)) throw badRequest('That does not look like a PayPal Secret');
  return { ...creds, clientId, clientSecret, businessName: creds.businessName?.trim().slice(0, 80) || undefined };
}

/** Proves possession of the credentials by obtaining a token from PayPal, and discovers what the app may do. */
export async function verifyCredentials(raw: MerchantCredentials) {
  const creds = validate(raw);
  const client = new PayPalClient(creds.clientId, creds.clientSecret, creds.environment);
  const token = await client.getToken(true);
  let accountId: string | null = null;
  if (hasCapability(token.scopes, 'reporting')) {
    try {
      accountId = (await pp.getBalances(client)).account_id ?? null;
    } catch (err) {
      logger.info({ err: (err as Error).message }, 'balances probe failed (reporting may be disabled)');
    }
  }
  return { creds, appId: token.appId, scopes: token.scopes, accountId };
}

async function saveConnection(user: User, v: Awaited<ReturnType<typeof verifyCredentials>>, existing?: MerchantConnection | null) {
  const values = {
    userId: user.id,
    environment: v.creds.environment,
    clientId: v.creds.clientId,
    secretEnc: encryptSecret(v.creds.clientSecret),
    appId: v.appId,
    accountId: v.accountId,
    businessName: v.creds.businessName ?? existing?.businessName ?? user.name,
    scopes: v.scopes,
    status: 'active' as const,
    lastVerifiedAt: new Date(),
  };
  const conn = existing ? await existing.update(values) : await MerchantConnection.create(values);
  // Evict any stale balance/transaction results so the next screen load fetches fresh PayPal data.
  clearMerchantCache(v.creds.environment, v.creds.clientId);
  if (user.accountType !== 'business') await user.update({ accountType: 'business' });
  return conn;
}

/**
 * "Sign in with PayPal REST API credentials". The merchant is identified by (environment, client id);
 * holding a valid secret for that app is the proof of ownership. Accounts are never merged by email.
 */
export async function signInWithCredentials(raw: MerchantCredentials): Promise<{ user: User; created: boolean }> {
  const v = await verifyCredentials(raw);
  const existing = await MerchantConnection.findOne({ where: { environment: v.creds.environment, clientId: v.creds.clientId } });
  if (existing) {
    const user = await User.findByPk(existing.userId);
    if (user) {
      await saveConnection(user, v, existing);
      return { user, created: false };
    }
    await existing.destroy();
  }
  const key = (v.accountId ?? v.appId ?? crypto.createHash('sha256').update(v.creds.clientId).digest('hex').slice(0, 16)).toLowerCase();
  const user = await createUser({
    // Synthetic, unique, never used to contact anyone: PayPal doesn't reveal the merchant's email to an app token.
    email: `merchant+${v.creds.environment}-${key}@merchants.dynopay.invalid`,
    name: v.creds.businessName ?? 'PayPal Merchant',
    verified: true,
    paypalPayerId: v.accountId,
  });
  await user.update({ accountType: 'business' });
  await saveConnection(user, v);
  return { user, created: true };
}

/** A signed-in user (e.g. via Log in with PayPal) adds their business REST credentials. */
export async function connectCredentials(user: User, raw: MerchantCredentials) {
  const v = await verifyCredentials(raw);
  const taken = await MerchantConnection.findOne({ where: { environment: v.creds.environment, clientId: v.creds.clientId } });
  if (taken && taken.userId !== user.id) throw conflict('These API credentials are already linked to another DynoPay account');
  const conn = await saveConnection(user, v, (await getConnection(user)) ?? null);
  return connectionView(conn);
}

export async function disconnect(user: User) {
  const conn = await getConnection(user);
  if (!conn) return { disconnected: false };
  if (!user.paypalUserId) {
    throw badRequest('This account signs in with these credentials. Sign out instead, or rotate them by signing in again.');
  }
  await conn.destroy();
  await user.update({ accountType: 'personal' });
  return { disconnected: true };
}

export function connectionView(conn: MerchantConnection | null) {
  if (!conn) return null;
  return {
    environment: conn.environment,
    businessName: conn.businessName,
    clientId: `${conn.clientId.slice(0, 6)}…${conn.clientId.slice(-4)}`,
    appId: conn.appId,
    accountId: conn.accountId,
    status: conn.status,
    capabilities: capabilityList(conn.scopes),
    lastVerifiedAt: conn.lastVerifiedAt?.toISOString() ?? null,
  };
}

/** Marks the connection invalid when PayPal starts rejecting the secret (rotated/revoked). */
export async function guard<T>(conn: MerchantConnection, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError && err.code === 'unauthorized') await conn.update({ status: 'invalid' });
    throw err;
  }
}

// ─── Views over PayPal payloads ────────────────────────────────────────────

const num = (m?: pp.Money) => (m ? Number(m.value) : 0);
const fmt = (value: number, currency: string) => formatMoney(toMinor(Math.round(value * 100) / 100), currency);

const EVENT_GROUPS: [string, string][] = [
  ['T00', 'Payment'], ['T01', 'Fee'], ['T02', 'Currency conversion'], ['T03', 'Bank deposit'], ['T04', 'Bank withdrawal'],
  ['T05', 'Debit card'], ['T06', 'Card withdrawal'], ['T07', 'Card deposit'], ['T08', 'Bonus'], ['T09', 'Incentive'],
  ['T10', 'Bill pay'], ['T11', 'Refund / reversal'], ['T12', 'Adjustment'], ['T13', 'Authorization'], ['T14', 'Dividend'],
  ['T15', 'Hold'], ['T16', 'Buyer credit'], ['T17', 'Withdrawal'], ['T19', 'Correction'], ['T20', 'Transfer'], ['T21', 'Reserve'], ['T22', 'Transfer'],
];
const STATUS: Record<string, string> = { S: 'completed', P: 'pending', V: 'reversed', D: 'denied', F: 'refunded' };

export function paypalTxView(t: pp.ReportingTransaction) {
  const info = t.transaction_info;
  const amount = num(info.transaction_amount);
  const currency = info.transaction_amount?.currency_code ?? 'USD';
  const fee = num(info.fee_amount);
  const payer = t.payer_info;
  const name =
    payer?.payer_name?.alternate_full_name ??
    [payer?.payer_name?.given_name, payer?.payer_name?.surname].filter(Boolean).join(' ') ??
    '';
  const code = info.transaction_event_code ?? '';
  return {
    id: info.transaction_id,
    date: info.transaction_initiation_date ?? info.transaction_updated_date ?? null,
    type: EVENT_GROUPS.find(([p]) => code.startsWith(p))?.[1] ?? 'Transaction',
    eventCode: code,
    status: STATUS[info.transaction_status ?? ''] ?? (info.transaction_status ?? 'unknown').toLowerCase(),
    direction: amount < 0 ? ('out' as const) : ('in' as const),
    amount,
    fee,
    net: Math.round((amount + fee) * 100) / 100,
    currency,
    formatted: fmt(amount, currency),
    counterparty: name || payer?.email_address || info.transaction_subject || 'PayPal',
    email: payer?.email_address ?? null,
    subject: info.transaction_subject ?? t.cart_info?.item_details?.[0]?.item_name ?? null,
    note: info.transaction_note ?? null,
    invoiceId: info.invoice_id ?? null,
  };
}
export type PayPalTxView = ReturnType<typeof paypalTxView>;

export function invoiceView(i: pp.Invoice) {
  const r = i.primary_recipients?.[0]?.billing_info;
  const currency = i.amount?.currency_code ?? i.detail.currency_code ?? 'USD';
  const total = num(i.amount);
  const due = i.due_amount ? num(i.due_amount) : total;
  return {
    id: i.id,
    number: i.detail.invoice_number ?? null,
    status: i.status,
    recipient: r?.name?.full_name ?? ([r?.name?.given_name, r?.name?.surname].filter(Boolean).join(' ') || r?.business_name || r?.email_address || 'Customer'),
    recipientEmail: r?.email_address ?? null,
    total,
    due,
    currency,
    formatted: fmt(total, currency),
    formattedDue: fmt(due, currency),
    invoiceDate: i.detail.invoice_date ?? null,
    dueDate: i.detail.payment_term?.due_date ?? null,
    termType: i.detail.payment_term?.term_type ?? null,
    note: i.detail.note ?? null,
    items: (i.items ?? []).map((it) => ({ name: it.name, quantity: Number(it.quantity), unitAmount: num(it.unit_amount) })),
    payerUrl: i.detail.metadata?.recipient_view_url ?? null,
  };
}
export type InvoiceView = ReturnType<typeof invoiceView>;

export function disputeView(d: pp.DisputeSummary) {
  const currency = d.dispute_amount?.currency_code ?? 'USD';
  return {
    id: d.dispute_id,
    reason: (d.reason ?? 'OTHER').replace(/_/g, ' ').toLowerCase(),
    status: d.status ?? 'OPEN',
    stage: d.dispute_life_cycle_stage ?? null,
    amount: num(d.dispute_amount),
    currency,
    formatted: fmt(num(d.dispute_amount), currency),
    createdAt: d.create_time ?? null,
    respondBy: d.seller_response_due_date ?? null,
    needsAction: d.status === 'WAITING_FOR_SELLER_RESPONSE',
  };
}

// ─── Aggregates ────────────────────────────────────────────────────────────

const DAY = 86_400_000;

/** Short-lived cache so one screen (overview + sales + activity) doesn't hit Transaction Search three times. */
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = fn().catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return value;
}

/** Evicts all balance/transaction cache entries for a given (env, clientId) pair. */
function clearMerchantCache(environment: string, clientId: string) {
  for (const k of cache.keys()) {
    if (k.includes(`:${environment}:${clientId}`)) cache.delete(k);
  }
}

/** Fetches reporting transactions for the last `days` (chunked in ≤31-day windows, as PayPal requires). */
export function recentPayPalTransactions(client: PayPalClient, days: number, maxItems = 500): Promise<PayPalTxView[]> {
  return cached(`tx:${client.environment}:${client.clientId}:${days}:${maxItems}`, 60_000, () => fetchPayPalTransactions(client, days, maxItems));
}

async function fetchPayPalTransactions(client: PayPalClient, days: number, maxItems: number) {
  const end = new Date();
  const out: PayPalTxView[] = [];
  for (let windowEnd = end; windowEnd.getTime() > end.getTime() - days * DAY && out.length < maxItems; ) {
    const windowStart = new Date(Math.max(end.getTime() - days * DAY, windowEnd.getTime() - 31 * DAY + 1000));
    const res = await pp.listReportingTransactions(client, { start: windowStart, end: windowEnd, pageSize: 100 });
    out.push(...(res.transaction_details ?? []).map(paypalTxView));
    windowEnd = new Date(windowStart.getTime() - 1000);
  }
  return out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, maxItems);
}

export function salesSummary(txs: PayPalTxView[], days: number, currency: string) {
  const payments = txs.filter((t) => t.type === 'Payment' && t.direction === 'in' && t.status !== 'denied');
  const refunds = txs.filter((t) => t.type === 'Refund / reversal');
  const byDay = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) byDay.set(new Date(Date.now() - i * DAY).toISOString().slice(0, 10), 0);
  for (const t of payments) if (t.date) byDay.set(t.date.slice(0, 10), (byDay.get(t.date.slice(0, 10)) ?? 0) + t.amount);
  const gross = payments.reduce((s, t) => s + t.amount, 0);
  const fees = payments.reduce((s, t) => s + t.fee, 0);
  const refunded = refunds.reduce((s, t) => s + Math.abs(t.amount), 0);
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    days,
    currency,
    gross: round(gross),
    fees: round(fees),
    refunded: round(refunded),
    net: round(gross + fees - refunded),
    count: payments.length,
    average: payments.length ? round(gross / payments.length) : 0,
    formattedGross: fmt(gross, currency),
    formattedNet: fmt(gross + fees - refunded, currency),
    buckets: [...byDay.entries()].map(([key, amount]) => ({ key, label: key, amount: round(amount), share: gross ? Math.round((amount / gross) * 1000) / 10 : 0 })),
  };
}

export async function merchantBalance(client: PayPalClient) {
  const b = await cached(`bal:${client.environment}:${client.clientId}`, 30_000, () => pp.getBalances(client));
  const list = (b.balances ?? []).map((x) => ({
    currency: x.currency,
    primary: !!x.primary,
    total: num(x.total_balance),
    available: num(x.available_balance ?? x.total_balance),
    withheld: num(x.withheld_balance),
    formatted: fmt(num(x.total_balance), x.currency),
  }));
  const primary = list.find((x) => x.primary) ?? list[0] ?? null;
  return { accountId: b.account_id ?? null, asOf: b.as_of_time ?? null, primary, balances: list };
}

/** One call for the merchant home: each part degrades independently if a capability is off. */
export async function merchantOverview(user: User) {
  const { client, conn } = await merchantClient(user);
  const safe = async <T>(cap: Capability, fn: () => Promise<T>): Promise<T | null> => {
    if (!hasCapability(conn.scopes, cap)) return null;
    try {
      return await guard(conn, fn);
    } catch (err) {
      logger.info({ cap, err: (err as Error).message }, 'merchant overview part unavailable');
      return null;
    }
  };
  const [balance, txs, invoices, disputes] = await Promise.all([
    safe('reporting', () => merchantBalance(client)),
    safe('reporting', () => recentPayPalTransactions(client, 30, 500)),
    safe('invoicing', () => pp.searchInvoices(client, { status: ['SENT', 'UNPAID', 'PARTIALLY_PAID'] }, 50)),
    safe('disputes', () => pp.listDisputes(client)),
  ]);
  const currency = balance?.primary?.currency ?? txs?.[0]?.currency ?? user.currency;
  return {
    businessName: conn.businessName,
    environment: conn.environment,
    balance,
    sales30: txs ? salesSummary(txs, 30, currency) : null,
    unpaidInvoices: invoices ? { count: invoices.total_items ?? invoices.items?.length ?? 0, total: (invoices.items ?? []).reduce((s, i) => s + num(i.due_amount ?? i.amount), 0) } : null,
    openDisputes: disputes ? (disputes.items ?? []).filter((d) => d.status !== 'RESOLVED').length : null,
    capabilities: capabilityList(conn.scopes),
  };
}
