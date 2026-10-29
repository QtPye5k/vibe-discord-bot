import { randomBytes } from 'node:crypto';
import { PermissionFlagsBits as P, type Client, type GuildMember, type PartialGuildMember } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import type { Store } from '../core/store.js';
import { UserError } from '../core/errors.js';
import {
  assertHierarchy,
  assertRoleHierarchy,
  resolveChannel,
  resolveMember,
  resolveRole,
} from '../core/permissions.js';
import { assertOrdinaryRole } from '../core/safe-role.js';
const id = z.string().regex(/^\d{17,20}$/),
  empty = z.strictObject({});
interface RolePolicy {
  roleIds: string[];
  authorId: string;
  channelId: string;
  version: string;
}
interface SavedRoles {
  enabled: boolean;
  roles: string[];
  savedAt: number;
}
interface RestoreJob {
  id: string;
  guildId: string;
  userId: string;
  roles: string[];
  version: string;
  attempts: number;
  retryAt: number;
  status: 'pending' | 'done' | 'failed';
}
const disabled = (store: Store, guildId: string) =>
  (store.get<string[]>('core.disabled', guildId) ?? []).includes('membership');
function ownKey(guildId: string, userId: string) {
  return `${guildId}:${userId}`;
}
export function registerMembershipActions(registry: ActionRegistry): void {
  const base = { category: 'membership', userPermissions: [], botPermissions: [], risk: 'write' as const };
  registry.register({
    ...base,
    id: 'membership.roles.configure',
    description:
      'Approve ordinary roles that consenting members may retain when they rejoin. Revalidates the configuring manager on restore.',
    userPermissions: [P.ManageGuild, P.ManageRoles],
    botPermissions: [P.ManageRoles],
    schema: z.strictObject({ roleIds: z.array(id).max(25) }),
    execute: async (ctx, input) => {
      for (const roleId of input.roleIds) {
        const role = await resolveRole(ctx, roleId);
        assertRoleHierarchy(ctx, role);
        assertOrdinaryRole(role, ctx.guild.members.me!);
      }
      const policy: RolePolicy = {
        ...input,
        authorId: ctx.member.id,
        channelId: ctx.channelId,
        version: randomBytes(8).toString('hex'),
      };
      ctx.store.set('membership.policy', ctx.guild.id, policy);
      return policy;
    },
  });
  registry.register({
    ...base,
    id: 'membership.roles.consent',
    description:
      'Opt yourself into or out of retaining approved ordinary roles after leaving and rejoining this server.',
    schema: z.strictObject({ enabled: z.boolean() }),
    execute: (ctx, input) => {
      const key = ownKey(ctx.guild.id, ctx.member.id);
      if (!input.enabled) {
        ctx.store.delete('membership.saved', key);
        ctx.store.delete('membership.restore', key);
        return { enabled: false, erased: true };
      }
      if (disabled(ctx.store, ctx.guild.id)) throw new UserError('Membership features are disabled.');
      const policy = ctx.store.get<RolePolicy>('membership.policy', ctx.guild.id);
      if (!policy) throw new UserError('A manager must configure approved retained roles first.');
      const saved: SavedRoles = {
        enabled: true,
        roles: policy.roleIds.filter((roleId) => ctx.member.roles.cache.has(roleId)),
        savedAt: Date.now(),
      };
      ctx.store.set('membership.saved', key, saved);
      return saved;
    },
  });
  registry.register({
    ...base,
    id: 'membership.roles.view',
    risk: 'read',
    description: 'Read your own saved-role consent, captured roles and last restoration result.',
    schema: empty,
    execute: (ctx) => ({
      saved: ctx.store.get('membership.saved', ownKey(ctx.guild.id, ctx.member.id)) ?? null,
      restore: ctx.store.get('membership.restore', ownKey(ctx.guild.id, ctx.member.id)) ?? null,
    }),
  });
  registry.register({
    ...base,
    id: 'membership.onboarding.configure',
    userPermissions: [P.ManageGuild],
    description:
      'Set a server onboarding DM template. Delivery requires the recipient’s existing personal-DM consent.',
    schema: z.strictObject({ text: z.string().min(1).max(1500) }),
    execute: (ctx, input) => {
      ctx.store.set('membership.onboarding', ctx.guild.id, input.text);
      return { configured: true };
    },
  });
  registry.register({
    ...base,
    id: 'membership.onboarding.start',
    description:
      'Send yourself the configured onboarding instructions using your previously approved personal DMs.',
    schema: empty,
    execute: async (ctx) => {
      const consent = ctx.store.get<{ enabled: boolean; dm: boolean; createdAt?: number; version?: string }>(
        'notifications.consent',
        ownKey(ctx.guild.id, ctx.member.id),
      );
      if (!consent?.enabled || !consent.dm)
        throw new UserError('Opt into personal DMs with notification.subscribe first.');
      if ((ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? []).includes('notifications'))
        throw new UserError('Notifications are disabled.');
      const notificationEpoch =
        ctx.store.get<number>('core.featureEpochs', `${ctx.guild.id}:notifications`) ?? 0;
      const membershipEpoch = ctx.store.get<number>('core.featureEpochs', `${ctx.guild.id}:membership`) ?? 0;
      const text = ctx.store.get<string>('membership.onboarding', ctx.guild.id);
      if (!text) throw new UserError('Onboarding instructions are not configured.');
      const dm = await ctx.member.createDM();
      const fresh = ctx.store.get<typeof consent>(
        'notifications.consent',
        ownKey(ctx.guild.id, ctx.member.id),
      );
      if (
        !fresh?.enabled ||
        !fresh.dm ||
        fresh.createdAt !== consent.createdAt ||
        fresh.version !== consent.version ||
        disabled(ctx.store, ctx.guild.id) ||
        (ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? []).includes('notifications') ||
        (ctx.store.get<number>('core.featureEpochs', `${ctx.guild.id}:notifications`) ?? 0) !==
          notificationEpoch ||
        (ctx.store.get<number>('core.featureEpochs', `${ctx.guild.id}:membership`) ?? 0) !== membershipEpoch
      )
        throw new UserError('Onboarding delivery was cancelled.');
      await dm.send({
        content: text.replaceAll('{server}', ctx.guild.name).replaceAll('{user}', `<@${ctx.member.id}>`),
        allowedMentions: { parse: [] },
      });
      return { sent: true };
    },
  });
}
/** Capture only roles approved by a manager and only for an opted-in departing member. */
export function rememberDepartingRoles(member: GuildMember | PartialGuildMember, store: Store): void {
  const key = ownKey(member.guild.id, member.id),
    saved = store.get<SavedRoles>('membership.saved', key);
  if (!saved?.enabled || disabled(store, member.guild.id)) return;
  const policy = store.get<RolePolicy>('membership.policy', member.guild.id);
  if (!policy) return;
  store.set('membership.saved', key, {
    enabled: true,
    roles: policy.roleIds.filter((roleId) => member.roles.cache.has(roleId)),
    savedAt: Date.now(),
  } satisfies SavedRoles);
}
export function queueRejoinRoles(member: GuildMember, store: Store): void {
  const key = ownKey(member.guild.id, member.id),
    saved = store.get<SavedRoles>('membership.saved', key),
    policy = store.get<RolePolicy>('membership.policy', member.guild.id);
  if (!saved?.enabled || !policy || disabled(store, member.guild.id)) return;
  store.set('membership.restore', key, {
    id: randomBytes(8).toString('hex'),
    guildId: member.guild.id,
    userId: member.id,
    roles: saved.roles.filter((roleId) => policy.roleIds.includes(roleId)),
    version: policy.version,
    attempts: 0,
    retryAt: 0,
    status: 'pending',
  } satisfies RestoreJob);
}
const running = new WeakSet<Store>();
export async function sweepMembershipTasks(
  client: Client,
  store: Store,
  now = Date.now(),
  allowedGuildIds: readonly string[] = [],
): Promise<void> {
  if (running.has(store)) return;
  running.add(store);
  try {
    const jobs = store
      .list<RestoreJob>('membership.restore')
      .filter(
        (row) =>
          row.value.status === 'pending' &&
          row.value.retryAt <= now &&
          (!allowedGuildIds.length || allowedGuildIds.includes(row.value.guildId)) &&
          !disabled(store, row.value.guildId),
      )
      .slice(0, 10);
    for (const row of jobs) {
      const job = row.value,
        policy = store.get<RolePolicy>('membership.policy', job.guildId);
      const current = () => {
        const saved = store.get<SavedRoles>('membership.saved', row.key),
          latest = store.get<RestoreJob>('membership.restore', row.key);
        return (
          saved?.enabled &&
          store.get<RolePolicy>('membership.policy', job.guildId)?.version === job.version &&
          !disabled(store, job.guildId) &&
          latest?.status === 'pending' &&
          latest.id === job.id
        );
      };
      if (!policy || !current()) {
        store.delete('membership.restore', row.key);
        continue;
      }
      try {
        const guild = await client.guilds.fetch(job.guildId),
          actor = await guild.members.fetch({ user: policy.authorId, force: true });
        await guild.members.fetchMe({ force: true });
        if (
          !actor.permissions.has([P.ManageGuild, P.ManageRoles]) ||
          !guild.members.me?.permissions.has(P.ManageRoles)
        )
          throw new UserError('Restoration manager or bot lost role permissions.');
        const ctx: ActionContext = { client, store, guild, member: actor, channelId: policy.channelId };
        await resolveChannel(ctx, policy.channelId);
        const target = await resolveMember(ctx, job.userId);
        assertHierarchy(ctx, target);
        for (const roleId of job.roles) {
          const role = await resolveRole(ctx, roleId);
          assertRoleHierarchy(ctx, role);
          assertOrdinaryRole(role, guild.members.me!);
          if (!current()) throw new UserError('Restoration was cancelled.');
          if (!target.roles.cache.has(roleId))
            await target.roles.add(role, 'Consented restoration of an approved rejoin role');
        }
        if (current()) store.set('membership.restore', row.key, { ...job, status: 'done', retryAt: now });
      } catch {
        if (current())
          store.set('membership.restore', row.key, {
            ...job,
            attempts: job.attempts + 1,
            status: job.attempts >= 2 ? 'failed' : 'pending',
            retryAt: now + 60000 * 2 ** job.attempts,
          });
      }
    }
    for (const row of store.list<RestoreJob>('membership.restore'))
      if (row.value.status !== 'pending' && row.value.retryAt < now - 7 * 86400000)
        store.delete('membership.restore', row.key);
  } finally {
    running.delete(store);
  }
}
