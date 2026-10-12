import type { NextFunction, Request, Response } from 'express';
import { User } from '../db/index.js';
import { unauthorized } from '../lib/errors.js';
import { isSessionActive, verifyAccessToken } from './tokens.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      sessionId?: string;
    }
  }
}

export async function authenticate(header: string | undefined): Promise<{ user: User; sessionId: string }> {
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw unauthorized();
  const { userId, sessionId } = await verifyAccessToken(token);
  const [user, active] = await Promise.all([User.findByPk(userId), isSessionActive(sessionId)]);
  if (!user || !active) throw unauthorized('Session is no longer valid');
  return { user, sessionId };
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const { user, sessionId } = await authenticate(req.headers.authorization);
    req.user = user;
    req.sessionId = sessionId;
    next();
  } catch (err) {
    next(err);
  }
}

/** Narrowing helper for handlers mounted behind requireAuth. */
export function currentUser(req: Request): User {
  if (!req.user) throw unauthorized();
  return req.user;
}
