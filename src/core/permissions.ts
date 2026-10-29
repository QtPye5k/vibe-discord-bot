import {
  ChannelType,
  PermissionFlagsBits as P,
  type GuildMember,
  type Role,
  type GuildBasedChannel,
} from 'discord.js';
import type { ActionContext } from './types.js';
import { UserError } from './errors.js';

export async function resolveChannel(ctx: ActionContext, id: string): Promise<GuildBasedChannel> {
  const channel = await ctx.guild.channels.fetch(id, { force: true });
  if (!channel || channel.guildId !== ctx.guild.id)
    throw new UserError('Channel does not belong to this server.');
  const bot = ctx.guild.members.me ?? (await ctx.guild.members.fetchMe());
  if (
    !channel.permissionsFor(ctx.member)?.has(P.ViewChannel) ||
    !channel.permissionsFor(bot)?.has(P.ViewChannel)
  )
    throw new UserError('Both you and the bot must be able to view that channel.');
  if (channel.type === ChannelType.PrivateThread)
    for (const principal of [ctx.member, bot]) {
      if (channel.permissionsFor(principal)?.has(P.ManageThreads)) continue;
      const participant = await channel.members.fetch(principal.id).catch(() => null);
      if (!participant)
        throw new UserError(
          principal.id === ctx.member.id
            ? 'You must belong to that private thread.'
            : 'The bot must belong to that private thread.',
        );
    }
  return channel;
}
export async function resolveMember(ctx: ActionContext, id: string): Promise<GuildMember> {
  const member = await ctx.guild.members.fetch({ user: id, force: true });
  if (member.guild.id !== ctx.guild.id) throw new UserError('Member does not belong to this server.');
  return member;
}
export async function resolveRole(ctx: ActionContext, id: string): Promise<Role> {
  const role = await ctx.guild.roles.fetch(id, { force: true });
  if (!role || role.guild.id !== ctx.guild.id) throw new UserError('Role does not belong to this server.');
  return role;
}
export function assertHierarchy(ctx: ActionContext, target: GuildMember): void {
  const bot = ctx.guild.members.me;
  if (!bot || target.id === ctx.guild.ownerId || target.id === ctx.member.id || target.id === bot.id)
    throw new UserError('Cannot target yourself, the server owner, or the bot.');
  if (
    ctx.member.id !== ctx.guild.ownerId &&
    ctx.member.roles.highest.comparePositionTo(target.roles.highest) <= 0
  )
    throw new UserError('Your highest role must be above the target member.');
  if (bot.roles.highest.comparePositionTo(target.roles.highest) <= 0)
    throw new UserError('The bot’s highest role must be above the target member.');
}
export function assertRoleHierarchy(ctx: ActionContext, role: Role): void {
  const bot = ctx.guild.members.me;
  if (!bot || role.managed || role.id === ctx.guild.id)
    throw new UserError('Managed and everyone roles cannot be changed here.');
  if (ctx.member.id !== ctx.guild.ownerId && ctx.member.roles.highest.comparePositionTo(role) <= 0)
    throw new UserError('Your highest role must be above the target role.');
  if (bot.roles.highest.comparePositionTo(role) <= 0)
    throw new UserError('That role is protected: it is at or above the bot’s highest role.');
}
export async function freshContext(ctx: ActionContext): Promise<ActionContext> {
  const [member] = await Promise.all([
    ctx.guild.members.fetch({ user: ctx.member.id, force: true }),
    ctx.guild.members.fetchMe({ force: true }),
  ]);
  return { ...ctx, member };
}
export async function assertPermissions(
  ctx: ActionContext,
  user: readonly bigint[],
  bot: readonly bigint[],
  input: unknown,
): Promise<void> {
  const params = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const ids = new Set<string>([ctx.channelId]);
  for (const [key, value] of Object.entries(params))
    if (/(?:channelId|ChannelId|parentId)$/.test(key) && typeof value === 'string') ids.add(value);
  const me = ctx.guild.members.me;
  if (!me) throw new UserError('Bot membership is unavailable.');
  // Channel grants can supply channel permissions absent from the base role. Global authority stays guild-scoped.
  const globalFlags = new Set<bigint>([
    P.Administrator,
    P.KickMembers,
    P.BanMembers,
    P.ManageGuild,
    P.ViewAuditLog,
    P.ManageRoles,
    P.ChangeNickname,
    P.ManageNicknames,
    P.ManageGuildExpressions,
    P.CreateGuildExpressions,
    P.ModerateMembers,
  ]);
  if (!ctx.member.permissions.has(user.filter((flag) => globalFlags.has(flag))))
    throw new UserError('You lack the required server permissions.');
  if (!me.permissions.has(bot.filter((flag) => globalFlags.has(flag))))
    throw new UserError('The bot lacks the required server permissions.');
  for (const id of ids) {
    const channel = await resolveChannel(ctx, id);
    if (!channel.permissionsFor(ctx.member)?.has([...user]))
      throw new UserError('You lack the required permissions in that channel.');
    if (!channel.permissionsFor(me)?.has([...bot]))
      throw new UserError('The bot lacks the required permissions in that channel.');
  }
}
