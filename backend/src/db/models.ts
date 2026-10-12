import {
  DataTypes,
  Model,
  type CreationOptional,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';

const id = () => ({ type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true });
const money = (allowNull = false) => ({ type: DataTypes.INTEGER, allowNull, defaultValue: allowNull ? null : 0 });

/** Raw JSON; always read through services/settings.resolveSettings. */
export type UserSettings = {
  [key: string]: unknown;
  aiProvider?: 'gemini' | 'cloudflare' | 'offline';
  biometricForSensitive?: boolean;
  haptics?: boolean;
};

export type AccountType = 'personal' | 'business';

export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<string>;
  /** personal: Log in with PayPal identity + DynoPay wallet. business: also a PayPal merchant (REST credentials). */
  declare accountType: CreationOptional<AccountType>;
  declare paypalUserId: string | null;
  declare paypalPayerId: string | null;
  declare email: string;
  declare name: string;
  declare handle: string;
  declare verified: CreationOptional<boolean>;
  declare currency: CreationOptional<string>;
  declare settings: CreationOptional<UserSettings>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Account extends Model<InferAttributes<Account>, InferCreationAttributes<Account>> {
  declare id: CreationOptional<string>;
  declare userId: ForeignKey<User['id']>;
  declare balance: CreationOptional<number>;
  declare currency: string;
}

export type TxDirection = 'in' | 'out';
export type TxKind = 'transfer' | 'topup' | 'payout' | 'card_funding' | 'card_spend' | 'refund' | 'request_payment' | 'schedule';
export type TxStatus = 'pending' | 'completed' | 'failed' | 'reversed';

export class Transaction extends Model<InferAttributes<Transaction>, InferCreationAttributes<Transaction>> {
  declare id: CreationOptional<string>;
  declare userId: ForeignKey<User['id']>;
  declare direction: TxDirection;
  declare amount: number;
  declare currency: string;
  declare kind: TxKind;
  declare status: CreationOptional<TxStatus>;
  declare counterpartyName: string;
  declare counterpartyHandle: string | null;
  declare counterpartyEmail: string | null;
  declare counterpartyUserId: string | null;
  declare contactId: string | null;
  declare cardId: string | null;
  declare category: CreationOptional<string>;
  declare note: string | null;
  declare balanceAfter: number | null;
  declare groupId: string | null;
  declare externalRef: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Contact extends Model<InferAttributes<Contact>, InferCreationAttributes<Contact>> {
  declare id: CreationOptional<string>;
  declare userId: ForeignKey<User['id']>;
  declare name: string;
  declare email: string | null;
  declare handle: string | null;
  declare linkedUserId: string | null;
  declare favorite: CreationOptional<boolean>;
  declare lastPaidAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export type CardStatus = 'active' | 'frozen' | 'closed';

export class Card extends Model<InferAttributes<Card>, InferCreationAttributes<Card>> {
  declare id: CreationOptional<string>;
  declare userId: ForeignKey<User['id']>;
  declare label: string;
  declare last4: string;
  declare color: CreationOptional<string>;
  declare status: CreationOptional<CardStatus>;
  declare balance: CreationOptional<number>;
  declare monthlyLimit: number | null;
  declare expMonth: number;
  declare expYear: number;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export type Recurrence = 'weekly' | 'monthly';

export class Schedule extends Model<InferAttributes<Schedule>, InferCreationAttributes<Schedule>> {
  declare id: CreationOptional<string>;
  declare userId: ForeignKey<User['id']>;
  declare name: string;
  declare contactId: string | null;
  declare amount: number;
  declare recurrence: Recurrence;
  declare nextRunAt: Date;
  declare status: CreationOptional<'active' | 'paused' | 'cancelled'>;
  declare note: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class MoneyRequest extends Model<InferAttributes<MoneyRequest>, InferCreationAttributes<MoneyRequest>> {
  declare id: CreationOptional<string>;
  declare requesterId: ForeignKey<User['id']>;
  declare payerUserId: string | null;
  declare payerEmail: string | null;
  declare payerName: string;
  declare amount: number;
  declare currency: string;
  declare note: string | null;
  declare status: CreationOptional<'pending' | 'paid' | 'declined' | 'cancelled'>;
  declare groupId: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export type PendingStatus = 'pending' | 'executing' | 'executed' | 'cancelled' | 'expired' | 'failed';

/**
 * A sensitive action proposed by the agent (or a button). It does nothing until
 * the user explicitly confirms it; the server re-validates on execution.
 */
export class PendingAction extends Model<InferAttributes<PendingAction>, InferCreationAttributes<PendingAction>> {
  declare id: CreationOptional<string>;
  declare userId: ForeignKey<User['id']>;
  declare type: string;
  declare payload: Record<string, unknown>;
  declare summary: Record<string, unknown>;
  declare status: CreationOptional<PendingStatus>;
  declare result: Record<string, unknown> | null;
  declare error: string | null;
  declare expiresAt: Date;
  declare executedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class PaypalOrder extends Model<InferAttributes<PaypalOrder>, InferCreationAttributes<PaypalOrder>> {
  declare id: string; // PayPal order id
  declare userId: ForeignKey<User['id']>;
  declare amount: number;
  declare currency: string;
  declare status: string;
  declare captureId: string | null;
  declare transactionId: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class UiLayout extends Model<InferAttributes<UiLayout>, InferCreationAttributes<UiLayout>> {
  declare id: CreationOptional<string>;
  declare userId: ForeignKey<User['id']>;
  declare slot: string;
  declare spec: Record<string, unknown>;
  declare instruction: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export type ChatTurn = { role: 'user' | 'assistant'; content: string; at: string };

export class Conversation extends Model<InferAttributes<Conversation>, InferCreationAttributes<Conversation>> {
  declare id: CreationOptional<string>;
  declare userId: ForeignKey<User['id']>;
  declare turns: CreationOptional<ChatTurn[]>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Session extends Model<InferAttributes<Session>, InferCreationAttributes<Session>> {
  declare id: CreationOptional<string>;
  declare userId: ForeignKey<User['id']>;
  declare refreshHash: string;
  declare expiresAt: Date;
  declare revokedAt: Date | null;
  declare userAgent: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/**
 * A merchant's own PayPal REST app. The secret is AES-256-GCM encrypted at rest and never returned by the API.
 * One connection per (environment, client id); a user has at most one active connection.
 */
export class MerchantConnection extends Model<InferAttributes<MerchantConnection>, InferCreationAttributes<MerchantConnection>> {
  declare id: CreationOptional<string>;
  declare userId: ForeignKey<User['id']>;
  declare environment: 'sandbox' | 'live';
  declare clientId: string;
  declare secretEnc: string;
  declare appId: string | null;
  declare accountId: string | null;
  declare businessName: string;
  declare scopes: CreationOptional<string[]>;
  declare status: CreationOptional<'active' | 'invalid'>;
  declare lastVerifiedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** A reusable agent plan (tool calls + UI) keyed by a templated sentence, so repeats cost no tokens. */
export class PlanCache extends Model<InferAttributes<PlanCache>, InferCreationAttributes<PlanCache>> {
  declare id: CreationOptional<string>;
  declare userId: ForeignKey<User['id']>;
  declare key: string;
  declare slots: { kind: string; value: string }[];
  declare plan: Record<string, unknown>;
  declare exactOnly: boolean;
  declare tokens: CreationOptional<number>;
  declare hits: CreationOptional<number>;
  declare lastUsedAt: Date;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** Daily per-user AI consumption and savings. */
export class AgentUsage extends Model<InferAttributes<AgentUsage>, InferCreationAttributes<AgentUsage>> {
  declare id: CreationOptional<string>;
  declare userId: ForeignKey<User['id']>;
  declare day: string;
  declare llmRuns: CreationOptional<number>;
  declare inputTokens: CreationOptional<number>;
  declare outputTokens: CreationOptional<number>;
  declare cacheHits: CreationOptional<number>;
  declare offlineRuns: CreationOptional<number>;
  declare tokensSaved: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** Cached translation of a server text (built-in packs cover fr/sw/es; others come from the LLM once). */
export class Translation extends Model<InferAttributes<Translation>, InferCreationAttributes<Translation>> {
  declare id: CreationOptional<string>;
  declare lang: string;
  declare sourceHash: string;
  declare source: string;
  declare text: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** The UI of the user's last request on a screen: it stays until a new request (or Clear) replaces it. */
export class LastView extends Model<InferAttributes<LastView>, InferCreationAttributes<LastView>> {
  declare id: CreationOptional<string>;
  declare userId: ForeignKey<User['id']>;
  declare screen: string;
  declare prompt: string;
  declare spec: Record<string, unknown>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export type McpScope = 'read' | 'propose';

/**
 * A personal access token for external agents over MCP (Claude, ChatGPT…). Only its SHA-256 is
 * stored; it is shown once. Scopes: read (data only) or propose (also prepares changes that the
 * user approves in the app). It never grants more than the user's own permissions.
 */
export class McpToken extends Model<InferAttributes<McpToken>, InferCreationAttributes<McpToken>> {
  declare id: CreationOptional<string>;
  declare userId: ForeignKey<User['id']>;
  declare name: string;
  declare tokenHash: string;
  declare hint: string;
  declare scopes: McpScope[];
  declare expiresAt: Date | null;
  declare revokedAt: Date | null;
  declare lastUsedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

/** Short-lived records for the PayPal OAuth round-trip (state) and the app hand-off (one-time code). */
export class AuthTicket extends Model<InferAttributes<AuthTicket>, InferCreationAttributes<AuthTicket>> {
  declare id: string; // hash of the state or one-time code
  declare kind: 'state' | 'code';
  declare userId: string | null;
  declare redirect: string | null;
  declare expiresAt: Date;
  declare usedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export function initModels(sequelize: Sequelize) {
  const ts = { createdAt: DataTypes.DATE, updatedAt: DataTypes.DATE };

  User.init(
    {
      id: id(),
      accountType: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'personal' },
      paypalUserId: { type: DataTypes.STRING, allowNull: true, unique: true },
      paypalPayerId: { type: DataTypes.STRING, allowNull: true },
      email: { type: DataTypes.STRING, allowNull: false, unique: true },
      name: { type: DataTypes.STRING, allowNull: false },
      handle: { type: DataTypes.STRING, allowNull: false, unique: true },
      verified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'USD' },
      settings: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
      ...ts,
    },
    { sequelize, tableName: 'users' },
  );

  Account.init(
    {
      id: id(),
      userId: { type: DataTypes.UUID, allowNull: false, unique: true },
      balance: money(),
      currency: { type: DataTypes.STRING(3), allowNull: false },
    },
    { sequelize, tableName: 'accounts' },
  );

  Transaction.init(
    {
      id: id(),
      userId: { type: DataTypes.UUID, allowNull: false },
      direction: { type: DataTypes.STRING(3), allowNull: false },
      amount: money(),
      currency: { type: DataTypes.STRING(3), allowNull: false },
      kind: { type: DataTypes.STRING(24), allowNull: false },
      status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'completed' },
      counterpartyName: { type: DataTypes.STRING, allowNull: false },
      counterpartyHandle: { type: DataTypes.STRING, allowNull: true },
      counterpartyEmail: { type: DataTypes.STRING, allowNull: true },
      counterpartyUserId: { type: DataTypes.UUID, allowNull: true },
      contactId: { type: DataTypes.UUID, allowNull: true },
      cardId: { type: DataTypes.UUID, allowNull: true },
      category: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'transfers' },
      note: { type: DataTypes.STRING(280), allowNull: true },
      balanceAfter: money(true),
      groupId: { type: DataTypes.UUID, allowNull: true },
      externalRef: { type: DataTypes.STRING, allowNull: true },
      ...ts,
    },
    {
      sequelize,
      tableName: 'transactions',
      indexes: [{ fields: ['user_id', 'created_at'] }, { fields: ['user_id', 'contact_id'] }, { fields: ['external_ref'] }],
    },
  );

  Contact.init(
    {
      id: id(),
      userId: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.STRING, allowNull: false },
      email: { type: DataTypes.STRING, allowNull: true },
      handle: { type: DataTypes.STRING, allowNull: true },
      linkedUserId: { type: DataTypes.UUID, allowNull: true },
      favorite: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      lastPaidAt: { type: DataTypes.DATE, allowNull: true },
      ...ts,
    },
    { sequelize, tableName: 'contacts', indexes: [{ unique: true, fields: ['user_id', 'email'] }] },
  );

  Card.init(
    {
      id: id(),
      userId: { type: DataTypes.UUID, allowNull: false },
      label: { type: DataTypes.STRING(40), allowNull: false },
      last4: { type: DataTypes.STRING(4), allowNull: false },
      color: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'amber' },
      status: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'active' },
      balance: money(),
      monthlyLimit: money(true),
      expMonth: { type: DataTypes.INTEGER, allowNull: false },
      expYear: { type: DataTypes.INTEGER, allowNull: false },
      ...ts,
    },
    { sequelize, tableName: 'cards', indexes: [{ fields: ['user_id'] }] },
  );

  Schedule.init(
    {
      id: id(),
      userId: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.STRING(60), allowNull: false },
      contactId: { type: DataTypes.UUID, allowNull: true },
      amount: money(),
      recurrence: { type: DataTypes.STRING(8), allowNull: false },
      nextRunAt: { type: DataTypes.DATE, allowNull: false },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'active' },
      note: { type: DataTypes.STRING(140), allowNull: true },
      ...ts,
    },
    { sequelize, tableName: 'schedules', indexes: [{ fields: ['status', 'next_run_at'] }] },
  );

  MoneyRequest.init(
    {
      id: id(),
      requesterId: { type: DataTypes.UUID, allowNull: false },
      payerUserId: { type: DataTypes.UUID, allowNull: true },
      payerEmail: { type: DataTypes.STRING, allowNull: true },
      payerName: { type: DataTypes.STRING, allowNull: false },
      amount: money(),
      currency: { type: DataTypes.STRING(3), allowNull: false },
      note: { type: DataTypes.STRING(140), allowNull: true },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
      groupId: { type: DataTypes.UUID, allowNull: true },
      ...ts,
    },
    { sequelize, tableName: 'money_requests', indexes: [{ fields: ['requester_id'] }, { fields: ['payer_user_id'] }] },
  );

  PendingAction.init(
    {
      id: id(),
      userId: { type: DataTypes.UUID, allowNull: false },
      type: { type: DataTypes.STRING(40), allowNull: false },
      payload: { type: DataTypes.JSON, allowNull: false },
      summary: { type: DataTypes.JSON, allowNull: false },
      status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'pending' },
      result: { type: DataTypes.JSON, allowNull: true },
      error: { type: DataTypes.STRING(280), allowNull: true },
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      executedAt: { type: DataTypes.DATE, allowNull: true },
      ...ts,
    },
    { sequelize, tableName: 'pending_actions', indexes: [{ fields: ['user_id', 'status'] }] },
  );

  PaypalOrder.init(
    {
      id: { type: DataTypes.STRING, primaryKey: true },
      userId: { type: DataTypes.UUID, allowNull: false },
      amount: money(),
      currency: { type: DataTypes.STRING(3), allowNull: false },
      status: { type: DataTypes.STRING(24), allowNull: false },
      captureId: { type: DataTypes.STRING, allowNull: true, unique: true },
      transactionId: { type: DataTypes.UUID, allowNull: true },
      ...ts,
    },
    { sequelize, tableName: 'paypal_orders' },
  );

  UiLayout.init(
    {
      id: id(),
      userId: { type: DataTypes.UUID, allowNull: false },
      slot: { type: DataTypes.STRING(40), allowNull: false },
      spec: { type: DataTypes.JSON, allowNull: false },
      instruction: { type: DataTypes.STRING(500), allowNull: true },
      ...ts,
    },
    { sequelize, tableName: 'ui_layouts', indexes: [{ unique: true, fields: ['user_id', 'slot'] }] },
  );

  Conversation.init(
    {
      id: id(),
      userId: { type: DataTypes.UUID, allowNull: false },
      turns: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
      ...ts,
    },
    { sequelize, tableName: 'conversations', indexes: [{ fields: ['user_id'] }] },
  );

  Session.init(
    {
      id: id(),
      userId: { type: DataTypes.UUID, allowNull: false },
      refreshHash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      revokedAt: { type: DataTypes.DATE, allowNull: true },
      userAgent: { type: DataTypes.STRING(200), allowNull: true },
      ...ts,
    },
    { sequelize, tableName: 'sessions' },
  );

  AuthTicket.init(
    {
      id: { type: DataTypes.STRING(64), primaryKey: true },
      kind: { type: DataTypes.STRING(8), allowNull: false },
      userId: { type: DataTypes.UUID, allowNull: true },
      redirect: { type: DataTypes.STRING(300), allowNull: true },
      expiresAt: { type: DataTypes.DATE, allowNull: false },
      usedAt: { type: DataTypes.DATE, allowNull: true },
      ...ts,
    },
    { sequelize, tableName: 'auth_tickets' },
  );

  MerchantConnection.init(
    {
      id: id(),
      userId: { type: DataTypes.UUID, allowNull: false, unique: true },
      environment: { type: DataTypes.STRING(8), allowNull: false },
      clientId: { type: DataTypes.STRING(120), allowNull: false },
      secretEnc: { type: DataTypes.STRING(512), allowNull: false },
      appId: { type: DataTypes.STRING(120), allowNull: true },
      accountId: { type: DataTypes.STRING(64), allowNull: true },
      businessName: { type: DataTypes.STRING(80), allowNull: false },
      scopes: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
      status: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'active' },
      lastVerifiedAt: { type: DataTypes.DATE, allowNull: true },
      ...ts,
    },
    { sequelize, tableName: 'merchant_connections', indexes: [{ unique: true, fields: ['environment', 'client_id'] }] },
  );

  const counter = () => ({ type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
  PlanCache.init(
    {
      id: id(),
      userId: { type: DataTypes.UUID, allowNull: false },
      key: { type: DataTypes.STRING(400), allowNull: false },
      slots: { type: DataTypes.JSON, allowNull: false },
      plan: { type: DataTypes.JSON, allowNull: false },
      exactOnly: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      tokens: counter(),
      hits: counter(),
      lastUsedAt: { type: DataTypes.DATE, allowNull: false },
      ...ts,
    },
    { sequelize, tableName: 'plan_cache', indexes: [{ unique: true, fields: ['user_id', 'key'] }, { fields: ['last_used_at'] }] },
  );

  AgentUsage.init(
    {
      id: id(),
      userId: { type: DataTypes.UUID, allowNull: false },
      day: { type: DataTypes.STRING(10), allowNull: false },
      llmRuns: counter(),
      inputTokens: counter(),
      outputTokens: counter(),
      cacheHits: counter(),
      offlineRuns: counter(),
      tokensSaved: counter(),
      ...ts,
    },
    { sequelize, tableName: 'agent_usage', indexes: [{ unique: true, fields: ['user_id', 'day'] }] },
  );

  Translation.init(
    {
      id: id(),
      lang: { type: DataTypes.STRING(12), allowNull: false },
      sourceHash: { type: DataTypes.STRING(40), allowNull: false },
      source: { type: DataTypes.TEXT, allowNull: false },
      text: { type: DataTypes.TEXT, allowNull: false },
      ...ts,
    },
    { sequelize, tableName: 'translations', indexes: [{ unique: true, fields: ['lang', 'source_hash'] }] },
  );

  LastView.init(
    {
      id: id(),
      userId: { type: DataTypes.UUID, allowNull: false },
      screen: { type: DataTypes.STRING(16), allowNull: false },
      prompt: { type: DataTypes.STRING(500), allowNull: false },
      spec: { type: DataTypes.JSON, allowNull: false },
      ...ts,
    },
    { sequelize, tableName: 'last_views', indexes: [{ unique: true, fields: ['user_id', 'screen'] }] },
  );
  User.hasMany(LastView, { foreignKey: 'userId', onDelete: 'CASCADE' });

  McpToken.init(
    {
      id: id(),
      userId: { type: DataTypes.UUID, allowNull: false },
      name: { type: DataTypes.STRING(60), allowNull: false },
      tokenHash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
      hint: { type: DataTypes.STRING(16), allowNull: false },
      scopes: { type: DataTypes.JSON, allowNull: false },
      expiresAt: { type: DataTypes.DATE, allowNull: true },
      revokedAt: { type: DataTypes.DATE, allowNull: true },
      lastUsedAt: { type: DataTypes.DATE, allowNull: true },
      ...ts,
    },
    { sequelize, tableName: 'mcp_tokens', indexes: [{ fields: ['user_id'] }] },
  );
  User.hasMany(McpToken, { foreignKey: 'userId', onDelete: 'CASCADE' });

  User.hasMany(PlanCache, { foreignKey: 'userId', onDelete: 'CASCADE' });
  User.hasMany(AgentUsage, { foreignKey: 'userId', onDelete: 'CASCADE' });
  User.hasOne(Account, { foreignKey: 'userId', onDelete: 'CASCADE' });
  User.hasOne(MerchantConnection, { foreignKey: 'userId', onDelete: 'CASCADE' });
  MerchantConnection.belongsTo(User, { foreignKey: 'userId' });
  Account.belongsTo(User, { foreignKey: 'userId' });
  for (const M of [Transaction, Contact, Card, Schedule, PendingAction, PaypalOrder, UiLayout, Conversation, Session]) {
    User.hasMany(M as typeof Transaction, { foreignKey: 'userId', onDelete: 'CASCADE' });
    (M as typeof Transaction).belongsTo(User, { foreignKey: 'userId' });
  }
  User.hasMany(MoneyRequest, { foreignKey: 'requesterId', onDelete: 'CASCADE' });
  MoneyRequest.belongsTo(User, { foreignKey: 'requesterId', as: 'requester' });
}
