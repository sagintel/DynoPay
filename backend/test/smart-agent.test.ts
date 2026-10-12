import type { BaseMessage } from '@langchain/core/messages';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { PendingAction, PlanCache, User } from '../src/db/index.js';
import { runAgent } from '../src/agent/index.js';
import { ScriptedChatModel, setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let user: User;

beforeAll(async () => {
  ctx = await setup();
  user = (await User.findByPk(ctx.login.user.id))!;
});

const lastText = (messages: BaseMessage[]) => String(messages.at(-1)?.content ?? '');
const observationOf = (messages: BaseMessage[]) => JSON.parse(lastText(messages).replace(/^Observation:\s*/, ''));

/** A stand-in LLM that understands "send <amount> to <name> for <note>" through the ReAct protocol. */
function sendingModel() {
  return new ScriptedChatModel((messages, call) => {
    const request = messages.map((m) => String(m.content)).reverse().find((c) => c.includes('REQUEST '))!;
    const [, amount, name, note] = request.match(/REQUEST "send (\d+) to (\w+) for (\w+)"/i)!;
    const step = messages.filter((m) => String(m.content).startsWith('Observation:')).length;
    if (step === 0) return JSON.stringify({ thought: 'find', action: { name: 'find_recipient', input: { name } } });
    if (step === 1) {
      const obs = observationOf(messages);
      return JSON.stringify({ action: { name: 'send_money', input: { recipient: { contactId: obs.result.contactId }, amount: Number(amount), note } } });
    }
    const obs = observationOf(messages);
    const id = obs.pending?.id ?? obs.draftId;
    void call;
    return JSON.stringify({ final: { say: `Ready to send ${amount} to ${name}.`, blocks: [{ type: 'confirmation', pendingId: id }, { type: 'transactions', query: { limit: 3 } }] } });
  });
}

async function setSettings(patch: Record<string, unknown>) {
  await request(ctx.app).patch('/v1/me').set(ctx.auth).send({ settings: patch });
  await user.reload();
}

describe('plan cache', () => {
  it('replays a similar sentence with new values without calling the LLM', async () => {
    await setSettings({ preferOffline: false, cacheMode: 'similar', cacheMaxReuse: 2 });
    const model = sendingModel();
    const deps = { provider: 'gemini' as const, modelFactory: () => model };

    const first = await runAgent(user, { prompt: 'Send 50 to Sara for dinner', screen: 'home' }, undefined, { deps });
    expect(first.engine).toBe('llm');
    const llmCalls = model.calls.length;
    expect(llmCalls).toBe(3);
    expect(await PlanCache.count({ where: { userId: user.id } })).toBe(1);

    const second = await runAgent(user, { prompt: 'send 120 to Ahmed for rent', screen: 'home' }, undefined, { deps });
    expect(second).toMatchObject({ engine: 'cache', cache: 'similar' });
    expect(model.calls.length).toBe(llmCalls); // no tokens spent
    const confirmation = second.spec.blocks[0] as { data: { summary: { amount: number; recipient: { name: string }; lines: { label: string; value: string }[] } } };
    expect(confirmation.data.summary.amount).toBe(120);
    expect(confirmation.data.summary.recipient.name).toBe('Ahmed Khalil');
    expect(confirmation.data.summary.lines.find((l) => l.label === 'Note')?.value).toBe('rent');
    expect(second.spec.say).toBe('Ready to send 120 to ahmed.');
    expect(second.spec.entities.map((e) => e.kind)).toEqual(['amount', 'person', 'purpose']);
  });

  it('refreshes with the LLM after cacheMaxReuse hits, then serves the new plan again', async () => {
    const model = sendingModel();
    const deps = { provider: 'gemini' as const, modelFactory: () => model };
    const third = await runAgent(user, { prompt: 'send 30 to Amina for lunch', screen: 'home' }, undefined, { deps });
    expect(third.engine).toBe('cache'); // 2nd reuse (limit 2)
    const fourth = await runAgent(user, { prompt: 'send 40 to Farhan for taxi', screen: 'home' }, undefined, { deps });
    expect(fourth.engine).toBe('llm'); // limit reached → refreshed
    expect(model.calls.length).toBe(3);
    const row = await PlanCache.findOne({ where: { userId: user.id } });
    expect(row!.hits).toBe(0); // reset with the fresh plan
    const fifth = await runAgent(user, { prompt: 'send 10 to Sara for coffee', screen: 'home' }, undefined, { deps });
    expect(fifth.engine).toBe('cache');
  });

  it('never caches or serves follow-ups that depend on context', async () => {
    const model = sendingModel();
    const res = await runAgent(user, { prompt: 'show that again as a chart', screen: 'home' }, undefined, { deps: { provider: 'offline', modelFactory: () => model } });
    expect(res.engine).not.toBe('cache');
  });

  it('cache off always uses the engines', async () => {
    await setSettings({ cacheMode: 'off', preferOffline: false });
    const model = sendingModel();
    const res = await runAgent(user, { prompt: 'Send 50 to Sara for dinner', screen: 'home' }, undefined, { deps: { provider: 'gemini', modelFactory: () => model } });
    expect(res.engine).toBe('llm');
    await setSettings({ cacheMode: 'similar', preferOffline: true });
  });
});

describe('live preview (as-you-type) has no side effects', () => {
  it('drafts instead of pending actions, and pressing it goes through confirmation', async () => {
    const pendingBefore = await PendingAction.count();
    const res = await request(ctx.app).post('/v1/agent').set(ctx.auth).send({ prompt: 'freeze my everyday card', mode: 'preview' });
    const [draft] = res.body.spec.blocks;
    expect(draft.pendingId).toMatch(/^draft_/);
    expect(draft.draft.action).toBe('freeze_card');
    expect(draft.data).toMatchObject({ status: 'draft', summary: { confirmLabel: 'Freeze card' } });
    expect(await PendingAction.count()).toBe(pendingBefore);
    const card = await request(ctx.app).post('/v1/actions/get_card').set(ctx.auth).send({ input: draft.draft.input });
    expect(card.body.result.status).toBe('active');

    // The same draft re-hydrates statelessly (e.g. pull to refresh).
    const again = await request(ctx.app).post('/v1/ui/hydrate').set(ctx.auth).send({ spec: { version: 1, blocks: [{ type: 'confirmation', pendingId: draft.pendingId, draft: draft.draft }] } });
    expect(again.body.spec.blocks[0].data.status).toBe('draft');
  });

  it('renders only what is known while typing, and nothing for unclear text', async () => {
    const partial = await request(ctx.app).post('/v1/agent').set(ctx.auth).send({ prompt: 'Send 500 to', mode: 'preview' });
    expect(partial.body.spec.blocks.map((b: { type: string }) => b.type)).toEqual(['amount', 'contacts', 'transactions']);
    expect(partial.body.spec.blocks[0].value).toBe(500);
    const unclear = await request(ctx.app).post('/v1/agent').set(ctx.auth).send({ prompt: 'qwerty zxc', mode: 'preview' });
    expect(unclear.body.engine).toBe('none');
    expect(unclear.body.spec.blocks).toEqual([]);
    expect(unclear.body.conversationId).toBeNull(); // previews never write memory
  });
});

describe('charts: every kind is reachable', () => {
  const ask = async (prompt: string) => (await request(ctx.app).post('/v1/agent').set(ctx.auth).send({ prompt })).body.spec.blocks[0];

  it.each([
    ['show my spending as a pie', 'pie'],
    ['spending breakdown this month', 'donut'],
    ['top spending categories', 'hbar'],
    ['spending trend this month', 'line'],
    ['spending as an area chart', 'area'],
    ['spending heatmap this month', 'heatmap'],
    ['spending sparkline', 'sparkline'],
    ['spending by day as bars', 'bar'],
    ['spending progress by category', 'progress'],
  ])('"%s" → %s', async (prompt, kind) => {
    const block = await ask(prompt);
    expect(block.type).toBe('chart');
    expect(block.kind).toBe(kind);
    expect(block.data.buckets.length).toBeGreaterThan(0);
  });

  it('in vs out is two aligned series', async () => {
    const block = await ask('compare income vs spending this month');
    expect(block.kind).toBe('grouped');
    expect(block.data.series.map((s: { name: string }) => s.name)).toEqual(['Spent', 'Received']);
    expect(block.data.series[0].buckets.length).toBe(block.data.series[1].buckets.length);
  });

  it.each(['day', 'week', 'month', 'category'])('buckets add up to the totals (groupBy %s)', async (groupBy) => {
    const res = await request(ctx.app).post('/v1/actions/spending_summary').set(ctx.auth).send({ input: { period: '90d', groupBy, direction: 'both' } });
    const r = res.body.result;
    for (const s of r.series) {
      const sum = s.buckets.reduce((acc: number, b: { amount: number }) => acc + b.amount, 0);
      expect(Math.round(sum * 100)).toBe(Math.round(s.total * 100));
    }
  });

  it('a budget becomes a gauge with its target', async () => {
    const block = await ask('spending this month against a budget of 900');
    expect(block).toMatchObject({ kind: 'gauge', data: { target: 900 } });
    const vs = await ask('my spending this month vs a budget of 700');
    expect(vs).toMatchObject({ kind: 'gauge', title: 'Spending vs budget', data: { target: 700, direction: 'out' } });
  });

  it('time series are continuous (zero days included)', async () => {
    const block = await ask('spending heatmap this month');
    const today = new Date();
    expect(block.data.buckets.length).toBe(today.getDate());
  });

  it('the preferred chart style applies only where the data fits', async () => {
    await setSettings({ design: { chartStyle: 'line' } });
    const time = await ask('spending by day as bars');
    expect(time.kind).toBe('line'); // time series → preferred line
    const share = await ask('show my spending as a pie');
    expect(share.kind).toBe('pie'); // categories can't be a line → unchanged
    await setSettings({ design: { chartStyle: 'auto' } });
  });
});

describe('usage & settings', () => {
  it('reports LLM runs, cache hits and tokens saved', async () => {
    const res = await request(ctx.app).get('/v1/agent/usage').set(ctx.auth);
    expect(res.body.usage.llmRuns).toBeGreaterThanOrEqual(3);
    expect(res.body.usage.cacheHits).toBeGreaterThanOrEqual(3);
    expect(res.body.cache.plans).toBeGreaterThan(0);
  });

  it('counts on-device answers as avoided LLM calls when an LLM is configured', async () => {
    const before = (await request(ctx.app).get('/v1/agent/usage').set(ctx.auth)).body.usage;
    const model = sendingModel();
    const res = await runAgent(user, { prompt: 'show my spending as a pie', screen: 'home' }, undefined, { deps: { provider: 'gemini', modelFactory: () => model } });
    expect(res.engine).toBe('offline');
    expect(model.calls.length).toBe(0);
    const after = (await request(ctx.app).get('/v1/agent/usage').set(ctx.auth)).body.usage;
    expect(after.offlineRuns).toBe(before.offlineRuns + 1);
    expect(after.tokensSaved).toBeGreaterThan(before.tokensSaved);
  });

  it('stores the design brief and toggles it; invalid values are rejected', async () => {
    const ok = await request(ctx.app).patch('/v1/me').set(ctx.auth).send({ settings: { design: { enabled: true, brief: 'Minimal, big numbers, no emojis', accent: 'ocean' } } });
    expect(ok.body.settings.design).toMatchObject({ enabled: true, accent: 'ocean', density: 'comfortable' });
    const bad = await request(ctx.app).patch('/v1/me').set(ctx.auth).send({ settings: { design: { accent: 'neon' } } });
    expect(bad.status).toBe(400);
    const cleared = await request(ctx.app).delete('/v1/agent/cache').set(ctx.auth);
    expect(cleared.body.cleared).toBeGreaterThan(0);
  });
});
