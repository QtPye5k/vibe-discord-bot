import { randomBytes } from 'node:crypto';
import { PermissionFlagsBits as P, type Client, type GuildMember } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import type { Store } from '../core/store.js';
import { UserError } from '../core/errors.js';
import { assertRoleHierarchy, freshContext, resolveChannel, resolveRole } from '../core/permissions.js';
import { assertOrdinaryRole } from '../core/safe-role.js';
const id = z.string().regex(/^\d{17,20}$/),
  slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  key = (guildId: string, eventId: string) => `${guildId}:${eventId}`;
interface Event {
  id: string;
  guildId: string;
  channelId: string;
  startsAt: number;
  endsAt: number;
  cancelled: boolean;
  rsvps: Record<string, { status: string }>;
}
interface RolePolicy {
  eventId: string;
  guildId: string;
  roleId: string;
  authorId: string;
  originChannelId: string;
  enabled: boolean;
  beforeMinutes: number;
  version: string;
  retryAt?: number;
  lastError?: string;
  grants: Record<
    string,
    { state: 'owned' | 'preexisting' | 'adding' | 'removing' | 'unknown'; at: number; lastError?: string }
  >;
}
function event(ctx: ActionContext, eventId: string) {
  const row = ctx.store.get<Event>('automation.calendar', key(ctx.guild.id, eventId));
  if (!row) throw new UserError('Calendar event does not exist.');
  return row;
}
function policy(ctx: ActionContext, eventId: string) {
  const row = ctx.store.get<RolePolicy>('automation.eventRoles', key(ctx.guild.id, eventId));
  if (!row) throw new UserError('Event role policy does not exist.');
  return row;
}
function enabled(store: Store, guildId: string) {
  return !(store.get<string[]>('core.disabled', guildId) ?? []).includes('automation');
}
function allowed(ctx: ActionContext) {
  const value = ctx.store.get<{ enabled: boolean; roleIds: string[]; channelIds: string[] }>(
    'core.actionPolicies',
    key(ctx.guild.id, 'eventroles.configure'),
  );
  return (
    !value ||
    (value.enabled &&
      (!value.roleIds.length || value.roleIds.some((id) => ctx.member.roles.cache.has(id))) &&
      (!value.channelIds.length || value.channelIds.includes(ctx.channelId)))
  );
}
export function registerEventRoleActions(registry: ActionRegistry) {
  const base = {
    category: 'automation',
    userPermissions: [P.ManageGuild, P.ManageRoles],
    botPermissions: [P.ManageRoles],
    risk: 'write' as const,
  };
  registry.register({
    ...base,
    id: 'eventroles.configure',
    description:
      'Synchronize an approved ordinary role to yes-RSVP participants during an event window; withdrawal/end removes only tracked bot-owned assignments.',
    schema: z.strictObject({
      eventId: slug,
      roleId: id,
      enabled: z.boolean().default(true),
      beforeMinutes: z.number().int().min(0).max(10080).default(0),
    }),
    execute: async (ctx, input) => {
      const source = event(ctx, input.eventId);
      await resolveChannel(ctx, source.channelId);
      const role = await resolveRole(ctx, input.roleId);
      assertRoleHierarchy(ctx, role);
      assertOrdinaryRole(role, ctx.guild.members.me!);
      const previous = ctx.store.get<RolePolicy>('automation.eventRoles', key(ctx.guild.id, input.eventId));
      if (previous && previous.roleId !== input.roleId && Object.keys(previous.grants).length)
        throw new UserError('Disable and reconcile the previous role assignments before changing roles.');
      if (!previous && ctx.store.list('automation.eventRoles', `${ctx.guild.id}:`).length >= 100)
        throw new UserError('Limit: 100 retained event role policies.');
      const row: RolePolicy = {
        ...input,
        guildId: ctx.guild.id,
        authorId: ctx.member.id,
        originChannelId: ctx.channelId,
        version: randomBytes(8).toString('hex'),
        grants: previous?.grants ?? {},
      };
      ctx.store.set('automation.eventRoles', key(ctx.guild.id, row.eventId), row);
      return row;
    },
  });
  registry.register({
    ...base,
    id: 'eventroles.view',
    risk: 'read',
    description:
      'Inspect an event role policy, confirmed bot-owned grants and ambiguous/manual ownership requiring review.',
    schema: z.strictObject({ eventId: slug }),
    execute: async (ctx, input) => {
      await resolveChannel(ctx, event(ctx, input.eventId).channelId);
      return policy(ctx, input.eventId);
    },
  });
  registry.register({
    ...base,
    id: 'eventroles.review',
    description:
      'Resolve one ambiguous event-role assignment after reviewing its ownership; preserving a manual role never removes it.',
    schema: z.strictObject({
      eventId: slug,
      userId: id,
      ownership: z.enum(['preserve', 'bot-owned']),
      reviewedOwnership: z.literal(true),
    }),
    execute: async (ctx, input) => {
      const row = policy(ctx, input.eventId);
      await resolveChannel(ctx, event(ctx, input.eventId).channelId);
      const member = await ctx.guild.members.fetch({ user: input.userId, force: true }),
        role = await resolveRole(ctx, row.roleId);
      assertRoleHierarchy(ctx, role);
      if (!row.grants[input.userId]) throw new UserError('No tracked assignment exists for this member.');
      if (['adding', 'removing'].includes(row.grants[input.userId]!.state))
        throw new UserError('Wait for the active role operation to settle before ownership review.');
      if (input.ownership === 'bot-owned' && !member.roles.cache.has(role.id))
        throw new UserError('That role is not currently assigned.');
      row.grants[input.userId] = {
        state: input.ownership === 'preserve' ? 'preexisting' : 'owned',
        at: Date.now(),
      };
      ctx.store.set('automation.eventRoles', key(ctx.guild.id, row.eventId), row);
      return row.grants[input.userId];
    },
  });
  registry.register({
    ...base,
    id: 'eventroles.remove',
    description:
      'Remove a disabled event-role policy after every tracked assignment has been reconciled; no manual roles are removed.',
    schema: z.strictObject({ eventId: slug }),
    execute: (ctx, input) => {
      const row = policy(ctx, input.eventId);
      if (row.enabled || Object.values(row.grants).some((grant) => grant.state !== 'preexisting'))
        throw new UserError('Disable the policy and wait for bot-owned role cleanup first.');
      ctx.store.delete('automation.eventRoles', key(ctx.guild.id, row.eventId));
      return { removed: true };
    },
  });
}
/** Manual role removal relinquishes ownership; it must not cause an automatic re-grant. */
export function observeEventRoleChange(before: GuildMember, after: GuildMember, store: Store) {
  for (const row of store.list<RolePolicy>('automation.eventRoles', `${after.guild.id}:`)) {
    const grant = row.value.grants[after.id];
    if (
      grant?.state === 'owned' &&
      before.roles.cache.has(row.value.roleId) &&
      !after.roles.cache.has(row.value.roleId)
    ) {
      grant.state = 'unknown';
      grant.lastError = 'RoleChangedOutsideActiveBotOperation';
      store.set('automation.eventRoles', row.key, row.value);
    }
  }
}
const sweeping = new WeakSet<Store>();
export async function sweepEventRoles(
  client: Client,
  store: Store,
  now = Date.now(),
  allowedGuildIds: readonly string[] = [],
) {
  if (sweeping.has(store)) return;
  sweeping.add(store);
  try {
    let processed = 0;
    const deadline = Date.now() + 15000;
    for (const { key: rowKey, value: row } of store.list<RolePolicy>('automation.eventRoles')) {
      if (processed >= 20 || Date.now() > deadline) break;
      if ((allowedGuildIds.length && !allowedGuildIds.includes(row.guildId)) || (row.retryAt ?? 0) > now)
        continue;
      const source = store.get<Event>('automation.calendar', key(row.guildId, row.eventId));
      const inWindow =
        !!source &&
        !source.cancelled &&
        source.startsAt - row.beforeMinutes * 60000 <= now &&
        source.endsAt > now;
      const wanted = new Set(
        inWindow && row.enabled && enabled(store, row.guildId)
          ? Object.entries(source!.rsvps)
              .filter(([, rsvp]) => rsvp.status === 'yes')
              .map(([id]) => id)
          : [],
      );
      const members = [...new Set([...Object.keys(row.grants), ...wanted])];
      for (const userId of members) {
        if (processed >= 20 || Date.now() > deadline) break;
        if (store.get<RolePolicy>('automation.eventRoles', rowKey)?.version !== row.version) break;
        const tracked = row.grants[userId];
        if (wanted.has(userId) && tracked) continue;
        if (!wanted.has(userId) && tracked?.state === 'preexisting') {
          delete row.grants[userId];
          store.set('automation.eventRoles', rowKey, row);
          continue;
        }
        if (tracked && ['adding', 'removing', 'unknown'].includes(tracked.state)) {
          if (tracked.state !== 'unknown') {
            tracked.state = 'unknown';
            tracked.lastError = 'InterruptedRoleMutation';
            store.set('automation.eventRoles', rowKey, row);
          }
          continue;
        }
        if (!wanted.has(userId) && !tracked) continue;
        processed++;
        try {
          const guild = await client.guilds.fetch(row.guildId),
            bot = await guild.members.fetchMe({ force: true });
          if (!bot.permissions.has(P.ManageRoles)) throw new UserError('Bot role management unavailable.');
          const member = await guild.members.fetch({ user: userId, force: true }).catch((error) => {
            if (error && typeof error === 'object' && 'code' in error && error.code === 10007) return null;
            throw error;
          });
          if (store.get<RolePolicy>('automation.eventRoles', rowKey)?.version !== row.version) break;
          if (!member) {
            delete row.grants[userId];
            store.set('automation.eventRoles', rowKey, row);
            continue;
          }
          const role = await guild.roles.fetch(row.roleId, { force: true });
          if (!role || role.managed || bot.roles.highest.comparePositionTo(role) <= 0)
            throw new UserError('The event role is not manageable.');
          if (wanted.has(userId)) {
            let ctx: ActionContext = {
              client,
              store,
              guild,
              member: await guild.members.fetch({ user: row.authorId, force: true }),
              channelId: row.originChannelId,
            };
            ctx = await freshContext(ctx);
            if (!ctx.member.permissions.has([P.ManageGuild, P.ManageRoles]) || !allowed(ctx))
              throw new UserError('The event role manager lost authority.');
            await resolveChannel(ctx, source!.channelId);
            assertRoleHierarchy(ctx, role);
            assertOrdinaryRole(role, bot);
            const latest = store.get<RolePolicy>('automation.eventRoles', rowKey),
              latestEvent = store.get<Event>('automation.calendar', key(row.guildId, row.eventId));
            if (
              latest?.version !== row.version ||
              !latest.enabled ||
              !enabled(store, row.guildId) ||
              latestEvent?.cancelled ||
              latestEvent?.rsvps[userId]?.status !== 'yes' ||
              latestEvent.endsAt <= Date.now()
            )
              continue;
            if (member.roles.cache.has(role.id)) {
              row.grants[userId] = { state: 'preexisting', at: now };
              store.set('automation.eventRoles', rowKey, row);
              continue;
            }
            row.grants[userId] = { state: 'adding', at: now };
            store.set('automation.eventRoles', rowKey, row);
            await member.roles.add(role, 'Confirmed event RSVP temporary role policy');
            const final = store.get<RolePolicy>('automation.eventRoles', rowKey);
            if (final?.roleId === row.roleId && final.grants[userId]?.state === 'adding') {
              final.grants[userId] = { state: 'owned', at: now };
              store.set('automation.eventRoles', rowKey, final);
              row.grants = final.grants;
            }
          } else {
            if (!member.roles.cache.has(role.id)) {
              delete row.grants[userId];
              store.set('automation.eventRoles', rowKey, row);
              continue;
            }
            row.grants[userId] = { state: 'removing', at: now };
            store.set('automation.eventRoles', rowKey, row);
            await member.roles.remove(
              role,
              'Event participation ended; expire original bot-managed assignment',
            );
            const final = store.get<RolePolicy>('automation.eventRoles', rowKey);
            if (final?.roleId === row.roleId && final.grants[userId]?.state === 'removing') {
              delete final.grants[userId];
              store.set('automation.eventRoles', rowKey, final);
              row.grants = final.grants;
            }
          }
        } catch (error) {
          const current = store.get<RolePolicy>('automation.eventRoles', rowKey);
          if (current?.version === row.version) {
            current.lastError = error instanceof Error ? error.name : 'Error';
            current.retryAt = now + 60000;
            if (current.grants[userId]) {
              current.grants[userId]!.lastError = current.lastError;
              if (['adding', 'removing'].includes(current.grants[userId]!.state))
                current.grants[userId]!.state = 'unknown';
            }
            store.set('automation.eventRoles', rowKey, current);
          }
          break;
        }
      }
    }
  } finally {
    sweeping.delete(store);
  }
}
