import { ChannelType, OverwriteType, type PermissionOverwriteOptions } from 'discord.js';
import type { ActionRegistry } from '../../core/registry.js';
import {
  P,
  z,
  id,
  empty,
  reason,
  nowReason,
  channelWith,
  editableChannel,
  summarizeChannel,
  permissionBits,
  checkedRole,
  checkedMember,
  assertGrantable,
  UserError,
} from './shared.js';

const channelTypes = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement,
  stage: ChannelType.GuildStageVoice,
  forum: ChannelType.GuildForum,
  media: ChannelType.GuildMedia,
} as const;
const tags = z
  .array(
    z.strictObject({
      id: id.optional(),
      name: z.string().min(1).max(20),
      moderated: z.boolean().default(false),
      emoji: z
        .strictObject({
          id: id.nullable().default(null),
          name: z.string().max(32).nullable().default(null),
        })
        .nullable()
        .optional(),
    }),
  )
  .max(20);

export function registerChannelActions(registry: ActionRegistry): void {
  registry.register({
    id: 'channel.list',
    category: 'channels',
    description: 'List channels accessible to both you and the bot.',
    schema: empty,
    userPermissions: [],
    botPermissions: [],
    risk: 'read',
    execute: async (ctx) =>
      (await ctx.guild.channels.fetch())
        .filter(
          (channel) =>
            !!channel &&
            !!channel.permissionsFor(ctx.member)?.has(P.ViewChannel) &&
            !!channel.permissionsFor(ctx.guild.members.me!)?.has(P.ViewChannel),
        )
        .map((channel) => channel && summarizeChannel(channel)),
  });
  registry.register({
    id: 'channel.info',
    category: 'channels',
    description: 'Read channel metadata and permission overwrites.',
    schema: z.strictObject({ channelId: id }),
    userPermissions: [],
    botPermissions: [],
    risk: 'read',
    execute: async (ctx, { channelId }) => {
      const channel = await channelWith(ctx, channelId);
      return {
        ...summarizeChannel(channel),
        ...(!channel.isThread()
          ? {
              overwrites: channel.permissionOverwrites.cache.map((o) => ({
                id: o.id,
                type: o.type,
                allow: o.allow.bitfield.toString(),
                deny: o.deny.bitfield.toString(),
              })),
              topic: 'topic' in channel ? channel.topic : null,
              nsfw: 'nsfw' in channel ? channel.nsfw : false,
            }
          : {}),
      };
    },
  });
  registry.register({
    id: 'channel.create',
    category: 'channels',
    description: 'Create text, voice, category, announcement, Stage, forum or media channels.',
    schema: z.strictObject({
      name: z.string().min(1).max(100),
      type: z.enum(['text', 'voice', 'category', 'announcement', 'stage', 'forum', 'media']),
      parentId: id.optional(),
      topic: z.string().max(1024).optional(),
      nsfw: z.boolean().optional(),
      reason,
    }),
    userPermissions: [P.ManageChannels],
    botPermissions: [P.ManageChannels],
    risk: 'write',
    execute: async (ctx, input) => {
      if (input.parentId) {
        const parent = await channelWith(ctx, input.parentId, [P.ManageChannels]);
        if (parent.type !== ChannelType.GuildCategory) throw new UserError('Parent must be a category.');
      }
      const channel = await ctx.guild.channels.create({
        name: input.name,
        type: channelTypes[input.type],
        parent: input.parentId,
        topic: input.topic,
        nsfw: input.nsfw,
        reason: nowReason(ctx, input.reason),
      });
      return summarizeChannel(channel);
    },
  });
  registry.register({
    id: 'channel.private-create',
    category: 'channels',
    description: 'Create a private text or voice channel for specified existing members.',
    schema: z.strictObject({
      name: z.string().min(1).max(100),
      type: z.enum(['text', 'voice']).default('text'),
      memberIds: z.array(id).min(1).max(20),
      parentId: id.optional(),
      reason,
    }),
    userPermissions: [P.ManageChannels, P.ManageRoles],
    botPermissions: [P.ManageChannels, P.ManageRoles],
    risk: 'write',
    execute: async (ctx, input) => {
      if (input.parentId) {
        const parent = await channelWith(ctx, input.parentId, [P.ManageChannels]);
        if (parent.type !== ChannelType.GuildCategory) throw new UserError('Parent must be a category.');
      }
      assertGrantable(
        ctx,
        P.ViewChannel |
          P.SendMessages |
          P.ReadMessageHistory |
          (input.type === 'voice' ? P.Connect | P.Speak : 0n),
      );
      const ids = [...new Set([...input.memberIds, ctx.member.id, ctx.client.user!.id])];
      for (const memberId of input.memberIds) await ctx.guild.members.fetch(memberId);
      const channel = await ctx.guild.channels.create({
        name: input.name,
        type: channelTypes[input.type],
        parent: input.parentId,
        permissionOverwrites: [
          { id: ctx.guild.id, deny: [P.ViewChannel] },
          ...ids.map((memberId) => ({
            id: memberId,
            type: OverwriteType.Member,
            allow: [
              P.ViewChannel,
              P.SendMessages,
              P.ReadMessageHistory,
              ...(input.type === 'voice' ? [P.Connect, P.Speak] : []),
            ],
          })),
        ],
        reason: nowReason(ctx, input.reason),
      });
      return summarizeChannel(channel);
    },
  });
  registry.register({
    id: 'channel.edit',
    category: 'channels',
    description: 'Edit channel names, topics, slowmode, age restriction, bitrate, limits and region.',
    schema: z.strictObject({
      channelId: id,
      name: z.string().min(1).max(100).optional(),
      topic: z.string().max(4096).nullable().optional(),
      nsfw: z.boolean().optional(),
      rateLimitPerUser: z.number().int().min(0).max(21600).optional(),
      bitrate: z.number().int().min(8000).max(384000).optional(),
      userLimit: z.number().int().min(0).max(99).optional(),
      rtcRegion: z.string().max(32).nullable().optional(),
      defaultAutoArchiveDuration: z
        .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
        .optional(),
      defaultThreadRateLimitPerUser: z.number().int().min(0).max(21600).optional(),
      videoQualityMode: z.union([z.literal(1), z.literal(2)]).optional(),
      availableTags: tags.optional(),
      defaultReactionEmoji: z
        .strictObject({ id: id.nullable().default(null), name: z.string().max(100).nullable().default(null) })
        .nullable()
        .optional(),
      defaultSortOrder: z
        .union([z.literal(0), z.literal(1)])
        .nullable()
        .optional(),
      defaultForumLayout: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
      reason,
    }),
    userPermissions: [P.ManageChannels],
    botPermissions: [P.ManageChannels],
    risk: 'write',
    execute: async (ctx, { channelId, reason: why, ...options }) => {
      const channel = await editableChannel(ctx, channelId);
      if (!Object.keys(options).length) throw new UserError('Provide at least one setting.');
      return summarizeChannel(await channel.edit({ ...options, reason: nowReason(ctx, why) }));
    },
  });
  registry.register({
    id: 'channel.move',
    category: 'channels',
    description: 'Move a channel into a category and optionally synchronize its permissions.',
    schema: z.strictObject({
      channelId: id,
      parentId: id.nullable(),
      syncPermissions: z.boolean().default(false),
      reason,
    }),
    userPermissions: [P.ManageChannels, P.ManageRoles],
    botPermissions: [P.ManageChannels, P.ManageRoles],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await editableChannel(ctx, input.channelId);
      if (input.parentId) {
        const parent = await channelWith(ctx, input.parentId, [P.ManageChannels]);
        if (parent.type !== ChannelType.GuildCategory) throw new UserError('Parent must be a category.');
      }
      return summarizeChannel(
        await channel.setParent(input.parentId, {
          lockPermissions: input.syncPermissions,
          reason: nowReason(ctx, input.reason),
        }),
      );
    },
  });
  registry.register({
    id: 'channel.position',
    category: 'channels',
    description: 'Reorder a channel or category.',
    schema: z.strictObject({
      channelId: id,
      position: z.number().int().min(0).max(499),
      reason,
    }),
    userPermissions: [P.ManageChannels],
    botPermissions: [P.ManageChannels],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await editableChannel(ctx, input.channelId);
      return summarizeChannel(
        await channel.setPosition(input.position, {
          reason: nowReason(ctx, input.reason),
        }),
      );
    },
  });
  registry.register({
    id: 'channel.clone',
    category: 'channels',
    description: 'Clone one accessible channel including its supported settings.',
    schema: z.strictObject({
      channelId: id,
      name: z.string().min(1).max(100).optional(),
      reason,
    }),
    userPermissions: [P.ManageChannels, P.ManageRoles],
    botPermissions: [P.ManageChannels, P.ManageRoles],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await editableChannel(ctx, input.channelId);
      return summarizeChannel(
        await channel.clone({
          name: input.name,
          reason: nowReason(ctx, input.reason),
        }),
      );
    },
  });
  registry.register({
    id: 'channel.delete',
    category: 'channels',
    description: 'Permanently delete an accessible channel and its Discord contents.',
    schema: z.strictObject({ channelId: id, reason }),
    userPermissions: [P.ManageChannels],
    botPermissions: [P.ManageChannels],
    risk: 'destructive',
    execute: async (ctx, input) => {
      const channel = await editableChannel(ctx, input.channelId);
      await channel.delete(nowReason(ctx, input.reason));
      return { deletedChannelId: input.channelId };
    },
  });
  registry.register({
    id: 'channel.overwrite',
    category: 'permissions',
    description: 'Set explicit allow and deny permissions for one role or member.',
    schema: z.strictObject({
      channelId: id,
      targetId: id,
      targetType: z.enum(['role', 'member']),
      allow: permissionBits,
      deny: permissionBits,
      reason,
    }),
    userPermissions: [P.ManageRoles],
    botPermissions: [P.ManageRoles],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await channelWith(ctx, input.channelId, [P.ManageRoles]);
      if (channel.isThread()) throw new UserError('Threads inherit permission overwrites from their parent.');
      if (input.targetType === 'role' && input.targetId !== ctx.guild.id)
        await checkedRole(ctx, input.targetId);
      if (input.targetType === 'member') await checkedMember(ctx, input.targetId);
      const allow = BigInt(input.allow),
        deny = BigInt(input.deny);
      if (allow & deny) throw new UserError('A permission cannot be both allowed and denied.');
      assertGrantable(ctx, allow);
      const options = Object.fromEntries(
        Object.entries(P).map(([name, bit]) => [
          name,
          (allow & bit) !== 0n ? true : (deny & bit) !== 0n ? false : null,
        ]),
      ) as PermissionOverwriteOptions;
      await channel.permissionOverwrites.create(input.targetId, options, {
        type: input.targetType === 'role' ? OverwriteType.Role : OverwriteType.Member,
        reason: nowReason(ctx, input.reason),
      });
      return {
        channelId: channel.id,
        targetId: input.targetId,
        allow: input.allow,
        deny: input.deny,
      };
    },
  });
  registry.register({
    id: 'channel.overwrite-delete',
    category: 'permissions',
    description: 'Remove a member or role channel overwrite.',
    schema: z.strictObject({
      channelId: id,
      targetId: id,
      targetType: z.enum(['role', 'member']),
      reason,
    }),
    userPermissions: [P.ManageRoles],
    botPermissions: [P.ManageRoles],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await channelWith(ctx, input.channelId, [P.ManageRoles]);
      if (channel.isThread()) throw new UserError('Threads have no independent overwrites.');
      if (input.targetType === 'role' && input.targetId !== ctx.guild.id)
        await checkedRole(ctx, input.targetId);
      if (input.targetType === 'member') await checkedMember(ctx, input.targetId);
      await channel.permissionOverwrites.delete(input.targetId, nowReason(ctx, input.reason));
      return { removed: true };
    },
  });
  registry.register({
    id: 'channel.lock',
    category: 'security',
    risk: 'destructive',
    description:
      'Lock ordinary members across every explicit overwrite, preserving the caller/bot and a complete conflict-aware restoration snapshot.',
    schema: z.strictObject({ channelId: id, reason }),
    userPermissions: [P.ManageChannels, P.ManageRoles],
    botPermissions: [P.ManageChannels, P.ManageRoles],
    execute: async (ctx, input) => {
      const channel = await channelWith(ctx, input.channelId, [P.ManageChannels, P.ManageRoles]);
      if (channel.isThread()) throw new UserError('Lock a thread using thread.edit instead.');
      const key = `${ctx.guild.id}:${channel.id}`;
      if (ctx.store.get('discord.channel-locks', key))
        throw new UserError('A saved lock already exists; unlock it before locking again.');
      const mask = P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads;
      const before = Array.from(channel.permissionOverwrites.cache, ([id, overwrite]) => ({
        id,
        type: overwrite.type ?? OverwriteType.Role,
        allow: overwrite.allow.bitfield.toString(),
        deny: overwrite.deny.bitfield.toString(),
      })).sort((a, b) => a.id.localeCompare(b.id));
      const applied = before.map((row) => ({
        ...row,
        allow: (BigInt(row.allow) & ~mask).toString(),
        deny: (BigInt(row.deny) | mask).toString(),
      }));
      if (!applied.some((row) => row.id === ctx.guild.id))
        applied.push({ id: ctx.guild.id, type: OverwriteType.Role, allow: '0', deny: mask.toString() });
      for (const principal of [ctx.member, ctx.guild.members.me!]) {
        const granted = (channel.permissionsFor(principal)?.bitfield ?? 0n) & mask;
        const existing = before.find((row) => row.id === principal.id),
          index = applied.findIndex((row) => row.id === principal.id);
        const row = {
          id: principal.id,
          type: OverwriteType.Member,
          allow: ((BigInt(existing?.allow ?? '0') & ~mask) | granted).toString(),
          deny: ((BigInt(existing?.deny ?? '0') & ~mask) | (mask & ~granted)).toString(),
        };
        if (index < 0) applied.push(row);
        else applied[index] = row;
      }
      applied.sort((a, b) => a.id.localeCompare(b.id));
      if (applied.length > 100) throw new UserError('Locking would exceed Discord’s overwrite capacity.');
      const snapshot = { version: 2 as const, before, applied, state: 'applying', createdAt: Date.now() };
      ctx.store.set('discord.channel-locks', key, snapshot);
      await channel.permissionOverwrites.set(
        applied.map((row) => ({ ...row, allow: BigInt(row.allow), deny: BigInt(row.deny) })),
        nowReason(ctx, input.reason),
      );
      ctx.store.set('discord.channel-locks', key, { ...snapshot, state: 'applied' });
      return {
        channelId: channel.id,
        locked: true,
        exemptUserIds: [ctx.member.id, ctx.guild.members.me!.id],
        notice:
          'Discord Administrators always bypass overwrites. Uncertain writes retain this snapshot for reconciliation through channel.unlock.',
      };
    },
  });
  registry.register({
    id: 'channel.unlock',
    category: 'security',
    risk: 'write',
    description:
      'Restore an exact saved channel lock snapshot only while its applied overwrites are unchanged.',
    schema: z.strictObject({ channelId: id, reason }),
    userPermissions: [P.ManageChannels, P.ManageRoles],
    botPermissions: [P.ManageChannels, P.ManageRoles],
    execute: async (ctx, input) => {
      const channel = await channelWith(ctx, input.channelId, [P.ManageChannels, P.ManageRoles]);
      if (channel.isThread()) throw new UserError('Requires a non-thread channel.');
      const key = `${ctx.guild.id}:${channel.id}`,
        saved = ctx.store.get<{
          version: 2;
          before: { id: string; type: OverwriteType; allow: string; deny: string }[];
          applied: { id: string; type: OverwriteType; allow: string; deny: string }[];
        }>('discord.channel-locks', key);
      if (!saved) throw new UserError('No saved lock exists for this channel.');
      if (saved.version !== 2) {
        await channel.permissionOverwrites.edit(
          ctx.guild.id,
          saved as unknown as PermissionOverwriteOptions,
          { reason: nowReason(ctx, input.reason) },
        );
        ctx.store.delete('discord.channel-locks', key);
        return { channelId: channel.id, restored: true, legacy: true };
      }
      const current = Array.from(channel.permissionOverwrites.cache, ([id, overwrite]) => ({
        id,
        type: overwrite.type ?? OverwriteType.Role,
        allow: overwrite.allow.bitfield.toString(),
        deny: overwrite.deny.bitfield.toString(),
      })).sort((a, b) => a.id.localeCompare(b.id));
      if (JSON.stringify(current) === JSON.stringify(saved.before)) {
        ctx.store.delete('discord.channel-locks', key);
        return { channelId: channel.id, restored: true, alreadyRestored: true };
      }
      if (JSON.stringify(current) !== JSON.stringify(saved.applied))
        throw new UserError(
          'Channel overwrites changed after locking. Resolve the conflict manually; no permissions were overwritten.',
        );
      await channel.permissionOverwrites.set(
        saved.before.map((row) => ({ ...row, allow: BigInt(row.allow), deny: BigInt(row.deny) })),
        nowReason(ctx, input.reason),
      );
      ctx.store.delete('discord.channel-locks', key);
      return { channelId: channel.id, restored: true };
    },
  });
  registry.register({
    id: 'channel.forum-tags',
    category: 'channels',
    description: 'Replace forum or media channel tags with a validated list.',
    schema: z.strictObject({ channelId: id, tags, reason }),
    userPermissions: [P.ManageChannels],
    botPermissions: [P.ManageChannels],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await editableChannel(ctx, input.channelId);
      if (channel.type !== ChannelType.GuildForum && channel.type !== ChannelType.GuildMedia)
        throw new UserError('Requires a forum or media channel.');
      await channel.setAvailableTags(input.tags, nowReason(ctx, input.reason));
      return { channelId: channel.id, tags: channel.availableTags };
    },
  });
  registry.register({
    id: 'channel.voice-status',
    category: 'voice',
    description: 'Set or clear an accessible voice-channel status.',
    schema: z.strictObject({
      channelId: id,
      status: z.string().max(500).nullable(),
      reason,
    }),
    userPermissions: [P.SetVoiceChannelStatus],
    botPermissions: [P.SetVoiceChannelStatus],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await channelWith(ctx, input.channelId, [P.SetVoiceChannelStatus]);
      if (channel.type !== ChannelType.GuildVoice) throw new UserError('Requires a regular voice channel.');
      await ctx.client.rest.put(`/channels/${channel.id}/voice-status`, {
        body: { status: input.status },
        reason: nowReason(ctx, input.reason),
      });
      return { channelId: channel.id, status: input.status };
    },
  });
  registry.register({
    id: 'channel.follow',
    category: 'channels',
    description: 'Follow an accessible announcement channel into an accessible destination.',
    schema: z.strictObject({ channelId: id, destinationId: id, reason }),
    userPermissions: [P.ManageWebhooks],
    botPermissions: [P.ManageWebhooks],
    risk: 'write',
    execute: async (ctx, input) => {
      const source = await channelWith(ctx, input.channelId, [P.ManageWebhooks]);
      const destination = await channelWith(ctx, input.destinationId, [P.ManageWebhooks]);
      if (source.type !== ChannelType.GuildAnnouncement || destination.type !== ChannelType.GuildText)
        throw new UserError('Source must be an announcement channel and destination a text channel.');
      const webhook = await source.addFollower(destination, nowReason(ctx, input.reason));
      return { followerId: webhook };
    },
  });

  registry.register({
    id: 'thread.create',
    category: 'threads',
    description: 'Create public or private threads, optionally from an existing message.',
    schema: z.strictObject({
      channelId: id,
      name: z.string().min(1).max(100),
      private: z.boolean().default(false),
      messageId: id.optional(),
      autoArchiveDuration: z
        .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
        .default(1440),
      reason,
    }),
    userPermissions: [P.ManageThreads],
    botPermissions: [P.ManageThreads],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await channelWith(ctx, input.channelId, [
        input.private ? P.CreatePrivateThreads : P.CreatePublicThreads,
      ]);
      if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
        throw new UserError('Requires a text or announcement channel.');
      if (input.private && input.messageId)
        throw new UserError('Private threads cannot be started from messages.');
      if (input.private && channel.type !== ChannelType.GuildText)
        throw new UserError('Private threads require a regular text channel.');
      const settings = {
        name: input.name,
        autoArchiveDuration: input.autoArchiveDuration,
        reason: nowReason(ctx, input.reason),
      };
      const thread = input.messageId
        ? await (await channel.messages.fetch(input.messageId)).startThread(settings)
        : channel.type === ChannelType.GuildText
          ? await channel.threads.create({
              ...settings,
              type: input.private ? ChannelType.PrivateThread : ChannelType.PublicThread,
            })
          : await channel.threads.create(settings);
      return summarizeChannel(thread);
    },
  });
  registry.register({
    id: 'thread.post',
    category: 'threads',
    description: 'Create a forum or media post with text and existing tag IDs.',
    schema: z.strictObject({
      channelId: id,
      name: z.string().min(1).max(100),
      content: z.string().min(1).max(2000),
      tagIds: z.array(id).max(5).default([]),
      reason,
    }),
    userPermissions: [P.SendMessages],
    botPermissions: [P.SendMessages],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await channelWith(ctx, input.channelId, [P.SendMessages]);
      if (channel.type !== ChannelType.GuildForum && channel.type !== ChannelType.GuildMedia)
        throw new UserError('Requires a forum or media channel.');
      const post = await channel.threads.create({
        name: input.name,
        message: { content: input.content, allowedMentions: { parse: [] } },
        appliedTags: input.tagIds,
        reason: nowReason(ctx, input.reason),
      });
      return summarizeChannel(post);
    },
  });
  registry.register({
    id: 'thread.edit',
    category: 'threads',
    description: 'Rename, archive, unarchive, lock, unlock or change thread slowmode/tags.',
    schema: z.strictObject({
      channelId: id,
      name: z.string().min(1).max(100).optional(),
      archived: z.boolean().optional(),
      autoArchiveDuration: z
        .union([z.literal(60), z.literal(1440), z.literal(4320), z.literal(10080)])
        .optional(),
      invitable: z.boolean().optional(),
      locked: z.boolean().optional(),
      rateLimitPerUser: z.number().int().min(0).max(21600).optional(),
      appliedTags: z.array(id).max(5).optional(),
      reason,
    }),
    userPermissions: [P.ManageThreads],
    botPermissions: [P.ManageThreads],
    risk: 'write',
    execute: async (ctx, { channelId, reason: why, ...options }) => {
      const channel = await channelWith(ctx, channelId, [P.ManageThreads]);
      if (!channel.isThread()) throw new UserError('Requires a thread.');
      if (!Object.keys(options).length) throw new UserError('Provide at least one setting.');
      return summarizeChannel(await channel.edit({ ...options, reason: nowReason(ctx, why) }));
    },
  });
  registry.register({
    id: 'thread.members',
    category: 'threads',
    description: 'List the fetched participants of an accessible thread.',
    schema: z.strictObject({ channelId: id }),
    userPermissions: [],
    botPermissions: [],
    risk: 'read',
    execute: async (ctx, { channelId }) => {
      const channel = await channelWith(ctx, channelId);
      if (!channel.isThread()) throw new UserError('Requires a thread.');
      return (await channel.members.fetch()).map((m) => ({
        id: m.id,
        joinedAt: m.joinedAt?.toISOString(),
      }));
    },
  });
  registry.register({
    id: 'thread.member-add',
    category: 'threads',
    description: 'Add a current server member to a thread.',
    schema: z.strictObject({ channelId: id, memberId: id }),
    userPermissions: [P.ManageThreads],
    botPermissions: [P.ManageThreads],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await channelWith(ctx, input.channelId, [P.ManageThreads]);
      if (!channel.isThread()) throw new UserError('Requires a thread.');
      await ctx.guild.members.fetch(input.memberId);
      await channel.members.add(input.memberId);
      return { addedMemberId: input.memberId };
    },
  });
  registry.register({
    id: 'thread.member-remove',
    category: 'threads',
    description: 'Remove a participant from a thread.',
    schema: z.strictObject({ channelId: id, memberId: id }),
    userPermissions: [P.ManageThreads],
    botPermissions: [P.ManageThreads],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await channelWith(ctx, input.channelId, [P.ManageThreads]);
      if (!channel.isThread()) throw new UserError('Requires a thread.');
      await channel.members.remove(input.memberId);
      return { removedMemberId: input.memberId };
    },
  });
  for (const operation of ['join', 'leave'] as const)
    registry.register({
      id: `thread.${operation}`,
      category: 'threads',
      description: `${operation === 'join' ? 'Join' : 'Leave'} a thread as the bot.`,
      schema: z.strictObject({ channelId: id }),
      userPermissions: [P.ManageThreads],
      botPermissions: [],
      risk: 'write',
      execute: async (ctx, { channelId }) => {
        const channel = await channelWith(ctx, channelId);
        if (!channel.isThread()) throw new UserError('Requires a thread.');
        await channel[operation]();
        return { channelId, operation };
      },
    });
  registry.register({
    id: 'thread.active',
    category: 'threads',
    description: 'List active threads accessible to you and the bot.',
    schema: empty,
    userPermissions: [],
    botPermissions: [],
    risk: 'read',
    execute: async (ctx) => {
      const result = await ctx.guild.channels.fetchActiveThreads();
      const visible = [];
      for (const thread of result.threads.values()) {
        try {
          await channelWith(ctx, thread.id);
          visible.push(summarizeChannel(thread));
        } catch {
          /* Omit inaccessible threads. */
        }
      }
      return visible;
    },
  });
  registry.register({
    id: 'thread.archived',
    category: 'threads',
    description: 'List up to 100 archived public threads under an accessible channel.',
    schema: z.strictObject({
      channelId: id,
      before: z.iso.datetime().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }),
    userPermissions: [P.ManageThreads],
    botPermissions: [P.ReadMessageHistory],
    risk: 'read',
    execute: async (ctx, input) => {
      const channel = await channelWith(ctx, input.channelId, [P.ReadMessageHistory]);
      if (!('threads' in channel) || channel.isThread())
        throw new UserError('Requires a thread parent channel.');
      const result = await channel.threads.fetchArchived({
        type: 'public',
        before: input.before ? new Date(input.before) : undefined,
        limit: input.limit,
      });
      return {
        hasMore: result.hasMore,
        threads: result.threads.map(summarizeChannel),
      };
    },
  });
}
