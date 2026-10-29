import { randomBytes } from 'node:crypto';
import {
  ChannelType,
  PermissionFlagsBits as P,
  type Client,
  type GuildMember,
  type PrivateThreadChannel,
  type TextChannel,
} from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry, ActionPolicy } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import type { Store } from '../core/store.js';
import { freshContext, resolveChannel, resolveMember } from '../core/permissions.js';
import { UserError } from '../core/errors.js';
import { readMessageRange } from './history.js';
const records = 'support.threadTickets',
  settings = 'support.threadSettings',
  active = 'support.threadActive',
  DAY = 86400000;
const snowflake = z.string().regex(/^\d{17,20}$/),
  token = () => randomBytes(12).toString('hex'),
  ticketId = z.string().regex(/^[a-f0-9]{24}$/);
const key = (guildId: string, id: string) => `${guildId}:${id}`;
interface Configuration {
  parentChannelId: string;
  staffUserIds: string[];
  version: string;
  authorId: string;
  originChannelId: string;
}
export interface ThreadTicket {
  id: string;
  guildId: string;
  userId: string;
  subject: string;
  parentChannelId: string;
  originChannelId: string;
  staffUserIds: string[];
  configurationVersion: string;
  creatorBotId: string;
  createdAt: number;
  state: 'creating' | 'needs-review' | 'inviting' | 'open' | 'closing' | 'closed' | 'failed';
  threadId?: string;
  pendingUserIds: string[];
  attempts: number;
  retryAt: number;
  lastError?: string;
  closedAt?: number;
}
const opening = new WeakMap<Store, Set<string>>(),
  sweeping = new WeakSet<Store>();
function disabled(store: Store, guildId: string) {
  return (store.get<string[]>('core.disabled', guildId) ?? []).includes('support');
}
function isStaff(ctx: ActionContext, member: GuildMember): boolean {
  const roleId = ctx.store.get<{ staffRoleId?: string | null }>(
    'community.settings',
    ctx.guild.id,
  )?.staffRoleId;
  return member.permissions.has(P.ModerateMembers) || !!(roleId && member.roles.cache.has(roleId));
}
function actionAllowed(ctx: ActionContext, action: string, member: GuildMember, channelId: string): void {
  const rule = ctx.store.get<ActionPolicy>('core.actionPolicies', `${ctx.guild.id}:${action}`);
  if (
    rule &&
    (!rule.enabled ||
      (rule.roleIds.length && !rule.roleIds.some((role) => member.roles.cache.has(role))) ||
      (rule.channelIds.length && !rule.channelIds.includes(channelId)))
  )
    throw new UserError('The current action policy no longer permits this ticket operation.');
}
function config(ctx: ActionContext): Configuration {
  const result = ctx.store.get<Configuration>(settings, ctx.guild.id);
  if (!result) throw new UserError('A server manager must configure private thread tickets first.');
  return result;
}
function reviewedConfiguration(ctx: ActionContext, ticket: ThreadTicket): void {
  const cfg = config(ctx);
  if (
    cfg.version !== ticket.configurationVersion ||
    cfg.parentChannelId !== ticket.parentChannelId ||
    JSON.stringify(cfg.staffUserIds) !== JSON.stringify(ticket.staffUserIds)
  )
    throw new UserError('The reviewed parent/staff configuration changed. Pending invitations stopped.');
}
function current(ctx: ActionContext, ticket: ThreadTicket): void {
  reviewedConfiguration(ctx, ticket);
  if (disabled(ctx.store, ctx.guild.id)) throw new UserError('Support is disabled.');
}
async function parent(ctx: ActionContext, parentId: string, opening = false): Promise<TextChannel> {
  const result = await resolveChannel(ctx, parentId);
  if (result.type !== ChannelType.GuildText)
    throw new UserError('Configure an ordinary server text channel parent.');
  const me = ctx.guild.members.me!;
  const required = opening
    ? [P.ViewChannel, P.CreatePrivateThreads, P.ManageThreads, P.SendMessagesInThreads, P.ReadMessageHistory]
    : [P.ViewChannel, P.ManageThreads, P.ReadMessageHistory];
  if (!result.permissionsFor(me)?.has(required))
    throw new UserError(
      'The bot needs private-thread creation, management, send and history permissions in the parent.',
    );
  if (opening && !result.permissionsFor(ctx.member)?.has([P.ViewChannel, P.SendMessagesInThreads]))
    throw new UserError('You need View Channel and Send Messages in Threads in the parent.');
  return result;
}
async function configured(ctx: ActionContext, cfg: Configuration): Promise<TextChannel> {
  const manager = await resolveMember(ctx, cfg.authorId);
  if (!manager.permissions.has(P.ManageGuild))
    throw new UserError('The configuring manager no longer has Manage Server.');
  const channel = await parent(ctx, cfg.parentChannelId, true);
  if (!channel.permissionsFor(manager)?.has(P.ViewChannel))
    throw new UserError('The configuring manager cannot currently view the parent.');
  for (const userId of cfg.staffUserIds) {
    const staff = await resolveMember(ctx, userId);
    if (
      staff.user.bot ||
      !isStaff(ctx, staff) ||
      !channel.permissionsFor(staff)?.has([P.ViewChannel, P.SendMessagesInThreads])
    )
      throw new UserError(
        'Every approved staff member must remain eligible and able to view/use the parent.',
      );
  }
  actionAllowed(ctx, 'ticket.thread-configure', manager, cfg.originChannelId);
  return channel;
}
function save(store: Store, ticket: ThreadTicket) {
  store.set(records, key(ticket.guildId, ticket.id), ticket);
}
function read(ctx: ActionContext, id: string): ThreadTicket {
  const ticket = ctx.store.get<ThreadTicket>(records, key(ctx.guild.id, id));
  if (!ticket) throw new UserError('Thread ticket not found in this server.');
  return ticket;
}
function assertParticipant(ctx: ActionContext, ticket: ThreadTicket) {
  if (
    ticket.userId !== ctx.member.id &&
    !(ticket.staffUserIds.includes(ctx.member.id) && isStaff(ctx, ctx.member))
  )
    throw new UserError('Only the ticket owner or current approved staff can access this ticket.');
}
export function threadTicketName(ticket: Pick<ThreadTicket, 'id'>) {
  return `support-${ticket.id}`;
}
async function exactThread(
  ctx: ActionContext,
  ticket: ThreadTicket,
  requireParticipant = true,
): Promise<PrivateThreadChannel> {
  if (!ticket.threadId) throw new UserError('Creation is unresolved; inspect or reconcile the reservation.');
  const raw = requireParticipant
    ? await resolveChannel(ctx, ticket.threadId)
    : await ctx.guild.channels.fetch(ticket.threadId, { force: true });
  if (
    !raw ||
    raw.type !== ChannelType.PrivateThread ||
    raw.guildId !== ctx.guild.id ||
    raw.parentId !== ticket.parentChannelId ||
    raw.ownerId !== ticket.creatorBotId ||
    raw.name !== threadTicketName(ticket) ||
    raw.invitable !== false
  )
    throw new UserError(
      'The private thread does not match the exact bot-owned reservation, parent and name.',
    );
  if (!raw.permissionsFor(ctx.guild.members.me!)?.has([P.ViewChannel, P.ManageThreads]))
    throw new UserError('The bot cannot currently manage this private thread.');
  return raw as PrivateThreadChannel;
}
function release(store: Store, ticket: ThreadTicket) {
  if (store.get<string>(active, key(ticket.guildId, ticket.userId)) === ticket.id)
    store.delete(active, key(ticket.guildId, ticket.userId));
}
async function withOpening<T>(store: Store, ownerKey: string, run: () => Promise<T>): Promise<T> {
  const locks = opening.get(store) ?? new Set<string>();
  opening.set(store, locks);
  if (locks.has(ownerKey))
    throw new UserError('A thread-ticket request for this member is already in progress.');
  locks.add(ownerKey);
  try {
    return await run();
  } finally {
    locks.delete(ownerKey);
  }
}
function inviteCurrent(store: Store, ticket: ThreadTicket): boolean {
  const row = store.get<ThreadTicket>(records, key(ticket.guildId, ticket.id));
  return (
    row?.state === 'inviting' &&
    row.threadId === ticket.threadId &&
    row.configurationVersion === ticket.configurationVersion
  );
}
async function invite(ctx: ActionContext, ticket: ThreadTicket): Promise<void> {
  const cfg = config(ctx);
  current(ctx, ticket);
  await configured(ctx, cfg);
  const thread = await exactThread(ctx, ticket, false);
  for (const userId of [...ticket.pendingUserIds]) {
    ctx = await freshContext(ctx);
    const member = await resolveMember(ctx, userId);
    const liveParent = await parent(ctx, ticket.parentChannelId, true);
    if (
      !liveParent.permissionsFor(member)?.has([P.ViewChannel, P.SendMessagesInThreads]) ||
      (userId !== ticket.userId && (!ticket.staffUserIds.includes(userId) || !isStaff(ctx, member)))
    )
      throw new UserError('A pending participant lost current parent/staff access.');
    current(ctx, ticket);
    await resolveChannel(ctx, ticket.originChannelId);
    actionAllowed(ctx, 'ticket.thread-open', ctx.member, ticket.originChannelId);
    await exactThread(ctx, ticket, false);
    current(ctx, ticket);
    if (!inviteCurrent(ctx.store, ticket)) return;
    await thread.members.add(userId, 'Confirmed private support ticket participant');
    if (!inviteCurrent(ctx.store, ticket)) return;
    ticket.pendingUserIds = ticket.pendingUserIds.filter((value) => value !== userId);
    save(ctx.store, ticket);
  }
  current(ctx, ticket);
  if (inviteCurrent(ctx.store, ticket)) {
    ticket.state = 'open';
    ticket.attempts = 0;
    delete ticket.lastError;
    save(ctx.store, ticket);
  }
}
function failInvites(store: Store, ticket: ThreadTicket, error: unknown, now: number) {
  const latest = store.get<ThreadTicket>(records, key(ticket.guildId, ticket.id));
  if (!latest || latest.state !== 'inviting') return;
  latest.attempts++;
  latest.retryAt = now + 30000 * 2 ** (latest.attempts - 1);
  latest.lastError =
    error instanceof UserError ? error.message.slice(0, 250) : error instanceof Error ? error.name : 'Error';
  if (error instanceof UserError || latest.attempts >= 3) latest.state = 'failed';
  save(store, latest);
}
export function registerThreadTicketActions(registry: ActionRegistry): void {
  const base = {
    category: 'support',
    risk: 'write' as const,
    userPermissions: [] as bigint[],
    botPermissions: [] as bigint[],
  };
  registry.register({
    ...base,
    id: 'ticket.thread-configure',
    userPermissions: [P.ManageGuild],
    description:
      'Approve one ordinary text parent and 1–5 current staff users for owner-requested private thread tickets. Changing this version stops pending old invitations.',
    schema: z.strictObject({
      parentChannelId: snowflake,
      staffUserIds: z
        .array(snowflake)
        .min(1)
        .max(5)
        .refine((ids) => new Set(ids).size === ids.length, 'Staff user IDs must be unique.'),
    }),
    execute: async (ctx, input) => {
      ctx = await freshContext(ctx);
      if (!ctx.member.permissions.has(P.ManageGuild))
        throw new UserError('Manage Server permission required.');
      const cfg: Configuration = {
        ...input,
        version: token(),
        authorId: ctx.member.id,
        originChannelId: ctx.channelId,
      };
      await configured(ctx, cfg);
      if (disabled(ctx.store, ctx.guild.id)) throw new UserError('Support is disabled.');
      ctx.store.set(settings, ctx.guild.id, cfg);
      return cfg;
    },
  });
  registry.register({
    ...base,
    id: 'ticket.thread-settings',
    risk: 'read',
    description:
      'Read the currently visible private-thread parent, approved staff and configuration version to review before opening a ticket.',
    schema: z.strictObject({}),
    execute: async (ctx) => {
      const cfg = config(ctx);
      await resolveChannel(ctx, cfg.parentChannelId);
      return cfg;
    },
  });
  registry.register({
    ...base,
    id: 'ticket.thread-open',
    description:
      'Open your own private thread ticket under an exact reviewed configuration version. The unique bot-owned name/reservation is persisted before creation; uncertain creates require review.',
    schema: z.strictObject({
      subject: z.string().trim().min(1).max(100),
      configurationVersion: z.string().regex(/^[a-f0-9]{24}$/),
    }),
    execute: (ctx, input) =>
      withOpening(ctx.store, key(ctx.guild.id, ctx.member.id), async () => {
        ctx = await freshContext(ctx);
        const cfg = config(ctx);
        if (input.configurationVersion !== cfg.version)
          throw new UserError(
            'Read ticket.thread-settings and review the current parent/staff configuration version.',
          );
        const channel = await configured(ctx, cfg);
        if (ctx.member.user.bot) throw new UserError('A person must open their own ticket.');
        if (disabled(ctx.store, ctx.guild.id)) throw new UserError('Support is disabled.');
        if (ctx.store.get(active, key(ctx.guild.id, ctx.member.id)))
          throw new UserError('Resolve or close your existing active/uncertain thread ticket first.');
        const rows = ctx.store.list<ThreadTicket>(records, `${ctx.guild.id}:`);
        if (
          rows.length >= 5000 ||
          rows.filter((row) => row.value.state !== 'closed').length >= 500 ||
          ctx.store.list(records).length >= 25000
        )
          throw new UserError('Thread ticket record/active capacity reached.');
        const day = new Date().toISOString().slice(0, 10),
          dailyKey = `${ctx.guild.id}:${ctx.member.id}:${day}`,
          count = ctx.store.get<number>('support.threadDaily', dailyKey) ?? 0;
        if (count >= 10) throw new UserError('Limit: ten new thread-ticket requests per member per UTC day.');
        if (config(ctx).version !== cfg.version)
          throw new UserError('Thread ticket configuration changed during authorization.');
        const now = Date.now(),
          ticket: ThreadTicket = {
            id: token(),
            guildId: ctx.guild.id,
            userId: ctx.member.id,
            subject: input.subject,
            parentChannelId: cfg.parentChannelId,
            originChannelId: ctx.channelId,
            staffUserIds: cfg.staffUserIds,
            configurationVersion: cfg.version,
            creatorBotId: ctx.guild.members.me!.id,
            createdAt: now,
            state: 'creating',
            pendingUserIds: [...new Set([ctx.member.id, ...cfg.staffUserIds])],
            attempts: 0,
            retryAt: now,
          };
        actionAllowed(ctx, 'ticket.thread-open', ctx.member, ctx.channelId);
        ctx.store.transaction(() => {
          save(ctx.store, ticket);
          ctx.store.set(active, key(ctx.guild.id, ctx.member.id), ticket.id);
          ctx.store.set('support.threadDaily', dailyKey, count + 1);
        });
        try {
          const thread = await channel.threads.create({
            name: threadTicketName(ticket),
            type: ChannelType.PrivateThread,
            invitable: false,
            autoArchiveDuration: 1440,
            reason: 'Confirmed owner-requested private support ticket',
          });
          ticket.threadId = thread.id;
          ticket.state = 'inviting';
          save(ctx.store, ticket);
        } catch (error) {
          ticket.state = 'needs-review';
          ticket.lastError = error instanceof Error ? error.name : 'Error';
          save(ctx.store, ticket);
          return ticket;
        }
        try {
          await invite(ctx, ticket);
        } catch (error) {
          failInvites(ctx.store, ticket, error, now);
        }
        return read(ctx, ticket.id);
      }),
  });
  registry.register({
    ...base,
    id: 'ticket.thread-retry',
    description:
      'Retry only idempotent participant invitations for a known failed ticket thread under its unchanged reviewed configuration. This never creates a thread.',
    schema: z.strictObject({ id: ticketId }),
    execute: (ctx, input) =>
      withOpening(ctx.store, key(ctx.guild.id, read(ctx, input.id).userId), async () => {
        ctx = await freshContext(ctx);
        const ticket = read(ctx, input.id);
        assertParticipant(ctx, ticket);
        await parent(ctx, ticket.parentChannelId);
        if (ticket.state !== 'failed' || !ticket.threadId)
          throw new UserError(
            'Only failed invitations on a known thread can be retried. Reconcile uncertain creation instead.',
          );
        const owner = await resolveMember(ctx, ticket.userId),
          ownerCtx = { ...ctx, member: owner, channelId: ticket.originChannelId };
        current(ownerCtx, ticket);
        await exactThread(ctx, ticket, false);
        ticket.state = 'inviting';
        ticket.attempts = 0;
        ticket.retryAt = 0;
        save(ctx.store, ticket);
        try {
          await invite(ownerCtx, ticket);
        } catch (error) {
          failInvites(ctx.store, ticket, error, Date.now());
        }
        return read(ctx, ticket.id);
      }),
  });
  registry.register({
    ...base,
    id: 'ticket.thread-view',
    risk: 'read',
    description:
      'Read your own or currently approved staff ticket metadata; current parent and private-thread access are rechecked.',
    schema: z.strictObject({ id: ticketId }),
    execute: async (ctx, input) => {
      ctx = await freshContext(ctx);
      const ticket = read(ctx, input.id);
      assertParticipant(ctx, ticket);
      await parent(ctx, ticket.parentChannelId);
      if (ticket.threadId) await exactThread(ctx, ticket);
      return ticket;
    },
  });
  registry.register({
    ...base,
    id: 'ticket.thread-list',
    risk: 'read',
    description:
      'List at most 100 recent own/current-staff thread tickets that remain visible. Does not list unrelated private threads.',
    schema: z.strictObject({ limit: z.number().int().min(1).max(100).default(25) }),
    execute: async (ctx, input) => {
      ctx = await freshContext(ctx);
      const result: ThreadTicket[] = [];
      for (const row of ctx.store
        .list<ThreadTicket>(records, `${ctx.guild.id}:`)
        .sort((a, b) => b.value.createdAt - a.value.createdAt)) {
        if (result.length >= input.limit) break;
        try {
          assertParticipant(ctx, row.value);
          await parent(ctx, row.value.parentChannelId);
          if (row.value.threadId) await exactThread(ctx, row.value);
          result.push(row.value);
        } catch {
          /* inaccessible records stay private */
        }
      }
      return result;
    },
  });
  registry.register({
    ...base,
    id: 'ticket.thread-close',
    description:
      'Owner or current approved staff privately lock and archive the exact ticket thread. Content is retained and the reservation is released only after success.',
    schema: z.strictObject({ id: ticketId }),
    execute: (ctx, input) =>
      withOpening(ctx.store, key(ctx.guild.id, read(ctx, input.id).userId), async () => {
        ctx = await freshContext(ctx);
        const ticket = read(ctx, input.id);
        assertParticipant(ctx, ticket);
        await parent(ctx, ticket.parentChannelId);
        const thread = await exactThread(ctx, ticket);
        if (ticket.state === 'closed' && thread.archived && thread.locked) return ticket;
        ticket.state = 'closing';
        save(ctx.store, ticket);
        try {
          await thread.edit({
            locked: true,
            archived: true,
            reason: 'Confirmed owner/staff private support ticket closure',
          });
          ticket.state = 'closed';
          ticket.closedAt = Date.now();
          delete ticket.lastError;
          ctx.store.transaction(() => {
            save(ctx.store, ticket);
            release(ctx.store, ticket);
          });
        } catch (error) {
          ticket.lastError = error instanceof Error ? error.name : 'Error';
          save(ctx.store, ticket);
          throw error;
        }
        return ticket;
      }),
  });
  registry.register({
    ...base,
    id: 'ticket.thread-reconcile',
    description:
      'Current approved staff attach an exact bot-owned private thread from an uncertain create. Manage Server may explicitly acknowledge no thread exists after reviewing active/archived inventory and waiting two minutes.',
    schema: z.strictObject({
      id: ticketId,
      outcome: z.enum(['created', 'not-created']),
      threadId: snowflake.optional(),
      reviewedServerState: z.literal(true),
    }),
    execute: (ctx, input) =>
      withOpening(ctx.store, key(ctx.guild.id, read(ctx, input.id).userId), async () => {
        ctx = await freshContext(ctx);
        const ticket = read(ctx, input.id);
        if (ticket.threadId || !['creating', 'needs-review'].includes(ticket.state))
          throw new UserError('Only an uncertain thread creation can be reconciled.');
        const channel = await parent(ctx, ticket.parentChannelId);
        if (input.outcome === 'created') {
          if (!ticket.staffUserIds.includes(ctx.member.id) || !isStaff(ctx, ctx.member))
            throw new UserError('A current approved staff member must reconcile a created thread.');
          if (!input.threadId) throw new UserError('Provide the real thread ID.');
          reviewedConfiguration(ctx, ticket);
          await exactThread(ctx, { ...ticket, threadId: input.threadId }, false);
          ticket.threadId = input.threadId;
          ticket.state = 'inviting';
          ticket.attempts = 0;
          ticket.retryAt = 0;
          save(ctx.store, ticket);
          if (!disabled(ctx.store, ctx.guild.id)) {
            const owner = await resolveMember(ctx, ticket.userId);
            try {
              await invite({ ...ctx, member: owner }, ticket);
            } catch (error) {
              failInvites(ctx.store, ticket, error, Date.now());
            }
          }
        } else {
          if (!ctx.member.permissions.has(P.ManageGuild))
            throw new UserError(
              'Manage Server and explicit manual inventory review are required to release an absent thread.',
            );
          if (Date.now() - ticket.createdAt < 120000)
            throw new UserError('Wait two minutes for the creation request to settle.');
          const [live, archived] = await Promise.all([
            channel.threads.fetchActive(),
            channel.threads.fetchArchived({ type: 'private', limit: 100 }),
          ]);
          if (
            [...live.threads.values(), ...archived.threads.values()].some(
              (thread) => thread.name === threadTicketName(ticket) && thread.ownerId === ticket.creatorBotId,
            )
          )
            throw new UserError('A matching private thread exists. Reconcile it as created.');
          if (archived.hasMore)
            throw new UserError(
              'Archived inventory exceeds the bounded review page. Inspect the unresolved reservation manually; it was not released.',
            );
          ticket.state = 'closed';
          ticket.closedAt = Date.now();
          ticket.lastError = 'Manually reviewed as not created';
          ctx.store.transaction(() => {
            save(ctx.store, ticket);
            release(ctx.store, ticket);
          });
        }
        return read(ctx, ticket.id);
      }),
  });
  registry.register({
    ...base,
    id: 'ticket.thread-transcript',
    risk: 'read',
    description:
      'Export a resumable private-ticket transcript with source IDs and attachment links. Current owner/staff, private membership and history permissions are checked for every page and after export.',
    schema: z.strictObject({
      id: ticketId,
      before: snowflake.optional(),
      after: snowflake.optional(),
      maxMessages: z.number().int().min(1).max(5000).default(1000),
    }),
    execute: async (ctx, input) => {
      ctx = await freshContext(ctx);
      const ticket = read(ctx, input.id);
      assertParticipant(ctx, ticket);
      await parent(ctx, ticket.parentChannelId);
      const thread = await exactThread(ctx, ticket);
      for (const principal of [ctx.member, ctx.guild.members.me!])
        if (!thread.permissionsFor(principal)?.has(P.ReadMessageHistory))
          throw new UserError('You and the bot need current message history permission.');
      const range = await readMessageRange(ctx, thread.id, input);
      ctx = await freshContext(ctx);
      assertParticipant(ctx, ticket);
      await parent(ctx, ticket.parentChannelId);
      const fresh = await exactThread(ctx, ticket);
      for (const principal of [ctx.member, ctx.guild.members.me!])
        if (!fresh.permissionsFor(principal)?.has(P.ReadMessageHistory))
          throw new UserError('History access changed during export.');
      const lines = [
        `Private ticket transcript ${ticket.id}`,
        `Subject: ${ticket.subject}`,
        range.notice,
        `Complete requested range: ${range.complete}. Continue before: ${range.nextBefore ?? 'none'}.`,
        ...range.messages.map(
          (message) =>
            `${message.createdAt} | ${message.userId} | ${message.id}\n${message.content}${message.attachments.map((file) => `\nAttachment: ${file.name} ${file.url}`).join('')}`,
        ),
      ];
      return {
        attachment: Buffer.from(lines.join('\n\n')),
        name: `thread-ticket-${ticket.id}.txt`,
        partial: range.partial,
        complete: range.complete,
        nextBefore: range.nextBefore,
        messageIds: range.messages.map((message) => message.id),
      };
    },
  });
}
export async function sweepThreadTicketTasks(
  client: Client,
  store: Store,
  now = Date.now(),
  allowedGuildIds: readonly string[] = [],
): Promise<void> {
  if (sweeping.has(store)) return;
  sweeping.add(store);
  const allowed = (guildId: string) => !allowedGuildIds.length || allowedGuildIds.includes(guildId);
  const deadline = Date.now() + 20000;
  try {
    for (const row of store.list<ThreadTicket>(records).filter((row) => allowed(row.value.guildId))) {
      const ticket = row.value;
      if (ticket.state === 'closed' && ticket.closedAt !== undefined && ticket.closedAt < now - 30 * DAY) {
        store.delete(records, row.key);
        continue;
      }
      if (ticket.state === 'creating' && !opening.get(store)?.has(key(ticket.guildId, ticket.userId))) {
        ticket.state = 'needs-review';
        ticket.lastError = 'InterruptedCreation';
        save(store, ticket);
      }
    }
    const due = store
      .list<ThreadTicket>(records)
      .filter(
        (row) =>
          allowed(row.value.guildId) &&
          row.value.state === 'inviting' &&
          row.value.retryAt <= now &&
          !disabled(store, row.value.guildId),
      )
      .sort((a, b) => a.value.retryAt - b.value.retryAt)
      .slice(0, 10);
    for (const row of due) {
      if (Date.now() >= deadline) break;
      if (opening.get(store)?.has(key(row.value.guildId, row.value.userId))) continue;
      await withOpening(store, key(row.value.guildId, row.value.userId), async () => {
        const ticket = store.get<ThreadTicket>(records, row.key);
        if (!ticket || ticket.state !== 'inviting') return;
        try {
          const guild = await client.guilds.fetch(ticket.guildId);
          const member = await guild.members.fetch({ user: ticket.userId, force: true });
          await guild.members.fetchMe({ force: true });
          await invite({ client, store, guild, member, channelId: ticket.parentChannelId }, ticket);
        } catch (error) {
          failInvites(store, ticket, error, now);
        }
      });
    }
    for (const row of store.list<number>('support.threadDaily'))
      if (row.key.slice(-10) < new Date(now - 31 * DAY).toISOString().slice(0, 10))
        store.delete('support.threadDaily', row.key);
  } finally {
    sweeping.delete(store);
  }
}
