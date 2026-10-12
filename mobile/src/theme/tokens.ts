import { Platform } from 'react-native';
import type { Theme } from '@/genui/types';

/** Design tokens. Every generated component reads from here, so the app looks consistent whatever the agent composes. */
export const colors = {
  bg: '#121212',
  bgRaised: '#161616',
  surface: '#1C1C1E',
  surfaceHigh: '#242426',
  hairline: '#2A2A2D',
  border: '#36363A',
  text: '#F4F1EA',
  textMuted: '#8F8B84',
  textFaint: '#5E5B56',
  accent: '#F0A531',
  accentDeep: '#C9822A',
  accentSoft: 'rgba(240,165,49,0.14)',
  accentGlow: 'rgba(240,165,49,0.35)',
  ivory: '#EFEAE0',
  onIvory: '#17140F',
  onAccent: '#17140F',
  positive: '#8ED19B',
  negative: '#FF8A7A',
  warning: '#F5C46B',
  info: '#9CB8E8',
  overlay: 'rgba(0,0,0,0.6)',
  /** Tinted fills derived from the status colours (badges, danger buttons, chips). */
  negativeSoft: 'rgba(255,138,122,0.12)',
  negativeBorder: 'rgba(255,138,122,0.25)',
  positiveSoft: 'rgba(142,209,155,0.12)',
  chip: 'rgba(240,165,49,0.22)',
  /** Veil over a frozen card. */
  scrim: 'rgba(12,12,12,0.55)',
};

const DEFAULT_COLORS = { ...colors };

/** "#RRGGBB" + alpha → rgba() */
export function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${a})`;
}

/** Accent options in Settings → Look & feel (each pairs with dark text on accent fills). */
export const ACCENTS = {
  amber: { accent: '#F0A531', accentDeep: '#C9822A', rgb: '240,165,49' },
  ocean: { accent: '#5AA9E6', accentDeep: '#3A7FB8', rgb: '90,169,230' },
  rose: { accent: '#E58FA1', accentDeep: '#B8667A', rgb: '229,143,161' },
  forest: { accent: '#6FCF97', accentDeep: '#3E9E6A', rgb: '111,207,151' },
  violet: { accent: '#A78BFA', accentDeep: '#7C5FD6', rgb: '167,139,250' },
} as const;
export type AccentName = keyof typeof ACCENTS;

/** Current appearance (read at render time by spacing/animation code). */
export const appearance = {
  accent: 'amber' as AccentName,
  density: 'comfortable' as 'comfortable' | 'compact',
  motion: 'full' as 'full' | 'reduced',
  /** Light or dark (drives the status bar, navigation theme and chart palette). */
  mode: 'dark' as 'dark' | 'light',
  /** Name of the custom theme, or null for the default DynoPay look. */
  theme: null as string | null,
};

/** Everything the boot script needs to restore the look before screens load. */
export type Look = { accent?: AccentName; density?: 'comfortable' | 'compact'; motion?: 'full' | 'reduced'; theme?: Theme | null };

/** A stable fingerprint of a look: a change means styles must be rebuilt (reload). */
export const lookSignature = (l: Look) =>
  [l.accent ?? 'amber', l.density ?? 'comfortable', l.motion ?? 'full', l.theme ? `${l.theme.mode}:${Object.values(l.theme.colors).join('')}` : 'default'].join('|');

let appliedSignature = lookSignature({});

/**
 * Applies the user's look & feel: accent, density, motion and (optionally) a full custom theme that
 * replaces every colour token (the server already checked its contrast). Returns true when
 * something visible changed.
 */
export function applyAppearance(next: Look): boolean {
  const accent = next.accent && next.accent in ACCENTS ? next.accent : appearance.accent;
  const signature = lookSignature({ ...next, accent });
  const changed = signature !== appliedSignature;
  appliedSignature = signature;
  Object.assign(colors, DEFAULT_COLORS);
  const theme = next.theme ?? null;
  if (theme) {
    const t = theme.colors;
    Object.assign(colors, {
      bg: t.bg, bgRaised: t.bgRaised, surface: t.surface, surfaceHigh: t.surfaceHigh, hairline: t.hairline, border: t.border,
      text: t.text, textMuted: t.textMuted, textFaint: t.textFaint,
      accent: t.accent, accentDeep: t.accentDeep, onAccent: t.onAccent,
      accentSoft: alpha(t.accent, theme.mode === 'light' ? 0.12 : 0.14),
      accentGlow: alpha(t.accent, 0.35),
      ivory: t.inverse, onIvory: t.onInverse,
      positive: t.positive, negative: t.negative, warning: t.warning, info: t.info,
      overlay: theme.mode === 'light' ? 'rgba(20,20,24,0.38)' : 'rgba(0,0,0,0.6)',
      negativeSoft: alpha(t.negative, 0.12), negativeBorder: alpha(t.negative, 0.28), positiveSoft: alpha(t.positive, 0.14),
      chip: alpha(t.accent, 0.22),
      scrim: alpha(t.bg, 0.6),
    });
  } else {
    const a = ACCENTS[accent];
    colors.accent = a.accent;
    colors.accentDeep = a.accentDeep;
    colors.accentSoft = `rgba(${a.rgb},0.14)`;
    colors.accentGlow = `rgba(${a.rgb},0.35)`;
    colors.chip = `rgba(${a.rgb},0.22)`;
  }
  appearance.accent = accent;
  appearance.density = next.density ?? appearance.density;
  appearance.motion = next.motion ?? appearance.motion;
  appearance.mode = theme?.mode ?? 'dark';
  appearance.theme = theme?.name ?? null;
  return changed;
}

export const cardThemes: Record<string, { from: string; to: string; text: string; muted: string }> = {
  amber: { from: '#F3B04A', to: '#C47A22', text: '#1A140A', muted: 'rgba(26,20,10,0.6)' },
  graphite: { from: '#3A3A3D', to: '#1E1E20', text: '#F4F1EA', muted: 'rgba(244,241,234,0.55)' },
  ivory: { from: '#F4EFE6', to: '#D9D1C3', text: '#17140F', muted: 'rgba(23,20,15,0.55)' },
  ocean: { from: '#2F4E6E', to: '#16263A', text: '#F4F1EA', muted: 'rgba(244,241,234,0.6)' },
  rose: { from: '#B76E79', to: '#6E3A44', text: '#FFF5F2', muted: 'rgba(255,245,242,0.6)' },
  forest: { from: '#3F6B54', to: '#1D3A2C', text: '#F2F7F3', muted: 'rgba(242,247,243,0.6)' },
};

export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28, xxxl: 40 } as const;
export const radius = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 } as const;

export const fonts = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
} as const;

export const type = {
  display: { fontFamily: fonts.bold, fontSize: 44, lineHeight: 50, letterSpacing: -1.2 },
  title: { fontFamily: fonts.semibold, fontSize: 24, lineHeight: 30, letterSpacing: -0.4 },
  heading: { fontFamily: fonts.semibold, fontSize: 17, lineHeight: 22, letterSpacing: -0.2 },
  body: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 21 },
  bodyStrong: { fontFamily: fonts.medium, fontSize: 15, lineHeight: 21 },
  caption: { fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 17 },
  label: { fontFamily: fonts.medium, fontSize: 12.5, lineHeight: 16, letterSpacing: 0.1 },
  tiny: { fontFamily: fonts.medium, fontSize: 10.5, lineHeight: 13 },
} as const;

export const toneColor = (tone?: string) =>
  tone === 'muted' ? colors.textMuted
  : tone === 'accent' ? colors.accent
  : tone === 'positive' ? colors.positive
  : tone === 'negative' ? colors.negative
  : colors.text;

export const shadow = Platform.select({
  ios: { shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
  android: { elevation: 8 },
  default: {},
});

export const GUTTER = 20;
