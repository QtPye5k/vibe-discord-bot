import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import { registerTemporaryBanActions, sweepTemporaryBans } from '../src/features/temporary-bans.js';
const G = '730000000000000001',
  U = '730000000000000002',
  V = '730000000000000003',
  B = '730000000000000004',
  C = '730000000000000005';
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const removed: string[] = [];
  let currentBan: { reason: string } | null = null,
    unknown = false;
  const highest = (n: number) => ({
    position: n,
    comparePositionTo: (other: { position: number }) => n - other.position,
  });
  const member = {
    id: U,
    permissions: new PermissionsBitField(P.Administrator),
    roles: { highest: highest(50), cache: new Map() },
  };
  const bot = {
    id: B,
    permissions: new PermissionsBitField(P.Administrator),
    roles: { highest: highest(100) },
  };
  const target = {
    id: V,
    bannable: true,
    roles: { highest: highest(1) },
    ban: async (input: { reason: string }) => {
      currentBan = { reason: input.reason };
      if (unknown) throw new Error('Unknown POST outcome');
    },
  };
  const guild = {
    id: G,
    ownerId: U,
    members: {
      me: bot,
      fetch: async (input: string | { user: string }) =>
        (typeof input === 'string' ? input : input.user) === V ? target : member,
      fetchMe: async () => bot,
    },
    channels: {
      fetch: async () => ({
        guildId: G,
        type: 0,
        permissionsFor: () => new PermissionsBitField(P.Administrator),
      }),
    },
    bans: {
      fetch: async () => {
        if (!currentBan) throw Object.assign(new Error('Unknown ban'), { code: 10026 });
        return currentBan;
      },
      remove: async (userId: string) => {
        removed.push(userId);
        currentBan = null;
      },
    },
  };
  Object.assign(target, { guild });
  Object.assign(member, { guild });
  const client = { guilds: { fetch: async () => guild } };
  const ctx = { store, client, guild, member, channelId: C } as unknown as ActionContext;
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  registerTemporaryBanActions(registry);
  const run = async (id: string, input: unknown) => {
    const action = registry.get(id);
    return action.execute(ctx, action.schema.parse(input));
  };
  const create = async () =>
    (await run('moderation.tempban', {
      memberId: V,
      durationSeconds: 60,
      reason: 'Explicit temporary punishment',
    })) as { id: string; expiresAt: number; caseId: string };
  return {
    ctx,
    store,
    registry,
    run,
    create,
    removed,
    bot,
    member,
    setBan: (value: { reason: string } | null) => {
      currentBan = value;
    },
    setUnknown: () => {
      unknown = true;
    },
  };
}
test('temporary bans record a native punishment case and expire after restart-style reconstruction even with moderation disabled', async (t) => {
  const f = fixture(t),
    row = await f.create();
  assert.ok(f.store.get('community.cases', `${G}:${row.caseId}`));
  f.store.set('core.disabled', G, ['moderation']);
  await sweepTemporaryBans(f.ctx.client, f.store, row.expiresAt + 1);
  assert.deepEqual(f.removed, [V]);
  assert.equal(f.store.get<{ state: string }>('moderation.tempBans', `${G}:${row.id}`)!.state, 'expired');
});
test('temporary expiry preserves a replacement moderator ban with a different provenance reason', async (t) => {
  const f = fixture(t),
    row = await f.create();
  f.setBan({ reason: 'New independent moderator ban' });
  await sweepTemporaryBans(f.ctx.client, f.store, row.expiresAt + 1);
  assert.deepEqual(f.removed, []);
  assert.equal(f.store.get<{ state: string }>('moderation.tempBans', `${G}:${row.id}`)!.state, 'conflict');
});
test('uncertain original ban POST is reconciled against Discord before later expiry rather than automatically banning again', async (t) => {
  const f = fixture(t);
  f.setUnknown();
  await assert.rejects(() => f.create(), /Unknown POST/);
  const row = f.store.list<{ id: string; expiresAt: number }>('moderation.tempBans')[0]!.value;
  await sweepTemporaryBans(f.ctx.client, f.store, row.expiresAt + 1);
  assert.deepEqual(f.removed, [V]);
});
test('temporary ban expiry pauses for excluded guilds and retries bounded failures without removing anything', async (t) => {
  const f = fixture(t),
    row = await f.create();
  await sweepTemporaryBans(f.ctx.client, f.store, row.expiresAt + 1, ['other']);
  assert.deepEqual(f.removed, []);
  f.bot.permissions = new PermissionsBitField(0n);
  for (let index = 0; index < 11; index++)
    await sweepTemporaryBans(f.ctx.client, f.store, row.expiresAt + index * 4000000);
  assert.equal(
    f.store.get<{ state: string; attempts: number }>('moderation.tempBans', `${G}:${row.id}`)!.attempts,
    10,
  );
  assert.deepEqual(f.removed, []);
});
test('early temporary-ban revocation needs current permission and preserves conflicting bans', async (t) => {
  const f = fixture(t),
    row = await f.create();
  f.member.permissions = new PermissionsBitField(P.ViewChannel);
  await assert.rejects(() => f.run('moderation.tempban-revoke', { id: row.id }), /Ban Members/);
  assert.deepEqual(f.removed, []);
  f.member.permissions = new PermissionsBitField(P.Administrator);
  f.setBan({ reason: 'Other moderator' });
  await assert.rejects(() => f.run('moderation.tempban-revoke', { id: row.id }), /preserved/);
  assert.deepEqual(f.removed, []);
});
test('already-removed temporary bans finish cleanup without issuing a redundant unban', async (t) => {
  const f = fixture(t),
    row = await f.create();
  f.setBan(null);
  await sweepTemporaryBans(f.ctx.client, f.store, row.expiresAt + 1);
  assert.equal(f.store.get<{ state: string }>('moderation.tempBans', `${G}:${row.id}`)!.state, 'expired');
  assert.deepEqual(f.removed, []);
});
