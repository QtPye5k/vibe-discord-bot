import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits as P, PermissionsBitField, type Client } from 'discord.js';
import { z } from 'zod';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import {
  registerEngagementActions,
  observeEngagementMemberCount,
  sweepEngagementTasks,
} from '../src/features/engagement.js';
const G = '700000000000000001',
  A = '700000000000000002',
  B = '700000000000000003',
  C = '700000000000000004',
  U = '700000000000000005',
  V = '700000000000000006',
  W = '700000000000000007',
  R = '700000000000000008',
  OTHER = '700000000000000009';
const POSTS = 'engagement.posts',
  JOBS = 'engagement.deliveries';
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  registerEngagementActions(registry);
  const hidden = new Set<string>(),
    sends: Record<string, unknown>[] = [];
  const controls = { fetch: async () => {}, send: async () => {}, canSend: true };
  const member = (id: string, admin = false) => ({
    id,
    guild: { id: G },
    permissions: new PermissionsBitField(admin ? P.Administrator : 0n),
    roles: {
      cache: new Map<string, unknown>(),
      add: async () => {
        throw new Error('Roster must never assign Discord roles');
      },
    },
  });
  const actor = member(A, true),
    bot = member(B, true),
    user = member(U),
    guest = member(V),
    third = member(W);
  const members = new Map([actor, bot, user, guest, third].map((value) => [value.id, value]));
  const role = { id: R, guild: { id: G } };
  const channel = {
    id: C,
    guildId: G,
    type: ChannelType.GuildText,
    isThread: () => false,
    isSendable: () => true,
    permissionsFor: (principal: { id: string }) =>
      new PermissionsBitField(
        hidden.has(principal.id) ? 0n : controls.canSend ? P.ViewChannel | P.SendMessages : P.ViewChannel,
      ),
    send: async (payload: Record<string, unknown>) => {
      await controls.send();
      sends.push(payload);
      return { id: 'message' };
    },
  };
  const guild = {
    id: G,
    name: 'Guild',
    memberCount: 10,
    members: {
      me: bot,
      fetch: async (value: string | { user: string }) => {
        const id = typeof value === 'string' ? value : value.user;
        const m = members.get(id);
        if (!m) throw Object.assign(new Error('Unknown member'), { code: 10007 });
        return m;
      },
      fetchMe: async () => bot,
    },
    roles: { fetch: async () => role },
    channels: {
      fetch: async () => {
        await controls.fetch();
        return channel;
      },
    },
  };
  const client = { guilds: { fetch: async () => guild } } as unknown as Client;
  const context = (id = A) =>
    ({ client, store, guild, member: members.get(id)!, channelId: C }) as unknown as ActionContext;
  const execute = async (name: string, input: unknown = {}, id = A) => {
    const action = registry.get(name);
    return action.execute(context(id), action.schema.parse(input));
  };
  const configure = async (capacity = 1, waitlistCapacity = 2) =>
    execute('group.configure', {
      id: 'club',
      kind: 'club',
      name: 'Readers',
      channelId: C,
      capacity,
      waitlistCapacity,
    });
  const questions = async () =>
    execute('engagement.questions.set', {
      id: 'daily',
      channelId: C,
      questions: ['First question?', 'Second question?'],
      hourUtc: 9,
    });
  const due = () => {
    const row = store.get<Record<string, unknown>>(POSTS, `${G}:questions:daily`)!;
    row.nextAt = Date.now() - 1000;
    store.set(POSTS, `${G}:questions:daily`, row);
  };
  return {
    store,
    registry,
    client,
    guild,
    actor,
    bot,
    user,
    guest,
    third,
    members,
    role,
    channel,
    hidden,
    sends,
    controls,
    context,
    execute,
    configure,
    questions,
    due,
  };
}
test('engagement catalog strict schemas and shared confirmation do not mutate before approval', async (t) => {
  const f = fixture(t);
  assert.equal(f.registry.list().length, 17);
  for (const action of f.registry.list()) assert.doesNotThrow(() => z.toJSONSchema(action.schema));
  const pending = await f.registry.request(f.context(), 'group.configure', {
    id: 'club',
    kind: 'club',
    name: 'Readers',
    channelId: C,
    capacity: 1,
  });
  assert.equal(pending.status, 'confirmation');
  assert.equal(f.store.list('engagement.groups').length, 0);
  assert.throws(() =>
    f.registry
      .get('engagement.questions.set')
      .schema.parse({ id: 'daily', channelId: C, questions: [], hourUtc: 24 }),
  );
});
test('capacity and waitlist enrollment is opt-in idempotent and FIFO with private member rosters', async (t) => {
  const f = fixture(t);
  await f.configure();
  await f.execute('group.enroll', { id: 'club' }, U);
  await f.execute('group.enroll', { id: 'club' }, V);
  await f.execute('group.enroll', { id: 'club' }, W);
  await f.execute('group.enroll', { id: 'club' }, V);
  const list = (await f.execute('group.list', {}, V)) as {
    members?: string[];
    waitlist?: string[];
    waitingPosition: number;
    memberCount: number;
    waitingCount: number;
  }[];
  assert.equal(list[0]!.members, undefined);
  assert.equal(list[0]!.waitlist, undefined);
  assert.equal(list[0]!.waitingPosition, 1);
  assert.equal(list[0]!.memberCount, 1);
  assert.equal(list[0]!.waitingCount, 2);
  const staff = (await f.execute('group.list')) as { members: string[]; waitlist: string[] }[];
  assert.deepEqual(staff[0]!.members, [U]);
  assert.deepEqual(staff[0]!.waitlist, [V, W]);
  await assert.rejects(f.execute('group.enroll', { id: 'club' }, A), /full/);
  await f.execute('group.leave', { id: 'club' }, U);
  const row = f.store.get<{ members: string[]; waitlist: string[] }>('engagement.groups', `${G}:club`)!;
  assert.deepEqual(row.members, [V]);
  assert.deepEqual(row.waitlist, [W]);
});
test('increasing roster capacity promotes waitlist before new entrants and shrinking below enrollment fails', async (t) => {
  const f = fixture(t);
  await f.configure();
  await f.execute('group.enroll', { id: 'club' }, U);
  await f.execute('group.enroll', { id: 'club' }, V);
  await f.execute('group.enroll', { id: 'club' }, W);
  await f.configure(2);
  const row = f.store.get<{ members: string[]; waitlist: string[] }>('engagement.groups', `${G}:club`)!;
  assert.deepEqual(row.members, [U, V]);
  assert.deepEqual(row.waitlist, [W]);
  await assert.rejects(f.configure(1), /shrinking/);
});
test('hidden rosters stay out of lists and cannot accept enrollments', async (t) => {
  const f = fixture(t);
  await f.configure();
  f.hidden.add(U);
  assert.deepEqual(await f.execute('group.list', {}, U), []);
  await assert.rejects(f.execute('group.enroll', { id: 'club' }, U), /view/);
  assert.equal(f.store.get<{ members: string[] }>('engagement.groups', `${G}:club`)!.members.length, 0);
});
test('current configured manager role can propose tasks only for consented seated members', async (t) => {
  const f = fixture(t);
  await f.execute('group.configure', {
    id: 'club',
    kind: 'volunteer',
    name: 'Volunteers',
    channelId: C,
    managerRoleId: R,
    capacity: 3,
  });
  await f.execute('group.enroll', { id: 'club' }, U);
  await f.execute('group.enroll', { id: 'club' }, V);
  f.user.roles.cache.set(R, f.role);
  const result = (await f.execute(
    'group.assignment.set',
    { groupId: 'club', id: 'shift', userId: V, task: 'Help with introductions' },
    U,
  )) as { status: string };
  assert.equal(result.status, 'proposed');
  await assert.rejects(
    f.execute('group.assignment.set', { groupId: 'club', id: 'other', userId: W, task: 'Help' }, U),
    /explicitly enroll/,
  );
  f.user.roles.cache.delete(R);
  await assert.rejects(
    f.execute('group.assignment.set', { groupId: 'club', id: 'other', userId: V, task: 'Help' }, U),
    /manager role/,
  );
});
test('task acceptance belongs to the target and completion requires prior acceptance', async (t) => {
  const f = fixture(t);
  await f.configure(3);
  await f.execute('group.enroll', { id: 'club' }, U);
  await f.execute('group.enroll', { id: 'club' }, V);
  await f.execute('group.assignment.set', {
    groupId: 'club',
    id: 'shift',
    userId: U,
    task: 'Staff the local event',
  });
  await assert.rejects(
    f.execute('group.assignment.respond', { groupId: 'club', id: 'shift', status: 'accepted' }, V),
    /another person/,
  );
  await assert.rejects(
    f.execute('group.assignment.respond', { groupId: 'club', id: 'shift', status: 'completed' }, U),
    /Accept/,
  );
  await f.execute('group.assignment.respond', { groupId: 'club', id: 'shift', status: 'accepted' }, U);
  await f.execute('group.assignment.respond', { groupId: 'club', id: 'shift', status: 'completed' }, U);
  const own = (await f.execute('group.assignment.list', { groupId: 'club' }, U)) as { status: string }[];
  assert.equal(own[0]!.status, 'completed');
  assert.deepEqual(await f.execute('group.assignment.list', { groupId: 'club' }, V), []);
  assert.equal(f.sends.length, 0);
});
test('personal leave and erasure work despite lost roster visibility and preserve another member data', async (t) => {
  const f = fixture(t);
  await f.configure(2);
  await f.execute('group.enroll', { id: 'club' }, U);
  await f.execute('group.enroll', { id: 'club' }, V);
  await f.execute('group.assignment.set', { groupId: 'club', id: 'shift', userId: U, task: 'Own task' });
  await f.execute('group.assignment.set', { groupId: 'club', id: 'other', userId: V, task: 'Other task' });
  f.hidden.add(U);
  f.store.set('core.disabled', G, ['engagement']);
  await f.execute('group.leave', { id: 'club' }, U);
  const erased = (await f.execute('group.erase.mine', {}, U)) as { assignmentsDeleted: number };
  assert.equal(erased.assignmentsDeleted, 1);
  assert.ok(f.store.get('engagement.assignments', `${G}:club:other`));
});
test('stale roster revision during awaited access cannot enroll into changed scope', async (t) => {
  const f = fixture(t);
  await f.configure();
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((r) => {
      started = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  f.controls.fetch = async () => {
    started();
    await gate;
  };
  const enrolling = f.execute('group.enroll', { id: 'club' }, U);
  await entered;
  const row = f.store.get<{ revision: number }>('engagement.groups', `${G}:club`)!;
  row.revision++;
  f.store.set('engagement.groups', `${G}:club`, row);
  release();
  await assert.rejects(enrolling, /changed during authorization/);
});
test('daily question posts rotate durably and do not burst missed days', async (t) => {
  const f = fixture(t);
  await f.questions();
  f.due();
  const now = Date.now();
  await sweepEngagementTasks(f.client, f.store, now);
  await sweepEngagementTasks(f.client, f.store, now);
  assert.equal(f.sends.length, 1);
  assert.match(String(f.sends[0]!.content), /First question/);
  assert.equal(f.sends[0]!.enforceNonce, true);
  assert.deepEqual(f.sends[0]!.allowedMentions, { parse: [] });
  const policy = f.store.get<{ nextAt: number; cursor: number }>(POSTS, `${G}:questions:daily`)!;
  assert.ok(policy.nextAt > now);
  assert.equal(policy.cursor, 1);
  await sweepEngagementTasks(f.client, f.store, now + 4 * 86400000);
  assert.equal(f.sends.length, 2);
  assert.match(String(f.sends[1]!.content), /Second question/);
});
test('milestones use silent baseline and only once per configured future observed threshold', async (t) => {
  const f = fixture(t);
  await f.execute('engagement.milestone.set', {
    id: 'growth',
    channelId: C,
    thresholds: [5, 10, 12, 15],
    template: '{server} reached {count}!',
  });
  await sweepEngagementTasks(f.client, f.store);
  assert.equal(f.sends.length, 0);
  const before = f.store.list(JOBS).length;
  f.guild.memberCount = 15;
  observeEngagementMemberCount(
    f.guild as unknown as Parameters<typeof observeEngagementMemberCount>[0],
    f.store,
  );
  assert.equal(f.store.list(JOBS).length, before);
  await sweepEngagementTasks(f.client, f.store);
  assert.equal(f.sends.length, 2);
  assert.match(String(f.sends[0]!.content), /12/);
  assert.match(String(f.sends[1]!.content), /15/);
  f.guild.memberCount = 11;
  observeEngagementMemberCount(
    f.guild as unknown as Parameters<typeof observeEngagementMemberCount>[0],
    f.store,
  );
  await sweepEngagementTasks(f.client, f.store);
  f.guild.memberCount = 15;
  observeEngagementMemberCount(
    f.guild as unknown as Parameters<typeof observeEngagementMemberCount>[0],
    f.store,
  );
  await sweepEngagementTasks(f.client, f.store);
  assert.equal(f.sends.length, 2);
  const p = f.store.get<{ announced: number[] }>(POSTS, `${G}:milestone:growth`)!;
  assert.deepEqual(p.announced, [12, 15]);
});
test('milestone expanded templates stay within Discord content bound', async (t) => {
  const f = fixture(t);
  await f.execute('engagement.milestone.set', {
    id: 'growth',
    channelId: C,
    thresholds: [12],
    template: '{server}'.repeat(180),
  });
  f.guild.name = 'x'.repeat(100);
  f.guild.memberCount = 12;
  observeEngagementMemberCount(
    f.guild as unknown as Parameters<typeof observeEngagementMemberCount>[0],
    f.store,
  );
  await sweepEngagementTasks(f.client, f.store);
  assert.equal(String(f.sends[0]!.content).length, 1900);
});
test('durable announcement retry preserves exact payload and nonce and disables after three failures', async (t) => {
  const f = fixture(t);
  await f.questions();
  f.due();
  const now = Date.now(),
    attempts: Record<string, unknown>[] = [];
  f.channel.send = async (payload) => {
    attempts.push(payload);
    throw new Error('PRIVATE ERROR BODY');
  };
  await sweepEngagementTasks(f.client, f.store, now);
  await sweepEngagementTasks(f.client, f.store, now + 30000);
  await sweepEngagementTasks(f.client, f.store, now + 90000);
  await sweepEngagementTasks(f.client, f.store, now + 1000000);
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts[0], attempts[2]);
  const p = f.store.get<{ enabled: boolean; lastError: string }>(POSTS, `${G}:questions:daily`)!;
  assert.equal(p.enabled, false);
  assert.equal(p.lastError, 'Error');
  assert.equal(JSON.stringify(f.store.list(JOBS)).includes('PRIVATE ERROR BODY'), false);
});
test('allowlist and engagement pause prevent queuing/sending until resumed', async (t) => {
  const f = fixture(t);
  await f.questions();
  f.due();
  await sweepEngagementTasks(f.client, f.store, Date.now(), [OTHER]);
  assert.equal(f.store.list(JOBS).length, 0);
  f.store.set('core.disabled', G, ['engagement']);
  await sweepEngagementTasks(f.client, f.store);
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.list(JOBS).length, 0);
  f.store.set('core.disabled', G, []);
  await sweepEngagementTasks(f.client, f.store);
  assert.equal(f.sends.length, 1);
});
test('lost author permission disables automatic policy without sending', async (t) => {
  const f = fixture(t);
  await f.questions();
  f.due();
  f.actor.permissions = new PermissionsBitField(0n);
  await sweepEngagementTasks(f.client, f.store);
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.get<{ enabled: boolean }>(POSTS, `${G}:questions:daily`)!.enabled, false);
});
test('cancellation during awaited channel access cannot resurrect job or send', async (t) => {
  const f = fixture(t);
  await f.questions();
  f.due();
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((r) => {
      started = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  f.controls.fetch = async () => {
    started();
    await gate;
  };
  const running = sweepEngagementTasks(f.client, f.store);
  await entered;
  await f.execute('engagement.questions.remove', { id: 'daily' });
  release();
  await running;
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.list(JOBS).length, 0);
  assert.equal(f.store.list(POSTS).length, 0);
});
test('policy version replacement invalidates captured announcement job', async (t) => {
  const f = fixture(t);
  await f.questions();
  f.due();
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((r) => {
      started = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  f.controls.fetch = async () => {
    started();
    await gate;
  };
  const running = sweepEngagementTasks(f.client, f.store);
  await entered;
  f.controls.fetch = async () => {};
  await f.questions();
  const replacement = f.store.get(POSTS, `${G}:questions:daily`);
  release();
  await running;
  assert.equal(f.sends.length, 0);
  assert.deepEqual(f.store.get(POSTS, `${G}:questions:daily`), replacement);
  await sweepEngagementTasks(f.client, f.store);
  assert.equal(f.sends.length, 0);
});
test('concurrent sweeps serialize delivery and pause during accepted send preserves completion', async (t) => {
  const f = fixture(t);
  await f.questions();
  f.due();
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((r) => {
      started = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  f.controls.send = async () => {
    started();
    await gate;
    f.store.set('core.disabled', G, ['engagement']);
  };
  const first = sweepEngagementTasks(f.client, f.store);
  await entered;
  await sweepEngagementTasks(f.client, f.store);
  release();
  await first;
  f.store.set('core.disabled', G, []);
  await sweepEngagementTasks(f.client, f.store);
  assert.equal(f.sends.length, 1);
  assert.equal(f.store.list<{ status: string }>(JOBS)[0]!.value.status, 'done');
});
