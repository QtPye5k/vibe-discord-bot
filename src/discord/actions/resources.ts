import {
  AutoModerationActionType,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventStatus,
  ChannelType,
  type AutoModerationActionOptions,
  type AutoModerationRule,
  type SoundboardSound,
  type Webhook,
} from 'discord.js';
import type { ActionRegistry } from '../../core/registry.js';
import {
  P,
  z,
  id,
  empty,
  reason,
  imageData,
  nowReason,
  channelWith,
  resolveRole,
  sendChannel,
  validFuture,
  UserError,
} from './shared.js';

const summarizeRule = (rule: AutoModerationRule) => ({
  id: rule.id,
  name: rule.name,
  enabled: rule.enabled,
  eventType: rule.eventType,
  triggerType: rule.triggerType,
  triggerMetadata: rule.triggerMetadata,
  exemptRoleIds: [...rule.exemptRoles.keys()],
  exemptChannelIds: [...rule.exemptChannels.keys()],
  actions: rule.actions.map((action) => ({
    type: action.type,
    metadata: action.metadata,
  })),
});
const summarizeSound = (sound: SoundboardSound) => ({
  soundId: sound.soundId,
  name: sound.name,
  volume: sound.volume,
  emoji: sound.emoji?.toString(),
  available: sound.available,
});
const summarizeWebhook = (hook: Webhook) => ({
  id: hook.id,
  name: hook.name,
  channelId: hook.channelId,
  type: hook.type,
});

export function registerResourceActions(registry: ActionRegistry): void {
  registry.register({
    id: 'automod.list',
    category: 'security',
    description: 'List native Discord AutoMod rules and exemptions.',
    schema: empty,
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'read',
    execute: async ({ guild }) => (await guild.autoModerationRules.fetch()).map(summarizeRule),
  });
  registry.register({
    id: 'automod.create',
    category: 'security',
    description: 'Create a keyword, regex, spam or mention-spam native AutoMod rule.',
    schema: z.strictObject({
      name: z.string().min(1).max(100),
      trigger: z.enum(['keywords', 'spam', 'mentions']),
      keywords: z.array(z.string().min(1).max(60)).max(1000).default([]),
      regexPatterns: z.array(z.string().min(1).max(260)).max(10).default([]),
      allowList: z.array(z.string().min(1).max(60)).max(100).default([]),
      mentionLimit: z.number().int().min(1).max(50).default(10),
      enabled: z.boolean().default(true),
      blockMessage: z.boolean().default(true),
      timeoutSeconds: z.number().int().min(0).max(2419200).default(0),
      alertChannelId: id.optional(),
      exemptRoleIds: z.array(id).max(20).default([]),
      exemptChannelIds: z.array(id).max(50).default([]),
      reason,
    }),
    userPermissions: [P.ManageGuild, P.ModerateMembers],
    botPermissions: [P.ManageGuild, P.ModerateMembers],
    risk: 'write',
    execute: async (ctx, input) => {
      for (const roleId of input.exemptRoleIds) await resolveRole(ctx, roleId);
      for (const channelId of input.exemptChannelIds) await channelWith(ctx, channelId);
      if (input.alertChannelId) {
        const alert = await channelWith(ctx, input.alertChannelId, [P.SendMessages]);
        if (!alert.isTextBased()) throw new UserError('Alert channel must support messages.');
      }
      if (input.trigger === 'keywords' && !input.keywords.length && !input.regexPatterns.length)
        throw new UserError('Keyword rules require keywords or regex patterns.');
      if (input.timeoutSeconds && input.trigger === 'spam')
        throw new UserError('Timeout actions are supported here for keyword or mention rules.');
      const actions: AutoModerationActionOptions[] = [];
      if (input.blockMessage) actions.push({ type: AutoModerationActionType.BlockMessage });
      if (input.alertChannelId)
        actions.push({
          type: AutoModerationActionType.SendAlertMessage,
          metadata: { channel: input.alertChannelId },
        });
      if (input.timeoutSeconds)
        actions.push({
          type: AutoModerationActionType.Timeout,
          metadata: { durationSeconds: input.timeoutSeconds },
        });
      if (!actions.length) throw new UserError('Choose at least one AutoMod action.');
      const triggerType =
        input.trigger === 'keywords'
          ? AutoModerationRuleTriggerType.Keyword
          : input.trigger === 'spam'
            ? AutoModerationRuleTriggerType.Spam
            : AutoModerationRuleTriggerType.MentionSpam;
      const triggerMetadata =
        input.trigger === 'keywords'
          ? {
              keywordFilter: input.keywords,
              regexPatterns: input.regexPatterns,
              allowList: input.allowList,
            }
          : input.trigger === 'mentions'
            ? {
                mentionTotalLimit: input.mentionLimit,
                mentionRaidProtectionEnabled: true,
              }
            : undefined;
      return summarizeRule(
        await ctx.guild.autoModerationRules.create({
          name: input.name,
          eventType: AutoModerationRuleEventType.MessageSend,
          triggerType,
          triggerMetadata,
          actions,
          enabled: input.enabled,
          exemptRoles: input.exemptRoleIds,
          exemptChannels: input.exemptChannelIds,
          reason: nowReason(ctx, input.reason),
        }),
      );
    },
  });
  registry.register({
    id: 'automod.toggle',
    category: 'security',
    description: 'Enable or disable a native AutoMod rule belonging to this server.',
    schema: z.strictObject({ ruleId: id, enabled: z.boolean(), reason }),
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'write',
    execute: async (ctx, input) =>
      summarizeRule(
        await (
          await ctx.guild.autoModerationRules.fetch(input.ruleId)
        ).edit({
          enabled: input.enabled,
          reason: nowReason(ctx, input.reason),
        }),
      ),
  });
  registry.register({
    id: 'automod.exemptions',
    category: 'security',
    description: 'Replace native AutoMod role and channel exemptions.',
    schema: z.strictObject({
      ruleId: id,
      exemptRoleIds: z.array(id).max(20),
      exemptChannelIds: z.array(id).max(50),
      reason,
    }),
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'write',
    execute: async (ctx, input) => {
      for (const roleId of input.exemptRoleIds) await resolveRole(ctx, roleId);
      for (const channelId of input.exemptChannelIds) await channelWith(ctx, channelId);
      return summarizeRule(
        await (
          await ctx.guild.autoModerationRules.fetch(input.ruleId)
        ).edit({
          exemptRoles: input.exemptRoleIds,
          exemptChannels: input.exemptChannelIds,
          reason: nowReason(ctx, input.reason),
        }),
      );
    },
  });
  registry.register({
    id: 'automod.delete',
    category: 'security',
    description: 'Permanently delete a native AutoMod rule.',
    schema: z.strictObject({ ruleId: id, reason }),
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'destructive',
    execute: async (ctx, input) => {
      await (await ctx.guild.autoModerationRules.fetch(input.ruleId)).delete(nowReason(ctx, input.reason));
      return { deletedRuleId: input.ruleId };
    },
  });

  registry.register({
    id: 'event.list',
    category: 'events',
    description: 'List Discord scheduled events and participant counts.',
    schema: empty,
    userPermissions: [],
    botPermissions: [],
    risk: 'read',
    execute: async (ctx) => {
      const result = [];
      for (const event of (await ctx.guild.scheduledEvents.fetch()).values()) {
        if (event.channelId) {
          try {
            await channelWith(ctx, event.channelId);
          } catch {
            continue;
          }
        }
        result.push({
          id: event.id,
          name: event.name,
          description: event.description,
          status: event.status,
          channelId: event.channelId,
          startTime: event.scheduledStartAt?.toISOString(),
          endTime: event.scheduledEndAt?.toISOString(),
          location: event.entityMetadata?.location,
          userCount: event.userCount,
          url: event.url,
        });
      }
      return result;
    },
  });
  registry.register({
    id: 'event.create',
    category: 'events',
    description: 'Create a future voice, Stage, or external scheduled event.',
    schema: z.strictObject({
      name: z.string().min(1).max(100),
      description: z.string().max(1000).optional(),
      kind: z.enum(['voice', 'stage', 'external']),
      channelId: id.optional(),
      location: z.string().min(1).max(100).optional(),
      startTime: z.iso.datetime(),
      endTime: z.iso.datetime().optional(),
      reason,
    }),
    userPermissions: [P.ManageEvents],
    botPermissions: [P.ManageEvents],
    risk: 'write',
    execute: async (ctx, input) => {
      if (!validFuture(input.startTime)) throw new UserError('Event start must be in the future.');
      if (input.endTime && Date.parse(input.endTime) <= Date.parse(input.startTime))
        throw new UserError('Event end must be after its start.');
      if (input.kind === 'external' && (!input.location || !input.endTime))
        throw new UserError('External events require a location and end time.');
      if (input.kind !== 'external') {
        if (!input.channelId) throw new UserError('A voice or Stage channel is required.');
        const channel = await channelWith(ctx, input.channelId, [P.ViewChannel]);
        if (channel.type !== (input.kind === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildStageVoice))
          throw new UserError('Channel type does not match the event.');
      }
      const event = await ctx.guild.scheduledEvents.create({
        name: input.name,
        description: input.description,
        scheduledStartTime: input.startTime,
        scheduledEndTime: input.endTime,
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType:
          input.kind === 'voice'
            ? GuildScheduledEventEntityType.Voice
            : input.kind === 'stage'
              ? GuildScheduledEventEntityType.StageInstance
              : GuildScheduledEventEntityType.External,
        channel: input.kind === 'external' ? undefined : input.channelId,
        entityMetadata: input.kind === 'external' ? { location: input.location } : undefined,
        reason: nowReason(ctx, input.reason),
      });
      return { id: event.id, name: event.name, url: event.url };
    },
  });
  registry.register({
    id: 'event.edit',
    category: 'events',
    description: 'Rename, redescribe, or reschedule a server event.',
    schema: z.strictObject({
      eventId: id,
      name: z.string().min(1).max(100).optional(),
      description: z.string().max(1000).optional(),
      startTime: z.iso.datetime().optional(),
      endTime: z.iso.datetime().optional(),
      reason,
    }),
    userPermissions: [P.ManageEvents],
    botPermissions: [P.ManageEvents],
    risk: 'write',
    execute: async (ctx, input) => {
      const event = await ctx.guild.scheduledEvents.fetch(input.eventId);
      if (!event) throw new UserError('Event not found.');
      if (event.channelId) await channelWith(ctx, event.channelId);
      if (input.startTime && !validFuture(input.startTime))
        throw new UserError('Start must be in the future.');
      const start = input.startTime ? Date.parse(input.startTime) : event.scheduledStartTimestamp;
      if (input.endTime && start && Date.parse(input.endTime) <= start)
        throw new UserError('End must follow start.');
      await event.edit({
        name: input.name,
        description: input.description,
        scheduledStartTime: input.startTime,
        scheduledEndTime: input.endTime,
        reason: nowReason(ctx, input.reason),
      });
      return { eventId: event.id, updated: true };
    },
  });
  registry.register({
    id: 'event.status',
    category: 'events',
    description: 'Start, complete, or cancel a scheduled event using valid Discord state transitions.',
    schema: z.strictObject({
      eventId: id,
      status: z.enum(['active', 'completed', 'canceled']),
      reason,
    }),
    userPermissions: [P.ManageEvents],
    botPermissions: [P.ManageEvents],
    risk: 'write',
    execute: async (ctx, input) => {
      const event = await ctx.guild.scheduledEvents.fetch(input.eventId);
      if (!event) throw new UserError('Event not found.');
      if (event.channelId) await channelWith(ctx, event.channelId);
      const status = (
        {
          active: GuildScheduledEventStatus.Active,
          completed: GuildScheduledEventStatus.Completed,
          canceled: GuildScheduledEventStatus.Canceled,
        } as const
      )[input.status];
      if (
        (event.status === GuildScheduledEventStatus.Scheduled &&
          status !== GuildScheduledEventStatus.Active &&
          status !== GuildScheduledEventStatus.Canceled) ||
        (event.status === GuildScheduledEventStatus.Active &&
          status !== GuildScheduledEventStatus.Completed) ||
        event.status === GuildScheduledEventStatus.Canceled ||
        event.status === GuildScheduledEventStatus.Completed
      )
        throw new UserError('Invalid event state transition.');
      await event.setStatus(status, nowReason(ctx, input.reason));
      return { eventId: event.id, status };
    },
  });
  registry.register({
    id: 'event.delete',
    category: 'events',
    description: 'Permanently delete a scheduled event.',
    schema: z.strictObject({ eventId: id }),
    userPermissions: [P.ManageEvents],
    botPermissions: [P.ManageEvents],
    risk: 'destructive',
    execute: async (ctx, input) => {
      const event = await ctx.guild.scheduledEvents.fetch(input.eventId);
      if (!event) throw new UserError('Event not found.');
      if (event.channelId) await channelWith(ctx, event.channelId);
      await event.delete();
      return { deletedEventId: input.eventId };
    },
  });
  registry.register({
    id: 'event.subscribers',
    category: 'events',
    description: 'Read up to 100 users interested in an accessible event.',
    schema: z.strictObject({
      eventId: id,
      limit: z.number().int().min(1).max(100).default(100),
      after: id.optional(),
    }),
    userPermissions: [P.ManageEvents],
    botPermissions: [],
    risk: 'read',
    execute: async (ctx, input) => {
      const event = await ctx.guild.scheduledEvents.fetch(input.eventId);
      if (!event) throw new UserError('Event not found.');
      if (event.channelId) await channelWith(ctx, event.channelId);
      return (await event.fetchSubscribers({ limit: input.limit, after: input.after })).map((entry) => ({
        id: entry.user.id,
        username: entry.user.username,
      }));
    },
  });
  registry.register({
    id: 'stage.create',
    category: 'events',
    description: 'Create a Stage instance in an accessible Stage channel.',
    schema: z.strictObject({
      channelId: id,
      topic: z.string().min(1).max(120),
      notify: z.boolean().default(false),
    }),
    userPermissions: [P.ManageChannels],
    botPermissions: [P.ManageChannels],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await channelWith(ctx, input.channelId, [P.ManageChannels]);
      if (channel.type !== ChannelType.GuildStageVoice) throw new UserError('Requires a Stage channel.');
      const stage = await ctx.guild.stageInstances.create(channel, {
        topic: input.topic,
        sendStartNotification: input.notify,
      });
      return { id: stage.id, channelId: stage.channelId, topic: stage.topic };
    },
  });
  registry.register({
    id: 'stage.topic',
    category: 'events',
    description: 'Update an existing Stage instance topic.',
    schema: z.strictObject({
      channelId: id,
      topic: z.string().min(1).max(120),
    }),
    userPermissions: [P.ManageChannels],
    botPermissions: [P.ManageChannels],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await channelWith(ctx, input.channelId, [P.ManageChannels]);
      if (channel.type !== ChannelType.GuildStageVoice) throw new UserError('Requires a Stage channel.');
      const stage = await ctx.guild.stageInstances.edit(channel, {
        topic: input.topic,
      });
      return { id: stage.id, topic: stage.topic };
    },
  });
  registry.register({
    id: 'stage.delete',
    category: 'events',
    description: 'End a Stage instance without deleting its channel.',
    schema: z.strictObject({ channelId: id }),
    userPermissions: [P.ManageChannels],
    botPermissions: [P.ManageChannels],
    risk: 'destructive',
    execute: async (ctx, input) => {
      const channel = await channelWith(ctx, input.channelId, [P.ManageChannels]);
      if (channel.type !== ChannelType.GuildStageVoice) throw new UserError('Requires a Stage channel.');
      await ctx.guild.stageInstances.delete(channel);
      return { ended: true };
    },
  });

  registry.register({
    id: 'emoji.list',
    category: 'expressions',
    description: 'List custom server emojis.',
    schema: empty,
    userPermissions: [],
    botPermissions: [],
    risk: 'read',
    execute: async ({ guild }) =>
      (await guild.emojis.fetch()).map((emoji) => ({
        id: emoji.id,
        name: emoji.name,
        animated: emoji.animated,
        url: emoji.imageURL(),
      })),
  });
  registry.register({
    id: 'emoji.create',
    category: 'expressions',
    description: 'Upload a custom emoji from validated image data.',
    schema: z.strictObject({
      name: z.string().regex(/^\w{2,32}$/),
      image: imageData,
      roleIds: z.array(id).max(20).default([]),
      reason,
    }),
    userPermissions: [P.ManageGuildExpressions],
    botPermissions: [P.ManageGuildExpressions],
    risk: 'write',
    execute: async (ctx, input) => {
      for (const roleId of input.roleIds) await resolveRole(ctx, roleId);
      const emoji = await ctx.guild.emojis.create({
        name: input.name,
        attachment: input.image,
        roles: input.roleIds,
        reason: nowReason(ctx, input.reason),
      });
      return { id: emoji.id, name: emoji.name };
    },
  });
  registry.register({
    id: 'emoji.edit',
    category: 'expressions',
    description: 'Rename a server emoji or restrict it to existing server roles.',
    schema: z.strictObject({
      emojiId: id,
      name: z
        .string()
        .regex(/^\w{2,32}$/)
        .optional(),
      roleIds: z.array(id).max(20).optional(),
      reason,
    }),
    userPermissions: [P.ManageGuildExpressions],
    botPermissions: [P.ManageGuildExpressions],
    risk: 'write',
    execute: async (ctx, input) => {
      if (input.roleIds) for (const roleId of input.roleIds) await resolveRole(ctx, roleId);
      const emoji = await ctx.guild.emojis.fetch(input.emojiId);
      await emoji.edit({
        name: input.name,
        roles: input.roleIds,
        reason: nowReason(ctx, input.reason),
      });
      return { id: emoji.id, name: emoji.name };
    },
  });
  registry.register({
    id: 'emoji.delete',
    category: 'expressions',
    description: 'Delete a custom emoji belonging to this server.',
    schema: z.strictObject({ emojiId: id, reason }),
    userPermissions: [P.ManageGuildExpressions],
    botPermissions: [P.ManageGuildExpressions],
    risk: 'destructive',
    execute: async (ctx, input) => {
      await (await ctx.guild.emojis.fetch(input.emojiId)).delete(nowReason(ctx, input.reason));
      return { deletedEmojiId: input.emojiId };
    },
  });
  registry.register({
    id: 'sticker.list',
    category: 'expressions',
    description: 'List custom server stickers.',
    schema: empty,
    userPermissions: [],
    botPermissions: [],
    risk: 'read',
    execute: async ({ guild }) =>
      (await guild.stickers.fetch()).map((sticker) => ({
        id: sticker.id,
        name: sticker.name,
        description: sticker.description,
        tags: sticker.tags,
        url: sticker.url,
      })),
  });
  registry.register({
    id: 'sticker.create',
    category: 'expressions',
    description: 'Upload a custom PNG sticker from base64 data; Discord validates dimensions and size.',
    schema: z.strictObject({
      name: z.string().min(2).max(30),
      description: z.string().min(2).max(100).optional(),
      tags: z.string().min(1).max(200),
      pngBase64: z
        .string()
        .min(1)
        .max(700000)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
      reason,
    }),
    userPermissions: [P.ManageGuildExpressions],
    botPermissions: [P.ManageGuildExpressions],
    risk: 'write',
    execute: async (ctx, input) => {
      const data = Buffer.from(input.pngBase64, 'base64');
      if (data.length > 512000 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new UserError('Requires a PNG file no larger than 512 KB.');
      const sticker = await ctx.guild.stickers.create({
        name: input.name,
        description: input.description,
        tags: input.tags,
        file: { attachment: data, name: 'sticker.png' },
        reason: nowReason(ctx, input.reason),
      });
      return { id: sticker.id, name: sticker.name };
    },
  });
  registry.register({
    id: 'sticker.edit',
    category: 'expressions',
    description: 'Edit a custom server sticker name, description and tags.',
    schema: z.strictObject({
      stickerId: id,
      name: z.string().min(2).max(30).optional(),
      description: z.string().min(2).max(100).optional(),
      tags: z.string().min(1).max(200).optional(),
      reason,
    }),
    userPermissions: [P.ManageGuildExpressions],
    botPermissions: [P.ManageGuildExpressions],
    risk: 'write',
    execute: async (ctx, { stickerId, reason: why, ...options }) => {
      const result = await ctx.guild.stickers.edit(stickerId, {
        ...options,
        reason: nowReason(ctx, why),
      });
      return { id: result.id, name: result.name };
    },
  });
  registry.register({
    id: 'sticker.delete',
    category: 'expressions',
    description: 'Delete a custom sticker belonging to this server.',
    schema: z.strictObject({ stickerId: id, reason }),
    userPermissions: [P.ManageGuildExpressions],
    botPermissions: [P.ManageGuildExpressions],
    risk: 'destructive',
    execute: async (ctx, input) => {
      await ctx.guild.stickers.delete(input.stickerId, nowReason(ctx, input.reason));
      return { deletedStickerId: input.stickerId };
    },
  });

  registry.register({
    id: 'soundboard.list',
    category: 'voice',
    description: 'Retrieve server soundboard sounds and volume settings.',
    schema: empty,
    userPermissions: [],
    botPermissions: [],
    risk: 'read',
    execute: async ({ guild }) => (await guild.soundboardSounds.fetch()).map(summarizeSound),
  });
  registry.register({
    id: 'soundboard.create',
    category: 'voice',
    description: 'Upload a short MP3 or Ogg soundboard clip from base64 audio data.',
    schema: z.strictObject({
      name: z.string().min(2).max(32),
      base64: z
        .string()
        .min(1)
        .max(700000)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
      contentType: z.enum(['audio/mpeg', 'audio/ogg']),
      volume: z.number().min(0).max(1).default(1),
      emojiName: z.string().max(32).optional(),
      reason,
    }),
    userPermissions: [P.ManageGuildExpressions],
    botPermissions: [P.ManageGuildExpressions],
    risk: 'write',
    execute: async (ctx, input) => {
      const data = Buffer.from(input.base64, 'base64');
      if (data.length > 512000) throw new UserError('Soundboard files are limited to 512 KB.');
      return summarizeSound(
        await ctx.guild.soundboardSounds.create({
          name: input.name,
          file: data,
          contentType: input.contentType,
          volume: input.volume,
          emojiName: input.emojiName,
          reason: nowReason(ctx, input.reason),
        }),
      );
    },
  });
  registry.register({
    id: 'soundboard.edit',
    category: 'voice',
    description: 'Edit a server soundboard sound name, volume or emoji.',
    schema: z.strictObject({
      soundId: id,
      name: z.string().min(2).max(32).optional(),
      volume: z.number().min(0).max(1).optional(),
      emojiName: z.string().max(32).nullable().optional(),
      reason,
    }),
    userPermissions: [P.ManageGuildExpressions],
    botPermissions: [P.ManageGuildExpressions],
    risk: 'write',
    execute: async (ctx, { soundId, reason: why, ...options }) =>
      summarizeSound(
        await ctx.guild.soundboardSounds.edit(soundId, {
          ...options,
          reason: nowReason(ctx, why),
        }),
      ),
  });
  registry.register({
    id: 'soundboard.delete',
    category: 'voice',
    description: 'Delete a server soundboard sound.',
    schema: z.strictObject({ soundId: id, reason }),
    userPermissions: [P.ManageGuildExpressions],
    botPermissions: [P.ManageGuildExpressions],
    risk: 'destructive',
    execute: async (ctx, input) => {
      await (await ctx.guild.soundboardSounds.fetch(input.soundId)).delete(nowReason(ctx, input.reason));
      return { deletedSoundId: input.soundId };
    },
  });
  registry.register({
    id: 'soundboard.play',
    category: 'voice',
    description: 'Trigger an available soundboard sound in the voice channel shared by you and the bot.',
    schema: z.strictObject({ channelId: id, soundId: id }),
    userPermissions: [P.UseSoundboard],
    botPermissions: [P.UseSoundboard],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await channelWith(ctx, input.channelId, [P.UseSoundboard, P.Connect]);
      if (
        channel.type !== ChannelType.GuildVoice ||
        ctx.member.voice.channelId !== channel.id ||
        ctx.guild.members.me?.voice.channelId !== channel.id
      )
        throw new UserError('You and the bot must be in the same regular voice channel.');
      await ctx.guild.soundboardSounds.fetch(input.soundId);
      await channel.sendSoundboardSound({ soundId: input.soundId });
      return { playedSoundId: input.soundId };
    },
  });

  registry.register({
    id: 'invite.create',
    category: 'invites',
    description: 'Create an invite for an accessible server channel with explicit expiry and usage limit.',
    schema: z.strictObject({
      channelId: id,
      maxAgeSeconds: z.number().int().min(0).max(604800).default(86400),
      maxUses: z.number().int().min(0).max(100).default(1),
      temporary: z.boolean().default(false),
      reason,
    }),
    userPermissions: [P.CreateInstantInvite],
    botPermissions: [P.CreateInstantInvite],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await channelWith(ctx, input.channelId, [P.CreateInstantInvite]);
      if (!('createInvite' in channel)) throw new UserError('This channel does not support invites.');
      const invite = await channel.createInvite({
        maxAge: input.maxAgeSeconds,
        maxUses: input.maxUses,
        temporary: input.temporary,
        unique: true,
        reason: nowReason(ctx, input.reason),
      });
      return {
        code: invite.code,
        url: invite.url,
        expiresAt: invite.expiresAt?.toISOString(),
        maxUses: invite.maxUses,
      };
    },
  });
  registry.register({
    id: 'invite.list',
    category: 'invites',
    description: 'List manageable invites for channels accessible to you and the bot.',
    schema: empty,
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'read',
    execute: async (ctx) => {
      const result = [];
      for (const invite of (await ctx.guild.invites.fetch()).values()) {
        if (!invite.channelId) continue;
        try {
          await channelWith(ctx, invite.channelId);
          result.push({
            code: invite.code,
            channelId: invite.channelId,
            uses: invite.uses,
            maxUses: invite.maxUses,
            expiresAt: invite.expiresAt?.toISOString(),
            inviterId: invite.inviterId,
          });
        } catch {
          /* Omit invites for inaccessible channels. */
        }
      }
      return result;
    },
  });
  registry.register({
    id: 'invite.delete',
    category: 'invites',
    description: 'Revoke an existing invite belonging to an accessible channel in this server.',
    schema: z.strictObject({
      code: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
      reason,
    }),
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'destructive',
    execute: async (ctx, input) => {
      const invite = (await ctx.guild.invites.fetch()).get(input.code);
      if (!invite || !invite.channelId) throw new UserError('Invite is not available in this server.');
      await channelWith(ctx, invite.channelId);
      await invite.delete(nowReason(ctx, input.reason));
      return { revokedCode: input.code };
    },
  });

  registry.register({
    id: 'webhook.list',
    category: 'webhooks',
    description: 'List accessible server webhooks without exposing tokens or execution URLs.',
    schema: empty,
    userPermissions: [P.ManageWebhooks],
    botPermissions: [P.ManageWebhooks],
    risk: 'read',
    execute: async (ctx) => {
      const result = [];
      for (const webhook of (await ctx.guild.fetchWebhooks()).values()) {
        try {
          await channelWith(ctx, webhook.channelId, [P.ManageWebhooks]);
          result.push(summarizeWebhook(webhook));
        } catch {
          /* Omit inaccessible webhooks. */
        }
      }
      return result;
    },
  });
  registry.register({
    id: 'webhook.create',
    category: 'webhooks',
    description: 'Create a webhook in an authorized channel; its credential remains private.',
    schema: z.strictObject({
      channelId: id,
      name: z.string().min(1).max(80),
      avatar: imageData.optional(),
      reason,
    }),
    userPermissions: [P.ManageWebhooks],
    botPermissions: [P.ManageWebhooks],
    risk: 'write',
    execute: async (ctx, input) => {
      const channel = await channelWith(ctx, input.channelId, [P.ManageWebhooks]);
      if (!('createWebhook' in channel)) throw new UserError('This channel does not support webhooks.');
      return summarizeWebhook(
        await channel.createWebhook({
          name: input.name,
          avatar: input.avatar,
          reason: nowReason(ctx, input.reason),
        }),
      );
    },
  });
  registry.register({
    id: 'webhook.edit',
    category: 'webhooks',
    description: 'Edit a server webhook display name or avatar without exposing its token.',
    schema: z.strictObject({
      webhookId: id,
      name: z.string().min(1).max(80).optional(),
      avatar: imageData.nullable().optional(),
      reason,
    }),
    userPermissions: [P.ManageWebhooks],
    botPermissions: [P.ManageWebhooks],
    risk: 'write',
    execute: async (ctx, input) => {
      const hook = (await ctx.guild.fetchWebhooks()).get(input.webhookId);
      if (!hook) throw new UserError('Webhook does not belong to this server.');
      await channelWith(ctx, hook.channelId, [P.ManageWebhooks]);
      return summarizeWebhook(
        await hook.edit({
          name: input.name,
          avatar: input.avatar,
          reason: nowReason(ctx, input.reason),
        }),
      );
    },
  });
  registry.register({
    id: 'webhook.send',
    category: 'webhooks',
    description: 'Send a plain announcement through an authorized incoming webhook in this server.',
    schema: z.strictObject({
      webhookId: id,
      content: z.string().min(1).max(2000),
      username: z.string().min(1).max(80).optional(),
    }),
    userPermissions: [P.ManageWebhooks],
    botPermissions: [P.ManageWebhooks],
    risk: 'write',
    execute: async (ctx, input) => {
      const hook = (await ctx.guild.fetchWebhooks()).get(input.webhookId);
      if (!hook || !hook.isIncoming())
        throw new UserError('Incoming webhook does not belong to this server.');
      await channelWith(ctx, hook.channelId, [P.ManageWebhooks]);
      await sendChannel(ctx, hook.channelId);
      const message = await hook.send({
        content: input.content,
        username: input.username,
        allowedMentions: { parse: [] },
      });
      return { id: message.id, channelId: message.channelId };
    },
  });
  registry.register({
    id: 'webhook.delete',
    category: 'webhooks',
    description: 'Permanently delete a webhook belonging to an accessible server channel.',
    schema: z.strictObject({ webhookId: id, reason }),
    userPermissions: [P.ManageWebhooks],
    botPermissions: [P.ManageWebhooks],
    risk: 'destructive',
    execute: async (ctx, input) => {
      const hook = (await ctx.guild.fetchWebhooks()).get(input.webhookId);
      if (!hook) throw new UserError('Webhook does not belong to this server.');
      await channelWith(ctx, hook.channelId, [P.ManageWebhooks]);
      await hook.delete(nowReason(ctx, input.reason));
      return { deletedWebhookId: input.webhookId };
    },
  });
  registry.register({
    id: 'bot.nickname',
    category: 'identity',
    description: 'Change or reset the bot nickname in this server.',
    schema: z.strictObject({
      nickname: z.string().min(1).max(32).nullable(),
      reason,
    }),
    userPermissions: [P.ManageNicknames],
    botPermissions: [P.ChangeNickname],
    risk: 'write',
    execute: async (ctx, input) => {
      const bot = await ctx.guild.members.fetchMe();
      await bot.setNickname(input.nickname, nowReason(ctx, input.reason));
      return { nickname: input.nickname };
    },
  });
  registry.register({
    id: 'premium.skus',
    category: 'premium',
    description: 'List application SKUs already configured through eligible Discord monetization setup.',
    schema: empty,
    userPermissions: [P.ManageGuild],
    botPermissions: [],
    risk: 'read',
    execute: async ({ client }) => {
      if (!client.application) throw new UserError('Application is unavailable.');
      return (await client.application.fetchSKUs()).map((sku) => ({
        id: sku.id,
        name: sku.name,
        type: sku.type,
        flags: sku.flags.bitfield,
      }));
    },
  });
  registry.register({
    id: 'premium.entitlements',
    category: 'premium',
    description: 'Read existing premium entitlements scoped to this server.',
    schema: empty,
    userPermissions: [P.ManageGuild],
    botPermissions: [],
    risk: 'read',
    execute: async ({ client, guild }) => {
      if (!client.application) throw new UserError('Application is unavailable.');
      return (
        await client.application.entitlements.fetch({
          guild: guild.id,
          excludeDeleted: true,
          excludeEnded: true,
          limit: 100,
        })
      )
        .filter((e) => e.guildId === guild.id)
        .map((e) => ({
          id: e.id,
          skuId: e.skuId,
          guildId: e.guildId,
          userId: e.userId,
          startsAt: e.startsAt?.toISOString(),
          endsAt: e.endsAt?.toISOString(),
        }));
    },
  });
}
