import { UiLayout, type User } from '../db/index.js';
import { badRequest } from '../lib/errors.js';
import { LAYOUT_SLOTS, uiSpecSchema, type LayoutSlot, type UISpec } from '../agent/ui/schema.js';
import { defaultLayout } from '../agent/ui/defaults.js';

export async function getLayout(user: User, slot: LayoutSlot): Promise<{ spec: UISpec; custom: boolean; instruction: string | null }> {
  const row = await UiLayout.findOne({ where: { userId: user.id, slot } });
  if (row) {
    const parsed = uiSpecSchema.safeParse(row.spec);
    if (parsed.success) return { spec: parsed.data, custom: true, instruction: row.instruction };
  }
  return { spec: defaultLayout(slot, user.accountType), custom: false, instruction: null };
}

export async function listLayouts(user: User) {
  const rows = await UiLayout.findAll({ where: { userId: user.id } });
  const custom = new Map(rows.map((r) => [r.slot, r]));
  return LAYOUT_SLOTS.map((slot) => ({
    slot,
    custom: custom.has(slot),
    instruction: custom.get(slot)?.instruction ?? null,
    updatedAt: custom.get(slot)?.updatedAt?.toISOString() ?? null,
  }));
}

export async function saveLayout(user: User, slot: LayoutSlot, spec: unknown, instruction?: string | null) {
  const parsed = uiSpecSchema.safeParse(spec);
  if (!parsed.success) throw badRequest('Layout is not valid', parsed.error.issues.slice(0, 5));
  const values = { spec: parsed.data as unknown as Record<string, unknown>, instruction: instruction?.slice(0, 500) ?? null };
  const existing = await UiLayout.findOne({ where: { userId: user.id, slot } });
  const row = existing ? await existing.update(values) : await UiLayout.create({ userId: user.id, slot, ...values });
  return { saved: true, slot, updatedAt: row.updatedAt.toISOString() };
}

export async function resetLayout(user: User, slot: LayoutSlot) {
  await UiLayout.destroy({ where: { userId: user.id, slot } });
  return { reset: true, slot };
}
