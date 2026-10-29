import { createHash, randomBytes } from 'node:crypto';
import { ChannelType, PermissionFlagsBits as P, type Client, type GuildMember } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import type { Store } from '../core/store.js';
import { UserError } from '../core/errors.js';
import { assertHierarchy, freshContext, resolveChannel, resolveMember } from '../core/permissions.js';
import { registerTemporaryBanActions, sweepTemporaryBans } from './temporary-bans.js';

const id = z.string().regex(/^\d{17,20}$/),
  empty = z.strictObject({}),
  HOUR = 3600000,
  DAY = 86400000;
const key = (guildId: string, value: string) => `${guildId}:${value}`;
const enabled = (store: Store, guildId: string) =>
  (store.get<string[]>('core.disabled', guildId) ?? []).includes('moderation') === false;
const nonce = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
export const warningPolicySchema = z.strictObject({
  noticeChannelId: id.nullable().default(null),
  escalationEnabled: z.boolean().default(false),
  threshold: z.number().int().min(2).max(20).default(3),
  windowHours: z.number().int().min(1).max(720).default(24),
  timeoutMinutes: z.number().int().min(1).max(60).default(10),
  cooldownMinutes: z.number().int().min(1).max(1440).default(60),
});
type Policy = z.infer<typeof warningPolicySchema> & { ownerId: string; version: string };
interface Warning {
  id: string;
  guildId: string;
  userId: string;
  moderatorId: string;
  createdAt: number;
  channelId: string;
}
interface Case {
  id: string;
  userId: string;
  moderatorId: string;
  reason: string;
  createdAt: number;
  notes: unknown[];
  appeal?: { status: string };
}
interface Job {
  id: string;
  guildId: string;
  caseId: string;
  userId: string;
  actorId: string;
  originChannelId: string;
  kind: 'notice' | 'timeout';
  delivery?: 'channel' | 'dm';
  channelId?: string;
  policyVersion?: string;
  until?: number;
  createdAt: number;
  expiresAt: number;
  retryAt: number;
  attempts: number;
  state: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  lastError?: string;
}
const running = new WeakSet<Store>();
function requireModeration(ctx: ActionContext): void {
  if (
    !ctx.member.permissions.has(P.ModerateMembers) ||
    !ctx.guild.members.me?.permissions.has(P.ModerateMembers)
  )
    throw new UserError('You and the bot need Moderate Members permission.');
}
async function authority(
  ctx: ActionContext,
  targetId: string,
): Promise<{ ctx: ActionContext; target: GuildMember }> {
  ctx = await freshContext(ctx);
  requireModeration(ctx);
  await resolveChannel(ctx, ctx.channelId);
  const target = await resolveMember(ctx, targetId);
  requireModeration(ctx);
  assertHierarchy(ctx, target);
  return { ctx, target };
}
function consent(store: Store, guildId: string, userId: string): boolean {
  const value = store.get<{ enabled: boolean; dm: boolean }>('notifications.consent', key(guildId, userId));
  return (
    !!(value?.enabled && value.dm) &&
    !(store.get<string[]>('core.disabled', guildId) ?? []).includes('notifications')
  );
}
async function noticeChannel(ctx: ActionContext, channelId: string, target: GuildMember) {
  const channel = await resolveChannel(ctx, channelId);
  if (
    channel.type !== ChannelType.GuildText ||
    !channel.permissionsFor(target)?.has([P.ViewChannel, P.ReadMessageHistory]) ||
    !channel.permissionsFor(ctx.guild.members.me!)?.has(P.SendMessages)
  )
    throw new UserError(
      'Warning notices require a text channel visible to the target and bot, with bot Send Messages permission.',
    );
  return channel;
}
function recentWarnings(store: Store, guildId: string, userId: string, since: number, limit = 20): Warning[] {
  return store.db
    .prepare(
      `SELECT w.value FROM kv w JOIN kv c ON c.namespace='community.cases' AND c.key=w.key
    WHERE w.namespace='moderation.warnings' AND w.key>=? AND w.key<? AND json_extract(w.value,'$.userId')=?
    AND json_extract(w.value,'$.createdAt')>=? AND COALESCE(json_extract(c.value,'$.appeal.status'),'')<>'approved'
    ORDER BY json_extract(w.value,'$.createdAt') DESC LIMIT ?`,
    )
    .all(`${guildId}:`, `${guildId};`, userId, since, limit)
    .map((row) => JSON.parse(String(row.value)) as Warning);
}
function publicJob(job: Job) {
  const { lastError, ...value } = job;
  return { ...value, lastError: lastError ?? null };
}
function jobsFor(store: Store, guildId: string, userId?: string): Job[] {
  return store.db
    .prepare(
      `SELECT value FROM kv WHERE namespace='moderation.warningJobs' AND key>=? AND key<?
    AND (? IS NULL OR json_extract(value,'$.userId')=?) ORDER BY json_extract(value,'$.createdAt') DESC LIMIT 100`,
    )
    .all(`${guildId}:`, `${guildId};`, userId ?? null, userId ?? null)
    .map((row) => JSON.parse(String(row.value)) as Job);
}
function reserveJob(store: Store, job: Job): void {
  if (
    !store.get('moderation.warningJobs', key(job.guildId, job.id)) &&
    Number(
      store.db
        .prepare(
          `SELECT count(*) AS n FROM kv WHERE namespace='moderation.warningJobs' AND key>=? AND key<? AND json_extract(value,'$.state') IN ('pending','running')`,
        )
        .get(`${job.guildId}:`, `${job.guildId};`)?.n ?? 0,
    ) >= 200
  )
    throw new UserError('Resolve pending warning jobs before adding more (limit 200 per server).');
  store.set('moderation.warningJobs', key(job.guildId, job.id), job);
}

export function registerModerationActions(registry: ActionRegistry): void {
  registerTemporaryBanActions(registry);
  const base = {
    category: 'moderation',
    userPermissions: [P.ModerateMembers],
    botPermissions: [] as bigint[],
  };
  registry.register({
    ...base,
    id: 'warning.configure',
    description:
      'Opt into explicit warning notices and bounded temporary escalation. Generic case records do not trigger this policy.',
    risk: 'write',
    userPermissions: [P.ManageGuild, P.ModerateMembers],
    schema: warningPolicySchema,
    execute: async (ctx, input) => {
      ctx = await freshContext(ctx);
      requireModeration(ctx);
      if (!ctx.member.permissions.has(P.ManageGuild))
        throw new UserError('Manage Server permission required.');
      if (input.noticeChannelId) {
        const channel = await resolveChannel(ctx, input.noticeChannelId);
        if (
          channel.type !== ChannelType.GuildText ||
          !channel.permissionsFor(ctx.guild.members.me!)?.has(P.SendMessages)
        )
          throw new UserError('Configure an accessible text channel the bot can send to.');
      }
      ctx = await freshContext(ctx);
      requireModeration(ctx);
      if (!ctx.member.permissions.has(P.ManageGuild))
        throw new UserError('Manage Server authorization changed.');
      const policy: Policy = { ...input, ownerId: ctx.member.id, version: randomBytes(8).toString('hex') };
      ctx.store.set('moderation.warningPolicy', ctx.guild.id, policy);
      return policy;
    },
  });
  registry.register({
    ...base,
    id: 'warning.policy',
    description: 'Read the explicit-warning notice and escalation policy.',
    risk: 'read',
    schema: empty,
    execute: (ctx) =>
      ctx.store.get<Policy>('moderation.warningPolicy', ctx.guild.id) ?? warningPolicySchema.parse({}),
  });
  registry.register({
    ...base,
    id: 'warning.issue',
    description:
      'Create a durable warning case with an explicitly selected notice delivery. Only these warnings count toward opted-in timeout escalation.',
    risk: 'write',
    botPermissions: [P.ModerateMembers],
    schema: z.strictObject({
      userId: id,
      reason: z.string().trim().min(1).max(1500),
      delivery: z.enum(['record-only', 'configured-channel', 'consented-dm']).default('record-only'),
    }),
    execute: async (ctx, input) => {
      const access = await authority(ctx, input.userId);
      ctx = access.ctx;
      let { target } = access;
      const policy = ctx.store.get<Policy>('moderation.warningPolicy', ctx.guild.id);
      if (input.delivery === 'configured-channel') {
        if (!policy?.noticeChannelId) throw new UserError('Configure a warning notice channel first.');
        await noticeChannel(ctx, policy.noticeChannelId, target);
      }
      if (input.delivery === 'consented-dm' && !consent(ctx.store, ctx.guild.id, target.id))
        throw new UserError('This member has not opted into personal direct messages in this server.');
      const verified = await authority(ctx, input.userId);
      ctx = verified.ctx;
      target = verified.target;
      if (input.delivery === 'consented-dm' && !consent(ctx.store, ctx.guild.id, target.id))
        throw new UserError('Personal direct-message consent changed.');
      const now = Date.now();
      return ctx.store.transaction(() => {
        if (!enabled(ctx.store, ctx.guild.id)) throw new UserError('moderation is disabled in this server.');
        if (
          Number(
            ctx.store.db
              .prepare(
                "SELECT count(*) AS n FROM kv WHERE namespace='moderation.warnings' AND key>=? AND key<? AND json_extract(value,'$.createdAt')>=?",
              )
              .get(`${ctx.guild.id}:`, `${ctx.guild.id};`, now - HOUR)?.n ?? 0,
          ) >= 100
        )
          throw new UserError('Explicit warnings are limited to 100 per server per hour.');
        const sequenceKey = key(ctx.guild.id, 'case'),
          next = (ctx.store.get<number>('community.sequence', sequenceKey) ?? 0) + 1;
        if (!Number.isSafeInteger(next) || next > 999999999999)
          throw new UserError('Case sequence limit reached.');
        ctx.store.set('community.sequence', sequenceKey, next);
        const caseId = String(next);
        const record: Case = {
          id: caseId,
          userId: target.id,
          moderatorId: ctx.member.id,
          reason: input.reason,
          createdAt: now,
          notes: [],
        };
        ctx.store.set('community.cases', key(ctx.guild.id, caseId), record);
        ctx.store.set('moderation.warnings', key(ctx.guild.id, caseId), {
          id: caseId,
          guildId: ctx.guild.id,
          userId: target.id,
          moderatorId: ctx.member.id,
          createdAt: now,
          channelId: ctx.channelId,
        } satisfies Warning);
        const queued: string[] = [];
        const common = {
          guildId: ctx.guild.id,
          caseId,
          userId: target.id,
          actorId: ctx.member.id,
          originChannelId: ctx.channelId,
          createdAt: now,
          retryAt: now,
          attempts: 0,
          state: 'pending' as const,
        };
        if (input.delivery !== 'record-only') {
          const job: Job = {
            ...common,
            id: `${caseId}-notice`,
            kind: 'notice',
            delivery: input.delivery === 'consented-dm' ? 'dm' : 'channel',
            expiresAt: now + DAY,
            ...(input.delivery === 'configured-channel'
              ? { channelId: policy!.noticeChannelId!, policyVersion: policy!.version }
              : {}),
          };
          reserveJob(ctx.store, job);
          queued.push(job.id);
        }
        const prior = ctx.store.get<{ at: number }>(
          'moderation.escalationCooldown',
          key(ctx.guild.id, target.id),
        );
        if (
          policy?.escalationEnabled &&
          (!prior || now - prior.at >= Math.max(policy.cooldownMinutes, policy.timeoutMinutes) * 60000) &&
          recentWarnings(
            ctx.store,
            ctx.guild.id,
            target.id,
            now - policy.windowHours * HOUR,
            policy.threshold,
          ).length >= policy.threshold
        ) {
          const job: Job = {
            ...common,
            id: `${caseId}-timeout`,
            kind: 'timeout',
            until: now + policy.timeoutMinutes * 60000,
            expiresAt: now + policy.timeoutMinutes * 60000,
            policyVersion: policy.version,
          };
          reserveJob(ctx.store, job);
          queued.push(job.id);
          ctx.store.set('moderation.escalationCooldown', key(ctx.guild.id, target.id), { at: now });
        }
        return {
          case: record,
          queuedJobs: queued,
          notice: 'Notice delivery and opted-in escalation run through the durable moderation queue.',
        };
      });
    },
  });
  registry.register({
    ...base,
    id: 'warning.jobs',
    description: 'Read up to 100 recent explicit-warning delivery and timeout job states.',
    risk: 'read',
    schema: z.strictObject({ userId: id.optional() }),
    execute: (ctx, input) => jobsFor(ctx.store, ctx.guild.id, input.userId).map(publicJob),
  });
  registry.register({
    ...base,
    id: 'warning.job.cancel',
    description:
      'Cancel a pending warning notice or temporary escalation. It does not retract a case or undo a delivered action.',
    risk: 'write',
    schema: z.strictObject({ jobId: z.string().regex(/^\d{1,12}-(?:notice|timeout)$/) }),
    execute: async (ctx, input) => {
      ctx = await freshContext(ctx);
      if (!ctx.member.permissions.has(P.ModerateMembers))
        throw new UserError('Moderate Members permission required.');
      const job = ctx.store.get<Job>('moderation.warningJobs', key(ctx.guild.id, input.jobId));
      if (!job) throw new UserError('Warning job not found.');
      if (!['pending', 'running'].includes(job.state))
        throw new UserError('Warning job is already complete.');
      job.state = 'cancelled';
      reserveJob(ctx.store, job);
      return publicJob(job);
    },
  });
}

export async function sweepModerationTasks(
  client: Client,
  store: Store,
  now = Date.now(),
  allowedGuildIds: readonly string[] = [],
): Promise<void> {
  await sweepTemporaryBans(client, store, now, allowedGuildIds);
  if (running.has(store)) return;
  running.add(store);
  const allowed = (guildId: string) => !allowedGuildIds.length || allowedGuildIds.includes(guildId);
  try {
    const candidates = store
      .list<Job>('moderation.warningJobs')
      .filter(
        (row) =>
          allowed(row.value.guildId) &&
          enabled(store, row.value.guildId) &&
          ['pending', 'running'].includes(row.value.state) &&
          row.value.retryAt <= now,
      )
      .sort((a, b) => a.value.createdAt - b.value.createdAt)
      .slice(0, 20);
    for (const { key: jobKey, value: job } of candidates) {
      if (job.expiresAt <= now) {
        reserveJob(store, { ...job, state: 'cancelled', lastError: 'Expired' });
        continue;
      }
      reserveJob(store, { ...job, state: 'running' });
      try {
        const guild = await client.guilds.fetch(job.guildId),
          actor = await guild.members.fetch({ user: job.actorId, force: true });
        const access = await authority(
          { client, guild, member: actor, store, channelId: job.originChannelId },
          job.userId,
        );
        const { ctx, target } = access;
        const policy = store.get<Policy>('moderation.warningPolicy', job.guildId);
        if (job.policyVersion) {
          if (!policy || policy.version !== job.policyVersion) throw new UserError('Warning policy changed.');
          const manager = await resolveMember(ctx, policy.ownerId);
          if (!manager.permissions.has([P.ManageGuild, P.ModerateMembers]))
            throw new UserError('Configuring manager lost authorization.');
          assertHierarchy({ ...ctx, member: manager }, target);
        }
        const record = store.get<Case>('community.cases', key(job.guildId, job.caseId));
        if (!record || record.userId !== job.userId) throw new UserError('Warning case is unavailable.');
        if (record.appeal?.status === 'approved') throw new UserError('The warning appeal was approved.');
        let deliver: (() => Promise<unknown>) | undefined;
        if (job.kind === 'notice') {
          const payload = {
            content:
              `Warning case #${record.id} in ${guild.name}, member ${target.id}.\n${record.reason}`.slice(
                0,
                1900,
              ),
            nonce: nonce(`${job.guildId}:${job.id}`),
            enforceNonce: true,
            allowedMentions: { parse: [] as never[] },
          };
          if (job.delivery === 'dm') {
            if (!consent(store, job.guildId, target.id))
              throw new UserError('Personal direct messages are no longer enabled.');
            deliver = () => target.send(payload);
          } else {
            const channel = await noticeChannel(ctx, job.channelId!, target);
            deliver = () => channel.send(payload);
          }
        } else {
          if (
            !policy?.escalationEnabled ||
            recentWarnings(store, job.guildId, target.id, now - policy.windowHours * HOUR, policy.threshold)
              .length < policy.threshold
          )
            throw new UserError('Warning escalation no longer applies.');
          if (target.permissions.has(P.Administrator))
            throw new UserError('Administrators cannot be timed out.');
          if ((target.communicationDisabledUntilTimestamp ?? 0) < job.until!)
            deliver = () =>
              target.disableCommunicationUntil(
                job.until!,
                `Explicit warning escalation for case ${job.caseId}`,
              );
        }
        const current = store.get<Job>('moderation.warningJobs', jobKey);
        if (current?.state !== 'running') continue;
        if (!enabled(store, job.guildId)) {
          reserveJob(store, { ...job, state: 'pending' });
          continue;
        }
        if (
          job.policyVersion &&
          store.get<Policy>('moderation.warningPolicy', job.guildId)?.version !== job.policyVersion
        )
          throw new UserError('Warning policy changed during authorization.');
        if (job.delivery === 'dm' && !consent(store, job.guildId, target.id))
          throw new UserError('Personal direct messages were revoked.');
        if (Date.now() >= job.expiresAt) {
          reserveJob(store, { ...job, state: 'cancelled', lastError: 'Expired' });
          continue;
        }
        requireModeration(ctx);
        assertHierarchy(ctx, target);
        await deliver?.();
        if (store.get<Job>('moderation.warningJobs', jobKey)?.state === 'running')
          reserveJob(store, { ...job, state: 'done' });
      } catch (error) {
        if (store.get<Job>('moderation.warningJobs', jobKey)?.state !== 'running') continue;
        const attempts = job.attempts + 1;
        reserveJob(store, {
          ...job,
          attempts,
          state: error instanceof UserError ? 'cancelled' : attempts >= 3 ? 'failed' : 'pending',
          retryAt: now + 30000 * 2 ** attempts,
          lastError: error instanceof Error ? error.name : 'Error',
        });
      }
    }
    for (const { key: rowKey, value } of store.list<Job>('moderation.warningJobs'))
      if (
        allowed(value.guildId) &&
        !['pending', 'running'].includes(value.state) &&
        now - value.createdAt > 7 * DAY
      )
        store.delete('moderation.warningJobs', rowKey);
    for (const { key: rowKey, value } of store.list<Warning>('moderation.warnings'))
      if (allowed(value.guildId) && now - value.createdAt > 31 * DAY)
        store.delete('moderation.warnings', rowKey);
  } finally {
    running.delete(store);
  }
}
