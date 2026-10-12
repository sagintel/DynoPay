import type { InferCreationAttributes } from 'sequelize';
import { Account, Card, Contact, Schedule, Transaction, User, withTx } from '../db/index.js';
import { createUser } from './users.js';

/**
 * Demo data for development/judging (only reachable when ALLOW_DEV_LOGIN is on).
 * The demo contacts are real DynoPay accounts, so transfers between them are instant.
 */
const PEOPLE = [
  { name: 'Ahmed Khalil', email: 'ahmed.demo@dynopay.dev' },
  { name: 'Amina Yusuf', email: 'amina.demo@dynopay.dev' },
  { name: 'Sara Nasser', email: 'sara.demo@dynopay.dev' },
  { name: 'Farhan Malik', email: 'farhan.demo@dynopay.dev' },
];

const MERCHANTS: { name: string; category: string; min: number; max: number }[] = [
  { name: 'Careem', category: 'transport', min: 1200, max: 4500 },
  { name: 'Spinneys', category: 'groceries', min: 4000, max: 22000 },
  { name: 'Blue Bottle Coffee', category: 'food', min: 450, max: 1400 },
  { name: 'Netflix', category: 'entertainment', min: 1599, max: 1599 },
  { name: 'Uber Eats', category: 'food', min: 1800, max: 6500 },
  { name: 'Apple', category: 'shopping', min: 999, max: 12900 },
  { name: 'Etisalat', category: 'bills', min: 9900, max: 9900 },
];

const rand = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1));
const daysAgo = (d: number, h = rand(8, 21)) => {
  const date = new Date();
  date.setDate(date.getDate() - d);
  date.setHours(h, rand(0, 59), 0, 0);
  return date;
};

async function ensurePerson(name: string, email: string): Promise<User> {
  return (await User.findOne({ where: { email } })) ?? createUser({ email, name, verified: true });
}

export async function seedDemoUser(name: string): Promise<User> {
  const email = 'demo@dynopay.dev';
  const existing = await User.findOne({ where: { email } });
  if (existing) return existing;

  const user = await createUser({ email, name, verified: true });
  const people = await Promise.all(PEOPLE.map((p) => ensurePerson(p.name, p.email)));
  // Give the demo friends some money so they can pay the demo user back.
  await Account.update({ balance: 250_000 }, { where: { userId: people.map((p) => p.id) } });

  await withTx(async (t) => {
    const contacts = await Promise.all(
      people.map((p, i) =>
        Contact.create(
          { userId: user.id, name: p.name, email: p.email, handle: p.handle, linkedUserId: p.id, favorite: i === 0, lastPaidAt: daysAgo(i + 1) },
          { transaction: t },
        ),
      ),
    );

    // 30 days of history, oldest first so balanceAfter is consistent.
    type Row = Omit<InferCreationAttributes<Transaction>, 'id' | 'balanceAfter' | 'updatedAt' | 'createdAt'> & { createdAt: Date };
    const rows: Row[] = [];
    const base = { userId: user.id, currency: user.currency, status: 'completed' as const, counterpartyHandle: null, counterpartyEmail: null, counterpartyUserId: null, contactId: null, cardId: null, groupId: null, externalRef: null, note: null };
    rows.push({ ...base, direction: 'in', kind: 'topup', amount: 1_000_000, category: 'topup', counterpartyName: 'PayPal', note: 'Top up from PayPal', createdAt: daysAgo(30, 9) });
    for (let d = 29; d >= 0; d--) {
      const count = rand(0, 2);
      for (let k = 0; k < count; k++) {
        const m = MERCHANTS[rand(0, MERCHANTS.length - 1)]!;
        rows.push({ ...base, direction: 'out', kind: 'card_spend', amount: rand(m.min, m.max), category: m.category, counterpartyName: m.name, createdAt: daysAgo(d) });
      }
    }
    rows.push({ ...base, direction: 'in', kind: 'transfer', amount: 15_000, category: 'food', counterpartyName: 'Sara Nasser', counterpartyUserId: people[2]!.id, contactId: contacts[2]!.id, note: 'Split · dinner', createdAt: daysAgo(1, 20) });
    rows.push({ ...base, direction: 'out', kind: 'transfer', amount: 50_000, category: 'rent', counterpartyName: 'Ahmed Khalil', counterpartyUserId: people[0]!.id, contactId: contacts[0]!.id, note: 'Rent · August', createdAt: daysAgo(28, 10) });
    rows.push({ ...base, direction: 'out', kind: 'transfer', amount: 4_000, category: 'gifts', counterpartyName: 'Amina Yusuf', counterpartyUserId: people[1]!.id, contactId: contacts[1]!.id, note: 'Birthday gift', createdAt: daysAgo(12, 18) });
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    let balance = 0;
    for (const r of rows) {
      balance += r.direction === 'in' ? r.amount : -r.amount;
      await Transaction.create({ ...r, balanceAfter: balance, updatedAt: r.createdAt }, { transaction: t, silent: true });
    }
    await Account.update({ balance }, { where: { userId: user.id }, transaction: t });

    const now = new Date();
    await Card.create({ userId: user.id, label: 'Everyday', last4: String(rand(1000, 9999)), color: 'amber', balance: 32_000, monthlyLimit: 150_000, expMonth: now.getMonth() + 1, expYear: now.getFullYear() + 3 }, { transaction: t });
    await Card.create({ userId: user.id, label: 'Travel', last4: String(rand(1000, 9999)), color: 'graphite', status: 'frozen', balance: 0, monthlyLimit: null, expMonth: now.getMonth() + 1, expYear: now.getFullYear() + 2 }, { transaction: t });

    const inDays = (d: number) => new Date(Date.now() + d * 86_400_000);
    await Schedule.create({ userId: user.id, name: 'Netflix', contactId: null, amount: 1_599, recurrence: 'monthly', nextRunAt: inDays(2), note: 'Subscription' }, { transaction: t });
    await Schedule.create({ userId: user.id, name: 'Rent', contactId: contacts[0]!.id, amount: 50_000, recurrence: 'monthly', nextRunAt: inDays(3), note: 'Rent' }, { transaction: t });
  });

  return user;
}
