import type { User } from '../db/index.js';
import { formatMoney, toMinor } from '../lib/money.js';
import { listCards } from '../services/cards.js';
import { listContacts } from '../services/contacts.js';

/**
 * "What I understood": the main elements of the user's sentence, resolved against their account,
 * so the app can show them as chips under the prompt bar while they type (like the concept video:
 * “Send · $500 · Sara Nasser · dinner”). Works on the English-normalised sentence and maps every
 * element back to the words the user actually typed (for highlighting), in any language.
 */
export type IntentPart =
  | { kind: 'action'; label: string; text?: string }
  | { kind: 'amount'; label: string; value: number; text?: string }
  | { kind: 'person'; label: string; subtitle?: string; initials?: string; status: 'matched' | 'ambiguous' | 'unknown' | 'email'; candidates?: number; text?: string }
  | { kind: 'card'; label: string; subtitle?: string; text?: string }
  | { kind: 'purpose'; label: string; text?: string }
  | { kind: 'missing'; label: string };

export type Intent = { parts: IntentPart[]; complete: boolean };

const ACTIONS: [RegExp, string, 'person' | 'card' | null][] = [
  [/^(send|transfer|give|wire)\b/, 'Send', 'person'],
  [/^pay\b/, 'Pay', 'person'],
  [/^(request|ask)\b/, 'Request', 'person'],
  [/^split\b/, 'Split', 'person'],
  [/^(top ?up|add money)\b/, 'Top up', null],
  [/^(fund|load|deposit|move|add|put)\b.*\bcard\b/, 'Add money', 'card'],
  [/^(withdraw|take)\b.*\bcard\b/, 'Move money', 'card'],
  [/^(unfreeze|unlock)\b/, 'Unfreeze', 'card'],
  [/^(freeze|lock)\b/, 'Freeze', 'card'],
  [/^(create|new|get|order|issue)\b.*\bcard\b/, 'New card', null],
  [/^(close)\b.*\bcard\b/, 'Close card', 'card'],
  [/^(invoice|bill)\b/, 'Invoice', 'person'],
  [/^refund\b/, 'Refund', null],
];
const AMOUNT = /(?<![\w.])[$€£]?(\d{1,9}(?:[.,]\d{1,2})?)(?![\w])/;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;
const ORDINALS: Record<string, number> = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, last: -1 };

/** Finds `piece` in the original sentence (case-insensitive) so the app can highlight what was typed. */
function inOriginal(original: string, piece: string | undefined): string | undefined {
  if (!piece) return undefined;
  const i = original.toLowerCase().indexOf(piece.toLowerCase());
  return i >= 0 ? original.slice(i, i + piece.length) : undefined;
}

export async function understand(user: User, original: string, normalized: string): Promise<Intent> {
  const p = normalized.toLowerCase().replace(/\s+/g, ' ').trim();
  const action = ACTIONS.find(([re]) => re.test(p));
  if (!action) return { parts: [], complete: false };
  const [, label, target] = action;
  const parts: IntentPart[] = [{ kind: 'action', label, text: inOriginal(original, original.trim().split(/\s+/)[0]) }];

  const amountRaw = p.match(AMOUNT)?.[1];
  const amount = amountRaw ? Number(amountRaw.replace(',', '.')) : undefined;
  if (amount && amount > 0) {
    parts.push({ kind: 'amount', value: amount, label: formatMoney(toMinor(amount), user.currency), text: inOriginal(original, original.match(AMOUNT)?.[0]) });
  } else if (label !== 'Freeze' && label !== 'Unfreeze' && label !== 'New card' && label !== 'Close card' && label !== 'Refund') {
    parts.push({ kind: 'missing', label: 'How much?' });
  }

  if (target === 'person') {
    const email = original.match(EMAIL)?.[0];
    // Whoever follows "to"/"from"/"with" (or the word after the verb), up to "for …".
    const who =
      email ??
      p.match(/\b(?:to|from|with)\s+(.+?)(?:\s+for\s+.*)?$/)?.[1]?.trim() ??
      p.match(/^(?:send|pay|transfer|give)\s+([a-z@][\w.'-]*)(?:\s|$)/)?.[1];
    const name = who?.replace(/^@/, '').replace(/\s+\d.*$/, '').trim();
    if (email) {
      const match = (await listContacts(user, { search: email.toLowerCase(), limit: 2 })).find((c) => c.email === email.toLowerCase());
      parts.push(match
        ? { kind: 'person', label: match.name, subtitle: email.toLowerCase(), initials: match.initials, status: 'matched', text: email }
        : { kind: 'person', label: email.toLowerCase(), subtitle: 'PayPal', initials: email.slice(0, 2).toUpperCase(), status: 'email', text: email });
    } else if (name && /[a-z]/i.test(name) && !/^\d+$/.test(name)) {
      const found = await listContacts(user, { search: name, limit: 5 });
      const exact = found.filter((c) => c.name.toLowerCase().split(/\s+/)[0] === name.toLowerCase().split(/\s+/)[0] || c.handle === name.toLowerCase());
      const best = exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : undefined;
      const text = inOriginal(original, name) ?? inOriginal(original, who);
      parts.push(best
        ? { kind: 'person', label: best.name, subtitle: best.handle ? `@${best.handle}` : best.email ?? undefined, initials: best.initials, status: 'matched', text }
        : found.length > 1
          ? { kind: 'person', label: name.replace(/^./, (c) => c.toUpperCase()), status: 'ambiguous', candidates: found.length, text }
          : { kind: 'person', label: name.replace(/^./, (c) => c.toUpperCase()), status: 'unknown', text });
    } else {
      parts.push({ kind: 'missing', label: 'Who?' });
    }
  } else if (target === 'card') {
    const cards = await listCards(user);
    const ord = p.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|last)\b/)?.[1];
    const card =
      cards.find((c) => p.includes(c.label.toLowerCase())) ??
      cards.find((c) => p.includes(c.last4)) ??
      (ord ? (ORDINALS[ord] === -1 ? cards.at(-1) : cards[ORDINALS[ord]!]) : undefined) ??
      (cards.length === 1 ? cards[0] : undefined);
    parts.push(card
      ? { kind: 'card', label: card.label, subtitle: `·· ${card.last4}`, text: inOriginal(original, card.label) ?? inOriginal(original, ord) }
      : { kind: 'missing', label: 'Which card?' });
  }

  const purpose = p.match(/\bfor\s+(?:the\s+|my\s+)?(.+?)(?:\s+every\s+(?:week|month))?$/)?.[1];
  if (purpose && !EMAIL.test(purpose) && !/^\d/.test(purpose)) {
    const text = inOriginal(original, purpose) ?? original.match(/\s(\S+)\s*$/)?.[1];
    parts.push({ kind: 'purpose', label: purpose.replace(/^./, (c) => c.toUpperCase()), text });
  }
  return { parts, complete: !parts.some((x) => x.kind === 'missing' || (x.kind === 'person' && x.status !== 'matched' && x.status !== 'email')) };
}
