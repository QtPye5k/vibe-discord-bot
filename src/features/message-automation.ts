import { createHash, randomBytes } from 'node:crypto';
import {
  PermissionFlagsBits as P,
  type Client,
  type Message,
  type MessageReaction,
  type User,
} from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import type { Store } from '../core/store.js';
import type { AiService } from './ai.js';
import { freshContext, resolveChannel } from '../core/permissions.js';
import { textWith } from '../discord/actions/shared.js';
import { UserError } from '../core/errors.js';
const id = z.string().regex(/^\d{17,20}$/),
  slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  key = (guildId: string, value: string) => `${guildId}:${value}`;
interface Relay {
  id: string;
  guildId: string;
  authorId: string;
  originChannelId: string;
  sourceChannelId: string;
  targetChannelId: string;
  version: string;
  enabled: boolean;
}
interface Conversation {
  guildId: string;
  channelId: string;
  authorId: string;
  version: string;
  enabled: boolean;
}
interface Watch {
  id: string;
  guildId: string;
  ownerId: string;
  channelId: string;
  messageId: string;
  replies: boolean;
  reactions: boolean;
  expiresAt: number;
  replyCount: number;
  reactionAdds: number;
  reactionRemoves: number;
  recent: { kind: string; id: string; userId: string; emoji?: string; at: number }[];
}
interface DeferredRelay {
  state: string;
  guildId: string;
  policyId: string;
  version: string;
  consentToken: string;
  userId: string;
  sourceChannelId: string;
  sourceMessageId: string;
  expiresAt: number;
  attempts: number;
  retryAt: number;
  lastError?: string;
}
export interface MessageAutomationOptions {
  messageContentEnabled?: () => boolean;
  aiAvailable?: () => boolean;
}
const active = (store: Store, guildId: string) =>
  (store.get<string[]>('core.disabled', guildId) ?? []).includes('automation') === false;
function actionAllowed(ctx: ActionContext, action: string) {
  const row = ctx.store.get<{ enabled: boolean; roleIds: string[]; channelIds: string[] }>(
    'core.actionPolicies',
    key(ctx.guild.id, action),
  );
  return (
    !row ||
    (row.enabled &&
      (!row.roleIds.length || row.roleIds.some((id) => ctx.member.roles.cache.has(id))) &&
      (!row.channelIds.length || row.channelIds.includes(ctx.channelId)))
  );
}
async function relayAccess(ctx: ActionContext, row: Relay) {
  const source = await textWith(ctx, row.sourceChannelId, [P.ReadMessageHistory]),
    target = await resolveChannel(ctx, row.targetChannelId);
  if (
    !target.isSendable() ||
    !target.permissionsFor(ctx.member)?.has([P.ViewChannel, P.SendMessages]) ||
    !target.permissionsFor(ctx.guild.members.me!)?.has(P.SendMessages)
  )
    throw new UserError('Relay destination access is unavailable.');
  return { source, target };
}
export function registerMessageAutomationActions(
  registry: ActionRegistry,
  options: MessageAutomationOptions = {},
) {
  const base = { category: 'automation', userPermissions: [], botPermissions: [], risk: 'write' as const };
  const textEnabled = options.messageContentEnabled ?? (() => false);
  registry.register({
    ...base,
    id: 'relay.configure',
    available: textEnabled,
    unavailableReason:
      'Enable Message Content in the Portal and ENABLE_MESSAGE_CONTENT before configuring automatic relays.',
    description:
      'Configure an authorized continuous channel relay. Each original author must separately consent to this exact source/destination policy version.',
    userPermissions: [P.ManageGuild, P.ManageMessages],
    schema: z.strictObject({
      id: slug,
      sourceChannelId: id,
      targetChannelId: id,
      enabled: z.boolean().default(true),
    }),
    execute: async (ctx, input) => {
      if (input.sourceChannelId === input.targetChannelId) throw new UserError('Relay channels must differ.');
      const row: Relay = {
        ...input,
        guildId: ctx.guild.id,
        authorId: ctx.member.id,
        originChannelId: ctx.channelId,
        version: randomBytes(8).toString('hex'),
      };
      await relayAccess(ctx, row);
      const rows = ctx.store.list<Relay>('message.relays', `${ctx.guild.id}:`);
      if (!ctx.store.get('message.relays', key(ctx.guild.id, input.id)) && rows.length >= 10)
        throw new UserError('Limit: 10 relays per server.');
      ctx.store.set('message.relays', key(ctx.guild.id, input.id), row);
      return row;
    },
  });
  registry.register({
    ...base,
    id: 'relay.consent',
    description:
      'Opt your own future messages into or out of one exact configured relay. Any relay reconfiguration invalidates old consent.',
    schema: z.strictObject({ id: slug, enabled: z.boolean() }),
    execute: async (ctx, input) => {
      const ownKey = key(ctx.guild.id, `${input.id}:${ctx.member.id}`);
      if (!input.enabled) {
        ctx.store.delete('message.relayConsent', ownKey);
        return { enabled: false };
      }
      if (!textEnabled()) throw new UserError('Message Content is disabled.');
      const row = ctx.store.get<Relay>('message.relays', key(ctx.guild.id, input.id));
      if (!row?.enabled) throw new UserError('Relay is not configured or is disabled.');
      await relayAccess(ctx, row);
      ctx.store.set('message.relayConsent', ownKey, {
        version: row.version,
        token: randomBytes(8).toString('hex'),
        enabled: true,
      });
      return {
        enabled: true,
        sourceChannelId: row.sourceChannelId,
        targetChannelId: row.targetChannelId,
        notice:
          'Your future source messages may be forwarded to this destination until you withdraw or its policy changes.',
      };
    },
  });
  registry.register({
    ...base,
    id: 'relay.list',
    risk: 'read',
    description:
      'List currently accessible relay policies and whether your own consent matches their exact version.',
    schema: z.strictObject({}),
    execute: async (ctx) => {
      const result = [];
      for (const row of ctx.store.list<Relay>('message.relays', `${ctx.guild.id}:`)) {
        try {
          await relayAccess(ctx, row.value);
          result.push({
            ...row.value,
            consented:
              ctx.store.get<{ version: string }>(
                'message.relayConsent',
                key(ctx.guild.id, `${row.value.id}:${ctx.member.id}`),
              )?.version === row.value.version,
          });
        } catch {
          /* Source/destination privacy is preserved. */
        }
      }
      return result;
    },
  });
  registry.register({
    ...base,
    id: 'relay.remove',
    description: 'Remove a continuous relay and invalidate every associated consent and future delivery.',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({ id: slug }),
    execute: (ctx, input) => {
      ctx.store.delete('message.relays', key(ctx.guild.id, input.id));
      for (const row of ctx.store.list('message.relayConsent', `${ctx.guild.id}:${input.id}:`))
        ctx.store.delete('message.relayConsent', row.key);
      return { removed: true };
    },
  });
  registry.register({
    ...base,
    id: 'conversation.channel.configure',
    available: () => textEnabled() && (options.aiAvailable?.() ?? false),
    unavailableReason:
      'Message Content and an available OpenAI key are required for consented channel conversations.',
    description:
      'Enable conversational replies in one channel without repeated mentions. Each author must opt in; public replies cannot access private preferences/history or administrative tools.',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({ channelId: id, enabled: z.boolean() }),
    execute: async (ctx, input) => {
      await textWith(ctx, input.channelId, [P.ReadMessageHistory, P.SendMessages]);
      const row: Conversation = {
        ...input,
        guildId: ctx.guild.id,
        authorId: ctx.member.id,
        version: randomBytes(8).toString('hex'),
      };
      if (
        !ctx.store.get('message.conversations', key(ctx.guild.id, input.channelId)) &&
        ctx.store.list('message.conversations', `${ctx.guild.id}:`).length >= 10
      )
        throw new UserError('Limit: 10 conversational channels per server.');
      ctx.store.set('message.conversations', key(ctx.guild.id, input.channelId), row);
      for (const prior of ctx.store.list(
        'ai.conversations',
        `${ctx.guild.id}:${input.channelId}:consented-public-channel:`,
      ))
        ctx.store.delete('ai.conversations', prior.key);
      return row;
    },
  });
  registry.register({
    ...base,
    id: 'conversation.channel.consent',
    description:
      'Opt your own unmentioned channel messages into or out of the current public conversation policy and its separately scoped retained conversation.',
    schema: z.strictObject({ channelId: id, enabled: z.boolean() }),
    execute: async (ctx, input) => {
      const ownKey = key(ctx.guild.id, `${input.channelId}:${ctx.member.id}`);
      if (!input.enabled) {
        ctx.store.delete('message.conversationConsent', ownKey);
        for (const prior of ctx.store.list(
          'ai.conversations',
          `${ctx.guild.id}:${input.channelId}:consented-public-channel:`,
        ))
          if (prior.key.endsWith(`:${ctx.member.id}`)) ctx.store.delete('ai.conversations', prior.key);
        return { enabled: false };
      }
      const policy = ctx.store.get<Conversation>('message.conversations', key(ctx.guild.id, input.channelId));
      if (!policy?.enabled) throw new UserError('The channel conversation policy is disabled.');
      await textWith(ctx, input.channelId, [P.ReadMessageHistory, P.SendMessages]);
      ctx.store.set('message.conversationConsent', ownKey, {
        version: policy.version,
        token: randomBytes(8).toString('hex'),
      });
      return {
        enabled: true,
        notice:
          'Future unmentioned messages in this channel may upload to OpenAI, receive public replies and retain bounded conversation context under the AI retention policy. Saved private preferences and private chat history are excluded.',
      };
    },
  });
  registry.register({
    ...base,
    id: 'tracking.watch',
    description:
      'Track future replies and reaction transitions for an accessible message, with bounded metadata retention and source access checked on every view.',
    schema: z.strictObject({
      channelId: id,
      messageId: id,
      replies: z.boolean().default(true),
      reactions: z.boolean().default(true),
      days: z.number().int().min(1).max(30).default(7),
    }),
    execute: async (ctx, input) => {
      const channel = await textWith(ctx, input.channelId, [P.ReadMessageHistory]);
      await channel.messages.fetch({ message: input.messageId, force: true });
      const rows = ctx.store.list<Watch>('message.watches', `${ctx.guild.id}:`);
      if (rows.length >= 100 || rows.filter((row) => row.value.ownerId === ctx.member.id).length >= 10)
        throw new UserError('Message watch capacity reached.');
      if (!input.replies && !input.reactions) throw new UserError('Select reply or reaction tracking.');
      const row: Watch = {
        ...input,
        id: randomBytes(8).toString('hex'),
        guildId: ctx.guild.id,
        ownerId: ctx.member.id,
        expiresAt: Date.now() + input.days * 86400000,
        replyCount: 0,
        reactionAdds: 0,
        reactionRemoves: 0,
        recent: [],
      };
      ctx.store.set('message.watches', key(ctx.guild.id, row.id), row);
      return row;
    },
  });
  registry.register({
    ...base,
    id: 'tracking.view',
    risk: 'read',
    description:
      'Read your observed reply/reaction counts and bounded recent metadata only while current source history access remains available.',
    schema: z.strictObject({ id: z.string().regex(/^[a-f0-9]{16}$/) }),
    execute: async (ctx, input) => {
      const row = ctx.store.get<Watch>('message.watches', key(ctx.guild.id, input.id));
      if (!row || row.ownerId !== ctx.member.id || row.expiresAt <= Date.now())
        throw new UserError('This watch expired or belongs to another person.');
      await textWith(ctx, row.channelId, [P.ReadMessageHistory]);
      return row;
    },
  });
  registry.register({
    ...base,
    id: 'tracking.remove',
    description: 'Remove your own message watch and its retained event deduplication records.',
    schema: z.strictObject({ id: z.string().regex(/^[a-f0-9]{16}$/) }),
    execute: (ctx, input) => {
      const row = ctx.store.get<Watch>('message.watches', key(ctx.guild.id, input.id));
      if (!row || row.ownerId !== ctx.member.id) throw new UserError('This watch belongs to another person.');
      ctx.store.delete('message.watches', key(ctx.guild.id, row.id));
      for (const seen of ctx.store.list('message.watchSeen', `${ctx.guild.id}:${row.id}:`))
        ctx.store.delete('message.watchSeen', seen.key);
      return { removed: true };
    },
  });
}
const relayActive = new WeakMap<Store, Set<string>>(),
  talking = new WeakMap<Store, Set<string>>();
let relayCount = 0,
  chatCount = 0;
/** Called only for normal guild messages admitted by the app allowlist. No passive path executes administrative tools. */
export async function handleMessageAutomation(
  message: Message,
  store: Store,
  ai?: Pick<AiService, 'available' | 'chat'>,
  options: { messageContentEnabled?: boolean; commandPrefix?: string; relayId?: string } = {},
) {
  if (
    !options.messageContentEnabled ||
    !message.guild ||
    message.author.bot ||
    message.webhookId ||
    message.system ||
    !message.member ||
    !active(store, message.guild.id)
  )
    return;
  const guild = message.guild;
  for (const { value: row } of store.list<Relay>('message.relays', `${guild.id}:`)) {
    if (
      !row.enabled ||
      row.sourceChannelId !== message.channelId ||
      (options.relayId && options.relayId !== row.id)
    )
      continue;
    const consentKey = key(guild.id, `${row.id}:${message.author.id}`),
      consent = store.get<{ version: string; token: string }>('message.relayConsent', consentKey);
    if (consent?.version !== row.version) continue;
    let locks = relayActive.get(store);
    if (!locks) {
      locks = new Set();
      relayActive.set(store, locks);
    }
    const deliveryKey = key(guild.id, `${row.id}:${row.version}:${message.id}`),
      prior = store.get<{ state: string }>('message.relayDeliveries', deliveryKey);
    if (locks.has(deliveryKey) || (prior && prior.state !== 'deferred')) continue;
    if (relayCount >= 4) {
      if (
        !prior &&
        store
          .list<{ state: string }>('message.relayDeliveries', `${guild.id}:`)
          .filter((row) => row.value.state === 'deferred').length < 200
      )
        store.set('message.relayDeliveries', deliveryKey, {
          state: 'deferred',
          guildId: guild.id,
          policyId: row.id,
          version: row.version,
          consentToken: consent.token,
          userId: message.author.id,
          sourceChannelId: message.channelId,
          sourceMessageId: message.id,
          expiresAt: Date.now() + 7 * 86400000,
          attempts: 0,
          retryAt: 0,
        } satisfies DeferredRelay);
      else if (!prior)
        store.set(
          'message.relayCapacity',
          guild.id,
          (store.get<number>('message.relayCapacity', guild.id) ?? 0) + 1,
        );
      continue;
    }
    locks.add(deliveryKey);
    relayCount++;
    try {
      const manager = await guild.members.fetch({ user: row.authorId, force: true });
      await guild.members.fetchMe({ force: true });
      const policyCtx: ActionContext = {
        client: message.client,
        store,
        guild,
        member: manager,
        channelId: row.originChannelId,
      };
      if (!manager.permissions.has(P.ManageGuild) || !actionAllowed(policyCtx, 'relay.configure')) continue;
      let authorCtx = await freshContext({
        ...policyCtx,
        member: message.member,
        channelId: message.channelId,
      });
      const { source, target } = await relayAccess(authorCtx, row);
      await resolveChannel(policyCtx, row.sourceChannelId);
      await resolveChannel(policyCtx, row.targetChannelId);
      const original = await source.messages.fetch({ message: message.id, force: true });
      if (original.author.id !== message.author.id) continue;
      authorCtx = await freshContext(authorCtx);
      await relayAccess(authorCtx, row);
      const latestManager = await guild.members.fetch({ user: row.authorId, force: true });
      if (
        !latestManager.permissions.has(P.ManageGuild) ||
        !source.permissionsFor(latestManager)?.has(P.ManageMessages) ||
        !target.permissionsFor(latestManager)?.has(P.ManageMessages) ||
        !actionAllowed({ ...policyCtx, member: latestManager }, 'relay.configure')
      )
        continue;
      if (
        !active(store, guild.id) ||
        store.get<Relay>('message.relays', key(guild.id, row.id))?.version !== row.version ||
        store.get<{ token: string }>('message.relayConsent', consentKey)?.token !== consent.token
      )
        continue;
      store.set('message.relayDeliveries', deliveryKey, {
        state: 'sending',
        at: Date.now(),
        expiresAt: Date.now() + 7 * 86400000,
      });
      try {
        const forwarded = await original.forward(target);
        store.set('message.relayDeliveries', deliveryKey, {
          state: 'sent',
          messageId: forwarded.id,
          at: Date.now(),
          expiresAt: Date.now() + 7 * 86400000,
        });
      } catch {
        store.set('message.relayDeliveries', deliveryKey, {
          state: 'unknown',
          at: Date.now(),
          expiresAt: Date.now() + 7 * 86400000,
        });
      }
    } catch {
      /* Current policy/source failures skip delivery; no content is retained. */
    } finally {
      locks.delete(deliveryKey);
      relayCount--;
    }
  }
  if (options.relayId) return;
  const policy = store.get<Conversation>('message.conversations', key(guild.id, message.channelId));
  if (
    !ai?.available ||
    !policy?.enabled ||
    chatCount >= 2 ||
    !message.content.trim() ||
    message.content.startsWith('<@') ||
    ((options.commandPrefix ?? '!') && message.content.startsWith(options.commandPrefix ?? '!'))
  )
    return;
  const consentKey = key(guild.id, `${message.channelId}:${message.author.id}`),
    consent = store.get<{ version: string; token: string }>('message.conversationConsent', consentKey);
  if (consent?.version !== policy.version) return;
  const lockKey = key(guild.id, message.author.id);
  let locks = talking.get(store);
  if (!locks) {
    locks = new Set();
    talking.set(store, locks);
  }
  const cooldown = store.get<number>('message.conversationCooldown', lockKey) ?? 0;
  if (locks.has(lockKey) || Date.now() - cooldown < 10000) return;
  locks.add(lockKey);
  chatCount++;
  store.set('message.conversationCooldown', lockKey, Date.now());
  const memoryScope = `consented-public-channel:${policy.version}:${consent.token}`,
    memoryKey = `${guild.id}:${message.channelId}:${memoryScope}:${message.author.id}`;
  try {
    const manager = await guild.members.fetch({ user: policy.authorId, force: true });
    if (!manager.permissions.has(P.ManageGuild)) return;
    let ctx: ActionContext = {
      client: message.client,
      store,
      guild,
      member: await guild.members.fetch({ user: message.author.id, force: true }),
      channelId: message.channelId,
    };
    await guild.members.fetchMe({ force: true });
    await textWith(ctx, ctx.channelId, [P.ReadMessageHistory, P.SendMessages]);
    if (!actionAllowed({ ...ctx, member: manager }, 'conversation.channel.configure')) return;
    const reply = await ai.chat(ctx, message.content.slice(0, 8000), undefined, false, {
      memoryScope,
      usePreferences: false,
      retainHistory: true,
      allowWebSearch: false,
    });
    ctx = await freshContext(ctx);
    await textWith(ctx, ctx.channelId, [P.ReadMessageHistory, P.SendMessages]);
    const latestManager = await guild.members.fetch({ user: policy.authorId, force: true });
    if (
      !latestManager.permissions.has(P.ManageGuild) ||
      !actionAllowed({ ...ctx, member: latestManager }, 'conversation.channel.configure')
    )
      return;
    if (
      !active(store, guild.id) ||
      store.get<Conversation>('message.conversations', key(guild.id, message.channelId))?.version !==
        policy.version ||
      store.get<{ token: string }>('message.conversationConsent', consentKey)?.token !== consent.token
    )
      return;
    await message.reply({
      content: reply.text.slice(0, 2000),
      allowedMentions: { parse: [], repliedUser: false },
    });
  } catch {
    /* Passive AI failures must not create a message flood or retry paid requests. */
  } finally {
    if (
      store.get<Conversation>('message.conversations', key(guild.id, message.channelId))?.version !==
        policy.version ||
      store.get<{ token: string }>('message.conversationConsent', consentKey)?.token !== consent.token
    )
      store.delete('ai.conversations', memoryKey);
    locks.delete(lockKey);
    chatCount--;
  }
}
export function observeMessageTracking(event: string, args: unknown[], store: Store, now = Date.now()) {
  let guildId: string | undefined,
    channelId: string | undefined,
    messageId: string | undefined,
    sourceId: string | undefined,
    userId: string | undefined,
    emoji: string | undefined,
    kind: string;
  if (event === 'messageCreate') {
    const message = args[0] as Message;
    if (!message.guildId || message.author.bot || message.webhookId || !message.reference?.messageId) return;
    guildId = message.guildId;
    channelId = message.channelId;
    messageId = message.reference.messageId;
    sourceId = message.id;
    userId = message.author.id;
    kind = 'reply';
  } else if (event === 'messageReactionAdd' || event === 'messageReactionRemove') {
    const reaction = args[0] as MessageReaction,
      user = args[1] as User;
    if (!reaction.message.guildId || !user || user.bot) return;
    guildId = reaction.message.guildId;
    channelId = reaction.message.channelId;
    messageId = reaction.message.id;
    userId = user.id;
    emoji = reaction.emoji.id ?? reaction.emoji.name ?? 'unknown';
    sourceId = createHash('sha256').update(`${userId}:${emoji}`).digest('hex').slice(0, 24);
    kind = event === 'messageReactionAdd' ? 'reaction-add' : 'reaction-remove';
  } else return;
  if (!active(store, guildId)) return;
  for (const { key: rowKey, value: row } of store.list<Watch>('message.watches', `${guildId}:`)) {
    if (
      row.expiresAt <= now ||
      row.channelId !== channelId ||
      row.messageId !== messageId ||
      (kind === 'reply' ? !row.replies : !row.reactions)
    )
      continue;
    const seenKey = key(guildId, `${row.id}:${kind === 'reply' ? 'reply' : 'reaction'}:${sourceId}`),
      prior = store.get<{ state: string }>('message.watchSeen', seenKey);
    const state = kind === 'reaction-remove' ? 'removed' : 'present';
    if (prior?.state === state) continue;
    if (!prior && store.list('message.watchSeen', `${guildId}:${row.id}:`).length >= 10000) continue;
    store.set('message.watchSeen', seenKey, { state, expiresAt: row.expiresAt });
    if (kind === 'reply') row.replyCount++;
    else if (kind === 'reaction-add') row.reactionAdds++;
    else row.reactionRemoves++;
    row.recent.push({ kind, id: sourceId!, userId: userId!, ...(emoji ? { emoji } : {}), at: now });
    row.recent = row.recent.slice(-100);
    store.set('message.watches', rowKey, row);
  }
}
export function sweepMessageAutomation(store: Store, now = Date.now()) {
  for (const namespace of ['message.watches', 'message.watchSeen', 'message.relayDeliveries'])
    for (const row of store.list<{ expiresAt: number }>(namespace))
      if (row.value.expiresAt <= now) store.delete(namespace, row.key);
}
const flushing = new WeakSet<Store>();
export async function flushRelayQueue(
  client: Client,
  store: Store,
  options: { messageContentEnabled?: boolean },
  allowedGuildIds: readonly string[] = [],
  now = Date.now(),
) {
  if (!options.messageContentEnabled || flushing.has(store)) return;
  flushing.add(store);
  try {
    let count = 0;
    const deadline = Date.now() + 15000;
    for (const { key: rowKey, value: job } of store.list<DeferredRelay>('message.relayDeliveries')) {
      if (count >= 10 || Date.now() > deadline) break;
      if (
        job.state !== 'deferred' ||
        job.retryAt > now ||
        job.expiresAt <= now ||
        (allowedGuildIds.length && !allowedGuildIds.includes(job.guildId))
      )
        continue;
      if (!active(store, job.guildId)) continue;
      const policy = store.get<Relay>('message.relays', key(job.guildId, job.policyId)),
        consent = store.get<{ token: string }>(
          'message.relayConsent',
          key(job.guildId, `${job.policyId}:${job.userId}`),
        );
      if (!policy?.enabled || policy.version !== job.version || consent?.token !== job.consentToken) {
        store.set('message.relayDeliveries', rowKey, { ...job, state: 'cancelled' });
        continue;
      }
      count++;
      try {
        const guild = await client.guilds.fetch(job.guildId),
          member = await guild.members.fetch({ user: job.userId, force: true });
        await guild.members.fetchMe({ force: true });
        const ctx = { client, store, guild, member, channelId: job.sourceChannelId };
        const channel = await textWith(ctx, job.sourceChannelId, [P.ReadMessageHistory]),
          message = await channel.messages.fetch({ message: job.sourceMessageId, force: true });
        await handleMessageAutomation(message, store, undefined, { ...options, relayId: job.policyId });
      } catch (error) {
        job.lastError = error instanceof Error ? error.name : 'Error';
      }
      const latest = store.get<{ state: string }>('message.relayDeliveries', rowKey);
      if (latest?.state === 'deferred') {
        job.attempts++;
        job.retryAt = now + Math.min(3600000, 30000 * 2 ** job.attempts);
        job.state = job.attempts >= 5 ? 'failed' : 'deferred';
        store.set('message.relayDeliveries', rowKey, job);
      }
    }
  } finally {
    flushing.delete(store);
  }
}
