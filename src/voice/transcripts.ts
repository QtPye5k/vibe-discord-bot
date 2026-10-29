import {
  ChannelType,
  OverwriteType,
  PermissionFlagsBits as P,
  type GuildBasedChannel,
  type GuildMember,
  type Role,
} from 'discord.js';
import type { ActionContext } from '../core/types.js';
import { UserError } from '../core/errors.js';

/** Cheap privacy invariant for every freshly fetched destination, including active voice sessions. */
export function assertPrivateTranscriptPrivacy(
  ctx: ActionContext,
  channel: GuildBasedChannel,
  bot: GuildMember,
  roles: ReadonlyMap<string, Role> | undefined = ctx.guild.roles?.cache,
): void {
  if (channel.guildId !== ctx.guild.id || channel.type !== ChannelType.GuildText)
    throw new UserError('Voice transcripts require a dedicated private text channel in this server.');
  const everyone = channel.permissionOverwrites.cache.get(ctx.guild.id),
    everyoneRole = ctx.guild.roles?.everyone;
  if (
    !everyone ||
    everyone.type !== OverwriteType.Role ||
    !everyone.deny.has(P.ViewChannel) ||
    everyone.allow.has(P.ViewChannel) ||
    !everyoneRole ||
    channel.permissionsFor(everyoneRole)?.has(P.ViewChannel) !== false
  )
    throw new UserError(
      'The transcript channel must explicitly deny View Channel to @everyone. Public or broadly visible channels cannot receive voice transcripts.',
    );
  for (const overwrite of channel.permissionOverwrites.cache.values()) {
    if (
      overwrite.type !== OverwriteType.Role ||
      overwrite.id === ctx.guild.id ||
      !overwrite.allow.has(P.ViewChannel)
    )
      continue;
    const role = roles?.get(overwrite.id);
    const ownBotRole =
      role?.managed === true &&
      role.tags?.botId === bot.id &&
      ctx.client?.user?.id === bot.id &&
      bot.roles.cache.has(role.id);
    if (!ownBotRole)
      throw new UserError(
        'The transcript channel grants a role broad View Channel access. Use selected member permissions instead; only this bot’s verified managed role is permitted.',
      );
  }
}

/** Resolve only a reviewed private destination. This function never creates a channel or falls back to the command channel. */
export function createTranscriptResolver(
  options: { channelId?: string; name?: string } = {},
): (ctx: ActionContext) => Promise<string> {
  const configured = options.channelId?.trim() || '',
    name = options.name?.trim() || 'vibe-transcripts';
  if (configured && !/^\d{17,20}$/.test(configured))
    throw new UserError('VOICE_TRANSCRIPT_CHANNEL_ID must be a Discord channel ID.');
  if (!name || name.length > 100 || /[\r\n\u0000]/.test(name))
    throw new UserError(
      'VOICE_TRANSCRIPT_CHANNEL_NAME must be a single channel name of at most100characters.',
    );
  return async (ctx) => {
    try {
      const [member, bot, roles] = await Promise.all([
        ctx.guild.members.fetch({ user: ctx.member.id, force: true }),
        ctx.guild.members.fetchMe({ force: true }),
        ctx.guild.roles.fetch(),
      ]);
      if (
        member.id !== ctx.member.id ||
        member.guild.id !== ctx.guild.id ||
        bot.guild.id !== ctx.guild.id ||
        bot.id !== ctx.client.user?.id
      )
        throw new UserError(
          'Current server membership and bot identity are required for private transcripts.',
        );
      let selected = configured;
      if (!selected) {
        const channels = await ctx.guild.channels.fetch();
        const matches = [...channels.values()].filter(
          (channel) =>
            channel?.guildId === ctx.guild.id &&
            channel.type === ChannelType.GuildText &&
            channel.name === name,
        );
        if (matches.length !== 1)
          throw new UserError(
            `Create exactly one private text channel named ${name}, or set VOICE_TRANSCRIPT_CHANNEL_ID to the dedicated private channel.`,
          );
        selected = matches[0]!.id;
      }
      const channel = await ctx.guild.channels.fetch(selected, { force: true });
      if (!channel || channel.id !== selected)
        throw new UserError(
          'The configured private transcript channel is unavailable. Check VOICE_TRANSCRIPT_CHANNEL_ID.',
        );
      const fresh = { ...ctx, member };
      assertPrivateTranscriptPrivacy(fresh, channel, bot, roles);
      if (!channel.permissionsFor(member)?.has([P.ViewChannel, P.ReadMessageHistory]))
        throw new UserError(
          'You need View Channel and Read Message History in the private transcript channel before joining voice.',
        );
      if (!channel.permissionsFor(bot)?.has([P.ViewChannel, P.ReadMessageHistory, P.SendMessages]))
        throw new UserError(
          'Vibe needs View Channel, Read Message History and Send Messages in the private transcript channel.',
        );
      return channel.id;
    } catch (error) {
      if (error instanceof UserError) throw error;
      throw new UserError(
        'The private transcript destination could not be verified. Check channel configuration, bot access and server permissions; no public fallback is used.',
      );
    }
  };
}
