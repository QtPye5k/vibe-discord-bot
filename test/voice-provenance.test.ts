import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, ClientUser, Guild, PermissionFlagsBits as P, type MessageCreateOptions } from 'discord.js';
import OpenAI from 'openai';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import { isCurrentUserRequest, userRequestContext, type ActionContext } from '../src/core/types.js';
import { AiService } from '../src/features/ai.js';
import { VoiceService, type VoiceDriver, type VoiceHooks } from '../src/features/voice.js';

const G = '860000000000000001',
  U = '860000000000000002',
  B = '860000000000000003',
  ORIGIN = '860000000000000004',
  PRIVATE = '860000000000000005',
  VC = '860000000000000006',
  BOT_ROLE = '860000000000000007';

test('real Discord objects preserve fresh captured speech authority across a different transcript channel and an expired join proof', async (t) => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const client = new Client({ intents: [] }),
    store = new Store(':memory:'),
    permissions = P.ViewChannel | P.ReadMessageHistory | P.SendMessages | P.Connect | P.Speak,
    botUser = Reflect.construct(ClientUser, [
      client,
      { id: B, username: 'Vibe', discriminator: '0', bot: true, avatar: null },
    ]) as ClientUser;
  Object.defineProperty(client, 'user', { value: botUser, configurable: true });
  client.users.cache.set(B, botUser);
  const guild = Reflect.construct(Guild, [
    client,
    {
      id: G,
      name: 'SDK test fixture',
      owner_id: U,
      roles: [
        { id: G, name: '@everyone', permissions: permissions.toString(), position: 0, managed: false },
        {
          id: BOT_ROLE,
          name: 'Vibe',
          permissions: P.Administrator.toString(),
          position: 1,
          managed: true,
          tags: { bot_id: B },
        },
      ],
      members: [
        {
          user: { id: U, username: 'Speaker', discriminator: '0', bot: false, avatar: null },
          roles: [],
          joined_at: new Date(now).toISOString(),
        },
        {
          user: { id: B, username: 'Vibe', discriminator: '0', bot: true, avatar: null },
          roles: [BOT_ROLE],
          joined_at: new Date(now).toISOString(),
        },
      ],
      channels: [
        { id: ORIGIN, guild_id: G, type: 0, name: 'commands', permission_overwrites: [] },
        {
          id: PRIVATE,
          guild_id: G,
          type: 0,
          name: 'vibe-transcripts',
          permission_overwrites: [
            { id: G, type: 0, allow: '0', deny: P.ViewChannel.toString() },
            { id: U, type: 1, allow: permissions.toString(), deny: '0' },
            { id: B, type: 1, allow: permissions.toString(), deny: '0' },
          ],
        },
        {
          id: VC,
          guild_id: G,
          type: 2,
          name: 'Voice',
          bitrate: 64000,
          user_limit: 0,
          permission_overwrites: [],
        },
      ],
      voice_states: [U, B].map((id) => ({
        user_id: id,
        channel_id: VC,
        session_id: 'fixture',
        deaf: false,
        mute: false,
        self_deaf: false,
        self_mute: false,
        suppress: false,
      })),
    },
  ]) as Guild;
  client.guilds.cache.set(G, guild);
  const member = guild.members.cache.get(U)!,
    bot = guild.members.cache.get(B)!;
  assert.equal(member.voice.channelId, VC);
  assert.equal(
    guild.channels.cache.get(PRIVATE)!.permissionsFor(guild.roles.everyone)?.has(P.ViewChannel),
    false,
  );
  t.mock.method(guild.members, 'fetch', async (input: unknown) => {
    const id = typeof input === 'string' ? input : (input as { user: string }).user;
    return guild.members.cache.get(id)!;
  });
  t.mock.method(guild.members, 'fetchMe', async () => bot);
  t.mock.method(guild.channels, 'fetch', async (id: unknown) => guild.channels.cache.get(String(id))!);
  const deliveries: MessageCreateOptions[] = [];
  t.mock.method(
    client.rest,
    'post',
    async (route: string, options?: { signal?: AbortSignal; body?: unknown }) => {
      assert.equal(route, `/channels/${PRIVATE}/messages`);
      options?.signal?.throwIfAborted();
      deliveries.push(options?.body as MessageCreateOptions);
      return {};
    },
  );
  let paidSpeech = 0;
  const sdk = new OpenAI({
    apiKey: 'offline-test-credential',
    maxRetries: 0,
    fetch: async (url, init) => {
      assert.match(String(url), /\/audio\/speech$/);
      assert(init?.signal);
      paidSpeech++;
      return new Response(Buffer.alloc(4800), { headers: { 'content-type': 'audio/pcm' } });
    },
  });
  const ai = new AiService(loadConfig({ DATABASE_PATH: ':memory:' }), store, new ActionRegistry(), sdk),
    proofs: ActionContext[] = [],
    played: Buffer[] = [],
    errors: unknown[] = [];
  let accessRefreshes = 0;
  let hooks!: VoiceHooks,
    chunk!: (data: Buffer) => void,
    end!: () => void,
    transcript = 'Vibe are you there';
  const driver: VoiceDriver = {
    play: (pcm) => {
      played.push(Buffer.from(pcm));
    },
    pause: () => true,
    resume: () => true,
    stop: () => hooks.idle(),
    destroy: () => {},
    receive: (_user, next, done) => {
      chunk = next;
      end = done;
      return () => {};
    },
  };
  const voice = new VoiceService({
    requireWakeWord: true,
    requirePrivateTranscripts: true,
    resolveTranscriptChannel: async () => PRIVATE,
    driverFactory: async (_channel, callbacks) => {
      hooks = callbacks;
      return driver;
    },
    transcribe: async () => transcript,
    onTranscript: async () => undefined,
    realtimeReply: async () => undefined,
    reply: async () => ({ text: 'I am here.', followUp: 'none' }),
    speech: async (ctx, text, request) => {
      assert.equal(ctx.channelId, PRIVATE);
      assert.equal(
        isCurrentUserRequest(ctx),
        true,
        'captured TTS receives this addressed turn, never the join proof',
      );
      proofs.push(ctx);
      return ai.speech(ctx, text, request?.signal);
    },
    onError: (error) => errors.push(error),
    onDiagnostic: (_event, fields) => {
      if (fields.stage === 'access.refresh.started') accessRefreshes++;
    },
    now: () => now,
  });
  t.after(async () => {
    voice.close();
    await voice.drain();
    store.close();
    await client.destroy();
  });
  const context: ActionContext = { client, guild, member, channelId: ORIGIN, store },
    join = userRequestContext(context, 'command');
  await assert.rejects(
    () => ai.speech({ ...join, channelId: PRIVATE }, 'Old incorrectly inherited request.'),
    /expired or was cancelled/,
  );
  await voice.join(join);
  voice.consent(context, true, true);
  for (let turn = 0; turn < 2; turn++) {
    if (turn) {
      now += 300001;
      transcript = 'Vibe explain that again';
    }
    hooks.speaking(U);
    chunk(Buffer.alloc(48000, 1));
    end();
    await voice.drain();
    hooks.idle();
  }
  assert.equal(join.channelId, ORIGIN, 'the initiating command context remains untouched');
  assert.equal(isCurrentUserRequest(join), false, 'the old join proof really expired');
  assert.equal(paidSpeech, 2);
  assert.equal(played.length, 2);
  assert.equal(deliveries.length, 2);
  assert.equal(accessRefreshes, 8, 'each turn refreshes before STT, transcript delivery, TTS and playback');
  assert.deepEqual(errors, []);
  voice.consent(context, false);
  assert.equal(
    isCurrentUserRequest(proofs.at(-1)!),
    false,
    'revocation still rejects captured speech authority',
  );
});
