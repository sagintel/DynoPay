import { literal, Op } from 'sequelize';
import { AgentUsage, type User } from '../db/index.js';
import { logger } from '../lib/logger.js';

type Counters = { llmRuns?: number; inputTokens?: number; outputTokens?: number; cacheHits?: number; offlineRuns?: number; tokensSaved?: number };

/** When we have no history yet, assume a typical ReAct run (system prompt + 2–3 steps). */
export const DEFAULT_TOKENS_PER_RUN = 9000;

const today = () => new Date().toISOString().slice(0, 10);

/** Adds to today's counters (atomic increments; never fails the request). */
export async function recordUsage(userId: string, c: Counters): Promise<void> {
  const inc = Object.fromEntries(Object.entries(c).filter(([, v]) => v && v > 0)) as Record<string, number>;
  if (!Object.keys(inc).length) return;
  const day = today();
  const set = Object.fromEntries(Object.entries(inc).map(([k, v]) => [k, literal(`${k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)} + ${Math.round(v)}`)]));
  try {
    // Increment in place; create today's row on first use (a concurrent creator loses the unique race and retries).
    for (let attempt = 0; attempt < 3; attempt++) {
      const [updated] = await AgentUsage.update(set as never, { where: { userId, day } });
      if (updated) return;
      try {
        await AgentUsage.create({ userId, day, ...Object.fromEntries(Object.entries(inc).map(([k, v]) => [k, Math.round(v)])) });
        return;
      } catch {
        /* row created concurrently: loop and increment it */
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'usage accounting failed');
  }
}

export async function averageTokensPerRun(userId: string): Promise<number> {
  const rows = await AgentUsage.findAll({ where: { userId, llmRuns: { [Op.gt]: 0 } }, order: [['day', 'DESC']], limit: 30 });
  const runs = rows.reduce((s, r) => s + r.llmRuns, 0);
  const tokens = rows.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  return runs && tokens ? Math.round(tokens / runs) : DEFAULT_TOKENS_PER_RUN;
}

export async function usageSummary(user: User, days = 30) {
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = await AgentUsage.findAll({ where: { userId: user.id, day: { [Op.gte]: since } }, order: [['day', 'ASC']] });
  const sum = (k: keyof Counters) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  const llmRuns = sum('llmRuns');
  const avoided = sum('cacheHits') + sum('offlineRuns');
  return {
    days,
    llmRuns,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheHits: sum('cacheHits'),
    offlineRuns: sum('offlineRuns'),
    tokensSaved: sum('tokensSaved'),
    /** Share of requests answered without calling an LLM. */
    savingsRate: llmRuns + avoided ? Math.round((avoided / (llmRuns + avoided)) * 100) : 0,
    daily: rows.map((r) => ({ day: r.day, llmRuns: r.llmRuns, tokens: r.inputTokens + r.outputTokens, avoided: r.cacheHits + r.offlineRuns })),
  };
}
