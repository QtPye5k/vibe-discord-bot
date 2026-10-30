import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits as P,
  type GuildMember,
  type GuildTextBasedChannel,
} from 'discord.js';
import { assertUserRequestCurrent, type ActionContext } from './types.js';
import type { ConfirmationPolicy, PendingConfirmation } from './registry.js';
import { UserError } from './errors.js';
import { redact } from './logger.js';
import { outcomePayload } from '../discord/presentation.js';

export interface ConfirmationPolicyOptions {
  channelId?: string;
  name?: string;
  /** Production adapters classify private account links, exports and other requester-only results. */
  isPrivateAction?: (id: string) => boolean;
}
/** No administrator/owner exception: this is an explicit comparison with Vibe's highest role. */
export function isConfirmationReviewer(member: GuildMember, bot: GuildMember): boolean {
  return (
    !member.user.bot && member.id !== bot.id && member.roles.highest.comparePositionTo(bot.roles.highest) > 0
  );
}
export function createConfirmationPolicy(options: ConfirmationPolicyOptions = {}): ConfirmationPolicy {
  const name = options.name?.trim() || 'bot-confirmations';
  const channelId = (ctx: ActionContext) =>
    options.channelId || ctx.store.get<string>('core.confirmationChannel', ctx.guild.id);
  async function resolve(ctx: ActionContext) {
    await ctx.guild.roles.fetch();
    const bot = await ctx.guild.members.fetchMe({ force: true });
    let id = channelId(ctx);
    if (!id) {
      const channels = await ctx.guild.channels.fetch();
      const candidates = channels.filter(
        (channel) => channel?.type === ChannelType.GuildText && channel.name === name,
      );
      if (candidates.size !== 1)
        throw new UserError(
          'Configure one dedicated private bot-confirmations channel before requesting approval.',
        );
      id = candidates.first()!.id;
    }
    const channel = await ctx.guild.channels.fetch(id, { force: true });
    if (!channel || channel.guildId !== ctx.guild.id || channel.type !== ChannelType.GuildText)
      throw new UserError('The dedicated confirmation channel must be a text channel in this server.');
    const everyone = channel.permissionOverwrites.cache.get(ctx.guild.id);
    if (!everyone?.deny.has(P.ViewChannel) || everyone.allow.has(P.ViewChannel))
      throw new UserError('The confirmation channel must deny View Channel to @everyone.');
    for (const overwrite of channel.permissionOverwrites.cache.values()) {
      if (!overwrite.allow.has(P.ViewChannel) || overwrite.id === bot.id) continue;
      if (overwrite.type === 0) {
        const role = ctx.guild.roles.cache.get(overwrite.id);
        const ownManagedBotRole =
          role?.managed && bot.roles.cache.has(role.id) && role.tags?.botId === bot.id;
        if (!ownManagedBotRole && (!role || role.comparePositionTo(bot.roles.highest) <= 0))
          throw new UserError('The confirmation channel grants access to a role that is not above Vibe.');
      } else {
        const member = await ctx.guild.members.fetch({ user: overwrite.id, force: true });
        if (!isConfirmationReviewer(member, bot))
          throw new UserError(
            'The confirmation channel grants access to a member whose role is not above Vibe.',
          );
      }
    }
    if (!channel.permissionsFor(bot)?.has([P.ViewChannel, P.SendMessages, P.ReadMessageHistory]))
      throw new UserError(
        'Vibe needs View Channel, Send Messages and Read Message History in its private confirmation channel.',
      );
    ctx.store.set('core.confirmationChannel', ctx.guild.id, channel.id);
    return { channel, bot };
  }
  return {
    channelId,
    async preparePrivateResult(ctx, action) {
      if (!options.isPrivateAction?.(action)) return undefined;
      assertUserRequestCurrent(ctx);
      let message;
      try {
        message = await ctx.member.user.send({
          content:
            'An authorized reviewer is processing your Vibe request. Its private result will appear here.',
          allowedMentions: { parse: [] },
        });
      } catch {
        throw new UserError(
          'The original requester must enable DMs from this server before this private action can run. No action was executed.',
        );
      }
      assertUserRequestCurrent(ctx);
      return {
        deliver: async (outcome) => {
          await message.edit({ ...outcomePayload(outcome), allowedMentions: { parse: [] } });
        },
      };
    },
    async authorize(ctx) {
      assertUserRequestCurrent(ctx);
      const { channel, bot } = await resolve(ctx);
      assertUserRequestCurrent(ctx);
      if (ctx.channelId !== channel.id)
        throw new UserError(`Approve or reject this request only in <#${channel.id}>.`);
      const member = await ctx.guild.members.fetch({ user: ctx.member.id, force: true });
      assertUserRequestCurrent(ctx);
      if (!isConfirmationReviewer(member, bot))
        throw new UserError(
          'Only a human member whose highest role is strictly above Vibe can approve or reject requests.',
        );
      if (!channel.permissionsFor(member)?.has([P.ViewChannel, P.ReadMessageHistory]))
        throw new UserError(
          'You need current access to the private confirmation channel to review requests.',
        );
      return { ...ctx, member };
    },
    async publish(ctx, pending: PendingConfirmation) {
      const { channel } = await resolve(ctx);
      assertUserRequestCurrent(ctx);
      const exactInput = redact(
        JSON.stringify(
          pending.input,
          (_, value) => (typeof value === 'bigint' ? value.toString() : value),
          2,
        ) ?? 'null',
      );
      if (Buffer.byteLength(exactInput) > 7_000_000)
        throw new UserError(
          'This action is too large for an exact private approval preview. Submit a smaller request.',
        );
      const header = `**Approval required: ${pending.action}**\nRequested by <@${ctx.member.id}> in <#${ctx.channelId}>.\nID: \`${pending.id}\` · expires <t:${Math.floor(pending.expiresAt / 1000)}:R>\nOnly members with a highest role strictly above Vibe may approve or reject.`,
        inline = exactInput.length <= 1100;
      await (channel as GuildTextBasedChannel).send({
        content:
          header +
          (inline
            ? `\n\`\`\`json\n${exactInput.replaceAll('```', '[code fence]')}\n\`\`\``
            : '\nReview the exact input in the attached JSON file.'),
        allowedMentions: { parse: [] },
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`confirm:${pending.id}`)
              .setLabel('Approve')
              .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
              .setCustomId(`cancel:${pending.id}`)
              .setLabel('Reject')
              .setStyle(ButtonStyle.Danger),
          ),
        ],
        ...(inline ? {} : { files: [{ attachment: Buffer.from(exactInput), name: 'approval-input.json' }] }),
      });
    },
  };
}
