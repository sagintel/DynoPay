import crypto from 'node:crypto';
import { Op } from 'sequelize';
import { McpToken, User, type McpScope } from '../db/index.js';
import { AppError, notFound, unauthorized } from '../lib/errors.js';

const PREFIX = 'dpm_';
const MAX_TOKENS = 10;
const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export type McpTokenView = {
  id: string;
  name: string;
  hint: string;
  scopes: McpScope[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

const view = (t: McpToken): McpTokenView => ({
  id: t.id,
  name: t.name,
  hint: t.hint,
  scopes: t.scopes,
  expiresAt: t.expiresAt?.toISOString() ?? null,
  lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
  createdAt: t.createdAt.toISOString(),
});

export const isMcpToken = (token: string) => token.startsWith(PREFIX);

/** Creates a token; the secret is returned once and only its hash is kept. */
export async function createMcpToken(user: User, input: { name: string; scopes: McpScope[]; days: number | null }) {
  const active = await McpToken.count({ where: { userId: user.id, revokedAt: null } });
  if (active >= MAX_TOKENS) throw new AppError('limit_exceeded', `You can have up to ${MAX_TOKENS} MCP tokens. Revoke one first.`);
  const secret = `${PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const row = await McpToken.create({
    userId: user.id,
    name: input.name,
    tokenHash: hash(secret),
    hint: `${secret.slice(0, 8)}…${secret.slice(-4)}`,
    scopes: [...new Set(input.scopes)],
    expiresAt: input.days ? new Date(Date.now() + input.days * 86_400_000) : null,
    revokedAt: null,
    lastUsedAt: null,
  });
  return { token: secret, mcpToken: view(row) };
}

export async function listMcpTokens(user: User): Promise<McpTokenView[]> {
  const rows = await McpToken.findAll({
    where: { userId: user.id, revokedAt: null, [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }] },
    order: [['createdAt', 'DESC']],
  });
  return rows.map(view);
}

export async function revokeMcpToken(user: User, id: string): Promise<void> {
  const row = await McpToken.findOne({ where: { id, userId: user.id, revokedAt: null } });
  if (!row) throw notFound('Token');
  await row.update({ revokedAt: new Date() });
}

/** Resolves a bearer MCP token to its user and scopes, or throws 401. */
export async function verifyMcpToken(token: string): Promise<{ user: User; tokenId: string; scopes: McpScope[] }> {
  const row = await McpToken.findOne({ where: { tokenHash: hash(token) } });
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt <= new Date())) throw unauthorized('This MCP token is invalid, expired or revoked');
  const user = await User.findByPk(row.userId);
  if (!user) throw unauthorized('This MCP token is invalid, expired or revoked');
  // Throttled bookkeeping (at most once a minute) so the list shows when a token was last used.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) void row.update({ lastUsedAt: new Date() }).catch(() => undefined);
  return { user, tokenId: row.id, scopes: row.scopes };
}
