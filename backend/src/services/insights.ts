import { Op } from 'sequelize';
import { z } from 'zod';
import { Contact, Schedule, Transaction, type User } from '../db/index.js';
import { formatMoney, toMajor } from '../lib/money.js';
import { getAccount } from './ledger.js';
import { initials } from './serialize.js';

export const spendingQuerySchema = z.object({
  period: z.enum(['week', 'month', '30d', '90d', 'year']).default('month'),
  groupBy: z.enum(['category', 'day', 'week', 'month', 'counterparty']).default('category'),
  /** both = two aligned series (Spent / Received) for in-vs-out charts. */
  direction: z.enum(['out', 'in', 'both']).default('out'),
  /** Optional budget/goal in major units (gauge and progress charts). */
  target: z.number().positive().max(10_000_000).optional(),
});
export type SpendingQuery = z.input<typeof spendingQuerySchema>;

/** Kinds that represent real money leaving/entering (moving money to your own card is not spending). */
const SPEND_KINDS = ['transfer', 'payout', 'card_spend', 'schedule', 'request_payment'];
const INCOME_KINDS = ['transfer', 'topup', 'refund', 'request_payment'];

function periodStart(period: z.infer<typeof spendingQuerySchema>['period'], now = new Date()): Date {
  const d = new Date(now);
  switch (period) {
    case 'week': {
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
      return d;
    }
    case 'month':
      return new Date(d.getFullYear(), d.getMonth(), 1);
    case '30d':
      return new Date(d.getTime() - 30 * 86_400_000);
    case '90d':
      return new Date(d.getTime() - 90 * 86_400_000);
    case 'year':
      return new Date(d.getFullYear(), 0, 1);
  }
}

/** Calendar keys in the server's local time zone (never mix with UTC ISO strings, or buckets won't line up). */
const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoMonth = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
function isoWeek(d: Date) {
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoDay(monday);
}
const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

type Bucket = { key: string; label: string; amount: number; share: number };

function bucketKey(t: Transaction, groupBy: z.infer<typeof spendingQuerySchema>['groupBy']) {
  return groupBy === 'category' ? t.category
    : groupBy === 'counterparty' ? t.counterpartyName
    : groupBy === 'day' ? isoDay(t.createdAt)
    : groupBy === 'week' ? isoWeek(t.createdAt)
    : isoMonth(t.createdAt);
}

/** Every time bucket in the period, so time series are continuous (zero days still show). */
function timeKeys(groupBy: 'day' | 'week' | 'month', since: Date, now = new Date()): string[] {
  const keys: string[] = [];
  const d = new Date(since);
  while (d <= now && keys.length < 400) {
    const key = groupBy === 'day' ? isoDay(d) : groupBy === 'week' ? isoWeek(d) : isoMonth(d);
    if (keys[keys.length - 1] !== key) keys.push(key);
    d.setDate(d.getDate() + 1);
  }
  return keys;
}

async function sumBy(user: User, direction: 'in' | 'out', since: Date, groupBy: z.infer<typeof spendingQuerySchema>['groupBy']) {
  const rows = await Transaction.findAll({
    where: {
      userId: user.id,
      direction,
      kind: direction === 'out' ? SPEND_KINDS : INCOME_KINDS,
      status: { [Op.ne]: 'failed' },
      createdAt: { [Op.gte]: since },
    },
    order: [['createdAt', 'ASC']],
  });
  const map = new Map<string, number>();
  for (const t of rows) map.set(bucketKey(t, groupBy), (map.get(bucketKey(t, groupBy)) ?? 0) + t.amount);
  return { map, total: rows.reduce((s, t) => s + t.amount, 0), count: rows.length };
}

export async function spendingSummary(user: User, raw: SpendingQuery = {}) {
  const q = spendingQuerySchema.parse(raw);
  const since = periodStart(q.period);
  const isTime = q.groupBy === 'day' || q.groupBy === 'week' || q.groupBy === 'month';
  const primaryDir = q.direction === 'in' ? 'in' : 'out';
  const primary = await sumBy(user, primaryDir, since, q.groupBy);
  const secondary = q.direction === 'both' ? await sumBy(user, 'in', since, q.groupBy) : null;

  // Keys: the full time axis for time series; otherwise the categories present (largest first).
  const keys = isTime
    ? timeKeys(q.groupBy as 'day' | 'week' | 'month', since)
    : [...new Set([...primary.map.keys(), ...(secondary?.map.keys() ?? [])])].sort((a, b) => (primary.map.get(b) ?? 0) - (primary.map.get(a) ?? 0));

  const toBuckets = (m: Map<string, number>, total: number): Bucket[] =>
    keys.map((key) => {
      const minor = m.get(key) ?? 0;
      return { key, label: isTime ? key : label(key), amount: toMajor(minor), share: total ? Math.round((minor / total) * 1000) / 10 : 0 };
    });

  const buckets = toBuckets(primary.map, primary.total);
  return {
    period: q.period,
    groupBy: q.groupBy,
    direction: q.direction,
    from: since.toISOString(),
    currency: user.currency,
    total: toMajor(primary.total),
    formattedTotal: formatMoney(primary.total, user.currency),
    count: primary.count + (secondary?.count ?? 0),
    target: q.target ?? null,
    buckets,
    /** Present for direction=both: aligned series on the same keys. */
    series: secondary
      ? [
          { key: 'out', name: 'Spent', total: toMajor(primary.total), buckets },
          { key: 'in', name: 'Received', total: toMajor(secondary.total), buckets: toBuckets(secondary.map, secondary.total) },
        ]
      : null,
  };
}

/** Data behind the home "sun arc": the days around today and what is planned on them. */
export async function weekPlan(user: User, now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 2);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);

  const schedules = await Schedule.findAll({
    where: { userId: user.id, status: 'active', nextRunAt: { [Op.gte]: start, [Op.lt]: end } },
    order: [['nextRunAt', 'ASC']],
  });
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const today = isoDay(d) === isoDay(now);
    return { date: isoDay(d), label: today ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'short' }), isToday: today };
  });
  const events = schedules.map((s) => ({
    id: s.id,
    date: isoDay(s.nextRunAt),
    name: s.name,
    amount: toMajor(s.amount),
    formatted: formatMoney(s.amount, user.currency),
  }));
  const planned = schedules.filter((s) => s.nextRunAt >= now).reduce((sum, s) => sum + s.amount, 0);
  return { days, events, planned: toMajor(planned), formattedPlanned: formatMoney(planned, user.currency) };
}

export async function balanceOverview(user: User) {
  const account = await getAccount(user.id);
  const lastIncome = await Transaction.findOne({
    where: { userId: user.id, direction: 'in', status: 'completed' },
    order: [['createdAt', 'DESC']],
  });
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return {
    balance: toMajor(account.balance),
    currency: account.currency,
    formatted: formatMoney(account.balance, account.currency),
    greeting: `${greeting}, ${user.name.split(/\s+/)[0]}`,
    caption: lastIncome
      ? `Available · ${lastIncome.counterpartyName} ${lastIncome.kind === 'topup' ? 'top-up' : 'payment'} landed ${relativeDay(lastIncome.createdAt)}`
      : 'Available balance',
  };
}

function relativeDay(d: Date) {
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `on ${d.toLocaleDateString('en-US', { weekday: 'long' })}`;
  return `on ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

export async function recentContacts(user: User, limit = 8) {
  const contacts = await Contact.findAll({
    where: { userId: user.id },
    order: [['favorite', 'DESC'], ['lastPaidAt', 'DESC'], ['name', 'ASC']],
    limit,
  });
  return contacts.map((c) => ({ id: c.id, name: c.name, firstName: c.name.split(/\s+/)[0], initials: initials(c.name), isDynoPayUser: !!c.linkedUserId, favorite: c.favorite }));
}
