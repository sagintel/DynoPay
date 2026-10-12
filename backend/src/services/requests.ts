import crypto from 'node:crypto';
import { Op } from 'sequelize';
import { MoneyRequest, User } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { assertPositiveMinor } from '../lib/money.js';
import { executeTransfer, resolveRecipient, type RecipientInput } from './ledger.js';
import { requestView } from './serialize.js';

/**
 * Request money from one or more people. With `split`, `amount` is the total and is
 * divided between the participants and you; otherwise each participant owes `amount`.
 */
export async function createRequests(user: User, input: { participants: RecipientInput[]; amount: number; split?: boolean; includeSelf?: boolean; note?: string }) {
  assertPositiveMinor(input.amount);
  if (!input.participants.length || input.participants.length > 10) throw badRequest('Request from 1–10 people');
  const resolved = await Promise.all(input.participants.map((p) => resolveRecipient(user, p)));
  const shares = input.split ? resolved.length + (input.includeSelf === false ? 0 : 1) : 1;
  const each = Math.floor(input.amount / shares);
  if (each <= 0) throw badRequest('Amount is too small to split');
  const groupId = resolved.length > 1 ? crypto.randomUUID() : null;

  const created = await Promise.all(
    resolved.map((r) =>
      MoneyRequest.create({
        requesterId: user.id,
        payerUserId: r.kind === 'internal' ? r.userId : null,
        payerEmail: r.email,
        payerName: r.name,
        amount: each,
        currency: user.currency,
        note: input.note?.slice(0, 140) ?? null,
        groupId,
      }),
    ),
  );
  return created.map((r) => requestView(r, 'outgoing', user.name));
}

export async function listRequests(user: User, perspective: 'incoming' | 'outgoing' | 'all' = 'all') {
  const [incoming, outgoing] = await Promise.all([
    perspective === 'outgoing' ? [] : MoneyRequest.findAll({ where: { [Op.or]: [{ payerUserId: user.id }, { payerEmail: user.email }], status: 'pending' }, order: [['createdAt', 'DESC']], limit: 50 }),
    perspective === 'incoming' ? [] : MoneyRequest.findAll({ where: { requesterId: user.id }, order: [['createdAt', 'DESC']], limit: 50 }),
  ]);
  const requesters = await User.findAll({ where: { id: [...new Set(incoming.map((r) => r.requesterId))] } });
  const names = new Map(requesters.map((u) => [u.id, u.name]));
  return [
    ...incoming.map((r) => requestView(r, 'incoming', names.get(r.requesterId))),
    ...outgoing.map((r) => requestView(r, 'outgoing', user.name)),
  ];
}

async function incomingRequest(user: User, id: string) {
  const r = await MoneyRequest.findOne({ where: { id, status: 'pending', [Op.or]: [{ payerUserId: user.id }, { payerEmail: user.email }] } });
  if (!r) throw notFound('Request');
  return r;
}

export async function payRequest(user: User, id: string) {
  const r = await incomingRequest(user, id);
  const requester = await User.findByPk(r.requesterId);
  if (!requester) throw notFound('Requester');
  const recipient = await resolveRecipient(user, { handle: requester.handle });
  // Claim before paying so a double tap cannot pay twice.
  const [claimed] = await MoneyRequest.update({ status: 'paid' }, { where: { id: r.id, status: 'pending' } });
  if (claimed !== 1) throw badRequest('This request was already settled');
  try {
    const result = await executeTransfer(user, { recipient, amount: r.amount, note: r.note ?? 'Request', kind: 'request_payment' });
    return { paid: true, requestId: r.id, transactionId: result.transactionId };
  } catch (err) {
    await MoneyRequest.update({ status: 'pending' }, { where: { id: r.id } });
    throw err;
  }
}

export async function declineRequest(user: User, id: string) {
  const r = await incomingRequest(user, id);
  r.status = 'declined';
  await r.save();
  return { declined: true, requestId: r.id };
}

export async function cancelRequest(user: User, id: string) {
  const r = await MoneyRequest.findOne({ where: { id, requesterId: user.id, status: 'pending' } });
  if (!r) throw notFound('Request');
  r.status = 'cancelled';
  await r.save();
  return { cancelled: true, requestId: r.id };
}
