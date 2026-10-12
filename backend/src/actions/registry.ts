import { z } from 'zod';
import type { User } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import { connectionView, getConnection, merchantClient, type Capability } from '../services/merchant.js';
import { formatMoney, toMinor } from '../lib/money.js';
import { layoutSlotSchema } from '../agent/ui/schema.js';
import * as cards from '../services/cards.js';
import * as contacts from '../services/contacts.js';
import * as insights from '../services/insights.js';
import * as layouts from '../services/layouts.js';
import * as requests from '../services/requests.js';
import * as schedules from '../services/schedules.js';
import * as topups from '../services/topups.js';
import * as txs from '../services/transactions.js';
import { executeTransfer, getAccount, resolveRecipient, assertWithinLimits, type ResolvedRecipient } from '../services/ledger.js';
import { initials, userView } from '../services/serialize.js';
import { updateProfile } from '../services/users.js';
import { settingsPatchSchema } from '../services/settings.js';

import { define, type ActionDef } from './types.js';
import { MERCHANT_ACTIONS } from './merchant.js';
import { assertPlatformFeature } from '../services/paypalStatus.js';

export type { ActionDef, Audience, ConfirmSummary, ExecuteContext, Risk } from './types.js';

/**
 * Every capability of the app, declared once. Consumed by:
 *  - the ReAct agent (its tools),
 *  - the MCP server (MCP tools),
 *  - the REST API (POST /v1/actions/:name, used by generated buttons).
 * See ./types.ts for risk levels and audiences.
 */

const amount = z.number().positive().max(1_000_000).describe('Amount in major units, e.g. 12.5');
const recipient = z
  .object({
    contactId: z.string().optional(),
    name: z.string().max(80).optional().describe('Contact name as the user said it, e.g. "Ahmed"'),
    email: z.string().max(120).optional(),
    handle: z.string().max(40).optional().describe('DynoPay @handle'),
  })
  .refine((r) => r.contactId || r.name || r.email || r.handle, 'Provide contactId, name, email or handle');

const id = (what: string) => z.string().min(1).max(64).describe(`${what} id`);

function recipientCard(r: ResolvedRecipient) {
  return {
    name: r.name,
    initials: initials(r.name),
    subtitle: r.kind === 'internal' ? `@${r.handle} · DynoPay account` : `${r.email} · PayPal`,
    verified: r.kind === 'internal',
  };
}

async function balanceLine(user: User) {
  const acc = await getAccount(user.id);
  return { label: 'From', value: `Main account · ${formatMoney(acc.balance, acc.currency)}` };
}

async function assertFunds(user: User, minor: number) {
  const acc = await getAccount(user.id);
  if (acc.balance < minor) throw badRequest(`Insufficient balance: you have ${formatMoney(acc.balance, acc.currency)}`);
}

const biometric = (u: User) => u.settings.biometricForSensitive !== false;

const CORE_ACTIONS: ActionDef[] = [
  // ─── read ────────────────────────────────────────────────────────────────
  define({
    name: 'get_profile', risk: 'read', input: z.object({}),
    description: "The signed-in user's profile (name, email, handle, currency, PayPal link, settings).",
    run: async (u) => userView(u),
  }),
  define({
    name: 'get_balance', risk: 'read', input: z.object({}),
    description: 'Main account balance plus the planned payments of this week.',
    run: async (u) => ({ ...(await insights.balanceOverview(u)), week: await insights.weekPlan(u) }),
  }),
  define({
    name: 'list_transactions', risk: 'read', input: txs.txQuerySchema,
    description: 'Search/filter transactions (by counterparty, contact, card, direction, kind, category, dates, amounts). Newest first.',
    run: (u, q) => txs.queryTransactions(u, q),
  }),
  define({
    name: 'get_transaction', risk: 'read', input: z.object({ transactionId: id('Transaction') }),
    description: 'Full details of one transaction.',
    run: (u, i) => txs.getTransaction(u, i.transactionId),
  }),
  define({
    name: 'spending_summary', risk: 'read', input: insights.spendingQuerySchema,
    description: 'Totals of money out (or in) for a period grouped by category, day, week, month or counterparty.',
    run: (u, q) => insights.spendingSummary(u, q),
  }),
  define({
    name: 'list_contacts', risk: 'read', input: z.object({ search: z.string().max(60).optional(), limit: z.number().int().min(1).max(50).optional() }),
    description: 'Contacts (people the user pays). Favorites and recent first.',
    run: (u, i) => contacts.listContacts(u, i),
  }),
  define({
    name: 'get_contact', risk: 'read', input: z.object({ contactId: id('Contact') }),
    description: 'One contact with totals sent/received.',
    run: (u, i) => contacts.getContact(u, i.contactId),
  }),
  define({
    name: 'find_recipient', risk: 'read', input: recipient,
    description: 'Resolve a name/@handle/email/contact to a payable recipient. Use before preparing a transfer when unsure who is meant.',
    run: async (u, r) => {
      const res = await resolveRecipient(u, r);
      return { kind: res.kind, contactId: res.contactId, ...recipientCard(res) };
    },
  }),
  define({
    name: 'list_cards', risk: 'read', input: z.object({ includeClosed: z.boolean().optional() }),
    description: "The user's virtual cards with balance, status, limit and month spend.",
    run: (u, i) => cards.listCards(u, i),
  }),
  define({
    name: 'get_card', risk: 'read', input: z.object({ cardId: id('Card') }),
    description: 'One card.',
    run: (u, i) => cards.getCard(u, i.cardId),
  }),
  define({
    name: 'list_schedules', risk: 'read', input: z.object({}),
    description: 'Scheduled/recurring payments.',
    run: (u) => schedules.listSchedules(u),
  }),
  define({
    name: 'list_requests', risk: 'read', input: z.object({ perspective: z.enum(['incoming', 'outgoing', 'all']).default('all') }),
    description: 'Money requests: incoming (others ask the user to pay) and outgoing (the user asked others).',
    run: (u, i) => requests.listRequests(u, i.perspective),
  }),
  define({
    name: 'list_layouts', risk: 'read', input: z.object({}),
    description: 'Which screen/dialog layouts the user has customised.',
    run: (u) => layouts.listLayouts(u),
  }),
  define({
    name: 'get_layout', risk: 'read', input: z.object({ slot: layoutSlotSchema }),
    description: 'The current layout spec of a slot (home, cards, detail:*).',
    run: (u, i) => layouts.getLayout(u, i.slot),
  }),

  // ─── auto (low-risk, reversible) ─────────────────────────────────────────
  define({
    name: 'freeze_card', risk: 'auto', input: z.object({ cardId: id('Card') }),
    description: 'Freeze a card immediately (protective, reversible).',
    summary: async (u, i) => { const c = await cards.getCard(u, i.cardId); return { title: `Freeze ${c.label}?`, lines: [{ label: 'Card', value: `${c.label} ·· ${c.last4}` }, { label: 'Payments', value: 'Blocked until you unfreeze' }], confirmLabel: 'Freeze card', tone: 'danger' }; },
    run: (u, i) => cards.setCardStatus(u, i.cardId, 'frozen'),
  }),
  define({
    name: 'update_card', risk: 'auto',
    input: z.object({
      cardId: id('Card'),
      label: z.string().max(40).optional(),
      color: z.enum(cards.CARD_COLORS).optional(),
      monthlyLimit: z.number().nonnegative().nullable().optional().describe('Major units; null removes the limit'),
    }),
    description: 'Rename a card, change its color or monthly spending limit.',
    summary: async (u, i) => { const c = await cards.getCard(u, i.cardId); return { title: `Update ${c.label}`, lines: [...(i.label ? [{ label: 'Name', value: `${c.label} → ${i.label}` }] : []), ...(i.color ? [{ label: 'Color', value: i.color }] : []), ...(i.monthlyLimit !== undefined ? [{ label: 'Monthly limit', value: i.monthlyLimit === null ? 'None' : formatMoney(toMinor(i.monthlyLimit), u.currency) }] : [])], confirmLabel: 'Save changes' }; },
    run: (u, i) =>
      cards.updateCard(u, i.cardId, {
        label: i.label,
        color: i.color,
        monthlyLimit: i.monthlyLimit === undefined ? undefined : i.monthlyLimit === null ? null : toMinor(i.monthlyLimit),
      }),
  }),
  define({
    name: 'add_contact', risk: 'auto',
    input: z.object({ name: z.string().min(1).max(60), email: z.string().max(120).optional(), handle: z.string().max(40).optional() }),
    description: 'Add a contact by email or DynoPay @handle.',
    summary: (_u, i) => ({ title: `Add ${i.name}`, lines: [{ label: 'Name', value: i.name }, { label: i.email ? 'Email' : 'Handle', value: i.email ?? `@${(i.handle ?? '').replace(/^@/, '')}` }], confirmLabel: 'Add contact' }),
    run: (u, i) => contacts.addContact(u, i),
  }),
  define({
    name: 'update_contact', risk: 'auto',
    input: z.object({ contactId: id('Contact'), name: z.string().max(60).optional(), favorite: z.boolean().optional() }),
    description: 'Rename a contact or mark as favorite.',
    summary: async (u, i) => { const c = await contacts.getContact(u, i.contactId); return { title: `Update ${c.name}`, lines: [...(i.name ? [{ label: 'Name', value: `${c.name} → ${i.name}` }] : []), ...(i.favorite !== undefined ? [{ label: 'Favorite', value: i.favorite ? 'Yes' : 'No' }] : [])], confirmLabel: 'Save' }; },
    run: (u, i) => contacts.updateContact(u, i.contactId, i),
  }),
  define({
    name: 'update_profile', risk: 'auto',
    input: z.object({
      name: z.string().max(60).optional(),
      settings: settingsPatchSchema.optional(),
    }),
    description: "Update the user's display name or app settings: AI provider, biometrics, haptics, live agent, cache, and design (accent, density, motion, balanceStyle, chartStyle, design brief).",
    summary: (_u, i) => ({ title: 'Update your settings', lines: [...(i.name ? [{ label: 'Name', value: i.name }] : []), ...Object.entries(i.settings ?? {}).filter(([k]) => k !== 'design').map(([k, v]) => ({ label: k, value: String(v) })), ...Object.entries(i.settings?.design ?? {}).map(([k, v]) => ({ label: k, value: String(v).slice(0, 60) }))].slice(0, 8), confirmLabel: 'Save settings' }),
    run: async (u, i) => userView(await updateProfile(u, i)),
  }),
  define({
    name: 'decline_request', risk: 'auto', input: z.object({ requestId: id('Request') }),
    description: 'Decline an incoming money request.',
    summary: () => ({ title: 'Decline this request?', lines: [{ label: 'The requester is notified', value: 'Yes' }], confirmLabel: 'Decline', tone: 'danger' }),
    run: (u, i) => requests.declineRequest(u, i.requestId),
  }),
  define({
    name: 'cancel_request', risk: 'auto', input: z.object({ requestId: id('Request') }),
    description: 'Cancel a money request the user sent.',
    summary: () => ({ title: 'Cancel your request?', lines: [], confirmLabel: 'Cancel request', tone: 'danger' }),
    run: (u, i) => requests.cancelRequest(u, i.requestId),
  }),
  define({
    name: 'save_layout', risk: 'auto',
    input: z.object({ slot: layoutSlotSchema, spec: z.record(z.string(), z.unknown()), instruction: z.string().max(500).optional() }),
    description: 'Persist a UI spec as the layout of a slot (home, cards, detail:transaction, detail:card, detail:contact, detail:profile). Detail templates use "$id" for the entity id.',
    summary: (_u, i) => ({ title: `Save as your ${i.slot.replace('detail:', '').replace(/^./, (m: string) => m.toUpperCase())} layout`, lines: [{ label: 'Blocks', value: String(Array.isArray(i.spec.blocks) ? i.spec.blocks.length : 0) }, ...(i.instruction ? [{ label: 'Style', value: i.instruction.slice(0, 80) }] : [])], confirmLabel: 'Apply layout' }),
    run: (u, i) => layouts.saveLayout(u, i.slot, i.spec, i.instruction),
  }),
  define({
    name: 'reset_layout', risk: 'auto', input: z.object({ slot: layoutSlotSchema }),
    description: 'Restore the built-in layout of a slot.',
    summary: (_u, i) => ({ title: 'Restore the original layout?', lines: [{ label: 'Slot', value: i.slot }], confirmLabel: 'Restore' }),
    run: (u, i) => layouts.resetLayout(u, i.slot),
  }),

  // ─── confirm (human confirmation required) ───────────────────────────────
  define({
    name: 'send_money', risk: 'confirm',
    input: z.object({ recipient, amount, note: z.string().max(140).optional() }),
    description: 'Send money to a contact, @handle or any PayPal email. DynoPay users receive instantly; others via PayPal Payouts.',
    preview: async (u, i) => {
      const r = await resolveRecipient(u, i.recipient);
      const minor = toMinor(i.amount);
      // Outside DynoPay the money goes out as a PayPal payout: refuse now, not after the user confirmed.
      if (r.kind !== 'internal') await assertPlatformFeature('payouts', r.name);
      await assertFunds(u, minor);
      await assertWithinLimits(u.id, minor);
      return {
        title: `Send to ${r.name}`, amount: i.amount, currency: u.currency, recipient: recipientCard(r),
        lines: [
          await balanceLine(u),
          { label: 'Arrives', value: r.kind === 'internal' ? 'In seconds' : 'Minutes, via PayPal' },
          { label: 'Fee', value: 'None' },
          ...(i.note ? [{ label: 'Note', value: i.note }] : []),
        ],
        confirmLabel: 'Hold to send', style: 'hold', tone: 'default', biometric: biometric(u),
      };
    },
    execute: async (u, i) => {
      const r = await resolveRecipient(u, i.recipient);
      const res = await executeTransfer(u, { recipient: r, amount: toMinor(i.amount), note: i.note });
      return { transactionId: res.transactionId, status: res.status, balance: res.balance / 100, recipient: r.name };
    },
  }),
  define({
    name: 'top_up', risk: 'confirm', input: z.object({ amount }),
    description: "Add money to the main balance from the user's PayPal account (opens PayPal to approve).",
    preview: async (u, i) => (await assertPlatformFeature('topUps'), {
      title: 'Top up from PayPal', amount: i.amount, currency: u.currency,
      lines: [{ label: 'To', value: 'Main account' }, { label: 'Paid with', value: 'Your PayPal account' }, { label: 'Fee', value: 'None' }],
      confirmLabel: 'Continue to PayPal', style: 'tap', tone: 'default', biometric: false,
    }),
    execute: async (u, i, ctx) => {
      const order = await topups.startTopUp(u, toMinor(i.amount), ctx.appReturnUrl);
      return { orderId: order.orderId, approveUrl: order.approveUrl, next: 'open_url' };
    },
  }),
  define({
    name: 'create_card', risk: 'confirm',
    input: z.object({ label: z.string().max(40).optional(), color: z.enum(cards.CARD_COLORS).optional(), monthlyLimit: z.number().positive().optional() }),
    description: 'Issue a new virtual card.',
    preview: async (u, i) => ({
      title: 'New virtual card',
      lines: [
        { label: 'Name', value: i.label ?? 'New card' },
        { label: 'Color', value: i.color ?? 'Auto' },
        { label: 'Monthly limit', value: i.monthlyLimit ? formatMoney(toMinor(i.monthlyLimit), u.currency) : 'None' },
        { label: 'Price', value: 'Free' },
      ],
      confirmLabel: 'Create card', style: 'tap', tone: 'default', biometric: biometric(u),
    }),
    execute: async (u, i) => {
      const card = await cards.createCard(u, { label: i.label, color: i.color, monthlyLimit: i.monthlyLimit ? toMinor(i.monthlyLimit) : null });
      return { cardId: card.id, card };
    },
  }),
  define({
    name: 'fund_card', risk: 'confirm', input: z.object({ cardId: id('Card'), amount }),
    description: 'Move money from the main balance onto a card.',
    preview: async (u, i) => {
      const card = await cards.getCard(u, i.cardId);
      const minor = toMinor(i.amount);
      await assertFunds(u, minor);
      return {
        title: `Add to ${card.label}`, amount: i.amount, currency: u.currency,
        lines: [await balanceLine(u), { label: 'To', value: `${card.label} ·· ${card.last4}` }, { label: 'Card balance after', value: formatMoney(toMinor(card.balance) + minor, u.currency) }],
        confirmLabel: 'Hold to move', style: 'hold', tone: 'default', biometric: biometric(u),
      };
    },
    execute: async (u, i) => cards.moveCardFunds(u, i.cardId, toMinor(i.amount), 'to_card'),
  }),
  define({
    name: 'withdraw_from_card', risk: 'confirm', input: z.object({ cardId: id('Card'), amount }),
    description: 'Move money from a card back to the main balance.',
    preview: async (u, i) => {
      const card = await cards.getCard(u, i.cardId);
      if (toMinor(card.balance) < toMinor(i.amount)) throw badRequest(`Card only holds ${card.formattedBalance}`);
      return {
        title: `Move from ${card.label}`, amount: i.amount, currency: u.currency,
        lines: [{ label: 'From', value: `${card.label} · ${card.formattedBalance}` }, { label: 'To', value: 'Main account' }],
        confirmLabel: 'Move money', style: 'tap', tone: 'default', biometric: biometric(u),
      };
    },
    execute: async (u, i) => cards.moveCardFunds(u, i.cardId, toMinor(i.amount), 'to_wallet'),
  }),
  define({
    name: 'unfreeze_card', risk: 'confirm', input: z.object({ cardId: id('Card') }),
    description: 'Unfreeze a frozen card.',
    preview: async (u, i) => {
      const card = await cards.getCard(u, i.cardId);
      return {
        title: `Unfreeze ${card.label}`, lines: [{ label: 'Card', value: `·· ${card.last4}` }, { label: 'Status after', value: 'Active' }],
        confirmLabel: 'Unfreeze', style: 'tap', tone: 'default', biometric: biometric(u),
      };
    },
    execute: async (u, i) => ({ card: await cards.setCardStatus(u, i.cardId, 'active') }),
  }),
  define({
    name: 'close_card', risk: 'confirm', input: z.object({ cardId: id('Card') }),
    description: 'Permanently close a card. Its balance returns to the main account.',
    preview: async (u, i) => {
      const card = await cards.getCard(u, i.cardId);
      return {
        title: `Close ${card.label}?`,
        lines: [{ label: 'Card', value: `·· ${card.last4}` }, { label: 'Returned to main account', value: card.formattedBalance }, { label: 'This cannot be undone', value: '' }],
        confirmLabel: 'Close card', style: 'hold', tone: 'danger', biometric: biometric(u),
      };
    },
    execute: async (u, i) => cards.closeCard(u, i.cardId),
  }),
  define({
    name: 'delete_contact', risk: 'confirm', input: z.object({ contactId: id('Contact') }),
    description: 'Remove a contact (their past transactions stay).',
    preview: async (u, i) => {
      const c = await contacts.getContact(u, i.contactId);
      return {
        title: `Delete ${c.name}?`, recipient: { name: c.name, initials: c.initials, subtitle: c.email ?? '', verified: c.isDynoPayUser },
        lines: [{ label: 'Past transactions', value: 'Kept' }], confirmLabel: 'Delete', style: 'tap', tone: 'danger', biometric: false,
      };
    },
    execute: async (u, i) => contacts.deleteContact(u, i.contactId),
  }),
  define({
    name: 'schedule_payment', risk: 'confirm',
    input: z.object({
      recipient, amount, recurrence: z.enum(['weekly', 'monthly']),
      startDate: z.string().optional().describe('ISO date of the first payment (default: tomorrow)'),
      name: z.string().max(60).optional(), note: z.string().max(140).optional(),
    }),
    description: 'Create a recurring payment (e.g. monthly rent).',
    preview: async (u, i) => {
      const r = await resolveRecipient(u, i.recipient);
      if (!r.contactId) throw badRequest(`Add ${r.name} as a contact first`);
      return {
        title: `Every ${i.recurrence === 'weekly' ? 'week' : 'month'} to ${r.name}`, amount: i.amount, currency: u.currency, recipient: recipientCard(r),
        lines: [
          { label: 'First payment', value: i.startDate ? new Date(i.startDate).toDateString() : 'Tomorrow' },
          { label: 'Repeats', value: i.recurrence === 'weekly' ? 'Weekly' : 'Monthly' },
          ...(i.note ? [{ label: 'Note', value: i.note }] : []),
        ],
        confirmLabel: 'Hold to schedule', style: 'hold', tone: 'default', biometric: biometric(u),
      };
    },
    execute: async (u, i) => ({ schedule: await schedules.createSchedule(u, { ...i, amount: toMinor(i.amount) }) }),
  }),
  define({
    name: 'cancel_schedule', risk: 'confirm', input: z.object({ scheduleId: id('Schedule') }),
    description: 'Stop a recurring payment.',
    preview: async (u, i) => {
      const s = (await schedules.listSchedules(u)).find((x) => x.id === i.scheduleId);
      if (!s) throw badRequest('Scheduled payment not found');
      return {
        title: `Stop "${s.name}"?`, lines: [{ label: 'Amount', value: s.formatted }, { label: 'Next run', value: new Date(s.nextRunAt).toDateString() }],
        confirmLabel: 'Stop payments', style: 'tap', tone: 'danger', biometric: false,
      };
    },
    execute: async (u, i) => schedules.cancelSchedule(u, i.scheduleId),
  }),
  define({
    name: 'request_money', risk: 'confirm',
    input: z.object({
      participants: z.array(recipient).min(1).max(10), amount,
      split: z.boolean().default(false).describe('true: amount is a total split equally between participants and the user'),
      note: z.string().max(140).optional(),
    }),
    description: 'Ask one or more people to pay the user (also used to split a bill).',
    preview: async (u, i) => {
      const people = await Promise.all(i.participants.map((p) => resolveRecipient(u, p)));
      const each = i.split ? i.amount / (people.length + 1) : i.amount;
      return {
        title: i.split ? 'Split the bill' : 'Request money', amount: i.split ? i.amount : i.amount * people.length, currency: u.currency,
        lines: [
          ...people.map((p) => ({ label: p.name, value: formatMoney(Math.floor(toMinor(each)), u.currency) })),
          ...(i.note ? [{ label: 'For', value: i.note }] : []),
        ],
        confirmLabel: 'Send request', style: 'tap', tone: 'default', biometric: false,
      };
    },
    execute: async (u, i) => ({ requests: await requests.createRequests(u, { ...i, amount: toMinor(i.amount) }) }),
  }),
  define({
    name: 'pay_request', risk: 'confirm', input: z.object({ requestId: id('Request') }),
    description: 'Pay an incoming money request.',
    preview: async (u, i) => {
      const r = (await requests.listRequests(u, 'incoming')).find((x) => x.id === i.requestId);
      if (!r) throw badRequest('Request not found');
      await assertFunds(u, toMinor(r.amount));
      return {
        title: `Pay ${r.requesterName ?? 'request'}`, amount: r.amount, currency: r.currency,
        lines: [await balanceLine(u), ...(r.note ? [{ label: 'For', value: r.note }] : [])],
        confirmLabel: 'Hold to pay', style: 'hold', tone: 'default', biometric: biometric(u),
      };
    },
    execute: async (u, i) => requests.payRequest(u, i.requestId),
  }),
];

export const ACTIONS: ActionDef[] = [...CORE_ACTIONS, ...MERCHANT_ACTIONS];
export const ACTION_MAP = new Map(ACTIONS.map((a) => [a.name, a]));

/** The actions this user can use: merchant actions only for business accounts. */
/**
 * Actions this user may use. With `capabilities` (the merchant's granted PayPal capabilities), merchant
 * actions whose capability isn't granted are left out too. Prefer `allowedActions`, which loads them.
 */
export function actionsFor(user: User, capabilities?: readonly string[] | null): ActionDef[] {
  return ACTIONS.filter((a) => {
    if ((a.audience ?? 'all') === 'all') return true;
    if (user.accountType !== 'business') return false;
    return !capabilities || !a.capability || capabilities.includes(a.capability);
  });
}

/** Granted merchant capabilities (null for personal accounts). */
export async function merchantCapabilities(user: User): Promise<string[] | null> {
  if (user.accountType !== 'business') return null;
  const conn = await getConnection(user);
  if (!conn || conn.status !== 'active') return [];
  return (connectionView(conn)?.capabilities ?? []).filter((c) => c.enabled).map((c) => c.key);
}

/** Exactly the actions this user is authorized for right now: account type + merchant capabilities. */
export async function allowedActions(user: User): Promise<ActionDef[]> {
  return actionsFor(user, await merchantCapabilities(user));
}

/** Throws unless the user may use this action (also checked when a pending action is confirmed). */
export async function assertAllowed(user: User, def: ActionDef): Promise<void> {
  if (!def.capability) return;
  const caps = await merchantCapabilities(user);
  // merchantClient explains exactly what is missing (no connection, expired credentials, capability off).
  if (caps && !caps.includes(def.capability)) await merchantClient(user, def.capability as Capability);
}

export function getAction(name: string): ActionDef {
  const def = ACTION_MAP.get(name);
  if (!def) throw badRequest(`Unknown action "${name}"`);
  return def;
}
