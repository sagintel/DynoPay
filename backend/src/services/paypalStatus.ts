import { env } from '../config/env.js';
import type { User } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { paypalConfigured, platformClient } from '../paypal/client.js';
import { connectionView, getConnection, merchantClient } from './merchant.js';

/**
 * What PayPal can do right now, for the platform app (personal accounts: Log in with PayPal,
 * top-ups via Orders, payouts to any email) and for a merchant's own REST app.
 * Features come from the scopes PayPal granted the app; an empty scope list means "unknown",
 * so the call is allowed and any refusal is reported clearly.
 */
export type PlatformStatus = {
  configured: boolean;
  environment: 'sandbox' | 'live';
  reachable: boolean | null;
  features: { login: boolean; topUps: boolean; payouts: boolean; webhooks: boolean };
  error: string | null;
  checkedAt: string | null;
};

const has = (scopes: string[], needle: string) => !scopes.length || scopes.some((s) => s.includes(needle));
const TTL = 5 * 60_000;
let cached: { at: number; value: PlatformStatus } | null = null;

export async function platformStatus(opts: { refresh?: boolean } = {}): Promise<PlatformStatus> {
  const base: PlatformStatus = {
    configured: paypalConfigured(),
    environment: env.PAYPAL_ENV,
    reachable: null,
    features: { login: false, topUps: false, payouts: false, webhooks: !!env.PAYPAL_WEBHOOK_ID },
    error: null,
    checkedAt: null,
  };
  if (!base.configured) return { ...base, error: 'PayPal is not configured on this server (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).' };
  if (!opts.refresh && cached && Date.now() - cached.at < TTL) return cached.value;
  let value: PlatformStatus;
  try {
    const token = await platformClient().getToken(opts.refresh);
    value = {
      ...base,
      reachable: true,
      features: {
        // Log in with PayPal is enabled per app in the dashboard; it can't be read from the token.
        login: true,
        topUps: has(token.scopes, 'payments/payment') || has(token.scopes, 'checkout'),
        payouts: has(token.scopes, 'payouts'),
        webhooks: !!env.PAYPAL_WEBHOOK_ID,
      },
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'paypal platform check failed');
    value = { ...base, reachable: false, error: err instanceof AppError ? err.message : 'PayPal is unreachable right now', checkedAt: new Date().toISOString() };
  }
  cached = { at: Date.now(), value };
  return value;
}

/** Fails early (at preview time, before any confirmation is shown) when a platform feature can't work. */
export async function assertPlatformFeature(feature: 'topUps' | 'payouts', who?: string) {
  const s = await platformStatus();
  if (!s.configured) {
    throw new AppError(
      'not_configured',
      feature === 'payouts'
        ? `${who ?? 'This person'} isn't on DynoPay, and PayPal payouts aren't configured on this server.`
        : 'Top-ups need PayPal, which is not configured on this server.',
    );
  }
  if (s.reachable === false) throw new AppError('upstream_error', s.error ?? 'PayPal is unreachable right now');
  if (!s.features[feature]) {
    throw new AppError(
      'forbidden',
      feature === 'payouts'
        ? 'Payouts are not enabled for this PayPal app. Enable “Payouts” in the PayPal developer dashboard.'
        : 'Accept payments is not enabled for this PayPal app. Enable it in the PayPal developer dashboard.',
    );
  }
}

/** The signed-in user's PayPal picture: platform features, their own PayPal link, and (merchants) their REST app. */
export async function userPaypalStatus(user: User, opts: { refresh?: boolean } = {}) {
  const platform = await platformStatus(opts);
  let merchant: (ReturnType<typeof connectionView> & { verified?: boolean; error?: string | null }) | null = null;
  if (user.accountType === 'business') {
    const conn = await getConnection(user);
    merchant = connectionView(conn);
    if (conn && opts.refresh) {
      try {
        const { client } = await merchantClient(user);
        await client.getToken(true);
        merchant = { ...connectionView(conn)!, verified: true, error: null };
      } catch (err) {
        merchant = { ...connectionView(conn)!, verified: false, error: err instanceof AppError ? err.message : 'PayPal check failed' };
      }
    }
  }
  return {
    accountType: user.accountType,
    platform,
    personal: {
      linked: !!user.paypalUserId,
      email: user.email,
      canTopUp: platform.configured && platform.reachable !== false && platform.features.topUps,
      canPayAnyEmail: platform.configured && platform.reachable !== false && platform.features.payouts,
    },
    merchant,
  };
}

/** Test hook: forget the cached platform check. */
export const resetPlatformStatus = () => {
  cached = null;
};
