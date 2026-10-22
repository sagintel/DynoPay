# Merchant Data Load Audit — DynoPay

> **Investigation scope:** What data loads on the merchant home screen (balance, cards, transactions) after sign-in, and where/why it can silently fail.

---

## Executive Summary

The merchant home screen (`BUSINESS_HOME`) is entirely PayPal-sourced: balance, sales chart, invoices, and PayPal transactions all depend on the `reporting` or `invoicing` scopes from the merchant's REST app. **There are no DynoPay virtual cards on the merchant home screen at all** — cards are a personal-account feature. The single most likely reason a merchant sees an empty or static home screen is a missing `reporting` scope (`Transaction Search` disabled in the PayPal developer dashboard). When that scope is absent, the `merchant_overview` block renders a "Check connection in Settings" notice instead of data, and every other block on the page silently shows a placeholder. There is also a subtle load-sequence issue: `canvas.tsx` checks for a `lastView` before falling through to the full screen layout, and `signInMerchant` does clear that view — but only if the `clearLastView` calls succeed, and failures are silently swallowed.

---

## Q1 — BALANCE: Does BUSINESS_HOME load the PayPal merchant balance?

**Yes, via `merchant_overview` block → `merchantOverview()` service.**

### Block in BUSINESS_HOME

`defaults.ts` line 1 of the `BUSINESS_HOME` constant:

```typescript
// backend/src/agent/ui/defaults.ts  (BUSINESS_HOME)
blocks: [
  { type: 'merchant_overview' },   // ← the balance lives here
  ...
]
```

### Hydration path

`hydrate.ts` `load()` function:

```typescript
case 'merchant_overview':
  return read(user, 'merchant_overview', {});
```

`read()` calls `performAction(user, 'merchant_overview', {})` which dispatches to `MERCHANT_ACTIONS` → `m.merchantOverview(user)`.

### What `merchantOverview` does

`services/merchant.ts` → `merchantOverview()`:

```typescript
const safe = async <T>(cap: Capability, fn: () => Promise<T>): Promise<T | null> => {
  if (!hasCapability(conn.scopes, cap)) return null;  // silent null if scope missing
  try {
    return await guard(conn, fn);
  } catch (err) {
    logger.info(...)
    return null;   // silent null on any PayPal error
  }
};
const [balance, txs, invoices, disputes] = await Promise.all([
  safe('reporting', () => merchantBalance(client)),   // ← balance fetched here
  ...
]);
```

### Scope requirement

- Scope key: `reporting`  
- PayPal scopes required (from `CAPABILITIES.reporting`): `['reporting/search/read']`  
- This maps to the **"Transaction Search"** feature flag in the PayPal developer REST app settings.

### What happens when the scope is missing

1. `hasCapability(conn.scopes, 'reporting')` returns `false`.  
2. `safe('reporting', ...)` returns `null` immediately — **no error thrown, no log**.
3. `merchantOverview` returns `{ balance: null, sales30: null, ... }`.
4. `MerchantOverviewBlock` in `Merchant.tsx`: when `block.data` exists but `d.balance?.primary` is falsy, it renders a static notice: `"Enable Transaction Search for your REST app to see your PayPal balance and sales here."` — not an error; the block renders, it just shows nothing useful.

**Special case:** if `conn.scopes` is an empty array (PayPal returned no scope list), `hasCapability` returns `true` by design (`if (!scopes.length) return true`) — the call is attempted and the real PayPal 403 is surfaced as a log entry.

---

## Q2 — CARDS: Does BUSINESS_HOME include a `cards` block?

**No.** There is no `cards` block in `BUSINESS_HOME`.

### Evidence

`defaults.ts` `BUSINESS_HOME` blocks:

```
1. merchant_overview
2. chips
3. merchant_sales
4. invoices
5. paypal_transactions
```

No `cards` or `card` type appears.

### Where cards live

Cards are in the **separate `cards` screen layout** (`DEFAULTS.cards`), available to all account types:

```typescript
// defaults.ts — DEFAULTS.cards
blocks: [
  { type: 'cards', variant: 'carousel', showActions: true },
  { type: 'chips', ... },
  { type: 'transactions', title: 'Card activity', query: { kind: 'card_spend', ... } },
]
```

A merchant can reach cards by tapping the Cards tab. The chips on BUSINESS_HOME have a **"Wallet"** chip that triggers `"Show my DynoPay wallet balance and recent transfers"` — this asks the AI agent and can produce a balance or transaction block, but does not show cards directly.

### Are these real PayPal cards or DynoPay virtual cards?

DynoPay virtual cards only. `cards.ts → listCards()` queries the local `Card` table (DynoPay DB), not PayPal. PayPal does not expose issued-card details via its merchant REST API. Merchants using BUSINESS_HOME have no automatic card display on their home screen.

---

## Q3 — TRANSACTIONS: Does BUSINESS_HOME include a transactions block?

**Yes, two blocks load transaction data, both PayPal-only.** There are no DynoPay local transactions on the merchant home.

### Block 1: `merchant_sales` (aggregated)

```typescript
// defaults.ts — BUSINESS_HOME
{ type: 'merchant_sales', title: 'Sales · last 30 days', days: 30, kind: 'bar' }
```

Hydration (`hydrate.ts`):
```typescript
case 'merchant_sales':
  return read(user, 'merchant_sales', { days: b.days });
```

Action `merchant_sales` calls `m.recentPayPalTransactions(client, days, 500)` → `pp.listReportingTransactions()` — **PayPal Transaction Search API**. Requires `reporting` scope. Returns aggregate sales summary (gross, fees, refunds, daily buckets). Rendered as a bar chart by `MerchantSalesBlock`.

### Block 2: `paypal_transactions` (list)

```typescript
{ type: 'paypal_transactions', title: 'PayPal activity', days: 30, limit: 10 }
```

Hydration (`hydrate.ts`):
```typescript
case 'paypal_transactions':
  return read(user, 'merchant_transactions', { days: b.days, limit: b.limit, ... });
```

Action `merchant_transactions` also calls `recentPayPalTransactions` — **same PayPal Transaction Search API call**, served from an in-process 60-second cache so the two blocks don't duplicate the PayPal request. Rendered as a list by `PayPalTransactionsBlock`.

### What about DynoPay transactions?

There is no `transactions` block (local DynoPay) in `BUSINESS_HOME`. A merchant's DynoPay wallet transactions are only visible by explicitly asking the AI ("Show my DynoPay wallet balance") or via the Wallet chip.

### Scope requirement for both

Both require `reporting` scope. If absent, `read()` returns `undefined` (via `performAction → res.status !== 'done'`), the block receives no `data`, and both components render placeholders silently (a caption-text empty state, not an error).

---

## Q4 — CANVAS LOAD SEQUENCE

When a merchant opens the Home tab, the sequence is:

### Step 1: `signInMerchant` clears lastView

`session.tsx → signInMerchant`:
```typescript
const res = await api.merchantSignIn(creds);
await session.save(res);
await Promise.all([api.clearLastView('home'), api.clearLastView('cards')]).catch(() => undefined);
setUser({ ...res.user, merchant: res.merchant });
```

`clearLastView` failures are silently caught with `.catch(() => undefined)`. If the clear fails (e.g., network error between sign-in API call and the clear call), a stale lastView from a previous session can persist.

### Step 2: Canvas mounts, `useEffect` fires

`canvas.tsx` `useEffect` (deps: `[screen, lang]`):

```typescript
void (async () => {
  try {
    const { last } = await api.lastView(screen);
    if (cancelled) return;
    if (last) {
      committed.current = last.spec;
      setSpec(last.spec);
      setMode('result');
      learnPeople(last.spec);
      return;   // ← early return, no screenLayout called
    }
  } catch { /* fall through */ }
  if (!cancelled) void resetRef.current();
})();
```

### Step 3a: If lastView exists → display it directly

The re-hydrated last spec is shown immediately. **No further `screenLayout` call is made.** This means the screen shows the previous session's layout (which could be a personal-account layout if lastView clear failed in Step 1).

### Step 3b: If no lastView → `reset()` → `api.screen(screen)`

`reset()` calls `api.screen(screen)` which hits `GET /v1/screen/home`. The backend calls `screenLayout(user, 'home')` → `getLayout(user, slot)` → `defaultLayout('home', 'business')` (because `user.accountType === 'business'`) → returns `BUSINESS_HOME` → hydrated via `hydrateSpec()`.

### Race condition / early-return risk

There is **one significant race**: the `cancelled` flag is set in the `useEffect` cleanup, but there is no abort controller for the `api.lastView` or `api.screen` calls themselves. If the component unmounts and remounts quickly (e.g., during navigation), both the old and new effect can fire. The `cancelled` flag guards the state updates, so only the latest effect's result is applied — this is correct but means the first render may briefly show `spec: null` (loading state) before data arrives.

**Empty screen scenario:** If `api.screen()` fails (network error, backend crash), `reset()` calls `setError(e.message)` — the canvas shows an error state, not data. There is no retry logic in `reset()`.

**Heavy/loop scenario (from user reports):** The most likely cause of the app feeling heavy and looping is that `merchant_overview` triggers `merchantOverview()` which fires four concurrent PayPal API calls. If the PayPal sandbox is slow or rate-limited, these calls can each take 2–5 seconds. Meanwhile the UI shows the screen skeleton. Since the block hydration is done server-side and streamed as JSON, the mobile app is simply waiting for the server response — there is no timeout configured in `canvas.tsx` for the initial `api.screen()` call.

---

## Q5 — DATA GAPS: Silent null/undefined rendering

The following blocks can silently show nothing (no error, just a static fallback):

| Block | Condition for silent null | What the user sees |
|---|---|---|
| `merchant_overview` — balance section | `reporting` scope missing OR PayPal error | Static info notice: "Enable Transaction Search…" |
| `merchant_overview` — sales30 stat | Same as above | Shows `—` instead of a number |
| `merchant_overview` — unpaidInvoices stat | `invoicing` scope missing OR PayPal error | Shows `—` |
| `merchant_overview` — openDisputes stat | `disputes` scope missing OR PayPal error | Shows `—` |
| `merchant_sales` block | `reporting` scope missing | Renders a card with caption text "Enable Transaction Search to see your sales chart." |
| `paypal_transactions` block | `reporting` scope missing OR `performAction` returns `status !== 'done'` | `block.data` is `undefined`, `items` is `[]`, renders `EmptyBlock` with "No PayPal activity yet." |
| `invoices` block | `invoicing` scope missing | `block.data` is `undefined`, `items` is `[]`, renders `EmptyBlock` with "No invoices." |

The key mechanism: `hydrate.ts → read()`:
```typescript
async function read(user, action, input) {
  const res = await performAction(user, action, input);
  return res.status === 'done' ? res.result : undefined;  // ← returns undefined on any failure
}
```

And in `hydrateLeaf()`:
```typescript
const data = await load(user, b, drafts);
return data === undefined ? b : { ...b, data };  // ← no error set, block just has no data
```

This means a block with no data is returned without an `error` field — the mobile app's renderer treats it as a "no data yet" state and shows placeholder content. The user sees a styled empty state, not an error message.

The only way a block gets an `error` field is if `load()` throws — but for all merchant blocks, errors are caught inside `merchantOverview` (`safe()` wrapper) and converted to `null` before `load()` even returns. So **merchant blocks never propagate errors to the client**.

---

## Q6 — SCOPE REQUIREMENTS

| Scope key | PayPal permission | Required for | If missing |
|---|---|---|---|
| `reporting` | `reporting/search/read` (Transaction Search) | Balance, all transaction data, sales chart | Balance = null, transactions = [], sales = null; all blocks show placeholder |
| `invoicing` | `services/invoicing` | Invoices block, invoice detail | Invoices block shows "No invoices" |
| `disputes` | `disputes/read-seller` | Disputes stat in overview | Shows `—` |
| `payments` | `payments/payment`, `checkout` | Payment links (not on home) | N/A for home |
| `subscriptions` | `services/subscriptions` | Catalog (not on home) | N/A for home |

**Without `reporting`:** The home screen shows:
- `MerchantOverviewBlock`: rendered but with a "Enable Transaction Search" notice where the balance should be, and `—` for all stats
- `MerchantSalesBlock`: a static card saying "Enable Transaction Search"
- `InvoicesBlock`: depends on `invoicing`, unaffected by `reporting`
- `PayPalTransactionsBlock`: empty state "No PayPal activity yet"

**If no MerchantConnection at all (not connected):** `merchantClient()` throws `forbidden(...)`. The `hydrateLeaf` catch block catches this and sets `error: 'Connect your PayPal business REST credentials to use merchant features'` on the block. The mobile app would render this as an error block (via `NoticeBlock` in error tone if the renderer handles the `error` field — worth verifying in the renderer).

---

## Conclusions and Recommended Fixes

### Fix 1 — `reporting` scope is the single biggest gap (HIGH PRIORITY)

The vast majority of the merchant home screen requires the `reporting` scope. If the merchant's PayPal REST app doesn't have "Transaction Search" enabled, the entire home screen shows placeholder content with no clear guidance. The current notice text is buried inside the balance area.

**Recommendation:** On the merchant sign-in success flow, check `hasCapability(conn.scopes, 'reporting')` immediately after `signInWithCredentials`. If missing, navigate to a dedicated onboarding screen (or show an inline modal) that explains exactly which PayPal developer setting to enable, before the user ever sees the empty home screen.

### Fix 2 — `clearLastView` failure can show wrong screen (MEDIUM)

`signInMerchant` swallows `clearLastView` errors silently. If the clear fails, the canvas `useEffect` finds the old lastView and renders it — a personal-account layout on a business login.

**Recommendation:** Don't just `.catch(() => undefined)`. Either retry once, or check `user.accountType` inside the canvas `useEffect` and skip the lastView if the account type doesn't match the cached spec's expected blocks.

### Fix 3 — No cards on the merchant home is by design, but not communicated (LOW)

The "Wallet" chip on BUSINESS_HOME lets merchants reach their DynoPay wallet via the AI, but there is no cards entry point. Merchants who expect to see cards will be confused.

**Recommendation:** Optionally add a `cards` block or a chip labeled "Cards" to `BUSINESS_HOME`, or add documentation/onboarding note.

### Fix 4 — Heavy load / looping performance (MEDIUM)

On first load, `merchantOverview` fires 4 concurrent PayPal calls. The 60-second in-process cache means the second block (`merchant_sales`) shares the transaction fetch, but `merchantOverview` itself is a separate call that also fetches balance + invoices + disputes in parallel. Under sandbox latency this can take 3–8 seconds.

**Recommendation:** Add a backend timeout (`AbortSignal.timeout`) to the individual PayPal calls inside `merchantOverview`, capped at ~5 seconds per call. Return the partial result rather than waiting indefinitely. This prevents the mobile app from appearing unresponsive.

### Fix 5 — `merchant_overview` block never shows an error (LOW)

Because `safe()` converts all errors to `null`, and `MerchantOverviewBlock` renders a notice (not an error) when `block.data` exists but balance is null, the user never gets a precise error message. A 401 (revoked credentials) looks identical to a missing scope.

**Recommendation:** Include a `capabilityWarnings` array in the `merchantOverview` return value listing which capabilities failed and why. Surface these as dismissible notices in `MerchantOverviewBlock`.
