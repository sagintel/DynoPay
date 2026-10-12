import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 20_000,
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-test-secret-test-secret-0123456789',
      DATABASE_URL: 'sqlite::memory:',
      ALLOW_DEV_LOGIN: 'true',
      AI_PROVIDER: 'offline',
      GEMINI_API_KEY: '',
      CLOUDFLARE_ACCOUNT_ID: '',
      CLOUDFLARE_API_TOKEN: '',
      PAYPAL_CLIENT_ID: '',
      PAYPAL_CLIENT_SECRET: '',
      CRON_SECRET: 'cron-test-secret',
      LIMIT_PER_TRANSFER: '5000',
      LIMIT_DAILY_OUT: '10000',
    },
  },
});
