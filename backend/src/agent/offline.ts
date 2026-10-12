import type { User } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { ActionRunner } from './runner.js';
import { listCards } from '../services/cards.js';
import { listContacts } from '../services/contacts.js';
import type { z } from 'zod';
import { uiSpecSchema, type UISpec } from './ui/schema.js';

type Block = z.input<typeof uiSpecSchema>['blocks'] extends (infer B)[] | undefined ? B : never;
import type { ReactResult, ReactStep } from './react.js';

/**
 * Rule-based planner that speaks the same contract as the ReAct agent.
 * Used when no LLM is configured, when the user picks "offline", or as a
 * fallback if the model fails — so the app always answers.
 */

const AMOUNT = String.raw`(\d{1,7}(?:[.,]\d{1,2})?)`;
const num = (s: string) => Number(s.replace(',', '.'));

type Entity = UISpec['entities'][number];
function entity(prompt: string, text: string | undefined, kind: Entity['kind']): Entity[] {
  if (!text) return [];
  const i = prompt.toLowerCase().indexOf(text.toLowerCase());
  return i < 0 ? [] : [{ text: prompt.slice(i, i + text.length), kind }];
}

function periodOf(p: string): 'week' | 'month' | 'year' | '30d' {
  if (/\bweek\b/.test(p)) return 'week';
  if (/\byear\b/.test(p)) return 'year';
  if (/\b30 ?days?\b/.test(p)) return '30d';
  return 'month';
}

const recentList = (title?: string): Block => ({ type: 'transactions', title, query: { limit: 8 }, groupBy: 'day', variant: 'list' });

const HELP: Block[] = [
  { type: 'notice', tone: 'info', text: 'Try “Send 50 to Sara for dinner”, “Show my spending this month”, or “Create a travel card”.' },
  {
    type: 'chips',
    items: [
      { label: 'Send', icon: 'send', action: { type: 'prefill', text: 'Send ' } },
      { label: 'Top up', icon: 'plus', action: { type: 'prefill', text: 'Top up ' } },
      { label: 'Spending', icon: 'chart', action: { type: 'ask', prompt: 'Show my spending this month' } },
      { label: 'Cards', icon: 'card', action: { type: 'navigate', screen: 'cards' } },
    ],
  },
];

/** Maps chart words in a sentence to the right chart form and query (all kinds reachable offline). */
function chartIntent(p: string): { title: string; block: Block } | null {
  const period = periodOf(p);
  const budget = p.match(/\bbudget(?: of)?\s*[$€£]?(\d{1,7}(?:[.,]\d{1,2})?)/)?.[1];
  // "spending vs a budget of 700" is a budget question, not money in vs out.
  const compare = !budget && /\b(vs|versus|compare|comparison|in and out|income and spend|money in|cash ?flow)\b/.test(p);
  const income = !compare && /\b(income|earned|received|money i got)\b/.test(p);
  const direction = compare ? 'both' : income ? 'in' : 'out';
  const byPerson = /\b(by|per) (person|people|contact|merchant)\b|\bwho\b/.test(p);
  const timeGroup = /\bweekly|per week|by week\b/.test(p) ? 'week' : /\bmonthly|per month|by month\b/.test(p) ? 'month' : 'day';
  const what = direction === 'in' ? 'Income' : direction === 'both' ? 'Money in vs out' : 'Spending';

  const chart = (kind: string, groupBy: string, title: string, extra: Record<string, unknown> = {}) =>
    ({ title: what, block: { type: 'chart', title, kind, query: { period, groupBy, direction, ...extra } } as Block });

  if (budget) return chart('gauge', 'category', `${what} vs budget`, { target: num(budget), direction: 'out' });
  if (compare) return chart(/\bstack/.test(p) ? 'stacked' : /\bline|trend/.test(p) ? 'line' : 'grouped', timeGroup === 'day' && period !== 'week' ? 'week' : timeGroup, 'In vs out');
  if (/\bheat ?map|calendar\b/.test(p)) return chart('heatmap', 'day', 'Daily intensity');
  if (/\bsparkline|mini|tiny\b/.test(p)) return chart('sparkline', timeGroup, 'Trend');
  if (/\barea\b/.test(p)) return chart('area', timeGroup, 'Over time');
  if (/\bline|trend|over time\b/.test(p)) return chart('line', timeGroup, 'Trend');
  if (/\bpie\b/.test(p)) return chart('pie', byPerson ? 'counterparty' : 'category', 'Share');
  if (/\bdonut|doughnut|breakdown|share\b/.test(p)) return chart('donut', byPerson ? 'counterparty' : 'category', 'Breakdown');
  if (/\btop|rank|most|biggest|largest|horizontal\b/.test(p)) return chart('hbar', byPerson ? 'counterparty' : 'category', byPerson ? 'Top people' : 'Top categories');
  if (/\bprogress\b/.test(p)) return chart('progress', byPerson ? 'counterparty' : 'category', 'By category');
  if (/\bbar|daily|per day|each day\b/.test(p)) return chart('bar', timeGroup, 'Day by day');
  if (byPerson) return chart('hbar', 'counterparty', 'By person');
  return null;
}

type Attempt = (name: string, input: Record<string, unknown>) => Promise<{ block: Block; ok: boolean; result?: unknown; draft?: boolean }>;
type SpecInput = Partial<z.input<typeof uiSpecSchema>>;
type Done = (spec: SpecInput, understood?: boolean) => OfflineResult;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/** Merchant sentences: invoices, payment links, refunds, disputes, sales, PayPal balance and activity. */
async function merchantIntent(user: User, prompt: string, p: string, attempt: Attempt, done: Done): Promise<OfflineResult | null> {
  // "Invoice john@acme.com 250 for website design"
  let m = p.match(new RegExp(`^(?:invoice|bill)\\s+(\\S+@\\S+)\\s+(?:for\\s+)?${AMOUNT}(?:\\s+for\\s+(.+))?$`));
  if (m) {
    const [, email, amountRaw, what] = m;
    // One confirmation creates and emails the invoice; nothing reaches the customer before the tap.
    const r = await attempt('create_and_send_invoice', { recipientEmail: email, items: [{ name: what ? what[0]!.toUpperCase() + what.slice(1) : 'Services', quantity: 1, unitAmount: num(amountRaw!) }] });
    return done({
      blocks: [r.block, { type: 'invoices', title: 'Recent invoices', limit: 5 }],
      entities: [...entity(prompt, email, 'person'), ...entity(prompt, amountRaw, 'amount'), ...entity(prompt, what, 'purpose')],
    });
  }
  if (/^(?:invoice|bill)\b/.test(p) && !EMAIL.test(p)) {
    return done({ blocks: [{ type: 'notice', tone: 'info', text: 'Who should receive it? Try “Invoice client@example.com 250 for design work”.' }, { type: 'invoices', limit: 5 }] });
  }

  // "Payment link for 49.99 for consulting"
  m = p.match(new RegExp(`^(?:payment link|pay link|checkout link|link)\\s+(?:for\\s+)?${AMOUNT}(?:\\s+for\\s+(.+))?$`));
  if (m) {
    const r = await attempt('create_payment_link', { amount: num(m[1]!), description: m[2] });
    // Creating the link is confirmed first; the confirmation shows the link once created.
    const link = (r.result as { approveUrl?: string; orderId?: string } | undefined) ?? {};
    return done({
      blocks: r.ok && link.approveUrl
        ? [
            { type: 'amount', value: num(m[1]!), caption: m[2] ? `For ${m[2]}` : 'Payment link' },
            { type: 'notice', tone: 'success', title: 'Link ready', text: 'Share it with your customer. When they approve, collect the payment.' },
            { type: 'key_values', rows: [{ label: 'Order', value: link.orderId ?? '' }, { label: 'Link', value: link.approveUrl }] },
            {
              type: 'buttons',
              items: [
                { label: 'Open link', icon: 'paypal', variant: 'secondary', action: { type: 'open_url', url: link.approveUrl } },
                { label: 'Collect payment', icon: 'check', variant: 'primary', action: { type: 'run', action: 'capture_payment', input: { orderId: link.orderId } } },
              ],
            },
          ]
        : [r.block],
      entities: entity(prompt, m[1], 'amount'),
    });
  }

  // "Refund <capture id> [amount]" or "refund the last payment"
  m = p.match(new RegExp(`^refund\\s+([a-z0-9]{12,})(?:\\s+${AMOUNT})?`, 'i'));
  if (m || /^refund\b.*\blast\b/.test(p)) {
    let captureId = m ? prompt.trim().split(/\s+/)[1]! : undefined;
    if (!captureId) {
      const recent = await attempt('merchant_transactions', { days: 30, direction: 'in', limit: 1 });
      captureId = (recent.result as { items?: { id: string }[] } | undefined)?.items?.[0]?.id;
      if (!captureId) return done({ blocks: [recent.ok ? { type: 'empty', title: 'No recent payments to refund', icon: 'receipt' } : recent.block] });
    }
    const r = await attempt('refund_payment', { captureId, ...(m?.[2] ? { amount: num(m[2]) } : {}) });
    return done({ blocks: [r.block, { type: 'paypal_transactions', title: 'Recent payments', days: 30, limit: 5, direction: 'in' }] });
  }

  if (/\bdisputes?|claims?|chargebacks?\b/.test(p)) return done({ title: 'Disputes', blocks: [{ type: 'disputes', status: /\bopen|action\b/.test(p) ? 'REQUIRED_ACTION' : undefined }] });
  if (/\binvoices?\b/.test(p)) {
    const status = /\bunpaid|outstanding|overdue\b/.test(p) ? 'UNPAID' : /\bdrafts?\b/.test(p) ? 'DRAFT' : /\bpaid\b/.test(p) ? 'PAID' : undefined;
    return done({ title: 'Invoices', blocks: [{ type: 'invoices', status, limit: 20 }] });
  }
  if (/\b(sales|revenue|earn|income|turnover)\b/.test(p)) {
    const days = /\bweek\b/.test(p) ? 7 : /\b90|quarter\b/.test(p) ? 90 : 30;
    return done({ title: 'Sales', blocks: [{ type: 'merchant_sales', days, kind: days > 30 ? 'line' : 'bar' }, { type: 'paypal_transactions', title: 'Payments', days, limit: 10, direction: 'in' }] });
  }
  if (/\b(plans?|subscriptions?|products?|catalog)\b/.test(p)) return done({ blocks: [{ type: 'catalog', kind: /\bproducts?|catalog\b/.test(p) ? 'products' : 'plans' }] });
  if (/\bpaypal\b.*\b(activity|transactions?|history)\b|\b(activity|transactions?)\b.*\bpaypal\b/.test(p)) {
    return done({ title: 'PayPal activity', blocks: [{ type: 'paypal_transactions', days: 30, limit: 30 }] });
  }
  if (/\b(paypal balance|business balance|dashboard|overview)\b/.test(p)) return done({ blocks: [{ type: 'merchant_overview' }, { type: 'merchant_sales', days: 30, kind: 'bar' }] });
  return null;
}

export type OfflineResult = ReactResult & { understood: boolean };

type CardView = Awaited<ReturnType<typeof listCards>>[number];
const ORDINALS: Record<string, number> = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, '5th': 4 };

/** The card the sentence names (label, last 4 digits, "second", "last"), or null when it doesn't say. */
function namedCard(p: string, cards: CardView[]): CardView | null {
  const byLabel = cards.find((c) => new RegExp(`\\b${c.label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(p));
  if (byLabel) return byLabel;
  const byDigits = cards.find((c) => p.includes(c.last4));
  if (byDigits) return byDigits;
  const ord = p.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\b/)?.[1]; // "second card" or, in Arabic word order, "card … second"
  if (ord) return (ord === 'last' ? cards.at(-1) : cards[ORDINALS[ord]!]) ?? null;
  return null;
}

/** Contact id to highlight when exactly one contact matches what the user typed. */
async function contactMatch(user: User, who: string): Promise<string | undefined> {
  const found = await listContacts(user, { search: who.replace(/^@/, ''), limit: 2 });
  return found.length === 1 ? found[0]!.id : undefined;
}

export async function runOffline(user: User, prompt: string, runner: ActionRunner = new ActionRunner(user, 'commit')): Promise<OfflineResult> {
  const p = prompt.trim().toLowerCase().replace(/\s+/g, ' ');
  const preview = runner.mode === 'preview';
  const steps: ReactStep[] = [];

  /** Calls an action; returns a confirmation block (pending or draft) or a notice on failure. */
  const attempt: Attempt = async (name, input) => {
    try {
      const res = await runner.run(name, input);
      steps.push({ tool: name, input, ok: true });
      if (res.status === 'needs_confirmation') return { block: { type: 'confirmation', pendingId: res.pending.id }, ok: true };
      if (res.status === 'draft') return { block: { type: 'confirmation', pendingId: res.draft.id }, ok: true, draft: true };
      return { block: { type: 'notice', tone: 'success', text: 'Done.' }, ok: true, result: res.result };
    } catch (err) {
      const message = err instanceof AppError ? err.message : 'Something went wrong';
      steps.push({ tool: name, input, ok: false, error: message });
      return { block: { type: 'notice', tone: 'error', text: message }, ok: false };
    }
  };
  // Planner output goes through the same schema as model output (fills defaults, rejects mistakes).
  const done = (spec: SpecInput, understood = true): OfflineResult => ({
    spec: uiSpecSchema.parse({ version: 1, blocks: [], entities: [], ...spec }),
    steps,
    pendingIds: runner.confirmableIds(),
    understood,
  });

  if (user.accountType === 'business') {
    const merchant = await merchantIntent(user, prompt, p, attempt, done);
    if (merchant) return merchant;
  }

  // delete / remove / cancel: the user selects the item, then confirms
  const removal = /^(delete|remove|close|cancel|stop|terminate|decline|reject)\b/.test(p);
  if (removal && /\bcards?\b/.test(p)) {
    const cards = await listCards(user);
    const named = namedCard(p, cards);
    if (!cards.length) return done({ blocks: [{ type: 'empty', title: 'No cards yet', icon: 'card' }] });
    return done({ blocks: [{ type: 'picker', kind: 'card', title: 'Which card should be closed?', preselect: named?.id, action: 'close_card', input: {} }] });
  }
  if (removal && /\b(schedul\w*|recurring|standing order|automatic payments?|subscriptions?)\b/.test(p)) {
    return done({ blocks: [{ type: 'picker', kind: 'schedule', title: 'Which scheduled payment should stop?', action: 'cancel_schedule', input: {} }] });
  }
  if (removal && /\brequests?\b/.test(p)) {
    const decline = /^(decline|reject)\b/.test(p);
    return done({ blocks: [{ type: 'picker', kind: 'request', title: decline ? 'Which request should be declined?' : 'Which request should be cancelled?', action: decline ? 'decline_request' : 'cancel_request', input: {} }] });
  }
  const contactDel = p.match(/^(?:delete|remove)\s+(?:the\s+)?(?:contact\s+)?(.+?)(?:\s+from\s+(?:my\s+)?contacts)?$/);
  if (removal && contactDel && (/\bcontacts?\b/.test(p) || !/\b(transaction|payment|card|layout)\b/.test(p))) {
    const who = contactDel[1]!.replace(/^(a|my)\s+/, '').replace(/\bcontacts?\b/, '').trim();
    const search = who && !/^(a|one|someone)$/.test(who) ? who : undefined;
    return done({
      blocks: [{ type: 'picker', kind: 'contact', title: 'Which contact should be removed?', search, preselect: search ? await contactMatch(user, search) : undefined, action: 'delete_contact', input: {} }],
      entities: entity(prompt, search, 'person'),
    });
  }
  if (/^pay\b.*\brequests?\b/.test(p)) {
    return done({ blocks: [{ type: 'picker', kind: 'request', title: 'Which request do you want to pay?', action: 'pay_request', input: {} }] });
  }

  // send / pay
  let amountText: string | undefined;
  let who: string | undefined;
  let note: string | undefined;
  let m = p.match(new RegExp(`^(?:send|pay|transfer|give)\\s+${AMOUNT}\\s+(?:to\\s+)?(.+?)(?:\\s+for\\s+(.+))?$`));
  if (m && !/^to$/.test(m[2]!.trim())) {
    amountText = m[1];
    who = m[2];
    note = m[3];
  } else if ((m = p.match(new RegExp(`^(?:send|pay|transfer|give)\\s+(.+?)\\s+${AMOUNT}(?:\\s+for\\s+(.+))?$`)))) {
    who = m[1];
    amountText = m[2];
    note = m[3];
  }
  const amount = amountText ? num(amountText) : undefined;
  if (who && amount !== undefined) {
    const recurring = note?.match(/^(.*?)\s*every (week|month)$/) ?? p.match(/every (week|month)/);
    const cleanNote = note?.replace(/\s*every (week|month)$/, '').replace(/^the\s+/, '');
    const ents = [...entity(prompt, amountText, 'amount'), ...entity(prompt, who, 'person'), ...entity(prompt, note, 'purpose')];
    const finalNote = cleanNote ? cleanNote[0]!.toUpperCase() + cleanNote.slice(1) : undefined;
    const search = who.replace(/^@/, '');
    // The user picks the recipient from a list (preselected when one contact matches), then confirms.
    const preselect = EMAIL.test(search) ? `email:${search}` : await contactMatch(user, search);
    if (recurring) {
      const rec = recurring[recurring.length - 1] === 'week' ? 'weekly' : 'monthly';
      return done({
        blocks: [
          { type: 'amount', value: amount, size: 'xl', caption: rec === 'weekly' ? 'Every week' : 'Every month' },
          { type: 'picker', kind: 'contact', title: 'Who should receive it?', search, preselect, action: 'schedule_payment', input: { amount, recurrence: rec, note: cleanNote } },
        ],
        entities: ents,
      });
    }
    return done({
      blocks: [
        { type: 'amount', value: amount, size: 'xl', ...(finalNote ? { caption: finalNote } : {}) },
        { type: 'picker', kind: 'contact', title: 'Who should receive it?', search, preselect, action: 'send_money', input: { amount, ...(finalNote ? { note: finalNote } : {}) } },
      ],
      entities: ents,
    });
  }

  // card funding: "fund Everyday with 100", "move 100 to my travel card", "move 50 from my card to my balance"
  const fund =
    p.match(new RegExp(`^(?:fund|load|top ?up)\\s+(?:my\\s+)?(.+?)(?:\\s+card)?\\s+with\\s+${AMOUNT}$`)) ??
    p.match(new RegExp(`^(?:move|add|put|transfer|deposit|load)\\s+${AMOUNT}\\s+(?:to|onto|on|in|into)\\s+(?:my\\s+|the\\s+)?(.*?)\\s*card$`));
  const withdraw = p.match(new RegExp(`^(?:move|take|withdraw)\\s+${AMOUNT}\\s+(?:from|off)\\s+(?:my\\s+)?(.*?)\\s*card(?:\\s+to\\s+.*)?$`));
  if (fund || withdraw) {
    const m2 = (fund ?? withdraw)!;
    const [amountRaw, label] = /^\d/.test(m2[1]!) ? [m2[1]!, m2[2] ?? ''] : [m2[2]!, m2[1]!];
    const cards = await listCards(user);
    const action = fund ? 'fund_card' : 'withdraw_from_card';
    const named = cards.find((c) => label && c.label.toLowerCase() === label.trim().toLowerCase()) ?? namedCard(p, cards);
    if (!cards.length) return done({ blocks: [{ type: 'empty', title: 'No cards yet', text: 'Create one with “Create a card”.', icon: 'card' }] });
    if (!named && cards.length > 1) {
      return done({
        blocks: [
          { type: 'amount', value: num(amountRaw), size: 'xl' },
          { type: 'picker', kind: 'card', title: 'Which card?', action, input: { amount: num(amountRaw) } },
        ],
        entities: entity(prompt, amountRaw, 'amount'),
      });
    }
    const target = named ?? cards[0]!;
    const r = await attempt(action, { cardId: target.id, amount: num(amountRaw) });
    return done({ blocks: [r.block, { type: 'card', cardId: target.id, showActions: false, showDetails: false }], entities: [...entity(prompt, amountRaw, 'amount'), ...entity(prompt, label || undefined, 'card')] });
  }

  // Unfinished sentences while typing: "send", "send 500", "send 500 to", "pay sa"
  const partial = p.match(new RegExp(`^(?:send|pay|transfer|give)(?:\\s+${AMOUNT})?(?:\\s+to)?(?:\\s+([a-z@][\\w.@'-]*))?$`));
  if (partial) {
    const [, amountRaw, name] = partial;
    const blocks: Block[] = [];
    if (amountRaw) blocks.push({ type: 'amount', value: num(amountRaw), size: 'xl' });
    blocks.push(
      name
        ? { type: 'contacts', variant: 'list', search: name.replace(/^@/, ''), limit: 5, showNew: false, onSelect: 'prefill_send' }
        : { type: 'contacts', variant: 'avatars', limit: 8, showNew: true, onSelect: 'prefill_send' },
    );
    if (!name) blocks.push({ type: 'transactions', query: { direction: 'out', limit: 5 }, groupBy: 'none', variant: 'compact', title: 'Recent' });
    return done({ blocks, entities: [...entity(prompt, amountRaw, 'amount'), ...entity(prompt, name, 'person')] }, preview);
  }

  // top up
  if ((m = p.match(new RegExp(`(?:top ?up|add money|deposit|load)(?:\\s+(?:my\\s+)?(?:account|balance|wallet))?(?:\\s+with)?\\s+${AMOUNT}`)))) {
    const r = await attempt('top_up', { amount: num(m[1]!) });
    return done({ say: r.ok ? 'You will approve it in PayPal.' : undefined, blocks: [r.block, { type: 'balance', variant: 'compact' }], entities: entity(prompt, m[1], 'amount') });
  }

  // split / request
  if ((m = p.match(new RegExp(`^split\\s+${AMOUNT}\\s+(?:with|between)\\s+(.+?)(?:\\s+for\\s+(.+))?$`)))) {
    const names = m[2]!.split(/\s*(?:,|\band\b|&)\s*/).filter(Boolean);
    const r = await attempt('request_money', { participants: names.map((name) => ({ name })), amount: num(m[1]!), split: true, note: m[3] });
    return done({ blocks: [r.block, { type: 'requests', perspective: 'outgoing' }], entities: [...entity(prompt, m[1], 'amount'), ...names.flatMap((n) => entity(prompt, n, 'person'))] });
  }
  // "request 20 from Sara for lunch" or "request from Sara 20 for lunch"
  const reqA = p.match(new RegExp(`^(?:request|ask(?: for)?)\\s+${AMOUNT}\\s+from\\s+(.+?)(?:\\s+for\\s+(.+))?$`));
  const reqB = reqA ? null : p.match(new RegExp(`^(?:request|ask)\\s+from\\s+(.+?)\\s+${AMOUNT}(?:\\s+for\\s+(.+))?$`));
  if (reqA || reqB) {
    const [amountRaw, who, forNote] = reqA ? [reqA[1]!, reqA[2]!, reqA[3]] : [reqB![2]!, reqB![1]!, reqB![3]];
    const names = who.split(/\s*(?:,|\band\b|&)\s*/).filter(Boolean);
    const r = await attempt('request_money', { participants: names.map((name) => ({ name })), amount: num(amountRaw), note: forNote });
    return done({ blocks: [r.block, { type: 'requests', perspective: 'outgoing' }], entities: [...entity(prompt, amountRaw, 'amount'), ...names.flatMap((n) => entity(prompt, n, 'person'))] });
  }

  // cards
  if (/\b(new|create|get|buy|order|issue)\b.*\bcard\b/.test(p)) {
    const label = prompt.match(/(?:called|named)\s+["“]?([^"”]+?)["”]?$/i)?.[1] ?? prompt.match(/\b(?:a|new)\s+(\w+)\s+card\b/i)?.[1];
    const r = await attempt('create_card', { label: label && !/^(new|virtual)$/i.test(label) ? label : undefined });
    return done({ blocks: [r.block, { type: 'cards', variant: 'stack', showActions: false }] });
  }
  if (/\b(unfreeze|freeze|lock|unlock)\b.*\bcard\b|\bcard\b.*\b(unfreeze|freeze)\b/.test(p)) {
    const cards = await listCards(user);
    const unfreeze = /\b(unfreeze|unlock)\b/.test(p);
    const named = namedCard(p, cards);
    if (!cards.length) return done({ blocks: [{ type: 'empty', title: 'No cards yet', text: 'Create one with “Create a card”.', icon: 'card' }] });
    if (!named && cards.length > 1) {
      return done({ blocks: [{ type: 'picker', kind: 'card', title: unfreeze ? 'Which card should be unfrozen?' : 'Which card should be frozen?', action: unfreeze ? 'unfreeze_card' : 'freeze_card', input: {} }] });
    }
    const target = named ?? cards[0]!;
    const r = await attempt(unfreeze ? 'unfreeze_card' : 'freeze_card', { cardId: target.id });
    return done({
      // Freezing is a change too: show the confirmation above the card, never act directly.
      blocks: [r.block, { type: 'card', cardId: target.id, showActions: false, showDetails: true }],
    });
  }
  if (/\bcards?\b/.test(p)) {
    return done({ blocks: [{ type: 'cards', variant: 'carousel', showActions: true }, { type: 'transactions', title: 'Card activity', query: { kind: 'card_spend', limit: 8 }, groupBy: 'day', variant: 'list', emptyText: 'No card payments yet' }] });
  }

  // insights & charts
  if (/\b(spend|spent|spending|insight|categor|chart|graph|budget|where.*money|income|earned|received|cash ?flow|in vs out|money in)\b/.test(p)) {
    const chart = chartIntent(p);
    if (chart) return done({ title: chart.title, blocks: [chart.block] });
    const period = periodOf(p);
    return done({
      title: 'Spending',
      blocks: [
        { type: 'chart', title: 'By category', kind: 'donut', query: { period, groupBy: 'category', direction: 'out' } },
        { type: 'chart', title: 'Day by day', kind: 'bar', query: { period, groupBy: 'day', direction: 'out' } },
      ],
    });
  }

  // transactions (optionally with a person)
  if (/\b(transactions?|history|activity|payments?|transfers?)\b/.test(p)) {
    const person = p.match(/\b(?:with|to|from)\s+([a-z][\w .'-]{1,40})$/)?.[1];
    const direction = /\b(received|incoming|from)\b/.test(p) && !person ? 'in' : /\b(sent|outgoing)\b/.test(p) ? 'out' : undefined;
    return done({
      title: person ? `With ${person}` : 'Activity',
      blocks: [{ type: 'transactions', query: { counterparty: person, direction, limit: 30 }, groupBy: 'day', variant: 'list', emptyText: 'Nothing found' }],
      entities: entity(prompt, person, 'person'),
    });
  }

  if (/\bbalance|how much (do i|money)\b/.test(p)) return done({ blocks: [{ type: 'balance', variant: 'arc' }] });
  if (/\b(contacts?|people|friends|recipients?)\b/.test(p)) return done({ title: 'People', blocks: [{ type: 'contacts', variant: 'list', limit: 30, showNew: true, onSelect: 'open' }] });
  if (/\b(requests?|owe)\b/.test(p)) return done({ blocks: [{ type: 'requests', perspective: 'all' }] });
  if (/\b(schedul|recurring|every month|subscriptions?)\b/.test(p)) return done({ blocks: [{ type: 'schedules', limit: 10 }] });
  if (/\b(profile|my account|who am i|my info|my details)\b/.test(p)) return done({ blocks: [{ type: 'profile', variant: 'card' }] });

  // Not understood. While typing render nothing at all; on submit, show help.
  return preview ? done({ blocks: [] }, false) : done({ say: "I'm not sure what you meant yet.", blocks: HELP }, false);
}
