import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Personal accounts end to end against a fake PayPal REST API (the platform app):
 * Log in with PayPal (OIDC), wallet top-ups (Orders v2 + capture + webhook), payouts to any email
 * (Payouts + reconciliation). The platform credentials are set before the app modules load.
 */
process.env.PAYPAL_CLIENT_ID = 'PLATFORMclientID0123456789abcdefghij';
process.env.PAYPAL_CLIENT_SECRET = 'PLATFORMsecret0123456789abcdefghijklm';
process.env.PAYPAL_WEBHOOK_ID = 'WH-TEST-1';

type Ctx = Awaited<ReturnType<typeof import('./helpers.js')['setup']>>;
let ctx: Ctx;
let balanceOf: typeof import('./helpers.js')['balanceOf'];
const realFetch = globalThis.fetch;
const calls: { method: string; path: string; body: any; headers: Record<string, string> }[] = [];
const orders = new Map<string, { amount: string; currency: string; customId: string; status: string }>();
const payoutStatus = new Map<string, string>();
let scopes = ['openid', 'https://uri.paypal.com/services/payments/payment/authcapture', 'https://uri.paypal.com/payments/payouts'];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const basic = 'Basic ' + Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');

async function fakePayPal(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== 'api-m.sandbox.paypal.com') return realFetch(input, init);
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  const raw = typeof init.body === 'string' ? init.body : '';
  const body = raw.startsWith('{') ? JSON.parse(raw) : raw;
  calls.push({ method, path: url.pathname, body, headers });

  if (url.pathname === '/v1/oauth2/token') {
    if (headers.authorization !== basic) return json(401, { error: 'invalid_client' });
    const form = new URLSearchParams(raw);
    if (form.get('grant_type') === 'authorization_code') {
      return form.get('code') === 'good-code' ? json(200, { access_token: 'USER_TOKEN', expires_in: 3600 }) : json(400, { error: 'invalid_grant', error_description: 'Code expired' });
    }
    return json(200, { access_token: 'APP_TOKEN', expires_in: 32400, app_id: 'APP-PLATFORM', scope: scopes.join(' ') });
  }
  if (url.pathname === '/v1/identity/oauth2/userinfo') {
    if (headers.authorization !== 'Bearer USER_TOKEN') return json(401, { error: 'invalid_token' });
    return json(200, { user_id: 'https://www.paypal.com/webapps/auth/identity/user/LIPP123', name: 'Nadia Okafor', payer_id: 'PAYERNADIA', verified_account: 'true', emails: [{ value: 'Nadia@Example.com', primary: true, confirmed: true }] });
  }
  if (headers.authorization !== 'Bearer APP_TOKEN') return json(401, { error: 'invalid_token' });

  if (url.pathname === '/v2/checkout/orders' && method === 'POST') {
    const id = `ORDER${orders.size + 1}`;
    const unit = body.purchase_units[0];
    orders.set(id, { amount: unit.amount.value, currency: unit.amount.currency_code, customId: unit.custom_id, status: 'PAYER_ACTION_REQUIRED' });
    return json(201, { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }] });
  }
  const capture = url.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/);
  if (capture && method === 'POST') {
    const o = orders.get(capture[1]!);
    if (!o) return json(404, { name: 'RESOURCE_NOT_FOUND', message: 'Order not found' });
    if (o.status === 'NOT_APPROVED') return json(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED', description: 'Payer has not yet approved the Order for payment.' }] });
    o.status = 'COMPLETED';
    return json(201, { id: capture[1], status: 'COMPLETED', purchase_units: [{ custom_id: o.customId, payments: { captures: [{ id: `CAP-${capture[1]}`, status: 'COMPLETED', amount: { value: o.amount, currency_code: o.currency } }] } }] });
  }
  if (url.pathname === '/v1/payments/payouts' && method === 'POST') {
    const batch = `BATCH-${body.sender_batch_header.sender_batch_id.slice(0, 8)}`;
    payoutStatus.set(batch, 'PENDING');
    return json(201, { batch_header: { payout_batch_id: batch, batch_status: 'PENDING' } });
  }
  const payout = url.pathname.match(/^\/v1\/payments\/payouts\/([^/]+)$/);
  if (payout) return json(200, { batch_header: { payout_batch_id: payout[1], batch_status: 'SUCCESS' }, items: [{ payout_item_id: 'ITEM1', transaction_status: payoutStatus.get(payout[1]!) ?? 'PENDING', payout_item: {} }] });
  if (url.pathname === '/v1/notifications/verify-webhook-signature') return json(200, { verification_status: headers['x-test-forged'] ? 'FAILURE' : 'SUCCESS' });
  return json(404, { name: 'RESOURCE_NOT_FOUND', message: `No fake for ${method} ${url.pathname}` });
}

beforeAll(async () => {
  vi.stubGlobal('fetch', fakePayPal);
  const helpers = await import('./helpers.js');
  balanceOf = helpers.balanceOf;
  ctx = await helpers.setup();
});
afterAll(() => vi.unstubAllGlobals());

const confirm = async (pendingId: string) => request(ctx.app).post(`/v1/pending/${pendingId}/confirm`).set(ctx.auth);

describe('PayPal status', () => {
  it('reports what the platform app can do', async () => {
    const res = await request(ctx.app).get('/v1/paypal/status?refresh=1').set(ctx.auth);
    expect(res.body.platform).toMatchObject({ configured: true, reachable: true, environment: 'sandbox', features: { topUps: true, payouts: true, webhooks: true } });
    expect(res.body.personal).toMatchObject({ canTopUp: true, canPayAnyEmail: true });
  });
});

describe('Log in with PayPal (personal)', () => {
  it('runs the OIDC round trip and hands the app a one-time code, never tokens in URLs', async () => {
    const start = await request(ctx.app).get('/v1/auth/paypal/start').query({ redirect: 'dynopay://auth' });
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.location!);
    expect(authorize.origin).toBe('https://www.sandbox.paypal.com');
    expect(authorize.searchParams.get('scope')).toContain('openid');
    const state = authorize.searchParams.get('state')!;

    const callback = await request(ctx.app).get('/v1/auth/paypal/callback').query({ code: 'good-code', state });
    expect(callback.status).toBe(200);
    const handoff = callback.text.match(/dynopay:\/\/auth\?code=([\w-]+)/);
    expect(handoff).toBeTruthy();
    expect(callback.text).not.toContain('USER_TOKEN');

    const exchange = await request(ctx.app).post('/v1/auth/exchange').send({ code: handoff![1] });
    expect(exchange.status).toBe(200);
    expect(exchange.body.user).toMatchObject({ email: 'nadia@example.com', name: 'Nadia Okafor', paypalLinked: true, accountType: 'personal' });
    // One-time: the same code can't be used twice, nor the state.
    expect((await request(ctx.app).post('/v1/auth/exchange').send({ code: handoff![1] })).status).toBeGreaterThanOrEqual(400);
    expect((await request(ctx.app).get('/v1/auth/paypal/callback').query({ code: 'good-code', state })).status).toBe(400);
  });

  it('a denied or expired PayPal code signs nobody in', async () => {
    const start = await request(ctx.app).get('/v1/auth/paypal/start').query({ redirect: 'dynopay://auth' });
    const state = new URL(start.headers.location!).searchParams.get('state')!;
    const res = await request(ctx.app).get('/v1/auth/paypal/callback').query({ code: 'bad-code', state });
    expect(res.status).toBe(400);
    expect(res.text).toContain('dynopay://auth?error=');
  });
});

describe('top-up from PayPal (Orders v2)', () => {
  it('confirm → approve in PayPal → capture credits the wallet exactly once (capture and webhook race)', async () => {
    const before = await balanceOf(ctx.app, ctx.auth);
    const prepared = await request(ctx.app).post('/v1/actions/top_up').set(ctx.auth).send({ input: { amount: 25 } });
    expect(prepared.body.status).toBe('needs_confirmation');
    const done = await confirm(prepared.body.pending.id);
    expect(done.body.status).toBe('executed');
    const { orderId, approveUrl } = done.body.result;
    expect(approveUrl).toContain(orderId);
    const order = calls.find((c) => c.path === '/v2/checkout/orders')!;
    expect(order.headers['paypal-request-id']).toBeTruthy();
    expect(order.body.purchase_units[0].amount).toEqual({ currency_code: 'USD', value: '25.00' });

    const [a, b] = await Promise.all([
      request(ctx.app).post(`/v1/topups/${orderId}/capture`).set(ctx.auth),
      request(ctx.app).post(`/v1/topups/${orderId}/capture`).set(ctx.auth),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    // The webhook for the same capture arrives too: still credited once.
    await request(ctx.app)
      .post('/v1/webhooks/paypal')
      .send({ id: 'WH1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: `CAP-${orderId}`, amount: { value: '25.00', currency_code: 'USD' }, supplementary_data: { related_ids: { order_id: orderId } } } });
    await new Promise((r) => setTimeout(r, 150));
    expect(await balanceOf(ctx.app, ctx.auth)).toBeCloseTo(before + 25, 2);
  });

  it('an order the user did not approve credits nothing', async () => {
    const before = await balanceOf(ctx.app, ctx.auth);
    const prepared = await request(ctx.app).post('/v1/actions/top_up').set(ctx.auth).send({ input: { amount: 40 } });
    const { orderId } = (await confirm(prepared.body.pending.id)).body.result;
    orders.get(orderId)!.status = 'NOT_APPROVED';
    const res = await request(ctx.app).post(`/v1/topups/${orderId}/capture`).set(ctx.auth);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not yet approved/i);
    expect(await balanceOf(ctx.app, ctx.auth)).toBeCloseTo(before, 2);
  });
});

describe('pay anyone by email (Payouts)', () => {
  const sendTo = async (email: string, amount: number) => {
    const prepared = await request(ctx.app).post('/v1/actions/send_money').set(ctx.auth).send({ input: { recipient: { email }, amount, note: 'Thanks' } });
    expect(prepared.body.status).toBe('needs_confirmation');
    expect(JSON.stringify(prepared.body.pending.summary)).toContain('via PayPal');
    return (await confirm(prepared.body.pending.id)).body;
  };

  it('reserves the money, pays out, and completes when PayPal reports success', async () => {
    const before = await balanceOf(ctx.app, ctx.auth);
    const done = await sendTo('friend@example.org', 10);
    expect(done.status).toBe('executed');
    expect(await balanceOf(ctx.app, ctx.auth)).toBeCloseTo(before - 10, 2);
    const payout = calls.filter((c) => c.path === '/v1/payments/payouts').at(-1)!;
    expect(payout.body.items[0]).toMatchObject({ recipient_type: 'EMAIL', receiver: 'friend@example.org', amount: { value: '10.00', currency: 'USD' } });

    const batch = [...payoutStatus.keys()].at(-1)!;
    payoutStatus.set(batch, 'SUCCESS');
    const sync = await request(ctx.app).post('/v1/internal/sync-payouts').set('X-Cron-Secret', 'cron-test-secret');
    expect(sync.body.synced).toBeGreaterThanOrEqual(1);
    const tx = await request(ctx.app).post('/v1/actions/get_transaction').set(ctx.auth).send({ input: { transactionId: done.result.transactionId } });
    expect(tx.body.result.status).toBe('completed');
  });

  it('a failed payout gives the money back', async () => {
    const before = await balanceOf(ctx.app, ctx.auth);
    await sendTo('nobody@example.org', 12);
    payoutStatus.set([...payoutStatus.keys()].at(-1)!, 'RETURNED');
    await request(ctx.app).post('/v1/internal/sync-payouts').set('X-Cron-Secret', 'cron-test-secret');
    expect(await balanceOf(ctx.app, ctx.auth)).toBeCloseTo(before, 2);
  });

  it('forged webhooks are ignored', async () => {
    const before = await balanceOf(ctx.app, ctx.auth);
    await request(ctx.app).post('/v1/webhooks/paypal').set('x-test-forged', '1')
      .send({ id: 'WH-FORGED', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-X', amount: { value: '999.00', currency_code: 'USD' }, supplementary_data: { related_ids: { order_id: 'ORDER1' } } } });
    await new Promise((r) => setTimeout(r, 100));
    expect(await balanceOf(ctx.app, ctx.auth)).toBeCloseTo(before, 2);
  });

  it('without the Payouts permission, outside recipients are refused before any confirmation', async () => {
    scopes = ['openid', 'https://uri.paypal.com/services/payments/payment/authcapture'];
    await request(ctx.app).get('/v1/paypal/status?refresh=1').set(ctx.auth);
    const prepared = await request(ctx.app).post('/v1/actions/send_money').set(ctx.auth).send({ input: { recipient: { email: 'later@example.org' }, amount: 5 } });
    expect(prepared.status).toBe(403);
    expect(prepared.body.error.message).toMatch(/Payouts are not enabled/);
    const picker = await request(ctx.app).post('/v1/ui/hydrate').set(ctx.auth)
      .send({ spec: { version: 1, blocks: [{ type: 'picker', kind: 'contact', search: 'later@example.org', action: 'send_money', input: { amount: 5 } }] } });
    expect(picker.body.spec.blocks[0].data.items[0]).toMatchObject({ disabled: true });
  });
});
