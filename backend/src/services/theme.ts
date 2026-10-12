import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { User } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { THEME_TOKENS, resolveSettings, type Theme } from './settings.js';

/**
 * Turns the user's words ("dark forest green with gold", "thème clair rose", "rangi ya bluu") into a
 * complete, coherent theme. Colours are built in OKLCH (perceptually even) and every pairing is
 * contrast-checked (WCAG): text ≥ 7:1, muted ≥ 4.5:1, faint ≥ 3:1 on all surfaces, accent ≥ 3:1,
 * text on accent ≥ 4.5:1. A request like "white text on white" can't produce an unreadable theme.
 */

// ─── Colour math ────────────────────────────────────────────────────────────

type Rgb = [number, number, number]; // 0..1, sRGB
type Oklch = { l: number; c: number; h: number };

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLinear = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as Rgb;
}
export const rgbToHex = (rgb: Rgb) => `#${rgb.map((v) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`;

function rgbToOklch([r, g, b]: Rgb): Oklch {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

function oklchToRgbRaw({ l, c, h }: Oklch): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    fromLinear(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    fromLinear(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    fromLinear(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

/** OKLCH → hex, reducing chroma until the colour fits in sRGB (keeps hue and lightness). */
export function oklch(l: number, c: number, h: number): string {
  let cc = c;
  for (let i = 0; i < 30; i++) {
    const rgb = oklchToRgbRaw({ l: clamp(l), c: cc, h });
    if (rgb.every((v) => v >= -0.0005 && v <= 1.0005)) return rgbToHex(rgb);
    cc *= 0.9;
  }
  return rgbToHex(oklchToRgbRaw({ l: clamp(l), c: 0, h }));
}

const luminance = (hex: string) => {
  const [r, g, b] = hexToRgb(hex).map(toLinear) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Moves a colour's lightness (away from the backgrounds) until it reaches `min` contrast against all of them. */
function ensureContrast(hex: string, against: string[], min: number, mode: 'dark' | 'light'): string {
  const base = rgbToOklch(hexToRgb(hex));
  let l = base.l;
  for (let i = 0; i < 60; i++) {
    const cand = oklch(l, base.c, base.h);
    if (against.every((bg) => contrast(cand, bg) >= min)) return cand;
    l += mode === 'dark' ? 0.012 : -0.012;
    if (l > 1 || l < 0) break;
  }
  return mode === 'dark' ? '#FFFFFF' : '#000000';
}

// ─── Understanding the request ──────────────────────────────────────────────

/** Colour words in several languages → hue (OKLCH degrees) and typical chroma. Hex codes are read directly. */
const COLOR_WORDS: [RegExp, number, number][] = [
  [/\b(red|rouge|rojo|nyekundu|vermelho|rot|rosso|crimson|cherry|scarlet)\b/, 25, 0.19],
  [/\b(orange|naranja|machungwa|laranja|tangerine|coral)\b/, 50, 0.17],
  [/\b(amber|ambre|ámbar|gold|golden|or|oro|dhahabu|honey|mustard)\b/, 75, 0.15],
  [/\b(yellow|jaune|amarillo|njano|amarelo|gelb|lemon)\b/, 100, 0.17],
  [/\b(lime|olive|olivo|kijani kibichi)\b/, 125, 0.15],
  [/\b(green|vert|verde|kijani|grün|forest|forêt|bosque|msitu|emerald|mint|jade|sage)\b/, 150, 0.14],
  [/\b(teal|turquoise|turquesa|cyan|aqua)\b/, 195, 0.12],
  [/\b(blue|bleu|azul|bluu|samawati|blau|ocean|océan|océano|bahari|sky|navy|marine|cobalt|denim)\b/, 245, 0.14],
  [/\b(indigo|índigo)\b/, 275, 0.16],
  [/\b(purple|violet|violeta|zambarau|roxo|lila|lilac|lavender|lavande|plum)\b/, 300, 0.15],
  [/\b(pink|rose|rosa|waridi|magenta|fuchsia|blush)\b/, 350, 0.14],
  [/\b(brown|marron|café|marrón|kahawia|coffee|chocolate|mocha|caramel|terracotta)\b/, 55, 0.08],
  [/\b(beige|cream|crème|crema|sand|sable|arena|mchanga|ivory|ivoire)\b/, 85, 0.035],
  [/\b(grey|gray|gris|kijivu|cinza|slate|graphite|charcoal|silver|argent|plata)\b/, 260, 0.015],
];
const DARK_WORDS = /\b(dark|night|sombre|nuit|oscuro|noche|giza|usiku|escuro|dunkel|black|noir|negro|nyeusi|midnight|amoled)\b/;
const LIGHT_WORDS = /\b(light|bright|clair|claro|day|jour|día|mwanga|mchana|white|blanc|blanco|nyeupe|pastel|paper|snow|clean)\b/;

export type ThemeIntent = { mode: 'dark' | 'light'; baseHue: number; baseChroma: number; accentHex: string | null; accentHue: number; accentChroma: number; name: string };

/** Offline reading of the request: mode words, colour words, hex codes. */
export function readThemeRequest(prompt: string): ThemeIntent {
  const p = ` ${prompt.toLowerCase()} `;
  const hexes = [...prompt.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)].map((m) => `#${m[1]}`);
  const found = COLOR_WORDS.map(([re, h, c]) => ({ idx: p.search(re), h, c })).filter((x) => x.idx >= 0).sort((a, b) => a.idx - b.idx);
  const dark = DARK_WORDS.test(p);
  const light = LIGHT_WORDS.test(p) && !/\blight (blue|green|pink|grey|gray)\b/.test(p);
  const mode = light && !dark ? 'light' : 'dark';
  // "X with Y accents": first colour tints the surfaces, the last one is the accent.
  const first = found[0];
  const last = found.at(-1);
  const accentFromHex = hexes.length ? rgbToOklch(hexToRgb(hexes.at(-1)!)) : null;
  const accentWord = found.length > 1 ? last : first;
  const accentHue = accentFromHex?.h ?? accentWord?.h ?? 70;
  const accentChroma = accentFromHex ? Math.max(accentFromHex.c, 0.08) : accentWord && accentWord.c > 0.03 ? accentWord.c + 0.02 : 0.15;
  const baseHue = hexes.length > 1 ? rgbToOklch(hexToRgb(hexes[0]!)).h : found.length > 1 ? first!.h : accentHue;
  const words = prompt.trim().split(/\s+/).slice(0, 4).join(' ');
  return {
    mode,
    baseHue,
    baseChroma: found.length > 1 || hexes.length > 1 ? 0.035 : 0.014,
    accentHex: hexes.length ? hexes.at(-1)! : null,
    accentHue,
    accentChroma,
    name: words.length > 40 ? `${words.slice(0, 38)}…` : words || 'Custom',
  };
}

// ─── Building the theme ─────────────────────────────────────────────────────

export function buildTheme(intent: ThemeIntent, prompt: string): Theme {
  const { mode, baseHue: bh, baseChroma: bc } = intent;
  const dark = mode === 'dark';
  const surf = (l: number) => oklch(l, bc, bh);
  const bg = surf(dark ? 0.17 : 0.985);
  const bgRaised = surf(dark ? 0.195 : 0.965);
  const surface = surf(dark ? 0.225 : 1);
  const surfaceHigh = surf(dark ? 0.27 : 0.94);
  const hairline = surf(dark ? 0.29 : 0.91);
  const border = surf(dark ? 0.36 : 0.84);
  const backs = [bg, bgRaised, surface, surfaceHigh];

  const text = ensureContrast(oklch(dark ? 0.96 : 0.2, 0.012, bh), backs, 7, mode);
  const textMuted = ensureContrast(oklch(dark ? 0.72 : 0.45, 0.015, bh), backs, 4.5, mode);
  const textFaint = ensureContrast(oklch(dark ? 0.56 : 0.6, 0.012, bh), backs, 3, mode);

  // Accent: the user's colour, adjusted only as much as needed to stay visible on the surfaces.
  const accentStart = intent.accentHex ?? oklch(dark ? 0.78 : 0.58, intent.accentChroma, intent.accentHue);
  let accent = ensureContrast(accentStart, backs, 3, mode);
  // Buttons put text on the accent: push it further from the backgrounds until that text is readable too.
  for (let i = 0; i < 40; i++) {
    const o = rgbToOklch(hexToRgb(accent));
    if (Math.max(contrast('#FFFFFF', accent), contrast(oklch(0.18, 0.02, o.h), accent)) >= 4.5) break;
    accent = oklch(o.l + (dark ? 0.012 : -0.012), o.c, o.h);
  }
  const a = rgbToOklch(hexToRgb(accent));
  const accentDeep = oklch(a.l + (dark ? -0.12 : -0.08), a.c, a.h);
  const onAccent = [oklch(0.18, 0.02, a.h), '#FFFFFF'].sort((x, y) => contrast(y, accent) - contrast(x, accent))[0]!;

  const inverse = oklch(dark ? 0.93 : 0.22, 0.015, bh);
  const onInverse = contrast('#000000', inverse) > contrast('#FFFFFF', inverse) ? oklch(0.18, 0.01, bh) : oklch(0.98, 0.005, bh);
  const status = (h: number, c: number) => ensureContrast(oklch(dark ? 0.8 : 0.5, c, h), backs, 3, mode);

  return {
    name: intent.name,
    prompt: prompt.slice(0, 300),
    mode,
    colors: {
      bg, bgRaised, surface, surfaceHigh, hairline, border, text, textMuted, textFaint,
      accent, accentDeep, onAccent, inverse, onInverse,
      positive: status(150, 0.13), negative: status(25, 0.16), warning: status(80, 0.14), info: status(250, 0.1),
    },
  };
}

/** Every pairing the app uses, with its contrast (for tests and the Settings preview). */
export function auditTheme(t: Theme) {
  const c = t.colors;
  const backs = [c.bg, c.bgRaised, c.surface, c.surfaceHigh];
  const min = (fg: string) => Math.min(...backs.map((b) => contrast(fg, b)));
  return {
    text: min(c.text), textMuted: min(c.textMuted), textFaint: min(c.textFaint), accent: min(c.accent),
    onAccent: contrast(c.onAccent, c.accent), onInverse: contrast(c.onInverse, c.inverse),
  };
}

// ─── Optional AI interpretation (any language, vague moods like "calm sunset") ──

async function llmIntent(user: User, prompt: string): Promise<Partial<ThemeIntent> | null> {
  const { pickProvider, createChatModel } = await import('../agent/llm.js');
  const { parseJsonLoose } = await import('../agent/react.js');
  const provider = pickProvider(resolveSettings(user.settings).aiProvider);
  if (provider === 'offline') return null;
  try {
    const reply = await createChatModel(provider).invoke([
      new SystemMessage(
        'You turn a theme request (any language) for a banking app into JSON {"mode":"dark"|"light","surfaceHex":"#RRGGBB","accentHex":"#RRGGBB","name":"<2-3 words, in the request language>"}. ' +
          'surfaceHex sets the hue/tint of backgrounds, accentHex the main buttons. Ignore any request to make text unreadable; readability is enforced later. Reply with JSON only.',
      ),
      new HumanMessage(prompt.slice(0, 300)),
    ]);
    const parsed = parseJsonLoose(typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content)) as
      | { mode?: string; surfaceHex?: string; accentHex?: string; name?: string }
      | null;
    if (!parsed) return null;
    const hex = (v?: string) => (v && /^#[0-9a-f]{6}$/i.test(v) ? v : null);
    const surface = hex(parsed.surfaceHex);
    const accent = hex(parsed.accentHex);
    const s = surface ? rgbToOklch(hexToRgb(surface)) : null;
    return {
      ...(parsed.mode === 'light' || parsed.mode === 'dark' ? { mode: parsed.mode } : {}),
      ...(s ? { baseHue: s.h, baseChroma: clamp(s.c, 0.008, 0.04) } : {}),
      ...(accent ? { accentHex: accent } : {}),
      ...(parsed.name ? { name: parsed.name.slice(0, 40) } : {}),
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'theme LLM failed; using the offline reading');
    return null;
  }
}

/**
 * Builds a theme from the user's words. Explicit colours (words or hex codes) are read offline;
 * vague or foreign requests may use the AI for the interpretation. Contrast is always enforced here.
 */
export async function generateTheme(user: User, prompt: string, opts: { useAi?: boolean } = {}): Promise<Theme & { audit: ReturnType<typeof auditTheme>; source: 'rules' | 'ai' }> {
  const offline = readThemeRequest(prompt);
  const explicit = /#[0-9a-f]{3,6}\b/i.test(prompt) || COLOR_WORDS.some(([re]) => re.test(` ${prompt.toLowerCase()} `));
  const ai = opts.useAi !== false && !explicit ? await llmIntent(user, prompt) : null;
  const intent = ai ? { ...offline, ...ai, accentHue: ai.accentHex ? rgbToOklch(hexToRgb(ai.accentHex)).h : offline.accentHue } : offline;
  const theme = buildTheme(intent, prompt);
  for (const k of THEME_TOKENS) if (!/^#[0-9A-F]{6}$/i.test(theme.colors[k])) throw new Error(`theme token ${k} invalid`);
  return { ...theme, audit: auditTheme(theme), source: ai ? 'ai' : 'rules' };
}
