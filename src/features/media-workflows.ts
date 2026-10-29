import { randomBytes } from 'node:crypto';
import { PermissionFlagsBits as P, type Client, type GuildMember } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import type { Store } from '../core/store.js';
import { assertPermissions, freshContext, resolveChannel, resolveMember } from '../core/permissions.js';
import { discordAttachmentUrl, downloadAttachment } from '../core/files.js';
import { UserError } from '../core/errors.js';
import { imageOperationSchema, imageFilterStepSchema, runMediaJob, type MediaFile } from './media.js';
import { runFileJob } from './files.js';
import { processAudioMedia } from './audio-media.js';
import type { AiService } from './ai.js';

const id = z.string().regex(/^\d{17,20}$/),
  color = z.string().regex(/^#[a-fA-F0-9]{6}$/),
  url = z
    .string()
    .max(4096)
    .refine((value) => {
      try {
        discordAttachmentUrl(value);
        return true;
      } catch {
        return false;
      }
    }, 'Use a Discord attachment URL.');
const appearance = { background: color.default('#111827'), accent: color.default('#6366f1') };
const base = { category: 'media', userPermissions: [], botPermissions: [], risk: 'read' as const };
interface IndexRecord {
  id: string;
  channelId: string;
  authorId: string;
  name: string;
  sha256: string;
  perceptualHash: string;
  createdAt: number;
}
interface WelcomePolicy {
  authorId: string;
  channelId: string;
  version: string;
  background: string;
  accent: string;
}
export const perceptualDistance = (left: string, right: string) => {
  if (!/^[a-f0-9]{16}$/.test(left) || !/^[a-f0-9]{16}$/.test(right))
    throw new UserError('Invalid perceptual hash.');
  let bits = BigInt('0x' + left) ^ BigInt('0x' + right),
    count = 0;
  while (bits) {
    count += Number(bits & 1n);
    bits >>= 1n;
  }
  return count;
};
async function binary(value: Awaited<ReturnType<typeof runMediaJob>>): Promise<MediaFile> {
  if (!('attachment' in value)) throw new UserError('Media processor returned no file.');
  return value;
}
async function analyticsRows(registry: ActionRegistry, ctx: ActionContext, days: number) {
  const outcome = await registry.request(ctx, 'analytics.observed', { days });
  if (outcome.status !== 'completed' || !Array.isArray(outcome.result))
    throw new UserError('Observed analytics are unavailable.');
  return outcome.result as { day: string; kind: string; count: number }[];
}
async function currentAnalytics(ctx: ActionContext) {
  const current = await freshContext(ctx);
  await assertPermissions(current, [P.ManageGuild], [], {});
  return current;
}

export async function memberImage(
  registry: ActionRegistry,
  ctx: ActionContext,
  userId: string,
  kind: 'welcome' | 'rank' | 'profile',
  theme: { background: string; accent: string },
): Promise<MediaFile> {
  const member = await resolveMember(ctx, userId);
  let title = '',
    subtitle = '',
    detail = '',
    progress: number | undefined;
  if (kind === 'welcome') {
    title = `Welcome, ${member.displayName}`.slice(0, 60);
    subtitle = ctx.guild.name.slice(0, 100);
    detail = `Member ${ctx.guild.memberCount}`;
  } else {
    const response = await registry.request(ctx, 'level.profile', { userId });
    if (response.status !== 'completed') throw new UserError('Member profile is unavailable.');
    const profile = response.result as {
      level: number;
      xp: number;
      nextLevelXp: number;
      observedActiveMessages: number;
    };
    title = member.displayName.slice(0, 60);
    subtitle = `Level ${profile.level} · ${profile.xp.toLocaleString()} XP`;
    detail = `${profile.observedActiveMessages.toLocaleString()} observed active messages`;
    progress = Math.min(1, profile.xp / Math.max(1, profile.nextLevelXp));
  }
  return binary(await runMediaJob({ kind: 'card', input: { title, subtitle, detail, progress, ...theme } }));
}
export function registerMediaWorkflowActions(
  registry: ActionRegistry,
  options: { ai?: AiService; download?: typeof downloadAttachment } = {},
): void {
  const download = options.download ?? downloadAttachment;
  registry.register({
    ...base,
    id: 'image.filters',
    description:
      'Apply an ordered bounded stack of typed brightness/color, normalize, gamma, sharpening, threshold and tint filters.',
    schema: z.strictObject({ url, steps: z.array(imageFilterStepSchema).min(1).max(8) }),
    execute: async (_ctx, input) =>
      runMediaJob({
        kind: 'image',
        data: await download(input.url, 8 * 1048576),
        operation: imageOperationSchema.parse({ kind: 'filters', steps: input.steps }),
      }),
  });
  registry.register({
    ...base,
    id: 'image.background-remove',
    description:
      'Create a transparent PNG by removing an edge-connected solid/color-key background with bounded feathering.',
    schema: z.strictObject({
      url,
      color: color.optional(),
      tolerance: z.number().int().min(0).max(255).default(30),
      feather: z.number().int().min(0).max(80).default(10),
    }),
    execute: async (_ctx, { url, ...input }) =>
      runMediaJob({
        kind: 'image',
        data: await download(url, 8 * 1048576),
        operation: { kind: 'background-remove', ...input },
      }),
  });
  registry.register({
    ...base,
    id: 'chart.render',
    description: 'Render a real bar, line, area, pie or scatter chart from bounded reviewed numeric data.',
    schema: z.strictObject({
      title: z.string().min(1).max(100),
      style: z.enum(['bar', 'line', 'area', 'pie', 'scatter']),
      values: z
        .array(z.strictObject({ label: z.string().min(1).max(30), value: z.number().min(0).max(1e9) }))
        .min(1)
        .max(20),
      color: color.default('#6366f1'),
    }),
    execute: (_ctx, input) => runMediaJob({ kind: 'chart', input }),
  });
  for (const kind of ['welcome', 'rank', 'profile'] as const)
    registry.register({
      ...base,
      id: `image.${kind}`,
      description: `Create a personalized ${kind} image directly from the current member/server profile and observed XP data.`,
      schema: z.strictObject({ userId: id.optional(), ...appearance }),
      execute: (ctx, input) => memberImage(registry, ctx, input.userId ?? ctx.member.id, kind, input),
    });
  registry.register({
    ...base,
    id: 'image.banner',
    description: 'Create a themed banner using current server identity and a reviewed subtitle.',
    schema: z.strictObject({ subtitle: z.string().max(100).default(''), ...appearance }),
    execute: (ctx, input) =>
      runMediaJob({
        kind: 'card',
        input: {
          title: ctx.guild.name.slice(0, 60),
          subtitle: input.subtitle,
          detail: `${ctx.guild.memberCount} members`,
          background: input.background,
          accent: input.accent,
        },
      }),
  });
  registry.register({
    ...base,
    id: 'ai.image.profile',
    category: 'ai',
    risk: 'write',
    description:
      'Generate a dedicated square profile-picture concept using reviewed style, colors and subject with the configured image model.',
    schema: z.strictObject({
      subject: z.string().min(1).max(500),
      style: z
        .enum(['minimal', 'illustration', 'photographic', 'pixel-art', 'abstract'])
        .default('illustration'),
      palette: z.string().max(100).default('balanced colors'),
    }),
    execute: (ctx, input) => {
      if (!options.ai) throw new UserError('AI image service is unavailable.');
      return options.ai.image(
        ctx,
        `Create a polished square profile-picture concept. Center the subject, keep a readable silhouette at small sizes, omit text and watermarks. Subject: ${input.subject}. Style: ${input.style}. Palette: ${input.palette}.`,
      );
    },
  });
  registry.register({
    ...base,
    id: 'analytics.chart',
    category: 'analytics',
    userPermissions: [P.ManageGuild],
    description:
      'Aggregate observed daily server metrics directly into an actual chart without manually copying values.',
    schema: z.strictObject({
      days: z.number().int().min(1).max(20).default(7),
      metric: z
        .string()
        .regex(/^[a-zA-Z0-9:._-]{1,100}$/)
        .default('messages'),
      style: z.enum(['bar', 'line', 'area', 'pie', 'scatter']).default('line'),
    }),
    execute: async (ctx, input) => {
      const rows = await analyticsRows(registry, ctx, input.days),
        days = new Map<string, number>();
      for (let i = input.days - 1; i >= 0; i--)
        days.set(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10), 0);
      for (const row of rows)
        if (row.kind === input.metric && days.has(row.day)) days.set(row.day, Number(row.count));
      const file = await runMediaJob({
        kind: 'chart',
        input: {
          title: `${ctx.guild.name.slice(0, 55)} · ${input.metric}`.slice(0, 100),
          style: input.style,
          values: [...days].map(([label, value]) => ({ label, value })),
        },
      });
      await currentAnalytics(ctx);
      return file;
    },
  });
  registry.register({
    ...base,
    id: 'image.statistics',
    userPermissions: [P.ManageGuild],
    description:
      'Generate a current server statistics image bound to actual server counts and observed activity.',
    schema: z.strictObject({ ...appearance }),
    execute: async (ctx, input) => {
      const rows = await analyticsRows(registry, ctx, 7),
        messages = rows
          .filter((row) => row.kind === 'messages')
          .reduce((sum, row) => sum + Number(row.count), 0);
      const guild = await ctx.guild.fetch();
      const file = await runMediaJob({
        kind: 'card',
        input: {
          title: guild.name.slice(0, 60),
          subtitle: `${guild.memberCount} members · ${guild.premiumSubscriptionCount ?? 0} boosts`,
          detail: `${messages} observed messages in the last 7 UTC days`,
          ...input,
        },
      });
      await currentAnalytics(ctx);
      return file;
    },
  });
  registry.register({
    ...base,
    id: 'analytics.workbook',
    category: 'analytics',
    userPermissions: [P.ManageGuild],
    description:
      'Export observed server metrics and request/error aggregates directly into a real multi-sheet XLSX workbook.',
    schema: z.strictObject({ days: z.number().int().min(1).max(90).default(30) }),
    execute: async (ctx, input) => {
      const rows = (await analyticsRows(registry, ctx, input.days)).slice(0, 1999),
        telemetry = ctx.store
          .list<{
            day: string;
            provider: string;
            endpoint: string;
            requests: number;
            errors: number;
            durationMs: number;
          }>('api.metrics', `${ctx.guild.id}:`)
          .map((row) => row.value)
          .filter(
            (row) => row.day >= new Date(Date.now() - (input.days - 1) * 86400000).toISOString().slice(0, 10),
          )
          .slice(0, 1999);
      const file = await runFileJob({
        kind: 'xlsx',
        input: {
          sheets: [
            {
              name: 'Observed activity',
              headerRow: true,
              rows: [
                ['UTC day', 'Metric', 'Observed count'],
                ...rows.map((row) => [row.day, row.kind, Number(row.count)]),
              ],
            },
            {
              name: 'API requests',
              headerRow: true,
              rows: [
                ['UTC day', 'Provider', 'Endpoint', 'Requests', 'Errors', 'Mean milliseconds'],
                ...telemetry.map((row) => [
                  row.day,
                  row.provider,
                  row.endpoint,
                  row.requests,
                  row.errors,
                  row.requests ? row.durationMs / row.requests : 0,
                ]),
              ],
            },
          ],
        },
      });
      await currentAnalytics(ctx);
      return file;
    },
  });
  registry.register({
    ...base,
    id: 'image.welcome.configure',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    description: 'Enable or disable personalized member-join welcome images in a reviewed server channel.',
    schema: z.strictObject({ enabled: z.boolean(), channelId: id, ...appearance }),
    execute: async (ctx, input) => {
      if (!input.enabled) {
        ctx.store.delete('media.welcomePolicy', ctx.guild.id);
        return { enabled: false };
      }
      const channel = await resolveChannel(ctx, input.channelId);
      if (
        !channel.permissionsFor(ctx.member)?.has(P.SendMessages) ||
        !channel.permissionsFor(ctx.guild.members.me!)?.has(P.SendMessages)
      )
        throw new UserError('Both manager and bot need Send Messages in the welcome channel.');
      ctx.store.set('media.welcomePolicy', ctx.guild.id, {
        authorId: ctx.member.id,
        channelId: input.channelId,
        background: input.background,
        accent: input.accent,
        version: randomBytes(8).toString('hex'),
      } satisfies WelcomePolicy);
      return { enabled: true, channelId: input.channelId };
    },
  });
  registry.register({
    ...base,
    id: 'media.index.add',
    risk: 'write',
    userPermissions: [P.ManageMessages],
    description:
      'Index an explicitly supplied image using exact SHA-256 and a 64-bit perceptual difference hash; retains no image bytes.',
    schema: z.strictObject({ url, name: z.string().min(1).max(100) }),
    execute: async (ctx, input) => {
      if (ctx.store.list('media.index', `${ctx.guild.id}:`).length >= 1000)
        throw new UserError('Media index limit is 1000 per server.');
      const hash = await runMediaJob({ kind: 'image-hash', data: await download(input.url, 8 * 1048576) });
      if (!('perceptualHash' in hash) || !hash.perceptualHash) throw new UserError('Image hashing failed.');
      const fresh = await freshContext(ctx);
      await assertPermissions(fresh, [P.ManageMessages], [], {});
      registry.assertPolicy(fresh, 'media.index.add');
      if (ctx.store.list('media.index', `${ctx.guild.id}:`).length >= 1000)
        throw new UserError('Media index limit is 1000 per server.');
      const record: IndexRecord = {
        id: randomBytes(8).toString('hex'),
        name: input.name,
        channelId: ctx.channelId,
        authorId: ctx.member.id,
        sha256: hash.sha256,
        perceptualHash: hash.perceptualHash,
        createdAt: Date.now(),
      };
      ctx.store.set('media.index', `${ctx.guild.id}:${record.id}`, record);
      return record;
    },
  });
  registry.register({
    ...base,
    id: 'media.index.remove',
    risk: 'write',
    userPermissions: [P.ManageMessages],
    description: 'Remove a retained duplicate-media index record after confirmation.',
    schema: z.strictObject({ id: z.string().regex(/^[a-f0-9]{16}$/) }),
    execute: (ctx, input) => ({ removed: ctx.store.delete('media.index', `${ctx.guild.id}:${input.id}`) }),
  });
  registry.register({
    ...base,
    id: 'media.duplicates',
    description:
      'Find exact or perceptually similar indexed images, filtered by current source-channel history access.',
    schema: z.strictObject({ url, maximumDistance: z.number().int().min(0).max(64).default(5) }),
    execute: async (ctx, input) => {
      const hash = await runMediaJob({ kind: 'image-hash', data: await download(input.url, 8 * 1048576) });
      if (!('perceptualHash' in hash) || !hash.perceptualHash) throw new UserError('Image hashing failed.');
      const fresh = await freshContext(ctx),
        result = [];
      for (const row of ctx.store.list<IndexRecord>('media.index', `${ctx.guild.id}:`)) {
        const record = row.value,
          distance = perceptualDistance(hash.perceptualHash, record.perceptualHash);
        if (hash.sha256 !== record.sha256 && distance > input.maximumDistance) continue;
        const channel = await resolveChannel(fresh, record.channelId).catch(() => null);
        if (
          !channel?.permissionsFor(fresh.member)?.has(P.ReadMessageHistory) ||
          !channel.permissionsFor(fresh.guild.members.me!)?.has(P.ReadMessageHistory)
        )
          continue;
        result.push({ id: record.id, name: record.name, exact: record.sha256 === hash.sha256, distance });
      }
      return result.sort((a, b) => Number(b.exact) - Number(a.exact) || a.distance - b.distance).slice(0, 50);
    },
  });
  registry.register({
    ...base,
    id: 'image.emoji.create',
    risk: 'write',
    userPermissions: [P.ManageGuildExpressions],
    botPermissions: [P.ManageGuildExpressions],
    description:
      'Prepare a bounded transparent 128px PNG and upload it as a custom emoji in one reviewed workflow.',
    schema: z.strictObject({
      url,
      name: z.string().regex(/^\w{2,32}$/),
      roleIds: z.array(id).max(20).default([]),
    }),
    execute: async (ctx, input) => {
      const file = await binary(
        await runMediaJob({
          kind: 'image',
          data: await download(input.url, 8 * 1048576),
          operation: { kind: 'resize', width: 128, height: 128, fit: 'contain' },
        }),
      );
      if (file.attachment.length > 256 * 1024) throw new UserError('Prepared emoji exceeds 256 KiB.');
      const outcome = await registry.request(ctx, 'emoji.create', {
        name: input.name,
        image: `data:image/png;base64,${file.attachment.toString('base64')}`,
        roleIds: input.roleIds,
      });
      return outcome.status === 'confirmation' ? registry.confirm(ctx, outcome.id) : outcome;
    },
  });
  registry.register({
    ...base,
    id: 'media.soundboard.create',
    risk: 'write',
    userPermissions: [P.ManageGuildExpressions],
    botPermissions: [P.ManageGuildExpressions],
    description:
      'Convert a selected attachment to a ≤5-second bounded MP3 clip and upload it as a soundboard sound after review.',
    schema: z.strictObject({
      url,
      name: z.string().min(2).max(32),
      startSeconds: z.number().min(0).max(7200).default(0),
      durationSeconds: z.number().min(0.1).max(5).default(3),
      volume: z.number().min(0).max(1).default(1),
    }),
    execute: async (ctx, input) => {
      const file = await processAudioMedia(await download(input.url, 8 * 1048576), {
        kind: 'audio',
        format: 'mp3',
        bitrateKbps: 64,
        startSeconds: input.startSeconds,
        durationSeconds: input.durationSeconds,
      });
      if (file.attachment.length > 512000) throw new UserError('Prepared soundboard clip exceeds 512 KB.');
      const outcome = await registry.request(ctx, 'soundboard.create', {
        name: input.name,
        base64: file.attachment.toString('base64'),
        contentType: 'audio/mpeg',
        volume: input.volume,
      });
      return outcome.status === 'confirmation' ? registry.confirm(ctx, outcome.id) : outcome;
    },
  });
}

/** Call on actual member joins; nothing posts until an authorized manager explicitly enables the policy. */
export async function onMediaMemberJoin(
  client: Client,
  store: Store,
  registry: ActionRegistry,
  member: GuildMember,
): Promise<void> {
  // The community welcome is the single join message when configured; optional
  // legacy PNG welcomes remain available for servers that choose that mode alone.
  const disabled = store.get<string[]>('core.disabled', member.guild.id) ?? [];
  if (
    member.user.bot ||
    (!disabled.includes('community') &&
      store.get<{ welcomeChannelId?: string | null }>('community.settings', member.guild.id)
        ?.welcomeChannelId)
  )
    return;
  const policy = store.get<WelcomePolicy>('media.welcomePolicy', member.guild.id);
  if (!policy || disabled.includes('media')) return;
  const occurrence = `${member.guild.id}:${member.id}:${member.joinedTimestamp ?? 0}`,
    version = policy.version,
    featureEpoch = store.get<number>('core.featureEpochs', `${member.guild.id}:media`) ?? 0;
  if (store.get('media.welcomeSeen', occurrence)) return;
  const author = await member.guild.members.fetch({ user: policy.authorId, force: true });
  const ctx = { client, store, guild: member.guild, member: author, channelId: policy.channelId };
  const verify = async () => {
    const fresh = await freshContext(ctx);
    registry.assertPolicy(fresh, 'image.welcome.configure');
    if (
      !fresh.member.permissions.has(P.ManageGuild) ||
      store.get<WelcomePolicy>('media.welcomePolicy', member.guild.id)?.version !== version ||
      (store.get<number>('core.featureEpochs', `${member.guild.id}:media`) ?? 0) !== featureEpoch
    )
      throw new UserError('Welcome policy changed.');
    const channel = await resolveChannel(fresh, policy.channelId);
    if (
      !channel.isSendable() ||
      !channel.permissionsFor(fresh.member)?.has(P.SendMessages) ||
      !channel.permissionsFor(fresh.guild.members.me!)?.has(P.SendMessages)
    )
      throw new UserError('Welcome channel is not writable.');
    return channel;
  };
  await verify();
  const file = await memberImage(registry, ctx, member.id, 'welcome', policy);
  const channel = await verify();
  // Persist the delivery claim before the irreversible send; uncertain sends are not blindly retried.
  if (store.get('media.welcomeSeen', occurrence)) return;
  store.set('media.welcomeSeen', occurrence, { at: Date.now() });
  const seen = store
    .list<{ at: number }>('media.welcomeSeen', `${member.guild.id}:`)
    .sort((a, b) => b.value.at - a.value.at);
  for (const [index, row] of seen.entries())
    if (row.value.at < Date.now() - 30 * 86400000 || index >= 5000)
      store.delete('media.welcomeSeen', row.key);
  await channel.send({ files: [file], allowedMentions: { parse: [] } });
}
