import crypto from 'node:crypto';
import { Op, literal, type Transaction as SqlTx } from 'sequelize';
import { env } from '../config/env.js';
import { Account, Contact, Transaction, User, withTx, type TxKind } from '../db/index.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { assertPositiveMinor, formatMoney, toMinor } from '../lib/money.js';
import { paypalConfigured } from '../paypal/client.js';
import { createPayout } from '../paypal/payments.js';

// ─── Balance primitives ────────────────────────────────────────────────────

export async function getAccount(userId: string, transaction?: SqlTx): Promise<Account> {
  const account = await Account.findOne({ where: { userId }, transaction });
  if (!account) throw notFound('Account');
  return account;
}

/** Atomic conditional debit: fails instead of going negative, even under concurrency. */
export async function debit(userId: string, amount: number, transaction: SqlTx): Promise<number> {
  assertPositiveMinor(amount);
  const [count] = await Account.update(
    { balance: literal(`balance - ${amount}`) as unknown as number },
    { where: { userId, balance: { [Op.gte]: amount } }, transaction },
  );
  if (count !== 1) {
    const account = await getAccount(userId, transaction);
    throw new AppError('insufficient_funds', `Insufficient balance: you have ${formatMoney(account.balance, account.currency)}`);
  }
  return (await getAccount(userId, transaction)).balance;
}

export async function credit(userId: string, amount: number, transaction: SqlTx): Promise<number> {
  assertPositiveMinor(amount);
  await Account.update({ balance: literal(`balance + ${amount}`) as unknown as number }, { where: { userId }, transaction });
  return (await getAccount(userId, transaction)).balance;
}

const OUTGOING_KINDS: TxKind[] = ['transfer', 'payout', 'schedule', 'request_payment'];

/** Server-side guardrails, enforced no matter who (agent, button, MCP client) initiates the transfer. */
export async function assertWithinLimits(userId: string, amount: number, transaction?: SqlTx) {
  if (amount > toMinor(env.LIMIT_PER_TRANSFER)) {
    throw new AppError('limit_exceeded', `Single transfers are limited to ${env.LIMIT_PER_TRANSFER.toFixed(2)}`);
  }
  const since = new Date(Date.now() - 86_400_000);
  const sent = (await Transaction.sum('amount', {
    where: { userId, direction: 'out', kind: OUTGOING_KINDS, status: { [Op.ne]: 'failed' }, createdAt: { [Op.gte]: since } },
    transaction,
  })) as number | null;
  if ((sent ?? 0) + amount > toMinor(env.LIMIT_DAILY_OUT)) {
    throw new AppError('limit_exceeded', `This would exceed your 24h sending limit of ${env.LIMIT_DAILY_OUT.toFixed(2)}`);
  }
}

// ─── Recipients ────────────────────────────────────────────────────────────

export type RecipientInput = { contactId?: string; email?: string; handle?: string; name?: string };

export type ResolvedRecipient =
  | { kind: 'internal'; userId: string; name: string; handle: string; email: string; contactId: string | null }
  | { kind: 'paypal'; email: string; name: string; contactId: string | null };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Turns "Ahmed", "@ahmedk", "ahmed@x.com" or a contact id into a concrete recipient.
 * DynoPay users are paid instantly on the ledger; anyone else receives a PayPal payout.
 */
export async function resolveRecipient(owner: User, input: RecipientInput): Promise<ResolvedRecipient> {
  let contact: Contact | null = null;

  if (input.contactId) {
    contact = await Contact.findOne({ where: { id: input.contactId, userId: owner.id } });
    if (!contact) throw notFound('Contact');
  } else if (input.email || (input.name && EMAIL.test(input.name.trim()))) {
    const email = (input.email ?? input.name!).trim().toLowerCase();
    if (!EMAIL.test(email)) throw badRequest('That email address looks invalid');
    contact = await Contact.findOne({ where: { userId: owner.id, email } });
    if (!contact) {
      const user = await User.findOne({ where: { email } });
      if (user) return internal(owner, user, null);
      return { kind: 'paypal', email, name: input.name && !EMAIL.test(input.name) ? input.name : email, contactId: null };
    }
  } else if (input.handle) {
    const handle = input.handle.replace(/^@/, '').toLowerCase();
    const user = await User.findOne({ where: { handle } });
    if (!user) throw notFound(`@${handle}`);
    contact = await Contact.findOne({ where: { userId: owner.id, linkedUserId: user.id } });
    return internal(owner, user, contact?.id ?? null);
  } else if (input.name) {
    contact = await findContactByName(owner.id, input.name);
  } else {
    throw badRequest('Who should receive the money?');
  }

  if (contact!.linkedUserId) {
    const user = await User.findByPk(contact!.linkedUserId);
    if (user) return internal(owner, user, contact!.id, contact!.name);
  }
  if (!contact!.email) throw badRequest(`${contact!.name} has no email or DynoPay account to pay`);
  return { kind: 'paypal', email: contact!.email, name: contact!.name, contactId: contact!.id };
}

function internal(owner: User, user: User, contactId: string | null, displayName?: string): ResolvedRecipient {
  if (user.id === owner.id) throw badRequest("You can't send money to yourself");
  return { kind: 'internal', userId: user.id, name: displayName ?? user.name, handle: user.handle, email: user.email, contactId };
}

export async function findContactByName(userId: string, rawName: string): Promise<Contact> {
  const name = rawName.trim().toLowerCase();
  const contacts = await Contact.findAll({ where: { userId } });
  const exact = contacts.filter((c) => c.name.toLowerCase() === name);
  const first = contacts.filter((c) => c.name.toLowerCase().split(/\s+/)[0] === name);
  const partial = contacts.filter((c) => c.name.toLowerCase().includes(name) || c.handle?.toLowerCase() === name.replace(/^@/, ''));
  const matches = exact.length ? exact : first.length ? first : partial;
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new AppError('not_found', `No contact named "${rawName}"`, { suggestions: contacts.slice(0, 5).map((c) => c.name) });
  throw new AppError('conflict', `Several contacts match "${rawName}": ${matches.map((c) => c.name).join(', ')}`, {
    candidates: matches.map((c) => ({ id: c.id, name: c.name })),
  });
}

// ─── Transfers ─────────────────────────────────────────────────────────────

const CATEGORY_HINTS: [RegExp, string][] = [
  [/\brent|landlord|lease\b/i, 'rent'],
  [/\bgrocer|supermarket|food shop\b/i, 'groceries'],
  [/\bdinner|lunch|breakfast|coffee|restaurant|pizza|food\b/i, 'food'],
  [/\btaxi|uber|ride|careem|fuel|gas|metro|bus\b/i, 'transport'],
  [/\bbill|electric|water|internet|phone|utility\b/i, 'bills'],
  [/\bgift|birthday\b/i, 'gifts'],
  [/\bsalary|payroll|wage\b/i, 'salary'],
];

export function guessCategory(note?: string | null): string {
  if (!note) return 'transfers';
  return CATEGORY_HINTS.find(([re]) => re.test(note))?.[1] ?? 'transfers';
}

export type TransferResult = { transactionId: string; status: 'completed' | 'pending'; recipient: ResolvedRecipient; balance: number };

export async function executeTransfer(
  sender: User,
  opts: { recipient: ResolvedRecipient; amount: number; note?: string | null; kind?: TxKind; category?: string },
): Promise<TransferResult> {
  const { recipient, amount } = opts;
  assertPositiveMinor(amount);
  const note = opts.note?.trim().slice(0, 140) || null;
  const category = opts.category ?? guessCategory(note);
  const kind = opts.kind ?? 'transfer';
  const currency = sender.currency;

  if (recipient.kind === 'paypal' && !paypalConfigured()) {
    throw new AppError('not_configured', `${recipient.name} isn't on DynoPay and PayPal payouts aren't configured on this server`);
  }

  if (recipient.kind === 'internal') {
    return withTx(async (t) => {
      await assertWithinLimits(sender.id, amount, t);
      const groupId = crypto.randomUUID();
      const senderBalance = await debit(sender.id, amount, t);
      const receiverBalance = await credit(recipient.userId, amount, t);
      const contactId = recipient.contactId ?? (await ensureContact(sender.id, recipient, t)).id;
      const out = await Transaction.create(
        {
          userId: sender.id, direction: 'out', amount, currency, kind, status: 'completed', category, note, groupId,
          counterpartyName: recipient.name, counterpartyHandle: recipient.handle, counterpartyEmail: recipient.email,
          counterpartyUserId: recipient.userId, contactId, cardId: null, balanceAfter: senderBalance, externalRef: null,
        },
        { transaction: t },
      );
      const back = await ensureContact(recipient.userId, { kind: 'internal', userId: sender.id, name: sender.name, handle: sender.handle, email: sender.email, contactId: null }, t);
      await Transaction.create(
        {
          userId: recipient.userId, direction: 'in', amount, currency, kind, status: 'completed', category, note, groupId,
          counterpartyName: sender.name, counterpartyHandle: sender.handle, counterpartyEmail: sender.email,
          counterpartyUserId: sender.id, contactId: back.id, cardId: null, balanceAfter: receiverBalance, externalRef: null,
        },
        { transaction: t },
      );
      await Contact.update({ lastPaidAt: new Date() }, { where: { id: contactId }, transaction: t });
      return { transactionId: out.id, status: 'completed' as const, recipient, balance: senderBalance };
    });
  }

  // External PayPal recipient: reserve funds first, then pay out. Refund the reservation if PayPal rejects it.
  const reserved = await withTx(async (t) => {
    await assertWithinLimits(sender.id, amount, t);
    const balance = await debit(sender.id, amount, t);
    const contactId = recipient.contactId ?? (await ensureContact(sender.id, recipient, t)).id;
    const tx = await Transaction.create(
      {
        userId: sender.id, direction: 'out', amount, currency, kind: kind === 'transfer' ? 'payout' : kind, status: 'pending', category, note,
        groupId: null, counterpartyName: recipient.name, counterpartyHandle: null, counterpartyEmail: recipient.email,
        counterpartyUserId: null, contactId, cardId: null, balanceAfter: balance, externalRef: null,
      },
      { transaction: t },
    );
    await Contact.update({ lastPaidAt: new Date() }, { where: { id: contactId }, transaction: t });
    return { tx, balance };
  });

  try {
    const payout = await createPayout({ batchId: reserved.tx.id, email: recipient.email, amountMinor: amount, currency, note: note ?? undefined });
    await reserved.tx.update({ externalRef: payout.payoutBatchId });
    return { transactionId: reserved.tx.id, status: 'pending', recipient, balance: reserved.balance };
  } catch (err) {
    logger.error({ err, txId: reserved.tx.id }, 'payout failed, releasing reserved funds');
    await failAndRefund(reserved.tx.id);
    throw err;
  }
}

/** Marks a pending outgoing transaction failed and returns the funds (idempotent). */
export async function failAndRefund(transactionId: string) {
  await withTx(async (t) => {
    const [count] = await Transaction.update({ status: 'failed' }, { where: { id: transactionId, status: 'pending' }, transaction: t });
    if (count !== 1) return;
    const tx = await Transaction.findByPk(transactionId, { transaction: t });
    if (tx) await credit(tx.userId, tx.amount, t);
  });
}

export async function completePending(transactionId: string) {
  await Transaction.update({ status: 'completed' }, { where: { id: transactionId, status: 'pending' } });
}

async function ensureContact(userId: string, r: ResolvedRecipient, transaction: SqlTx): Promise<Contact> {
  const where = r.kind === 'internal' ? { userId, linkedUserId: r.userId } : { userId, email: r.email };
  const found = await Contact.findOne({ where, transaction });
  if (found) return found;
  return Contact.create(
    {
      userId, name: r.name, email: r.email, handle: r.kind === 'internal' ? r.handle : null,
      linkedUserId: r.kind === 'internal' ? r.userId : null, favorite: false, lastPaidAt: null,
    },
    { transaction },
  );
}
