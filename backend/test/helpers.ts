import os from 'node:os';
import path from 'node:path';
import { SimpleChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { connectDatabase } from '../src/db/index.js';

export async function setup() {
  // A real file (not :memory:) so transactions get their own connection, like production.
  const file = path.join(os.tmpdir(), `dynopay-test-${process.pid}-${Date.now()}.sqlite`);
  await connectDatabase(`sqlite:${file}`);
  const app = createApp();
  const login = await request(app).post('/v1/auth/dev').send({ name: 'Test User' });
  if (login.status !== 200) throw new Error(`dev login failed: ${JSON.stringify(login.body)}`);
  const auth = { Authorization: `Bearer ${login.body.accessToken as string}` };
  return { app, auth, login: login.body as { accessToken: string; refreshToken: string; user: { id: string } } };
}

export async function balanceOf(app: ReturnType<typeof createApp>, auth: Record<string, string>): Promise<number> {
  const res = await request(app).post('/v1/actions/get_balance').set(auth).send({ input: {} });
  return res.body.result.balance as number;
}

/** A LangChain chat model whose replies are computed from the conversation so far (for ReAct tests). */
export class ScriptedChatModel extends SimpleChatModel {
  calls: BaseMessage[][] = [];
  constructor(private readonly script: (messages: BaseMessage[], call: number) => string) {
    super({});
  }
  _llmType() {
    return 'scripted';
  }
  async _call(messages: BaseMessage[]): Promise<string> {
    this.calls.push(messages);
    return this.script(messages, this.calls.length - 1);
  }
}

export const lastObservation = (messages: BaseMessage[]) => {
  const text = String(messages.at(-1)?.content ?? '');
  return JSON.parse(text.replace(/^Observation:\s*/, '').replace(/…\(truncated.*$/, '')) as Record<string, any>;
};
