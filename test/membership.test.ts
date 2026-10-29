import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { PermissionFlagsBits as P, PermissionsBitField, type Client, type GuildMember } from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import {
  registerMembershipActions,
  rememberDepartingRoles,
  queueRejoinRoles,
  sweepMembershipTasks,
} from '../src/features/membership.js';
const G = '420000000000000001',
  A = '420000000000000002',
  U = '420000000000000003',
  R = '420000000000000004',
  C = '420000000000000005';
const position = (n: number) => ({
  position: n,
  comparePositionTo: (other: { position: number }) => n - other.position,
});
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const granted: string[] = [],
    sent: string[] = [];
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
    guild: { id: G },
    roles: {
      highest: position(1),
      cache: new Map([[R, role]]),
      add: async (r: { id: string }) => {
        granted.push(r.id);
      },
    },
    createDM: async () => ({ send: async (payload: { content: string }) => sent.push(payload.content) }),
  };
  const gateway = { fetch: async (user: { user: string }) => (user.user === A ? actor : target) };
  const channel = { guildId: G, permissionsFor: () => new PermissionsBitField(P.ViewChannel) };
  const guild = {
    id: G,
    name: 'Test',
    ownerId: 'owner',
    members: { me: bot, fetch: (user: { user: string }) => gateway.fetch(user), fetchMe: async () => bot },
    channels: { fetch: async () => channel },
    roles: { fetch: async () => role },
  };
  target.guild = guild;
  const client = { guilds: { fetch: async () => guild } } as unknown as Client;
  const ctx = { store, client, guild, member: actor, channelId: C } as unknown as ActionContext;
  const registry = new ActionRegistry(120, async (c) => c);
  registerMembershipActions(registry);
  const execute = (id: string, input: unknown = {}, context = ctx) => {
    const action = registry.get(id);
    return Promise.resolve(action.execute(context, action.schema.parse(input)));
  };
  const userCtx = { ...ctx, member: target } as unknown as ActionContext;
  const setup = async () => {
    await execute('membership.roles.configure', { roleIds: [R] });
    await execute('membership.roles.consent', { enabled: true }, userCtx);
  };
  return {
    store,
    ctx,
    userCtx,
    client,
    registry,
    execute,
    setup,
    target,
    actor,
    role,
    granted,
    sent,
    gateway,
  };
}
test('Saved-role restoration requires member consent and captures only manager-approved roles', async (t) => {
  const f = fixture(t);
  rememberDepartingRoles(f.target as unknown as GuildMember, f.store);
  queueRejoinRoles(f.target as unknown as GuildMember, f.store);
  assert.equal(f.store.list('membership.restore').length, 0);
  await f.setup();
  rememberDepartingRoles(f.target as unknown as GuildMember, f.store);
  f.target.roles.cache.clear();
  queueRejoinRoles(f.target as unknown as GuildMember, f.store);
  await sweepMembershipTasks(f.client, f.store);
  assert.deepEqual(f.granted, [R]);
  assert.equal(f.store.get<{ status: string }>('membership.restore', `${G}:${U}`)?.status, 'done');
});
test('Unsafe future permissions cannot enter rejoin role policy', async (t) => {
  const f = fixture(t);
  f.role.permissions = new PermissionsBitField(1n << 62n);
  await assert.rejects(() => f.execute('membership.roles.configure', { roleIds: [R] }), /ordinary/);
  assert.equal(f.store.get('membership.policy', G), undefined);
});
test('Rejoin role jobs revalidate manager authority and retry a bounded number of times', async (t) => {
  const f = fixture(t);
  await f.setup();
  f.target.roles.cache.clear();
  queueRejoinRoles(f.target as unknown as GuildMember, f.store);
  f.actor.permissions = new PermissionsBitField(0n);
  const now = Date.now();
  for (let i = 0; i < 4; i++) await sweepMembershipTasks(f.client, f.store, now + i * 600000);
  assert.deepEqual(f.granted, []);
  assert.equal(
    f.store.get<{ status: string; attempts: number }>('membership.restore', `${G}:${U}`)?.status,
    'failed',
  );
  assert.equal(f.store.get<{ attempts: number }>('membership.restore', `${G}:${U}`)?.attempts, 3);
});
test('Disabled or excluded membership jobs pause; withdrawal erases pending roles even while disabled', async (t) => {
  const f = fixture(t);
  await f.setup();
  queueRejoinRoles(f.target as unknown as GuildMember, f.store);
  f.target.roles.cache.clear();
  await sweepMembershipTasks(f.client, f.store, Date.now(), ['other']);
  f.store.set('core.disabled', G, ['membership']);
  await sweepMembershipTasks(f.client, f.store);
  assert.deepEqual(f.granted, []);
  await f.execute('membership.roles.consent', { enabled: false }, f.userCtx);
  assert.equal(f.store.get('membership.saved', `${G}:${U}`), undefined);
  assert.equal(f.store.get('membership.restore', `${G}:${U}`), undefined);
});
test('Consent withdrawal during member lookup prevents late role grants and does not resurrect work', async (t) => {
  const f = fixture(t);
  await f.setup();
  queueRejoinRoles(f.target as unknown as GuildMember, f.store);
  f.target.roles.cache.clear();
  f.gateway.fetch = async () => {
    f.store.delete('membership.saved', `${G}:${U}`);
    f.store.delete('membership.restore', `${G}:${U}`);
    return f.actor;
  };
  await sweepMembershipTasks(f.client, f.store);
  assert.deepEqual(f.granted, []);
  assert.equal(f.store.get('membership.restore', `${G}:${U}`), undefined);
});
test('Onboarding DMs require existing consent and do not send after consent is withdrawn during DM creation', async (t) => {
  const f = fixture(t);
  await f.execute('membership.onboarding.configure', { text: 'Welcome to {server}, {user}!' });
  await assert.rejects(() => f.execute('membership.onboarding.start', {}, f.userCtx), /Opt into/);
  assert.deepEqual(f.sent, []);
  f.store.set('notifications.consent', `${G}:${U}`, { enabled: true, dm: true });
  await f.execute('membership.onboarding.start', {}, f.userCtx);
  assert.equal(f.sent.length, 1);
  f.target.createDM = async () => {
    f.store.delete('notifications.consent', `${G}:${U}`);
    return { send: async (payload: { content: string }) => f.sent.push(payload.content) };
  };
  await assert.rejects(() => f.execute('membership.onboarding.start', {}, f.userCtx), /cancelled/);
  assert.equal(f.sent.length, 1);
});

test('Reconsenting or toggling membership during DM creation invalidates old onboarding delivery', async (t) => {
  for (const change of ['consent', 'module'] as const)
    await t.test(change, async (sub) => {
      const f = fixture(sub);
      await f.execute('membership.onboarding.configure', { text: 'Welcome' });
      f.store.set('notifications.consent', `${G}:${U}`, {
        enabled: true,
        dm: true,
        createdAt: 10,
        version: 'before',
      });
      f.target.createDM = async () => {
        if (change === 'consent')
          f.store.set('notifications.consent', `${G}:${U}`, {
            enabled: true,
            dm: true,
            createdAt: 10,
            version: 'after',
          });
        else f.store.set('core.featureEpochs', `${G}:membership`, 2);
        return { send: async (payload: { content: string }) => f.sent.push(payload.content) };
      };
      await assert.rejects(() => f.execute('membership.onboarding.start', {}, f.userCtx), /cancelled/);
      assert.deepEqual(f.sent, []);
    });
});
