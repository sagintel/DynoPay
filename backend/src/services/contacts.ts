import { Op } from 'sequelize';
import { Contact, Transaction, User } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { contactView } from './serialize.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function listContacts(owner: User, opts: { search?: string; limit?: number } = {}) {
  const where = opts.search
    ? { userId: owner.id, [Op.or]: [{ name: { [Op.like]: `%${opts.search}%` } }, { email: { [Op.like]: `%${opts.search}%` } }, { handle: { [Op.like]: `%${opts.search.replace(/^@/, '')}%` } }] }
    : { userId: owner.id };
  const rows = await Contact.findAll({ where, order: [['favorite', 'DESC'], ['lastPaidAt', 'DESC'], ['name', 'ASC']], limit: opts.limit ?? 50 });
  return rows.map(contactView);
}

export async function getContact(owner: User, id: string) {
  const c = await Contact.findOne({ where: { id, userId: owner.id } });
  if (!c) throw notFound('Contact');
  const [sent, received, count] = await Promise.all([
    Transaction.sum('amount', { where: { userId: owner.id, contactId: id, direction: 'out', status: { [Op.ne]: 'failed' } } }),
    Transaction.sum('amount', { where: { userId: owner.id, contactId: id, direction: 'in', status: { [Op.ne]: 'failed' } } }),
    Transaction.count({ where: { userId: owner.id, contactId: id } }),
  ]);
  return { ...contactView(c), totals: { sent: (sent ?? 0) / 100, received: (received ?? 0) / 100, transactions: count, currency: owner.currency } };
}

export async function addContact(owner: User, input: { name: string; email?: string; handle?: string }) {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 60) throw badRequest('Name must be 1–60 characters');
  let email = input.email?.trim().toLowerCase() || null;
  if (email && !EMAIL.test(email)) throw badRequest('That email address looks invalid');

  let linked: User | null = null;
  if (input.handle) linked = await User.findOne({ where: { handle: input.handle.replace(/^@/, '').toLowerCase() } });
  else if (email) linked = await User.findOne({ where: { email } });
  if (input.handle && !linked) throw notFound(`@${input.handle.replace(/^@/, '')}`);
  if (!email && !linked) throw badRequest('Add an email or a DynoPay @handle so they can be paid');
  if (linked?.id === owner.id) throw badRequest("That's you");
  email ??= linked!.email;

  if (await Contact.findOne({ where: { userId: owner.id, email } })) throw conflict(`${name} is already in your contacts`);
  const c = await Contact.create({
    userId: owner.id, name, email, handle: linked?.handle ?? null, linkedUserId: linked?.id ?? null, favorite: false, lastPaidAt: null,
  });
  return contactView(c);
}

export async function updateContact(owner: User, id: string, patch: { name?: string; favorite?: boolean }) {
  const c = await Contact.findOne({ where: { id, userId: owner.id } });
  if (!c) throw notFound('Contact');
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name || name.length > 60) throw badRequest('Name must be 1–60 characters');
    c.name = name;
  }
  if (patch.favorite !== undefined) c.favorite = patch.favorite;
  await c.save();
  return contactView(c);
}

export async function deleteContact(owner: User, id: string) {
  const c = await Contact.findOne({ where: { id, userId: owner.id } });
  if (!c) throw notFound('Contact');
  await c.destroy(); // transactions keep their own counterparty snapshot
  return { deleted: true, id, name: c.name };
}
