# Merchant Data-Flow Investigation
**Date:** 2025-07-13  
**Scope:** What a merchant actually sees after signing in with PayPal REST API credentials — balance, cards, transactions — and why changes to those credentials appear to have no effect on the app.

---

## Summary Answer

**The architecture is correct: real PayPal data IS fetched.** The balance shown to a merchant is their live PayPal account balance (via `/v1/reporting/balances`). Their transactions come from PayPal's Transaction Search API. Their cards are DynoPay virtual cards (independent of PayPal — this is by design and explicitly documented). However, three bugs/gaps cause the symptoms the user describes:

1. **No redirect after merchant sign-in** — `merchant.tsx` calls `router.replace('/(tabs)')` correctly, but the `Stack.Protected` guard in `_layout.tsx` only responds to `user` changing. The sign-in flow calls `setUser()` correctly via `signInMerchant`, so the redirect *should* work — but there is a **performance/loop bug** (point 2) that causes the screen to spin.
2. **Heavy load / infinite loop** — The `CanvasProvider` in `canvas.tsx` depends on `lang` in its `useEffect`, meaning the canvas re-mounts and re-fetches the screen layout every time the language changes. For a merchant, the `BUSINESS_HOME` default layout triggers `merchant_overview`, which calls four live PayPal APIs in parallel. If any one of them is slow or errors transiently, the provider can get into a retry/remount cycle. Additionally, the `reset` callback is declared with `useCallback` but listed in the `useEffect` deps array, causing the effect to fire on every render where `reset` changes (which it does on every re-render because `learnPeople` is not stable across `people` state changes).
3. **"Nothing changes" after rotating credentials** — The `clientFromConnection` function in `services/merchant.ts` caches `PayPalClient` instances in a module-level `Map`, keyed by `${conn.id}:${conn.updatedAt.getTime()}`. After `connectCredentials` is called via `PUT /v1/merchant/connection`, the old cache entry **is** purged (the `for (const k of clients.keys())` loop). BUT the `merchantOverview` function also has its own short-lived in-memory cache (`cached()` helper, keyed by `bal:${env}:${clientId}`). This cache TTL is 30 seconds for balances and 60 seconds for transactions. So immediately after reconnecting, the stale PayPal data is returned from this second cache for up to a minute.

---

## Evidence by Question

### 1. Balance: real PayPal or local wallet?

**For merchants: real PayPal.** For personal accounts: local DynoPay wallet.

The key fork is in `backend/src/agent/ui/defaults.ts` → `defaultLayout()`:

```ts
// defaults.ts, line ~81
const BUSINESS_HOME: z.input<typeof uiSpecSchema> = {
  version: 1,
  blocks: [
    { type: 'merchant_overview' },      // ← PayPal live API
    ...
    { type: 'merchant_sales', days: 30 },
    { type: 'paypal_transactions', days: 30, limit: 10 },
  ],
};
```

When a business account opens the home screen, `defaultLayout('home', 'business')` returns `BUSINESS_HOME`. The `merchant_overview` block is hydrated by `backend/src/agent/ui/hydrate.ts`:

```ts
// hydrate.ts
case 'merchant_overview':
  return read(user, 'merchant_overview', {});
```

`read()` calls `performAction(user, 'merchant_overview', {})`, which runs `merchantOverview(user)` in `services/merchant.ts`:

```ts
// services/merchant.ts, merchantOverview()
const [balance, txs, invoices, disputes] = await Promise.all([
  safe('reporting', () => merchantBalance(client)),     // → PayPal /v1/reporting/balances
  safe('reporting', () => recentPayPalTransactions(client, 30, 500)),  // → PayPal /v1/reporting/transactions
  safe('invoicing', () => pp.searchInvoices(...)),
  safe('disputes',  () => pp.listDisputes(client)),
]);
```

`merchantBalance()` calls `pp.getBalances(client)` → `PayPalClient.request('/v1/reporting/balances')` → live PayPal API.

**Personal account balance** (the `balance` block type) is hydrated by `insights.balanceOverview(user)` → `getAccount(user.id)` → the local `accounts` table. These are completely separate code paths.

### 2. Cards: real PayPal payment methods or virtual DynoPay cards?

**Virtual DynoPay cards, for both personal and business accounts.** This is intentional and documented.

`backend/src/services/cards.ts`:
```ts
/**
 * DynoPay virtual cards are sub-wallets funded from the main balance.
 * Card issuing on a real network needs an issuer-processor partner...
 */
```

Cards are stored in the `cards` table (`backend/src/db/models.ts`). The `last4` is generated with `crypto.randomInt`. There is no PayPal card API call anywhere in `cards.ts`.

The `cards` block in `hydrate.ts` calls `cards.listCards(user)` — pure DB query. This is the same for personal and business accounts. PayPal's card/payment-method API is never called.

**Implication for the user:** A merchant's PayPal-linked debit/credit card in their PayPal account does NOT appear in DynoPay. The "Cards" tab only shows DynoPay virtual cards the user created within the app. This is the correct behavior per the design, but it may surprise users who expected to see their PayPal payment methods.

### 3. Transactions: PayPal Transaction Search API or local ledger?

**Both — but shown in different places, and a merchant sees both.**

| Block type | Source | Who sees it |
|---|---|---|
| `transactions` | Local `transactions` table (Sequelize) | Everyone |
| `paypal_transactions` | PayPal `/v1/reporting/transactions` API | Merchants only |

On the merchant home (`BUSINESS_HOME`), both a `paypal_transactions` block and no local transactions block are included. Local DynoPay transfers (wallet→wallet, top-ups) are NOT shown on the merchant home by default — only PayPal activity is shown. A merchant can ask the agent to show their wallet transactions.

`backend/src/services/transactions.ts → queryTransactions()` queries only the local `transactions` table.  
`backend/src/services/merchant.ts → recentPayPalTransactions()` calls `pp.listReportingTransactions(client, ...)` → PayPal `/v1/reporting/transactions`.

### 4. Sync mechanism on sign-in or periodic?

**No background sync; data is fetched lazily on screen render.**

On sign-in (`POST /v1/auth/paypal/credentials`), `signInWithCredentials()` in `services/merchant.ts`:
1. Calls `verifyCredentials()` — gets a PayPal token and optionally fetches balances to discover `accountId`.
2. Saves/updates the `MerchantConnection` row.
3. Returns session tokens.

There is no subsequent balance pull, no webhook registration, no cron job. The PayPal balance and transactions are only fetched when the merchant opens a screen that contains a merchant block (i.e., on every `GET /v1/ui/screen/home` call for a business account, and on every `merchant_overview` agent tool call).

There is a short-lived in-process cache (`cached()` in `services/merchant.ts`):
- Balance TTL: 30 seconds
- Transaction list TTL: 60 seconds

### 5. What is different in the data layer for a business account vs personal?

| Feature | Personal | Business (merchant) |
|---|---|---|
| Home screen default layout | `DEFAULTS.home` — wallet balance arc, DynoPay contacts, local transactions | `BUSINESS_HOME` — PayPal merchant_overview, sales chart, invoices, PayPal transactions |
| Balance shown | Local `Account.balance` (DynoPay wallet) | Live PayPal balance via `/v1/reporting/balances` |
| Transactions on home | Local `transactions` table | PayPal Transaction Search API |
| Cards | DynoPay virtual cards (DB) | Same — DynoPay virtual cards (DB) |
| Extra features | — | Invoicing, disputes, subscriptions, payment links, refunds, payouts |
| Guard check | — | `checkRequest()` allows merchant keywords only for `accountType === 'business'` |
| Account snapshot | `merchant: null` | `merchant: { capabilities: [...] }` from `MerchantConnection.scopes` |

The `accountType` field on the `User` model is set to `'business'` by `saveConnection()` after credential verification. `defaultLayout()` reads this to pick the right home layout.

### 6. What needs to change to fix the three symptoms?

---

## Root Causes and Recommended Fixes

### Bug 1: App appears to do nothing / not redirect after merchant sign-in

**Root cause:** The redirect does work (`router.replace('/(tabs)')` in `merchant.tsx` line ~53), but it fires before the `SessionProvider` state updates, causing Expo Router to treat the navigation as a no-op (the user isn't in the guarded stack yet at the moment `replace` fires). The `Stack.Protected guard={!!user}` evaluates synchronously; when `replace('/(tabs)')` is called and `user` is still null, the router ignores it.

**Fix:** Remove `router.replace('/(tabs)')` from `merchant.tsx`. Instead, rely solely on the `Stack.Protected` guard reacting to `user` becoming non-null (which happens immediately after `signInMerchant` calls `setUser()`). The navigation is then automatic, not imperative.

```tsx
// merchant.tsx — in the submit() function
if (connecting) {
  await api.connectMerchant(creds);
  await refreshUser();
  toast('Merchant account connected', 'success');
  router.back();
} else {
  await signInMerchant(creds);
  // ← remove router.replace('/(tabs)') — the guard handles it
}
```

### Bug 2: Heavy / looping behavior after sign-in

**Root cause:** `canvas.tsx`'s `useEffect` that calls `api.lastView` + `reset()` has `[reset, lang]` as dependencies. `reset` is a `useCallback` that depends on `[screen, learnPeople]`. `learnPeople` is a `useCallback` depending on nothing (stable), but its body calls `setPeople(prev => ...)` which mutates state, causing re-renders. More critically, `reset` itself calls `setSpec`, `setMode`, etc., which triggers re-renders, which re-evaluates the `reset` callback identity, which fires the `useEffect` again.

For merchants specifically, this is worse because `GET /v1/ui/screen/home` triggers `merchant_overview`, which fans out to four PayPal API calls. Each call takes 200–2000ms. If any fails transiently, the error state triggers another render cycle.

**Fix A:** Wrap the `useEffect` in `canvas.tsx` to run only once on mount (use an `isMounted` guard and remove `reset` from the dep array). The `lang` dependency is intentional (language switch re-fetches the layout) but `reset` should not be a dep — it should be called via a stable ref:

```tsx
// canvas.tsx
const resetRef = useRef(reset);
resetRef.current = reset;

useEffect(() => {
  let cancelled = false;
  void (async () => {
    try {
      const { last } = await api.lastView(screen);
      if (cancelled) return;
      if (last) { /* ... */ return; }
    } catch { /* ... */ }
    if (!cancelled) void resetRef.current();  // ← call via ref, not dep
  })();
  return () => { cancelled = true; };
}, [screen, lang]);  // ← remove `reset` from deps
```

**Fix B:** In `merchantOverview()` (`services/merchant.ts`), use `safe()` properly — it already catches individual failures. The in-process cache prevents hammering PayPal, but the cache key includes `clientId`, so a first load after sign-in is always cold. Consider seeding the balance cache during `signInWithCredentials` (it already fetches balances for `accountId` discovery — return and cache that result).

### Bug 3: "Nothing changes" when re-entering credentials

**Root cause:** `services/merchant.ts` has two caching layers:
1. `clientFromConnection()` caches `PayPalClient` by `${conn.id}:${conn.updatedAt.getTime()}` — this IS invalidated on credential update because `conn.updatedAt` changes.
2. `cached()` helper caches balance/transaction results keyed by `${env}:${clientId}` with no dependency on `updatedAt`. After rotating credentials, the clientId typically stays the same, so the cache entry is still valid and returns stale data for up to 60 seconds.

**Fix:** When `connectCredentials` or `signInWithCredentials` successfully saves new credentials, clear the relevant cache entries. Add a `clearMerchantCache(clientId: string, env: string)` helper:

```ts
// services/merchant.ts
function clearMerchantCache(env: string, clientId: string) {
  for (const k of cache.keys()) {
    if (k.includes(`:${env}:${clientId}:`)) cache.delete(k);
  }
}

// Call it in saveConnection() after the DB update:
async function saveConnection(...) {
  const conn = existing ? await existing.update(values) : await MerchantConnection.create(values);
  clearMerchantCache(v.creds.environment, v.creds.clientId);
  // ...
}
```

---

## Secondary Observations

### The "cards" confusion
A user who connects their PayPal business account and expects to see their **PayPal Debit Mastercard** or linked bank cards will see **nothing** in the Cards tab (unless they create DynoPay virtual cards). The `cards.ts` service exclusively queries the local `Card` model. There is no PayPal `/v2/payment-experience/web-profiles` or equivalent card-listing call anywhere. The merchant home also has no `cards` block. This should be made explicit in the UI (e.g., a notice in the Cards tab for business users: "Cards here are DynoPay virtual cards. Your PayPal payment methods are managed in PayPal.").

### The `auth.tsx` redirect is a no-op
`mobile/src/app/auth.tsx` contains only `<Redirect href="/" />`. After a PayPal OAuth callback the deep link already points the app to `/(tabs)` via the code exchange. The `auth.tsx` file is never reached in normal flow (the `Stack.Protected` guard redirects first). This is fine.

### Merchant sign-in creates a synthetic email
`signInWithCredentials()` creates users with emails like `merchant+sandbox-<hash>@merchants.dynopay.invalid`. This email is never shown to the user and is intentional (PayPal client credentials don't expose the merchant's email). Worth noting in case anyone queries the DB and is confused.

### Balance block on merchant home shows PayPal balance, NOT DynoPay wallet
The `BUSINESS_HOME` layout has `{ type: 'merchant_overview' }` as the first block, not `{ type: 'balance' }`. So the balance shown is the real PayPal balance. If the merchant also wants to see their DynoPay wallet balance, they must ask the agent explicitly (there is a "Wallet" chip in the quick-actions row that prompts this).

---

## Conclusion

The data wiring is correct: merchant balance and transactions come from live PayPal APIs when the user has the `reporting` scope enabled. Cards are intentionally DynoPay-only. The three user-reported problems (no redirect, heavy/looping load, stale data after credential change) are real bugs in the mobile canvas initialization logic and the backend's in-process cache invalidation. None require architecture changes — they are targeted fixes in three files: `mobile/src/app/merchant.tsx`, `mobile/src/genui/canvas.tsx`, and `backend/src/services/merchant.ts`.
