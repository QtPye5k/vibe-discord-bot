import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  Collection,
  Events,
  PermissionFlagsBits as P,
  PermissionsBitField,
  type Message,
  type ClientEvents,
} from 'discord.js';
import { bindEvents, createServices } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/core/store.js';
import { UserError } from '../src/core/errors.js';

const G = '760000000000000001',
  U = '760000000000000002',
  B = '760000000000000003',
  C = '760000000000000004',
  OTHER = '760000000000000005';
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function waitFor<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Expected message response did not arrive')), 2000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function fixture(t: TestContext) {
  const services = createServices(
    loadConfig({
      DATABASE_PATH: ':memory:',
      ENABLE_VOICE: 'false',
      ENABLE_MESSAGE_CONTENT: 'true',
      BOT_NAME: 'Vibe',
    }),
    { store: new Store(':memory:') },
  );
  const errors: { event: string; error: unknown }[] = [],
    order: string[] = [],
    replies: { content?: string }[] = [];
  services.logger.error = (event, error) => {
    errors.push({ event, error });
  };
  services.logger.info = () => {};
  const permissions = new PermissionsBitField(P.Administrator),
    user = { id: U, username: 'fixture', bot: false },
    member = { id: U, user, permissions, roles: { cache: new Collection() } },
    bot = { ...member, id: B, user: { id: B, username: 'Vibe', bot: true } };
  const channel = {
    id: C,
    guildId: G,
    type: 0,
    isSendable: () => true,
    isTextBased: () => true,
    permissionsFor: () => permissions,
    sendTyping: async () => {
      order.push('typing');
    },
  };
  const guild = {
    id: G,
    name: 'Fixture',
    ownerId: U,
    members: { me: bot, fetch: async () => member, fetchMe: async () => bot },
    channels: { fetch: async () => channel },
  };
  Object.assign(member, { guild });
  Object.assign(bot, { guild });
  Object.defineProperty(services.client, 'user', { value: bot.user, configurable: true });
  services.client.guilds.fetch = (async () => guild) as unknown as typeof services.client.guilds.fetch;
  let finish!: (payload: { content?: string }) => void;
  const replied = new Promise<{ content?: string }>((resolve) => {
    finish = resolve;
  });
  const stop = bindEvents(services);
  t.after(async () => {
    await stop();
    await services.close();
  });
  const makeMessage = (content: string, patch: Record<string, unknown> = {}) =>
    ({
      id: '760000000000000009',
      guild,
      guildId: G,
      channel,
      channelId: C,
      client: services.client,
      member,
      author: user,
      content,
      system: false,
      webhookId: null,
      reference: null,
      mentions: { users: new Collection(), roles: new Collection(), everyone: false },
      reply: async (payload: { content?: string }) => {
        replies.push(payload);
        finish(payload);
        return { id: 'reply' };
      },
      ...patch,
    }) as unknown as Message;
  return {
    services,
    channel,
    guild,
    member,
    order,
    errors,
    replies,
    replied,
    makeMessage,
    emit(content: string, patch: Record<string, unknown> = {}) {
      services.client.emit(
        Events.MessageCreate,
        makeMessage(content, patch) as ClientEvents[Events.MessageCreate][0],
      );
    },
    drain: stop,
  };
}

test('Vibe accepts actual mentions anywhere, nickname mention syntax and leading whitespace without exposing private AI tools', async (t) => {
  for (const [input, prompt] of [
    [`Hi <@${B}> can you help?`, 'Hi can you help?'],
    [`  <@!${B}>   Hello`, 'Hello'],
    [`<@${B}> hello <@${B}>`, 'hello'],
  ])
    await t.test(input!, async (sub) => {
      const f = fixture(sub),
        requests: string[] = [];
      f.services.ai.chat = async (_ctx, text, attachment, allowActions, options) => {
        requests.push(text.replace(/\s+/g, ' ').trim());
        assert.equal(attachment, undefined);
        assert.equal(allowActions, true);
        assert.deepEqual(options, {
          memoryScope: 'public-mention',
          usePreferences: false,
          retainHistory: true,
          historyTtlSeconds: 600,
          timeZone: 'America/New_York',
          responsePrivacy: 'public',
          allowWebSearch: false,
        });
        return { text: 'Hello from Vibe', pending: [] };
      };
      f.emit(input!);
      await waitFor(f.replied);
      await f.drain();
      assert.deepEqual(requests, [prompt]);
      assert.equal(f.replies[0]?.content, 'Hello from Vibe');
    });
});

test('An empty direct mention returns useful Vibe help without spending an AI request', async (t) => {
  const f = fixture(t);
  let calls = 0;
  f.services.ai.chat = async () => {
    calls++;
    return { text: 'unexpected', pending: [] };
  };
  f.emit(`  <@${B}>   `);
  await waitFor(f.replied);
  await f.drain();
  assert.equal(calls, 0);
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0]!.content!, /Vibe/);
  assert.match(f.replies[0]!.content!, /help|ask/i);
});

test('Other user/role mentions, an unrelated reply, bot/webhook messages and ordinary unaddressed text do not activate public AI', async (t) => {
  for (const [content, patch] of [
    [`<@${OTHER}> hello`, {}],
    [`<@&${B}> hello`, {}],
    ['Hello Vibe', {}],
    [
      'An ordinary reply',
      {
        reference: { messageId: OTHER },
        mentions: {
          repliedUser: { id: OTHER },
          users: new Collection([[B, { id: B }]]),
          roles: new Collection(),
          everyone: false,
        },
      },
    ],
    [`<@${B}> bot loop`, { author: { id: OTHER, bot: true } }],
    [`<@${B}> webhook loop`, { webhookId: OTHER }],
  ] as const)
    await t.test(content, async (sub) => {
      const f = fixture(sub);
      let calls = 0;
      f.services.ai.chat = async () => {
        calls++;
        return { text: 'unexpected', pending: [] };
      };
      f.emit(content, patch);
      await f.drain();
      assert.equal(calls, 0);
      assert.equal(f.replies.length, 0);
      assert.equal(f.order.length, 0);
    });
});

test('Typing starts before a delayed AI request, refreshes while pending, and stops after the completed response', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t),
    entered = latch(),
    completion = latch();
  f.services.ai.chat = async () => {
    f.order.push('chat');
    entered.release();
    await completion.promise;
    return { text: 'Finished', pending: [] };
  };
  try {
    f.emit(`<@${B}> think carefully`);
    await waitFor(entered.promise);
    assert.deepEqual(f.order.slice(0, 2), ['typing', 'chat']);
    t.mock.timers.tick(8000);
    await Promise.resolve();
    assert.equal(f.order.filter((value) => value === 'typing').length, 2);
  } finally {
    completion.release();
    await waitFor(f.replied);
    await f.drain();
  }
  assert.equal((await f.replied).content, 'Finished');
  const count = f.order.length;
  t.mock.timers.tick(24000);
  await Promise.resolve();
  assert.equal(f.order.length, count);
});

test('Typing failure does not suppress a response and a failed AI request releases its typing timer', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t);
  let typingCalls = 0;
  f.channel.sendTyping = async () => {
    typingCalls++;
    throw new Error('Typing endpoint unavailable');
  };
  f.services.ai.chat = async () => {
    throw new UserError('AI temporarily unavailable.');
  };
  f.emit(`<@${B}> hello`);
  await waitFor(f.replied);
  await f.drain();
  assert.equal(typingCalls, 1);
  assert.equal(f.replies[0]?.content, 'AI temporarily unavailable.');
  t.mock.timers.tick(24000);
  await Promise.resolve();
  assert.equal(typingCalls, 1);
});

test('Community, workflow and automation failures are isolated from explicitly addressed replies', async (t) => {
  for (const kind of ['community', 'workflow', 'automation'] as const)
    await t.test(kind, async (sub) => {
      const f = fixture(sub),
        failure = new Error(`fixture ${kind} failure`);
      if (kind === 'community') f.services.store.set('community.settings', G, { faqEnabled: 'invalid' });
      if (kind === 'workflow') {
        const original = f.services.store.get.bind(f.services.store);
        f.services.store.get = ((namespace: string, key: string) => {
          if (namespace === 'message.formatter') throw failure;
          return original(namespace, key);
        }) as typeof f.services.store.get;
      }
      if (kind === 'automation') {
        const original = f.services.store.list.bind(f.services.store);
        f.services.store.list = ((namespace: string, prefix?: string) => {
          if (namespace === 'message.relays') throw failure;
          return original(namespace, prefix);
        }) as typeof f.services.store.list;
      }
      f.services.ai.chat = async () => ({ text: 'Vibe is still answering', pending: [] });
      f.emit(`<@${B}> help me`);
      await waitFor(f.replied);
      await f.drain();
      assert.equal(f.replies[0]?.content, 'Vibe is still answering');
      assert.ok(f.errors.length >= 1);
    });
});

test('Fresh message-context authorization failures receive a safe visible reply instead of disappearing into logs', async (t) => {
  const f = fixture(t);
  let calls = 0;
  f.guild.members.fetch = async () => {
    throw new UserError('Your channel access changed.');
  };
  f.services.ai.chat = async () => {
    calls++;
    return { text: 'unexpected', pending: [] };
  };
  f.emit(`<@${B}> hello`);
  await waitFor(f.replied);
  await f.drain();
  assert.equal(calls, 0);
  assert.equal(f.replies[0]?.content, 'Your channel access changed.');
});

test('Missing text or thread send permission is detected before making a paid AI request', async (t) => {
  for (const thread of [false, true])
    await t.test(thread ? 'thread' : 'text channel', async (sub) => {
      const f = fixture(sub);
      let calls = 0;
      Object.assign(f.channel, { isThread: () => thread });
      f.channel.permissionsFor = () =>
        new PermissionsBitField(thread ? [P.ViewChannel, P.SendMessages] : [P.ViewChannel]);
      f.services.ai.chat = async () => {
        calls++;
        return { text: 'unexpected', pending: [] };
      };
      f.emit(`<@${B}> hello`);
      await waitFor(f.replied);
      await f.drain();
      assert.equal(calls, 0);
      assert.match(f.replies[0]?.content ?? '', /Send Messages/);
    });
});
