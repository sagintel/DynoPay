import fs from 'node:fs';
import path from 'node:path';
import { Sequelize, type Options } from 'sequelize';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * One connection factory for every supported dialect:
 *   sqlite:./data/dynopay.sqlite   sqlite::memory:
 *   postgres://user:pass@host:5432/db   (requires `pg`)
 *   mysql://user:pass@host:3306/db      (requires `mysql2`)
 */
export function createSequelize(url = env.DATABASE_URL): Sequelize {
  const common: Options = {
    logging: env.LOG_LEVEL === 'trace' ? (sql) => logger.trace(sql) : false,
    define: { underscored: true, timestamps: true },
  };

  if (url.startsWith('sqlite:')) {
    const storage = url.slice('sqlite:'.length) || ':memory:';
    if (storage !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(storage)), { recursive: true });
    const sequelize = new Sequelize({
      ...common,
      dialect: 'sqlite',
      dialectModule: await import('better-sqlite3').then((m) => m.default ?? m),
      storage,
      // better-sqlite3 is synchronous; no busy-retry needed but keep the pragma hook.
    });
    sequelize.addHook('afterConnect', (connection) => {
      const conn = connection as { pragma?: (sql: string) => void };
      conn.pragma?.('foreign_keys = ON');
    });
    return sequelize;
  }

  return new Sequelize(url, {
    ...common,
    pool: { max: 10, min: 0, idle: 10_000 },
    dialectOptions: url.startsWith('postgres') && url.includes('sslmode=require') ? { ssl: { require: true } } : undefined,
  });
}
