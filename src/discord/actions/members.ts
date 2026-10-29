import { PermissionsBitField, type GuildMember } from 'discord.js';
import type { ActionRegistry } from '../../core/registry.js';
import { recordModerationCase } from '../../features/moderation-cases.js';
import {
  P,
  z,
  id,
  empty,
  reason,
  permissionBits,
  imageData,
  nowReason,
  checkedRole,
  checkedMember,
  assertGrantable,
  resolveMember,
  channelWith,
  summarizeRole,
  summarizeMember,
  UserError,
} from './shared.js';

export function registerRoleMemberActions(registry: ActionRegistry): void {
  registry.register({
    id: 'member.permissions-compare',
    category: 'permissions',
    risk: 'read',
    description:
      'Compare one member’s effective permissions across selected accessible channels, including added and missing permissions relative to the first.',
    schema: z.strictObject({ memberId: id, channelIds: z.array(id).min(2).max(25) }),
    userPermissions: [P.ManageRoles],
    botPermissions: [],
    execute: async (ctx, input) => {
      const member = await resolveMember(ctx, input.memberId),
        channels = [];
      for (const channelId of [...new Set(input.channelIds)]) {
        const channel = await channelWith(ctx, channelId),
          permissions = channel.permissionsFor(member);
        if (!permissions) throw new UserError('Member permissions unavailable.');
        channels.push({
          channelId,
          bitfield: permissions.bitfield.toString(),
          permissions: permissions.toArray(),
        });
      }
      const baseline = BigInt(channels[0]!.bitfield);
      return {
        memberId: member.id,
        baselineChannelId: channels[0]!.channelId,
        channels: channels.map((channel) => ({
          ...channel,
          added: new PermissionsBitField(BigInt(channel.bitfield) & ~baseline).toArray(),
          missing: new PermissionsBitField(baseline & ~BigInt(channel.bitfield)).toArray(),
        })),
      };
    },
  });
  registry.register({
    id: 'role.list',
    category: 'roles',
    description: 'Read server roles, colors, positions and permission bitsets.',
    schema: empty,
    userPermissions: [],
    botPermissions: [],
    risk: 'read',
    execute: async ({ guild }) => (await guild.roles.fetch()).map(summarizeRole),
  });
  registry.register({
    id: 'role.create',
    category: 'roles',
    description: 'Create a role with explicit permissions limited to your and the bot permissions.',
    schema: z.strictObject({
      name: z.string().min(1).max(100),
      color: z.number().int().min(0).max(0xffffff).default(0),
      permissions: permissionBits.default('0'),
      hoist: z.boolean().default(false),
      mentionable: z.boolean().default(false),
      reason,
    }),
    userPermissions: [P.ManageRoles],
    botPermissions: [P.ManageRoles],
    risk: 'write',
    execute: async (ctx, input) => {
      assertGrantable(ctx, BigInt(input.permissions));
      const role = await ctx.guild.roles.create({
        name: input.name,
        colors: { primaryColor: input.color },
        permissions: BigInt(input.permissions),
        hoist: input.hoist,
        mentionable: input.mentionable,
        reason: nowReason(ctx, input.reason),
      });
      return summarizeRole(role);
    },
  });
  registry.register({
    id: 'role.edit',
    category: 'roles',
    description: 'Edit role name, normal or enhanced colors, permissions, hoist and mentionability.',
    schema: z.strictObject({
      roleId: id,
      name: z.string().min(1).max(100).optional(),
      primaryColor: z.number().int().min(0).max(0xffffff).optional(),
      secondaryColor: z.number().int().min(0).max(0xffffff).nullable().optional(),
      tertiaryColor: z.number().int().min(0).max(0xffffff).nullable().optional(),
      permissions: permissionBits.optional(),
      hoist: z.boolean().optional(),
      mentionable: z.boolean().optional(),
      reason,
    }),
    userPermissions: [P.ManageRoles],
    botPermissions: [P.ManageRoles],
    risk: 'write',
    execute: async (
      ctx,
      { roleId, primaryColor, secondaryColor, tertiaryColor, reason: why, ...settings },
    ) => {
      const role = await checkedRole(ctx, roleId);
      if (settings.permissions !== undefined) assertGrantable(ctx, BigInt(settings.permissions));
      const colors =
        primaryColor !== undefined || secondaryColor !== undefined || tertiaryColor !== undefined
          ? {
              primaryColor: primaryColor ?? role.colors.primaryColor,
              secondaryColor,
              tertiaryColor,
            }
          : undefined;
      return summarizeRole(
        await role.edit({
          ...settings,
          permissions: settings.permissions !== undefined ? BigInt(settings.permissions) : undefined,
          colors,
          reason: nowReason(ctx, why),
        }),
      );
    },
  });
  registry.register({
    id: 'role.icon',
    category: 'roles',
    description: 'Set or clear a role icon using validated image data.',
    schema: z.strictObject({ roleId: id, image: imageData.nullable(), reason }),
    userPermissions: [P.ManageRoles],
    botPermissions: [P.ManageRoles],
    risk: 'write',
    execute: async (ctx, input) => {
      const role = await checkedRole(ctx, input.roleId);
      await role.setIcon(input.image, nowReason(ctx, input.reason));
      return { roleId: role.id, updated: true };
    },
  });
  registry.register({
    id: 'role.position',
    category: 'roles',
    description: 'Reorder a role strictly below your and the bot highest roles.',
    schema: z.strictObject({
      roleId: id,
      position: z.number().int().min(1).max(249),
      reason,
    }),
    userPermissions: [P.ManageRoles],
    botPermissions: [P.ManageRoles],
    risk: 'write',
    execute: async (ctx, input) => {
      const role = await checkedRole(ctx, input.roleId);
      const me = ctx.guild.members.me;
      if (
        !me ||
        input.position >= me.roles.highest.position ||
        (ctx.member.id !== ctx.guild.ownerId && input.position >= ctx.member.roles.highest.position)
      )
        throw new UserError('Requested role position exceeds your or the bot role hierarchy.');
      return summarizeRole(
        await role.setPosition(input.position, {
          reason: nowReason(ctx, input.reason),
        }),
      );
    },
  });
  registry.register({
    id: 'role.delete',
    category: 'roles',
    description: 'Permanently delete a manageable role.',
    schema: z.strictObject({ roleId: id, reason }),
    userPermissions: [P.ManageRoles],
    botPermissions: [P.ManageRoles],
    risk: 'destructive',
    execute: async (ctx, input) => {
      const role = await checkedRole(ctx, input.roleId);
      await role.delete(nowReason(ctx, input.reason));
      return { deletedRoleId: input.roleId };
    },
  });
  for (const operation of ['assign', 'remove'] as const)
    registry.register({
      id: `role.${operation}`,
      category: 'roles',
      description: `${operation === 'assign' ? 'Assign' : 'Remove'} one manageable role for a manageable member.`,
      schema: z.strictObject({ roleId: id, memberId: id, reason }),
      userPermissions: [P.ManageRoles],
      botPermissions: [P.ManageRoles],
      risk: 'write',
      execute: async (ctx, input) => {
        const role = await checkedRole(ctx, input.roleId),
          member = await checkedMember(ctx, input.memberId);
        if (operation === 'assign') {
          assertGrantable(ctx, role.permissions.bitfield);
          await member.roles.add(role, nowReason(ctx, input.reason));
        } else await member.roles.remove(role, nowReason(ctx, input.reason));
        return { memberId: member.id, roleId: role.id, operation };
      },
    });
  registry.register({
    id: 'role.assign-many',
    category: 'roles',
    description: 'Assign up to 10 validated roles to one manageable member in one operation.',
    schema: z.strictObject({
      roleIds: z.array(id).min(1).max(10),
      memberId: id,
      reason,
    }),
    userPermissions: [P.ManageRoles],
    botPermissions: [P.ManageRoles],
    risk: 'write',
    execute: async (ctx, input) => {
      const member = await checkedMember(ctx, input.memberId);
      for (const roleId of input.roleIds)
        assertGrantable(ctx, (await checkedRole(ctx, roleId)).permissions.bitfield);
      await member.roles.add(input.roleIds, nowReason(ctx, input.reason));
      return {
        memberId: member.id,
        assignedRoleIds: [...new Set(input.roleIds)],
      };
    },
  });
  registry.register({
    id: 'role.security-review',
    category: 'permissions',
    description: 'Report roles containing sensitive administrative permissions.',
    schema: empty,
    userPermissions: [P.ManageRoles],
    botPermissions: [],
    risk: 'read',
    execute: async ({ guild }) => {
      const dangerous = [
        P.Administrator,
        P.ManageGuild,
        P.ManageRoles,
        P.ManageChannels,
        P.ManageWebhooks,
        P.BanMembers,
        P.KickMembers,
        P.MentionEveryone,
      ];
      return (await guild.roles.fetch())
        .filter((role) => dangerous.some((bit) => role.permissions.has(bit, false)))
        .map((role) => ({
          ...summarizeRole(role),
          sensitivePermissions: new PermissionsBitField(
            role.permissions.bitfield & dangerous.reduce((a, b) => a | b, 0n),
          ).toArray(),
        }));
    },
  });
  registry.register({
    id: 'member.info',
    category: 'members',
    description: 'Read a current member profile, role IDs, join date and timeout status.',
    schema: z.strictObject({ memberId: id }),
    userPermissions: [],
    botPermissions: [],
    risk: 'read',
    execute: async (ctx, { memberId }) => summarizeMember(await resolveMember(ctx, memberId)),
  });
  registry.register({
    id: 'member.permissions',
    category: 'permissions',
    description: 'Calculate current server or accessible channel permissions for a member.',
    schema: z.strictObject({ memberId: id, channelId: id.optional() }),
    userPermissions: [],
    botPermissions: [],
    risk: 'read',
    execute: async (ctx, input) => {
      const member = await resolveMember(ctx, input.memberId);
      const permissions = input.channelId
        ? (await channelWith(ctx, input.channelId)).permissionsFor(member)
        : member.permissions;
      return {
        memberId: member.id,
        channelId: input.channelId ?? null,
        bitfield: permissions?.bitfield.toString(),
        permissions: permissions?.toArray(),
      };
    },
  });
  registry.register({
    id: 'member.nickname',
    category: 'members',
    description: 'Set or reset a manageable member nickname.',
    schema: z.strictObject({
      memberId: id,
      nickname: z.string().min(1).max(32).nullable(),
      reason,
    }),
    userPermissions: [P.ManageNicknames],
    botPermissions: [P.ManageNicknames],
    risk: 'write',
    execute: async (ctx, input) => {
      const member = await checkedMember(ctx, input.memberId);
      await member.setNickname(input.nickname, nowReason(ctx, input.reason));
      return { memberId: member.id, nickname: input.nickname };
    },
  });
  registry.register({
    id: 'member.kick',
    category: 'moderation',
    description: 'Kick a member after checking both user and bot role hierarchy.',
    schema: z.strictObject({ memberId: id, reason }),
    userPermissions: [P.KickMembers],
    botPermissions: [P.KickMembers],
    risk: 'destructive',
    execute: async (ctx, input) => {
      const member = await checkedMember(ctx, input.memberId);
      if (!member.kickable) throw new UserError('Discord reports that this member cannot be kicked.');
      await member.kick(nowReason(ctx, input.reason));
      return {
        kickedMemberId: input.memberId,
        caseId: recordModerationCase(ctx, 'kick', input.memberId, input.reason).id,
      };
    },
  });
  registry.register({
    id: 'member.ban',
    category: 'moderation',
    description: 'Ban a current member and optionally remove up to seven days of messages.',
    schema: z.strictObject({
      memberId: id,
      deleteMessageSeconds: z.number().int().min(0).max(604800).default(0),
      reason,
    }),
    userPermissions: [P.BanMembers],
    botPermissions: [P.BanMembers],
    risk: 'destructive',
    execute: async (ctx, input) => {
      const member = await checkedMember(ctx, input.memberId);
      if (!member.bannable) throw new UserError('Discord reports that this member cannot be banned.');
      await member.ban({
        deleteMessageSeconds: input.deleteMessageSeconds,
        reason: nowReason(ctx, input.reason),
      });
      return {
        bannedMemberId: member.id,
        caseId: recordModerationCase(ctx, 'ban', member.id, input.reason).id,
      };
    },
  });
  registry.register({
    id: 'member.bulk-ban',
    category: 'moderation',
    description: 'Ban up to 20 current manageable members with per-target hierarchy checks.',
    schema: z.strictObject({
      memberIds: z
        .array(id)
        .min(1)
        .max(20)
        .refine((ids) => new Set(ids).size === ids.length, 'Duplicate member IDs'),
      deleteMessageSeconds: z.number().int().min(0).max(604800).default(0),
      reason,
    }),
    userPermissions: [P.BanMembers],
    botPermissions: [P.BanMembers],
    risk: 'destructive',
    execute: async (ctx, input) => {
      const members: GuildMember[] = [];
      for (const memberId of input.memberIds) {
        const member = await checkedMember(ctx, memberId);
        if (!member.bannable) throw new UserError(`Member ${memberId} is not bannable.`);
        members.push(member);
      }
      const result = await ctx.guild.members.bulkBan(members, {
        deleteMessageSeconds: input.deleteMessageSeconds,
        reason: nowReason(ctx, input.reason),
      });
      const caseIds = result.bannedUsers.map(
        (userId) => recordModerationCase(ctx, 'ban', userId, input.reason, { bulk: true }).id,
      );
      return {
        bannedUserIds: result.bannedUsers,
        failedUserIds: result.failedUsers,
        caseIds,
      };
    },
  });
  registry.register({
    id: 'member.unban',
    category: 'moderation',
    description: 'Remove an existing server ban.',
    schema: z.strictObject({ userId: id, reason }),
    userPermissions: [P.BanMembers],
    botPermissions: [P.BanMembers],
    risk: 'write',
    execute: async (ctx, input) => {
      await ctx.guild.bans.remove(input.userId, nowReason(ctx, input.reason));
      return {
        unbannedUserId: input.userId,
        caseId: recordModerationCase(ctx, 'unban', input.userId, input.reason).id,
      };
    },
  });
  registry.register({
    id: 'member.bans',
    category: 'moderation',
    description: 'List up to 100 existing bans and reasons.',
    schema: z.strictObject({
      limit: z.number().int().min(1).max(100).default(25),
      before: id.optional(),
      after: id.optional(),
    }),
    userPermissions: [P.BanMembers],
    botPermissions: [P.BanMembers],
    risk: 'read',
    execute: async ({ guild }, input) =>
      (await guild.bans.fetch(input)).map((ban) => ({
        userId: ban.user.id,
        username: ban.user.username,
        reason: ban.reason,
      })),
  });
  registry.register({
    id: 'member.timeout',
    category: 'moderation',
    description: 'Apply or clear a communication timeout, up to Discord’s 28 day limit.',
    schema: z.strictObject({
      memberId: id,
      durationSeconds: z.number().int().min(0).max(2419200),
      reason,
    }),
    userPermissions: [P.ModerateMembers],
    botPermissions: [P.ModerateMembers],
    risk: 'write',
    execute: async (ctx, input) => {
      const member = await checkedMember(ctx, input.memberId);
      if (!member.moderatable) throw new UserError('Discord reports that this member cannot be timed out.');
      await member.timeout(
        input.durationSeconds === 0 ? null : input.durationSeconds * 1000,
        nowReason(ctx, input.reason),
      );
      return {
        memberId: member.id,
        timedOutUntil: member.communicationDisabledUntil?.toISOString() ?? null,
        caseId: recordModerationCase(
          ctx,
          input.durationSeconds ? 'timeout' : 'timeout-clear',
          member.id,
          input.reason,
          { durationSeconds: input.durationSeconds },
        ).id,
      };
    },
  });
  registry.register({
    id: 'member.voice-mute',
    category: 'voice',
    description: 'Server-mute or unmute a manageable member in an accessible voice channel.',
    schema: z.strictObject({ memberId: id, muted: z.boolean(), reason }),
    userPermissions: [P.MuteMembers],
    botPermissions: [P.MuteMembers],
    risk: 'write',
    execute: async (ctx, input) => {
      const member = await checkedMember(ctx, input.memberId);
      if (!member.voice.channelId) throw new UserError('Member is not in voice.');
      await channelWith(ctx, member.voice.channelId, [P.MuteMembers]);
      await member.voice.setMute(input.muted, nowReason(ctx, input.reason));
      return {
        memberId: member.id,
        muted: input.muted,
        caseId: recordModerationCase(
          ctx,
          input.muted ? 'voice-mute' : 'voice-unmute',
          member.id,
          input.reason,
        ).id,
      };
    },
  });
  registry.register({
    id: 'member.voice-deafen',
    category: 'voice',
    description: 'Server-deafen or undeafen a manageable member in an accessible voice channel.',
    schema: z.strictObject({ memberId: id, deafened: z.boolean(), reason }),
    userPermissions: [P.DeafenMembers],
    botPermissions: [P.DeafenMembers],
    risk: 'write',
    execute: async (ctx, input) => {
      const member = await checkedMember(ctx, input.memberId);
      if (!member.voice.channelId) throw new UserError('Member is not in voice.');
      await channelWith(ctx, member.voice.channelId, [P.DeafenMembers]);
      await member.voice.setDeaf(input.deafened, nowReason(ctx, input.reason));
      return {
        memberId: member.id,
        deafened: input.deafened,
        caseId: recordModerationCase(
          ctx,
          input.deafened ? 'voice-deafen' : 'voice-undeafen',
          member.id,
          input.reason,
        ).id,
      };
    },
  });
  registry.register({
    id: 'member.voice-move',
    category: 'voice',
    description: 'Move a manageable member between accessible voice channels or disconnect them.',
    schema: z.strictObject({ memberId: id, channelId: id.nullable(), reason }),
    userPermissions: [P.MoveMembers],
    botPermissions: [P.MoveMembers],
    risk: 'write',
    execute: async (ctx, input) => {
      const member = await checkedMember(ctx, input.memberId);
      if (!member.voice.channelId) throw new UserError('Member is not in voice.');
      await channelWith(ctx, member.voice.channelId, [P.MoveMembers]);
      if (input.channelId) {
        const target = await channelWith(ctx, input.channelId, [P.MoveMembers, P.Connect]);
        if (!target.isVoiceBased()) throw new UserError('Destination must be a voice or Stage channel.');
      }
      await member.voice.setChannel(input.channelId, nowReason(ctx, input.reason));
      return {
        memberId: member.id,
        channelId: input.channelId,
        caseId: recordModerationCase(
          ctx,
          input.channelId ? 'voice-move' : 'voice-disconnect',
          member.id,
          input.reason,
          { channelId: input.channelId },
        ).id,
      };
    },
  });
  registry.register({
    id: 'member.prune-count',
    category: 'members',
    description: 'Estimate how many inactive members Discord would prune; no members are removed.',
    schema: z.strictObject({
      days: z.number().int().min(1).max(30).default(7),
      roleIds: z.array(id).max(20).default([]),
    }),
    userPermissions: [P.KickMembers],
    botPermissions: [P.KickMembers],
    risk: 'read',
    execute: async (ctx, input) => {
      for (const roleId of input.roleIds) await checkedRole(ctx, roleId);
      return {
        count: await ctx.guild.members.prune({
          dry: true,
          days: input.days,
          roles: input.roleIds,
        }),
        days: input.days,
      };
    },
  });
}
