import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type MessageCreateOptions } from 'discord.js';
import type { ActionOutcome } from '../core/registry.js';
import { redact } from '../core/logger.js';
import type { AiReply } from '../features/ai.js';
import type { ConversationActionResult } from '../core/conversation-actions.js';
import { publicMediaPage } from '../features/media-posting.js';

export const NO_MENTIONS = { parse: [] as never[] };
export type BotPayload = Pick<MessageCreateOptions, 'content' | 'files' | 'components' | 'allowedMentions'>;
export function conversationPayload(reply: ConversationActionResult): BotPayload {
  const parts = reply.outcomes.map(outcomePayload);
  const result = textPayload(
    [reply.message, ...parts.map((part) => part.content)].filter(Boolean).join('\n\n') || 'Done.',
  );
  const files = parts.flatMap((part) => part.files ?? []);
  if (files.length) result.files = [...(result.files ?? []), ...files];
  return result;
}
export function aiPayload(reply: AiReply): BotPayload {
  const payload = textPayload(
    reply.text + (reply.pending.length ? '\n\n' + reply.pending.map(preview).join('\n\n') : ''),
    confirmationRows(reply.pending),
  );
  if (reply.files?.length) payload.files = [...(payload.files ?? []), ...reply.files];
  return payload;
}
export function stringify(value: unknown): string {
  return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) ?? 'null';
}
export function confirmationRows(
  pending: Extract<ActionOutcome, { status: 'confirmation' }>[],
): ActionRowBuilder<ButtonBuilder>[] {
  return pending
    .filter((item) => !item.approvalChannelId)
    .slice(0, 5)
    .map((item) =>
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm:${item.id}`)
          .setLabel(`Confirm ${item.action}`.slice(0, 80))
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`cancel:${item.id}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      ),
    );
}
export function preview(item: Extract<ActionOutcome, { status: 'confirmation' }>): string {
  if (item.approvalChannelId)
    return `Approval request sent to <#${item.approvalChannelId}>. An authorized reviewer must approve or reject it there.`;
  return `**Awaiting confirmation: ${item.action}**\nID: \`${item.id}\` · expires <t:${Math.floor(item.expiresAt / 1000)}:R>\n\`\`\`json\n${stringify(item.input).replaceAll('```', '[code fence]')}\n\`\`\``;
}
export function outcomePayload(outcome: ActionOutcome): BotPayload {
  if (outcome.status === 'confirmation') return textPayload(preview(outcome), confirmationRows([outcome]));
  const result = outcome.result;
  if (
    result &&
    typeof result === 'object' &&
    'status' in result &&
    result.status === 'approval-routed' &&
    'approvalChannelId' in result &&
    typeof result.approvalChannelId === 'string'
  )
    return textPayload(
      'notice' in result && typeof result.notice === 'string'
        ? result.notice
        : `Staff approval is required in <#${result.approvalChannelId}> before this operation can run.`,
    );
  if (
    outcome.action === 'premium.purchase' &&
    result &&
    typeof result === 'object' &&
    'premiumPurchase' in result &&
    result.premiumPurchase === true &&
    'content' in result &&
    typeof result.content === 'string' &&
    'components' in result &&
    Array.isArray(result.components)
  )
    return textPayload(result.content, result.components as ActionRowBuilder<ButtonBuilder>[]);
  if (
    outcome.action === 'activity.launch' &&
    result &&
    typeof result === 'object' &&
    'activityLaunch' in result &&
    result.activityLaunch === true
  )
    return textPayload('Open the shared Activity in this Discord channel.', [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('activity:launch')
          .setLabel('Launch common room')
          .setStyle(ButtonStyle.Primary),
      ),
    ]);
  if (
    (outcome.action === 'image.search' || outcome.action === 'gif.search') &&
    result &&
    typeof result === 'object' &&
    'searchId' in result &&
    typeof result.searchId === 'string' &&
    /^[A-Za-z0-9_-]{16}$/.test(result.searchId) &&
    'results' in result &&
    Array.isArray(result.results)
  ) {
    const items = result.results
      .filter(
        (item): item is { index: number; title: string; source: string; license: string } =>
          !!item &&
          typeof item === 'object' &&
          Number.isInteger(item.index) &&
          item.index >= 1 &&
          item.index <= 8 &&
          typeof item.title === 'string' &&
          typeof item.source === 'string' &&
          safeMediaSource(item.source) &&
          !/[<>\r\n]/.test(item.source) &&
          typeof item.license === 'string',
      )
      .slice(0, 8);
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let start = 0; start < items.length; start += 4)
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          ...items
            .slice(start, start + 4)
            .map((item) =>
              new ButtonBuilder()
                .setCustomId(`media:pick:${result.searchId}:${item.index}`)
                .setLabel(`${item.index}. ${item.title}`.slice(0, 80).toWellFormed())
                .setStyle(ButtonStyle.Primary),
            ),
        ),
      );
    const provider =
      'provider' in result && result.provider === 'KLIPY'
        ? 'KLIPY'
        : 'provider' in result && result.provider === 'Pinterest public partner search'
          ? 'Pinterest'
          : 'Wikimedia Commons';
    return textPayload(
      `**${provider} · ${items.length} results**\nChoose a result to send to this channel. The configured confirmation policy applies.\n\n${items.map((item) => `${item.index}. ${item.title}\n${item.license} · <${item.source}>`).join('\n\n')}\n\nSelections expire after ten minutes. Source pages contain attribution and provider terms.`,
      rows,
    );
  }
  if (
    result &&
    typeof result === 'object' &&
    'attachment' in result &&
    Buffer.isBuffer(result.attachment) &&
    'name' in result &&
    typeof result.name === 'string'
  )
    return {
      content: `Completed: **${outcome.action}**${'notice' in result && typeof result.notice === 'string' ? '\n' + result.notice.slice(0, 1000) : ''}`,
      files: [{ attachment: result.attachment, name: result.name }],
      allowedMentions: NO_MENTIONS,
      components: [],
    };
  const content =
    typeof result === 'string'
      ? result
      : `\`\`\`json\n${stringify(result).replaceAll('```', '[code fence]')}\n\`\`\``;
  return textPayload(`Completed: **${outcome.action}**\n${content}`);
}
function safeMediaSource(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol === 'https:' &&
      url.hostname === 'commons.wikimedia.org' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.pathname.startsWith('/wiki/File')
    )
      return true;
    publicMediaPage(value);
    return true;
  } catch {
    return false;
  }
}
export function textPayload(content: string, components: ActionRowBuilder<ButtonBuilder>[] = []): BotPayload {
  const safe = redact(content);
  if (safe.length <= 1900) return { content: safe, allowedMentions: NO_MENTIONS, components };
  return {
    content: safe.slice(0, 1600) + '\n\nFull output attached.',
    files: [{ attachment: Buffer.from(safe), name: 'result.txt' }],
    allowedMentions: NO_MENTIONS,
    components,
  };
}
