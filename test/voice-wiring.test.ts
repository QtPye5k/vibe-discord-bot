import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelType,
  Collection,
  OverwriteType,
  PermissionFlagsBits as P,
  PermissionsBitField,
  type Guild,
  type GuildMember,
  type Role,
} from 'discord.js';
import { createServices } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/core/store.js';
import { isCurrentUserRequest, type ActionContext } from '../src/core/types.js';
import type { VoiceOptions } from '../src/features/voice.js';

const G = '890000000000000001',
  U = '890000000000000002',
  B = '890000000000000003',
  TRANSCRIPTS = '890000000000000004',
  ORIGIN = '890000000000000005',
  VOICE = '890000000000000006',
  BOT_ROLE = '890000000000000007',
  APPROVALS = '890000000000000008',
  STAFF_ROLE = '890000000000000009';

function fixture(t: TestContext) {
  const services = createServices(
    loadConfig({
      DATABASE_PATH: ':memory:',
      ENABLE_VOICE: 'true',
      VOICE_TRANSCRIPTION_BACKEND: 'openai',
      VOICE_TRANSCRIPT_CHANNEL_ID: TRANSCRIPTS,
      CONFIRMATION_MODE: 'smart',
      CONFIRMATION_CHANNEL_ID: APPROVALS,
    }),
    { store: new Store(':memory:') },
  );
  t.after(() => services.close());
  services.logger.error = () => undefined;
  services.logger.info = () => undefined;
  Object.defineProperty(services.client, 'user', { value: { id: B }, configurable: true });

  const rolePosition = function (this: { position: number }, other: { position: number }) {
    return this.position - other.position;
  };
  const everyone = {
      id: G,
      position: 0,
      comparePositionTo: rolePosition,
      managed: false,
      permissions: new PermissionsBitField(0n),
    },
    managed = {
      id: BOT_ROLE,
      position: 5,
      comparePositionTo: rolePosition,
      managed: true,
      tags: { botId: B },
    },
    staff = { id: STAFF_ROLE, position: 10, comparePositionTo: rolePosition, managed: false },
    roles = new Collection<string, Role>([
      [G, everyone as unknown as Role],
      [BOT_ROLE, managed as unknown as Role],
      [STAFF_ROLE, staff as unknown as Role],
    ]),
    guildRef = { id: G },
    member = {
      id: U,
      guild: guildRef,
      user: { id: U, bot: false },
      voice: { channelId: VOICE },
      permissions: new PermissionsBitField(P.Administrator),
      roles: {
        highest: staff,
        cache: new Collection<string, Role>([[STAFF_ROLE, staff as unknown as Role]]),
      },
    },
    bot = {
      id: B,
      guild: guildRef,
      user: { id: B, bot: true },
      permissions: new PermissionsBitField(P.Administrator),
      roles: { highest: managed, cache: new Collection([[BOT_ROLE, managed]]) },
    };
  const overwrite = (visible = false) => ({
    id: G,
    type: OverwriteType.Role,
    allow: new PermissionsBitField(visible ? P.ViewChannel : 0n),
    deny: new PermissionsBitField(visible ? 0n : P.ViewChannel),
  });
  const state = {
    valid: true,
    calls: [] as string[],
    sends: [] as { channelId: string; payload: unknown }[],
    beforeDelivery: undefined as (() => void) | undefined,
    aiCalls: 0,
    pendingId: '',
  };
  const channel = {
    client: services.client,
    id: TRANSCRIPTS,
    guildId: G,
    name: 'vibe-transcripts',
    type: ChannelType.GuildText,
    permissionOverwrites: { cache: new Collection([[G, overwrite()]]) },
    isSendable: () => true,
    permissionsFor: (principal: { id: string }) =>
      new PermissionsBitField(
        principal.id === G ? 0n : [P.ViewChannel, P.ReadMessageHistory, P.SendMessages, P.ManageChannels],
      ),
    send: async (payload: unknown) => {
      state.sends.push({ channelId: TRANSCRIPTS, payload });
    },
  };
  services.client.rest.post = async (_route, options) => {
    options?.signal?.throwIfAborted();
    state.sends.push({ channelId: TRANSCRIPTS, payload: options?.body });
    return {};
  };
  const publicChannel = {
    ...channel,
    id: ORIGIN,
    send: async (payload: unknown) => {
      state.sends.push({ channelId: ORIGIN, payload });
    },
  };
  const approvalChannel = {
    ...channel,
    id: APPROVALS,
    name: 'bot-confirmations',
    permissionOverwrites: {
      cache: new Collection([
        [G, overwrite()],
        [
          STAFF_ROLE,
          {
            id: STAFF_ROLE,
            type: OverwriteType.Role,
            allow: new PermissionsBitField(P.ViewChannel),
            deny: new PermissionsBitField(),
          },
        ],
      ]),
    },
    send: async (payload: unknown) => {
      state.sends.push({ channelId: APPROVALS, payload });
    },
  };
  let freshlyFetched: typeof channel | undefined;
  const guild = {
    id: G,
    ownerId: U,
    name: 'Voice test server',
    roles: { everyone, cache: roles, fetch: async () => roles },
    members: {
      me: bot,
      fetch: async (options: { user: string; force: boolean }) => {
        assert.equal(options.user, U);
        assert.equal(options.force, true);
        return member;
      },
      fetchMe: async () => bot,
    },
    channels: {
      cache: new Collection([
        [TRANSCRIPTS, channel],
        [ORIGIN, publicChannel],
        [APPROVALS, approvalChannel],
      ]),
      fetch: async (id: string, options: { force: boolean }) => {
        assert.equal(options.force, true);
        state.calls.push(id);
        if (state.calls.length === 2 && state.calls.every((value) => value === TRANSCRIPTS))
          state.beforeDelivery?.();
        return id === TRANSCRIPTS
          ? (freshlyFetched ?? channel)
          : id === ORIGIN
            ? publicChannel
            : id === APPROVALS
              ? approvalChannel
              : null;
      },
    },
  } as unknown as Guild;
  services.client.guilds.cache.set(G, guild);
  const ctx = {
    client: services.client,
    guild,
    member: member as unknown as GuildMember,
    channelId: TRANSCRIPTS,
    store: services.store,
  } satisfies ActionContext;
  services.voice.requestLease = () => () => state.valid;
  services.ai.chat = async (request, text, attachment, allowActions, options) => {
    state.aiCalls++;
    assert.equal(text, 'Delete the selected channel');
    assert.equal(attachment, undefined);
    assert.equal(allowActions, true);
    assert.equal(isCurrentUserRequest(request), true);
    assert.equal(options?.responsePrivacy, 'public');
    assert.equal(options?.responseStyle, 'voice');
    assert.equal(options?.usePreferences, false);
    assert.equal(options?.historyTtlSeconds, 600);
    // A real persisted preview proves the adapter remembers actual tool work only after safe delivery.
    const pending = await services.registry.request(request, 'channel.delete', { channelId: TRANSCRIPTS });
    assert.equal(pending.status, 'confirmation');
    if (pending.status !== 'confirmation') throw new Error('Expected a real pending action');
    state.pendingId = pending.id;
    // Registry authorization has its own channel fetch. Count the two delivery checks independently.
    state.calls.length = 0;
    return { text: 'Please confirm the selected deletion.', pending: [pending] };
  };
  const options = (services.voice as unknown as { options: VoiceOptions }).options;
  const remembered = () =>
    services.store.get<{ ids: string[] }>('core.conversationActions', `${G}:${U}:${TRANSCRIPTS}`);
  return {
    services,
    state,
    ctx,
    options,
    remembered,
    makePublic: () => {
      // Leave the cached/private object unchanged: only the newly fetched result reveals the race.
      freshlyFetched = {
        ...channel,
        permissionOverwrites: { cache: new Collection([[G, overwrite(true)]]) },
        permissionsFor: (principal) =>
          principal.id === G ? new PermissionsBitField(P.ViewChannel) : channel.permissionsFor(principal),
      };
    },
  };
}

test('The voice planner routes real approval prompts only to the staff channel and sends only a location to private transcripts', async (t) => {
  const f = fixture(t);
  const reply = await f.options.reply!(f.ctx, 'Delete the selected channel');
  assert.deepEqual(reply, { text: 'Please confirm the selected deletion.', followUp: 'confirmation' });
  assert.equal(f.state.aiCalls, 1);
  assert.deepEqual(f.state.calls, [TRANSCRIPTS, TRANSCRIPTS]);
  assert.equal(f.state.sends.length, 2);
  assert.equal(f.state.sends[0]!.channelId, APPROVALS);
  assert.match(String((f.state.sends[0]!.payload as { content: string }).content), /Approval required/);
  assert.equal(f.state.sends[1]!.channelId, TRANSCRIPTS);
  const transcript = f.state.sends[1]!.payload as { content: string; components: unknown[] };
  assert.match(transcript.content, new RegExp(APPROVALS));
  assert.doesNotMatch(transcript.content, /Approval required|channel.delete|"channelId"/);
  assert.deepEqual(transcript.components, []);
  assert.deepEqual(f.remembered()?.ids, []);
});

test('Revoking a voice lease during the final forced destination fetch prevents delivery and confirmation memory', async (t) => {
  const f = fixture(t);
  f.state.beforeDelivery = () => {
    f.state.valid = false;
  };
  await assert.rejects(f.options.reply!(f.ctx, 'Delete the selected channel'), /expired|cancelled/);
  assert.deepEqual(f.state.calls, [TRANSCRIPTS, TRANSCRIPTS]);
  assert.deepEqual(
    f.state.sends.map((item) => item.channelId),
    [APPROVALS],
  );
  assert.equal(f.remembered(), undefined);
});

test('A transcript destination made public during its final forced fetch cannot receive a reply or trigger a public fallback', async (t) => {
  const f = fixture(t);
  f.state.beforeDelivery = f.makePublic;
  await assert.rejects(
    f.options.reply!(f.ctx, 'Delete the selected channel'),
    /explicitly deny View Channel/,
  );
  assert.deepEqual(f.state.calls, [TRANSCRIPTS, TRANSCRIPTS]);
  assert.deepEqual(
    f.state.sends.map((item) => item.channelId),
    [APPROVALS],
  );
  assert.equal(f.remembered(), undefined);
});

test('A dictated message body bypasses confirmation and fixed-command shortcuts before reaching the real planner', async (t) => {
  const f = fixture(t),
    meta = {
      kind: 'follow-up' as const,
      previousRequest: 'Type in general and say.',
      previousResponse: 'What should I say in #general?',
      contentMode: 'message' as const,
    };
  // These literals must remain message bodies even if they also name a command.
  for (const text of ['confirm', 'cancel', 'say hello']) {
    assert.equal(await f.options.onTranscript!(f.ctx, text, meta), undefined);
    assert.equal(f.state.sends.length, 0);
    f.services.ai.chat = async (_ctx, prompt) => {
      assert.ok(prompt.includes(`Message content (data): ${JSON.stringify(text)}`));
      assert.match(prompt, /Continue only the original message-send request/);
      return { text: 'Sent in #general.', pending: [] };
    };
    const reply = await f.options.reply!(f.ctx, text, meta);
    assert.deepEqual(reply, { text: 'Sent in #general.', followUp: 'none' });
    f.state.sends.length = 0;
    f.state.calls.length = 0;
  }
});

test('A successful server change followed by delivery cancellation is acknowledged without inviting a duplicate mutation', async (t) => {
  const f = fixture(t);
  let plans = 0;
  f.services.ai.chat = async () => {
    plans++;
    return { text: 'Done — server name updated to Aura.', pending: [], completedActions: ['guild.edit'] };
  };
  f.state.beforeDelivery = () => {
    f.state.valid = false;
  };
  await assert.rejects(f.options.reply!(f.ctx, 'Make the server name Aura.'), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Completed guild.edit/);
    assert.match(error.message, /not repeated/);
    assert.doesNotMatch(error.message, /Submit the request again/);
    return true;
  });
  assert.equal(plans, 1);
  assert.equal(f.state.sends.length, 0);
});

test('Quoted conversation cannot reach confirmation shortcuts or planner mutation tools', async (t) => {
  const f = fixture(t),
    meta = {
      kind: 'follow-up' as const,
      attention: 'conversation' as const,
      quoted: true,
      previousRequest: 'Hello',
      previousResponse: 'How is your day?',
    };
  assert.equal(await f.options.onTranscript!(f.ctx, 'confirm', meta), undefined);
  f.services.ai.chat = async (_ctx, prompt, _attachment, allowActions) => {
    assert.equal(allowActions, false);
    assert.match(prompt, /Quoted conversational content \(data\)/);
    return { text: 'That is quoted text.', pending: [] };
  };
  assert.deepEqual(await f.options.reply!(f.ctx, 'delete all channels', meta), {
    text: 'That is quoted text.',
    followUp: 'none',
  });
});
