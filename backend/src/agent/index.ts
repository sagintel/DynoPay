import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { env } from '../config/env.js';
import { Conversation, LastView, type ChatTurn, type User } from '../db/index.js';
import { AppError, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getLayout } from '../services/layouts.js';
import { detectAnyLanguage, LANGUAGE_NAMES, toEnglishForRules } from '../services/i18n.js';
import { designBriefForAgent, resolveSettings, type Settings } from '../services/settings.js';
import { accountSnapshot, checkRequest, snapshotForAgent, type Rejection } from './guard.js';
import { translateSpec } from './translate.js';
import { understand, type Intent } from './intent.js';
import { isCacheable, lookupPlan, markHit, replayPlan, storePlan, templatize, type Template } from './cache.js';
import { createChatModel, pickProvider, type Provider } from './llm.js';
import { runOffline } from './offline.js';
import { runReact, type AgentContext, type AgentEvent, type ReactResult, type TokenUsage } from './react.js';
import { ActionRunner, type AgentMode } from './runner.js';
import { averageTokensPerRun, recordUsage } from './usage.js';
import { bindTemplate } from './ui/defaults.js';
import { hydrateSpec, type HydratedSpec } from './ui/hydrate.js';
import type { Block, LayoutSlot, UISpec } from './ui/schema.js';

export type AgentRequest = {
  prompt: string;
  screen: AgentContext['screen'];
  /** preview: as-you-type (no side effects). commit: the user submitted. */
  mode?: AgentMode;
  currentView?: string;
  focus?: AgentContext['focus'];
  conversationId?: string;
  /** false for sentences the app itself sent (chips, buttons): use the user's language, don't detect it. */
  detectLanguage?: boolean;
};

export type Engine = 'cache' | 'offline' | 'llm' | 'guard' | 'none';

export type AgentResponse = {
  conversationId: string | null;
  mode: AgentMode;
  provider: Provider;
  /** Which engine produced the UI: cache replay, on-device rules, the LLM, or nothing yet. */
  engine: Engine;
  cache?: 'exact' | 'similar';
  fallback: boolean;
  spec: HydratedSpec;
  steps: ReactResult['steps'];
  usage: TokenUsage;
  /** Language of the texts in `spec` (the app switches its UI to it when auto-language is on). */
  language: string;
  /** Set when the request can't be fulfilled: the prompt bar turns red and shows the message. */
  rejection: Rejection | null;
  /** The main elements understood from the sentence (shown as chips while typing). */
  intent: Intent;
};

export type AgentDeps = { modelFactory?: (provider: Exclude<Provider, 'offline'>) => BaseChatModel; provider?: Provider };

const MAX_TURNS = 12;
const PREVIEW_MAX_STEPS = 4;
const NO_USAGE: TokenUsage = { input: 0, output: 0, calls: 0 };

/** A compact memory of what was shown, so follow-ups like "now as a chart" work. */
function describe(spec: UISpec): string {
  const parts = spec.blocks.map((b) => {
    if (b.type === 'transactions') return `transactions(${JSON.stringify(b.query)})`;
    if (b.type === 'chart') return `chart(${b.kind},${JSON.stringify(b.query)})`;
    if (b.type === 'confirmation') return `confirmation(${b.pendingId})`;
    if ('cardId' in b) return `${b.type}(${b.cardId})`;
    return b.type;
  });
  return JSON.stringify({ say: spec.say ?? null, shown: parts });
}

/** Drafts carry their action+input in the block so any later re-hydration recomputes them (stateless). */
function attachDrafts(spec: UISpec, runner: ActionRunner): UISpec {
  if (!runner.drafts.size) return spec;
  const attach = (b: Block): Block => {
    if (b.type === 'confirmation') {
      const d = runner.drafts.get(b.pendingId);
      return d ? { ...b, draft: { action: d.action, input: d.input } } : b;
    }
    if (b.type === 'section' || b.type === 'row') return { ...b, children: b.children.map((c) => attach(c) as typeof c) } as Block;
    return b;
  };
  return { ...spec, blocks: spec.blocks.map(attach) };
}

/** Blocks that help after a rejection (who to pay, what is available…). Never an action by themselves. */
function helpFor(r: Rejection, prompt: string): Block[] {
  if (r.code === 'insufficient_funds' || r.code === 'limit_exceeded') return [{ type: 'balance', variant: 'compact' }];
  if ((r.code === 'invalid_recipient' || r.code === 'unclear') && /^(send|pay|transfer|give)\b/i.test(prompt)) {
    const amount = Number(prompt.match(/(\d{1,9}(?:[.,]\d{1,2})?)/)?.[1]?.replace(',', '.'));
    return [{ type: 'picker', kind: 'contact', action: 'send_money', input: amount > 0 ? { amount } : {} }];
  }
  return [];
}

/** A spec whose only content is an error notice is a request that can't be fulfilled. */
function extractRejection(spec: UISpec): { spec: UISpec; rejection: Rejection | null } {
  // A rejected request never carries something to confirm, even if the model prepared one.
  if (spec.rejection) return { spec: { ...spec, blocks: spec.blocks.filter((b) => b.type !== 'confirmation') }, rejection: spec.rejection as Rejection };
  const isError = (b: Block) => b.type === 'notice' && b.tone === 'error';
  const errors = spec.blocks.filter(isError);
  const other = spec.blocks.filter((b) => !isError(b));
  if (!errors.length || other.some((b) => b.type === 'confirmation' || b.type === 'picker')) return { spec, rejection: null };
  const first = errors[0] as Extract<Block, { type: 'notice' }>;
  const rejection: Rejection = { code: 'cannot_fulfill', message: first.text };
  return { spec: { ...spec, blocks: other, rejection }, rejection };
}

/** When the rules can't read the sentence (e.g. a language without phrase rules), use what the AI marked. */
function intentFromEntities(entities: { text: string; kind: string }[]): Intent {
  const parts = entities.flatMap((e): Intent['parts'] =>
    e.kind === 'amount' ? [{ kind: 'amount', label: e.text, value: Number(e.text.replace(/[^\d.]/g, '')) || 0, text: e.text }]
    : e.kind === 'person' ? [{ kind: 'person', label: e.text, status: 'unknown', text: e.text }]
    : e.kind === 'purpose' ? [{ kind: 'purpose', label: e.text, text: e.text }]
    : e.kind === 'card' ? [{ kind: 'card', label: e.text, text: e.text }]
    : [],
  );
  return { parts, complete: false };
}

/** The language replies are shown in: detected from the sentence (any language) or the user's choice. */
async function replyLanguage(prompt: string, settings: Settings): Promise<string> {
  if (!settings.autoLanguage) return settings.language;
  return (await detectAnyLanguage(prompt)) ?? settings.language;
}

const looksTooShort = (prompt: string) => prompt.length < 6 || !/\s/.test(prompt.trim());

/**
 * Engine chain, cheapest first:
 *   1. plan cache (exact sentence, or a similar one with new values) — 0 tokens
 *   2. on-device rules for sentences they understand            — 0 tokens (optional)
 *   3. the LLM ReAct agent                                       — tokens, then cached for next time
 * Previews (as-you-type) never have side effects and never write conversation memory.
 */
export async function runAgent(
  user: User,
  req: AgentRequest,
  onEvent?: (e: AgentEvent) => void,
  opts: { signal?: AbortSignal; deps?: AgentDeps } = {},
): Promise<AgentResponse> {
  const prompt = req.prompt.trim();
  const mode: AgentMode = req.mode ?? 'commit';
  if (!prompt) throw new AppError('bad_request', 'Say what you want to do');
  if (prompt.length > 500) throw new AppError('bad_request', 'Keep it under 500 characters');

  const settings = resolveSettings(user.settings);
  const provider = opts.deps?.provider ?? pickProvider(settings.aiProvider);
  const conversation = req.conversationId
    ? await Conversation.findOne({ where: { id: req.conversationId, userId: user.id } })
    : null;

  const language = req.detectLanguage === false ? settings.language : await replyLanguage(prompt, settings);
  // Rules and the guard read English keywords; known phrases of other languages are mapped first.
  const normalized = toEnglishForRules(prompt, language);
  const [snapshot, understood] = await Promise.all([accountSnapshot(user), understand(user, prompt, normalized)]);

  const finish = async (
    engine: Engine,
    result: Pick<ReactResult, 'spec' | 'steps'>,
    runner: ActionRunner,
    extra: Partial<Pick<AgentResponse, 'cache' | 'fallback' | 'usage'>> = {},
  ): Promise<AgentResponse> => {
    const { spec, rejection } = extractRejection(attachDrafts(result.spec, runner));
    let conversationId = conversation?.id ?? null;
    if (mode === 'commit' && !rejection) {
      const convo = conversation ?? (await Conversation.create({ userId: user.id }));
      const now = new Date().toISOString();
      const turns: ChatTurn[] = [...convo.turns, { role: 'user' as const, content: prompt, at: now }, { role: 'assistant' as const, content: describe(spec), at: now }].slice(-MAX_TURNS);
      await convo.update({ turns });
      conversationId = convo.id;
    }
    const hydrated = await hydrateSpec(user, { ...spec, language }, runner.drafts);
    const translated = await translateSpec(hydrated, language, { user, aiWritten: engine === 'llm' });
    // The last answer stays on screen (also after a restart) until a new request replaces it.
    if (mode === 'commit' && !rejection && (spec.blocks.length || spec.dialog) && req.screen !== 'settings') {
      await saveLastView(user, req.screen, prompt, { ...spec, language });
    }
    return {
      conversationId, mode, provider, engine, fallback: false, usage: NO_USAGE, ...extra,
      spec: translated,
      steps: result.steps,
      language,
      rejection: (translated.rejection as Rejection | undefined) ?? null,
      intent: understood.parts.length ? understood : intentFromEntities(spec.entities ?? []),
    };
  };

  // 0 ── Guard: the account's real limits and permissions, before anything runs ──
  const rejected = checkRequest(normalized, snapshot);
  if (rejected) {
    logger.info({ userId: user.id, code: rejected.code }, 'request rejected by guard');
    const runner = new ActionRunner(user, 'preview');
    return finish('guard', { spec: { version: 1, blocks: helpFor(rejected, normalized), entities: [], rejection: rejected }, steps: [] }, runner);
  }

  // 1 ── Plan cache ─────────────────────────────────────────────────────────
  let template: Template | null = null;
  let refreshDue = false;
  if (settings.cacheMode !== 'off' && isCacheable(prompt, req.focus)) {
    template = await templatize(user, prompt, req.screen, settings, language);
    const found = await lookupPlan(user, template, settings.cacheMode, settings.cacheMaxReuse);
    // Reuse limit reached: go straight to the LLM so the plan is refreshed (and its count reset).
    refreshDue = !!found && 'refresh' in found && provider !== 'offline';
    const hit = found && 'hit' in found ? found.hit : null;
    if (hit) {
      const runner = new ActionRunner(user, mode);
      try {
        onEvent?.({ type: 'step', index: 0, label: 'Using your last answer' });
        const replay = await replayPlan(hit.row.plan as never, template.slots, prompt, runner);
        await markHit(hit.row);
        await recordUsage(user.id, { cacheHits: 1, tokensSaved: hit.row.tokens });
        return finish('cache', { spec: replay.spec, steps: replay.tools.map((tool) => ({ tool, ok: true })) }, runner, { cache: hit.mode });
      } catch (err) {
        logger.info({ err: (err as Error).message, key: template.key }, 'cached plan did not replay; continuing');
      }
    }
  }

  // 2 ── On-device rules ────────────────────────────────────────────────────
  if ((settings.preferOffline && !refreshDue) || provider === 'offline') {
    const runner = new ActionRunner(user, mode);
    const offline = await runOffline(user, normalized, runner);
    if (offline.understood || provider === 'offline') {
      if (provider !== 'offline') await recordUsage(user.id, { offlineRuns: 1, tokensSaved: await averageTokensPerRun(user.id) });
      return finish(offline.understood ? 'offline' : 'none', offline, runner);
    }
  }

  // 3 ── LLM (ReAct) ────────────────────────────────────────────────────────
  if (mode === 'preview' && looksTooShort(prompt)) {
    return finish('none', { spec: { version: 1, blocks: [], entities: [] }, steps: [] }, new ActionRunner(user, mode));
  }
  const runner = new ActionRunner(user, mode);
  const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(env.AGENT_TIMEOUT_MS)]) : AbortSignal.timeout(env.AGENT_TIMEOUT_MS);
  const context: AgentContext = {
    screen: req.screen,
    mode,
    design: designBriefForAgent(settings.design),
    currentView: req.currentView,
    focus: req.focus,
    history: (conversation?.turns ?? []).map((t) => ({ role: t.role, content: t.content })),
    account: snapshotForAgent(snapshot),
    language: { code: language, name: LANGUAGE_NAMES[language] ?? language },
  };
  const model = (opts.deps?.modelFactory ?? createChatModel)(provider as Exclude<Provider, 'offline'>);
  try {
    const result = await runReact({ model, user, prompt, context, runner, signal, onEvent, maxSteps: mode === 'preview' ? PREVIEW_MAX_STEPS : undefined });
    const usage = result.usage ?? NO_USAGE;
    await recordUsage(user.id, { llmRuns: 1, inputTokens: usage.input, outputTokens: usage.output });
    const allOk = result.steps.every((s) => s.ok !== false);
    if (template && allOk && (result.spec.blocks.length || result.spec.dialog)) {
      void storePlan(user, template, runner.trace, result.spec, usage.input + usage.output || (await averageTokensPerRun(user.id)));
    }
    return finish('llm', result, runner, { usage });
  } catch (err) {
    const details = (err as AppError).details as { pendingIds?: string[]; usage?: TokenUsage } | undefined;
    if (details?.usage) await recordUsage(user.id, { llmRuns: 1, inputTokens: details.usage.input, outputTokens: details.usage.output });
    if (opts.signal?.aborted) throw new AppError('bad_request', 'Request cancelled');
    // Never leave the user with nothing: keep a prepared confirmation, otherwise degrade to the rules.
    logger.warn({ err: (err as Error).message, provider }, 'agent failed, using fallback');
    const pending = details?.pendingIds ?? [];
    if (pending.length) {
      return finish('llm', { spec: { version: 1, blocks: pending.map((id) => ({ type: 'confirmation' as const, pendingId: id })), entities: [] }, steps: [] }, runner, { fallback: true });
    }
    const fallbackRunner = new ActionRunner(user, mode);
    const offline = await runOffline(user, normalized, fallbackRunner);
    return finish(offline.understood ? 'offline' : 'none', offline, fallbackRunner, { fallback: true });
  }
}

async function saveLastView(user: User, screen: string, prompt: string, spec: UISpec) {
  try {
    const row = await LastView.findOne({ where: { userId: user.id, screen } });
    if (row) await row.update({ prompt, spec });
    else await LastView.create({ userId: user.id, screen, prompt, spec });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'could not save the last view');
  }
}

/** The last answer on a screen, re-hydrated with fresh data (null when there is none or it was cleared). */
export async function lastView(user: User, screen: 'home' | 'cards') {
  const row = await LastView.findOne({ where: { userId: user.id, screen } });
  if (!row) return null;
  try {
    const spec = row.spec as UISpec;
    const hydrated = await hydrateSpec(user, spec);
    return { prompt: row.prompt, spec: await translateSpec(hydrated, spec.language ?? 'en', { user, aiWritten: false }) };
  } catch {
    // A stale view (deleted card, closed contact…) is dropped rather than shown broken.
    await row.destroy();
    return null;
  }
}

export async function clearLastView(user: User, screen: 'home' | 'cards') {
  await LastView.destroy({ where: { userId: user.id, screen } });
}

/** The default (or user-customised) canvas of a screen, hydrated. No LLM involved. */
/** The user's UI language (screens and dialogs the app builds without the assistant use it too). */
const uiLanguage = (user: User) => resolveSettings(user.settings).language;

export async function screenLayout(user: User, slot: 'home' | 'cards') {
  const { spec, custom } = await getLayout(user, slot);
  return { custom, spec: await translateSpec(await hydrateSpec(user, spec), uiLanguage(user), { user, aiWritten: false }) };
}

/** Re-hydrates a spec already on screen (its own texts are already in the right language; fresh data isn't). */
export async function rehydrate(user: User, spec: UISpec) {
  return translateSpec(await hydrateSpec(user, spec), spec.language ?? uiLanguage(user), { user, aiWritten: true });
}

const DETAIL_TITLES: Record<string, string> = { transaction: 'Transaction', card: 'Card', contact: 'Contact', profile: 'You', invoice: 'Invoice', dispute: 'Dispute' };

/** Detail dialog for a tapped entity, from its (possibly AI-redesigned) template. */
export async function detailDialog(user: User, kind: 'transaction' | 'card' | 'contact' | 'profile' | 'invoice' | 'dispute', id?: string) {
  if (kind !== 'profile' && !id) throw notFound(DETAIL_TITLES[kind]!);
  const slot = `detail:${kind}` as LayoutSlot;
  const { spec } = await getLayout(user, slot);
  const bound = id ? bindTemplate(spec, id) : spec;
  const lang = uiLanguage(user);
  const hydrated = await translateSpec(await hydrateSpec(user, { ...bound, title: bound.title ?? DETAIL_TITLES[kind]! }), lang, { user, aiWritten: false });
  return { title: hydrated.title ?? DETAIL_TITLES[kind]!, blocks: hydrated.blocks, currency: user.currency };
}
