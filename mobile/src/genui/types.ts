/** Mirror of the backend UI contract (backend/src/agent/ui/schema.ts). The server validates; the app renders. */

export type Tone = 'default' | 'muted' | 'accent' | 'positive' | 'negative';
export type IconName =
  | 'send' | 'plus' | 'split' | 'card' | 'chart' | 'arrow-up' | 'arrow-down' | 'arrow-right' | 'arrow-left' | 'lock' | 'unlock' | 'trash' | 'edit'
  | 'check' | 'close' | 'user' | 'users' | 'calendar' | 'repeat' | 'wallet' | 'paypal' | 'shield' | 'info' | 'warning' | 'search'
  | 'settings' | 'star' | 'sparkle' | 'receipt' | 'bolt' | 'mic' | 'chevron-right' | 'logout';

export type Field = {
  name: string;
  label: string;
  kind: 'text' | 'number' | 'amount' | 'email' | 'toggle' | 'select';
  value?: string | number | boolean;
  placeholder?: string;
  options?: { label: string; value: string }[];
  required?: boolean;
};

export type DialogSpec = {
  title: string;
  message?: string;
  icon?: IconName;
  tone?: 'default' | 'danger' | 'success';
  blocks?: Block[];
  fields?: Field[];
  buttons?: ButtonSpec[];
};

export type Action =
  | { type: 'run'; action: string; input?: Record<string, unknown> }
  | { type: 'confirm'; pendingId: string }
  | { type: 'open'; kind: 'transaction' | 'card' | 'contact' | 'profile' | 'invoice' | 'dispute'; id?: string }
  | { type: 'ask'; prompt: string }
  | { type: 'prefill'; text: string }
  | { type: 'navigate'; screen: 'home' | 'cards' | 'settings' }
  | { type: 'open_url'; url: string }
  | { type: 'reset_view' }
  | { type: 'close' }
  | { type: 'pin'; slot: 'home' | 'cards' }
  | { type: 'dialog'; dialog: DialogSpec };

export type ButtonSpec = { label: string; icon?: IconName; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; action: Action };

type Data<T> = { data?: T; error?: string };

export type Block = (
  | { type: 'text'; text: string; variant?: 'display' | 'title' | 'heading' | 'body' | 'caption' | 'label'; tone?: Tone; align?: 'left' | 'center' }
  | { type: 'amount'; value: number; currency?: string; caption?: string; size?: 'xl' | 'lg' | 'md'; tone?: Tone }
  | { type: 'key_values'; rows: { label: string; value: string; tone?: Tone; action?: Action }[] }
  | ({ type: 'button'; fullWidth?: boolean } & ButtonSpec)
  | { type: 'buttons'; items: ButtonSpec[]; layout?: 'row' | 'column' }
  | { type: 'chips'; items: { label: string; icon?: IconName; action: Action }[] }
  | { type: 'notice'; tone?: 'info' | 'success' | 'warning' | 'error'; title?: string; text: string }
  | { type: 'stat_grid'; items: { label: string; value: string; caption?: string; tone?: Tone }[] }
  | { type: 'empty'; title: string; text?: string; icon?: IconName }
  | { type: 'divider' }
  | { type: 'spacer'; size?: 'sm' | 'md' | 'lg' }
  | ({ type: 'balance'; variant?: 'arc' | 'compact' | 'minimal' } & Data<BalanceData>)
  | ({ type: 'transactions'; title?: string; query?: Record<string, unknown>; groupBy?: 'day' | 'none' | 'category' | 'counterparty'; variant?: 'list' | 'compact'; highlightId?: string; emptyText?: string } & Data<{ items: Tx[]; total: number }>)
  | ({ type: 'contacts'; title?: string; variant?: 'avatars' | 'list'; search?: string; limit?: number; showNew?: boolean; onSelect?: 'open' | 'prefill_send' } & Data<Contact[]>)
  | ({ type: 'chart'; title?: string; kind?: ChartKind; query?: Record<string, unknown> } & Data<ChartData>)
  | ({ type: 'cards'; variant?: 'carousel' | 'stack' | 'list'; showActions?: boolean } & Data<Card[]>)
  | ({ type: 'card'; cardId: string; showActions?: boolean; showDetails?: boolean } & Data<Card>)
  | ({ type: 'transaction'; transactionId: string; variant?: 'receipt' | 'detail' } & Data<Tx>)
  | ({ type: 'contact'; contactId: string; variant?: 'profile' | 'compact' } & Data<ContactDetail>)
  | ({ type: 'profile'; variant?: 'card' | 'compact' } & Data<User>)
  | ({ type: 'schedules'; title?: string; limit?: number } & Data<ScheduleItem[]>)
  | ({ type: 'requests'; title?: string; perspective?: 'incoming' | 'outgoing' | 'all' } & Data<RequestItem[]>)
  | ({ type: 'picker'; kind: 'contact' | 'card' | 'schedule' | 'request'; title?: string; search?: string; preselect?: string; action: string; input: Record<string, unknown> } & Data<PickerData>)
  | ({ type: 'confirmation'; pendingId: string; draft?: { action: string; input: Record<string, unknown> } } & Data<PendingView | DraftView>)
  | ({ type: 'merchant_overview' } & Data<MerchantOverview>)
  | ({ type: 'merchant_sales'; title?: string; days?: number; kind?: 'bar' | 'line' | 'area' | 'sparkline' | 'heatmap' } & Data<SalesSummary>)
  | ({ type: 'paypal_transactions'; title?: string; days?: number; limit?: number; search?: string; direction?: 'in' | 'out' } & Data<{ items: PayPalTx[]; total: number }>)
  | ({ type: 'invoices'; title?: string; status?: string; limit?: number } & Data<{ items: Invoice[]; total: number }>)
  | ({ type: 'invoice'; invoiceId: string } & Data<Invoice>)
  | ({ type: 'disputes'; title?: string; status?: string } & Data<Dispute[]>)
  | ({ type: 'dispute'; disputeId: string } & Data<Dispute & { messages?: { posted_by?: string; time_posted?: string; content?: string }[]; transactionId?: string | null; buyer?: string | null }>)
  | ({ type: 'catalog'; kind?: 'products' | 'plans' } & Data<CatalogItem[]>)
  | { type: 'section'; title?: string; subtitle?: string; trailing?: { label: string; action: Action }; style?: 'plain' | 'card'; children: Block[] }
  | { type: 'row'; children: Block[] }
);

export type Entity = { text: string; kind: 'amount' | 'person' | 'purpose' | 'card' | 'date' | 'other' };

export type Spec = {
  version: 1;
  title?: string;
  say?: string;
  blocks: Block[];
  dialog?: DialogSpec;
  entities?: Entity[];
  currency?: string;
  rejection?: Rejection;
  language?: string;
};

export type RejectionCode = 'manipulation' | 'invalid_recipient' | 'unclear' | 'invalid_amount' | 'insufficient_funds' | 'limit_exceeded' | 'not_allowed' | 'not_found' | 'cannot_fulfill';
export type Rejection = { code: RejectionCode; message: string };

export type PickerItem = { id: string; title: string; subtitle: string; initials?: string; badge?: string; disabled?: boolean; reason?: string; patch: Record<string, unknown> };
export type PickerData = { action: string; input: Record<string, unknown>; preselect: string | null; searchMiss: boolean; items: PickerItem[] };

export type ThemeTokens = Record<
  'bg' | 'bgRaised' | 'surface' | 'surfaceHigh' | 'hairline' | 'border' | 'text' | 'textMuted' | 'textFaint' | 'accent' | 'accentDeep' | 'onAccent' | 'inverse' | 'onInverse' | 'positive' | 'negative' | 'warning' | 'info',
  string
>;
export type Theme = { name: string; prompt: string; mode: 'dark' | 'light'; colors: ThemeTokens };
export type ThemeAudit = { text: number; textMuted: number; textFaint: number; accent: number; onAccent: number; onInverse: number };

export type McpScope = 'read' | 'propose';
export type McpToken = { id: string; name: string; hint: string; scopes: McpScope[]; expiresAt: string | null; lastUsedAt: string | null; createdAt: string };

export type Engine = 'cache' | 'offline' | 'llm' | 'guard' | 'none';

export type AgentResult = {
  conversationId: string | null;
  mode: 'preview' | 'commit';
  provider: 'gemini' | 'cloudflare' | 'offline';
  engine: Engine;
  cache?: 'exact' | 'similar';
  usage: { input: number; output: number; calls: number };
  fallback: boolean;
  spec: Spec;
  steps: { thought?: string; tool?: string; ok?: boolean; error?: string }[];
  /** Language of the texts in the spec (the UI follows it when auto-language is on). */
  language: string;
  /** The request can't be fulfilled: red prompt bar + this message. */
  rejection: Rejection | null;
  /** The main elements understood from the sentence (chips under the prompt bar). */
  intent: Intent;
};

export type IntentPart =
  | { kind: 'action'; label: string; text?: string }
  | { kind: 'amount'; label: string; value: number; text?: string }
  | { kind: 'person'; label: string; subtitle?: string; initials?: string; status: 'matched' | 'ambiguous' | 'unknown' | 'email'; candidates?: number; text?: string }
  | { kind: 'card'; label: string; subtitle?: string; text?: string }
  | { kind: 'purpose'; label: string; text?: string }
  | { kind: 'missing'; label: string };
export type Intent = { parts: IntentPart[]; complete: boolean };

// ─── Data shapes (from backend services/serialize.ts) ──────────────────────

export type User = {
  id: string;
  name: string;
  firstName: string;
  initials: string;
  email: string;
  handle: string;
  verified: boolean;
  currency: string;
  accountType: 'personal' | 'business';
  paypalLinked: boolean;
  memberSince: string;
  merchant?: MerchantConnection | null;
  settings: Settings;
};

export type Accent = 'amber' | 'ocean' | 'rose' | 'forest' | 'violet';
export type ChartStyle = 'auto' | 'bar' | 'hbar' | 'line' | 'area' | 'sparkline' | 'donut' | 'pie' | 'progress' | 'heatmap';
export type Design = {
  enabled: boolean;
  brief: string;
  accent: Accent;
  density: 'comfortable' | 'compact';
  motion: 'full' | 'reduced';
  balanceStyle: 'arc' | 'compact' | 'minimal';
  chartStyle: ChartStyle;
  /** A custom theme generated from the user's words (contrast-checked); null = default. */
  theme: Theme | null;
};
export type Settings = {
  aiProvider?: 'gemini' | 'cloudflare' | 'offline';
  biometricForSensitive: boolean;
  haptics: boolean;
  liveAgent: boolean;
  cacheMode: 'off' | 'exact' | 'similar';
  cacheMaxReuse: number;
  preferOffline: boolean;
  /** UI language (BCP-47 base code), English by default. */
  language: string;
  /** Follow the language the user writes in. */
  autoLanguage: boolean;
  design: Design;
};
export type SettingsPatch = Partial<Omit<Settings, 'design'>> & { design?: Partial<Design> };

export type BalanceData = {
  balance: number;
  currency: string;
  formatted: string;
  greeting: string;
  caption: string;
  week: null | {
    days: { date: string; label: string; isToday: boolean }[];
    events: { id: string; date: string; name: string; amount: number; formatted: string }[];
    planned: number;
    formattedPlanned: string;
  };
};

export type Tx = {
  id: string;
  direction: 'in' | 'out';
  kind: string;
  status: 'pending' | 'completed' | 'failed' | 'reversed';
  amount: number;
  signedAmount: number;
  currency: string;
  formatted: string;
  counterparty: { name: string; initials: string; handle: string | null; email: string | null; contactId: string | null; isDynoPayUser: boolean };
  cardId: string | null;
  category: string;
  note: string | null;
  balanceAfter: number | null;
  reference: string | null;
  createdAt: string;
};

export type Contact = { id: string; name: string; initials: string; email: string | null; handle: string | null; isDynoPayUser: boolean; favorite: boolean; lastPaidAt: string | null };
export type ContactDetail = Contact & { totals: { sent: number; received: number; transactions: number; currency: string } };

export type Card = {
  id: string;
  label: string;
  last4: string;
  color: string;
  status: 'active' | 'frozen' | 'closed';
  balance: number;
  currency: string;
  formattedBalance: string;
  monthlyLimit: number | null;
  spentThisMonth: number;
  expiry: string;
};

export type ChartKind = 'bar' | 'hbar' | 'line' | 'area' | 'sparkline' | 'donut' | 'pie' | 'progress' | 'gauge' | 'heatmap' | 'stacked' | 'grouped';
export type ChartBucket = { key: string; label: string; amount: number; share: number };

export type ChartData = {
  period: string;
  groupBy: string;
  direction: 'in' | 'out' | 'both';
  currency: string;
  total: number;
  formattedTotal: string;
  count: number;
  target?: number | null;
  buckets: ChartBucket[];
  /** direction=both: aligned Spent / Received series. */
  series?: { key: string; name: string; total: number; buckets: ChartBucket[] }[] | null;
};

export type ScheduleItem = { id: string; name: string; recipientName: string | null; amount: number; currency: string; formatted: string; recurrence: 'weekly' | 'monthly'; nextRunAt: string; status: string };
export type RequestItem = { id: string; perspective: 'incoming' | 'outgoing'; requesterName: string | null; payerName: string; amount: number; currency: string; formatted: string; note: string | null; status: string; createdAt: string };

export type ConfirmSummary = {
  title: string;
  amount?: number;
  currency?: string;
  recipient?: { name: string; initials: string; subtitle: string; verified: boolean };
  lines: { label: string; value: string }[];
  confirmLabel: string;
  style: 'hold' | 'tap';
  tone: 'default' | 'danger';
  biometric: boolean;
};

export type PendingView = {
  id: string;
  action: string;
  status: 'pending' | 'executing' | 'executed' | 'cancelled' | 'expired' | 'failed';
  summary: ConfirmSummary;
  input: Record<string, unknown>;
  expiresAt: string;
  result: Record<string, unknown> | null;
  error: string | null;
};

/** A would-be action shown while typing; pressing it calls the action for real (still confirmed). */
export type DraftView = Omit<PendingView, 'status' | 'expiresAt'> & { status: 'draft'; risk: 'auto' | 'confirm'; expiresAt: null };

export type UsageReport = {
  usage: { days: number; llmRuns: number; inputTokens: number; outputTokens: number; cacheHits: number; offlineRuns: number; tokensSaved: number; savingsRate: number };
  cache: { plans: number; reusable: number; hits: number };
};

export type PerformResult =
  | { status: 'done'; action: string; risk: 'read' | 'auto'; result: unknown }
  | { status: 'needs_confirmation'; action: string; risk: 'confirm'; pending: PendingView };

// ─── Merchant (business accounts) ──────────────────────────────────────────

export type MerchantConnection = {
  environment: 'sandbox' | 'live';
  businessName: string;
  clientId: string;
  appId: string | null;
  accountId: string | null;
  status: 'active' | 'invalid';
  capabilities: { key: string; label: string; enabled: boolean }[];
  lastVerifiedAt: string | null;
};

export type SalesSummary = {
  days: number;
  currency: string;
  gross: number;
  fees: number;
  refunded: number;
  net: number;
  count: number;
  average: number;
  formattedGross: string;
  formattedNet: string;
  buckets: { key: string; label: string; amount: number; share: number }[];
};

export type MerchantOverview = {
  businessName: string;
  environment: 'sandbox' | 'live';
  balance: null | { accountId: string | null; primary: { currency: string; total: number; available: number; withheld: number; formatted: string } | null; balances: { currency: string; total: number; formatted: string }[] };
  sales30: SalesSummary | null;
  unpaidInvoices: { count: number; total: number } | null;
  openDisputes: number | null;
  capabilities: { key: string; label: string; enabled: boolean }[];
  /** Human-readable hints for missing PayPal REST app scopes, shown as warnings in the UI. */
  capabilityWarnings?: string[];
};

export type PayPalTx = {
  id: string;
  date: string | null;
  type: string;
  status: string;
  direction: 'in' | 'out';
  amount: number;
  fee: number;
  net: number;
  currency: string;
  formatted: string;
  counterparty: string;
  email: string | null;
  subject: string | null;
  note: string | null;
  invoiceId: string | null;
};

export type Invoice = {
  id: string;
  number: string | null;
  status: string;
  recipient: string;
  recipientEmail: string | null;
  total: number;
  due: number;
  currency: string;
  formatted: string;
  formattedDue: string;
  invoiceDate: string | null;
  dueDate: string | null;
  termType: string | null;
  note: string | null;
  items: { name: string; quantity: number; unitAmount: number }[];
  payerUrl: string | null;
};

export type Dispute = {
  id: string;
  reason: string;
  status: string;
  stage: string | null;
  amount: number;
  currency: string;
  formatted: string;
  createdAt: string | null;
  respondBy: string | null;
  needsAction: boolean;
};

export type CatalogItem = { id: string; name: string; status?: string; description?: string; type?: string; price?: { currency_code: string; value: string } | null; interval?: string | null };
