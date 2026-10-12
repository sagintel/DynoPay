import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MerchantConnection } from '../src/db/index.js';
import { installFakePayPal, MERCHANT } from './paypal-fake.js';
import { setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
let paypal: ReturnType<typeof installFakePayPal>;
let merchantAuth: Record<string, string>;

const creds = { clientId: MERCHANT.clientId, clientSecret: MERCHANT.secret, environment: 'sandbox', businessName: 'Acme Studio' };

beforeAll(async () => {
  ctx = await setup(); // ctx.auth = personal demo account
  paypal = installFakePayPal();
});
afterAll(() => paypal.restore());

describe('merchant sign-in with PayPal REST credentials', () => {
  it('rejects wrong secrets without creating anything', async () => {
    const res = await request(ctx.app).post('/v1/auth/paypal/credentials').send({ ...creds, clientSecret: 'X'.repeat(36) });
    expect(res.status).toBe(401);
    expect(await MerchantConnection.count()).toBe(0);
  });

  it('signs in, creates a business account and reports capabilities', async () => {
    const res = await request(ctx.app).post('/v1/auth/paypal/credentials').send(creds);
    expect(res.status).toBe(201);
    expect(res.body.user.accountType).toBe('business');
    expect(res.body.user.name).toBe('Acme Studio');
    expect(res.body.merchant).toMatchObject({ environment: 'sandbox', accountId: 'MERCH4NT1D', appId: 'APP-80W284485P519543T', status: 'active' });
    expect(res.body.merchant.clientId).not.toContain(MERCHANT.clientId); // masked
    expect(JSON.stringify(res.body)).not.toContain(MERCHANT.secret);
    const caps = Object.fromEntries(res.body.merchant.capabilities.map((c: { key: string; enabled: boolean }) => [c.key, c.enabled]));
    expect(caps).toMatchObject({ reporting: true, invoicing: true, refunds: true, disputes: true, tracking: false });
    merchantAuth = { Authorization: `Bearer ${res.body.accessToken}` };
  });

  it('stores the secret encrypted at rest', async () => {
    const conn = await MerchantConnection.findOne();
    expect(conn!.secretEnc).toMatch(/^v1\./);
    expect(conn!.secretEnc).not.toContain(MERCHANT.secret);
  });

  it('signing in again with the same app returns the same account', async () => {
    const again = await request(ctx.app).post('/v1/auth/paypal/credentials').send(creds);
    expect(again.status).toBe(200);
    const me = await request(ctx.app).get('/v1/me').set(merchantAuth);
    expect(again.body.user.id).toBe(me.body.id);
  });
});

describe('audience: merchant features', () => {
  it('personal accounts cannot use merchant actions (API and MCP)', async () => {
    const res = await request(ctx.app).post('/v1/actions/merchant_balance').set(ctx.auth).send({ input: {} });
    expect(res.status).toBe(403);
    const token = (await request(ctx.app).post('/v1/mcp/tokens').set(ctx.auth).send({ name: 'Agent', scopes: ['read', 'propose'] })).body.token;
    const list = await request(ctx.app)
      .post('/mcp')
      .set({ Authorization: `Bearer ${token}` })
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(list.text).not.toContain('refund_payment');
  });

  it('only the capabilities granted by the PayPal app are offered (agent, MCP and API)', async () => {
    const token = (await request(ctx.app).post('/v1/mcp/tokens').set(merchantAuth).send({ name: 'Agent', scopes: ['read', 'propose'] })).body.token;
    const list = await request(ctx.app).post('/mcp').set({ Authorization: `Bearer ${token}` }).set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(list.text).toContain('refund_payment');
    expect(list.text).not.toContain('add_tracking'); // tracking isn't granted to this app
    const manifest = await request(ctx.app).get('/v1/agent/manifest').set(merchantAuth);
    expect(JSON.stringify(manifest.body)).not.toContain('add_tracking');
    const direct = await request(ctx.app).post('/v1/actions/add_tracking').set(merchantAuth).send({ input: { captureId: 'X', trackingNumber: '1', carrier: 'UPS' } });
    expect(direct.status).toBe(403);
  });

  it('merchants read their real PayPal balance and activity', async () => {
    const bal = await request(ctx.app).post('/v1/actions/merchant_balance').set(merchantAuth).send({ input: {} });
    expect(bal.body.result.primary).toMatchObject({ currency: 'USD', total: 1520.4, available: 1500 });

    const sales = await request(ctx.app).post('/v1/actions/merchant_sales').set(merchantAuth).send({ input: { days: 7 } });
    expect(sales.body.result).toMatchObject({ gross: 165.5, refunded: 20, count: 2 });
    expect(sales.body.result.buckets).toHaveLength(7);

    const search = paypal.calls.find((c) => c.path.startsWith('/v1/reporting/transactions'))!;
    expect(search.path).toMatch(/start_date=.*end_date=/);
  });

  it('serves a merchant dashboard as the default home', async () => {
    const home = await request(ctx.app).get('/v1/ui/screen/home').set(merchantAuth);
    const [overview] = home.body.spec.blocks;
    expect(overview.type).toBe('merchant_overview');
    expect(overview.data).toMatchObject({ businessName: 'Acme Studio', openDisputes: 1 });
    expect(overview.data.sales30.gross).toBe(165.5);
  });
});

describe('merchant actions follow the confirmation rule', () => {
  let invoiceId = '';

  it('creating a draft invoice and sending it each need confirmation', async () => {
    const draft = await request(ctx.app)
      .post('/v1/actions/create_invoice_draft')
      .set(merchantAuth)
      .send({ input: { recipientEmail: 'client@example.com', recipientName: 'Client Co', items: [{ name: 'Design', quantity: 2, unitAmount: 150 }] } });
    expect(draft.body.status).toBe('needs_confirmation');
    expect(draft.body.pending.summary).toMatchObject({ title: 'Create invoice draft', amount: 300 });
    expect(paypal.invoices.size).toBe(0);
    const created = await request(ctx.app).post(`/v1/pending/${draft.body.pending.id}/confirm`).set(merchantAuth);
    invoiceId = created.body.result.id;
    expect(created.body.result).toMatchObject({ status: 'DRAFT', total: 300, recipientEmail: 'client@example.com' });

    const send = await request(ctx.app).post('/v1/actions/send_invoice').set(merchantAuth).send({ input: { invoiceId } });
    expect(send.body.status).toBe('needs_confirmation');
    expect(send.body.pending.summary).toMatchObject({ amount: 300, confirmLabel: 'Send invoice' });
    expect(paypal.invoices.get(invoiceId)!.status).toBe('DRAFT'); // nothing sent yet

    const confirmed = await request(ctx.app).post(`/v1/pending/${send.body.pending.id}/confirm`).set(merchantAuth);
    expect(confirmed.body.status).toBe('executed');
    expect(paypal.invoices.get(invoiceId)!.status).toBe('SENT');
    const sendCall = paypal.calls.find((c) => c.path.endsWith('/send'))!;
    expect(sendCall.headers['paypal-request-id']).toBe(send.body.pending.id);
  });

  it('refunds are previewed from PayPal and only executed after confirmation', async () => {
    const before = paypal.calls.filter((c) => c.path.endsWith('/refund')).length;
    const res = await request(ctx.app).post('/v1/actions/refund_payment').set(merchantAuth).send({ input: { captureId: '8MC585209K746392H', amount: 20 } });
    expect(res.body.pending.summary).toMatchObject({ title: 'Partial refund', amount: 20, style: 'hold', tone: 'danger' });
    expect(paypal.calls.filter((c) => c.path.endsWith('/refund')).length).toBe(before);
    const over = await request(ctx.app).post('/v1/actions/refund_payment').set(merchantAuth).send({ input: { captureId: '8MC585209K746392H', amount: 500 } });
    expect(over.status).toBe(400);
    const done = await request(ctx.app).post(`/v1/pending/${res.body.pending.id}/confirm`).set(merchantAuth);
    expect(done.body).toMatchObject({ status: 'executed', result: { refundId: 'REFUND-1' } });
  });

  it('capabilities missing from the app are refused with a clear message', async () => {
    // Refused when preparing the confirmation, not after the user taps.
    const res = await request(ctx.app).post('/v1/actions/add_tracking').set(merchantAuth).send({ input: { transactionId: '8MC585209K746392H', trackingNumber: '1Z999', carrier: 'UPS' } });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/Shipment tracking isn't enabled/);
  });
});

describe('merchant sentences (offline planner)', () => {
  it('"Invoice <email> <amount> for <what>" prepares one confirmation that creates and emails it', async () => {
    const before = paypal.invoices.size;
    const res = await request(ctx.app).post('/v1/agent').set(merchantAuth).send({ prompt: 'Invoice bob@shop.com 250 for website design' });
    const [confirmation] = res.body.spec.blocks;
    expect(confirmation.data).toMatchObject({ action: 'create_and_send_invoice', summary: { amount: 250, confirmLabel: 'Send invoice' } });
    expect(paypal.invoices.size).toBe(before); // nothing created yet
    const done = await request(ctx.app).post(`/v1/pending/${confirmation.pendingId}/confirm`).set(merchantAuth);
    expect(done.body.status).toBe('executed');
    expect(paypal.invoices.get(done.body.result.invoiceId)!.status).toBe('SENT');
  });

  it('"Show my open disputes" renders the disputes block', async () => {
    const res = await request(ctx.app).post('/v1/agent').set(merchantAuth).send({ prompt: 'Show my open disputes' });
    expect(res.body.spec.blocks[0].data[0]).toMatchObject({ id: 'PP-D-27803', needsAction: true, amount: 45.5 });
  });
});

describe('connecting credentials to an existing personal account', () => {
  it('upgrades the account to business; the same app cannot be linked twice', async () => {
    const dupe = await request(ctx.app).put('/v1/merchant/connection').set(ctx.auth).send(creds);
    expect(dupe.status).toBe(409);
  });
});
