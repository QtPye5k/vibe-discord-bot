import { ChannelType, PermissionFlagsBits as P } from 'discord.js';
import { z } from 'zod';
import { credentialPresent, type Config } from '../config.js';
import type { ActionRegistry } from '../core/registry.js';
import { resolveChannel } from '../core/permissions.js';
import { UserError } from '../core/errors.js';
import { assertPrivateTranscriptPrivacy } from '../voice/transcripts.js';
import { moderationPolicySchema, type createAutomaticModeration } from './service.js';

const snowflake = z.string().regex(/^\d{17,20}$/);
const patch = z.strictObject({
  enabled: z.boolean().optional(),
  textEnabled: z.boolean().optional(),
  imagesEnabled: z.boolean().optional(),
  honeypotChannelId: snowflake.nullable().optional(),
  logChannelId: snowflake.nullable().optional(),
});

export function registerAutomaticModerationActions(
  registry: ActionRegistry,
  service: ReturnType<typeof createAutomaticModeration>,
  config: Config,
): void {
  registry.register({
    id: 'moderation.automatic.status',
    description:
      'Read automatic sexual-content filtering, honeypot policy and recent private moderation outcomes.',
    category: 'moderation',
    risk: 'read',
    schema: z.strictObject({}),
    userPermissions: [P.ManageGuild],
    botPermissions: [],
    execute: (ctx) => ({
      ...service.status(ctx.guild.id),
      hostEnabled: config.autoModerationEnabled,
      classifierModel: config.moderationModel,
      classifierConfigured: credentialPresent(config.openaiKey),
      recentCases: ctx.store.db
        .prepare(
          "SELECT value FROM kv WHERE namespace='moderation.automatic.cases' AND json_extract(value,'$.guildId')=? ORDER BY updated_at DESC LIMIT 25",
        )
        .all(ctx.guild.id)
        .map((row) => JSON.parse(String(row.value)) as unknown),
      notice:
        'Honeypot posts automatically ban eligible accounts. Explicit content is deleted, not banned. Owner and Discord role hierarchy restrictions still apply.',
    }),
  });
  registry.register({
    id: 'moderation.automatic.configure',
    description:
      'Configure automatic explicit-content deletion and the channel whose posts trigger immediate bans; one exact policy approval.',
    category: 'moderation',
    risk: 'write',
    confirmation: 'always',
    schema: patch,
    userPermissions: [P.ManageGuild],
    botPermissions: [],
    execute: async (ctx, input) => {
      const next = moderationPolicySchema.parse({ ...service.policy(ctx.guild.id), ...input });
      if (next.enabled && !config.autoModerationEnabled)
        throw new UserError(
          'Set AUTO_MODERATION_ENABLED=true in .env and restart before enabling this policy.',
        );
      if (next.enabled && (next.textEnabled || next.imagesEnabled) && !credentialPresent(config.openaiKey))
        throw new UserError(
          'The existing OPENAI_API_KEY is required for automatic explicit-content classification.',
        );
      if (next.honeypotChannelId && next.honeypotChannelId === next.logChannelId)
        throw new UserError('The moderation log and honeypot must be different channels.');
      const bot = await ctx.guild.members.fetchMe({ force: true });
      if (next.enabled && next.honeypotChannelId) {
        if (!ctx.member.permissions.has(P.BanMembers) || !bot.permissions.has(P.BanMembers))
          throw new UserError('Both you and Vibe need Ban Members to enable the honeypot.');
        const channel = await resolveChannel(ctx, next.honeypotChannelId);
        if (
          channel.type !== ChannelType.GuildText ||
          !channel.permissionsFor(bot)?.has([P.ReadMessageHistory, P.ManageMessages])
        )
          throw new UserError('The honeypot must be a text channel Vibe can read and moderate.');
      }
      if (next.logChannelId) {
        const roles = await ctx.guild.roles.fetch();
        const channel = await resolveChannel(ctx, next.logChannelId);
        assertPrivateTranscriptPrivacy(ctx, channel, bot, roles);
        if (!channel.permissionsFor(bot)?.has([P.SendMessages, P.ReadMessageHistory]))
          throw new UserError(
            'Vibe needs Send Messages and Read Message History in the private log channel.',
          );
      }
      ctx.store.set('moderation.automatic', ctx.guild.id, next);
      return {
        policy: next,
        notice:
          'Enabled rules run automatically without per-message confirmations. No historical messages were scanned or members banned by this configuration change.',
      };
    },
  });
}
