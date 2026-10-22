import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Sequelize, type Options } from 'sequelize';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const require = createRequire(import.meta.url);

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
    // Use better-sqlite3 instead of sqlite3 — it ships prebuilt binaries compatible with older glibc
    // (required for Render free tier which runs Debian with glibc < 2.38).
    // Sequelize's SQLite connection manager does `new this.lib.Database(path)`, so it expects
    // the module to expose a `Database` property — wrap the default export to satisfy that shape.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require('better-sqlite3') as new (...args: unknown[]) => unknown;
    const dialectModule = { Database: BetterSqlite3 };
    const sequelize = new Sequelize({
      ...common,
      dialect: 'sqlite',
      dialectModule,
      storage,
    } as Options);
    sequelize.addHook('afterConnect', (connection) => {
      // better-sqlite3 exposes pragma() directly on the Database instance.
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
