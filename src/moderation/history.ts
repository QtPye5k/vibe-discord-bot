import { createHash } from 'node:crypto';
import { DiscordAPIError, PermissionFlagsBits as P, type Message } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import { assertPermissions, freshContext, resolveChannel } from '../core/permissions.js';
import { assertUserRequestCurrent } from '../core/types.js';
import { UserError } from '../core/errors.js';
import { communitySettingsSchema } from '../features/community.js';
import { moderationMessageView, moderationPolicySchema, type ExplicitClassification } from './service.js';
import { matchContentRules } from './rules.js';

const id = z.string().regex(/^\d{17,20}$/);
export const historyCleanupSchema = z.strictObject({
  channelId: id.optional(),
  limit: z.number().int().min(1).max(500).default(100),
  before: id.optional(),
});
export interface HistoryModerationOptions {
  classify: (message: Message, signal?: AbortSignal) => Promise<ExplicitClassification>;
  hostEnabled?: () => boolean;
  onError?: (error: Error) => void;
}
export interface HistoryCleanupResult {
  channelId: string;
  scanned: number;
  matched: number;
  deleted: number;
  failed: number;
  skipped: number;
  providerFailures: number;
  unscannable: number;
  continuation: string | null;
  exhausted: boolean;
  stopped?: string;
}
const active = new WeakMap<object, Set<string>>();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const signature = (message: Message) =>
  digest([
    message.id,
    message.author.id,
    message.content,
    message.editedTimestamp,
    [...message.attachments.values()].map((a) => [a.id, a.url, a.name, a.size, a.contentType]),
    message.embeds.map((e) => [
      e.title,
      e.description,
      e.url,
      e.author?.name,
      e.footer?.text,
      e.fields?.map((f) => [f.name, f.value]),
      e.provider?.url,
      e.image?.url,
      e.thumbnail?.url,
    ]),
  ]);
const spamSignature = (message: Message) =>
  digest([
    message.content.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim(),
    [...message.attachments.values()]
      .slice(0, 10)
      .map((a) => a.url.split(/[?#]/, 1)[0])
      .sort(),
  ]);

/** Explicitly requested historical removal. This path never runs honeypot bans or channel deletion. */
export function registerHistoryModerationActions(
  registry: ActionRegistry,
  options: HistoryModerationOptions,
): void {
  registry.register({
    id: 'moderation.history.clean',
    category: 'moderation',
    risk: 'write',
    description:
      'Clean explicit content and configured spam from up to 500 messages in one readable channel; delete matching posts individually, including old posts, and return a continuation cursor. Never delete the channel or ban historical authors.',
    schema: historyCleanupSchema,
    userPermissions: [P.ManageMessages, P.ReadMessageHistory],
    botPermissions: [P.ManageMessages, P.ReadMessageHistory],
    execute: async (initial, input): Promise<HistoryCleanupResult> => {
      const channelId = input.channelId ?? initial.channelId,
        key = `${initial.guild.id}:${channelId}`,
        locks = active.get(initial.store) ?? new Set<string>();
      if (locks.has(key) || locks.size >= 2)
        throw new UserError(
          'A history cleanup is already running here, or two cleanups are active. Wait for their result.',
        );
      locks.add(key);
      active.set(initial.store, locks);
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), 120000),
        result: HistoryCleanupResult = {
          channelId,
          scanned: 0,
          matched: 0,
          deleted: 0,
          failed: 0,
          skipped: 0,
          providerFailures: 0,
          unscannable: 0,
          continuation: input.before ?? null,
          exhausted: false,
        };
      const wait = <T>(promise: Promise<T>) =>
        new Promise<T>((resolve, reject) => {
          const abort = () => {
            controller.signal.removeEventListener('abort', abort);
            reject(new UserError('History cleanup deadline reached. Continue from the returned cursor.'));
          };
          if (controller.signal.aborted) {
            void promise.catch(() => {});
            abort();
            return;
          }
          controller.signal.addEventListener('abort', abort, { once: true });
          void promise.then(
            (value) => {
              controller.signal.removeEventListener('abort', abort);
              resolve(value);
            },
            (error) => {
              controller.signal.removeEventListener('abort', abort);
              reject(error);
            },
          );
        });
      let ctx = initial;
      const policy = () => {
        const value = moderationPolicySchema.safeParse(
          ctx.store.get('moderation.automatic', ctx.guild.id) ?? {},
        );
        return value.success ? value.data : moderationPolicySchema.parse({});
      };
      const communityPolicy = () => {
        const value = communitySettingsSchema.safeParse(
          ctx.store.get('community.settings', ctx.guild.id) ?? {},
        );
        return value.success ? value.data : communitySettingsSchema.parse({});
      };
      const selected = policy(),
        revision = JSON.stringify(selected),
        community = communityPolicy(),
        communityRevision = JSON.stringify(community);
      const current = () => {
        assertUserRequestCurrent(ctx);
        registry.assertPolicy(ctx, 'moderation.history.clean');
        if (controller.signal.aborted) throw new UserError('History cleanup deadline reached.');
        if (options.hostEnabled?.() === false || !policy().enabled)
          throw new UserError(
            'Automatic moderation must be enabled on the host and in this server before a history cleanup.',
          );
        if (JSON.stringify(policy()) !== revision || JSON.stringify(communityPolicy()) !== communityRevision)
          throw new UserError('Moderation settings changed. Request a new history cleanup.');
      };
      const access = async () => {
        current();
        ctx = await wait(freshContext(ctx));
        current();
        await wait(
          assertPermissions(
            ctx,
            [P.ManageMessages, P.ReadMessageHistory],
            [P.ManageMessages, P.ReadMessageHistory],
            { channelId },
          ),
        );
        current();
        const channel = await wait(resolveChannel(ctx, channelId));
        current();
        if (!channel.isTextBased() || !('messages' in channel))
          throw new UserError('Choose a readable text channel or thread.');
        return channel;
      };
      try {
        if (channelId === selected.logChannelId)
          throw new UserError('The private moderation case log is preserved; choose a conversation channel.');
        let channel = await access(),
          before = input.before;
        const messages: Message[] = [];
        while (messages.length < input.limit) {
          current();
          const page = await wait(
            channel.messages.fetch({
              limit: Math.min(100, input.limit - messages.length),
              before,
              cache: false,
            }),
          );
          current();
          const ordered = [...page.values()]
            .filter((message) => message.guildId === ctx.guild.id && message.channelId === channelId)
            .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0));
          if (!ordered.length) {
            result.exhausted = true;
            break;
          }
          for (const message of ordered)
            if (!messages.some((existing) => existing.id === message.id)) messages.push(message);
          const next = ordered.at(-1)!.id;
          if (before === next) break;
          before = next;
          if (page.size < Math.min(100, input.limit - messages.length + ordered.length)) {
            result.exhausted = true;
            break;
          }
        }
        // Keep only hashes, IDs and times for local burst detection. No message bodies are persisted.
        const spam = new Set<string>(),
          windows = new Map<string, Message[]>();
        if (community.antiSpamEnabled)
          for (const message of [...messages].sort((a, b) => a.createdTimestamp - b.createdTimestamp)) {
            if (
              message.author.id === ctx.client.user?.id ||
              message.system ||
              (community.antiSpamExemptStaff && message.member?.permissions.has(P.ManageMessages))
            )
              continue;
            const rows = (windows.get(message.author.id) ?? []).filter(
              (row) => message.createdTimestamp - row.createdTimestamp < 8000,
            );
            rows.push(message);
            windows.set(message.author.id, rows.slice(-30));
            const matching = rows.filter((row) => spamSignature(row) === spamSignature(message));
            if (
              (message.content.trim() || message.attachments.size) &&
              matching.length >= community.repeatLimit
            )
              for (const item of matching) spam.add(item.id);
            if (rows.length > community.messageLimit) for (const item of rows) spam.add(item.id);
            const mentions =
              message.mentions.users.size +
              message.mentions.roles.size +
              (message.mentions.everyone ? community.mentionLimit : 0);
            if (
              mentions >= community.mentionLimit ||
              community.blockedKeywords.some((word) =>
                message.content.toLowerCase().includes(word.toLowerCase()),
              )
            )
              spam.add(message.id);
          }
        for (const message of messages) {
          try {
            current();
          } catch (error) {
            result.stopped = error instanceof UserError ? error.message : 'Cleanup authorization changed.';
            result.exhausted = false;
            break;
          }
          result.scanned++;
          result.continuation = message.id;
          if (message.author.id === ctx.client.user?.id || message.system) {
            result.skipped++;
            continue;
          }
          const original = signature(message),
            view = moderationMessageView(message, selected);
          let remove = spam.has(message.id);
          if (!remove) {
            const local = selected.textEnabled ? matchContentRules(view) : { remove: false };
            remove = local.remove;
            if (!remove && (selected.textEnabled || selected.imagesEnabled))
              try {
                const classified = await wait(options.classify(view, controller.signal));
                remove = classified.remove === true;
                result.unscannable += classified.unscannable?.length ? 1 : 0;
              } catch {
                result.providerFailures++;
                result.failed++;
                try {
                  options.onError?.(
                    new Error('Historical moderation classifier failed; raw content was not logged.'),
                  );
                } catch {
                  /* best effort diagnostics */
                }
                if (result.providerFailures >= 3) {
                  result.stopped = 'Classifier unavailable repeatedly; remaining history was not scanned.';
                  result.exhausted = false;
                  break;
                }
                continue;
              }
          }
          if (!remove) continue;
          result.matched++;
          try {
            channel = await access();
            const fresh = await wait(channel.messages.fetch({ message: message.id, force: true }));
            current();
            if (
              fresh.author.id !== message.author.id ||
              fresh.guildId !== ctx.guild.id ||
              fresh.channelId !== channelId ||
              signature(fresh) !== original ||
              !fresh.deletable
            ) {
              result.skipped++;
              continue;
            }
            await wait(fresh.delete());
            result.deleted++;
          } catch (error) {
            if (error instanceof DiscordAPIError && error.code === 10008 && error.status === 404) {
              result.skipped++;
              continue;
            }
            result.failed++;
            if (error instanceof UserError) {
              result.stopped = error.message;
              result.exhausted = false;
              break;
            }
          }
        }
        if (result.exhausted && !result.stopped) result.continuation = null;
        return result;
      } finally {
        clearTimeout(timer);
        controller.abort();
        locks.delete(key);
      }
    },
  });
}
