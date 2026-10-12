# DynoPay

**Banking without forms.** DynoPay is a PayPal-connected banking app whose Home and Cards screens have no fixed UI.
You write what you want ("Send 500 to Ahmed for the rent", "show my spending this week as a donut",
"freeze my travel card"). A ReAct agent reads your data, then composes the screen from a fixed catalog of
pre-built, on-brand components. Anything that moves money waits for you to **hold to confirm**.

```
mobile/   Expo SDK 54 · expo-router 6 · Reanimated 4 · react-native-svg      (the renderer)
backend/  Node 22+ · Express 5 · Sequelize (SQLite → Postgres/MySQL) · LangChain · MCP · PayPal REST
```

## How it works

```
 prompt bar ──► POST /v1/agent/stream ──► ReAct loop (Gemini or Cloudflare via LangChain)
                                            │  Thought → Action → Observation …
                                            │  actions = one registry (read | auto | confirm)
                                            ▼
                                  final UI spec (catalog blocks only, zod-validated)
                                            ▼
                         server hydrates data blocks from the DB (numbers never come from the model)
                                            ▼
                           app renders pre-built components with animations
```

- **One action registry** (`backend/src/actions/registry.ts`) declares every capability once with a risk level.
  The same registry backs the agent's tools, the MCP server and the REST endpoint that generated buttons call.
  - `read`: balances, card details, transactions, contacts, insights. These run freely, with no human in the loop.
  - **every change needs the user's validation.** Money moves (send, refund, fund, payouts) get Hold-to-confirm
    plus Face ID or fingerprint. Small changes (freeze/unfreeze, rename, add/remove contacts, new card, save
    layout, invoices, payment links…) get a one-tap confirmation. Calling any of them only creates a
    **pending action** with a preview; only `POST /v1/pending/:id/confirm` executes it, and the server re-checks
    the balance, limits and status at that moment. A test asserts that no non-read action can run without it.
- **Live as you type.** Every input change (debounced, previous request cancelled) asks the agent for a
  *preview*: reads run and changes become **drafts** that do nothing until pressed. A sentence that isn't
  understood yet renders nothing, and clearing the input restores the screen.
- **Cheapest engine first.** A request is answered by the **plan cache**, then **on-device rules**, then the
  **LLM**. A cached plan is the tool calls + layout of an earlier AI answer stored as a template
  (`send {amount} to {person} for {purpose}`) and replayed with fresh data for the same or a similar sentence.
  Settings → *Answer cache* picks Off / Same sentence / Similar and a **reuse limit**: after N reuses the next
  request goes to the LLM, the plan is refreshed and its count restarts. Token use and savings are shown
  in Settings.
- **Charts.** bar, ranked (hbar), line, area, sparkline, donut, pie, progress, budget gauge, calendar heatmap,
  stacked and grouped (money in vs out). The colors are colorblind-safe (validated with the dataviz checker
  against the dark surface), every chart has tap-to-inspect values and a table view, and charts with two or
  more series always have a legend.
- **Your taste, inside the app's rules.** Settings → *Look & feel* (accent, density, motion, balance style,
  preferred chart) applies everywhere without AI. *Design brief* is free text the agent follows on every render,
  using only the catalog; it can be switched off, or applied to Home & Cards as proposals you accept.
- **UI contract** (`backend/src/agent/ui/schema.ts`): generic primitives (text, amount, key/values, buttons,
  chips, notice, stat grid…), data blocks (balance arc, transactions, contacts, chart, cards, confirmation…) and
  **one generic dialog** that covers details, edits, deletions and info.
- **Layouts are data.** Home, Cards and every detail dialog (`detail:transaction|card|contact|profile`) are
  stored specs. Say "keep this as my home", or open Settings → *Your layouts* → *Redesign*. Reset at any time.
- **Offline planner.** A rule-based planner speaks the same contract. It's used when no LLM is configured and
  as an automatic fallback if a model call fails, so the demo always answers.

## Quick start

```bash
cd backend
cp .env.example .env        # set JWT_SECRET (and AI / PayPal keys when you have them)
npm install
npm run dev                 # http://localhost:4000
```

```bash
cd mobile
npm install
npx expo start              # press w for web, or scan with Expo Go (SDK 54)
```

On a phone, the app reaches the API at `http://<your-LAN-IP>:4000` automatically. Set `EXPO_PUBLIC_API_URL`
to point it elsewhere. With `ALLOW_DEV_LOGIN=true`, **Explore the demo account** signs in to a seeded account
(contacts that are real DynoPay users, 30 days of history, two cards and scheduled bills).

## AI providers (LangChain)

| Provider | Env | Notes |
| --- | --- | --- |
| Gemini | `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-2.5-flash`) | `ChatGoogleGenerativeAI` in JSON mode |
| Cloudflare Workers AI | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_MODEL` (default `@cf/openai/gpt-oss-120b`) | `ChatOpenAI` on the OpenAI-compatible endpoint `…/accounts/{id}/ai/v1` (same route as Enjux) |
| Offline | none | Rule-based planner |

`AI_PROVIDER` sets the server default. Each user can switch provider in Settings. The ReAct protocol is plain
JSON, so both providers behave the same; see `backend/src/agent/react.ts` and `manifest.ts`.

## PayPal

Create a REST app at <https://developer.paypal.com/dashboard/applications/sandbox> and set
`PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`.

1. **Log in with PayPal.** Enable it in the app settings with the *email* and *profile* scopes.
   Add the return URL `${PUBLIC_URL}/v1/auth/paypal/callback`. PayPal needs a public HTTPS URL, so in
   development expose the API with a tunnel (`cloudflared tunnel --url http://localhost:4000` or ngrok) and
   set `PUBLIC_URL` to it. The API exchanges the code, creates the user and hands the app a one-time code
   (tokens never travel in URLs).
2. **Top-ups** use Orders v2 (`intent: CAPTURE`). The user approves in PayPal, and the wallet is credited
   exactly once, from either the capture call or the `PAYMENT.CAPTURE.COMPLETED` webhook.
3. **Sending to anyone with an email** uses Payouts (enable Payouts on the sandbox business account).
   Funds are reserved first and refunded automatically if PayPal rejects the payout.
   DynoPay-to-DynoPay transfers are instant ledger moves.
4. **Webhooks.** Point a webhook at `${PUBLIC_URL}/v1/webhooks/paypal` (`PAYMENT.CAPTURE.*`,
   `PAYMENT.PAYOUTS-ITEM.*`) and set `PAYPAL_WEBHOOK_ID`. Every event is signature-verified.

Every PayPal POST carries a `PayPal-Request-Id`, retries use exponential backoff on 429/5xx, and `debug_id`
is logged on errors.

> PayPal's public APIs don't expose a consumer's own PayPal balance, cards or history to third-party apps.
> DynoPay therefore keeps its own wallet ledger, funded from PayPal (top-ups) and paid out through PayPal.
> Virtual cards are wallet sub-balances. Issuing real network cards requires an issuer-processor partner;
> the card model is ready for that integration.

## PayPal status

`GET /v1/paypal/status` (`?refresh=1` re-checks with PayPal) reports what works right now. The same check is
in Settings → PayPal.

- **Platform app** (from its granted scopes): Log in with PayPal, top-ups, payouts and webhooks.
- **Your account:** whether your own PayPal is linked.
- **Merchants:** whether their REST app is verified, and its capabilities.

Sends to people outside DynoPay and top-ups are refused **before** a confirmation is shown when PayPal can't do
them, so a confirmation never fails afterwards. The picker greys out such recipients and says why.

## Personal and merchant accounts

| | Personal | Merchant (business) |
| --- | --- | --- |
| Sign in | **Log in with PayPal** (OpenID: name, email, verified status, payer ID) | **PayPal REST API credentials**: the Client ID + Secret of the merchant's own REST app, sandbox or live |
| Money | DynoPay wallet: top-ups (Orders v2), instant transfers, PayPal payouts, virtual cards, requests, schedules | Everything personal has, **plus the merchant's real PayPal account** |
| Merchant features | none (actions are filtered out of the agent, MCP and API) | balance & Transaction Search, sales analytics, Invoicing v2, payment links (Orders v2), refunds (Payments v2), disputes, catalog products, subscription plans and subscriptions, payouts from the business balance, shipment tracking |
| Home | sun-arc wallet | merchant dashboard (PayPal balance, 30-day sales, invoices, PayPal activity) |

Log in with PayPal doesn't tell an app whether an account is personal or business, so the user chooses. A personal user
can also connect business credentials later (Settings → Account), which upgrades the account.

**Signing in with the REST API** (works from any HTTP client, not just the app):

```bash
curl -X POST http://localhost:4000/v1/auth/paypal/credentials \
  -H "Content-Type: application/json" \
  -d '{"clientId":"<REST app client id>","clientSecret":"<secret>","environment":"sandbox","businessName":"Acme Studio"}'
# → { accessToken, refreshToken, user: { accountType: "business", … }, merchant: { capabilities: […] } }
```

- The server proves ownership by obtaining a token from PayPal with those credentials. The merchant is identified by
  (environment, client id); accounts are never merged by email.
- The secret is stored AES-256-GCM encrypted (`CREDENTIALS_ENCRYPTION_KEY`) and never returned. If PayPal starts
  rejecting it, the connection is marked invalid and the app asks to reconnect.
- Capabilities come from the scopes PayPal granted the app (e.g. Transaction Search, Invoicing, Disputes, Subscriptions,
  Payouts). Enable features for the app in the PayPal developer dashboard, then reconnect. A disabled feature returns a
  clear 403 instead of a broken screen.
- Merchant actions follow the same human-in-the-loop rule. Sending or cancelling invoices, reminders, refunds, accepting
  claims, messaging buyers, payouts and changing subscriptions need the confirmation button. Every PayPal POST uses
  the pending action's id as `PayPal-Request-Id`, so retries never duplicate.
- Other endpoints: `GET|PUT|DELETE /v1/merchant/connection` (view, connect or rotate, disconnect).

## Database

SQLite by default (`DATABASE_URL=sqlite:./data/dynopay.sqlite`). To switch, change only the URL:

```bash
npm i pg pg-hstore   # DATABASE_URL=postgres://user:pass@host:5432/dynopay
npm i mysql2         # DATABASE_URL=mysql://user:pass@host:3306/dynopay
```

Balances are integer cents, changed with conditional `UPDATE … WHERE balance >= amount`, so they never go
negative under concurrency on any dialect. On SQLite, write transactions are queued in-process (single writer).

## Guard: requests that can't be fulfilled

Before any engine runs, `agent/guard.ts` checks the sentence against the real account: balance, per-transfer
and daily limits, contacts, cards and merchant capabilities. It also catches attempts to change the rules
("skip the confirmation", "ignore your instructions", someone else's account). The check runs on the sentence
after other languages are mapped to English keywords.

- **Rejected requests:** the response carries `rejection {code, message}`. The prompt bar turns red with the
  message, nothing runs, and the answer may add help such as a contact picker or the balance.
- **The LLM:** it gets the same account facts and can return a `rejection` itself.

## Pick, then confirm

Sends, card actions and deletions first show a `picker` block (recipient, card, schedule, request). The server
lists the items and their eligibility, for example "Frozen" or "Only $20 on this card", and computes each
item's input patch. **Continue** prepares the action, which still opens its confirmation.

- **Named targets:** "deposit 30 on my second card" uses the card the sentence names.
- **Unclear targets:** "move 30 to my card" asks which card.

## What the app understood

While you type, the server breaks the sentence into its main elements and returns them as `intent` with every
answer, previews included. The app shows them as chips under the prompt bar, like the concept video:

```
send 500 to sara for dinner   →   [Send] [$500.00] [(SN) Sara Nasser @saranasser] [for Dinner]
send 500 to john@gmail.com    →   [Send] [$500.00] [john@gmail.com · PayPal]
send to sara                  →   [Send] [How much?] [(SN) Sara Nasser]
```

- **Resolved against the account:** people are matched to your contacts ("2 matches · pick below" when it's
  ambiguous), emails become PayPal recipients, and cards are named by label, last 4 digits or "second".
- **Highlighted in the sentence:** the same words are highlighted where you typed them, on native and web,
  in any language.
- **Not an approval:** the chips only show what was understood. The picker and the confirmation still decide
  what happens.

## Languages

Write in any language. Detection is offline: scripts (Arabic, Hebrew, Persian, Urdu…), built-in rules for
en/fr/sw/es/pt/ar/he, and `franc` for 400+ others.

- **Answers:** they come back in that language, and with **Follow my language** the whole UI switches to it:
  screens, buttons, dialogs, dates and confirmations.
- **Shipped dictionaries:** French, Swahili, Spanish (`mobile/src/i18n/locales.ts`) and Arabic
  (`locales.ar.ts`) ship with the app, so they work without an AI key. `npm run i18n:check` verifies that every
  UI string is translated.
- **Right-to-left:** Arabic, Hebrew, Persian, Urdu… mirror the whole layout, not just the text.
  - On web this sets `dir="rtl"`. On native, `I18nManager` switches and the app reloads once.
  - Text aligns from the right, and directional icons flip.
  - Arabic-Indic digits are read as amounts, and the attached "to" (لسارة) is understood.
- **Other languages:** translated once by the server (`POST /v1/i18n/translate`: packs, then DB cache, then AI).
  Only app strings are sent, never user data.
- **Language choice:** English is the default, and the sign-in screen can reset to it.
- **New UI strings:** after adding some, run `npm run i18n:extract` in `mobile/`.

## Themes

Settings → Theme turns words into a full theme, in any language: "dark forest green with gold", "thème clair
bleu". The generator works in OKLCH and enforces contrast: text ≥ 7:1, muted text ≥ 4.5:1, accent ≥ 3:1, and
text on buttons ≥ 4.5:1. A request like "white text on white" therefore can't produce an unreadable theme.

- **Flow:** preview first, then apply. Every screen, dialog, chart palette and the status bar follow it.
- **On device:** the look is restored before any style module loads (`theme/boot.ts`), and a change reloads the
  app on the same screen.

## Last answer stays

The UI of the last submitted request stays on screen, across launches too, until a new request replaces it or
you tap **Clear** (`GET/DELETE /v1/ui/last/:screen`). After an action, it refreshes with fresh data.

## MCP

`POST /mcp` (Streamable HTTP, stateless) exposes tools plus a `dynopay://manifest` resource. It is locked down:

- **Authentication:** only scoped, revocable MCP tokens (`dpm_…`) created in Settings → Connected agents are
  accepted (`/v1/mcp/tokens`). Only a hash is stored and the token is shown once. App session tokens are
  refused unless `MCP_ALLOW_SESSION_TOKENS=true`.
- **Authorization:** tools are exactly the actions this user may use. That means the account type plus the
  merchant capabilities their PayPal app grants, narrowed by the token scope (`read` or `read + propose`).
  The same capability filter applies to the in-app agent and to `/v1/actions`.
- **Browser protection:** browser `Origin`s must be allow-listed (DNS-rebinding protection), and each token is
  rate limited (`MCP_RATE_PER_MINUTE`).
- **Confirmation:** confirm-level tools only return a pending action that the user approves in the app.

## Jobs

- `POST /v1/internal/run-schedules` runs due recurring payments.
- `POST /v1/internal/sync-payouts` reconciles payouts if a webhook was missed.

Both need the `X-Cron-Secret: $CRON_SECRET` header. Call them from any scheduler (Cloud Scheduler, cron, GitHub Actions).

## Tests

```bash
cd backend && npm test        # 113 tests (Vitest + supertest)
cd backend && npm run typecheck
cd mobile && npm test         # 24 tests (jest-expo + React Native Testing Library)
cd mobile && npm run typecheck && npm run lint && npm run i18n:check
```

**Backend coverage:**

- **Core:** ledger and limits, the confirmation gate, the ReAct loop with a scripted LangChain model, plan
  cache, charts.
- **Safety and UI:** the guard (wrong recipients, insufficient funds, manipulation), pickers, the "understood"
  intent, languages including RTL, themes and contrast, last view.
- **MCP:** tokens, scopes, revocation and origins.
- **Merchant PayPal** (fake REST API): sign-in with REST credentials, encrypted secrets, capabilities,
  invoices, refunds, disputes.
- **Personal PayPal** (fake platform app): Log in with PayPal (OIDC round trip, one-time codes), top-ups (Orders
  v2 capture, and a capture/webhook race credited once), payouts to any email (success, returned money,
  reconciliation), forged webhooks, and refusal before confirmation when Payouts isn't enabled.

**Mobile coverage:** every UI string is translated in fr/sw/es/ar, with placeholders kept. Also covered:
`<Text>` translating app strings but never data, RTL alignment, the "understood" chips, the prompt bar (live
changes, red rejection, highlighted words), and the picker (nothing runs before a choice, the server's patch
is used, ineligible items can't be chosen).

### Manual test script (demo account, no keys needed)

1. Sign in with **Explore the demo account**.
   - The sign-in screen has a language picker. Pick **Kiswahili** and back with **English**.
2. Type `send 500 to sara for dinner`.
   - Chips show *Send · $500.00 · Sara Nasser · for Dinner*.
   - The picker preselects Sara.
   - **Continue** opens the Hold-to-send confirmation.
3. Type `send 200 to 6789`. The prompt bar turns red, explains why, and offers your contacts.
4. Type `send send 300` (unclear). Then type `send 99999 to sara` (more than your balance).
5. Type `deposit 30 on my second card`. Then type `move 30 to my card` (it asks which card).
6. Type `delete Sara from my contacts`. You select first, then confirm.
7. Write in Swahili: `Tuma 50 kwa Sara kwa ajili ya chakula`. The whole UI switches to Swahili.
8. Write in Arabic: `أرسل ٥٠ إلى Sara من أجل العشاء`. The UI switches to Arabic and mirrors right-to-left.
9. Open Settings → **Theme**, type `light and calm, ocean blue`, then **Preview** and **Apply**.
10. Open Settings → **PayPal** to see what the server's PayPal app can do. Use **Check connection** to re-verify.
11. Open Settings → **Connected agents (MCP)** and create a read-only token. Call `POST /mcp` with it.

With PayPal sandbox keys in `backend/.env`, the same script also covers:

- **Continue with PayPal:** Log in with PayPal.
- **Top up 25:** approve in the PayPal sandbox.
- **Send 10 to a sandbox personal email:** goes out as a payout.

**Sign in as a merchant** with a sandbox REST app's Client ID and Secret covers sales, invoices, refunds and
disputes.

## Production checklist

- Set `NODE_ENV=production`, a strong `JWT_SECRET`, `PAYPAL_ENV=live` with live credentials, and HTTPS `PUBLIC_URL`.
  Dev login is force-disabled in production.
- Use Postgres or MySQL, set `DB_SYNC_ALTER=false`, and manage schema changes with migrations.
- Tune `LIMIT_PER_TRANSFER` and `LIMIT_DAILY_OUT`.
- Mobile: `npx eas-cli@latest build`, with `EXPO_PUBLIC_API_URL` set per build profile.
- Holding customer funds is regulated (money transmission / e-money). Run this under the right license or partner.
