import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelType,
  PermissionFlagsBits as P,
  PermissionsBitField,
  type GuildMember,
  type Role,
} from 'discord.js';
import { z } from 'zod';
import { Store } from '../src/core/store.js';
import { ActionRegistry, type ActionOutcome } from '../src/core/registry.js';
import { AiLimits, Cooldowns } from '../src/core/limits.js';
import { csv, discordAttachmentUrl, downloadAttachment } from '../src/core/files.js';
import {
  assertHierarchy,
  assertPermissions,
  assertRoleHierarchy,
  freshContext,
  resolveChannel,
  resolveMember,
  resolveRole,
} from '../src/core/permissions.js';
import { credentialPresent, loadConfig } from '../src/config.js';
import type { ActionContext } from '../src/core/types.js';

const GUILD = '200000000000000001',
  USER = '200000000000000002',
  CHANNEL = '200000000000000003';
const OTHER = '200000000000000004',
  BOT = '200000000000000005',
  TARGET_CHANNEL = '200000000000000006';
function storeFixture(t: TestContext): Store {
  const store = new Store(':memory:');
  t.after(() => store.close());
  return store;
}
function registryFixture(
  t: TestContext,
  guard: ConstructorParameters<typeof ActionRegistry>[1] = async (ctx) => ctx,
) {
  const store = storeFixture(t),
    effects: string[] = [];
  const ctx = {
    guild: { id: GUILD },
    member: { id: USER },
    channelId: CHANNEL,
    store,
  } as unknown as ActionContext;
  const registry = new ActionRegistry(120, guard);
  registry.register({
    id: 'test.change',
    description: 'A guarded write',
    category: 'testing',
    risk: 'write',
    userPermissions: [],
    botPermissions: [],
    schema: z.strictObject({ name: z.string().min(1).max(20) }),
    execute: (_ctx, input) => {
      effects.push(input.name);
      return input.name;
    },
  });
  return { store, ctx, registry, effects };
}
function confirmation(outcome: ActionOutcome): string {
  assert.equal(outcome.status, 'confirmation');
  if (outcome.status !== 'confirmation') throw new Error('Expected confirmation');
  return outcome.id;
}
test('Per-action policy restrictions block channels/roles and revoke a pending write before execution', async (t) => {
  const f = registryFixture(t);
  Object.assign(f.ctx.member, { roles: { cache: new Map([['allowed-role', {}]]) } });
  const key = `${GUILD}:test.change`;
  f.store.set('core.actionPolicies', key, {
    enabled: true,
    roleIds: ['allowed-role'],
    channelIds: [TARGET_CHANNEL],
  });
  await assert.rejects(() => f.registry.request(f.ctx, 'test.change', { name: 'blocked' }), /channel/);
  f.store.set('core.actionPolicies', key, { enabled: true, roleIds: ['other-role'], channelIds: [CHANNEL] });
  await assert.rejects(() => f.registry.request(f.ctx, 'test.change', { name: 'blocked' }), /roles/);
  f.store.set('core.actionPolicies', key, {
    enabled: true,
    roleIds: ['allowed-role'],
    channelIds: [CHANNEL],
  });
  const pending = await f.registry.request(f.ctx, 'test.change', { name: 'allowed' });
  f.store.set('core.actionPolicies', key, { enabled: false, roleIds: [], channelIds: [] });
  await assert.rejects(() => f.registry.confirm(f.ctx, confirmation(pending)), /disabled/);
  assert.deepEqual(f.effects, []);
});
test('Action policy is checked against fresh membership after awaited authorization', async (t) => {
  const f = registryFixture(t, async (ctx) => ({
    ...ctx,
    member: { ...ctx.member, roles: { cache: new Map() } } as unknown as GuildMember,
  }));
  Object.assign(f.ctx.member, { roles: { cache: new Map([['allowed-role', {}]]) } });
  f.store.set('core.actionPolicies', `${GUILD}:test.change`, {
    enabled: true,
    roleIds: ['allowed-role'],
    channelIds: [],
  });
  await assert.rejects(() => f.registry.request(f.ctx, 'test.change', { name: 'blocked' }), /roles/);
  assert.deepEqual(f.effects, []);
});
function position(value: number) {
  return { position: value, comparePositionTo: (other: { position: number }) => value - other.position };
}
function permissionFixture(t: TestContext) {
  const store = storeFixture(t),
    userPerms = new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory, P.ManageMessages]),
    botPerms = new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory, P.ManageMessages]);
  const member = { id: USER, permissions: userPerms, roles: { highest: position(20) } };
  const bot = { id: BOT, permissions: botPerms, roles: { highest: position(30) } };
  const target = {
    id: OTHER,
    permissions: new PermissionsBitField(P.ViewChannel),
    roles: { highest: position(10) },
    guild: { id: GUILD },
  };
  const channelPerms = new Map([
    [USER, new PermissionsBitField(userPerms)],
    [BOT, new PermissionsBitField(botPerms)],
  ]);
  const channel = {
    id: CHANNEL,
    guildId: GUILD,
    type: ChannelType.GuildText as number,
    permissionsFor: (who: { id: string }) => channelPerms.get(who.id),
    members: { fetch: async () => null as unknown },
  };
  const channels = new Map<string, typeof channel>([[CHANNEL, channel]]);
  const role = { id: '200000000000000007', managed: false, guild: { id: GUILD }, ...position(10) };
  const guild = {
    id: GUILD,
    ownerId: 'owner',
    channels: { fetch: async (id: string) => channels.get(id) ?? null },
    members: { me: bot, fetchMe: async () => bot, fetch: async () => target },
    roles: { fetch: async () => role },
  };
  const ctx = { guild, member, store, channelId: CHANNEL } as unknown as ActionContext;
  return { ctx, guild, member, bot, target, channel, channelPerms, channels, role };
}

test('Store isolates namespaces, treats prefix metacharacters literally, and parameterizes hostile keys', (t) => {
  const store = storeFixture(t);
  store.set('one', 'a_%:1', { value: 1 });
  store.set('one', 'abc:2', { value: 2 });
  store.set('two', 'a_%:1', { value: 3 });
  store.set('one', "'; DROP TABLE kv; --", { safe: true });
  assert.deepEqual(store.list('one', 'a_%:'), [{ key: 'a_%:1', value: { value: 1 } }]);
  assert.deepEqual(store.get('two', 'a_%:1'), { value: 3 });
  assert.deepEqual(store.get('one', "'; DROP TABLE kv; --"), { safe: true });
  const value = store.get<{ value: number }>('one', 'a_%:1')!;
  value.value = 99;
  assert.equal(store.get<{ value: number }>('one', 'a_%:1')?.value, 1);
});

test('Store rolls back multi-record failures and remains usable after rollback', (t) => {
  const store = storeFixture(t);
  store.set('test', 'before', 1);
  assert.throws(
    () =>
      store.transaction(() => {
        store.set('test', 'before', 2);
        store.set('test', 'new', 3);
        throw new Error('abort');
      }),
    /abort/,
  );
  assert.equal(store.get('test', 'before'), 1);
  assert.equal(store.get('test', 'new'), undefined);
  store.transaction(() => {
    store.set('test', 'after', 4);
  });
  assert.equal(store.get('test', 'after'), 4);
  assert.throws(() => store.set('test', 'undefined', undefined), /undefined/);
});

test('Store forbids asynchronous transactions including nested calls and rolls back their synchronous writes', (t) => {
  const store = storeFixture(t);
  assert.throws(
    () =>
      store.transaction(async () => {
        store.set('test', 'async', 1);
      }),
    /synchronous/,
  );
  assert.equal(store.get('test', 'async'), undefined);
  assert.throws(
    () =>
      store.transaction(() =>
        store.transaction(async () => {
          store.set('test', 'nested', 2);
        }),
      ),
    /synchronous/,
  );
  assert.equal(store.get('test', 'nested'), undefined);
});

test('Store retention prunes old AI context and audit events while keeping durable community state', (t) => {
  const store = storeFixture(t),
    now = 1_800_000_000_000;
  store.set('ai.conversations', 'old', { text: 'old' });
  store.set('ai.documents', 'old', { text: 'old' });
  store.set('community.profiles', 'durable', { balance: 100 });
  store.db.prepare('UPDATE kv SET updated_at=?').run(now - 40 * 86_400_000);
  store.audit({ guildId: GUILD, userId: USER, action: 'testing', status: 'success' });
  store.db.prepare('UPDATE audit SET created_at=?').run(now - 40 * 86_400_000);
  store.prune(30, 7, now);
  assert.equal(store.get('ai.conversations', 'old'), undefined);
  assert.equal(store.get('ai.documents', 'old'), undefined);
  assert.deepEqual(store.get('community.profiles', 'durable'), { balance: 100 });
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM audit').get()?.n, 0);
});

test('Registry validates strict arguments before calling authorization or producing a confirmation', async (t) => {
  let checks = 0;
  const { registry, ctx, store } = registryFixture(t, async (context) => {
    checks++;
    return context;
  });
  await assert.rejects(() => registry.request(ctx, 'test.change', { name: 'valid', unexpected: true }));
  await assert.rejects(() => registry.request(ctx, 'test.change', { name: '' }));
  assert.equal(checks, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM confirmations').get()?.n, 0);
});

test('Registry serializes the reviewed arguments independently of subsequent caller mutations', async (t) => {
  const { registry, ctx, effects } = registryFixture(t),
    input = { name: 'reviewed' };
  const outcome = await registry.request(ctx, 'test.change', input),
    token = confirmation(outcome);
  input.name = 'changed';
  if (outcome.status === 'confirmation') (outcome.input as { name: string }).name = 'also changed';
  await registry.confirm(ctx, token);
  assert.deepEqual(effects, ['reviewed']);
});

test('Registry binds confirmations to actor, guild, and channel without consuming legitimate ownership', async (t) => {
  const { registry, ctx, effects } = registryFixture(t),
    token = confirmation(await registry.request(ctx, 'test.change', { name: 'yes' }));
  for (const altered of [
    { ...ctx, member: { id: OTHER } },
    { ...ctx, guild: { id: 'different' } },
    { ...ctx, channelId: TARGET_CHANNEL },
  ]) {
    await assert.rejects(() => registry.confirm(altered as ActionContext, token), /unavailable|belongs/);
  }
  assert.deepEqual(effects, []);
  await registry.confirm(ctx, token);
  assert.deepEqual(effects, ['yes']);
});

test('Registry expiration and cancellation prevent side effects and replay', async (t) => {
  const { registry, ctx, store, effects } = registryFixture(t);
  const expired = confirmation(await registry.request(ctx, 'test.change', { name: 'expired' }));
  store.db.prepare('UPDATE confirmations SET expires_at=0 WHERE id=?').run(expired);
  await assert.rejects(() => registry.confirm(ctx, expired), /expired/);
  const cancelled = confirmation(await registry.request(ctx, 'test.change', { name: 'cancelled' }));
  assert.equal(registry.cancel({ ...ctx, member: { id: OTHER } } as ActionContext, cancelled), false);
  assert.equal(registry.cancel(ctx, cancelled), true);
  await assert.rejects(() => registry.confirm(ctx, cancelled), /unavailable/);
  assert.deepEqual(effects, []);
});

test('Concurrent confirmation clicks execute the side effect exactly once', async (t) => {
  const { registry, ctx, effects } = registryFixture(t, async (context) => {
    await new Promise((resolve) => setImmediate(resolve));
    return context;
  });
  const token = confirmation(await registry.request(ctx, 'test.change', { name: 'once' }));
  const results = await Promise.allSettled([
    registry.confirm(ctx, token),
    registry.confirm(ctx, token),
    registry.confirm(ctx, token),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.deepEqual(effects, ['once']);
});

test('Registry rechecks permissions on confirmation and preserves pending intent after denial', async (t) => {
  let allowed = true;
  const { registry, ctx, effects } = registryFixture(t, async (context) => {
    if (!allowed) throw new Error('permission revoked');
    return context;
  });
  const token = confirmation(await registry.request(ctx, 'test.change', { name: 'authorized' }));
  allowed = false;
  await assert.rejects(() => registry.confirm(ctx, token), /revoked/);
  assert.deepEqual(effects, []);
  allowed = true;
  await registry.confirm(ctx, token);
  assert.deepEqual(effects, ['authorized']);
});

test('Registry disables a category for new requests and already-pending confirmations', async (t) => {
  const { registry, ctx, store, effects } = registryFixture(t);
  const token = confirmation(await registry.request(ctx, 'test.change', { name: 'pending' }));
  store.set('core.disabled', GUILD, ['testing']);
  await assert.rejects(() => registry.request(ctx, 'test.change', { name: 'new' }), /disabled/);
  await assert.rejects(() => registry.confirm(ctx, token), /disabled/);
  assert.deepEqual(effects, []);
});

test('Registry refuses confirmations that expire while authorization is awaiting I/O', async (t) => {
  let paused = false,
    release!: () => void;
  const { registry, ctx, store, effects } = registryFixture(t, async (context) => {
    if (paused)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return context;
  });
  const token = confirmation(await registry.request(ctx, 'test.change', { name: 'late' }));
  paused = true;
  const pending = registry.confirm(ctx, token);
  store.db.prepare('UPDATE confirmations SET expires_at=0 WHERE id=?').run(token);
  release();
  await assert.rejects(() => pending, /expired|unavailable|confirmed/);
  assert.deepEqual(effects, []);
});

test('Registry honors category disable that occurs while authorization is awaiting I/O', async (t) => {
  let paused = false,
    release!: () => void;
  const { registry, ctx, store, effects } = registryFixture(t, async (context) => {
    if (paused)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return context;
  });
  const token = confirmation(await registry.request(ctx, 'test.change', { name: 'late' }));
  paused = true;
  const pending = registry.confirm(ctx, token);
  store.set('core.disabled', GUILD, ['testing']);
  release();
  await assert.rejects(() => pending, /disabled/);
  assert.deepEqual(effects, []);
});

test('Failed confirmed actions are not replayed and audit logs redact provider error messages', async (t) => {
  const { registry, ctx, store } = registryFixture(t);
  let calls = 0;
  registry.register({
    id: 'test.fail',
    description: 'Fail',
    category: 'testing',
    risk: 'write',
    schema: z.strictObject({}),
    userPermissions: [],
    botPermissions: [],
    execute: () => {
      calls++;
      throw new Error('request included a sensitive credential');
    },
  });
  const token = confirmation(await registry.request(ctx, 'test.fail', {}));
  await assert.rejects(() => registry.confirm(ctx, token), /sensitive credential/);
  await assert.rejects(() => registry.confirm(ctx, token), /unavailable/);
  assert.equal(calls, 1);
  const row = store.db
    .prepare("SELECT detail FROM audit WHERE action='test.fail' AND status='failure'")
    .get();
  assert.equal(row?.detail, 'Error');
});

test('Registry rejects duplicate and malformed action identifiers', (t) => {
  const { registry } = registryFixture(t),
    existing = registry.get('test.change');
  assert.throws(() => registry.register(existing), /duplicate/);
  assert.throws(() => registry.register({ ...existing, id: '../unsafe' }), /Invalid/);
});

test('AI concurrency blocks the same user and global overload; idempotent release never underflows', (t) => {
  const store = storeFixture(t),
    limits = new AiLimits(store, {
      maxAiConcurrent: 2,
      maxAiRequestsPerUserDay: 10,
      maxAiRequestsPerGuildDay: 10,
    });
  const first = limits.enter(GUILD, USER);
  assert.throws(() => limits.enter(GUILD, USER), /busy/);
  const second = limits.enter(GUILD, OTHER);
  assert.throws(() => limits.enter('other-guild', 'third'), /busy/);
  first();
  first();
  const third = limits.enter('other-guild', 'third');
  assert.throws(() => limits.enter('other-guild', 'fourth'), /busy/);
  second();
  third();
});

test('AI daily guild-limit failure rolls back the attempted user quota increment', (t) => {
  const store = storeFixture(t),
    limits = new AiLimits(store, {
      maxAiConcurrent: 3,
      maxAiRequestsPerUserDay: 5,
      maxAiRequestsPerGuildDay: 1,
    });
  limits.enter(GUILD, USER)();
  assert.throws(() => limits.enter(GUILD, OTHER), /allowance/);
  assert.equal(
    store.db.prepare('SELECT count FROM quota WHERE scope=?').get(`user:${GUILD}:${OTHER}`),
    undefined,
  );
  assert.equal(
    store.db.prepare('SELECT count FROM quota WHERE scope=?').get(`user:${GUILD}:${USER}`)?.count,
    1,
  );
});

test('AI per-user quotas survive limiter reconstruction and reset at UTC midnight', (t) => {
  const store = storeFixture(t),
    options = { maxAiConcurrent: 2, maxAiRequestsPerUserDay: 1, maxAiRequestsPerGuildDay: 5 };
  const beforeMidnight = Date.parse('2026-10-28T23:59:59Z');
  new AiLimits(store, options).enter(GUILD, USER, beforeMidnight)();
  const next = new AiLimits(store, options);
  assert.throws(() => next.enter(GUILD, USER, beforeMidnight), /allowance/);
  next.enter(GUILD, USER, beforeMidnight + 1000)();
});

test('Cooldowns reject bursts and allow the exact expiration boundary', () => {
  const cooldown = new Cooldowns();
  assert.equal(cooldown.take('user', 1000, 0), true);
  assert.equal(cooldown.take('user', 1000, 999), false);
  assert.equal(cooldown.take('user', 1000, 1000), true);
});

test('Config parses strict booleans and bounds instead of silently enabling privileged intents', () => {
  const config = loadConfig({});
  assert.equal(config.enableMessageContent, false);
  assert.equal(config.enableMembers, false);
  assert.throws(() => loadConfig({ ENABLE_MEMBERS: 'yes' }));
  assert.throws(() => loadConfig({ MAX_AI_CONCURRENT: '0' }));
  assert.throws(() => loadConfig({ DISCORD_GUILD_IDS: 'not-an-id' }));
  assert.equal(
    loadConfig({
      ENABLE_MEMBERS: 'true',
      DISCORD_GUILD_IDS: `${GUILD}, ${OTHER}`,
      DISCORD_BOT_TOKEN: 'legacy-token',
    }).discordToken,
    'legacy-token',
  );
  assert.equal(
    loadConfig({ DISCORD_TOKEN: 'current-token', DISCORD_BOT_TOKEN: 'legacy-token' }).discordToken,
    'current-token',
  );
});

test('Credential presence rejects placeholders without requiring live authentication', () => {
  assert.equal(credentialPresent(''), false);
  assert.equal(credentialPresent('paste_your_token_here'), false);
  assert.equal(credentialPresent('a'.repeat(40)), true);
});

test('Attachment allowlist blocks local addresses, credentials, lookalike hosts, ports, and alternate paths', () => {
  for (const url of [
    'http://cdn.discordapp.com/attachments/1/file',
    'https://127.0.0.1/attachments/file',
    'https://cdn.discordapp.com.evil.example/attachments/file',
    'https://user:pass@cdn.discordapp.com/attachments/file',
    'https://cdn.discordapp.com:444/attachments/file',
    'https://cdn.discordapp.com/icons/1/file',
    'file:///attachments/file',
    'invalid',
  ])
    assert.throws(() => discordAttachmentUrl(url));
  assert.equal(
    discordAttachmentUrl('https://cdn.discordapp.com/attachments/1/file.png?ex=123').hostname,
    'cdn.discordapp.com',
  );
});

test('Attachment downloads prohibit redirects, enforce timeouts, and honor declared limits before buffering', async () => {
  let options: RequestInit | undefined;
  const fetcher = (async (_url: unknown, init?: RequestInit) => {
    options = init;
    return new Response(new Uint8Array(10), { headers: { 'content-length': '10' } });
  }) as typeof fetch;
  await assert.rejects(
    () => downloadAttachment('https://cdn.discordapp.com/attachments/1/a', 9, fetcher),
    /large/,
  );
  assert.equal(options?.redirect, 'error');
  assert.ok(options?.signal);
});

test('Attachment streaming limit stops undeclared oversized bodies and returns exact permitted bytes', async () => {
  const oversized = (async () => new Response(new Uint8Array(11))) as typeof fetch;
  await assert.rejects(
    () => downloadAttachment('https://media.discordapp.net/attachments/1/a', 10, oversized),
    /large/,
  );
  const exact = (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;
  assert.deepEqual(
    await downloadAttachment('https://cdn.discordapp.com/attachments/1/a', 3, exact),
    Buffer.from([1, 2, 3]),
  );
  const unavailable = (async () => new Response(null, { status: 503 })) as typeof fetch;
  await assert.rejects(
    () => downloadAttachment('https://cdn.discordapp.com/attachments/1/a', 10, unavailable),
    /503/,
  );
});

test('CSV quotes multiline data and neutralizes spreadsheet formula injection', () => {
  const output = csv([
    { title: '=HYPERLINK("bad")', note: 'line 1\nline 2' },
    { title: '  @SUM(A1)', note: '"quoted"', more: null },
  ]);
  assert.ok(output.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(output.includes('"\'  @SUM(A1)"'));
  assert.ok(output.includes('"line 1\nline 2"'));
  assert.ok(output.includes('"""quoted"""'));
  assert.equal(csv([]), '');
});

test('Channel resolution requires both user and bot visibility and rejects cross-guild resources', async (t) => {
  const { ctx, channel, channelPerms } = permissionFixture(t);
  channelPerms.set(USER, new PermissionsBitField(0n));
  await assert.rejects(() => resolveChannel(ctx, CHANNEL), /view/);
  channelPerms.set(USER, new PermissionsBitField(P.ViewChannel));
  channelPerms.set(BOT, new PermissionsBitField(0n));
  await assert.rejects(() => resolveChannel(ctx, CHANNEL), /view/);
  channelPerms.set(BOT, new PermissionsBitField(P.ViewChannel));
  channel.guildId = 'other';
  await assert.rejects(() => resolveChannel(ctx, CHANNEL), /server/);
});

test('Private-thread reads require membership when caller lacks Manage Threads', async (t) => {
  const { ctx, channel } = permissionFixture(t);
  channel.type = ChannelType.PrivateThread;
  await assert.rejects(() => resolveChannel(ctx, CHANNEL), /belong to that private thread/);
  channel.members.fetch = async () => ({ id: USER });
  assert.equal((await resolveChannel(ctx, CHANNEL)).id, CHANNEL);
});

test('Permission guard checks referenced target channels as well as invocation channel and guild permissions', async (t) => {
  const { ctx, channel, channels, channelPerms, member } = permissionFixture(t);
  channels.set(TARGET_CHANNEL, {
    ...channel,
    id: TARGET_CHANNEL,
    permissionsFor: () => new PermissionsBitField(P.ViewChannel),
  });
  await assert.rejects(
    () => assertPermissions(ctx, [P.ManageMessages], [P.ManageMessages], { targetChannelId: TARGET_CHANNEL }),
    /permissions in that channel/,
  );
  channels.delete(TARGET_CHANNEL);
  member.permissions.remove(P.ManageMessages);
  await assertPermissions(ctx, [P.ManageMessages], [], {}); // Explicit channel grants are sufficient for channel-scoped permissions.
  await assert.rejects(() => assertPermissions(ctx, [P.ManageRoles], [], {}), /server permissions/);
  await assert.rejects(() => assertPermissions(ctx, [], [P.ManageRoles], {}), /bot lacks/);
  channelPerms.set(USER, new PermissionsBitField(P.ViewChannel));
  await assert.rejects(
    () => assertPermissions(ctx, [P.ManageMessages], [], {}),
    /permissions in that channel/,
  );
});

test('Hierarchy checks protect owner, self, bot, peers, managed roles, and bot role boundary', (t) => {
  const { ctx, guild, target, role, member, bot } = permissionFixture(t);
  assertHierarchy(ctx, target as unknown as GuildMember);
  assertRoleHierarchy(ctx, role as unknown as Role);
  for (const id of [USER, BOT, guild.ownerId])
    assert.throws(() => assertHierarchy(ctx, { ...target, id } as unknown as GuildMember));
  target.roles.highest = position(20);
  assert.throws(() => assertHierarchy(ctx, target as unknown as GuildMember), /Your highest/);
  member.roles.highest = position(40);
  target.roles.highest = position(30);
  assert.throws(() => assertHierarchy(ctx, target as unknown as GuildMember), /bot/);
  role.managed = true;
  assert.throws(() => assertRoleHierarchy(ctx, role as unknown as Role), /Managed/);
  role.managed = false;
  bot.roles.highest = position(10);
  assert.throws(() => assertRoleHierarchy(ctx, role as unknown as Role), /bot/);
});

test('Member and role resolution reject mismatched guilds even when managers return an object', async (t) => {
  const { ctx, target, role } = permissionFixture(t);
  target.guild.id = 'wrong';
  role.guild.id = 'wrong';
  await assert.rejects(() => resolveMember(ctx, OTHER), /server/);
  await assert.rejects(() => resolveRole(ctx, role.id), /server/);
});

test('Fresh authorization refetches both member and bot and returns the refreshed actor', async (t) => {
  const { ctx, guild, target } = permissionFixture(t);
  let memberReads = 0,
    botReads = 0;
  guild.members.fetch = async () => {
    memberReads++;
    return target;
  };
  guild.members.fetchMe = async () => {
    botReads++;
    return guild.members.me;
  };
  const fresh = await freshContext(ctx);
  assert.equal(fresh.member.id, OTHER);
  assert.equal(memberReads, 1);
  assert.equal(botReads, 1);
});

test('Global attachment concurrency rejects excess work and releases every slot after completion', async () => {
  const releases: (() => void)[] = [];
  const fetcher = (async () => {
    await new Promise<void>((resolve) => releases.push(resolve));
    return new Response(new Uint8Array([1]));
  }) as typeof fetch;
  const pending = Array.from({ length: 4 }, () =>
    downloadAttachment('https://cdn.discordapp.com/attachments/1/file', 10, fetcher),
  );
  await assert.rejects(
    downloadAttachment('https://cdn.discordapp.com/attachments/1/file', 10, fetcher),
    /busy/,
  );
  releases.forEach((release) => release());
  await Promise.all(pending);
  assert.deepEqual(
    await downloadAttachment(
      'https://cdn.discordapp.com/attachments/1/file',
      10,
      (async () => new Response(new Uint8Array([2]))) as typeof fetch,
    ),
    Buffer.from([2]),
  );
});

test('Mixed cooldown durations remain active when the bounded cache is saturated', () => {
  const cooldowns = new Cooldowns();
  for (let i = 0; i < 10000; i++) assert.equal(cooldowns.take(`message:${i}`, 3000, 1000), true);
  assert.equal(cooldowns.take('slash:new', 750, 1800), false);
  assert.equal(cooldowns.take('message:0', 3000, 1800), false);
  assert.equal(cooldowns.take('slash:new', 750, 4000), true);
});
