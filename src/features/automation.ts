import { createHash, randomBytes } from 'node:crypto';
import {
  ChannelType,
  PermissionFlagsBits as P,
  type Client,
  type VoiceState,
  type GuildMember,
} from 'discord.js';
import { z } from 'zod';
import { registerEventRoleActions, sweepEventRoles, observeEventRoleChange } from './event-roles.js';
import { observeMessageTracking } from './message-automation.js';
import type { ActionContext } from '../core/types.js';
import type { ActionRegistry } from '../core/registry.js';
import type { Store } from '../core/store.js';
import { UserError } from '../core/errors.js';
import { resolveChannel, resolveRole, assertRoleHierarchy } from '../core/permissions.js';
import { csv } from '../core/files.js';
import { assertOrdinaryRole } from '../core/safe-role.js';

const snowflake = z.string().regex(/^\d{17,20}$/);
const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const empty = z.strictObject({});
const noMentions = { parse: [] as never[] };
const DAY = 86_400_000;
const key = (guildId: string, id: string) => `${guildId}:${id}`;
const nonce = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const token = () => randomBytes(6).toString('hex');
const disabled = (store: Store, guildId: string) =>
  (store.get<string[]>('core.disabled', guildId) ?? []).includes('automation');

interface CronField {
  values: Set<number>;
  wildcard: boolean;
}
/** Standard five-field UTC cron: integers, lists, ranges and steps; DOM/DOW use normal OR semantics. */
export function parseCron(expression: string): CronField[] {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new UserError('Use five UTC cron fields: minute hour day month weekday.');
  return parts.map((field, index) => {
    const [min, max] = (
      [
        [0, 59],
        [0, 23],
        [1, 31],
        [1, 12],
        [0, 7],
      ] as [number, number][]
    )[index]!;
    const values = new Set<number>();
    if (field.length > 100) throw new UserError('Cron field is too long.');
    for (const fragment of field.split(',')) {
      const match = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(fragment);
      if (!match) throw new UserError('Invalid cron field. Use *, numbers, ranges, lists or /steps.');
      const step = match[2] ? Number(match[2]) : 1;
      if (step < 1 || step > max - min + 1) throw new UserError('Invalid cron step.');
      const range = match[1] === '*' ? [min, max] : match[1]!.split('-').map(Number);
      const start = range[0]!,
        end = range[1] ?? (match[2] ? max : start);
      if (start < min || end > max || start > end) throw new UserError('Cron field is outside its range.');
      for (let value = start; value <= end; value += step) values.add(index === 4 && value === 7 ? 0 : value);
    }
    return { values, wildcard: field === '*' };
  });
}
export function cronMatches(expression: string, date: Date): boolean {
  const [minute, hour, day, month, weekday] = parseCron(expression);
  if (
    !minute!.values.has(date.getUTCMinutes()) ||
    !hour!.values.has(date.getUTCHours()) ||
    !month!.values.has(date.getUTCMonth() + 1)
  )
    return false;
  const dom = day!.values.has(date.getUTCDate()),
    dow = weekday!.values.has(date.getUTCDay());
  return day!.wildcard ? dow : weekday!.wildcard ? dom : dom || dow;
}
export function nextCron(expression: string, after: number): number {
  const fields = parseCron(expression);
  let time = Math.floor(after / 60000) * 60000 + 60000;
  for (let i = 0; i < 527040; i++, time += 60000) {
    const date = new Date(time);
    const [m, h, d, mo, w] = fields;
    if (
      !m!.values.has(date.getUTCMinutes()) ||
      !h!.values.has(date.getUTCHours()) ||
      !mo!.values.has(date.getUTCMonth() + 1)
    )
      continue;
    const dom = d!.values.has(date.getUTCDate()),
      dow = w!.values.has(date.getUTCDay());
    if (d!.wildcard ? dow : w!.wildcard ? dom : dom || dow) return time;
  }
  throw new UserError('Cron expression has no occurrence in the next 366 days.');
}
const cron = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      parseCron(value);
      return true;
    } catch {
      return false;
    }
  }, 'Invalid five-field UTC cron expression');
const stepSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('message'), channelId: snowflake, content: z.string().min(1).max(1700) }),
  z.strictObject({ kind: z.literal('thread'), name: z.string().min(1).max(80) }),
  z.strictObject({ kind: z.literal('role'), roleId: snowflake }),
]);
type Step = z.infer<typeof stepSchema>;
const triggerSchema = z.enum([
  'guildMemberAdd',
  'guildMemberRemove',
  'messageCreate',
  'messageUpdate',
  'messageDelete',
  'messageReactionAdd',
  'messageReactionRemove',
  'guildMemberUpdate',
  'channelCreate',
  'channelUpdate',
  'channelDelete',
  'threadCreate',
  'threadUpdate',
  'guildScheduledEventCreate',
  'guildScheduledEventUpdate',
  'guildScheduledEventDelete',
  'voiceStateUpdate',
  'messagePollVoteAdd',
  'messagePollVoteRemove',
  'entitlementCreate',
  'entitlementUpdate',
  'entitlementDelete',
  'subscriptionCreate',
  'subscriptionUpdate',
  'subscriptionDelete',
  'discordWebhookEvent',
  'presenceUpdate',
]);
interface Workflow {
  id: string;
  guildId: string;
  authorId: string;
  channelId: string;
  trigger: z.infer<typeof triggerSchema>;
  sourceChannelId?: string;
  keyword?: string;
  eventType?: string;
  steps: Step[];
  version: string;
  enabled: boolean;
}
interface EventData {
  id: string;
  userId?: string;
  channelId?: string;
  messageId?: string;
  content?: string;
  eventType?: string;
}
interface WorkflowJob {
  id: string;
  guildId: string;
  workflowId: string;
  version: string;
  event: EventData;
  step: number;
  attempts: number;
  nextAt: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  updatedAt: number;
  lastError?: string;
}
interface Schedule {
  id: string;
  guildId: string;
  authorId: string;
  channelId: string;
  content: string;
  cron: string;
  nextAt: number;
  nonce: string;
  enabled: boolean;
  attempts: number;
  retryAt: number;
  lastError?: string;
  once?: boolean;
  tournament?: { id: string; round: number; match: number; startsAt: number };
}
interface TemporaryChannel {
  guildId: string;
  channelId: string;
  ownerId: string;
  expiresAt: number;
  deleteWhenEmpty: boolean;
  attempts: number;
  nextAt: number;
}
interface VoiceHub {
  guildId: string;
  authorId: string;
  channelId: string;
  categoryId: string;
  private: boolean;
  maxMinutes: number;
  userLimit: number;
}
interface CalendarEvent {
  id: string;
  guildId: string;
  authorId: string;
  channelId: string;
  title: string;
  startsAt: number;
  endsAt: number;
  capacity: number;
  voiceChannelId?: string;
  rsvps: Record<string, { status: 'yes' | 'maybe' | 'waitlist'; at: number }>;
  attended: string[];
  reminderAt?: number;
  reminderSent: boolean;
  summarySent: boolean;
  cancelled: boolean;
  reminderAttempts?: number;
  summaryAttempts?: number;
  reminderRetryAt?: number;
  summaryRetryAt?: number;
  lastError?: string;
}
interface Tournament {
  id: string;
  title: string;
  channelId: string;
  players: string[];
  round: number;
  matches: { a: string; b: string | null; winner?: string; startsAt?: string }[];
  history: { round: number; matches: { a: string; b: string | null; winner?: string }[] }[];
  champion?: string;
}
interface Celebration {
  guildId: string;
  userId: string;
  kind: 'birthday' | 'anniversary';
  month: number;
  day: number;
  lastDate?: string;
  attemptDate?: string;
  attempts?: number;
  retryAt?: number;
  lastError?: string;
}
async function actorContext(
  client: Client,
  store: Store,
  guildId: string,
  authorId: string,
  channelId: string,
): Promise<ActionContext> {
  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch({ user: authorId, force: true });
  await guild.members.fetchMe({ force: true });
  if (!member.permissions.has(P.ManageGuild))
    throw new UserError('Automation author no longer has Manage Server.');
  return { client, store, guild, member, channelId };
}
async function sendable(ctx: ActionContext, id: string) {
  const channel = await resolveChannel(ctx, id);
  const permission = channel.isThread() ? P.SendMessagesInThreads : P.SendMessages;
  if (
    !channel.isSendable() ||
    !channel.permissionsFor(ctx.member)?.has(permission) ||
    !channel.permissionsFor(ctx.guild.members.me!)?.has(permission)
  )
    throw new UserError('Automation message permissions are unavailable.');
  return channel;
}
async function safeRole(ctx: ActionContext, id: string) {
  const role = await resolveRole(ctx, id);
  assertRoleHierarchy(ctx, role);
  assertOrdinaryRole(role, ctx.guild.members.me!);
  if (!ctx.member.permissions.has(P.ManageRoles) || !ctx.guild.members.me?.permissions.has(P.ManageRoles))
    throw new UserError('Automation roles must be ordinary roles and require Manage Roles.');
  return role;
}
async function validateSteps(ctx: ActionContext, steps: Step[], sourceChannelId?: string) {
  if (sourceChannelId) await resolveChannel(ctx, sourceChannelId);
  for (const step of steps)
    if (step.kind === 'message') await sendable(ctx, step.channelId);
    else if (step.kind === 'role') await safeRole(ctx, step.roleId);
    else {
      if (!sourceChannelId) throw new UserError('Thread steps require a sourceChannelId.');
      const channel = await resolveChannel(ctx, sourceChannelId);
      if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
        throw new UserError('Thread workflows require a text/announcement source channel.');
      for (const member of [ctx.member, ctx.guild.members.me!])
        if (!channel.permissionsFor(member)?.has([P.ReadMessageHistory, P.CreatePublicThreads]))
          throw new UserError('Thread automation requires Read History and Create Public Threads.');
    }
}
function template(text: string, event: EventData, guildId: string) {
  return text
    .replaceAll('{user}', event.userId ? `<@${event.userId}>` : 'unknown')
    .replaceAll('{userId}', event.userId ?? 'unknown')
    .replaceAll('{channel}', event.channelId ? `<#${event.channelId}>` : 'unknown')
    .replaceAll('{guildId}', guildId)
    .replaceAll('{event}', event.eventType ?? 'event');
}
export function extractAutomationEvent(
  event: string,
  args: unknown[],
): { guildId: string; data: EventData } | undefined {
  if (event === 'messageReactionAdd' || event === 'messageReactionRemove') {
    const reaction = args[0] as
      | {
          message?: { id: string; guildId?: string; channelId?: string };
          emoji?: { id?: string; name?: string };
        }
      | undefined;
    const user = args[1] as { id?: string; bot?: boolean } | undefined;
    if (!reaction?.message?.guildId || !user?.id || user.bot) return;
    return {
      guildId: reaction.message.guildId,
      data: {
        id: nonce(`${event}:${reaction.message.id}:${reaction.emoji?.id ?? reaction.emoji?.name}:${user.id}`),
        userId: user.id,
        channelId: reaction.message.channelId,
        messageId: reaction.message.id,
        eventType: event,
      },
    };
  }
  if (event === 'messagePollVoteAdd' || event === 'messagePollVoteRemove') {
    const answer = args[0] as
      { id?: number; poll?: { message?: { id: string; guildId?: string; channelId?: string } } } | undefined;
    const userId = args[1];
    const message = answer?.poll?.message;
    if (!message?.guildId || typeof userId !== 'string') return;
    return {
      guildId: message.guildId,
      data: {
        id: nonce(`${event}:${message.id}:${answer?.id}:${userId}`),
        userId,
        channelId: message.channelId,
        messageId: message.id,
        eventType: event,
      },
    };
  }
  const raw = args[args.length - 1] as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return;
  if (event === 'discordWebhookEvent') {
    const body = raw as {
      application_id?: string;
      guildId?: string;
      event?: {
        type?: string;
        timestamp?: string;
        data?: { guild?: { id?: string }; guild_id?: string; user?: { id?: string }; user_id?: string };
      };
    };
    const guildId = body.guildId ?? body.event?.data?.guild?.id ?? body.event?.data?.guild_id;
    if (!guildId) return;
    return {
      guildId,
      data: {
        id: nonce(JSON.stringify(body)),
        eventType: body.event?.type,
        userId: body.event?.data?.user?.id ?? body.event?.data?.user_id,
      },
    };
  }
  const value = raw as {
    id?: string;
    guildId?: string;
    guild?: { id: string };
    channelId?: string;
    channel?: { id?: string; guildId?: string };
    message?: { id?: string; guildId?: string; channelId?: string };
    user?: { id?: string; bot?: boolean };
    author?: { id?: string; bot?: boolean };
    content?: string;
    editedTimestamp?: number;
    joinedTimestamp?: number;
    createdTimestamp?: number;
    roles?: { cache?: Map<string, unknown> };
    member?: { id?: string; user?: { bot?: boolean } };
    userId?: string;
    timestamp?: number;
    status?: string;
    activities?: { name: string; type: number }[];
  };
  const guildId = value.guildId ?? value.guild?.id ?? value.message?.guildId ?? value.channel?.guildId;
  if (!guildId) return;
  if (event === 'messageCreate' && (value.author?.bot || !value.content)) return;
  const userId =
    value.author?.id ??
    value.user?.id ??
    value.member?.id ??
    value.userId ??
    (event.startsWith('guildMember') ? value.id : undefined);
  const channelId = value.channelId ?? value.message?.channelId ?? value.channel?.id;
  const version =
    event === 'messageUpdate'
      ? value.editedTimestamp
      : event === 'guildMemberAdd'
        ? value.joinedTimestamp
        : event === 'guildMemberUpdate'
          ? [...(value.roles?.cache?.keys() ?? [])].sort().join(',')
          : event === 'voiceStateUpdate'
            ? `${channelId ?? 'left'}:${Math.floor(Date.now() / 5000)}`
            : event === 'presenceUpdate'
              ? `${value.status}:${JSON.stringify(value.activities?.map((activity) => ({ name: activity.name, type: activity.type })))}:${Math.floor(Date.now() / 5000)}`
              : (value.timestamp ?? value.createdTimestamp ?? '');
  return {
    guildId,
    data: {
      id: nonce(`${event}:${value.id ?? value.message?.id ?? userId ?? ''}:${version}`),
      userId,
      channelId,
      messageId: event.startsWith('message') ? (value.message?.id ?? value.id) : undefined,
      content: (event === 'presenceUpdate' ? value.status : value.content)?.slice(0, 2000),
      eventType: event,
    },
  };
}
export async function onAutomationEvent(
  event: string,
  args: unknown[],
  client: Client,
  store: Store,
): Promise<void> {
  if (event === 'guildMemberUpdate' && args[0] && args[1])
    observeEventRoleChange(args[0] as GuildMember, args[1] as GuildMember, store);
  observeMessageTracking(event, args, store);
  if (event === 'voiceStateUpdate') await handleVoiceHub(args, client, store);
  const parsed = extractAutomationEvent(event, args);
  if (!parsed || disabled(store, parsed.guildId)) return;
  for (const { value: workflow } of store.list<Workflow>('automation.workflows', `${parsed.guildId}:`)) {
    if (
      !workflow.enabled ||
      workflow.trigger !== event ||
      (workflow.sourceChannelId && workflow.sourceChannelId !== parsed.data.channelId) ||
      (workflow.keyword && !parsed.data.content?.toLowerCase().includes(workflow.keyword.toLowerCase())) ||
      (workflow.eventType && workflow.eventType !== parsed.data.eventType)
    )
      continue;
    const id = key(parsed.guildId, `${workflow.id}:${parsed.data.id}`);
    if (store.get('automation.outbox', id)) continue;
    const count = store
      .list<WorkflowJob>('automation.outbox', `${parsed.guildId}:`)
      .filter((row) => row.value.status === 'pending' || row.value.status === 'running').length;
    if (count >= 200) break;
    const data = { ...parsed.data };
    delete data.content;
    store.set('automation.outbox', id, {
      id,
      guildId: parsed.guildId,
      workflowId: workflow.id,
      version: workflow.version,
      event: data,
      step: 0,
      attempts: 0,
      nextAt: Date.now(),
      status: 'pending',
      updatedAt: Date.now(),
    } satisfies WorkflowJob);
  }
}
async function executeStep(
  ctx: ActionContext,
  step: Step,
  event: EventData,
  deliveryId: string,
  assertActive: () => void,
) {
  if (step.kind === 'message') {
    const channel = await sendable(ctx, step.channelId);
    assertActive();
    await channel.send({
      content: template(step.content, event, ctx.guild.id),
      allowedMentions: noMentions,
      nonce: nonce(deliveryId),
      enforceNonce: true,
    });
    return;
  }
  if (step.kind === 'role') {
    if (!event.userId) throw new UserError('This event has no target member.');
    const role = await safeRole(ctx, step.roleId);
    const member = await ctx.guild.members.fetch({ user: event.userId, force: true });
    if (member.id === ctx.guild.ownerId || member.user.bot)
      throw new UserError('Automatic roles do not target the owner or bots.');
    assertActive();
    await member.roles.add(role, 'Confirmed automation policy');
    return;
  }
  if (!event.channelId || !event.messageId) throw new UserError('Thread steps require a message event.');
  await validateSteps(ctx, [step], event.channelId);
  const channel = await resolveChannel(ctx, event.channelId);
  if (!channel.isTextBased()) throw new UserError('No messages in source channel.');
  const message = await channel.messages.fetch(event.messageId);
  assertActive();
  if (!message.hasThread)
    await message.startThread({
      name: template(step.name, event, ctx.guild.id),
      reason: 'Confirmed automatic discussion threading',
    });
}
const sweeping = new WeakSet<Store>();
export async function sweepAutomationTasks(
  client: Client,
  store: Store,
  now = Date.now(),
  allowedGuildIds: readonly string[] = [],
): Promise<void> {
  await sweepEventRoles(client, store, now, allowedGuildIds);
  if (sweeping.has(store)) return;
  sweeping.add(store);
  const allowed = (id: string) => !allowedGuildIds.length || allowedGuildIds.includes(id);
  const deadline = Date.now() + 20000;
  try {
    let processed = 0;
    for (const { key: jobKey, value: job } of store.list<WorkflowJob>('automation.outbox')) {
      if (processed >= 20 || Date.now() >= deadline) break;
      if (!allowed(job.guildId) || disabled(store, job.guildId)) continue;
      if (job.status === 'running' && now - job.updatedAt > 300_000) job.status = 'pending';
      if (job.status !== 'pending' || job.nextAt > now) continue;
      processed++;
      const workflow = store.get<Workflow>('automation.workflows', key(job.guildId, job.workflowId));
      if (!workflow?.enabled || workflow.version !== job.version) {
        job.status = 'failed';
        job.lastError = 'PolicyChanged';
        store.set('automation.outbox', jobKey, job);
        continue;
      }
      job.status = 'running';
      job.updatedAt = now;
      store.set('automation.outbox', jobKey, job);
      try {
        const ctx = await actorContext(client, store, job.guildId, workflow.authorId, workflow.channelId);
        if (workflow.sourceChannelId) await resolveChannel(ctx, workflow.sourceChannelId);
        for (; job.step < workflow.steps.length; job.step++) {
          const assertActive = () => {
            if (
              disabled(store, job.guildId) ||
              store.get<Workflow>('automation.workflows', key(job.guildId, job.workflowId))?.version !==
                job.version
            )
              throw new UserError('Automation policy changed.');
          };
          assertActive();
          await executeStep(ctx, workflow.steps[job.step]!, job.event, `${job.id}:${job.step}`, assertActive);
          job.updatedAt = Date.now();
          store.set('automation.outbox', jobKey, { ...job, step: job.step + 1 });
        }
        job.status = 'done';
        job.updatedAt = now;
        store.set('automation.outbox', jobKey, job);
      } catch (error) {
        job.attempts++;
        job.status = error instanceof UserError || job.attempts >= 3 ? 'failed' : 'pending';
        job.nextAt = now + 30_000 * 2 ** job.attempts;
        job.lastError = error instanceof Error ? error.name : 'Error';
        job.updatedAt = now;
        store.set('automation.outbox', jobKey, job);
      }
    }
    for (const { key: rowKey, value: schedule } of store.list<Schedule>('automation.schedules')) {
      if (processed >= 40 || Date.now() >= deadline) break;
      if (
        !allowed(schedule.guildId) ||
        disabled(store, schedule.guildId) ||
        !schedule.enabled ||
        schedule.nextAt > now ||
        schedule.retryAt > now
      )
        continue;
      processed++;
      try {
        const ctx = await actorContext(
          client,
          store,
          schedule.guildId,
          schedule.authorId,
          schedule.channelId,
        );
        const channel = await sendable(ctx, schedule.channelId);
        if (schedule.tournament) {
          const current = store.get<Tournament>(
            'automation.tournaments',
            key(schedule.guildId, schedule.tournament.id),
          );
          const match = current?.matches[schedule.tournament.match - 1];
          if (
            !current ||
            current.round !== schedule.tournament.round ||
            !match ||
            match.winner ||
            current.champion ||
            now > schedule.tournament.startsAt + 3600000
          ) {
            schedule.enabled = false;
            store.set('automation.schedules', rowKey, schedule);
            continue;
          }
          const rule = store.get<{ enabled: boolean; roleIds: string[]; channelIds: string[] }>(
            'core.actionPolicies',
            key(schedule.guildId, 'tournament.schedule'),
          );
          if (
            rule &&
            (!rule.enabled ||
              (rule.roleIds.length && !rule.roleIds.some((id) => ctx.member.roles.cache.has(id))) ||
              (rule.channelIds.length && !rule.channelIds.includes(schedule.channelId)))
          )
            throw new UserError('Tournament scheduling policy changed.');
        }
        if (
          disabled(store, schedule.guildId) ||
          store.get<Schedule>('automation.schedules', rowKey)?.nonce !== schedule.nonce
        )
          continue;
        const occurrenceNonce = schedule.nonce;
        await channel.send({
          content: schedule.content,
          allowedMentions: noMentions,
          nonce: schedule.nonce,
          enforceNonce: true,
        });
        if (store.get<Schedule>('automation.schedules', rowKey)?.nonce !== occurrenceNonce) continue;
        if (schedule.once) schedule.enabled = false;
        else schedule.nextAt = nextCron(schedule.cron, now);
        schedule.nonce = token();
        schedule.attempts = 0;
        schedule.retryAt = 0;
        delete schedule.lastError;
      } catch (error) {
        if (store.get<Schedule>('automation.schedules', rowKey)?.nonce !== schedule.nonce) continue;
        schedule.attempts++;
        schedule.retryAt = now + 30_000 * 2 ** schedule.attempts;
        schedule.lastError = error instanceof Error ? error.name : 'Error';
        if (error instanceof UserError || schedule.attempts >= 3) schedule.enabled = false;
      }
      store.set('automation.schedules', rowKey, schedule);
    }
    // Existing time-limited resources still expire after new automation is disabled.
    for (const { key: rowKey, value: resource } of store.list<TemporaryChannel>('automation.channels')) {
      if (processed >= 60 || Date.now() >= deadline) break;
      if (
        !allowed(resource.guildId) ||
        resource.nextAt > now ||
        (resource.expiresAt > now && !resource.deleteWhenEmpty)
      )
        continue;
      processed++;
      try {
        const guild = await client.guilds.fetch(resource.guildId);
        const channel = await guild.channels.fetch(resource.channelId, { force: true });
        if (!channel) {
          store.delete('automation.channels', rowKey);
          continue;
        }
        if (
          resource.expiresAt > now &&
          (!resource.deleteWhenEmpty || !channel.isVoiceBased() || channel.members.size > 0)
        ) {
          resource.nextAt = now + 60_000;
          store.set('automation.channels', rowKey, resource);
          continue;
        }
        if (channel.isVoiceBased() && channel.members.size > 0) {
          resource.nextAt = now + 60_000;
          store.set('automation.channels', rowKey, resource);
          continue;
        }
        await channel.delete('Temporary channel lifetime expired');
        store.delete('automation.channels', rowKey);
      } catch (error) {
        resource.attempts++;
        resource.nextAt = now + Math.min(3_600_000, 30_000 * 2 ** Math.min(resource.attempts, 7));
        if (resource.attempts >= 20) resource.nextAt = Number.MAX_SAFE_INTEGER;
        store.set('automation.channels', rowKey, resource);
      }
    }
    if (Date.now() < deadline) await sweepCalendar(client, store, now, allowed, deadline);
    if (Date.now() < deadline) await sweepCelebrations(client, store, now, allowed, deadline);
    for (const row of store.list<WorkflowJob>('automation.outbox'))
      if (
        allowed(row.value.guildId) &&
        ['done', 'failed'].includes(row.value.status) &&
        now - row.value.updatedAt > 7 * DAY
      )
        store.delete('automation.outbox', row.key);
  } finally {
    sweeping.delete(store);
  }
}
const voiceJoining = new WeakMap<Store, Set<string>>();
async function handleVoiceHub(args: unknown[], client: Client, store: Store) {
  const old = args[0] as VoiceState | undefined,
    after = args[1] as VoiceState | undefined;
  if (
    !after?.guild ||
    !after.channelId ||
    after.channelId === old?.channelId ||
    after.member?.user.bot ||
    disabled(store, after.guild.id)
  )
    return;
  const hub = store.get<VoiceHub>('automation.voiceHubs', key(after.guild.id, after.channelId));
  if (!hub) return;
  const id = key(after.guild.id, after.id),
    active = voiceJoining.get(store) ?? new Set<string>();
  voiceJoining.set(store, active);
  if (active.has(id)) return;
  active.add(id);
  try {
    const existing = store
      .list<TemporaryChannel>('automation.channels', `${hub.guildId}:`)
      .find((row) => row.value.ownerId === after.id && row.value.deleteWhenEmpty);
    if (existing) return;
    if (store.list('automation.channels', `${hub.guildId}:`).length >= 50) return;
    const ctx = await actorContext(client, store, hub.guildId, hub.authorId, hub.channelId);
    const source = await resolveChannel(ctx, hub.channelId);
    const category = await resolveChannel(ctx, hub.categoryId);
    if (
      category.type !== ChannelType.GuildCategory ||
      !ctx.member.permissions.has(P.ManageChannels) ||
      !ctx.guild.members.me?.permissions.has([P.ManageChannels, P.MoveMembers])
    )
      throw new UserError('Voice room policy permissions unavailable.');
    const member = await ctx.guild.members.fetch({ user: after.id, force: true });
    if (
      member.voice.channelId !== hub.channelId ||
      !source.permissionsFor(member)?.has([P.ViewChannel, P.Connect])
    )
      return;
    const name =
      `room-${member.displayName}`.replace(/[^\p{L}\p{N}\s_-]/gu, '').slice(0, 90) || 'private-room';
    const room = await ctx.guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: category.id,
      userLimit: hub.userLimit,
      permissionOverwrites: hub.private
        ? [
            { id: ctx.guild.id, deny: [P.ViewChannel] },
            { id: member.id, allow: [P.ViewChannel, P.Connect, P.Speak] },
            {
              id: ctx.guild.members.me.id,
              allow: [P.ViewChannel, P.Connect, P.ManageChannels, P.MoveMembers],
            },
          ]
        : undefined,
      reason: 'Confirmed join-to-create policy',
    });
    store.set('automation.channels', key(hub.guildId, room.id), {
      guildId: hub.guildId,
      channelId: room.id,
      ownerId: member.id,
      expiresAt: Date.now() + hub.maxMinutes * 60000,
      deleteWhenEmpty: true,
      attempts: 0,
      nextAt: Date.now() + 60_000,
    } satisfies TemporaryChannel);
    await member.voice.setChannel(room, 'Created personal voice room');
  } finally {
    active.delete(id);
  }
}
function eventVisible(ctx: ActionContext, event: CalendarEvent) {
  return resolveChannel(ctx, event.channelId);
}
function rsvpCounts(event: CalendarEvent) {
  return {
    yes: Object.values(event.rsvps).filter((row) => row.status === 'yes').length,
    maybe: Object.values(event.rsvps).filter((row) => row.status === 'maybe').length,
    waitlist: Object.values(event.rsvps).filter((row) => row.status === 'waitlist').length,
  };
}
function promoteWaitlist(event: CalendarEvent) {
  const available = event.capacity - rsvpCounts(event).yes;
  for (const [id] of Object.entries(event.rsvps)
    .filter(([, row]) => row.status === 'waitlist')
    .sort((a, b) => a[1].at - b[1].at)
    .slice(0, Math.max(0, available)))
    event.rsvps[id]!.status = 'yes';
}
async function sweepCalendar(
  client: Client,
  store: Store,
  now: number,
  allowed: (id: string) => boolean,
  deadline: number,
) {
  let count = 0;
  for (const { key: rowKey, value: event } of store.list<CalendarEvent>('automation.calendar')) {
    if (count >= 20 || Date.now() >= deadline) break;
    if (!allowed(event.guildId) || disabled(store, event.guildId) || event.cancelled) continue;
    if (
      event.reminderAt !== undefined &&
      !event.reminderSent &&
      event.reminderAt <= now &&
      now < event.endsAt &&
      (event.reminderAttempts ?? 0) < 3 &&
      (event.reminderRetryAt ?? 0) <= now
    ) {
      count++;
      await notifyCalendar(client, store, rowKey, 'reminder', now);
    }
    if (event.voiceChannelId && event.startsAt <= now && now <= event.endsAt) {
      count++;
      try {
        const guild = await client.guilds.fetch(event.guildId);
        const channel = await guild.channels.fetch(event.voiceChannelId);
        if (channel?.isVoiceBased()) {
          const latest = store.get<CalendarEvent>('automation.calendar', rowKey);
          if (latest && !latest.cancelled) {
            latest.attended = [
              ...new Set([
                ...latest.attended,
                ...channel.members.filter((member) => !member.user.bot).keys(),
              ]),
            ].slice(0, 1000);
            store.set('automation.calendar', rowKey, latest);
          }
        }
      } catch {
        /* Metadata collection is best effort. */
      }
    }
    if (
      !event.summarySent &&
      event.endsAt <= now &&
      (event.summaryAttempts ?? 0) < 3 &&
      (event.summaryRetryAt ?? 0) <= now
    ) {
      count++;
      await notifyCalendar(client, store, rowKey, 'summary', now);
    }
  }
}
async function notifyCalendar(
  client: Client,
  store: Store,
  rowKey: string,
  kind: 'reminder' | 'summary',
  now: number,
) {
  const event = store.get<CalendarEvent>('automation.calendar', rowKey);
  if (!event || event.cancelled) return;
  const attempts = kind === 'reminder' ? 'reminderAttempts' : 'summaryAttempts',
    retry = kind === 'reminder' ? 'reminderRetryAt' : 'summaryRetryAt',
    sent = kind === 'reminder' ? 'reminderSent' : 'summarySent';
  event[attempts] = (event[attempts] ?? 0) + 1;
  event[retry] = now + 30_000 * 2 ** event[attempts]!;
  store.set('automation.calendar', rowKey, event);
  try {
    const ctx = await actorContext(client, store, event.guildId, event.authorId, event.channelId);
    const channel = await sendable(ctx, event.channelId);
    const latest = store.get<CalendarEvent>('automation.calendar', rowKey);
    if (!latest || latest.cancelled || disabled(store, event.guildId)) return;
    const content =
      kind === 'reminder'
        ? `Event reminder: ${latest.title}\nStarts <t:${Math.floor(latest.startsAt / 1000)}:F>. RSVP: ${rsvpCounts(latest).yes}/${latest.capacity}; waitlist ${rsvpCounts(latest).waitlist}.`
        : `Event ended: ${latest.title}\nConfirmed RSVPs: ${rsvpCounts(latest).yes}. Observed/checked-in attendance: ${latest.attended.length}.`;
    await channel.send({
      content,
      allowedMentions: noMentions,
      nonce: nonce(`calendar-${kind}:${rowKey}`),
      enforceNonce: true,
    });
    const current = store.get<CalendarEvent>('automation.calendar', rowKey);
    if (current) {
      current[sent] = true;
      store.set('automation.calendar', rowKey, current);
    }
  } catch (error) {
    const current = store.get<CalendarEvent>('automation.calendar', rowKey);
    if (current) {
      current.lastError = error instanceof Error ? error.name : 'Error';
      if (error instanceof UserError) current[attempts] = 3;
      store.set('automation.calendar', rowKey, current);
    }
  }
}
async function sweepCelebrations(
  client: Client,
  store: Store,
  now: number,
  allowed: (id: string) => boolean,
  deadline: number,
) {
  const date = new Date(now),
    today = date.toISOString().slice(0, 10);
  let count = 0;
  for (const { key: rowKey, value: entry } of store.list<Celebration>('automation.celebrations')) {
    if (count >= 20 || Date.now() >= deadline) break;
    if (
      !allowed(entry.guildId) ||
      disabled(store, entry.guildId) ||
      entry.lastDate === today ||
      entry.month !== date.getUTCMonth() + 1 ||
      entry.day !== date.getUTCDate() ||
      (entry.attemptDate === today && ((entry.attempts ?? 0) >= 3 || (entry.retryAt ?? 0) > now))
    )
      continue;
    const destination = store.get<{ channelId: string; authorId: string }>(
      'automation.celebrationConfig',
      entry.guildId,
    );
    if (!destination) continue;
    count++;
    if (entry.attemptDate !== today) {
      entry.attemptDate = today;
      entry.attempts = 0;
    }
    entry.attempts = (entry.attempts ?? 0) + 1;
    entry.retryAt = now + 30_000 * 2 ** entry.attempts;
    store.set('automation.celebrations', rowKey, entry);
    try {
      const ctx = await actorContext(
        client,
        store,
        entry.guildId,
        destination.authorId,
        destination.channelId,
      );
      const channel = await sendable(ctx, destination.channelId);
      await ctx.guild.members.fetch(entry.userId);
      const latest = store.get<Celebration>('automation.celebrations', rowKey);
      if (
        !latest ||
        latest.day !== entry.day ||
        latest.month !== entry.month ||
        disabled(store, entry.guildId)
      )
        continue;
      await channel.send({
        content: `Happy ${entry.kind} to <@${entry.userId}>!`,
        allowedMentions: noMentions,
        nonce: nonce(`celebration:${rowKey}:${today}`),
        enforceNonce: true,
      });
      const current = store.get<Celebration>('automation.celebrations', rowKey);
      if (current && current.month === entry.month && current.day === entry.day) {
        current.lastDate = today;
        store.set('automation.celebrations', rowKey, current);
      }
    } catch (error) {
      const current = store.get<Celebration>('automation.celebrations', rowKey);
      if (current && current.month === entry.month && current.day === entry.day) {
        current.lastError = error instanceof Error ? error.name : 'Error';
        if (error instanceof UserError) current.attempts = 3;
        store.set('automation.celebrations', rowKey, current);
      }
    }
  }
}
export function registerAutomationActions(registry: ActionRegistry): void {
  registerEventRoleActions(registry);
  const admin = {
    category: 'automation',
    userPermissions: [P.ManageGuild],
    botPermissions: [],
    risk: 'write' as const,
  };
  registry.register({
    ...admin,
    id: 'workflow.set',
    description:
      'Create an explicit event-to-message/thread/ordinary-role workflow with durable retries and deduplication.',
    schema: z.strictObject({
      id: slug,
      trigger: triggerSchema,
      sourceChannelId: snowflake.optional(),
      keyword: z.string().min(1).max(100).optional(),
      eventType: z.string().max(100).optional(),
      steps: z.array(stepSchema).min(1).max(5),
      enabled: z.boolean().default(true),
    }),
    execute: async (ctx, input) => {
      const k = key(ctx.guild.id, input.id);
      if (
        !ctx.store.get('automation.workflows', k) &&
        ctx.store.list('automation.workflows', `${ctx.guild.id}:`).length >= 25
      )
        throw new UserError('Limit: 25 workflows per server.');
      if (input.steps.some((step) => step.kind === 'thread') && input.trigger !== 'messageCreate')
        throw new UserError('Thread steps support messageCreate only.');
      if (
        input.steps.some((step) => step.kind === 'role') &&
        ![
          'guildMemberAdd',
          'messageCreate',
          'messageReactionAdd',
          'guildMemberUpdate',
          'voiceStateUpdate',
        ].includes(input.trigger)
      )
        throw new UserError('This trigger does not provide an eligible target member for role assignment.');
      await validateSteps(ctx, input.steps, input.sourceChannelId);
      const workflow: Workflow = {
        ...input,
        guildId: ctx.guild.id,
        authorId: ctx.member.id,
        channelId: ctx.channelId,
        version: token(),
      };
      ctx.store.set('automation.workflows', k, workflow);
      return workflow;
    },
  });
  registry.register({
    ...admin,
    id: 'workflow.remove',
    description: 'Disable a workflow and invalidate queued work from it.',
    schema: z.strictObject({ id: slug }),
    execute: (ctx, input) => ({
      removed: ctx.store.delete('automation.workflows', key(ctx.guild.id, input.id)),
    }),
  });
  registry.register({
    ...admin,
    id: 'workflow.list',
    description: 'List confirmed automation policies and their precise steps.',
    risk: 'read',
    schema: empty,
    execute: (ctx) =>
      ctx.store.list<Workflow>('automation.workflows', `${ctx.guild.id}:`).map((row) => row.value),
  });
  registry.register({
    ...admin,
    id: 'workflow.jobs',
    description:
      'Inspect recent workflow execution status and failed step numbers; no event message contents are retained.',
    risk: 'read',
    schema: empty,
    execute: (ctx) =>
      ctx.store
        .list<WorkflowJob>('automation.outbox', `${ctx.guild.id}:`)
        .map((row) => row.value)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 100),
  });
  registry.register({
    ...admin,
    id: 'schedule.set',
    description:
      'Schedule UTC cron announcements (five fields); missed occurrences are skipped after restart.',
    schema: z.strictObject({
      id: slug,
      channelId: snowflake,
      content: z.string().min(1).max(1800),
      cron,
      enabled: z.boolean().default(true),
    }),
    execute: async (ctx, input) => {
      await sendable(ctx, input.channelId);
      const k = key(ctx.guild.id, input.id);
      if (
        !ctx.store.get('automation.schedules', k) &&
        ctx.store.list('automation.schedules', `${ctx.guild.id}:`).length >= 25
      )
        throw new UserError('Limit: 25 cron announcements per server.');
      const schedule: Schedule = {
        ...input,
        guildId: ctx.guild.id,
        authorId: ctx.member.id,
        nextAt: nextCron(input.cron, Date.now()),
        nonce: token(),
        attempts: 0,
        retryAt: 0,
      };
      ctx.store.set('automation.schedules', k, schedule);
      return schedule;
    },
  });
  registry.register({
    ...admin,
    id: 'schedule.list',
    description: 'List durable cron announcements, next UTC occurrence and failure state.',
    risk: 'read',
    schema: empty,
    execute: (ctx) =>
      ctx.store.list<Schedule>('automation.schedules', `${ctx.guild.id}:`).map((row) => row.value),
  });
  registry.register({
    ...admin,
    id: 'schedule.remove',
    description: 'Remove a cron announcement.',
    schema: z.strictObject({ id: slug }),
    execute: (ctx, input) => ({
      removed: ctx.store.delete('automation.schedules', key(ctx.guild.id, input.id)),
    }),
  });
  registry.register({
    ...admin,
    id: 'channel.temporary',
    description: 'Create a managed temporary text/voice channel; occupied voice channels are never deleted.',
    userPermissions: [P.ManageGuild, P.ManageChannels],
    botPermissions: [P.ManageChannels],
    schema: z.strictObject({
      name: z.string().min(1).max(90),
      kind: z.enum(['text', 'voice']),
      minutes: z.number().int().min(1).max(43200),
      parentId: snowflake.optional(),
      private: z.boolean().default(false),
    }),
    execute: async (ctx, input) => {
      if (ctx.store.list('automation.channels', `${ctx.guild.id}:`).length >= 50)
        throw new UserError('Limit: 50 temporary channels per server.');
      if (input.parentId) {
        const parent = await resolveChannel(ctx, input.parentId);
        if (parent.type !== ChannelType.GuildCategory) throw new UserError('Parent must be a category.');
      }
      const channel = await ctx.guild.channels.create({
        name: input.name,
        type: input.kind === 'text' ? ChannelType.GuildText : ChannelType.GuildVoice,
        parent: input.parentId,
        permissionOverwrites: input.private
          ? [
              { id: ctx.guild.id, deny: [P.ViewChannel] },
              {
                id: ctx.member.id,
                allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.Connect, P.Speak],
              },
              {
                id: ctx.guild.members.me!.id,
                allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.Connect, P.ManageChannels],
              },
            ]
          : undefined,
        reason: 'Confirmed temporary channel',
      });
      const record: TemporaryChannel = {
        guildId: ctx.guild.id,
        channelId: channel.id,
        ownerId: ctx.member.id,
        expiresAt: Date.now() + input.minutes * 60000,
        deleteWhenEmpty: false,
        attempts: 0,
        nextAt: Date.now(),
      };
      ctx.store.set('automation.channels', key(ctx.guild.id, channel.id), record);
      return record;
    },
  });
  registry.register({
    ...admin,
    id: 'channel.temporary-list',
    description: 'List managed temporary resources and failed expiration state.',
    risk: 'read',
    schema: empty,
    execute: (ctx) =>
      ctx.store.list<TemporaryChannel>('automation.channels', `${ctx.guild.id}:`).map((row) => row.value),
  });
  registry.register({
    ...admin,
    id: 'voiceroom.hub',
    description: 'Configure an existing voice channel as a join-to-create private room hub.',
    userPermissions: [P.ManageGuild, P.ManageChannels],
    botPermissions: [P.ManageChannels, P.MoveMembers],
    schema: z.strictObject({
      channelId: snowflake,
      categoryId: snowflake,
      private: z.boolean().default(true),
      maxMinutes: z.number().int().min(5).max(1440).default(180),
      userLimit: z.number().int().min(0).max(99).default(0),
    }),
    execute: async (ctx, input) => {
      const source = await resolveChannel(ctx, input.channelId),
        category = await resolveChannel(ctx, input.categoryId);
      if (source.type !== ChannelType.GuildVoice || category.type !== ChannelType.GuildCategory)
        throw new UserError('Choose a regular voice channel and category.');
      const hub: VoiceHub = { ...input, guildId: ctx.guild.id, authorId: ctx.member.id };
      ctx.store.set('automation.voiceHubs', key(ctx.guild.id, input.channelId), hub);
      return hub;
    },
  });
  registry.register({
    ...admin,
    id: 'voiceroom.hub-remove',
    description: 'Disable a voice-room hub; existing rooms still expire.',
    schema: z.strictObject({ channelId: snowflake }),
    execute: (ctx, input) => ({
      removed: ctx.store.delete('automation.voiceHubs', key(ctx.guild.id, input.channelId)),
    }),
  });
  registry.register({
    ...admin,
    id: 'voiceroom.allow',
    description: 'Allow another current server member into your managed personal voice room.',
    userPermissions: [],
    botPermissions: [P.ManageChannels],
    schema: z.strictObject({ channelId: snowflake, userId: snowflake }),
    execute: async (ctx, input) => {
      const record = ctx.store.get<TemporaryChannel>(
        'automation.channels',
        key(ctx.guild.id, input.channelId),
      );
      if (!record?.deleteWhenEmpty || record.ownerId !== ctx.member.id)
        throw new UserError('Only the personal room owner may invite a member.');
      const channel = await resolveChannel(ctx, input.channelId);
      if (!channel.isVoiceBased()) throw new UserError('Voice room no longer exists.');
      await ctx.guild.members.fetch(input.userId);
      await channel.permissionOverwrites.edit(
        input.userId,
        { ViewChannel: true, Connect: true, Speak: true },
        { reason: 'Personal room owner invitation' },
      );
      return { allowed: input.userId };
    },
  });
  registry.register({
    ...admin,
    id: 'calendar.create',
    description:
      'Create a local event calendar entry with RSVP capacity, waitlist, reminder, voice attendance and post-event summary.',
    schema: z.strictObject({
      id: slug,
      title: z.string().min(1).max(150),
      channelId: snowflake,
      startsAt: z.iso.datetime({ offset: true }),
      endsAt: z.iso.datetime({ offset: true }),
      capacity: z.number().int().min(1).max(1000).default(100),
      voiceChannelId: snowflake.optional(),
      reminderMinutes: z.number().int().min(1).max(10080).optional(),
    }),
    execute: async (ctx, input) => {
      const startsAt = Date.parse(input.startsAt),
        endsAt = Date.parse(input.endsAt);
      if (
        startsAt < Date.now() + 60000 ||
        endsAt <= startsAt ||
        endsAt - startsAt > 7 * DAY ||
        startsAt > Date.now() + 366 * DAY
      )
        throw new UserError(
          'Events must start within the next year, end after start and last at most seven days.',
        );
      if (ctx.store.get('automation.calendar', key(ctx.guild.id, input.id)))
        throw new UserError('Event ID already exists.');
      if (ctx.store.list('automation.calendar', `${ctx.guild.id}:`).length >= 100)
        throw new UserError('Limit: 100 calendar entries per server.');
      await sendable(ctx, input.channelId);
      if (input.voiceChannelId) {
        const voice = await resolveChannel(ctx, input.voiceChannelId);
        if (!voice.isVoiceBased()) throw new UserError('Attendance channel must be a voice channel.');
      }
      const event: CalendarEvent = {
        id: input.id,
        guildId: ctx.guild.id,
        authorId: ctx.member.id,
        title: input.title,
        channelId: input.channelId,
        startsAt,
        endsAt,
        capacity: input.capacity,
        voiceChannelId: input.voiceChannelId,
        rsvps: {},
        attended: [],
        reminderAt: input.reminderMinutes ? startsAt - input.reminderMinutes * 60000 : undefined,
        reminderSent: false,
        summarySent: false,
        cancelled: false,
      };
      ctx.store.set('automation.calendar', key(ctx.guild.id, input.id), event);
      return event;
    },
  });
  registry.register({
    ...admin,
    id: 'calendar.list',
    description: 'Read calendar entries only in channels you can currently view.',
    userPermissions: [],
    risk: 'read',
    schema: empty,
    execute: async (ctx) => {
      const results = [];
      for (const { value: event } of ctx.store.list<CalendarEvent>(
        'automation.calendar',
        `${ctx.guild.id}:`,
      )) {
        try {
          await eventVisible(ctx, event);
          results.push({
            ...event,
            rsvps: rsvpCounts(event),
            attended: event.attended.length,
            countdownSeconds: Math.max(0, Math.floor((event.startsAt - Date.now()) / 1000)),
          });
        } catch {
          /* Hidden entries stay private. */
        }
      }
      return results;
    },
  });
  registry.register({
    ...admin,
    id: 'calendar.rsvp',
    description: 'Set your RSVP; full events place new confirmations on a FIFO waitlist.',
    userPermissions: [],
    schema: z.strictObject({ id: slug, status: z.enum(['yes', 'maybe', 'no']) }),
    execute: async (ctx, input) => {
      const k = key(ctx.guild.id, input.id),
        initial = ctx.store.get<CalendarEvent>('automation.calendar', k);
      if (!initial) throw new UserError('Event not found.');
      await eventVisible(ctx, initial);
      return ctx.store.transaction(() => {
        const event = ctx.store.get<CalendarEvent>('automation.calendar', k)!;
        if (event.cancelled || event.endsAt <= Date.now()) throw new UserError('Event is closed.');
        if (input.status === 'no') delete event.rsvps[ctx.member.id];
        else {
          const old = event.rsvps[ctx.member.id];
          if (!old && Object.keys(event.rsvps).length >= 2000)
            throw new UserError('Event RSVP limit reached.');
          const status =
            input.status === 'yes' && old?.status !== 'yes' && rsvpCounts(event).yes >= event.capacity
              ? 'waitlist'
              : input.status;
          event.rsvps[ctx.member.id] = { status, at: old?.at ?? Date.now() };
        }
        promoteWaitlist(event);
        ctx.store.set('automation.calendar', k, event);
        return { status: event.rsvps[ctx.member.id]?.status ?? 'no', ...rsvpCounts(event) };
      });
    },
  });
  registry.register({
    ...admin,
    id: 'calendar.checkin',
    description: 'Check yourself into an active event; optional voice-channel membership is required.',
    userPermissions: [],
    schema: z.strictObject({ id: slug }),
    execute: async (ctx, input) => {
      const k = key(ctx.guild.id, input.id),
        event = ctx.store.get<CalendarEvent>('automation.calendar', k);
      if (!event || event.cancelled || Date.now() < event.startsAt || Date.now() > event.endsAt)
        throw new UserError('Event is not active.');
      await eventVisible(ctx, event);
      if (event.voiceChannelId && ctx.member.voice.channelId !== event.voiceChannelId)
        throw new UserError('Join the event voice channel first.');
      const latest = ctx.store.get<CalendarEvent>('automation.calendar', k);
      if (!latest || latest.cancelled || Date.now() > latest.endsAt) throw new UserError('Event is closed.');
      latest.attended = [...new Set([...latest.attended, ctx.member.id])].slice(0, 1000);
      ctx.store.set('automation.calendar', k, latest);
      return { checkedIn: true };
    },
  });
  registry.register({
    ...admin,
    id: 'calendar.cancel',
    description: 'Cancel a calendar entry and its pending reminder/summary.',
    schema: z.strictObject({ id: slug }),
    execute: async (ctx, input) => {
      const k = key(ctx.guild.id, input.id),
        event = ctx.store.get<CalendarEvent>('automation.calendar', k);
      if (!event) throw new UserError('Event not found.');
      await eventVisible(ctx, event);
      const latest = ctx.store.get<CalendarEvent>('automation.calendar', k)!;
      latest.cancelled = true;
      ctx.store.set('automation.calendar', k, latest);
      return { cancelled: input.id };
    },
  });
  registry.register({
    ...admin,
    id: 'calendar.export',
    description: 'Export local event RSVP and attendance rows as CSV.',
    risk: 'read',
    schema: z.strictObject({ id: slug }),
    execute: async (ctx, input) => {
      const event = ctx.store.get<CalendarEvent>('automation.calendar', key(ctx.guild.id, input.id));
      if (!event) throw new UserError('Event not found.');
      await eventVisible(ctx, event);
      return {
        attachment: Buffer.from(
          csv(
            [...new Set([...Object.keys(event.rsvps), ...event.attended])].map((userId) => ({
              event: event.id,
              userId,
              rsvp: event.rsvps[userId]?.status ?? 'none',
              attended: event.attended.includes(userId),
            })),
          ),
        ),
        name: `event-${event.id}.csv`,
      };
    },
  });
  registry.register({
    ...admin,
    id: 'celebration.configure',
    description: 'Configure the destination for opted-in birthday and anniversary announcements (UTC dates).',
    schema: z.strictObject({ channelId: snowflake }),
    execute: async (ctx, input) => {
      await sendable(ctx, input.channelId);
      ctx.store.set('automation.celebrationConfig', ctx.guild.id, {
        channelId: input.channelId,
        authorId: ctx.member.id,
      });
      return { configured: true };
    },
  });
  registry.register({
    ...admin,
    id: 'celebration.set',
    description:
      'Opt your own birthday or anniversary date into public UTC announcements; no birth year is stored.',
    userPermissions: [],
    schema: z.strictObject({
      kind: z.enum(['birthday', 'anniversary']),
      month: z.number().int().min(1).max(12),
      day: z.number().int().min(1).max(31),
    }),
    execute: (ctx, input) => {
      const date = new Date(Date.UTC(2024, input.month - 1, input.day));
      if (date.getUTCMonth() !== input.month - 1) throw new UserError('Invalid date.');
      const entry: Celebration = { ...input, guildId: ctx.guild.id, userId: ctx.member.id };
      ctx.store.set('automation.celebrations', key(ctx.guild.id, `${ctx.member.id}:${input.kind}`), entry);
      return { saved: true, timezone: 'UTC', leapDay: 'February 29 is announced only in leap years' };
    },
  });
  registry.register({
    ...admin,
    id: 'celebration.remove',
    description: 'Remove your own public birthday/anniversary opt-in.',
    userPermissions: [],
    schema: z.strictObject({ kind: z.enum(['birthday', 'anniversary']) }),
    execute: (ctx, input) => ({
      removed: ctx.store.delete(
        'automation.celebrations',
        key(ctx.guild.id, `${ctx.member.id}:${input.kind}`),
      ),
    }),
  });
  registry.register({
    ...admin,
    id: 'tournament.create',
    description: 'Create a bounded single-elimination tournament and publish its first-round schedule.',
    schema: z.strictObject({
      id: slug,
      title: z.string().min(1).max(100),
      channelId: snowflake,
      userIds: z
        .array(snowflake)
        .min(2)
        .max(32)
        .refine((ids) => new Set(ids).size === ids.length, 'Players must be unique'),
    }),
    execute: async (ctx, input) => {
      const k = key(ctx.guild.id, input.id);
      if (ctx.store.get('automation.tournaments', k)) throw new UserError('Tournament ID exists.');
      if (ctx.store.list('automation.tournaments', `${ctx.guild.id}:`).length >= 20)
        throw new UserError('Limit: 20 tournaments per server.');
      const channel = await sendable(ctx, input.channelId);
      for (const id of input.userIds) await ctx.guild.members.fetch(id);
      const matches = [];
      for (let i = 0; i < input.userIds.length; i += 2)
        matches.push({
          a: input.userIds[i]!,
          b: input.userIds[i + 1] ?? null,
          ...(!input.userIds[i + 1] ? { winner: input.userIds[i]! } : {}),
        });
      const tournament: Tournament = {
        id: input.id,
        title: input.title,
        channelId: input.channelId,
        players: input.userIds,
        round: 1,
        matches,
        history: [],
      };
      ctx.store.set('automation.tournaments', k, tournament);
      await channel.send({
        content: `Tournament ${input.title}, round 1\n${matches.map((match, index) => `${index + 1}: ${match.a} vs ${match.b ?? 'bye'}`).join('\n')}`,
        allowedMentions: noMentions,
      });
      return tournament;
    },
  });
  registry.register({
    ...admin,
    id: 'tournament.schedule',
    description:
      'Assign exact dates to unfinished matches in the current bracket round, publish the dated schedule and create durable one-time match reminders using the shared announcement scheduler.',
    schema: z.strictObject({
      id: slug,
      round: z.number().int().min(1).max(5),
      matches: z
        .array(
          z.strictObject({
            match: z.number().int().min(1).max(16),
            startsAt: z.iso.datetime({ offset: true }),
          }),
        )
        .min(1)
        .max(16),
      reminderMinutes: z.number().int().min(0).max(10080).default(15),
    }),
    execute: async (ctx, input) => {
      const k = key(ctx.guild.id, input.id),
        initial = ctx.store.get<Tournament>('automation.tournaments', k);
      if (!initial || initial.champion || initial.round !== input.round)
        throw new UserError('Select the current active tournament round.');
      if (new Set(input.matches.map((row) => row.match)).size !== input.matches.length)
        throw new UserError('Match numbers must be unique.');
      const channel = await sendable(ctx, initial.channelId),
        current = ctx.store.get<Tournament>('automation.tournaments', k);
      if (!current || current.round !== input.round || current.champion)
        throw new UserError('Tournament round changed.');
      const planned = input.matches.map((row) => {
        const match = current.matches[row.match - 1],
          startsAt = Date.parse(row.startsAt),
          due = startsAt - input.reminderMinutes * 60000;
        if (!match || match.winner || !match.b)
          throw new UserError('Schedule only unfinished matches with two players.');
        if (due < Date.now() + 5000 || startsAt > Date.now() + 365 * DAY)
          throw new UserError('The reminder must be 5 seconds to 365 days in the future.');
        return {
          ...row,
          startsAt,
          due,
          matchRecord: match,
          scheduleId: `tm_${nonce(`${input.id}:${input.round}:${row.match}`)}`,
        };
      });
      const existing = ctx.store.list<Schedule>('automation.schedules', `${ctx.guild.id}:`);
      if (
        existing.filter(
          (row) => row.value.enabled && !planned.some((item) => item.scheduleId === row.value.id),
        ).length +
          planned.length >
        25
      )
        throw new UserError('Limit: 25 active announcements per server.');
      ctx.store.transaction(() => {
        for (const row of planned) {
          row.matchRecord.startsAt = new Date(row.startsAt).toISOString();
          const schedule: Schedule = {
            id: row.scheduleId,
            guildId: ctx.guild.id,
            authorId: ctx.member.id,
            channelId: current.channelId,
            content: `Tournament ${current.title}, round ${current.round}, match ${row.match}: ${row.matchRecord.a} vs ${row.matchRecord.b}. Starts <t:${Math.floor(row.startsAt / 1000)}:F>.`,
            cron: '* * * * *',
            nextAt: row.due,
            nonce: token(),
            enabled: true,
            attempts: 0,
            retryAt: 0,
            once: true,
            tournament: { id: current.id, round: current.round, match: row.match, startsAt: row.startsAt },
          };
          ctx.store.set('automation.schedules', key(ctx.guild.id, row.scheduleId), schedule);
        }
        ctx.store.set('automation.tournaments', k, current);
      });
      await channel.send({
        content: `Tournament ${current.title}, round ${current.round} schedule\n${current.matches.map((match, index) => `${index + 1}: ${match.a} vs ${match.b ?? 'bye'}${match.startsAt ? ` — <t:${Math.floor(Date.parse(match.startsAt) / 1000)}:F>` : ''}`).join('\n')}`,
        allowedMentions: noMentions,
      });
      return {
        tournament: current,
        reminders: planned.map((row) => ({
          id: row.scheduleId,
          match: row.match,
          dueAt: new Date(row.due).toISOString(),
        })),
      };
    },
  });
  registry.register({
    ...admin,
    id: 'tournament.result',
    description: 'Record a match winner and advance the elimination bracket after all results are present.',
    schema: z.strictObject({ id: slug, match: z.number().int().min(1).max(16), winnerId: snowflake }),
    execute: async (ctx, input) => {
      const k = key(ctx.guild.id, input.id),
        initial = ctx.store.get<Tournament>('automation.tournaments', k);
      if (!initial || initial.champion) throw new UserError('Active tournament not found.');
      await resolveChannel(ctx, initial.channelId);
      const tournament = ctx.store.get<Tournament>('automation.tournaments', k)!;
      if (tournament.champion || tournament.round !== initial.round)
        throw new UserError('Tournament round changed; refresh the bracket.');
      const match = tournament.matches[input.match - 1];
      if (!match || match.winner || ![match.a, match.b].includes(input.winnerId))
        throw new UserError('Choose an unfinished match and one of its players.');
      match.winner = input.winnerId;
      if (tournament.matches.every((row) => row.winner)) {
        const winners = tournament.matches.map((row) => row.winner!);
        tournament.history.push({ round: tournament.round, matches: structuredClone(tournament.matches) });
        if (winners.length === 1) tournament.champion = winners[0];
        else {
          tournament.round++;
          tournament.matches = [];
          for (let i = 0; i < winners.length; i += 2)
            tournament.matches.push({
              a: winners[i]!,
              b: winners[i + 1] ?? null,
              ...(!winners[i + 1] ? { winner: winners[i]! } : {}),
            });
        }
      }
      ctx.store.set('automation.tournaments', k, tournament);
      const channel = await sendable(ctx, tournament.channelId);
      await channel.send({
        content: tournament.champion
          ? `Tournament ${tournament.title} champion: ${tournament.champion}`
          : `Tournament ${tournament.title}: round ${tournament.round}\n${tournament.matches.map((row, index) => `${index + 1}: ${row.a} vs ${row.b ?? 'bye'}${row.winner ? ` — winner ${row.winner}` : ''}`).join('\n')}`,
        allowedMentions: noMentions,
      });
      return tournament;
    },
  });
  registry.register({
    ...admin,
    id: 'tournament.view',
    description: 'View a tournament bracket in a channel you can currently access.',
    risk: 'read',
    userPermissions: [],
    schema: z.strictObject({ id: slug }),
    execute: async (ctx, input) => {
      const value = ctx.store.get<Tournament>('automation.tournaments', key(ctx.guild.id, input.id));
      if (!value) throw new UserError('Tournament not found.');
      await resolveChannel(ctx, value.channelId);
      return value;
    },
  });
}
