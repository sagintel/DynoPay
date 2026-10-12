import type { User } from '../db/index.js';
import { translateSpec } from '../agent/translate.js';
import { generateTheme } from '../services/theme.js';
import { userPaypalStatus } from '../services/paypalStatus.js';
import { translateTexts } from '../services/i18n.js';
import { llmTranslator } from '../agent/translate.js';
import { createMcpToken, listMcpTokens, revokeMcpToken } from '../services/mcpTokens.js';
import { allowedActions } from '../actions/registry.js';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth/middleware.js';
import { badRequest } from '../lib/errors.js';
import { handler, isAllowedAppRedirect, parseBody } from '../lib/http.js';
import { cancelPending, confirmPending, getPending, listPending, performAction } from '../actions/perform.js';
import { clearLastView, detailDialog, lastView, rehydrate, runAgent, screenLayout } from '../agent/index.js';
import { availableProviders } from '../agent/llm.js';
import { cacheStats, clearPlans } from '../agent/cache.js';
import { usageSummary } from '../agent/usage.js';
import { manifestJson } from '../agent/manifest.js';
import type { AgentEvent } from '../agent/react.js';
import { layoutSlotSchema, uiSpecSchema } from '../agent/ui/schema.js';
import { hydrateSpec } from '../agent/ui/hydrate.js';
import { listLayouts, resetLayout, saveLayout } from '../services/layouts.js';
import { userView } from '../services/serialize.js';
import { captureTopUp, topUpStatus } from '../services/topups.js';
import { updateProfile } from '../services/users.js';
import { resolveSettings, settingsPatchSchema } from '../services/settings.js';
import { connectCredentials, connectionView, disconnect, getConnection } from '../services/merchant.js';
import { merchantCredentialsSchema } from './auth.js';

/** All routes here are mounted behind requireAuth. */
export const apiRouter = Router();

// ─── Profile ───────────────────────────────────────────────────────────────

apiRouter.get(
  '/me',
  handler(async (req, res) => {
    const user = currentUser(req);
    res.json({ ...userView(user), merchant: connectionView(await getConnection(user)) });
  }),
);

// ─── Merchant connection (PayPal REST credentials) ─────────────────────────

apiRouter.get(
  '/merchant/connection',
  handler(async (req, res) => {
    res.json({ connection: connectionView(await getConnection(currentUser(req))) });
  }),
);

/** Connect or rotate the merchant's REST credentials (verified with PayPal before saving). */
apiRouter.put(
  '/merchant/connection',
  handler(async (req, res) => {
    res.json({ connection: await connectCredentials(currentUser(req), parseBody(merchantCredentialsSchema, req.body)) });
  }),
);

apiRouter.delete(
  '/merchant/connection',
  handler(async (req, res) => {
    res.json(await disconnect(currentUser(req)));
  }),
);

apiRouter.patch(
  '/me',
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        name: z.string().max(60).optional(),
        settings: settingsPatchSchema.optional(),
      }),
      req.body,
    );
    res.json(userView(await updateProfile(currentUser(req), body)));
  }),
);

// ─── PayPal ────────────────────────────────────────────────────────────────

/** What PayPal can do for this account right now (`?refresh=1` re-checks the credentials with PayPal). */
apiRouter.get(
  '/paypal/status',
  handler(async (req, res) => {
    res.json(await userPaypalStatus(currentUser(req), { refresh: req.query.refresh === '1' }));
  }),
);

// ─── Theme & language ───────────────────────────────────────────────────────

/** A contrast-checked theme from the user's words. Saved only when `apply` is true (Settings shows a preview first). */
apiRouter.post(
  '/theme/generate',
  handler(async (req, res) => {
    const { prompt, apply } = parseBody(z.object({ prompt: z.string().trim().min(2).max(300), apply: z.boolean().default(false) }), req.body);
    const user = currentUser(req);
    const { audit, source, ...theme } = await generateTheme(user, prompt);
    if (apply) await updateProfile(user, { settings: { design: { theme } } });
    res.json({ theme, audit, source, applied: apply });
  }),
);

/**
 * Translates the app's own UI strings into any language (built-in packs, then the DB cache, then
 * the AI once). Unknown strings come back unchanged, so the app always has something to show.
 */
apiRouter.post(
  '/i18n/translate',
  handler(async (req, res) => {
    const { lang, strings } = parseBody(
      z.object({ lang: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/), strings: z.array(z.string().min(1).max(300)).min(1).max(400) }),
      req.body,
    );
    const user = currentUser(req);
    const map = await translateTexts(strings, lang, llmTranslator(user));
    res.json({ lang, translations: Object.fromEntries(strings.map((s) => [s, map.get(s) ?? s])) });
  }),
);

// ─── MCP tokens (external agents) ───────────────────────────────────────────

apiRouter.get(
  '/mcp/tokens',
  handler(async (req, res) => {
    res.json({ tokens: await listMcpTokens(currentUser(req)) });
  }),
);

/** The secret is returned once. Scopes never exceed the user's own permissions. */
apiRouter.post(
  '/mcp/tokens',
  handler(async (req, res) => {
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(60),
        scopes: z.array(z.enum(['read', 'propose'])).min(1).default(['read']),
        days: z.number().int().min(1).max(365).nullable().default(90),
      }),
      req.body,
    );
    res.status(201).json(await createMcpToken(currentUser(req), body));
  }),
);

apiRouter.delete(
  '/mcp/tokens/:id',
  handler(async (req, res) => {
    await revokeMcpToken(currentUser(req), z.string().uuid().parse(req.params.id));
    res.status(204).end();
  }),
);

// ─── Generative UI ─────────────────────────────────────────────────────────

apiRouter.get(
  '/ui/screen/:slot',
  handler(async (req, res) => {
    const slot = z.enum(['home', 'cards']).parse(req.params.slot);
    res.json(await screenLayout(currentUser(req), slot));
  }),
);

/** The screen's last answer (kept until a new request replaces it, or the user clears it). */
apiRouter.get(
  '/ui/last/:slot',
  handler(async (req, res) => {
    const slot = z.enum(['home', 'cards']).parse(req.params.slot);
    res.json({ last: await lastView(currentUser(req), slot) });
  }),
);

apiRouter.delete(
  '/ui/last/:slot',
  handler(async (req, res) => {
    const slot = z.enum(['home', 'cards']).parse(req.params.slot);
    await clearLastView(currentUser(req), slot);
    res.status(204).end();
  }),
);

apiRouter.get(
  '/ui/detail/:kind{/:id}',
  handler(async (req, res) => {
    const kind = z.enum(['transaction', 'card', 'contact', 'profile', 'invoice', 'dispute']).parse(req.params.kind);
    res.json(await detailDialog(currentUser(req), kind, req.params.id as string | undefined));
  }),
);

/** Re-hydrate an existing spec (refresh after an action without asking the model again). */
apiRouter.post(
  '/ui/hydrate',
  handler(async (req, res) => {
    const { spec } = parseBody(z.object({ spec: uiSpecSchema }), req.body);
    res.json({ spec: await rehydrate(currentUser(req), spec) });
  }),
);

apiRouter.get(
  '/ui/layouts',
  handler(async (req, res) => {
    res.json({ layouts: await listLayouts(currentUser(req)) });
  }),
);

apiRouter.put(
  '/ui/layouts/:slot',
  handler(async (req, res) => {
    const slot = layoutSlotSchema.parse(req.params.slot);
    const { spec, instruction } = parseBody(z.object({ spec: z.record(z.string(), z.unknown()), instruction: z.string().max(500).optional() }), req.body);
    res.json(await saveLayout(currentUser(req), slot, stripHydration(spec), instruction));
  }),
);

apiRouter.delete(
  '/ui/layouts/:slot',
  handler(async (req, res) => {
    res.json(await resetLayout(currentUser(req), layoutSlotSchema.parse(req.params.slot)));
  }),
);

/** Hydrated specs carry `data`/`error`; layouts must store only the structure. */
function stripHydration(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripHydration);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (k !== 'data' && k !== 'error' && k !== 'currency') out[k] = stripHydration(v);
    return out;
  }
  return value;
}

/** Confirmation previews are shown in the user's language (summary texts only; amounts and names stay). */
async function localizePending<T extends { summary: unknown }>(user: User, view: T): Promise<T> {
  const lang = resolveSettings(user.settings).language;
  if (lang === 'en') return view;
  const { summary } = await translateSpec({ summary: view.summary }, lang, { user, aiWritten: false });
  return { ...view, summary };
}

// ─── Agent ─────────────────────────────────────────────────────────────────

const agentBody = z.object({
  prompt: z.string().min(1).max(500),
  screen: z.enum(['home', 'cards', 'settings']).default('home'),
  mode: z.enum(['preview', 'commit']).default('commit'),
  currentView: z.string().max(1500).optional(),
  focus: z.object({ kind: z.string().max(20), id: z.string().max(64) }).optional(),
  conversationId: z.string().max(64).optional(),
  /** false for sentences the app itself sent (chips, buttons): keep the user's language instead of detecting it. */
  detectLanguage: z.boolean().default(true),
});

apiRouter.get('/agent/providers', (_req, res) => {
  res.json({ providers: availableProviders() });
});

apiRouter.get(
  '/agent/usage',
  handler(async (req, res) => {
    const user = currentUser(req);
    const [usage, cache] = await Promise.all([usageSummary(user), cacheStats(user)]);
    res.json({ usage, cache });
  }),
);

/** Forget every cached plan (e.g. after changing taste a lot). */
apiRouter.delete(
  '/agent/cache',
  handler(async (req, res) => {
    res.json(await clearPlans(currentUser(req)));
  }),
);

/** Aborts the agent (and its LLM calls) when the client goes away, e.g. a newer keystroke replaced it. */
function abortOnClose(req: import('express').Request, res: import('express').Response) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return controller.signal;
}

apiRouter.get('/agent/manifest', handler(async (req, res) => {
  res.json(manifestJson(currentUser(req), await allowedActions(currentUser(req))));
}));

apiRouter.post(
  '/agent',
  handler(async (req, res) => {
    res.json(await runAgent(currentUser(req), parseBody(agentBody, req.body), undefined, { signal: abortOnClose(req, res) }));
  }),
);

/** Same as POST /agent, streamed as Server-Sent Events: `step` events, then `result` (or `error`). */
apiRouter.post(
  '/agent/stream',
  handler(async (req, res) => {
    const body = parseBody(agentBody, req.body);
    const signal = abortOnClose(req, res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    try {
      send('step', { index: -1, label: 'Understanding your request' });
      const result = await runAgent(currentUser(req), body, (e: AgentEvent) => e.type === 'step' && send('step', e), { signal });
      send('result', result);
    } catch (err) {
      const e = err as { message?: string; code?: string };
      if (!signal.aborted) send('error', { code: e.code ?? 'internal', message: e.code ? e.message : 'Something went wrong' });
    } finally {
      clearInterval(ping);
      res.end();
    }
  }),
);

// ─── Actions & confirmations ───────────────────────────────────────────────

apiRouter.post(
  '/actions/:name',
  handler(async (req, res) => {
    const { input } = parseBody(z.object({ input: z.record(z.string(), z.unknown()).default({}) }), req.body);
    const user = currentUser(req);
    const result = await performAction(user, String(req.params.name), input);
    res.json(result.status === 'needs_confirmation' ? { ...result, pending: await localizePending(user, result.pending) } : result);
  }),
);

apiRouter.get(
  '/pending',
  handler(async (req, res) => {
    res.json({ pending: await listPending(currentUser(req)) });
  }),
);

apiRouter.get(
  '/pending/:id',
  handler(async (req, res) => {
    res.json(await localizePending(currentUser(req), await getPending(currentUser(req), String(req.params.id))));
  }),
);

/** The only way a confirm-level action executes: the user pressed the confirmation button. */
apiRouter.post(
  '/pending/:id/confirm',
  handler(async (req, res) => {
    const appReturnUrl = req.get('x-app-return-url');
    if (appReturnUrl && !isAllowedAppRedirect(appReturnUrl)) throw badRequest('Return URL not allowed');
    res.json(await localizePending(currentUser(req), await confirmPending(currentUser(req), String(req.params.id), { appReturnUrl: appReturnUrl ?? undefined })));
  }),
);

apiRouter.post(
  '/pending/:id/cancel',
  handler(async (req, res) => {
    res.json(await localizePending(currentUser(req), await cancelPending(currentUser(req), String(req.params.id))));
  }),
);

// ─── Top-ups (PayPal Orders) ───────────────────────────────────────────────

apiRouter.post(
  '/topups/:orderId/capture',
  handler(async (req, res) => {
    res.json(await captureTopUp(currentUser(req), String(req.params.orderId)));
  }),
);

apiRouter.get(
  '/topups/:orderId',
  handler(async (req, res) => {
    res.json(await topUpStatus(currentUser(req), String(req.params.orderId)));
  }),
);
