export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'insufficient_funds'
  | 'limit_exceeded'
  | 'expired'
  | 'rate_limited'
  | 'upstream_error'
  | 'not_configured'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  insufficient_funds: 422,
  limit_exceeded: 422,
  expired: 410,
  rate_limited: 429,
  upstream_error: 502,
  not_configured: 503,
  internal: 500,
};

/** An error whose message is safe to show to the end user (and to the agent). */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS[code];
  }
}

export const badRequest = (m: string, d?: unknown) => new AppError('bad_request', m, d);
export const notFound = (what: string) => new AppError('not_found', `${what} not found`);
export const forbidden = (m = 'Not allowed') => new AppError('forbidden', m);
export const unauthorized = (m = 'Authentication required') => new AppError('unauthorized', m);
export const conflict = (m: string) => new AppError('conflict', m);
