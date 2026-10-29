import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  Collection,
  PermissionsBitField,
  PermissionFlagsBits as P,
  type GuildMember,
  type Message,
} from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import {
  flushRelayQueue,
  handleMessageAutomation,
  observeMessageTracking,
  registerMessageAutomationActions,
  sweepMessageAutomation,
} from '../src/features/message-automation.js';
const G = '760000000000000001',
  U = '760000000000000002',
  V = '760000000000000003',
  BOT = '760000000000000004',
  S = '760000000000000005',
  D = '760000000000000006',
  M = '760000000000000007';
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const forwarded: string[] = [],
    replies: string[] = [],
    hooks: { read?: () => void; forward?: () => Promise<void> | void } = {};
  let enabled = true;
  const make = (id: string, bot = false) => ({
      id,
      user: { id, bot },
      permissions: new PermissionsBitField(P.Administrator),
      roles: { cache: new Collection() },
    }),
    manager = make(U),
    author = make(V),
    bot = make(BOT, true);
  const messages = new Map<string, Message>();
  const source = {
    id: S,
    guildId: G,
    type: 0,
    isTextBased: () => true,
    isSendable: () => true,
    permissionsFor: (member: { permissions: PermissionsBitField }) => member.permissions,
    messages: {
      fetch: async (input: string | { message: string }) => {
        hooks.read?.();
        const value = messages.get(typeof input === 'string' ? input : input.message);
        if (!value) throw new Error('Unknown message');
        return value;
      },
    },
  };
  const target = { ...source, id: D },
    guild = {
      id: G,
      ownerId: U,
      members: {
        me: bot,
        fetch: async (input: string | { user: string }) =>
          (typeof input === 'string' ? input : input.user) === V ? author : manager,
        fetchMe: async () => bot,
      },
      channels: { fetch: async (id: string) => (id === S ? source : target) },
    };
  Object.assign(author, { guild });
  Object.assign(manager, { guild });
  const client = { user: { id: BOT }, guilds: { fetch: async () => guild } };
  const ctx = { store, client, guild, member: manager, channelId: S } as unknown as ActionContext,
    authorCtx = { ...ctx, member: author as unknown as GuildMember };
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  registerMessageAutomationActions(registry, {
    messageContentEnabled: () => enabled,
    aiAvailable: () => true,
  });
  const run = async (id: string, input: unknown, context = ctx) => {
    const action = registry.get(id);
    return action.execute(context, action.schema.parse(input));
  };
  const message = (id = M, content = 'A source message') => {
    const row = {
      id,
      guild,
      guildId: G,
      client,
      member: author,
      author: author.user,
      channelId: S,
      content,
      system: false,
      webhookId: null,
      reference: null,
      forward: async (channel: { id: string }) => {
        await hooks.forward?.();
        forwarded.push(`${id}:${channel.id}`);
        return { id: `forward-${id}` };
      },
      reply: async (input: { content: string }) => {
        replies.push(input.content);
        return { id: 'reply' };
      },
    } as unknown as Message;
    messages.set(id, row);
    return row;
  };
  const setupRelay = () => run('relay.configure', { id: 'bridge', sourceChannelId: S, targetChannelId: D });
  const consentRelay = () => run('relay.consent', { id: 'bridge', enabled: true }, authorCtx);
  const setupConversation = async () => {
    await run('conversation.channel.configure', { channelId: S, enabled: true });
    await run('conversation.channel.consent', { channelId: S, enabled: true }, authorCtx);
  };
  return {
    store,
    ctx,
    authorCtx,
    registry,
    run,
    message,
    setupRelay,
    consentRelay,
    setupConversation,
    forwarded,
    replies,
    hooks,
    author,
    manager,
    client,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
  };
}
const deliveryOptions = { messageContentEnabled: true, commandPrefix: '!' };
test('continuous relays require exact author consent, forward once and invalidate consent after policy edits', async (t) => {
  const f = fixture(t);
  await f.setupRelay();
  const message = f.message();
  await handleMessageAutomation(message, f.store, undefined, deliveryOptions);
  assert.deepEqual(f.forwarded, []);
  await f.consentRelay();
  await handleMessageAutomation(message, f.store, undefined, deliveryOptions);
  await handleMessageAutomation(message, f.store, undefined, deliveryOptions);
  assert.deepEqual(f.forwarded, [`${M}:${D}`]);
  await f.setupRelay();
  await handleMessageAutomation(f.message('760000000000000008'), f.store, undefined, deliveryOptions);
  assert.equal(f.forwarded.length, 1);
});
test('relay consent withdrawal during source lookup and missing destination posting authority suppress delivery', async (t) => {
  const f = fixture(t);
  await f.setupRelay();
  await f.consentRelay();
  f.hooks.read = () => f.store.delete('message.relayConsent', `${G}:bridge:${V}`);
  await handleMessageAutomation(f.message(), f.store, undefined, deliveryOptions);
  assert.equal(f.forwarded.length, 0);
  f.hooks.read = undefined;
  await f.consentRelay();
  f.author.permissions = new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory]);
  await handleMessageAutomation(f.message(), f.store, undefined, deliveryOptions);
  assert.equal(f.forwarded.length, 0);
});
test('unknown relay sends remain visible and are never blindly sent a second time', async (t) => {
  const f = fixture(t);
  await f.setupRelay();
  await f.consentRelay();
  let attempts = 0;
  f.hooks.forward = () => {
    attempts++;
    throw new Error('Unknown forward');
  };
  const message = f.message();
  await handleMessageAutomation(message, f.store, undefined, deliveryOptions);
  await handleMessageAutomation(message, f.store, undefined, deliveryOptions);
  assert.equal(attempts, 1);
  assert.equal(f.store.list<{ state: string }>('message.relayDeliveries')[0]!.value.state, 'unknown');
});
test('relay saturation persists reference-only deferred work and flushes it without starting AI conversation', async (t) => {
  const f = fixture(t);
  await f.setupRelay();
  await f.consentRelay();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.hooks.forward = () => gate;
  const work = Array.from({ length: 5 }, (_, index) =>
    handleMessageAutomation(
      f.message(String(BigInt(M) + BigInt(index))),
      f.store,
      undefined,
      deliveryOptions,
    ),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    f.store.list<{ state: string }>('message.relayDeliveries').filter((row) => row.value.state === 'deferred')
      .length,
    1,
  );
  release();
  await Promise.all(work);
  await flushRelayQueue(f.ctx.client, f.store, { messageContentEnabled: true });
  assert.equal(f.forwarded.length, 5);
});
test('disabled Message Content prevents old stored relay policies from forwarding after restart', async (t) => {
  const f = fixture(t);
  await f.setupRelay();
  await f.consentRelay();
  await handleMessageAutomation(f.message(), f.store, undefined, { messageContentEnabled: false });
  assert.equal(f.forwarded.length, 0);
  f.setEnabled(false);
  await assert.rejects(
    () =>
      f.registry.request(f.ctx, 'relay.configure', { id: 'other', sourceChannelId: S, targetChannelId: D }),
    /Message Content/,
  );
});
test('reply and reaction watches persist deduplicated transition counts and preserve current source privacy', async (t) => {
  const f = fixture(t);
  f.message();
  const watch = (await f.run('tracking.watch', { channelId: S, messageId: M })) as { id: string };
  const reply = {
    id: '760000000000000009',
    guildId: G,
    channelId: S,
    author: { id: V, bot: false },
    reference: { messageId: M },
    webhookId: null,
  };
  observeMessageTracking('messageCreate', [reply], f.store);
  observeMessageTracking('messageCreate', [reply], f.store);
  const reaction = { message: { guildId: G, channelId: S, id: M }, emoji: { name: '⭐', id: null } },
    user = { id: V, bot: false };
  for (const event of [
    'messageReactionAdd',
    'messageReactionAdd',
    'messageReactionRemove',
    'messageReactionRemove',
    'messageReactionAdd',
  ])
    observeMessageTracking(event, [reaction, user], f.store);
  const view = (await f.run('tracking.view', { id: watch.id })) as {
    replyCount: number;
    reactionAdds: number;
    reactionRemoves: number;
  };
  assert.equal(view.replyCount, 1);
  assert.equal(view.reactionAdds, 2);
  assert.equal(view.reactionRemoves, 1);
  f.manager.permissions = new PermissionsBitField(0n);
  await assert.rejects(() => f.run('tracking.view', { id: watch.id }), /view/);
});
test('unmentioned conversation starts only after explicit consent and never receives private history, preferences or tools', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const ai = {
    available: true,
    chat: async (
      _ctx: ActionContext,
      _text: string,
      _file: unknown,
      allow: unknown,
      options: Record<string, unknown>,
    ) => {
      calls++;
      assert.equal(allow, false);
      assert.equal(options.usePreferences, false);
      assert.equal(options.retainHistory, true);
      assert.match(String(options.memoryScope), /^consented-public-channel:/);
      return { text: 'Consented reply', pending: [] };
    },
  };
  await f.run('conversation.channel.configure', { channelId: S, enabled: true });
  await handleMessageAutomation(f.message(), f.store, ai as never, deliveryOptions);
  assert.equal(calls, 0);
  await f.run('conversation.channel.consent', { channelId: S, enabled: true }, f.authorCtx);
  await handleMessageAutomation(f.message(), f.store, ai as never, deliveryOptions);
  assert.equal(calls, 1);
  assert.deepEqual(f.replies, ['Consented reply']);
});
test('conversation revocation during provider work prevents public replies and removes late retained history', async (t) => {
  const f = fixture(t);
  await f.setupConversation();
  const ai = {
    available: true,
    chat: async (
      ctx: ActionContext,
      _text: string,
      _file: unknown,
      _allow: unknown,
      options: { memoryScope: string },
    ) => {
      await f.run('conversation.channel.consent', { channelId: S, enabled: false }, f.authorCtx);
      f.store.set('ai.conversations', `${G}:${S}:${options.memoryScope}:${ctx.member.id}`, ['late data']);
      return { text: 'Late response', pending: [] };
    },
  };
  await handleMessageAutomation(f.message(), f.store, ai as never, deliveryOptions);
  assert.deepEqual(f.replies, []);
  assert.equal(f.store.list('ai.conversations').length, 0);
});
test('configured prefix messages do not receive a second passive AI response and expired watches are pruned', async (t) => {
  const f = fixture(t);
  await f.setupConversation();
  const ai = {
    available: true,
    chat: async () => {
      throw new Error('Must not call AI for prefix commands');
    },
  };
  await handleMessageAutomation(f.message(M, '$help'), f.store, ai as never, {
    messageContentEnabled: true,
    commandPrefix: '$',
  });
  assert.deepEqual(f.replies, []);
  f.store.set('message.watches', `${G}:expired`, { expiresAt: 1 });
  sweepMessageAutomation(f.store);
  assert.equal(f.store.list('message.watches').length, 0);
});
