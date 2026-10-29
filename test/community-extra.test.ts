import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Collection, PermissionsBitField, PermissionFlagsBits as P, type GuildMember } from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import {
  eraseCommunityExtra,
  registerCommunityExtraActions,
  sweepCommunityExtra,
} from '../src/features/community-extra.js';
const G = '720000000000000001',
  U = '720000000000000002',
  V = '720000000000000003',
  B = '720000000000000004',
  C = '720000000000000005',
  R = '720000000000000006';
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let sendCount = 0;
  const hooks: { fetch?: (id: string) => void; send?: () => void } = {};
  const user = {
    id: U,
    user: { id: U, bot: false, createdTimestamp: 1 },
    joinedTimestamp: 1,
    permissions: new PermissionsBitField(P.Administrator),
    roles: { cache: new Collection<string, unknown>() },
  };
  const other = {
    ...user,
    id: V,
    user: { id: V, bot: false, createdTimestamp: 1 },
    roles: { cache: new Collection<string, unknown>() },
  };
  const bot = { ...user, id: B, user: { id: B, bot: true, createdTimestamp: 1 } };
  const channel = {
    id: C,
    guildId: G,
    type: 0,
    isSendable: () => true,
    permissionsFor: () => new PermissionsBitField(P.Administrator),
    send: async () => {
      sendCount++;
      hooks.send?.();
      return { id: 'announcement' };
    },
  };
  const guild = {
    id: G,
    ownerId: U,
    members: {
      me: bot,
      fetchMe: async () => bot,
      fetch: async (input: string | { user: string }) => {
        const id = typeof input === 'string' ? input : input.user;
        hooks.fetch?.(id);
        return id === V ? other : user;
      },
    },
    channels: { fetch: async () => channel },
    roles: { fetch: async () => ({ id: R }) },
  };
  Object.assign(user, { guild });
  Object.assign(other, { guild });
  Object.assign(bot, { guild });
  const client = { guilds: { fetch: async () => guild } };
  const ctx = { client, store, guild, member: user, channelId: C } as unknown as ActionContext;
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  registerCommunityExtraActions(registry);
  const run = async (id: string, input: unknown = {}, context = ctx) => {
    const action = registry.get(id);
    return action.execute(context, action.schema.parse(input));
  };
  const setupRaffle = async (options: Record<string, unknown> = {}) => {
    await run('raffle.create', {
      id: 'example',
      title: 'Community drawing',
      prize: 'Fictional badge',
      freeEntry: true,
      channelId: C,
      closesAt: new Date(Date.now() + 120000).toISOString(),
      ...options,
    });
  };
  const close = () => {
    const row = store.get<Record<string, unknown>>('community.raffles', `${G}:example`)!;
    row.closesAt = Date.now() - 1;
    store.set('community.raffles', `${G}:example`, row);
  };
  return {
    store,
    ctx,
    client,
    registry,
    run,
    user,
    other,
    hooks,
    setupRaffle,
    close,
    sendCount: () => sendCount,
    otherCtx: { ...ctx, member: other as unknown as GuildMember },
  };
}
test('fictional currencies are named, supply-capped and disabled neither imply cash nor require external credentials', async (t) => {
  const f = fixture(t);
  await f.run('currency.create', { id: 'stars', name: 'Stars', symbol: '★', maxSupply: 100 });
  await f.run('currency.adjust', { currencyId: 'stars', userId: U, delta: 70, reason: 'Participation' });
  await f.run('currency.transfer', { currencyId: 'stars', userId: V, amount: 25 });
  assert.equal(
    ((await f.run('currency.balance', { currencyId: 'stars' })) as { balance: number }).balance,
    45,
  );
  assert.equal(
    ((await f.run('currency.balance', { currencyId: 'stars', userId: V })) as { balance: number }).balance,
    25,
  );
  await assert.rejects(
    () => f.run('currency.adjust', { currencyId: 'stars', userId: V, delta: 31, reason: 'Over cap' }),
    /supply cap/,
  );
  assert.equal(f.store.get<{ supply: number }>('currency.definitions', `${G}:stars`)!.supply, 70);
});
test('failed fictional transfers rollback both wallets and ledger and cannot cross currency boundaries', async (t) => {
  const f = fixture(t);
  for (const id of ['stars', 'points']) await f.run('currency.create', { id, name: id, symbol: id });
  await f.run('currency.adjust', { currencyId: 'stars', userId: U, delta: 10, reason: 'initial' });
  const before = f.store.list('currency.ledger').length;
  await assert.rejects(
    () => f.run('currency.transfer', { currencyId: 'stars', userId: V, amount: 11 }),
    /Insufficient/,
  );
  assert.equal(f.store.list('currency.ledger').length, before);
  assert.equal(
    ((await f.run('currency.balance', { currencyId: 'points' })) as { balance: number }).balance,
    0,
  );
  await assert.rejects(() => f.run('currency.delete', { currencyId: 'stars' }), /outstanding/);
});
test('personal community erasure burns own fictional balance and removes own ledger and open raffle receipts', async (t) => {
  const f = fixture(t);
  await f.run('currency.create', { id: 'stars', name: 'Stars', symbol: '★' });
  await f.run('currency.adjust', { currencyId: 'stars', userId: U, delta: 10, reason: 'initial' });
  await f.setupRaffle();
  await f.run('raffle.enter', { id: 'example' });
  f.store.transaction(() => eraseCommunityExtra(f.ctx));
  assert.equal(f.store.list('currency.wallets').length, 0);
  assert.equal(f.store.get<{ supply: number }>('currency.definitions', `${G}:stars`)!.supply, 0);
  assert.equal(f.store.list('currency.ledger').length, 0);
  assert.equal(((await f.run('raffle.view', { id: 'example' })) as { entrantCount: number }).entrantCount, 0);
});
test('raffles require explicitly free entry, validate eligibility, issue unique receipts and allow withdrawal', async (t) => {
  const f = fixture(t);
  assert.throws(() => f.registry.get('raffle.create').schema.parse({ freeEntry: false }));
  await f.setupRaffle({ roleIds: [R] });
  await assert.rejects(() => f.run('raffle.enter', { id: 'example' }), /eligibility/);
  f.user.roles.cache.set(R, {});
  const first = (await f.run('raffle.enter', { id: 'example' })) as { entry: { number: number } };
  const duplicate = (await f.run('raffle.enter', { id: 'example' })) as {
    entry: { number: number };
    alreadyEntered: boolean;
  };
  assert.equal(first.entry.number, duplicate.entry.number);
  assert.equal(duplicate.alreadyEntered, true);
  await f.run('raffle.withdraw', { id: 'example' });
  assert.equal(((await f.run('raffle.view', { id: 'example' })) as { entrantCount: number }).entrantCount, 0);
});
test('closed raffle draws persist one winner, export the receipt digest and never announce twice', async (t) => {
  const f = fixture(t);
  await f.setupRaffle();
  await f.run('raffle.enter', { id: 'example' }, f.otherCtx);
  f.close();
  const result = (await f.run('raffle.draw', { id: 'example' })) as {
    state: string;
    winners: string[];
    entryDigest: string;
  };
  assert.equal(result.state, 'drawn');
  assert.deepEqual(result.winners, [V]);
  assert.match(result.entryDigest, /^[a-f0-9]{64}$/);
  await f.run('raffle.draw', { id: 'example' });
  assert.equal(f.sendCount(), 1);
  const file = (await f.run('raffle.export', { id: 'example' })) as { attachment: Buffer };
  assert.equal(JSON.parse(file.attachment.toString()).entries[V].number, 1);
});
test('interrupted raffle candidate resolution resumes the same persisted candidate rather than rerandomizing', async (t) => {
  const f = fixture(t);
  await f.setupRaffle();
  await f.run('raffle.enter', { id: 'example' }, f.otherCtx);
  f.close();
  let fail = true;
  f.hooks.fetch = (id) => {
    if (id === V && fail) throw new Error('Network');
  };
  await assert.rejects(() => f.run('raffle.draw', { id: 'example' }), /Network/);
  assert.equal(f.store.get<{ pendingUser: string }>('community.raffles', `${G}:example`)!.pendingUser, V);
  fail = false;
  const result = (await f.run('raffle.draw', { id: 'example' })) as { winners: string[] };
  assert.deepEqual(result.winners, [V]);
});
test('raffle cancellation during awaited membership resolution cannot select or publish late winners', async (t) => {
  const f = fixture(t);
  await f.setupRaffle();
  await f.run('raffle.enter', { id: 'example' }, f.otherCtx);
  f.close();
  f.hooks.fetch = (id) => {
    if (id === V) {
      const row = f.store.get<Record<string, unknown>>('community.raffles', `${G}:example`)!;
      row.state = 'cancelled';
      f.store.set('community.raffles', `${G}:example`, row);
    }
  };
  await assert.rejects(() => f.run('raffle.draw', { id: 'example' }), /changed during drawing/);
  assert.equal(f.sendCount(), 0);
  assert.equal(f.store.get<{ state: string }>('community.raffles', `${G}:example`)!.state, 'cancelled');
});
test('raffle announcement ambiguous failures remain visible and are not blindly repeated by sweeps', async (t) => {
  const f = fixture(t);
  await f.setupRaffle();
  await f.run('raffle.enter', { id: 'example' });
  f.close();
  f.hooks.send = () => {
    throw new Error('Unknown send');
  };
  await f.run('raffle.draw', { id: 'example' });
  await sweepCommunityExtra(f.ctx.client, f.store);
  assert.equal(f.sendCount(), 1);
  assert.equal(
    f.store.get<{ announcement: string }>('community.raffles', `${G}:example`)!.announcement,
    'unknown',
  );
});
test('raffle deadlines resume through the actual registered community sweep and pause for excluded guilds', async (t) => {
  const f = fixture(t);
  await f.setupRaffle();
  await f.run('raffle.enter', { id: 'example' });
  f.close();
  await sweepCommunityExtra(f.ctx.client, f.store, Date.now(), ['different']);
  assert.equal(f.sendCount(), 0);
  await sweepCommunityExtra(f.ctx.client, f.store);
  assert.equal(f.sendCount(), 1);
});
test('raffles recheck winner role eligibility at draw time and conceal the full entrant list from ordinary views', async (t) => {
  const f = fixture(t);
  f.user.roles.cache.set(R, {});
  await f.setupRaffle({ roleIds: [R] });
  await f.run('raffle.enter', { id: 'example' });
  f.user.roles.cache.delete(R);
  f.close();
  const result = (await f.run('raffle.draw', { id: 'example' })) as { winners: string[] };
  assert.deepEqual(result.winners, []);
  const view = (await f.run('raffle.view', { id: 'example' })) as Record<string, unknown>;
  assert.equal('entries' in view, false);
});
