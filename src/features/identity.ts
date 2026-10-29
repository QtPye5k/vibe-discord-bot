import { ActivityType, PermissionFlagsBits as P, type Client, type Message } from 'discord.js';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import type { Store } from '../core/store.js';
import type { AiService } from './ai.js';
import { UserError } from '../core/errors.js';
import { assertOperator } from '../core/operator.js';
import { aiPayload } from '../discord/presentation.js';
import { withTyping } from '../discord/typing.js';
const empty = z.strictObject({});
const image = z
  .string()
  .max(6000000)
  .regex(/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/)
  .nullable();
const presenceSchema = z.strictObject({
  status: z.enum(['online', 'idle', 'dnd', 'invisible']),
  activity: z.string().min(1).max(100).optional(),
  kind: z.enum(['playing', 'watching', 'listening', 'competing']).default('playing'),
});
type Presence = z.infer<typeof presenceSchema>;
interface Consent {
  enabled: boolean;
  dm: boolean;
  createdAt: number;
  version?: string;
}
interface DmReminder {
  guildId: string;
  userId: string;
  content: string;
  dueAt: number;
  nonce: string;
  attempts: number;
  state: 'pending' | 'running' | 'done' | 'failed';
  retryAt: number;
}
const activityTypes = {
  playing: ActivityType.Playing,
  watching: ActivityType.Watching,
  listening: ActivityType.Listening,
  competing: ActivityType.Competing,
};
function applyPresence(client: Client, input: Presence): void {
  client.user?.setPresence({
    status: input.status,
    activities: input.activity ? [{ name: input.activity, type: activityTypes[input.kind] }] : [],
  });
}
export function restorePresence(client: Client, store: Store): void {
  if (!client.user) return;
  const input = presenceSchema.safeParse(store.get('identity.presence', client.user.id));
  if (input.success) applyPresence(client, input.data);
}
export function registerIdentityActions(registry: ActionRegistry, operatorIds: readonly string[] = []): void {
  const global = {
    category: 'identity',
    userPermissions: [] as bigint[],
    botPermissions: [] as bigint[],
    risk: 'write' as const,
  };
  registry.register({
    ...global,
    id: 'bot.profile.global',
    description: 'Application-owner-only global bot username, avatar and banner updates.',
    schema: z.strictObject({
      username: z.string().min(2).max(32).optional(),
      avatar: image.optional(),
      banner: image.optional(),
    }),
    execute: async (ctx, input) => {
      assertOperator(ctx, operatorIds);
      if (!ctx.client.user) throw new UserError('Bot is not ready.');
      if (!Object.keys(input).length) throw new UserError('Provide a field to update.');
      const updated = await ctx.client.user.edit(input);
      return {
        id: updated.id,
        username: updated.username,
        avatar: updated.avatarURL(),
        banner: updated.bannerURL(),
      };
    },
  });
  registry.register({
    ...global,
    id: 'bot.presence',
    description: 'Application-owner-only global status and playing/watching/listening activity.',
    schema: presenceSchema,
    execute: (ctx, input) => {
      assertOperator(ctx, operatorIds);
      applyPresence(ctx.client, input);
      if (ctx.client.user) ctx.store.set('identity.presence', ctx.client.user.id, input);
      return input;
    },
  });
  registry.register({
    ...global,
    id: 'bot.application.profile',
    description: 'Application-owner-only public application description and tags.',
    schema: z.strictObject({
      description: z.string().max(400).optional(),
      tags: z.array(z.string().min(1).max(20)).max(5).optional(),
    }),
    execute: async (ctx, input) => {
      assertOperator(ctx, operatorIds);
      if (!ctx.client.application) throw new UserError('Application is unavailable.');
      if (!Object.keys(input).length) throw new UserError('Provide a field to update.');
      const app = await ctx.client.application.edit(input);
      return { id: app.id, name: app.name, description: app.description, tags: app.tags };
    },
  });
  registry.register({
    ...global,
    id: 'bot.profile.guild',
    description: 'Edit this server’s bot nickname, avatar, banner or bio, subject to Discord eligibility.',
    userPermissions: [P.ManageGuild],
    schema: z.strictObject({
      nick: z.string().min(1).max(32).nullable().optional(),
      avatar: image.optional(),
      banner: image.optional(),
      bio: z.string().max(190).nullable().optional(),
    }),
    execute: async (ctx, input) => {
      if (!Object.keys(input).length) throw new UserError('Provide a field to update.');
      const member = await ctx.guild.members.editMe(input);
      return {
        guildId: ctx.guild.id,
        nickname: member.nickname,
        avatar: member.avatarURL(),
        banner: member.bannerURL(),
      };
    },
  });
  registry.register({
    ...global,
    id: 'bot.linked-role.metadata',
    description:
      'Owner-only registration of Linked Role metadata; user linking still requires an OAuth callback application.',
    schema: z.strictObject({
      records: z
        .array(
          z.strictObject({
            key: z.string().regex(/^[a-z0-9_]{1,50}$/),
            name: z.string().min(1).max(100),
            description: z.string().min(1).max(200),
            type: z.number().int().min(1).max(8),
          }),
        )
        .max(5),
    }),
    execute: async (ctx, input) => {
      assertOperator(ctx, operatorIds);
      if (!ctx.client.application) throw new UserError('Application is unavailable.');
      return (await ctx.client.application.editRoleConnectionMetadataRecords(input.records)).map((row) => ({
        key: row.key,
        name: row.name,
        description: row.description,
        type: row.type,
      }));
    },
  });
  registry.register({
    ...global,
    id: 'notification.subscribe',
    category: 'notifications',
    description:
      'Opt yourself into or out of server notifications and optional personal DMs. Sets your default DM server.',
    schema: z.strictObject({ enabled: z.boolean(), dm: z.boolean().default(false) }),
    execute: async (ctx, input) => {
      if (
        input.enabled &&
        (ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? []).includes('notifications')
      )
        throw new UserError('Notifications are disabled in this server. You can still withdraw consent.');
      const key = `${ctx.guild.id}:${ctx.member.id}`;
      const subscription: Consent = {
        ...input,
        createdAt: Date.now(),
        version: randomBytes(8).toString('hex'),
      };
      ctx.store.set('notifications.consent', key, subscription);
      if (input.enabled && input.dm) ctx.store.set('notifications.default', ctx.member.id, ctx.guild.id);
      else if (ctx.store.get('notifications.default', ctx.member.id) === ctx.guild.id)
        ctx.store.delete('notifications.default', ctx.member.id);
      if (!input.enabled || !input.dm) {
        for (const row of ctx.store.list<DmReminder>(
          'notifications.jobs',
          `${ctx.guild.id}:${ctx.member.id}:`,
        ))
          ctx.store.delete('notifications.jobs', row.key);
        return { ...input, dmOpened: false };
      }
      try {
        const dm = await ctx.member.createDM();
        if (!personalConsentCurrent(ctx.store, ctx.guild.id, ctx.member.id, subscription))
          return { ...input, dmOpened: false, notice: 'Delivery cancelled after preferences changed.' };
        await dm.send({
          content: `You opted into notifications and conversational AI for ${ctx.guild.name}. Your replies here use that server’s AI access and limits. Server administration is unavailable in DMs. Disable using notification.subscribe in the server.`,
          allowedMentions: { parse: [] },
        });
        return { ...input, dmOpened: true };
      } catch {
        return {
          ...input,
          dmOpened: false,
          notice: 'Discord rejected the DM. Review your DM privacy settings.',
        };
      }
    },
  });
  registry.register({
    ...global,
    id: 'notification.preferences',
    category: 'notifications',
    risk: 'read',
    description: 'Read your own saved notification consent for this server.',
    schema: empty,
    execute: (ctx) =>
      ctx.store.get('notifications.consent', `${ctx.guild.id}:${ctx.member.id}`) ?? {
        enabled: false,
        dm: false,
      },
  });
  registry.register({
    ...global,
    id: 'notification.remind',
    category: 'notifications',
    description:
      'Schedule a personal DM reminder after opting in. Delivery rechecks consent and server membership.',
    schema: z.strictObject({ content: z.string().min(1).max(1500), dueAt: z.iso.datetime({ offset: true }) }),
    execute: (ctx, input) => {
      const consent = ctx.store.get<Consent>('notifications.consent', `${ctx.guild.id}:${ctx.member.id}`);
      if (!consent?.enabled || !consent.dm)
        throw new UserError('Opt into personal DMs using notification.subscribe first.');
      const dueAt = Date.parse(input.dueAt);
      if (dueAt < Date.now() + 5000 || dueAt > Date.now() + 365 * 86400000)
        throw new UserError('Deadline must be 5 seconds to 365 days from now.');
      if (
        ctx.store
          .list<DmReminder>('notifications.jobs', `${ctx.guild.id}:${ctx.member.id}:`)
          .filter((row) => row.value.state === 'pending' || row.value.state === 'running').length >= 25
      )
        throw new UserError('At most 25 active DM reminders per person per server.');
      const token = randomBytes(6).toString('hex');
      ctx.store.set('notifications.jobs', `${ctx.guild.id}:${ctx.member.id}:${token}`, {
        guildId: ctx.guild.id,
        userId: ctx.member.id,
        content: input.content,
        dueAt,
        nonce: token,
        attempts: 0,
        state: 'pending',
        retryAt: 0,
      } satisfies DmReminder);
      return { id: token, dueAt: input.dueAt };
    },
  });
  registry.register({
    ...global,
    id: 'notification.reminders',
    category: 'notifications',
    risk: 'read',
    description: 'List your personal DM reminders.',
    schema: empty,
    execute: (ctx) =>
      ctx.store
        .list<DmReminder>('notifications.jobs', `${ctx.guild.id}:${ctx.member.id}:`)
        .map((row) => ({ id: row.key.split(':').at(-1), ...row.value }))
        .slice(-50),
  });
  registry.register({
    ...global,
    id: 'notification.cancel',
    category: 'notifications',
    description: 'Cancel one of your personal DM reminders.',
    schema: z.strictObject({ id: z.string().regex(/^[a-f0-9]{12}$/) }),
    execute: (ctx, input) => {
      const key = `${ctx.guild.id}:${ctx.member.id}:${input.id}`;
      const job = ctx.store.get<DmReminder>('notifications.jobs', key);
      if (!job) throw new UserError('Reminder not found.');
      ctx.store.delete('notifications.jobs', key);
      return { cancelled: input.id };
    },
  });
}
export async function identityContext(
  client: Client,
  store: Store,
  userId: string,
  channelId: string,
  allowedGuildIds: readonly string[] = [],
): Promise<ActionContext> {
  const guildId = store.get<string>('notifications.default', userId);
  if (!guildId || (allowedGuildIds.length && !allowedGuildIds.includes(guildId)))
    throw new UserError('Opt into personal DMs from a configured server with notification.subscribe first.');
  const consent = store.get<Consent>('notifications.consent', `${guildId}:${userId}`);
  if (!consent?.enabled || !consent.dm) throw new UserError('Personal DMs are disabled.');
  if ((store.get<string[]>('core.disabled', guildId) ?? []).includes('notifications'))
    throw new UserError('Personal DMs are disabled in this server.');
  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch({ user: userId, force: true });
  if (!personalConsentCurrent(store, guildId, userId, consent))
    throw new UserError('Personal DMs were disabled while checking membership.');
  return { client, store, guild, member, channelId };
}
export function personalConsentCurrent(
  store: Store,
  guildId: string,
  userId: string,
  expected?: { createdAt: number; version?: string },
): boolean {
  const consent = store.get<Consent>('notifications.consent', `${guildId}:${userId}`);
  return (
    store.get('notifications.default', userId) === guildId &&
    !!consent?.enabled &&
    consent.dm &&
    (!expected || (consent.createdAt === expected.createdAt && consent.version === expected.version)) &&
    !(store.get<string[]>('core.disabled', guildId) ?? []).includes('notifications')
  );
}
export async function onIdentityMessage(
  message: Message,
  store: Store,
  ai: AiService,
  allowedGuildIds: readonly string[] = [],
): Promise<boolean> {
  if (message.guild || message.author.bot || !message.channel.isDMBased()) return false;
  if (message.content.toLowerCase().trim() === 'stop') {
    store.delete('notifications.default', message.author.id);
    for (const row of store.list<Consent>('notifications.consent'))
      if (row.key.endsWith(`:${message.author.id}`))
        store.set('notifications.consent', row.key, { enabled: false, dm: false, createdAt: Date.now() });
    for (const row of store.list<DmReminder>('notifications.jobs'))
      if (row.value.userId === message.author.id) store.delete('notifications.jobs', row.key);
    await message.reply({
      content: 'Personal DMs disabled for all servers. Pending DM reminders cancelled.',
      allowedMentions: { parse: [] },
    });
    return true;
  }
  const sourceGuildId = store.get<string>('notifications.default', message.author.id);
  if (!sourceGuildId) return true;
  const initialConsent = store.get<Consent>('notifications.consent', `${sourceGuildId}:${message.author.id}`);
  let replyAuthority: { guildId: string; consent: Consent } | undefined =
    initialConsent && personalConsentCurrent(store, sourceGuildId, message.author.id, initialConsent)
      ? { guildId: sourceGuildId, consent: initialConsent }
      : undefined;
  try {
    const ctx = await identityContext(
      message.client,
      store,
      message.author.id,
      message.channelId,
      allowedGuildIds,
    );
    const file = message.attachments.first();
    const consent = store.get<Consent>('notifications.consent', `${ctx.guild.id}:${message.author.id}`);
    if (!message.content.trim() && !file) return true;
    if (!consent || !personalConsentCurrent(store, ctx.guild.id, message.author.id, consent)) return true;
    replyAuthority = { guildId: ctx.guild.id, consent };
    await withTyping(message.channel, async () => {
      if (!personalConsentCurrent(store, ctx.guild.id, message.author.id, consent)) return;
      const reply = await ai.chat(
        ctx,
        message.content.slice(0, 6000) || 'Analyze this attachment.',
        file ? { url: file.url, name: file.name, contentType: file.contentType } : undefined,
        false,
      );
      if (personalConsentCurrent(store, ctx.guild.id, message.author.id, consent))
        await message.reply(aiPayload(reply));
    });
  } catch (error) {
    if (!store.get('notifications.default', message.author.id)) return true;
    if (
      replyAuthority &&
      !personalConsentCurrent(store, replyAuthority.guildId, message.author.id, replyAuthority.consent)
    )
      return true;
    await message
      .reply({
        content:
          error instanceof UserError ? error.message : 'The DM request failed. Review the bot diagnostics.',
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
  }
  return true;
}
const running = new WeakSet<Store>();
export async function sweepIdentityTasks(
  client: Client,
  store: Store,
  now = Date.now(),
  allowedGuildIds: readonly string[] = [],
): Promise<void> {
  if (running.has(store)) return;
  running.add(store);
  let count = 0;
  try {
    for (const row of store.list<DmReminder>('notifications.jobs')) {
      const job = row.value;
      if (job.dueAt < now - 7 * 86400000 && (job.state === 'done' || job.state === 'failed')) {
        store.delete('notifications.jobs', row.key);
        continue;
      }
      if (
        count >= 10 ||
        job.state === 'done' ||
        job.state === 'failed' ||
        job.dueAt > now ||
        job.retryAt > now ||
        (allowedGuildIds.length && !allowedGuildIds.includes(job.guildId)) ||
        (store.get<string[]>('core.disabled', job.guildId) ?? []).includes('notifications')
      )
        continue;
      count++;
      const consent = store.get<Consent>('notifications.consent', `${job.guildId}:${job.userId}`);
      if (!consent?.enabled || !consent.dm) {
        store.delete('notifications.jobs', row.key);
        continue;
      }
      store.set('notifications.jobs', row.key, { ...job, state: 'running' });
      try {
        const guild = await client.guilds.fetch(job.guildId);
        const member = await guild.members.fetch({ user: job.userId, force: true });
        if (!store.get('notifications.jobs', row.key)) continue;
        const latest = store.get<Consent>('notifications.consent', `${job.guildId}:${job.userId}`);
        if (!latest?.enabled || !latest.dm) {
          store.delete('notifications.jobs', row.key);
          continue;
        }
        if ((store.get<string[]>('core.disabled', job.guildId) ?? []).includes('notifications')) {
          store.set('notifications.jobs', row.key, { ...job, state: 'pending' });
          continue;
        }
        await member.send({
          content: `Reminder from ${guild.name}: ${job.content}`,
          nonce: job.nonce,
          enforceNonce: true,
          allowedMentions: { parse: [] },
        });
        if (store.get('notifications.jobs', row.key))
          store.set('notifications.jobs', row.key, { ...job, state: 'done' });
      } catch {
        if (store.get('notifications.jobs', row.key))
          store.set('notifications.jobs', row.key, {
            ...job,
            attempts: job.attempts + 1,
            state: job.attempts + 1 >= 3 ? 'failed' : 'pending',
            retryAt: now + 30000 * 2 ** (job.attempts + 1),
          });
      }
    }
  } finally {
    running.delete(store);
  }
}
