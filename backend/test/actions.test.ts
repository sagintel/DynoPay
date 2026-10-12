import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { Account } from '../src/db/index.js';
import { balanceOf, setup } from './helpers.js';

/** Puts the demo account at a known balance (major units). */
const setBalance = (major: number) => Account.update({ balance: Math.round(major * 100) }, { where: { userId: ctx.login.user.id } });

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  ctx = await setup();
});

describe('auth', () => {
  it('rejects requests without a token', async () => {
    const res = await request(ctx.app).get('/v1/me');
    expect(res.status).toBe(401);
  });

  it('returns the profile and rotates refresh tokens', async () => {
    const me = await request(ctx.app).get('/v1/me').set(ctx.auth);
    expect(me.body.email).toBe('demo@dynopay.dev');

    const first = await request(ctx.app).post('/v1/auth/refresh').send({ refreshToken: ctx.login.refreshToken });
    expect(first.status).toBe(200);
    // Re-using the old refresh token is treated as theft and revokes the session family.
    const replay = await request(ctx.app).post('/v1/auth/refresh').send({ refreshToken: ctx.login.refreshToken });
    expect(replay.status).toBe(401);
    // Get a fresh session for the remaining tests.
    const login = await request(ctx.app).post('/v1/auth/dev').send({});
    ctx.auth = { Authorization: `Bearer ${login.body.accessToken}` };
  });
});

describe('reads run freely; every change needs confirmation', () => {
  it('lists transactions with filters', async () => {
    const res = await request(ctx.app).post('/v1/actions/list_transactions').set(ctx.auth).send({ input: { counterparty: 'Sara', limit: 5 } });
    expect(res.body.status).toBe('done');
    expect(res.body.result.items.length).toBeGreaterThan(0);
    expect(res.body.result.items.every((t: { counterparty: { name: string } }) => t.counterparty.name.includes('Sara'))).toBe(true);
  });

  it('card details are a read; freezing waits for the user', async () => {
    const cards = await request(ctx.app).post('/v1/actions/list_cards').set(ctx.auth).send({ input: {} });
    const active = cards.body.result.find((c: { status: string }) => c.status === 'active');
    const details = await request(ctx.app).post('/v1/actions/get_card').set(ctx.auth).send({ input: { cardId: active.id } });
    expect(details.body.status).toBe('done');

    const res = await request(ctx.app).post('/v1/actions/freeze_card').set(ctx.auth).send({ input: { cardId: active.id } });
    expect(res.body.status).toBe('needs_confirmation');
    expect(res.body.pending.summary).toMatchObject({ title: `Freeze ${active.label}?`, confirmLabel: 'Freeze card', style: 'tap' });
    const still = await request(ctx.app).post('/v1/actions/get_card').set(ctx.auth).send({ input: { cardId: active.id } });
    expect(still.body.result.status).toBe('active');

    const confirmed = await request(ctx.app).post(`/v1/pending/${res.body.pending.id}/confirm`).set(ctx.auth);
    expect(confirmed.body).toMatchObject({ status: 'executed', result: { status: 'frozen' } });
  });

  it('every non-read action in the registry is confirm-level', async () => {
    const { ACTIONS } = await import('../src/actions/registry.js');
    const changes = ACTIONS.filter((a) => a.risk !== 'read');
    expect(changes.length).toBeGreaterThan(30);
    for (const a of changes) {
      expect(a.risk, a.name).toBe('confirm');
      expect(typeof a.preview, a.name).toBe('function');
      expect(typeof a.execute, a.name).toBe('function');
      expect(a.run, a.name).toBeUndefined();
    }
  });

  it('validates inputs', async () => {
    const res = await request(ctx.app).post('/v1/actions/send_money').set(ctx.auth).send({ input: { amount: -5 } });
    expect(res.status).toBe(400);
  });
});

describe('sensitive actions require explicit confirmation', () => {
  it('send_money only creates a pending action, confirm executes once', async () => {
    const before = await balanceOf(ctx.app, ctx.auth);
    const proposed = await request(ctx.app)
      .post('/v1/actions/send_money')
      .set(ctx.auth)
      .send({ input: { recipient: { name: 'Ahmed' }, amount: 25.5, note: 'Lunch' } });
    expect(proposed.body.status).toBe('needs_confirmation');
    expect(proposed.body.pending.summary.recipient.name).toBe('Ahmed Khalil');
    expect(proposed.body.pending.summary.style).toBe('hold');
    expect(await balanceOf(ctx.app, ctx.auth)).toBe(before); // nothing moved yet

    const id = proposed.body.pending.id as string;
    const [a, b] = await Promise.all([
      request(ctx.app).post(`/v1/pending/${id}/confirm`).set(ctx.auth),
      request(ctx.app).post(`/v1/pending/${id}/confirm`).set(ctx.auth),
    ]);
    // A concurrent second tap is either rejected (in progress) or replays the result — never a second debit.
    const statuses = [a, b].map((r) => (r.status === 409 ? 'in_progress' : r.body.status)).sort();
    expect(['executed,in_progress', 'executed,executed']).toContain(statuses.join(','));
    expect(await balanceOf(ctx.app, ctx.auth)).toBeCloseTo(before - 25.5, 2); // debited exactly once
    const replay = await request(ctx.app).post(`/v1/pending/${id}/confirm`).set(ctx.auth);
    expect(replay.body.status).toBe('executed');

    const txId = (a.body.result ?? b.body.result).transactionId;
    const tx = await request(ctx.app).post('/v1/actions/get_transaction').set(ctx.auth).send({ input: { transactionId: txId } });
    expect(tx.body.result).toMatchObject({ direction: 'out', amount: 25.5, note: 'Lunch', status: 'completed' });
  });

  it('cancelled actions can no longer be confirmed', async () => {
    const proposed = await request(ctx.app).post('/v1/actions/create_card').set(ctx.auth).send({ input: { label: 'Groceries' } });
    const id = proposed.body.pending.id;
    await request(ctx.app).post(`/v1/pending/${id}/cancel`).set(ctx.auth);
    const confirm = await request(ctx.app).post(`/v1/pending/${id}/confirm`).set(ctx.auth);
    expect(confirm.status).toBe(410);
  });

  it('refuses transfers above the balance or the limits at preview time', async () => {
    await setBalance(1000);
    const tooMuch = await request(ctx.app).post('/v1/actions/send_money').set(ctx.auth).send({ input: { recipient: { name: 'Sara' }, amount: 1500 } });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.message).toMatch(/Insufficient balance/);
    const overLimit = await request(ctx.app).post('/v1/actions/send_money').set(ctx.auth).send({ input: { recipient: { name: 'Sara' }, amount: 6000 } });
    expect(overLimit.status).toBeGreaterThanOrEqual(400);
  });

  it('re-validates at execution time', async () => {
    await setBalance(3000);
    const p1 = await request(ctx.app).post('/v1/actions/send_money').set(ctx.auth).send({ input: { recipient: { name: 'Amina' }, amount: 2000 } });
    const p2 = await request(ctx.app).post('/v1/actions/send_money').set(ctx.auth).send({ input: { recipient: { name: 'Farhan' }, amount: 2000 } });
    const c1 = await request(ctx.app).post(`/v1/pending/${p1.body.pending.id}/confirm`).set(ctx.auth);
    const c2 = await request(ctx.app).post(`/v1/pending/${p2.body.pending.id}/confirm`).set(ctx.auth);
    expect(c1.body.status).toBe('executed');
    expect(c2.body.status).toBe('failed');
    expect(c2.body.error).toMatch(/Insufficient balance/);
    expect(await balanceOf(ctx.app, ctx.auth)).toBeCloseTo(1000, 2);
  });

  it('ambiguous or unknown recipients are reported, not guessed', async () => {
    const res = await request(ctx.app).post('/v1/actions/send_money').set(ctx.auth).send({ input: { recipient: { name: 'Zed' }, amount: 1 } });
    expect(res.status).toBe(404);
  });
});
