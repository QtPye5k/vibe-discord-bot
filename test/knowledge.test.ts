import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import type { AiService, ConversationOptions } from '../src/features/ai.js';
import { registerKnowledgeActions } from '../src/features/knowledge.js';
const G = '410000000000000001',
  U = '410000000000000002',
  C = '410000000000000003';
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const calls: { prompt: string; allow: boolean | undefined; options: ConversationOptions | undefined }[] =
    [];
  const ai = {
    embed: async () => [1, 0],
    chat: async (
      _ctx: ActionContext,
      prompt: string,
      _attachment: unknown,
      allow?: boolean,
      options?: ConversationOptions,
    ) => {
      calls.push({ prompt, allow, options });
      return { text: 'Answer [manual]', pending: [] };
    },
  };
  const channel = {
    guildId: G,
    isTextBased: () => true,
    permissionsFor: () => new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory]),
    messages: {
      fetch: async () =>
        new Map(
          Array.from({ length: 100 }, (_, i) => [
            String(i),
            { id: String(i), author: { id: U }, content: '\\\"\u0000'.repeat(500), createdTimestamp: i },
          ]),
        ),
    },
  };
  const member = { id: U },
    bot = { id: 'bot' };
  const ctx = {
    store,
    channelId: C,
    member,
    guild: {
      id: G,
      members: { me: bot, fetch: async () => member, fetchMe: async () => bot },
      channels: { fetch: async () => channel },
    },
  } as unknown as ActionContext;
  const registry = new ActionRegistry(120, async (c) => c);
  registerKnowledgeActions(registry, ai as unknown as AiService);
  return { ctx, store, registry, calls, ai, channel };
}
test('Knowledge retrieval only reads the requesting user/server and supplies named bounded sources', async (t) => {
  const f = fixture(t);
  f.store.set('ai.documents', `${G}:${U}:manual`, { text: 'own manual', embedding: [1, 0] });
  f.store.set('ai.documents', `${G}:other:secret`, { text: 'PRIVATE OTHER USER', embedding: [1, 0] });
  const result = (await f.registry.get('ai.knowledge.ask').execute(f.ctx, { question: 'How?' })) as {
    sources: { name: string }[];
  };
  assert.deepEqual(
    result.sources.map((s) => s.name),
    ['manual'],
  );
  assert.ok(!f.calls[0]!.prompt.includes('PRIVATE OTHER USER'));
  assert.equal(f.calls[0]!.allow, false);
  assert.equal(f.calls[0]!.options?.retainHistory, false);
  assert.equal(f.calls[0]!.options?.usePreferences, false);
});
test('Knowledge questions with no relevant documents do not ask the model to invent an answer', async (t) => {
  const f = fixture(t);
  f.store.set('ai.documents', `${G}:${U}:manual`, { text: 'unrelated', embedding: [0, 1] });
  const result = (await f.registry.get('ai.knowledge.ask').execute(f.ctx, { question: 'How?' })) as {
    sources: unknown[];
  };
  assert.deepEqual(result.sources, []);
  assert.equal(f.calls.length, 0);
});
test('Knowledge snapshots are refreshed after embedding and deletion during generation prevents delivery', async (t) => {
  const f = fixture(t),
    key = `${G}:${U}:manual`;
  f.store.set('ai.documents', key, { text: 'source', embedding: [1, 0] });
  f.ai.chat = async () => {
    f.store.delete('ai.documents', key);
    return { text: 'now deleted', pending: [] };
  };
  await assert.rejects(
    () => Promise.resolve(f.registry.get('ai.knowledge.ask').execute(f.ctx, { question: 'How?' })),
    /deleted/,
  );
});
test('Escaped knowledge and message excerpts fit the strict 8000-character chat input bound', async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 3; i++)
    f.store.set('ai.documents', `${G}:${U}:doc${i}`, { text: '\u0000'.repeat(12000), embedding: [1, 0] });
  await f.registry.get('ai.knowledge.ask').execute(f.ctx, { question: 'q'.repeat(1500) });
  assert.ok(f.calls[0]!.prompt.length <= 8000);
  const result = (await f.registry
    .get('ai.summarize.messages')
    .execute(f.ctx, { channelId: C, limit: 100, focus: 'f'.repeat(400) })) as {
    partial: boolean;
    messageIds: string[];
  };
  assert.ok(f.calls[1]!.prompt.length <= 8000);
  assert.equal(result.partial, true);
  assert.ok(result.messageIds.length > 0 && result.messageIds.length < 100);
  assert.equal(f.calls[1]!.options?.retainHistory, false);
});
test('Message summaries reject a channel without current readable history', async (t) => {
  const f = fixture(t);
  f.channel.permissionsFor = () => new PermissionsBitField(P.ViewChannel);
  await assert.rejects(
    () =>
      Promise.resolve(
        f.registry.get('ai.summarize.messages').execute(f.ctx, { channelId: C, limit: 10, focus: '' }),
      ),
    /history/,
  );
  assert.equal(f.calls.length, 0);
});
