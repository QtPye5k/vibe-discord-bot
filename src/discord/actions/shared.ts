import {
  ChannelType,
  PermissionFlagsBits as P,
  PermissionsBitField,
  type GuildBasedChannel,
  type GuildTextBasedChannel,
  type GuildMember,
  type Role,
} from 'discord.js';
import { z } from 'zod';
import type { ActionContext } from '../../core/types.js';
import { UserError } from '../../core/errors.js';
import {
  resolveChannel,
  resolveMember,
  resolveRole,
  assertHierarchy,
  assertRoleHierarchy,
} from '../../core/permissions.js';

export { P, z, UserError, resolveChannel, resolveMember, resolveRole, assertHierarchy, assertRoleHierarchy };
export const id = z.string().regex(/^\d{17,20}$/, 'Expected a Discord snowflake ID');
export const reason = z.string().min(1).max(400).default('Requested through the bot');
export const empty = z.strictObject({});
export const permissionBits = z
  .string()
  .regex(/^\d{1,30}$/)
  .refine((v) => (BigInt(v) & ~PermissionsBitField.All) === 0n, 'Unknown permission bits');
export const imageData = z
  .string()
  .max(14_000_000)
  .regex(
    /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/,
    'Use a base64 image data URI; URLs and local paths are not accepted',
  );
export const nowReason = (ctx: ActionContext, text: string) =>
  `${text} [requested by ${ctx.member.id}]`.slice(0, 512);

export async function channelWith(
  ctx: ActionContext,
  channelId: string,
  permissions: bigint[] = [],
): Promise<GuildBasedChannel> {
  const channel = await resolveChannel(ctx, channelId);
  const me = ctx.guild.members.me ?? (await ctx.guild.members.fetchMe());
  for (const member of [ctx.member, me]) {
    const effective = channel.permissionsFor(member);
    if (!effective?.has([P.ViewChannel, ...permissions]))
      throw new UserError('You and the bot need access and the required permissions in that channel.');
  }
  if (channel.type === ChannelType.PrivateThread) {
    for (const member of [ctx.member, me]) {
      if (channel.permissionsFor(member)?.has(P.ManageThreads)) continue;
      const participant = await channel.members.fetch(member.id).catch(() => null);
      if (!participant) throw new UserError('Private thread access requires membership.');
    }
  }
  return channel;
}

export async function textWith(
  ctx: ActionContext,
  channelId: string,
  permissions: bigint[] = [],
): Promise<GuildTextBasedChannel> {
  const channel = await channelWith(ctx, channelId, permissions);
  if (!channel.isTextBased()) throw new UserError('This action requires a channel with messages.');
  return channel;
}

export async function sendChannel(ctx: ActionContext, channelId: string) {
  const channel = await textWith(ctx, channelId);
  await channelWith(ctx, channelId, [channel.isThread() ? P.SendMessagesInThreads : P.SendMessages]);
  if (!channel.isSendable()) throw new UserError('The bot cannot send messages in this channel.');
  return channel;
}

export async function editableChannel(ctx: ActionContext, channelId: string) {
  const channel = await channelWith(ctx, channelId, [P.ManageChannels]);
  if (channel.isThread()) throw new UserError('Use a thread action for thread settings.');
  return channel;
}

export async function checkedMember(ctx: ActionContext, memberId: string): Promise<GuildMember> {
  const target = await resolveMember(ctx, memberId);
  assertHierarchy(ctx, target);
  return target;
}

export async function checkedRole(ctx: ActionContext, roleId: string): Promise<Role> {
  const role = await resolveRole(ctx, roleId);
  assertRoleHierarchy(ctx, role);
  if (role.managed || role.id === ctx.guild.id)
    throw new UserError('Integration and everyone roles cannot be managed here.');
  return role;
}

export function assertGrantable(ctx: ActionContext, bits: bigint): void {
  const bot = ctx.guild.members.me;
  if (!bot) throw new UserError('Bot membership is unavailable.');
  if (!ctx.member.permissions.has(bits) || !bot.permissions.has(bits))
    throw new UserError('You and the bot may only grant permissions you currently possess.');
}

export function summarizeChannel(channel: GuildBasedChannel) {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId,
    ...(channel.isThread()
      ? { archived: channel.archived, locked: channel.locked }
      : { position: channel.position }),
  };
}

export function summarizeRole(role: Role) {
  return {
    id: role.id,
    name: role.name,
    colors: {
      primary: role.colors.primaryColor,
      secondary: role.colors.secondaryColor,
      tertiary: role.colors.tertiaryColor,
    },
    position: role.position,
    permissions: role.permissions.bitfield.toString(),
    managed: role.managed,
    hoist: role.hoist,
    mentionable: role.mentionable,
  };
}

export function summarizeMember(member: GuildMember) {
  return {
    id: member.id,
    username: member.user.username,
    displayName: member.displayName,
    joinedAt: member.joinedAt?.toISOString(),
    accountCreatedAt: member.user.createdAt.toISOString(),
    roles: [...member.roles.cache.keys()],
    timedOutUntil: member.communicationDisabledUntil?.toISOString(),
    bot: member.user.bot,
  };
}

export function validFuture(value: string): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && time > Date.now();
}
