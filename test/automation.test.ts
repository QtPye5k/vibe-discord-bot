import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, PermissionFlagsBits as P, PermissionsBitField, type Client } from 'discord.js';
import { z } from 'zod';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import {
  parseCron,
  cronMatches,
  nextCron,
  registerAutomationActions,
  onAutomationEvent,
  sweepAutomationTasks,
  extractAutomationEvent,
} from '../src/features/automation.js';
const G = '500000000000000001',
  A = '500000000000000002',
  B = '500000000000000003',
  U = '500000000000000004',
  C = '500000000000000005',
  R = '500000000000000006',
  OTHER = '500000000000000007';
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const sends: Record<string, unknown>[] = [],
    roleAdds: string[] = [],
    deleted: string[] = [];
  const highest = { comparePositionTo: () => 1 };
  const actor = {
    id: A,
    displayName: 'Admin',
    user: { bot: false },
    permissions: new PermissionsBitField(P.Administrator),
    roles: { highest, cache: new Map() },
    voice: { channelId: C },
  };
  const bot = { id: B, permissions: new PermissionsBitField(P.Administrator), roles: { highest } };
  const target = {
    id: U,
    displayName: 'Guest',
    user: { bot: false },
    roles: {
      add: async (id: { id: string }) => {
        roleAdds.push(id.id);
      },
      highest,
      cache: new Map(),
    },
    voice: { channelId: C, setChannel: async () => undefined },
  };
  const transport = {
    send: async (options: Record<string, unknown>) => {
      sends.push(options);
      return { id: 'msg' };
    },
    roleAdd: async () => {
      roleAdds.push(R);
    },
  };
  target.roles.add = async () => transport.roleAdd();
  const channel = {
    id: C,
    guildId: G,
    type: ChannelType.GuildText,
    name: 'general',
    members: new Map(),
    isThread: () => false,
    isTextBased: () => true,
    isVoiceBased: () => false,
    isSendable: () => true,
    permissionsFor: () => new PermissionsBitField(P.Administrator),
    send: (options: Record<string, unknown>) => transport.send(options),
    delete: async () => {
      deleted.push(C);
    },
    permissionOverwrites: { edit: async () => undefined },
    messages: { fetch: async () => ({ hasThread: false, startThread: async () => ({ id: 'thread' }) }) },
  };
  const channels = new Map<string, typeof channel>([[C, channel]]);
  const role = { id: R, guild: { id: G }, managed: false, permissions: new PermissionsBitField(0n) };
  const guild = {
    id: G,
    ownerId: A,
    name: 'Guild',
    members: {
      me: bot,
      fetch: async (options: string | { user: string }) => {
        const id = typeof options === 'string' ? options : options.user;
        return id === A ? actor : target;
      },
      fetchMe: async () => bot,
    },
    roles: { fetch: async () => role },
    channels: {
      fetch: async (id: string) => channels.get(id) ?? null,
      create: async (options: Record<string, unknown>) => {
        const value = { ...channel, id: '500000000000000099', type: options.type as ChannelType.GuildText };
        channels.set(value.id, value);
        return value;
      },
    },
  };
  const client = { guilds: { fetch: async () => guild } } as unknown as Client;
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  registerAutomationActions(registry);
  const ctx = { client, store, guild, member: actor, channelId: C } as unknown as ActionContext;
  const execute = async (id: string, input: unknown = {}, who = ctx) => {
    const action = registry.get(id);
    return action.execute(who, action.schema.parse(input));
  };
  return {
    store,
    client,
    registry,
    ctx,
    execute,
    guild,
    actor,
    bot,
    target,
    channel,
    channels,
    role,
    sends,
    roleAdds,
    deleted,
    transport,
  };
}
test('Automation catalog exposes strict schemas and all policy changes require common confirmation', async (t) => {
  const f = fixture(t);
  assert.ok(f.registry.list().length >= 20);
  for (const action of f.registry.list()) assert.doesNotThrow(() => z.toJSONSchema(action.schema));
  const pending = await f.registry.request(f.ctx, 'workflow.set', {
    id: 'welcome',
    trigger: 'guildMemberAdd',
    steps: [{ kind: 'message', channelId: C, content: 'Welcome {user}' }],
  });
  assert.equal(pending.status, 'confirmation');
  assert.equal(f.store.list('automation.workflows').length, 0);
});
test('UTC cron parser implements lists ranges steps weekday aliases and standard DOM/DOW matching', () => {
  assert.equal(cronMatches('*/15 9-17 * * 1-5', new Date('2026-11-02T09:30:00Z')), true);
  assert.equal(cronMatches('*/15 9-17 * * 1-5', new Date('2026-11-01T09:30:00Z')), false);
  assert.equal(cronMatches('0 0 1 * 1', new Date('2026-11-02T00:00:00Z')), true);
  assert.equal(cronMatches('0 0 1 * 1', new Date('2026-11-01T00:00:00Z')), true);
  assert.equal(cronMatches('0 0 * * 7', new Date('2026-11-01T00:00:00Z')), true);
  assert.equal(cronMatches('7/15 * * * *', new Date('2026-11-01T00:22:00Z')), true);
  for (const value of [
    '* * * *',
    '60 * * * *',
    '*/0 * * * *',
    '0 25 * * *',
    '0 0 1 13 *',
    '0 0 * * 8',
    '0 0 * * MON',
  ])
    assert.throws(() => parseCron(value));
});
test('Cron next occurrence is strictly future UTC and handles leap days', () => {
  assert.equal(nextCron('0 0 * * *', Date.parse('2026-12-31T23:59:30Z')), Date.parse('2027-01-01T00:00:00Z'));
  assert.equal(
    nextCron('0 0 29 2 *', Date.parse('2027-10-01T00:00:00Z')),
    Date.parse('2028-02-29T00:00:00Z'),
  );
  assert.throws(() => nextCron('0 0 30 2 *', Date.parse('2026-01-01T00:00:00Z')), /366 days/);
});
test('A duplicate observed event enqueues only one durable job and completes once', async (t) => {
  const f = fixture(t);
  await f.execute('workflow.set', {
    id: 'welcome',
    trigger: 'guildMemberAdd',
    steps: [{ kind: 'message', channelId: C, content: 'Welcome {userId}' }],
  });
  const event = { id: U, guild: { id: G }, user: { id: U, bot: false }, joinedTimestamp: 1000 };
  await onAutomationEvent('guildMemberAdd', [event], f.client, f.store);
  await onAutomationEvent('guildMemberAdd', [event], f.client, f.store);
  assert.equal(f.store.list('automation.outbox').length, 1);
  await sweepAutomationTasks(f.client, f.store);
  await sweepAutomationTasks(f.client, f.store);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0]?.content, `Welcome ${U}`);
  assert.deepEqual(f.sends[0]?.allowedMentions, { parse: [] });
  assert.equal(f.sends[0]?.enforceNonce, true);
});
test('Policy replacement invalidates queued jobs instead of executing new unchecked steps', async (t) => {
  const f = fixture(t);
  await f.execute('workflow.set', {
    id: 'welcome',
    trigger: 'guildMemberAdd',
    steps: [{ kind: 'message', channelId: C, content: 'old' }],
  });
  await onAutomationEvent(
    'guildMemberAdd',
    [{ id: U, guild: { id: G }, user: { id: U } }],
    f.client,
    f.store,
  );
  await f.execute('workflow.set', {
    id: 'welcome',
    trigger: 'guildMemberAdd',
    steps: [{ kind: 'message', channelId: C, content: 'new' }],
  });
  await sweepAutomationTasks(f.client, f.store);
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.list<{ lastError: string }>('automation.outbox')[0]?.value.lastError, 'PolicyChanged');
});
test('Revoked policy-author permissions prevent automation side effects', async (t) => {
  const f = fixture(t);
  await f.execute('workflow.set', {
    id: 'welcome',
    trigger: 'guildMemberAdd',
    steps: [{ kind: 'message', channelId: C, content: 'hello' }],
  });
  await onAutomationEvent(
    'guildMemberAdd',
    [{ id: U, guild: { id: G }, user: { id: U } }],
    f.client,
    f.store,
  );
  f.actor.permissions = new PermissionsBitField(0n);
  await sweepAutomationTasks(f.client, f.store);
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.list<{ status: string }>('automation.outbox')[0]?.value.status, 'failed');
});
test('Workflow retries resume at failed steps without replaying completed message steps', async (t) => {
  const f = fixture(t);
  await f.execute('workflow.set', {
    id: 'welcome',
    trigger: 'guildMemberAdd',
    steps: [
      { kind: 'message', channelId: C, content: 'hello' },
      { kind: 'role', roleId: R },
    ],
  });
  await onAutomationEvent(
    'guildMemberAdd',
    [{ id: U, guild: { id: G }, user: { id: U } }],
    f.client,
    f.store,
  );
  let attempts = 0;
  f.transport.roleAdd = async () => {
    if (++attempts === 1) throw new Error('network');
    f.roleAdds.push(R);
  };
  await sweepAutomationTasks(f.client, f.store);
  const job = f.store.list<{ nextAt: number; step: number }>('automation.outbox')[0]!;
  assert.equal(job.value.step, 1);
  await sweepAutomationTasks(f.client, f.store, job.value.nextAt);
  assert.equal(f.sends.length, 1);
  assert.deepEqual(f.roleAdds, [R]);
});
test('Role workflows reject unsafe roles both at configuration and execution', async (t) => {
  const f = fixture(t);
  f.role.permissions.add(P.ManageRoles);
  await assert.rejects(
    f.execute('workflow.set', {
      id: 'unsafe',
      trigger: 'guildMemberAdd',
      steps: [{ kind: 'role', roleId: R }],
    }),
    /ordinary/,
  );
  f.role.permissions.remove(P.ManageRoles);
  await f.execute('workflow.set', {
    id: 'safe',
    trigger: 'guildMemberAdd',
    steps: [{ kind: 'role', roleId: R }],
  });
  await onAutomationEvent(
    'guildMemberAdd',
    [{ id: U, guild: { id: G }, user: { id: U } }],
    f.client,
    f.store,
  );
  f.role.permissions.add(P.Administrator);
  await sweepAutomationTasks(f.client, f.store);
  assert.equal(f.roleAdds.length, 0);
});
test('Message filters and source-channel visibility scope workflow event capture', async (t) => {
  const f = fixture(t);
  await f.execute('workflow.set', {
    id: 'faq',
    trigger: 'messageCreate',
    sourceChannelId: C,
    keyword: 'release',
    steps: [{ kind: 'message', channelId: C, content: 'ack' }],
  });
  await onAutomationEvent(
    'messageCreate',
    [{ id: 'm1', guildId: G, channelId: OTHER, author: { id: U }, content: 'release' }],
    f.client,
    f.store,
  );
  await onAutomationEvent(
    'messageCreate',
    [{ id: 'm2', guildId: G, channelId: C, author: { id: U, bot: true }, content: 'release' }],
    f.client,
    f.store,
  );
  await onAutomationEvent(
    'messageCreate',
    [{ id: 'm3', guildId: G, channelId: C, author: { id: U }, content: 'other' }],
    f.client,
    f.store,
  );
  assert.equal(f.store.list('automation.outbox').length, 0);
  await onAutomationEvent(
    'messageCreate',
    [{ id: 'm4', guildId: G, channelId: C, author: { id: U }, content: 'Release notes' }],
    f.client,
    f.store,
  );
  const job = f.store.list<{ event: Record<string, unknown> }>('automation.outbox')[0]!;
  assert.equal(job.value.event.content, undefined);
  f.channel.permissionsFor = () => new PermissionsBitField(0n);
  await sweepAutomationTasks(f.client, f.store);
  assert.equal(f.sends.length, 0);
});
test('Reaction and poll payload extraction reads event entity rather than the trailing user argument', () => {
  const reaction = extractAutomationEvent('messageReactionAdd', [
    { message: { id: 'message', guildId: G, channelId: C }, emoji: { name: 'yes' } },
    { id: U },
  ]);
  assert.equal(reaction?.guildId, G);
  assert.equal(reaction?.data.userId, U);
  const poll = extractAutomationEvent('messagePollVoteAdd', [
    { id: 2, poll: { message: { id: 'message', guildId: G, channelId: C } } },
    U,
  ]);
  assert.equal(poll?.data.userId, U);
  const webhook = extractAutomationEvent('discordWebhookEvent', [
    { event: { type: 'APPLICATION_AUTHORIZED', data: { guild: { id: G }, user: { id: U } } } },
  ]);
  assert.equal(webhook?.data.eventType, 'APPLICATION_AUTHORIZED');
});
test('Disabled automation and excluded guilds pause queued jobs without starving allowed entries', async (t) => {
  const f = fixture(t);
  await f.execute('workflow.set', {
    id: 'welcome',
    trigger: 'guildMemberAdd',
    steps: [{ kind: 'message', channelId: C, content: 'hi' }],
  });
  await onAutomationEvent(
    'guildMemberAdd',
    [{ id: U, guild: { id: G }, user: { id: U } }],
    f.client,
    f.store,
  );
  f.store.set('core.disabled', G, ['automation']);
  await sweepAutomationTasks(f.client, f.store);
  assert.equal(f.sends.length, 0);
  f.store.delete('core.disabled', G);
  await sweepAutomationTasks(f.client, f.store, Date.now(), [OTHER]);
  assert.equal(f.sends.length, 0);
  await sweepAutomationTasks(f.client, f.store);
  assert.equal(f.sends.length, 1);
});
test('Cron announcements retain stable nonce across transient retries and stop after three failures', async (t) => {
  const f = fixture(t);
  await f.execute('schedule.set', { id: 'daily', channelId: C, content: 'scheduled', cron: '* * * * *' });
  const schedule = f.store.get<{ nextAt: number; nonce: string }>('automation.schedules', `${G}:daily`)!;
  let count = 0;
  f.transport.send = async (options) => {
    count++;
    f.sends.push(options);
    throw new Error('network');
  };
  await sweepAutomationTasks(f.client, f.store, schedule.nextAt);
  let stored = f.store.get<{ retryAt: number; nonce: string; enabled: boolean }>(
    'automation.schedules',
    `${G}:daily`,
  )!;
  assert.equal(stored.nonce, schedule.nonce);
  await sweepAutomationTasks(f.client, f.store, stored.retryAt);
  stored = f.store.get('automation.schedules', `${G}:daily`)!;
  await sweepAutomationTasks(f.client, f.store, stored.retryAt);
  assert.equal(f.store.get<{ enabled: boolean }>('automation.schedules', `${G}:daily`)?.enabled, false);
  assert.equal(count, 3);
  assert.equal(new Set(f.sends.map((value) => value.nonce)).size, 1);
});
test('Temporary channels expire even after new automation is disabled; occupied voice channels are retained', async (t) => {
  const f = fixture(t);
  await f.execute('channel.temporary', { name: 'session', kind: 'text', minutes: 1 });
  const row = f.store.list<{ expiresAt: number; channelId: string }>('automation.channels')[0]!;
  f.store.set('core.disabled', G, ['automation']);
  await sweepAutomationTasks(f.client, f.store, row.value.expiresAt + 1);
  assert.equal(f.store.list('automation.channels').length, 0);
  const voice = { ...f.channel, id: OTHER, isVoiceBased: () => true, members: new Map([[U, f.target]]) };
  f.channels.set(OTHER, voice);
  f.store.set('automation.channels', `${G}:${OTHER}`, {
    guildId: G,
    channelId: OTHER,
    ownerId: A,
    expiresAt: 0,
    deleteWhenEmpty: true,
    attempts: 0,
    nextAt: 0,
  });
  await sweepAutomationTasks(f.client, f.store);
  assert.ok(f.store.get('automation.channels', `${G}:${OTHER}`));
});
test('Calendar RSVP capacity creates FIFO waitlist and promotes the first waiting user after cancellation', async (t) => {
  const f = fixture(t);
  await f.execute('calendar.create', {
    id: 'meetup',
    title: 'Meetup',
    channelId: C,
    startsAt: new Date(Date.now() + 120000).toISOString(),
    endsAt: new Date(Date.now() + 3600000).toISOString(),
    capacity: 1,
  });
  await f.execute('calendar.rsvp', { id: 'meetup', status: 'yes' });
  const second = { ...f.ctx, member: { ...f.ctx.member, id: U } } as ActionContext;
  assert.equal(
    ((await f.execute('calendar.rsvp', { id: 'meetup', status: 'yes' }, second)) as { status: string })
      .status,
    'waitlist',
  );
  await f.execute('calendar.rsvp', { id: 'meetup', status: 'no' });
  assert.equal(
    f.store.get<{ rsvps: Record<string, { status: string }> }>('automation.calendar', `${G}:meetup`)?.rsvps[U]
      ?.status,
    'yes',
  );
});
test('Calendar never reveals entries from channels a user cannot currently view', async (t) => {
  const f = fixture(t);
  await f.execute('calendar.create', {
    id: 'private',
    title: 'Staff',
    channelId: C,
    startsAt: new Date(Date.now() + 120000).toISOString(),
    endsAt: new Date(Date.now() + 3600000).toISOString(),
  });
  f.channel.permissionsFor = () => new PermissionsBitField(0n);
  assert.deepEqual(await f.execute('calendar.list'), []);
  await assert.rejects(f.execute('calendar.rsvp', { id: 'private', status: 'yes' }), /view/);
});
test('Birthday and anniversary opt-ins store no birth year and reject invalid dates', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.execute('celebration.set', { kind: 'birthday', month: 2, day: 30 }), /date/);
  await f.execute('celebration.set', { kind: 'birthday', month: 2, day: 29 });
  const entry = f.store.list<Record<string, unknown>>('automation.celebrations')[0]!.value;
  assert.equal(entry.userId, A);
  assert.equal(entry.year, undefined);
  await f.execute('celebration.remove', { kind: 'birthday' });
  assert.equal(f.store.list('automation.celebrations').length, 0);
});
test('Tournament bracket advances to a single champion and rejects unrelated winners', async (t) => {
  const f = fixture(t);
  await f.execute('tournament.create', { id: 'cup', title: 'Cup', channelId: C, userIds: [A, U, B, OTHER] });
  await assert.rejects(
    f.execute('tournament.result', { id: 'cup', match: 1, winnerId: B }),
    /unfinished match/,
  );
  await f.execute('tournament.result', { id: 'cup', match: 1, winnerId: A });
  await f.execute('tournament.result', { id: 'cup', match: 2, winnerId: B });
  const round2 = (await f.execute('tournament.view', { id: 'cup' })) as { round: number; matches: unknown[] };
  assert.equal(round2.round, 2);
  assert.equal(round2.matches.length, 1);
  await f.execute('tournament.result', { id: 'cup', match: 1, winnerId: A });
  assert.equal(((await f.execute('tournament.view', { id: 'cup' })) as { champion: string }).champion, A);
});
test('tournament dated match schedules reuse one-time announcements and stop obsolete round reminders', async (t) => {
  const f = fixture(t);
  await f.execute('tournament.create', {
    id: 'dates',
    title: 'Dated Cup',
    channelId: C,
    userIds: [A, U, B, OTHER],
  });
  const startsAt = new Date(Date.now() + 3600000).toISOString();
  await f.execute('tournament.schedule', {
    id: 'dates',
    round: 1,
    matches: [
      { match: 1, startsAt },
      { match: 2, startsAt },
    ],
    reminderMinutes: 15,
  });
  const schedules = f.store.list<{
    once: boolean;
    nextAt: number;
    enabled: boolean;
    tournament: { id: string };
  }>('automation.schedules', `${G}:`);
  assert.equal(schedules.length, 2);
  assert.ok(schedules.every((row) => row.value.once && row.value.tournament.id === 'dates'));
  const before = f.sends.length;
  await sweepAutomationTasks(f.client, f.store, Date.parse(startsAt) - 15 * 60000);
  assert.equal(f.sends.length, before + 2);
  await sweepAutomationTasks(f.client, f.store, Date.parse(startsAt));
  assert.equal(f.sends.length, before + 2);
  assert.ok(
    f.store.list<{ enabled: boolean }>('automation.schedules', `${G}:`).every((row) => !row.value.enabled),
  );
  await assert.rejects(
    () => f.execute('tournament.schedule', { id: 'dates', round: 2, matches: [{ match: 1, startsAt }] }),
    /current active/,
  );
});

test('A workflow removed during target lookup is rejected immediately before its first side effect', async (t) => {
  const f = fixture(t);
  await f.execute('workflow.set', {
    id: 'welcome',
    trigger: 'guildMemberAdd',
    steps: [{ kind: 'message', channelId: C, content: 'hello' }],
  });
  await onAutomationEvent(
    'guildMemberAdd',
    [{ id: U, guild: { id: G }, user: { id: U } }],
    f.client,
    f.store,
  );
  let release!: () => void;
  f.guild.channels.fetch = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return f.channel;
  };
  const pending = sweepAutomationTasks(f.client, f.store);
  await new Promise((resolve) => setImmediate(resolve));
  await f.execute('workflow.remove', { id: 'welcome' });
  release();
  await pending;
  assert.equal(f.sends.length, 0);
});

test('Calendar notification failures stop after three attempts with stable delivery identity', async (t) => {
  const f = fixture(t);
  const start = Date.now() + 120000;
  await f.execute('calendar.create', {
    id: 'event',
    title: 'Event',
    channelId: C,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 3600000).toISOString(),
    reminderMinutes: 1,
  });
  f.transport.send = async (options) => {
    f.sends.push(options);
    throw new Error('transient');
  };
  let now = start - 60000;
  for (let i = 0; i < 3; i++) {
    await sweepAutomationTasks(f.client, f.store, now);
    const event = f.store.get<{ reminderRetryAt: number }>('automation.calendar', `${G}:event`)!;
    now = event.reminderRetryAt;
  }
  await sweepAutomationTasks(f.client, f.store, now);
  assert.equal(f.sends.length, 3);
  assert.equal(new Set(f.sends.map((row) => row.nonce)).size, 1);
  assert.equal(
    f.store.get<{ reminderAttempts: number }>('automation.calendar', `${G}:event`)?.reminderAttempts,
    3,
  );
});
