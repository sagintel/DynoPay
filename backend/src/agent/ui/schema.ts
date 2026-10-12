import { z } from 'zod';
import { txQuerySchema } from '../../services/transactions.js';
import { spendingQuerySchema } from '../../services/insights.js';

/**
 * The generative-UI contract.
 *
 * The agent never writes UI code: it composes these blocks (all pre-built and
 * styled in the app), wires their actions, and the server hydrates every data
 * block from the database. Numbers shown in data blocks therefore always come
 * from real records, never from the model.
 */

export const LAYOUT_SLOTS = ['home', 'cards', 'detail:transaction', 'detail:card', 'detail:contact', 'detail:profile', 'detail:invoice', 'detail:dispute'] as const;
export type LayoutSlot = (typeof LAYOUT_SLOTS)[number];
export const layoutSlotSchema = z.enum(LAYOUT_SLOTS);

const short = (max: number) => z.string().trim().min(1).max(max);
const tone = z.enum(['default', 'muted', 'accent', 'positive', 'negative']);
/** Every chart form the app can render. Time-series and categorical data accept different subsets. */
export const CHART_KINDS = ['bar', 'hbar', 'line', 'area', 'sparkline', 'donut', 'pie', 'progress', 'gauge', 'heatmap', 'stacked', 'grouped'] as const;
export const SALES_CHART_KINDS = ['bar', 'line', 'area', 'sparkline', 'heatmap'] as const;

export const ICONS = [
  'send', 'plus', 'split', 'card', 'chart', 'arrow-up', 'arrow-down', 'arrow-right', 'lock', 'unlock', 'trash', 'edit', 'check',
  'close', 'user', 'users', 'calendar', 'repeat', 'wallet', 'paypal', 'shield', 'info', 'warning', 'search', 'settings', 'star', 'sparkle', 'receipt', 'bolt',
] as const;
const icon = z.enum(ICONS);

// ─── Actions ───────────────────────────────────────────────────────────────

const runAction = z.object({
  type: z.literal('run'),
  action: short(40).describe('Name of an action from the action registry'),
  input: z.record(z.string(), z.unknown()).default({}).describe('Action input. Use "$field.<name>" to reference a dialog field value'),
});
const confirmAction = z.object({ type: z.literal('confirm'), pendingId: short(64) });
const openAction = z.object({
  type: z.literal('open'),
  kind: z.enum(['transaction', 'card', 'contact', 'profile', 'invoice', 'dispute']),
  id: z.string().max(64).optional(),
});
const askAction = z.object({ type: z.literal('ask'), prompt: short(300) });
const prefillAction = z.object({ type: z.literal('prefill'), text: z.string().max(200) });
const navigateAction = z.object({ type: z.literal('navigate'), screen: z.enum(['home', 'cards', 'settings']) });
const openUrlAction = z.object({ type: z.literal('open_url'), url: z.string().url().max(2000) });
const resetViewAction = z.object({ type: z.literal('reset_view') });
const closeAction = z.object({ type: z.literal('close') });
const pinAction = z.object({ type: z.literal('pin'), slot: z.enum(['home', 'cards']) });

const leafActions = [runAction, confirmAction, openAction, askAction, prefillAction, navigateAction, openUrlAction, resetViewAction, closeAction, pinAction] as const;
export const leafActionSchema = z.discriminatedUnion('type', [...leafActions]);

// ─── Blocks (factory so dialogs can reuse them without infinite recursion) ─

function makeBlocks<A extends z.ZodType>(action: A) {
  const button = z.object({
    label: short(40),
    icon: icon.optional(),
    variant: z.enum(['primary', 'secondary', 'ghost', 'danger']).default('secondary'),
    action,
  });

  const blocks = z.discriminatedUnion('type', [
    // Generic primitives
    z.object({
      type: z.literal('text'),
      text: short(400),
      variant: z.enum(['display', 'title', 'heading', 'body', 'caption', 'label']).default('body'),
      tone: tone.default('default'),
      align: z.enum(['left', 'center']).default('left'),
    }),
    z.object({
      type: z.literal('amount'),
      value: z.number(),
      currency: z.string().length(3).optional(),
      caption: z.string().max(120).optional(),
      size: z.enum(['xl', 'lg', 'md']).default('xl'),
      tone: tone.default('default'),
    }),
    z.object({
      type: z.literal('key_values'),
      rows: z.array(z.object({ label: short(40), value: short(120), tone: tone.optional(), action: action.optional() })).min(1).max(12),
    }),
    z.object({ type: z.literal('button'), ...button.shape, fullWidth: z.boolean().default(true) }),
    z.object({ type: z.literal('buttons'), items: z.array(button).min(1).max(4), layout: z.enum(['row', 'column']).default('row') }),
    z.object({
      type: z.literal('chips'),
      items: z.array(z.object({ label: short(24), icon: icon.optional(), action })).min(1).max(8),
    }),
    z.object({
      type: z.literal('notice'),
      tone: z.enum(['info', 'success', 'warning', 'error']).default('info'),
      title: z.string().max(80).optional(),
      text: short(300),
    }),
    z.object({
      type: z.literal('stat_grid'),
      items: z.array(z.object({ label: short(30), value: short(30), caption: z.string().max(40).optional(), tone: tone.optional() })).min(1).max(6),
    }),
    z.object({ type: z.literal('empty'), title: short(60), text: z.string().max(200).optional(), icon: icon.optional() }),
    z.object({ type: z.literal('divider') }),
    z.object({ type: z.literal('spacer'), size: z.enum(['sm', 'md', 'lg']).default('md') }),

    // Data-bound blocks (hydrated server-side)
    z.object({ type: z.literal('balance'), variant: z.enum(['arc', 'compact', 'minimal']).default('arc') }),
    z.object({
      type: z.literal('transactions'),
      title: z.string().max(60).optional(),
      query: txQuerySchema.partial().default({}),
      groupBy: z.enum(['day', 'none', 'category', 'counterparty']).default('day'),
      variant: z.enum(['list', 'compact']).default('list'),
      highlightId: z.string().max(64).optional(),
      emptyText: z.string().max(120).optional(),
    }),
    z.object({
      type: z.literal('contacts'),
      title: z.string().max(60).optional(),
      variant: z.enum(['avatars', 'list']).default('avatars'),
      search: z.string().max(60).optional(),
      limit: z.number().int().min(1).max(30).default(8),
      showNew: z.boolean().default(true),
      onSelect: z.enum(['open', 'prefill_send']).default('prefill_send'),
    }),
    z.object({
      type: z.literal('chart'),
      title: z.string().max(60).optional(),
      kind: z.enum(CHART_KINDS).default('bar'),
      query: spendingQuerySchema.partial().default({}),
    }),
    z.object({ type: z.literal('cards'), variant: z.enum(['carousel', 'stack', 'list']).default('carousel'), showActions: z.boolean().default(true) }),
    z.object({ type: z.literal('card'), cardId: short(64), showActions: z.boolean().default(true), showDetails: z.boolean().default(true) }),
    z.object({ type: z.literal('transaction'), transactionId: short(64), variant: z.enum(['receipt', 'detail']).default('detail') }),
    z.object({ type: z.literal('contact'), contactId: short(64), variant: z.enum(['profile', 'compact']).default('profile') }),
    z.object({ type: z.literal('profile'), variant: z.enum(['card', 'compact']).default('card') }),
    z.object({ type: z.literal('schedules'), title: z.string().max(60).optional(), limit: z.number().int().min(1).max(20).default(5) }),
    z.object({ type: z.literal('requests'), title: z.string().max(60).optional(), perspective: z.enum(['incoming', 'outgoing', 'all']).default('all') }),
    // Choose the target first (recipient, card, item to delete…), then the action is confirmed.
    z.object({
      type: z.literal('picker'),
      kind: z.enum(['contact', 'card', 'schedule', 'request']),
      title: z.string().max(80).optional(),
      search: z.string().max(80).optional().describe('Narrows contacts; an email also offers a new PayPal recipient'),
      preselect: z.string().max(80).optional().describe('Item id to highlight (the user still picks)'),
      action: short(40).describe('Confirm-level registry action run with the chosen item'),
      input: z.record(z.string(), z.unknown()).default({}).describe('Action input without the target (added from the chosen item)'),
    }),
    z.object({
      type: z.literal('confirmation'),
      pendingId: short(64),
      /** Attached by the server for previews ("draft_…" ids) so the block can be re-hydrated statelessly. */
      draft: z.object({ action: short(40), input: z.record(z.string(), z.unknown()) }).optional(),
    }),

    // Merchant data blocks (business accounts; hydrated from the merchant's PayPal account)
    z.object({ type: z.literal('merchant_overview') }),
    z.object({ type: z.literal('merchant_sales'), title: z.string().max(60).optional(), days: z.number().int().min(1).max(90).default(30), kind: z.enum(SALES_CHART_KINDS).default('bar') }),
    z.object({
      type: z.literal('paypal_transactions'),
      title: z.string().max(60).optional(),
      days: z.number().int().min(1).max(90).default(30),
      limit: z.number().int().min(1).max(50).default(10),
      search: z.string().max(80).optional(),
      direction: z.enum(['in', 'out']).optional(),
    }),
    z.object({ type: z.literal('invoices'), title: z.string().max(60).optional(), status: z.string().max(24).optional(), limit: z.number().int().min(1).max(30).default(10) }),
    z.object({ type: z.literal('invoice'), invoiceId: short(64) }),
    z.object({ type: z.literal('disputes'), title: z.string().max(60).optional(), status: z.string().max(40).optional() }),
    z.object({ type: z.literal('dispute'), disputeId: short(64) }),
    z.object({ type: z.literal('catalog'), kind: z.enum(['products', 'plans']).default('plans') }),
  ]);

  return { button, blocks };
}

const basic = makeBlocks(leafActionSchema);

export const fieldSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][\w]{0,31}$/),
  label: short(40),
  kind: z.enum(['text', 'number', 'amount', 'email', 'toggle', 'select']).default('text'),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  placeholder: z.string().max(60).optional(),
  options: z.array(z.object({ label: short(40), value: short(40) })).max(10).optional(),
  required: z.boolean().default(false),
});

/** The single, generic dialog used for details, edits, deletions, info, etc. */
export const dialogSchema = z.object({
  title: short(60),
  message: z.string().max(400).optional(),
  icon: icon.optional(),
  tone: z.enum(['default', 'danger', 'success']).default('default'),
  blocks: z.array(basic.blocks).max(16).default([]),
  fields: z.array(fieldSchema).max(6).default([]),
  buttons: z.array(basic.button).max(3).default([]),
});

export const actionSchema = z.union([leafActionSchema, z.object({ type: z.literal('dialog'), dialog: dialogSchema })]);

const full = makeBlocks(actionSchema);
export const leafBlockSchema = full.blocks;

export const blockSchema = z.union([
  leafBlockSchema,
  z.object({
    type: z.literal('section'),
    title: z.string().max(60).optional(),
    subtitle: z.string().max(120).optional(),
    trailing: z.object({ label: short(24), action: actionSchema }).optional(),
    style: z.enum(['plain', 'card']).default('plain'),
    children: z.array(leafBlockSchema).min(1).max(12),
  }),
  z.object({
    type: z.literal('row'),
    children: z.array(leafBlockSchema).min(1).max(3),
  }),
]);

export const REJECTION_CODES = ['manipulation', 'invalid_recipient', 'unclear', 'invalid_amount', 'insufficient_funds', 'limit_exceeded', 'not_allowed', 'not_found', 'cannot_fulfill'] as const;
export const rejectionSchema = z.object({ code: z.enum(REJECTION_CODES), message: short(300) });

export const entitySchema = z.object({
  text: short(60),
  kind: z.enum(['amount', 'person', 'purpose', 'card', 'date', 'other']),
});

export const uiSpecSchema = z.object({
  version: z.literal(1).default(1),
  title: z.string().max(60).optional(),
  /** One short sentence shown under the prompt bar. */
  say: z.string().max(240).optional(),
  blocks: z.array(blockSchema).max(24).default([]),
  /** Dialog to open immediately (e.g. a detail view or a delete confirmation). */
  dialog: dialogSchema.optional(),
  /** Spans of the user's sentence to highlight in the prompt bar. */
  entities: z.array(entitySchema).max(8).default([]),
  /** The request can't be fulfilled (shown under a red prompt bar; nothing runs). */
  rejection: rejectionSchema.optional(),
  /** Language of the texts in this spec (BCP-47 base code). */
  language: z.string().max(5).optional(),
});

export type Action = z.infer<typeof actionSchema>;
export type LeafBlock = z.infer<typeof leafBlockSchema>;
export type Block = z.infer<typeof blockSchema>;
export type Dialog = z.infer<typeof dialogSchema>;
export type UISpec = z.infer<typeof uiSpecSchema>;

export const DATA_BLOCK_TYPES = [
  'balance', 'transactions', 'contacts', 'chart', 'cards', 'card', 'transaction', 'contact', 'profile', 'schedules', 'requests', 'confirmation',
  'merchant_overview', 'merchant_sales', 'paypal_transactions', 'invoices', 'invoice', 'disputes', 'dispute', 'catalog',
] as const;
export const MERCHANT_BLOCK_TYPES = ['merchant_overview', 'merchant_sales', 'paypal_transactions', 'invoices', 'invoice', 'disputes', 'dispute', 'catalog'] as const;

/**
 * Lenient validation for model output: keeps every valid block, drops invalid
 * ones and reports precise issues so the ReAct loop can ask the model to repair.
 */
export function sanitizeSpec(raw: unknown): { spec: UISpec; issues: string[] } {
  const issues: string[] = [];
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawBlocks = Array.isArray(obj.blocks) ? obj.blocks : [];

  const blocks: Block[] = [];
  rawBlocks.slice(0, 24).forEach((b, i) => {
    const r = blockSchema.safeParse(b);
    if (r.success) {
      blocks.push(r.data);
      return;
    }
    // Sections: salvage valid children rather than losing the whole section.
    if (b && typeof b === 'object' && (b as { type?: string }).type === 'section' && Array.isArray((b as { children?: unknown[] }).children)) {
      const kids = (b as { children: unknown[] }).children.map((c) => leafBlockSchema.safeParse(c)).filter((c) => c.success).map((c) => c.data!);
      const salvaged = blockSchema.safeParse({ ...(b as object), children: kids });
      if (kids.length && salvaged.success) {
        blocks.push(salvaged.data);
        issues.push(`blocks[${i}] (section): some children were invalid and dropped`);
        return;
      }
    }
    const type = (b as { type?: string })?.type ?? 'unknown';
    issues.push(`blocks[${i}] (${type}): ${r.error.issues.slice(0, 3).map((x) => `${x.path.join('.') || '(root)'} ${x.message}`).join('; ')}`);
  });

  let dialog: Dialog | undefined;
  if (obj.dialog !== undefined) {
    const d = dialogSchema.safeParse(obj.dialog);
    if (d.success) dialog = d.data;
    else issues.push(`dialog: ${d.error.issues.slice(0, 3).map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`);
  }

  const entities = z.array(entitySchema).max(8).safeParse(obj.entities ?? []);
  const spec: UISpec = {
    version: 1,
    title: typeof obj.title === 'string' ? obj.title.slice(0, 60) : undefined,
    say: typeof obj.say === 'string' ? obj.say.slice(0, 240) : undefined,
    blocks,
    dialog,
    entities: entities.success ? entities.data : [],
    rejection: rejectionSchema.safeParse(obj.rejection).data,
  };
  return { spec, issues };
}
