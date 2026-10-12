import { pino } from 'pino';
import { env, isProd, isTest } from '../config/env.js';

export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.access_token', '*.refresh_token', '*.apiKey', '*.password'],
    censor: '[redacted]',
  },
  ...(isProd || isTest ? {} : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }),
});
