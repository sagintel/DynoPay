import crypto from 'node:crypto';
import { Router } from 'express';
import { env } from '../config/env.js';
import { PaypalOrder, Transaction } from '../db/index.js';
import { appendQuery, handler, handoffPage, isAllowedAppRedirect } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { paypalConfigured } from '../paypal/client.js';
import { getPayoutItemStatus, verifyWebhookSignature } from '../paypal/payments.js';
import { completePending, failAndRefund } from '../services/ledger.js';
import { creditCapture } from '../services/topups.js';
import { runDueSchedules } from '../services/schedules.js';
import { Op } from 'sequelize';

export const paypalRouter = Router();

/** PayPal sends the buyer here after approving/cancelling a top-up; we bounce them back to the app. */
paypalRouter.get('/paypal/return', (req, res) => {
  const { status, token, app } = req.query as Record<string, string | undefined>;
  const approved = status === 'approved';
  const base = isAllowedAppRedirect(app) ? app : `${env.APP_SCHEME}://topup`;
  const target = appendQuery(base, { status: approved ? 'approved' : 'cancelled', ...(token ? { orderId: token } : {}) });
  res.type('html').send(handoffPage(approved ? 'Payment approved' : 'Top-up cancelled', approved ? 'Finishing your top-up in DynoPay…' : 'No money was moved.', target));
});

const FAILED_PAYOUT = new Set(['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'DENIED']);

async function processWebhook(event: { event_type?: string; resource?: Record<string, unknown> }) {
  const type = event.event_type ?? '';
  const resource = event.resource ?? {};
  if (type === 'PAYMENT.CAPTURE.COMPLETED') {
    const orderId = (resource.supplementary_data as { related_ids?: { order_id?: string } } | undefined)?.related_ids?.order_id;
    const amount = resource.amount as { value: string; currency_code: string } | undefined;
    const order = orderId ? await PaypalOrder.findByPk(orderId) : null;
    if (order && amount) await creditCapture(order, { id: String(resource.id), value: amount.value, currency: amount.currency_code });
    return;
  }
  if (type.startsWith('PAYMENT.PAYOUTS-ITEM.')) {
    const txId = (resource.payout_item as { sender_item_id?: string } | undefined)?.sender_item_id;
    if (!txId) return;
    if (type === 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED') await completePending(txId);
    else if (FAILED_PAYOUT.has(type.split('.').pop()!)) await failAndRefund(txId);
  }
}

/** Acknowledge immediately, verify + process asynchronously (PayPal retries if we are slow). */
paypalRouter.post('/webhooks/paypal', (req, res) => {
  res.status(200).json({ received: true });
  const event = req.body as { id?: string; event_type?: string; resource?: Record<string, unknown> };
  void (async () => {
    try {
      if (!(await verifyWebhookSignature(req.headers, event))) {
        logger.warn({ id: event.id, type: event.event_type }, 'rejected unverified paypal webhook');
        return;
      }
      await processWebhook(event);
    } catch (err) {
      logger.error({ err, id: event.id }, 'paypal webhook processing failed');
    }
  })();
});

// ─── Internal jobs (cron) ──────────────────────────────────────────────────

function cronAuthorized(header: string | undefined) {
  if (!env.CRON_SECRET || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(env.CRON_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

paypalRouter.post(
  '/internal/run-schedules',
  handler(async (req, res) => {
    if (!cronAuthorized(req.get('x-cron-secret'))) return void res.status(401).json({ error: { code: 'unauthorized', message: 'Bad cron secret' } });
    res.json({ results: await runDueSchedules() });
  }),
);

/** Reconciles pending payouts by polling PayPal (backup for missed webhooks). */
paypalRouter.post(
  '/internal/sync-payouts',
  handler(async (req, res) => {
    if (!cronAuthorized(req.get('x-cron-secret'))) return void res.status(401).json({ error: { code: 'unauthorized', message: 'Bad cron secret' } });
    if (!paypalConfigured()) return void res.json({ synced: 0 });
    const pending = await Transaction.findAll({ where: { kind: 'payout', status: 'pending', externalRef: { [Op.ne]: null } }, limit: 100 });
    let synced = 0;
    for (const tx of pending) {
      const status = await getPayoutItemStatus(tx.externalRef!).catch(() => null);
      if (status === 'SUCCESS') await completePending(tx.id);
      else if (status && FAILED_PAYOUT.has(status)) await failAndRefund(tx.id);
      else continue;
      synced++;
    }
    res.json({ synced });
  }),
);
