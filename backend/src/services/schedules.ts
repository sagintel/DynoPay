import { Op } from 'sequelize';
import { Contact, Schedule, User, type Recurrence } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { assertPositiveMinor } from '../lib/money.js';
import { executeTransfer, resolveRecipient, type RecipientInput } from './ledger.js';
import { scheduleView } from './serialize.js';

export function nextOccurrence(from: Date, recurrence: Recurrence): Date {
  const d = new Date(from);
  if (recurrence === 'weekly') d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

export async function listSchedules(user: User) {
  const rows = await Schedule.findAll({ where: { userId: user.id, status: { [Op.ne]: 'cancelled' } }, order: [['nextRunAt', 'ASC']] });
  const contacts = await Contact.findAll({ where: { id: rows.map((r) => r.contactId).filter(Boolean) as string[] } });
  const names = new Map(contacts.map((c) => [c.id, c.name]));
  return rows.map((s) => scheduleView(s, user.currency, s.contactId ? names.get(s.contactId) : undefined));
}

export async function createSchedule(
  user: User,
  input: { recipient: RecipientInput; amount: number; recurrence: Recurrence; startDate?: string; name?: string; note?: string },
) {
  assertPositiveMinor(input.amount);
  const recipient = await resolveRecipient(user, input.recipient);
  if (!recipient.contactId) throw badRequest('Add this person to your contacts before scheduling payments to them');
  const start = input.startDate ? new Date(input.startDate) : new Date(Date.now() + 86_400_000);
  if (Number.isNaN(start.getTime())) throw badRequest('Invalid start date');
  if (start.getTime() < Date.now() - 60_000) throw badRequest('Start date must be in the future');
  const s = await Schedule.create({
    userId: user.id,
    name: (input.name?.trim() || `${recipient.name}${input.note ? ` · ${input.note}` : ''}`).slice(0, 60),
    contactId: recipient.contactId,
    amount: input.amount,
    recurrence: input.recurrence,
    nextRunAt: start,
    note: input.note?.slice(0, 140) ?? null,
  });
  return scheduleView(s, user.currency, recipient.name);
}

export async function cancelSchedule(user: User, id: string) {
  const s = await Schedule.findOne({ where: { id, userId: user.id, status: { [Op.ne]: 'cancelled' } } });
  if (!s) throw notFound('Scheduled payment');
  s.status = 'cancelled';
  await s.save();
  return { cancelled: true, id, name: s.name };
}

/** Executes due schedules. Triggered by a cron hitting /v1/internal/run-schedules. */
export async function runDueSchedules(now = new Date()) {
  const due = await Schedule.findAll({ where: { status: 'active', nextRunAt: { [Op.lte]: now } }, limit: 200 });
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const s of due) {
    // Claim the run first so concurrent runners can't double-pay.
    const next = nextOccurrence(s.nextRunAt, s.recurrence);
    const [claimed] = await Schedule.update({ nextRunAt: next }, { where: { id: s.id, nextRunAt: s.nextRunAt, status: 'active' } });
    if (claimed !== 1) continue;
    // Schedules without a recipient are bill reminders (shown on the week arc), not payments.
    if (!s.contactId) continue;
    try {
      const user = await User.findByPk(s.userId);
      if (!user) throw new Error('owner missing');
      const recipient = await resolveRecipient(user, { contactId: s.contactId });
      await executeTransfer(user, { recipient, amount: s.amount, note: s.note ?? s.name, kind: 'schedule' });
      results.push({ id: s.id, ok: true });
    } catch (err) {
      logger.warn({ err, scheduleId: s.id }, 'scheduled payment failed');
      results.push({ id: s.id, ok: false, error: (err as Error).message });
    }
  }
  return results;
}
