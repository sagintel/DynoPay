import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import { env } from '../config/env.js';

export type Provider = 'gemini' | 'cloudflare' | 'offline';

export function providerAvailable(p: Provider): boolean {
  if (p === 'gemini') return Boolean(env.GEMINI_API_KEY);
  if (p === 'cloudflare') return Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN);
  return true;
}

/** Preferred provider (user setting → server default), falling back to whichever is configured. */
export function pickProvider(preferred?: Provider): Provider {
  if (preferred === 'offline') return 'offline';
  const order: Provider[] = [preferred ?? env.AI_PROVIDER, env.AI_PROVIDER, 'gemini', 'cloudflare'];
  return order.find((p) => p !== 'offline' && providerAvailable(p)) ?? 'offline';
}

export function availableProviders() {
  return (['gemini', 'cloudflare', 'offline'] as Provider[]).map((id) => ({
    id,
    available: providerAvailable(id),
    model: id === 'gemini' ? env.GEMINI_MODEL : id === 'cloudflare' ? env.CLOUDFLARE_MODEL : 'rules',
    default: id === env.AI_PROVIDER,
  }));
}

/**
 * LangChain chat models configured for JSON-only replies. Both providers speak
 * the same ReAct JSON protocol, so the agent loop is provider-agnostic.
 */
export function createChatModel(provider: Exclude<Provider, 'offline'>): BaseChatModel {
  if (provider === 'gemini') {
    return new ChatGoogleGenerativeAI({
      model: env.GEMINI_MODEL,
      apiKey: env.GEMINI_API_KEY,
      temperature: 0.2,
      maxOutputTokens: 4096,
      json: true,
      maxRetries: 1,
    });
  }
  // Cloudflare Workers AI exposes an OpenAI-compatible Chat Completions endpoint.
  const isReasoning = /gpt-oss|qwq|deepseek|qwen3/i.test(env.CLOUDFLARE_MODEL);
  return new ChatOpenAI({
    model: env.CLOUDFLARE_MODEL,
    apiKey: env.CLOUDFLARE_API_TOKEN,
    configuration: { baseURL: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1` },
    temperature: 0.2,
    maxTokens: 4096,
    useResponsesApi: false,
    maxRetries: 1,
    timeout: env.AGENT_TIMEOUT_MS,
    modelKwargs: {
      response_format: { type: 'json_object' },
      ...(isReasoning ? { reasoning_effort: 'low' } : {}),
    },
  });
}
