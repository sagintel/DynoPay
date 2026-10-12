import crypto from 'node:crypto';
import { z } from 'zod';

/**
 * Per-user preferences. Stored as JSON on the user; always read through `resolveSettings`
 * so older rows get defaults for new fields.
 */
export const ACCENTS = ['amber', 'ocean', 'rose', 'forest', 'violet'] as const;

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const THEME_TOKENS = [
  'bg', 'bgRaised', 'surface', 'surfaceHigh', 'hairline', 'border', 'text', 'textMuted', 'textFaint',
  'accent', 'accentDeep', 'onAccent', 'inverse', 'onInverse', 'positive', 'negative', 'warning', 'info',
] as const;
export const themeSchema = z.object({
  name: z.string().max(40),
  prompt: z.string().max(300),
  mode: z.enum(['dark', 'light']),
  colors: z.object(Object.fromEntries(THEME_TOKENS.map((k) => [k, hex])) as Record<(typeof THEME_TOKENS)[number], typeof hex>),
});
export type Theme = z.infer<typeof themeSchema>;

export const designSchema = z.object({
  /** The free-text design brief is applied to every AI render when enabled. */
  enabled: z.boolean().default(false),
  brief: z.string().max(1500).default(''),
  accent: z.enum(ACCENTS).default('amber'),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  motion: z.enum(['full', 'reduced']).default('full'),
  balanceStyle: z.enum(['arc', 'compact', 'minimal']).default('arc'),
  /** Preferred chart form; applied only where it fits the data (time series vs categories). */
  chartStyle: z.enum(['auto', 'bar', 'hbar', 'line', 'area', 'sparkline', 'donut', 'pie', 'progress', 'heatmap']).default('auto'),
  /** A custom theme generated from the user's words (contrast-checked); null = the default DynoPay dark. */
  theme: themeSchema.nullable().default(null),
});

export const settingsSchema = z.object({
  aiProvider: z.enum(['gemini', 'cloudflare', 'offline']).optional(),
  biometricForSensitive: z.boolean().default(true),
  haptics: z.boolean().default(true),
  /** Run the agent as the user types (previews only; nothing executes). */
  liveAgent: z.boolean().default(true),
  /** Reuse previous AI answers: off, identical sentences only, or similar sentences with new values. */
  cacheMode: z.enum(['off', 'exact', 'similar']).default('similar'),
  /** Serve a cached plan at most this many times, then refresh it with the LLM (0 = no limit). */
  cacheMaxReuse: z.number().int().min(0).max(100).default(5),
  /** Answer common sentences with on-device rules before spending tokens. */
  preferOffline: z.boolean().default(true),
  /** UI language (BCP-47 base code). English by default. */
  language: z.string().regex(/^[a-z]{2,3}$/).default('en'),
  /** Follow the language the user writes in (all screens switch). */
  autoLanguage: z.boolean().default(true),
  design: designSchema.default(designSchema.parse({})),
});

export type Settings = z.infer<typeof settingsSchema>;
export type Design = z.infer<typeof designSchema>;

export const settingsPatchSchema = settingsSchema
  .omit({ design: true })
  .partial()
  .extend({ design: designSchema.partial().optional() });
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export function resolveSettings(raw: unknown): Settings {
  const parsed = settingsSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  // Drop invalid keys one by one rather than losing everything.
  const obj = { ...(raw as Record<string, unknown>) };
  for (const issue of parsed.error.issues) delete obj[String(issue.path[0])];
  return settingsSchema.parse(obj);
}

export function mergeSettings(current: unknown, patch: SettingsPatch): Settings {
  const base = resolveSettings(current);
  return settingsSchema.parse({ ...base, ...patch, design: { ...base.design, ...(patch.design ?? {}) } });
}

/** Changes whenever anything that shapes AI output changes (invalidates cached plans). */
export function designFingerprint(d: Design): string {
  const relevant = { brief: d.enabled ? d.brief.trim() : '', balanceStyle: d.balanceStyle, chartStyle: d.chartStyle, density: d.density };
  return crypto.createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 12);
}

/** The design brief as the agent sees it: cleaned, bounded, and explicitly subordinate to the app's rules. */
export function designBriefForAgent(d: Design): string | null {
  const brief = d.enabled ? d.brief.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
  const structured = `balance style: ${d.balanceStyle}; chart style: ${d.chartStyle}; density: ${d.density}`;
  return brief ? `${structured}\nUser's own words: "${brief}"` : structured;
}
