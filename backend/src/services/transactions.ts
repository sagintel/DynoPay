import { Op, type WhereOptions } from 'sequelize';
import { z } from 'zod';
import { Contact, Transaction, type User } from '../db/index.js';
import { notFound } from '../lib/errors.js';
import { toMinor } from '../lib/money.js';
import { txView, type TxView } from './serialize.js';

export const txQuerySchema = z.object({
  search: z.string().max(80).optional().describe('Free text matched against counterparty name, email and note'),
  counterparty: z.string().max(80).optional().describe('Counterparty/contact name, e.g. "Ahmed"'),
  contactId: z.string().optional(),
  cardId: z.string().optional(),
  direction: z.enum(['in', 'out']).optional(),
  kind: z.enum(['transfer', 'topup', 'payout', 'card_funding', 'card_spend', 'refund', 'request_payment', 'schedule']).optional(),
  category: z.string().max(32).optional(),
  status: z.enum(['pending', 'completed', 'failed', 'reversed']).optional(),
  from: z.string().optional().describe('ISO date (inclusive)'),
  to: z.string().optional().describe('ISO date (inclusive)'),
  minAmount: z.number().nonnegative().optional(),
  maxAmount: z.number().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});
export type TxQuery = z.input<typeof txQuerySchema>;

function dayBoundary(value: string, end: boolean): Date | undefined {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (end) d.setUTCHours(23, 59, 59, 999);
    else d.setUTCHours(0, 0, 0, 0);
  }
  return d;
}

export async function queryTransactions(user: User, raw: TxQuery = {}): Promise<{ items: TxView[]; total: number }> {
  const q = txQuerySchema.parse(raw);
  const and: WhereOptions<Transaction>[] = [{ userId: user.id }];

  if (q.direction) and.push({ direction: q.direction });
  if (q.kind) and.push({ kind: q.kind });
  if (q.category) and.push({ category: q.category.toLowerCase() });
  if (q.status) and.push({ status: q.status });
  if (q.cardId) and.push({ cardId: q.cardId });
  if (q.contactId) and.push({ contactId: q.contactId });

  const created: Record<symbol, Date> = {};
  const from = q.from ? dayBoundary(q.from, false) : undefined;
  const to = q.to ? dayBoundary(q.to, true) : undefined;
  if (from) created[Op.gte] = from;
  if (to) created[Op.lte] = to;
  if (from || to) and.push({ createdAt: created });

  const amount: Record<symbol, number> = {};
  if (q.minAmount !== undefined) amount[Op.gte] = toMinor(q.minAmount);
  if (q.maxAmount !== undefined) amount[Op.lte] = toMinor(q.maxAmount);
  if (q.minAmount !== undefined || q.maxAmount !== undefined) and.push({ amount });

  if (q.counterparty) {
    const term = q.counterparty.trim();
    const contacts = await Contact.findAll({ where: { userId: user.id, name: { [Op.like]: `%${term}%` } }, attributes: ['id'] });
    and.push({
      [Op.or]: [{ counterpartyName: { [Op.like]: `%${term}%` } }, { contactId: contacts.map((c) => c.id) }],
    } as WhereOptions<Transaction>);
  }
  if (q.search) {
    const like = { [Op.like]: `%${q.search.trim()}%` };
    and.push({ [Op.or]: [{ counterpartyName: like }, { counterpartyEmail: like }, { note: like }, { category: like }] } as WhereOptions<Transaction>);
  }

  const { rows, count } = await Transaction.findAndCountAll({
    where: { [Op.and]: and },
    order: [['createdAt', 'DESC']],
    limit: q.limit,
    offset: q.offset,
  });
  return { items: rows.map(txView), total: count };
}

export async function getTransaction(user: User, id: string): Promise<TxView> {
  const tx = await Transaction.findOne({ where: { id, userId: user.id } });
  if (!tx) throw notFound('Transaction');
  return txView(tx);
}
