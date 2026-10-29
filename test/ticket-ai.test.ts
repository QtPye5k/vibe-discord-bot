import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits as P, PermissionsBitField, Collection, type Client } from 'discord.js';
import { z } from 'zod';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import type { AiService, ConversationOptions } from '../src/features/ai.js';
import { registerTicketAiActions, sweepTicketAiTasks } from '../src/features/ticket-ai.js';
const G = '610000000000000001',
  U = '610000000000000002',
  C = '610000000000000003';
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const calls: { prompt: string; options?: ConversationOptions }[] = [];
  const member = {
    id: U,
    permissions: new PermissionsBitField([P.ManageGuild, P.ModerateMembers]),
    roles: { cache: new Map() },
  };
  const bot = { id: 'bot' },
    channel = { guildId: G, permissionsFor: () => new PermissionsBitField(P.ViewChannel) };
  const guild = {
    id: G,
    members: { me: bot, fetch: async () => member, fetchMe: async () => bot },
    channels: { fetch: async () => channel },
  };
  const client = { guilds: { fetch: async () => guild } } as unknown as Client;
  const ctx = { client, store, guild, member, channelId: C } as unknown as ActionContext;
  const ai = {
    chat: async (
      _ctx: ActionContext,
      prompt: string,
      _attachment: unknown,
      allow?: boolean,
      options?: ConversationOptions,
    ) => {
      assert.equal(allow, false);
      calls.push({ prompt, options });
      return { text: '{"category":"support"}', pending: [] };
    },
  };
  const registry = new ActionRegistry(120, async (c) => c);
  registerTicketAiActions(registry, ai as Pick<AiService, 'chat'>);
  const execute = (id: string, input: unknown = {}) => {
    const action = registry.get(id);
    return Promise.resolve(action.execute(ctx, action.schema.parse(input)));
  };
  const ticket = (id = C) =>
    store.set('community.tickets', `${G}:${id}`, {
      id,
      channelId: id,
      userId: 'owner',
      subject: 'Need help',
      createdAt: Date.now() + 1,
      status: 'open',
    });
  const configure = () =>
    execute('ticket.ai.configure', { enabled: true, categories: ['support', 'billing'] });
  return { store, ctx, client, member, channel, ai, calls, execute, ticket, configure, registry };
}
test('content classification supplies approved readable messages, infers priority/locale and applies only exact configured routes', async (t) => {
  const f = fixture(t),
    category = '610000000000000009',
    writes: unknown[] = [];
  Object.assign(f.channel, {
    type: 0,
    isTextBased: () => true,
    permissionsFor: () => new PermissionsBitField(P.Administrator),
    messages: {
      fetch: async () =>
        new Collection([
          [
            'message',
            {
              id: 'message',
              createdTimestamp: 1,
              author: { id: 'customer' },
              content: 'Bonjour, urgent login outage',
            },
          ],
        ]),
    },
  });
  f.ctx.guild.channels.fetch = (async (channelId: string) =>
    channelId === category
      ? { ...f.channel, type: 4 }
      : f.channel) as unknown as typeof f.ctx.guild.channels.fetch;
  f.registry.register({
    id: 'ticket.category',
    description: 'Test approved category mutation',
    category: 'support',
    risk: 'write',
    schema: z.strictObject({ channelId: z.string(), categoryId: z.string() }),
    userPermissions: [],
    botPermissions: [],
    execute: (_ctx, input) => {
      writes.push(input);
      return {};
    },
  });
  f.registry.register({
    id: 'ticket.update',
    description: 'Test approved ticket metadata update',
    category: 'support',
    risk: 'write',
    schema: z.strictObject({ channelId: z.string(), priority: z.enum(['low', 'normal', 'high', 'urgent']) }),
    userPermissions: [],
    botPermissions: [],
    execute: (_ctx, input) => {
      writes.push(input);
      return {};
    },
  });
  await f.execute('ticket.ai.configure', {
    enabled: true,
    categories: ['support', 'billing'],
    includeContent: true,
    inferPriority: true,
    inferLocale: true,
    applyPriority: true,
    routes: [{ category: 'support', categoryId: category }],
  });
  f.ticket();
  f.ai.chat = async (_ctx, prompt) => {
    assert.match(prompt, /Bonjour/);
    return { text: '{"category":"support","priority":"urgent","locale":"fr"}', pending: [] };
  };
  const result = (await f.execute('ticket.ai.classify', { channelId: C })) as {
    priority: string;
    locale: string;
    routeState: string;
    priorityState: string;
  };
  assert.equal(result.priority, 'urgent');
  assert.equal(result.locale, 'fr');
  assert.equal(result.routeState, 'applied');
  assert.equal(result.priorityState, 'applied');
  assert.deepEqual(writes, [
    { channelId: C, priority: 'urgent' },
    { channelId: C, categoryId: category },
  ]);
});
test('changing readable ticket content during AI processing prevents stale classification or routing', async (t) => {
  const f = fixture(t);
  let text = 'Original content';
  Object.assign(f.channel, {
    isTextBased: () => true,
    permissionsFor: () => new PermissionsBitField(P.Administrator),
    messages: {
      fetch: async () =>
        new Collection([
          ['message', { id: 'message', createdTimestamp: 1, author: { id: 'customer' }, content: text }],
        ]),
    },
  });
  await f.execute('ticket.ai.configure', {
    enabled: true,
    categories: ['support', 'billing'],
    includeContent: true,
  });
  f.ticket();
  f.ai.chat = async () => {
    text = 'Edited while classifying';
    return { text: '{"category":"support"}', pending: [] };
  };
  await assert.rejects(() => f.execute('ticket.ai.classify', { channelId: C }), /source or policy changed/);
  assert.equal(f.store.list('support.ai.labels').length, 0);
});
test('automatic classification processes approved private-thread tickets with a single billed attempt', async (t) => {
  const f = fixture(t);
  await f.configure();
  const threadId = 'ab'.repeat(12);
  f.store.set('support.threadTickets', `${G}:${threadId}`, {
    id: threadId,
    guildId: G,
    threadId: C,
    userId: 'customer',
    subject: 'Private thread question',
    staffUserIds: [U],
    createdAt: Date.now() + 1,
    state: 'open',
  });
  await sweepTicketAiTasks(f.client, f.store, f.ai as Pick<AiService, 'chat'>, f.registry);
  assert.equal(f.calls.length, 1);
  await sweepTicketAiTasks(f.client, f.store, f.ai as Pick<AiService, 'chat'>, f.registry);
  assert.equal(f.calls.length, 1);
  assert.ok(f.store.get('support.ai.labels', `${G}:${threadId}`));
});

test('Ticket classifier uses only the subject and no personal memory, web search or administrative tools', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.ticket();
  const result = (await f.execute('ticket.ai.classify', { channelId: C })) as { category: string };
  assert.equal(result.category, 'support');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.options?.retainHistory, false);
  assert.equal(f.calls[0]!.options?.usePreferences, false);
  assert.equal(f.calls[0]!.options?.allowWebSearch, false);
});
test('Model responses outside the approved taxonomy cannot write ticket labels', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.ticket();
  f.ai.chat = async () => ({ text: '{"category":"admin"}', pending: [] });
  await assert.rejects(() => f.execute('ticket.ai.classify', { channelId: C }), /taxonomy/);
  assert.equal(f.store.list('support.ai.labels').length, 0);
});
test('Source replacement, lost staff authority and module toggles suppress late ticket classification', async (t) => {
  for (const change of ['subject', 'staff', 'toggle'])
    await t.test(change, async (sub) => {
      const f = fixture(sub);
      await f.configure();
      f.ticket();
      f.ai.chat = async () => {
        if (change === 'subject')
          f.store.set('community.tickets', `${G}:${C}`, {
            id: C,
            channelId: C,
            userId: 'owner',
            subject: 'Changed subject',
            createdAt: Date.now() + 1,
            status: 'open',
          });
        if (change === 'staff') f.member.permissions = new PermissionsBitField(P.ManageGuild);
        if (change === 'toggle') f.store.set('core.featureEpochs', `${G}:ai`, 1);
        return { text: '{"category":"support"}', pending: [] };
      };
      await assert.rejects(() => f.execute('ticket.ai.classify', { channelId: C }));
      assert.equal(f.store.list('support.ai.labels').length, 0);
    });
});
test('Automatic labels process one future ticket per cycle and do not repeat paid work or retry failures', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.ticket();
  f.ticket('610000000000000004');
  await sweepTicketAiTasks(f.client, f.store, f.ai as Pick<AiService, 'chat'>, f.registry);
  assert.equal(f.calls.length, 1);
  await sweepTicketAiTasks(f.client, f.store, f.ai as Pick<AiService, 'chat'>, f.registry);
  assert.equal(f.calls.length, 2);
  await sweepTicketAiTasks(f.client, f.store, f.ai as Pick<AiService, 'chat'>, f.registry);
  assert.equal(f.calls.length, 2);
  f.ticket('610000000000000005');
  let failures = 0;
  f.ai.chat = async () => {
    failures++;
    throw new Error('Provider failed');
  };
  await sweepTicketAiTasks(f.client, f.store, f.ai as Pick<AiService, 'chat'>, f.registry);
  await sweepTicketAiTasks(f.client, f.store, f.ai as Pick<AiService, 'chat'>, f.registry);
  assert.equal(failures, 1);
});
test('Automatic classification respects action restrictions and reaches an older ticket behind 100 completed records', async (t) => {
  const f = fixture(t);
  await f.configure();
  const policy = f.store.get<{ version: string; createdAt: number }>('support.ai.policy', G)!;
  for (let i = 0; i < 101; i++) {
    const id = String(BigInt(C) + BigInt(i));
    f.ticket(id);
    if (i)
      f.store.set('support.ai.labels', `${G}:${id}`, {
        policyVersion: policy.version,
        state: 'done',
        sourceHash: 'old',
        updatedAt: Date.now(),
      });
  }
  f.store.set('core.actionPolicies', `${G}:ticket.ai.classify`, {
    enabled: false,
    roleIds: [],
    channelIds: [],
  });
  await sweepTicketAiTasks(f.client, f.store, f.ai as Pick<AiService, 'chat'>, f.registry);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.get('support.ai.labels', `${G}:${C}`), undefined);
  f.store.delete('core.actionPolicies', `${G}:ticket.ai.classify`);
  await sweepTicketAiTasks(f.client, f.store, f.ai as Pick<AiService, 'chat'>, f.registry);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.get<{ state: string }>('support.ai.labels', `${G}:${C}`)?.state, 'done');
});
