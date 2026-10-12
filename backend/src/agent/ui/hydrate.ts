import type { User } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { draftAction, getPending, performAction, type DraftView } from '../../actions/perform.js';
import * as cards from '../../services/cards.js';
import * as contacts from '../../services/contacts.js';
import * as insights from '../../services/insights.js';
import * as requests from '../../services/requests.js';
import * as schedules from '../../services/schedules.js';
import * as txs from '../../services/transactions.js';
import { userView } from '../../services/serialize.js';
import type { Block, Dialog, LeafBlock, UISpec } from './schema.js';
import { applyDesign } from './preferences.js';
import { pickerData } from './picker.js';
import { resolveSettings } from '../../services/settings.js';

type Hydrated<T> = T & { data?: unknown; error?: string };
export type HydratedBlock = Hydrated<LeafBlock> | (Extract<Block, { type: 'section' | 'row' }> & { children: Hydrated<LeafBlock>[] });
export type HydratedSpec = Omit<UISpec, 'blocks' | 'dialog'> & {
  blocks: HydratedBlock[];
  dialog?: Omit<Dialog, 'blocks'> & { blocks: Hydrated<LeafBlock>[] };
  currency: string;
};

async function load(user: User, b: LeafBlock, drafts?: Map<string, DraftView>): Promise<unknown> {
  switch (b.type) {
    case 'balance': {
      const [overview, week] = await Promise.all([insights.balanceOverview(user), b.variant === 'arc' ? insights.weekPlan(user) : null]);
      return { ...overview, week };
    }
    case 'transactions':
      return txs.queryTransactions(user, { limit: 12, ...b.query });
    case 'contacts':
      return contacts.listContacts(user, { search: b.search, limit: b.limit });
    case 'chart':
      return insights.spendingSummary(user, b.query);
    case 'cards':
      return cards.listCards(user);
    case 'card':
      return cards.getCard(user, b.cardId);
    case 'transaction':
      return txs.getTransaction(user, b.transactionId);
    case 'contact':
      return contacts.getContact(user, b.contactId);
    case 'profile':
      return userView(user);
    case 'schedules':
      return (await schedules.listSchedules(user)).slice(0, b.limit);
    case 'requests':
      return requests.listRequests(user, b.perspective);
    case 'picker':
      return pickerData(user, b);
    case 'confirmation':
      if (b.pendingId.startsWith('draft_')) {
        const known = drafts?.get(b.pendingId);
        if (known) return known;
        if (!b.draft) throw new AppError('expired', 'This preview expired. Type it again.');
        return draftAction(user, b.draft.action, b.draft.input); // recomputed: always current balances/limits
      }
      return getPending(user, b.pendingId);
    // Merchant blocks reuse the registry, so audience + capability checks apply identically.
    case 'merchant_overview':
      return read(user, 'merchant_overview', {});
    case 'merchant_sales':
      return read(user, 'merchant_sales', { days: b.days });
    case 'paypal_transactions':
      return read(user, 'merchant_transactions', { days: b.days, limit: b.limit, search: b.search, direction: b.direction });
    case 'invoices':
      return read(user, 'list_invoices', { status: b.status, limit: b.limit });
    case 'invoice':
      return read(user, 'get_invoice', { invoiceId: b.invoiceId });
    case 'disputes':
      return read(user, 'list_disputes', { status: b.status });
    case 'dispute':
      return read(user, 'get_dispute', { disputeId: b.disputeId });
    case 'catalog':
      return read(user, b.kind === 'products' ? 'list_products' : 'list_plans', {});
    default:
      return undefined;
  }
}

async function read(user: User, action: string, input: Record<string, unknown>) {
  const res = await performAction(user, action, input);
  return res.status === 'done' ? res.result : undefined;
}

async function hydrateLeaf(user: User, b: LeafBlock, drafts?: Map<string, DraftView>): Promise<Hydrated<LeafBlock>> {
  try {
    const data = await load(user, b, drafts);
    return data === undefined ? b : { ...b, data };
  } catch (err) {
    if (!(err instanceof AppError)) logger.warn({ err, type: b.type }, 'block hydration failed');
    return { ...b, error: err instanceof AppError ? err.message : 'Could not load this section' };
  }
}

export async function hydrateSpec(user: User, spec: UISpec, drafts?: Map<string, DraftView>): Promise<HydratedSpec> {
  spec = applyDesign(spec, resolveSettings(user.settings).design);
  const blocks = await Promise.all(
    spec.blocks.map(async (b): Promise<HydratedBlock> => {
      if (b.type === 'section' || b.type === 'row') {
        return { ...b, children: await Promise.all(b.children.map((c) => hydrateLeaf(user, c, drafts))) };
      }
      return hydrateLeaf(user, b, drafts);
    }),
  );
  const dialog = spec.dialog
    ? { ...spec.dialog, blocks: await Promise.all(spec.dialog.blocks.map((c) => hydrateLeaf(user, c as LeafBlock))) }
    : undefined;
  return { ...spec, blocks, dialog, currency: user.currency };
}
