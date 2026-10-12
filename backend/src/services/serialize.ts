import type { Card, Contact, MoneyRequest, Schedule, Transaction, User } from '../db/index.js';
import { formatMoney, toMajor } from '../lib/money.js';
import { resolveSettings } from './settings.js';

/** Public shapes returned to the app, the agent and MCP clients. Money is in major units. */

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';

export const money = (minor: number, currency: string) => ({
  amount: toMajor(minor),
  currency,
  formatted: formatMoney(minor, currency),
});

export function txView(t: Transaction) {
  const signed = t.direction === 'out' ? -t.amount : t.amount;
  return {
    id: t.id,
    direction: t.direction,
    kind: t.kind,
    status: t.status,
    amount: toMajor(t.amount),
    signedAmount: toMajor(signed),
    currency: t.currency,
    formatted: formatMoney(t.amount, t.currency),
    counterparty: {
      name: t.counterpartyName,
      initials: initials(t.counterpartyName),
      handle: t.counterpartyHandle,
      email: t.counterpartyEmail,
      contactId: t.contactId,
      isDynoPayUser: !!t.counterpartyUserId,
    },
    cardId: t.cardId,
    category: t.category,
    note: t.note,
    balanceAfter: t.balanceAfter === null ? null : toMajor(t.balanceAfter),
    reference: t.externalRef,
    createdAt: t.createdAt.toISOString(),
  };
}
export type TxView = ReturnType<typeof txView>;

export function contactView(c: Contact) {
  return {
    id: c.id,
    name: c.name,
    initials: initials(c.name),
    email: c.email,
    handle: c.handle,
    isDynoPayUser: !!c.linkedUserId,
    favorite: c.favorite,
    lastPaidAt: c.lastPaidAt?.toISOString() ?? null,
  };
}
export type ContactView = ReturnType<typeof contactView>;

export function cardView(c: Card, currency: string, spentThisMonthMinor = 0) {
  return {
    id: c.id,
    label: c.label,
    last4: c.last4,
    color: c.color,
    status: c.status,
    balance: toMajor(c.balance),
    currency,
    formattedBalance: formatMoney(c.balance, currency),
    monthlyLimit: c.monthlyLimit === null ? null : toMajor(c.monthlyLimit),
    spentThisMonth: toMajor(spentThisMonthMinor),
    expiry: `${String(c.expMonth).padStart(2, '0')}/${String(c.expYear).slice(-2)}`,
    createdAt: c.createdAt.toISOString(),
  };
}
export type CardView = ReturnType<typeof cardView>;

export function scheduleView(s: Schedule, currency: string, contactName?: string) {
  return {
    id: s.id,
    name: s.name,
    contactId: s.contactId,
    recipientName: contactName ?? null,
    amount: toMajor(s.amount),
    currency,
    formatted: formatMoney(s.amount, currency),
    recurrence: s.recurrence,
    nextRunAt: s.nextRunAt.toISOString(),
    status: s.status,
    note: s.note,
  };
}

export function requestView(r: MoneyRequest, perspective: 'incoming' | 'outgoing', requesterName?: string) {
  return {
    id: r.id,
    perspective,
    requesterName: requesterName ?? null,
    payerName: r.payerName,
    payerEmail: r.payerEmail,
    amount: toMajor(r.amount),
    currency: r.currency,
    formatted: formatMoney(r.amount, r.currency),
    note: r.note,
    status: r.status,
    groupId: r.groupId,
    createdAt: r.createdAt.toISOString(),
  };
}

export function userView(u: User) {
  return {
    id: u.id,
    name: u.name,
    firstName: u.name.split(/\s+/)[0] ?? u.name,
    initials: initials(u.name),
    email: u.email,
    handle: u.handle,
    verified: u.verified,
    currency: u.currency,
    accountType: u.accountType,
    paypalLinked: !!u.paypalUserId,
    settings: resolveSettings(u.settings),
    memberSince: u.createdAt.toISOString(),
  };
}
