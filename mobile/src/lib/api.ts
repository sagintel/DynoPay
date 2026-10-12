import { fetch as expoFetch } from 'expo/fetch';
import { API_URL } from './config';
import { secureStorage } from './storage';
import type { AgentResult, McpScope, McpToken, MerchantConnection, PendingView, PerformResult, SettingsPatch, Theme, ThemeAudit, UsageReport, User } from '@/genui/types';

export type MerchantCredentials = { clientId: string; clientSecret: string; environment: 'sandbox' | 'live'; businessName?: string };

const ACCESS = 'dynopay.access';
const REFRESH = 'dynopay.refresh';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Tokens = { accessToken: string; refreshToken: string };

let accessToken: string | null = null;
/** 'invalid' only when the server rejected the refresh token; network trouble never signs the user out. */
type RefreshResult = 'ok' | 'invalid' | 'network';
let refreshing: Promise<RefreshResult> | null = null;
let onSignedOut: (() => void) | null = null;

export const session = {
  async load(): Promise<boolean> {
    accessToken = await secureStorage.get(ACCESS);
    return !!(accessToken || (await secureStorage.get(REFRESH)));
  },
  async save(tokens: Tokens) {
    accessToken = tokens.accessToken;
    await Promise.all([secureStorage.set(ACCESS, tokens.accessToken), secureStorage.set(REFRESH, tokens.refreshToken)]);
  },
  async clear() {
    accessToken = null;
    await Promise.all([secureStorage.remove(ACCESS), secureStorage.remove(REFRESH)]);
  },
  onSignedOut(cb: () => void) {
    onSignedOut = cb;
  },
};

async function refresh(): Promise<RefreshResult> {
  refreshing ??= (async (): Promise<RefreshResult> => {
    try {
      const refreshToken = await secureStorage.get(REFRESH);
      if (!refreshToken) return 'invalid';
      const res = await fetch(`${API_URL}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (res.status === 401) return 'invalid';
      if (!res.ok) return 'network';
      await session.save((await res.json()) as Tokens);
      return 'ok';
    } catch {
      return 'network';
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

async function parseError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  return new ApiError(res.status, body?.error?.code ?? 'error', body?.error?.message ?? `Request failed (${res.status})`);
}

export async function request<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; auth?: boolean } = {}): Promise<T> {
  const doFetch = () =>
    fetch(`${API_URL}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        'Content-Type': 'application/json',
        ...(init.auth !== false && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  let res: Response;
  try {
    res = await doFetch();
  } catch {
    throw new ApiError(0, 'network', "Can't reach DynoPay. Check your connection.");
  }
  if (res.status === 401 && init.auth !== false) {
    const r = await refresh();
    if (r === 'ok') res = await doFetch();
    else if (r === 'invalid') {
      await session.clear();
      onSignedOut?.();
    } else throw new ApiError(0, 'network', "Can't reach DynoPay. Check your connection.");
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export type AgentStepEvent = { index: number; label: string; tool?: string };

/**
 * Runs the agent with live ReAct progress (Server-Sent Events over a streaming fetch).
 * Falls back to the plain JSON endpoint if streaming is unavailable.
 */
export async function runAgentStream(
  body: { prompt: string; screen: string; mode?: 'preview' | 'commit'; currentView?: string; conversationId?: string; focus?: { kind: string; id: string }; detectLanguage?: boolean },
  onStep: (e: AgentStepEvent) => void,
  signal?: AbortSignal,
): Promise<AgentResult> {
  const call = () =>
    expoFetch(`${API_URL}/v1/agent/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify(body),
      signal,
    });

  let res = await call().catch(() => null);
  if (res?.status === 401 && (await refresh()) === 'ok') res = await call().catch(() => null);
  if (!res || !res.ok || !res.body) {
    if (res && res.status !== 404 && res.status !== 0 && !res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      throw new ApiError(res.status, err?.error?.code ?? 'error', err?.error?.message ?? 'The assistant is unavailable');
    }
    return request<AgentResult>('/v1/agent', { body });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: AgentResult | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const event = /^event: (.+)$/m.exec(chunk)?.[1];
      const data = /^data: (.+)$/m.exec(chunk)?.[1];
      if (!event || !data) continue;
      const parsed = JSON.parse(data);
      if (event === 'step') onStep(parsed as AgentStepEvent);
      else if (event === 'result') result = parsed as AgentResult;
      else if (event === 'error') throw new ApiError(500, parsed.code ?? 'error', parsed.message ?? 'Something went wrong');
    }
  }
  if (!result) throw new ApiError(500, 'stream', 'The assistant stopped unexpectedly');
  return result;
}

// ─── Typed endpoints ───────────────────────────────────────────────────────

export const api = {
  authConfig: () => request<{ paypal: boolean; devLogin: boolean; paypalEnv: string; merchantSignIn: boolean }>('/v1/auth/config', { auth: false }),
  merchantSignIn: (creds: MerchantCredentials) =>
    request<Tokens & { user: User; merchant: MerchantConnection }>('/v1/auth/paypal/credentials', { body: creds, auth: false }),
  connectMerchant: (creds: MerchantCredentials) => request<{ connection: MerchantConnection }>('/v1/merchant/connection', { method: 'PUT', body: creds }),
  disconnectMerchant: () => request<{ disconnected: boolean }>('/v1/merchant/connection', { method: 'DELETE' }),
  exchange: (code: string) => request<Tokens & { user: User }>('/v1/auth/exchange', { body: { code }, auth: false }),
  devLogin: () => request<Tokens & { user: User }>('/v1/auth/dev', { body: {}, auth: false }),
  logout: () => request<void>('/v1/auth/logout', { method: 'POST' }),
  me: () => request<User>('/v1/me'),
  updateMe: (patch: { name?: string; settings?: SettingsPatch }) => request<User>('/v1/me', { method: 'PATCH', body: patch }),
  usage: () => request<UsageReport>('/v1/agent/usage'),
  clearCache: () => request<{ cleared: number }>('/v1/agent/cache', { method: 'DELETE' }),
  screen: (slot: 'home' | 'cards') => request<{ custom: boolean; spec: AgentResult['spec'] }>(`/v1/ui/screen/${slot}`),
  detail: (kind: string, id?: string) => request<{ title: string; blocks: AgentResult['spec']['blocks'] }>(`/v1/ui/detail/${kind}${id ? `/${id}` : ''}`),
  hydrate: (spec: unknown) => request<{ spec: AgentResult['spec'] }>('/v1/ui/hydrate', { body: { spec } }),
  layouts: () => request<{ layouts: { slot: string; custom: boolean; instruction: string | null; updatedAt: string | null }[] }>('/v1/ui/layouts'),
  saveLayout: (slot: string, spec: unknown, instruction?: string) => request<{ saved: boolean }>(`/v1/ui/layouts/${encodeURIComponent(slot)}`, { method: 'PUT', body: { spec, instruction } }),
  resetLayout: (slot: string) => request<{ reset: boolean }>(`/v1/ui/layouts/${encodeURIComponent(slot)}`, { method: 'DELETE' }),
  agent: (body: { prompt: string; screen: string; currentView?: string }) => request<AgentResult>('/v1/agent', { body }),
  providers: () => request<{ providers: { id: string; available: boolean; model: string; default: boolean }[] }>('/v1/agent/providers'),
  perform: (name: string, input: Record<string, unknown>) => request<PerformResult>(`/v1/actions/${name}`, { body: { input } }),
  pending: (id: string) => request<PendingView>(`/v1/pending/${id}`),
  confirm: (id: string, appReturnUrl?: string) =>
    request<PendingView>(`/v1/pending/${id}/confirm`, { method: 'POST', headers: appReturnUrl ? { 'X-App-Return-Url': appReturnUrl } : {} }),
  cancel: (id: string) => request<PendingView>(`/v1/pending/${id}/cancel`, { method: 'POST' }),
  paypalStatus: (refresh = false) =>
    request<{
      accountType: 'personal' | 'business';
      platform: { configured: boolean; environment: 'sandbox' | 'live'; reachable: boolean | null; features: { login: boolean; topUps: boolean; payouts: boolean; webhooks: boolean }; error: string | null; checkedAt: string | null };
      personal: { linked: boolean; email: string; canTopUp: boolean; canPayAnyEmail: boolean };
      merchant: (MerchantConnection & { verified?: boolean; error?: string | null }) | null;
    }>(`/v1/paypal/status${refresh ? '?refresh=1' : ''}`),
  lastView: (slot: 'home' | 'cards') => request<{ last: { prompt: string; spec: AgentResult['spec'] } | null }>(`/v1/ui/last/${slot}`),
  clearLastView: (slot: 'home' | 'cards') => request<void>(`/v1/ui/last/${slot}`, { method: 'DELETE' }),
  generateTheme: (prompt: string, apply = false) =>
    request<{ theme: Theme; audit: ThemeAudit; source: 'rules' | 'ai'; applied: boolean }>('/v1/theme/generate', { body: { prompt, apply } }),
  translate: (lang: string, strings: string[]) => request<{ lang: string; translations: Record<string, string> }>('/v1/i18n/translate', { body: { lang, strings } }),
  mcpTokens: () => request<{ tokens: McpToken[] }>('/v1/mcp/tokens'),
  createMcpToken: (body: { name: string; scopes: McpScope[]; days: number | null }) => request<{ token: string; mcpToken: McpToken }>('/v1/mcp/tokens', { body }),
  revokeMcpToken: (id: string) => request<void>(`/v1/mcp/tokens/${id}`, { method: 'DELETE' }),
  captureTopUp: (orderId: string) => request<{ status: string; transactionId: string | null }>(`/v1/topups/${orderId}/capture`, { method: 'POST' }),
};
