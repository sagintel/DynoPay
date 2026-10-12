import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  APP_SCHEME: z.string().min(1).default('dynopay'),
  CORS_ORIGINS: z.string().default(''),
  /** Accept the app's own session tokens on /mcp (off: only scoped MCP tokens). */
  MCP_ALLOW_SESSION_TOKENS: bool.default(false),
  /** Calls per minute per MCP token. */
  MCP_RATE_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1).default('sqlite:./data/dynopay.sqlite'),
  DB_SYNC_ALTER: bool.default(false),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  ALLOW_DEV_LOGIN: bool.default(false),

  PAYPAL_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYPAL_CLIENT_ID: z.string().default(''),
  PAYPAL_CLIENT_SECRET: z.string().default(''),
  PAYPAL_WEBHOOK_ID: z.string().default(''),
  DEFAULT_CURRENCY: z.string().length(3).default('USD'),
  /** 32 bytes, base64. Encrypts merchant REST API secrets at rest. Required in production. */
  CREDENTIALS_ENCRYPTION_KEY: z.string().default(''),

  AI_PROVIDER: z.enum(['gemini', 'cloudflare', 'offline']).default('gemini'),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  CLOUDFLARE_ACCOUNT_ID: z.string().default(''),
  CLOUDFLARE_API_TOKEN: z.string().default(''),
  CLOUDFLARE_MODEL: z.string().default('@cf/openai/gpt-oss-120b'),
  AGENT_MAX_STEPS: z.coerce.number().int().min(1).max(20).default(8),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(5000).default(45000),

  LIMIT_PER_TRANSFER: z.coerce.number().positive().default(5000),
  LIMIT_DAILY_OUT: z.coerce.number().positive().default(10000),
  CRON_SECRET: z.string().default(''),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    if (env.JWT_SECRET.startsWith('change-me')) throw new Error('Set a real JWT_SECRET in production.');
    if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new Error('PayPal credentials are required in production.');
    // Dev login is never available in production, whatever the flag says.
    env.ALLOW_DEV_LOGIN = false;
  }
  return env;
}

export const env = load();
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
