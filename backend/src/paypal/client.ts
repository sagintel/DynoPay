import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export type PayPalEnv = 'sandbox' | 'live';

export const apiBase = (e: PayPalEnv) => (e === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');
export const webBase = (e: PayPalEnv) => (e === 'live' ? 'https://www.paypal.com' : 'https://www.sandbox.paypal.com');

export const PAYPAL_API = apiBase(env.PAYPAL_ENV);
export const PAYPAL_WEB = webBase(env.PAYPAL_ENV);

export type TokenInfo = { accessToken: string; expiresAt: number; appId: string | null; scopes: string[] };

type RequestOpts = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** PayPal-Request-Id: makes POSTs idempotent on PayPal's side (generated when omitted). */
  idempotencyKey?: string;
  /** Use a user token instead of the client-credentials token (identity calls). */
  bearer?: string;
  headers?: Record<string, string>;
};

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 200) };
  }
}

/**
 * A REST client bound to one PayPal app (client id + secret) in one environment.
 * Used for the platform app and for every merchant who signs in with their own REST credentials.
 */
export class PayPalClient {
  private token: TokenInfo | null = null;
  private inflight: Promise<TokenInfo> | null = null;

  constructor(
    readonly clientId: string,
    private readonly clientSecret: string,
    readonly environment: PayPalEnv,
    private readonly label = 'PayPal',
  ) {}

  get api() {
    return apiBase(this.environment);
  }

  basicAuth() {
    return 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
  }

  /** Client-credentials token, cached until shortly before expiry. Also reports granted scopes. */
  async getToken(force = false): Promise<TokenInfo> {
    if (!force && this.token && this.token.expiresAt > Date.now() + 60_000) return this.token;
    this.inflight ??= (async () => {
      try {
        let res: Response;
        try {
          res = await fetch(`${this.api}/v1/oauth2/token`, {
            method: 'POST',
            headers: { Authorization: this.basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'grant_type=client_credentials',
            signal: AbortSignal.timeout(15_000),
          });
        } catch {
          throw new AppError('upstream_error', `${this.label} is unreachable right now`);
        }
        const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; app_id?: string; scope?: string; error?: string; error_description?: string };
        if (res.status === 401 || data.error === 'invalid_client') {
          throw new AppError('unauthorized', `${this.label} rejected these API credentials (${this.environment}). Check the Client ID, Secret and environment.`);
        }
        if (!res.ok || !data.access_token) throw new AppError('upstream_error', `${this.label} auth failed: ${data.error_description ?? res.status}`);
        this.token = {
          accessToken: data.access_token,
          expiresAt: Date.now() + (data.expires_in ?? 300) * 1000,
          appId: data.app_id ?? null,
          scopes: (data.scope ?? '').split(/\s+/).filter(Boolean),
        };
        return this.token;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  async request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
    const method = opts.method ?? 'GET';
    // Every POST carries a PayPal-Request-Id; retries reuse it so PayPal de-duplicates.
    const requestId = opts.idempotencyKey ?? (method === 'POST' ? crypto.randomUUID() : undefined);
    const qs = opts.query
      ? '?' + new URLSearchParams(Object.entries(opts.query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString()
      : '';

    let res: Response | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const token = opts.bearer ?? (await this.getToken()).accessToken;
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...opts.headers };
      if (requestId) headers['PayPal-Request-Id'] = requestId;
      try {
        res = await fetch(`${this.api}${path}${qs}`, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) throw new AppError('upstream_error', `${this.label} is unreachable right now`);
        logger.warn({ path, attempt, err: (err as Error).message }, 'paypal network error, retrying');
        await sleep(400 * 2 ** (attempt - 1));
        continue;
      }
      if (res.status === 401 && !opts.bearer && attempt < MAX_ATTEMPTS) {
        this.token = null; // token revoked/rotated early
        continue;
      }
      if (!RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS) break;
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 400 * 2 ** (attempt - 1));
    }
    if (!res) throw new AppError('upstream_error', `${this.label} is unreachable right now`);

    const text = await res.text();
    const data = text ? safeJson(text) : {};
    if (!res.ok) {
      const debugId = res.headers.get('paypal-debug-id');
      const d = data as { name?: string; message?: string; details?: { issue?: string; description?: string }[]; error_description?: string };
      const detail = d.details?.[0];
      logger.warn({ path, status: res.status, debugId, name: d.name, issue: detail?.issue }, 'paypal request failed');
      const message = detail?.description ?? d.message ?? d.error_description ?? `HTTP ${res.status}`;
      if (res.status === 403) {
        throw new AppError('forbidden', `${this.label}: this app isn't permitted to do that. Enable the feature for your REST app in the PayPal developer dashboard. (${message})`, { issue: detail?.issue ?? d.name, debugId });
      }
      if (res.status === 404) throw new AppError('not_found', `${this.label}: ${message}`, { debugId });
      throw new AppError(res.status === 422 || res.status === 400 ? 'bad_request' : 'upstream_error', `${this.label}: ${message}`, { issue: detail?.issue ?? d.name, debugId });
    }
    return data as T;
  }
}

// ─── Platform app (DynoPay's own REST app) ─────────────────────────────────

export const paypalConfigured = () => Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);

export function assertConfigured() {
  if (!paypalConfigured()) throw new AppError('not_configured', 'PayPal is not configured on this server');
}

let platform: PayPalClient | null = null;
export function platformClient(): PayPalClient {
  assertConfigured();
  return (platform ??= new PayPalClient(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET, env.PAYPAL_ENV));
}

export const basicAuth = () => platformClient().basicAuth();
export const getAppAccessToken = async () => (await platformClient().getToken()).accessToken;

export function paypalRequest<T>(path: string, opts: Omit<RequestOpts, 'query'> = {}): Promise<T> {
  return platformClient().request<T>(path, opts);
}
