import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits as P, PermissionsBitField, ChannelType, type Client } from 'discord.js';
import { z } from 'zod';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import {
  buildReport,
  reportWindow,
  nextReportAt,
  registerReportActions,
  sweepReportTasks,
} from '../src/features/reports.js';

const G = '600000000000000001',
  A = '600000000000000002',
  B = '600000000000000003',
  C = '600000000000000004',
  OTHER = '600000000000000005';
const NS = 'reports.schedules';
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  registerReportActions(registry);
  const sends: Record<string, unknown>[] = [];
  const controls = { publicChannel: false, canSend: true, fetch: async () => {}, send: async () => {} };
  const everyone = { id: G };
  const actor = {
    id: A,
    guild: { id: G },
    permissions: new PermissionsBitField(P.Administrator),
    roles: { cache: new Map<string, unknown>() },
  };
  const bot = { id: B, permissions: new PermissionsBitField(P.Administrator) };
  const channel = {
    id: C,
    guildId: G,
    type: ChannelType.GuildText,
    isThread: () => false,
    isSendable: () => true,
    permissionsFor: (member: unknown) =>
      new PermissionsBitField(
        member === everyone
          ? controls.publicChannel
            ? P.ViewChannel
            : 0n
          : controls.canSend
            ? P.Administrator
            : P.ViewChannel,
      ),
    send: async (payload: Record<string, unknown>) => {
      await controls.send();
      sends.push(payload);
      return { id: 'message' };
    },
  };
  const guild = {
    id: G,
    members: { me: bot, fetch: async () => actor, fetchMe: async () => bot },
    roles: { fetch: async () => everyone },
    channels: {
      fetch: async () => {
        await controls.fetch();
        return channel;
      },
    },
  };
  const client = { guilds: { fetch: async () => guild } } as unknown as Client;
  const ctx = { store, client, guild, member: actor, channelId: C } as unknown as ActionContext;
  const execute = async (name: string, input: unknown = {}) => {
    const action = registry.get(name);
    return action.execute(ctx, action.schema.parse(input));
  };
  const set = async (id = 'daily') =>
    execute('report.schedule.set', {
      id,
      channelId: C,
      cadence: 'daily',
      sections: ['activity', 'commands', 'moderation', 'support', 'giveaways', 'resources'],
    });
  const due = (id = 'daily', at = Date.now() - 60000) => {
    const value = store.get<Record<string, unknown>>(NS, `${G}:${id}`)!;
    value.nextAt = at;
    store.set(NS, `${G}:${id}`, value);
    return at;
  };
  return { store, registry, ctx, client, guild, actor, channel, controls, sends, execute, set, due };
}

test('UTC report windows cover complete days, Monday weeks and calendar months', () => {
  const at = Date.parse('2026-11-02T09:30:00Z');
  assert.deepEqual(reportWindow('daily', at), {
    start: Date.parse('2026-11-01T00:00:00Z'),
    end: Date.parse('2026-11-02T00:00:00Z'),
  });
  assert.deepEqual(reportWindow('weekly', at), {
    start: Date.parse('2026-10-26T00:00:00Z'),
    end: Date.parse('2026-11-02T00:00:00Z'),
  });
  assert.deepEqual(reportWindow('monthly', Date.parse('2028-03-10T10:00:00Z')), {
    start: Date.parse('2028-02-01T00:00:00Z'),
    end: Date.parse('2028-03-01T00:00:00Z'),
  });
});
test('UTC schedules are strictly future and calendar based without DST drift', () => {
  assert.equal(
    nextReportAt({ cadence: 'daily', hourUtc: 9, minuteUtc: 15 }, Date.parse('2026-11-01T09:15:00Z')),
    Date.parse('2026-11-02T09:15:00Z'),
  );
  assert.equal(
    nextReportAt({ cadence: 'weekly', hourUtc: 9, minuteUtc: 0 }, Date.parse('2026-11-01T20:00:00Z')),
    Date.parse('2026-11-02T09:00:00Z'),
  );
  assert.equal(
    nextReportAt({ cadence: 'monthly', hourUtc: 9, minuteUtc: 0 }, Date.parse('2026-12-01T09:00:00Z')),
    Date.parse('2027-01-01T09:00:00Z'),
  );
});
test('report catalog is strict and creation requires common confirmation', async (t) => {
  const f = fixture(t);
  for (const action of f.registry.list()) assert.doesNotThrow(() => z.toJSONSchema(action.schema));
  const result = await f.registry.request(f.ctx, 'report.schedule.set', {
    id: 'daily',
    channelId: C,
    cadence: 'daily',
    sections: ['commands'],
  });
  assert.equal(result.status, 'confirmation');
  assert.equal(f.store.list(NS).length, 0);
  assert.throws(() =>
    f.registry
      .get('report.schedule.set')
      .schema.parse({ id: 'daily', channelId: C, cadence: 'hourly', sections: ['commands'] }),
  );
  assert.throws(() =>
    f.registry.get('report.preview').schema.parse({ cadence: 'daily', sections: ['commands', 'commands'] }),
  );
});
test('aggregate report excludes other guilds, content, reasons, identities and out-of-period rows', (t) => {
  const f = fixture(t),
    at = Date.parse('2026-11-02T09:00:00Z'),
    inside = Date.parse('2026-11-01T12:00:00Z');
  f.store.audit({
    guildId: G,
    userId: A,
    action: 'member.timeout',
    status: 'success',
    detail: 'PRIVATE WARNING',
  });
  f.store.db.prepare('UPDATE audit SET created_at=?').run(inside);
  f.store.audit({ guildId: OTHER, userId: A, action: 'private.other', status: 'success' });
  f.store.db.prepare('UPDATE audit SET created_at=? WHERE guild_id=?').run(inside, OTHER);
  f.store.set('community.cases', `${G}:one`, { createdAt: inside, reason: 'PRIVATE REASON', userId: A });
  f.store.set('community.tickets', `${G}:one`, {
    createdAt: inside - 10000,
    closedAt: inside,
    status: 'closed',
    subject: 'PRIVATE TICKET',
    userId: A,
  });
  f.store.set('community.tickets', `${OTHER}:one`, { createdAt: inside, status: 'open' });
  f.store.set('community.giveaways', `${G}:one`, { endsAt: inside, status: 'drawn', entrants: [A, B] });
  const report = buildReport(
    f.store,
    G,
    { cadence: 'daily', sections: ['commands', 'moderation', 'support', 'giveaways', 'activity'] },
    at,
  );
  assert.deepEqual(report.sections.moderation, { warningsCreated: 1, observedFindingsCreated: 0 });
  assert.deepEqual(report.sections.support, {
    ticketsCreated: 1,
    ticketsClosed: 1,
    averageResolutionSeconds: 10,
    currentlyOpen: 0,
  });
  assert.deepEqual(report.sections.giveaways, {
    dueInPeriod: 1,
    currentlyDrawn: 1,
    recordedEntriesForThoseGiveaways: 2,
  });
  const text = JSON.stringify(report);
  for (const privateValue of ['PRIVATE', A, B, 'private.other'])
    assert.equal(text.includes(privateValue), false);
  assert.match(text, /member.timeout/);
  assert.deepEqual(report.sections.activity, {
    available: false,
    reason: 'Observed analytics is not enabled or has no initialized data.',
  });
});
test('reports read opted-in daily analytics only within their exact UTC window', (t) => {
  const f = fixture(t);
  f.store.set('security.settings', G, { analyticsEnabled: true });
  f.store.db.exec('CREATE TABLE security_metrics(guild_id TEXT,day TEXT,kind TEXT,scope TEXT,count REAL)');
  const add = f.store.db.prepare('INSERT INTO security_metrics VALUES(?,?,?,?,?)');
  add.run(G, '2026-11-01', 'messages', C, 6);
  add.run(G, '2026-11-01', 'messages', OTHER, 4);
  add.run(G, '2026-11-02', 'messages', C, 100);
  add.run(OTHER, '2026-11-01', 'messages', C, 100);
  const report = buildReport(
    f.store,
    G,
    { cadence: 'daily', sections: ['activity'] },
    Date.parse('2026-11-02T09:00:00Z'),
  );
  assert.equal((report.sections.activity as { count: number }[])[0]?.count, 10);
});
test('scheduled reports enforce private staff destinations and bounded schedule counts', async (t) => {
  const f = fixture(t);
  f.controls.publicChannel = true;
  await assert.rejects(f.set(), /hidden from the everyone role/);
  f.controls.publicChannel = false;
  for (let i = 0; i < 10; i++) await f.set(`report${i}`);
  await assert.rejects(f.set('extra'), /ten report schedules/);
  await f.set('report0');
});
test('due report sends a real bounded artifact once and advances cadence after restart-safe state', async (t) => {
  const f = fixture(t);
  await f.set();
  const due = f.due();
  const now = Date.now();
  await sweepReportTasks(f.client, f.store, now);
  await sweepReportTasks(f.client, f.store, now);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0]!.enforceNonce, true);
  assert.deepEqual(f.sends[0]!.allowedMentions, { parse: [] });
  const files = f.sends[0]!.files as { attachment: Buffer; name: string }[];
  const report = JSON.parse(files[0]!.attachment.toString()) as { period: unknown };
  assert.ok(report.period);
  assert.match(files[0]!.name, /daily-report-/);
  const policy = f.store.get<{ nextAt: number; pending?: unknown; lastSentAt: number }>(NS, `${G}:daily`)!;
  assert.ok(policy.nextAt > now);
  assert.equal(policy.pending, undefined);
  assert.equal(policy.lastSentAt, now);
  assert.ok(due < policy.nextAt);
});
test('transient retries retain immutable rendered period and stable nonce then stop at three failures', async (t) => {
  const f = fixture(t);
  await f.set();
  const due = f.due(),
    now = Date.now();
  const attempts: Record<string, unknown>[] = [];
  f.channel.send = async (payload) => {
    attempts.push(payload);
    throw new Error('PRIVATE PROVIDER MESSAGE');
  };
  await sweepReportTasks(f.client, f.store, now);
  await sweepReportTasks(f.client, f.store, now + 30000);
  await sweepReportTasks(f.client, f.store, now + 90000);
  await sweepReportTasks(f.client, f.store, now + 1000000);
  assert.equal(attempts.length, 3);
  assert.equal(attempts[0]!.nonce, attempts[2]!.nonce);
  const p = f.store.get<{
    enabled: boolean;
    nextAt: number;
    pending: { body: string; attempts: number };
    lastError: string;
  }>(NS, `${G}:daily`)!;
  assert.equal(p.enabled, false);
  assert.equal(p.nextAt, due);
  assert.equal(p.pending.attempts, 3);
  assert.equal(p.lastError, 'Error');
  assert.equal(JSON.stringify(p).includes('PRIVATE PROVIDER MESSAGE'), false);
  assert.equal(
    (attempts[0]!.files as { attachment: Buffer }[])[0]!.attachment.toString(),
    (attempts[2]!.files as { attachment: Buffer }[])[0]!.attachment.toString(),
  );
});
test('preflight errors back off without changing original cadence occurrence and have a failure cap', async (t) => {
  const f = fixture(t);
  await f.set();
  const due = f.due(),
    now = Date.now();
  f.guild.members.fetch = async () => {
    throw new Error('network');
  };
  await sweepReportTasks(f.client, f.store, now);
  await sweepReportTasks(f.client, f.store, now + 30000);
  await sweepReportTasks(f.client, f.store, now + 90000);
  const value = f.store.get<{ enabled: boolean; nextAt: number; failures: number }>(NS, `${G}:daily`)!;
  assert.equal(value.nextAt, due);
  assert.equal(value.failures, 3);
  assert.equal(value.enabled, false);
  assert.equal(f.sends.length, 0);
});
test('guild allowlist and analytics pause are checked before starting work', async (t) => {
  const f = fixture(t);
  await f.set();
  f.due();
  await sweepReportTasks(f.client, f.store, Date.now(), [OTHER]);
  f.store.set('core.disabled', G, ['analytics']);
  await sweepReportTasks(f.client, f.store);
  assert.equal(f.sends.length, 0);
  f.store.set('core.disabled', G, []);
  await sweepReportTasks(f.client, f.store);
  assert.equal(f.sends.length, 1);
});
test('revoked current author authority and policy channel restrictions stop delivery', async (t) => {
  const f = fixture(t);
  await f.set();
  f.due();
  f.actor.permissions = new PermissionsBitField(0n);
  await sweepReportTasks(f.client, f.store);
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.get<{ enabled: boolean }>(NS, `${G}:daily`)!.enabled, false);
  f.actor.permissions = new PermissionsBitField(P.Administrator);
  await f.set();
  f.due();
  f.store.set('core.actionPolicies', `${G}:report.schedule.set`, {
    enabled: true,
    roleIds: [],
    channelIds: [OTHER],
  });
  await sweepReportTasks(f.client, f.store);
  assert.equal(f.sends.length, 0);
});
test('removing or replacing policy during awaited permission fetch cannot resurrect/send old work', async (t) => {
  const f = fixture(t);
  await f.set();
  f.due();
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.controls.fetch = async () => {
    started();
    await gate;
  };
  const running = sweepReportTasks(f.client, f.store);
  await entered;
  await f.execute('report.schedule.remove', { id: 'daily' });
  release();
  await running;
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.get(NS, `${G}:daily`), undefined);
  f.controls.fetch = async () => {};
  await f.set();
  f.due();
  let releaseNext!: () => void, startedNext!: () => void;
  const enteredNext = new Promise<void>((resolve) => {
    startedNext = resolve;
  });
  const gateNext = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  f.controls.fetch = async () => {
    startedNext();
    await gateNext;
  };
  const runningNext = sweepReportTasks(f.client, f.store);
  await enteredNext;
  f.controls.fetch = async () => {};
  await f.set();
  const replacement = f.store.get(NS, `${G}:daily`);
  releaseNext();
  await runningNext;
  assert.equal(f.sends.length, 0);
  assert.deepEqual(f.store.get(NS, `${G}:daily`), replacement);
});
test('concurrent sweeps cannot duplicate one in-flight delivery', async (t) => {
  const f = fixture(t);
  await f.set();
  f.due();
  let release!: () => void, started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.controls.send = async () => {
    started();
    await gate;
  };
  const first = sweepReportTasks(f.client, f.store);
  await entered;
  await sweepReportTasks(f.client, f.store);
  release();
  await first;
  assert.equal(f.sends.length, 1);
});
test('module pause during accepted delivery preserves completion instead of scheduling duplicate', async (t) => {
  const f = fixture(t);
  await f.set();
  f.due();
  f.controls.send = async () => {
    f.store.set('core.disabled', G, ['analytics']);
  };
  await sweepReportTasks(f.client, f.store);
  f.store.set('core.disabled', G, []);
  await sweepReportTasks(f.client, f.store);
  assert.equal(f.sends.length, 1);
  assert.equal(f.store.get<{ pending?: unknown }>(NS, `${G}:daily`)!.pending, undefined);
});
