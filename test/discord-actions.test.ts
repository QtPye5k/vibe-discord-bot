import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { ActionRegistry } from '../src/core/registry.js';
import { Store } from '../src/core/store.js';
import type { ActionContext } from '../src/core/types.js';
import { registerDiscordActions } from '../src/discord/actions.js';

const GUILD = '100000000000000001',
  USER = '100000000000000002',
  BOT = '100000000000000003';
const CHANNEL = '100000000000000004',
  TARGET = '100000000000000005',
  ROLE = '100000000000000006';
const MESSAGE = '100000000000000007';

function fixture() {
  const calls: { name: string; input: unknown }[] = [];
  const all = () => new PermissionsBitField(PermissionsBitField.All);
  const highest = (position: number) => ({
    position,
    comparePositionTo: (role: { position: number }) => position - role.position,
  });
  const me = {
    id: BOT,
    permissions: all(),
    roles: { highest: highest(100) },
    voice: { channelId: CHANNEL },
    setNickname: async (input: unknown) => {
      calls.push({ name: 'bot.nickname', input });
    },
  };
  const member = {
    id: USER,
    permissions: all(),
    roles: { highest: highest(80) },
    voice: { channelId: CHANNEL },
  };
  const role = {
    id: ROLE,
    guild: { id: GUILD },
    name: 'Member',
    position: 10,
    managed: false,
    permissions: new PermissionsBitField(0n),
    colors: { primaryColor: 0, secondaryColor: null, tertiaryColor: null },
    hoist: false,
    mentionable: false,
    edit: async (input: unknown) => {
      calls.push({ name: 'role.edit', input });
      return role;
    },
    setPosition: async (input: unknown) => {
      calls.push({ name: 'role.position', input });
      return role;
    },
  };
  const target = {
    id: TARGET,
    guild: { id: GUILD },
    roles: {
      highest: highest(10),
      add: async (input: unknown) => {
        calls.push({ name: 'role.assign', input });
      },
      remove: async (input: unknown) => {
        calls.push({ name: 'role.remove', input });
      },
    },
    bannable: true,
    kickable: true,
    moderatable: true,
    ban: async (input: unknown) => {
      calls.push({ name: 'member.ban', input });
    },
    kick: async (input: unknown) => {
      calls.push({ name: 'member.kick', input });
    },
    timeout: async (input: unknown) => {
      calls.push({ name: 'member.timeout', input });
    },
  };
  const message = {
    id: MESSAGE,
    channelId: CHANNEL,
    author: { id: BOT },
    content: 'hello',
    createdAt: new Date(0),
    editedAt: null,
    url: 'https://discord.com/channels/test',
    pinned: false,
    attachments: new Collection(),
    embeds: [],
    edit: async (input: unknown) => {
      calls.push({ name: 'message.edit', input });
      return message;
    },
  };
  const channel = {
    id: CHANNEL,
    guildId: GUILD,
    name: 'general',
    type: ChannelType.GuildText,
    parentId: null,
    position: 0,
    permissionsFor: () => all(),
    isThread: () => false,
    isTextBased: () => true,
    isSendable: () => true,
    isVoiceBased: () => false,
    permissionOverwrites: {
      cache: new Collection<string, { allow: PermissionsBitField; deny: PermissionsBitField }>(),
      create: async (...input: unknown[]) => {
        calls.push({ name: 'overwrite.create', input });
      },
      edit: async (...input: unknown[]) => {
        calls.push({ name: 'overwrite.edit', input });
      },
      delete: async (...input: unknown[]) => {
        calls.push({ name: 'overwrite.delete', input });
      },
    },
    messages: {
      fetch: async (input: unknown) => {
        calls.push({ name: 'message.fetch', input });
        return message;
      },
    },
    send: async (input: unknown) => {
      calls.push({ name: 'message.send', input });
      return message;
    },
    bulkDelete: async (input: string[]) => {
      calls.push({ name: 'message.bulk-delete', input });
      return new Collection(input.map((id) => [id, {}]));
    },
  };
  const guild = {
    id: GUILD,
    ownerId: '100000000000000099',
    members: {
      me,
      fetchMe: async () => me,
      fetch: async (input: string | { user: string }) => {
        const memberId = typeof input === 'string' ? input : input.user;
        if (memberId === TARGET) return target;
        if (memberId === USER) return member;
        throw new Error('Unknown member');
      },
      bulkBan: async (input: unknown) => {
        calls.push({ name: 'member.bulk-ban', input });
        return { bannedUsers: [TARGET], failedUsers: [] };
      },
    },
    channels: {
      fetch: async (channelId?: string) => {
        if (channelId && channelId !== CHANNEL) throw new Error('Unknown channel');
        return channelId ? channel : new Collection([[CHANNEL, channel]]);
      },
      create: async (input: unknown) => {
        calls.push({ name: 'channel.create', input });
        return channel;
      },
    },
    roles: {
      fetch: async () => role,
      create: async (input: unknown) => {
        calls.push({ name: 'role.create', input });
        return role;
      },
    },
    scheduledEvents: {
      create: async (input: unknown) => {
        calls.push({ name: 'event.create', input });
        return {
          id: MESSAGE,
          name: 'Event',
          url: 'https://discord.com/events/test',
        };
      },
    },
    autoModerationRules: {
      create: async (input: unknown) => {
        calls.push({ name: 'automod.create', input });
        return {
          id: MESSAGE,
          name: 'Rule',
          enabled: true,
          eventType: 1,
          triggerType: 1,
          triggerMetadata: {},
          exemptRoles: new Collection(),
          exemptChannels: new Collection(),
          actions: [],
        };
      },
    },
    fetchWebhooks: async () =>
      new Collection([
        [
          MESSAGE,
          {
            id: MESSAGE,
            name: 'announce',
            channelId: CHANNEL,
            type: 1,
            token: 'secret-webhook-token',
            url: 'https://discord.com/api/webhooks/secret',
          },
        ],
      ]),
  };
  const store = new Store(':memory:');
  const ctx = {
    guild,
    member,
    client: { user: { id: BOT } },
    channelId: CHANNEL,
    store,
  } as unknown as ActionContext;
  const registry = new ActionRegistry();
  registerDiscordActions(registry);
  const run = async (name: string, input: unknown) => {
    const action = registry.get(name);
    return action.execute(ctx, action.schema.parse(input));
  };
  return {
    ctx,
    store,
    registry,
    run,
    calls,
    role,
    target,
    member,
    me,
    channel,
    guild,
    message,
  };
}

test('native catalog contains unique described validated actions and permission checks for every write', () => {
  const f = fixture();
  try {
    const actions = f.registry.list();
    assert.ok(actions.length >= 100, `${actions.length} native actions`);
    assert.equal(new Set(actions.map((a) => a.id)).size, actions.length);
    for (const action of actions) {
      assert.ok(action.description.length >= 20);
      assert.ok(action.schema);
      if (action.risk !== 'read') assert.ok(action.userPermissions.length > 0, action.id);
    }
  } finally {
    f.store.close();
  }
});

test('strict action schemas reject unknown arguments, invalid IDs and excessive ban history', () => {
  const f = fixture();
  try {
    assert.throws(() => f.registry.get('guild.info').schema.parse({ token: 'unexpected' }));
    assert.throws(() => f.registry.get('member.ban').schema.parse({ memberId: '../other', reason: 'test' }));
    assert.throws(() =>
      f.registry.get('member.ban').schema.parse({
        memberId: TARGET,
        deleteMessageSeconds: 604801,
        reason: 'test',
      }),
    );
    assert.throws(() =>
      f.registry.get('member.timeout').schema.parse({
        memberId: TARGET,
        durationSeconds: 2419201,
        reason: 'test',
      }),
    );
    assert.throws(() =>
      f.registry.get('role.edit').schema.parse({ roleId: ROLE, permissions: (1n << 110n).toString() }),
    );
  } finally {
    f.store.close();
  }
});

test('role.create refuses permissions absent from invoking moderator before API mutation', async () => {
  const f = fixture();
  try {
    f.member.permissions = new PermissionsBitField([P.ManageRoles]);
    await assert.rejects(
      f.run('role.create', {
        name: 'Admin',
        permissions: P.Administrator.toString(),
      }),
      /may only grant/,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('role.create refuses permissions absent from bot even for server owner', async () => {
  const f = fixture();
  try {
    f.ctx.guild.ownerId = USER;
    f.me.permissions = new PermissionsBitField([P.ManageRoles]);
    await assert.rejects(
      f.run('role.create', {
        name: 'Admin',
        permissions: P.Administrator.toString(),
      }),
      /may only grant/,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('role.assign blocks granting an existing privileged role without matching moderator permissions', async () => {
  const f = fixture();
  try {
    f.role.permissions = new PermissionsBitField([P.Administrator]);
    f.member.permissions = new PermissionsBitField([P.ManageRoles]);
    await assert.rejects(f.run('role.assign', { memberId: TARGET, roleId: ROLE }), /may only grant/);
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('role.position cannot raise a role to or above bot or moderator highest role', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.run('role.position', { roleId: ROLE, position: 80 }), /hierarchy/);
    await assert.rejects(f.run('role.position', { roleId: ROLE, position: 100 }), /hierarchy/);
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('role.edit rejects managed roles and higher roles', async () => {
  const f = fixture();
  try {
    f.role.managed = true;
    await assert.rejects(f.run('role.edit', { roleId: ROLE, name: 'changed' }), /Managed|Integration/);
    f.role.managed = false;
    f.role.position = 81;
    await assert.rejects(f.run('role.edit', { roleId: ROLE, name: 'changed' }), /highest role/);
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('member.ban rejects server owner and respects caller hierarchy before mutation', async () => {
  const f = fixture();
  try {
    f.ctx.guild.ownerId = TARGET;
    await assert.rejects(f.run('member.ban', { memberId: TARGET }), /server owner/);
    f.ctx.guild.ownerId = GUILD;
    f.target.roles.highest = { position: 90, comparePositionTo: () => 0 };
    await assert.rejects(f.run('member.ban', { memberId: TARGET }), /Your highest role/);
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('member.ban validates Discord bannability and stamps responsible actor on audit reason', async () => {
  const f = fixture();
  try {
    f.target.bannable = false;
    await assert.rejects(f.run('member.ban', { memberId: TARGET }), /cannot be banned/);
    f.target.bannable = true;
    assert.deepEqual(
      await f.run('member.ban', {
        memberId: TARGET,
        reason: 'spam',
        deleteMessageSeconds: 60,
      }),
      { bannedMemberId: TARGET, caseId: '1' },
    );
    assert.deepEqual(f.calls[0], {
      name: 'member.ban',
      input: {
        deleteMessageSeconds: 60,
        reason: `spam [requested by ${USER}]`,
      },
    });
  } finally {
    f.store.close();
  }
});
test('bulk bans prevalidate every target before contacting Discord mutation endpoint', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.run('member.bulk-ban', { memberIds: [TARGET, '100000000000000088'] }),
      /Unknown member/,
    );
    assert.equal(f.calls.length, 0);
    assert.throws(() => f.registry.get('member.bulk-ban').schema.parse({ memberIds: [TARGET, TARGET] }));
  } finally {
    f.store.close();
  }
});
test('message.edit refuses to edit another bot or user message', async () => {
  const f = fixture();
  try {
    f.message.author.id = TARGET;
    await assert.rejects(
      f.run('message.edit', {
        channelId: CHANNEL,
        messageId: MESSAGE,
        content: 'replacement',
      }),
      /own messages/,
    );
    assert.equal(f.calls.filter((c) => c.name === 'message.edit').length, 0);
  } finally {
    f.store.close();
  }
});
test('message.send explicitly disables all mentions and replies by default', async () => {
  const f = fixture();
  try {
    await f.run('message.send', {
      channelId: CHANNEL,
      content: '@everyone hello',
    });
    const call = f.calls.find((c) => c.name === 'message.send');
    assert.ok(call);
    assert.deepEqual((call.input as { allowedMentions: unknown }).allowedMentions, {
      parse: [],
      repliedUser: false,
    });
  } finally {
    f.store.close();
  }
});
test('message.send validates filenames and blocks path traversal or remote file input', () => {
  const f = fixture();
  try {
    const schema = f.registry.get('message.send').schema;
    for (const name of ['../secret.env', 'C:\\secret.env', '/etc/passwd'])
      assert.throws(() => schema.parse({ channelId: CHANNEL, files: [{ name, base64: 'YWJj' }] }));
    assert.throws(() =>
      schema.parse({
        channelId: CHANNEL,
        files: [{ name: 'data.txt', url: 'http://127.0.0.1/' }],
      }),
    );
  } finally {
    f.store.close();
  }
});
test('message.bulk-delete rejects old or duplicate messages before API mutation', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.run('message.bulk-delete', {
        channelId: CHANNEL,
        messageIds: [MESSAGE, TARGET],
      }),
      /two weeks/,
    );
    assert.throws(() =>
      f.registry
        .get('message.bulk-delete')
        .schema.parse({ channelId: CHANNEL, messageIds: [MESSAGE, MESSAGE] }),
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('message.bulk-delete sends explicit fresh IDs and returns actual deleted count', async () => {
  const f = fixture();
  try {
    const fresh = ((BigInt(Date.now() - 60000) - 1420070400000n) << 22n).toString();
    const next = (BigInt(fresh) + 1n).toString();
    assert.deepEqual(
      await f.run('message.bulk-delete', {
        channelId: CHANNEL,
        messageIds: [fresh, next],
      }),
      { deleted: 2, messageIds: [fresh, next] },
    );
  } finally {
    f.store.close();
  }
});
test('target channel reads reject caller or bot access loss', async () => {
  const f = fixture();
  try {
    f.channel.permissionsFor = () => new PermissionsBitField(0n);
    await assert.rejects(
      f.run('message.read', { channelId: CHANNEL, messageId: MESSAGE }),
      /view that channel/,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('private thread reads require bot membership even when caller can manage threads', async () => {
  const f = fixture();
  try {
    Object.assign(f.channel, {
      type: ChannelType.PrivateThread,
      isThread: () => true,
      permissionsFor: (member: { id: string }) =>
        new PermissionsBitField(
          member.id === USER ? PermissionsBitField.All : P.ViewChannel | P.ReadMessageHistory,
        ),
      members: {
        fetch: async () => {
          throw new Error('Not a participant');
        },
      },
    });
    await assert.rejects(
      f.run('message.read', { channelId: CHANNEL, messageId: MESSAGE }),
      /bot must belong to that private thread/,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('channel.overwrite rejects conflicting allow and deny flags before mutations', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.run('channel.overwrite', {
        channelId: CHANNEL,
        targetId: ROLE,
        targetType: 'role',
        allow: P.SendMessages.toString(),
        deny: P.SendMessages.toString(),
      }),
      /both allowed and denied/,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('channel.overwrite performs one targeted mutation preserving unrelated overwrites', async () => {
  const f = fixture();
  try {
    await f.run('channel.overwrite', {
      channelId: CHANNEL,
      targetId: ROLE,
      targetType: 'role',
      allow: P.ViewChannel.toString(),
      deny: P.SendMessages.toString(),
    });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]?.name, 'overwrite.create');
    const [, options] = f.calls[0]?.input as [string, Record<string, unknown>];
    assert.equal(options.ViewChannel, true);
    assert.equal(options.SendMessages, false);
    assert.equal(options.ManageMessages, null);
  } finally {
    f.store.close();
  }
});
test('channel lock and unlock restore the full exact overwrite snapshot', async () => {
  const f = fixture();
  try {
    f.channel.permissionOverwrites.cache.set(GUILD, {
      allow: new PermissionsBitField(P.SendMessages),
      deny: new PermissionsBitField(P.CreatePrivateThreads),
    });
    Object.assign(f.channel.permissionOverwrites, {
      set: async (values: { id: string; type: number; allow: bigint; deny: bigint }[]) => {
        f.calls.push({ name: 'overwrite.set', input: values });
        f.channel.permissionOverwrites.cache.clear();
        for (const value of values)
          f.channel.permissionOverwrites.cache.set(
            value.id,
            Object.assign(
              { allow: new PermissionsBitField(value.allow), deny: new PermissionsBitField(value.deny) },
              { type: value.type },
            ),
          );
      },
    });
    await f.run('channel.lock', { channelId: CHANNEL });
    await assert.rejects(f.run('channel.lock', { channelId: CHANNEL }), /saved lock already exists/);
    await f.run('channel.unlock', { channelId: CHANNEL });
    const call = f.calls.at(-1);
    assert.equal(call?.name, 'overwrite.set');
    const previous = call?.input as { id: string; allow: bigint; deny: bigint }[];
    assert.deepEqual(previous, [{ id: GUILD, type: 0, allow: P.SendMessages, deny: P.CreatePrivateThreads }]);
    assert.equal(f.store.get('discord.channel-locks', `${GUILD}:${CHANNEL}`), undefined);
  } finally {
    f.store.close();
  }
});
test('webhook.list never serializes execution credentials', async () => {
  const f = fixture();
  try {
    const result = JSON.stringify(await f.run('webhook.list', {}));
    assert.ok(result.includes('announce'));
    assert.ok(!result.includes('secret'));
    assert.ok(!result.includes('token'));
    assert.ok(!result.includes('url'));
  } finally {
    f.store.close();
  }
});
test('event.create rejects past starts, reversed end times and incomplete external events', async () => {
  const f = fixture();
  try {
    const future = new Date(Date.now() + 3600000).toISOString();
    await assert.rejects(
      f.run('event.create', {
        name: 'test',
        kind: 'external',
        startTime: '2020-01-01T00:00:00Z',
      }),
      /future/,
    );
    await assert.rejects(
      f.run('event.create', {
        name: 'test',
        kind: 'external',
        startTime: future,
      }),
      /location and end/,
    );
    await assert.rejects(
      f.run('event.create', {
        name: 'test',
        kind: 'external',
        startTime: future,
        endTime: future,
        location: 'park',
      }),
      /after its start/,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('event.create maps valid external events into Discord entity metadata', async () => {
  const f = fixture();
  try {
    const startTime = new Date(Date.now() + 3600000).toISOString(),
      endTime = new Date(Date.now() + 7200000).toISOString();
    await f.run('event.create', {
      name: 'test',
      kind: 'external',
      startTime,
      endTime,
      location: 'park',
    });
    const call = f.calls[0];
    assert.equal(call?.name, 'event.create');
    assert.deepEqual((call?.input as { entityMetadata: unknown }).entityMetadata, { location: 'park' });
  } finally {
    f.store.close();
  }
});
test('automod.create validates trigger content, action presence and timeout compatibility', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.run('automod.create', { name: 'test', trigger: 'keywords' }), /require keywords/);
    await assert.rejects(
      f.run('automod.create', {
        name: 'test',
        trigger: 'spam',
        timeoutSeconds: 60,
      }),
      /Timeout actions/,
    );
    await assert.rejects(
      f.run('automod.create', {
        name: 'test',
        trigger: 'spam',
        blockMessage: false,
      }),
      /at least one/,
    );
    assert.equal(f.calls.length, 0);
  } finally {
    f.store.close();
  }
});
test('automod.create sends native mention protection without constructing user-supplied regular expressions locally', async () => {
  const f = fixture();
  try {
    await f.run('automod.create', {
      name: 'mention guard',
      trigger: 'mentions',
      mentionLimit: 5,
    });
    const call = f.calls[0];
    assert.equal(call?.name, 'automod.create');
    assert.deepEqual((call?.input as { triggerMetadata: unknown }).triggerMetadata, {
      mentionTotalLimit: 5,
      mentionRaidProtectionEnabled: true,
    });
  } finally {
    f.store.close();
  }
});
test('visual schemas reject filesystem paths, HTTP URLs and nonimage data', () => {
  const f = fixture();
  try {
    const schema = f.registry.get('guild.visual').schema;
    for (const image of ['C:\\secrets.env', 'https://evil.test/icon.png', 'data:text/plain;base64,YWJj'])
      assert.throws(() => schema.parse({ kind: 'icon', image }));
  } finally {
    f.store.close();
  }
});
