import { createApp } from './app.js';
import { env } from './config/env.js';
import { closeDatabase, connectDatabase } from './db/index.js';
import { pickProvider } from './agent/llm.js';
import { paypalConfigured } from './paypal/client.js';
import { logger } from './lib/logger.js';

async function main() {
  await connectDatabase();
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, ai: pickProvider(), paypal: paypalConfigured() ? env.PAYPAL_ENV : 'not configured', devLogin: env.ALLOW_DEV_LOGIN },
      `DynoPay API listening on ${env.PUBLIC_URL}`,
    );
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void closeDatabase().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
