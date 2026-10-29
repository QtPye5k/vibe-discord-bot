import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelType,
  Collection,
  OverwriteType,
  PermissionsBitField,
  PermissionFlagsBits as P,
  type GuildMember,
  type GuildBasedChannel,
  type Role,
} from 'discord.js';
import { Store } from '../src/core/store.js';
import type { ActionContext } from '../src/core/types.js';
import { createTranscriptResolver, assertPrivateTranscriptPrivacy } from '../src/voice/transcripts.js';

const G = '780000000000000001',
  U = '780000000000000002',
  B = '780000000000000003',
  C = '780000000000000004',
  ORIGIN = '780000000000000005',
  R = '780000000000000006',
  BOT_ROLE = '780000000000000007';
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const guildRef = { id: G },
    everyone = { id: G, managed: false, tags: {}, permissions: new PermissionsBitField(0n) },
    managed = { id: BOT_ROLE, managed: true, tags: { botId: B }, permissions: new PermissionsBitField(0n) },
    roles = new Collection<string, Role>([
      [G, everyone as unknown as Role],
      [BOT_ROLE, managed as unknown as Role],
    ]);
  const member = { id: U, guild: guildRef, roles: { cache: new Collection() } },
    bot = { id: B, guild: guildRef, roles: { cache: new Collection([[BOT_ROLE, managed]]) } };
  const overwrite = (id: string, type: OverwriteType, allow = 0n, deny = 0n) => ({
    id,
    type,
    allow: new PermissionsBitField(allow),
    deny: new PermissionsBitField(deny),
  });
  const overwrites = new Collection([
    [G, overwrite(G, OverwriteType.Role, 0n, P.ViewChannel)],
    [U, overwrite(U, OverwriteType.Member, P.ViewChannel)],
    [B, overwrite(B, OverwriteType.Member, P.ViewChannel)],
  ]);
  const calls: { id?: string; force?: boolean }[] = [],
    state = {
      memberHistory: true,
      botSend: true,
      everyoneVisible: false,
      throwFetch: false,
      creates: 0,
      sends: 0,
    };
  const channel = {
    id: C,
    guildId: G,
    name: 'vibe-transcripts',
    type: ChannelType.GuildText as ChannelType,
    permissionOverwrites: { cache: overwrites },
    permissionsFor: (principal: { id: string }) =>
      new PermissionsBitField(
        principal.id === G
          ? state.everyoneVisible
            ? P.ViewChannel
            : 0n
          : [
              P.ViewChannel,
              ...(principal.id === U && !state.memberHistory ? [] : [P.ReadMessageHistory]),
              ...(principal.id === B && !state.botSend ? [] : [P.SendMessages]),
            ],
      ),
    send: async () => {
      state.sends++;
    },
  };
  const channels = new Collection<string, typeof channel>([[C, channel]]);
  const memberships: string[] = [];
  const guild = {
    id: G,
    roles: { everyone, cache: roles, fetch: async () => roles },
    members: {
      me: bot,
      fetch: async (options: { user: string; force: boolean }) => {
        assert.equal(options.force, true);
        memberships.push(options.user);
        return member;
      },
      fetchMe: async (options: { force: boolean }) => {
        assert.equal(options.force, true);
        memberships.push(B);
        return bot;
      },
    },
    channels: {
      fetch: async (id?: string, options?: { force: boolean }) => {
        calls.push({ id, force: options?.force });
        if (state.throwFetch)
          throw new Error('private transcript contents must not escape through an API failure');
        return id ? (channels.get(id) ?? null) : channels;
      },
      create: async () => {
        state.creates++;
      },
    },
  };
  const ctx = {
    store,
    guild,
    member,
    client: { user: { id: B } },
    channelId: ORIGIN,
  } as unknown as ActionContext;
  return {
    ctx,
    store,
    channel,
    channels,
    calls,
    overwrites,
    overwrite,
    state,
    managed,
    bot,
    roles,
    memberships,
    roleGrant: (id = R) => {
      roles.set(id, { id, managed: false, tags: {} } as unknown as Role);
      overwrites.set(id, overwrite(id, OverwriteType.Role, P.ViewChannel));
    },
    privacy: () =>
      assertPrivateTranscriptPrivacy(
        ctx,
        channel as unknown as GuildBasedChannel,
        bot as unknown as GuildMember,
      ),
  };
}
test('An exact private transcript ID refreshes requester, bot, roles and destination without using the public command channel', async (t) => {
  const f = fixture(t),
    resolve = createTranscriptResolver({ channelId: C });
  assert.equal(await resolve(f.ctx), C);
  assert.deepEqual(f.memberships.sort(), [U, B].sort());
  assert.deepEqual(f.calls, [{ id: C, force: true }]);
  assert.equal(f.state.creates, 0);
  assert.equal(f.state.sends, 0);
  assert(!f.calls.some((call) => call.id === ORIGIN));
});
test('Blank configuration discovers one exact named GuildText destination and force-fetches it before returning', async (t) => {
  const f = fixture(t);
  assert.equal(await createTranscriptResolver()(f.ctx), C);
  assert.deepEqual(f.calls, [
    { id: undefined, force: undefined },
    { id: C, force: true },
  ]);
});
test('Missing or duplicate named channels fail closed rather than selecting a public fallback', async (t) => {
  const f = fixture(t),
    resolve = createTranscriptResolver();
  f.channels.clear();
  await assert.rejects(resolve(f.ctx), /exactly one private/);
  f.channels.set(C, f.channel);
  f.channels.set(R, { ...f.channel, id: R });
  await assert.rejects(resolve(f.ctx), /exactly one private/);
  assert.equal(f.state.creates, 0);
  assert.equal(f.state.sends, 0);
});
test('Invalid configured IDs and wrong-guild or non-text destinations are rejected', async (t) => {
  const f = fixture(t);
  assert.throws(() => createTranscriptResolver({ channelId: 'not-a-channel-id' }), /channel ID/);
  const resolve = createTranscriptResolver({ channelId: C });
  f.channel.guildId = '790000000000000001';
  await assert.rejects(resolve(f.ctx), /private text channel in this server/);
  f.channel.guildId = G;
  for (const type of [ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.PrivateThread]) {
    f.channel.type = type;
    await assert.rejects(resolve(f.ctx), /private text channel/);
  }
});
test('Effective inherited privacy is insufficient without an explicit @everyone View Channel deny', async (t) => {
  const f = fixture(t),
    resolve = createTranscriptResolver({ channelId: C });
  f.overwrites.delete(G);
  await assert.rejects(resolve(f.ctx), /explicitly deny/);
  f.overwrites.set(G, f.overwrite(G, OverwriteType.Role, P.ViewChannel, P.ViewChannel));
  await assert.rejects(resolve(f.ctx), /explicitly deny/);
});
test('Broad ordinary-role visibility is denied even when @everyone itself cannot see the channel', async (t) => {
  const f = fixture(t);
  f.roleGrant();
  assert.equal(f.channel.permissionsFor({ id: G }).has(P.ViewChannel), false);
  await assert.rejects(createTranscriptResolver({ channelId: C })(f.ctx), /role broad View Channel/);
  assert.equal(f.state.sends, 0);
});
test('Selected member readers and the verified managed role for this bot are permitted', async (t) => {
  const f = fixture(t);
  f.overwrites.set(R, f.overwrite(R, OverwriteType.Member, P.ViewChannel));
  f.overwrites.set(BOT_ROLE, f.overwrite(BOT_ROLE, OverwriteType.Role, P.ViewChannel));
  assert.equal(await createTranscriptResolver({ channelId: C })(f.ctx), C);
  f.managed.tags.botId = U;
  await assert.rejects(createTranscriptResolver({ channelId: C })(f.ctx), /role broad View Channel/);
  f.managed.tags.botId = B;
  f.managed.managed = false;
  await assert.rejects(createTranscriptResolver({ channelId: C })(f.ctx), /role broad View Channel/);
});
test('Requester history and bot send permission are independently required', async (t) => {
  const f = fixture(t),
    resolve = createTranscriptResolver({ channelId: C });
  f.state.memberHistory = false;
  await assert.rejects(resolve(f.ctx), /You need View Channel and Read Message History/);
  f.state.memberHistory = true;
  f.state.botSend = false;
  await assert.rejects(resolve(f.ctx), /Vibe needs/);
});
test('Fresh privacy checks reject a channel that becomes public or grants a broad role after an earlier successful resolution', async (t) => {
  const f = fixture(t),
    resolve = createTranscriptResolver({ channelId: C });
  assert.equal(await resolve(f.ctx), C);
  f.state.everyoneVisible = true;
  await assert.rejects(resolve(f.ctx), /explicitly deny/);
  f.state.everyoneVisible = false;
  f.roleGrant();
  assert.throws(f.privacy, /role broad View Channel/);
  assert.equal(f.state.sends, 0);
});
test('Provider errors never expose private transcript content and never create or send to another channel', async (t) => {
  const f = fixture(t);
  f.state.throwFetch = true;
  await assert.rejects(createTranscriptResolver({ channelId: C })(f.ctx), (error) => {
    assert(error instanceof Error);
    assert.match(error.message, /could not be verified/);
    assert(!error.message.includes('private transcript contents'));
    return true;
  });
  assert.equal(f.state.sends, 0);
  assert.equal(f.state.creates, 0);
});
