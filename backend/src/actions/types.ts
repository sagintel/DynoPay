import type { z } from 'zod';
import type { User } from '../db/index.js';

/**
 * Risk levels:
 *  - read:    returns data, runs freely (no human in the loop): balances, details, lists, insights.
 *  - auto:    a low-risk change (freeze, rename, save a layout…). Declared for readability only:
 *             define() turns it into a confirm action with a simple tap, so EVERY change still needs
 *             the user's explicit validation.
 *  - confirm: moves money / is irreversible / contacts a third party. Calling it only creates a pending
 *             action + preview. Execution requires the user to press the confirmation button
 *             (the server re-validates at that moment).
 */
export type Risk = 'read' | 'auto' | 'confirm';

/** Who may use an action: everyone, or only business accounts with connected PayPal REST credentials. */
export type Audience = 'all' | 'merchant';

export type ConfirmSummary = {
  title: string;
  amount?: number;
  currency?: string;
  recipient?: { name: string; initials: string; subtitle: string; verified: boolean };
  lines: { label: string; value: string }[];
  confirmLabel: string;
  style: 'hold' | 'tap';
  tone: 'default' | 'danger';
  biometric: boolean;
};

/** Request-scoped info available when a confirmed action executes. */
export type ExecuteContext = {
  appReturnUrl?: string;
  /** Stable per pending action: used as PayPal-Request-Id so retries never duplicate. */
  requestId: string;
};

export type ActionDef<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  risk: Risk;
  audience?: Audience;
  /** Merchant capability (granted by the merchant's PayPal app) required to use it at all. */
  capability?: string;
  input: S;
  /** For read/auto actions. */
  run?: (user: User, input: z.infer<S>) => Promise<unknown>;
  /** For auto actions: a readable preview for the tap confirmation (title, lines…). */
  summary?: (user: User, input: z.infer<S>) => Promise<Partial<ConfirmSummary>> | Partial<ConfirmSummary>;
  /** For confirm actions: validate everything and describe what will happen. Must not change state. */
  preview?: (user: User, input: z.infer<S>) => Promise<ConfirmSummary>;
  /** For confirm actions: performed only after explicit user confirmation. */
  execute?: (user: User, input: z.infer<S>, ctx: ExecuteContext) => Promise<Record<string, unknown>>;
};

const humanize = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');

/** Default preview for low-risk changes: the action name plus its non-id inputs. */
export function tapSummary(name: string, input: Record<string, unknown>): ConfirmSummary {
  const lines = Object.entries(input ?? {})
    .filter(([k, v]) => v !== undefined && v !== null && typeof v !== 'object' && !/id$/i.test(k))
    .slice(0, 6)
    .map(([k, v]) => ({ label: humanize(k.replace(/([A-Z])/g, '_$1').toLowerCase()), value: String(v) }));
  return { title: humanize(name), lines, confirmLabel: humanize(name), style: 'tap', tone: 'default', biometric: false };
}

/**
 * Declares an action. Every non-read action ends up confirm-level: "auto" actions keep their
 * run() as the execution step behind a one-tap confirmation.
 */
export const define = <S extends z.ZodType>(def: ActionDef<S>): ActionDef => {
  if (def.risk !== 'auto') return def as unknown as ActionDef;
  const { run, summary, ...rest } = def;
  if (!run) throw new Error(`auto action ${def.name} needs run()`);
  const converted: ActionDef<S> = {
    ...rest,
    risk: 'confirm',
    preview: async (u, i) => ({ ...tapSummary(def.name, i as Record<string, unknown>), ...((await summary?.(u, i)) ?? {}) }),
    execute: async (u, i) => {
      const result = await run(u, i);
      return result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : { result };
    },
  };
  return converted as unknown as ActionDef;
};
