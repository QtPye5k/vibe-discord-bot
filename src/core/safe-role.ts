import { PermissionFlagsBits as P, type Role, type GuildMember } from 'discord.js';
import { UserError } from './errors.js';
export function assertOrdinaryRole(role: Role, bot: GuildMember): void {
  const ordinary = [
    P.ViewChannel,
    P.SendMessages,
    P.SendMessagesInThreads,
    P.ReadMessageHistory,
    P.AddReactions,
    P.Connect,
    P.Speak,
    P.UseVAD,
    P.Stream,
    P.RequestToSpeak,
    P.UseExternalEmojis,
    P.UseExternalStickers,
    P.SendTTSMessages,
    P.EmbedLinks,
    P.AttachFiles,
    P.UseApplicationCommands,
    P.UseExternalApps,
    P.SendVoiceMessages,
    P.UseSoundboard,
    P.UseExternalSounds,
    P.CreatePublicThreads,
    P.CreatePrivateThreads,
  ];
  const allowed = ordinary.reduce((bits, flag) => bits | flag, 0n);
  if (
    role.managed ||
    role.id === role.guild.id ||
    (role.permissions.bitfield & ~allowed) !== 0n ||
    bot.roles.highest.comparePositionTo(role) <= 0
  )
    throw new UserError('Choose an ordinary, nonmanaged role below the bot without privileged permissions.');
}
