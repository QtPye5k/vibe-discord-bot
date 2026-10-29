import {
  EmbedBuilder,
  PermissionFlagsBits as P,
  escapeMarkdown,
  type GuildMember,
  type MessageCreateOptions,
} from 'discord.js';
import type { Store } from '../core/store.js';

export interface WelcomeConfiguration {
  welcomeChannelId: string | null;
  welcomeTemplate: string;
  welcomeStyle: 'text' | 'embed';
  welcomeTitle: string;
  welcomeColor: string;
  welcomeMention: boolean;
}
interface Delivery {
  at: number;
  channelId: string;
  state: 'sending' | 'sent' | 'uncertain';
  messageId?: string;
}
const deliveries = 'community.welcomeSeen';
const enabled = (member: GuildMember, store: Store) =>
  !(store.get<string[]>('core.disabled', member.guild.id) ?? []).includes('community');
const occurrence = (member: GuildMember) => `${member.guild.id}:${member.id}:${member.joinedTimestamp ?? 0}`;
const revision = (config: WelcomeConfiguration) =>
  JSON.stringify([
    config.welcomeChannelId,
    config.welcomeTemplate,
    config.welcomeStyle,
    config.welcomeTitle,
    config.welcomeColor,
    config.welcomeMention,
  ]);
function avatar(member: GuildMember): string | undefined {
  const value =
    member.displayAvatarURL?.({ extension: 'png', size: 256, forceStatic: true }) ??
    member.user.displayAvatarURL?.({ extension: 'png', size: 256, forceStatic: true });
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'cdn.discordapp.com') return url.href;
  } catch {
    /* An invalid avatar URL never prevents the welcome itself. */
  }
}
export function formatWelcomeTemplate(template: string, member: GuildMember): string {
  const count =
      Number.isSafeInteger(member.guild.memberCount) && member.guild.memberCount > 0
        ? member.guild.memberCount.toLocaleString('en-US')
        : '—',
    values: Record<string, string> = {
      user: `<@${member.id}>`,
      id: member.id,
      name: escapeMarkdown(member.user.username),
      username: escapeMarkdown(member.user.username),
      displayName: escapeMarkdown(member.displayName),
      server: escapeMarkdown(member.guild.name),
      memberCount: count,
      count,
      avatar: avatar(member) ?? '',
    };
  // One substitution pass avoids treating a user's literal braces as another template.
  return template.replace(
    /\{(user|id|name|username|displayName|server|memberCount|count|avatar)\}/g,
    (literal, key: string) => values[key] ?? literal,
  );
}
export function welcomePayload(member: GuildMember, config: WelcomeConfiguration): MessageCreateOptions {
  const description = formatWelcomeTemplate(config.welcomeTemplate, member).slice(0, 1900).trim(),
    allowedMentions = { parse: [] as never[], users: config.welcomeMention ? [member.id] : [] };
  if (config.welcomeStyle === 'text')
    return { content: description || `Welcome, <@${member.id}>!`, allowedMentions };
  const embed = new EmbedBuilder()
    .setColor(Number.parseInt(config.welcomeColor.slice(1), 16))
    .setTitle(formatWelcomeTemplate(config.welcomeTitle, member).slice(0, 256) || 'Welcome!')
    .setDescription(description || `Welcome, <@${member.id}>!`)
    .setFooter({
      text: `Member #${Number.isSafeInteger(member.guild.memberCount) ? member.guild.memberCount.toLocaleString('en-US') : '—'}`,
    })
    .setTimestamp(member.joinedTimestamp ?? Date.now());
  const thumbnail = avatar(member);
  if (thumbnail) embed.setThumbnail(thumbnail);
  return {
    ...(config.welcomeMention ? { content: `<@${member.id}>` } : {}),
    embeds: [embed],
    allowedMentions,
  };
}

/** Future human joins only: one durable claim for this exact join occurrence, with no ambiguous-send retry. */
export async function sendMemberWelcome(
  member: GuildMember,
  store: Store,
  configuration: () => WelcomeConfiguration,
): Promise<void> {
  if (member.user.bot || !enabled(member, store)) return;
  const config = configuration();
  if (!config.welcomeChannelId) return;
  const key = occurrence(member),
    expected = revision(config);
  if (store.get(deliveries, key)) return;
  const [fresh, bot] = await Promise.all([
    member.guild.members.fetch({ user: member.id, force: true }).catch(() => null),
    member.guild.members.fetchMe({ force: true }).catch(() => null),
  ]);
  if (
    !fresh ||
    !bot ||
    fresh.user.bot ||
    fresh.guild.id !== member.guild.id ||
    bot.guild.id !== member.guild.id ||
    occurrence(fresh) !== key
  )
    return;
  if (!enabled(member, store) || revision(configuration()) !== expected) return;
  const channel = await member.guild.channels
    .fetch(config.welcomeChannelId, { force: true })
    .catch(() => null);
  if (
    !channel ||
    channel.guildId !== member.guild.id ||
    !channel.isSendable() ||
    !enabled(member, store) ||
    revision(configuration()) !== expected
  )
    return;
  const required = [
    P.ViewChannel,
    channel.isThread() ? P.SendMessagesInThreads : P.SendMessages,
    ...(config.welcomeStyle === 'embed' ? [P.EmbedLinks] : []),
  ];
  if (!channel.permissionsFor(bot)?.has(required) || !channel.permissionsFor(fresh)?.has(P.ViewChannel))
    return;
  const claimed = store.transaction(() => {
    if (store.get(deliveries, key)) return false;
    store.set(deliveries, key, {
      at: Date.now(),
      channelId: channel.id,
      state: 'sending',
    } satisfies Delivery);
    return true;
  });
  if (!claimed) return;
  try {
    const sent = await channel.send(welcomePayload(fresh, config));
    store.set(deliveries, key, {
      at: Date.now(),
      channelId: channel.id,
      state: 'sent',
      messageId: sent.id,
    } satisfies Delivery);
  } catch {
    store.set(deliveries, key, {
      at: Date.now(),
      channelId: channel.id,
      state: 'uncertain',
    } satisfies Delivery);
  }
  const seen = store
    .list<Delivery>(deliveries, `${member.guild.id}:`)
    .sort((a, b) => b.value.at - a.value.at);
  for (const [index, row] of seen.entries())
    if (row.value.at < Date.now() - 30 * 86400000 || index >= 5000) store.delete(deliveries, row.key);
}
