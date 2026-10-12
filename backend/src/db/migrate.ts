import { DataTypes, type QueryInterface, type Sequelize } from 'sequelize';
import { logger } from '../lib/logger.js';

/**
 * Ordered, idempotent schema migrations for databases created by an earlier version.
 * `sync()` creates missing tables but never adds columns to existing ones; these do.
 * Each migration runs once and is recorded in `schema_migrations`.
 */
type Migration = { id: string; up: (qi: QueryInterface) => Promise<void> };

async function hasColumn(qi: QueryInterface, table: string, column: string) {
  const desc = await qi.describeTable(table).catch(() => null);
  return !!desc && column in desc;
}

const MIGRATIONS: Migration[] = [
  {
    id: '2026-10-08-users-account-type',
    up: async (qi) => {
      if (!(await hasColumn(qi, 'users', 'account_type'))) {
        await qi.addColumn('users', 'account_type', { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'personal' });
      }
    },
  },
];

export async function runMigrations(sequelize: Sequelize) {
  const qi = sequelize.getQueryInterface();
  await qi.createTable('schema_migrations', {
    id: { type: DataTypes.STRING(80), primaryKey: true },
    applied_at: { type: DataTypes.DATE, allowNull: false },
  }).catch(() => undefined); // already exists
  const [rows] = await sequelize.query('SELECT id FROM schema_migrations');
  const applied = new Set((rows as { id: string }[]).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    await m.up(qi);
    await qi.bulkInsert('schema_migrations', [{ id: m.id, applied_at: new Date() }]);
    logger.info({ migration: m.id }, 'migration applied');
  }
}
