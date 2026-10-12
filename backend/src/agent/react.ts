import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import { env } from '../config/env.js';
import type { User } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { allowedActions } from '../actions/registry.js';
import { observationFor, type ActionRunner } from './runner.js';
import { buildSystemPrompt } from './manifest.js';
import { sanitizeSpec, type Block, type UISpec } from './ui/schema.js';

export type AgentEvent =
  | { type: 'step'; index: number; label: string; tool?: string }
  | { type: 'observation'; index: number; tool: string; ok: boolean };

export type ReactStep = { thought?: string; tool?: string; input?: unknown; ok?: boolean; error?: string };

export type AgentContext = {
  screen: 'home' | 'cards' | 'settings';
  /** preview = the user is still typing (partial sentence, drafts only). */
  mode?: 'preview' | 'commit';
  /** The user's design preferences/brief (already bounded and cleaned). */
  design?: string | null;
  /** Short description of what is currently on screen, e.g. block types + titles. */
  currentView?: string;
  /** Entity the user is looking at (opened dialog), if any. */
  focus?: { kind: string; id: string };
  history: { role: 'user' | 'assistant'; content: string }[];
  /** The real account facts (balance, limits, contacts, cards, merchant capabilities). */
  account?: Record<string, unknown>;
  /** Language the user wrote in (write `say`, titles and labels in it). */
  language?: { code: string; name: string } | null;
};

const LABELS: Record<string, string> = {
  get_profile: 'Reading your profile',
  get_balance: 'Checking your balance',
  list_transactions: 'Looking through transactions',
  get_transaction: 'Opening the transaction',
  spending_summary: 'Adding up your spending',
  list_contacts: 'Finding people',
  get_contact: 'Opening the contact',
  find_recipient: 'Finding the recipient',
  list_cards: 'Checking your cards',
  get_card: 'Opening the card',
  list_schedules: 'Checking scheduled payments',
  list_requests: 'Checking requests',
  send_money: 'Preparing the transfer',
  top_up: 'Preparing the top-up',
  create_card: 'Preparing your new card',
  fund_card: 'Preparing the card top-up',
  save_layout: 'Saving your layout',
};
export const labelFor = (tool: string) => LABELS[tool] ?? `Running ${tool.replace(/_/g, ' ')}`;

/** Extracts the first top-level JSON object from a model reply (tolerates fences/prose). */
export function parseJsonLoose(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        const v = JSON.parse(cleaned.slice(start, i + 1));
        return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function contentText(msg: BaseMessage): string {
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : 'text' in p && typeof p.text === 'string' ? p.text : '')).join('');
  return '';
}

const MAX_OBSERVATION = 6000;
function observation(value: unknown): string {
  const json = JSON.stringify(value);
  return json.length > MAX_OBSERVATION ? `${json.slice(0, MAX_OBSERVATION)}…(truncated; narrow your query)` : json;
}

function contextMessage(user: User, ctx: AgentContext, prompt: string): string {
  return [
    `CONTEXT ${JSON.stringify({
      now: new Date().toISOString(),
      user: { firstName: user.name.split(/\s+/)[0], currency: user.currency, handle: user.handle },
      screen: ctx.screen,
      currentView: ctx.currentView ?? null,
      focus: ctx.focus ?? null,
      mode: ctx.mode ?? 'commit',
    })}`,
    ...(ctx.account
      ? [`ACCOUNT (facts; never exceed them: amounts above balance/limits, unknown recipients, missing cards or capabilities → final with "rejection"):
${JSON.stringify(ctx.account)}`]
      : []),
    ...(ctx.language && ctx.language.code !== 'en'
      ? [`LANGUAGE: the user writes in ${ctx.language.name} (${ctx.language.code}). Understand it fully; write say/titles/labels/dialog texts in that language; keep action names and inputs in English. Set "language":"${ctx.language.code}".`]
      : []),
    // Preferences live in the user message (not the system prompt) so the large system prefix stays
    // identical across users and requests, which lets providers cache it.
    ...(ctx.design ? [`DESIGN PREFERENCES (the user's taste; apply within the catalog and every rule above, never beyond):\n${ctx.design}`] : []),
    ...(ctx.mode === 'preview'
      ? ['PREVIEW: the sentence may be unfinished. Show only what is already clear (e.g. just the amount). If nothing is clear yet, return {"final":{"blocks":[]}}. Use at most 2 actions.']
      : []),
    `REQUEST ${JSON.stringify(prompt)}`,
  ].join('\n');
}

export type TokenUsage = { input: number; output: number; calls: number };

function addUsage(total: TokenUsage, reply: BaseMessage) {
  const u = (reply as { usage_metadata?: { input_tokens?: number; output_tokens?: number } }).usage_metadata;
  total.calls++;
  total.input += u?.input_tokens ?? 0;
  total.output += u?.output_tokens ?? 0;
}

function collectPendingIds(blocks: Block[]): Set<string> {
  const ids = new Set<string>();
  for (const b of blocks) {
    if (b.type === 'confirmation') ids.add(b.pendingId);
    if (b.type === 'section' || b.type === 'row') for (const c of b.children) if (c.type === 'confirmation') ids.add(c.pendingId);
  }
  return ids;
}

export type ReactResult = { spec: UISpec; steps: ReactStep[]; pendingIds: string[]; usage?: TokenUsage };

/**
 * The ReAct loop: Thought → Action (one registry action) → Observation, until the
 * model returns a final UI spec. All actions go through performAction, so the
 * confirm-level guard applies to the agent exactly like to any other caller.
 */
export async function runReact(opts: {
  model: BaseChatModel;
  user: User;
  prompt: string;
  context: AgentContext;
  runner: ActionRunner;
  maxSteps?: number;
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
}): Promise<ReactResult> {
  const { model, user, prompt, context, onEvent, signal, runner } = opts;
  const preview = context.mode === 'preview';
  const usage: TokenUsage = { input: 0, output: 0, calls: 0 };
  // Only the actions this user is authorized for are described to the model AND accepted from it.
  const tools = await allowedActions(user);
  const messages: BaseMessage[] = [new SystemMessage(buildSystemPrompt(user, tools))];
  for (const turn of context.history.slice(-6)) {
    messages.push(turn.role === 'user' ? new HumanMessage(turn.content) : new AIMessage(turn.content));
  }
  messages.push(new HumanMessage(contextMessage(user, context, prompt)));

  const allowed = new Set(tools.map((a) => a.name));
  const steps: ReactStep[] = [];
  let repairs = 0;
  let invalid = 0;
  const maxSteps = opts.maxSteps ?? env.AGENT_MAX_STEPS;

  for (let i = 0; i < maxSteps; i++) {
    if (signal?.aborted) throw new AppError('bad_request', 'Request cancelled', { usage });
    const reply = await model.invoke(messages, { signal });
    addUsage(usage, reply);
    const text = contentText(reply);
    const parsed = parseJsonLoose(text);
    messages.push(new AIMessage(text || '{}'));

    if (!parsed) {
      if (++invalid > 2) break;
      messages.push(new HumanMessage('Observation: {"error":"Reply was not a single JSON object. Follow the REACT PROTOCOL exactly."}'));
      continue;
    }
    const thought = typeof parsed.thought === 'string' ? parsed.thought.slice(0, 300) : undefined;

    // ── Act ───────────────────────────────────────────────────────────────
    const action = parsed.action as { name?: unknown; input?: unknown } | undefined;
    if (action && typeof action.name === 'string' && !parsed.final) {
      const name = action.name;
      onEvent?.({ type: 'step', index: i, label: labelFor(name), tool: name });
      let obs: unknown;
      let ok = true;
      if (!allowed.has(name)) {
        ok = false;
        obs = { error: `Unknown action "${name}". Use one of the BACKEND ACTIONS.` };
      } else {
        try {
          obs = observationFor(await runner.run(name, action.input ?? {}));
        } catch (err) {
          ok = false;
          obs = err instanceof AppError ? { error: err.message, code: err.code, details: err.details } : { error: 'Action failed unexpectedly' };
          if (!(err instanceof AppError)) logger.error({ err, tool: name }, 'agent tool crashed');
        }
      }
      steps.push({ thought, tool: name, input: action.input, ok, error: ok ? undefined : (obs as { error: string }).error });
      onEvent?.({ type: 'observation', index: i, tool: name, ok });
      messages.push(new HumanMessage(`Observation: ${observation(obs)}`));
      continue;
    }

    // ── Final answer ──────────────────────────────────────────────────────
    if (parsed.final) {
      const { spec, issues } = sanitizeSpec(parsed.final);
      const referenced = collectPendingIds(spec.blocks);
      const missing = runner.confirmableIds().filter((id) => !referenced.has(id));
      // An empty preview is a valid answer ("nothing clear yet"); an empty committed answer is not.
      if ((issues.length || (!preview && !spec.blocks.length && !spec.dialog)) && repairs < 1) {
        repairs++;
        messages.push(
          new HumanMessage(`Observation: {"error":"UI spec invalid","issues":${JSON.stringify(issues.length ? issues : ['blocks is empty'])}}. Return a corrected final.`),
        );
        continue;
      }
      // Safety net: a pending action created in this run is always shown for confirmation.
      for (const id of missing) spec.blocks.unshift({ type: 'confirmation', pendingId: id });
      steps.push({ thought });
      return { spec, steps, pendingIds: runner.confirmableIds(), usage };
    }

    if (++invalid > 2) break;
    messages.push(new HumanMessage('Observation: {"error":"Reply needs either \\"action\\" or \\"final\\"."}'));
  }

  throw new AppError('upstream_error', 'The assistant could not finish this request', { steps, pendingIds: runner.confirmableIds(), usage });
}
