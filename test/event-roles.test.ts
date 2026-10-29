import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Collection, PermissionFlagsBits as P, PermissionsBitField, type GuildMember } from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import {
  observeEventRoleChange,
  registerEventRoleActions,
  sweepEventRoles,
} from '../src/features/event-roles.js';
const G = '750000000000000001',
  U = '750000000000000002',
  V = '750000000000000003',
  B = '750000000000000004',
  C = '750000000000000005',
  R = '750000000000000006';
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const added: string[] = [],
    removed: string[] = [];
  const hooks: { add?: () => void } = {};
  const highest = (n: number) => ({
    position: n,
    comparePositionTo: (target: { position: number }) => n - target.position,
  });
  const role = {
    id: R,
    guild: { id: G },
    managed: false,
    permissions: new PermissionsBitField(P.ViewChannel),
    ...highest(5),
  };
  const actor = {
    id: U,
    user: { id: U, bot: false },
    permissions: new PermissionsBitField(P.Administrator),
    roles: { cache: new Collection(), highest: highest(50) },
  };
  const bot = { ...actor, id: B, roles: { ...actor.roles, highest: highest(100) } };
  const target = {
    ...actor,
    id: V,
    user: { id: V, bot: false },
    roles: {
      cache: new Collection<string, typeof role>(),
      highest: highest(1),
      add: async (input: typeof role) => {
        added.push(input.id);
        target.roles.cache.set(input.id, input);
        hooks.add?.();
      },
      remove: async (input: typeof role) => {
        removed.push(input.id);
        target.roles.cache.delete(input.id);
      },
    },
  };
  const guild = {
    id: G,
    ownerId: U,
    members: {
      me: bot,
      fetchMe: async () => bot,
      fetch: async (input: string | { user: string }) =>
        (typeof input === 'string' ? input : input.user) === V ? target : actor,
    },
    roles: { fetch: async () => role },
    channels: {
      fetch: async () => ({
        id: C,
        guildId: G,
        type: 0,
        permissionsFor: () => new PermissionsBitField(P.Administrator),
      }),
    },
  };
  Object.assign(target, { guild });
  Object.assign(actor, { guild });
  const client = { guilds: { fetch: async () => guild } },
    ctx = { client, store, guild, member: actor, channelId: C } as unknown as ActionContext;
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  registerEventRoleActions(registry);
  const run = async (id: string, input: unknown) => {
    const action = registry.get(id);
    return action.execute(ctx, action.schema.parse(input));
  };
  const now = Date.now();
  store.set('automation.calendar', `${G}:event`, {
    id: 'event',
    guildId: G,
    channelId: C,
    startsAt: now - 60000,
    endsAt: now + 60000,
    cancelled: false,
    rsvps: { [V]: { status: 'yes' } },
  });
  const setup = () => run('eventroles.configure', { eventId: 'event', roleId: R });
  return { store, ctx, client, registry, run, setup, role, target, actor, bot, added, removed, hooks, now };
}
test('event role policies grant accepted RSVP participants and expire only their tracked bot-owned roles', async (t) => {
  const f = fixture(t);
  await f.setup();
  await sweepEventRoles(f.ctx.client, f.store);
  assert.deepEqual(f.added, [R]);
  assert.equal(f.target.roles.cache.has(R), true);
  await sweepEventRoles(f.ctx.client, f.store, f.now + 120000);
  assert.deepEqual(f.removed, [R]);
});
test('preexisting participant roles survive withdrawal and event expiry', async (t) => {
  const f = fixture(t);
  f.target.roles.cache.set(R, f.role);
  await f.setup();
  await sweepEventRoles(f.ctx.client, f.store);
  await sweepEventRoles(f.ctx.client, f.store, f.now + 120000);
  assert.deepEqual(f.added, []);
  assert.deepEqual(f.removed, []);
  assert.equal(f.target.roles.cache.has(R), true);
});
test('RSVP withdrawal removes a tracked role and disabling automation still permits existing ownership cleanup', async (t) => {
  const f = fixture(t);
  await f.setup();
  await sweepEventRoles(f.ctx.client, f.store);
  f.store.set('core.disabled', G, ['automation']);
  await sweepEventRoles(f.ctx.client, f.store);
  assert.deepEqual(f.removed, [R]);
});
test('event role grants revalidate manager authority and reject newly privileged roles', async (t) => {
  const f = fixture(t);
  await f.setup();
  f.role.permissions = new PermissionsBitField(P.Administrator);
  await sweepEventRoles(f.ctx.client, f.store);
  assert.deepEqual(f.added, []);
  assert.ok(f.store.get<{ lastError: string }>('automation.eventRoles', `${G}:event`)!.lastError);
});
test('uncertain role-add outcomes require ownership review and never become silently removable', async (t) => {
  const f = fixture(t);
  await f.setup();
  f.hooks.add = () => {
    throw new Error('Unknown write');
  };
  await sweepEventRoles(f.ctx.client, f.store);
  assert.equal(
    f.store.get<{ grants: Record<string, { state: string }> }>('automation.eventRoles', `${G}:event`)!.grants[
      V
    ]!.state,
    'unknown',
  );
  await sweepEventRoles(f.ctx.client, f.store, f.now + 120000);
  assert.deepEqual(f.removed, []);
  await f.run('eventroles.review', {
    eventId: 'event',
    userId: V,
    ownership: 'preserve',
    reviewedOwnership: true,
  });
  assert.equal(f.target.roles.cache.has(R), true);
});
test('policy withdrawal while an add is pending preserves the new policy and cleans the actual owned result later', async (t) => {
  const f = fixture(t);
  await f.setup();
  f.hooks.add = () => {
    const policy = f.store.get<Record<string, unknown>>('automation.eventRoles', `${G}:event`)!;
    policy.enabled = false;
    policy.version = 'new-policy';
    f.store.set('automation.eventRoles', `${G}:event`, policy);
  };
  await sweepEventRoles(f.ctx.client, f.store);
  assert.equal(f.store.get<{ enabled: boolean }>('automation.eventRoles', `${G}:event`)!.enabled, false);
  await sweepEventRoles(f.ctx.client, f.store);
  assert.deepEqual(f.removed, [R]);
});
test('observed manual removal relinquishes ownership and prevents an automatic regrant', async (t) => {
  const f = fixture(t);
  await f.setup();
  await sweepEventRoles(f.ctx.client, f.store);
  const before = { ...f.target, roles: { ...f.target.roles, cache: new Collection([[R, f.role]]) } };
  f.target.roles.cache.delete(R);
  observeEventRoleChange(before as unknown as GuildMember, f.target as unknown as GuildMember, f.store);
  await sweepEventRoles(f.ctx.client, f.store);
  assert.equal(f.added.length, 1);
  assert.equal(
    f.store.get<{ grants: Record<string, { state: string }> }>('automation.eventRoles', `${G}:event`)!.grants[
      V
    ]!.state,
    'unknown',
  );
});
