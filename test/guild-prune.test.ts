import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { ActionRegistry, type ActionOutcome } from '../src/core/registry.js';
import { Store } from '../src/core/store.js';
import type { ActionContext } from '../src/core/types.js';
import { registerGuildActions } from '../src/discord/actions/guild.js';

const GUILD = '700000000000000001',
  OWNER = '700000000000000002',
  OTHER = '700000000000000003',
  BOT = '700000000000000004',
  CHANNEL = '700000000000000005',
  ROLE = '700000000000000006';
interface PruneOptions {
  days?: number;
  roles?: string[];
  dry?: boolean;
  count?: boolean;
  reason?: string;
}
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const highest = (position: number) => ({
    position,
    comparePositionTo: (role: { position: number }) => position - role.position,
  });
  const makeMember = (id: string, permissions: bigint | bigint[], position: number) => ({
    id,
    permissions: new PermissionsBitField(permissions),
    roles: { highest: highest(position), cache: new Map() },
  });
  let actor = makeMember(OWNER, P.Administrator, 50),
    bot = makeMember(BOT, [P.ViewChannel, P.ManageGuild, P.KickMembers], 100),
    count = 5,
    guildReads = 0;
  const originalActor = actor,
    hidden = new Set<string>(),
    calls: PruneOptions[] = [],
    memberReads: unknown[] = [],
    botReads: unknown[] = [];
  const role = { id: ROLE, guild: { id: GUILD }, position: 10, managed: false };
  const hooks: { guildFetch?: (call: number) => Promise<void> | void; dry?: () => Promise<void> | void } = {};
  const channel = {
    id: CHANNEL,
    guildId: GUILD,
    type: ChannelType.GuildText,
    permissionsFor: (member: { id: string; permissions: PermissionsBitField }) =>
      new PermissionsBitField(hidden.has(member.id) ? 0n : member.permissions),
  };
  const guild = {
    id: GUILD,
    ownerId: OWNER,
    features: [] as string[],
    fetch: async () => {
      guildReads++;
      await hooks.guildFetch?.(guildReads);
      return guild;
    },
    members: {
      me: bot,
      fetch: async (input: string | { user: string; force?: boolean }) => {
        memberReads.push(input);
        if ((typeof input === 'string' ? input : input.user) !== OWNER) throw new Error('Unexpected member');
        return actor;
      },
      fetchMe: async (input?: { force?: boolean }) => {
        botReads.push(input);
        guild.members.me = bot;
        return bot;
      },
      prune: async (input: PruneOptions) => {
        calls.push(input);
        if (input.dry) {
          await hooks.dry?.();
          return count;
        }
        return null;
      },
    },
    channels: { fetch: async (id: string) => (id === CHANNEL ? channel : null) },
    roles: { fetch: async (id: string) => (id === role.id ? role : null) },
  };
  const registry = new ActionRegistry();
  registerGuildActions(registry);
  const ctx = {
    store,
    guild,
    member: originalActor,
    channelId: CHANNEL,
    client: {},
  } as unknown as ActionContext;
  const request = (action: string, input: unknown = {}) => registry.request(ctx, action, input);
  const pending = async (input: unknown = { days: 7, expectedCount: 5 }) => {
    const outcome = await request('guild.prune', input);
    if (outcome.status !== 'confirmation') throw new Error('Expected prune confirmation');
    return outcome;
  };
  return {
    store,
    registry,
    ctx,
    guild,
    role,
    hidden,
    hooks,
    calls,
    memberReads,
    botReads,
    request,
    pending,
    setCount: (value: number) => {
      count = value;
    },
    setActorPermissions: (value: bigint | bigint[]) => {
      actor = makeMember(OWNER, value, 50);
    },
    setBotPermissions: (value: bigint | bigint[]) => {
      bot = makeMember(BOT, value, 100);
      guild.members.me = bot;
    },
    dryCalls: () => calls.filter((call) => call.dry === true),
    writes: () => calls.filter((call) => call.dry !== true),
    guildReads: () => guildReads,
  };
}
function completed(outcome: ActionOutcome): unknown {
  assert.equal(outcome.status, 'completed');
  if (outcome.status !== 'completed') throw new Error('Expected completion');
  return outcome.result;
}

test('Native prune preview reads fresh count without confirmation or destructive mutation', async (t) => {
  const f = fixture(t);
  const result = completed(await f.request('guild.prune-count', { days: 14, roleIds: [ROLE] })) as {
    count: number;
    days: number;
    roleIds: string[];
  };
  assert.equal(result.count, 5);
  assert.equal(result.days, 14);
  assert.deepEqual(result.roleIds, [ROLE]);
  assert.deepEqual(f.calls, [{ days: 14, roles: [ROLE], dry: true }]);
  assert.equal(f.writes().length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM confirmations').get()!.count, 0);
  assert.equal(f.guildReads(), 1);
  assert.ok(f.memberReads.every((input) => (input as { force: boolean }).force === true));
  assert.ok(f.botReads.every((input) => (input as { force: boolean }).force === true));
});

test('Native prune only writes after exact registry confirmation and returns unknown final prune count', async (t) => {
  const f = fixture(t);
  const pending = await f.pending({
    days: 10,
    roleIds: [ROLE],
    expectedCount: 5,
    reason: 'Reviewed inactive members',
  });
  assert.equal(f.calls.length, 0);
  assert.equal(f.guildReads(), 0);
  assert.equal(pending.action, 'guild.prune');
  const result = completed(await f.registry.confirm(f.ctx, pending.id)) as {
    started: boolean;
    previewCount: number;
    pruned: number | null;
  };
  assert.deepEqual(
    { started: result.started, previewCount: result.previewCount, pruned: result.pruned },
    { started: true, previewCount: 5, pruned: null },
  );
  assert.deepEqual(f.dryCalls(), [{ days: 10, roles: [ROLE], dry: true }]);
  assert.equal(f.writes().length, 1);
  assert.equal(f.guildReads(), 2);
  assert.deepEqual(f.writes()[0], {
    days: 10,
    roles: [ROLE],
    count: false,
    reason: `Reviewed inactive members [requested by ${OWNER}]`,
  });
  await assert.rejects(() => f.registry.confirm(f.ctx, pending.id), /unavailable|already/);
  assert.equal(f.writes().length, 1);
});

test('A nonowner may preview with permissions but cannot execute the native prune', async (t) => {
  const f = fixture(t);
  f.guild.ownerId = OTHER;
  assert.equal((completed(await f.request('guild.prune-count')) as { count: number }).count, 5);
  f.calls.length = 0;
  const pending = await f.pending();
  await assert.rejects(() => f.registry.confirm(f.ctx, pending.id), /Only the server owner/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes().length, 0);
});

test('Changed preview count consumes the confirmed intent without starting destructive work', async (t) => {
  const f = fixture(t);
  const preview = completed(await f.request('guild.prune-count')) as { count: number };
  const pending = await f.pending({ expectedCount: preview.count });
  f.setCount(6);
  await assert.rejects(() => f.registry.confirm(f.ctx, pending.id), /count changed to 6/);
  assert.equal(f.dryCalls().length, 2);
  assert.equal(f.writes().length, 0);
  await assert.rejects(() => f.registry.confirm(f.ctx, pending.id), /unavailable|already/);
});

test('Matching zero count performs only the dry request and has no destructive side effect', async (t) => {
  const f = fixture(t);
  f.setCount(0);
  const pending = await f.pending({ expectedCount: 0 });
  assert.deepEqual(completed(await f.registry.confirm(f.ctx, pending.id)), { started: false, pruned: 0 });
  assert.equal(f.dryCalls().length, 1);
  assert.equal(f.writes().length, 0);
  assert.equal(f.guildReads(), 1);
});

test('Native prune schemas reject unreviewed, malformed or oversized scope', (t) => {
  const f = fixture(t),
    write = f.registry.get('guild.prune').schema,
    read = f.registry.get('guild.prune-count').schema;
  assert.throws(() => write.parse({}));
  assert.throws(() => write.parse({ expectedCount: -1 }));
  assert.throws(() => write.parse({ expectedCount: 1.5 }));
  assert.throws(() => write.parse({ expectedCount: 5, days: 31 }));
  assert.throws(() => read.parse({ days: 0 }));
  assert.throws(() => read.parse({ roleIds: [ROLE.repeat(2)] }));
  assert.throws(() => read.parse({ roleIds: Array(26).fill(ROLE) }));
  assert.throws(() => read.parse({ expectedCount: 5 }));
  assert.deepEqual(read.parse({}), { days: 7, roleIds: [] });
  assert.equal(f.calls.length, 0);
});

test('Supplied roles respect current bot/requester hierarchy and reject managed/everyone targets', async (t) => {
  for (const mode of ['bot', 'requester', 'managed', 'everyone'] as const)
    await t.test(mode, async (sub) => {
      const f = fixture(sub);
      let roleId = ROLE;
      if (mode === 'bot') f.role.position = 100;
      if (mode === 'requester') {
        f.guild.ownerId = OTHER;
        f.role.position = 50;
      }
      if (mode === 'managed') f.role.managed = true;
      if (mode === 'everyone') {
        f.role.id = GUILD;
        roleId = GUILD;
      }
      await assert.rejects(
        () => f.request('guild.prune-count', { roleIds: [roleId] }),
        /highest role|above|Managed and everyone/,
      );
      assert.equal(f.calls.length, 0);
    });
});

test('Role changes between preview/confirmation or during the dry count stop destructive work', async (t) => {
  const before = fixture(t);
  const pending = await before.pending({ roleIds: [ROLE], expectedCount: 5 });
  before.role.position = 100;
  await assert.rejects(() => before.registry.confirm(before.ctx, pending.id), /highest role|above/);
  assert.equal(before.calls.length, 0);
  const during = fixture(t);
  const second = await during.pending({ roleIds: [ROLE], expectedCount: 5 });
  during.hooks.dry = () => {
    during.role.position = 100;
  };
  await assert.rejects(() => during.registry.confirm(during.ctx, second.id), /highest role|above/);
  assert.equal(during.dryCalls().length, 1);
  assert.equal(during.writes().length, 0);
});

test('PRUNE_REQUIRES_ADMIN is fetched fresh and enforced for both preview caller and bot', async (t) => {
  const caller = fixture(t);
  caller.guild.ownerId = OTHER;
  caller.setActorPermissions([P.ViewChannel, P.ManageGuild, P.KickMembers]);
  caller.setBotPermissions(P.Administrator);
  caller.hooks.guildFetch = () => {
    caller.guild.features = ['PRUNE_REQUIRES_ADMIN'];
  };
  await assert.rejects(() => caller.request('guild.prune-count'), /requires Administrator/);
  assert.equal(caller.calls.length, 0);
  const bot = fixture(t);
  bot.guild.features = ['PRUNE_REQUIRES_ADMIN'];
  const pending = await bot.pending();
  await assert.rejects(() => bot.registry.confirm(bot.ctx, pending.id), /requires Administrator/);
  assert.equal(bot.calls.length, 0);
  const allowed = fixture(t);
  allowed.guild.features = ['PRUNE_REQUIRES_ADMIN'];
  allowed.setBotPermissions(P.Administrator);
  const approved = await allowed.pending();
  assert.equal(
    (completed(await allowed.registry.confirm(allowed.ctx, approved.id)) as { started: boolean }).started,
    true,
  );
  assert.equal(allowed.writes().length, 1);
});

test('Current prune permissions are refreshed before confirmation and a denied confirmation remains pending', async (t) => {
  for (const principal of ['caller', 'bot'] as const)
    await t.test(principal, async (sub) => {
      const f = fixture(sub);
      const pending = await f.pending();
      if (principal === 'caller') f.setActorPermissions(P.ViewChannel);
      else f.setBotPermissions(P.ViewChannel);
      await assert.rejects(() => f.registry.confirm(f.ctx, pending.id), /required server permissions/);
      assert.equal(f.calls.length, 0);
      assert.ok(f.store.db.prepare('SELECT id FROM confirmations WHERE id=?').get(pending.id));
    });
});

test('Ownership transfer during final guild fetch or during native count cancels the bulk prune', async (t) => {
  for (const stage of ['initial-guild-fetch', 'final-guild-fetch', 'dry-count'] as const)
    await t.test(stage, async (sub) => {
      const f = fixture(sub);
      const pending = await f.pending();
      if (stage === 'dry-count')
        f.hooks.dry = () => {
          f.guild.ownerId = OTHER;
        };
      else
        f.hooks.guildFetch = (call) => {
          if (call === (stage === 'initial-guild-fetch' ? 1 : 2)) f.guild.ownerId = OTHER;
        };
      await assert.rejects(() => f.registry.confirm(f.ctx, pending.id), /Only the server owner/);
      assert.equal(f.writes().length, 0);
      assert.equal(f.dryCalls().length, stage === 'initial-guild-fetch' ? 0 : 1);
    });
});

test('Permission, source visibility, administrator flag and policy revocation during counting block the real prune', async (t) => {
  for (const change of [
    'bot-permission',
    'caller-permission',
    'source-visibility',
    'admin-flag',
    'action-policy',
  ] as const)
    await t.test(change, async (sub) => {
      const f = fixture(sub);
      const pending = await f.pending();
      f.hooks.dry = () => {
        if (change === 'bot-permission') f.setBotPermissions(P.ViewChannel);
        if (change === 'caller-permission') f.setActorPermissions(P.ViewChannel);
        if (change === 'source-visibility') f.hidden.add(OWNER);
        if (change === 'admin-flag') f.guild.features = ['PRUNE_REQUIRES_ADMIN'];
        if (change === 'action-policy')
          f.store.set('core.actionPolicies', `${GUILD}:guild.prune`, {
            enabled: false,
            roleIds: [],
            channelIds: [],
          });
      };
      await assert.rejects(
        () => f.registry.confirm(f.ctx, pending.id),
        /permissions|view|Administrator|disabled/i,
      );
      assert.equal(f.dryCalls().length, 1);
      assert.equal(f.writes().length, 0);
    });
});

test('Concurrent confirmation clicks can start at most one native bulk prune', async (t) => {
  const f = fixture(t),
    pending = await f.pending();
  const outcomes = await Promise.allSettled([
    f.registry.confirm(f.ctx, pending.id),
    f.registry.confirm(f.ctx, pending.id),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  assert.equal(f.dryCalls().length, 1);
  assert.equal(f.writes().length, 1);
});
