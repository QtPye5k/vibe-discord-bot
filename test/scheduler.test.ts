import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits as P, PermissionsBitField, type Client } from 'discord.js';
import { Store } from '../src/core/store.js';
import { Scheduler, registerScheduleActions, type Job } from '../src/core/scheduler.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import type { Logger } from '../src/core/logger.js';

const GUILD = '400000000000000001',
  USER = '400000000000000002',
  BOT = '400000000000000003',
  CHANNEL = '400000000000000004',
  OTHER_GUILD = '400000000000000005';
interface SendOptions {
  content: string;
  allowedMentions: { parse: unknown[] };
  nonce: string;
  enforceNonce: boolean;
}
function fixture(t: TestContext, allowedGuildIds: string[] = []) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const sends: SendOptions[] = [],
    errors: unknown[] = [],
    guildReads: string[] = [];
  const member = {
    id: USER,
    roles: { highest: { position: 10 } },
    permissions: new PermissionsBitField(P.ViewChannel | P.SendMessages),
  };
  const bot = { id: BOT, permissions: new PermissionsBitField(P.ViewChannel | P.SendMessages) };
  const permissions = new Map([
    [USER, new PermissionsBitField(P.ViewChannel | P.SendMessages)],
    [BOT, new PermissionsBitField(P.ViewChannel | P.SendMessages)],
  ]);
  const transport = {
    send: async (options: SendOptions) => {
      sends.push(options);
      return { id: 'message' };
    },
  };
  const channel = {
    id: CHANNEL,
    guildId: GUILD,
    type: 0,
    isTextBased: () => true,
    isSendable: () => true,
    permissionsFor: (who: { id: string }) => permissions.get(who.id),
    send: (options: SendOptions) => transport.send(options),
  };
  const guild = {
    id: GUILD,
    members: { me: bot, fetch: async () => member, fetchMe: async () => bot },
    channels: { fetch: async () => channel },
  };
  const gateway = {
    fetch: async (guildId: string) => {
      guildReads.push(guildId);
      return guild;
    },
  };
  const client = { guilds: { fetch: (guildId: string) => gateway.fetch(guildId) } } as unknown as Client;
  const logger = { error: (_event: string, error: unknown) => errors.push(error) } as unknown as Logger;
  const scheduler = new Scheduler(client, store, logger, allowedGuildIds);
  const registry = new ActionRegistry(120, async (context) => context);
  registerScheduleActions(registry);
  const ctx = { client, guild, member, channelId: CHANNEL, store } as unknown as ActionContext;
  let serial = 0;
  function job(overrides: Partial<Job> = {}): Job {
    const id = (++serial).toString(16).padStart(12, '0');
    const value: Job = {
      id,
      guild_id: GUILD,
      user_id: USER,
      channel_id: CHANNEL,
      content: 'A reminder',
      due_at: Date.now(),
      interval_ms: null,
      attempts: 0,
      status: 'pending',
      last_error: null,
      nonce: `nonce-${id}`,
      ...overrides,
    };
    store.db
      .prepare(
        'INSERT INTO jobs(id,guild_id,user_id,channel_id,content,due_at,interval_ms,attempts,status,last_error,nonce) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        value.id,
        value.guild_id,
        value.user_id,
        value.channel_id,
        value.content,
        value.due_at,
        value.interval_ms,
        value.attempts,
        value.status,
        value.last_error,
        value.nonce,
      );
    return value;
  }
  function read(id: string): Job & { retry_at: number } {
    return store.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as unknown as Job & { retry_at: number };
  }
  const execute = (id: string, input: unknown, context = ctx) => {
    const action = registry.get(id);
    return action.execute(context, action.schema.parse(input));
  };
  return {
    store,
    client,
    logger,
    scheduler,
    registry,
    ctx,
    job,
    read,
    execute,
    sends,
    errors,
    guildReads,
    gateway,
    guild,
    permissions,
    transport,
  };
}

test('Reminder scheduler ignores future jobs and sends a due reminder once with mentions suppressed', async (t) => {
  const f = fixture(t),
    now = Date.now(),
    due = f.job({ due_at: now }),
    future = f.job({ due_at: now + 60_000 });
  await f.scheduler.tick(now);
  await f.scheduler.tick(now);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0]?.nonce, due.nonce);
  assert.equal(f.sends[0]?.enforceNonce, true);
  assert.deepEqual(f.sends[0]?.allowedMentions, { parse: [] });
  assert.equal(f.read(due.id).status, 'done');
  assert.equal(f.read(future.id).status, 'pending');
});

test('Scheduler reconstruction recovers an interrupted running job with the persisted delivery nonce', async (t) => {
  const f = fixture(t),
    now = Date.now(),
    pending = f.job({ status: 'running', due_at: now - 1000, nonce: 'immutable-restart-nonce' });
  const restarted = new Scheduler(f.client, f.store, f.logger);
  assert.equal(f.read(pending.id).status, 'pending');
  await restarted.tick(now);
  assert.equal(f.sends[0]?.nonce, 'immutable-restart-nonce');
  assert.equal(f.read(pending.id).status, 'done');
});

test('Transient failures back off durably and reuse the same nonce instead of changing delivery identity', async (t) => {
  const f = fixture(t),
    now = Date.now(),
    pending = f.job({ due_at: now });
  let attempts = 0;
  f.transport.send = async (options) => {
    attempts++;
    if (attempts === 1) throw new Error('Temporary transport failure');
    f.sends.push(options);
    return { id: 'message' };
  };
  await f.scheduler.tick(now);
  const retry = f.read(pending.id);
  assert.equal(retry.status, 'pending');
  assert.equal(retry.attempts, 1);
  assert.ok(retry.retry_at > now);
  assert.equal(retry.due_at, pending.due_at);
  assert.equal(retry.nonce, pending.nonce);
  assert.equal(retry.last_error, 'Error');
  const reconstructed = new Scheduler(f.client, f.store, f.logger);
  await reconstructed.tick(retry.retry_at);
  assert.equal(f.sends[0]?.nonce, pending.nonce);
  assert.equal(f.read(pending.id).status, 'done');
  assert.equal(attempts, 2);
});

test('Persistent transient failures stop after three attempts without storing sensitive error text', async (t) => {
  const f = fixture(t),
    now = Date.now(),
    pending = f.job({ due_at: now });
  f.transport.send = async () => {
    throw new Error('provider response containing a credential');
  };
  await f.scheduler.tick(now);
  await f.scheduler.tick(f.read(pending.id).retry_at);
  await f.scheduler.tick(f.read(pending.id).retry_at);
  const failed = f.read(pending.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 3);
  assert.equal(failed.last_error, 'Error');
  await f.scheduler.tick(failed.retry_at + 1000);
  assert.equal(f.errors.length, 3);
});

test('Revoked member or bot visibility fails a reminder before reading or sending channel content', async (t) => {
  for (const actor of [USER, BOT])
    await t.test(actor, async (sub) => {
      const f = fixture(sub),
        now = Date.now(),
        pending = f.job({ due_at: now });
      f.permissions.set(actor, new PermissionsBitField(0n));
      await f.scheduler.tick(now);
      assert.equal(f.sends.length, 0);
      assert.equal(f.read(pending.id).status, 'failed');
      assert.equal(f.read(pending.id).attempts, 1);
    });
});

test('Revoked Send Messages permission prevents a reminder even when channel remains visible', async (t) => {
  const f = fixture(t),
    now = Date.now(),
    pending = f.job({ due_at: now });
  f.permissions.set(USER, new PermissionsBitField(P.ViewChannel));
  await f.scheduler.tick(now);
  assert.equal(f.sends.length, 0);
  assert.equal(f.read(pending.id).status, 'failed');
});

test('Recurring reminders skip missed intervals, retain cadence, and rotate nonce for the next occurrence', async (t) => {
  const f = fixture(t),
    original = Date.now() - 725_000,
    pending = f.job({ due_at: original, interval_ms: 300_000, attempts: 2, last_error: 'Error' }),
    now = original + 725_000;
  await f.scheduler.tick(now);
  const next = f.read(pending.id);
  assert.equal(f.sends.length, 1);
  assert.equal(next.status, 'pending');
  assert.equal(next.due_at, original + 900_000);
  assert.equal(next.attempts, 0);
  assert.equal(next.last_error, null);
  assert.notEqual(next.nonce, pending.nonce);
  await f.scheduler.tick(now);
  assert.equal(f.sends.length, 1);
  await f.scheduler.tick(next.due_at);
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1]?.nonce, next.nonce);
});

test('A scheduler tick is serialized while a prior transport operation is in flight', async (t) => {
  const f = fixture(t),
    now = Date.now();
  f.job({ due_at: now });
  let release!: () => void;
  f.transport.send = async (options) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    f.sends.push(options);
    return { id: 'message' };
  };
  const first = f.scheduler.tick(now);
  await new Promise((resolve) => setImmediate(resolve));
  await f.scheduler.tick(now);
  assert.equal(f.sends.length, 0);
  release();
  await first;
  assert.equal(f.sends.length, 1);
});

test('Cancellation before a due job is claimed prevents delivery and is restricted to its owner', async (t) => {
  const f = fixture(t),
    now = Date.now(),
    pending = f.job({ due_at: now });
  assert.throws(
    () =>
      f.execute('reminder.cancel', { id: pending.id }, {
        ...f.ctx,
        member: { id: 'another' },
      } as ActionContext),
    /not found/,
  );
  await f.execute('reminder.cancel', { id: pending.id });
  await f.scheduler.tick(now);
  assert.equal(f.sends.length, 0);
  assert.equal(f.read(pending.id).status, 'cancelled');
});

test('Cancellation completed while a claimed job awaits authorization suppresses its eventual send', async (t) => {
  const f = fixture(t),
    now = Date.now(),
    pending = f.job({ due_at: now });
  let release!: () => void;
  f.gateway.fetch = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return f.guild;
  };
  const running = f.scheduler.tick(now);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.read(pending.id).status, 'running');
  await f.execute('reminder.cancel', { id: pending.id });
  release();
  await running;
  assert.equal(f.sends.length, 0);
  assert.equal(f.read(pending.id).status, 'cancelled');
});

test('Cancellation after transport starts cannot retract delivery and never resurrects a cancelled recurring job', async (t) => {
  const f = fixture(t),
    now = Date.now(),
    pending = f.job({ due_at: now, interval_ms: 300_000 });
  let release!: () => void;
  f.transport.send = async (options) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    f.sends.push(options);
    return { id: 'message' };
  };
  const running = f.scheduler.tick(now);
  await new Promise((resolve) => setImmediate(resolve));
  await f.execute('reminder.cancel', { id: pending.id });
  release();
  await running;
  assert.equal(f.sends.length, 1);
  assert.equal(f.read(pending.id).status, 'cancelled');
  await f.scheduler.tick(now + 1_000_000);
  assert.equal(f.sends.length, 1);
});

test('Changed guild allowlist excludes durable jobs without starving allowed work behind the first batch', async (t) => {
  const f = fixture(t, [GUILD]),
    now = Date.now();
  for (let index = 0; index < 12; index++) f.job({ guild_id: OTHER_GUILD, due_at: now - 1000 });
  const allowed = f.job({ due_at: now });
  await f.scheduler.tick(now);
  assert.equal(f.sends.length, 1);
  assert.equal(f.read(allowed.id).status, 'done');
  assert.ok(f.guildReads.every((id) => id === GUILD));
});

test('Disabled automation pauses deadlines and resumes them after re-enabling', async (t) => {
  const f = fixture(t),
    now = Date.now(),
    pending = f.job({ due_at: now });
  f.store.set('core.disabled', GUILD, ['automation']);
  await f.scheduler.tick(now);
  assert.equal(f.sends.length, 0);
  assert.equal(f.read(pending.id).status, 'pending');
  f.store.set('core.disabled', GUILD, []);
  await f.scheduler.tick(now + 1000);
  assert.equal(f.sends.length, 1);
  assert.equal(f.read(pending.id).status, 'done');
});

test('Automation disabled while authorization awaits I/O pauses the claimed reminder before send', async (t) => {
  const f = fixture(t),
    now = Date.now(),
    pending = f.job({ due_at: now });
  let release!: () => void;
  f.gateway.fetch = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return f.guild;
  };
  const running = f.scheduler.tick(now);
  await new Promise((resolve) => setImmediate(resolve));
  f.store.set('core.disabled', GUILD, ['automation']);
  release();
  await running;
  assert.equal(f.sends.length, 0);
  assert.equal(f.read(pending.id).status, 'pending');
});

test('Reminder creation validates deadline boundaries and enforces durable per-member limits', async (t) => {
  const f = fixture(t),
    create = f.registry.get('reminder.create');
  await assert.rejects(
    async () =>
      f.execute('reminder.create', {
        content: 'too early',
        dueAt: new Date(Date.now() - 1000).toISOString(),
      }),
    /future/,
  );
  assert.equal(create.schema.safeParse({ content: 'bad', dueAt: '2026-10-28' }).success, false);
  for (let index = 0; index < 25; index++) f.job({ due_at: Date.now() + 60_000 });
  await assert.rejects(
    async () =>
      f.execute('reminder.create', {
        content: 'over limit',
        dueAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    /limit/,
  );
});
