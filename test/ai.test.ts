import assert from 'node:assert/strict';
import { test } from 'node:test';
import OpenAI from 'openai';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import { userRequestContext, type ActionContext } from '../src/core/types.js';
import { AiService, cosine, registerAiActions, forgetAiData } from '../src/features/ai.js';
import { aiPayload } from '../src/discord/presentation.js';
import { PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { conversationContext, findConversationActions } from '../src/features/ai-conversation.js';
import { registerMessageActions } from '../src/discord/actions/messages.js';

const guildId = '11111111111111111',
  userId = '22222222222222222',
  channelId = '33333333333333333';
function context(
  store: Store,
  change: { guild?: string; user?: string; channel?: string } = {},
): ActionContext {
  return {
    store,
    guild: { id: change.guild ?? guildId, ownerId: '99999999999999999' },
    member: { id: change.user ?? userId, roles: { cache: new Map() } },
    channelId: change.channel ?? channelId,
  } as unknown as ActionContext;
}
function message(text: string, annotations: unknown[] = []) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations }],
  };
}
function response(output: unknown[]) {
  return { id: 'resp_test', object: 'response', created_at: 1, model: 'test', status: 'completed', output };
}
function functionCall(name: string, args: unknown, id = 'call_test') {
  return {
    type: 'function_call',
    id: 'fc_test',
    call_id: id,
    name,
    arguments: JSON.stringify(args),
    status: 'completed',
  };
}
function client(handler: (body: Record<string, unknown>, path: string) => unknown): OpenAI {
  return new OpenAI({
    apiKey: 'test-only-not-a-real-key',
    maxRetries: 0,
    fetch: async (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify(await handler(body, String(input))), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}
function fixture(
  handler: (body: Record<string, unknown>, path: string) => unknown,
  env: NodeJS.ProcessEnv = {},
) {
  const store = new Store(':memory:');
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  const ai = new AiService(loadConfig(env), store, registry, client(handler));
  return { store, registry, ai, ctx: context(store) };
}

test('A message-cleanup request cannot be turned into channel deletion by an AI tool selection', async () => {
  let round = 0,
    executions = 0;
  const f = fixture(() =>
    ++round === 1
      ? response([functionCall('run_action', { action: 'channel.delete', json: '{}' })])
      : response([message('Use the message-cleanup action instead.')]),
  );
  f.registry.register({
    id: 'channel.delete',
    category: 'channels',
    description: 'Delete channel',
    schema: z.strictObject({}),
    risk: 'destructive',
    userPermissions: [],
    botPermissions: [],
    execute: () => {
      executions++;
      return 'deleted';
    },
  });
  try {
    const reply = await f.ai.chat(f.ctx, 'Review the chat and remove explicit messages', undefined, true, {
      responsePrivacy: 'public',
    });
    assert.equal(executions, 0);
    assert.equal(reply.pending.length, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM confirmations').get()?.n, 0);
  } finally {
    f.store.close();
  }
});

test('Shared chat can invoke typed history cleanup with sensible defaults and no extra approval', async () => {
  const store = new Store(':memory:'),
    registry = new ActionRegistry(120, async (ctx) => ctx, { confirmationMode: 'smart' });
  let round = 0,
    executions = 0;
  const ai = new AiService(
    loadConfig({}),
    store,
    registry,
    client(() =>
      ++round === 1
        ? response([functionCall('run_action', { action: 'moderation.history.clean', json: '{}' })])
        : response([message('Removed three matching messages.')]),
    ),
  );
  registry.register({
    id: 'moderation.history.clean',
    description: 'Review chat and delete explicit hateful spam messages',
    category: 'moderation',
    schema: z.strictObject({ limit: z.number().int().default(100) }),
    risk: 'write',
    userPermissions: [],
    botPermissions: [],
    execute: (_ctx, input) => {
      executions++;
      assert.equal(input.limit, 100);
      return { scanned: 8, deleted: 3 };
    },
  });
  try {
    const ctx = userRequestContext(context(store), 'chat');
    const authoritative = JSON.parse(
      conversationContext(
        ctx,
        registry,
        'Review chat and remove explicit messages',
        { responsePrivacy: 'public' },
        true,
      ),
    );
    assert.equal(authoritative.knownActionSchemas[0].action, 'moderation.history.clean');
    const reply = await ai.chat(ctx, 'Review chat and remove explicit messages', undefined, true, {
      responsePrivacy: 'public',
    });
    assert.equal(executions, 1);
    assert.equal(reply.pending.length, 0);
    assert.deepEqual(reply.completedActions, ['moderation.history.clean']);
  } finally {
    store.close();
  }
});

test('Low-latency GPT-5 chat requests use minimal reasoning and voice output stays concise without altering unrelated model contracts', async () => {
  const bodies: Record<string, unknown>[] = [];
  const f = fixture((body) => {
    bodies.push(body);
    return response([message('Ready')]);
  });
  try {
    await f.ai.chat(f.ctx, 'Hello', undefined, true, { responseStyle: 'voice' });
    assert.deepEqual(bodies[0]?.reasoning, { effort: 'minimal' });
    assert.deepEqual(bodies[0]?.text, { verbosity: 'low' });
    assert.equal(bodies[0]?.max_output_tokens, 700);
    f.ai.configureModelRoutes({ general: 'some-other-model' });
    await f.ai.chat(f.ctx, 'Hello');
    assert.equal(bodies[1]?.reasoning, undefined);
    assert.equal(bodies[1]?.text, undefined);
  } finally {
    f.store.close();
  }
});
test('Web-enabled GPT-5 requests use low effort because hosted web search does not support minimal reasoning', async () => {
  let sent: Record<string, unknown> | undefined;
  const f = fixture(
    (body) => {
      sent = body;
      return response([message('Verified link')]);
    },
    { ENABLE_WEB_SEARCH: 'true' },
  );
  try {
    await f.ai.chat(f.ctx, 'Find the direct song link');
    assert.deepEqual(sent?.reasoning, { effort: 'low' });
    assert((sent?.tools as { type: string }[]).some((tool) => tool.type === 'web_search'));
  } finally {
    f.store.close();
  }
});

test('Local event scheduling requires a real datetime receipt and copies tomorrow at 9pm without model UTC arithmetic', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-30T02:00:00Z'));
  let round = 0;
  const requests: Record<string, unknown>[] = [];
  const f = fixture((body) => {
    requests.push(body);
    if (++round === 1)
      return response([
        functionCall(
          'run_action',
          {
            action: 'event.create',
            json: JSON.stringify({
              name: 'Roblox',
              startTime: '2026-10-30T01:00:00Z',
              endTime: '2026-10-30T03:00:00Z',
            }),
          },
          'guessed',
        ),
      ]);
    if (round === 2)
      return response([
        functionCall(
          'resolve_datetime',
          {
            day: 'tomorrow',
            time: '21:00',
            timeZone: null,
            durationMinutes: 120,
          },
          'resolved',
        ),
      ]);
    if (round === 3)
      return response([
        functionCall(
          'run_action',
          {
            action: 'event.create',
            json: JSON.stringify({
              name: 'Roblox',
              startTime: '2026-10-31T01:00:00.000Z',
              endTime: '2026-10-31T03:00:00.000Z',
            }),
          },
          'actual',
        ),
      ]);
    return response([message('Please confirm Roblox tomorrow at 9pm for two hours.')]);
  });
  f.registry.register({
    id: 'event.create',
    category: 'events',
    risk: 'write',
    description: 'Create event',
    schema: z.strictObject({ name: z.string(), startTime: z.iso.datetime(), endTime: z.iso.datetime() }),
    userPermissions: [],
    botPermissions: [],
    execute: () => {
      throw new Error('An unconfirmed event must not execute');
    },
  });
  try {
    const result = await f.ai.chat(
      f.ctx,
      'Make an event for Roblox tomorrow at 9pm for 2 hours, vc, publix, everyone',
      undefined,
      true,
      {
        timeZone: 'America/New_York',
        responsePrivacy: 'public',
      },
    );
    assert.equal(result.pending.length, 1);
    assert.deepEqual(result.pending[0]?.input, {
      name: 'Roblox',
      startTime: '2026-10-31T01:00:00.000Z',
      endTime: '2026-10-31T03:00:00.000Z',
    });
    assert.equal(f.registry.pending(f.ctx).length, 1);
    assert(JSON.stringify(requests[1]?.input).includes('Call resolve_datetime'));
    assert(JSON.stringify(requests[2]?.input).includes('2026-10-31T01:00:00.000Z'));
    assert(String(requests[0]?.instructions).includes('NEVER do UTC offset/date arithmetic'));
    assert(String(requests[0]?.instructions).includes('"tomorrow":"2026-10-30"'));
  } finally {
    f.store.close();
  }
});

test('Shared conversation leases retain only the same public user/channel scope and expire without private memory crossover', async () => {
  const requests: Record<string, unknown>[] = [];
  const f = fixture((body) => {
    requests.push(body);
    return response([message('Which voice channel?')]);
  });
  const settings = {
    memoryScope: 'public-mention',
    usePreferences: false,
    retainHistory: true,
    historyTtlSeconds: 600,
    responsePrivacy: 'public',
  } as const;
  try {
    f.store.set('ai.preferences', `${guildId}:${userId}`, 'private preference');
    await f.ai.chat(f.ctx, 'private saved chat');
    await f.ai.chat(f.ctx, 'Schedule Roblox tonight at9pm', undefined, true, settings);
    await f.ai.chat(f.ctx, 'Use the gaming VC, public please', undefined, true, settings);
    const request = JSON.stringify(requests[2]);
    assert(request.includes('Schedule Roblox'));
    assert(!request.includes('private saved chat'));
    assert(!request.includes('private preference'));
    await f.ai.chat(
      context(f.store, { user: '44444444444444444' }),
      'Other person',
      undefined,
      true,
      settings,
    );
    assert(!JSON.stringify(requests[3]).includes('Schedule Roblox'));
    const key = `${guildId}:${channelId}:public-mention:${userId}`,
      saved = f.store.get<{ turns: unknown[]; expiresAt: number }>('ai.conversations', key)!;
    assert(saved.expiresAt > Date.now());
    f.store.set('ai.conversations', key, { ...saved, expiresAt: Date.now() - 1 });
    await f.ai.chat(f.ctx, 'A new topic', undefined, true, settings);
    assert(!JSON.stringify(requests[4]?.input).includes('Schedule Roblox'));
  } finally {
    f.store.close();
  }
});

test('Action context supplies real visible channel IDs, local scheduling time and existing pending IDs while excluding hidden channels', async () => {
  const f = fixture(() => response([message('Ready')]));
  try {
    const everyone = { id: guildId },
      bot = { id: '77777777777777777' },
      member = { id: userId, voice: { channelId: '44444444444444444' } },
      publicChannel = {
        id: '44444444444444444',
        guildId,
        name: 'Gaming VC',
        type: 2,
        permissionsFor: () => new PermissionsBitField(P.ViewChannel),
      },
      privateChannel = {
        ...publicChannel,
        id: '55555555555555555',
        name: 'Private transcript archive',
        permissionsFor: (actor: unknown) => new PermissionsBitField(actor === everyone ? 0n : P.ViewChannel),
      };
    const ctx = {
      ...f.ctx,
      member,
      guild: {
        id: guildId,
        members: { me: bot },
        roles: { everyone },
        channels: {
          cache: new Map([
            [publicChannel.id, publicChannel],
            [privateChannel.id, privateChannel],
          ]),
        },
      },
    } as unknown as ActionContext;
    f.registry.register({
      id: 'event.create',
      category: 'events',
      risk: 'write',
      schema: z.strictObject({ name: z.string(), channelId: z.string(), startTime: z.string() }),
      description: 'Create event',
      userPermissions: [],
      botPermissions: [],
      execute: () => ({ ok: true }),
    });
    f.store.db
      .prepare('INSERT INTO confirmations VALUES(?,?,?,?,?,?,?)')
      .run('pending-real', guildId, userId, channelId, 'event.create', '{}', Date.now() + 60000);
    const value = JSON.parse(
      conversationContext(
        ctx,
        f.registry,
        'Create a Roblox event at9pm',
        { responsePrivacy: 'public', timeZone: 'America/New_York' },
        true,
        Date.parse('2026-10-29T17:00:00Z'),
      ),
    );
    assert.equal(value.timeZone, 'America/New_York');
    assert.match(value.localTime, /13:00:00/);
    assert.equal(value.memberVoiceChannelId, publicChannel.id);
    assert.equal(value.visibleChannels.length, 1);
    assert.equal(value.knownActionSchemas[0].action, 'event.create');
    assert.equal(value.realPendingConfirmations[0].id, 'pending-real');
    assert(!JSON.stringify(value).includes(privateChannel.name));
  } finally {
    f.store.close();
  }
});

test('Action discovery resolves natural server rename vocabulary and returns schemas in one result', () => {
  const f = fixture(() => response([message('Ready')]));
  try {
    f.registry.register({
      id: 'guild.edit',
      category: 'server',
      risk: 'write',
      schema: z.strictObject({ name: z.string() }),
      description: 'Update current server name',
      userPermissions: [],
      botPermissions: [],
      execute: () => ({ ok: true }),
    });
    const result = findConversationActions(f.registry, 'rename the server', 'public');
    assert.equal(result[0]?.action, 'guild.edit');
    assert.equal(result[0]?.schema.type, 'object');
  } finally {
    f.store.close();
  }
});

test('Public tool requests cannot mint or reveal a private OAuth account link', async () => {
  let round = 0,
    executed = 0;
  const requests: Record<string, unknown>[] = [];
  const f = fixture((body) => {
    requests.push(body);
    return response(
      ++round === 1
        ? [functionCall('run_action', { action: 'oauth.start', json: '{}' })]
        : [message('Use private /ask for account linking.')],
    );
  });
  f.registry.register({
    id: 'oauth.start',
    category: 'oauth',
    risk: 'write',
    schema: z.strictObject({}),
    description: 'Create private account link',
    userPermissions: [],
    botPermissions: [],
    execute: () => {
      executed++;
      return { url: 'https://private.example/one-use-secret' };
    },
  });
  try {
    await f.ai.chat(f.ctx, 'Link my account', undefined, true, { responsePrivacy: 'public' });
    assert.equal(executed, 0);
    assert(JSON.stringify(requests[1]?.input).includes('returns private'));
    assert(!JSON.stringify(requests).includes('one-use-secret'));
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM confirmations').get()?.n, 0);
  } finally {
    f.store.close();
  }
});
test('Public announcement requests find the real message action and a failed mention permission never becomes a false sent receipt', async () => {
  let round = 0,
    sends = 0;
  const f = fixture(() =>
    response(
      ++round === 1
        ? [
            functionCall('run_action', {
              action: 'message.send',
              json: JSON.stringify({ channelId, content: 'Game night', mentionEveryone: true }),
            }),
          ]
        : [message('Done — I sent the announcement.')],
    ),
  );
  registerMessageActions(f.registry);
  const permissions = new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory, P.SendMessages]),
    member = { ...f.ctx.member, guild: { id: guildId } },
    bot = { id: '77777777777777777', guild: { id: guildId }, roles: { cache: new Map() } };
  const channel = {
    id: channelId,
    guildId,
    type: 0,
    isTextBased: () => true,
    isSendable: () => true,
    isThread: () => false,
    permissionsFor: () => permissions,
    send: async () => {
      sends++;
      throw new Error('send must not be reached');
    },
  };
  f.ctx = {
    ...f.ctx,
    member,
    guild: {
      id: guildId,
      members: { me: bot, fetch: async () => member, fetchMe: async () => bot },
      channels: { fetch: async () => channel },
    },
  } as unknown as ActionContext;
  f.registry.request = async (ctx, id, raw) => {
    const action = f.registry.get(id);
    return { status: 'completed', action: id, result: await action.execute(ctx, action.schema.parse(raw)) };
  };
  try {
    const discovered = findConversationActions(f.registry, 'ping everyone', 'public');
    assert.equal(discovered[0]?.action, 'message.send');
    const reply = await f.ai.chat(f.ctx, 'Ping everyone about game night', undefined, true, {
      responsePrivacy: 'public',
    });
    assert.equal(sends, 0);
    assert.equal(reply.completedActions, undefined);
    assert.match(reply.text, /message.send was not completed/);
    assert.match(reply.text, /required permissions/);
    assert(!reply.text.includes('I sent the announcement'));
  } finally {
    f.store.close();
  }
});

test('Completed mutation receipts survive a later model transport failure so the user is not told to retry an already completed operation', async () => {
  let round = 0;
  const f = fixture(() => {
    if (++round === 1) return response([functionCall('run_action', { action: 'event.create', json: '{}' })]);
    throw new Error('Simulated provider connection failure');
  });
  f.registry.register({
    id: 'event.create',
    category: 'events',
    risk: 'write',
    schema: z.strictObject({}),
    description: 'Create event',
    userPermissions: [],
    botPermissions: [],
    execute: () => ({ ok: true }),
  });
  let dispatches = 0;
  f.registry.request = async () => {
    dispatches++;
    return { status: 'completed', action: 'event.create', result: { name: 'Roblox Night' } };
  };
  try {
    const reply = await f.ai.chat(f.ctx, 'Create the event');
    assert.equal(dispatches, 1);
    assert.match(reply.text, /event Roblox Night was created/);
    assert.deepEqual(reply.completedActions, ['event.create']);
    assert.equal(reply.pending.length, 0);
  } finally {
    f.store.close();
  }
});

test('A completed mutation remains acknowledged when its voice lease changes before the next model round', async () => {
  let valid = true,
    rounds = 0,
    dispatches = 0;
  const f = fixture(() => {
    rounds++;
    return response([functionCall('run_action', { action: 'guild.edit', json: '{}' })]);
  });
  f.registry.register({
    id: 'guild.edit',
    category: 'server',
    risk: 'write',
    schema: z.strictObject({}),
    description: 'Rename server',
    userPermissions: [],
    botPermissions: [],
    execute: () => 'done',
  });
  f.registry.request = async () => {
    dispatches++;
    valid = false;
    return { status: 'completed', action: 'guild.edit', result: { name: 'Aura' } };
  };
  const ctx = userRequestContext(f.ctx, 'voice', { valid: () => valid });
  try {
    await assert.rejects(f.ai.chat(ctx, 'Make the server name Aura.'), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Completed guild.edit/);
      assert.match(error.message, /not repeated/);
      assert.doesNotMatch(error.message, /Submit the request again/);
      return true;
    });
    assert.equal(dispatches, 1);
    assert.equal(rounds, 1);
    assert.equal(f.store.list('ai.conversations').length, 0);
  } finally {
    f.store.close();
  }
});

test('An already cancelled voice request starts no provider generation', async () => {
  let rounds = 0;
  const f = fixture(() => {
    rounds++;
    return response([message('hello')]);
  });
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(f.ai.chat(f.ctx, 'Hello', undefined, true, { signal: controller.signal }), /abort/i);
    assert.equal(rounds, 0);
  } finally {
    f.store.close();
  }
});

test('A model cannot demand another confirmation after an ordinary mutation has actually completed', async () => {
  let round = 0;
  const f = fixture(() =>
    response(
      ++round === 1
        ? [functionCall('run_action', { action: 'guild.edit', json: '{}' })]
        : [message('Please confirm this change.')],
    ),
  );
  f.registry.register({
    id: 'guild.edit',
    category: 'server',
    risk: 'write',
    schema: z.strictObject({}),
    description: 'Rename server',
    userPermissions: [],
    botPermissions: [],
    execute: () => ({ ok: true }),
  });
  f.registry.request = async () => ({
    status: 'completed',
    action: 'guild.edit',
    result: { name: 'Roblox Hub' },
  });
  try {
    const reply = await f.ai.chat(f.ctx, 'Rename server');
    assert.equal(reply.text, 'Done — the server is named Roblox Hub.');
    assert.equal(reply.pending.length, 0);
  } finally {
    f.store.close();
  }
});

test('AI requests use the configured bot identity rather than obsolete persona environment settings', async () => {
  const requests: Record<string, unknown>[] = [];
  const f = fixture(
    (body) => {
      requests.push(body);
      return response([message('Hello')]);
    },
    { BOT_NAME: 'Vibe', BOT_INSTRUCTIONS: 'You are the obsolete assistant.' },
  );
  try {
    await f.ai.chat(f.ctx, 'What is your name?');
    assert.match(String(requests[0]?.instructions), /^You are "Vibe", a capable Discord assistant\./);
    assert.ok(!String(requests[0]?.instructions).includes('obsolete assistant'));
  } finally {
    f.store.close();
  }
});

test('Speech requests send the configured voice unchanged and return real PCM bytes to the voice pipeline', async () => {
  const store = new Store(':memory:'),
    registry = new ActionRegistry(),
    expected = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
  let body: Record<string, unknown> | undefined;
  const provider = new OpenAI({
    apiKey: 'test-only-not-a-real-key',
    maxRetries: 0,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      assert.match(request.url, /\/audio\/speech$/);
      body = (await request.json()) as Record<string, unknown>;
      return new Response(expected, { headers: { 'content-type': 'audio/pcm' } });
    },
  });
  try {
    const ai = new AiService(loadConfig({ OPENAI_SPEECH_VOICE: 'marin' }), store, registry, provider);
    assert.deepEqual(await ai.speech(context(store), 'Hi, I am Vibe.'), expected);
    assert.equal(body?.voice, 'marin');
    assert.equal(body?.response_format, 'pcm');
    assert.equal(body?.input, 'Hi, I am Vibe.');
  } finally {
    store.close();
  }
});

test('AI requests use stateless Responses API, bounded output and no provider-side conversation storage', async () => {
  let request: Record<string, unknown> | undefined;
  const f = fixture((body) => {
    request = body;
    return response([message('Hello')]);
  });
  try {
    const reply = await f.ai.chat(f.ctx, 'Hello');
    assert.equal(reply.text, 'Hello');
    assert.equal(request?.store, false);
    assert.equal(request?.max_output_tokens, 2000);
    assert.equal(request?.parallel_tool_calls, false);
    assert.deepEqual(request?.include, ['reasoning.encrypted_content']);
    assert.ok(String(request?.instructions).includes(guildId));
  } finally {
    f.store.close();
  }
});
test('Erasing AI data during a pending provider response prevents late delivery and history repopulation', async () => {
  const store = new Store(':memory:');
  const registry = new ActionRegistry(120, async (c) => c);
  let resume!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
      resume = resolve;
    }),
    entered = new Promise<void>((resolve) => {
      started = resolve;
    });
  const provider = new OpenAI({
    apiKey: 'test-only-not-a-real-key',
    maxRetries: 0,
    fetch: async () => {
      started();
      await gate;
      return new Response(JSON.stringify(response([message('Delayed response')])), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const ai = new AiService(loadConfig({}), store, registry, provider),
    ctx = context(store);
  try {
    const pending = ai.chat(ctx, 'erase this pending conversation');
    await entered;
    forgetAiData(store, userId, guildId);
    resume();
    await assert.rejects(() => pending, /erased/);
    assert.deepEqual(store.list('ai.conversations'), []);
    const next = await ai.chat(ctx, 'New conversation');
    assert.equal(next.text, 'Delayed response');
  } finally {
    resume();
    store.close();
  }
});

test('AI conversations and preferences stay isolated by server, channel and requesting user', async () => {
  const requests: Record<string, unknown>[] = [];
  const f = fixture((body) => {
    requests.push(body);
    return response([message('Answer')]);
  });
  try {
    f.store.set('ai.preferences', `${guildId}:${userId}`, 'Prefer short answers');
    await f.ai.chat(f.ctx, 'secret-context');
    await f.ai.chat(context(f.store, { user: '44444444444444444' }), 'other-user');
    await f.ai.chat(context(f.store, { channel: '55555555555555555' }), 'other-channel');
    await f.ai.chat(context(f.store, { guild: '66666666666666666' }), 'other-server');
    for (const request of requests.slice(1)) assert.ok(!JSON.stringify(request).includes('secret-context'));
    assert.ok(String(requests[0]?.instructions).includes('Prefer short answers'));
    assert.ok(!String(requests[1]?.instructions).includes('Prefer short answers'));
    await f.ai.chat(f.ctx, 'follow-up');
    assert.ok(JSON.stringify(requests.at(-1)?.input).includes('secret-context'));
  } finally {
    f.store.close();
  }
});
test('Shared activities cannot read private history/preferences or retain shared-source prompts', async () => {
  const requests: Record<string, unknown>[] = [];
  const f = fixture((body) => {
    requests.push(body);
    return response([message('Answer')]);
  });
  try {
    f.store.set('ai.preferences', `${guildId}:${userId}`, 'private-preference');
    await f.ai.chat(f.ctx, 'private-conversation');
    await f.ai.chat(f.ctx, 'shared-story', undefined, false, {
      memoryScope: 'story:123',
      usePreferences: false,
      retainHistory: false,
    });
    const shared = JSON.stringify(requests[1]);
    assert.ok(!shared.includes('private-conversation'));
    assert.ok(!shared.includes('private-preference'));
    assert.deepEqual(requests[1]?.tools, []);
    assert.equal(f.store.list('ai.conversations').length, 1);
    assert.ok(!JSON.stringify(f.store.list('ai.conversations')).includes('shared-story'));
    await f.ai.chat(f.ctx, 'private-follow-up');
    assert.ok(!JSON.stringify(requests[2]).includes('shared-story'));
  } finally {
    f.store.close();
  }
});

test('AI-proposed writes only create human confirmations and preserve exact typed arguments', async () => {
  let executed = 0,
    round = 0;
  const requests: Record<string, unknown>[] = [];
  const f = fixture((body) => {
    requests.push(body);
    return response(
      ++round === 1
        ? [functionCall('run_action', { action: 'channel.test', json: '{"name":"planned-channel"}' })]
        : [message('Awaiting confirmation.')],
    );
  });
  f.registry.register({
    id: 'channel.test',
    category: 'channels',
    description: 'test',
    schema: z.strictObject({ name: z.string() }),
    risk: 'write',
    userPermissions: [],
    botPermissions: [],
    execute: (_ctx, input) => {
      executed++;
      return input;
    },
  });
  try {
    const reply = await f.ai.chat(f.ctx, 'Create a channel');
    assert.equal(executed, 0);
    assert.equal(reply.pending.length, 1);
    assert.deepEqual(reply.pending[0]?.input, { name: 'planned-channel' });
    const replay = requests[1]?.input as { type?: string; output?: string }[];
    assert.ok(
      replay.some((item) => item.type === 'function_call_output' && item.output?.includes('confirmation')),
    );
    const outcome = await f.registry.confirm(f.ctx, reply.pending[0]!.id);
    assert.equal(outcome.status, 'completed');
    assert.equal(executed, 1);
  } finally {
    f.store.close();
  }
});

test('AI tool errors become explicit tool results; unknown actions never run arbitrary code', async () => {
  let round = 0,
    seen: Record<string, unknown> | undefined;
  const f = fixture((body) => {
    if (++round === 1)
      return response([functionCall('run_action', { action: 'shell.exec', json: '{"command":"anything"}' })]);
    seen = body;
    return response([message('That action is unavailable.')]);
  });
  try {
    await f.ai.chat(f.ctx, 'run this');
    assert.ok(JSON.stringify(seen?.input).includes('Unknown action'));
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM confirmations').get()?.n, 0);
  } finally {
    f.store.close();
  }
});

test('AI image actions are discoverable and use the normal registry confirmation policy', async () => {
  let round = 0,
    seen: Record<string, unknown> | undefined;
  const f = fixture((body) => {
    if (++round === 1)
      return response([functionCall('run_action', { action: 'ai.image', json: '{"prompt":"image"}' })]);
    seen = body;
    return response([message('Please use the image command directly.')]);
  });
  try {
    registerAiActions(f.registry, f.ai);
    const reply = await f.ai.chat(f.ctx, 'Make an image');
    assert.equal(reply.pending[0]?.action, 'ai.image');
    assert.equal(findConversationActions(f.registry, 'ai.image', 'private')[0]?.action, 'ai.image');
    assert.ok(JSON.stringify(seen?.input).includes('confirmation'));
    assert.equal(round, 2);
  } finally {
    f.store.close();
  }
});

test('Conversational-only voice/context-menu requests never accept administrative function calls', async () => {
  const f = fixture(() => response([functionCall('run_action', { action: 'anything', json: '{}' })]));
  try {
    await assert.rejects(f.ai.chat(f.ctx, 'say hello', undefined, false), /unavailable/);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM confirmations').get()?.n, 0);
  } finally {
    f.store.close();
  }
});

test('Mention private actions prove DM delivery before execution and never retain their result in public history', async () => {
  let round = 0,
    delivered = false,
    executions = 0;
  const f = fixture(() =>
    response(
      ++round === 1
        ? [functionCall('run_action', { action: 'private.records', json: '{}' })]
        : [message('Here are your private records.')],
    ),
  );
  f.registry.register({
    id: 'private.records',
    category: 'system',
    description: 'Read private records',
    risk: 'read',
    schema: z.strictObject({}),
    userPermissions: [],
    botPermissions: [],
    execute: () => {
      assert(delivered);
      executions++;
      return 'private-result';
    },
  });
  try {
    const reply = await f.ai.chat(f.ctx, 'Show my records', undefined, true, {
      responsePrivacy: 'public',
      allowPrivateActions: true,
      preparePrivateDelivery: async () => {
        delivered = true;
      },
      memoryScope: 'public-mention',
      historyTtlSeconds: 600,
    });
    assert.equal(reply.privateResponse, true);
    assert.equal(executions, 1);
    assert.equal(f.store.list('ai.conversations').length, 0);
    assert.equal(
      findConversationActions(f.registry, 'records', 'public', true)[0]?.action,
      'private.records',
    );
  } finally {
    f.store.close();
  }
});

test('A blocked DM prevents a private mention action from executing', async () => {
  let round = 0,
    executions = 0;
  const f = fixture(() =>
    response(
      ++round === 1
        ? [functionCall('run_action', { action: 'private.records', json: '{}' })]
        : [message('Enable DMs and ask again.')],
    ),
  );
  f.registry.register({
    id: 'private.records',
    category: 'system',
    description: 'Private records',
    risk: 'read',
    schema: z.strictObject({}),
    userPermissions: [],
    botPermissions: [],
    execute: () => {
      executions++;
      return 'never expose';
    },
  });
  try {
    const reply = await f.ai.chat(f.ctx, 'Show my records', undefined, true, {
      responsePrivacy: 'public',
      allowPrivateActions: true,
      preparePrivateDelivery: async () => {
        throw new Error('DM disabled');
      },
    });
    assert.equal(executions, 0);
    assert.equal(reply.privateResponse, undefined);
  } finally {
    f.store.close();
  }
});

test('A sequential image tool shares the parent AI slot, charges quota, and returns real bytes', async () => {
  let rounds = 0,
    images = 0;
  const f = fixture(
    (_body, path) => {
      if (path.includes('/images/generations')) {
        images++;
        return { data: [{ b64_json: Buffer.from('test image bytes').toString('base64') }] };
      }
      return response(
        ++rounds === 1
          ? [functionCall('run_action', { action: 'ai.image', json: '{"prompt":"rabbit"}' })]
          : [message('Image attached.')],
      );
    },
    { MAX_AI_CONCURRENT: '1' },
  );
  // A read wrapper exercises the nested API path independently of confirmation UI.
  f.registry.register({
    id: 'ai.image',
    category: 'ai',
    description: 'Test image',
    risk: 'read',
    schema: z.strictObject({ prompt: z.string() }),
    userPermissions: [],
    botPermissions: [],
    execute: (ctx, input) => f.ai.image(ctx, input.prompt),
  });
  try {
    const reply = await f.ai.chat(f.ctx, 'Make a rabbit');
    assert.equal(images, 1);
    assert.equal(reply.files?.[0]?.attachment.toString(), 'test image bytes');
    assert.equal(
      Number(
        f.store.db.prepare('SELECT count FROM quota WHERE scope=?').get(`user:${guildId}:${userId}`)?.count,
      ),
      2,
    );
  } finally {
    f.store.close();
  }
});

test('Tool loops end at configured round limit and the last request disables further tools', async () => {
  let calls = 0,
    last: Record<string, unknown> | undefined;
  const f = fixture(
    (body) => {
      calls++;
      last = body;
      return response([functionCall('find_actions', { query: 'missing' }, `call_${calls}`)]);
    },
    { MAX_TOOL_ROUNDS: '2' },
  );
  try {
    const reply = await f.ai.chat(f.ctx, 'Look indefinitely');
    assert.equal(calls, 3);
    assert.equal(last?.tool_choice, 'none');
    assert.match(reply.text, /tool limit/);
  } finally {
    f.store.close();
  }
});

test('Web search is opt-in and web citations are preserved in Discord output', async () => {
  let request: Record<string, unknown> | undefined;
  const f = fixture(
    (body) => {
      request = body;
      return response([
        message('A sourced answer.', [
          {
            type: 'url_citation',
            url: 'https://example.com/source',
            title: 'Official source',
            start_index: 0,
            end_index: 5,
          },
        ]),
      ]);
    },
    { ENABLE_WEB_SEARCH: 'true' },
  );
  try {
    const reply = await f.ai.chat(f.ctx, 'Find current information');
    assert.ok((request?.tools as { type: string }[]).some((tool) => tool.type === 'web_search'));
    assert.ok(reply.text.includes('[Official source](<https://example.com/source>)'));
  } finally {
    f.store.close();
  }
});

test('AI role access and disabled categories reject before any provider request', async () => {
  let calls = 0;
  const f = fixture(() => {
    calls++;
    return response([message('ok')]);
  });
  try {
    f.store.set('core.aiRoles', guildId, ['77777777777777777']);
    await assert.rejects(f.ai.chat(f.ctx, 'hi'), /roles/);
    assert.equal(calls, 0);
    f.store.delete('core.aiRoles', guildId);
    f.store.set('core.disabled', guildId, ['ai']);
    await assert.rejects(f.ai.chat(f.ctx, 'hi'), /disabled/);
    assert.equal(calls, 0);
  } finally {
    f.store.close();
  }
});

test('AI provider failures release concurrency and never save failed conversation turns', async () => {
  let calls = 0;
  const f = fixture(() => {
    if (++calls === 1) throw new Error('Simulated network failure');
    return response([message('Recovered')]);
  });
  try {
    await assert.rejects(f.ai.chat(f.ctx, 'failed'));
    assert.equal(f.store.list('ai.conversations').length, 0);
    assert.equal((await f.ai.chat(f.ctx, 'retry')).text, 'Recovered');
  } finally {
    f.store.close();
  }
});

test('Revoking a voice request during a delayed read stops subsequent mutations and model rounds', async () => {
  let resume!: () => void,
    entered!: () => void,
    active = true,
    writes = 0,
    providerCalls = 0;
  const gate = new Promise<void>((resolve) => {
      resume = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const f = fixture(() => {
    providerCalls++;
    return response([
      functionCall('run_action', { action: 'channel.list', json: '{}' }, 'read'),
      functionCall('run_action', { action: 'guild.edit', json: '{"name":"Late mutation"}' }, 'write'),
    ]);
  });
  f.registry.register({
    id: 'channel.list',
    category: 'channels',
    risk: 'read',
    schema: z.strictObject({}),
    userPermissions: [],
    botPermissions: [],
    description: 'Read live channels',
    execute: async () => {
      entered();
      await gate;
      return [];
    },
  });
  f.registry.register({
    id: 'guild.edit',
    category: 'guild',
    risk: 'write',
    schema: z.strictObject({ name: z.string() }),
    userPermissions: [],
    botPermissions: [],
    description: 'Update server',
    execute: () => {
      writes++;
      return {};
    },
  });
  try {
    const ctx = userRequestContext(f.ctx, 'voice', { valid: () => active });
    const pending = f.ai.chat(ctx, 'Rename the server', undefined, true, {
      memoryScope: 'voice-chat',
      historyTtlSeconds: 600,
      usePreferences: false,
    });
    await started;
    active = false;
    resume();
    await assert.rejects(pending, /cancelled/);
    assert.equal(providerCalls, 1);
    assert.equal(writes, 0);
    assert.deepEqual(f.registry.pending(f.ctx), []);
    assert.deepEqual(f.store.list('ai.conversations'), []);
  } finally {
    resume();
    f.store.close();
  }
});

test('A revoked voice lease cannot recreate erased shared history after a delayed provider response', async () => {
  let resume!: () => void,
    entered!: () => void,
    active = true;
  const gate = new Promise<void>((resolve) => {
      resume = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const f = fixture(async () => {
    entered();
    await gate;
    return response([message('Late answer')]);
  });
  const key = `${guildId}:${channelId}:voice-chat:${userId}`;
  f.store.set('ai.conversations', key, {
    turns: [{ role: 'assistant', content: 'Old session context' }],
    expiresAt: Date.now() + 600000,
  });
  try {
    const ctx = userRequestContext(f.ctx, 'voice', { valid: () => active });
    const pending = f.ai.chat(ctx, 'A pending question', undefined, false, {
      memoryScope: 'voice-chat',
      historyTtlSeconds: 600,
      usePreferences: false,
    });
    await started;
    active = false;
    f.store.delete('ai.conversations', key);
    resume();
    await assert.rejects(pending, /cancelled/);
    assert.equal(f.store.get('ai.conversations', key), undefined);
  } finally {
    resume();
    f.store.close();
  }
});

test('Realtime voice admission shares text AI daily quota and records its actual endpoint without provider calls', async () => {
  let providerCalls = 0,
    operations = 0;
  const f = fixture(
    () => {
      providerCalls++;
      return response([message('Unused')]);
    },
    {
      MAX_AI_REQUESTS_PER_USER_DAY: '1',
    },
  );
  try {
    assert.equal(
      await f.ai.admitVoice(f.ctx, async (signal) => {
        assert(signal instanceof AbortSignal);
        operations++;
        return 'Spoken';
      }),
      'Spoken',
    );
    await assert.rejects(f.ai.chat(f.ctx, 'Another request'), /allowance/);
    await assert.rejects(
      f.ai.admitVoice(f.ctx, async () => {
        operations++;
      }),
      /allowance/,
    );
    assert.equal(providerCalls, 0);
    assert.equal(operations, 1);
    const metrics = f.store.list<{ endpoint: string; successes: number }>('api.metrics');
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]?.value.endpoint, 'realtime');
  } finally {
    f.store.close();
  }
});

test('Realtime voice admission enforces AI access policy and shares in-flight concurrency with chat', async () => {
  const f = fixture(() => response([message('Allowed after release')]));
  let resume!: () => void,
    entered!: () => void,
    operations = 0;
  const gate = new Promise<void>((resolve) => {
      resume = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  try {
    f.store.set('core.disabled', guildId, ['ai']);
    await assert.rejects(
      f.ai.admitVoice(f.ctx, async () => {
        operations++;
      }),
      /disabled/,
    );
    f.store.delete('core.disabled', guildId);
    f.store.set('core.aiRoles', guildId, ['77777777777777777']);
    await assert.rejects(
      f.ai.admitVoice(f.ctx, async () => {
        operations++;
      }),
      /roles/,
    );
    f.store.delete('core.aiRoles', guildId);
    const pending = f.ai.admitVoice(f.ctx, async () => {
      operations++;
      entered();
      await gate;
      return 'Spoken';
    });
    await started;
    await assert.rejects(f.ai.chat(f.ctx, 'Competing request'), /busy/);
    resume();
    assert.equal(await pending, 'Spoken');
    assert.equal((await f.ai.chat(f.ctx, 'After release')).text, 'Allowed after release');
    assert.equal(operations, 1);
  } finally {
    resume();
    f.store.close();
  }
});

test('Revocation while voice admission awaits billing does not consume quota or start a stream', async () => {
  const f = fixture(() => response([message('Unused')]));
  let resume!: () => void,
    entered!: () => void,
    active = true,
    operations = 0;
  const gate = new Promise<void>((resolve) => {
      resume = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  f.ai.setAllowanceResolver(async () => {
    entered();
    await gate;
    return undefined;
  });
  try {
    const ctx = userRequestContext(f.ctx, 'voice', { valid: () => active });
    const pending = f.ai.admitVoice(ctx, async () => {
      operations++;
    });
    await started;
    active = false;
    resume();
    await assert.rejects(pending, /cancelled/);
    assert.equal(operations, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM quota').get()?.n, 0);
  } finally {
    resume();
    f.store.close();
  }
});

test('AI forget remains available when AI is disabled and deletes only the requester data', async () => {
  const f = fixture(() => response([message('unused')]));
  try {
    registerAiActions(f.registry, f.ai);
    f.store.set('core.disabled', guildId, ['ai']);
    f.store.set('ai.conversations', `${guildId}:${channelId}:${userId}`, [
      { role: 'user', content: 'private' },
    ]);
    f.store.set('ai.preferences', `${guildId}:${userId}`, 'private');
    f.store.set('ai.documents', `${guildId}:${userId}:doc`, { text: 'private' });
    f.store.set('ai.preferences', `${guildId}:44444444444444444`, 'someone else');
    const pending = await f.registry.request(f.ctx, 'ai.memory.forget', {});
    assert.equal(pending.status, 'confirmation');
    if (pending.status === 'confirmation') await f.registry.confirm(f.ctx, pending.id);
    assert.equal(f.store.list('ai.conversations').length, 0);
    assert.equal(f.store.list('ai.documents').length, 0);
    assert.equal(f.store.get('ai.preferences', `${guildId}:44444444444444444`), 'someone else');
  } finally {
    f.store.close();
  }
});

test('Semantic retrieval distinguishes matching, orthogonal, zero and mismatched vectors', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([0, 0], [1, 1]), 0);
  assert.equal(cosine([1], [1, 1]), 0);
});

test('AI local-media tools deliver real binary results as Discord attachments without sending bytes back to the model', async () => {
  let round = 0,
    seen: Record<string, unknown> | undefined;
  const f = fixture((body) => {
    if (++round === 1) return response([functionCall('run_action', { action: 'image.test', json: '{}' })]);
    seen = body;
    return response([message('Your file is attached.')]);
  });
  f.registry.register({
    id: 'image.test',
    category: 'media',
    description: 'Local file test',
    schema: z.strictObject({}),
    risk: 'read',
    userPermissions: [],
    botPermissions: [],
    execute: () => ({ attachment: Buffer.from('binary-output'), name: 'test.png' }),
  });
  try {
    const reply = await f.ai.chat(f.ctx, 'Create a card');
    assert.equal(reply.files?.length, 1);
    assert.ok(Buffer.isBuffer(reply.files?.[0]?.attachment));
    assert.equal(reply.files?.[0]?.name, 'test.png');
    assert.ok(!JSON.stringify(seen).includes('binary-output'));
    const payload = aiPayload(reply);
    assert.equal(payload.files?.length, 1);
  } finally {
    f.store.close();
  }
});

test('A later provider failure preserves completed files and pending approval previews instead of hiding them', async () => {
  let round = 0;
  const f = fixture(() => {
    if (++round === 1)
      return response([
        functionCall('run_action', { action: 'image.test', json: '{}' }, 'file'),
        functionCall('run_action', { action: 'channel.test', json: '{}' }, 'pending'),
      ]);
    throw new Error('Provider stopped');
  });
  for (const [id, risk] of [
    ['image.test', 'read'],
    ['channel.test', 'write'],
  ] as const)
    f.registry.register({
      id,
      category: 'test',
      description: 'test',
      schema: z.strictObject({}),
      risk,
      userPermissions: [],
      botPermissions: [],
      execute: () => ({ attachment: Buffer.from('data'), name: 'test.png' }),
    });
  try {
    const reply = await f.ai.chat(f.ctx, 'Run both');
    assert.equal(reply.files?.length, 1);
    assert.equal(reply.pending.length, 1);
    assert.match(reply.text, /stopped before completion/);
  } finally {
    f.store.close();
  }
});

test('Missing credentials fail clearly and do not reserve paid-request quota', async () => {
  const store = new Store(':memory:');
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  const ai = new AiService(loadConfig({}), store, registry);
  try {
    await assert.rejects(ai.chat(context(store), 'Hello'), /API key/);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM quota').get()?.n, 0);
  } finally {
    store.close();
  }
});
test('Image generation uses the supported default model and file transcription sends the current model through multipart', async () => {
  const store = new Store(':memory:'),
    registry = new ActionRegistry(120, async (c) => c),
    models: string[] = [];
  const provider = new OpenAI({
    apiKey: 'test-only-not-a-real-key',
    maxRetries: 0,
    fetch: async (input, init) => {
      const request = new Request(String(input), init);
      if (request.url.includes('/audio/transcriptions')) {
        const form = await request.formData();
        models.push(String(form.get('model')));
        assert.ok(form.get('file') instanceof File);
        return new Response(JSON.stringify({ text: 'Test transcript' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      const body = (await request.json()) as { model: string };
      models.push(body.model);
      return new Response(
        JSON.stringify({ data: [{ b64_json: Buffer.from('fixture').toString('base64') }] }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const ai = new AiService(loadConfig({}), store, registry, provider),
    ctx = context(store);
  try {
    await ai.image(ctx, 'Test image');
    assert.equal(await ai.transcribe(ctx, Buffer.from('test'), 'sample.wav'), 'Test transcript');
    assert.deepEqual(models, ['gpt-image-2.5-flare', 'gpt-transcribe']);
    assert.equal(loadConfig({}).imageEditModel, 'gpt-image-2.5-sunburst');
  } finally {
    store.close();
  }
});

test('Aborting the parent during a nested allowance wait does not charge the child quota or dispatch its API call', async () => {
  let resolveAllowance!: () => void,
    entered!: () => void,
    allowances = 0,
    images = 0;
  const gate = new Promise<void>((resolve) => {
      resolveAllowance = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  const f = fixture((_body, path) => {
    if (path.includes('/images/generations')) {
      images++;
      return { data: [{ b64_json: Buffer.from('unused').toString('base64') }] };
    }
    return response([functionCall('run_action', { action: 'ai.image', json: '{"prompt":"A test image"}' })]);
  });
  f.registry.register({
    id: 'ai.image',
    category: 'ai',
    description: 'Nested image test',
    risk: 'read',
    userPermissions: [],
    botPermissions: [],
    schema: z.strictObject({ prompt: z.string() }),
    execute: (ctx, input) => f.ai.image(ctx, input.prompt),
  });
  f.ai.setAllowanceResolver(async () => {
    if (++allowances === 2) {
      entered();
      await gate;
    }
    return undefined;
  });
  const controller = new AbortController();
  try {
    const work = f.ai.chat(f.ctx, 'Generate an image', undefined, true, { signal: controller.signal });
    await started;
    controller.abort(new Error('Addressed request stopped'));
    resolveAllowance();
    await assert.rejects(work, /stopped|abort/i);
    assert.equal(images, 0);
    assert.equal(
      Number(
        f.store.db.prepare('SELECT count FROM quota WHERE scope=?').get(`user:${guildId}:${userId}`)?.count,
      ),
      1,
    );
    assert.equal(f.store.list('ai.conversations').length, 0);
  } finally {
    resolveAllowance();
    f.store.close();
  }
});
