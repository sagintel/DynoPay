import crypto from 'node:crypto';
import { Op } from 'sequelize';
import { PendingAction, type User } from '../db/index.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { assertAllowed, getAction, type ConfirmSummary, type ExecuteContext } from './registry.js';
import { tapSummary } from './types.js';

const PENDING_TTL_MS = 10 * 60_000;

export type PendingView = {
  id: string;
  action: string;
  status: string;
  summary: ConfirmSummary;
  /** The proposed input (lets the owner edit a line and re-propose). */
  input: Record<string, unknown>;
  expiresAt: string;
  result: Record<string, unknown> | null;
  error: string | null;
};

const view = (p: PendingAction): PendingView => ({
  id: p.id,
  action: p.type,
  status: p.status,
  summary: p.summary as unknown as ConfirmSummary,
  input: p.payload,
  expiresAt: p.expiresAt.toISOString(),
  result: p.result,
  error: p.error,
});

export type PerformResult =
  | { status: 'done'; action: string; risk: 'read' | 'auto'; result: unknown }
  | { status: 'needs_confirmation'; action: string; risk: 'confirm'; pending: PendingView };

/**
 * Single entry point used by the agent, MCP and REST.
 * Confirm-level actions never execute here: they become a PendingAction.
 */
export async function performAction(user: User, name: string, rawInput: unknown): Promise<PerformResult> {
  const def = getAction(name);
  assertAudience(user, def.audience);
  await assertAllowed(user, def);
  const parsed = def.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw badRequest(`Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`);
  }
  if (def.risk !== 'confirm') {
    const result = await def.run!(user, parsed.data);
    return { status: 'done', action: name, risk: def.risk, result };
  }
  const summary = await def.preview!(user, parsed.data);
  const pending = await PendingAction.create({
    userId: user.id,
    type: name,
    payload: parsed.data as Record<string, unknown>,
    summary: summary as unknown as Record<string, unknown>,
    result: null,
    error: null,
    executedAt: null,
    expiresAt: new Date(Date.now() + PENDING_TTL_MS),
  });
  return { status: 'needs_confirmation', action: name, risk: 'confirm', pending: view(pending) };
}

// ─── Drafts (live previews) ────────────────────────────────────────────────

/**
 * A draft is a would-be action shown while the user is still typing. It is validated and previewed
 * but nothing is stored or executed: pressing its button calls the action for real (and confirm-level
 * actions still go through a pending action). Its id is deterministic so the same sentence re-renders identically.
 */
export type DraftView = Omit<PendingView, 'status' | 'expiresAt'> & { status: 'draft'; risk: 'auto' | 'confirm'; expiresAt: null };

export const draftId = (userId: string, name: string, input: unknown) =>
  'draft_' + crypto.createHash('sha256').update(`${userId}|${name}|${JSON.stringify(input)}`).digest('hex').slice(0, 24);

export async function draftAction(user: User, name: string, rawInput: unknown): Promise<DraftView> {
  const def = getAction(name);
  assertAudience(user, def.audience);
  if (def.risk === 'read') throw badRequest(`${name} is a read action`);
  const parsed = def.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    throw badRequest(`Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`);
  }
  const input = parsed.data as Record<string, unknown>;
  const summary = def.risk === 'confirm' ? await def.preview!(user, input) : tapSummary(name, input);
  return { id: draftId(user.id, name, input), action: name, risk: def.risk, status: 'draft', summary, input, expiresAt: null, result: null, error: null };
}

function assertAudience(user: User, audience: 'all' | 'merchant' = 'all') {
  if (audience === 'merchant' && user.accountType !== 'business') {
    throw forbidden('This is a merchant feature. Sign in with your PayPal business REST credentials, or connect them in Settings.');
  }
}

export async function getPending(user: User, id: string): Promise<PendingView> {
  const p = await PendingAction.findOne({ where: { id, userId: user.id } });
  if (!p) throw notFound('Pending action');
  if (p.status === 'pending' && p.expiresAt.getTime() < Date.now()) {
    p.status = 'expired';
    await p.save();
  }
  return view(p);
}

export async function listPending(user: User): Promise<PendingView[]> {
  const rows = await PendingAction.findAll({
    where: { userId: user.id, status: 'pending', expiresAt: { [Op.gt]: new Date() } },
    order: [['createdAt', 'DESC']],
    limit: 10,
  });
  return rows.map(view);
}

/** Executes a pending action. Only reachable from an explicit user confirmation. */
export async function confirmPending(user: User, id: string, ctx: Omit<ExecuteContext, 'requestId'> = {}): Promise<PendingView> {
  // Atomic claim: protects against double taps and replays.
  const [claimed] = await PendingAction.update(
    { status: 'executing' },
    { where: { id, userId: user.id, status: 'pending', expiresAt: { [Op.gt]: new Date() } } },
  );
  if (claimed !== 1) {
    const current = await getPending(user, id);
    if (current.status === 'executed') return current; // idempotent replay
    if (current.status === 'executing') throw new AppError('conflict', 'Already in progress');
    throw new AppError('expired', current.status === 'expired' ? 'This confirmation expired. Ask again.' : `This action is ${current.status}`);
  }

  const p = (await PendingAction.findByPk(id))!;
  const def = getAction(p.type);
  try {
    // Re-validate at execution time: balances, limits and statuses may have changed.
    assertAudience(user, def.audience);
    await assertAllowed(user, def);
    const input = def.input.parse(p.payload);
    const result = await def.execute!(user, input, { ...ctx, requestId: p.id });
    await p.update({ status: 'executed', result, executedAt: new Date() });
  } catch (err) {
    const message = err instanceof AppError ? err.message : 'Something went wrong. Nothing was charged.';
    if (!(err instanceof AppError)) logger.error({ err, pendingId: id }, 'pending action failed');
    await p.update({ status: 'failed', error: message.slice(0, 280) });
  }
  return view(p);
}

export async function cancelPending(user: User, id: string): Promise<PendingView> {
  await PendingAction.update({ status: 'cancelled' }, { where: { id, userId: user.id, status: 'pending' } });
  return getPending(user, id);
}
