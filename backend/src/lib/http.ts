import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { env, isProd } from '../config/env.js';
import { AppError, badRequest } from './errors.js';
import { logger } from './logger.js';

/** Express 5 forwards rejected promises, but this keeps handler typing tidy. */
export const handler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) =>
    fn(req, res, next).catch(next);

export function parseBody<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value ?? {});
  if (!r.success) throw badRequest(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_request', message: 'Malformed JSON body' } });
    return;
  }
  logger.error({ err, path: req.path }, 'unhandled error');
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
};

/**
 * Where we may send users back after PayPal (sign-in / top-up).
 * Always the app scheme; in development also Expo Go (exp://) and local web.
 */
export function isAllowedAppRedirect(url: string | undefined | null): url is string {
  if (!url || url.length > 500) return false;
  if (url.startsWith(`${env.APP_SCHEME}://`)) return true;
  if (isProd) return false;
  return /^(exps?:\/\/|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/.test(url);
}

export function appendQuery(url: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  return `${url}${url.includes('?') ? '&' : '?'}${qs}`;
}

/** Minimal HTML page that hands the browser back to the app. */
export function handoffPage(title: string, message: string, target?: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const redirect = target ? `<meta http-equiv="refresh" content="0;url=${esc(target)}">` : '';
  const link = target ? `<a href="${esc(target)}">Return to DynoPay</a>` : '<p>You can close this window.</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${redirect}<title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121212;color:#f4f1ea;font:16px -apple-system,system-ui,sans-serif;text-align:center}
h1{font-size:22px;margin:0 0 8px}p{color:#9a968e;margin:0 0 20px}a{color:#121212;background:#f0a531;padding:12px 22px;border-radius:14px;text-decoration:none;font-weight:600}</style>
</head><body><main><h1>${esc(title)}</h1><p>${esc(message)}</p>${link}</main></body></html>`;
}
