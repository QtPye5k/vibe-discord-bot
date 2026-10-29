import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection, PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { ActionRegistry } from '../src/core/registry.js';
import { Store } from '../src/core/store.js';
import type { ActionContext } from '../src/core/types.js';
import {
  applyLayoutBatch,
  canonicalLayout,
  captureLayout,
  diffLayouts,
  layoutDefinitionSchema,
  registerServerLayoutActions,
} from '../src/features/server-layout.js';

const GUILD = '520000000000000001',
  USER = '520000000000000002',
  BOT = '520000000000000003',
  CHANNEL = '520000000000000004',
  OTHER = '520000000000000005';
interface RoleRow {
  id: string;
  name: string;
  guild: { id: string };
  managed: boolean;
  position: number;
  permissions: PermissionsBitField;
  colors: { primaryColor: number };
  hoist: boolean;
  mentionable: boolean;
  edit: (data: Record<string, unknown>) => Promise<RoleRow>;
}
interface ChannelRow {
  id: string;
  guildId: string;
  name: string;
  type: number;
  parentId: string | null;
  position: number;
  topic: string | null;
  nsfw: boolean;
  rateLimitPerUser: number;
  permissionOverwrites: {
    cache: Collection<
      string,
      { id: string; type: number; allow: PermissionsBitField; deny: PermissionsBitField }
    >;
  };
  isThread: () => boolean;
  permissionsFor: (target: { id: string }) => PermissionsBitField;
}
interface Result {
  id: string;
  state: string;
  completed: number;
  total: number;
  inFlight: number | null;
  nextBatch: { planId: string; operations: unknown[] } | null;
  mapping: { roles: Record<string, string>; channels: Record<string, string> };
}
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const member = {
    id: USER,
    permissions: new PermissionsBitField(P.Administrator),
    roles: {
      highest: { position: 100, comparePositionTo: (role: { position: number }) => 100 - role.position },
    },
  };
  const bot = {
    ...member,
    id: BOT,
    roles: {
      highest: { position: 90, comparePositionTo: (role: { position: number }) => 90 - role.position },
    },
  };
  const roles = new Collection<string, RoleRow>(),
    channels = new Collection<string, ChannelRow>();
  const hooks: {
    roleCreate?: (role: RoleRow) => Promise<void> | void;
    channelFetch?: (id: string) => Promise<void> | void;
  } = {};
  const createdRoles: RoleRow[] = [],
    createdChannels: ChannelRow[] = [],
    edits: Record<string, unknown>[] = [];
  const hidden = new Set<string>();
  let sequence = 100,
    refreshes = 0;
  function role(data: Record<string, unknown> = {}): RoleRow {
    const row: RoleRow = {
      id: `520000000000000${sequence++}`,
      name: 'role',
      guild: { id: GUILD },
      managed: false,
      position: 1,
      permissions: new PermissionsBitField(0n),
      colors: { primaryColor: 0 },
      hoist: false,
      mentionable: false,
      edit: async (input) => {
        Object.assign(row, input);
        if (input.permissions !== undefined)
          row.permissions = new PermissionsBitField(input.permissions as bigint);
        edits.push(input);
        return row;
      },
    };
    Object.assign(row, data);
    if (data.permissions !== undefined) row.permissions = new PermissionsBitField(data.permissions as bigint);
    roles.set(row.id, row);
    return row;
  }
  function channel(data: Partial<ChannelRow> = {}): ChannelRow {
    const row: ChannelRow = {
      id: `520000000000000${sequence++}`,
      guildId: GUILD,
      name: 'channel',
      type: ChannelType.GuildText,
      parentId: null,
      position: 0,
      topic: null,
      nsfw: false,
      rateLimitPerUser: 0,
      permissionOverwrites: { cache: new Collection() },
      isThread: () => false,
      permissionsFor: (target) =>
        new PermissionsBitField(hidden.has(row.id) && target.id !== BOT ? 0n : P.Administrator),
      ...data,
    };
    channels.set(row.id, row);
    return row;
  }
  channel({ id: CHANNEL, name: 'commands' });
  const guild = {
    id: GUILD,
    ownerId: OTHER,
    name: 'Testing',
    description: null,
    verificationLevel: 0,
    defaultMessageNotifications: 0,
    explicitContentFilter: 0,
    afkTimeout: 300,
    systemChannelFlags: { bitfield: 0 },
    afkChannelId: null,
    systemChannelId: null,
    rulesChannelId: null,
    publicUpdatesChannelId: null,
    roles: {
      fetch: async (id?: string) => (id ? (roles.get(id) ?? null) : roles),
      create: async (data: Record<string, unknown>) => {
        const row = role(data);
        createdRoles.push(row);
        await hooks.roleCreate?.(row);
        return row;
      },
    },
    channels: {
      fetch: async (id?: string) => {
        if (!id) return channels;
        await hooks.channelFetch?.(id);
        if (!channels.has(id)) throw Object.assign(new Error('Unknown channel'), { code: 10003 });
        return channels.get(id)!;
      },
      create: async (data: Record<string, unknown>) => {
        const row = channel({
          name: String(data.name),
          type: Number(data.type),
          parentId: (data.parent as string | null) ?? null,
        });
        createdChannels.push(row);
        return row;
      },
      edit: async (id: string, data: Record<string, unknown>) => {
        const row = channels.get(id)!;
        Object.assign(row, data);
        if (data.parent !== undefined) row.parentId = data.parent as string | null;
        edits.push(data);
        return row;
      },
    },
    members: {
      me: bot,
      fetch: async (input: { user: string }) => {
        refreshes++;
        if (input.user !== USER) throw new Error('Unknown member');
        return member;
      },
      fetchMe: async () => bot,
    },
    fetch: async () => guild,
    edit: async (data: Record<string, unknown>) => {
      Object.assign(guild, data);
      edits.push(data);
      return guild;
    },
  };
  Object.assign(member, { guild });
  Object.assign(bot, { guild });
  const template = {
    name: 'Starter',
    code: 'starter',
    serializedGuild: {
      roles: [
        { id: 0, name: '@everyone', permissions: '0' },
        { id: 1, name: 'Member', permissions: P.ViewChannel.toString() },
      ],
      channels: [
        { id: 2, name: 'Category', type: ChannelType.GuildCategory },
        {
          id: 3,
          name: 'chat',
          type: ChannelType.GuildText,
          parent_id: 2,
          permission_overwrites: [
            { id: 0, type: 0, allow: '0', deny: '0' },
            { id: 1, type: 0, allow: P.ViewChannel.toString(), deny: '0' },
          ],
        },
      ],
    },
  };
  const client = { fetchGuildTemplate: async (_code: string) => template };
  const ctx = { guild, member, client, store, channelId: CHANNEL } as unknown as ActionContext;
  const registry = new ActionRegistry(120, async (context) => context);
  registerServerLayoutActions(registry);
  const execute = async <T = Result>(id: string, input: unknown = {}, context = ctx): Promise<T> => {
    const action = registry.get(id);
    return (await action.execute(context, action.schema.parse(input))) as T;
  };
  return {
    store,
    ctx,
    registry,
    execute,
    member,
    bot,
    guild,
    roles,
    channels,
    role,
    channel,
    hooks,
    createdRoles,
    createdChannels,
    edits,
    hidden,
    template,
    refreshes: () => refreshes,
  };
}
const roleLayout = (count = 1) => ({
  roles: Array.from({ length: count }, (_, index) => ({ key: `role_${index}`, name: `Role ${index}` })),
});

test('layout validation rejects dangling references, duplicates, unsafe flags and reserved role keys', () => {
  for (const value of [
    { settings: { afkChannelRef: 'missing' } },
    { channels: [{ key: 'a', name: 'a', type: 'category', parentRef: 'a' }] },
    {
      roles: [
        { key: 'a', name: 'a' },
        { key: 'a', name: 'b' },
      ],
    },
    {
      roles: [
        { key: 'a', name: 'a', existingId: USER },
        { key: 'b', name: 'b', existingId: USER },
      ],
    },
    { roles: [{ key: 'everyone', name: 'conflict' }] },
    { roles: [{ key: 'unknown', name: 'unknown', permissions: (1n << 100n).toString() }] },
    {
      channels: [
        { key: 'a', name: 'a', type: 'text', overwrites: [{ roleRef: 'everyone', allow: '1', deny: '1' }] },
      ],
    },
    { channels: [{ key: 'a', name: 'a', type: 'text', topic: 'x'.repeat(1025) }] },
  ])
    assert.equal(layoutDefinitionSchema.safeParse(value).success, false);
  assert.equal(
    layoutDefinitionSchema.safeParse({
      channels: [{ key: 'a', name: 'a', type: 'forum', topic: 'x'.repeat(4096) }],
    }).success,
    true,
  );
});

test('canonical comparison ignores object ordering but preserves array ordering', () => {
  assert.equal(canonicalLayout({ b: 2, a: { x: 1 } }), canonicalLayout({ a: { x: 1 }, b: 2 }));
  assert.notEqual(canonicalLayout([1, 2]), canonicalLayout([2, 1]));
  assert.equal(canonicalLayout({ a: undefined }), canonicalLayout({}));
  assert.deepEqual(diffLayouts({ settings: { name: 'old' } }, { settings: { name: 'new' } }), [
    { path: 'settings.name', before: 'old', after: 'new' },
  ]);
});

test('plans order dependencies without changing Discord and expose exact immutable operations', async (t) => {
  const f = fixture(t);
  const plan = await f.execute('layout.plan', {
    label: 'Community',
    layout: {
      roles: [{ key: 'member', name: 'Member' }],
      channels: [
        {
          key: 'chat',
          name: 'chat',
          type: 'text',
          parentRef: 'area',
          overwrites: [{ roleRef: 'member', allow: P.ViewChannel.toString() }],
        },
        { key: 'area', name: 'Area', type: 'category' },
      ],
      settings: { systemChannelRef: 'chat' },
    },
  });
  assert.equal(plan.total, 4);
  assert.deepEqual(
    plan.nextBatch!.operations.map((value) => (value as { kind: string }).kind),
    ['role', 'channel', 'channel', 'settings'],
  );
  assert.equal(f.createdRoles.length + f.createdChannels.length + f.edits.length, 0);
  const result = (await applyLayoutBatch(f.ctx, plan.id, plan.nextBatch!.operations)) as Result;
  assert.equal(result.state, 'done');
  assert.equal(f.createdChannels[1]!.parentId, f.createdChannels[0]!.id);
  assert.equal(result.mapping.roles.member, f.createdRoles[0]!.id);
});

test('modified or shortened review payloads are rejected before any API mutation', async (t) => {
  const f = fixture(t),
    plan = await f.execute('layout.plan', { label: 'Roles', layout: roleLayout(2) });
  await assert.rejects(applyLayoutBatch(f.ctx, plan.id, plan.nextBatch!.operations.slice(0, 1)), /differs/);
  const changed = structuredClone(plan.nextBatch!.operations) as { definition: { name: string } }[];
  changed[0]!.definition.name = 'unreviewed';
  await assert.rejects(applyLayoutBatch(f.ctx, plan.id, changed), /differs/);
  assert.equal(f.createdRoles.length, 0);
});

test('more than ten operations require another exact confirmed batch and fresh authority per operation', async (t) => {
  const f = fixture(t),
    plan = await f.execute('layout.plan', { label: 'Roles', layout: roleLayout(11) });
  const first = (await applyLayoutBatch(f.ctx, plan.id, plan.nextBatch!.operations)) as Result;
  assert.equal(first.completed, 10);
  assert.equal(first.state, 'ready');
  assert.equal(first.nextBatch!.operations.length, 1);
  const second = (await applyLayoutBatch(f.ctx, plan.id, first.nextBatch!.operations)) as Result;
  assert.equal(second.state, 'done');
  assert.equal(f.createdRoles.length, 11);
  assert.ok(f.refreshes() >= 12);
});

test('layout mutation goes through one-use requester and channel bound confirmation', async (t) => {
  const f = fixture(t),
    plan = await f.execute('layout.plan', { label: 'Roles', layout: roleLayout() });
  const pending = await f.registry.request(f.ctx, 'layout.apply', plan.nextBatch);
  assert.equal(pending.status, 'confirmation');
  assert.equal(f.createdRoles.length, 0);
  if (pending.status !== 'confirmation') throw new Error('Expected confirmation');
  await assert.rejects(
    f.registry.confirm({ ...f.ctx, channelId: OTHER }, pending.id),
    /another person\/channel/,
  );
  await f.registry.confirm(f.ctx, pending.id);
  assert.equal(f.createdRoles.length, 1);
  await assert.rejects(f.registry.confirm(f.ctx, pending.id), /unavailable/);
});

test('permission revocation between steps stops and persists progress without retry', async (t) => {
  const f = fixture(t),
    plan = await f.execute('layout.plan', { label: 'Roles', layout: roleLayout(2) });
  f.hooks.roleCreate = () => {
    f.member.permissions = new PermissionsBitField(0n);
  };
  const first = (await applyLayoutBatch(f.ctx, plan.id, plan.nextBatch!.operations)) as Result;
  assert.equal(first.completed, 1);
  assert.equal(first.state, 'needs-review');
  assert.equal(first.inFlight, 1);
  assert.equal(f.createdRoles.length, 1);
  await assert.rejects(applyLayoutBatch(f.ctx, plan.id, plan.nextBatch!.operations), /not ready/);
  f.member.permissions = new PermissionsBitField(P.Administrator);
  f.hooks.roleCreate = undefined;
  const ready = await f.execute('layout.reconcile', {
    planId: plan.id,
    operationIndex: 1,
    outcome: 'not-applied',
  });
  const done = (await applyLayoutBatch(f.ctx, plan.id, ready.nextBatch!.operations)) as Result;
  assert.equal(done.state, 'done');
  assert.equal(f.createdRoles.length, 2);
});

test('an ambiguous creation response requires reconciliation and never blind retries', async (t) => {
  const f = fixture(t),
    plan = await f.execute('layout.plan', { label: 'Roles', layout: roleLayout() });
  f.hooks.roleCreate = () => {
    throw new Error('Network disconnected after creation');
  };
  const result = (await applyLayoutBatch(f.ctx, plan.id, plan.nextBatch!.operations)) as Result;
  assert.equal(result.state, 'needs-review');
  assert.equal(f.createdRoles.length, 1);
  await assert.rejects(applyLayoutBatch(f.ctx, plan.id, plan.nextBatch!.operations), /not ready/);
  const wrong = f.role({ name: 'Unrelated' });
  await assert.rejects(
    f.execute('layout.reconcile', {
      planId: plan.id,
      operationIndex: 0,
      outcome: 'applied',
      resourceId: wrong.id,
    }),
    /do not match/,
  );
  const done = await f.execute('layout.reconcile', {
    planId: plan.id,
    operationIndex: 0,
    outcome: 'applied',
    resourceId: f.createdRoles[0]!.id,
  });
  assert.equal(done.state, 'done');
  assert.equal(f.createdRoles.length, 1);
});

test('concurrent batches cannot both execute and active operations cannot be reconciled', async (t) => {
  const f = fixture(t),
    plan = await f.execute('layout.plan', { label: 'Roles', layout: roleLayout() });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  f.hooks.roleCreate = async () => {
    reached();
    await gate;
  };
  const pending = applyLayoutBatch(f.ctx, plan.id, plan.nextBatch!.operations);
  await started;
  await assert.rejects(applyLayoutBatch(f.ctx, plan.id, plan.nextBatch!.operations), /not ready/);
  await assert.rejects(
    f.execute('layout.reconcile', { planId: plan.id, operationIndex: 0, outcome: 'not-applied' }),
    /still active/,
  );
  release();
  await pending;
  assert.equal(f.createdRoles.length, 1);
});

test('persisted applying state after process interruption is explicitly recoverable', async (t) => {
  const f = fixture(t),
    plan = await f.execute('layout.plan', { label: 'Roles', layout: roleLayout() });
  const stored = f.store.get<Record<string, unknown>>('layout.plans', `${GUILD}:${plan.id}`)!;
  stored.state = 'applying';
  stored.inFlight = 0;
  f.store.set('layout.plans', `${GUILD}:${plan.id}`, stored);
  const ready = await f.execute('layout.reconcile', {
    planId: plan.id,
    operationIndex: 0,
    outcome: 'not-applied',
  });
  assert.equal(ready.state, 'ready');
  const done = (await applyLayoutBatch(f.ctx, plan.id, ready.nextBatch!.operations)) as Result;
  assert.equal(done.state, 'done');
});

test('deleted channel IDs recreate while inaccessible existing targets never duplicate', async (t) => {
  const f = fixture(t);
  const deleted = '520000000000000099';
  const plan = await f.execute('layout.plan', {
    label: 'Recover',
    layout: { channels: [{ key: 'recover', existingId: deleted, name: 'recovered', type: 'text' }] },
  });
  assert.equal((plan.nextBatch!.operations[0] as { mode: string }).mode, 'create');
  await applyLayoutBatch(f.ctx, plan.id, plan.nextBatch!.operations);
  assert.equal(f.createdChannels.length, 1);
  assert.equal(f.channels.has(CHANNEL), true);
  f.hidden.add(CHANNEL);
  await assert.rejects(
    f.execute('layout.plan', {
      label: 'Hidden',
      layout: { channels: [{ key: 'hidden', existingId: CHANNEL, name: 'hidden', type: 'text' }] },
    }),
    /view/,
  );
  f.hooks.channelFetch = () => {
    throw Object.assign(new Error('Denied'), { code: 50013 });
  };
  await assert.rejects(
    f.execute('layout.plan', {
      label: 'Denied',
      layout: { channels: [{ key: 'denied', existingId: deleted, name: 'denied', type: 'text' }] },
    }),
    /Denied/,
  );
  assert.equal(f.createdChannels.length, 1);
});

test('roles above hierarchy and permissions absent from the requester are rejected', async (t) => {
  const f = fixture(t),
    high = f.role({ position: 100 });
  await assert.rejects(
    f.execute('layout.plan', {
      label: 'High',
      layout: { roles: [{ key: 'high', existingId: high.id, name: 'High' }] },
    }),
    /above/,
  );
  await assert.rejects(
    f.execute('layout.plan', {
      label: 'Position',
      layout: { roles: [{ key: 'high', name: 'High', position: 90 }] },
    }),
    /below/,
  );
  f.member.permissions = new PermissionsBitField([P.ManageGuild, P.ManageRoles, P.ManageChannels]);
  await assert.rejects(
    f.execute('layout.plan', {
      label: 'Escalation',
      layout: { roles: [{ key: 'admin', name: 'Admin', permissions: P.Administrator.toString() }] },
    }),
    /cannot exceed/,
  );
  await assert.rejects(
    f.execute('layout.plan', {
      label: 'Deny',
      layout: {
        channels: [
          {
            key: 'a',
            name: 'a',
            type: 'text',
            overwrites: [{ roleRef: 'everyone', deny: P.BanMembers.toString() }],
          },
        ],
      },
    }),
    /cannot exceed/,
  );
});

test('snapshot captures supported accessible resources and restores explicit null settings', async (t) => {
  const f = fixture(t),
    hidden = f.channel({ name: 'secret' });
  f.hidden.add(hidden.id);
  f.role({ name: 'Member' });
  f.role({ name: 'Managed', managed: true });
  const snapshot = await captureLayout(f.ctx, 'before');
  assert.equal(snapshot.layout.channels.length, 1);
  assert.equal(snapshot.layout.roles.length, 1);
  assert.equal(snapshot.layout.settings!.systemChannelRef, null);
  await f.execute('layout.snapshot.save', { name: 'before' });
  const data = await f.execute<{ attachment: Buffer; name: string }>('layout.snapshot.export', {
    name: 'before',
  });
  assert.equal(JSON.parse(data.attachment.toString()).guildId, GUILD);
  f.hidden.add(CHANNEL);
  await assert.rejects(f.execute('layout.snapshot.export', { name: 'before' }), /view/);
  await assert.rejects(f.execute('layout.snapshot.diff', { name: 'before' }), /view/);
});

test('disabled layouts stop subsequent operations and expired/foreign plans cannot apply', async (t) => {
  const f = fixture(t),
    plan = await f.execute('layout.plan', { label: 'Roles', layout: roleLayout(2) });
  f.hooks.roleCreate = () => {
    f.store.set('core.disabled', GUILD, ['layouts']);
  };
  const result = (await applyLayoutBatch(f.ctx, plan.id, plan.nextBatch!.operations)) as Result;
  assert.equal(result.state, 'needs-review');
  assert.equal(f.createdRoles.length, 1);
  f.store.set('core.disabled', GUILD, []);
  await assert.rejects(
    applyLayoutBatch({ ...f.ctx, channelId: OTHER }, plan.id, plan.nextBatch!.operations),
    /another person/,
  );
  const fresh = await f.execute('layout.plan', { label: 'Expired', layout: roleLayout() });
  const stored = f.store.get<Record<string, unknown>>('layout.plans', `${GUILD}:${fresh.id}`)!;
  stored.expiresAt = Date.now() - 1;
  f.store.set('layout.plans', `${GUILD}:${fresh.id}`, stored);
  await assert.rejects(applyLayoutBatch(f.ctx, fresh.id, fresh.nextBatch!.operations), /expired/);
  const aborted = await f.execute('layout.abort', { planId: fresh.id });
  assert.equal(aborted.state, 'aborted');
});

test('public template placeholders become local references and require confirmed application', async (t) => {
  const f = fixture(t);
  const plan = await f.execute('layout.template.plan', { code: 'starter' });
  assert.equal(plan.total, 3);
  assert.equal(f.createdRoles.length, 0);
  const done = (await applyLayoutBatch(f.ctx, plan.id, plan.nextBatch!.operations)) as Result;
  assert.equal(done.state, 'done');
  assert.equal(f.createdChannels[1]!.parentId, f.createdChannels[0]!.id);
  assert.ok(done.mapping.roles.r_1);
  f.template.serializedGuild.channels[1]!.permission_overwrites![0]!.type = 1;
  await assert.rejects(f.execute('layout.template.plan', { code: 'starter' }), /member overwrites/);
});

test('source channel access revocation between operations stops the remaining batch', async (t) => {
  const f = fixture(t),
    plan = await f.execute('layout.plan', { label: 'Roles', layout: roleLayout(2) });
  f.hooks.roleCreate = () => {
    f.hidden.add(CHANNEL);
  };
  const result = (await applyLayoutBatch(f.ctx, plan.id, plan.nextBatch!.operations)) as Result;
  assert.equal(result.state, 'needs-review');
  assert.equal(result.completed, 1);
  assert.equal(f.createdRoles.length, 1);
});
