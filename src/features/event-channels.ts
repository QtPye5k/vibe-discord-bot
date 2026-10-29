import { randomBytes } from 'node:crypto';
import {
  ChannelType,
  GuildScheduledEventStatus,
  OverwriteType,
  PermissionFlagsBits as P,
  type Client,
  type GuildBasedChannel,
  type GuildScheduledEvent,
  type OverwriteResolvable,
} from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry, ActionPolicy } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import type { Store } from '../core/store.js';
import { UserError } from '../core/errors.js';
import { assertRoleHierarchy, freshContext, resolveChannel, resolveRole } from '../core/permissions.js';
import { assertOrdinaryRole } from '../core/safe-role.js';

const category = 'event-channels',
  namespace = 'eventChannels.policies',
  MINUTE = 60000;
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  snowflake = z.string().regex(/^\d{17,20}$/);
const managerPermissions = [P.ManageEvents, P.ManageChannels, P.ManageRoles];
const channelPermissions = [P.ViewChannel, P.ManageChannels, P.ManageRoles];
const openPermissions = [...channelPermissions, P.SendMessages, P.ReadMessageHistory];
const token = () => randomBytes(12).toString('hex');
const key = (guildId: string, policyId: string) => `${guildId}:${policyId}`;
type State = 'waiting' | 'creating' | 'needs-review' | 'open' | 'closing' | 'closed' | 'failed';
export interface EventChannelPolicy {
  id: string;
  guildId: string;
  eventId: string;
  parentCategoryId: string;
  visibilityRoleIds: string[];
  openBeforeMinutes: number;
  closeAfterMinutes: number;
  authorId: string;
  originChannelId: string;
  version: string;
  reservation: string;
  enabled: boolean;
  state: State;
  channelId?: string;
  attempts: number;
  retryAt: number;
  terminalAt?: number;
  lastError?: string;
}
export function eventChannelMarker(
  policy: Pick<EventChannelPolicy, 'id' | 'eventId' | 'reservation'>,
): string {
  return `Managed event channel ${policy.id}; event=${policy.eventId}; reservation=${policy.reservation}`;
}
function paused(store: Store, guildId: string): boolean {
  return (store.get<string[]>('core.disabled', guildId) ?? []).includes(category);
}
function current(store: Store, policy: EventChannelPolicy): boolean {
  const latest = store.get<EventChannelPolicy>(namespace, key(policy.guildId, policy.id));
  return latest?.enabled === true && latest.version === policy.version && !paused(store, policy.guildId);
}
function unchanged(store: Store, policy: EventChannelPolicy): void {
  if (store.get<EventChannelPolicy>(namespace, key(policy.guildId, policy.id))?.version !== policy.version)
    throw new UserError(
      'This lifecycle changed while authorizing the operation. Inspect its current state and retry.',
    );
}
function actionAllowed(ctx: ActionContext): void {
  const policy = ctx.store.get<ActionPolicy>('core.actionPolicies', `${ctx.guild.id}:eventchannel.configure`);
  if (
    policy &&
    (!policy.enabled ||
      (policy.roleIds.length && !policy.roleIds.some((roleId) => ctx.member.roles.cache.has(roleId))) ||
      (policy.channelIds.length && !policy.channelIds.includes(ctx.channelId)))
  )
    throw new UserError('The configuring action policy no longer authorizes this event lifecycle.');
}
async function authority(ctx: ActionContext, policy: EventChannelPolicy): Promise<ActionContext> {
  ctx = await freshContext(ctx);
  if (ctx.member.id !== policy.authorId || !ctx.member.permissions.has(managerPermissions))
    throw new UserError(
      'The configuring member needs current Manage Events, Manage Channels and Manage Roles.',
    );
  if (!ctx.guild.members.me?.permissions.has([P.ManageChannels, P.ManageRoles]))
    throw new UserError('The bot needs current Manage Channels and Manage Roles.');
  await resolveChannel(ctx, policy.originChannelId);
  const parent = await resolveChannel(ctx, policy.parentCategoryId);
  if (parent.type !== ChannelType.GuildCategory)
    throw new UserError('The configured parent must remain a category.');
  for (const principal of [ctx.member, ctx.guild.members.me!])
    if (!parent.permissionsFor(principal)?.has(openPermissions))
      throw new UserError(
        'The configuring member and bot need View Channel, Manage Channels and Manage Roles in the parent category.',
      );
  for (const roleId of policy.visibilityRoleIds) {
    const role = await resolveRole(ctx, roleId);
    assertRoleHierarchy(ctx, role);
    assertOrdinaryRole(role, ctx.guild.members.me!);
    if (!parent.permissionsFor(role)?.has(P.ViewChannel))
      throw new UserError('A selected ordinary role cannot currently view the parent category.');
  }
  actionAllowed(ctx);
  return ctx;
}
async function nativeEvent(ctx: ActionContext, eventId: string): Promise<GuildScheduledEvent> {
  const event = await ctx.guild.scheduledEvents.fetch({ guildScheduledEvent: eventId, force: true });
  if (!event || event.guildId !== ctx.guild.id || !Number.isFinite(event.scheduledStartTimestamp))
    throw new UserError('A current native scheduled event in this server is required.');
  return event;
}
const bits = (values: readonly bigint[]) => values.reduce((sum, value) => sum | value, 0n);
const sendBits = bits([
  P.SendMessages,
  P.SendMessagesInThreads,
  P.CreatePublicThreads,
  P.CreatePrivateThreads,
]);
export function eventChannelOverwrites(
  policy: EventChannelPolicy,
  botId: string,
  closed = false,
): OverwriteResolvable[] {
  const reader = bits([P.ViewChannel, P.ReadMessageHistory]);
  return [
    { id: policy.guildId, type: OverwriteType.Role, allow: 0n, deny: P.ViewChannel | sendBits },
    ...policy.visibilityRoleIds.map((roleId) => ({
      id: roleId,
      type: OverwriteType.Role,
      allow: closed ? 0n : reader | P.SendMessages,
      deny: closed ? P.ViewChannel | sendBits : sendBits & ~P.SendMessages,
    })),
    ...[policy.authorId, botId].map((memberId) => ({
      id: memberId,
      type: OverwriteType.Member,
      allow: reader | P.ManageChannels | P.ManageRoles | (closed ? 0n : P.SendMessages),
      deny: closed ? sendBits : sendBits & ~P.SendMessages,
    })),
  ];
}
function signature(
  values: readonly { id: string; type?: number; allow?: unknown; deny?: unknown }[],
): string {
  const bitfield = (value: unknown) =>
    String(value && typeof value === 'object' && 'bitfield' in value ? value.bitfield : (value ?? 0n));
  return JSON.stringify(
    values
      .map((value) => ({
        id: value.id,
        type: value.type,
        allow: bitfield(value.allow),
        deny: bitfield(value.deny),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}
async function ownedChannel(ctx: ActionContext, policy: EventChannelPolicy) {
  if (!policy.channelId) throw new UserError('The channel creation must be reconciled first.');
  const channel = await resolveChannel(ctx, policy.channelId);
  if (
    channel.type !== ChannelType.GuildText ||
    channel.parentId !== policy.parentCategoryId ||
    channel.topic !== eventChannelMarker(policy)
  )
    throw new UserError('The channel no longer matches this exact event reservation, type and parent.');
  for (const principal of [ctx.member, ctx.guild.members.me!])
    if (!channel.permissionsFor(principal)?.has(channelPermissions))
      throw new UserError('Current channel management access is unavailable.');
  return channel;
}
function inspectLayout(
  channel: GuildBasedChannel,
  policy: EventChannelPolicy,
  botId: string,
): 'open' | 'closed' {
  if (!('permissionOverwrites' in channel)) throw new UserError('Unsupported managed channel.');
  const actual = signature([...channel.permissionOverwrites.cache.values()]);
  if (actual === signature(eventChannelOverwrites(policy, botId) as Parameters<typeof signature>[0]))
    return 'open';
  if (actual === signature(eventChannelOverwrites(policy, botId, true) as Parameters<typeof signature>[0]))
    return 'closed';
  throw new UserError(
    'Channel permissions changed outside this lifecycle. Review the conflict manually; no permissions were replaced.',
  );
}
function save(store: Store, policy: EventChannelPolicy): void {
  store.set(namespace, key(policy.guildId, policy.id), policy);
}
const locks = new WeakMap<Store, Set<string>>();
async function locked<T>(store: Store, policyKey: string, execute: () => Promise<T>): Promise<T> {
  const active = locks.get(store) ?? new Set<string>();
  locks.set(store, active);
  if (active.has(policyKey))
    throw new UserError('This event lifecycle is busy. Try again after the current operation finishes.');
  active.add(policyKey);
  try {
    return await execute();
  } finally {
    active.delete(policyKey);
  }
}
function get(ctx: ActionContext, policyId: string): EventChannelPolicy {
  const policy = ctx.store.get<EventChannelPolicy>(namespace, key(ctx.guild.id, policyId));
  if (!policy) throw new UserError('Event channel policy not found in this server.');
  return policy;
}
export function registerEventChannelActions(registry: ActionRegistry): void {
  const base = {
    category,
    risk: 'write' as const,
    userPermissions: managerPermissions,
    botPermissions: [] as bigint[],
  };
  registry.register({
    ...base,
    id: 'eventchannel.configure',
    description:
      'Bind a native scheduled event to a private category-bound text channel that opens before the start and archives privately after its end/cancellation. No channel deletion.',
    schema: z.strictObject({
      id,
      eventId: snowflake,
      parentCategoryId: snowflake,
      visibilityRoleIds: z
        .array(snowflake)
        .max(20)
        .default([])
        .refine((values) => new Set(values).size === values.length, 'Role IDs must be unique.'),
      openBeforeMinutes: z.number().int().min(0).max(10080).default(30),
      closeAfterMinutes: z.number().int().min(0).max(10080).default(30),
    }),
    execute: (ctx, input) =>
      locked(ctx.store, key(ctx.guild.id, input.id), async () => {
        if (paused(ctx.store, ctx.guild.id))
          throw new UserError('Event channels are disabled in this server.');
        if (ctx.store.get(namespace, key(ctx.guild.id, input.id)))
          throw new UserError('Policy IDs cannot be replaced. Pause or reconcile the existing lifecycle.');
        if (
          ctx.store.list(namespace, `${ctx.guild.id}:`).length >= 25 ||
          ctx.store.list(namespace).length >= 500
        )
          throw new UserError('Event policy limit reached (25 per server / 500 total).');
        const policy: EventChannelPolicy = {
          ...input,
          guildId: ctx.guild.id,
          authorId: ctx.member.id,
          originChannelId: ctx.channelId,
          version: token(),
          reservation: token(),
          enabled: true,
          state: 'waiting',
          attempts: 0,
          retryAt: 0,
        };
        ctx = await authority(ctx, policy);
        const event = await nativeEvent(ctx, policy.eventId);
        if ([GuildScheduledEventStatus.Completed, GuildScheduledEventStatus.Canceled].includes(event.status))
          throw new UserError('Choose an upcoming or active event.');
        if (paused(ctx.store, ctx.guild.id))
          throw new UserError('Event channels were disabled during authorization.');
        if (
          ctx.store.list(namespace, `${ctx.guild.id}:`).length >= 25 ||
          ctx.store.list(namespace).length >= 500
        )
          throw new UserError('Event policy limit reached (25 per server / 500 total).');
        if (
          ctx.store
            .list<EventChannelPolicy>(namespace, `${ctx.guild.id}:`)
            .some((row) => row.value.eventId === policy.eventId && row.value.state !== 'closed')
        )
          throw new UserError('This native event already has a retained lifecycle.');
        save(ctx.store, policy);
        return policy;
      }),
  });
  registry.register({
    ...base,
    id: 'eventchannel.list',
    risk: 'read',
    description:
      'Inspect retained event lifecycle state, exact reservation markers and channel IDs. Does not expose channel messages.',
    schema: z.strictObject({}),
    execute: (ctx) =>
      ctx.store
        .list<EventChannelPolicy>(namespace, `${ctx.guild.id}:`)
        .map((row) => ({ ...row.value, marker: eventChannelMarker(row.value) })),
  });
  registry.register({
    ...base,
    id: 'eventchannel.pause',
    description:
      'Pause or resume this event lifecycle without deleting its channel or creation reservation. Pausing remains available while the module is disabled.',
    schema: z.strictObject({ id, paused: z.boolean() }),
    execute: async (ctx, input) => {
      ctx = await freshContext(ctx);
      if (!ctx.member.permissions.has(managerPermissions))
        throw new UserError('Current event/channel/role management permissions required.');
      if (input.paused) {
        const policy = get(ctx, input.id);
        policy.enabled = false;
        policy.version = token();
        save(ctx.store, policy);
        return { enabled: false, state: policy.state };
      }
      return locked(ctx.store, key(ctx.guild.id, input.id), async () => {
        const policy = get(ctx, input.id);
        await authority(
          {
            ...ctx,
            member: await ctx.guild.members.fetch({ user: policy.authorId, force: true }),
            channelId: policy.originChannelId,
          },
          policy,
        );
        unchanged(ctx.store, policy);
        if (policy.state === 'needs-review' || policy.state === 'creating')
          throw new UserError('Reconcile the uncertain creation before resuming.');
        policy.enabled = true;
        policy.version = token();
        save(ctx.store, policy);
        return { enabled: policy.enabled, state: policy.state };
      });
    },
  });
  registry.register({
    ...base,
    id: 'eventchannel.retry',
    description:
      'After reviewing a failed nonambiguous operation, reset its bounded attempts. Uncertain channel creations require reconciliation and cannot be retried.',
    schema: z.strictObject({ id }),
    execute: (ctx, input) =>
      locked(ctx.store, key(ctx.guild.id, input.id), async () => {
        const policy = get(ctx, input.id);
        if (policy.state !== 'failed')
          throw new UserError(
            'Only failed operations can be retried. Reconcile uncertain creations instead.',
          );
        await authority(
          {
            ...ctx,
            member: await ctx.guild.members.fetch({ user: policy.authorId, force: true }),
            channelId: policy.originChannelId,
          },
          policy,
        );
        unchanged(ctx.store, policy);
        policy.state = policy.channelId ? 'open' : 'waiting';
        policy.attempts = 0;
        policy.retryAt = 0;
        policy.version = token();
        delete policy.lastError;
        save(ctx.store, policy);
        return policy;
      }),
  });
  registry.register({
    ...base,
    id: 'eventchannel.remove',
    description:
      'Cancel an unopened waiting policy, or forget a closed archived lifecycle. Never deletes a channel or erases an uncertain creation reservation.',
    schema: z.strictObject({ id }),
    execute: (ctx, input) =>
      locked(ctx.store, key(ctx.guild.id, input.id), async () => {
        ctx = await freshContext(ctx);
        if (!ctx.member.permissions.has(managerPermissions))
          throw new UserError('Current event/channel/role management permissions required.');
        const policy = get(ctx, input.id);
        if (policy.state !== 'closed' && !(policy.state === 'waiting' && !policy.channelId))
          throw new UserError(
            'Pause active lifecycles; reconcile uncertain creations before removing a policy.',
          );
        return { removed: ctx.store.delete(namespace, key(ctx.guild.id, input.id)), channelPreserved: true };
      }),
  });
  registry.register({
    ...base,
    id: 'eventchannel.reconcile',
    description:
      'Attach the exact channel from an uncertain creation, or acknowledge no channel exists after reviewing all current guild channels. Never blindly repeats an uncertain create.',
    schema: z.strictObject({
      id,
      reservation: z.string().regex(/^[a-f0-9]{24}$/),
      outcome: z.enum(['created', 'not-created']),
      channelId: snowflake.optional(),
      reviewedServerState: z.literal(true),
    }),
    execute: (ctx, input) =>
      locked(ctx.store, key(ctx.guild.id, input.id), async () => {
        const policy = get(ctx, input.id);
        if (!['creating', 'needs-review'].includes(policy.state) || policy.reservation !== input.reservation)
          throw new UserError('No matching uncertain creation reservation.');
        ctx = await authority(
          {
            ...ctx,
            member: await ctx.guild.members.fetch({ user: policy.authorId, force: true }),
            channelId: policy.originChannelId,
          },
          policy,
        );
        if (input.outcome === 'created') {
          if (!input.channelId) throw new UserError('Provide the actual channel ID.');
          const channel = await ownedChannel(ctx, { ...policy, channelId: input.channelId });
          policy.state =
            inspectLayout(channel, policy, ctx.guild.members.me!.id) === 'closed' ? 'closed' : 'open';
          policy.channelId = channel.id;
        } else {
          if (Date.now() - policy.retryAt < 2 * MINUTE)
            throw new UserError(
              'Wait two minutes after the uncertain request before acknowledging no channel exists.',
            );
          const channels = await ctx.guild.channels.fetch();
          if (
            [...channels.values()].some(
              (channel) => channel && 'topic' in channel && channel.topic === eventChannelMarker(policy),
            )
          )
            throw new UserError('A matching channel exists. Reconcile it as created.');
          policy.state = 'waiting';
          policy.reservation = token();
        }
        unchanged(ctx.store, policy);
        policy.version = token();
        policy.attempts = 0;
        policy.retryAt = 0;
        delete policy.lastError;
        save(ctx.store, policy);
        return policy;
      }),
  });
}
const sweeping = new WeakSet<Store>();
export async function sweepEventChannelTasks(
  client: Client,
  store: Store,
  now = Date.now(),
  allowedGuildIds: readonly string[] = [],
): Promise<void> {
  if (sweeping.has(store)) return;
  sweeping.add(store);
  const deadline = Date.now() + 20000;
  try {
    const policies = store
      .list<EventChannelPolicy>(namespace)
      .filter(
        (row) =>
          row.value.enabled &&
          !paused(store, row.value.guildId) &&
          row.value.retryAt <= now &&
          !['closed', 'failed', 'needs-review'].includes(row.value.state) &&
          (!allowedGuildIds.length || allowedGuildIds.includes(row.value.guildId)),
      )
      .sort((a, b) => a.value.retryAt - b.value.retryAt)
      .slice(0, 10);
    for (const row of policies) {
      if (Date.now() >= deadline) break;
      if (locks.get(store)?.has(row.key)) continue;
      await locked(store, row.key, async () => {
        const policy = store.get<EventChannelPolicy>(namespace, row.key);
        if (!policy || !current(store, policy)) return;
        if (policy.state === 'creating') {
          policy.state = 'needs-review';
          policy.lastError = 'InterruptedCreation';
          save(store, policy);
          return;
        }
        try {
          const guild = await client.guilds.fetch(policy.guildId);
          const initial: ActionContext = {
            client,
            store,
            guild,
            member: { id: policy.authorId } as ActionContext['member'],
            channelId: policy.originChannelId,
          };
          const event = await nativeEvent(initial, policy.eventId);
          const ctx = await authority(initial, policy);
          if (!current(store, policy)) return;
          const terminal = [GuildScheduledEventStatus.Completed, GuildScheduledEventStatus.Canceled].includes(
            event.status,
          );
          if (terminal && !policy.terminalAt) {
            policy.terminalAt = now;
            save(store, policy);
          }
          const closeAt = terminal
            ? Math.min(policy.terminalAt!, event.scheduledEndTimestamp ?? Infinity) +
              policy.closeAfterMinutes * MINUTE
            : event.scheduledEndTimestamp === null
              ? Infinity
              : event.scheduledEndTimestamp + policy.closeAfterMinutes * MINUTE;
          if (!policy.channelId && (terminal || now >= closeAt)) {
            policy.state = 'closed';
            save(store, policy);
            return;
          }
          if (!policy.channelId) {
            if (now < event.scheduledStartTimestamp! - policy.openBeforeMinutes * MINUTE) {
              policy.retryAt = now + MINUTE;
              save(store, policy);
              return;
            }
            policy.state = 'creating';
            policy.retryAt = now;
            save(store, policy);
            try {
              const channel = await guild.channels.create({
                name: `event-${policy.id}`,
                type: ChannelType.GuildText,
                parent: policy.parentCategoryId,
                topic: eventChannelMarker(policy),
                permissionOverwrites: eventChannelOverwrites(policy, guild.members.me!.id),
                reason: 'Confirmed native event lifecycle policy',
              });
              const latest = store.get<EventChannelPolicy>(namespace, row.key);
              if (latest?.reservation === policy.reservation) {
                latest.channelId = channel.id;
                latest.state = 'open';
                latest.attempts = 0;
                latest.retryAt = now + MINUTE;
                save(store, latest);
              }
            } catch (error) {
              const latest = store.get<EventChannelPolicy>(namespace, row.key);
              if (latest?.reservation === policy.reservation) {
                latest.state = 'needs-review';
                latest.lastError = error instanceof Error ? error.name : 'Error';
                save(store, latest);
              }
            }
            return;
          }
          if (now < closeAt) {
            policy.retryAt = now + MINUTE;
            policy.attempts = 0;
            save(store, policy);
            return;
          }
          const channel = await ownedChannel(ctx, policy),
            layout = inspectLayout(channel, policy, guild.members.me!.id);
          if (!current(store, policy)) return;
          if (layout === 'closed') {
            policy.state = 'closed';
            save(store, policy);
            return;
          }
          policy.state = 'closing';
          save(store, policy);
          await channel.edit({
            name: `archived-event-${policy.id}`,
            permissionOverwrites: eventChannelOverwrites(policy, guild.members.me!.id, true),
            reason: 'Archive and privately lock completed native event channel; retain content',
          });
          if (current(store, policy)) {
            policy.state = 'closed';
            policy.attempts = 0;
            save(store, policy);
          }
        } catch (error) {
          if (!current(store, policy)) return;
          policy.attempts++;
          policy.lastError =
            error instanceof UserError
              ? error.message.slice(0, 250)
              : error instanceof Error
                ? error.name
                : 'Error';
          policy.retryAt = now + 30000 * 2 ** (policy.attempts - 1);
          if (policy.attempts >= 3) policy.state = 'failed';
          save(store, policy);
        }
      });
    }
  } finally {
    sweeping.delete(store);
  }
}
