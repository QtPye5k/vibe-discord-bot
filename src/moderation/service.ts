import { createHash } from 'node:crypto';
import { Collection, DiscordAPIError, PermissionFlagsBits as P, type Client, type Message } from 'discord.js';
import { z } from 'zod';
import type { Store } from '../core/store.js';
import type { ActionContext } from '../core/types.js';
import { assertPrivateTranscriptPrivacy } from '../voice/transcripts.js';
import { matchContentRules } from './rules.js';

const snowflake = z.string().regex(/^\d{17,20}$/);
export const moderationPolicySchema = z.strictObject({
  enabled: z.boolean().default(false),
  textEnabled: z.boolean().default(false),
  imagesEnabled: z.boolean().default(false),
  honeypotChannelId: snowflake.nullable().default(null),
  logChannelId: snowflake.nullable().default(null),
});
export const automaticModerationPolicySchema = moderationPolicySchema;
export type AutomaticModerationPolicy = z.infer<typeof moderationPolicySchema>;
export interface ExplicitClassification {
  remove: boolean;
  categories: string[];
  scannedImages: number;
  unscannable?: string[];
}
export interface AutomaticModerationOptions {
  store: Store;
  client: Client;
  allowedGuildIds?: readonly string[];
  classify: (message: Message, signal?: AbortSignal) => Promise<ExplicitClassification>;
  onError?: (error: Error) => void;
}
interface Case {
  id: string;
  guildId: string;
  channelId: string;
  messageId: string;
  userId: string;
  kind: 'honeypot' | 'explicit';
  state: 'reviewed' | 'attempted' | 'completed' | 'failed' | 'uncertain' | 'blocked';
  createdAt: number;
  categories: string[];
  scannedImages: number;
  deleted?: boolean;
  banned?: boolean;
  issue?: string;
}
interface Job {
  message: Message;
  key: string;
  snapshot: string;
  resolve: (handled: boolean) => void;
  promise: Promise<boolean>;
  controller: AbortController;
  settled: boolean;
  lane: 'normal' | 'honeypot';
  handled?: boolean;
  timer?: NodeJS.Timeout;
}
const POLICY = 'moderation.automatic',
  CASES = 'moderation.automatic.cases',
  SEEN = 'moderation.automatic.seen',
  TARGETS = 'moderation.automatic.targets';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snapshot = (message: Message) =>
  hash([
    message.content,
    message.editedTimestamp,
    [...message.attachments.values()].map((a) => [a.id, a.url, a.name, a.contentType, a.size]),
    message.embeds.map((e) => [
      e.url,
      e.image?.url,
      e.thumbnail?.url,
      e.title,
      e.description,
      e.author?.name,
      e.author?.url,
      e.footer?.text,
      e.provider?.url,
      e.fields?.map((field) => [field.name, field.value]),
    ]),
    [...message.stickers.values()].map((s) => s.id),
  ]);
const labels = (values: unknown) =>
  Array.isArray(values)
    ? [
        ...new Set(
          values.filter(
            (value): value is string => typeof value === 'string' && /^[a-z0-9_/-]{1,60}$/i.test(value),
          ),
        ),
      ].slice(0, 12)
    : [];

/** Apply independent text/image policy without dropping enabled link-preview text or leaking disabled text. */
export function moderationMessageView(
  message: Message,
  selected: Pick<AutomaticModerationPolicy, 'textEnabled' | 'imagesEnabled'>,
): Message {
  const view = Object.create(message) as Message,
    embeds = message.embeds.map((embed) => {
      const projected = Object.create(embed) as typeof embed,
        fields: PropertyDescriptorMap = {};
      if (!selected.textEnabled)
        for (const key of ['title', 'description', 'author', 'footer', 'url', 'provider'])
          fields[key] = { value: undefined };
      if (!selected.textEnabled) fields.fields = { value: [] };
      if (!selected.imagesEnabled)
        for (const key of ['image', 'thumbnail', 'video']) fields[key] = { value: undefined };
      Object.defineProperties(projected, fields);
      return projected;
    });
  Object.defineProperties(view, {
    content: { value: selected.textEnabled ? message.content : '', enumerable: true },
    cleanContent: { value: selected.textEnabled ? message.cleanContent : '', enumerable: true },
    attachments: { value: selected.imagesEnabled ? message.attachments : new Collection(), enumerable: true },
    embeds: { value: embeds, enumerable: true },
    stickers: { value: selected.imagesEnabled ? message.stickers : new Collection(), enumerable: true },
  });
  return view;
}

/** Only new/edited events are inspected. Effects are never retried after an ambiguous Discord result. */
export function createAutomaticModeration(options: AutomaticModerationOptions) {
  const { store, client } = options;
  const queue: Job[] = [],
    honeypotQueue: Job[] = [],
    jobs = new Map<string, Job>(),
    targets = new Set<string>(),
    running = new Set<Promise<void>>();
  let active = 0,
    normalActive = 0,
    honeypotActive = 0,
    providers = 0,
    closed = false,
    admissions = 0;
  const report = (issue: string, error?: unknown) => {
    try {
      const value =
          error && typeof error === 'object'
            ? (error as { name?: unknown; code?: unknown; status?: unknown })
            : {},
        name =
          error instanceof DiscordAPIError
            ? 'DiscordAPIError'
            : ['Error', 'HTTPError', 'AbortError', 'TypeError'].includes(String(value.name))
              ? String(value.name)
              : undefined,
        code = typeof value.code === 'number' && Number.isSafeInteger(value.code) ? value.code : undefined,
        status =
          typeof value.status === 'number' && value.status >= 100 && value.status <= 599
            ? value.status
            : undefined,
        metadata = [
          name && `name=${name}`,
          code !== undefined && `code=${code}`,
          status !== undefined && `status=${status}`,
        ]
          .filter(Boolean)
          .join(' ');
      options.onError?.(new Error(`Automatic moderation: ${issue}${metadata ? ` [${metadata}]` : ''}`));
    } catch {
      /* Diagnostics cannot stop moderation. */
    }
  };
  const policy = (guildId: string): AutomaticModerationPolicy => {
    const value = moderationPolicySchema.safeParse(store.get(POLICY, guildId) ?? {});
    return value.success ? value.data : moderationPolicySchema.parse({});
  };
  const enabled = (guildId: string) =>
    !closed &&
    (!options.allowedGuildIds?.length || options.allowedGuildIds.includes(guildId)) &&
    !(store.get<string[]>('core.disabled', guildId) ?? []).includes('moderation') &&
    policy(guildId).enabled;
  const live = (job: Job) =>
    !closed && !job.controller.signal.aborted && !!job.message.guild && enabled(job.message.guild.id);
  const finish = (job: Job, value: boolean) => {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.resolve(value);
  };
  const wait = <T>(job: Job, promise: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const signal = job.controller.signal;
      const aborted = () => {
        signal.removeEventListener('abort', aborted);
        reject(new Error('Moderation event cancelled'));
      };
      if (signal.aborted) {
        void promise.catch(() => {});
        aborted();
        return;
      }
      signal.addEventListener('abort', aborted, { once: true });
      void promise.then(
        (value) => {
          signal.removeEventListener('abort', aborted);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', aborted);
          reject(error);
        },
      );
    });
  const save = (job: Job, value: Case) => {
    if (!closed && !job.controller.signal.aborted) store.set(CASES, value.id, value);
  };
  async function privateLog(job: Job, record: Case) {
    if (!live(job)) return;
    const guild = job.message.guild!,
      id = policy(guild.id).logChannelId;
    if (!id) return;
    try {
      const [bot, roles] = await Promise.all([guild.members.fetchMe({ force: true }), guild.roles.fetch()]);
      if (!live(job) || policy(guild.id).logChannelId !== id) return;
      const channel = await guild.channels.fetch(id, { force: true });
      if (!live(job) || policy(guild.id).logChannelId !== id || !channel?.isSendable()) return;
      const ctx = { client, guild, member: bot, channelId: id, store } satisfies ActionContext;
      assertPrivateTranscriptPrivacy(ctx, channel, bot, roles);
      if (!channel.permissionsFor(bot)?.has([P.ViewChannel, P.SendMessages])) return;
      await channel.send({
        content: `Automatic moderation ${record.kind}: ${record.state}.\nCase: ${record.id}\nMember: ${record.userId}\nChannel: ${record.channelId}\nMessage: ${record.messageId}\nDeleted: ${record.deleted === true}; banned: ${record.banned === true}.\nCategories: ${record.categories.join(', ') || 'none'}${record.issue ? `\nIssue: ${record.issue}` : ''}`,
        allowedMentions: { parse: [] },
      });
    } catch {
      report('private log could not be delivered; no public fallback was used');
    }
  }
  async function fresh(job: Job): Promise<Message | undefined> {
    if (!live(job)) return;
    const channel = await job.message.guild!.channels.fetch(job.message.channelId, { force: true });
    if (!live(job) || !channel?.isTextBased() || !('messages' in channel)) return;
    let message: Message;
    try {
      message = await channel.messages.fetch({ message: job.message.id, force: true });
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === 10008 && error.status === 404) {
        job.handled = true;
        return;
      }
      report('fresh message could not be verified', error);
      throw error;
    }
    if (
      !live(job) ||
      message.guildId !== job.message.guildId ||
      message.channelId !== job.message.channelId ||
      message.author.id !== job.message.author.id ||
      message.system ||
      message.author.id === client.user?.id
    )
      return;
    return message;
  }
  async function isHoneypot(message: Message, selected: AutomaticModerationPolicy): Promise<boolean> {
    if (!selected.honeypotChannelId || !message.guild) return false;
    if (message.channelId === selected.honeypotChannelId) return true;
    if (!message.channel.isThread()) return false;
    const channel = await message.guild.channels.fetch(message.channelId, { force: true });
    return !!channel?.isThread() && channel.parentId === selected.honeypotChannelId;
  }
  async function canDelete(message: Message) {
    const bot = await message.guild!.members.fetchMe({ force: true });
    const channel = await message.guild!.channels.fetch(message.channelId, { force: true });
    return message.deletable && !!channel?.permissionsFor(bot)?.has([P.ViewChannel, P.ManageMessages]);
  }
  async function run(job: Job): Promise<boolean> {
    if (!live(job)) return false;
    let message = await wait(job, fresh(job));
    if (!message || snapshot(message) !== job.snapshot) return false;
    let selected = policy(message.guildId!);
    const honey = await wait(job, isHoneypot(message, selected));
    if (!live(job)) return false;
    const caseId = `${message.guildId}:${message.channelId}:${message.id}:${message.author.id}:${honey ? 'honeypot' : job.snapshot.slice(0, 16)}`;
    const previous = store.get<Case>(CASES, caseId);
    if (previous) return true;
    if (store.get(SEEN, caseId)) return false;
    let result: ExplicitClassification = { remove: false, categories: [], scannedImages: 0 };
    if (!honey) {
      if (!selected.textEnabled && !selected.imagesEnabled) return false;
      const view = moderationMessageView(message, selected);
      try {
        const rule = selected.textEnabled ? matchContentRules(view) : { remove: false, categories: [] };
        if (rule.remove) result = { ...rule, scannedImages: 0 };
        else {
          if (providers >= 3) {
            report('classifier slots remain occupied by cancelled provider work');
            return false;
          }
          providers++;
          const scan = Promise.resolve().then(() => options.classify(view, job.controller.signal));
          void scan
            .finally(() => {
              providers--;
            })
            .catch(() => {});
          result = await wait(job, scan);
        }
      } catch (error) {
        if (live(job)) {
          report('explicit-content scan failed; message was not marked clean', error);
          await wait(
            job,
            privateLog(job, {
              id: caseId,
              guildId: message.guildId!,
              channelId: message.channelId,
              messageId: message.id,
              userId: message.author.id,
              kind: 'explicit',
              state: 'failed',
              createdAt: Date.now(),
              categories: [],
              scannedImages: 0,
              issue: 'classifier-unavailable',
            }),
          );
        }
        return false;
      }
      if (!live(job)) return false;
      const currentPolicy = policy(message.guildId!);
      if (JSON.stringify(currentPolicy) !== JSON.stringify(selected)) return false;
      message = await wait(job, fresh(job));
      if (!message || snapshot(message) !== job.snapshot) return false;
      if (result.remove !== true) {
        if (result.unscannable?.length) {
          report('some images could not be scanned; no clean guarantee was recorded');
          await wait(
            job,
            privateLog(job, {
              id: caseId,
              guildId: message.guildId!,
              channelId: message.channelId,
              messageId: message.id,
              userId: message.author.id,
              kind: 'explicit',
              state: 'failed',
              createdAt: Date.now(),
              categories: [],
              scannedImages: result.scannedImages,
              issue: 'image-scan-incomplete',
            }),
          );
        } else store.set(SEEN, caseId, { at: Date.now() });
        return false;
      }
    }
    if (!live(job)) return false;
    job.handled = true;
    const record: Case = {
      id: caseId,
      guildId: message.guildId!,
      channelId: message.channelId,
      messageId: message.id,
      userId: message.author.id,
      kind: honey ? 'honeypot' : 'explicit',
      state: 'reviewed',
      createdAt: Date.now(),
      categories: labels(result.categories),
      scannedImages: Number.isSafeInteger(result.scannedImages)
        ? Math.max(0, Math.min(100, result.scannedImages))
        : 0,
    };
    save(job, record);
    selected = policy(message.guildId!);
    if (!live(job) || (honey && !(await wait(job, isHoneypot(message, selected))))) return false;
    if (await wait(job, canDelete(message))) {
      if (!live(job) || JSON.stringify(policy(message.guildId!)) !== JSON.stringify(selected)) return false;
      const latest = await wait(job, fresh(job));
      if (!latest || (!honey && snapshot(latest) !== job.snapshot)) return false;
      message = latest;
      if (!live(job) || JSON.stringify(policy(message.guildId!)) !== JSON.stringify(selected)) return false;
      record.state = 'attempted';
      save(job, record);
      try {
        await wait(job, message.delete());
        record.deleted = true;
      } catch {
        record.issue = 'delete-result-unknown';
        record.state = 'uncertain';
      }
      if (!live(job)) return true;
      save(job, record);
    } else {
      record.issue = 'missing-delete-permission';
    }
    if (honey) {
      const targetKey = `${message.guildId}:${message.author.id}`;
      if (message.webhookId) {
        record.issue = 'webhook-has-no-bannable-member';
        record.state = 'blocked';
      } else if (targets.has(targetKey) || store.get(TARGETS, targetKey)) {
        record.issue = 'ban-already-in-flight-or-uncertain';
        record.state = 'blocked';
      } else {
        targets.add(targetKey);
        try {
          const guild = message.guild!,
            [bot, target] = await wait(
              job,
              Promise.all([
                guild.members.fetchMe({ force: true }),
                guild.members.fetch({ user: message.author.id, force: true }).catch((error) => {
                  // A confirmed Discord "Unknown Member" means the author left after posting.
                  // Other lookup failures do not establish departure and cannot authorize a ban.
                  if (error instanceof DiscordAPIError && error.code === 10007 && error.status === 404)
                    return null;
                  throw error;
                }),
              ]),
            );
          const current = policy(guild.id);
          if (!live(job) || !(await wait(job, isHoneypot(message, current)))) return record.deleted === true;
          if (!live(job) || JSON.stringify(policy(guild.id)) !== JSON.stringify(current))
            return record.deleted === true;
          if (
            message.author.id === guild.ownerId ||
            message.author.id === bot.id ||
            !bot.permissions.has(P.BanMembers) ||
            (target !== null &&
              (target.id !== message.author.id ||
                !target.bannable ||
                bot.roles.highest.comparePositionTo(target.roles.highest) <= 0))
          ) {
            record.issue = 'target-or-bot-authority-prevents-ban';
            record.state = 'blocked';
          } else {
            record.state = 'attempted';
            save(job, record);
            // Persist before the network call: a crash or unknown result must never cause an automatic retry.
            store.set(TARGETS, targetKey, { caseId, at: Date.now() });
            try {
              await wait(
                job,
                guild.members.ban(message.author.id, {
                  deleteMessageSeconds: 0,
                  reason: `Automatic honeypot rule; case ${hash(caseId).slice(0, 16)}`,
                }),
              );
              record.banned = true;
              record.state = 'completed';
              if (!closed) store.delete(TARGETS, targetKey);
            } catch {
              record.state = 'uncertain';
              record.issue = 'ban-result-unknown-manual-review-required';
            }
          }
        } catch {
          record.state = 'failed';
          record.issue = 'ban-authority-could-not-be-verified';
        } finally {
          targets.delete(targetKey);
        }
      }
    } else if (record.deleted) record.state = 'completed';
    else if (record.state !== 'uncertain') record.state = 'blocked';
    if (live(job)) {
      save(job, record);
      await wait(job, privateLog(job, record));
    }
    return true;
  }
  function pump() {
    const start = (job: Job) => {
      active++;
      if (job.lane === 'honeypot') honeypotActive++;
      else normalActive++;
      const task = run(job)
        .then(
          (value) => finish(job, value || job.handled === true),
          (error) => {
            if (!job.controller.signal.aborted) report('event processing failed', error);
            finish(job, job.handled === true);
          },
        )
        .finally(() => {
          clearTimeout(job.timer);
          active--;
          if (job.lane === 'honeypot') honeypotActive--;
          else normalActive--;
          jobs.delete(job.key);
          running.delete(task);
          pump();
        });
      running.add(task);
    };
    while (!closed && honeypotActive < 2 && honeypotQueue.length) start(honeypotQueue.shift()!);
    while (!closed && normalActive < 3 && queue.length) start(queue.shift()!);
  }
  function processMessage(message: Message, _event: { edited?: boolean } = {}): Promise<boolean> {
    if (
      closed ||
      !message.guild ||
      message.system ||
      message.author.id === client.user?.id ||
      !enabled(message.guild.id)
    )
      return Promise.resolve(false);
    let fingerprint: string;
    try {
      fingerprint = snapshot(message);
    } catch {
      report('message metadata was incomplete');
      return Promise.resolve(false);
    }
    const key = `${message.guildId}:${message.channelId}:${message.id}:${message.author.id}:${fingerprint}`;
    const existing = jobs.get(key);
    if (existing) return existing.promise;
    const selected = policy(message.guild.id),
      candidate =
        !!selected.honeypotChannelId &&
        (message.channelId === selected.honeypotChannelId ||
          (message.channel?.isThread?.() && message.channel.parentId === selected.honeypotChannelId)),
      lane = candidate ? 'honeypot' : 'normal',
      selectedQueue = candidate ? honeypotQueue : queue;
    if (selectedQueue.length >= 64) {
      report(`${lane} queue is full; new event was not admitted`);
      return Promise.resolve(false);
    }
    if (++admissions % 100 === 0) {
      store.db.prepare('DELETE FROM kv WHERE namespace=? AND updated_at<?').run(SEEN, Date.now() - 86400000);
      store.db
        .prepare('DELETE FROM kv WHERE namespace=? AND updated_at<?')
        .run(CASES, Date.now() - 90 * 86400000);
      for (const [namespace, limit] of [
        [CASES, 3000],
        [SEEN, 10000],
      ] as const)
        store.db
          .prepare(
            'DELETE FROM kv WHERE rowid IN (SELECT rowid FROM kv WHERE namespace=? AND key>=? AND key<? ORDER BY updated_at DESC,rowid DESC LIMIT -1 OFFSET ?)',
          )
          .run(namespace, `${message.guild.id}:`, `${message.guild.id};`, limit);
    }
    let resolve!: (handled: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    const job: Job = {
      message,
      key,
      snapshot: fingerprint,
      resolve,
      promise,
      controller: new AbortController(),
      settled: false,
      lane,
    };
    job.timer = setTimeout(() => {
      job.controller.abort();
      const queuedIndex = selectedQueue.indexOf(job);
      if (queuedIndex >= 0) {
        selectedQueue.splice(queuedIndex, 1);
        jobs.delete(job.key);
      }
      report('scan deadline reached; late results are discarded');
      finish(job, job.handled === true);
    }, 30000);
    jobs.set(key, job);
    selectedQueue.push(job);
    pump();
    return promise;
  }
  return {
    processMessage,
    policy,
    status: (guildId: string) => ({
      policy: policy(guildId),
      active,
      queued: queue.length + honeypotQueue.length,
      normalActive,
      normalQueued: queue.length,
      honeypotActive,
      honeypotQueued: honeypotQueue.length,
      uncertainTargets: store.list(TARGETS, `${guildId}:`).length,
    }),
    drain: async () => {
      await Promise.allSettled([...jobs.values()].map((job) => job.promise));
      await Promise.allSettled([...running]);
    },
    close: async () => {
      closed = true;
      for (const job of jobs.values()) {
        job.controller.abort();
        finish(job, false);
      }
      queue.length = 0;
      honeypotQueue.length = 0;
      await Promise.allSettled([...running]);
      jobs.clear();
    },
  };
}
