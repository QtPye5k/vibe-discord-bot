import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionsBitField, PermissionFlagsBits as P, type Client } from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import { registerCommunityActions } from '../src/features/community.js';
import {
  registerModerationActions,
  sweepModerationTasks,
  warningPolicySchema,
} from '../src/features/moderation.js';
const GUILD = '530000000000000001',
  USER = '530000000000000002',
  TARGET = '530000000000000003',
  BOT = '530000000000000004',
  CHANNEL = '530000000000000005',
  OWNER = '530000000000000006';
interface Job {
  id: string;
  state: string;
  attempts: number;
  retryAt: number;
  expiresAt: number;
  until?: number;
  lastError?: string;
  createdAt: number;
}
interface Issued {
  case: { id: string; reason: string };
  queuedJobs: string[];
}
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const hooks: {
    fetch?: (id: string) => Promise<void> | void;
    send?: () => Promise<void> | void;
    timeout?: () => Promise<void> | void;
  } = {};
  const makeMember = (id: string, position: number, permissions: bigint[]) => ({
    id,
    user: { id, username: id, bot: id === BOT },
    permissions: new PermissionsBitField(permissions),
    roles: {
      cache: new Collection(),
      highest: { position, comparePositionTo: (target: { position: number }) => position - target.position },
    },
    communicationDisabledUntilTimestamp: null as number | null,
    send: async (payload: Record<string, unknown>) => {
      await hooks.send?.();
      directMessages.push(payload);
      return { id: 'dm' };
    },
    disableCommunicationUntil: async (until: number, _reason: string) => {
      timeouts.push(until);
      await hooks.timeout?.();
      target.communicationDisabledUntilTimestamp = until;
      return target;
    },
  });
  const notices: Record<string, unknown>[] = [],
    directMessages: Record<string, unknown>[] = [],
    timeouts: number[] = [];
  const member = makeMember(USER, 100, [P.ManageGuild, P.ModerateMembers]),
    target = makeMember(TARGET, 1, [P.ViewChannel]),
    bot = makeMember(BOT, 90, [P.ModerateMembers]);
  const members = new Map([
    [USER, member],
    [TARGET, target],
    [BOT, bot],
  ]);
  const hidden = new Set<string>();
  let guildReads = 0;
  const channel = {
    id: CHANNEL,
    guildId: GUILD,
    type: 0,
    isSendable: () => true,
    isTextBased: () => true,
    permissionsFor: (value: { id: string }) =>
      new PermissionsBitField(hidden.has(value.id) ? 0n : P.Administrator),
    send: async (payload: Record<string, unknown>) => {
      await hooks.send?.();
      notices.push(payload);
      return { id: 'notice' };
    },
  };
  const guild = {
    id: GUILD,
    name: 'Test',
    ownerId: OWNER,
    members: {
      me: bot,
      fetchMe: async () => bot,
      fetch: async (input: string | { user: string }) => {
        const id = typeof input === 'string' ? input : input.user;
        await hooks.fetch?.(id);
        const result = members.get(id);
        if (!result) throw new Error('Missing member');
        return result;
      },
    },
    channels: { fetch: async (id: string) => (id === CHANNEL ? channel : null) },
  };
  for (const value of members.values()) Object.assign(value, { guild });
  const client = {
    guilds: {
      fetch: async (_id: string) => {
        guildReads++;
        return guild;
      },
    },
    channels: { fetch: async () => channel },
  } as unknown as Client;
  const ctx = { client, guild, member, channelId: CHANNEL, store } as unknown as ActionContext;
  const registry = new ActionRegistry(120, async (context) => context);
  registerCommunityActions(registry);
  registerModerationActions(registry);
  const execute = async <T = unknown>(id: string, input: unknown = {}): Promise<T> => {
    const action = registry.get(id);
    return (await action.execute(ctx, action.schema.parse(input))) as T;
  };
  const issue = (delivery = 'record-only') =>
    execute<Issued>('warning.issue', { userId: TARGET, reason: 'Repeated rule violation', delivery });
  const job = (id: string) => store.get<Job>('moderation.warningJobs', `${GUILD}:${id}`)!;
  const sweep = (now = Date.now(), allowed: readonly string[] = []) =>
    sweepModerationTasks(client, store, now, allowed);
  return {
    store,
    ctx,
    registry,
    execute,
    issue,
    job,
    sweep,
    member,
    target,
    bot,
    hidden,
    hooks,
    notices,
    directMessages,
    timeouts,
    client,
    guild,
    reads: () => guildReads,
  };
}

test('warning policy defaults to no escalation and rejects permanent or excessive sanctions', () => {
  assert.equal(warningPolicySchema.parse({}).escalationEnabled, false);
  assert.equal(warningPolicySchema.safeParse({ threshold: 1 }).success, false);
  assert.equal(warningPolicySchema.safeParse({ timeoutMinutes: 61 }).success, false);
  assert.equal(warningPolicySchema.safeParse({ ban: true }).success, false);
});

test('explicit warnings require common confirmation and share the durable case sequence without silently delivering notices', async (t) => {
  const f = fixture(t);
  const pending = await f.registry.request(f.ctx, 'warning.issue', {
    userId: TARGET,
    reason: 'Review this violation',
  });
  assert.equal(pending.status, 'confirmation');
  assert.equal(f.store.list('community.cases').length, 0);
  if (pending.status !== 'confirmation') throw new Error('Expected confirmation');
  await f.registry.confirm(f.ctx, pending.id);
  assert.equal(f.store.list('community.cases').length, 1);
  assert.equal(f.store.list('moderation.warnings').length, 1);
  assert.equal(f.store.list('moderation.warningJobs').length, 0);
  assert.equal(f.notices.length + f.directMessages.length, 0);
});

test('ordinary case records do not count toward explicit warning escalation', async (t) => {
  const f = fixture(t);
  await f.execute('warning.configure', { escalationEnabled: true, threshold: 2 });
  await f.execute('case.warn', { userId: TARGET, reason: 'A record without escalation opt-in' });
  const first = await f.issue();
  assert.equal(first.case.id, '2');
  assert.deepEqual(first.queuedJobs, []);
  const second = await f.issue();
  assert.deepEqual(second.queuedJobs, ['3-timeout']);
});

test('configured-channel notices validate target access and deliver through the durable queue with a stable nonce', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.issue('configured-channel'), /Configure/);
  assert.equal(f.store.list('community.cases').length, 0);
  await f.execute('warning.configure', { noticeChannelId: CHANNEL });
  f.hidden.add(TARGET);
  await assert.rejects(f.issue('configured-channel'), /visible to the target/);
  f.hidden.delete(TARGET);
  const issued = await f.issue('configured-channel');
  assert.equal(f.notices.length, 0);
  await f.sweep();
  assert.equal(f.notices.length, 1);
  assert.equal(f.job(issued.queuedJobs[0]!).state, 'done');
  assert.match(String(f.notices[0]!.content), /Repeated rule violation/);
  assert.equal(f.notices[0]!.enforceNonce, true);
  assert.equal(String(f.notices[0]!.nonce).length, 24);
  assert.deepEqual(f.notices[0]!.allowedMentions, { parse: [] });
  await f.sweep();
  assert.equal(f.notices.length, 1);
});

test('warning DMs require explicit current consent and revocation cancels queued delivery', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.issue('consented-dm'), /not opted/);
  assert.equal(f.store.list('community.cases').length, 0);
  const consentKey = `${GUILD}:${TARGET}`;
  f.store.set('notifications.consent', consentKey, { enabled: true, dm: true });
  const first = await f.issue('consented-dm');
  f.store.set('notifications.consent', consentKey, { enabled: false, dm: false });
  await f.sweep();
  assert.equal(f.directMessages.length, 0);
  assert.equal(f.job(first.queuedJobs[0]!).state, 'cancelled');
  f.store.set('notifications.consent', consentKey, { enabled: true, dm: true });
  await f.issue('consented-dm');
  await f.sweep();
  assert.equal(f.directMessages.length, 1);
});

test('threshold escalation applies a fixed deadline, conserves longer existing timeouts and respects cooldown', async (t) => {
  const f = fixture(t);
  await f.execute('warning.configure', { escalationEnabled: true, threshold: 2, timeoutMinutes: 60 });
  const first = await f.issue();
  assert.deepEqual(first.queuedJobs, []);
  const second = await f.issue();
  const queued = f.job(second.queuedJobs[0]!);
  assert.ok(queued.until! - queued.createdAt <= 3600000);
  f.target.communicationDisabledUntilTimestamp = queued.until! + 3600000;
  await f.sweep();
  assert.equal(f.timeouts.length, 0);
  assert.equal(f.job(queued.id).state, 'done');
  const third = await f.issue();
  assert.deepEqual(third.queuedJobs, []);
});

test('timeout retries reuse the original absolute deadline without extending the sanction', async (t) => {
  const f = fixture(t);
  await f.execute('warning.configure', { escalationEnabled: true, threshold: 2, timeoutMinutes: 5 });
  await f.issue();
  const second = await f.issue();
  const id = second.queuedJobs[0]!;
  let calls = 0;
  f.hooks.timeout = () => {
    if (++calls === 1) throw new Error('Transport failed');
  };
  await f.sweep();
  assert.equal(f.job(id).state, 'pending');
  const until = f.job(id).until!;
  await f.sweep(f.job(id).retryAt + 1);
  assert.deepEqual(f.timeouts, [until, until]);
  assert.equal(f.job(id).state, 'done');
});

test('configuring manager authorization and target hierarchy are checked again at execution', async (t) => {
  const f = fixture(t);
  await f.execute('warning.configure', { escalationEnabled: true, threshold: 2 });
  await f.issue();
  const second = await f.issue();
  f.member.permissions = new PermissionsBitField(P.ModerateMembers);
  await f.sweep();
  assert.equal(f.timeouts.length, 0);
  assert.equal(f.job(second.queuedJobs[0]!).state, 'cancelled');
});

test('approved appeals prevent queued sanctions even though durable cases remain', async (t) => {
  const f = fixture(t);
  await f.execute('warning.configure', { escalationEnabled: true, threshold: 2 });
  const first = await f.issue();
  const second = await f.issue();
  const caseKey = `${GUILD}:${first.case.id}`,
    record = f.store.get<Record<string, unknown>>('community.cases', caseKey)!;
  record.appeal = { status: 'approved' };
  f.store.set('community.cases', caseKey, record);
  await f.sweep();
  assert.equal(f.timeouts.length, 0);
  assert.equal(f.job(second.queuedJobs[0]!).state, 'cancelled');
  assert.equal(f.store.list('community.cases').length, 2);
});

test('policy changes invalidate previously queued automatic actions', async (t) => {
  const f = fixture(t);
  await f.execute('warning.configure', { noticeChannelId: CHANNEL });
  const issued = await f.issue('configured-channel');
  await f.execute('warning.configure', { noticeChannelId: null });
  await f.sweep();
  assert.equal(f.notices.length, 0);
  assert.equal(f.job(issued.queuedJobs[0]!).state, 'cancelled');
});

test('module pause and guild allowlists leave pending jobs unchanged without Discord requests', async (t) => {
  const f = fixture(t);
  await f.execute('warning.configure', { noticeChannelId: CHANNEL });
  const issued = await f.issue('configured-channel');
  f.store.set('core.disabled', GUILD, ['moderation']);
  await f.sweep();
  assert.equal(f.reads(), 0);
  assert.equal(f.job(issued.queuedJobs[0]!).state, 'pending');
  f.store.set('core.disabled', GUILD, []);
  await f.sweep(Date.now(), [OWNER]);
  assert.equal(f.reads(), 0);
  await f.sweep();
  assert.equal(f.notices.length, 1);
});

test('mid-authorization cancellation and module disabling prevent the pending HTTP mutation', async (t) => {
  const f = fixture(t);
  await f.execute('warning.configure', { noticeChannelId: CHANNEL });
  const issued = await f.issue('configured-channel');
  let cancelled = false;
  f.hooks.fetch = async (id) => {
    if (id === TARGET && !cancelled) {
      cancelled = true;
      await f.execute('warning.job.cancel', { jobId: issued.queuedJobs[0] });
    }
  };
  await f.sweep();
  assert.equal(f.notices.length, 0);
  assert.equal(f.job(issued.queuedJobs[0]!).state, 'cancelled');
  f.hooks.fetch = undefined;
  const next = await f.issue('configured-channel');
  f.hooks.fetch = (id) => {
    if (id === TARGET) f.store.set('core.disabled', GUILD, ['moderation']);
  };
  await f.sweep();
  assert.equal(f.notices.length, 0);
  assert.equal(f.job(next.queuedJobs[0]!).state, 'pending');
});

test('transient notice failures back off, preserve nonce and stop after three attempts without saving provider details', async (t) => {
  const f = fixture(t);
  await f.execute('warning.configure', { noticeChannelId: CHANNEL });
  const issued = await f.issue('configured-channel'),
    id = issued.queuedJobs[0]!;
  let calls = 0;
  f.hooks.send = () => {
    calls++;
    throw new Error('SENSITIVE provider request details');
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    await f.sweep(Math.max(Date.now(), f.job(id).retryAt));
    assert.equal(f.job(id).attempts, attempt);
  }
  assert.equal(calls, 3);
  assert.equal(f.job(id).state, 'failed');
  assert.equal(f.job(id).lastError, 'Error');
  await f.sweep(Date.now() + 3600000);
  assert.equal(calls, 3);
});

test('concurrent maintenance calls cannot deliver the same warning twice', async (t) => {
  const f = fixture(t);
  await f.execute('warning.configure', { noticeChannelId: CHANNEL });
  await f.issue('configured-channel');
  let release!: () => void, arrived!: () => void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  f.hooks.send = async () => {
    arrived();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const first = f.sweep();
  await started;
  await f.sweep();
  release();
  await first;
  assert.equal(f.notices.length, 1);
});

test('persisted in-flight notice jobs recover after restart using their original identity', async (t) => {
  const f = fixture(t);
  await f.execute('warning.configure', { noticeChannelId: CHANNEL });
  const issued = await f.issue('configured-channel'),
    job = f.job(issued.queuedJobs[0]!);
  f.store.set('moderation.warningJobs', `${GUILD}:${job.id}`, { ...job, state: 'running' });
  await f.sweep();
  assert.equal(f.notices.length, 1);
  assert.equal(f.job(job.id).state, 'done');
});

test('current target hierarchy and administrator immunity prevent automatic timeouts', async (t) => {
  const f = fixture(t);
  await f.execute('warning.configure', { escalationEnabled: true, threshold: 2 });
  await f.issue();
  const issued = await f.issue();
  f.target.roles.highest.position = 100;
  await f.sweep();
  assert.equal(f.timeouts.length, 0);
  assert.equal(f.job(issued.queuedJobs[0]!).state, 'cancelled');
});

test('the warning window excludes older explicit warnings', async (t) => {
  const f = fixture(t);
  await f.execute('warning.configure', { escalationEnabled: true, threshold: 2, windowHours: 1 });
  const first = await f.issue();
  const warningKey = `${GUILD}:${first.case.id}`,
    old = f.store.get<Record<string, unknown>>('moderation.warnings', warningKey)!;
  old.createdAt = Date.now() - 2 * 3600000;
  f.store.set('moderation.warnings', warningKey, old);
  assert.deepEqual((await f.issue()).queuedJobs, []);
  assert.equal((await f.issue()).queuedJobs.length, 1);
});

test('pending job limits roll back case creation rather than partially queueing a two-job warning', async (t) => {
  const f = fixture(t);
  await f.execute('warning.configure', { noticeChannelId: CHANNEL, escalationEnabled: true, threshold: 2 });
  await f.issue();
  for (let index = 0; index < 199; index++)
    f.store.set('moderation.warningJobs', `${GUILD}:fake-${index}`, { guildId: GUILD, state: 'pending' });
  await assert.rejects(f.issue('configured-channel'), /limit 200/);
  assert.equal(f.store.list('community.cases').length, 1);
  assert.equal(f.store.get('moderation.warningJobs', `${GUILD}:2-notice`), undefined);
  assert.equal(f.store.get('community.sequence', `${GUILD}:case`), 1);
});
