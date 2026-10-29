import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  Collection,
  EntitlementType,
  PermissionFlagsBits as P,
  PermissionsBitField,
  SKUFlags,
  SKUType,
  type Client,
  type Entitlement,
  type FetchEntitlementsOptions,
  type GuildMember,
} from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import {
  ENTITLEMENT_ROLE_LIMITS,
  observeEntitlementRoleEvent,
  registerEntitlementRoleActions,
  sweepEntitlementRoleTasks,
} from '../src/features/entitlement-roles.js';

const G = '700000000000000001',
  A = '700000000000000002',
  U = '700000000000000003',
  R = '700000000000000004',
  C = '700000000000000005',
  APP = '700000000000000006',
  S = '700000000000000007',
  E = '700000000000001000';
const POLICY = 'entitlement.roles.policy',
  GRANTS = 'entitlement.roles.grants',
  JOBS = 'entitlement.roles.jobs';
const position = (value: number) => ({
  position: value,
  comparePositionTo: (role: { position: number }) => value - role.position,
});
function entitlement(overrides: Record<string, unknown> = {}) {
  return {
    id: E,
    applicationId: APP,
    skuId: S,
    userId: U,
    guildId: null,
    type: EntitlementType.ApplicationSubscription,
    deleted: false,
    consumed: false,
    startsTimestamp: 0,
    endsTimestamp: 2000,
    ...overrides,
  } as unknown as Entitlement;
}
const collection = (values: Entitlement[]) =>
  new Collection(values.map((value, index) => [String(index), value]));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const state = {
    now: 1000,
    records: [entitlement()],
    fetches: 0,
    targetFetches: 0,
    skuFetches: 0,
    applicationFetches: 0,
  };
  const queries: FetchEntitlementsOptions[] = [],
    added: string[] = [],
    removed: string[] = [],
    reasons: string[] = [],
    roles = new Set<string>();
  const role = {
    id: R,
    guild: { id: G },
    managed: false,
    permissions: new PermissionsBitField(P.ViewChannel),
    ...position(5),
  };
  const actor = {
    id: A,
    permissions: new PermissionsBitField([P.ManageGuild, P.ManageRoles]),
    roles: { highest: position(20), cache: new Map() },
  };
  const bot = {
    id: 'bot',
    permissions: new PermissionsBitField(P.ManageRoles),
    roles: { highest: position(30) },
  };
  const target = {
    id: U,
    user: { bot: false },
    guild: { id: G },
    roles: {
      highest: position(1),
      cache: new Map<string, unknown>(),
      add: async (_role: unknown, reason: string) => {
        added.push(R);
        reasons.push(reason);
        roles.add(R);
      },
      remove: async (_role: unknown, reason: string) => {
        removed.push(R);
        reasons.push(reason);
        roles.delete(R);
      },
    },
  };
  const api = {
    fetch: async (_options: FetchEntitlementsOptions) => collection(state.records),
    sku: async () => {},
    member: async () => {},
    channel: async () => {},
  };
  const sku = {
    id: S,
    applicationId: APP,
    type: SKUType.Subscription,
    flags: { bitfield: SKUFlags.UserSubscription },
  };
  const application = {
    id: APP,
    owner: { id: A },
    fetch: async () => {
      state.applicationFetches++;
      return application;
    },
    fetchSKUs: async () => {
      state.skuFetches++;
      await api.sku();
      return new Collection([[S, sku]]);
    },
    entitlements: {
      fetch: async (options: FetchEntitlementsOptions) => {
        state.fetches++;
        queries.push(options);
        return api.fetch(options);
      },
    },
  };
  const guild = {
    id: G,
    ownerId: 'owner',
    members: {
      me: bot,
      fetchMe: async () => bot,
      fetch: async (input: { user: string }) => {
        if (input.user === A) return actor;
        state.targetFetches++;
        await api.member();
        return {
          ...target,
          roles: { ...target.roles, cache: new Map([...roles].map((roleId) => [roleId, role])) },
        };
      },
    },
    channels: {
      fetch: async () => {
        await api.channel();
        return { guildId: G, permissionsFor: () => new PermissionsBitField(P.ViewChannel) };
      },
    },
    roles: { fetch: async () => role },
  };
  const client = { application, guilds: { fetch: async () => guild } } as unknown as Client;
  const ctx = { client, store, guild, member: actor, channelId: C } as unknown as ActionContext;
  const userCtx = { ...ctx, member: target as unknown as GuildMember };
  const operators: string[] = [],
    guilds = [G];
  const options = { operatorIds: operators, allowedGuildIds: guilds, now: () => state.now };
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  registerEntitlementRoleActions(registry, options);
  const execute = async (actionId: string, input: unknown = {}, context = ctx) => {
    const action = registry.get(actionId);
    return action.execute(context, action.schema.parse(input));
  };
  const configure = () => execute('entitlement.roles.configure', { mappings: [{ skuId: S, roleId: R }] });
  const sync = () => execute('entitlement.roles.sync', {}, userCtx);
  const grants = () =>
    store
      .list<{ id: string; state: string; version: string; nextAt: number }>(GRANTS)
      .map((row) => row.value);
  return {
    store,
    state,
    role,
    actor,
    bot,
    target,
    roles,
    added,
    removed,
    reasons,
    api,
    sku,
    application,
    client,
    ctx,
    userCtx,
    options,
    operators,
    guilds,
    registry,
    execute,
    configure,
    sync,
    grants,
    queries,
  };
}

test('subscription mapping requires current operator + Manage Server/Roles and exact ordinary-role hierarchy', async (t) => {
  const f = fixture(t);
  assert.equal(f.registry.list().length, 5);
  f.application.owner.id = 'other';
  await assert.rejects(f.configure(), /application owner/);
  f.operators.push(A);
  await f.configure();
  f.actor.permissions = new PermissionsBitField(P.ManageGuild);
  await assert.rejects(f.configure(), /authority/);
  f.actor.permissions = new PermissionsBitField([P.ManageGuild, P.ManageRoles]);
  f.bot.permissions = new PermissionsBitField();
  await assert.rejects(f.configure(), /authority/);
  f.bot.permissions = new PermissionsBitField(P.ManageRoles);
  f.role.permissions = new PermissionsBitField(P.Administrator);
  await assert.rejects(f.configure(), /ordinary/);
  f.role.permissions = new PermissionsBitField(1n << 62n);
  await assert.rejects(f.configure(), /ordinary/);
  f.role.permissions = new PermissionsBitField(P.ViewChannel);
  f.role.managed = true;
  await assert.rejects(f.configure(), /ordinary|Managed/);
  assert.throws(
    () =>
      f.registry.get('entitlement.roles.configure').schema.parse({
        mappings: [
          { skuId: S, roleId: R },
          { skuId: S, roleId: '700000000000000008' },
        ],
      }),
    /one-to-one/,
  );
});

test('SKU validation accepts user subscriptions with optional available flag and rejects foreign/consumable/group/guild/unknown flags', async (t) => {
  const f = fixture(t);
  for (const invalid of [
    { applicationId: 'other' },
    { type: SKUType.Consumable },
    { type: SKUType.Durable },
    { type: SKUType.SubscriptionGroup },
    { flags: { bitfield: SKUFlags.GuildSubscription } },
    { flags: { bitfield: SKUFlags.UserSubscription | SKUFlags.GuildSubscription } },
    { flags: { bitfield: SKUFlags.UserSubscription + 2 ** 40 } },
    { flags: { bitfield: -4294967040 } },
  ]) {
    Object.assign(
      f.sku,
      { applicationId: APP, type: SKUType.Subscription, flags: { bitfield: SKUFlags.UserSubscription } },
      invalid,
    );
    await assert.rejects(f.configure(), /UserSubscription/);
  }
  Object.assign(f.sku, {
    applicationId: APP,
    type: SKUType.Subscription,
    flags: { bitfield: SKUFlags.UserSubscription | SKUFlags.Available },
  });
  await f.configure();
});

test('self sync fetches complete own-application user/SKU entitlements and uses idempotent singular role ownership', async (t) => {
  const f = fixture(t);
  await f.configure();
  assert.equal((await f.registry.request(f.userCtx, 'entitlement.roles.sync', {})).status, 'confirmation');
  const result = (await f.sync()) as { added: string[] };
  assert.deepEqual(result.added, [R]);
  assert.deepEqual(f.added, [R]);
  assert.deepEqual(f.queries[0], {
    user: U,
    skus: [S],
    limit: 100,
    after: '0',
    excludeEnded: false,
    excludeDeleted: false,
    cache: false,
  });
  assert.equal(f.grants()[0]?.state, 'owned');
  assert.ok(f.state.targetFetches >= 1);
  await f.sync();
  assert.deepEqual(f.added, [R]);
  assert.equal(f.grants()[0]?.state, 'owned');
  assert.match(f.reasons[0]!, /Verified app entitlement role/);
  const other = {
    ...f.userCtx,
    member: { ...f.target, id: '700000000000000099' },
  } as unknown as ActionContext;
  await assert.rejects(
    f.execute('entitlement.roles.sync', { userId: U }, other),
    /application owner|authority/,
  );
});

test('pre-existing roles are preserved, never claimed and cannot enter removal review', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.roles.add(R);
  await f.sync();
  assert.deepEqual(f.grants(), []);
  assert.deepEqual(f.added, []);
  f.state.records = [];
  await f.sync();
  assert.deepEqual(f.removed, []);
  await assert.rejects(
    f.execute('entitlement.roles.review', { userId: U, roleId: R, operation: 'remove' }),
    /No bot ownership/,
  );
});

test('deleted, consumed, future-starting and expired entitlements cannot grant; nullable bounds are handled explicitly', async (t) => {
  const f = fixture(t);
  await f.configure();
  for (const overrides of [
    { deleted: true },
    { consumed: true },
    { startsTimestamp: 1001 },
    { endsTimestamp: 1000 },
  ]) {
    f.state.records = [entitlement(overrides)];
    await f.sync();
    assert.deepEqual(f.added, []);
  }
  f.state.records = [entitlement({ startsTimestamp: null, endsTimestamp: null })];
  await f.sync();
  assert.deepEqual(f.added, [R]);
});

test('invalid or foreign entitlement records fail closed without revoking a previously bot-added role', async (t) => {
  const f = fixture(t);
  await f.configure();
  await f.sync();
  for (const overrides of [
    { applicationId: 'other' },
    { userId: A },
    { skuId: '700000000000000099' },
    { guildId: G },
    { type: EntitlementType.TestModePurchase },
    { startsTimestamp: NaN },
    { endsTimestamp: 'tomorrow' },
    { startsTimestamp: 2001, endsTimestamp: 2000 },
    { consumed: undefined },
    { deleted: undefined },
  ]) {
    f.state.records = [entitlement(overrides)];
    await assert.rejects(f.sync(), /invalid|unsupported/);
    assert.deepEqual(f.removed, []);
  }
});

test('pagination starts at after zero, advances monotonically and observes all pages before changing roles', async (t) => {
  const f = fixture(t);
  await f.configure();
  const first = Array.from({ length: 100 }, (_, index) =>
    entitlement({ id: (BigInt(E) + BigInt(index + 1)).toString(), endsTimestamp: 0 }),
  );
  f.api.fetch = async (options) => {
    assert.deepEqual(f.added, []);
    return options.after === '0'
      ? collection(first)
      : collection([entitlement({ id: (BigInt(E) + 101n).toString() })]);
  };
  await f.sync();
  assert.deepEqual(
    f.queries.map((query) => query.after),
    ['0', (BigInt(E) + 100n).toString()],
  );
  assert.deepEqual(f.added, [R]);
});

test('incomplete, duplicate and nonprogress pagination never prove entitlement absence', async (t) => {
  const f = fixture(t);
  await f.configure();
  await f.sync();
  f.api.fetch = async (options) =>
    collection(
      Array.from({ length: 100 }, (_, index) =>
        entitlement({
          id: (BigInt(options.after ?? '0') + BigInt(index + 1) + BigInt(E)).toString(),
          endsTimestamp: 0,
        }),
      ),
    );
  await assert.rejects(f.sync(), /500-record/);
  assert.deepEqual(f.removed, []);
  f.api.fetch = async () => collection([entitlement(), entitlement()]);
  await assert.rejects(f.sync(), /duplicate/);
  let pages = 0;
  f.api.fetch = async () =>
    collection(
      pages++
        ? [entitlement({ id: (BigInt(E) + 1n).toString() })]
        : Array.from({ length: 100 }, (_, index) =>
            entitlement({ id: (BigInt(E) + BigInt(index + 1)).toString() }),
          ),
    );
  await assert.rejects(f.sync(), /duplicate|invalid/);
  assert.deepEqual(f.removed, []);
});

test('observed Gateway entitlements only queue verification, reject foreign/guild scope and do not trust event grants', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.state.records = [];
  observeEntitlementRoleEvent(f.client, f.store, entitlement({ applicationId: 'foreign' }), f.options);
  observeEntitlementRoleEvent(f.client, f.store, entitlement({ guildId: G }), f.options);
  assert.equal(f.store.list(JOBS).length, 0);
  observeEntitlementRoleEvent(f.client, f.store, entitlement(), f.options);
  assert.equal(f.store.list(JOBS).length, 1);
  assert.deepEqual(f.added, []);
  await sweepEntitlementRoleTasks(f.client, f.store, f.state.now, f.options);
  assert.equal(f.state.fetches, 1);
  assert.deepEqual(f.added, []);
});

test('expiry refresh fetches current entitlements before removing only the bot-owned role', async (t) => {
  const f = fixture(t);
  await f.configure();
  await f.sync();
  f.state.now = 2000;
  await sweepEntitlementRoleTasks(f.client, f.store, f.state.now, f.options);
  assert.deepEqual(f.removed, [R]);
  assert.equal(f.grants()[0]?.state, 'removed');
  assert.equal(f.state.fetches, 2);
});

test('API failures preserve roles and bounded retry metadata; Gateway spam cannot reset failed retries', async (t) => {
  const f = fixture(t);
  await f.configure();
  await f.sync();
  f.state.now = 2000;
  f.api.fetch = async () => {
    throw new Error('provider error containing no persisted details');
  };
  for (let attempt = 0; attempt < ENTITLEMENT_ROLE_LIMITS.attempts; attempt++) {
    await sweepEntitlementRoleTasks(f.client, f.store, f.state.now, f.options);
    f.state.now += 600000;
  }
  const job = f.store.get<{ status: string; attempts: number; lastError: string }>(JOBS, `${G}:${U}`)!;
  assert.equal(job.status, 'failed');
  assert.equal(job.attempts, 3);
  assert.equal(job.lastError, 'Error');
  assert.deepEqual(f.removed, []);
  const calls = f.state.fetches;
  observeEntitlementRoleEvent(f.client, f.store, entitlement(), f.options);
  await sweepEntitlementRoleTasks(f.client, f.store, f.state.now, f.options);
  assert.equal(f.state.fetches, calls);
});

test('policy removal during entitlement fetch cancels late work and leaves existing roles for explicit review', async (t) => {
  const f = fixture(t);
  await f.configure();
  await f.sync();
  f.state.records = [];
  f.api.fetch = async () => {
    await f.execute('entitlement.roles.configure', { mappings: [] });
    return collection([]);
  };
  await assert.rejects(f.sync(), /cancelled/);
  assert.deepEqual(f.removed, []);
  assert.equal(f.store.get(POLICY, G), undefined);
  assert.equal(f.store.list(JOBS).length, 0);
  await sweepEntitlementRoleTasks(f.client, f.store, 999999, f.options);
  assert.deepEqual(f.removed, []);
  await f.execute('entitlement.roles.review', { userId: U, roleId: R, operation: 'remove' });
  assert.deepEqual(f.removed, [R]);
  assert.equal(f.grants()[0]?.state, 'detached');
});

test('new policy versions freeze prior ownership until explicit resume and detach persists manual takeover', async (t) => {
  const f = fixture(t);
  await f.configure();
  await f.sync();
  await f.configure();
  f.state.records = [];
  await f.sync();
  assert.deepEqual(f.removed, []);
  await f.execute('entitlement.roles.review', { userId: U, roleId: R, operation: 'resume' });
  assert.deepEqual(f.removed, [R]);
  f.state.records = [entitlement()];
  await f.sync();
  await f.execute('entitlement.roles.review', { userId: U, roleId: R, operation: 'detach' });
  f.state.records = [];
  await f.sync();
  assert.equal(f.removed.length, 1);
  await assert.rejects(
    f.execute('entitlement.roles.review', { userId: U, roleId: R, operation: 'remove' }),
    /confirmed current bot ownership/,
  );
});

test('ambiguous role-add failures never claim ownership or automatically remove the role', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.target.roles.add = async () => {
    f.roles.add(R);
    throw new Error('ambiguous HTTP failure');
  };
  await assert.rejects(f.sync(), /ambiguous/);
  assert.equal(f.grants()[0]?.state, 'uncertain');
  f.state.records = [];
  await f.sync();
  assert.deepEqual(f.removed, []);
  await assert.rejects(
    f.execute('entitlement.roles.review', { userId: U, roleId: R, operation: 'remove' }),
    /confirmed current bot ownership/,
  );
  await f.execute('entitlement.roles.review', { userId: U, roleId: R, operation: 'resume' });
  assert.deepEqual(f.removed, []);
  assert.equal(f.grants()[0]?.state, 'unowned');
});

test('authority, module, allowlist and role safety are refreshed after asynchronous provider/member/role work', async (t) => {
  for (const change of ['author', 'bot', 'operator', 'module', 'allowlist', 'role'] as const) {
    const f = fixture(t);
    await f.configure();
    f.api.member = async () => {
      if (change === 'author') f.actor.permissions = new PermissionsBitField();
      if (change === 'bot') f.bot.permissions = new PermissionsBitField();
      if (change === 'operator') f.application.owner.id = 'other';
      if (change === 'module') f.store.set('core.disabled', G, ['membership']);
      if (change === 'allowlist') f.guilds.splice(0, 1, 'other');
      if (change === 'role') f.role.permissions = new PermissionsBitField(P.ManageRoles);
    };
    await assert.rejects(f.sync());
    assert.deepEqual(f.added, [], change);
  }
});

test('permission loss during channel lookup blocks configuration and SKU lookup loss blocks mutation', async (t) => {
  const f = fixture(t);
  f.api.channel = async () => {
    f.actor.permissions = new PermissionsBitField();
  };
  await assert.rejects(f.configure(), /revoked/);
  f.actor.permissions = new PermissionsBitField([P.ManageGuild, P.ManageRoles]);
  f.api.channel = async () => {};
  await f.configure();
  f.api.sku = async () => {
    f.bot.permissions = new PermissionsBitField();
  };
  await assert.rejects(f.sync(), /authority|revoked/);
  assert.deepEqual(f.added, []);
});

test('entitlements expiring during final authority refresh do not grant a stale role', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.api.member = async () => {
    f.state.now = 2000;
  };
  await f.sync();
  assert.deepEqual(f.added, []);
});

test('user reconciliation locks and global slots release after failure; sweeps do not consume another running job retry', async (t) => {
  const f = fixture(t);
  await f.configure();
  const gate = deferred<Collection<string, Entitlement>>();
  f.api.fetch = async () => gate.promise;
  const first = f.sync();
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.sync(), /busy/);
  await sweepEntitlementRoleTasks(f.client, f.store, f.state.now, f.options);
  assert.equal(f.store.get<{ attempts: number }>(JOBS, `${G}:${U}`)?.attempts, 0);
  gate.resolve(collection([entitlement()]));
  await first;
  f.api.fetch = async () => collection([entitlement()]);
  await f.sync();
  assert.equal(f.added.length, 1);
});

test('global reconciliation concurrency is capped and released for later explicit syncs', async (t) => {
  const fixtures = [fixture(t), fixture(t), fixture(t)];
  await Promise.all(fixtures.map((f) => f.configure()));
  const gates = [deferred<Collection<string, Entitlement>>(), deferred<Collection<string, Entitlement>>()];
  fixtures[0]!.api.fetch = async () => gates[0]!.promise;
  fixtures[1]!.api.fetch = async () => gates[1]!.promise;
  const jobs = [fixtures[0]!.sync(), fixtures[1]!.sync()];
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(fixtures[2]!.sync(), /busy/);
  gates.forEach((gate) => gate.resolve(collection([entitlement()])));
  await Promise.all(jobs);
  await fixtures[2]!.sync();
  assert.deepEqual(fixtures[2]!.added, [R]);
});

test('expired owned roles remain intact after late permission or target-hierarchy loss', async (t) => {
  for (const change of ['author', 'bot', 'hierarchy'] as const) {
    const f = fixture(t);
    await f.configure();
    await f.sync();
    f.state.now = 2000;
    f.api.member = async () => {
      if (change === 'author') f.actor.permissions = new PermissionsBitField();
      if (change === 'bot') f.bot.permissions = new PermissionsBitField();
      if (change === 'hierarchy') f.target.roles.highest = position(40);
    };
    await assert.rejects(f.sync());
    assert.deepEqual(f.removed, [], change);
  }
});
