import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { User } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { LANGUAGE_NAMES, translateTexts, type Translator } from '../services/i18n.js';
import { resolveSettings } from '../services/settings.js';
import { createChatModel, pickProvider } from './llm.js';
import { parseJsonLoose } from './react.js';

/** An LLM-backed translator for any language (undefined when no AI provider is configured). */
export function llmTranslator(user: User): Translator | undefined {
  const provider = pickProvider(resolveSettings(user.settings).aiProvider);
  if (provider === 'offline') return undefined;
  return async (texts, lang) => {
    const model = createChatModel(provider);
    const out: Record<string, string> = {};
    for (let i = 0; i < texts.length; i += 60) {
      const batch = texts.slice(i, i + 60);
      try {
        const reply = await model.invoke([
          new SystemMessage(
            'You translate the user-interface strings of a banking app. Reply with ONE JSON object {"translations":{"<source>":"<translation>"}}. ' +
              'Keep it short and natural for buttons/labels, keep {placeholders}, numbers, currency symbols, names, @handles, emails and emojis unchanged, ' +
              'never add explanations. If a string is already in the target language, return it unchanged.',
          ),
          new HumanMessage(JSON.stringify({ targetLanguage: `${LANGUAGE_NAMES[lang] ?? lang} (${lang})`, strings: batch })),
        ]);
        const text = typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content);
        const parsed = parseJsonLoose(text) as { translations?: Record<string, string> } | null;
        Object.assign(out, parsed?.translations ?? {});
      } catch (err) {
        logger.warn({ err: (err as Error).message, lang }, 'LLM translation batch failed');
      }
    }
    return out;
  };
}

type Node = Record<string, unknown>;
/** Keys whose values are UI text (translated freely); everything else is data. */
const UI_KEYS = new Set(['say', 'title', 'subtitle', 'text', 'label', 'emptyText', 'caption', 'message', 'confirmLabel', 'reason']);
/** Keys holding values that are data but may match a known phrase pattern ("In seconds", "Main account · $50"). */
const PACK_ONLY = new Set(['value']);

/**
 * Translates the server-made texts of a (hydrated) spec into `lang`. For AI-composed specs the AI
 * already wrote in the user's language, so only server texts are touched (confirmations, pickers,
 * rejections, data blocks); rule/cached specs are translated entirely.
 */
export async function translateSpec<T>(spec: T, lang: string, opts: { user: User; aiWritten: boolean }): Promise<T> {
  if (!lang || lang === 'en') return spec;
  const free: string[] = [];
  const packOnly: string[] = [];
  const visit = (v: unknown, key: string, inServerData: boolean) => {
    if (typeof v === 'string') {
      if (UI_KEYS.has(key) && (!opts.aiWritten || inServerData)) free.push(v);
      else if (PACK_ONLY.has(key) && inServerData) packOnly.push(v);
      return;
    }
    if (Array.isArray(v)) v.forEach((x) => visit(x, key, inServerData));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Node)) {
        // Hydrated `data`, picker items and rejections are produced by the server, whatever engine composed the spec.
        visit(x, k, inServerData || k === 'data' || k === 'rejection' || k === 'summary');
      }
    }
  };
  visit(spec, '', false);
  if (!free.length && !packOnly.length) return spec;
  const [freeMap, packMap] = await Promise.all([
    translateTexts(free, lang, llmTranslator(opts.user)),
    translateTexts(packOnly, lang), // no LLM: names, notes and amounts are never sent for translation
  ]);
  const replace = (v: unknown, key: string): unknown => {
    if (typeof v === 'string') return (UI_KEYS.has(key) ? freeMap.get(v) : PACK_ONLY.has(key) ? packMap.get(v) : undefined) ?? v;
    if (Array.isArray(v)) return v.map((x) => replace(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Node).map(([k, x]) => [k, replace(x, k)]));
    return v;
  };
  return replace(spec, '') as T;
}
