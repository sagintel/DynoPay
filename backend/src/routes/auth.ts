import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { requireAuth } from '../auth/middleware.js';
import { consumeTicket, createSession, issueTicket, refreshSession, revokeSession } from '../auth/tokens.js';
import { User } from '../db/index.js';
import { AppError, forbidden } from '../lib/errors.js';
import { appendQuery, handler, handoffPage, isAllowedAppRedirect, parseBody } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { paypalConfigured } from '../paypal/client.js';
import { buildAuthorizeUrl, exchangeCode, fetchUserInfo } from '../paypal/identity.js';
import { userView } from '../services/serialize.js';
import { upsertPayPalUser } from '../services/users.js';
import { seedDemoUser } from '../services/seed.js';
import { connectionView, getConnection, signInWithCredentials } from '../services/merchant.js';

export const authRouter = Router();

authRouter.get('/config', (_req, res) => {
  res.json({
    paypal: paypalConfigured(),
    devLogin: env.ALLOW_DEV_LOGIN,
    paypalEnv: env.PAYPAL_ENV,
    // Merchants sign in with their own PayPal REST app credentials (works without platform PayPal config).
    merchantSignIn: true,
  });
});

/**
 * Log in with PayPal, step 1. The app opens this URL in an auth session:
 *   GET /v1/auth/paypal/start?redirect=<app deep link>
 */
authRouter.get(
  '/paypal/start',
  handler(async (req, res) => {
    const redirect = typeof req.query.redirect === 'string' ? req.query.redirect : `${env.APP_SCHEME}://auth`;
    if (!isAllowedAppRedirect(redirect)) throw forbidden('Redirect not allowed');
    const state = await issueTicket('state', { redirect, ttlMs: 10 * 60_000 });
    res.redirect(302, buildAuthorizeUrl(state));
  }),
);

/** Step 2: PayPal redirects here. We create the user/session and hand a one-time code to the app. */
authRouter.get(
  '/paypal/callback',
  handler(async (req, res) => {
    const { code, state, error_description: denied } = req.query as Record<string, string | undefined>;
    let redirect: string | null = null;
    try {
      if (!state) throw new AppError('unauthorized', 'Missing state');
      const ticket = await consumeTicket('state', state);
      redirect = ticket.redirect;
      if (denied || !code) throw new AppError('unauthorized', denied ?? 'Sign-in was cancelled');
      const { accessToken } = await exchangeCode(code);
      const profile = await fetchUserInfo(accessToken);
      const user = await upsertPayPalUser(profile);
      const oneTime = await issueTicket('code', { userId: user.id, ttlMs: 2 * 60_000 });
      const target = appendQuery(redirect ?? `${env.APP_SCHEME}://auth`, { code: oneTime });
      res.type('html').send(handoffPage('Signed in', 'Taking you back to DynoPay…', target));
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'paypal sign-in failed');
      const message = err instanceof AppError ? err.message : 'Sign-in failed';
      const target = redirect && isAllowedAppRedirect(redirect) ? appendQuery(redirect, { error: message }) : undefined;
      res.status(400).type('html').send(handoffPage('Sign-in failed', message, target));
    }
  }),
);

/** Step 3: the app exchanges the one-time code for tokens (code never carries tokens through URLs). */
authRouter.post(
  '/exchange',
  handler(async (req, res) => {
    const { code } = parseBody(z.object({ code: z.string().min(10).max(200) }), req.body);
    const ticket = await consumeTicket('code', code);
    const user = await User.findByPk(ticket.userId!);
    if (!user) throw new AppError('unauthorized', 'Account not found');
    const tokens = await createSession(user.id, req.get('user-agent'));
    res.json({ ...tokens, user: userView(user) });
  }),
);

authRouter.post(
  '/refresh',
  handler(async (req, res) => {
    const { refreshToken } = parseBody(z.object({ refreshToken: z.string().min(20).max(200) }), req.body);
    res.json(await refreshSession(refreshToken));
  }),
);

authRouter.post(
  '/logout',
  requireAuth,
  handler(async (req, res) => {
    await revokeSession(req.sessionId!);
    res.status(204).end();
  }),
);

export const merchantCredentialsSchema = z.object({
  clientId: z.string().min(20).max(120),
  clientSecret: z.string().min(20).max(200),
  environment: z.enum(['sandbox', 'live']).default('sandbox'),
  businessName: z.string().max(80).optional(),
});

/**
 * Merchant sign-in with PayPal REST API credentials (Client ID + Secret of the merchant's own REST app).
 * Works for any REST client, not just the app: returns the same session tokens as the other sign-ins.
 */
authRouter.post(
  '/paypal/credentials',
  handler(async (req, res) => {
    const creds = parseBody(merchantCredentialsSchema, req.body);
    const { user, created } = await signInWithCredentials(creds);
    const tokens = await createSession(user.id, req.get('user-agent'));
    res.status(created ? 201 : 200).json({ ...tokens, user: userView(user), merchant: connectionView(await getConnection(user)) });
  }),
);

/** Development/demo sign-in with a seeded account. Disabled in production. */
authRouter.post(
  '/dev',
  handler(async (req, res) => {
    if (!env.ALLOW_DEV_LOGIN) throw forbidden('Dev login is disabled');
    const { name } = parseBody(z.object({ name: z.string().min(2).max(40).optional() }), req.body);
    const user = await seedDemoUser(name ?? 'Alex Morgan');
    const tokens = await createSession(user.id, req.get('user-agent'));
    res.json({ ...tokens, user: userView(user) });
  }),
);
