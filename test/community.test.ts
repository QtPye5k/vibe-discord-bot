import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Collection,
  PermissionFlagsBits as P,
  PermissionsBitField,
  type GuildMember,
  type Role,
} from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import {
  awardObservedXp,
  claimDaily,
  communityPatchSchema,
  communitySettingsSchema,
  drawGiveaway,
  getProfile,
  levelForXp,
  onCommunityMessage,
  registerCommunityActions,
  settings,
  sweepCommunityTasks,
  transferCoins,
} from '../src/features/community.js';

const GUILD = '100000000000000001',
  USER = '100000000000000002',
  OTHER = '100000000000000003';
const CHANNEL = '100000000000000004',
  BOT = '100000000000000005',
  ROLE = '100000000000000006';
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const role = {
    id: ROLE,
    name: 'Support',
    managed: false,
    position: 1,
    guild: { id: GUILD },
    permissions: new PermissionsBitField(0n),
  } as unknown as Role;
  const highest = { comparePositionTo: (value: { position?: number }) => 100 - (value.position ?? 1) };
  const member = {
    id: USER,
    user: { id: USER, bot: false, username: 'member' },
    roles: { cache: new Collection(), highest, add: async () => undefined, remove: async () => undefined },
    permissions: new PermissionsBitField(P.Administrator),
  };
  const other = {
    ...member,
    id: OTHER,
    user: { id: OTHER, bot: false, username: 'other' },
    roles: { ...member.roles, cache: new Collection() },
    permissions: new PermissionsBitField(P.Administrator),
  };
  const bot = { ...member, id: BOT };
  const members = new Map([
    [USER, member],
    [OTHER, other],
    [BOT, bot],
  ]);
  const hidden = new Set<string>();
  const channel = {
    id: CHANNEL,
    guildId: GUILD,
    type: 0,
    topic: null as string | null,
    parentId: null as string | null,
    setParent: async (parentId: string | null, _options?: unknown) => {
      channel.parentId = parentId;
    },
    isSendable: () => true,
    isTextBased: () => true,
    permissionsFor: (target?: { id: string }) =>
      new PermissionsBitField(target && hidden.has(target.id) ? 0n : P.Administrator),
    send: async () => ({ id: 'message' }),
    permissionOverwrites: {
      edit: async (_id: string, _permissions: Record<string, boolean>, _options?: unknown) => undefined,
    },
    messages: { fetch: async () => new Collection() },
  };
  const channels = new Collection([[CHANNEL, channel]]);
  const guild = {
    id: GUILD,
    ownerId: USER,
    name: 'test',
    members: {
      me: bot,
      fetchMe: async () => bot,
      fetch: async (input: string | { user: string }) => {
        const id = typeof input === 'string' ? input : input.user;
        const result = members.get(id);
        if (!result) throw new Error('Member not found');
        return result;
      },
    },
    roles: { fetch: async (id: string) => (id === ROLE ? role : null) },
    channels: {
      fetch: async (id?: string) => (id ? (channels.get(id) ?? null) : channels),
      create: async (data?: Record<string, unknown>) => {
        channel.topic = (data?.topic as string | undefined) ?? channel.topic;
        return channel;
      },
    },
  };
  for (const item of members.values()) Object.assign(item, { guild });
  const client = { channels: { fetch: async () => channel }, guilds: { fetch: async () => guild } };
  const ctx = { store, client, guild, member, channelId: CHANNEL } as unknown as ActionContext;
  const registry = new ActionRegistry(120, async (context) => context);
  registerCommunityActions(registry);
  const execute = (id: string, input: unknown = {}, context = ctx) => {
    const action = registry.get(id);
    return action.execute(context, action.schema.parse(input));
  };
  return { store, ctx, registry, execute, members, guild, channel, channels, hidden, client, role };
}

test('community patch updates preserve previous configuration and reject unknown keys', async (t) => {
  const { store, execute } = fixture(t);
  store.set('community.settings', GUILD, {
    ...communitySettingsSchema.parse({}),
    welcomeTemplate: 'Hello {name}',
    faqEnabled: true,
  });
  assert.deepEqual(communityPatchSchema.parse({ xpEnabled: true }), { xpEnabled: true });
  await execute('community.configure', { xpEnabled: true });
  assert.equal(settings(store, GUILD).welcomeTemplate, 'Hello {name}');
  assert.equal(settings(store, GUILD).faqEnabled, true);
  assert.equal(settings(store, GUILD).xpEnabled, true);
  assert.throws(() => communityPatchSchema.parse({ token: 'no' }));
});

test('daily reward persists its 24-hour cooldown across process restarts', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-community-'));
  let reopened: Store | undefined;
  t.after(() => {
    reopened?.close();
    assert.ok(dir.startsWith(join(tmpdir(), 'discord-community-')));
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, 'bot.sqlite'),
    now = 1_800_000_000_000;
  const first = new Store(path);
  claimDaily(first, GUILD, USER, now);
  first.close();
  const second = new Store(path);
  reopened = second;
  assert.throws(() => claimDaily(second, GUILD, USER, now + 1000), /Daily reward/);
  assert.equal(getProfile(second, GUILD, USER).balance, 100);
  assert.equal(claimDaily(second, GUILD, USER, now + 86_400_000).balance, 200);
});

test('daily rewards are isolated by guild and user', (t) => {
  const { store } = fixture(t),
    now = 1_800_000_000_000;
  claimDaily(store, GUILD, USER, now);
  claimDaily(store, 'other-guild', USER, now);
  claimDaily(store, GUILD, OTHER, now);
  assert.equal(getProfile(store, GUILD, USER).balance, 100);
  assert.equal(getProfile(store, 'other-guild', USER).balance, 100);
  assert.equal(getProfile(store, GUILD, OTHER).balance, 100);
});
test('Daily streak rewards are transactional, survive reconstruction and reset after the 48-hour grace period', (t) => {
  const f = fixture(t),
    now = Date.now() - 10 * 86400000;
  for (let day = 0; day < 7; day++) claimDaily(f.store, GUILD, USER, now + day * 86400000);
  const profile = getProfile(f.store, GUILD, USER);
  assert.equal(profile.balance, 750);
  assert.equal(profile.dailyStreak, 7);
  assert.equal(profile.bestDailyStreak, 7);
  assert.equal(profile.lastDailyReward, 150);
  assert.throws(() => claimDaily(f.store, GUILD, USER, now + 6 * 86400000 + 1000), /Daily reward/);
  assert.equal(getProfile(f.store, GUILD, USER).dailyStreak, 7);
  const reset = claimDaily(f.store, GUILD, USER, now + 9 * 86400000);
  assert.equal(reset.dailyStreak, 1);
  assert.equal(reset.bestDailyStreak, 7);
  assert.equal(reset.lastDailyReward, 100);
  f.store.set('community.profiles', `${GUILD}:${USER}`, { ...reset, balance: 1_000_000_000_000 });
  assert.throws(() => claimDaily(f.store, GUILD, USER, now + 10 * 86400000), /range/);
  assert.equal(getProfile(f.store, GUILD, USER).dailyStreak, 1);
});

test('coin transfer conserves total supply and rejects overdraft, self, fractional and negative transfers', (t) => {
  const { store } = fixture(t);
  claimDaily(store, GUILD, USER);
  assert.deepEqual(transferCoins(store, GUILD, USER, OTHER, 40), { fromBalance: 60, toBalance: 40 });
  for (const amount of [61, -1, 0, 0.5, Number.MAX_SAFE_INTEGER])
    assert.throws(() => transferCoins(store, GUILD, USER, OTHER, amount));
  assert.throws(() => transferCoins(store, GUILD, USER, USER, 1));
  assert.equal(getProfile(store, GUILD, USER).balance + getProfile(store, GUILD, OTHER).balance, 100);
});

test('recipient overflow rolls back a transfer without debiting sender', (t) => {
  const { store } = fixture(t);
  claimDaily(store, GUILD, USER);
  store.set('community.profiles', `${GUILD}:${OTHER}`, {
    ...getProfile(store, GUILD, OTHER),
    balance: 1_000_000_000_000,
  });
  assert.throws(() => transferCoins(store, GUILD, USER, OTHER, 1), /limit/);
  assert.equal(getProfile(store, GUILD, USER).balance, 100);
});

test('observed XP respects opt-in and cooldown and keeps servers isolated', (t) => {
  const { store } = fixture(t),
    now = 1_800_000_000_000;
  assert.equal(awardObservedXp(store, GUILD, USER, now), false);
  store.set('community.settings', GUILD, { xpEnabled: true, xpCooldownSeconds: 60, xpPerMessage: 20 });
  assert.equal(awardObservedXp(store, GUILD, USER, now), true);
  assert.equal(awardObservedXp(store, GUILD, USER, now + 59_999), false);
  assert.equal(awardObservedXp(store, GUILD, USER, now + 60_000), true);
  assert.equal(getProfile(store, GUILD, USER).xp, 40);
  assert.equal(getProfile(store, GUILD, USER).messages, 2);
  assert.equal(getProfile(store, 'other-guild', USER).xp, 0);
  assert.equal(levelForXp(399), 1);
  assert.equal(levelForXp(400), 2);
});

test('shop purchases deduct the exact cost once and retain owned inventory after delisting', async (t) => {
  const { store, execute } = fixture(t);
  claimDaily(store, GUILD, USER);
  await execute('shop.set', { itemId: 'badge', name: 'Badge', price: 30 });
  assert.deepEqual(await execute('shop.buy', { itemId: 'badge', quantity: 2 }), {
    item: 'Badge',
    quantity: 2,
    cost: 60,
    coins: 40,
  });
  assert.throws(() => execute('shop.buy', { itemId: 'badge', quantity: 2 }), /Insufficient/);
  assert.equal(getProfile(store, GUILD, USER).balance, 40);
  assert.deepEqual(await execute('shop.inventory'), { badge: 2 });
  await execute('shop.remove', { itemId: 'badge' });
  assert.deepEqual(await execute('shop.inventory'), { badge: 2 });
});

test('shop rejects unsafe item keys and zero-price items', (t) => {
  const { execute } = fixture(t);
  assert.throws(() => execute('shop.set', { itemId: '__proto__', name: 'bad', price: 1 }));
  assert.throws(() => execute('shop.set', { itemId: 'constructor', name: 'bad', price: 1 }));
  assert.throws(() => execute('shop.set', { itemId: 'free', name: 'bad', price: 0 }));
  assert.throws(() => execute('shop.buy', { itemId: 'badge', quantity: -1 }));
});

test('FAQ keys normalize case and only exact matches respond', async (t) => {
  const { store, execute, ctx } = fixture(t);
  await execute('faq.set', { keyword: 'Rules', response: 'Be kind.' });
  store.set('community.settings', GUILD, { faqEnabled: true });
  const replies: string[] = [];
  const message = {
    guild: ctx.guild,
    author: { id: USER, bot: false },
    member: ctx.member,
    client: ctx.client,
    webhookId: null,
    channelId: CHANNEL,
    channel: { isSendable: () => true },
    content: ' rules ',
    reply: async (value: { content: string }) => replies.push(value.content),
  };
  await onCommunityMessage(message as unknown as Parameters<typeof onCommunityMessage>[0], store);
  assert.deepEqual(replies, ['Be kind.']);
  message.content = 'Please show the rules';
  await onCommunityMessage(message as unknown as Parameters<typeof onCommunityMessage>[0], store);
  assert.equal(replies.length, 1);
});

test('passive community hooks stop when the category is disabled', async (t) => {
  const { store, ctx } = fixture(t);
  store.set('core.disabled', GUILD, ['community']);
  store.set('community.settings', GUILD, { xpEnabled: true });
  const message = {
    guild: ctx.guild,
    author: { id: USER, bot: false },
    member: ctx.member,
    webhookId: null,
    content: 'Hello world',
  };
  await onCommunityMessage(message as unknown as Parameters<typeof onCommunityMessage>[0], store);
  assert.equal(getProfile(store, GUILD, USER).xp, 0);
});

test('case.mine excludes staff notes and another member’s cases', async (t) => {
  const { store, execute } = fixture(t);
  store.set('community.cases', `${GUILD}:1`, {
    id: '1',
    userId: USER,
    moderatorId: OTHER,
    reason: 'warning',
    createdAt: Date.now(),
    notes: [{ text: 'private staff context' }],
  });
  store.set('community.cases', `${GUILD}:2`, {
    id: '2',
    userId: OTHER,
    moderatorId: USER,
    reason: 'other warning',
    createdAt: Date.now(),
    notes: [],
  });
  const result = (await execute('case.mine')) as Record<string, unknown>[];
  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, '1');
  assert.equal('notes' in result[0]!, false);
});

test('appeals enforce ownership, single submission, and separate reviewer', async (t) => {
  const { store, execute, ctx, members } = fixture(t);
  store.set('community.cases', `${GUILD}:1`, {
    id: '1',
    userId: USER,
    moderatorId: OTHER,
    reason: 'warning',
    createdAt: Date.now(),
    notes: [],
  });
  const otherCtx = { ...ctx, member: members.get(OTHER) as unknown as GuildMember };
  await assert.rejects(
    async () => execute('appeal.submit', { caseId: '1', explanation: 'I disagree' }, otherCtx),
    /own case/,
  );
  await execute('appeal.submit', { caseId: '1', explanation: 'Please review' });
  await assert.rejects(
    async () => execute('appeal.submit', { caseId: '1', explanation: 'Again' }),
    /already has/,
  );
  assert.throws(
    () => execute('appeal.review', { caseId: '1', approve: true, decision: 'fine' }),
    /own appeal/,
  );
  await execute('appeal.review', { caseId: '1', approve: true, decision: 'Approved' }, otherCtx);
  assert.equal(
    store.get<{ appeal: { status: string } }>('community.cases', `${GUILD}:1`)?.appeal.status,
    'approved',
  );
});

test('report queue enforces five-per-hour submission limit and a single owner', async (t) => {
  const { execute, ctx, members } = fixture(t);
  for (let i = 0; i < 5; i++) await execute('report.submit', { userId: OTHER, reason: `Report ${i}` });
  await assert.rejects(
    async () => execute('report.submit', { userId: OTHER, reason: 'sixth' }),
    /five reports/,
  );
  await execute('report.claim', { reportId: '1' });
  assert.throws(
    () =>
      execute(
        'report.claim',
        { reportId: '1' },
        { ...ctx, member: members.get(OTHER) as unknown as GuildMember },
      ),
    /Another moderator/,
  );
  await execute('report.resolve', { reportId: '1', resolution: 'Resolved' });
  const closed = (await execute('report.list', { status: 'closed' })) as unknown[];
  assert.equal(closed.length, 1);
});

test('ticket creation reserves before asynchronous create and permits only one active ticket', async (t) => {
  const { store, execute, guild } = fixture(t);
  store.set('community.settings', GUILD, { staffRoleId: ROLE });
  const originalCreate = guild.channels.create;
  let finish!: () => void;
  guild.channels.create = async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return originalCreate();
  };
  const first = execute('ticket.open', { subject: 'Help' });
  // role and category reads happen first, so allow their continuations to settle.
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(async () => execute('ticket.open', { subject: 'Duplicate' }), /already being created/);
  finish();
  await first;
  await assert.rejects(async () => execute('ticket.open', { subject: 'Another' }), /existing ticket/);
});

test('explicitly rejected ticket creation releases its reservation for a retry', async (t) => {
  const { store, execute, guild } = fixture(t);
  store.set('community.settings', GUILD, { staffRoleId: ROLE });
  const original = guild.channels.create;
  guild.channels.create = async () => {
    throw Object.assign(new Error('Discord rejected the request'), { status: 403 });
  };
  await assert.rejects(async () => execute('ticket.open', { subject: 'Help' }), /rejected/);
  assert.equal(store.get('community.activeTickets', `${GUILD}:${USER}`), undefined);
  guild.channels.create = original;
  await execute('ticket.open', { subject: 'Retry' });
  assert.equal(
    store.get<{ channelId: string }>('community.activeTickets', `${GUILD}:${USER}`)?.channelId,
    CHANNEL,
  );
});

test('ticket closure retains transcript and releases the active-ticket slot', async (t) => {
  const { store, execute, channel } = fixture(t);
  store.set('community.settings', GUILD, { staffRoleId: ROLE });
  await execute('ticket.open', { subject: 'Help' });
  let overwriteChanged = false;
  channel.permissionOverwrites.edit = async () => {
    overwriteChanged = true;
  };
  await execute('ticket.close', { channelId: CHANNEL });
  assert.equal(overwriteChanged, true);
  assert.equal(store.get<{ status: string }>('community.tickets', `${GUILD}:${CHANNEL}`)?.status, 'closed');
  assert.equal(store.get('community.activeTickets', `${GUILD}:${USER}`), undefined);
});

test('transport-uncertain ticket creation keeps its durable reservation and blocks duplicate creation', async (t) => {
  const f = fixture(t);
  f.store.set('community.settings', GUILD, { staffRoleId: ROLE });
  let creates = 0;
  f.guild.channels.create = async () => {
    creates++;
    throw new Error('Connection ended after sending');
  };
  await assert.rejects(async () => f.execute('ticket.open', { subject: 'Help' }), /Connection/);
  const status = (await f.execute('ticket.status')) as {
    reservation: { reservation: string; state: string };
  };
  assert.equal(status.reservation.state, 'needs-review');
  assert.ok(status.reservation.reservation);
  await assert.rejects(async () => f.execute('ticket.open', { subject: 'Again' }), /already being created/);
  assert.equal(creates, 1);
});

test('HTTP 408 remains uncertain and interrupted-ticket maintenance never automatically releases an unmatched reservation', async (t) => {
  const f = fixture(t);
  f.store.set('community.settings', GUILD, { staffRoleId: ROLE });
  f.guild.channels.create = async () => {
    throw Object.assign(new Error('Timeout'), { status: 408 });
  };
  await assert.rejects(async () => f.execute('ticket.open', { subject: 'Help' }), /Timeout/);
  const key = `${GUILD}:${USER}`,
    row = f.store.get<{ createdAt: number }>('community.activeTickets', key)!;
  row.createdAt -= 700_000;
  f.store.set('community.activeTickets', key, row);
  await sweepCommunityTasks(f.client as unknown as Parameters<typeof sweepCommunityTasks>[0], f.store);
  assert.ok(f.store.get('community.activeTickets', key));
});

test('exact reservation topics recover a successful creation after an ambiguous response without another create', async (t) => {
  const f = fixture(t);
  f.store.set('community.settings', GUILD, { staffRoleId: ROLE });
  const create = f.guild.channels.create;
  let creates = 0;
  f.guild.channels.create = async (data) => {
    creates++;
    await create(data);
    throw new Error('Response lost');
  };
  await assert.rejects(async () => f.execute('ticket.open', { subject: 'Help' }), /lost/);
  const key = `${GUILD}:${USER}`,
    row = f.store.get<{ reservation: string; createdAt: number }>('community.activeTickets', key)!;
  const exact = f.channel.topic;
  f.channel.topic = `${exact} tampered`;
  await assert.rejects(
    async () =>
      f.execute('ticket.reconcile', { reservation: row.reservation, outcome: 'created', channelId: CHANNEL }),
    /exact creation reservation/,
  );
  f.channel.topic = exact;
  const recovered = (await f.execute('ticket.reconcile', {
    reservation: row.reservation,
    outcome: 'created',
    channelId: CHANNEL,
  })) as { channelId: string };
  assert.equal(recovered.channelId, CHANNEL);
  assert.equal(creates, 1);
  assert.equal(f.store.get<{ channelId: string }>('community.activeTickets', key)?.channelId, CHANNEL);
});

test('staff may explicitly release a settled unmatched reservation but cannot release a matching created channel', async (t) => {
  const f = fixture(t);
  f.store.set('community.settings', GUILD, { staffRoleId: ROLE });
  f.guild.channels.create = async () => {
    throw new Error('Response lost');
  };
  await assert.rejects(async () => f.execute('ticket.open', { subject: 'Help' }));
  const key = `${GUILD}:${USER}`,
    row = f.store.get<{ reservation: string; subject: string; createdAt: number }>(
      'community.activeTickets',
      key,
    )!;
  await assert.rejects(
    async () => f.execute('ticket.reconcile', { reservation: row.reservation, outcome: 'not-created' }),
    /two minutes/,
  );
  row.createdAt -= 121_000;
  f.store.set('community.activeTickets', key, row);
  f.channel.topic = `Support request ${row.reservation} for ${USER}: ${row.subject}`;
  await assert.rejects(
    async () => f.execute('ticket.reconcile', { reservation: row.reservation, outcome: 'not-created' }),
    /matching channel exists/,
  );
  f.channel.topic = null;
  const result = (await f.execute('ticket.reconcile', {
    reservation: row.reservation,
    outcome: 'not-created',
  })) as { released: boolean };
  assert.equal(result.released, true);
  assert.equal(f.store.get('community.activeTickets', key), undefined);
});

test('automatic recovery attaches exactly one matching channel', async (t) => {
  const f = fixture(t);
  f.store.set('community.settings', GUILD, { staffRoleId: ROLE });
  const create = f.guild.channels.create;
  f.guild.channels.create = async (data) => {
    await create(data);
    throw new Error('Response lost');
  };
  await assert.rejects(async () => f.execute('ticket.open', { subject: 'Help' }));
  const key = `${GUILD}:${USER}`,
    row = f.store.get<{ createdAt: number }>('community.activeTickets', key)!;
  row.createdAt -= 700_000;
  f.store.set('community.activeTickets', key, row);
  await sweepCommunityTasks(f.client as unknown as Parameters<typeof sweepCommunityTasks>[0], f.store);
  assert.equal(f.store.get<{ channelId: string }>('community.activeTickets', key)?.channelId, CHANNEL);
  assert.equal(f.store.get<{ status: string }>('community.tickets', `${GUILD}:${CHANNEL}`)?.status, 'open');
});

test('an old maintenance response cannot resurrect a replaced ticket reservation', async (t) => {
  const f = fixture(t);
  f.store.set('community.settings', GUILD, { staffRoleId: ROLE });
  const create = f.guild.channels.create;
  f.guild.channels.create = async (data) => {
    await create(data);
    throw new Error('Lost response');
  };
  await assert.rejects(async () => f.execute('ticket.open', { subject: 'Help' }));
  const key = `${GUILD}:${USER}`,
    old = f.store.get<{ reservation: string; createdAt: number }>('community.activeTickets', key)!;
  old.createdAt -= 700_000;
  f.store.set('community.activeTickets', key, old);
  const replacement = { ...old, reservation: '00000000-0000-4000-8000-000000000001', createdAt: Date.now() };
  f.client.guilds.fetch = async () => {
    f.store.set('community.activeTickets', key, replacement);
    return f.guild;
  };
  await sweepCommunityTasks(f.client as unknown as Parameters<typeof sweepCommunityTasks>[0], f.store);
  assert.equal(
    f.store.get<{ reservation: string; channelId?: string }>('community.activeTickets', key)?.reservation,
    replacement.reservation,
  );
  assert.equal(f.store.get<{ channelId?: string }>('community.activeTickets', key)?.channelId, undefined);
  assert.equal(f.store.get('community.tickets', `${GUILD}:${CHANNEL}`), undefined);
});

test('active creation cannot be reconciled concurrently while its Discord request is still running', async (t) => {
  const f = fixture(t);
  f.store.set('community.settings', GUILD, { staffRoleId: ROLE });
  let release!: () => void;
  const original = f.guild.channels.create;
  f.guild.channels.create = async (data) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return original(data);
  };
  const opening = f.execute('ticket.open', { subject: 'Help' });
  await new Promise((resolve) => setImmediate(resolve));
  const row = f.store.get<{ reservation: string }>('community.activeTickets', `${GUILD}:${USER}`)!;
  await assert.rejects(
    async () => f.execute('ticket.reconcile', { reservation: row.reservation, outcome: 'not-created' }),
    /still active/,
  );
  release();
  await opening;
});

test('ticket transfer requires a current human staff member with access and respects unassignment', async (t) => {
  const f = fixture(t);
  f.store.set('community.settings', GUILD, { staffRoleId: ROLE });
  await f.execute('ticket.open', { subject: 'Help' });
  f.members.get(OTHER)!.permissions = new PermissionsBitField(P.ViewChannel);
  await assert.rejects(
    async () => f.execute('ticket.transfer', { channelId: CHANNEL, assigneeId: OTHER }),
    /human support staff/,
  );
  f.members.get(OTHER)!.permissions = new PermissionsBitField(P.ModerateMembers);
  f.hidden.add(OTHER);
  await assert.rejects(
    async () => f.execute('ticket.transfer', { channelId: CHANNEL, assigneeId: OTHER }),
    /human support staff/,
  );
  f.hidden.delete(OTHER);
  const assigned = (await f.execute('ticket.transfer', { channelId: CHANNEL, assigneeId: OTHER })) as {
    assigneeId: string;
  };
  assert.equal(assigned.assigneeId, OTHER);
  const unassigned = (await f.execute('ticket.transfer', { channelId: CHANNEL, assigneeId: null })) as {
    assigneeId?: string;
  };
  assert.equal(unassigned.assigneeId, undefined);
});

test('staff privilege revocation during transfer aborts without saving an assignee', async (t) => {
  const f = fixture(t);
  f.store.set('community.settings', GUILD, { staffRoleId: ROLE });
  await f.execute('ticket.open', { subject: 'Help' });
  const original = f.guild.members.fetch;
  f.guild.members.fetch = async (input) => {
    const result = await original(input);
    if ((typeof input === 'string' ? input : input.user) === OTHER)
      f.members.get(USER)!.permissions = new PermissionsBitField(P.ViewChannel);
    return result;
  };
  await assert.rejects(
    async () => f.execute('ticket.transfer', { channelId: CHANNEL, assigneeId: OTHER }),
    /Support staff/,
  );
  assert.equal(
    f.store.get<{ assigneeId?: string }>('community.tickets', `${GUILD}:${CHANNEL}`)?.assigneeId,
    undefined,
  );
});

test('priority and tags are staff controlled and are excluded from a nonstaff owner’s list', async (t) => {
  const f = fixture(t);
  f.store.set('community.settings', GUILD, { staffRoleId: ROLE });
  await f.execute('ticket.open', { subject: 'Help' });
  await f.execute('ticket.update', {
    channelId: CHANNEL,
    priority: 'urgent',
    tags: ['billing', 'billing', 'follow-up'],
  });
  const stored = f.store.get<{ priority: string; tags: string[] }>(
    'community.tickets',
    `${GUILD}:${CHANNEL}`,
  )!;
  assert.equal(stored.priority, 'urgent');
  assert.deepEqual(stored.tags, ['billing', 'follow-up']);
  f.members.get(USER)!.permissions = new PermissionsBitField(P.ViewChannel);
  await assert.rejects(
    async () => f.execute('ticket.update', { channelId: CHANNEL, priority: 'low' }),
    /Support staff/,
  );
  const listed = (await f.execute('ticket.list')) as { priority?: string; tags?: string[] }[];
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.priority, undefined);
  assert.equal(listed[0]!.tags, undefined);
});

test('category moves preserve explicit overwrites and failed moves do not save category metadata', async (t) => {
  const f = fixture(t);
  f.store.set('community.settings', GUILD, { staffRoleId: ROLE });
  await f.execute('ticket.open', { subject: 'Help' });
  const categoryId = '100000000000000007';
  f.channels.set(categoryId, { ...f.channel, id: categoryId, type: 4 });
  let options: unknown;
  f.channel.setParent = async (parentId, value) => {
    f.channel.parentId = parentId;
    options = value;
  };
  await f.execute('ticket.category', { channelId: CHANNEL, categoryId });
  assert.equal(f.channel.parentId, categoryId);
  assert.equal((options as { lockPermissions: boolean }).lockPermissions, false);
  f.channel.setParent = async () => {
    throw new Error('Network failure');
  };
  await assert.rejects(
    async () => f.execute('ticket.category', { channelId: CHANNEL, categoryId: null }),
    /Network/,
  );
  assert.equal(
    f.store.get<{ categoryId: string }>('community.tickets', `${GUILD}:${CHANNEL}`)?.categoryId,
    categoryId,
  );
});

test('close and archive retain history while denying owner posting and then visibility', async (t) => {
  const f = fixture(t);
  f.store.set('community.settings', GUILD, { staffRoleId: ROLE });
  await f.execute('ticket.open', { subject: 'Help' });
  const changes: Record<string, boolean>[] = [];
  f.channel.permissionOverwrites.edit = async (_id, value) => {
    changes.push(value);
  };
  await assert.rejects(async () => f.execute('ticket.archive', { channelId: CHANNEL }), /Close/);
  await f.execute('ticket.close', { channelId: CHANNEL });
  assert.equal(changes[0]!.SendMessages, false);
  assert.equal(changes[0]!.SendMessagesInThreads, false);
  await f.execute('ticket.archive', { channelId: CHANNEL });
  assert.equal(changes[1]!.ViewChannel, false);
  assert.equal(
    f.store.get<{ status: string }>('community.tickets', `${GUILD}:${CHANNEL}`)?.status,
    'archived',
  );
  assert.equal(f.store.get('community.activeTickets', `${GUILD}:${USER}`), undefined);
});

test('failed closure leaves its active slot and state intact and concurrent mutation is rejected', async (t) => {
  const f = fixture(t);
  f.store.set('community.settings', GUILD, { staffRoleId: ROLE });
  await f.execute('ticket.open', { subject: 'Help' });
  f.channel.permissionOverwrites.edit = async () => {
    throw new Error('Denied');
  };
  await assert.rejects(async () => f.execute('ticket.close', { channelId: CHANNEL }), /Denied/);
  assert.equal(f.store.get<{ status: string }>('community.tickets', `${GUILD}:${CHANNEL}`)?.status, 'open');
  assert.ok(f.store.get('community.activeTickets', `${GUILD}:${USER}`));
  let release!: () => void;
  f.channel.permissionOverwrites.edit = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const closing = f.execute('ticket.close', { channelId: CHANNEL });
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    async () => f.execute('ticket.update', { channelId: CHANNEL, priority: 'high' }),
    /still active/,
  );
  release();
  await closing;
  assert.equal(
    f.store.get<{ priority: string }>('community.tickets', `${GUILD}:${CHANNEL}`)?.priority,
    'normal',
  );
});

test('closed ticket satisfaction is one-time, owner-only and expires after thirty days', async (t) => {
  const f = fixture(t);
  f.store.set('community.settings', GUILD, { staffRoleId: ROLE });
  await f.execute('ticket.open', { subject: 'Help' });
  await assert.rejects(async () => f.execute('ticket.rate', { ticketId: CHANNEL, score: 5 }), /Close/);
  await f.execute('ticket.close', { channelId: CHANNEL });
  await assert.rejects(
    async () =>
      f.execute('ticket.rate', { ticketId: CHANNEL, score: 5 }, {
        ...f.ctx,
        member: f.members.get(OTHER)!,
      } as unknown as ActionContext),
    /owner/,
  );
  await f.execute('ticket.rate', { ticketId: CHANNEL, score: 4, comment: 'Solved quickly' });
  await assert.rejects(
    async () => f.execute('ticket.rate', { ticketId: CHANNEL, score: 1 }),
    /already submitted/,
  );
  const feedback = (await f.execute('ticket.feedback', { ticketId: CHANNEL })) as {
    feedback: { score: number };
  };
  assert.equal(feedback.feedback.score, 4);
  const row = f.store.get<Record<string, unknown>>('community.tickets', `${GUILD}:${CHANNEL}`)!;
  delete row.feedback;
  row.closedAt = Date.now() - 31 * 86_400_000;
  f.store.set('community.tickets', `${GUILD}:${CHANNEL}`, row);
  await assert.rejects(async () => f.execute('ticket.rate', { ticketId: CHANNEL, score: 5 }), /expired/);
});

test('an archived owner can submit feedback from another accessible channel without gaining ticket access', async (t) => {
  const f = fixture(t);
  f.store.set('community.settings', GUILD, { staffRoleId: ROLE });
  await f.execute('ticket.open', { subject: 'Help' });
  await f.execute('ticket.close', { channelId: CHANNEL });
  await f.execute('ticket.archive', { channelId: CHANNEL });
  f.members.get(USER)!.permissions = new PermissionsBitField(P.ViewChannel);
  f.hidden.add(USER);
  const commandId = '100000000000000008';
  f.channels.set(commandId, {
    ...f.channel,
    id: commandId,
    permissionsFor: () => new PermissionsBitField(P.Administrator),
  });
  const context = { ...f.ctx, channelId: commandId };
  await f.execute('ticket.rate', { ticketId: CHANNEL, score: 5 }, context);
  const feedback = (await f.execute('ticket.feedback', { ticketId: CHANNEL }, context)) as {
    feedback: { score: number };
  };
  assert.equal(feedback.feedback.score, 5);
  await assert.rejects(async () => f.execute('ticket.transcript', { channelId: CHANNEL }, context), /view/);
});

test('self-service role assignment revalidates privilege changes after allowlisting', async (t) => {
  const { store, execute, role } = fixture(t);
  store.set('community.settings', GUILD, { selfRoleIds: [ROLE] });
  role.permissions.add(P.Administrator);
  await assert.rejects(async () => execute('selfrole.add', { roleId: ROLE }), /privileged/);
});

test('temporary role assignment never schedules removal of an existing role', async (t) => {
  const { execute, members } = fixture(t);
  members.get(OTHER)!.roles.cache.set(ROLE, {});
  await assert.rejects(
    async () => execute('temprole.assign', { userId: OTHER, roleId: ROLE, minutes: 1 }),
    /already has/,
  );
});

test('giveaway draw returns unique winners and tolerates fewer entrants than prizes', () => {
  assert.deepEqual(drawGiveaway([], 3), []);
  const winners = drawGiveaway([USER, USER, OTHER], 20);
  assert.equal(winners.length, 2);
  assert.equal(new Set(winners).size, 2);
  assert.deepEqual([...winners].sort(), [USER, OTHER].sort());
});
test('giveaway role, account age, membership age and level eligibility are checked at entry and again for selected winners', async (t) => {
  const f = fixture(t),
    member = f.members.get(USER)!;
  Object.assign(member.user, { createdTimestamp: Date.now() - 100 * 86400000 });
  Object.assign(member, { joinedTimestamp: Date.now() - 20 * 86400000 });
  const giveaway = (await f.execute('giveaway.create', {
    channelId: CHANNEL,
    prize: 'Badge',
    minutes: 1,
    roleIds: [ROLE],
    minimumAccountDays: 30,
    minimumMemberDays: 7,
    minimumLevel: 1,
  })) as { id: string; endsAt: number };
  await assert.rejects(async () => f.execute('giveaway.enter', { giveawayId: giveaway.id }), /requirements/);
  member.roles.cache.set(ROLE, f.role);
  await assert.rejects(async () => f.execute('giveaway.enter', { giveawayId: giveaway.id }), /requirements/);
  f.store.set('community.profiles', `${GUILD}:${USER}`, { ...getProfile(f.store, GUILD, USER), xp: 100 });
  await f.execute('giveaway.enter', { giveawayId: giveaway.id });
  member.roles.cache.clear();
  await sweepCommunityTasks(f.client as unknown as ClientForSweep, f.store, giveaway.endsAt + 1);
  assert.deepEqual(
    f.store.get<{ winners: string[] }>('community.giveaways', `${GUILD}:${giveaway.id}`)!.winners,
    [],
  );
});
type ClientForSweep = Parameters<typeof sweepCommunityTasks>[0];
test('giveaway cancellation during candidate lookup is preserved and uncertain membership retries the same candidate', async (t) => {
  const f = fixture(t),
    giveaway = (await f.execute('giveaway.create', { channelId: CHANNEL, prize: 'Badge', minutes: 1 })) as {
      id: string;
      endsAt: number;
    };
  await f.execute('giveaway.enter', { giveawayId: giveaway.id });
  const original = f.guild.members.fetch;
  let uncertain = true;
  f.guild.members.fetch = async (input) => {
    if (uncertain) throw new Error('transient');
    return original(input);
  };
  await sweepCommunityTasks(f.client as unknown as ClientForSweep, f.store, giveaway.endsAt + 1);
  const first = f.store.get<{ drawing: { pending: string; retryAt: number } }>(
    'community.giveaways',
    `${GUILD}:${giveaway.id}`,
  )!;
  assert.equal(first.drawing.pending, USER);
  uncertain = false;
  f.guild.members.fetch = async (input) => {
    await f.execute('giveaway.cancel', { giveawayId: giveaway.id });
    return original(input);
  };
  await sweepCommunityTasks(f.client as unknown as ClientForSweep, f.store, first.drawing.retryAt);
  assert.equal(
    f.store.get<{ status: string }>('community.giveaways', `${GUILD}:${giveaway.id}`)!.status,
    'cancelled',
  );
});

test('giveaway deadlines persist winners once and do not announce twice in a normal retry', async (t) => {
  const { store, execute, client, channel } = fixture(t);
  let announcements = 0;
  channel.send = async () => {
    announcements++;
    return { id: 'message' };
  };
  const giveaway = (await execute('giveaway.create', {
    channelId: CHANNEL,
    prize: 'A badge',
    minutes: 1,
    winners: 2,
  })) as { id: string; endsAt: number };
  await execute('giveaway.enter', { giveawayId: giveaway.id });
  await execute('giveaway.enter', { giveawayId: giveaway.id });
  const row = store.get<{ entrants: string[] }>('community.giveaways', `${GUILD}:${giveaway.id}`)!;
  assert.equal(row.entrants.length, 1);
  await sweepCommunityTasks(
    client as unknown as Parameters<typeof sweepCommunityTasks>[0],
    store,
    giveaway.endsAt + 1,
  );
  await sweepCommunityTasks(
    client as unknown as Parameters<typeof sweepCommunityTasks>[0],
    store,
    giveaway.endsAt + 2,
  );
  assert.equal(announcements, 2); // create announcement, then result announcement
  const result = store.get<{ status: string; winners: string[] }>(
    'community.giveaways',
    `${GUILD}:${giveaway.id}`,
  )!;
  assert.equal(result.status, 'drawn');
  assert.deepEqual(result.winners, [USER]);
});

test('personal erase removes only the requester’s community profile and retains moderation records', async (t) => {
  const { store, execute } = fixture(t);
  claimDaily(store, GUILD, USER);
  claimDaily(store, GUILD, OTHER);
  store.set('community.cases', `${GUILD}:1`, { userId: USER });
  await execute('community.erase');
  assert.equal(getProfile(store, GUILD, USER).balance, 0);
  assert.equal(getProfile(store, GUILD, OTHER).balance, 100);
  assert.ok(store.get('community.cases', `${GUILD}:1`));
});

test('every community write requires confirmation through the common registry', async (t) => {
  const { ctx, registry } = fixture(t);
  const result = await registry.request(ctx, 'economy.daily', {});
  assert.equal(result.status, 'confirmation');
  assert.equal(getProfile(ctx.store, GUILD, USER).balance, 0);
  if (result.status !== 'confirmation') throw new Error('Expected confirmation');
  await registry.confirm(ctx, result.id);
  assert.equal(getProfile(ctx.store, GUILD, USER).balance, 100);
  await assert.rejects(() => registry.confirm(ctx, result.id), /unavailable/);
});

test('community sweeper leaves every excluded-guild namespace untouched and makes no Discord requests', async (t) => {
  const { store, client } = fixture(t),
    now = Date.now();
  let reads = 0;
  client.guilds.fetch = async () => {
    reads++;
    throw new Error('Excluded guild must not be fetched');
  };
  store.set('community.tempRoles', `${OTHER}:${USER}:${ROLE}`, {
    userId: USER,
    roleId: ROLE,
    expiresAt: now - 1,
    attempts: 0,
  });
  store.set('community.giveaways', `${OTHER}:deadbeef`, {
    id: 'deadbeef',
    channelId: CHANNEL,
    prize: 'Prize',
    createdBy: USER,
    endsAt: now - 1,
    winnerCount: 1,
    entrants: [USER],
    status: 'open',
  });
  store.set('community.activeTickets', `${OTHER}:${USER}`, {
    createdAt: now - 700_000,
    reservation: 'pending',
  });
  store.set('community.trivia', `${OTHER}:${USER}`, {
    questionIndex: 0,
    createdAt: now - 500_000,
    attempts: 0,
  });
  const before = [
    'community.tempRoles',
    'community.giveaways',
    'community.activeTickets',
    'community.trivia',
  ].map((namespace) => store.list(namespace));
  await sweepCommunityTasks(client as unknown as Parameters<typeof sweepCommunityTasks>[0], store, now, [
    GUILD,
  ]);
  assert.equal(reads, 0);
  assert.deepEqual(
    ['community.tempRoles', 'community.giveaways', 'community.activeTickets', 'community.trivia'].map(
      (namespace) => store.list(namespace),
    ),
    before,
  );
});

test('existing temporary roles still expire with community actions disabled', async (t) => {
  const { store, client, members } = fixture(t),
    now = Date.now();
  let removed = 0;
  members.get(OTHER)!.roles.remove = async () => {
    removed++;
  };
  store.set('core.disabled', GUILD, ['community']);
  store.set('community.tempRoles', `${GUILD}:${OTHER}:${ROLE}`, {
    userId: OTHER,
    roleId: ROLE,
    expiresAt: now - 1,
    attempts: 0,
  });
  await sweepCommunityTasks(client as unknown as Parameters<typeof sweepCommunityTasks>[0], store, now, [
    GUILD,
  ]);
  assert.equal(removed, 1);
  assert.equal(store.get('community.tempRoles', `${GUILD}:${OTHER}:${ROLE}`), undefined);
});

test('disabled community pauses giveaways and draws once when re-enabled', async (t) => {
  const { store, client, channel } = fixture(t),
    now = Date.now();
  let sends = 0;
  channel.send = async () => {
    sends++;
    return { id: 'message' };
  };
  store.set('core.disabled', GUILD, ['community']);
  store.set('community.giveaways', `${GUILD}:deadbeef`, {
    id: 'deadbeef',
    channelId: CHANNEL,
    prize: 'Prize',
    createdBy: USER,
    endsAt: now - 1,
    winnerCount: 1,
    entrants: [USER],
    status: 'open',
  });
  await sweepCommunityTasks(client as unknown as Parameters<typeof sweepCommunityTasks>[0], store, now, [
    GUILD,
  ]);
  assert.equal(sends, 0);
  assert.equal(store.get<{ status: string }>('community.giveaways', `${GUILD}:deadbeef`)?.status, 'open');
  store.set('core.disabled', GUILD, []);
  await sweepCommunityTasks(client as unknown as Parameters<typeof sweepCommunityTasks>[0], store, now, [
    GUILD,
  ]);
  await sweepCommunityTasks(client as unknown as Parameters<typeof sweepCommunityTasks>[0], store, now + 1, [
    GUILD,
  ]);
  assert.equal(sends, 1);
});

test('disabled support pauses interrupted-ticket reconciliation and expired trivia is purged at five minutes', async (t) => {
  const { store, client } = fixture(t),
    now = Date.now();
  let reads = 0;
  client.guilds.fetch = async () => {
    reads++;
    throw new Error('Disabled support must not fetch');
  };
  store.set('core.disabled', GUILD, ['support']);
  store.set('community.activeTickets', `${GUILD}:${USER}`, {
    createdAt: now - 700_000,
    reservation: 'pending',
  });
  store.set('community.trivia', `${GUILD}:${USER}`, {
    questionIndex: 0,
    createdAt: now - 300_000,
    attempts: 0,
  });
  store.set('community.trivia', `${GUILD}:${OTHER}`, {
    questionIndex: 1,
    createdAt: now - 299_999,
    attempts: 0,
  });
  await sweepCommunityTasks(client as unknown as Parameters<typeof sweepCommunityTasks>[0], store, now, [
    GUILD,
  ]);
  assert.equal(reads, 0);
  assert.ok(store.get('community.activeTickets', `${GUILD}:${USER}`));
  assert.equal(store.get('community.trivia', `${GUILD}:${USER}`), undefined);
  assert.ok(store.get('community.trivia', `${GUILD}:${OTHER}`));
});

test('disabling moderation suppresses custom antispam without disabling opted-in XP', async (t) => {
  const { store, ctx } = fixture(t);
  let deletes = 0;
  store.set('core.disabled', GUILD, ['moderation']);
  store.set('community.settings', GUILD, {
    xpEnabled: true,
    antiSpamEnabled: true,
    blockedKeywords: ['forbidden'],
  });
  const message = {
    guild: ctx.guild,
    author: { id: USER, bot: false },
    member: { permissions: new PermissionsBitField(P.ViewChannel) },
    webhookId: null,
    content: 'forbidden message',
    channel: { isSendable: () => false },
    deletable: true,
    delete: async () => {
      deletes++;
    },
  };
  await onCommunityMessage(message as unknown as Parameters<typeof onCommunityMessage>[0], store);
  assert.equal(deletes, 0);
  assert.equal(getProfile(store, GUILD, USER).xp, 15);
});

test('giveaway announcement failures back off and stop after five attempts', async (t) => {
  const { store, client, channel } = fixture(t);
  let now = Date.now(),
    calls = 0;
  channel.send = async () => {
    calls++;
    throw new Error('Channel send unavailable');
  };
  const key = `${GUILD}:deadbeef`;
  store.set('community.giveaways', key, {
    id: 'deadbeef',
    channelId: CHANNEL,
    prize: 'Prize',
    createdBy: USER,
    endsAt: now - 1,
    winnerCount: 1,
    entrants: [USER],
    status: 'open',
  });
  for (let attempt = 1; attempt <= 5; attempt++) {
    await sweepCommunityTasks(client as unknown as Parameters<typeof sweepCommunityTasks>[0], store, now, [
      GUILD,
    ]);
    const state = store.get<{ announcementAttempts: number; announcementRetryAt: number; winners: string[] }>(
      'community.giveaways',
      key,
    )!;
    assert.equal(state.announcementAttempts, attempt);
    assert.deepEqual(state.winners, [USER]);
    await sweepCommunityTasks(
      client as unknown as Parameters<typeof sweepCommunityTasks>[0],
      store,
      now + 1,
      [GUILD],
    );
    assert.equal(calls, attempt);
    now = state.announcementRetryAt;
  }
  await sweepCommunityTasks(
    client as unknown as Parameters<typeof sweepCommunityTasks>[0],
    store,
    now + 1_000_000,
    [GUILD],
  );
  assert.equal(calls, 5);
});
