import type { ActionContext } from '../core/types.js';
import { freshContext } from '../core/permissions.js';
import { PermissionFlagsBits as P } from 'discord.js';
import { textWith } from '../discord/actions/shared.js';
import { UserError } from '../core/errors.js';

export interface HistoryMessage {
  id: string;
  userId: string;
  content: string;
  createdAt: string;
  replyTo: string | null;
  attachments: { name: string; url: string }[];
}
export interface HistoryRange {
  before?: string;
  after?: string;
  maxMessages: number;
  query?: string;
  authorId?: string;
}
/** Fetch finite resumable ranges. Limits bound a single response, not the history a user can traverse. */
export async function readMessageRange(ctx: ActionContext, channelId: string, input: HistoryRange) {
  if (input.before && input.after && BigInt(input.before) <= BigInt(input.after))
    throw new UserError('The before boundary must be newer than the after boundary.');
  const messages: HistoryMessage[] = [];
  let before = input.before,
    scanned = 0,
    bytes = 0,
    complete = false;
  const deadline = Date.now() + 30000;
  while (scanned < input.maxMessages && Date.now() < deadline) {
    ctx = await freshContext(ctx);
    const channel = await textWith(ctx, channelId, [P.ReadMessageHistory]);
    const page = await channel.messages.fetch({
      limit: Math.min(100, input.maxMessages - scanned),
      before,
      cache: false,
    });
    const ordered = [...page.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
    if (!ordered.length) {
      complete = true;
      break;
    }
    let stopped = false;
    for (const message of ordered) {
      if (input.after && BigInt(message.id) <= BigInt(input.after)) {
        complete = true;
        stopped = true;
        break;
      }
      const row: HistoryMessage = {
        id: message.id,
        userId: message.author.id,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
        replyTo: message.reference?.messageId ?? null,
        attachments: [...message.attachments.values()].map((file) => ({ name: file.name, url: file.url })),
      };
      const size = Buffer.byteLength(JSON.stringify(row));
      if (bytes + size > 6 * 1024 * 1024) {
        stopped = true;
        break;
      }
      scanned++;
      before = message.id;
      bytes += size;
      if (
        (!input.authorId || row.userId === input.authorId) &&
        (!input.query || row.content.toLocaleLowerCase().includes(input.query.toLocaleLowerCase()))
      )
        messages.push(row);
    }
    if (stopped) break;
    if (page.size < Math.min(100, input.maxMessages - (scanned - page.size))) {
      complete = true;
      break;
    }
  }
  ctx = await freshContext(ctx);
  await textWith(ctx, channelId, [P.ReadMessageHistory]);
  return {
    channelId,
    complete,
    partial: !complete,
    scanned,
    messageCount: messages.length,
    messages: messages.reverse(),
    nextBefore: complete ? null : (before ?? null),
    after: input.after ?? null,
    notice:
      'Only accessible retained Discord messages are returned. Continue with nextBefore until complete; deleted messages and unavailable content cannot be reconstructed.',
  };
}
