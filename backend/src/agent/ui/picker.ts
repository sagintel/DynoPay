import { User, type User as UserT } from '../../db/index.js';
import { AppError } from '../../lib/errors.js';
import { formatMoney, toMinor } from '../../lib/money.js';
import { allowedActions, getAction } from '../../actions/registry.js';
import { listCards } from '../../services/cards.js';
import { listContacts } from '../../services/contacts.js';
import { listRequests } from '../../services/requests.js';
import { listSchedules } from '../../services/schedules.js';
import { initials } from '../../services/serialize.js';
import { platformStatus } from '../../services/paypalStatus.js';
import type { LeafBlock } from './schema.js';

type PickerBlock = Extract<LeafBlock, { type: 'picker' }>;

export type PickerItem = {
  id: string;
  title: string;
  subtitle: string;
  initials?: string;
  badge?: string;
  disabled?: boolean;
  reason?: string;
  /** Merged into the action input when this item is chosen (computed here, never by the client). */
  patch: Record<string, unknown>;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Where the chosen contact goes in each action's input. */
function contactPatch(action: string, contactId: string): Record<string, unknown> {
  if (action === 'send_money' || action === 'schedule_payment') return { recipient: { contactId } };
  if (action === 'request_money') return { participants: [{ contactId }] };
  return { contactId };
}

/**
 * Items for a picker block, with per-item eligibility for the action (a frozen card can't be
 * funded, a card can't give more than it holds…). The action itself must be a confirm-level
 * action this user may use: picking only chooses the target, the change is confirmed after.
 */
export async function pickerData(user: UserT, b: PickerBlock) {
  const def = getAction(b.action);
  if (def.risk !== 'confirm' || !(await allowedActions(user)).some((a) => a.name === b.action)) {
    throw new AppError('forbidden', 'This choice is not available');
  }
  const amount = typeof b.input.amount === 'number' ? b.input.amount : undefined;
  let items: PickerItem[] = [];
  let searchMiss = false;

  // Someone outside DynoPay is paid with a PayPal payout: only offer them when payouts can work.
  const paysOut = b.action === 'send_money' || b.action === 'schedule_payment';
  const payoutBlock = async () => {
    if (!paysOut) return undefined;
    const s = await platformStatus();
    return s.configured && s.reachable !== false && s.features.payouts ? undefined : 'Needs PayPal payouts (not available here)';
  };

  if (b.kind === 'contact') {
    const search = b.search?.trim().replace(/^@/, '');
    if (search && EMAIL.test(search)) {
      const email = search.toLowerCase();
      const contacts = await listContacts(user, { search: email, limit: 5 });
      items = contacts.filter((c) => c.email === email).map((c) => ({ id: c.id, title: c.name, subtitle: c.email ?? '', initials: c.initials, badge: c.isDynoPayUser ? 'DynoPay' : undefined, patch: contactPatch(b.action, c.id) }));
      if (!items.length && (b.action === 'send_money' || b.action === 'request_money')) {
        const member = await User.findOne({ where: { email } });
        items.push({
          id: `email:${email}`,
          title: member?.name ?? email,
          subtitle: member ? `@${member.handle} · DynoPay account` : `${email} · New PayPal recipient`,
          initials: (member?.name ?? email).slice(0, 2).toUpperCase(),
          badge: member ? 'DynoPay' : 'PayPal',
          patch: b.action === 'request_money' ? { participants: [{ email }] } : { recipient: { email } },
        });
      }
    } else {
      const found = search ? await listContacts(user, { search, limit: 20 }) : [];
      const list = found.length ? found : await listContacts(user, { limit: 20 });
      searchMiss = !!search && !found.length;
      items = list.map((c) => ({
        id: c.id,
        title: c.name,
        subtitle: c.handle ? `@${c.handle}` : c.email ?? '',
        initials: c.initials,
        badge: c.isDynoPayUser ? 'DynoPay' : undefined,
        patch: contactPatch(b.action, c.id),
      }));
    }
    const reason = await payoutBlock();
    if (reason) {
      const external = new Set((await listContacts(user, { limit: 200 })).filter((c) => !c.isDynoPayUser).map((c) => c.id));
      items = items.map((i) => (i.id.startsWith('email:') ? !i.badge?.includes('DynoPay') : external.has(i.id)) ? { ...i, disabled: true, reason } : i);
    }
  } else if (b.kind === 'card') {
    const cards = await listCards(user);
    items = cards.map((c) => {
      let reason: string | undefined;
      if (b.action === 'fund_card' && c.status === 'frozen') reason = 'Frozen';
      if (b.action === 'freeze_card' && c.status === 'frozen') reason = 'Already frozen';
      if (b.action === 'unfreeze_card' && c.status !== 'frozen') reason = 'Not frozen';
      if (b.action === 'withdraw_from_card' && amount !== undefined && toMinor(c.balance) < toMinor(amount)) reason = `Only ${c.formattedBalance} on this card`;
      return {
        id: c.id,
        title: `${c.label} ·· ${c.last4}`,
        subtitle: `${c.formattedBalance}${c.status === 'frozen' ? ' · Frozen' : ''}`,
        badge: c.color,
        disabled: !!reason,
        reason,
        patch: { cardId: c.id },
      };
    });
  } else if (b.kind === 'schedule') {
    items = (await listSchedules(user)).map((s) => ({
      id: s.id,
      title: s.name,
      subtitle: `${s.formatted} · ${s.recurrence === 'weekly' ? 'Weekly' : 'Monthly'}`,
      initials: initials(s.name),
      patch: { scheduleId: s.id },
    }));
  } else {
    const perspective = b.action === 'cancel_request' ? 'outgoing' : 'incoming';
    items = (await listRequests(user, perspective))
      .filter((r) => r.status === 'pending')
      .map((r) => ({
        id: r.id,
        title: perspective === 'incoming' ? r.requesterName ?? 'Request' : r.payerName,
        subtitle: [formatMoney(toMinor(r.amount), r.currency), r.note].filter(Boolean).join(' · '),
        initials: initials(perspective === 'incoming' ? r.requesterName ?? 'R' : r.payerName),
        patch: { requestId: r.id },
      }));
  }

  return { action: b.action, input: b.input, preselect: b.preselect ?? null, searchMiss, items };
}
