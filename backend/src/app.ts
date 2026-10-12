import compression from 'compression';
import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env, isTest } from './config/env.js';
import { requireAuth } from './auth/middleware.js';
import { errorHandler } from './lib/http.js';
import { logger } from './lib/logger.js';
import { mcpRouter } from './mcp/server.js';
import { apiRouter } from './routes/api.js';
import { authRouter } from './routes/auth.js';
import { paypalRouter } from './routes/paypal.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({ contentSecurityPolicy: false }));
  const origins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  // Native apps send no Origin header; browsers (Expo web) must be allow-listed.
  app.use(cors({ origin: (origin, cb) => cb(null, !origin || origins.includes(origin)), credentials: false }));
  app.use(compression({ filter: (req, res) => !req.path.endsWith('/stream') && compression.filter(req, res) }));
  app.use(express.json({ limit: '200kb' }));
  if (!isTest) app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

  const limiter = (limit: number) => rateLimit({ windowMs: 60_000, limit, standardHeaders: 'draft-8', legacyHeaders: false, skip: () => isTest });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'dynopay', time: new Date().toISOString() });
  });

  app.use('/v1/auth', limiter(30), authRouter);
  // Limit only the PayPal return/webhook/cron paths here (mounting a limiter on '/v1' would count every API call).
  app.use(['/v1/paypal', '/v1/webhooks', '/v1/internal'], limiter(120));
  app.use('/v1', paypalRouter);
  // As-you-type previews are debounced and mostly served by the cache/rules; LLM spend is bounded by those.
  app.use('/v1/agent', limiter(120));
  app.use('/v1', limiter(240), requireAuth, apiRouter);
  app.use('/mcp', limiter(120), mcpRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
  });
  app.use(errorHandler);
  return app;
}
