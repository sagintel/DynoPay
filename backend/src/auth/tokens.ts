import crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { Op } from 'sequelize';
import { env } from '../config/env.js';
import { AuthTicket, Session } from '../db/index.js';
import { AppError, unauthorized } from '../lib/errors.js';

const secret = new TextEncoder().encode(env.JWT_SECRET);
const ISSUER = 'dynopay';
const AUDIENCE = 'dynopay-app';

export const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export async function signAccessToken(userId: string, sessionId: string): Promise<string> {
  return new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(env.ACCESS_TOKEN_TTL)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<{ userId: string; sessionId: string }> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, audience: AUDIENCE });
    if (!payload.sub || typeof payload.sid !== 'string') throw unauthorized('Malformed token');
    return { userId: payload.sub, sessionId: payload.sid };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw unauthorized('Invalid or expired token');
  }
}

export type TokenPair = { accessToken: string; refreshToken: string; expiresIn: string };

export async function createSession(userId: string, userAgent?: string): Promise<TokenPair> {
  const refreshToken = randomToken(48);
  const session = await Session.create({
    userId,
    refreshHash: sha256(refreshToken),
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    revokedAt: null,
    userAgent: userAgent?.slice(0, 200) ?? null,
  });
  return { accessToken: await signAccessToken(userId, session.id), refreshToken, expiresIn: env.ACCESS_TOKEN_TTL };
}

/** Rotates the refresh token. Re-use of an already rotated token revokes every session of that user. */
export async function refreshSession(refreshToken: string): Promise<TokenPair> {
  const session = await Session.findOne({ where: { refreshHash: sha256(refreshToken) } });
  if (!session) throw unauthorized('Unknown refresh token');
  if (session.revokedAt) {
    await Session.update({ revokedAt: new Date() }, { where: { userId: session.userId, revokedAt: null } });
    throw unauthorized('Refresh token reuse detected; please sign in again');
  }
  if (session.expiresAt.getTime() < Date.now()) throw unauthorized('Session expired');

  const next = randomToken(48);
  session.refreshHash = sha256(next);
  await session.save();
  return { accessToken: await signAccessToken(session.userId, session.id), refreshToken: next, expiresIn: env.ACCESS_TOKEN_TTL };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await Session.update({ revokedAt: new Date() }, { where: { id: sessionId, revokedAt: null } });
}

export async function isSessionActive(sessionId: string): Promise<boolean> {
  const s = await Session.findOne({ where: { id: sessionId, revokedAt: null, expiresAt: { [Op.gt]: new Date() } } });
  return !!s;
}

// ─── One-time tickets (OAuth state + app hand-off code) ────────────────────

export async function issueTicket(kind: 'state' | 'code', opts: { userId?: string; redirect?: string; ttlMs: number }) {
  const raw = randomToken(32);
  await AuthTicket.create({
    id: sha256(raw),
    kind,
    userId: opts.userId ?? null,
    redirect: opts.redirect ?? null,
    expiresAt: new Date(Date.now() + opts.ttlMs),
    usedAt: null,
  });
  return raw;
}

export async function consumeTicket(kind: 'state' | 'code', raw: string): Promise<AuthTicket> {
  const ticket = await AuthTicket.findByPk(sha256(raw));
  if (!ticket || ticket.kind !== kind) throw unauthorized('Invalid sign-in ticket');
  // Atomic single use: only one concurrent consumer can flip usedAt.
  const [count] = await AuthTicket.update(
    { usedAt: new Date() },
    { where: { id: ticket.id, usedAt: null, expiresAt: { [Op.gt]: new Date() } } },
  );
  if (count !== 1) throw unauthorized('Sign-in ticket expired or already used');
  return ticket;
}
