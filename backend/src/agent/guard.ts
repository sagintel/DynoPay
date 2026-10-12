import { Op } from 'sequelize';
import { env } from '../config/env.js';
import { Card, Contact, Transaction, type User } from '../db/index.js';
import { formatMoney, toMajor, toMinor } from '../lib/money.js';
import { getAccount } from '../services/ledger.js';
import { connectionView, getConnection } from '../services/merchant.js';

/**
 * The guard runs BEFORE any engine (cache, rules, LLM) and checks a request against the user's
 * real account and permissions. It is the security layer against sentences that cannot be
 * fulfilled ("send 200 to 6789", 300 with 50 on the balance) and against attempts to talk the
 * assistant out of its rules ("skip the confirmation", "ignore your instructions", someone
 * else's account). Rejections are shown under a red prompt bar; nothing runs.
 */

export type RejectionCode =
  | 'manipulation'
  | 'invalid_recipient'
  | 'unclear'
  | 'invalid_amount'
  | 'insufficient_funds'
  | 'limit_exceeded'
  | 'not_allowed'
  | 'not_found'
  | 'cannot_fulfill';

export type Rejection = { code: RejectionCode; message: string };

export type AccountSnapshot = {
  accountType: User['accountType'];
  currency: string;
  balance: number; // major units
  formattedBalance: string;
  perTransferLimit: number;
  dailyRemaining: number;
  contacts: string[];
  cards: { label: string; last4: string; status: string; balance: number }[];
  merchant: { capabilities: string[] } | null;
};

const OUTGOING = ['transfer', 'payout', 'schedule', 'request_payment'];

/** What the assistant knows about the account (also given to the LLM as context). */
export async function accountSnapshot(user: User): Promise<AccountSnapshot> {
  const [account, sent, contacts, cards, conn] = await Promise.all([
    getAccount(user.id),
    Transaction.sum('amount', {
      where: { userId: user.id, direction: 'out', kind: OUTGOING, status: { [Op.ne]: 'failed' }, createdAt: { [Op.gte]: new Date(Date.now() - 86_400_000) } },
    }) as Promise<number | null>,
    Contact.findAll({ where: { userId: user.id }, attributes: ['name'], order: [['favorite', 'DESC'], ['lastPaidAt', 'DESC']], limit: 40 }),
    Card.findAll({ where: { userId: user.id, status: { [Op.ne]: 'closed' } }, order: [['createdAt', 'ASC']] }),
    user.accountType === 'business' ? getConnection(user) : Promise.resolve(null),
  ]);
  const daily = toMinor(env.LIMIT_DAILY_OUT) - (sent ?? 0);
  return {
    accountType: user.accountType,
    currency: account.currency,
    balance: toMajor(account.balance),
    formattedBalance: formatMoney(account.balance, account.currency),
    perTransferLimit: env.LIMIT_PER_TRANSFER,
    dailyRemaining: toMajor(Math.max(0, daily)),
    contacts: contacts.map((c) => c.name),
    cards: cards.map((c) => ({ label: c.label, last4: c.last4, status: c.status, balance: toMajor(c.balance) })),
    merchant: conn ? { capabilities: (connectionView(conn)?.capabilities ?? []).filter((c) => c.enabled).map((c) => c.key) } : null,
  };
}

// Attempts to change the rules, in the languages the app speaks (the LLM gets the same rule in its prompt).
const MANIPULATION: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b.{0,30}\b(instruction|rule|polic|previous|above|system|guard|limit)/,
  /\b(skip|bypass|disable|turn off|remove|avoid|without)\b.{0,25}\b(confirm|confirmation|verification|verify|biometric|face ?id|pin|password|approval|limit|security|check)/,
  /\bno (confirmation|confirm|verification|approval)\b/,
  /\b(you are|act as|pretend( to be)?|you're now|become)\b.{0,20}\b(admin|administrator|developer|root|system|god mode|unrestricted|jailbroken|dan)\b/,
  /\b(system prompt|developer mode|jailbreak|god mode|sudo|prompt injection)\b/,
  /\b(reveal|show|print|leak)\b.{0,20}\b(your|the)\b.{0,10}\b(prompt|instructions|rules|api key|secret|token)\b/,
  /\b(unlimited|infinite|free) (money|balance|credit)\b|\b(add|give) me (free|unlimited) money\b/,
  /\b(from|of|using|in)\b.{0,15}\b(someone else'?s?|another (user|person|account)|other users?'?|their)\b.{0,10}\b(account|balance|card|money|wallet)\b/,
  // fr / sw / es
  /\b(ignore|ignorez|oublie)\b.{0,30}\b(instructions|règles)\b|\bsans (confirmation|vérification)\b/,
  /\b(puuza|ruka)\b.{0,30}\b(maelekezo|sheria|uthibitisho)\b|\bbila (uthibitisho|kuthibitisha)\b/,
  /\b(ignora|olvida)\b.{0,30}\b(instrucciones|reglas)\b|\bsin (confirmación|verificación)\b/,
];

const SEND_VERB = /^(send|pay|transfer|give|wire)\b/;
const NUMBER = /(?<![\w.])[$€£]?(\d{1,9}(?:[.,]\d{1,2})?)(?![\w])/;
const MONEY_WORDS = /^(send|pay|transfer|give|wire|fund|move|add|put|deposit|load|top ?up|split|request)\b/;

const fmt = (n: number, currency: string) => formatMoney(Math.round(n * 100), currency);

/**
 * Checks a sentence (already normalised to English keywords) against the account.
 * Returns null when it may proceed to the engines.
 */
export function checkRequest(p: string, snap: AccountSnapshot): Rejection | null {
  const text = p.toLowerCase().replace(/\s+/g, ' ').trim();

  for (const re of MANIPULATION) {
    if (re.test(text)) {
      return { code: 'manipulation', message: "I can't change how DynoPay works: every change needs your own confirmation, and only your account can be used." };
    }
  }

  if (/\b(?!my\b)\w+'s (balance|account|password|pin|card number|wallet)\b/.test(text)) {
    return { code: 'not_allowed', message: 'You can only see and use your own account.' };
  }

  if (snap.accountType !== 'business' && /^(invoice|bill)\b|\brefund\b|\bdisputes?\b|\bpayment link\b|\bpaypal (balance|sales)\b/.test(text)) {
    return { code: 'not_allowed', message: 'That is a merchant feature. Sign in as a merchant with your PayPal business credentials to use it.' };
  }

  if (!MONEY_WORDS.test(text)) return null;

  // Garbled input like "send send 300".
  if (/\b(\w+) \1\b/.test(text) && /^(send|pay|transfer|give)\b/.test(text)) {
    const amount = text.match(NUMBER)?.[1];
    return { code: 'unclear', message: amount ? `“${p}” isn't clear. Who should receive ${fmt(Number(amount.replace(',', '.')), snap.currency)}?` : `“${p}” isn't clear. Say who to pay and how much.` };
  }

  const amountRaw = text.match(NUMBER)?.[1];
  const amount = amountRaw ? Number(amountRaw.replace(',', '.')) : undefined;
  if (amount !== undefined && !(amount > 0)) return { code: 'invalid_amount', message: 'The amount must be more than zero.' };

  if (SEND_VERB.test(text)) {
    // Recipient: whatever follows "to" (or the word after the verb when there is no "to").
    const after = text.match(/\bto\s+(.+?)(?:\s+for\s+.*)?$/)?.[1]?.trim();
    if (after) {
      const target = after.replace(/^@/, '');
      if (/^\+?[\d\s().-]{2,}$/.test(target)) {
        return { code: 'invalid_recipient', message: `“${after}” isn't a contact, @handle or email address. Choose someone from your contacts or type their email.` };
      }
      if (target.includes('@') && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(target)) {
        return { code: 'invalid_recipient', message: `“${after}” isn't a valid email address.` };
      }
    }
    if (amount !== undefined) {
      if (amount > snap.balance) {
        return { code: 'insufficient_funds', message: `You have ${snap.formattedBalance} available, so ${fmt(amount, snap.currency)} can't be sent. Top up first or send less.` };
      }
      if (amount > snap.perTransferLimit) {
        return { code: 'limit_exceeded', message: `A single transfer is limited to ${fmt(snap.perTransferLimit, snap.currency)}.` };
      }
      if (amount > snap.dailyRemaining) {
        return { code: 'limit_exceeded', message: `You can send ${fmt(snap.dailyRemaining, snap.currency)} more today (24-hour limit).` };
      }
    }
    return null;
  }

  // Moving money onto a card comes from the main balance.
  if (/^(fund|move|add|put|deposit|load)\b.*\bcard\b/.test(text) && !/\bfrom\b.*\bcard\b/.test(text) && amount !== undefined) {
    if (!snap.cards.length) return { code: 'not_found', message: "You don't have a card yet. Create one first." };
    if (amount > snap.balance) {
      return { code: 'insufficient_funds', message: `You have ${snap.formattedBalance} available; ${fmt(amount, snap.currency)} can't go onto a card.` };
    }
  }
  if (/^(move|take|withdraw)\b.*\bfrom\b.*\bcard\b/.test(text) && amount !== undefined && snap.cards.length) {
    const most = Math.max(...snap.cards.map((c) => c.balance));
    if (amount > most) return { code: 'insufficient_funds', message: `None of your cards holds ${fmt(amount, snap.currency)}.` };
  }
  if (/^(top ?up|deposit|load|add)\b/.test(text) && !/\bcard\b/.test(text) && amount !== undefined && amount > 10_000) {
    return { code: 'limit_exceeded', message: `Top-ups are limited to ${fmt(10_000, snap.currency)} at a time.` };
  }
  return null;
}

/** Compact account context for the LLM (it must respect these facts, never invent others). */
export function snapshotForAgent(s: AccountSnapshot) {
  return {
    accountType: s.accountType,
    balance: s.formattedBalance,
    perTransferLimit: fmt(s.perTransferLimit, s.currency),
    canSendToday: fmt(s.dailyRemaining, s.currency),
    contacts: s.contacts.slice(0, 25),
    cards: s.cards.map((c) => `${c.label} ··${c.last4} (${c.status}, ${fmt(c.balance, s.currency)})`),
    merchantCapabilities: s.merchant?.capabilities ?? null,
  };
}
