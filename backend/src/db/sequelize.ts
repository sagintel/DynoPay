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
      storage,
      retry: { match: [/SQLITE_BUSY/], max: 5 },
    });
    sequelize.addHook('afterConnect', (connection) => {
      const conn = connection as { configure?: (option: string, value: number) => void; run?: (sql: string) => void };
      conn.configure?.('busyTimeout', 5000);
      conn.run?.('PRAGMA foreign_keys = ON;');
    });
    return sequelize;
  }

  return new Sequelize(url, {
    ...common,
    pool: { max: 10, min: 0, idle: 10_000 },
    dialectOptions: url.startsWith('postgres')
      ? { ssl: { require: true, rejectUnauthorized: false } }
      : undefined,
  });
}
