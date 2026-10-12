import type { z } from 'zod';
import { uiSpecSchema, type LayoutSlot, type UISpec } from './schema.js';

/**
 * Built-in layouts used until the user (through the agent) customises a slot.
 * Detail slots are dialog templates: "$id" is replaced with the opened entity id.
 */
const DEFAULTS: Record<LayoutSlot, z.input<typeof uiSpecSchema>> = {
  home: {
    version: 1,
    blocks: [
      { type: 'balance', variant: 'arc' },
      {
        type: 'chips',
        items: [
          { label: 'Send', icon: 'send', action: { type: 'prefill', text: 'Send ' } },
          { label: 'Top up', icon: 'plus', action: { type: 'prefill', text: 'Top up ' } },
          { label: 'Insights', icon: 'chart', action: { type: 'ask', prompt: 'Show my spending this month by category' } },
          { label: 'Split', icon: 'split', action: { type: 'prefill', text: 'Split ' } },
        ],
      },
      { type: 'contacts', variant: 'avatars', limit: 8, showNew: true, onSelect: 'prefill_send' },
      { type: 'transactions', query: { limit: 12 }, groupBy: 'day', variant: 'list' },
    ],
    entities: [],
  },
  cards: {
    version: 1,
    title: 'Cards',
    blocks: [
      { type: 'cards', variant: 'carousel', showActions: true },
      {
        type: 'chips',
        items: [
          { label: 'New card', icon: 'plus', action: { type: 'ask', prompt: 'Create a new virtual card' } },
          { label: 'Card spending', icon: 'chart', action: { type: 'ask', prompt: 'Show my card spending this month by category' } },
          { label: 'All cards', icon: 'card', action: { type: 'ask', prompt: 'Show all my cards as a list' } },
        ],
      },
      { type: 'transactions', title: 'Card activity', query: { kind: 'card_spend', limit: 10 }, groupBy: 'day', variant: 'list', emptyText: 'No card payments yet' },
    ],
    entities: [],
  },
  'detail:transaction': {
    version: 1,
    blocks: [{ type: 'transaction', transactionId: '$id', variant: 'detail' }],
    entities: [],
  },
  'detail:card': {
    version: 1,
    blocks: [
      { type: 'card', cardId: '$id', showActions: true, showDetails: true },
      { type: 'transactions', title: 'Recent', query: { cardId: '$id', limit: 5 }, groupBy: 'none', variant: 'compact', emptyText: 'Nothing here yet' },
    ],
    entities: [],
  },
  'detail:contact': {
    version: 1,
    blocks: [
      { type: 'contact', contactId: '$id', variant: 'profile' },
      { type: 'transactions', title: 'Between you', query: { contactId: '$id', limit: 6 }, groupBy: 'none', variant: 'compact', emptyText: 'No payments yet' },
    ],
    entities: [],
  },
  'detail:profile': {
    version: 1,
    blocks: [{ type: 'profile', variant: 'card' }],
    entities: [],
  },
  'detail:invoice': {
    version: 1,
    blocks: [{ type: 'invoice', invoiceId: '$id' }],
    entities: [],
  },
  'detail:dispute': {
    version: 1,
    blocks: [{ type: 'dispute', disputeId: '$id' }],
    entities: [],
  },
};

/** Business accounts land on a merchant dashboard; their DynoPay wallet is one sentence away. */
const BUSINESS_HOME: z.input<typeof uiSpecSchema> = {
  version: 1,
  blocks: [
    { type: 'merchant_overview' },
    {
      type: 'chips',
      items: [
        { label: 'Invoice', icon: 'receipt', action: { type: 'prefill', text: 'Invoice ' } },
        { label: 'Payment link', icon: 'paypal', action: { type: 'prefill', text: 'Payment link for ' } },
        { label: 'Disputes', icon: 'shield', action: { type: 'ask', prompt: 'Show my open disputes' } },
        { label: 'Wallet', icon: 'wallet', action: { type: 'ask', prompt: 'Show my DynoPay wallet balance and recent transfers' } },
      ],
    },
    { type: 'merchant_sales', title: 'Sales · last 30 days', days: 30, kind: 'bar' },
    { type: 'invoices', title: 'Invoices', limit: 5 },
    { type: 'paypal_transactions', title: 'PayPal activity', days: 30, limit: 10 },
  ],
  entities: [],
};

export function defaultLayout(slot: LayoutSlot, accountType: 'personal' | 'business' = 'personal'): UISpec {
  const spec = slot === 'home' && accountType === 'business' ? BUSINESS_HOME : DEFAULTS[slot];
  return uiSpecSchema.parse(structuredClone(spec));
}

/** Deep-replaces the "$id" placeholder in a detail template. */
export function bindTemplate<T>(spec: T, id: string): T {
  return JSON.parse(JSON.stringify(spec).replaceAll('"$id"', JSON.stringify(id))) as T;
}
