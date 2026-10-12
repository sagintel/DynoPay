import crypto from 'node:crypto';
import { PaypalOrder, Transaction, User, withTx } from '../db/index.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { assertPositiveMinor, toMinor } from '../lib/money.js';
import { paypalConfigured } from '../paypal/client.js';
import { captureOrder, createTopUpOrder, getOrder } from '../paypal/payments.js';
import { credit } from './ledger.js';

/** Step 1: create a PayPal order; the app opens `approveUrl` so the user approves in PayPal. */
export async function startTopUp(user: User, amount: number, appReturnUrl?: string) {
  assertPositiveMinor(amount);
  if (!paypalConfigured()) throw new AppError('not_configured', 'PayPal is not configured on this server');
  if (amount > 1_000_000) throw badRequest('Top-ups are limited to 10,000.00 at a time');
  const order = await createTopUpOrder({ userId: user.id, amountMinor: amount, currency: user.currency, requestId: crypto.randomUUID(), appReturnUrl });
  await PaypalOrder.create({ id: order.orderId, userId: user.id, amount, currency: user.currency, status: order.status, captureId: null, transactionId: null });
  return order;
}

/** Step 2: after approval, capture and credit the wallet exactly once. */
export async function captureTopUp(user: User, orderId: string) {
  const order = await PaypalOrder.findByPk(orderId);
  if (!order) throw notFound('Top-up');
  if (order.userId !== user.id) throw forbidden();
  if (order.transactionId) return { status: 'completed' as const, transactionId: order.transactionId, alreadyCredited: true };

  const result = await captureOrder(orderId);
  if (result.status !== 'COMPLETED' || !result.capture || result.capture.status !== 'COMPLETED') {
    await order.update({ status: result.status });
    throw new AppError('upstream_error', `PayPal payment is ${result.capture?.status ?? result.status}`);
  }
  return creditCapture(order, result.capture);
}

/** Shared by the capture call and the PAYMENT.CAPTURE.COMPLETED webhook. Idempotent per order. */
export async function creditCapture(order: PaypalOrder, capture: { id: string; value: string; currency: string }) {
  const captured = toMinor(capture.value);
  if (captured !== order.amount || capture.currency !== order.currency) {
    logger.error({ orderId: order.id, captured, expected: order.amount }, 'capture amount mismatch');
    throw new AppError('conflict', 'Captured amount does not match the top-up');
  }
  const credited = await withTx(async (t) => {
    // Claim the order with a conditional UPDATE: portable across SQLite/PG/MySQL, and only one
    // concurrent caller (capture call vs. webhook) can win it.
    const [claimed] = await PaypalOrder.update(
      { captureId: capture.id, status: 'CAPTURING' },
      { where: { id: order.id, captureId: null }, transaction: t },
    );
    if (claimed !== 1) return null;
    const balance = await credit(order.userId, order.amount, t);
    const tx = await Transaction.create(
      {
        userId: order.userId, direction: 'in', amount: order.amount, currency: order.currency, kind: 'topup', status: 'completed',
        category: 'topup', note: 'Top up from PayPal', counterpartyName: 'PayPal', counterpartyHandle: null, counterpartyEmail: null,
        counterpartyUserId: null, contactId: null, cardId: null, balanceAfter: balance, groupId: null, externalRef: capture.id,
      },
      { transaction: t },
    );
    await PaypalOrder.update({ status: 'COMPLETED', transactionId: tx.id }, { where: { id: order.id }, transaction: t });
    return { status: 'completed' as const, transactionId: tx.id, alreadyCredited: false, balance: balance / 100 };
  });
  if (credited) return credited;
  const existing = await PaypalOrder.findByPk(order.id);
  return { status: 'completed' as const, transactionId: existing?.transactionId ?? null, alreadyCredited: true };
}

export async function topUpStatus(user: User, orderId: string) {
  const order = await PaypalOrder.findByPk(orderId);
  if (!order || order.userId !== user.id) throw notFound('Top-up');
  if (order.transactionId) return { status: 'completed', transactionId: order.transactionId };
  const remote = await getOrder(orderId);
  return { status: remote.status.toLowerCase(), transactionId: null };
}
