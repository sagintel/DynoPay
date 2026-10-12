import { Op } from 'sequelize';
import { Card, Contact, PlanCache, type User } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { designFingerprint, type Settings } from '../services/settings.js';
import type { ActionRunner, RunOutcome, TraceStep } from './runner.js';
import { sanitizeSpec, type Block, type UISpec } from './ui/schema.js';

/**
 * Plan cache: the agent's answer to a sentence (its tool calls + UI) is stored as a template,
 * so the same request — or, in "similar" mode, the same kind of request with new values — is
 * answered by replaying the plan with fresh data instead of calling the LLM.
 *
 *   "Send 50 to Sara for dinner"  →  send {amount} to {person} for {purpose}
 *   "send 120 to John for rent"   →  same template → replay with John / 120 / rent
 *
 * Bump CACHE_VERSION whenever the catalog, actions or prompts change shape.
 */
const CACHE_VERSION = 'v1';
const MAX_PLANS_PER_USER = 200;
const PLAN_TTL_MS = 14 * 86_400_000;

export type SlotKind = 'amount' | 'email' | 'person' | 'card' | 'purpose';
export type Slot = { kind: SlotKind; value: string };
export type Template = { key: string; slots: Slot[]; template: string };

const MONEY_VERBS = /^(send|pay|transfer|give|request|ask|split|invoice|bill|payment link|pay link|schedule|fund|move|top ?up|refund)\b/;
/** Follow-ups depend on conversation context, so they are never served from (or stored in) the cache. */
const CONTEXTUAL = /\b(this|that|these|those|it|them|again|instead|same|previous|above|now|more|less)\b/;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function isCacheable(prompt: string, focus?: unknown): boolean {
  return !focus && !CONTEXTUAL.test(prompt.toLowerCase());
}

/** Turns a sentence into a template + ordered slot values. */
export async function templatize(user: User, prompt: string, screen: string, settings: Settings, language = 'en'): Promise<Template> {
  let text = prompt.trim().toLowerCase().replace(/[!?.]+$/, '').replace(/\s+/g, ' ');
  const found: { slot: Slot; placeholder: string }[] = [];
  const take = (re: RegExp, kind: SlotKind) => {
    text = text.replace(re, (match) => {
      found.push({ slot: { kind, value: match.trim() }, placeholder: `{${kind}}` });
      return `\u0000${found.length - 1}\u0000`;
    });
  };

  // Purpose tail first ("… for dinner"), only for money sentences.
  if (MONEY_VERBS.test(text)) {
    const m = text.match(/\sfor\s+(.+)$/);
    if (m && !/^\d/.test(m[1]!)) {
      const start = text.length - m[1]!.length;
      found.push({ slot: { kind: 'purpose', value: m[1]! }, placeholder: '{purpose}' });
      text = `${text.slice(0, start)}\u0000${found.length - 1}\u0000`;
    }
  }
  take(/[^\s@\u0000]+@[^\s@\u0000]+\.[a-z]{2,}/g, 'email');
  take(/(?<![\w\u0000])[$€£]?\d{1,7}(?:[.,]\d{1,2})?(?![\w\u0000])/g, 'amount');

  const [contacts, cards] = await Promise.all([
    Contact.findAll({ where: { userId: user.id }, attributes: ['name'] }),
    Card.findAll({ where: { userId: user.id, status: { [Op.ne]: 'closed' } }, attributes: ['label'] }),
  ]);
  const cardLabels = cards.map((c) => c.label.toLowerCase()).filter((l) => l.length >= 3);
  for (const label of cardLabels.sort((a, b) => b.length - a.length)) take(new RegExp(`\\b${escape(label)}\\b`, 'g'), 'card');
  const names = new Set<string>();
  for (const c of contacts) {
    const full = c.name.toLowerCase();
    names.add(full);
    const first = full.split(/\s+/)[0]!;
    if (first.length >= 3) names.add(first);
  }
  for (const name of [...names].sort((a, b) => b.length - a.length)) take(new RegExp(`(?<![\\w@])@?${escape(name)}\\b`, 'g'), 'person');

  // Slots in reading order = order of their markers in the final text.
  const slots = [...text.matchAll(/\u0000(\d+)\u0000/g)].map((m) => found[Number(m[1])]!.slot);
  const template = text.replace(/\u0000(\d+)\u0000/g, (_, i) => found[Number(i)]!.placeholder);
  const key = [CACHE_VERSION, user.accountType, screen, language, designFingerprint(settings.design), template].join('|').slice(0, 400);
  return { key, slots, template };
}

// ─── Generalisation ────────────────────────────────────────────────────────

type Ref = { $slot: number } | { $obs: [number, string[]] } | { $tpl: string };
type Plan = { steps: { tool: string; input: unknown }[]; spec: unknown };

/** Values a later step / the UI may have copied from an observation (ids mostly). */
function indexObservation(outcome: RunOutcome, step: number, index: Map<string, [number, string[]]>) {
  const confirmId = outcome.status === 'needs_confirmation' ? outcome.pending.id : outcome.status === 'draft' ? outcome.draft.id : null;
  // A mode-independent alias: the same plan replays in preview (drafts) and commit (pending actions).
  if (confirmId && !index.has(confirmId)) index.set(confirmId, [step, ['confirmId']]);
  const walk = (v: unknown, path: string[]) => {
    if (typeof v === 'string' && v.length >= 6 && !index.has(v)) index.set(v, [step, path]);
    else if (Array.isArray(v)) v.slice(0, 50).forEach((x, i) => walk(x, [...path, String(i)]));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
  };
  if (outcome.status === 'done') walk(outcome.result, ['result']);
}

const amountPattern = (value: string) => {
  const n = value.replace(/^[$€£]/, '');
  return new RegExp(`(?<![\\d.,])${escape(n)}(?![\\d]|[.,]\\d)`, 'g');
};
const slotPattern = (s: Slot) => (s.kind === 'amount' ? amountPattern(s.value) : new RegExp(`\\b${escape(s.value.replace(/^@/, ''))}\\b`, 'gi'));
const numericSlot = (s: Slot) => (s.kind === 'amount' ? Number(s.value.replace(/^[$€£]/, '').replace(',', '.')) : NaN);

function generalize(value: unknown, slots: Slot[], obs: Map<string, [number, string[]]>, key = ''): unknown {
  if (typeof value === 'string') {
    const hit = obs.get(value);
    if (hit) return { $obs: hit } satisfies Ref;
    const exact = slots.findIndex((s) => s.value.replace(/^[$€£@]/, '').toLowerCase() === value.toLowerCase());
    if (exact >= 0) return { $slot: exact } satisfies Ref;
    let tpl = value;
    slots.forEach((s, i) => (tpl = tpl.replace(slotPattern(s), `{{${i}}}`)));
    return tpl === value ? value : ({ $tpl: tpl } satisfies Ref);
  }
  if (typeof value === 'number' && /amount|value|price/i.test(key)) {
    const i = slots.findIndex((s) => numericSlot(s) === value);
    if (i >= 0) return { $slot: i } satisfies Ref;
  }
  if (Array.isArray(value)) return value.map((v) => generalize(v, slots, obs, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, generalize(v, slots, obs, k)]));
  }
  return value;
}

/** True if any original slot value survives un-templated (e.g. "$50.00" rewritten by the model). */
function leaksSlots(value: unknown, slots: Slot[]): boolean {
  const text = JSON.stringify(value).toLowerCase();
  return slots.some((s) => {
    if (s.kind === 'amount') {
      const n = numericSlot(s);
      return Number.isFinite(n) && new RegExp(`(?<![\\d.])${escape(String(n))}(?:[.,]\\d+)?(?![\\d])`).test(text);
    }
    return text.includes(s.value.replace(/^@/, '').toLowerCase());
  });
}

const stripEntities = (spec: UISpec): Omit<UISpec, 'entities'> => {
  const { entities: _e, ...rest } = spec;
  return rest;
};

export function buildPlan(trace: TraceStep[], spec: UISpec, slots: Slot[]): { plan: Plan; exactOnly: boolean } {
  const obs = new Map<string, [number, string[]]>();
  const steps: Plan['steps'] = [];
  trace.forEach((t, i) => {
    steps.push({ tool: t.tool, input: generalize(t.input, slots, obs) });
    indexObservation(t.outcome, i, obs);
  });
  const genSpec = generalize(stripEntities(spec), slots, obs);
  const plan = { steps, spec: genSpec };
  // Plans whose text still embeds this sentence's values may only be reused for the identical sentence.
  const exactOnly = !slots.length ? false : leaksSlots(plan, slots);
  return { plan, exactOnly };
}

// ─── Replay ────────────────────────────────────────────────────────────────

function resolve(value: unknown, slots: Slot[], outcomes: RunOutcome[]): unknown {
  if (Array.isArray(value)) return value.map((v) => resolve(v, slots, outcomes));
  if (value && typeof value === 'object') {
    const ref = value as Partial<Record<'$slot' | '$obs' | '$tpl', unknown>>;
    if (typeof ref.$slot === 'number') {
      const s = slots[ref.$slot];
      if (!s) throw new Error('slot out of range');
      return s.kind === 'amount' ? numericSlot(s) : s.value.replace(/^@/, '');
    }
    if (Array.isArray(ref.$obs)) {
      const [step, path] = ref.$obs as [number, string[]];
      const o = outcomes[step] as unknown as Record<string, unknown>;
      const root = path[0] === 'confirmId'
        ? (outcomes[step]?.status === 'needs_confirmation' ? (outcomes[step] as Extract<RunOutcome, { status: 'needs_confirmation' }>).pending.id
          : outcomes[step]?.status === 'draft' ? (outcomes[step] as Extract<RunOutcome, { status: 'draft' }>).draft.id : undefined)
        : path.reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o);
      if (root === undefined) throw new Error('observation path missing');
      return root;
    }
    if (typeof ref.$tpl === 'string') {
      return ref.$tpl.replace(/\{\{(\d+)\}\}/g, (_, i) => {
        const s = slots[Number(i)];
        if (!s) throw new Error('slot out of range');
        return s.kind === 'amount' ? s.value.replace(/^[$€£]/, '') : s.value;
      });
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, slots, outcomes)]));
  }
  return value;
}

const ENTITY_KIND: Record<SlotKind, UISpec['entities'][number]['kind']> = { amount: 'amount', email: 'person', person: 'person', card: 'card', purpose: 'purpose' };

export async function replayPlan(plan: Plan, slots: Slot[], prompt: string, runner: ActionRunner): Promise<{ spec: UISpec; tools: string[] }> {
  const outcomes: RunOutcome[] = [];
  for (const step of plan.steps) outcomes.push(await runner.run(step.tool, resolve(step.input, slots, outcomes)));
  const { spec, issues } = sanitizeSpec(resolve(plan.spec, slots, outcomes));
  if (issues.length) throw new Error(`replayed spec invalid: ${issues[0]}`);
  const shown = new Set(
    spec.blocks.flatMap((b: Block) => (b.type === 'confirmation' ? [b.pendingId] : b.type === 'section' || b.type === 'row' ? b.children.flatMap((c) => (c.type === 'confirmation' ? [c.pendingId] : [])) : [])),
  );
  for (const id of runner.confirmableIds()) if (!shown.has(id)) spec.blocks.unshift({ type: 'confirmation', pendingId: id });
  const lower = prompt.toLowerCase();
  spec.entities = slots
    .map((s) => {
      const i = lower.indexOf(s.value.toLowerCase());
      return i < 0 ? null : { text: prompt.slice(i, i + s.value.length), kind: ENTITY_KIND[s.kind] };
    })
    .filter((e): e is NonNullable<typeof e> => !!e)
    .slice(0, 8);
  return { spec, tools: plan.steps.map((s) => s.tool) };
}

// ─── Storage ───────────────────────────────────────────────────────────────

export type CacheHit = { row: PlanCache; mode: 'exact' | 'similar' };
export type CacheLookup = { hit: CacheHit } | { refresh: PlanCache } | null;

/**
 * Finds a reusable plan. Once a plan has been served `maxReuse` times it is due for a refresh:
 * the caller asks the LLM again and storePlan() replaces it with hits reset to 0.
 */
export async function lookupPlan(user: User, t: Template, cacheMode: Settings['cacheMode'], maxReuse = 0): Promise<CacheLookup> {
  if (cacheMode === 'off') return null;
  const row = await PlanCache.findOne({ where: { userId: user.id, key: t.key } });
  if (!row) return null;
  if (row.lastUsedAt.getTime() < Date.now() - PLAN_TTL_MS) {
    await row.destroy();
    return null;
  }
  const same = row.slots.length === t.slots.length && row.slots.every((s, i) => s.kind === t.slots[i]!.kind && s.value.toLowerCase() === t.slots[i]!.value.toLowerCase());
  const usable = same || (cacheMode === 'similar' && !row.exactOnly);
  if (!usable) return null;
  if (maxReuse > 0 && row.hits >= maxReuse) return { refresh: row };
  return { hit: { row, mode: same ? 'exact' : 'similar' } };
}

export async function storePlan(user: User, t: Template, trace: TraceStep[], spec: UISpec, tokens: number): Promise<void> {
  if (trace.some((s) => s.outcome === undefined)) return;
  try {
    const { plan, exactOnly } = buildPlan(trace, spec, t.slots);
    // A fresh plan (first one, or a refresh after maxReuse) starts its reuse count at 0.
    const values = { slots: t.slots, plan: plan as unknown as Record<string, unknown>, exactOnly, tokens, hits: 0, lastUsedAt: new Date() };
    const existing = await PlanCache.findOne({ where: { userId: user.id, key: t.key } });
    if (existing) await existing.update(values);
    else await PlanCache.create({ userId: user.id, key: t.key, ...values });
    const count = await PlanCache.count({ where: { userId: user.id } });
    if (count > MAX_PLANS_PER_USER) {
      const old = await PlanCache.findAll({ where: { userId: user.id }, order: [['lastUsedAt', 'ASC']], limit: count - MAX_PLANS_PER_USER, attributes: ['id'] });
      await PlanCache.destroy({ where: { id: old.map((o) => o.id) } });
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'plan not cached');
  }
}

export async function markHit(row: PlanCache) {
  await PlanCache.update({ hits: row.hits + 1, lastUsedAt: new Date() }, { where: { id: row.id } });
}

export async function forgetPlan(row: PlanCache) {
  await row.destroy().catch(() => undefined);
}

export async function clearPlans(user: User) {
  return { cleared: await PlanCache.destroy({ where: { userId: user.id } }) };
}

export async function cacheStats(user: User) {
  const rows = await PlanCache.findAll({ where: { userId: user.id }, attributes: ['hits', 'tokens', 'exactOnly'] });
  return { plans: rows.length, reusable: rows.filter((r) => !r.exactOnly).length, hits: rows.reduce((s, r) => s + r.hits, 0) };
}
