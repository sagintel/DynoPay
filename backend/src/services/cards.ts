import crypto from 'node:crypto';
import { Op } from 'sequelize';
import { Card, Transaction, withTx, type User } from '../db/index.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { assertPositiveMinor, formatMoney } from '../lib/money.js';
import { credit, debit } from './ledger.js';
import { cardView } from './serialize.js';

/**
 * DynoPay virtual cards are sub-wallets funded from the main balance.
 * Card issuing on a real network needs an issuer-processor partner; the model
 * here (balance, limits, freeze, close) is what such a partner integration plugs into.
 */
export const CARD_COLORS = ['amber', 'graphite', 'ivory', 'ocean', 'rose', 'forest'] as const;
export const MAX_ACTIVE_CARDS = 5;

async function spentThisMonth(cardIds: string[]) {
  if (!cardIds.length) return new Map<string, number>();
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const rows = await Transaction.findAll({
    where: { cardId: cardIds, kind: 'card_spend', status: { [Op.ne]: 'failed' }, createdAt: { [Op.gte]: start } },
    attributes: ['cardId', 'amount'],
  });
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.cardId!, (map.get(r.cardId!) ?? 0) + r.amount);
  return map;
}

export async function listCards(user: User, opts: { includeClosed?: boolean } = {}) {
  const cards = await Card.findAll({
    where: opts.includeClosed ? { userId: user.id } : { userId: user.id, status: { [Op.ne]: 'closed' } },
    order: [['createdAt', 'ASC']],
  });
  const spent = await spentThisMonth(cards.map((c) => c.id));
  return cards.map((c) => cardView(c, user.currency, spent.get(c.id) ?? 0));
}

async function ownCard(user: User, cardId: string) {
  const card = await Card.findOne({ where: { id: cardId, userId: user.id } });
  if (!card || card.status === 'closed') throw notFound('Card');
  return card;
}

export async function getCard(user: User, cardId: string) {
  const card = await ownCard(user, cardId);
  const spent = await spentThisMonth([card.id]);
  return cardView(card, user.currency, spent.get(card.id) ?? 0);
}

export async function createCard(user: User, input: { label?: string; color?: string; monthlyLimit?: number | null }) {
  const active = await Card.count({ where: { userId: user.id, status: { [Op.ne]: 'closed' } } });
  if (active >= MAX_ACTIVE_CARDS) throw new AppError('limit_exceeded', `You can have up to ${MAX_ACTIVE_CARDS} cards`);
  const color = input.color && (CARD_COLORS as readonly string[]).includes(input.color) ? input.color : CARD_COLORS[active % CARD_COLORS.length]!;
  const now = new Date();
  const card = await Card.create({
    userId: user.id,
    label: (input.label?.trim() || `Card ${active + 1}`).slice(0, 40),
    last4: String(crypto.randomInt(0, 10_000)).padStart(4, '0'),
    color,
    monthlyLimit: input.monthlyLimit ?? null,
    expMonth: now.getMonth() + 1,
    expYear: now.getFullYear() + 3,
  });
  return cardView(card, user.currency);
}

export async function updateCard(user: User, cardId: string, patch: { label?: string; color?: string; monthlyLimit?: number | null }) {
  const card = await ownCard(user, cardId);
  if (patch.label !== undefined) {
    const label = patch.label.trim();
    if (!label || label.length > 40) throw badRequest('Card name must be 1–40 characters');
    card.label = label;
  }
  if (patch.color !== undefined) {
    if (!(CARD_COLORS as readonly string[]).includes(patch.color)) throw badRequest(`Color must be one of ${CARD_COLORS.join(', ')}`);
    card.color = patch.color;
  }
  if (patch.monthlyLimit !== undefined) {
    if (patch.monthlyLimit !== null && patch.monthlyLimit < 0) throw badRequest('Limit must be positive');
    card.monthlyLimit = patch.monthlyLimit;
  }
  await card.save();
  return getCard(user, card.id);
}

export async function setCardStatus(user: User, cardId: string, status: 'active' | 'frozen') {
  const card = await ownCard(user, cardId);
  card.status = status;
  await card.save();
  return getCard(user, card.id);
}

/** Move money between the main balance and a card. */
export async function moveCardFunds(user: User, cardId: string, amount: number, direction: 'to_card' | 'to_wallet') {
  assertPositiveMinor(amount);
  return withTx(async (t) => {
    const card = await Card.findOne({ where: { id: cardId, userId: user.id }, transaction: t });
    if (!card || card.status === 'closed') throw notFound('Card');
    let balance: number;
    if (direction === 'to_card') {
      if (card.status === 'frozen') throw badRequest('Unfreeze the card before adding money');
      balance = await debit(user.id, amount, t);
      card.balance += amount;
    } else {
      if (card.balance < amount) throw new AppError('insufficient_funds', `Card only holds ${formatMoney(card.balance, user.currency)}`);
      card.balance -= amount;
      balance = await credit(user.id, amount, t);
    }
    await card.save({ transaction: t });
    const tx = await Transaction.create(
      {
        userId: user.id, direction: direction === 'to_card' ? 'out' : 'in', amount, currency: user.currency, kind: 'card_funding',
        status: 'completed', category: 'card', note: direction === 'to_card' ? `Added to ${card.label}` : `Moved from ${card.label}`,
        counterpartyName: `${card.label} ·· ${card.last4}`, counterpartyHandle: null, counterpartyEmail: null, counterpartyUserId: null,
        contactId: null, cardId: card.id, balanceAfter: balance, groupId: null, externalRef: null,
      },
      { transaction: t },
    );
    return { transactionId: tx.id, cardId: card.id, cardBalance: card.balance / 100, walletBalance: balance / 100, currency: user.currency };
  });
}

/** Closing returns any remaining card balance to the wallet. */
export async function closeCard(user: User, cardId: string) {
  const card = await ownCard(user, cardId);
  if (card.balance > 0) await moveCardFunds(user, cardId, card.balance, 'to_wallet');
  await Card.update({ status: 'closed' }, { where: { id: cardId } });
  return { closed: true, id: cardId, label: card.label };
}
