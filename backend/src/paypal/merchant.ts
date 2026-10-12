import type { PayPalClient } from './client.js';

/**
 * Merchant REST APIs, called with the merchant's own app credentials.
 * Paths and payloads follow paypal/paypal-rest-api-specifications (OpenAPI).
 */

export type Money = { currency_code: string; value: string };

// ─── Reporting (Transaction Search) ────────────────────────────────────────

export type BalancesResponse = {
  account_id?: string;
  as_of_time?: string;
  balances?: { currency: string; primary?: boolean; total_balance: Money; available_balance?: Money; withheld_balance?: Money }[];
};

export const getBalances = (c: PayPalClient, currency?: string) =>
  c.request<BalancesResponse>('/v1/reporting/balances', { query: { currency_code: currency } });

export type ReportingTransaction = {
  transaction_info: {
    transaction_id: string;
    transaction_event_code?: string;
    transaction_initiation_date?: string;
    transaction_updated_date?: string;
    transaction_amount?: Money;
    fee_amount?: Money;
    transaction_status?: string;
    transaction_subject?: string;
    transaction_note?: string;
    invoice_id?: string;
    custom_field?: string;
    ending_balance?: Money;
  };
  payer_info?: { account_id?: string; email_address?: string; payer_name?: { given_name?: string; surname?: string; alternate_full_name?: string } };
  cart_info?: { item_details?: { item_name?: string }[] };
};

export type TransactionsResponse = {
  transaction_details?: ReportingTransaction[];
  total_items?: number;
  total_pages?: number;
  page?: number;
  last_refreshed_datetime?: string;
};

/** PayPal requires start/end dates and limits a search window to 31 days. */
export const listReportingTransactions = (
  c: PayPalClient,
  q: { start: Date; end: Date; page?: number; pageSize?: number; transactionId?: string; status?: string },
) =>
  c.request<TransactionsResponse>('/v1/reporting/transactions', {
    query: {
      start_date: q.start.toISOString().replace(/\.\d{3}Z$/, '-0000'),
      end_date: q.end.toISOString().replace(/\.\d{3}Z$/, '-0000'),
      fields: 'transaction_info,payer_info,cart_info',
      page_size: q.pageSize ?? 100,
      page: q.page ?? 1,
      transaction_id: q.transactionId,
      transaction_status: q.status,
    },
  });

// ─── Invoicing v2 ──────────────────────────────────────────────────────────

export type Invoice = {
  id: string;
  status: string;
  detail: { invoice_number?: string; invoice_date?: string; currency_code?: string; note?: string; memo?: string; payment_term?: { term_type?: string; due_date?: string }; metadata?: { recipient_view_url?: string; invoicer_view_url?: string; create_time?: string } };
  invoicer?: { business_name?: string; email_address?: string };
  primary_recipients?: { billing_info?: { email_address?: string; business_name?: string; name?: { given_name?: string; surname?: string; full_name?: string } } }[];
  items?: { name: string; quantity: string; unit_amount: Money; description?: string }[];
  amount?: Money;
  due_amount?: Money;
  links?: { href: string; rel: string; method?: string }[];
};

export const listInvoices = (c: PayPalClient, page = 1, pageSize = 20) =>
  c.request<{ items?: Invoice[]; total_items?: number; total_pages?: number }>('/v2/invoicing/invoices', {
    query: { page, page_size: pageSize, total_required: true },
  });

export const searchInvoices = (c: PayPalClient, search: Record<string, unknown>, pageSize = 20) =>
  c.request<{ items?: Invoice[]; total_items?: number }>('/v2/invoicing/search-invoices', {
    method: 'POST',
    body: search,
    query: { page: 1, page_size: pageSize, total_required: true },
  });

export const getInvoice = (c: PayPalClient, id: string) => c.request<Invoice>(`/v2/invoicing/invoices/${encodeURIComponent(id)}`);

export async function createDraftInvoice(
  c: PayPalClient,
  input: {
    currency: string;
    recipientEmail: string;
    recipientName?: string;
    items: { name: string; quantity: number; unitAmount: number; description?: string }[];
    note?: string;
    termType?: string;
    dueDate?: string;
  },
  requestId: string,
): Promise<Invoice> {
  const [given, ...rest] = (input.recipientName ?? '').trim().split(/\s+/);
  const created = await c.request<Invoice & { href?: string }>('/v2/invoicing/invoices', {
    method: 'POST',
    idempotencyKey: requestId,
    headers: { Prefer: 'return=representation' },
    body: {
      detail: {
        currency_code: input.currency,
        note: input.note,
        payment_term: input.dueDate ? { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: input.dueDate } : { term_type: input.termType ?? 'NET_30' },
      },
      primary_recipients: [
        {
          billing_info: {
            email_address: input.recipientEmail,
            ...(given ? { name: { given_name: given, surname: rest.join(' ') || undefined } } : {}),
          },
        },
      ],
      items: input.items.map((i) => ({
        name: i.name,
        description: i.description,
        quantity: String(i.quantity),
        unit_amount: { currency_code: input.currency, value: i.unitAmount.toFixed(2) },
      })),
    },
  });
  // Without return=representation support PayPal answers with a link only; fetch the full invoice.
  if (created.id && created.status) return created;
  const id = created.href?.split('/').pop() ?? (created as { links?: { href: string }[] }).links?.[0]?.href.split('/').pop();
  if (!id) throw new Error('PayPal did not return the invoice id');
  return getInvoice(c, id);
}

export const sendInvoice = (c: PayPalClient, id: string, requestId: string, note?: string) =>
  c.request<{ href?: string }>(`/v2/invoicing/invoices/${encodeURIComponent(id)}/send`, {
    method: 'POST',
    idempotencyKey: requestId,
    body: { send_to_invoicer: true, send_to_recipient: true, note },
  });

export const remindInvoice = (c: PayPalClient, id: string, requestId: string, note?: string) =>
  c.request(`/v2/invoicing/invoices/${encodeURIComponent(id)}/remind`, {
    method: 'POST',
    idempotencyKey: requestId,
    body: { subject: 'Payment reminder', note, send_to_invoicer: false, send_to_recipient: true },
  });

export const cancelInvoice = (c: PayPalClient, id: string, requestId: string, note?: string) =>
  c.request(`/v2/invoicing/invoices/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    idempotencyKey: requestId,
    body: { subject: 'Invoice cancelled', note, send_to_invoicer: true, send_to_recipient: true },
  });

export const deleteInvoice = (c: PayPalClient, id: string) => c.request(`/v2/invoicing/invoices/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const recordInvoicePayment = (c: PayPalClient, id: string, amount: Money, method: string, requestId: string, note?: string) =>
  c.request(`/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`, {
    method: 'POST',
    idempotencyKey: requestId,
    body: { method, payment_date: new Date().toISOString().slice(0, 10), amount, note },
  });

export const invoiceQrCode = (c: PayPalClient, id: string) =>
  c.request<unknown>(`/v2/invoicing/invoices/${encodeURIComponent(id)}/generate-qr-code`, { method: 'POST', body: { width: 300, height: 300 } });

// ─── Payments v2 (refunds) ─────────────────────────────────────────────────

export const getCapture = (c: PayPalClient, captureId: string) =>
  c.request<{ id: string; status: string; amount: Money; invoice_id?: string; create_time?: string }>(`/v2/payments/captures/${encodeURIComponent(captureId)}`);

export const refundCapture = (c: PayPalClient, captureId: string, requestId: string, amount?: Money, note?: string) =>
  c.request<{ id: string; status: string; amount?: Money }>(`/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    method: 'POST',
    idempotencyKey: requestId,
    headers: { Prefer: 'return=representation' },
    body: { ...(amount ? { amount } : {}), ...(note ? { note_to_payer: note.slice(0, 255) } : {}) },
  });

// ─── Orders v2 (payment links / collecting payments) ───────────────────────

export const createPaymentOrder = (c: PayPalClient, input: { amount: Money; description?: string; invoiceId?: string }, requestId: string) =>
  c.request<{ id: string; status: string; links?: { href: string; rel: string }[] }>('/v2/checkout/orders', {
    method: 'POST',
    idempotencyKey: requestId,
    body: {
      intent: 'CAPTURE',
      purchase_units: [{ amount: input.amount, description: input.description?.slice(0, 127), invoice_id: input.invoiceId }],
    },
  });

export const getOrderDetails = (c: PayPalClient, id: string) =>
  c.request<{ id: string; status: string; purchase_units?: { amount?: Money; payments?: { captures?: { id: string; status: string; amount: Money }[] } }[] }>(
    `/v2/checkout/orders/${encodeURIComponent(id)}`,
  );

export const captureOrder = (c: PayPalClient, id: string) =>
  c.request<{ id: string; status: string; purchase_units?: { payments?: { captures?: { id: string; status: string; amount: Money }[] } }[] }>(
    `/v2/checkout/orders/${encodeURIComponent(id)}/capture`,
    { method: 'POST', idempotencyKey: `capture-${id}`, body: {} },
  );

// ─── Disputes v1 ───────────────────────────────────────────────────────────

export type DisputeSummary = {
  dispute_id: string;
  create_time?: string;
  update_time?: string;
  reason?: string;
  status?: string;
  dispute_state?: string;
  dispute_amount?: Money;
  dispute_life_cycle_stage?: string;
  seller_response_due_date?: string;
};

export const listDisputes = (c: PayPalClient, status?: string) =>
  c.request<{ items?: DisputeSummary[] }>('/v1/customer/disputes', { query: { dispute_state: status, page_size: 20 } });

export const getDispute = (c: PayPalClient, id: string) =>
  c.request<DisputeSummary & { messages?: { posted_by?: string; time_posted?: string; content?: string }[]; disputed_transactions?: { seller_transaction_id?: string; buyer?: { name?: string } }[] }>(
    `/v1/customer/disputes/${encodeURIComponent(id)}`,
  );

export const acceptClaim = (c: PayPalClient, id: string, requestId: string, note: string) =>
  c.request(`/v1/customer/disputes/${encodeURIComponent(id)}/accept-claim`, { method: 'POST', idempotencyKey: requestId, body: { note } });

export const sendDisputeMessage = (c: PayPalClient, id: string, requestId: string, message: string) =>
  c.request(`/v1/customer/disputes/${encodeURIComponent(id)}/send-message`, { method: 'POST', idempotencyKey: requestId, body: { message } });

// ─── Catalog products & Subscriptions v1 ───────────────────────────────────

export type Product = { id: string; name: string; description?: string; type?: string; category?: string; create_time?: string };
export type Plan = {
  id: string;
  product_id?: string;
  name: string;
  status?: string;
  description?: string;
  create_time?: string;
  billing_cycles?: { frequency?: { interval_unit?: string; interval_count?: number }; pricing_scheme?: { fixed_price?: Money } }[];
};

export const listProducts = (c: PayPalClient) => c.request<{ products?: Product[] }>('/v1/catalogs/products', { query: { page_size: 20, total_required: true } });

export const createProduct = (c: PayPalClient, input: { name: string; description?: string; type: string }, requestId: string) =>
  c.request<Product>('/v1/catalogs/products', { method: 'POST', idempotencyKey: requestId, body: input });

export const listPlans = (c: PayPalClient, productId?: string) =>
  c.request<{ plans?: Plan[] }>('/v1/billing/plans', { query: { product_id: productId, page_size: 20, total_required: true }, headers: { Prefer: 'return=representation' } });

export const createPlan = (
  c: PayPalClient,
  input: { productId: string; name: string; price: Money; intervalUnit: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR' },
  requestId: string,
) =>
  c.request<Plan>('/v1/billing/plans', {
    method: 'POST',
    idempotencyKey: requestId,
    headers: { Prefer: 'return=representation' },
    body: {
      product_id: input.productId,
      name: input.name,
      status: 'ACTIVE',
      billing_cycles: [
        { frequency: { interval_unit: input.intervalUnit, interval_count: 1 }, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, pricing_scheme: { fixed_price: input.price } },
      ],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
    },
  });

export const setPlanActive = (c: PayPalClient, id: string, active: boolean) =>
  c.request(`/v1/billing/plans/${encodeURIComponent(id)}/${active ? 'activate' : 'deactivate'}`, { method: 'POST', body: {} });

export type Subscription = {
  id: string;
  status: string;
  plan_id?: string;
  start_time?: string;
  subscriber?: { email_address?: string; name?: { given_name?: string; surname?: string } };
  billing_info?: { next_billing_time?: string; last_payment?: { amount?: Money; time?: string } };
};

export const getSubscription = (c: PayPalClient, id: string) => c.request<Subscription>(`/v1/billing/subscriptions/${encodeURIComponent(id)}`);

export const changeSubscription = (c: PayPalClient, id: string, op: 'suspend' | 'cancel' | 'activate', reason: string, requestId: string) =>
  c.request(`/v1/billing/subscriptions/${encodeURIComponent(id)}/${op}`, { method: 'POST', idempotencyKey: requestId, body: { reason: reason.slice(0, 128) } });

// ─── Payouts (from the merchant's balance) ─────────────────────────────────

export const merchantPayout = (c: PayPalClient, input: { batchId: string; email: string; amount: Money; note?: string }) =>
  c.request<{ batch_header: { payout_batch_id: string; batch_status: string } }>('/v1/payments/payouts', {
    method: 'POST',
    idempotencyKey: input.batchId,
    body: {
      sender_batch_header: { sender_batch_id: input.batchId, email_subject: 'You have a payment', email_message: input.note ?? 'Payment' },
      items: [{ recipient_type: 'EMAIL', receiver: input.email, amount: { value: input.amount.value, currency: input.amount.currency_code }, note: input.note, sender_item_id: input.batchId }],
    },
  });

// ─── Shipment tracking ─────────────────────────────────────────────────────

export const addTracking = (c: PayPalClient, input: { transactionId: string; trackingNumber: string; carrier: string; status?: string }, requestId: string) =>
  c.request('/v1/shipping/trackers-batch', {
    method: 'POST',
    idempotencyKey: requestId,
    body: { trackers: [{ transaction_id: input.transactionId, tracking_number: input.trackingNumber, carrier: input.carrier, status: input.status ?? 'SHIPPED' }] },
  });
