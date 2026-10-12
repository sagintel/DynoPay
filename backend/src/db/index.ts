import type { Sequelize, Transaction as SqlTx } from 'sequelize';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { createSequelize } from './sequelize.js';
import { runMigrations } from './migrate.js';
import { initModels } from './models.js';

export * from './models.js';

let instance: Sequelize | null = null;

export function db(): Sequelize {
  if (!instance) throw new Error('Database not initialised. Call connectDatabase() first.');
  return instance;
}

export async function connectDatabase(url = env.DATABASE_URL): Promise<Sequelize> {
  if (instance) return instance;
  const sequelize = createSequelize(url);
  initModels(sequelize);
  await sequelize.authenticate();
  const sqlite = sequelize.getDialect() === 'sqlite';
  if (sqlite) await sequelize.query('PRAGMA journal_mode = WAL;');
  // `sync()` creates missing tables. `alter` migrates columns in place (dev only). On SQLite, alter
  // rebuilds tables (drop + recreate), so foreign keys must be off or ON DELETE CASCADE wipes child rows.
  if (sqlite) await sequelize.query('PRAGMA foreign_keys = OFF;');
  await sequelize.sync({ alter: env.DB_SYNC_ALTER });
  await runMigrations(sequelize);
  if (sqlite) await sequelize.query('PRAGMA foreign_keys = ON;');
  logger.info({ dialect: sequelize.getDialect() }, 'database ready');
  instance = sequelize;
  return sequelize;
}

export async function closeDatabase(): Promise<void> {
  await instance?.close();
  instance = null;
}

let sqliteQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs `fn` in a DB transaction. Postgres/MySQL handle concurrency with row locks
 * (our balance UPDATEs are conditional). SQLite allows a single writer, so write
 * transactions are queued in-process instead of failing with SQLITE_BUSY.
 * Never call withTx from inside another withTx callback (pass the transaction down instead).
 */
export function withTx<T>(fn: (t: SqlTx) => Promise<T>): Promise<T> {
  const sequelize = db();
  if (sequelize.getDialect() !== 'sqlite') return sequelize.transaction((t) => fn(t));
  const run = sqliteQueue.then(() => sequelize.transaction((t) => fn(t)));
  sqliteQueue = run.catch(() => undefined);
  return run;
}
