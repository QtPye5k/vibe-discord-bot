import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  Collection,
  Events,
  PermissionFlagsBits as P,
  PermissionsBitField,
  type Client,
  type Message,
} from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import {
  analyzeMessageContent,
  observeSecurityEvent,
  recordCommandMetric,
  registerSecurityActions,
  SECURITY_DEFAULTS,
  SECURITY_EVENTS,
  securityPatchSchema,
  securitySettings,
  sweepSecurityTasks,
} from '../src/features/security.js';

const GUILD = '710000000000000001',
  USER = '710000000000000002',
  BOT = '710000000000000003',
  CHANNEL = '710000000000000004',
  ALERT = '710000000000000005',
  OTHER = '710000000000000006',
  OTHER_GUILD = '710000000000000007';
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const alerts: string[] = [],
    incidents: unknown[] = [],
    mutations: unknown[] = [];
  const permissions = new Map([
    [USER, new PermissionsBitField(P.Administrator)],
    [BOT, new PermissionsBitField(P.Administrator)],
  ]);
  const bot = { id: BOT, permissions: permissions.get(BOT)!, user: { id: BOT, bot: true } };
  const member = {
    id: USER,
    nickname: 'before',
    joinedTimestamp: 1000,
    user: { id: USER, bot: false },
    roles: { cache: new Collection<string, unknown>() },
    permissions: permissions.get(USER)!,
    voice: { channelId: null as string | null },
  };
  const base = new Collection<
    string,
    { id: string; type: 0 | 1; allow: PermissionsBitField; deny: PermissionsBitField }
  >([
    [
      GUILD,
      {
        id: GUILD,
        type: 0,
        allow: new PermissionsBitField(P.SendMessages),
        deny: new PermissionsBitField(0n),
      },
    ],
  ]);
  const channel = {
    id: CHANNEL,
    guildId: GUILD,
    type: 0,
    name: 'private-discussion',
    parentId: null,
    position: 0,
    topic: null as string | null,
    isSendable: () => true,
    isTextBased: () => true,
    isThread: () => false,
    isVoiceBased: () => false,
    permissionsFor: (actor: { id: string }) => permissions.get(actor.id) ?? new PermissionsBitField(0n),
    permissionOverwrites: {
      cache: base,
      async set(values: { id: string; type: 0 | 1; allow: bigint; deny: bigint }[]) {
        mutations.push(values);
        base.clear();
        for (const value of values)
          base.set(value.id, {
            ...value,
            allow: new PermissionsBitField(value.allow),
            deny: new PermissionsBitField(value.deny),
          });
        return channel;
      },
    },
    async send(options: { content: string }) {
      alerts.push(options.content);
      return { id: 'message' };
    },
  };
  const alert = { ...channel, id: ALERT, name: 'staff-alerts' };
  const channels = new Collection([
    [CHANNEL, channel],
    [ALERT, alert],
  ]);
  const roles = new Collection([
    [GUILD, { id: GUILD, name: 'everyone', position: 0, permissions: new PermissionsBitField(0n) }],
  ]);
  const guild = {
    id: GUILD,
    ownerId: USER,
    name: 'test',
    verificationLevel: 0,
    members: {
      me: bot,
      cache: new Collection([[USER, member]]),
      fetchMe: async () => bot,
      fetch: async () => member,
    },
    channels: { fetch: async (id?: string) => (id ? (channels.get(id) ?? null) : channels) },
    roles: { fetch: async (id?: string) => (id ? (roles.get(id) ?? null) : roles) },
    voiceStates: { cache: new Collection() },
    setIncidentActions: async (input: unknown) => {
      incidents.push(input);
      return input;
    },
    incidentsData: null as { invitesDisabledUntil: Date } | null,
    fetchAuditLogs: async () => ({ entries: new Collection() }),
  };
  Object.assign(member, { guild });
  Object.assign(channel, { guild });
  Object.assign(alert, { guild });
  const guilds = new Collection([[GUILD, guild]]);
  const client = {
    user: { id: BOT },
    ws: { ping: 12 },
    guilds: {
      cache: guilds,
      fetch: async (id: string) => {
        const found = guilds.get(id);
        if (!found) throw new Error('Missing guild');
        return found;
      },
    },
  } as unknown as Client;
  const ctx = { store, client, guild, member, channelId: CHANNEL } as unknown as ActionContext;
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  registerSecurityActions(registry);
  const execute = async (id: string, input: unknown = {}, context = ctx) => {
    const action = registry.get(id);
    return action.execute(context, action.schema.parse(input));
  };
  const configure = (settings: Record<string, unknown>) =>
    store.set('security.settings', GUILD, { ...SECURITY_DEFAULTS, ...settings });
  let serial = 100;
  const message = (content = 'hello', options: Record<string, unknown> = {}) =>
    ({
      id: String(++serial),
      guild,
      guildId: GUILD,
      author: member.user,
      member,
      channelId: CHANNEL,
      channel,
      content,
      editedTimestamp: null,
      partial: false,
      webhookId: null,
      mentions: { users: new Collection(), roles: new Collection(), everyone: false },
      attachments: new Collection(),
      deletable: true,
      delete: async () => {
        mutations.push('delete');
      },
      ...options,
    }) as unknown as Message;
  const observe = (event: string, ...args: unknown[]) => observeSecurityEvent(event, args, client, store);
  return {
    store,
    ctx,
    client,
    guild,
    member,
    bot,
    channel,
    alert,
    channels,
    roles,
    permissions,
    alerts,
    incidents,
    mutations,
    execute,
    configure,
    message,
    observe,
    registry,
  };
}
function rows(store: Store, table: string): Record<string, unknown>[] {
  return store.db.prepare(`SELECT * FROM ${table}`).all();
}

test('a single privileged-role permission addition triggers a specific alert before any burst threshold', async (t) => {
  const f = fixture(t);
  f.configure({ enabled: true, logAdministrativeChanges: true, alertChannelId: ALERT, changeThreshold: 50 });
  const before = {
    id: OTHER,
    guild: f.guild,
    name: 'Ordinary',
    permissions: new PermissionsBitField(P.ViewChannel),
  };
  await f.observe(Events.GuildRoleUpdate, before, {
    ...before,
    permissions: new PermissionsBitField([P.ViewChannel, P.ManageRoles]),
  });
  assert.ok(f.alerts.some((text) => text.includes('Privileged role permission change')));
  const event = rows(f.store, 'security_events').find((row) => row.event_type === 'privilegedRoleChange');
  assert.ok(event);
  assert.equal(JSON.parse(String(event.metadata)).added, P.ManageRoles.toString());
});

test('Security is opt-in and its strict patch preserves prior settings without resetting defaults', async (t) => {
  const f = fixture(t);
  assert.equal(securitySettings(f.store, GUILD).enabled, false);
  await f.observe(Events.MessageCreate, f.message('not recorded'));
  assert.equal(
    f.store.db.prepare("SELECT name FROM sqlite_master WHERE name='security_events'").get(),
    undefined,
  );
  await f.execute('security.configure', { enabled: true, raidJoinThreshold: 4 });
  await f.execute('security.configure', { analyticsEnabled: true });
  assert.equal(securitySettings(f.store, GUILD).raidJoinThreshold, 4);
  assert.equal(securitySettings(f.store, GUILD).logMessageContent, false);
  assert.equal(securityPatchSchema.safeParse({ unknown: true }).success, false);
});

test('Security configuration validates automatic response permissions and accessible destinations', async (t) => {
  const f = fixture(t);
  f.permissions.get(BOT)!.remove(P.Administrator);
  f.permissions.get(BOT)!.add(P.ViewChannel);
  await assert.rejects(f.execute('security.configure', { autoPauseInvites: true }), /Manage Server/);
  await assert.rejects(f.execute('security.configure', { autoDeleteFlagged: true }), /Manage Messages/);
  await assert.rejects(f.execute('security.configure', { alertChannelId: ALERT }), /send/);
  assert.equal(f.store.get('security.settings', GUILD), undefined);
});

test('URL blocklists use hostname boundaries; allowlists do not override explicit blocked domains', () => {
  const config = {
    ...SECURITY_DEFAULTS,
    blockedDomains: ['bad.example'],
    allowedDomains: ['safe.example', 'bad.example'],
  };
  assert.equal(analyzeMessageContent('https://sub.bad.example', [], 0, config).score, 100);
  assert.equal(analyzeMessageContent('https://bad.example.evil.test', [], 0, config).score, 0);
  assert.equal(analyzeMessageContent('http://safe.example/path', [], 0, config).score, 0);
  assert.equal(analyzeMessageContent('https://safe.example@bad.example/path', [], 0, config).score, 100);
});

test('Local heuristic scoring identifies attachment disguises, IP/user-info links, mentions, caps and emoji without external scanning', () => {
  const finding = analyzeMessageContent(
    `${'UPPERCASE TEXT '.repeat(4)} http://user:pass@127.0.0.1/ ${'🚀'.repeat(25)}`,
    ['invoice.pdf.exe'],
    10,
    SECURITY_DEFAULTS,
  );
  assert.ok(finding.score >= 200);
  assert.ok(finding.reasons.some((reason) => reason.includes('double extension')));
  assert.ok(finding.reasons.some((reason) => reason.includes('user-info')));
  assert.ok(finding.reasons.some((reason) => reason.includes('capitalization')));
  assert.deepEqual(finding.domains, ['127.0.0.1']);
  assert.ok(!JSON.stringify(finding).includes('pass'));
});

test('Observed content findings are deduplicated, store reasons only, and never delete by default', async (t) => {
  const f = fixture(t);
  f.configure({
    enabled: true,
    contentAnalysisEnabled: true,
    blockedDomains: ['bad.example'],
    alertChannelId: ALERT,
  });
  const message = f.message('my private words https://bad.example');
  await f.observe(Events.MessageCreate, message);
  await f.observe(Events.MessageCreate, message);
  assert.equal(rows(f.store, 'security_findings').length, 1);
  assert.equal(f.mutations.length, 0);
  assert.equal(f.alerts.length, 1);
  assert.ok(!JSON.stringify(rows(f.store, 'security_findings')).includes('my private words'));
  assert.ok(!f.alerts[0]!.includes('my private words'));
});

test('Explicit content-deletion policy removes flagged messages but respects trusted roles and module disable', async (t) => {
  const f = fixture(t);
  f.configure({
    enabled: true,
    contentAnalysisEnabled: true,
    autoDeleteFlagged: true,
    blockedDomains: ['bad.example'],
    trustedRoleIds: [OTHER],
  });
  await f.observe(Events.MessageCreate, f.message('https://bad.example'));
  assert.deepEqual(f.mutations, ['delete']);
  f.member.roles.cache.set(OTHER, {});
  await f.observe(Events.MessageCreate, f.message('https://bad.example'));
  assert.equal(f.mutations.length, 1);
  f.member.roles.cache.clear();
  f.store.set('core.disabled', GUILD, ['security']);
  await f.observe(Events.MessageCreate, f.message('https://bad.example'));
  assert.equal(f.mutations.length, 1);
});

test('Findings require current channel visibility and reviews are guild-scoped and single-use', async (t) => {
  const f = fixture(t);
  f.configure({ enabled: true, contentAnalysisEnabled: true, blockedDomains: ['bad.example'] });
  await f.observe(Events.MessageCreate, f.message('https://bad.example'));
  const finding = rows(f.store, 'security_findings')[0]!;
  f.permissions.set(USER, new PermissionsBitField(0n));
  assert.deepEqual(await f.execute('security.findings'), []);
  f.permissions.set(USER, new PermissionsBitField(P.Administrator));
  const otherCtx = { ...f.ctx, guild: { ...f.ctx.guild, id: OTHER_GUILD } } as ActionContext;
  await assert.rejects(
    f.execute(
      'security.review',
      { findingId: finding.id, decision: 'confirmed', note: 'reviewed' },
      otherCtx,
    ),
    /server/,
  );
  await f.execute('security.review', { findingId: finding.id, decision: 'confirmed', note: 'reviewed' });
  await assert.rejects(
    f.execute('security.review', { findingId: finding.id, decision: 'dismissed', note: 'again' }),
    /already/,
  );
  const trust = (await f.execute('security.trust', { userId: USER })) as { score: number };
  assert.equal(trust.score, 90);
});

test('Raid joins deduplicate and reach an exact threshold before bounded invite pause and alert', async (t) => {
  const f = fixture(t);
  f.configure({
    enabled: true,
    raidEnabled: true,
    autoPauseInvites: true,
    raidJoinThreshold: 3,
    alertChannelId: ALERT,
  });
  const joins = Array.from({ length: 3 }, (_, i) => ({
    ...f.member,
    id: String(710000000000000020n + BigInt(i)),
    joinedTimestamp: 1000 + i,
    guild: f.guild,
  }));
  await f.observe(Events.GuildMemberAdd, joins[0]);
  await f.observe(Events.GuildMemberAdd, joins[0]);
  await f.observe(Events.GuildMemberAdd, joins[1]);
  assert.equal(f.incidents.length, 0);
  await f.observe(Events.GuildMemberAdd, joins[2]);
  assert.equal(f.incidents.length, 1);
  assert.equal(f.alerts.length, 1);
  const until = Date.parse((f.incidents[0] as { invitesDisabledUntil: string }).invitesDisabledUntil);
  assert.ok(until > Date.now() && until <= Date.now() + 10 * 60000);
  assert.ok(f.alerts[0]!.includes('Invites paused'));
  assert.equal(rows(f.store, 'security_events').at(-1)?.event_type, 'raidJoinSpike');
});

test('Configured invite pause does not shorten an existing incident restriction', async (t) => {
  const f = fixture(t);
  f.configure({ enabled: true, raidEnabled: true, autoPauseInvites: true, raidJoinThreshold: 3 });
  const until = new Date(Date.now() + 30 * 60000);
  f.guild.incidentsData = { invitesDisabledUntil: until };
  for (let i = 0; i < 3; i++)
    await f.observe(Events.GuildMemberAdd, {
      ...f.member,
      id: `other-${i}`,
      joinedTimestamp: i,
      guild: f.guild,
    });
  assert.equal(
    (f.incidents[0] as { invitesDisabledUntil: string }).invitesDisabledUntil,
    until.toISOString(),
  );
});

test('Invite auto-response checks current bot authority and a policy disabled during awaited authorization', async (t) => {
  const f = fixture(t);
  f.configure({ enabled: true, raidEnabled: true, autoPauseInvites: true, raidJoinThreshold: 3 });
  f.guild.members.fetchMe = async () => {
    f.store.set('core.disabled', GUILD, ['security']);
    return f.bot;
  };
  for (let i = 0; i < 3; i++)
    await f.observe(Events.GuildMemberAdd, {
      ...f.member,
      id: `other-${i}`,
      joinedTimestamp: i,
      guild: f.guild,
    });
  assert.equal(f.incidents.length, 0);
});

test('Failed staff alerts back off durably rather than retrying every flagged message', async (t) => {
  const f = fixture(t);
  let attempts = 0;
  f.alert.send = async () => {
    attempts++;
    throw new Error('cannot send');
  };
  f.configure({
    enabled: true,
    contentAnalysisEnabled: true,
    blockedDomains: ['bad.example'],
    alertChannelId: ALERT,
  });
  await f.observe(Events.MessageCreate, f.message('https://bad.example'));
  await f.observe(Events.MessageCreate, f.message('https://bad.example'));
  assert.equal(attempts, 1);
  assert.equal(f.store.get<{ failures: number }>('security.alerts', `${GUILD}:content:${USER}`)?.failures, 1);
});

test('Structural burst alerts work without enabling administrative data logging', async (t) => {
  const f = fixture(t);
  f.configure({ enabled: true, antiNukeEnabled: true, changeThreshold: 2, alertChannelId: ALERT });
  await f.observe(Events.ChannelDelete, { ...f.channel, id: OTHER });
  await f.observe(Events.ChannelDelete, { ...f.channel, id: '710000000000000008' });
  assert.equal(f.alerts.length, 1);
  assert.match(f.alerts[0]!, /Structural-change spike/);
  assert.equal(rows(f.store, 'security_events').length, 0);
});

test('Observed edit/delete logs omit content by default and include it only with explicit logging policy', async (t) => {
  const f = fixture(t);
  f.configure({ enabled: true, logMessageEdits: true, logMessageDeletes: true });
  const before = f.message('sensitive before'),
    after = { ...before, content: 'sensitive after', editedTimestamp: Date.now() };
  await f.observe(Events.MessageUpdate, before, after);
  assert.equal(rows(f.store, 'security_events')[0]?.before_text, null);
  f.configure({ enabled: true, logMessageEdits: true, logMessageDeletes: true, logMessageContent: true });
  await f.observe(Events.MessageDelete, before);
  const removed = rows(f.store, 'security_events').at(-1)!;
  assert.equal(removed.before_text, 'sensitive before');
  assert.equal(removed.after_text, null);
  assert.ok(!f.alerts.some((content) => content.includes('sensitive')));
});

test('Historical logs require current view and read-history permission, even for staff', async (t) => {
  const f = fixture(t);
  f.configure({ enabled: true, logMessageDeletes: true, logMessageContent: true });
  await f.observe(Events.MessageDelete, f.message('private record'));
  assert.equal(((await f.execute('security.logs')) as unknown[]).length, 1);
  f.permissions.set(USER, new PermissionsBitField(P.ViewChannel | P.ViewAuditLog));
  assert.deepEqual(await f.execute('security.logs'), []);
  f.permissions.set(USER, new PermissionsBitField(P.ViewAuditLog));
  assert.deepEqual(await f.execute('security.logs'), []);
  f.channels.delete(CHANNEL);
  assert.deepEqual(await f.execute('security.logs'), []);
});

test('Message logging honors selected source channels and retention pruning', async (t) => {
  const f = fixture(t);
  f.configure({ enabled: true, logMessageDeletes: true, logChannelIds: [ALERT], retentionDays: 1 });
  await f.observe(Events.MessageDelete, f.message('not selected'));
  assert.equal(rows(f.store, 'security_events').length, 0);
  await f.observe(Events.MessageDelete, f.message('selected', { channelId: ALERT }));
  assert.equal(rows(f.store, 'security_events').length, 1);
  await sweepSecurityTasks(f.client, f.store, Date.now() + 2 * 86400000);
  assert.equal(rows(f.store, 'security_events').length, 0);
});

test('Member nickname/role logs preserve only changed fields and deduplicate repeated target state', async (t) => {
  const f = fixture(t);
  f.configure({ enabled: true, logAdministrativeChanges: true });
  const after = {
    ...f.member,
    guild: f.guild,
    nickname: 'after',
    roles: { cache: new Collection([[OTHER, {}]]) },
  };
  await f.observe(Events.GuildMemberUpdate, f.member, after);
  await f.observe(Events.GuildMemberUpdate, f.member, after);
  const records = rows(f.store, 'security_events');
  assert.equal(records.length, 1);
  const metadata = JSON.parse(String(records[0]!.metadata));
  assert.equal(metadata.newNickname, 'after');
  assert.deepEqual(metadata.addedRoleIds, [OTHER]);
  assert.equal(metadata.actorAssociation, 'unknown');
});

test('Channel overwrite changes are detected even when channel name is unchanged', async (t) => {
  const f = fixture(t);
  f.configure({ enabled: true, logAdministrativeChanges: true });
  await f.observe(Events.ChannelUpdate, f.channel, f.channel);
  f.channel.permissionOverwrites.cache.get(GUILD)!.deny.add(P.SendMessages);
  await f.observe(Events.ChannelUpdate, f.channel, f.channel);
  assert.equal(rows(f.store, 'security_events').length, 2);
});

test('Webhook change alerts can recur after their cooldown without storing execution tokens', async (t) => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  f.configure({ enabled: true, logAdministrativeChanges: true, alertChannelId: ALERT });
  await f.observe(Events.WebhooksUpdate, f.channel);
  now += 61000;
  await f.observe(Events.WebhooksUpdate, f.channel);
  assert.equal(f.alerts.length, 2);
  assert.ok(!JSON.stringify(rows(f.store, 'security_events')).includes('token'));
});

test('Observed analytics deduplicate message creates and keep guild activity separate', async (t) => {
  const f = fixture(t);
  f.configure({ analyticsEnabled: true });
  const message = f.message('one');
  await f.observe(Events.MessageCreate, message);
  await f.observe(Events.MessageCreate, message);
  const metrics = rows(f.store, 'security_metrics');
  assert.equal(metrics[0]?.count, 1);
  assert.equal(rows(f.store, 'security_activity')[0]?.messages, 1);
  await f.observe(Events.MessageCreate, {
    ...f.message('other guild'),
    guild: { ...f.guild, id: OTHER_GUILD },
  });
  assert.equal(rows(f.store, 'security_activity').length, 1);
});

test('Observed voice time splits at UTC midnight and stops after channel departure', async (t) => {
  const f = fixture(t);
  let now = Date.parse('2026-10-28T23:59:30.000Z');
  t.mock.method(Date, 'now', () => now);
  f.configure({ analyticsEnabled: true });
  const before = { id: USER, guild: f.guild, member: f.member, channelId: null },
    joined = { ...before, channelId: CHANNEL };
  await f.observe(Events.VoiceStateUpdate, before, joined);
  now += 60000;
  await f.observe(Events.VoiceStateUpdate, joined, before);
  const duration = rows(f.store, 'security_metrics').filter((row) => row.kind === 'voiceSeconds');
  assert.equal(duration.length, 2);
  assert.deepEqual(
    duration.map((row) => row.count),
    [30, 30],
  );
  assert.equal(rows(f.store, 'security_activity')[0]?.voice_seconds, 60);
  assert.equal(f.store.get('security.voice', `${GUILD}:${USER}`), undefined);
});

test('Command timing instrumentation is opt-in, bounded, and scoped to its guild', async (t) => {
  const f = fixture(t);
  f.configure({ analyticsEnabled: true });
  recordCommandMetric(f.store, GUILD, 'test.action', 'failure', 50);
  const metrics = rows(f.store, 'security_metrics');
  assert.ok(metrics.some((row) => row.kind === 'command:test.action:failure' && row.count === 1));
  assert.ok(metrics.some((row) => row.kind === 'commandDurationMs' && row.count === 50));
  f.store.set('core.disabled', GUILD, ['analytics']);
  recordCommandMetric(f.store, GUILD, 'test.action', 'failure', 100);
  assert.equal(rows(f.store, 'security_metrics').length, 3);
});

test('real Discord REST latency samples use one fixed harmless endpoint and retain at most30 measurements', async (t) => {
  const f = fixture(t),
    calls: string[] = [];
  Object.assign(f.ctx.client, {
    rest: {
      get: async (path: string) => {
        calls.push(path);
        return { url: 'wss://gateway.discord.gg' };
      },
    },
  });
  for (let index = 0; index < 32; index++) {
    const result = (await f.execute('analytics.api-latency')) as { elapsedMs: number; samples: unknown[] };
    assert.ok(result.elapsedMs >= 0);
    assert.ok(result.samples.length <= 30);
  }
  assert.equal(calls.length, 32);
  assert.ok(calls.every((path) => path === '/gateway'));
  assert.equal(f.store.get<unknown[]>('analytics.restLatency', GUILD)!.length, 30);
});
test('UTC weekly comparison reports actual previous/current totals and change percentages', async (t) => {
  const f = fixture(t);
  let now = Date.parse('2026-10-10T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  f.configure({ analyticsEnabled: true });
  await f.observe(Events.MessageCreate, f.message());
  now = Date.parse('2026-10-20T12:00:00Z');
  await f.observe(Events.MessageCreate, f.message());
  await f.observe(Events.MessageCreate, f.message());
  const result = (await f.execute('analytics.compare', { periodDays: 7 })) as {
    comparison: { kind: string; current: number; previous: number; percentChange: number }[];
  };
  const messages = result.comparison.find((row) => row.kind === 'messages')!;
  assert.equal(messages.current, 2);
  assert.equal(messages.previous, 1);
  assert.equal(messages.percentChange, 100);
});

test('Security baseline comparison finds role and accessible channel changes without storing message contents', async (t) => {
  const f = fixture(t);
  await f.execute('security.baseline.save');
  f.channel.topic = 'changed';
  f.roles.get(GUILD)!.permissions.add(P.SendMessages);
  const result = (await f.execute('security.baseline.compare')) as {
    channels: { changed: string[] };
    roles: { changed: string[] };
  };
  assert.ok(result.roles.changed.includes(GUILD));
  // The baseline deliberately fingerprints selected native settings. A name change is observable.
  f.channel.name = 'renamed';
  const changed = (await f.execute('security.baseline.compare')) as typeof result;
  assert.ok(changed.channels.changed.includes(CHANNEL));
  assert.ok(!JSON.stringify(f.store.get('security.baselines', GUILD)).includes('changed'));
});

test('Lockdown removes role/member sending allows, preserves exact original overwrites, and restores them', async (t) => {
  const f = fixture(t);
  f.channel.permissionOverwrites.cache.set(OTHER, {
    id: OTHER,
    type: 0,
    allow: new PermissionsBitField(P.SendMessages),
    deny: new PermissionsBitField(P.AttachFiles),
  });
  const original = [...f.channel.permissionOverwrites.cache.values()].map((value) => ({
    id: value.id,
    allow: value.allow.bitfield,
    deny: value.deny.bitfield,
  }));
  const applied = (await f.execute('security.lockdown.apply', { channelIds: [CHANNEL], minutes: 1 })) as {
    operationId: string;
    applied: number;
  };
  assert.equal(applied.applied, 1);
  assert.equal(f.channel.permissionOverwrites.cache.get(OTHER)?.allow.has(P.SendMessages), false);
  assert.equal(f.channel.permissionOverwrites.cache.get(OTHER)?.deny.has(P.SendMessages), true);
  assert.equal(f.channel.permissionOverwrites.cache.get(BOT)?.allow.has(P.SendMessages), true);
  await f.execute('security.lockdown.restore', { operationId: applied.operationId });
  assert.deepEqual(
    [...f.channel.permissionOverwrites.cache.values()].map((value) => ({
      id: value.id,
      allow: value.allow.bitfield,
      deny: value.deny.bitfield,
    })),
    original,
  );
  assert.equal(f.store.get('security.activeLockdown', GUILD), undefined);
});

test('Lockdown restoration preserves conflicting later edits unless force is explicitly confirmed', async (t) => {
  const f = fixture(t);
  const applied = (await f.execute('security.lockdown.apply', { channelIds: [CHANNEL] })) as {
    operationId: string;
  };
  f.channel.permissionOverwrites.cache.get(GUILD)!.deny.add(P.AttachFiles);
  const restored = (await f.execute('security.lockdown.restore', { operationId: applied.operationId })) as {
    state: string;
    channels: { state: string }[];
  };
  assert.equal(restored.state, 'partial');
  assert.equal(restored.channels[0]?.state, 'conflict');
  assert.equal(f.mutations.length, 1);
  await f.execute('security.lockdown.restore', { operationId: applied.operationId, force: true });
  assert.equal(f.mutations.length, 2);
  assert.equal(f.channel.permissionOverwrites.cache.get(GUILD)?.deny.has(P.AttachFiles), false);
});

test('Lockdown prevalidates every target before mutating and prevents overlapping guild operations', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.execute('security.lockdown.apply', { channelIds: [CHANNEL, OTHER] }), /server/);
  assert.equal(f.mutations.length, 0);
  await f.execute('security.lockdown.apply', { channelIds: [CHANNEL] });
  await assert.rejects(f.execute('security.lockdown.apply', { channelIds: [CHANNEL] }), /existing lockdown/);
  assert.equal(f.mutations.length, 1);
});

test('Timed lockdown restores exact permissions after its deadline even if new security actions are disabled', async (t) => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await f.execute('security.lockdown.apply', { channelIds: [CHANNEL], minutes: 1 });
  f.store.set('core.disabled', GUILD, ['security']);
  now += 61000;
  await sweepSecurityTasks(f.client, f.store, now);
  assert.equal(f.mutations.length, 2);
  assert.equal(f.store.get('security.activeLockdown', GUILD), undefined);
});

test('Security maintenance respects configured guild allowlists before deadlines or retention mutation', async (t) => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  f.configure({ enabled: true, logMessageDeletes: true, retentionDays: 1 });
  await f.observe(Events.MessageDelete, f.message('keep'));
  await f.execute('security.lockdown.apply', { channelIds: [CHANNEL], minutes: 1 });
  now += 2 * 86400000;
  await sweepSecurityTasks(f.client, f.store, now, [OTHER_GUILD]);
  assert.equal(f.mutations.length, 1);
  assert.equal(rows(f.store, 'security_events').length, 1);
});

test('All security mutations use common registry confirmation and all event names are unique', async (t) => {
  const f = fixture(t);
  assert.equal(new Set(SECURITY_EVENTS).size, SECURITY_EVENTS.length);
  const request = await f.registry.request(f.ctx, 'security.configure', { enabled: true });
  assert.equal(request.status, 'confirmation');
  assert.equal(f.store.get('security.settings', GUILD), undefined);
  if (request.status === 'confirmation') await f.registry.confirm(f.ctx, request.id);
  assert.equal(securitySettings(f.store, GUILD).enabled, true);
});

test('Personal analytics opt-out erases member counters and stops future user-level tracking while keeping aggregate totals', async (t) => {
  const f = fixture(t);
  f.configure({ analyticsEnabled: true });
  await f.observe(Events.MessageCreate, f.message());
  assert.equal(rows(f.store, 'security_activity').length, 1);
  await f.execute('analytics.privacy', { enabled: false });
  await f.observe(Events.MessageCreate, f.message());
  assert.equal(rows(f.store, 'security_activity').length, 0);
  assert.equal(rows(f.store, 'security_metrics').find((row) => row.kind === 'messages')?.count, 2);
  await f.execute('analytics.privacy', { enabled: true });
  await f.observe(Events.MessageCreate, f.message());
  assert.equal(rows(f.store, 'security_activity')[0]?.messages, 1);
});

test('Action latency reports count both success and failure executions and compute exact mean duration', async (t) => {
  const f = fixture(t);
  f.configure({ analyticsEnabled: true });
  recordCommandMetric(f.store, GUILD, 'channel.create', 'success', 100);
  recordCommandMetric(f.store, GUILD, 'channel.create', 'failure', 300);
  const result = (await f.execute('analytics.command-latency')) as {
    action: string;
    count: number;
    averageMs: number;
  }[];
  assert.deepEqual(result, [{ action: 'channel.create', count: 2, averageMs: 200 }]);
});

test('Poll and native AutoMod observations produce scoped metrics and omit native message contents', async (t) => {
  const f = fixture(t);
  f.configure({ enabled: true, analyticsEnabled: true, logAdministrativeChanges: true });
  await f.observe(Events.MessagePollVoteAdd, { poll: { message: f.message() } }, USER);
  await f.observe(Events.AutoModerationActionExecution, {
    guild: f.guild,
    channelId: CHANNEL,
    userId: USER,
    ruleId: OTHER,
    action: { type: 1 },
    content: 'not logged',
  });
  const metric = rows(f.store, 'security_metrics');
  assert.ok(metric.some((row) => row.kind === Events.MessagePollVoteAdd && row.scope === CHANNEL));
  assert.ok(metric.some((row) => row.kind === 'automodExecutions'));
  assert.ok(!JSON.stringify(rows(f.store, 'security_events')).includes('not logged'));
});

test('Security alerts use a hard per-guild delivery budget during many-user content floods', async (t) => {
  const f = fixture(t);
  f.configure({
    enabled: true,
    contentAnalysisEnabled: true,
    blockedDomains: ['bad.example'],
    alertChannelId: ALERT,
  });
  for (let i = 0; i < 20; i++)
    await f.observe(
      Events.MessageCreate,
      f.message('https://bad.example', { author: { id: `user-${i}`, bot: false } }),
    );
  assert.equal(f.alerts.length, 10);
  assert.equal(rows(f.store, 'security_findings').length, 20);
});

test('Lockdown restore rejects another server operation and status hides inaccessible channel settings', async (t) => {
  const f = fixture(t);
  const operation = (await f.execute('security.lockdown.apply', { channelIds: [CHANNEL] })) as {
    operationId: string;
  };
  const otherCtx = { ...f.ctx, guild: { ...f.ctx.guild, id: OTHER_GUILD } } as ActionContext;
  await assert.rejects(
    f.execute('security.lockdown.restore', { operationId: operation.operationId }, otherCtx),
    /server/,
  );
  f.permissions.set(USER, new PermissionsBitField(0n));
  const status = (await f.execute('security.lockdown.status')) as { channels: unknown[] };
  assert.deepEqual(status.channels, []);
});

test('Replaying an old restored lockdown never releases a newer active lockdown reservation', async (t) => {
  const f = fixture(t);
  const first = (await f.execute('security.lockdown.apply', { channelIds: [CHANNEL] })) as {
    operationId: string;
  };
  await f.execute('security.lockdown.restore', { operationId: first.operationId });
  const second = (await f.execute('security.lockdown.apply', { channelIds: [CHANNEL] })) as {
    operationId: string;
  };
  await f.execute('security.lockdown.restore', { operationId: first.operationId });
  assert.equal(f.store.get('security.activeLockdown', GUILD), second.operationId);
});

test('Large administrative metadata remains valid JSON and readable after bounded truncation', async (t) => {
  const f = fixture(t);
  f.configure({ enabled: true, logAdministrativeChanges: true });
  for (let i = 0; i < 120; i++)
    f.channel.permissionOverwrites.cache.set(String(710000000000001000n + BigInt(i)), {
      id: String(710000000000001000n + BigInt(i)),
      type: 0,
      allow: new PermissionsBitField(P.SendMessages),
      deny: new PermissionsBitField(0n),
    });
  await f.observe(Events.ChannelUpdate, f.channel, f.channel);
  const records = (await f.execute('security.logs')) as { metadata: { truncated?: boolean } }[];
  assert.equal(records.length, 1);
  assert.equal(records[0]?.metadata.truncated, true);
});
