import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { User } from '../src/db/index.js';
import { runReact } from '../src/agent/react.js';
import { ActionRunner } from '../src/agent/runner.js';
import { parseJsonLoose } from '../src/agent/react.js';
import { sanitizeSpec } from '../src/agent/ui/schema.js';
import { lastObservation, ScriptedChatModel, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let user: User;
beforeAll(async () => {
  ctx = await setup();
  user = (await User.findByPk(ctx.login.user.id))!;
});

const context = { screen: 'home' as const, history: [] };

describe('ReAct loop', () => {
  it('reasons, acts through the registry, and renders the confirmation for sensitive actions', async () => {
    const model = new ScriptedChatModel((messages, call) => {
      if (call === 0) return JSON.stringify({ thought: 'Find Ahmed', action: { name: 'find_recipient', input: { name: 'Ahmed' } } });
      if (call === 1) {
        const obs = lastObservation(messages);
        expect(obs.result.name).toBe('Ahmed Khalil');
        return '```json\n' + JSON.stringify({ thought: 'Prepare it', action: { name: 'send_money', input: { recipient: { contactId: obs.result.contactId }, amount: 500, note: 'Rent' } } }) + '\n```';
      }
      const obs = lastObservation(messages);
      expect(obs.status).toBe('needs_confirmation');
      return JSON.stringify({
        thought: 'Show preview',
        final: {
          say: 'Ready. Hold to send.',
          blocks: [{ type: 'confirmation', pendingId: obs.pending.id }, { type: 'transactions', query: { limit: 5 } }],
          entities: [{ text: '500', kind: 'amount' }, { text: 'Ahmed', kind: 'person' }],
        },
      });
    });
    const events: string[] = [];
    const res = await runReact({ model, user, prompt: 'Send 500 to Ahmed for the rent', context, runner: new ActionRunner(user, 'commit'), onEvent: (e) => e.type === 'step' && events.push(e.label) });

    expect(res.steps.map((s) => s.tool).filter(Boolean)).toEqual(['find_recipient', 'send_money']);
    expect(res.pendingIds).toHaveLength(1);
    expect(res.spec.blocks[0]).toMatchObject({ type: 'confirmation', pendingId: res.pendingIds[0] });
    expect(events).toEqual(['Finding the recipient', 'Preparing the transfer']);
  });

  it('inserts the confirmation block if the model forgets it', async () => {
    let pendingId = '';
    const model = new ScriptedChatModel((messages, call) => {
      if (call === 0) return JSON.stringify({ action: { name: 'create_card', input: { label: 'Travel 2' } } });
      pendingId = lastObservation(messages).pending.id;
      return JSON.stringify({ final: { say: 'Your card is created!', blocks: [{ type: 'cards' }] } });
    });
    const res = await runReact({ model, user, prompt: 'new travel card', context, runner: new ActionRunner(user, 'commit') });
    expect(res.spec.blocks[0]).toEqual({ type: 'confirmation', pendingId });
  });

  it('feeds tool errors and invalid UI back to the model for repair', async () => {
    const model = new ScriptedChatModel((messages, call) => {
      if (call === 0) return JSON.stringify({ action: { name: 'get_card', input: { cardId: 'nope' } } });
      if (call === 1) {
        expect(lastObservation(messages).error).toMatch(/Card not found/);
        return JSON.stringify({ final: { blocks: [{ type: 'chart', kind: 'radar' }] } }); // invalid kind
      }
      expect(String(messages.at(-1)!.content)).toContain('UI spec invalid');
      return JSON.stringify({ final: { blocks: [{ type: 'notice', tone: 'error', text: 'That card does not exist.' }] } });
    });
    const res = await runReact({ model, user, prompt: 'show card nope', context, runner: new ActionRunner(user, 'commit') });
    expect(res.spec.blocks).toEqual([{ type: 'notice', tone: 'error', text: 'That card does not exist.' }]);
  });

  it('rejects unknown tools without crashing', async () => {
    const model = new ScriptedChatModel((messages, call) =>
      call === 0
        ? JSON.stringify({ action: { name: 'transfer_everything', input: {} } })
        : JSON.stringify({ final: { blocks: [{ type: 'balance' }] } }),
    );
    const res = await runReact({ model, user, prompt: 'hi', context, runner: new ActionRunner(user, 'commit') });
    expect(res.steps[0]).toMatchObject({ tool: 'transfer_everything', ok: false });
  });
});

describe('agent endpoint (offline planner)', () => {
  it('composes a hydrated transfer preview from one sentence', async () => {
    const res = await request(ctx.app).post('/v1/agent').set(ctx.auth).send({ prompt: 'Send 500 to Ahmed for the rent', screen: 'home' });
    expect(res.status).toBe(200);
    // First the user picks the recipient (preselected: one contact matches), then confirms.
    const [amount, picker] = res.body.spec.blocks;
    expect(amount).toMatchObject({ type: 'amount', value: 500 });
    expect(picker).toMatchObject({ type: 'picker', kind: 'contact', action: 'send_money', input: { amount: 500, note: 'Rent' } });
    const chosen = picker.data.items.find((i: { id: string }) => i.id === picker.data.preselect);
    expect(chosen.title).toBe('Ahmed Khalil');
    expect(res.body.spec.entities.map((e: { kind: string }) => e.kind)).toEqual(['amount', 'person', 'purpose']);

    const run = await request(ctx.app).post('/v1/actions/send_money').set(ctx.auth).send({ input: { ...picker.input, ...chosen.patch } });
    expect(run.body.status).toBe('needs_confirmation');
    expect(run.body.pending.summary).toMatchObject({ amount: 500, confirmLabel: 'Hold to send' });
    expect(run.body.pending.summary.recipient.name).toBe('Ahmed Khalil');
  });

  it('streams steps and the result as SSE', async () => {
    const res = await request(ctx.app).post('/v1/agent/stream').set(ctx.auth).send({ prompt: 'show my spending this week' });
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('event: step');
    const result = JSON.parse(res.text.split('event: result\ndata: ')[1]!.split('\n')[0]!);
    expect(result.spec.blocks.map((b: { type: string }) => b.type)).toEqual(['chart', 'chart']);
    expect(result.spec.blocks[0].data.period).toBe('week');
  });
});

describe('UI contract', () => {
  it('keeps valid blocks and reports invalid ones', () => {
    const { spec, issues } = sanitizeSpec({ blocks: [{ type: 'balance' }, { type: 'nope' }, { type: 'text' }] });
    expect(spec.blocks).toEqual([{ type: 'balance', variant: 'arc' }]);
    expect(issues).toHaveLength(2);
  });

  it('parses JSON wrapped in prose or fences', () => {
    expect(parseJsonLoose('Sure! ```json\n{"a":{"b":"}"}}\n``` done')).toEqual({ a: { b: '}' } });
    expect(parseJsonLoose('no json here')).toBeNull();
  });

  it('serves hydrated default screens and detail dialogs', async () => {
    const home = await request(ctx.app).get('/v1/ui/screen/home').set(ctx.auth);
    expect(home.body.spec.blocks[0].data.week.days).toHaveLength(7);
    const tx = home.body.spec.blocks.find((b: { type: string }) => b.type === 'transactions').data.items[0];
    const detail = await request(ctx.app).get(`/v1/ui/detail/transaction/${tx.id}`).set(ctx.auth);
    expect(detail.body.blocks[0].data.id).toBe(tx.id);
  });

  it('saves and resets a redesigned layout', async () => {
    const spec = { blocks: [{ type: 'balance', variant: 'minimal', data: { leaked: true } }, { type: 'chart', kind: 'donut' }] };
    const saved = await request(ctx.app).put('/v1/ui/layouts/home').set(ctx.auth).send({ spec, instruction: 'minimal' });
    expect(saved.body.saved).toBe(true);
    const home = await request(ctx.app).get('/v1/ui/screen/home').set(ctx.auth);
    expect(home.body.custom).toBe(true);
    expect(home.body.spec.blocks.map((b: { type: string }) => b.type)).toEqual(['balance', 'chart']);
    expect(home.body.spec.blocks[0].data.leaked).toBeUndefined();
    await request(ctx.app).delete('/v1/ui/layouts/home').set(ctx.auth);
    expect((await request(ctx.app).get('/v1/ui/screen/home').set(ctx.auth)).body.custom).toBe(false);
  });
});

describe('MCP server', () => {
  let mcpAuth: { Authorization: string };
  let readOnly: { Authorization: string };
  let readOnlyId: string;
  const rpc = (body: object, auth = mcpAuth) =>
    request(ctx.app).post('/mcp').set(auth).set('Accept', 'application/json, text/event-stream').send(body);
  const parse = (text: string) => JSON.parse(text.includes('data: ') ? text.split('data: ')[1]!.split('\n')[0]! : text);
  const toolNames = async (auth: { Authorization: string }) =>
    parse((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, auth)).text).result.tools.map((t: { name: string }) => t.name) as string[];

  beforeAll(async () => {
    const full = await request(ctx.app).post('/v1/mcp/tokens').set(ctx.auth).send({ name: 'Claude', scopes: ['read', 'propose'] });
    expect(full.status).toBe(201);
    expect(full.body.token).toMatch(/^dpm_/);
    mcpAuth = { Authorization: `Bearer ${full.body.token}` };
    const ro = await request(ctx.app).post('/v1/mcp/tokens').set(ctx.auth).send({ name: 'Reader', scopes: ['read'] });
    readOnly = { Authorization: `Bearer ${ro.body.token}` };
    readOnlyId = ro.body.mcpToken.id;
  });

  it('requires auth, and app session tokens are not accepted', async () => {
    expect((await request(ctx.app).post('/mcp').send({})).status).toBe(401);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, ctx.auth)).status).toBe(401);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { Authorization: 'Bearer dpm_forged' })).status).toBe(401);
  });

  it('rejects browser origins that are not allow-listed (DNS rebinding)', async () => {
    const res = await request(ctx.app).post('/mcp').set(mcpAuth).set('Origin', 'http://evil.example').set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(403);
  });

  it('never stores the token itself, and lists tokens without secrets', async () => {
    const list = await request(ctx.app).get('/v1/mcp/tokens').set(ctx.auth);
    expect(list.body.tokens.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(list.body)).not.toContain(mcpAuth.Authorization.slice(7));
  });

  it('a read-only token only sees read tools, and calls to others fail', async () => {
    const names = await toolNames(readOnly);
    expect(names).toContain('get_balance');
    expect(names).not.toContain('send_money');
    const call = parse((await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_money', arguments: { recipient: { name: 'Sara' }, amount: 1 } } }, readOnly)).text);
    expect(call.result?.isError ?? !!call.error).toBe(true);
  });

  it('revoked tokens stop working immediately', async () => {
    expect((await request(ctx.app).delete(`/v1/mcp/tokens/${readOnlyId}`).set(ctx.auth)).status).toBe(204);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, readOnly)).status).toBe(401);
  });

  it('lists the user\'s actions as tools and keeps the confirmation rule', async () => {
    const list = parse((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).text);
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('send_money');
    expect(list.result.tools.find((t: { name: string }) => t.name === 'send_money').annotations.destructiveHint).toBe(true);

    const call = parse((await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'send_money', arguments: { recipient: { name: 'Sara' }, amount: 1 } } })).text);
    expect(JSON.parse(call.result.content[0].text).status).toBe('needs_confirmation');
  });
});
