import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelType,
  GuildScheduledEventStatus,
  OverwriteType,
  PermissionsBitField,
  PermissionFlagsBits as P,
  type Client,
} from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import {
  eventChannelMarker,
  registerEventChannelActions,
  sweepEventChannelTasks,
  type EventChannelPolicy,
} from '../src/features/event-channels.js';
const G = '570000000000000001',
  A = '570000000000000002',
  B = '570000000000000003',
  C = '570000000000000004',
  CATEGORY = '570000000000000005',
  R = '570000000000000006',
  E = '570000000000000007';
const NOW = 1800000000000,
  MINUTE = 60000,
  namespace = 'eventChannels.policies';
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const highest = { comparePositionTo: () => 1 };
  const actor = {
      id: A,
      permissions: new PermissionsBitField(P.Administrator),
      roles: { highest, cache: new Map() },
    },
    bot = {
      id: B,
      permissions: new PermissionsBitField(P.Administrator),
      roles: { highest, cache: new Map() },
    };
  const role = {
    id: R,
    guild: { id: G },
    managed: false,
    permissions: new PermissionsBitField([P.ViewChannel, P.SendMessages, P.ReadMessageHistory]),
  };
  const hidden = new Set<string>(),
    noManage = new Set<string>();
  const event = {
    id: E,
    guildId: G,
    status: GuildScheduledEventStatus.Scheduled,
    scheduledStartTimestamp: NOW + 60 * MINUTE,
    scheduledEndTimestamp: NOW + 120 * MINUTE,
  };
  const creates: Record<string, unknown>[] = [],
    edits: Record<string, unknown>[] = [],
    eventReads: unknown[] = [];
  const hooks: {
    event?: () => Promise<void> | void;
    create?: () => Promise<void> | void;
    edit?: () => Promise<void> | void;
    channel?: () => Promise<void> | void;
  } = {};
  const permissionsFor = (principal: { id: string }) =>
    new PermissionsBitField(
      hidden.has(principal.id)
        ? 0n
        : noManage.has(principal.id)
          ? [P.ViewChannel, P.SendMessages, P.ReadMessageHistory]
          : P.Administrator,
    );
  interface Channel {
    id: string;
    guildId: string;
    type: ChannelType;
    parentId: string | null;
    topic: string | null;
    name: string;
    permissionsFor: typeof permissionsFor;
    permissionOverwrites: {
      cache: Map<string, { id: string; type: number; allow: PermissionsBitField; deny: PermissionsBitField }>;
    };
    edit: (input: Record<string, unknown>) => Promise<Channel>;
  }
  let serial = 570000000000000100n;
  const channels = new Map<string, Channel>();
  function channel(id: string, type: ChannelType = ChannelType.GuildText): Channel {
    const result: Channel = {
      id,
      guildId: G,
      type,
      parentId: null,
      topic: null,
      name: 'source',
      permissionsFor,
      permissionOverwrites: { cache: new Map() },
      edit: async (input) => {
        edits.push(input);
        await hooks.edit?.();
        if (typeof input.name === 'string') result.name = input.name;
        if (input.permissionOverwrites) overwrites(result, input.permissionOverwrites);
        return result;
      },
    };
    channels.set(id, result);
    return result;
  }
  function overwrites(target: Channel, input: unknown) {
    target.permissionOverwrites.cache = new Map(
      (input as { id: string; type: number; allow: bigint; deny: bigint }[]).map((value) => [
        value.id,
        { ...value, allow: new PermissionsBitField(value.allow), deny: new PermissionsBitField(value.deny) },
      ]),
    );
  }
  const source = channel(C),
    parent = channel(CATEGORY, ChannelType.GuildCategory);
  const guild = {
    id: G,
    ownerId: A,
    members: {
      me: bot,
      fetchMe: async () => bot,
      fetch: async (input: string | { user: string }) => {
        const id = typeof input === 'string' ? input : input.user;
        if (id === A) return actor;
        if (id === B) return bot;
        throw new Error('Unknown member');
      },
    },
    roles: { fetch: async (id: string) => (id === R ? role : null) },
    scheduledEvents: {
      fetch: async (input: unknown) => {
        eventReads.push(input);
        await hooks.event?.();
        return event;
      },
    },
    channels: {
      fetch: async (id?: string) => {
        await hooks.channel?.();
        return id ? (channels.get(id) ?? null) : channels;
      },
      create: async (input: Record<string, unknown>) => {
        creates.push(input);
        const created = channel(String(serial++));
        created.name = String(input.name);
        created.parentId = String(input.parent);
        created.topic = String(input.topic);
        overwrites(created, input.permissionOverwrites);
        await hooks.create?.();
        return created;
      },
    },
  };
  Object.assign(actor, { guild });
  Object.assign(bot, { guild });
  const client = { guilds: { fetch: async () => guild } } as unknown as Client;
  const ctx = { client, store, guild, member: actor, channelId: C } as unknown as ActionContext,
    registry = new ActionRegistry(120, async (ctx) => ctx);
  registerEventChannelActions(registry);
  async function execute<T = unknown>(id: string, input: unknown = {}): Promise<T> {
    const action = registry.get(id);
    return (await action.execute(ctx, action.schema.parse(input))) as T;
  }
  async function configure(overrides: Record<string, unknown> = {}) {
    return execute<EventChannelPolicy>('eventchannel.configure', {
      id: 'study',
      eventId: E,
      parentCategoryId: CATEGORY,
      visibilityRoleIds: [R],
      openBeforeMinutes: 10,
      closeAfterMinutes: 5,
      ...overrides,
    });
  }
  const policy = () => store.get<EventChannelPolicy>(namespace, `${G}:study`)!;
  const sweep = (now = NOW, allow: readonly string[] = []) =>
    sweepEventChannelTasks(client, store, now, allow);
  return {
    store,
    actor,
    bot,
    role,
    hidden,
    noManage,
    event,
    creates,
    edits,
    eventReads,
    hooks,
    channels,
    source,
    parent,
    execute,
    configure,
    policy,
    sweep,
    ctx,
  };
}
test('native event channel opens at its configured boundary with explicit private overwrites', async (t) => {
  const f = fixture(t);
  await f.configure();
  await f.sweep(NOW + 49 * MINUTE);
  assert.equal(f.creates.length, 0);
  await f.sweep(NOW + 50 * MINUTE);
  assert.equal(f.creates.length, 1);
  assert.equal(f.policy().state, 'open');
  const created = f.channels.get(f.policy().channelId!)!;
  assert.equal(created.parentId, CATEGORY);
  assert.equal(created.topic, eventChannelMarker(f.policy()));
  const everyone = created.permissionOverwrites.cache.get(G)!;
  assert.equal(everyone.type, OverwriteType.Role);
  assert.equal(everyone.allow.bitfield, 0n);
  assert.ok(everyone.deny.has(P.ViewChannel));
  assert.ok(created.permissionOverwrites.cache.get(R)!.allow.has([P.ViewChannel, P.SendMessages]));
  assert.deepEqual([...created.permissionOverwrites.cache.keys()].sort(), [G, R, A, B].sort());
  assert.ok(f.eventReads.every((input) => (input as { force: boolean }).force === true));
  await f.sweep(NOW + 51 * MINUTE);
  assert.equal(f.creates.length, 1);
});
test('close archives and hides participants without deleting content or channels', async (t) => {
  const f = fixture(t);
  await f.configure();
  await f.sweep(NOW + 50 * MINUTE);
  await f.sweep(NOW + 124 * MINUTE);
  assert.equal(f.edits.length, 0);
  await f.sweep(NOW + 125 * MINUTE);
  assert.equal(f.edits.length, 1);
  assert.equal(f.policy().state, 'closed');
  const created = f.channels.get(f.policy().channelId!)!;
  assert.equal(created.name, 'archived-event-study');
  assert.ok(created.permissionOverwrites.cache.get(R)!.deny.has([P.ViewChannel, P.SendMessages]));
  assert.ok(created.permissionOverwrites.cache.get(A)!.allow.has([P.ViewChannel, P.ReadMessageHistory]));
  assert.ok(created.permissionOverwrites.cache.get(A)!.deny.has(P.SendMessages));
  assert.equal(f.channels.size, 3);
  await f.sweep(NOW + 130 * MINUTE);
  assert.equal(f.edits.length, 1);
});
test('canceled or already elapsed events never create late channels', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.event.status = GuildScheduledEventStatus.Canceled;
  await f.sweep(NOW + 55 * MINUTE);
  assert.equal(f.policy().state, 'closed');
  assert.equal(f.creates.length, 0);
  const g = fixture(t);
  await g.configure();
  await g.sweep(NOW + 126 * MINUTE);
  assert.equal(g.creates.length, 0);
  assert.equal(g.policy().state, 'closed');
});
test('cancellation closes an existing room after the configured observed grace interval', async (t) => {
  const f = fixture(t);
  await f.configure();
  await f.sweep(NOW + 50 * MINUTE);
  f.event.status = GuildScheduledEventStatus.Canceled;
  await f.sweep(NOW + 55 * MINUTE);
  assert.equal(f.edits.length, 0);
  await f.sweep(NOW + 60 * MINUTE);
  assert.equal(f.policy().state, 'closed');
  assert.equal(f.edits.length, 1);
});
test('fresh native-event rescheduling changes the lifecycle boundary', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.event.scheduledStartTimestamp = NOW + 90 * MINUTE;
  await f.sweep(NOW + 50 * MINUTE);
  assert.equal(f.creates.length, 0);
  await f.sweep(NOW + 80 * MINUTE);
  assert.equal(f.creates.length, 1);
});
test('unknown create outcome is retained and never retried; exact real channel can be reconciled', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.hooks.create = () => {
    throw new Error('Lost response');
  };
  await f.sweep(NOW + 50 * MINUTE);
  assert.equal(f.policy().state, 'needs-review');
  await f.sweep(NOW + 55 * MINUTE);
  assert.equal(f.creates.length, 1);
  await assert.rejects(() => f.execute('eventchannel.retry', { id: 'study' }), /Only failed/);
  const actual = [...f.channels.values()].find(
    (channel) => channel.topic === eventChannelMarker(f.policy()),
  )!;
  await assert.rejects(
    () =>
      f.execute('eventchannel.reconcile', {
        id: 'study',
        reservation: f.policy().reservation,
        outcome: 'created',
        channelId: C,
        reviewedServerState: true,
      }),
    /exact event reservation/,
  );
  await f.execute('eventchannel.reconcile', {
    id: 'study',
    reservation: f.policy().reservation,
    outcome: 'created',
    channelId: actual.id,
    reviewedServerState: true,
  });
  assert.equal(f.policy().channelId, actual.id);
  assert.equal(f.policy().state, 'open');
  await f.sweep(NOW + 55 * MINUTE);
  assert.equal(f.creates.length, 1);
});
test('persisted creating state requires review after interruption', async (t) => {
  const f = fixture(t);
  const policy = await f.configure();
  f.store.set(namespace, `${G}:study`, { ...policy, state: 'creating' });
  await f.sweep(NOW + 55 * MINUTE);
  assert.equal(f.policy().state, 'needs-review');
  assert.equal(f.creates.length, 0);
});
test('not-created reconciliation requires reviewed absence and rotates the reservation', async (t) => {
  const f = fixture(t);
  const policy = await f.configure();
  f.store.set(namespace, `${G}:study`, {
    ...policy,
    state: 'needs-review',
    retryAt: Date.now() - 3 * MINUTE,
  });
  const before = f.policy().reservation;
  await f.execute('eventchannel.reconcile', {
    id: 'study',
    reservation: before,
    outcome: 'not-created',
    reviewedServerState: true,
  });
  assert.equal(f.policy().state, 'waiting');
  assert.notEqual(f.policy().reservation, before);
  await f.sweep(NOW + 55 * MINUTE);
  assert.equal(f.creates.length, 1);
});
test('not-created reconciliation refuses a matching real channel', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.hooks.create = () => {
    throw new Error('Lost response');
  };
  await f.sweep(NOW + 50 * MINUTE);
  f.store.set(namespace, `${G}:study`, { ...f.policy(), retryAt: Date.now() - 3 * MINUTE });
  await assert.rejects(
    () =>
      f.execute('eventchannel.reconcile', {
        id: 'study',
        reservation: f.policy().reservation,
        outcome: 'not-created',
        reviewedServerState: true,
      }),
    /matching channel exists/,
  );
  assert.equal(f.policy().state, 'needs-review');
});
test('manager, role, and category authority are fetched again before opening', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.hooks.event = () => {
    f.actor.permissions = new PermissionsBitField(P.ViewChannel);
  };
  await f.sweep(NOW + 50 * MINUTE);
  assert.equal(f.creates.length, 0);
  assert.equal(f.policy().attempts, 1);
  const g = fixture(t);
  await g.configure();
  g.role.permissions = new PermissionsBitField(P.Administrator);
  await g.sweep(NOW + 50 * MINUTE);
  assert.equal(g.creates.length, 0);
  const h = fixture(t);
  await h.configure();
  h.hidden.add(R);
  await h.sweep(NOW + 50 * MINUTE);
  assert.equal(h.creates.length, 0);
});
test('failed authority retries are bounded at three and need explicit reset', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.noManage.add(A);
  await f.sweep(NOW + 50 * MINUTE);
  await f.sweep(NOW + 51 * MINUTE);
  await f.sweep(NOW + 53 * MINUTE);
  assert.equal(f.policy().state, 'failed');
  assert.equal(f.policy().attempts, 3);
  f.noManage.delete(A);
  await f.sweep(NOW + 55 * MINUTE);
  assert.equal(f.creates.length, 0);
  await f.execute('eventchannel.retry', { id: 'study' });
  await f.sweep(NOW + 55 * MINUTE);
  assert.equal(f.creates.length, 1);
});
test('allowlist, module disable, and current action policy prevent opening', async (t) => {
  const f = fixture(t);
  await f.configure();
  await f.sweep(NOW + 50 * MINUTE, ['570000000000000999']);
  assert.equal(f.eventReads.length, 1);
  f.store.set('core.disabled', G, ['event-channels']);
  await f.sweep(NOW + 50 * MINUTE);
  assert.equal(f.creates.length, 0);
  f.store.set('core.disabled', G, []);
  f.store.set('core.actionPolicies', `${G}:eventchannel.configure`, {
    enabled: false,
    roleIds: [],
    channelIds: [],
  });
  await f.sweep(NOW + 50 * MINUTE);
  assert.equal(f.creates.length, 0);
});
test('pause during native-event fetch cancels opening; pause during create retains the real ID', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.hooks.event = async () => {
    await f.execute('eventchannel.pause', { id: 'study', paused: true });
  };
  await f.sweep(NOW + 50 * MINUTE);
  assert.equal(f.creates.length, 0);
  assert.equal(f.policy().enabled, false);
  const g = fixture(t);
  await g.configure();
  g.hooks.create = async () => {
    await g.execute('eventchannel.pause', { id: 'study', paused: true });
  };
  await g.sweep(NOW + 50 * MINUTE);
  assert.equal(g.creates.length, 1);
  assert.equal(g.policy().enabled, false);
  assert.ok(g.policy().channelId);
  assert.equal(g.policy().state, 'open');
});
test('concurrent sweeps make only one channel', async (t) => {
  const f = fixture(t);
  await f.configure();
  await Promise.all([f.sweep(NOW + 50 * MINUTE), f.sweep(NOW + 50 * MINUTE)]);
  assert.equal(f.creates.length, 1);
});
test('foreign permission edits cause a close conflict without replacing overwrites', async (t) => {
  const f = fixture(t);
  await f.configure();
  await f.sweep(NOW + 50 * MINUTE);
  const created = f.channels.get(f.policy().channelId!)!;
  created.permissionOverwrites.cache.get(G)!.allow = new PermissionsBitField(P.ViewChannel);
  await f.sweep(NOW + 125 * MINUTE);
  assert.equal(f.edits.length, 0);
  assert.equal(f.policy().attempts, 1);
});
test('closing crash recovery recognizes an already applied identical archive', async (t) => {
  const f = fixture(t);
  await f.configure();
  await f.sweep(NOW + 50 * MINUTE);
  await f.sweep(NOW + 125 * MINUTE);
  f.store.set(namespace, `${G}:study`, { ...f.policy(), state: 'closing', retryAt: 0 });
  await f.sweep(NOW + 126 * MINUTE);
  assert.equal(f.policy().state, 'closed');
  assert.equal(f.edits.length, 1);
});
test('schemas and removal protect uncertain or active channel reservations', async (t) => {
  const f = fixture(t);
  await assert.rejects(() => f.configure({ visibilityRoleIds: [R, R] }), /unique/);
  await f.configure();
  await assert.rejects(() => f.configure(), /cannot be replaced/);
  await f.sweep(NOW + 50 * MINUTE);
  await assert.rejects(() => f.execute('eventchannel.remove', { id: 'study' }), /Pause active/);
  await f.sweep(NOW + 125 * MINUTE);
  await f.execute('eventchannel.remove', { id: 'study' });
  assert.equal(f.policy(), undefined);
  assert.equal(f.channels.size, 3);
});
