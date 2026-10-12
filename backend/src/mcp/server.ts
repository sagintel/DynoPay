import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Router, type Request } from 'express';
import { authenticate } from '../auth/middleware.js';
import { env } from '../config/env.js';
import type { McpScope, User } from '../db/index.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { handler } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { performAction } from '../actions/perform.js';
import { allowedActions, type ActionDef } from '../actions/registry.js';
import { manifestJson } from '../agent/manifest.js';
import { isMcpToken, verifyMcpToken } from '../services/mcpTokens.js';

/**
 * DynoPay over MCP, locked down:
 *  - only authenticated callers: a scoped, revocable MCP token (dpm_…) the user created in Settings
 *    (app session tokens only when MCP_ALLOW_SESSION_TOKENS is on);
 *  - only authorized tools: the actions THIS user may use (account type + the merchant capabilities
 *    granted by their PayPal app), narrowed by the token's scopes;
 *  - confirm-level tools only prepare a pending action that the user approves in the app;
 *  - browser Origins must be allow-listed (DNS-rebinding protection) and each token is rate limited.
 */
function toolsFor(actions: ActionDef[], scopes: McpScope[]): ActionDef[] {
  return actions.filter((a) => a.risk === 'read' || scopes.includes('propose'));
}

function buildServer(user: User, tools: ActionDef[]): McpServer {
  const server = new McpServer({ name: 'dynopay', version: '1.0.0' });
  const allowed = new Set(tools.map((t) => t.name));

  for (const action of tools) {
    server.registerTool(
      action.name,
      {
        description:
          action.risk === 'read'
            ? action.description
            : `${action.description} Requires the user to approve it in the DynoPay app; returns a pending action.`,
        inputSchema: action.input,
        annotations: {
          readOnlyHint: action.risk === 'read',
          destructiveHint: action.risk !== 'read',
          openWorldHint: false,
        },
      },
      async (input: unknown) => {
        try {
          if (!allowed.has(action.name)) throw forbidden('Not allowed');
          const result = await performAction(user, action.name, input);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (err) {
          const message = err instanceof AppError ? err.message : 'Action failed';
          return { isError: true, content: [{ type: 'text', text: message }] };
        }
      },
    );
  }

  server.registerResource(
    'manifest',
    'dynopay://manifest',
    { title: 'DynoPay app manifest', description: 'Actions you may use, risk levels, layout slots and UI vocabulary', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(manifestJson(user, tools)) }] }),
  );

  return server;
}

// ─── Caller checks ──────────────────────────────────────────────────────────

const allowedOrigins = new Set(
  [new URL(env.PUBLIC_URL).origin, ...env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)],
);

/** Browsers always send Origin; a page on another (or rebound) host must not reach the user's tools. */
function assertOrigin(req: Request) {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) throw forbidden('Origin not allowed');
}

const windows = new Map<string, number[]>();
function rateLimit(key: string) {
  const now = Date.now();
  const recent = (windows.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= env.MCP_RATE_PER_MINUTE) throw new AppError('rate_limited', 'Too many MCP calls. Try again in a minute.');
  recent.push(now);
  windows.set(key, recent);
  if (windows.size > 10_000) windows.clear();
}

async function caller(req: Request): Promise<{ user: User; scopes: McpScope[]; key: string }> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw unauthorized('An MCP token is required. Create one in DynoPay → Settings → Connected agents.');
  if (isMcpToken(token)) {
    const { user, tokenId, scopes } = await verifyMcpToken(token);
    return { user, scopes, key: tokenId };
  }
  if (!env.MCP_ALLOW_SESSION_TOKENS) throw unauthorized('Use an MCP token (dpm_…). App session tokens are not accepted here.');
  const { user, sessionId } = await authenticate(header);
  return { user, scopes: ['read', 'propose'], key: sessionId };
}

export const mcpRouter = Router();

// Stateless Streamable HTTP: a fresh server per request, built for exactly this caller's permissions.
mcpRouter.post(
  '/',
  handler(async (req, res) => {
    assertOrigin(req);
    const { user, scopes, key } = await caller(req);
    rateLimit(key);
    const tools = toolsFor(await allowedActions(user), scopes);
    const server = buildServer(user, tools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    if (req.body?.method === 'tools/call') logger.info({ userId: user.id, tool: req.body?.params?.name }, 'mcp tool call');
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }),
);

const notAllowed = (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) =>
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null });
mcpRouter.get('/', notAllowed);
mcpRouter.delete('/', notAllowed);
