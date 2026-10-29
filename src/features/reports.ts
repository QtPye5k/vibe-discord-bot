import { createHash, randomBytes } from 'node:crypto';
import { PermissionFlagsBits as P, type Client } from 'discord.js';
import { z } from 'zod';
import type { ActionContext } from '../core/types.js';
import type { ActionRegistry, ActionPolicy } from '../core/registry.js';
import type { Store } from '../core/store.js';
import { freshContext, resolveChannel } from '../core/permissions.js';
import { UserError } from '../core/errors.js';
import { securitySettings } from './security.js';

const DAY = 86_400_000;
const namespace = 'reports.schedules';
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const snowflake = z.string().regex(/^\d{17,20}$/);
const cadence = z.enum(['daily', 'weekly', 'monthly']);
const sections = z
  .array(z.enum(['activity', 'commands', 'moderation', 'support', 'giveaways', 'resources']))
  .min(1)
  .max(6)
  .refine((values) => new Set(values).size === values.length, 'Choose distinct report sections.');
const reportOptions = z.strictObject({
  cadence,
  hourUtc: z.number().int().min(0).max(23).default(9),
  minuteUtc: z.number().int().min(0).max(59).default(0),
  sections,
});
type ReportOptions = z.infer<typeof reportOptions>;
interface Delivery {
  dueAt: number;
  retryAt: number;
  attempts: number;
  nonce: string;
  body: string;
}
interface Schedule extends ReportOptions {
  id: string;
  guildId: string;
  authorId: string;
  originChannelId: string;
  channelId: string;
  version: string;
  nextAt: number;
  retryAt?: number;
  failures?: number;
  enabled: boolean;
  pending?: Delivery;
  lastSentAt?: number;
  lastError?: string;
}
export interface ReportWindow {
  start: number;
  end: number;
}
const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/** Previous complete UTC day, Monday–Sunday week, or calendar month. End is exclusive. */
export function reportWindow(period: z.infer<typeof cadence>, at: number): ReportWindow {
  const now = new Date(at);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (period === 'daily') return { start: today - DAY, end: today };
  if (period === 'weekly') {
    const end = today - ((now.getUTCDay() + 6) % 7) * DAY;
    return { start: end - 7 * DAY, end };
  }
  return {
    start: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    end: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  };
}

/** Daily, Monday weekly, or first-of-month UTC delivery, strictly after the supplied instant. */
export function nextReportAt(
  options: Pick<ReportOptions, 'cadence' | 'hourUtc' | 'minuteUtc'>,
  after: number,
): number {
  const now = new Date(after);
  let next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    options.hourUtc,
    options.minuteUtc,
  );
  if (options.cadence === 'daily') return next > after ? next : next + DAY;
  if (options.cadence === 'weekly') {
    next += ((8 - now.getUTCDay()) % 7) * DAY;
    return next > after ? next : next + 7 * DAY;
  }
  next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, options.hourUtc, options.minuteUtc);
  return next > after
    ? next
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, options.hourUtc, options.minuteUtc);
}
function tableExists(store: Store, table: string): boolean {
  return !!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

/** Aggregate only: never includes messages, ticket subjects, member names, reasons, or submitted answers. */
export function buildReport(
  store: Store,
  guildId: string,
  raw: z.input<typeof reportOptions>,
  at = Date.now(),
) {
  const input = reportOptions.parse(raw);
  const window = reportWindow(input.cadence, at);
  const data: Record<string, unknown> = {};
  const limitations = [
    'Only currently retained bot-observed records are included. Downtime, disabled collection, missing intents and retention gaps are not reconstructed.',
    'Activity reports contain aggregate counts, never message content or member identifiers. Resource values are a current process snapshot.',
  ];
  const enabled = securitySettings(store, guildId).analyticsEnabled;
  for (const section of input.sections) {
    if (section === 'activity') {
      data.activity =
        enabled && tableExists(store, 'security_metrics')
          ? store.db
              .prepare(
                `SELECT kind,sum(count) AS count FROM security_metrics
          WHERE guild_id=? AND day>=? AND day<? AND kind NOT LIKE 'command:%' AND kind NOT LIKE 'duration:%'
          GROUP BY kind ORDER BY kind LIMIT 50`,
              )
              .all(guildId, isoDay(window.start), isoDay(window.end))
          : { available: false, reason: 'Observed analytics is not enabled or has no initialized data.' };
    } else if (section === 'commands') {
      data.commands = store.db
        .prepare(
          `SELECT action,status,count(*) AS count FROM audit
        WHERE guild_id=? AND created_at>=? AND created_at<? AND status IN ('success','failure','denied')
        GROUP BY action,status ORDER BY count DESC,action LIMIT 30`,
        )
        .all(guildId, window.start, window.end);
    } else if (section === 'moderation') {
      data.moderation = {
        warningsCreated: store
          .list<{ createdAt: number }>('community.cases', `${guildId}:`)
          .filter((row) => row.value.createdAt >= window.start && row.value.createdAt < window.end).length,
        observedFindingsCreated: tableExists(store, 'security_findings')
          ? Number(
              store.db
                .prepare('SELECT count(*) AS n FROM security_findings WHERE guild_id=? AND at>=? AND at<?')
                .get(guildId, window.start, window.end)?.n ?? 0,
            )
          : 0,
      };
    } else if (section === 'support') {
      const tickets = store
        .list<{ createdAt: number; closedAt?: number; status: string }>('community.tickets', `${guildId}:`)
        .map((row) => row.value);
      const closed = tickets.filter(
        (ticket) =>
          ticket.closedAt !== undefined && ticket.closedAt >= window.start && ticket.closedAt < window.end,
      );
      data.support = {
        ticketsCreated: tickets.filter(
          (ticket) => ticket.createdAt >= window.start && ticket.createdAt < window.end,
        ).length,
        ticketsClosed: closed.length,
        averageResolutionSeconds: closed.length
          ? Math.round(
              closed.reduce(
                (sum, ticket) => sum + Math.max(0, ticket.closedAt! - ticket.createdAt) / 1000,
                0,
              ) / closed.length,
            )
          : null,
        currentlyOpen: tickets.filter((ticket) => ticket.status === 'open').length,
      };
    } else if (section === 'giveaways') {
      const due = store
        .list<{ endsAt: number; status: string; entrants: string[] }>('community.giveaways', `${guildId}:`)
        .map((row) => row.value)
        .filter((giveaway) => giveaway.endsAt >= window.start && giveaway.endsAt < window.end);
      data.giveaways = {
        dueInPeriod: due.length,
        currentlyDrawn: due.filter((giveaway) => giveaway.status === 'drawn').length,
        recordedEntriesForThoseGiveaways: due.reduce((sum, giveaway) => sum + giveaway.entrants.length, 0),
      };
    } else
      data.resources = {
        cpuMicroseconds: process.cpuUsage(),
        memoryBytes: process.memoryUsage(),
        uptimeSeconds: process.uptime(),
      };
  }
  return {
    cadence: input.cadence,
    period: { start: new Date(window.start).toISOString(), endExclusive: new Date(window.end).toISOString() },
    generatedAt: new Date(at).toISOString(),
    sections: data,
    limitations,
  };
}

function paused(store: Store, guildId: string): boolean {
  return (store.get<string[]>('core.disabled', guildId) ?? []).includes('analytics');
}
function permittedPolicy(ctx: ActionContext, schedule: Schedule): void {
  if (!ctx.member.permissions.has(P.ManageGuild))
    throw new UserError('Report author no longer has Manage Server.');
  const policy = ctx.store.get<ActionPolicy>(
    'core.actionPolicies',
    `${schedule.guildId}:report.schedule.set`,
  );
  if (
    policy &&
    (!policy.enabled ||
      (policy.channelIds.length && !policy.channelIds.includes(schedule.originChannelId)) ||
      (policy.roleIds.length && !policy.roleIds.some((role) => ctx.member.roles.cache.has(role))))
  )
    throw new UserError('Scheduled report policy authorization was revoked.');
}
async function destination(ctx: ActionContext, channelId: string) {
  const everyone = await ctx.guild.roles.fetch(ctx.guild.id, { force: true });
  const channel = await resolveChannel(ctx, channelId);
  const bot = ctx.guild.members.me;
  if (
    !bot ||
    !channel.isSendable() ||
    !channel.permissionsFor(ctx.member)?.has([P.SendMessages, P.AttachFiles]) ||
    !channel.permissionsFor(bot)?.has([P.SendMessages, P.AttachFiles])
  )
    throw new UserError('You and the bot need sending and attachment access in the report channel.');
  if (!everyone || channel.permissionsFor(everyone)?.has(P.ViewChannel))
    throw new UserError('Administrator reports require a channel hidden from the everyone role.');
  return channel;
}
const key = (guildId: string, reportId: string) => `${guildId}:${reportId}`;
function unchanged(store: Store, schedule: Schedule): boolean {
  const latest = store.get<Schedule>(namespace, key(schedule.guildId, schedule.id));
  return latest?.enabled === true && latest.version === schedule.version && !paused(store, schedule.guildId);
}
function view(schedule: Schedule) {
  return {
    ...schedule,
    pending: schedule.pending
      ? {
          dueAt: new Date(schedule.pending.dueAt).toISOString(),
          retryAt: new Date(schedule.pending.retryAt).toISOString(),
          attempts: schedule.pending.attempts,
        }
      : null,
  };
}
export function registerReportActions(registry: ActionRegistry): void {
  const base = { category: 'analytics', userPermissions: [P.ManageGuild], botPermissions: [] as bigint[] };
  registry.register({
    ...base,
    id: 'report.preview',
    risk: 'read',
    description:
      'Preview aggregate administration statistics for the previous complete UTC day, week or month.',
    schema: reportOptions,
    execute: (ctx, input) => buildReport(ctx.store, ctx.guild.id, input),
  });
  registry.register({
    ...base,
    id: 'report.schedule.set',
    risk: 'write',
    description:
      'Schedule a bounded aggregate report into a private staff channel daily, Monday weekly, or first-of-month UTC.',
    schema: z.strictObject({ id, channelId: snowflake, ...reportOptions.shape }),
    execute: async (ctx, input) => {
      await destination(ctx, input.channelId);
      if (
        !ctx.store.get(namespace, key(ctx.guild.id, input.id)) &&
        ctx.store.list(namespace, `${ctx.guild.id}:`).length >= 10
      )
        throw new UserError('Limit: ten report schedules per server.');
      const schedule: Schedule = {
        ...input,
        guildId: ctx.guild.id,
        authorId: ctx.member.id,
        originChannelId: ctx.channelId,
        version: randomBytes(8).toString('hex'),
        nextAt: nextReportAt(input, Date.now()),
        enabled: true,
      };
      ctx.store.set(namespace, key(ctx.guild.id, input.id), schedule);
      return view(schedule);
    },
  });
  registry.register({
    ...base,
    id: 'report.schedule.list',
    risk: 'read',
    description: 'Inspect aggregate report schedules, bounded retry state and delivery errors.',
    schema: z.strictObject({}),
    execute: (ctx) => ctx.store.list<Schedule>(namespace, `${ctx.guild.id}:`).map((row) => view(row.value)),
  });
  registry.register({
    ...base,
    id: 'report.schedule.remove',
    risk: 'write',
    description: 'Cancel an aggregate report schedule and discard pending retries.',
    schema: z.strictObject({ id }),
    execute: (ctx, input) => ({ removed: ctx.store.delete(namespace, key(ctx.guild.id, input.id)) }),
  });
}

const sweeping = new WeakSet<Store>();
export async function sweepReportTasks(
  client: Client,
  store: Store,
  now = Date.now(),
  allowedGuildIds: readonly string[] = [],
): Promise<void> {
  if (sweeping.has(store)) return;
  sweeping.add(store);
  const stopAt = Date.now() + 20_000;
  try {
    const due = store
      .list<Schedule>(namespace)
      .filter(
        ({ value }) =>
          value.enabled &&
          !paused(store, value.guildId) &&
          (!allowedGuildIds.length || allowedGuildIds.includes(value.guildId)) &&
          (value.pending?.retryAt ?? value.retryAt ?? value.nextAt) <= now,
      )
      .sort((a, b) => a.value.nextAt - b.value.nextAt)
      .slice(0, 10);
    for (const { value: schedule } of due) {
      if (Date.now() >= stopAt) break;
      const scheduleKey = key(schedule.guildId, schedule.id);
      try {
        const guild = await client.guilds.fetch(schedule.guildId);
        const ctx = await freshContext({
          client,
          store,
          guild,
          member: { id: schedule.authorId } as ActionContext['member'],
          channelId: schedule.originChannelId,
        });
        if (!ctx.member.permissions.has(P.ManageGuild))
          throw new UserError('Report author no longer has Manage Server.');
        if (ctx.member.guild.id !== guild.id)
          throw new UserError('Report author no longer belongs to this server.');
        await resolveChannel(ctx, schedule.originChannelId);
        const channel = await destination(ctx, schedule.channelId);
        permittedPolicy(ctx, schedule);
        if (!unchanged(store, schedule)) continue;
        let pending = schedule.pending;
        if (!pending) {
          const body = JSON.stringify(
            buildReport(
              store,
              guild.id,
              {
                cadence: schedule.cadence,
                hourUtc: schedule.hourUtc,
                minuteUtc: schedule.minuteUtc,
                sections: schedule.sections,
              },
              schedule.nextAt,
            ),
            null,
            2,
          );
          if (Buffer.byteLength(body) > 128 * 1024)
            throw new UserError('Aggregate report exceeds the output bound.');
          pending = {
            dueAt: schedule.nextAt,
            retryAt: now,
            attempts: schedule.failures ?? 0,
            body,
            nonce: createHash('sha256')
              .update(`${scheduleKey}:${schedule.version}:${schedule.nextAt}`)
              .digest('hex')
              .slice(0, 24),
          };
          schedule.pending = pending;
          store.set(namespace, scheduleKey, schedule);
        }
        if (!unchanged(store, schedule)) continue;
        await channel.send({
          content: `${schedule.cadence[0]!.toUpperCase()}${schedule.cadence.slice(1)} administrator report — previous complete UTC period. Counts reflect retained observations, not a complete server history.`,
          files: [
            {
              attachment: Buffer.from(pending.body),
              name: `${schedule.cadence}-report-${isoDay(pending.dueAt)}.json`,
            },
          ],
          allowedMentions: { parse: [] },
          nonce: pending.nonce,
          enforceNonce: true,
        });
        const deliveredPolicy = store.get<Schedule>(namespace, scheduleKey);
        if (!deliveredPolicy || deliveredPolicy.version !== schedule.version) continue;
        schedule.enabled = deliveredPolicy.enabled;
        delete schedule.pending;
        delete schedule.lastError;
        delete schedule.retryAt;
        delete schedule.failures;
        schedule.lastSentAt = now;
        schedule.nextAt = nextReportAt(schedule, now);
        store.set(namespace, scheduleKey, schedule);
      } catch (error) {
        if (!unchanged(store, schedule)) continue;
        schedule.lastError = error instanceof Error ? error.name : 'Error';
        const code = error && typeof error === 'object' && 'code' in error ? Number(error.code) : 0;
        if (error instanceof UserError || [10003, 10004, 10007, 50001, 50013].includes(code))
          schedule.enabled = false;
        else {
          const failures = (schedule.failures ?? 0) + 1;
          const retryAt = now + Math.min(600_000, 30_000 * 2 ** (failures - 1));
          schedule.failures = failures;
          if (schedule.pending) Object.assign(schedule.pending, { attempts: failures, retryAt });
          else schedule.retryAt = retryAt;
          if (failures >= 3) schedule.enabled = false;
        }
        store.set(namespace, scheduleKey, schedule);
      }
    }
  } finally {
    sweeping.delete(store);
  }
}
