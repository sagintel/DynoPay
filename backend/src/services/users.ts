import crypto from 'node:crypto';
import { Op } from 'sequelize';
import { env } from '../config/env.js';
import { Account, Contact, User, withTx, type UserSettings } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { mergeSettings, type SettingsPatch } from './settings.js';

function slugify(name: string) {
  return (
    name
      .normalize('NFKD')
      .replace(/[^\w\s]/g, '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '')
      .slice(0, 16) || 'user'
  );
}

async function uniqueHandle(name: string): Promise<string> {
  const base = slugify(name);
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? base : `${base}${crypto.randomInt(10, 9999)}`;
    if (!(await User.findOne({ where: { handle: candidate } }))) return candidate;
  }
  return `${base}${crypto.randomBytes(3).toString('hex')}`;
}

/** Creates the user + wallet on first PayPal sign-in; refreshes identity fields afterwards. */
export async function upsertPayPalUser(p: {
  paypalUserId: string;
  payerId: string | null;
  email: string;
  name: string;
  verified: boolean;
}): Promise<User> {
  const existing = await User.findOne({ where: { [Op.or]: [{ paypalUserId: p.paypalUserId }, { email: p.email }] } });
  if (existing) {
    await existing.update({ paypalUserId: p.paypalUserId, paypalPayerId: p.payerId, name: p.name, verified: p.verified, email: p.email });
    await linkContactsToUser(existing);
    return existing;
  }
  return createUser({ ...p, paypalPayerId: p.payerId });
}

export async function createUser(p: {
  email: string;
  name: string;
  verified?: boolean;
  paypalUserId?: string | null;
  paypalPayerId?: string | null;
  currency?: string;
}): Promise<User> {
  const handle = await uniqueHandle(p.name);
  const user = await withTx(async (transaction) => {
    const u = await User.create(
      {
        email: p.email.toLowerCase(),
        name: p.name,
        handle,
        verified: p.verified ?? false,
        paypalUserId: p.paypalUserId ?? null,
        paypalPayerId: p.paypalPayerId ?? null,
        currency: p.currency ?? env.DEFAULT_CURRENCY,
        settings: { biometricForSensitive: true, haptics: true },
      },
      { transaction },
    );
    await Account.create({ userId: u.id, currency: u.currency }, { transaction });
    return u;
  });
  await linkContactsToUser(user);
  return user;
}

/** When someone joins, contacts that reference their email become DynoPay contacts (instant transfers). */
async function linkContactsToUser(user: User) {
  await Contact.update({ linkedUserId: user.id, handle: user.handle }, { where: { email: user.email, linkedUserId: null } });
}

export async function getUser(userId: string): Promise<User> {
  const user = await User.findByPk(userId);
  if (!user) throw notFound('User');
  return user;
}

export async function updateProfile(user: User, patch: { name?: string; settings?: SettingsPatch }) {
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name.length < 2 || name.length > 60) throw badRequest('Name must be 2–60 characters');
    user.name = name;
  }
  if (patch.settings) user.settings = mergeSettings(user.settings, patch.settings) as UserSettings;
  await user.save();
  return user;
}
