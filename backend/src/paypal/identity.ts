import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { PAYPAL_API, PAYPAL_WEB, assertConfigured, basicAuth, paypalRequest } from './client.js';

/** Log in with PayPal (OpenID Connect). */
export const PAYPAL_CALLBACK_PATH = '/v1/auth/paypal/callback';
export const paypalRedirectUri = () => `${env.PUBLIC_URL}${PAYPAL_CALLBACK_PATH}`;

export function buildAuthorizeUrl(state: string): string {
  assertConfigured();
  const params = new URLSearchParams({
    flowEntry: 'static',
    client_id: env.PAYPAL_CLIENT_ID,
    response_type: 'code',
    scope: 'openid profile email https://uri.paypal.com/services/paypalattributes',
    redirect_uri: paypalRedirectUri(),
    state,
  });
  return `${PAYPAL_WEB}/signin/authorize?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<{ accessToken: string }> {
  assertConfigured();
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    throw new AppError('unauthorized', `PayPal sign-in failed: ${data.error_description ?? res.status}`);
  }
  return { accessToken: data.access_token };
}

export type PayPalUserInfo = {
  user_id: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  payer_id?: string;
  verified_account?: boolean | string;
  email?: string;
  emails?: { value: string; primary?: boolean; confirmed?: boolean }[];
};

export async function fetchUserInfo(accessToken: string) {
  const info = await paypalRequest<PayPalUserInfo>('/v1/identity/oauth2/userinfo?schema=paypalv1.1', { bearer: accessToken });
  const email = info.emails?.find((e) => e.primary)?.value ?? info.emails?.[0]?.value ?? info.email;
  if (!email) throw new AppError('unauthorized', 'PayPal did not share an email address. Enable the email scope in your PayPal app.');
  const name = info.name ?? ([info.given_name, info.family_name].filter(Boolean).join(' ') || email.split('@')[0]!);
  return {
    paypalUserId: info.user_id,
    payerId: info.payer_id ?? null,
    email: email.toLowerCase(),
    name,
    verified: info.verified_account === true || info.verified_account === 'true',
  };
}
