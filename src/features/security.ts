import { createHash, randomUUID } from 'node:crypto';
import {
  AuditLogEvent,
  ChannelType,
  Events,
  PermissionFlagsBits as P,
  Routes,
  type Client,
  type Guild,
  type GuildBasedChannel,
  type GuildMember,
  type Message,
  type VoiceState,
} from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { Action, ActionContext } from '../core/types.js';
import type { Store } from '../core/store.js';
import { csv } from '../core/files.js';
import { resolveChannel } from '../core/permissions.js';
import { UserError } from '../core/errors.js';

const DAY = 86_400_000;
const id = z.string().regex(/^\d{17,20}$/);
const empty = z.strictObject({});
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .refine((value) => {
    try {
      const url = new URL(`https://${value}`);
      return (
        url.hostname === value &&
        !url.port &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        /^[a-z0-9.-]+$/.test(value)
      );
    } catch {
      return false;
    }
  }, 'Use a lowercase hostname without a URL path or port.');

export const securitySettingsSchema = z.strictObject({
  enabled: z.boolean(),
  analyticsEnabled: z.boolean(),
  alertChannelId: id.nullable(),
  logChannelIds: z.array(id).max(100),
  logMessageEdits: z.boolean(),
  logMessageDeletes: z.boolean(),
  logMessageContent: z.boolean(),
  logAdministrativeChanges: z.boolean(),
  correlateAuditActors: z.boolean(),
  allowedAdminUserIds: z.array(id).max(100),
  retentionDays: z.number().int().min(1).max(90),
  raidEnabled: z.boolean(),
  raidWindowSeconds: z.number().int().min(5).max(300),
  raidJoinThreshold: z.number().int().min(3).max(100),
  autoPauseInvites: z.boolean(),
  invitesPauseMinutes: z.number().int().min(1).max(60),
  antiNukeEnabled: z.boolean(),
  changeWindowSeconds: z.number().int().min(5).max(300),
  changeThreshold: z.number().int().min(2).max(50),
  contentAnalysisEnabled: z.boolean(),
  blockedDomains: z.array(domain).max(200),
  allowedDomains: z.array(domain).max(200),
  suspiciousExtensions: z.array(z.string().regex(/^\.[a-z0-9]{1,10}$/)).max(30),
  trustedRoleIds: z.array(id).max(30),
  mentionLimit: z.number().int().min(3).max(100),
  flagScore: z.number().int().min(10).max(200),
  autoDeleteFlagged: z.boolean(),
  activitySpikeThreshold: z.number().int().min(10).max(1000),
});
export type SecuritySettings = z.infer<typeof securitySettingsSchema>;
export const securityPatchSchema = securitySettingsSchema.partial();
export const SECURITY_DEFAULTS: SecuritySettings = {
  enabled: false,
  analyticsEnabled: false,
  alertChannelId: null,
  logChannelIds: [],
  logMessageEdits: false,
  logMessageDeletes: false,
  logMessageContent: false,
  logAdministrativeChanges: false,
  correlateAuditActors: false,
  allowedAdminUserIds: [],
  retentionDays: 7,
  raidEnabled: false,
  raidWindowSeconds: 60,
  raidJoinThreshold: 10,
  autoPauseInvites: false,
  invitesPauseMinutes: 10,
  antiNukeEnabled: false,
  changeWindowSeconds: 60,
  changeThreshold: 5,
  contentAnalysisEnabled: false,
  blockedDomains: [],
  allowedDomains: [],
  suspiciousExtensions: ['.exe', '.scr', '.bat', '.cmd', '.com', '.vbs', '.ps1', '.lnk', '.iso'],
  trustedRoleIds: [],
  mentionLimit: 8,
  flagScore: 60,
  autoDeleteFlagged: false,
  activitySpikeThreshold: 100,
};
export function securitySettings(store: Store, guildId: string): SecuritySettings {
  return securitySettingsSchema.parse({
    ...SECURITY_DEFAULTS,
    ...store.get<Partial<SecuritySettings>>('security.settings', guildId),
  });
}

const initialized = new WeakSet<Store>();
const observationCounts = new WeakMap<Store, number>();
function tables(store: Store): void {
  if (initialized.has(store)) return;
  store.db.exec(`CREATE TABLE IF NOT EXISTS security_events(
    id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,channel_id TEXT,user_id TEXT,event_type TEXT NOT NULL,
    at INTEGER NOT NULL,before_text TEXT,after_text TEXT,metadata TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS security_events_time ON security_events(guild_id,at);
    CREATE TABLE IF NOT EXISTS security_seen(key TEXT PRIMARY KEY,at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS security_seen_time ON security_seen(at);
    CREATE TABLE IF NOT EXISTS security_metrics(guild_id TEXT NOT NULL,day TEXT NOT NULL,scope TEXT NOT NULL,
      kind TEXT NOT NULL,count REAL NOT NULL,PRIMARY KEY(guild_id,day,scope,kind));
    CREATE TABLE IF NOT EXISTS security_activity(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,
      last_seen INTEGER NOT NULL,messages INTEGER NOT NULL,voice_seconds INTEGER NOT NULL,
      PRIMARY KEY(guild_id,user_id));
    CREATE TABLE IF NOT EXISTS security_findings(id TEXT PRIMARY KEY,guild_id TEXT NOT NULL,channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,at INTEGER NOT NULL,score INTEGER NOT NULL,reasons TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',reviewer_id TEXT,resolution TEXT);
    CREATE INDEX IF NOT EXISTS security_findings_time ON security_findings(guild_id,at);`);
  // A restart creates an observation gap. Never count persisted wall-clock downtime as observed voice time.
  store.db
    .prepare(
      "UPDATE kv SET value=json_set(value,'$.checkpoint',?),updated_at=? WHERE namespace='security.voice'",
    )
    .run(Date.now(), Date.now());
  initialized.add(store);
}
function enabled(store: Store, guildId: string, category: string): boolean {
  return !(store.get<string[]>('core.disabled', guildId) ?? []).includes(category);
}
function seen(store: Store, key: string, now: number): boolean {
  tables(store);
  const inserted = store.db.prepare('INSERT OR IGNORE INTO security_seen VALUES(?,?)').run(key, now).changes;
  const count = (observationCounts.get(store) ?? 0) + 1;
  observationCounts.set(store, count);
  if (count % 256 === 0) {
    store.db.prepare('DELETE FROM security_seen WHERE at<?').run(now - DAY);
    store.db.exec(
      'DELETE FROM security_seen WHERE key IN (SELECT key FROM security_seen ORDER BY at DESC LIMIT -1 OFFSET 100000)',
    );
  }
  return inserted === 0;
}
function metric(store: Store, guildId: string, kind: string, scope = '*', count = 1, now = Date.now()): void {
  tables(store);
  store.db
    .prepare(
      `INSERT INTO security_metrics VALUES(?,?,?,?,?) ON CONFLICT(guild_id,day,scope,kind)
    DO UPDATE SET count=count+excluded.count`,
    )
    .run(guildId, new Date(now).toISOString().slice(0, 10), scope, kind, count);
}
function activity(
  store: Store,
  guildId: string,
  userId: string,
  messages: number,
  voiceSeconds: number,
  now: number,
): void {
  if (store.get<boolean>('security.activityOptOut', `${guildId}:${userId}`)) return;
  tables(store);
  const exists = store.db
    .prepare('SELECT 1 FROM security_activity WHERE guild_id=? AND user_id=?')
    .get(guildId, userId);
  if (
    !exists &&
    Number(
      store.db.prepare('SELECT count(*) AS n FROM security_activity WHERE guild_id=?').get(guildId)?.n ?? 0,
    ) >= 50000
  )
    return;
  store.db
    .prepare(
      `INSERT INTO security_activity VALUES(?,?,?,?,?) ON CONFLICT(guild_id,user_id)
    DO UPDATE SET last_seen=excluded.last_seen,messages=messages+excluded.messages,voice_seconds=voice_seconds+excluded.voice_seconds`,
    )
    .run(guildId, userId, now, messages, voiceSeconds);
}
interface EventRecord {
  guildId: string;
  kind: string;
  at: number;
  channelId?: string;
  userId?: string;
  before?: string;
  after?: string;
  metadata?: Record<string, unknown>;
}
function record(store: Store, value: EventRecord): void {
  tables(store);
  const serialized = JSON.stringify(value.metadata ?? {}, (_key, item) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
  const metadata =
    serialized.length > 5000
      ? JSON.stringify({ truncated: true, summary: serialized.slice(0, 4000) })
      : serialized;
  store.db
    .prepare('INSERT INTO security_events VALUES(?,?,?,?,?,?,?,?,?)')
    .run(
      randomUUID(),
      value.guildId,
      value.channelId ?? null,
      value.userId ?? null,
      value.kind,
      value.at,
      value.before?.slice(0, 1000) ?? null,
      value.after?.slice(0, 1000) ?? null,
      metadata,
    );
  const count = Number(
    store.db.prepare('SELECT count(*) AS n FROM security_events WHERE guild_id=?').get(value.guildId)?.n ?? 0,
  );
  if (count > 5100)
    store.db
      .prepare(
        'DELETE FROM security_events WHERE id IN (SELECT id FROM security_events WHERE guild_id=? ORDER BY at DESC,rowid DESC LIMIT -1 OFFSET 5000)',
      )
      .run(value.guildId);
}
function guildFrom(args: unknown[], client: Client): Guild | undefined {
  for (const arg of [...args].reverse()) {
    if (!arg || typeof arg !== 'object') continue;
    const item = arg as {
      guild?: Guild;
      guildId?: string;
      message?: { guild?: Guild };
      poll?: { message?: { guild?: Guild } };
      id?: string;
      members?: unknown;
      channels?: unknown;
    };
    if (item.guild?.id) return item.guild;
    if (item.message?.guild?.id) return item.message.guild;
    if (item.poll?.message?.guild?.id) return item.poll.message.guild;
    if (item.guildId) {
      const guild = client.guilds.cache.get(item.guildId);
      if (guild) return guild;
    }
    if (item.id && item.members && item.channels) return item as Guild;
  }
  return undefined;
}
async function alert(
  guild: Guild,
  store: Store,
  config: SecuritySettings,
  key: string,
  content: string,
  now: number,
  cooldown = 60000,
): Promise<boolean> {
  if (!config.alertChannelId) return false;
  const stateKey = `${guild.id}:${key}`;
  const previous = store.get<{ at: number; failures: number }>('security.alerts', stateKey);
  const backoff = previous
    ? Math.max(cooldown, Math.min(3600000, 10000 * 2 ** Math.min(previous.failures, 8)))
    : cooldown;
  if (previous && now - previous.at < backoff) return false;
  const budget = (store.get<number[]>('security.alertBudget', guild.id) ?? []).filter(
    (at) => now - at < 60000,
  );
  if (budget.length >= 10) return false;
  store.set('security.alertBudget', guild.id, [...budget, now]);
  store.set('security.alerts', stateKey, { at: now, failures: previous?.failures ?? 0 });
  try {
    const channel = await guild.channels.fetch(config.alertChannelId, { force: true });
    const me = guild.members.me ?? (await guild.members.fetchMe());
    const current = securitySettings(store, guild.id);
    if (
      !enabled(store, guild.id, 'security') ||
      !current.enabled ||
      current.alertChannelId !== config.alertChannelId
    )
      return false;
    if (!channel?.isSendable() || !channel.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages]))
      throw new Error('AlertChannelUnavailable');
    await channel.send({ content: content.slice(0, 1900), allowedMentions: { parse: [] } });
    store.set('security.alerts', stateKey, { at: now, failures: 0 });
    return true;
  } catch {
    store.set('security.alerts', stateKey, { at: now, failures: (previous?.failures ?? 0) + 1 });
    return false;
  }
}
function burst(
  store: Store,
  guildId: string,
  key: string,
  now: number,
  windowMs: number,
): { count: number; triggeredAt: number } {
  const stateKey = `${guildId}:${key}`;
  const previous = store.get<{ hits: number[]; triggeredAt: number }>('security.bursts', stateKey) ?? {
    hits: [],
    triggeredAt: 0,
  };
  const hits = previous.hits.filter((at) => now - at < windowMs).slice(-199);
  hits.push(now);
  store.set('security.bursts', stateKey, { hits, triggeredAt: previous.triggeredAt });
  return { count: hits.length, triggeredAt: previous.triggeredAt };
}
function markBurst(store: Store, guildId: string, key: string, now: number): void {
  const stateKey = `${guildId}:${key}`;
  const state = store.get<{ hits: number[]; triggeredAt: number }>('security.bursts', stateKey);
  if (state) store.set('security.bursts', stateKey, { ...state, triggeredAt: now });
}
export interface ContentFinding {
  score: number;
  reasons: string[];
  domains: string[];
}
export function analyzeMessageContent(
  content: string,
  filenames: string[],
  mentionCount: number,
  config: SecuritySettings,
): ContentFinding {
  let score = 0;
  const reasons: string[] = [],
    domains = new Set<string>();
  const matches =
    content
      .slice(0, 12000)
      .match(/https?:\/\/[^\s<>"`]+/gi)
      ?.slice(0, 15) ?? [];
  const matchesDomain = (host: string, list: string[]) =>
    list.some((value) => host === value || host.endsWith(`.${value}`));
  for (const match of matches) {
    let url: URL;
    try {
      url = new URL(match.slice(0, 2048));
    } catch {
      score += 10;
      reasons.push('malformed URL');
      continue;
    }
    const host = url.hostname.toLowerCase();
    domains.add(host);
    if (matchesDomain(host, config.blockedDomains)) {
      score += 100;
      reasons.push(`blocked domain: ${host}`);
      continue;
    }
    if (matchesDomain(host, config.allowedDomains)) continue;
    if (url.username || url.password) {
      score += 50;
      reasons.push('URL contains user-info masking');
    }
    if (host.includes('xn--')) {
      score += 20;
      reasons.push('internationalized hostname requires review');
    }
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) || host.startsWith('[')) {
      score += 25;
      reasons.push('literal IP link');
    }
    if (/(?:discord[^.]*gift|nitro[^.]*free|steam[^.]*gift|discord[^.]*nitro)/i.test(host)) {
      score += 35;
      reasons.push('giveaway impersonation pattern');
    }
    if (url.protocol === 'http:') {
      score += 10;
      reasons.push('unencrypted HTTP link');
    }
  }
  for (const filename of filenames.slice(0, 10)) {
    const lower = filename.toLowerCase();
    if (config.suspiciousExtensions.some((ext) => lower.endsWith(ext))) {
      score += 60;
      reasons.push(`suspicious attachment extension: ${lower.slice(-20)}`);
    }
    if (/\.(?:png|jpg|pdf|txt)\.(?:exe|scr|com|lnk)$/i.test(filename)) {
      score += 30;
      reasons.push('double extension disguise');
    }
  }
  if (mentionCount >= config.mentionLimit) {
    score += 60;
    reasons.push('excessive mentions');
  }
  const letters = content.match(/\p{L}/gu) ?? [],
    capitals = content.match(/\p{Lu}/gu) ?? [];
  if (letters.length >= 20 && capitals.length / letters.length >= 0.8) {
    score += 20;
    reasons.push('excessive capitalization');
  }
  if ((content.match(/\p{Extended_Pictographic}/gu)?.length ?? 0) >= 20) {
    score += 30;
    reasons.push('excessive emoji');
  }
  return {
    score: Math.min(500, score),
    reasons: [...new Set(reasons)].slice(0, 20),
    domains: [...domains].slice(0, 15),
  };
}
async function correlate(
  guild: Guild,
  type: AuditLogEvent,
  targetId: string,
  now: number,
): Promise<string | undefined> {
  try {
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (!me.permissions.has(P.ViewAuditLog)) return undefined;
    const logs = await guild.fetchAuditLogs({ type, limit: 5 });
    const candidates = [...logs.entries.values()].filter(
      (entry) => entry.targetId === targetId && Math.abs(now - entry.createdTimestamp) < 15000,
    );
    return candidates.length === 1 ? (candidates[0]?.executorId ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

export const SECURITY_EVENTS = [
  Events.MessageCreate,
  Events.MessageUpdate,
  Events.MessageDelete,
  Events.GuildMemberAdd,
  Events.GuildMemberRemove,
  Events.GuildMemberUpdate,
  Events.ChannelCreate,
  Events.ChannelUpdate,
  Events.ChannelDelete,
  Events.GuildRoleCreate,
  Events.GuildRoleUpdate,
  Events.GuildRoleDelete,
  Events.ThreadCreate,
  Events.ThreadUpdate,
  Events.ThreadDelete,
  Events.VoiceStateUpdate,
  Events.MessageReactionAdd,
  Events.MessageReactionRemove,
  Events.MessagePollVoteAdd,
  Events.MessagePollVoteRemove,
  Events.GuildScheduledEventCreate,
  Events.GuildScheduledEventUpdate,
  Events.GuildScheduledEventDelete,
  Events.GuildScheduledEventUserAdd,
  Events.GuildScheduledEventUserRemove,
  Events.AutoModerationActionExecution,
  Events.WebhooksUpdate,
  Events.GuildAuditLogEntryCreate,
  Events.GuildUpdate,
] as const;

export async function observeSecurityEvent(
  event: string,
  args: unknown[],
  client: Client,
  store: Store,
): Promise<void> {
  const guild = guildFrom(args, client);
  if (!guild) return;
  const config = securitySettings(store, guild.id);
  const security = config.enabled && enabled(store, guild.id, 'security');
  const analytics = config.analyticsEnabled && enabled(store, guild.id, 'analytics');
  if (!security && !analytics) return;
  tables(store);
  const now = Date.now();
  if (event === Events.MessageCreate || event === Events.MessageUpdate || event === Events.MessageDelete) {
    const message = (event === Events.MessageUpdate ? args[1] : args[0]) as Message | undefined;
    const before = args[0] as Message | undefined;
    if (!message?.id || message.author?.bot || message.webhookId) return;
    const fingerprint =
      event === Events.MessageUpdate
        ? `${
            message.editedTimestamp ??
            createHash('sha256')
              .update(message.content ?? '')
              .digest('hex')
          }`
        : event;
    if (seen(store, `${guild.id}:${event}:${message.id}:${fingerprint}`, now)) return;
    if (analytics) {
      metric(
        store,
        guild.id,
        event === Events.MessageCreate
          ? 'messages'
          : event === Events.MessageUpdate
            ? 'messageEdits'
            : 'messageDeletes',
        message.channelId,
        1,
        now,
      );
      if (event === Events.MessageCreate && message.author)
        activity(store, guild.id, message.author.id, 1, 0, now);
    }
    if (
      security &&
      event !== Events.MessageCreate &&
      (config.logChannelIds.length === 0 || config.logChannelIds.includes(message.channelId)) &&
      ((event === Events.MessageUpdate && config.logMessageEdits) ||
        (event === Events.MessageDelete && config.logMessageDeletes))
    ) {
      record(store, {
        guildId: guild.id,
        channelId: message.channelId,
        userId: message.author?.id,
        kind: event,
        at: now,
        ...(config.logMessageContent
          ? {
              before: before?.content ?? '',
              after: event === Events.MessageUpdate ? (message.content ?? '') : undefined,
            }
          : {}),
        metadata: {
          messageId: message.id,
          contentRecorded: config.logMessageContent,
          partial: !!message.partial,
        },
      });
    }
    if (event !== Events.MessageCreate) return;
    if (analytics) {
      const spike = burst(store, guild.id, `activity:${message.channelId}`, now, 60000);
      if (spike.count >= config.activitySpikeThreshold && now - spike.triggeredAt > 60000) {
        markBurst(store, guild.id, `activity:${message.channelId}`, now);
        await alert(
          guild,
          store,
          config,
          `activity:${message.channelId}`,
          `Activity spike: ${spike.count} observed messages in channel ${message.channelId} within one minute.`,
          now,
        );
      }
    }
    if (
      !security ||
      !config.contentAnalysisEnabled ||
      config.trustedRoleIds.some((roleId) => message.member?.roles.cache.has(roleId))
    )
      return;
    const mentions =
      (message.mentions?.users.size ?? 0) +
      (message.mentions?.roles.size ?? 0) +
      (message.mentions?.everyone ? config.mentionLimit : 0);
    const finding = analyzeMessageContent(
      message.content ?? '',
      [...message.attachments.values()].map((file) => file.name),
      mentions,
      config,
    );
    if (finding.score < config.flagScore || !message.author) return;
    const findingId = randomUUID();
    store.db
      .prepare(
        'INSERT INTO security_findings(id,guild_id,channel_id,user_id,at,score,reasons) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        findingId,
        guild.id,
        message.channelId,
        message.author.id,
        now,
        finding.score,
        JSON.stringify(finding.reasons),
      );
    const count = Number(
      store.db.prepare('SELECT count(*) AS n FROM security_findings WHERE guild_id=?').get(guild.id)?.n ?? 0,
    );
    if (count > 5100)
      store.db
        .prepare(
          'DELETE FROM security_findings WHERE id IN (SELECT id FROM security_findings WHERE guild_id=? ORDER BY at DESC LIMIT -1 OFFSET 5000)',
        )
        .run(guild.id);
    let deleted = false;
    if (config.autoDeleteFlagged && message.deletable && enabled(store, guild.id, 'security')) {
      await message.delete();
      deleted = true;
    }
    await alert(
      guild,
      store,
      config,
      `content:${message.author.id}`,
      `Human review requested: finding ${findingId}; member ${message.author.id}; channel ${message.channelId}; score ${finding.score}; ${deleted ? 'message removed by configured policy' : 'no punishment applied'}. Use security.findings.`,
      now,
    );
    return;
  }
  if (event === Events.GuildMemberAdd || event === Events.GuildMemberRemove) {
    const member = args[0] as GuildMember;
    if (seen(store, `${guild.id}:${event}:${member.id}:${member.joinedTimestamp ?? ''}`, now)) return;
    if (analytics)
      metric(store, guild.id, event === Events.GuildMemberAdd ? 'memberJoins' : 'memberLeaves', '*', 1, now);
    if (security && config.logAdministrativeChanges)
      record(store, {
        guildId: guild.id,
        kind: event,
        userId: member.id,
        at: now,
        metadata: { joinedAt: member.joinedTimestamp },
      });
    if (event !== Events.GuildMemberAdd || !security || !config.raidEnabled) return;
    const state = burst(store, guild.id, 'joins', now, config.raidWindowSeconds * 1000);
    if (state.count < config.raidJoinThreshold || now - state.triggeredAt < config.raidWindowSeconds * 1000)
      return;
    markBurst(store, guild.id, 'joins', now);
    let pause: string | undefined, pauseError: string | undefined;
    if (config.autoPauseInvites) {
      try {
        const me = await guild.members.fetchMe({ force: true });
        if (!me.permissions.has(P.ManageGuild)) throw new UserError('Missing Manage Server permission.');
        if (!enabled(store, guild.id, 'security') || !securitySettings(store, guild.id).autoPauseInvites)
          return;
        const requested = now + config.invitesPauseMinutes * 60000;
        const existing = guild.incidentsData?.invitesDisabledUntil?.getTime() ?? 0;
        pause = new Date(Math.max(requested, existing)).toISOString();
        await guild.setIncidentActions({ invitesDisabledUntil: pause });
      } catch (error) {
        pauseError = error instanceof Error ? error.name : 'Error';
      }
    }
    record(store, {
      guildId: guild.id,
      kind: 'raidJoinSpike',
      at: now,
      metadata: {
        joins: state.count,
        windowSeconds: config.raidWindowSeconds,
        pauseUntil: pause,
        pauseError,
      },
    });
    await alert(
      guild,
      store,
      config,
      'raid',
      `Join spike: ${state.count} members within ${config.raidWindowSeconds} seconds. ${pause && !pauseError ? `Invites paused until ${pause}.` : pauseError ? 'Configured invite pause failed; staff review needed.' : 'No automatic punishment applied.'}`,
      now,
    );
    return;
  }
  if (event === Events.VoiceStateUpdate) {
    if (!analytics) return;
    const before = args[0] as VoiceState,
      after = args[1] as VoiceState;
    if (!after?.id || after.member?.user.bot) return;
    const key = `${guild.id}:${after.id}`;
    if (store.get<boolean>('security.activityOptOut', key)) {
      store.delete('security.voice', key);
      return;
    }
    const saved = store.get<{ channelId: string; checkpoint: number }>('security.voice', key);
    if (before.channelId !== after.channelId) {
      if (saved) finishVoice(store, guild.id, after.id, saved, now);
      if (after.channelId) {
        store.set('security.voice', key, { channelId: after.channelId, checkpoint: now });
        metric(store, guild.id, 'voiceJoins', after.channelId, 1, now);
      } else store.delete('security.voice', key);
    } else if (after.channelId) metric(store, guild.id, 'voiceStateChanges', after.channelId, 1, now);
    return;
  }
  const reactionEvents: string[] = [
    Events.MessageReactionAdd,
    Events.MessageReactionRemove,
    Events.MessagePollVoteAdd,
    Events.MessagePollVoteRemove,
  ];
  if (reactionEvents.includes(event)) {
    if (analytics) {
      const object = args[0] as {
        message?: { channelId?: string };
        poll?: { message?: { channelId?: string } };
      };
      metric(
        store,
        guild.id,
        event,
        object.message?.channelId ?? object.poll?.message?.channelId ?? '*',
        1,
        now,
      );
    }
    return;
  }
  if (event === Events.GuildAuditLogEntryCreate) {
    if (!security || !config.logAdministrativeChanges) return;
    const entry = args[0] as { id: string; executorId?: string; targetId?: string; action: number };
    if (seen(store, `${guild.id}:audit:${entry.id}`, now)) return;
    record(store, {
      guildId: guild.id,
      kind: event,
      userId: entry.executorId,
      at: now,
      metadata: {
        entryId: entry.id,
        targetId: entry.targetId,
        action: entry.action,
        actorAssociation: 'Discord audit entry',
      },
    });
    return;
  }
  if (event === Events.AutoModerationActionExecution) {
    const execution = args[0] as {
      ruleId?: string;
      userId?: string;
      channelId?: string;
      action?: { type?: number };
      messageId?: string;
    };
    if (analytics) metric(store, guild.id, 'automodExecutions', execution.channelId ?? '*', 1, now);
    if (security && config.logAdministrativeChanges)
      record(store, {
        guildId: guild.id,
        kind: event,
        channelId: execution.channelId,
        userId: execution.userId,
        at: now,
        metadata: {
          ruleId: execution.ruleId,
          messageId: execution.messageId,
          actionType: execution.action?.type,
        },
      });
    return;
  }
  if (event === Events.GuildMemberUpdate) {
    if (!security || !config.logAdministrativeChanges) return;
    const before = args[0] as GuildMember,
      after = args[1] as GuildMember;
    const oldRoles = [...before.roles.cache.keys()].sort(),
      newRoles = [...after.roles.cache.keys()].sort();
    if (before.nickname === after.nickname && JSON.stringify(oldRoles) === JSON.stringify(newRoles)) return;
    const stateHash = createHash('sha256')
      .update(JSON.stringify([after.nickname, newRoles]))
      .digest('hex');
    if (store.get<string>('security.states', `${guild.id}:member:${after.id}`) === stateHash) return;
    store.set('security.states', `${guild.id}:member:${after.id}`, stateHash);
    const actorId = config.correlateAuditActors
      ? await correlate(
          guild,
          JSON.stringify(oldRoles) !== JSON.stringify(newRoles)
            ? AuditLogEvent.MemberRoleUpdate
            : AuditLogEvent.MemberUpdate,
          after.id,
          now,
        )
      : undefined;
    record(store, {
      guildId: guild.id,
      kind: event,
      userId: after.id,
      at: now,
      metadata: {
        oldNickname: before.nickname,
        newNickname: after.nickname,
        addedRoleIds: newRoles.filter((role) => !oldRoles.includes(role)).slice(0, 30),
        removedRoleIds: oldRoles.filter((role) => !newRoles.includes(role)).slice(0, 30),
        actorId,
        actorAssociation: actorId ? 'single matching recent audit entry; best effort' : 'unknown',
      },
    });
    return;
  }
  if (event === Events.WebhooksUpdate) {
    const channel = args[0] as { id?: string };
    if (!channel.id || !security) return;
    if (config.logAdministrativeChanges)
      record(store, {
        guildId: guild.id,
        channelId: channel.id,
        kind: event,
        at: now,
        metadata: { targetId: channel.id },
      });
    await alert(
      guild,
      store,
      config,
      'webhooks',
      `Webhook configuration changed in channel ${channel.id}. Review authorized integrations and the audit log.`,
      now,
    );
    return;
  }
  const object = (event.endsWith('Update') ? args[1] : args[0]) as
    | {
        id?: string;
        channelId?: string;
        name?: string;
        permissions?: { bitfield: bigint };
        position?: number;
        parentId?: string | null;
        topic?: string | null;
        nsfw?: boolean;
        rateLimitPerUser?: number;
        verificationLevel?: number;
        permissionOverwrites?: {
          cache: {
            map<T>(
              fn: (value: { id: string; allow: { bitfield: bigint }; deny: { bitfield: bigint } }) => T,
            ): T[];
          };
        };
      }
    | undefined;
  if (!object?.id) return;
  if (analytics) metric(store, guild.id, event, object.channelId ?? '*', 1, now);
  if (!security || (!config.logAdministrativeChanges && !config.antiNukeEnabled)) return;
  const isChannel = event.startsWith('channel') || event.startsWith('thread');
  const channelId = isChannel ? object.id : object.channelId;
  const shape = {
    name: object.name?.slice(0, 100),
    permissions: object.permissions?.bitfield.toString(),
    position: object.position,
    parentId: object.parentId,
    topic: object.topic?.slice(0, 1024),
    nsfw: object.nsfw,
    slowmode: object.rateLimitPerUser,
    verificationLevel: object.verificationLevel,
    overwrites: object.permissionOverwrites?.cache
      .map((overwrite) => ({
        id: overwrite.id,
        allow: overwrite.allow.bitfield.toString(),
        deny: overwrite.deny.bitfield.toString(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  const stateKey = `${guild.id}:${event}:${object.id}`;
  if (event.endsWith('Update')) {
    const hash = createHash('sha256').update(JSON.stringify(shape)).digest('hex');
    if (store.get<string>('security.states', stateKey) === hash) return;
    store.set('security.states', stateKey, hash);
  } else if (seen(store, stateKey, now)) return;
  let auditType: AuditLogEvent | undefined;
  if (event === Events.ChannelDelete) auditType = AuditLogEvent.ChannelDelete;
  if (event === Events.GuildRoleDelete) auditType = AuditLogEvent.RoleDelete;
  if (event === Events.GuildRoleUpdate) auditType = AuditLogEvent.RoleUpdate;
  if (event === Events.ChannelUpdate) auditType = AuditLogEvent.ChannelUpdate;
  const actorId =
    config.correlateAuditActors && auditType !== undefined
      ? await correlate(guild, auditType, object.id, now)
      : undefined;
  if (config.logAdministrativeChanges)
    record(store, {
      guildId: guild.id,
      kind: event,
      channelId,
      at: now,
      metadata: {
        targetId: object.id,
        ...shape,
        actorId,
        actorAssociation: actorId ? 'single matching recent audit entry; best effort' : 'unknown',
      },
    });
  if (event === Events.GuildRoleUpdate || event === Events.GuildRoleCreate) {
    const previous =
      event === Events.GuildRoleUpdate
        ? ((args[0] as { permissions?: { bitfield: bigint } }).permissions?.bitfield ?? 0n)
        : 0n;
    const current = object.permissions?.bitfield ?? 0n;
    const privileged =
      P.Administrator |
      P.ManageGuild |
      P.ManageRoles |
      P.ManageChannels |
      P.ManageWebhooks |
      P.BanMembers |
      P.KickMembers |
      P.ModerateMembers |
      P.MentionEveryone;
    const added = current & ~previous & privileged,
      removed = previous & ~current & privileged;
    if (added || removed) {
      record(store, {
        guildId: guild.id,
        kind: 'privilegedRoleChange',
        at: now,
        metadata: {
          roleId: object.id,
          added: added.toString(),
          removed: removed.toString(),
          actorId,
          actorAssociation: actorId ? 'best effort' : 'unknown',
        },
      });
      await alert(
        guild,
        store,
        config,
        `privileged-role:${object.id}`,
        `Privileged role permission change: role ${object.id}; added bits ${added}; removed bits ${removed}. Review the role and audit log; actor ${actorId ?? 'unknown'}.`,
        now,
      );
    }
  }
  if (
    actorId &&
    config.allowedAdminUserIds.length &&
    !config.allowedAdminUserIds.includes(actorId) &&
    actorId !== client.user?.id
  )
    await alert(
      guild,
      store,
      config,
      `unlisted:${actorId}`,
      `Administrative change by an actor outside the configured allowlist: member ${actorId}, event ${event}, target ${object.id}. Review the Discord audit log before drawing conclusions.`,
      now,
    );
  if (
    config.antiNukeEnabled &&
    [Events.ChannelDelete, Events.GuildRoleDelete, Events.GuildRoleUpdate].includes(
      event as typeof Events.ChannelDelete,
    )
  ) {
    const state = burst(store, guild.id, 'structure', now, config.changeWindowSeconds * 1000);
    if (
      state.count >= config.changeThreshold &&
      now - state.triggeredAt > config.changeWindowSeconds * 1000
    ) {
      markBurst(store, guild.id, 'structure', now);
      await alert(
        guild,
        store,
        config,
        'structure',
        `Structural-change spike: ${state.count} observed channel deletions/role deletions or edits within ${config.changeWindowSeconds} seconds. Human review required; no rollback or punishment has been performed.`,
        now,
      );
    }
  }
}
function finishVoice(
  store: Store,
  guildId: string,
  userId: string,
  saved: { channelId: string; checkpoint: number },
  now: number,
): void {
  let cursor = Math.max(saved.checkpoint, now - DAY),
    total = 0;
  while (cursor < now) {
    const date = new Date(cursor);
    date.setUTCHours(24, 0, 0, 0);
    const end = Math.min(now, date.getTime());
    const seconds = Math.max(0, Math.floor((end - cursor) / 1000));
    if (seconds) metric(store, guildId, 'voiceSeconds', saved.channelId, seconds, cursor);
    total += seconds;
    cursor = end;
  }
  if (total) activity(store, guildId, userId, 0, total, now);
}
export function recordCommandMetric(
  store: Store,
  guildId: string,
  action: string,
  status: 'success' | 'failure',
  durationMs: number,
): void {
  const config = securitySettings(store, guildId);
  if (!config.analyticsEnabled || !enabled(store, guildId, 'analytics')) return;
  metric(store, guildId, `command:${action}:${status}`);
  metric(store, guildId, 'commandDurationMs', '*', Math.max(0, Math.min(300000, durationMs)));
  metric(store, guildId, `duration:${action}`, '*', Math.max(0, Math.min(300000, durationMs)));
}

async function visibleEvents(
  ctx: ActionContext,
  limit: number,
  kind?: string,
): Promise<Record<string, unknown>[]> {
  tables(ctx.store);
  const records = ctx.store.db
    .prepare(
      `SELECT * FROM security_events WHERE guild_id=? ${kind ? 'AND event_type=?' : ''} ORDER BY at DESC LIMIT 1000`,
    )
    .all(...(kind ? [ctx.guild.id, kind] : [ctx.guild.id]));
  const visible = new Map<string, boolean>();
  const rows: Record<string, unknown>[] = [];
  for (const row of records) {
    if (row.channel_id) {
      const channelId = String(row.channel_id);
      if (!visible.has(channelId)) {
        const channel = await resolveChannel(ctx, channelId).catch(() => null);
        visible.set(channelId, !!channel && !!channel.permissionsFor(ctx.member)?.has(P.ReadMessageHistory));
      }
      if (!visible.get(channelId)) continue;
    }
    rows.push({ ...row, metadata: JSON.parse(String(row.metadata)) as unknown });
    if (rows.length >= limit) break;
  }
  return rows;
}
interface Snapshot {
  capturedAt: number;
  guild: { name: string; verificationLevel: number };
  channels: { id: string; hash: string }[];
  roles: { id: string; hash: string }[];
}
interface SavedOverwrite {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
}
interface LockedChannel {
  channelId: string;
  before: SavedOverwrite[];
  applied: SavedOverwrite[];
  state: 'pending' | 'applied' | 'restored' | 'conflict' | 'failed' | 'gone';
  error?: string;
}
interface Lockdown {
  id: string;
  guildId: string;
  actorId: string;
  createdAt: number;
  expiresAt: number;
  state: 'applying' | 'active' | 'partial' | 'restored';
  channels: LockedChannel[];
  attempts: number;
  retryAt: number;
}
const runningLockdowns = new WeakMap<Store, Set<string>>();
function overwriteList(
  channel: Exclude<
    GuildBasedChannel,
    { type: ChannelType.PublicThread | ChannelType.PrivateThread | ChannelType.AnnouncementThread }
  >,
): SavedOverwrite[] {
  if (!('permissionOverwrites' in channel))
    throw new UserError('Threads inherit channel permissions; choose their parent channel.');
  return channel.permissionOverwrites.cache
    .map((value) => ({
      id: value.id,
      type: value.type as 0 | 1,
      allow: value.allow.bitfield.toString(),
      deny: value.deny.bitfield.toString(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
function sameOverwrites(a: SavedOverwrite[], b: SavedOverwrite[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function lockdownKey(guildId: string, operationId: string): string {
  return `${guildId}:${operationId}`;
}
async function restoreLockdown(
  guild: Guild,
  store: Store,
  operation: Lockdown,
  force = false,
  ctx?: ActionContext,
): Promise<Lockdown> {
  const running = runningLockdowns.get(store) ?? new Set<string>();
  if (running.has(operation.id))
    throw new UserError('This lockdown operation is still processing. Try again shortly.');
  runningLockdowns.set(store, running);
  running.add(operation.id);
  try {
    const bot = await guild.members.fetchMe({ force: true });
    for (const item of operation.channels) {
      if (item.state === 'restored' || item.state === 'gone' || (!ctx && item.state === 'conflict')) continue;
      try {
        const channel = ctx
          ? await resolveChannel(ctx, item.channelId)
          : await guild.channels.fetch(item.channelId, { force: true });
        if (!channel) {
          item.state = 'gone';
          continue;
        }
        if (channel.isThread() || !('permissionOverwrites' in channel))
          throw new UserError('Unsupported lockdown channel.');
        if (!channel.permissionsFor(bot)?.has([P.ManageChannels, P.ManageRoles]))
          throw new UserError('Bot cannot restore this channel.');
        if (ctx && !channel.permissionsFor(ctx.member)?.has([P.ManageChannels, P.ManageRoles]))
          throw new UserError('You cannot restore this channel.');
        const current = overwriteList(channel);
        if (sameOverwrites(current, item.before)) {
          item.state = 'restored';
          delete item.error;
          continue;
        }
        if (!force && !sameOverwrites(current, item.applied)) {
          item.state = 'conflict';
          item.error = 'PermissionsChangedAfterLockdown';
          continue;
        }
        await channel.permissionOverwrites.set(
          item.before.map((value) => ({ ...value, allow: BigInt(value.allow), deny: BigInt(value.deny) })),
          'Restore saved lockdown permissions',
        );
        item.state = 'restored';
        delete item.error;
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code === 10003) {
          item.state = 'gone';
          delete item.error;
        } else {
          item.state = 'failed';
          item.error = error instanceof Error ? error.name : 'Error';
        }
      } finally {
        store.set('security.lockdowns', lockdownKey(guild.id, operation.id), operation);
      }
    }
    operation.state = operation.channels.every((item) => item.state === 'restored' || item.state === 'gone')
      ? 'restored'
      : 'partial';
    operation.attempts++;
    operation.retryAt = Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(operation.attempts, 7));
    store.set('security.lockdowns', lockdownKey(guild.id, operation.id), operation);
    if (
      operation.state === 'restored' &&
      store.get<string>('security.activeLockdown', guild.id) === operation.id
    )
      store.delete('security.activeLockdown', guild.id);
    return operation;
  } finally {
    running.delete(operation.id);
  }
}
async function snapshot(ctx: ActionContext): Promise<Snapshot> {
  const [channels, roles] = await Promise.all([ctx.guild.channels.fetch(), ctx.guild.roles.fetch()]);
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    capturedAt: Date.now(),
    guild: { name: ctx.guild.name, verificationLevel: ctx.guild.verificationLevel },
    channels: [...channels.values()]
      .filter(
        (channel): channel is Exclude<typeof channel, null> =>
          !!channel &&
          !!channel.permissionsFor(ctx.member)?.has(P.ViewChannel) &&
          !!channel.permissionsFor(ctx.guild.members.me!)?.has(P.ViewChannel),
      )
      .map((channel) => ({
        id: channel.id,
        hash: hash({
          name: channel.name,
          type: channel.type,
          parentId: channel.parentId,
          ...(!channel.isThread()
            ? {
                overwrites: channel.permissionOverwrites.cache
                  .map((overwrite) => ({
                    id: overwrite.id,
                    allow: overwrite.allow.bitfield.toString(),
                    deny: overwrite.deny.bitfield.toString(),
                  }))
                  .sort((a, b) => a.id.localeCompare(b.id)),
              }
            : {}),
        }),
      })),
    roles: roles.map((role) => ({
      id: role.id,
      hash: hash({
        name: role.name,
        permissions: role.permissions.bitfield.toString(),
        position: role.position,
      }),
    })),
  };
}
function differences(before: { id: string; hash: string }[], after: { id: string; hash: string }[]) {
  const a = new Map(before.map((value) => [value.id, value.hash])),
    b = new Map(after.map((value) => [value.id, value.hash]));
  return {
    added: [...b.keys()].filter((key) => !a.has(key)),
    removed: [...a.keys()].filter((key) => !b.has(key)),
    changed: [...b.keys()].filter((key) => a.has(key) && a.get(key) !== b.get(key)),
  };
}
function add<S extends z.ZodType>(
  registry: ActionRegistry,
  action: Omit<Action<S>, 'category' | 'userPermissions' | 'botPermissions'> &
    Partial<Pick<Action<S>, 'category' | 'userPermissions' | 'botPermissions'>>,
): void {
  registry.register({
    category: 'security',
    userPermissions: [P.ManageGuild],
    botPermissions: [],
    ...action,
  });
}
export function registerSecurityActions(registry: ActionRegistry): void {
  add(registry, {
    id: 'security.settings',
    description: 'Read opt-in raid, content-review, logging and analytics settings.',
    schema: empty,
    risk: 'read',
    execute: (ctx) => securitySettings(ctx.store, ctx.guild.id),
  });
  add(registry, {
    id: 'security.configure',
    description:
      'Configure bounded security policies and observed analytics; content logging is off by default.',
    schema: securityPatchSchema,
    risk: 'write',
    execute: async (ctx, input) => {
      const config = securitySettingsSchema.parse({ ...securitySettings(ctx.store, ctx.guild.id), ...input });
      const me = await ctx.guild.members.fetchMe({ force: true });
      if (
        config.autoPauseInvites &&
        (!ctx.member.permissions.has(P.ManageGuild) || !me.permissions.has(P.ManageGuild))
      )
        throw new UserError('You and the bot need Manage Server for automatic invite pauses.');
      if (
        config.autoDeleteFlagged &&
        (!ctx.member.permissions.has(P.ManageMessages) || !me.permissions.has(P.ManageMessages))
      )
        throw new UserError('You and the bot need Manage Messages for configured automatic deletion.');
      if (config.alertChannelId) {
        const channel = await resolveChannel(ctx, config.alertChannelId);
        if (!channel.isSendable() || !channel.permissionsFor(me)?.has(P.SendMessages))
          throw new UserError('Choose an alert channel where the bot can send.');
      }
      for (const channelId of config.logChannelIds) await resolveChannel(ctx, channelId);
      for (const roleId of config.trustedRoleIds)
        if (!(await ctx.guild.roles.fetch(roleId))) throw new UserError('Trusted role does not exist.');
      ctx.store.set('security.settings', ctx.guild.id, config);
      return config;
    },
  });
  add(registry, {
    id: 'security.analyze',
    description:
      'Score supplied text/filenames using configured local heuristics; this is not external reputation scanning.',
    schema: z.strictObject({
      text: z.string().max(12000),
      filenames: z.array(z.string().max(255)).max(10).default([]),
      mentions: z.number().int().min(0).max(1000).default(0),
    }),
    risk: 'read',
    execute: (ctx, input) =>
      analyzeMessageContent(
        input.text,
        input.filenames,
        input.mentions,
        securitySettings(ctx.store, ctx.guild.id),
      ),
  });
  add(registry, {
    id: 'security.findings',
    description: 'Read the human-review queue, restricted to currently accessible channels.',
    schema: z.strictObject({
      status: z.enum(['open', 'confirmed', 'dismissed']).default('open'),
      limit: z.number().int().min(1).max(100).default(25),
    }),
    risk: 'read',
    userPermissions: [P.ModerateMembers],
    execute: async (ctx, input) => {
      tables(ctx.store);
      const rows = ctx.store.db
        .prepare('SELECT * FROM security_findings WHERE guild_id=? AND status=? ORDER BY at DESC LIMIT 500')
        .all(ctx.guild.id, input.status);
      const visible = new Map<string, boolean>();
      const result: Record<string, unknown>[] = [];
      for (const row of rows) {
        const channelId = String(row.channel_id);
        if (!visible.has(channelId)) {
          const channel = await resolveChannel(ctx, channelId).catch(() => null);
          visible.set(
            channelId,
            !!channel && !!channel.permissionsFor(ctx.member)?.has(P.ReadMessageHistory),
          );
        }
        if (!visible.get(channelId)) continue;
        result.push({ ...row, reasons: JSON.parse(String(row.reasons)) as unknown });
        if (result.length >= input.limit) break;
      }
      return result;
    },
  });
  add(registry, {
    id: 'security.review',
    description: 'Mark a security finding confirmed or dismissed without imposing an automatic punishment.',
    schema: z.strictObject({
      findingId: z.uuid(),
      decision: z.enum(['confirmed', 'dismissed']),
      note: z.string().min(1).max(1000),
    }),
    risk: 'write',
    userPermissions: [P.ModerateMembers],
    execute: async (ctx, input) => {
      tables(ctx.store);
      const row = ctx.store.db
        .prepare('SELECT * FROM security_findings WHERE id=? AND guild_id=?')
        .get(input.findingId, ctx.guild.id);
      if (!row) throw new UserError('Finding does not belong to this server.');
      const channel = await resolveChannel(ctx, String(row.channel_id));
      if (!channel.permissionsFor(ctx.member)?.has(P.ReadMessageHistory))
        throw new UserError('Read Message History permission is required to review this finding.');
      if (
        ctx.store.db
          .prepare(
            "UPDATE security_findings SET status=?,reviewer_id=?,resolution=? WHERE id=? AND guild_id=? AND status='open'",
          )
          .run(input.decision, ctx.member.id, input.note, input.findingId, ctx.guild.id).changes !== 1
      )
        throw new UserError('Finding has already been reviewed.');
      return { findingId: input.findingId, decision: input.decision };
    },
  });
  add(registry, {
    id: 'security.trust',
    description:
      'Calculate a transparent, configurable trust score from confirmed findings and recorded warning history.',
    schema: z.strictObject({
      userId: id,
      warningPenalty: z.number().int().min(0).max(30).default(5),
      findingPenalty: z.number().int().min(0).max(30).default(10),
    }),
    risk: 'read',
    userPermissions: [P.ModerateMembers],
    execute: async (ctx, input) => {
      tables(ctx.store);
      await ctx.guild.members.fetch({ user: input.userId, force: true });
      const findings = Number(
        ctx.store.db
          .prepare(
            "SELECT count(*) AS n FROM security_findings WHERE guild_id=? AND user_id=? AND status='confirmed' AND at>?",
          )
          .get(ctx.guild.id, input.userId, Date.now() - 30 * DAY)?.n ?? 0,
      );
      const warnings = ctx.store
        .list<{ userId: string; appeal?: { status?: string } }>('community.cases', `${ctx.guild.id}:`)
        .filter((row) => row.value.userId === input.userId && row.value.appeal?.status !== 'approved').length;
      return {
        userId: input.userId,
        score: Math.max(0, 100 - findings * input.findingPenalty - warnings * input.warningPenalty),
        confirmedFindingsLast30Days: findings,
        warnings,
        limitation: 'A rule-based history score; not a prediction of intent or identity.',
      };
    },
  });
  const logInput = z.strictObject({
    limit: z.number().int().min(1).max(100).default(25),
    event: z.string().max(80).optional(),
  });
  add(registry, {
    id: 'security.logs',
    description: 'Read opt-in observed event logs; message content requires current channel/history access.',
    schema: logInput,
    risk: 'read',
    userPermissions: [P.ViewAuditLog],
    execute: (ctx, input) => visibleEvents(ctx, input.limit, input.event),
  });
  add(registry, {
    id: 'security.export',
    description: 'Export accessible observed event logs as spreadsheet-safe CSV.',
    schema: logInput,
    risk: 'read',
    userPermissions: [P.ViewAuditLog],
    execute: async (ctx, input) => ({
      attachment: Buffer.from(csv(await visibleEvents(ctx, input.limit, input.event))),
      name: 'observed-security-events.csv',
    }),
  });
  add(registry, {
    id: 'security.logs.clear',
    description: 'Permanently erase retained security events and findings for this server.',
    schema: empty,
    risk: 'destructive',
    execute: (ctx) => {
      tables(ctx.store);
      return ctx.store.transaction(() => ({
        eventsDeleted: ctx.store.db.prepare('DELETE FROM security_events WHERE guild_id=?').run(ctx.guild.id)
          .changes,
        findingsDeleted: ctx.store.db
          .prepare('DELETE FROM security_findings WHERE guild_id=?')
          .run(ctx.guild.id).changes,
      }));
    },
  });
  add(registry, {
    id: 'security.baseline.save',
    description: 'Save hashes of accessible channel configuration and role settings for later comparison.',
    schema: empty,
    risk: 'write',
    execute: async (ctx) => {
      const data = await snapshot(ctx);
      ctx.store.set('security.baselines', ctx.guild.id, data);
      return { capturedAt: data.capturedAt, channels: data.channels.length, roles: data.roles.length };
    },
  });
  add(registry, {
    id: 'security.baseline.compare',
    description:
      'Compare current accessible configuration against a saved baseline; hidden/deleted channel names are never disclosed.',
    schema: empty,
    risk: 'read',
    execute: async (ctx) => {
      const previous = ctx.store.get<Snapshot>('security.baselines', ctx.guild.id);
      if (!previous) throw new UserError('Save a baseline first.');
      const current = await snapshot(ctx);
      return {
        baselineAt: previous.capturedAt,
        comparedAt: current.capturedAt,
        channels: differences(previous.channels, current.channels),
        roles: differences(previous.roles, current.roles),
        serverSettingsChanged: JSON.stringify(previous.guild) !== JSON.stringify(current.guild),
        limitation:
          'A missing channel can mean deletion or loss of visibility. Hash differences identify changes, not authorization or malicious intent.',
      };
    },
  });
  add(registry, {
    id: 'security.lockdown.apply',
    description:
      'Temporarily lock up to 50 channels, preserving exact overwrites for restoration. Administrators retain Discord bypass.',
    schema: z.strictObject({
      channelIds: z
        .array(id)
        .min(1)
        .max(50)
        .refine((values) => new Set(values).size === values.length, 'Choose unique channels.'),
      minutes: z.number().int().min(1).max(120).default(10),
    }),
    risk: 'destructive',
    userPermissions: [P.ManageGuild, P.ManageChannels, P.ManageRoles],
    botPermissions: [P.ManageChannels, P.ManageRoles],
    execute: async (ctx, input) => {
      const bot = ctx.guild.members.me ?? (await ctx.guild.members.fetchMe());
      const channels: Exclude<
        GuildBasedChannel,
        { type: ChannelType.PublicThread | ChannelType.PrivateThread | ChannelType.AnnouncementThread }
      >[] = [];
      for (const channelId of input.channelIds) {
        const channel = await resolveChannel(ctx, channelId);
        if (channel.isThread() || !('permissionOverwrites' in channel))
          throw new UserError('Lock thread parent channels instead of individual threads.');
        for (const member of [ctx.member, bot])
          if (!channel.permissionsFor(member)?.has([P.ManageChannels, P.ManageRoles]))
            throw new UserError('You and the bot need channel and overwrite management in every target.');
        channels.push(channel);
      }
      const operation: Lockdown = {
        id: randomUUID(),
        guildId: ctx.guild.id,
        actorId: ctx.member.id,
        createdAt: Date.now(),
        expiresAt: Date.now() + input.minutes * 60000,
        state: 'applying',
        channels: [],
        attempts: 0,
        retryAt: 0,
      };
      ctx.store.transaction(() => {
        if (ctx.store.get('security.activeLockdown', ctx.guild.id))
          throw new UserError('Restore the existing lockdown before starting another.');
        ctx.store.set('security.activeLockdown', ctx.guild.id, operation.id);
        ctx.store.set('security.lockdowns', lockdownKey(ctx.guild.id, operation.id), operation);
      });
      const running = runningLockdowns.get(ctx.store) ?? new Set<string>();
      runningLockdowns.set(ctx.store, running);
      running.add(operation.id);
      try {
        for (const channel of channels) {
          const lockBits = channel.isVoiceBased()
            ? P.Connect | P.Speak
            : P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads;
          const before = overwriteList(channel),
            applied = before.map((value) => ({
              ...value,
              allow: (BigInt(value.allow) & ~lockBits).toString(),
              deny: (BigInt(value.deny) | lockBits).toString(),
            }));
          if (!applied.some((value) => value.id === ctx.guild.id))
            applied.push({ id: ctx.guild.id, type: 0, allow: '0', deny: lockBits.toString() });
          const botPermissions = channel.permissionsFor(bot);
          const botBits = botPermissions?.has(P.Administrator)
            ? lockBits
            : (botPermissions?.bitfield ?? 0n) & lockBits;
          let botOverwrite = applied.find((value) => value.id === bot.id);
          if (!botOverwrite) {
            botOverwrite = { id: bot.id, type: 1, allow: '0', deny: '0' };
            applied.push(botOverwrite);
          }
          botOverwrite.allow = (BigInt(botOverwrite.allow) | botBits).toString();
          botOverwrite.deny = (BigInt(botOverwrite.deny) & ~botBits).toString();
          applied.sort((a, b) => a.id.localeCompare(b.id));
          const saved: LockedChannel = { channelId: channel.id, before, applied, state: 'pending' };
          operation.channels.push(saved);
          ctx.store.set('security.lockdowns', lockdownKey(ctx.guild.id, operation.id), operation);
          try {
            await channel.permissionOverwrites.set(
              applied.map((value) => ({ ...value, allow: BigInt(value.allow), deny: BigInt(value.deny) })),
              `Temporary lockdown requested by ${ctx.member.id}`,
            );
            saved.state = 'applied';
          } catch (error) {
            saved.state = 'failed';
            saved.error = error instanceof Error ? error.name : 'Error';
          }
          ctx.store.set('security.lockdowns', lockdownKey(ctx.guild.id, operation.id), operation);
        }
        operation.state = operation.channels.every((item) => item.state === 'applied') ? 'active' : 'partial';
        ctx.store.set('security.lockdowns', lockdownKey(ctx.guild.id, operation.id), operation);
        return {
          operationId: operation.id,
          expiresAt: operation.expiresAt,
          applied: operation.channels.filter((item) => item.state === 'applied').length,
          failed: operation.channels
            .filter((item) => item.state === 'failed')
            .map((item) => ({ channelId: item.channelId, error: item.error })),
          notice:
            'Administrators bypass channel denies. Expiry restores saved overwrites only while they still match the applied lock; conflicting changes require explicit review.',
        };
      } finally {
        running.delete(operation.id);
      }
    },
  });
  add(registry, {
    id: 'security.lockdown.status',
    description:
      'Inspect the active lockdown and restoration conflicts without exposing inaccessible channel settings.',
    schema: empty,
    risk: 'read',
    execute: async (ctx) => {
      const operationId = ctx.store.get<string>('security.activeLockdown', ctx.guild.id);
      if (!operationId) return { active: false };
      const operation = ctx.store.get<Lockdown>('security.lockdowns', lockdownKey(ctx.guild.id, operationId));
      if (!operation) return { active: false };
      const visible = [];
      for (const item of operation.channels)
        if (await resolveChannel(ctx, item.channelId).catch(() => null))
          visible.push({ channelId: item.channelId, state: item.state, error: item.error });
      return { operationId, state: operation.state, expiresAt: operation.expiresAt, channels: visible };
    },
  });
  add(registry, {
    id: 'security.lockdown.restore',
    description:
      'Restore a saved lockdown. force=true explicitly overwrites later permission changes; default preserves conflicts.',
    schema: z.strictObject({ operationId: z.uuid(), force: z.boolean().default(false) }),
    risk: 'destructive',
    userPermissions: [P.ManageGuild, P.ManageChannels, P.ManageRoles],
    botPermissions: [P.ManageChannels, P.ManageRoles],
    execute: async (ctx, input) => {
      const operation = ctx.store.get<Lockdown>(
        'security.lockdowns',
        lockdownKey(ctx.guild.id, input.operationId),
      );
      if (!operation) throw new UserError('Lockdown does not belong to this server.');
      const restored = await restoreLockdown(ctx.guild, ctx.store, operation, input.force, ctx);
      const visible = [];
      for (const item of restored.channels)
        if (await resolveChannel(ctx, item.channelId).catch(() => null))
          visible.push({ channelId: item.channelId, state: item.state, error: item.error });
      return { operationId: restored.id, state: restored.state, channels: visible };
    },
  });
  add(registry, {
    id: 'analytics.observed',
    category: 'analytics',
    description:
      'Read UTC daily observed counters over a bounded date range; channel-specific rows require access.',
    schema: z.strictObject({ days: z.number().int().min(1).max(90).default(7), channelId: id.optional() }),
    risk: 'read',
    execute: async (ctx, input) => {
      tables(ctx.store);
      if (input.channelId) await resolveChannel(ctx, input.channelId);
      return ctx.store.db
        .prepare(
          `SELECT day,kind,sum(count) AS count FROM security_metrics WHERE guild_id=? AND day>=? ${input.channelId ? 'AND scope=?' : ''} GROUP BY day,kind ORDER BY day,kind`,
        )
        .all(
          ...[
            ctx.guild.id,
            new Date(Date.now() - (input.days - 1) * DAY).toISOString().slice(0, 10),
            ...(input.channelId ? [input.channelId] : []),
          ],
        );
    },
  });
  add(registry, {
    id: 'analytics.compare',
    category: 'analytics',
    description: 'Compare current versus previous UTC weekly or monthly observed metrics.',
    schema: z.strictObject({ periodDays: z.union([z.literal(7), z.literal(30)]).default(7) }),
    risk: 'read',
    execute: (ctx, input) => {
      tables(ctx.store);
      const currentStart = new Date(Date.now() - (input.periodDays - 1) * DAY).toISOString().slice(0, 10),
        previousStart = new Date(Date.now() - (input.periodDays * 2 - 1) * DAY).toISOString().slice(0, 10);
      const current = ctx.store.db
        .prepare(
          'SELECT kind,sum(count) AS count FROM security_metrics WHERE guild_id=? AND day>=? GROUP BY kind',
        )
        .all(ctx.guild.id, currentStart);
      const previous = ctx.store.db
        .prepare(
          'SELECT kind,sum(count) AS count FROM security_metrics WHERE guild_id=? AND day>=? AND day<? GROUP BY kind',
        )
        .all(ctx.guild.id, previousStart, currentStart);
      const prior = new Map(previous.map((row) => [String(row.kind), Number(row.count)])),
        present = new Map(current.map((row) => [String(row.kind), Number(row.count)]));
      return {
        periodDays: input.periodDays,
        currentStart,
        previousStart,
        comparison: [...new Set([...prior.keys(), ...present.keys()])].map((kind) => {
          const before = prior.get(kind) ?? 0,
            after = present.get(kind) ?? 0;
          return {
            kind,
            current: after,
            previous: before,
            change: after - before,
            percentChange: before ? Math.round(((after - before) / before) * 10000) / 100 : null,
          };
        }),
      };
    },
  });
  add(registry, {
    id: 'analytics.activity',
    category: 'analytics',
    description:
      'Read observed member activity or inactivity; absence of activity is not proof a member was offline.',
    schema: z.strictObject({
      inactiveDays: z.number().int().min(0).max(90).default(0),
      limit: z.number().int().min(1).max(1000).default(100),
    }),
    risk: 'read',
    execute: (ctx, input) => {
      tables(ctx.store);
      return ctx.store.db
        .prepare(
          'SELECT user_id,last_seen,messages,voice_seconds FROM security_activity WHERE guild_id=? AND last_seen<=? ORDER BY last_seen LIMIT ?',
        )
        .all(ctx.guild.id, Date.now() - input.inactiveDays * DAY, input.limit);
    },
  });
  add(registry, {
    id: 'analytics.leaderboard',
    category: 'analytics',
    description: 'Rank observed activity using configurable message/voice weights.',
    schema: z.strictObject({
      messageWeight: z.number().min(0).max(100).default(1),
      voiceMinuteWeight: z.number().min(0).max(100).default(1),
    }),
    risk: 'read',
    execute: (ctx, input) => {
      tables(ctx.store);
      return ctx.store.db
        .prepare(
          'SELECT user_id,messages,voice_seconds,(messages*?+voice_seconds/60.0*?) AS score FROM security_activity WHERE guild_id=? ORDER BY score DESC LIMIT 25',
        )
        .all(input.messageWeight, input.voiceMinuteWeight, ctx.guild.id);
    },
  });
  add(registry, {
    id: 'analytics.summary',
    category: 'analytics',
    description: 'Generate an observed administration/support/community activity report for this server.',
    schema: empty,
    risk: 'read',
    execute: (ctx) => {
      tables(ctx.store);
      const tickets = ctx.store
          .list<{ status: string; createdAt: number; closedAt?: number }>(
            'community.tickets',
            `${ctx.guild.id}:`,
          )
          .map((row) => row.value),
        closed = tickets.filter((ticket) => ticket.closedAt);
      return {
        observedSince:
          ctx.store.db
            .prepare('SELECT min(day) AS since FROM security_metrics WHERE guild_id=?')
            .get(ctx.guild.id)?.since ?? null,
        support: {
          tickets: tickets.length,
          open: tickets.filter((ticket) => ticket.status === 'open').length,
          averageResolutionSeconds: closed.length
            ? Math.round(
                closed.reduce((sum, ticket) => sum + (ticket.closedAt! - ticket.createdAt) / 1000, 0) /
                  closed.length,
              )
            : null,
        },
        observedMembers: Number(
          ctx.store.db
            .prepare('SELECT count(*) AS n FROM security_activity WHERE guild_id=?')
            .get(ctx.guild.id)?.n ?? 0,
        ),
        moderationCases: ctx.store.list('community.cases', `${ctx.guild.id}:`).length,
        pendingSecurityFindings: Number(
          ctx.store.db
            .prepare("SELECT count(*) AS n FROM security_findings WHERE guild_id=? AND status='open'")
            .get(ctx.guild.id)?.n ?? 0,
        ),
        giveaways: ctx.store
          .list<{ entrants: string[] }>('community.giveaways', `${ctx.guild.id}:`)
          .map((row) => ({ id: row.key.split(':')[1], entrants: row.value.entrants.length })),
        botActions: ctx.store.db
          .prepare(
            'SELECT action,status,count(*) AS count FROM audit WHERE guild_id=? GROUP BY action,status ORDER BY count DESC LIMIT 50',
          )
          .all(ctx.guild.id),
      };
    },
  });
  add(registry, {
    id: 'analytics.observed.export',
    category: 'analytics',
    description: 'Export observed daily aggregate metrics as CSV.',
    schema: z.strictObject({ days: z.number().int().min(1).max(90).default(30) }),
    risk: 'read',
    execute: (ctx, input) => {
      tables(ctx.store);
      const rows = ctx.store.db
        .prepare(
          'SELECT day,kind,sum(count) AS count FROM security_metrics WHERE guild_id=? AND day>=? GROUP BY day,kind ORDER BY day,kind',
        )
        .all(ctx.guild.id, new Date(Date.now() - input.days * DAY).toISOString().slice(0, 10));
      return { attachment: Buffer.from(csv(rows)), name: 'observed-analytics.csv' };
    },
  });
  add(registry, {
    id: 'analytics.resources',
    category: 'analytics',
    description: 'Report current CPU usage, memory, uptime and Gateway latency.',
    schema: empty,
    risk: 'read',
    execute: (ctx) => ({
      cpuMicroseconds: process.cpuUsage(),
      memoryBytes: process.memoryUsage(),
      uptimeSeconds: process.uptime(),
      gatewayLatencyMs: ctx.client.ws.ping,
      note: 'Cumulative process CPU; not a host-wide CPU percentage.',
    }),
  });
  add(registry, {
    id: 'analytics.api-latency',
    category: 'analytics',
    description:
      'Measure the real Discord REST gateway-discovery round trip, including SDK queue/network overhead, and retain a bounded per-server sample history. This performs one harmless API read.',
    schema: empty,
    risk: 'read',
    execute: async (ctx) => {
      const started = performance.now();
      await ctx.client.rest.get(Routes.gateway());
      const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
      const samples =
        ctx.store.get<{ at: number; elapsedMs: number }[]>('analytics.restLatency', ctx.guild.id) ?? [];
      samples.push({ at: Date.now(), elapsedMs });
      ctx.store.set('analytics.restLatency', ctx.guild.id, samples.slice(-30));
      return {
        endpoint: 'GET /gateway',
        elapsedMs,
        gatewayHeartbeatMs: ctx.client.ws.ping,
        samples: samples.slice(-30),
        note: 'REST duration includes SDK queue and network overhead; this is not an OpenAI billing request or an endpoint-wide histogram.',
      };
    },
  });
  add(registry, {
    id: 'analytics.command-latency',
    category: 'analytics',
    description: 'Read average elapsed execution time and counts for observed bot actions.',
    schema: z.strictObject({ days: z.number().int().min(1).max(90).default(7) }),
    risk: 'read',
    execute: (ctx, input) => {
      tables(ctx.store);
      const records = ctx.store.db
        .prepare(
          "SELECT kind,sum(count) AS count FROM security_metrics WHERE guild_id=? AND day>=? AND (kind LIKE 'command:%' OR kind LIKE 'duration:%') GROUP BY kind",
        )
        .all(ctx.guild.id, new Date(Date.now() - (input.days - 1) * DAY).toISOString().slice(0, 10));
      const counts = new Map<string, number>(),
        duration = new Map<string, number>();
      for (const row of records) {
        const key = String(row.kind);
        if (key.startsWith('duration:')) duration.set(key.slice(9), Number(row.count));
        else {
          const action = key.slice(8, key.lastIndexOf(':'));
          counts.set(action, (counts.get(action) ?? 0) + Number(row.count));
        }
      }
      return [...counts]
        .map(([action, count]) => ({
          action,
          count,
          averageMs: Math.round(((duration.get(action) ?? 0) / count) * 100) / 100,
        }))
        .sort((a, b) => b.count - a.count);
    },
  });
  add(registry, {
    id: 'analytics.privacy',
    category: 'analytics',
    description:
      'Opt yourself in or out of personal activity tracking; opting out erases your existing member counters.',
    schema: z.strictObject({ enabled: z.boolean() }),
    risk: 'write',
    userPermissions: [],
    execute: (ctx, input) => {
      tables(ctx.store);
      ctx.store.set('security.activityOptOut', `${ctx.guild.id}:${ctx.member.id}`, !input.enabled);
      if (!input.enabled) {
        ctx.store.db
          .prepare('DELETE FROM security_activity WHERE guild_id=? AND user_id=?')
          .run(ctx.guild.id, ctx.member.id);
        ctx.store.delete('security.voice', `${ctx.guild.id}:${ctx.member.id}`);
      }
      return { personalActivityEnabled: input.enabled, aggregateCountsAndModerationRecordsRetained: true };
    },
  });
  add(registry, {
    id: 'analytics.privacy.view',
    category: 'analytics',
    description: 'Read your personal observed-activity tracking preference.',
    schema: empty,
    risk: 'read',
    userPermissions: [],
    execute: (ctx) => ({
      personalActivityEnabled: !ctx.store.get<boolean>(
        'security.activityOptOut',
        `${ctx.guild.id}:${ctx.member.id}`,
      ),
    }),
  });
  add(registry, {
    id: 'analytics.erase.mine',
    category: 'analytics',
    description: 'Erase your own observed per-member activity counters; aggregate server counts remain.',
    schema: empty,
    risk: 'destructive',
    userPermissions: [],
    execute: (ctx) => {
      tables(ctx.store);
      ctx.store.delete('security.voice', `${ctx.guild.id}:${ctx.member.id}`);
      return {
        deleted: ctx.store.db
          .prepare('DELETE FROM security_activity WHERE guild_id=? AND user_id=?')
          .run(ctx.guild.id, ctx.member.id).changes,
      };
    },
  });
}

export async function sweepSecurityTasks(
  client: Client,
  store: Store,
  now = Date.now(),
  allowedGuildIds: readonly string[] = [],
): Promise<void> {
  tables(store);
  const allowed = (guildId: string) => !allowedGuildIds.length || allowedGuildIds.includes(guildId);
  for (const { value } of store
    .list<Lockdown>('security.lockdowns')
    .filter(
      (row) =>
        row.value.state !== 'restored' &&
        row.value.expiresAt <= now &&
        row.value.retryAt <= now &&
        row.value.attempts < 20,
    )
    .slice(0, 10)) {
    if (!allowed(value.guildId) || runningLockdowns.get(store)?.has(value.id)) continue;
    try {
      await restoreLockdown(await client.guilds.fetch(value.guildId), store, value);
    } catch {
      value.attempts++;
      value.retryAt = now + Math.min(3600000, 30000 * 2 ** Math.min(value.attempts, 7));
      store.set('security.lockdowns', lockdownKey(value.guildId, value.id), value);
    }
  }
  for (const { key, value } of store
    .list<{ channelId: string; checkpoint: number }>('security.voice')
    .sort((a, b) => a.value.checkpoint - b.value.checkpoint)
    .slice(0, 1000)) {
    const [guildId, userId] = key.split(':');
    if (!guildId || !userId || !allowed(guildId)) continue;
    const config = securitySettings(store, guildId);
    if (
      !config.analyticsEnabled ||
      !enabled(store, guildId, 'analytics') ||
      store.get<boolean>('security.activityOptOut', key)
    ) {
      store.delete('security.voice', key);
      continue;
    }
    const guild = client.guilds.cache.get(guildId),
      state = guild?.voiceStates?.cache.get(userId),
      member = guild?.members.cache.get(userId);
    if ((state?.channelId ?? member?.voice.channelId) !== value.channelId) {
      store.delete('security.voice', key);
      continue;
    }
    finishVoice(store, guildId, userId, value, now);
    store.set('security.voice', key, { ...value, checkpoint: now });
  }
  const guildIds = new Set<string>(store.list('security.settings').map((row) => row.key));
  for (const guildId of guildIds) {
    if (!allowed(guildId)) continue;
    const config = securitySettings(store, guildId);
    store.db
      .prepare('DELETE FROM security_events WHERE guild_id=? AND at<?')
      .run(guildId, now - config.retentionDays * DAY);
    store.db
      .prepare('DELETE FROM security_findings WHERE guild_id=? AND at<?')
      .run(guildId, now - Math.max(30, config.retentionDays) * DAY);
    store.db
      .prepare('DELETE FROM security_metrics WHERE guild_id=? AND day<?')
      .run(guildId, new Date(now - 90 * DAY).toISOString().slice(0, 10));
    store.db
      .prepare('DELETE FROM security_activity WHERE guild_id=? AND last_seen<?')
      .run(guildId, now - 90 * DAY);
  }
  store.db.prepare('DELETE FROM security_seen WHERE at<?').run(now - DAY);
  store.db
    .prepare(
      "DELETE FROM kv WHERE namespace IN ('security.states','security.alerts','security.bursts') AND updated_at<?",
    )
    .run(now - 7 * DAY);
}
