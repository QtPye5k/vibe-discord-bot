import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import {
  Collection,
  Events,
  PermissionFlagsBits as P,
  PermissionsBitField,
  type ClientEvents,
  type Guild,
  type Message,
} from 'discord.js';
import { bindEvents, createServices } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/core/store.js';
import { getProfile } from '../src/features/community.js';
import { createAutomaticModeration } from '../src/moderation/service.js';
import { EXPLICIT_STRIKES, type ExplicitStrikeCount } from '../src/moderation/penalties.js';

const USER = '810000000000000002',
  BOT = '810000000000000003',
  CHANNEL = '810000000000000004',
  TRAP = '810000000000000005',
  OTHER_BOT = '810000000000000006';
let serial = 0;
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture(t: TestContext) {
  const guildId = String(810000000000001000n + BigInt(serial++)),
    services = createServices(
      loadConfig({
        DATABASE_PATH: ':memory:',
        ENABLE_VOICE: 'false',
        ENABLE_MESSAGE_CONTENT: 'true',
        AUTO_MODERATION_ENABLED: 'true',
        DISCORD_GUILD_IDS: guildId,
      }),
      { store: new Store(':memory:') },
    ),
    errors: { event: string; error: unknown }[] = [],
    trace: string[] = [],
    replies: { content?: string }[] = [],
    sends: { content?: string }[] = [],
    deleted: string[] = [],
    requests: string[] = [],
    messages = new Map<string, Message>();
  services.logger.error = (event, error) => {
    errors.push({ event, error });
  };
  services.logger.info = () => {};
  const user = { id: USER, bot: false, username: 'member' },
    permissions = new PermissionsBitField(P.Administrator),
    member = { id: USER, user, permissions, roles: { cache: new Collection() } },
    bot = { ...member, id: BOT, user: { id: BOT, bot: true, username: 'Vibe' } };
  const channel = (id: string) => ({
    id,
    guildId,
    type: 0,
    name: id === TRAP ? 'honeypot' : 'general',
    isThread: () => false,
    isTextBased: () => true,
    isSendable: () => true,
    permissionsFor: () => permissions,
    sendTyping: async () => {
      trace.push('typing');
    },
    send: async (payload: { content?: string }) => {
      trace.push('format');
      sends.push(payload);
      return { id: 'sent' };
    },
    messages: {
      fetch: async (input: string | { message: string }) => {
        const value = messages.get(typeof input === 'string' ? input : input.message);
        if (!value) throw new Error('Unknown fixture message');
        return value;
      },
    },
  });
  const channels = new Map([
      [CHANNEL, channel(CHANNEL)],
      [TRAP, channel(TRAP)],
    ]),
    guild = {
      id: guildId,
      name: 'Moderation fixture',
      ownerId: USER,
      members: { me: bot, fetch: async () => member, fetchMe: async () => bot },
      channels: { fetch: async (id: string) => channels.get(id) ?? null },
    };
  Object.assign(member, { guild });
  Object.assign(bot, { guild });
  services.client.guilds.cache.set(guildId, guild as unknown as Guild);
  services.client.guilds.fetch = (async () => guild) as unknown as typeof services.client.guilds.fetch;
  Object.defineProperty(services.client, 'user', { value: bot.user, configurable: true });
  const transport = t.mock.method(services.client.rest, 'request', async () => {
    throw new Error('Tests cannot make Discord API calls');
  });
  services.ai.chat = async (_ctx, text) => {
    trace.push('ai');
    requests.push(text);
    return { text: 'Accepted reply.', pending: [] };
  };
  t.mock.method(services.externalAutomation, 'observe', () => {
    trace.push('event');
  });
  services.store.set('community.settings', guildId, { xpEnabled: true, faqEnabled: true });
  services.store.set('automation.workflows', `${guildId}:observed`, {
    id: 'observed',
    guildId,
    authorId: USER,
    channelId: CHANNEL,
    trigger: Events.MessageCreate,
    version: 'fixture',
    enabled: true,
    steps: [{ kind: 'message', channelId: CHANNEL, content: 'Allowed event' }],
  });
  let messageSerial = 0;
  const makeMessage = (content: string, patch: Record<string, unknown> = {}) => {
    const channelId = String(patch.channelId ?? CHANNEL),
      value = {
        id: String(810000000000002000n + BigInt(messageSerial++)),
        guild,
        guildId,
        client: services.client,
        channel: channels.get(channelId),
        channelId,
        author: user,
        member,
        content,
        cleanContent: content,
        partial: false,
        system: false,
        webhookId: null,
        reference: null,
        createdTimestamp: Date.now(),
        editedTimestamp: null,
        attachments: new Collection(),
        embeds: [],
        stickers: new Collection(),
        mentions: { users: new Collection(), roles: new Collection(), everyone: false, repliedUser: null },
        deletable: true,
        delete: async () => {
          trace.push('delete');
          deleted.push(value.id);
        },
        reply: async (payload: { content?: string }) => {
          trace.push(payload.content === 'FAQ reply.' ? 'faq' : 'reply');
          replies.push(payload);
          return { id: 'reply' };
        },
        ...patch,
      } as unknown as Message;
    messages.set(value.id, value);
    return value;
  };
  const stop = bindEvents(services);
  t.after(async () => {
    await stop();
    assert.equal(transport.mock.callCount(), 0, 'all Discord transport is mocked');
    await services.close();
  });
  return {
    services,
    guildId,
    guild,
    trace,
    replies,
    sends,
    deleted,
    requests,
    errors,
    makeMessage,
    drain: stop,
    emit: async (message: Message) => {
      services.client.emit(Events.MessageCreate, message as ClientEvents[Events.MessageCreate][0]);
      await tick();
    },
    configureContentEffects: (content: string) => {
      services.store.set('community.faq', `${guildId}:${content.toLowerCase()}`, 'FAQ reply.');
      services.store.set('message.formatter', `${guildId}:${CHANNEL}`, {
        guildId,
        channelId: CHANNEL,
        ownerId: USER,
        originChannelId: CHANNEL,
        version: 'fixture',
        enabled: true,
        prefix: '!format',
      });
    },
  };
}

test('app routes another bot’s honeypot post to moderation before ignoring ordinary bot messages', async (t) => {
  const f = fixture(t),
    calls: Message[] = [];
  f.services.store.set('moderation.automatic', f.guildId, {
    ...f.services.automaticModeration.policy(f.guildId),
    honeypotChannelId: TRAP,
  });
  t.mock.method(f.services.automaticModeration, 'processMessage', async (message: Message) => {
    f.trace.push('moderation');
    calls.push(message);
    return true;
  });
  const message = f.makeMessage(`<@${BOT}> bot honeypot post`, {
    author: { id: OTHER_BOT, bot: true },
    channelId: TRAP,
  });
  await f.emit(message);
  await f.drain();
  assert.deepEqual(calls, [message]);
  assert.equal(calls[0]!.author.bot, true);
  assert.notEqual(calls[0]!.author.id, BOT, 'this tests another bot, not self-banning');
  assert.deepEqual(f.trace, ['moderation']);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.replies, []);
  assert.deepEqual(f.errors, []);
});

test('held and handled human content cannot reach XP, FAQ, formatting, AI or event workflows', async (t) => {
  const f = fixture(t),
    entered = latch(),
    completion = latch(),
    content = `!format quote forbidden <@${BOT}>`;
  f.configureContentEffects(content);
  t.mock.method(f.services.automaticModeration, 'processMessage', async () => {
    f.trace.push('moderation');
    entered.release();
    await completion.promise;
    return true;
  });
  f.services.client.emit(
    Events.MessageCreate,
    f.makeMessage(content) as ClientEvents[Events.MessageCreate][0],
  );
  await entered.promise;
  try {
    assert.equal(getProfile(f.services.store, f.guildId, USER).xp, 0);
    assert.deepEqual(f.replies, []);
    assert.deepEqual(f.trace, ['moderation'], 'event observers wait for the moderation decision');
    assert.equal(f.services.store.list('automation.outbox', `${f.guildId}:`).length, 0);
  } finally {
    completion.release();
  }
  await f.drain();
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.replies, []);
  assert.deepEqual(f.sends, []);
  assert.equal(getProfile(f.services.store, f.guildId, USER).xp, 0);
  assert.equal(f.services.store.get('message.formatCooldown', `${f.guildId}:${USER}`), undefined);
  assert.equal(f.services.store.list('automation.outbox', `${f.guildId}:`).length, 0);
  assert.deepEqual(f.errors, []);
});

test('an admitted ordinary message reaches XP, FAQ, formatter, addressed AI and event workflows once', async (t) => {
  const f = fixture(t),
    content = `!format quote hello <@${BOT}>`;
  f.configureContentEffects(content);
  t.mock.method(f.services.automaticModeration, 'processMessage', async () => {
    f.trace.push('moderation');
    return false;
  });
  assert.equal(
    f.services.automaticModeration.policy(f.guildId).enabled,
    true,
    'environment bootstraps the server policy',
  );
  await f.emit(f.makeMessage(content));
  await f.drain();
  assert.equal(f.trace[0], 'moderation');
  assert.deepEqual(f.requests, ['!format quote hello']);
  assert.deepEqual(
    f.replies.map((reply) => reply.content),
    ['FAQ reply.', 'Accepted reply.'],
  );
  assert.deepEqual(
    f.sends.map((reply) => reply.content),
    [`> hello <@${BOT}>`],
  );
  assert.equal(getProfile(f.services.store, f.guildId, USER).xp, 15);
  assert.equal(getProfile(f.services.store, f.guildId, USER).messages, 1);
  assert.equal(f.services.store.list('automation.outbox', `${f.guildId}:`).length, 1);
  assert.equal(f.trace.filter((entry) => entry === 'event').length, 1);
  assert.deepEqual(f.errors, []);
});

test('app fetches a partial message edit and dispatches the hydrated content to moderation as an edit', async (t) => {
  const f = fixture(t),
    calls: { message: Message; edited: boolean | undefined }[] = [],
    current = f.makeMessage('edited explicit content', { editedTimestamp: Date.now() });
  t.mock.method(
    f.services.automaticModeration,
    'processMessage',
    async (message: Message, event?: { edited?: boolean }) => {
      calls.push({ message, edited: event?.edited });
      return true;
    },
  );
  let fetched = 0;
  const partial = {
    guildId: f.guildId,
    partial: true,
    fetch: async () => {
      fetched++;
      return current;
    },
  };
  f.services.client.emit(
    Events.MessageUpdate,
    current as ClientEvents[Events.MessageUpdate][0],
    partial as unknown as ClientEvents[Events.MessageUpdate][1],
  );
  await f.drain();
  assert.equal(fetched, 1);
  assert.deepEqual(calls, [{ message: current, edited: true }]);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.replies, []);
  assert.deepEqual(f.errors, []);
});

test('the fourth repeat removes the complete observed burst before another classification without double-counting reward phases', async (t) => {
  const f = fixture(t),
    scanned: string[] = [],
    content = `hello <@${BOT}>`;
  f.services.store.set('community.settings', f.guildId, {
    antiSpamEnabled: true,
    antiSpamExemptStaff: false,
    xpEnabled: true,
    messageLimit: 8,
  });
  t.mock.method(f.services.automaticModeration, 'processMessage', async (message: Message) => {
    scanned.push(message.id);
    return false;
  });
  const accepted: string[] = [];
  for (let count = 0; count < 3; count++) {
    const message = f.makeMessage(content);
    accepted.push(message.id);
    await f.emit(message);
  }
  const spam = f.makeMessage(content);
  await f.emit(spam);
  await f.drain();
  assert.deepEqual(scanned, accepted);
  assert.deepEqual(f.deleted, [...accepted, spam.id]);
  assert.equal(f.requests.length, 1, 'the normal addressed-message cooldown still applies');
  assert.equal(f.replies.length, 1);
  assert.equal(getProfile(f.services.store, f.guildId, USER).messages, 1);
  assert.equal(
    f.services.store.list('automation.outbox', `${f.guildId}:`).length,
    3,
    'spam does not queue an event workflow',
  );
  assert.deepEqual(f.errors, []);
});

test('Every distinct explicit post reaches progressive penalties even when a repeated burst exceeds the spam threshold', async (t) => {
  for (const mode of ['local', 'semantic'] as const)
    await t.test(mode, async (sub) => {
      const f = fixture(sub),
        entered = latch(),
        release = latch(),
        timeouts: number[] = [],
        bans: string[] = [];
      let scans = 0;
      const bot = {
        id: BOT,
        guild: { id: f.guildId },
        user: { id: BOT, bot: true },
        permissions: new PermissionsBitField(P.Administrator),
        roles: {
          cache: new Collection(),
          highest: {
            position: 100,
            comparePositionTo: (target: { position: number }) => 100 - target.position,
          },
        },
      };
      const target = {
        id: USER,
        guild: { id: f.guildId },
        user: { id: USER, bot: false },
        permissions: new PermissionsBitField(0n),
        roles: { cache: new Collection(), highest: { position: 1 } },
        moderatable: true,
        bannable: true,
        communicationDisabledUntilTimestamp: null,
        disableCommunicationUntil: async (until: number) => {
          timeouts.push(until);
        },
      };
      Object.assign(f.guild, { ownerId: OTHER_BOT, roles: { fetch: async () => new Collection() } });
      Object.assign(f.guild.members, {
        me: bot,
        fetchMe: async () => bot,
        fetch: async () => target,
        ban: async (id: string) => {
          bans.push(id);
        },
      });
      const service = createAutomaticModeration({
        store: f.services.store,
        client: f.services.client,
        allowedGuildIds: [f.guildId],
        classify: async () => {
          scans++;
          entered.release();
          await release.promise;
          return { remove: true, categories: ['sexual'], scannedImages: 0 };
        },
      });
      f.services.automaticModeration = service;
      f.services.store.set('moderation.automatic', f.guildId, {
        enabled: true,
        textEnabled: true,
        imagesEnabled: false,
        explicitEscalationEnabled: true,
      });
      f.services.store.set('community.settings', f.guildId, {
        antiSpamEnabled: true,
        antiSpamExemptStaff: false,
        repeatLimit: 2,
        xpEnabled: true,
      });
      const messages = Array.from({ length: 5 }, () =>
        f.makeMessage(
          mode === 'local' ? 'Watch free porn videos' : 'A semantic-only classified unsafe utterance',
        ),
      );
      try {
        for (const message of messages)
          f.services.client.emit(Events.MessageCreate, message as ClientEvents[Events.MessageCreate][0]);
        if (mode === 'semantic') {
          await entered.promise;
          assert.equal(scans, 1);
        }
      } finally {
        release.release();
      }
      await f.drain();
      await service.close();
      assert.equal(
        f.services.store.get<ExplicitStrikeCount>(EXPLICIT_STRIKES, `${f.guildId}:${USER}`)?.count,
        5,
      );
      assert.equal(timeouts.length, 3);
      assert.deepEqual(bans, [USER]);
      assert.equal(new Set(f.deleted).size, 5);
      assert.equal(f.deleted.length, 5, 'spam must not delete an already moderated post twice');
      assert.equal(
        scans,
        mode === 'local' ? 0 : 1,
        'obvious local content and repeated positive semantic input avoid extra provider calls',
      );
      assert.deepEqual(f.requests, []);
      assert.deepEqual(f.replies, []);
      assert.equal(getProfile(f.services.store, f.guildId, USER).xp, 0);
    });
});
