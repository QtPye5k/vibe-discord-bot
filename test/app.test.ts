import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  Events,
  GatewayIntentBits as I,
  MessageFlags,
  PermissionsBitField,
  PermissionFlagsBits as P,
  type Guild,
  type Interaction,
  type ClientEvents,
  Routes,
} from 'discord.js';
import { z } from 'zod';
import {
  bindEvents,
  commandContext,
  createServices,
  deployCommands,
  helpPayload,
  eventGuildId,
  startBot,
  type Services,
} from '../src/app.js';
import { commandDefinitions } from '../src/discord/commands.js';
import { confirmationRows, outcomePayload, preview, textPayload } from '../src/discord/presentation.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/core/store.js';
import { isCurrentUserRequest } from '../src/core/types.js';
import { forgetPersonalAi } from '../src/discord/personal.js';

const GUILD = '300000000000000001',
  USER = '300000000000000002',
  BOT = '300000000000000003',
  CHANNEL = '300000000000000004',
  OTHER = '300000000000000005';
function fixture(t: TestContext, env: NodeJS.ProcessEnv = {}) {
  const services = createServices(loadConfig({ ...env, ENABLE_VOICE: 'true', DATABASE_PATH: ':memory:' }), {
    store: new Store(':memory:'),
  });
  services.logger.error = () => undefined;
  services.logger.info = () => undefined;
  const bot = { id: BOT, permissions: new PermissionsBitField(P.Administrator) };
  const user = { id: USER, username: 'test-user' };
  const member = {
    id: USER,
    user,
    permissions: new PermissionsBitField(P.Administrator),
    roles: { cache: new Map() },
  };
  const channel = {
    id: CHANNEL,
    guildId: GUILD,
    type: 0,
    isSendable: () => true,
    isTextBased: () => true,
    permissionsFor: () => new PermissionsBitField(P.Administrator),
  };
  const guild = {
    id: GUILD,
    ownerId: USER,
    name: 'Test server',
    members: { me: bot, fetch: async () => member, fetchMe: async () => bot },
    channels: { fetch: async () => channel },
  } as unknown as Guild;
  services.client.guilds.cache.set(GUILD, guild);
  let stop: (() => Promise<void>) | undefined;
  t.after(async () => {
    await stop?.();
    await services.close();
  });
  return {
    services,
    guild,
    user,
    bind() {
      stop ??= bindEvents(services);
    },
    emit(interaction: Interaction) {
      services.client.emit(Events.InteractionCreate, interaction);
    },
  };
}
type Kind = 'slash' | 'button' | 'modal' | 'autocomplete' | 'user-context' | 'message-context';
function fakeInteraction(guild: Guild, kind: Kind, name: string, values: Record<string, unknown> = {}) {
  const events: string[] = [],
    replies: unknown[] = [];
  let finish!: (payload: unknown) => void;
  const finished = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  function option(key: string, required = false) {
    const value = values[key] ?? null;
    if (required && value === null) throw new Error(`Missing required option ${key}`);
    return value;
  }
  const interaction = {
    guild,
    guildId: guild.id,
    channelId: CHANNEL,
    user: { id: USER, username: 'test-user' },
    commandName: name,
    customId: name,
    targetId: OTHER,
    targetMessage: { id: 'message', channelId: CHANNEL, content: 'untrusted sample' },
    deferred: false,
    replied: false,
    inGuild: () => true,
    isChatInputCommand: () => kind === 'slash',
    isButton: () => kind === 'button',
    isMessageComponent: () => kind === 'button',
    isStringSelectMenu: () => false,
    isRepliable: () => true,
    isModalSubmit: () => kind === 'modal',
    isAutocomplete: () => kind === 'autocomplete',
    isContextMenuCommand: () => kind === 'user-context' || kind === 'message-context',
    isMessageContextMenuCommand: () => kind === 'message-context',
    isUserContextMenuCommand: () => kind === 'user-context',
    options: {
      getString: (key: string, required?: boolean) => option(key, required),
      getInteger: (key: string, required?: boolean) => option(key, required),
      getBoolean: (key: string, required?: boolean) => option(key, required),
      getUser: (key: string, required?: boolean) => option(key, required),
      getAttachment: (key: string, required?: boolean) => option(key, required),
      getFocused: () => values.focused ?? '',
      getSubcommandGroup: () => values.group ?? null,
      getSubcommand: () => values.subcommand ?? null,
    },
    fields: { getTextInputValue: () => String(values.json ?? '{}') },
    async deferReply(options: unknown) {
      events.push('defer');
      interaction.deferred = true;
      replies.push(options);
    },
    async editReply(payload: unknown) {
      events.push('edit');
      replies.push(payload);
      finish(payload);
      return payload;
    },
    async reply(payload: unknown) {
      events.push('reply');
      interaction.replied = true;
      replies.push(payload);
      finish(payload);
      return payload;
    },
    async respond(payload: unknown) {
      events.push('autocomplete');
      replies.push(payload);
      finish(payload);
    },
    async showModal(payload: unknown) {
      events.push('modal');
      interaction.replied = true;
      replies.push(payload);
      finish(payload);
    },
  };
  return { interaction: interaction as unknown as Interaction, data: interaction, events, replies, finished };
}
function content(payload: unknown): string {
  return (payload as { content?: string }).content ?? '';
}
function fakeMessage(
  guild: Guild,
  text: string,
  options: { userId?: string; channelId?: string; replyTo?: string; pingReply?: boolean } = {},
) {
  const replies: unknown[] = [];
  let finish!: (payload: unknown) => void;
  const finished = new Promise<unknown>((resolve) => {
    finish = resolve;
  });
  const message = {
    id: 'source-message',
    guild,
    guildId: guild.id,
    author: { id: options.userId ?? USER, bot: false },
    channelId: options.channelId ?? CHANNEL,
    channel: { sendTyping: async () => undefined },
    content: text,
    webhookId: null,
    reference: options.replyTo ? { messageId: 'prior-message', channelId: CHANNEL, guildId: guild.id } : null,
    mentions: {
      repliedUser: options.replyTo && options.pingReply !== false ? { id: options.replyTo } : null,
    },
    fetchReference: async () => ({ author: { id: options.replyTo }, guildId: guild.id, channelId: CHANNEL }),
    reply: async (payload: unknown) => {
      replies.push(payload);
      finish(payload);
      return payload;
    },
  };
  return { message: message as unknown as ClientEvents[Events.MessageCreate][0], replies, finished };
}
function spyRequests(services: Services) {
  const requests: { id: string; input: unknown }[] = [];
  services.registry.request = async (_ctx, id, input) => {
    services.registry.get(id).schema.parse(input);
    requests.push({ id, input });
    return { status: 'completed', action: id, result: 'ok' };
  };
  return requests;
}

test('Offline service construction registers the entire action catalog with serializable schemas', async (t) => {
  const { services } = fixture(t),
    actions = services.registry.list();
  assert.ok(actions.length > 150);
  assert.equal(new Set(actions.map((action) => action.id)).size, actions.length);
  for (const action of actions) {
    assert.doesNotThrow(() => JSON.stringify(z.toJSONSchema(action.schema, { io: 'input' })), action.id);
    assert.ok(action.description.length > 0);
    assert.ok(['read', 'write', 'destructive'].includes(action.risk));
  }
  assert.equal(services.ai.available, false);
  for (const intent of [
    I.Guilds,
    I.GuildMessages,
    I.GuildMessageReactions,
    I.GuildMessagePolls,
    I.GuildModeration,
    I.GuildScheduledEvents,
    I.GuildIntegrations,
    I.GuildWebhooks,
    I.AutoModerationConfiguration,
    I.AutoModerationExecution,
  ])
    assert.ok(services.client.options.intents.has(intent), `Missing Gateway intent ${intent}`);
});
test('Disabling voice capture preserves Gateway metadata for separately configured automation and analytics', async (t) => {
  const services = createServices(loadConfig({ ENABLE_VOICE: 'false', DATABASE_PATH: ':memory:' }), {
    store: new Store(':memory:'),
  });
  t.after(() => services.close());
  assert.ok(services.client.options.intents.has(I.GuildVoiceStates));
  assert.ok(!services.registry.list().some((action) => action.id === 'voice.join'));
  assert.ok(services.registry.list().some((action) => action.id === 'voiceroom.hub'));
  assert.equal(services.client.options.intents.has(I.GuildMembers), false);
  assert.equal(services.client.options.intents.has(I.GuildPresences), false);
});

test('Graceful shutdown drains pending command deployment before closing SQLite', async (t) => {
  const f = fixture(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    putEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
  Object.defineProperty(f.services.client, 'application', {
    value: { fetch: async () => ({ id: 'app' }) },
    configurable: true,
  });
  const remote = new Map<string, unknown>();
  f.services.client.rest.get = (async (route) =>
    remote.get(String(route)) ?? []) as typeof f.services.client.rest.get;
  f.services.client.rest.put = (async (route, options) => {
    entered();
    await gate;
    const body = (options as { body: unknown }).body;
    remote.set(String(route), body);
    return body;
  }) as typeof f.services.client.rest.put;
  f.services.client.login = async () => {
    f.services.client.emit(Events.ClientReady, f.services.client as never);
    return 'fake-login';
  };
  const stop = await startBot(f.services);
  await putEntered;
  let stopped = false;
  const pending = stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.doesNotThrow(() => f.services.store.get('test', 'open'));
  release();
  await pending;
  assert.equal(stopped, true);
  assert.throws(() => f.services.store.get('test', 'closed'), /finalized|closed/);
});
test('Startup cancellation closes services while an unconnected login is pending', async (t) => {
  const f = fixture(t),
    controller = new AbortController();
  let entered!: () => void;
  const loginEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.services.client.login = () => {
    entered();
    return new Promise<string>(() => {});
  };
  const startup = startBot(f.services, controller.signal);
  await loginEntered;
  controller.abort();
  await assert.rejects(() => startup, /cancelled/);
  assert.throws(() => f.services.store.get('test', 'closed'), /finalized|closed/);
});
test('Replacing personal consent during a pending personal chat prevents delivery of the old response', async (t) => {
  const f = fixture(t, { ENABLE_USER_INSTALL: 'true' });
  f.bind();
  const stamp = Date.now();
  f.services.store.set('notifications.default', USER, GUILD);
  f.services.store.set('notifications.consent', `${GUILD}:${USER}`, {
    enabled: true,
    dm: true,
    createdAt: stamp,
    version: 'old',
  });
  f.services.client.guilds.fetch = (async () => f.guild) as unknown as typeof f.services.client.guilds.fetch;
  f.services.ai.chat = async () => {
    f.services.store.set('notifications.consent', `${GUILD}:${USER}`, {
      enabled: true,
      dm: true,
      createdAt: stamp,
      version: 'new',
    });
    return { text: 'Old response must not appear', pending: [] };
  };
  const i = fakeInteraction(f.guild, 'slash', 'ask', { prompt: 'Hello' });
  i.data.inGuild = () => false;
  f.emit(i.interaction);
  const result = content(await i.finished);
  assert.match(result, /cancelled/);
  assert.ok(!result.includes('Old response'));
});
test('User-installed personal chat retains real membership and disables administrative tools', async (t) => {
  const f = fixture(t, { ENABLE_USER_INSTALL: 'true' });
  f.bind();
  f.services.store.set('notifications.default', USER, GUILD);
  f.services.store.set('notifications.consent', `${GUILD}:${USER}`, {
    enabled: true,
    dm: true,
    createdAt: Date.now(),
  });
  f.services.client.guilds.fetch = (async () => f.guild) as unknown as typeof f.services.client.guilds.fetch;
  let invoked = false;
  f.services.ai.chat = async (ctx, _prompt, _attachment, allow) => {
    invoked = true;
    assert.equal(ctx.guild.id, GUILD);
    assert.equal(ctx.member.id, USER);
    assert.equal(allow, false);
    return { text: 'Private reply', pending: [] };
  };
  const i = fakeInteraction(f.guild, 'slash', 'ask', { prompt: 'Hello' });
  i.data.inGuild = () => false;
  f.emit(i.interaction);
  assert.equal(content(await i.finished), 'Private reply');
  assert.equal(invoked, true);
  assert.deepEqual(i.events, ['defer', 'edit']);
  assert.equal((i.replies[0] as { flags: number }).flags, MessageFlags.Ephemeral);
});
test('Personal erasure confirmations bind user/channel and remove only that user’s AI records', async (t) => {
  const f = fixture(t, { ENABLE_USER_INSTALL: 'true' });
  f.bind();
  const resets: [string, string][] = [];
  f.services.voice.resetSpeakerConversation = (guildId, userId) => {
    resets.push([guildId, userId]);
  };
  f.services.client.guilds.cache.set(OTHER, { id: OTHER } as Guild);
  f.services.store.set('ai.preferences', `${GUILD}:${USER}`, 'mine');
  f.services.store.set('ai.preferences', `${GUILD}:${OTHER}`, 'other');
  const request = fakeInteraction(f.guild, 'slash', 'forget');
  request.data.inGuild = () => false;
  f.emit(request.interaction);
  const payload = (await request.finished) as {
    components: { toJSON(): { components: { custom_id: string }[] } }[];
  };
  const customId = payload.components[0]!.toJSON().components[0]!.custom_id;
  assert.deepEqual(resets, []);
  const wrong = fakeInteraction(f.guild, 'button', customId);
  wrong.data.inGuild = () => false;
  wrong.data.user.id = OTHER;
  f.emit(wrong.interaction);
  assert.match(content(await wrong.finished), /unavailable/);
  assert.deepEqual(resets, []);
  assert.equal(f.services.store.get('ai.preferences', `${GUILD}:${USER}`), 'mine');
  const approve = fakeInteraction(f.guild, 'button', customId);
  approve.data.inGuild = () => false;
  f.emit(approve.interaction);
  assert.match(content(await approve.finished), /Deleted 1/);
  assert.equal(f.services.store.get('ai.preferences', `${GUILD}:${USER}`), undefined);
  assert.equal(f.services.store.get('ai.preferences', `${GUILD}:${OTHER}`), 'other');
  assert.deepEqual(resets, [
    [GUILD, USER],
    [OTHER, USER],
  ]);
  const replay = fakeInteraction(f.guild, 'button', customId);
  replay.data.inGuild = () => false;
  f.emit(replay.interaction);
  assert.match(content(await replay.finished), /unavailable/);
  assert.equal(resets.length, 2);
});

test('Personal AI erasure remains usable with only its required store dependency', () => {
  const store = new Store(':memory:');
  try {
    store.set('ai.preferences', `${GUILD}:${USER}`, 'mine');
    store.set('ai.preferences', `${OTHER}:${USER}`, 'also mine');
    store.set('ai.preferences', `${GUILD}:${OTHER}`, 'someone else');
    assert.equal(forgetPersonalAi({ store }, USER), 2);
    assert.equal(store.get('ai.preferences', `${GUILD}:${USER}`), undefined);
    assert.equal(store.get('ai.preferences', `${OTHER}:${USER}`), undefined);
    assert.equal(store.get('ai.preferences', `${GUILD}:${OTHER}`), 'someone else');
  } finally {
    store.close();
  }
});
test('Select-menu interfaces pass the application router and acknowledge before resolving member access', async (t) => {
  const f = fixture(t);
  f.bind();
  const i = fakeInteraction(f.guild, 'button', 'ui:unknown:panel');
  i.data.isButton = () => false;
  i.data.isMessageComponent = () => true;
  Object.assign(i.data, { message: { id: 'panel' } });
  f.emit(i.interaction);
  assert.match(content(await i.finished), /Unknown interface/);
  assert.deepEqual(i.events, ['defer', 'edit']);
});
test('User-install command deployment separates global personal commands from guild administration', async (t) => {
  const f = fixture(t, { ENABLE_USER_INSTALL: 'true', DISCORD_GUILD_IDS: GUILD });
  Object.defineProperty(f.services.client, 'application', {
    value: { fetch: async () => ({ id: 'app' }) },
    configurable: true,
  });
  const bodies: Record<string, unknown>[][] = [];
  const remote = new Map<string, unknown>();
  f.services.client.rest.get = (async (route) =>
    remote.get(String(route)) ?? []) as typeof f.services.client.rest.get;
  f.services.client.rest.put = (async (route, options) => {
    const body = (options as { body: Record<string, unknown>[] }).body;
    bodies.push(body);
    remote.set(String(route), body);
    return body;
  }) as typeof f.services.client.rest.put;
  await deployCommands(f.services);
  await deployCommands(f.services);
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0]!.every((command) => !('contexts' in command) && !('integration_types' in command)));
  assert.deepEqual(
    bodies[1]!.map((command) => command.name),
    ['help', 'schema', 'ask', 'status', 'forget'],
  );
  assert.ok(bodies[1]!.every((command) => (command.integration_types as number[]).includes(1)));
  for (const command of bodies[1]!)
    assert(!bodies[0]!.some((guildCommand) => guildCommand.name === command.name));
});
test('Guild extraction finds scheduled-event and audit guilds even when trailing arguments are users', () => {
  assert.equal(eventGuildId([{ guild: { id: GUILD } }, { id: USER }]), GUILD);
  assert.equal(eventGuildId([{ id: 'entry' }, { members: {}, channels: {}, id: GUILD }]), GUILD);
  assert.equal(eventGuildId([{ id: USER }]), undefined);
});
test('Large confirmation files retain all exact reviewed input beyond the former 12,000-character boundary', () => {
  const input = { begin: 'start', text: 'x'.repeat(16000), end: 'REVIEW-THIS-END' };
  const payload = outcomePayload({
    status: 'confirmation',
    action: 'test.change',
    id: 'token',
    input,
    expiresAt: Date.now() + 60000,
  });
  const attachment = payload.files?.[0] as { attachment: Buffer };
  assert.ok(attachment.attachment.toString().includes('REVIEW-THIS-END'));
});

test('All slash and context-menu command definitions serialize with unique valid names and supported contexts', () => {
  const commands = commandDefinitions() as Record<string, unknown>[];
  assert.equal(new Set(commands.map((command) => command.name)).size, commands.length);
  assert.ok(commands.length < 100);
  for (const command of commands) {
    assert.deepEqual(command.contexts, [0]);
    assert.deepEqual(command.integration_types, [0]);
    assert.ok(String(command.name).length <= 32);
    const options = command.options as
      { name: string; required?: boolean; autocomplete?: boolean }[] | undefined;
    if (options) {
      assert.equal(new Set(options.map((option) => option.name)).size, options.length);
      const firstOptional = options.findIndex((option) => !option.required);
      if (firstOptional >= 0) assert.ok(options.slice(firstOptional).every((option) => !option.required));
    }
  }
});

test('Every documented slash alias targets an existing action with the correct input schema', async (t) => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['status', {}, 'system.status'],
    ['forget', {}, 'ai.memory.forget'],
    ['join', {}, 'voice.join'],
    ['consent', { replies: false }, 'voice.consent'],
    ['speak', { text: 'Hello' }, 'voice.speak'],
    ['remind', { minutes: 5, text: 'Remember' }, 'reminder.create'],
    ['balance', {}, 'economy.balance'],
    ['daily', {}, 'economy.daily'],
    ['ticket', { subject: 'Help' }, 'ticket.open'],
    ['report', { member: { id: OTHER }, reason: 'Review please' }, 'report.submit'],
  ];
  for (const [name, values, id] of cases)
    await t.test(name, async (sub) => {
      const f = fixture(sub);
      f.bind();
      const requests = spyRequests(f.services),
        i = fakeInteraction(f.guild, 'slash', name, values);
      f.emit(i.interaction);
      await i.finished;
      assert.equal(requests.length, 1, content(i.replies.at(-1)));
      assert.equal(requests[0]?.id, id);
      assert.deepEqual(i.events, ['defer', 'edit']);
      assert.equal((i.replies[0] as { flags: number }).flags, MessageFlags.Ephemeral);
    });
});

test('Initial acknowledgement precedes potentially slow authorization reads', async (t) => {
  const f = fixture(t);
  f.bind();
  let release!: () => void;
  const originalFetch = f.guild.members.fetch.bind(f.guild.members);
  let authorizationStarted = false;
  f.guild.members.fetch = (async (...args: unknown[]) => {
    authorizationStarted = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return originalFetch(...(args as Parameters<typeof originalFetch>));
  }) as typeof f.guild.members.fetch;
  spyRequests(f.services);
  const i = fakeInteraction(f.guild, 'slash', 'status');
  f.emit(i.interaction);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(authorizationStarted, true);
  assert.deepEqual(i.events, ['defer']);
  release();
  await i.finished;
});

test('Required action input opens a modal immediately without waiting on guild API calls', async (t) => {
  const f = fixture(t);
  f.bind();
  let authorizationReads = 0;
  f.guild.members.fetch = (async () => {
    authorizationReads++;
    throw new Error('Should not fetch');
  }) as typeof f.guild.members.fetch;
  const i = fakeInteraction(f.guild, 'slash', 'action', { name: 'member.info' });
  f.emit(i.interaction);
  const modal = (await i.finished) as { toJSON(): { custom_id: string } };
  assert.deepEqual(i.events, ['modal']);
  assert.equal(authorizationReads, 0);
  assert.equal(modal.toJSON().custom_id, 'action:member.info');
});

test('Modal action submissions validate exact arguments through the registry', async (t) => {
  const f = fixture(t);
  f.bind();
  const requests = spyRequests(f.services),
    i = fakeInteraction(f.guild, 'modal', 'action:member.info', {
      json: JSON.stringify({ memberId: OTHER }),
    });
  f.emit(i.interaction);
  await i.finished;
  assert.deepEqual(requests, [{ id: 'member.info', input: { memberId: OTHER } }]);
});

test('Malformed action JSON returns an actionable private error without invoking a side effect', async (t) => {
  const f = fixture(t);
  f.bind();
  const requests = spyRequests(f.services),
    i = fakeInteraction(f.guild, 'slash', 'action', { name: 'member.info', input: '{bad json' });
  f.emit(i.interaction);
  const result = await i.finished;
  assert.match(content(result), /valid JSON/);
  assert.equal(requests.length, 0);
  assert.equal(i.data.deferred, true);
});

test('Autocomplete is capped at Discord’s 25-choice limit and returns actual action IDs', async (t) => {
  const f = fixture(t);
  f.bind();
  const i = fakeInteraction(f.guild, 'autocomplete', 'action', { focused: '' });
  f.emit(i.interaction);
  const choices = (await i.finished) as { name: string; value: string }[];
  assert.ok(choices.length <= 25);
  assert.ok(choices.length > 0);
  for (const choice of choices) {
    assert.ok(choice.name.length <= 100);
    assert.ok(f.services.registry.get(choice.value));
  }
});

test('Member context menu uses member.info’s memberId schema', async (t) => {
  const f = fixture(t);
  f.bind();
  const requests = spyRequests(f.services),
    i = fakeInteraction(f.guild, 'user-context', 'Inspect member');
  f.emit(i.interaction);
  await i.finished;
  assert.deepEqual(requests, [{ id: 'member.info', input: { memberId: OTHER } }]);
});

test('Message context explanations disable AI action execution', async (t) => {
  const f = fixture(t);
  f.bind();
  let allowActions: boolean | undefined;
  f.services.ai.chat = async (_ctx, prompt, _attachment, allow) => {
    allowActions = allow;
    assert.match(prompt, /untrusted/);
    return { text: 'Explanation', pending: [] };
  };
  const i = fakeInteraction(f.guild, 'message-context', 'Explain message');
  f.emit(i.interaction);
  const result = await i.finished;
  assert.equal(allowActions, false);
  assert.equal(content(result), 'Explanation');
});

test('Public prefix action requests cannot return private form results or dashboard credentials', async (t) => {
  const f = fixture(t, { ENABLE_MESSAGE_CONTENT: 'true', COMMAND_PREFIX: '!' });
  f.bind();
  Object.defineProperty(f.services.client, 'user', { value: { id: BOT }, configurable: true });
  const requests = spyRequests(f.services);
  const result = await new Promise<unknown>((resolve) => {
    const message = {
      guild: f.guild,
      author: { id: USER, bot: false },
      channelId: CHANNEL,
      content: '!action form.export {"formId":"private"}',
      reply: async (payload: unknown) => {
        resolve(payload);
      },
    };
    f.services.client.emit(Events.MessageCreate, message as unknown as ClientEvents[Events.MessageCreate][0]);
  });
  assert.match(content(result), /Use \/action/);
  assert.deepEqual(requests, []);
});

test('Public mention AI permits scoped server actions with isolated short-lived history and no private preferences', async (t) => {
  const f = fixture(t);
  f.bind();
  Object.defineProperty(f.services.client, 'user', { value: { id: BOT }, configurable: true });
  let calls = 0;
  f.services.ai.chat = async (_ctx, prompt, attachment, allow, options) => {
    calls++;
    assert.equal(prompt, 'Show my saved private information');
    assert.equal(attachment, undefined);
    assert.equal(allow, true);
    assert.equal(options?.memoryScope, 'public-mention');
    assert.equal(options?.usePreferences, false);
    assert.equal(options?.retainHistory, true);
    assert.equal(options?.historyTtlSeconds, 600);
    assert.equal(options?.responsePrivacy, 'public');
    return { text: 'Public response', pending: [] };
  };
  const result = await new Promise<unknown>((resolve) => {
    const message = {
      guild: f.guild,
      author: { id: USER, bot: false },
      channelId: CHANNEL,
      content: `<@${BOT}> Show my saved private information`,
      reply: async (payload: unknown) => {
        resolve(payload);
      },
    };
    f.services.client.emit(Events.MessageCreate, message as unknown as ClientEvents[Events.MessageCreate][0]);
  });
  assert.equal(calls, 1);
  assert.equal(content(result), 'Public response');
});

test('An explicit ordinary /action write executes once in smart mode without an extra preview', async (t) => {
  const f = fixture(t, { CONFIRMATION_MODE: 'smart' });
  f.bind();
  let executions = 0;
  f.services.registry.register({
    id: 'test.write',
    category: 'test',
    description: 'Record a requested setting',
    risk: 'write',
    schema: z.strictObject({ value: z.string() }),
    userPermissions: [],
    botPermissions: [],
    execute: (ctx, input) => {
      assert.equal(isCurrentUserRequest(ctx), true);
      executions++;
      return `Saved ${input.value}`;
    },
  });
  const request = fakeInteraction(f.guild, 'slash', 'action', {
    name: 'test.write',
    input: JSON.stringify({ value: 'chosen' }),
  });
  f.emit(request.interaction);
  const result = await request.finished;
  assert.match(content(result), /Saved chosen/);
  assert.doesNotMatch(content(result), /Awaiting confirmation/);
  assert.equal(executions, 1);
  assert.equal(f.services.store.db.prepare('SELECT count(*) AS count FROM confirmations').get()?.count, 0);
});

test('A confirmed guild /forget resets that speaker’s live voice conversation exactly once', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t, { CONFIRMATION_MODE: 'always' });
  f.bind();
  const resets: [string, string][] = [];
  f.services.voice.resetSpeakerConversation = (guildId, userId) => {
    resets.push([guildId, userId]);
  };
  f.services.store.set('ai.preferences', `${GUILD}:${USER}`, 'mine');
  f.services.store.set('ai.preferences', `${GUILD}:${OTHER}`, 'another user');
  const request = fakeInteraction(f.guild, 'slash', 'forget');
  f.emit(request.interaction);
  assert.match(content(await request.finished), /Awaiting confirmation: ai.memory.forget/);
  assert.deepEqual(resets, []);
  assert.equal(f.services.store.get('ai.preferences', `${GUILD}:${USER}`), 'mine');
  now += 751;
  const confirm = fakeInteraction(f.guild, 'slash', 'confirm');
  f.emit(confirm.interaction);
  assert.match(content(await confirm.finished), /forgotten/);
  assert.equal(f.services.store.get('ai.preferences', `${GUILD}:${USER}`), undefined);
  assert.equal(f.services.store.get('ai.preferences', `${GUILD}:${OTHER}`), 'another user');
  assert.deepEqual(resets, [[GUILD, USER]]);
  now += 751;
  const replay = fakeInteraction(f.guild, 'slash', 'confirm');
  f.emit(replay.interaction);
  assert.match(content(await replay.finished), /no pending|unavailable/i);
  assert.deepEqual(resets, [[GUILD, USER]]);
});

test('A destructive /action needs one real preview and /confirm without an ID completes it exactly once', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t, { CONFIRMATION_MODE: 'smart' });
  f.bind();
  let executions = 0;
  f.services.registry.register({
    id: 'test.delete',
    category: 'test',
    description: 'Delete the chosen test resource',
    risk: 'destructive',
    schema: z.strictObject({ value: z.string() }),
    userPermissions: [],
    botPermissions: [],
    execute: (_ctx, input) => {
      executions++;
      return `Deleted ${input.value}`;
    },
  });
  const request = fakeInteraction(f.guild, 'slash', 'action', {
    name: 'test.delete',
    input: JSON.stringify({ value: 'chosen' }),
  });
  f.emit(request.interaction);
  assert.match(content(await request.finished), /Awaiting confirmation/);
  assert.equal(executions, 0);
  assert.equal(f.services.store.db.prepare('SELECT count(*) AS count FROM confirmations').get()?.count, 1);
  now += 751;
  const confirm = fakeInteraction(f.guild, 'slash', 'confirm');
  f.emit(confirm.interaction);
  assert.match(content(await confirm.finished), /Deleted chosen/);
  assert.equal(executions, 1);
  assert.equal(f.services.store.db.prepare('SELECT count(*) AS count FROM confirmations').get()?.count, 0);
  now += 751;
  const replay = fakeInteraction(f.guild, 'slash', 'confirm');
  f.emit(replay.interaction);
  assert.match(content(await replay.finished), /no pending|unavailable/i);
  assert.equal(executions, 1);
});

test('A public server-tool preview accepts immediate plain confirm without waiting or another AI call', async (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture(t, { CONFIRMATION_MODE: 'smart', ENABLE_MESSAGE_CONTENT: 'true' });
  f.bind();
  Object.defineProperty(f.services.client, 'user', { value: { id: BOT }, configurable: true });
  let executions = 0,
    aiCalls = 0;
  f.services.registry.get('channel.delete').execute = () => {
    executions++;
    return 'Deleted requested channel';
  };
  f.services.ai.chat = async (ctx, prompt, _attachment, allow, options) => {
    aiCalls++;
    assert.equal(allow, true);
    assert.equal(options?.responsePrivacy, 'public');
    assert.equal(isCurrentUserRequest(ctx), true);
    assert.equal(prompt, 'Delete this channel');
    const outcome = await f.services.registry.request(ctx, 'channel.delete', { channelId: CHANNEL });
    assert.equal(outcome.status, 'confirmation');
    return {
      text: 'Please confirm deleting this channel.',
      pending: outcome.status === 'confirmation' ? [outcome] : [],
    };
  };
  const request = fakeMessage(f.guild, `<@${BOT}> Delete this channel`);
  f.services.client.emit(Events.MessageCreate, request.message);
  assert.match(content(await request.finished), /Awaiting confirmation: channel.delete/);
  assert.equal(executions, 0);
  const confirm = fakeMessage(f.guild, 'confirm');
  f.services.client.emit(Events.MessageCreate, confirm.message);
  assert.match(content(await confirm.finished), /Deleted requested channel/);
  assert.equal(executions, 1);
  assert.equal(aiCalls, 1);
  assert.equal(f.services.store.db.prepare('SELECT count(*) AS count FROM confirmations').get()?.count, 0);
});

test('A public confirm cannot execute or disclose a private slash-action confirmation', async (t) => {
  const f = fixture(t, { CONFIRMATION_MODE: 'smart' });
  f.bind();
  Object.defineProperty(f.services.client, 'user', { value: { id: BOT }, configurable: true });
  let executions = 0;
  f.services.registry.register({
    id: 'test.private-delete',
    category: 'test',
    description: 'Erase a private test record',
    risk: 'destructive',
    schema: z.strictObject({}),
    userPermissions: [],
    botPermissions: [],
    execute: () => {
      executions++;
      return 'SECRET_PRIVATE_RESULT';
    },
  });
  const request = fakeInteraction(f.guild, 'slash', 'action', { name: 'test.private-delete', input: '{}' });
  f.emit(request.interaction);
  assert.match(content(await request.finished), /Awaiting confirmation/);
  f.services.ai.chat = async () => {
    throw new Error('A real confirmation must not be delegated to AI');
  };
  const confirm = fakeMessage(f.guild, `<@${BOT}> confirm`);
  f.services.client.emit(Events.MessageCreate, confirm.message);
  const result = content(await confirm.finished);
  assert.match(result, /private action|private interaction/i);
  assert.doesNotMatch(result, /SECRET_PRIVATE_RESULT/);
  assert.equal(executions, 0);
  assert.equal(f.services.store.db.prepare('SELECT count(*) AS count FROM confirmations').get()?.count, 1);
});

test('An explicit reply to Vibe is addressed even when the reply mention is disabled', async (t) => {
  const f = fixture(t, { ENABLE_MESSAGE_CONTENT: 'true' });
  f.bind();
  Object.defineProperty(f.services.client, 'user', { value: { id: BOT }, configurable: true });
  let calls = 0;
  f.services.ai.chat = async (_ctx, prompt) => {
    calls++;
    assert.equal(prompt, 'Please explain that again');
    return { text: 'Here is the explanation.', pending: [] };
  };
  const reply = fakeMessage(f.guild, 'Please explain that again', { replyTo: BOT, pingReply: false });
  f.services.client.emit(Events.MessageCreate, reply.message);
  assert.equal(content(await reply.finished), 'Here is the explanation.');
  assert.equal(calls, 1);
});

test('A reply to another member remains passive and does not call Vibe', async (t) => {
  const f = fixture(t, { ENABLE_MESSAGE_CONTENT: 'true' });
  f.bind();
  Object.defineProperty(f.services.client, 'user', { value: { id: BOT }, configurable: true });
  let calls = 0;
  f.services.ai.chat = async () => {
    calls++;
    return { text: 'must not reply', pending: [] };
  };
  const reply = fakeMessage(f.guild, 'Please explain that again', { replyTo: OTHER });
  f.services.client.emit(Events.MessageCreate, reply.message);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 0);
  assert.deepEqual(reply.replies, []);
});

test('Voice stop, leave, and consent revocation act immediately without registry confirmation', async (t) => {
  for (const command of ['stop', 'leave', 'revoke'])
    await t.test(command, async (sub) => {
      const f = fixture(sub);
      f.bind();
      const requests = spyRequests(f.services);
      let called = false;
      if (command === 'stop')
        f.services.voice.stop = () => {
          called = true;
          return 'Stopped';
        };
      if (command === 'leave')
        f.services.voice.leave = () => {
          called = true;
          return 'Disconnected';
        };
      if (command === 'revoke')
        f.services.voice.consent = (_ctx, enabled) => {
          assert.equal(enabled, false);
          called = true;
          return 'Revoked';
        };
      const i = fakeInteraction(f.guild, 'slash', command);
      f.emit(i.interaction);
      await i.finished;
      assert.equal(called, true);
      assert.equal(requests.length, 0);
    });
});

test('Rapid slash requests are privately throttled after their initial acknowledgement', async (t) => {
  const f = fixture(t);
  f.bind();
  const requests = spyRequests(f.services);
  const first = fakeInteraction(f.guild, 'slash', 'status');
  f.emit(first.interaction);
  await first.finished;
  const second = fakeInteraction(f.guild, 'slash', 'status');
  f.emit(second.interaction);
  const result = await second.finished;
  assert.match(content(result), /wait a moment/);
  assert.deepEqual(second.events, ['defer', 'edit']);
  assert.equal(requests.length, 1);
});

test('Configured guild restriction rejects programmatic contexts and ignores unrelated interactions', async (t) => {
  const f = fixture(t, { DISCORD_GUILD_IDS: OTHER });
  f.bind();
  await assert.rejects(
    () => commandContext(f.services, f.guild, f.user as Parameters<typeof commandContext>[2], CHANNEL),
    /outside/,
  );
  const i = fakeInteraction(f.guild, 'slash', 'status');
  f.emit(i.interaction);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(i.events, []);
});

test('Help pagination remains valid with Unicode search values near the custom-ID length limit', (t) => {
  const { services } = fixture(t);
  const query = 'a'.repeat(59) + 'é';
  // Matching custom actions force multiple pages for this exact query.
  for (let index = 0; index < 14; index++)
    services.registry.register({
      id: `test.help.${index}`,
      category: 'test',
      description: query,
      risk: 'read',
      schema: z.strictObject({}),
      userPermissions: [],
      botPermissions: [],
      execute: () => 'ok',
    });
  const payload = helpPayload(services, query),
    rows = payload.components as unknown as { toJSON(): { components: { custom_id?: string }[] } }[];
  for (const row of rows)
    for (const component of row.toJSON().components) {
      const id = component.custom_id!;
      assert.ok(id.length <= 100);
      assert.doesNotThrow(() => decodeURIComponent(id.split(':')[2] ?? ''));
    }
});

test('Large outputs attach complete text, neutralize mentions, and produce valid confirmation component IDs', () => {
  const body = '@everyone ' + 'x'.repeat(12_000),
    payload = textPayload(body);
  assert.ok((payload.content?.length ?? 0) < 2000);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal((payload.files?.[0] as { attachment: Buffer }).attachment.toString(), body);
  const pending = {
    status: 'confirmation' as const,
    action: 'test.change',
    id: 'valid_token',
    input: { value: '``` @everyone' },
    expiresAt: Date.now() + 1000,
  };
  assert.ok(preview(pending).includes('[code fence]'));
  const rows = confirmationRows([pending]);
  assert.equal(rows[0]?.toJSON().components.length, 2);
  const complete = outcomePayload({
    status: 'completed',
    action: 'test.file',
    result: { attachment: Buffer.from('data'), name: 'report.csv' },
  });
  assert.equal((complete.files?.[0] as { name: string }).name, 'report.csv');
});
test('In always-confirm mode media search selections create reviewed send requests', async (t) => {
  const f = fixture(t, { CONFIRMATION_MODE: 'always' });
  f.bind();
  const searchId = 'abcdefghijklmnop';
  const payload = outcomePayload({
    status: 'completed',
    action: 'image.search',
    result: {
      searchId,
      results: [
        {
          index: 1,
          title: 'Reviewed image',
          source: 'https://commons.wikimedia.org/wiki/File:Example.png',
          license: 'CC0',
        },
      ],
    },
  });
  const row = payload.components?.[0] as { toJSON(): { components: { custom_id: string }[] } };
  assert.equal(row.toJSON().components[0]!.custom_id, `media:pick:${searchId}:1`);
  f.services.store.set('media.search', searchId, {
    userId: USER,
    guildId: GUILD,
    channelId: CHANNEL,
    expiresAt: Date.now() + 60000,
    results: [{ title: 'Reviewed image', state: 'available' }],
  });
  const i = fakeInteraction(f.guild, 'button', `media:pick:${searchId}:1`);
  f.emit(i.interaction);
  assert.match(content(await i.finished), /Awaiting confirmation/);
  const pending = f.services.store.db.prepare('SELECT action,input FROM confirmations').get();
  assert.equal(pending?.action, 'media.search-send');
  assert.deepEqual(JSON.parse(String(pending?.input)), { searchId, index: 1, title: 'Reviewed image' });
});

test('Command deployment is idempotent for the exact application and selected guild', async (t) => {
  const { services } = fixture(t, { DISCORD_GUILD_IDS: GUILD });
  let puts = 0;
  Object.defineProperty(services.client, 'application', {
    value: { fetch: async () => ({ id: 'app' }) },
    configurable: true,
  });
  const remote = new Map<string, unknown>();
  services.client.rest.get = (async (route) =>
    remote.get(String(route)) ?? []) as typeof services.client.rest.get;
  services.client.rest.put = (async (route, options) => {
    puts++;
    const body = (options as { body: unknown }).body;
    remote.set(String(route), body);
    return body;
  }) as typeof services.client.rest.put;
  await deployCommands(services);
  await deployCommands(services);
  assert.equal(puts, 1);
  assert.ok(services.store.get('core.commands', `app:${GUILD}`));
  assert.ok(services.store.get('core.commands', 'app:global'));
  remote.set(Routes.applicationCommands('app'), [{ name: 'voice', type: 1, description: 'old command' }]);
  await deployCommands(services);
  assert.equal(puts, 2);
  assert.deepEqual(remote.get(Routes.applicationCommands('app')), []);
});

test('A cached legacy ask question option is accepted while Discord command caches refresh', async (t) => {
  const f = fixture(t);
  f.bind();
  let received: unknown;
  f.services.ai.chat = async (_ctx, prompt, attachment) => {
    received = { prompt, attachment };
    return { text: 'Vibe answered the legacy cached command.', pending: [] };
  };
  const interaction = fakeInteraction(f.guild, 'slash', 'ask', {
    question: 'A cached question',
    image: { url: 'https://cdn.discordapp.com/fixture.png', name: 'fixture.png', contentType: 'image/png' },
  });
  f.emit(interaction.interaction);
  assert.equal(content(await interaction.finished), 'Vibe answered the legacy cached command.');
  assert.deepEqual(received, {
    prompt: 'A cached question',
    attachment: {
      url: 'https://cdn.discordapp.com/fixture.png',
      name: 'fixture.png',
      contentType: 'image/png',
    },
  });
});

test('A malformed cached ask command returns a useful upgrade instruction without calling AI', async (t) => {
  const f = fixture(t);
  f.bind();
  let called = false;
  f.services.ai.chat = async () => {
    called = true;
    return { text: 'must not be called', pending: [] };
  };
  const interaction = fakeInteraction(f.guild, 'slash', 'ask');
  f.emit(interaction.interaction);
  const result = content(await interaction.finished);
  assert.match(result, /outdated.*Reopen.*\/ask prompt:/);
  assert(!result.includes('Required option'));
  assert.equal(called, false);
});
