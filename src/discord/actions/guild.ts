import {
  GuildVerificationLevel,
  GuildExplicitContentFilter,
  GuildDefaultMessageNotifications,
  GuildFeature,
  GuildOnboardingMode,
  GuildOnboardingPromptType,
  SystemChannelFlagsBitField,
  ChannelType,
  type GuildEditOptions,
} from 'discord.js';
import type { ActionRegistry } from '../../core/registry.js';
import { assertPermissions, assertRoleHierarchy, freshContext, resolveRole } from '../../core/permissions.js';
import { assertOrdinaryRole } from '../../core/safe-role.js';
import {
  P,
  z,
  id,
  empty,
  reason,
  imageData,
  nowReason,
  channelWith,
  summarizeChannel,
  summarizeRole,
  UserError,
} from './shared.js';

export function registerGuildActions(registry: ActionRegistry): void {
  registry.register({
    id: 'guild.system-flags',
    category: 'server',
    risk: 'write',
    description:
      'Replace the supported system-message suppression flags, preserving the configured system channel.',
    schema: z.strictObject({
      flags: z
        .number()
        .int()
        .min(0)
        .max(0x7fffffff)
        .refine(
          (value) =>
            (value &
              ~Object.values(SystemChannelFlagsBitField.Flags)
                .filter((bit): bit is number => typeof bit === 'number')
                .reduce((a, b) => a | b, 0)) ===
            0,
          'Unknown system-message flag bits',
        ),
      reason,
    }),
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    execute: async (ctx, input) => {
      const result = await ctx.guild.edit({
        systemChannelFlags: input.flags,
        reason: nowReason(ctx, input.reason),
      });
      return { guildId: result.id, systemChannelFlags: result.systemChannelFlags.bitfield };
    },
  });
  registry.register({
    id: 'guild.community',
    category: 'server',
    risk: 'write',
    description:
      'Enable or disable Community with explicit rules/update channels while retaining other server features.',
    schema: z.strictObject({
      enabled: z.boolean(),
      rulesChannelId: id.optional(),
      updatesChannelId: id.optional(),
      reason,
    }),
    userPermissions: [P.Administrator],
    botPermissions: [P.Administrator],
    execute: async (ctx, input) => {
      const fresh = await ctx.guild.fetch();
      for (const channelId of [input.rulesChannelId, input.updatesChannelId].filter(
        (value): value is string => !!value,
      )) {
        const channel = await channelWith(ctx, channelId);
        if (channel.type !== ChannelType.GuildText)
          throw new UserError('Community rules and updates channels must be regular text channels.');
      }
      if (input.enabled && !(input.rulesChannelId ?? fresh.rulesChannelId))
        throw new UserError('Select a rules channel before enabling Community.');
      if (input.enabled && !(input.updatesChannelId ?? fresh.publicUpdatesChannelId))
        throw new UserError('Select a community updates channel before enabling Community.');
      const features = [
        ...fresh.features.filter((feature) => feature !== GuildFeature.Community),
        ...(input.enabled ? [GuildFeature.Community] : []),
      ];
      const result = await fresh.edit({
        features,
        rulesChannel: input.rulesChannelId,
        publicUpdatesChannel: input.updatesChannelId,
        reason: nowReason(ctx, input.reason),
      });
      return {
        guildId: result.id,
        community: result.features.includes(GuildFeature.Community),
        features: result.features,
      };
    },
  });
  registry.register({
    id: 'guild.onboarding-edit',
    category: 'server',
    risk: 'write',
    description:
      'Create, replace, reorder or delete Community onboarding prompts/options using an exact reviewed prompt array.',
    schema: z.strictObject({
      enabled: z.boolean().optional(),
      mode: z.nativeEnum(GuildOnboardingMode).optional(),
      defaultChannelIds: z.array(id).max(50).optional(),
      prompts: z
        .array(
          z.strictObject({
            id: id.optional(),
            title: z.string().min(1).max(100),
            type: z.nativeEnum(GuildOnboardingPromptType).default(GuildOnboardingPromptType.MultipleChoice),
            singleSelect: z.boolean().default(false),
            required: z.boolean().default(false),
            inOnboarding: z.boolean().default(true),
            options: z
              .array(
                z.strictObject({
                  id: id.optional(),
                  title: z.string().min(1).max(100),
                  description: z.string().max(100).optional(),
                  emoji: z.string().max(100).optional(),
                  channelIds: z.array(id).max(10).default([]),
                  roleIds: z.array(id).max(10).default([]),
                }),
              )
              .min(1)
              .max(50),
          }),
        )
        .max(5),
      reason,
    }),
    userPermissions: [P.ManageGuild, P.ManageRoles],
    botPermissions: [P.ManageGuild, P.ManageRoles],
    execute: async (ctx, input) => {
      const roleIds = [
        ...new Set(input.prompts.flatMap((prompt) => prompt.options.flatMap((option) => option.roleIds))),
      ];
      const channelIds = [
        ...new Set([
          ...(input.defaultChannelIds ?? []),
          ...input.prompts.flatMap((prompt) => prompt.options.flatMap((option) => option.channelIds)),
        ]),
      ];
      if (roleIds.length > 25 || channelIds.length > 50)
        throw new UserError(
          'Onboarding supports at most 25 distinct roles and 50 distinct channels per update.',
        );
      for (const channelId of channelIds) await channelWith(ctx, channelId);
      for (const roleId of roleIds) {
        const role = await resolveRole(ctx, roleId);
        assertRoleHierarchy(ctx, role);
        assertOrdinaryRole(role, ctx.guild.members.me!);
      }
      const result = await ctx.guild.editOnboarding({
        enabled: input.enabled,
        mode: input.mode,
        defaultChannels: input.defaultChannelIds,
        prompts: input.prompts.map((prompt) => ({
          ...prompt,
          options: prompt.options.map(({ channelIds, roleIds, ...option }) => ({
            ...option,
            channels: channelIds,
            roles: roleIds,
          })),
        })),
        reason: nowReason(ctx, input.reason),
      });
      return {
        guildId: ctx.guild.id,
        enabled: result.enabled,
        mode: result.mode,
        promptCount: result.prompts.size,
      };
    },
  });
  const pruneSchema = {
    days: z.number().int().min(1).max(30).default(7),
    roleIds: z.array(id).max(25).default([]),
  };
  for (const execute of [false, true])
    registry.register({
      id: execute ? 'guild.prune' : 'guild.prune-count',
      category: 'server',
      description: execute
        ? 'Server owner executes a native inactive-member prune after an exact count check; removes members and cannot be undone.'
        : 'Preview Discord’s native inactive-member prune count; a later prune requires the owner’s separate confirmation.',
      risk: execute ? 'destructive' : 'read',
      userPermissions: [P.ManageGuild, P.KickMembers],
      botPermissions: [P.ManageGuild, P.KickMembers],
      schema: z.strictObject({
        ...pruneSchema,
        ...(execute ? { expectedCount: z.number().int().min(0), reason } : {}),
      }),
      execute: async (ctx, input) => {
        const authorize = async () => {
          let current = await freshContext(ctx);
          const roles = [];
          for (const roleId of input.roleIds) roles.push(await resolveRole(current, roleId));
          await assertPermissions(
            current,
            [P.ManageGuild, P.KickMembers],
            [P.ManageGuild, P.KickMembers],
            input,
          );
          current = { ...current, guild: await current.guild.fetch() };
          registry.assertPolicy(current, execute ? 'guild.prune' : 'guild.prune-count');
          if (execute && current.member.id !== current.guild.ownerId)
            throw new UserError('Only the server owner may execute a bulk native prune.');
          for (const member of [current.member, current.guild.members.me!]) {
            if (!member.permissions.has([P.ManageGuild, P.KickMembers]))
              throw new UserError('Current server prune permissions are required for you and the bot.');
            if (
              current.guild.features.includes('PRUNE_REQUIRES_ADMIN') &&
              !member.permissions.has(P.Administrator)
            )
              throw new UserError('This server requires Administrator for native prune operations.');
          }
          for (const role of roles) assertRoleHierarchy(current, role);
          return current;
        };
        const authorized = await authorize();
        const count = await authorized.guild.members.prune({
          days: input.days,
          roles: input.roleIds,
          dry: true,
        });
        if (!execute)
          return {
            count,
            days: input.days,
            roleIds: input.roleIds,
            notice:
              'Counts can change before execution. Native pruning uses Discord inactivity criteria, not this bot’s observed message activity.',
          };
        if (count !== input.expectedCount)
          throw new UserError(
            `Prune count changed to ${count}; review a fresh preview before confirming again.`,
          );
        if (count === 0) return { started: false, pruned: 0 };
        const current = await authorize();
        await current.guild.members.prune({
          days: input.days,
          roles: input.roleIds,
          count: false,
          reason: nowReason(current, reason.parse(input.reason)),
        });
        return {
          started: true,
          previewCount: count,
          pruned: null,
          notice:
            'Discord performs the bulk prune; the preview and execution are separate requests and cannot lock membership.',
        };
      },
    });
  registry.register({
    id: 'guild.info',
    category: 'server',
    description: 'Read server identity, features, boost tier and member counts.',
    schema: empty,
    userPermissions: [],
    botPermissions: [],
    risk: 'read',
    execute: async ({ guild }) => {
      const fresh = await guild.fetch();
      return {
        id: fresh.id,
        name: fresh.name,
        description: fresh.description,
        ownerId: fresh.ownerId,
        icon: fresh.iconURL(),
        banner: fresh.bannerURL(),
        memberCount: fresh.memberCount,
        features: fresh.features,
        premiumTier: fresh.premiumTier,
        premiumSubscriptionCount: fresh.premiumSubscriptionCount,
        verificationLevel: fresh.verificationLevel,
        afkChannelId: fresh.afkChannelId,
        afkTimeout: fresh.afkTimeout,
        systemChannelId: fresh.systemChannelId,
        rulesChannelId: fresh.rulesChannelId,
        publicUpdatesChannelId: fresh.publicUpdatesChannelId,
        defaultMessageNotifications: fresh.defaultMessageNotifications,
        explicitContentFilter: fresh.explicitContentFilter,
      };
    },
  });
  registry.register({
    id: 'guild.edit',
    category: 'server',
    description: 'Update supported server name, description, verification, safety and notification settings.',
    schema: z.strictObject({
      name: z.string().min(2).max(100).optional(),
      description: z.string().max(120).nullable().optional(),
      verificationLevel: z.nativeEnum(GuildVerificationLevel).optional(),
      explicitContentFilter: z.nativeEnum(GuildExplicitContentFilter).optional(),
      defaultMessageNotifications: z.nativeEnum(GuildDefaultMessageNotifications).optional(),
      afkTimeout: z
        .union([z.literal(60), z.literal(300), z.literal(900), z.literal(1800), z.literal(3600)])
        .optional(),
      premiumProgressBarEnabled: z.boolean().optional(),
      reason,
    }),
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'write',
    execute: async (ctx, { reason: why, ...options }) => {
      if (!Object.keys(options).length) throw new UserError('Provide at least one setting.');
      const edited = await ctx.guild.edit({
        ...options,
        reason: nowReason(ctx, why),
      });
      return {
        id: edited.id,
        name: edited.name,
        updated: Object.keys(options),
      };
    },
  });
  registry.register({
    id: 'guild.visual',
    category: 'server',
    description: 'Set or clear a server icon, banner, splash, or discovery splash using image data.',
    schema: z.strictObject({
      kind: z.enum(['icon', 'banner', 'splash', 'discoverySplash']),
      image: imageData.nullable(),
      reason,
    }),
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'write',
    execute: async (ctx, input) => {
      const data: GuildEditOptions = {
        reason: nowReason(ctx, input.reason),
        [input.kind]: input.image,
      };
      const result = await ctx.guild.edit(data);
      return { guildId: result.id, updated: input.kind };
    },
  });
  registry.register({
    id: 'guild.channel-setting',
    category: 'server',
    description: 'Configure AFK, system, rules, updates or safety-alert channel.',
    schema: z.strictObject({
      setting: z.enum([
        'afkChannel',
        'systemChannel',
        'rulesChannel',
        'publicUpdatesChannel',
        'safetyAlertsChannel',
      ]),
      channelId: id.nullable(),
      reason,
    }),
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'write',
    execute: async (ctx, input) => {
      if (input.channelId) await channelWith(ctx, input.channelId);
      const result = await ctx.guild.edit({
        [input.setting]: input.channelId,
        reason: nowReason(ctx, input.reason),
      });
      return {
        guildId: result.id,
        updated: input.setting,
        channelId: input.channelId,
      };
    },
  });
  registry.register({
    id: 'guild.widget',
    category: 'server',
    description: 'Read the server widget configuration.',
    schema: empty,
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'read',
    execute: async ({ guild }) => {
      const value = await guild.fetchWidgetSettings();
      return { enabled: value.enabled, channelId: value.channel?.id ?? null };
    },
  });
  registry.register({
    id: 'guild.widget-set',
    category: 'server',
    description: 'Configure the public server widget.',
    schema: z.strictObject({
      enabled: z.boolean(),
      channelId: id.nullable(),
      reason,
    }),
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'write',
    execute: async (ctx, input) => {
      if (input.channelId) await channelWith(ctx, input.channelId);
      await ctx.guild.setWidgetSettings(
        { enabled: input.enabled, channel: input.channelId },
        nowReason(ctx, input.reason),
      );
      return { enabled: input.enabled, channelId: input.channelId };
    },
  });
  registry.register({
    id: 'guild.integrations',
    category: 'server',
    description: 'List integration names and types without access tokens.',
    schema: empty,
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'read',
    execute: async ({ guild }) =>
      (await guild.fetchIntegrations()).map((integration) => ({
        id: integration.id,
        name: integration.name,
        type: integration.type,
        enabled: integration.enabled,
      })),
  });
  registry.register({
    id: 'guild.vanity',
    category: 'server',
    description: 'Read the vanity invite code and available usage count.',
    schema: empty,
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'read',
    execute: ({ guild }) => guild.fetchVanityData(),
  });
  registry.register({
    id: 'guild.welcome',
    category: 'server',
    description: 'Read the Community welcome screen.',
    schema: empty,
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'read',
    execute: async ({ guild }) => {
      const screen = await guild.fetchWelcomeScreen();
      return {
        description: screen.description,
        channels: screen.welcomeChannels.map((channel) => ({
          channelId: channel.channelId,
          description: channel.description,
          emoji: channel.emoji,
        })),
      };
    },
  });
  registry.register({
    id: 'guild.welcome-set',
    category: 'server',
    description: 'Set the Community welcome screen description and channels.',
    schema: z.strictObject({
      enabled: z.boolean(),
      description: z.string().max(140).nullable(),
      channels: z
        .array(
          z.strictObject({
            channelId: id,
            description: z.string().min(1).max(50),
            emoji: z.string().max(100).optional(),
          }),
        )
        .max(5),
      reason,
    }),
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'write',
    execute: async (ctx, input) => {
      for (const channel of input.channels) await channelWith(ctx, channel.channelId);
      await ctx.guild.editWelcomeScreen({
        enabled: input.enabled,
        description: input.description ?? '',
        welcomeChannels: input.channels.map((c) => ({
          channel: c.channelId,
          description: c.description,
          emoji: c.emoji,
        })),
      });
      return { updated: true };
    },
  });
  registry.register({
    id: 'guild.onboarding',
    category: 'server',
    description: 'Read Community onboarding prompts, choices and defaults.',
    schema: empty,
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'read',
    execute: async ({ guild }) => {
      const data = await guild.fetchOnboarding();
      return {
        enabled: data.enabled,
        mode: data.mode,
        defaultChannelIds: data.defaultChannels.map((channel) => channel.id),
        prompts: data.prompts.map((p) => ({
          id: p.id,
          title: p.title,
          singleSelect: p.singleSelect,
          required: p.required,
          options: p.options.map((o) => ({
            id: o.id,
            title: o.title,
            description: o.description,
            channelIds: [...o.channels.keys()],
            roleIds: [...o.roles.keys()],
          })),
        })),
      };
    },
  });
  registry.register({
    id: 'guild.onboarding-defaults',
    category: 'server',
    description: 'Enable onboarding and configure default channels (Discord eligibility applies).',
    schema: z.strictObject({
      enabled: z.boolean(),
      channelIds: z.array(id).max(20),
      reason,
    }),
    userPermissions: [P.ManageGuild, P.ManageRoles],
    botPermissions: [P.ManageGuild, P.ManageRoles],
    risk: 'write',
    execute: async (ctx, input) => {
      for (const channelId of input.channelIds) await channelWith(ctx, channelId);
      await ctx.guild.editOnboarding({
        enabled: input.enabled,
        defaultChannels: input.channelIds,
        reason: nowReason(ctx, input.reason),
      });
      return { updated: true };
    },
  });
  registry.register({
    id: 'guild.incident',
    category: 'security',
    description: 'Temporarily pause invites and/or direct messages for incident response.',
    schema: z.strictObject({
      invitesDisabledUntil: z.iso.datetime().nullable(),
      dmsDisabledUntil: z.iso.datetime().nullable(),
    }),
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'destructive',
    execute: async ({ guild }, input) => {
      const max = Date.now() + 24 * 60 * 60 * 1000;
      for (const value of Object.values(input))
        if (value && (Date.parse(value) <= Date.now() || Date.parse(value) > max))
          throw new UserError('Incident pauses must end within the next 24 hours.');
      const result = await guild.setIncidentActions(input);
      return {
        invitesDisabledUntil: result.invitesDisabledUntil?.toISOString() ?? null,
        dmsDisabledUntil: result.dmsDisabledUntil?.toISOString() ?? null,
      };
    },
  });
  registry.register({
    id: 'guild.invites-toggle',
    category: 'security',
    description: 'Disable or re-enable invitations using Discord incident controls.',
    schema: z.strictObject({ disabled: z.boolean() }),
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'destructive',
    execute: async ({ guild }, { disabled }) => {
      await guild.disableInvites(disabled);
      return { disabled };
    },
  });
  registry.register({
    id: 'guild.audit',
    category: 'moderation',
    description: 'Retrieve recent Discord audit log entries.',
    schema: z.strictObject({
      limit: z.number().int().min(1).max(100).default(25),
      before: id.optional(),
    }),
    userPermissions: [P.ViewAuditLog],
    botPermissions: [P.ViewAuditLog],
    risk: 'read',
    execute: async ({ guild }, input) =>
      (await guild.fetchAuditLogs(input)).entries.map((entry) => ({
        id: entry.id,
        action: entry.action,
        executorId: entry.executorId,
        targetId: entry.targetId,
        reason: entry.reason,
        createdAt: entry.createdAt.toISOString(),
        changes: entry.changes,
      })),
  });
  registry.register({
    id: 'guild.templates',
    category: 'server',
    description: 'List server configuration templates.',
    schema: empty,
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'read',
    execute: async ({ guild }) =>
      (await guild.fetchTemplates()).map((template) => ({
        code: template.code,
        name: template.name,
        description: template.description,
        updatedAt: template.updatedAt?.toISOString(),
        dirty: template.unSynced,
      })),
  });
  registry.register({
    id: 'guild.template-create',
    category: 'server',
    description: 'Create a Discord server configuration template.',
    schema: z.strictObject({
      name: z.string().min(1).max(100),
      description: z.string().max(120).optional(),
    }),
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'write',
    execute: async ({ guild }, input) => {
      const value = await guild.createTemplate(input.name, input.description);
      return { code: value.code, name: value.name, url: value.url };
    },
  });
  registry.register({
    id: 'guild.template-sync',
    category: 'server',
    description: 'Synchronize a template belonging to this server.',
    schema: z.strictObject({
      code: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
    }),
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'write',
    execute: async ({ guild }, { code }) => {
      const template = (await guild.fetchTemplates()).get(code);
      if (!template) throw new UserError('Template does not belong to this server.');
      await template.sync();
      return { code, synchronized: true };
    },
  });
  registry.register({
    id: 'guild.snapshot',
    category: 'server',
    description: 'Export accessible channel settings, roles and server metadata; no messages or secrets.',
    schema: empty,
    userPermissions: [P.ManageGuild],
    botPermissions: [P.ManageGuild],
    risk: 'read',
    execute: async (ctx) => {
      const [channels, roles] = await Promise.all([ctx.guild.channels.fetch(), ctx.guild.roles.fetch()]);
      const visible = channels.filter(
        (channel) =>
          !!channel &&
          !!channel.permissionsFor(ctx.member)?.has(P.ViewChannel) &&
          !!channel.permissionsFor(ctx.guild.members.me!)?.has(P.ViewChannel),
      );
      return {
        version: 1,
        capturedAt: new Date().toISOString(),
        guild: {
          id: ctx.guild.id,
          name: ctx.guild.name,
          description: ctx.guild.description,
          verificationLevel: ctx.guild.verificationLevel,
        },
        channels: visible.map(
          (channel) =>
            channel && {
              ...summarizeChannel(channel),
              ...(!channel.isThread()
                ? {
                    overwrites: channel.permissionOverwrites.cache.map((o) => ({
                      id: o.id,
                      type: o.type,
                      allow: o.allow.bitfield.toString(),
                      deny: o.deny.bitfield.toString(),
                    })),
                  }
                : {}),
            },
        ),
        roles: roles.map(summarizeRole),
      };
    },
  });
}
