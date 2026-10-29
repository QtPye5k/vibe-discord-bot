import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  Collection,
  ChannelType,
  GuildFeature,
  PermissionFlagsBits as P,
  PermissionsBitField,
  SystemChannelFlagsBitField,
} from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import { registerGuildActions } from '../src/discord/actions/guild.js';
import { registerChannelActions } from '../src/discord/actions/channels.js';
import { registerMessageActions } from '../src/discord/actions/messages.js';
import { registerRoleMemberActions } from '../src/discord/actions/members.js';
import { readMessageRange } from '../src/features/history.js';

const G = '710000000000000001',
  U = '710000000000000002',
  B = '710000000000000003',
  C = '710000000000000004',
  R = '710000000000000005',
  D = '710000000000000006';
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const calls: { kind: string; input: unknown }[] = [];
  const pos = (n: number) => ({
    position: n,
    comparePositionTo: (other: { position: number }) => n - other.position,
  });
  const member = {
    id: U,
    user: { id: U, bot: false },
    permissions: new PermissionsBitField(P.Administrator),
    roles: { cache: new Collection(), highest: pos(50) },
  };
  const bot = {
    ...member,
    id: B,
    user: { id: B, bot: true },
    roles: { cache: new Collection(), highest: pos(100) },
  };
  const role = {
    id: R,
    name: 'ordinary',
    managed: false,
    guild: { id: G },
    permissions: new PermissionsBitField(P.ViewChannel),
    mentionable: false,
    ...pos(5),
  };
  const history = Array.from({ length: 205 }, (_, i) => ({
    id: String(900000000000000000n + BigInt(i)),
    author: { id: U },
    content: `Message ${i}`,
    createdAt: new Date(i * 1000),
    reference: i ? { messageId: String(900000000000000000n + BigInt(i - 1)) } : null,
    attachments: new Collection(),
  }));
  let readHook: (() => void) | undefined;
  const overwrites = new Collection<
    string,
    { type: number; allow: PermissionsBitField; deny: PermissionsBitField }
  >([
    [
      R,
      {
        type: 0,
        allow: new PermissionsBitField(P.SendMessages | P.ViewChannel),
        deny: new PermissionsBitField(0n),
      },
    ],
  ]);
  const channel = {
    id: C,
    guildId: G,
    type: ChannelType.GuildText,
    isThread: () => false,
    isTextBased: () => true,
    isSendable: () => true,
    permissionsFor: (principal: { permissions: PermissionsBitField }) => principal.permissions,
    edit: async (input: unknown) => {
      calls.push({ kind: 'channel.edit', input });
      return channel;
    },
    send: async (input: unknown) => {
      calls.push({ kind: 'message.send', input });
      return {
        ...history[0],
        channelId: C,
        content: 'sent',
        createdAt: new Date(),
        editedAt: null,
        url: 'url',
        pinned: false,
        embeds: [],
      };
    },
    messages: {
      fetch: async (input: { limit: number; before?: string }) => {
        readHook?.();
        return new Collection(
          history
            .filter((row) => !input.before || BigInt(row.id) < BigInt(input.before))
            .reverse()
            .slice(0, input.limit)
            .map((row) => [row.id, row]),
        );
      },
    },
    permissionOverwrites: {
      cache: overwrites,
      set: async (input: { id: string; type: number; allow: bigint; deny: bigint }[]) => {
        calls.push({ kind: 'overwrite.set', input });
        overwrites.clear();
        for (const value of input)
          overwrites.set(value.id, {
            type: value.type,
            allow: new PermissionsBitField(value.allow),
            deny: new PermissionsBitField(value.deny),
          });
      },
      edit: async () => {},
    },
  };
  const guild = {
    id: G,
    ownerId: U,
    features: [GuildFeature.AnimatedIcon] as string[],
    rulesChannelId: null,
    publicUpdatesChannelId: null,
    members: { me: bot, fetch: async () => member, fetchMe: async () => bot },
    roles: { fetch: async () => role },
    channels: { fetch: async (id: string) => ({ ...channel, id }) },
    fetch: async () => guild,
    edit: async (input: Record<string, unknown>) => {
      calls.push({ kind: 'guild.edit', input });
      return {
        id: G,
        features: input.features ?? guild.features,
        systemChannelFlags: new SystemChannelFlagsBitField((input.systemChannelFlags as number) ?? 0),
      };
    },
    editOnboarding: async (input: { prompts: unknown[]; enabled?: boolean; mode?: number }) => {
      calls.push({ kind: 'guild.onboarding', input });
      return {
        enabled: input.enabled ?? false,
        mode: input.mode ?? 0,
        prompts: new Collection(input.prompts.map((row, i) => [String(i), row])),
      };
    },
  };
  Object.assign(member, { guild });
  Object.assign(bot, { guild });
  const ctx = { store, guild, member, client: { user: { id: B } }, channelId: C } as unknown as ActionContext;
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  registerGuildActions(registry);
  registerChannelActions(registry);
  registerMessageActions(registry);
  registerRoleMemberActions(registry);
  const run = (id: string, input: unknown) => {
    const action = registry.get(id);
    return Promise.resolve(action.execute(ctx, action.schema.parse(input)));
  };
  return {
    store,
    ctx,
    guild,
    member,
    bot,
    role,
    channel,
    calls,
    registry,
    run,
    history,
    setReadHook: (hook: () => void) => {
      readHook = hook;
    },
  };
}
test('system flags reject unknown bits and write exact supported suppression flags', async (t) => {
  const f = fixture(t);
  assert.throws(() => f.registry.get('guild.system-flags').schema.parse({ flags: 1 << 30 }));
  await f.run('guild.system-flags', { flags: 3 });
  assert.equal((f.calls[0]!.input as { systemChannelFlags: number }).systemChannelFlags, 3);
});
test('Community activation retains unrelated features and requires explicit ordinary text destinations', async (t) => {
  const f = fixture(t);
  await assert.rejects(() => f.run('guild.community', { enabled: true }), /rules channel/);
  await f.run('guild.community', { enabled: true, rulesChannelId: C, updatesChannelId: D });
  const input = f.calls[0]!.input as { features: string[] };
  assert.deepEqual(input.features, [GuildFeature.AnimatedIcon, GuildFeature.Community]);
});
test('onboarding edit transmits real SDK prompt/option shapes and rejects privileged self-service roles', async (t) => {
  const f = fixture(t);
  const input = {
    enabled: false,
    prompts: [{ title: 'Topics', options: [{ title: 'News', roleIds: [R], channelIds: [C] }] }],
  };
  await f.run('guild.onboarding-edit', input);
  const sent = f.calls[0]!.input as { prompts: { options: { roles: string[]; channels: string[] }[] }[] };
  assert.deepEqual(sent.prompts[0]!.options[0]!.roles, [R]);
  f.role.permissions = new PermissionsBitField(P.Administrator);
  await assert.rejects(() => f.run('guild.onboarding-edit', input), /ordinary/);
  assert.equal(f.calls.length, 1);
});
test('channel and thread schemas support forum defaults, archive duration and invitation controls', (t) => {
  const f = fixture(t);
  assert.doesNotThrow(() =>
    f.registry.get('channel.edit').schema.parse({
      channelId: C,
      defaultSortOrder: 1,
      defaultForumLayout: 2,
      defaultReactionEmoji: { id: null, name: '⭐' },
      defaultThreadRateLimitPerUser: 30,
    }),
  );
  assert.doesNotThrow(() =>
    f.registry.get('thread.edit').schema.parse({ channelId: C, invitable: false, autoArchiveDuration: 1440 }),
  );
});
test('permission comparison returns effective added and missing permissions by channel', async (t) => {
  const f = fixture(t);
  f.guild.channels.fetch = async (id) => ({
    ...f.channel,
    id,
    permissionsFor: () =>
      new PermissionsBitField(id === C ? [P.ViewChannel, P.SendMessages] : [P.ViewChannel, P.ManageMessages]),
  });
  const output = (await f.run('member.permissions-compare', { memberId: U, channelIds: [C, D] })) as {
    channels: { added: string[]; missing: string[] }[];
  };
  assert.ok(output.channels[1]!.added.includes('ManageMessages'));
  assert.ok(output.channels[1]!.missing.includes('SendMessages'));
});
test('channel lock denies explicit role allows and restores only its unchanged exact snapshot', async (t) => {
  const f = fixture(t);
  await f.run('channel.lock', { channelId: C });
  assert.equal(f.channel.permissionOverwrites.cache.get(R)!.allow.has(P.SendMessages), false);
  assert.equal(f.channel.permissionOverwrites.cache.get(R)!.deny.has(P.SendMessages), true);
  await f.run('channel.unlock', { channelId: C });
  assert.equal(f.channel.permissionOverwrites.cache.size, 1);
  assert.equal(f.channel.permissionOverwrites.cache.get(R)!.allow.has(P.SendMessages), true);
});
test('channel unlock preserves external changes rather than overwriting a divergent snapshot', async (t) => {
  const f = fixture(t);
  await f.run('channel.lock', { channelId: C });
  f.channel.permissionOverwrites.cache.get(R)!.allow.add(P.ManageMessages);
  await assert.rejects(() => f.run('channel.unlock', { channelId: C }), /changed after locking/);
  assert.ok(f.store.get('discord.channel-locks', `${G}:${C}`));
});
test('explicit mention notification IDs are transmitted only when selected and authorized', async (t) => {
  const f = fixture(t);
  await f.run('message.send', { channelId: C, content: `<@${U}>`, mentionUserIds: [U] });
  assert.deepEqual((f.calls[0]!.input as { allowedMentions: unknown }).allowedMentions, {
    parse: [],
    users: [U],
    repliedUser: false,
  });
  f.member.permissions = new PermissionsBitField([P.ViewChannel, P.SendMessages]);
  f.bot.permissions = f.member.permissions;
  await assert.rejects(
    () => f.run('message.send', { channelId: C, content: '@everyone', mentionEveryone: true }),
    /permissions/,
  );
});
test('history ranges traverse beyond 100 messages and expose a stable continuation until exhausted', async (t) => {
  const f = fixture(t);
  const first = await readMessageRange(f.ctx, C, { maxMessages: 120 });
  assert.equal(first.scanned, 120);
  assert.equal(first.complete, false);
  const second = await readMessageRange(f.ctx, C, { maxMessages: 120, before: first.nextBefore! });
  assert.equal(second.scanned, 85);
  assert.equal(second.complete, true);
  assert.equal(new Set([...first.messages, ...second.messages].map((row) => row.id)).size, 205);
});
test('message search filters complete traversed history and cancels output after permission withdrawal', async (t) => {
  const f = fixture(t);
  const result = (await f.run('message.search', { channelId: C, query: 'Message 0', maxMessages: 300 })) as {
    complete: boolean;
    messages: { content: string }[];
  };
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.messages.map((row) => row.content),
    ['Message 0'],
  );
  f.setReadHook(() => {
    f.member.permissions = new PermissionsBitField(0n);
  });
  await assert.rejects(() => readMessageRange(f.ctx, C, { maxMessages: 20 }), /view/);
});
