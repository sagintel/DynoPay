import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { toPayPalValue } from '../lib/money.js';
import { paypalRequest } from './client.js';

// ─── Orders v2 (wallet top-up, paid from the user's PayPal account) ────────

type OrderLink = { href: string; rel: string };
type OrderResponse = {
  id: string;
  status: string;
  links?: OrderLink[];
  purchase_units?: {
    custom_id?: string;
    payments?: { captures?: { id: string; status: string; amount: { value: string; currency_code: string } }[] };
  }[];
};

export const TOPUP_RETURN_PATH = '/v1/paypal/return';

export async function createTopUpOrder(opts: { userId: string; amountMinor: number; currency: string; requestId: string; appReturnUrl?: string }) {
  // PayPal keeps our query params and appends ?token=<orderId>; `app` tells the return page where to send the user.
  const app = opts.appReturnUrl ? `&app=${encodeURIComponent(opts.appReturnUrl)}` : '';
  const order = await paypalRequest<OrderResponse>('/v2/checkout/orders', {
    method: 'POST',
    idempotencyKey: opts.requestId,
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          custom_id: opts.userId,
          description: 'DynoPay wallet top-up',
          amount: { currency_code: opts.currency, value: toPayPalValue(opts.amountMinor) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'DynoPay',
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            return_url: `${env.PUBLIC_URL}${TOPUP_RETURN_PATH}?status=approved${app}`,
            cancel_url: `${env.PUBLIC_URL}${TOPUP_RETURN_PATH}?status=cancelled${app}`,
          },
        },
      },
    },
  });
  const approveUrl = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
  if (!approveUrl) throw new AppError('upstream_error', 'PayPal did not return an approval link');
  return { orderId: order.id, status: order.status, approveUrl };
}

export async function captureOrder(orderId: string) {
  const order = await paypalRequest<OrderResponse>(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    idempotencyKey: `capture-${orderId}`,
    body: {},
  });
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    status: order.status,
    customId: order.purchase_units?.[0]?.custom_id,
    capture: capture
      ? { id: capture.id, status: capture.status, value: capture.amount.value, currency: capture.amount.currency_code }
      : null,
  };
}

export async function getOrder(orderId: string) {
  return paypalRequest<OrderResponse>(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}

type PayoutBatch = {
  batch_header: { payout_batch_id: string; batch_status: string };
  items?: { payout_item_id: string; transaction_status: string; payout_item: { sender_item_id?: string } }[];
};

/** SUCCESS | PENDING | UNCLAIMED | FAILED | RETURNED | BLOCKED | REFUNDED | REVERSED | ... */
export async function getPayoutItemStatus(payoutBatchId: string): Promise<string | null> {
  const batch = await paypalRequest<PayoutBatch>(`/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`);
  return batch.items?.[0]?.transaction_status ?? null;
}

// ─── Payouts (send from the platform balance to any PayPal email) ──────────

type PayoutResponse = { batch_header: { payout_batch_id: string; batch_status: string } };

export async function createPayout(opts: { batchId: string; email: string; amountMinor: number; currency: string; note?: string }) {
  const res = await paypalRequest<PayoutResponse>('/v1/payments/payouts', {
    method: 'POST',
    idempotencyKey: opts.batchId,
    body: {
      sender_batch_header: {
        sender_batch_id: opts.batchId,
        email_subject: 'You received money via DynoPay',
        email_message: opts.note ?? 'Sent with DynoPay',
      },
      items: [
        {
          recipient_type: 'EMAIL',
          receiver: opts.email,
          amount: { value: toPayPalValue(opts.amountMinor), currency: opts.currency },
          note: opts.note?.slice(0, 4000) ?? 'Sent with DynoPay',
          sender_item_id: opts.batchId,
        },
      ],
    },
  });
  return { payoutBatchId: res.batch_header.payout_batch_id, status: res.batch_header.batch_status };
}

// ─── Webhooks ─────────────────────────────────────────────────────────────

export async function verifyWebhookSignature(headers: Record<string, string | string[] | undefined>, event: unknown): Promise<boolean> {
  if (!env.PAYPAL_WEBHOOK_ID) return false;
  const h = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const res = await paypalRequest<{ verification_status: string }>('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: {
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: env.PAYPAL_WEBHOOK_ID,
      webhook_event: event,
    },
  });
  return res.verification_status === 'SUCCESS';
}
