import { vi } from 'vitest';

/**
 * A minimal in-memory PayPal REST server (shapes from paypal-rest-api-specifications),
 * installed by stubbing global fetch for api-m.sandbox.paypal.com only.
 */
export type FakeCall = { method: string; path: string; headers: Record<string, string>; body: unknown };

export const MERCHANT = { clientId: 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', secret: 'EFGHijklMNOPqrstUVWXyz0123456789abcd' };
export const SCOPES = [
  'https://uri.paypal.com/services/invoicing',
  'https://uri.paypal.com/services/reporting/search/read',
  'https://uri.paypal.com/services/payments/refund',
  'https://uri.paypal.com/services/payments/payment/authcapture',
  'https://uri.paypal.com/services/disputes/read-seller',
  'https://uri.paypal.com/services/disputes/update-seller',
  'https://uri.paypal.com/services/subscriptions',
  'https://uri.paypal.com/payments/payouts',
];

export function installFakePayPal(opts: { scopes?: string[] } = {}) {
  const calls: FakeCall[] = [];
  const invoices = new Map<string, Record<string, any>>();
  let seq = 0;
  const realFetch = globalThis.fetch;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'paypal-debug-id': 'dbg123' } });

  const today = new Date();
  const iso = (daysAgo: number) => new Date(today.getTime() - daysAgo * 86_400_000).toISOString().replace(/\.\d{3}Z$/, '+0000');
  const tx = (id: string, daysAgo: number, value: string, code: string, name: string, email: string) => ({
    transaction_info: {
      transaction_id: id,
      transaction_event_code: code,
      transaction_initiation_date: iso(daysAgo),
      transaction_amount: { currency_code: 'USD', value },
      fee_amount: { currency_code: 'USD', value: code.startsWith('T00') ? '-1.20' : '0.00' },
      transaction_status: 'S',
      transaction_subject: 'Order',
    },
    payer_info: { email_address: email, payer_name: { alternate_full_name: name } },
  });

  const handler = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : init.body;
    calls.push({ method, path: u.pathname + u.search, headers, body });

    if (u.pathname === '/v1/oauth2/token') {
      const expected = 'Basic ' + Buffer.from(`${MERCHANT.clientId}:${MERCHANT.secret}`).toString('base64');
      if (headers.authorization !== expected) return json(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
      return json(200, { access_token: 'A21AAmerchant', token_type: 'Bearer', app_id: 'APP-80W284485P519543T', expires_in: 32400, scope: (opts.scopes ?? SCOPES).join(' ') });
    }
    if (headers.authorization !== 'Bearer A21AAmerchant') return json(401, { error: 'invalid_token' });

    if (u.pathname === '/v1/reporting/balances') {
      return json(200, { account_id: 'MERCH4NT1D', balances: [{ currency: 'USD', primary: true, total_balance: { currency_code: 'USD', value: '1520.40' }, available_balance: { currency_code: 'USD', value: '1500.00' }, withheld_balance: { currency_code: 'USD', value: '20.40' } }] });
    }
    if (u.pathname === '/v1/reporting/transactions') {
      if (!u.searchParams.get('start_date') || !u.searchParams.get('end_date')) return json(400, { name: 'INVALID_REQUEST', message: 'dates required' });
      const all = [
        tx('8MC585209K746392H', 1, '120.00', 'T0006', 'Jane Buyer', 'jane@example.com'),
        tx('5TY05013RG002845M', 3, '45.50', 'T0006', 'Sam Lee', 'sam@example.com'),
        tx('7HR10035CK7593546', 4, '-20.00', 'T1107', 'Sam Lee', 'sam@example.com'),
      ];
      const start = new Date(u.searchParams.get('start_date')!.replace('-0000', 'Z'));
      return json(200, { transaction_details: all.filter((t) => new Date(t.transaction_info.transaction_initiation_date.replace('+0000', 'Z')) >= start), total_items: 3, page: 1, total_pages: 1 });
    }
    if (u.pathname === '/v2/invoicing/invoices' && method === 'POST') {
      const id = `INV2-${String(++seq).padStart(4, '0')}-TEST`;
      const b = body as Record<string, any>;
      const total = (b.items as any[]).reduce((s, i) => s + Number(i.unit_amount.value) * Number(i.quantity), 0).toFixed(2);
      const inv = { id, status: 'DRAFT', detail: { ...b.detail, invoice_number: String(seq) }, primary_recipients: b.primary_recipients, items: b.items, amount: { currency_code: b.detail.currency_code, value: total } };
      invoices.set(id, inv);
      return json(201, inv);
    }
    if (u.pathname === '/v2/invoicing/invoices' && method === 'GET') return json(200, { items: [...invoices.values()], total_items: invoices.size });
    if (u.pathname === '/v2/invoicing/search-invoices') return json(200, { items: [...invoices.values()].filter((i) => !(body as any).status || (body as any).status.includes(i.status)), total_items: invoices.size });
    let mm = u.pathname.match(/^\/v2\/invoicing\/invoices\/([^/]+)(\/send)?$/);
    if (mm) {
      const inv = invoices.get(mm[1]!);
      if (!inv) return json(404, { name: 'RESOURCE_NOT_FOUND', message: 'Invoice not found' });
      if (mm[2]) {
        inv.status = 'SENT';
        return json(200, { href: `https://www.sandbox.paypal.com/invoice/p/#${inv.id}` });
      }
      return json(200, inv);
    }
    mm = u.pathname.match(/^\/v2\/payments\/captures\/([^/]+)(\/refund)?$/);
    if (mm) {
      if (mm[2]) return json(201, { id: 'REFUND-1', status: 'COMPLETED', amount: (body as any)?.amount });
      return json(200, { id: mm[1], status: 'COMPLETED', amount: { currency_code: 'USD', value: '120.00' } });
    }
    if (u.pathname === '/v1/customer/disputes') {
      return json(200, { items: [{ dispute_id: 'PP-D-27803', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'WAITING_FOR_SELLER_RESPONSE', dispute_amount: { currency_code: 'USD', value: '45.50' }, dispute_life_cycle_stage: 'INQUIRY' }] });
    }
    if (u.pathname === '/v2/checkout/orders' && method === 'POST') {
      return json(201, { id: '5O190127TN364715T', status: 'CREATED', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T' }] });
    }
    return json(404, { name: 'RESOURCE_NOT_FOUND', message: `fake: ${method} ${u.pathname}` });
  };

  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://api-m.sandbox.paypal.com')) return handler(url, init);
    return realFetch(input, init);
  });

  return { calls, invoices, restore: () => vi.unstubAllGlobals() };
}
