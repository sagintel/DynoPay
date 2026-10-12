import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { haptic } from '@/components/Pressable';
import { useToast } from '@/components/Toast';
import { useI18n } from '@/i18n/context';
import { api, ApiError, runAgentStream } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Action, Block, DialogSpec, Engine, Entity, Intent, PendingView, Spec } from './types';

export type DialogState = (Omit<DialogSpec, 'blocks'> & { blocks: Block[]; loading?: boolean }) | null;

type CanvasValue = {
  screen: 'home' | 'cards';
  spec: Spec | null;
  mode: 'default' | 'result';
  loading: boolean;
  /** A live (as-you-type) preview request is in flight. */
  previewing: boolean;
  /** Which engine produced the current result (cache / on-device / AI). */
  engine: Engine | null;
  status: string | null;
  error: string | null;
  /** Why the last request can't be fulfilled (red prompt bar + message). Nothing ran. */
  rejection: string | null;
  /** What was understood from the sentence being typed (or last sent). */
  intent: Intent | null;
  entities: Entity[];
  people: string[];
  dialog: DialogState;
  /** `fromUi`: the sentence came from a chip/button (keeps the user's language instead of detecting it). */
  ask: (prompt: string, opts?: { fromUi?: boolean }) => Promise<void>;
  /** Live preview while typing: no side effects; empty text restores the screen. */
  preview: (text: string) => Promise<void>;
  reset: (opts?: { highlightId?: string; forget?: boolean }) => Promise<void>;
  refresh: () => Promise<void>;
  dispatch: (action: Action, fields?: Record<string, unknown>) => Promise<void>;
  closeDialog: () => void;
  onExecuted: (pending: PendingView) => Promise<void>;
  registerPrefill: (fn: (text: string) => void) => void;
};

const Ctx = createContext<CanvasValue | null>(null);

export function useCanvas() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCanvas must be used inside <CanvasProvider>');
  return v;
}

const PAYPAL_URL = /^https:\/\/(www\.)?(sandbox\.)?paypal\.com\//;

/** Removes server-hydrated data so a spec can be re-hydrated or saved as a layout. */
export function stripData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripData) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (k !== 'data' && k !== 'error' && k !== 'currency') out[k] = stripData(v);
    return out as T;
  }
  return value;
}

/** Compact description of what is on screen, sent to the agent as context for follow-ups. */
function describe(spec: Spec | null): string | undefined {
  if (!spec) return undefined;
  return JSON.stringify(
    spec.blocks.map((b) => {
      const extra = 'query' in b && b.query ? b.query : 'cardId' in b ? { cardId: b.cardId } : 'pendingId' in b ? { pendingId: b.pendingId } : undefined;
      return { type: b.type, ...('title' in b && b.title ? { title: b.title } : {}), ...(extra ? { q: extra } : {}) };
    }),
  ).slice(0, 1400);
}

function withHighlight(spec: Spec, id: string): Spec {
  return { ...spec, blocks: spec.blocks.map((b) => (b.type === 'transactions' ? { ...b, highlightId: id } : b)) };
}

function interpolate(input: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.startsWith('$field.')) out[k] = fields[v.slice(7)];
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = interpolate(v as Record<string, unknown>, fields);
    else out[k] = v;
  }
  return out;
}

export function CanvasProvider({ screen, children }: { screen: 'home' | 'cards'; children: ReactNode }) {
  const toast = useToast();
  const { t, lang, setLanguage } = useI18n();
  const { user } = useSession();
  const autoLanguage = user?.settings.autoLanguage !== false;
  /** The last submitted answer: it stays on screen until a new request replaces it (or Clear). */
  const committed = useRef<Spec | null>(null);
  const [rejection, setRejection] = useState<string | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [spec, setSpec] = useState<Spec | null>(null);
  const [mode, setMode] = useState<'default' | 'result'>('default');
  const [loading, setLoading] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [engine, setEngine] = useState<Engine | null>(null);
  const lastPreview = useRef<{ text: string; engine: Engine } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [entities, setEntities] = useState<Entity[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [people, setPeople] = useState<string[]>([]);
  const conversationId = useRef<string | undefined>(undefined);
  const prefillRef = useRef<(text: string) => void>(() => {});
  const abort = useRef<AbortController | null>(null);
  const specRef = useRef<Spec | null>(null);
  specRef.current = spec;
  const modeRef = useRef<'default' | 'result'>('default');
  modeRef.current = mode;

  const learnPeople = useCallback((s: Spec) => {
    const names = new Set<string>();
    const visit = (blocks: Block[]) => {
      for (const b of blocks) {
        if (b.type === 'contacts') b.data?.forEach((c) => names.add(c.name.split(' ')[0]!));
        if (b.type === 'transactions') b.data?.items.forEach((t) => t.counterparty.contactId && names.add(t.counterparty.name.split(' ')[0]!));
        if (b.type === 'section' || b.type === 'row') visit(b.children);
      }
    };
    visit(s.blocks);
    if (names.size) setPeople((prev) => [...new Set([...prev, ...names])].slice(0, 40));
  }, []);

  const reset = useCallback(
    async (opts: { highlightId?: string; forget?: boolean } = {}) => {
      abort.current?.abort();
      setError(null);
      setRejection(null);
      setIntent(null);
      committed.current = null;
      if (opts.forget) void api.clearLastView(screen).catch(() => undefined);
      try {
        const res = await api.screen(screen);
        const next = opts.highlightId ? withHighlight(res.spec, opts.highlightId) : res.spec;
        setSpec(next);
        setMode('default');
        setStatus(null);
        setEntities([]);
        setEngine(null);
        lastPreview.current = null;
        learnPeople(next);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [screen, learnPeople],
  );

  // Keep a stable ref to reset so the effect below never re-fires because reset's identity changed.
  const resetRef = useRef(reset);
  resetRef.current = reset;

  // On open: the last answer (kept across launches) or the screen's own layout.
  // Deps: `screen` (different tab = different data) and `lang` (language switch re-fetches translated layouts).
  // `reset` is intentionally excluded — it changes identity on every render but its behaviour is stable;
  // we access the latest version through `resetRef` to avoid the infinite loop.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { last } = await api.lastView(screen);
        if (cancelled) return;
        if (last) {
          committed.current = last.spec;
          setSpec(last.spec);
          setMode('result');
          setEntities([]);
          learnPeople(last.spec);
          return;
        }
      } catch {
        /* fall back to the layout */
      }
      if (!cancelled) void resetRef.current();
    })();
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, lang]);

  const refresh = useCallback(async () => {
    const current = specRef.current;
    if (!current || mode === 'default') return reset();
    try {
      const { spec: fresh } = await api.hydrate(stripData({ ...current, currency: undefined }));
      if (committed.current === current) committed.current = fresh;
      setSpec(fresh);
    } catch {
      /* keep what we have */
    }
  }, [mode, reset]);

  /** Follow the language the user writes in (when enabled). */
  const followLanguage = useCallback(
    (language: string | undefined) => {
      if (autoLanguage && language && language !== lang) void setLanguage(language);
    },
    [autoLanguage, lang, setLanguage],
  );

  const ask = useCallback(
    async (prompt: string, opts: { fromUi?: boolean } = {}) => {
      // Enter on a sentence that is already previewed: the drafts on screen are actionable, so no new request.
      const shown = lastPreview.current;
      if (shown && shown.text === prompt.trim() && shown.engine !== 'none' && !previewingRef.current) {
        haptic('select');
        return;
      }
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setLoading(true);
      setError(null);
      setRejection(null);
      setStatus(t('Understanding your request'));
      try {
        const result = await runAgentStream(
          { prompt, screen, mode: 'commit', currentView: describe(specRef.current), conversationId: conversationId.current, detectLanguage: !opts.fromUi },
          (e) => setStatus(e.label),
          controller.signal,
        );
        if (controller.signal.aborted) return;
        conversationId.current = result.conversationId ?? conversationId.current;
        lastPreview.current = null;
        setEngine(result.engine);
        if (!opts.fromUi) followLanguage(result.language);
        setIntent(result.intent?.parts.length ? result.intent : null);
        if (result.rejection) {
          // Nothing ran. Keep what was on screen unless the answer offers help (a picker, the balance…).
          setRejection(result.rejection.message);
          setStatus(null);
          haptic('error');
          if (result.spec.blocks.length) {
            setSpec(result.spec);
            setMode('result');
          } else if (committed.current) {
            setSpec(committed.current);
          }
          return;
        }
        committed.current = result.spec;
        setSpec(result.spec);
        setMode('result');
        setEntities(result.spec.entities ?? []);
        setStatus(result.spec.say ?? null);
        learnPeople(result.spec);
        if (result.spec.dialog) setDialog({ ...result.spec.dialog, blocks: result.spec.dialog.blocks ?? [] });
        haptic('select');
      } catch (e) {
        if (controller.signal.aborted) return;
        setStatus(null);
        setError(e instanceof ApiError ? e.message : t('Something went wrong. Try again.'));
        haptic('error');
      } finally {
        if (abort.current === controller) setLoading(false);
      }
    },
    [screen, learnPeople, t, followLanguage],
  );

  const previewingRef = useRef(false);
  const preview = useCallback(
    async (text: string) => {
      const prompt = text.trim();
      abort.current?.abort();
      if (!prompt) {
        // Input cleared: back to the last answer (it stays until a new request), or the screen's layout.
        previewingRef.current = false;
        setPreviewing(false);
        setRejection(null);
        setIntent(null);
        lastPreview.current = null;
        if (committed.current) {
          setSpec(committed.current);
          setMode('result');
          setEntities([]);
          setStatus(null);
        } else if (modeRef.current === 'result') void reset();
        return;
      }
      const controller = new AbortController();
      abort.current = controller;
      previewingRef.current = true;
      setPreviewing(true);
      try {
        const result = await runAgentStream(
          { prompt, screen, mode: 'preview', currentView: modeRef.current === 'default' ? describe(specRef.current) : undefined, conversationId: conversationId.current },
          (e) => setStatus(e.label),
          controller.signal,
        );
        if (controller.signal.aborted) return;
        lastPreview.current = { text: prompt, engine: result.engine };
        setEngine(result.engine);
        setError(null);
        setRejection(result.rejection?.message ?? null);
        setIntent(result.intent?.parts.length ? result.intent : null);
        if (result.rejection && !result.spec.blocks.length) return;
        // Nothing understood yet → render nothing (no stale or guessed elements).
        setSpec(result.spec);
        setMode('result');
        setEntities(result.spec.entities ?? []);
        setStatus(result.spec.say ?? null);
        learnPeople(result.spec);
      } catch {
        /* a newer keystroke replaced this one, or a transient error: keep what is shown */
      } finally {
        if (abort.current === controller) {
          previewingRef.current = false;
          setPreviewing(false);
        }
      }
    },
    [screen, learnPeople, reset],
  );

  const showPending = useCallback((pending: PendingView) => {
    setDialog({ title: pending.summary.title, blocks: [{ type: 'confirmation', pendingId: pending.id, data: pending }] });
  }, []);

  const dispatch = useCallback(
    async (action: Action, fields: Record<string, unknown> = {}) => {
      switch (action.type) {
        case 'ask':
          setDialog(null);
          prefillRef.current(action.prompt);
          return ask(action.prompt, { fromUi: true });
        case 'prefill':
          setDialog(null);
          return prefillRef.current(action.text);
        case 'navigate':
          setDialog(null);
          return router.navigate(action.screen === 'home' ? '/' : `/${action.screen}`);
        case 'reset_view':
          setDialog(null);
          return reset({ forget: true });
        case 'close':
          return setDialog(null);
        case 'dialog': {
          const blocks = action.dialog.blocks ?? [];
          setDialog({ ...action.dialog, blocks });
          if (blocks.length) {
            try {
              const { spec: h } = await api.hydrate({ version: 1, blocks, entities: [] });
              setDialog((d) => (d ? { ...d, blocks: h.blocks } : d));
            } catch {
              /* static blocks still render */
            }
          }
          return;
        }
        case 'open': {
          setDialog({ title: '', blocks: [], loading: true });
          try {
            const d = await api.detail(action.kind, action.id);
            setDialog({ title: d.title, blocks: d.blocks });
          } catch (e) {
            setDialog(null);
            toast((e as Error).message, 'error');
          }
          return;
        }
        case 'pin': {
          const current = specRef.current;
          if (!current) return;
          await api.saveLayout(action.slot, stripData({ ...current, currency: undefined }));
          toast(t('Saved as your {x} layout', { x: t(action.slot === 'home' ? 'Home' : 'Cards') }), 'success');
          return;
        }
        case 'open_url':
          if (PAYPAL_URL.test(action.url)) await WebBrowser.openBrowserAsync(action.url);
          return;
        case 'confirm': {
          try {
            showPending(await api.pending(action.pendingId));
          } catch (e) {
            toast((e as Error).message, 'error');
          }
          return;
        }
        case 'run': {
          try {
            const res = await api.perform(action.action, interpolate(action.input, fields));
            if (res.status === 'needs_confirmation') return showPending(res.pending);
            haptic('success');
            setDialog(null);
            toast('Done', 'success');
            await refresh();
          } catch (e) {
            haptic('error');
            toast((e as Error).message, 'error');
          }
          return;
        }
      }
    },
    [ask, reset, refresh, showPending, toast, t],
  );

  /** Called by the confirmation block once the server executed a pending action. */
  const onExecuted = useCallback(
    async (pending: PendingView) => {
      const result = pending.result ?? {};
      if (pending.action === 'top_up' && typeof result.approveUrl === 'string' && typeof result.orderId === 'string') {
        const returnUrl = Linking.createURL('topup');
        await WebBrowser.openAuthSessionAsync(result.approveUrl, returnUrl);
        try {
          await api.captureTopUp(result.orderId);
          toast('Money added to your balance', 'success');
          setDialog(null);
          await refresh();
        } catch (e) {
          toast(e instanceof ApiError && /approve|PAYER_ACTION_REQUIRED|ORDER_NOT_APPROVED/i.test(e.message) ? t('Top-up was not approved in PayPal') : (e as Error).message, 'error');
        }
        return;
      }
      if (typeof result.approveUrl === 'string') return; // e.g. a payment link: the confirmation shows it
      setTimeout(() => setDialog(null), 900);
      if (typeof result.transactionId === 'string' && screen === 'home' && ['send_money', 'pay_request'].includes(pending.action) && !committed.current) {
        // Like the concept video: home, balance updated, the new payment highlighted.
        setTimeout(() => void reset({ highlightId: result.transactionId as string }), 1100);
        return;
      }
      // The answer stays on screen with fresh data (the last request's UI is kept until a new one).
      setTimeout(() => void refresh(), 600);
    },
    [refresh, reset, screen, toast, t],
  );

  const value = useMemo<CanvasValue>(
    () => ({
      screen, spec, mode, loading, previewing, engine, status, error, rejection, intent, entities, people, dialog,
      ask, preview, reset, refresh, dispatch, onExecuted,
      closeDialog: () => setDialog(null),
      registerPrefill: (fn) => (prefillRef.current = fn),
    }),
    [screen, spec, mode, loading, previewing, engine, status, error, rejection, intent, entities, people, dialog, ask, preview, reset, refresh, dispatch, onExecuted],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
