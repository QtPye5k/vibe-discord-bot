import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import { assertUserRequestCurrent } from '../core/types.js';
import { UserError } from '../core/errors.js';
import type { AiService } from './ai.js';
import { runMediaJob } from './media.js';
import { resolveMediaDestination } from './media-search.js';

const destination = {
  channelId: z
    .string()
    .regex(/^\d{17,20}$/)
    .optional(),
  requestId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
};
interface Delivery {
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  state: 'preparing' | 'sending' | 'sent' | 'unknown';
  result?: { messageId: string; channelId: string; generated?: true; source?: string };
}
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Original provider pages only: no shorteners, credentials, query redirects, account cookies or scraping. */
export function publicMediaPage(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UserError('Use a full public Pinterest Pin or KLIPY GIF link.');
  }
  if (
    value.length > 1000 ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !(
      (['www.pinterest.com', 'pinterest.com'].includes(url.hostname) &&
        /^\/pin\/\d{1,30}\/?$/.test(url.pathname)) ||
      (url.hostname === 'klipy.com' && /^\/gifs\/[A-Za-z0-9_-]{1,200}\/?$/.test(url.pathname))
    )
  )
    throw new UserError(
      'Use an original https://www.pinterest.com/pin/ID/ or https://klipy.com/gifs/SLUG link without redirects or tracking parameters.',
    );
  return url.href;
}
export function registerMediaPostingActions(
  registry: ActionRegistry,
  options: { ai?: Pick<AiService, 'image'> } = {},
) {
  async function once(
    ctx: ActionContext,
    action: string,
    input: { channelId?: string; requestId?: string },
    fingerprint: string,
    prepare: () => Promise<{ attachment: Buffer; name: string } | string>,
  ) {
    const now = Date.now(),
      prefix = `${ctx.guild.id}:${ctx.member.id}:${ctx.channelId}:`;
    for (const row of ctx.store.list<Delivery>('media.deliveries'))
      if (row.value.expiresAt <= now) ctx.store.delete('media.deliveries', row.key);
    const rows = ctx.store.list<Delivery>('media.deliveries'),
      own = rows.filter((row) => row.key.startsWith(prefix));
    const duplicate = input.requestId
      ? ctx.store.get<Delivery>('media.deliveries', prefix + input.requestId)
      : own.find((row) => row.value.fingerprint === fingerprint && row.value.createdAt > now - 60000)?.value;
    if (duplicate) {
      if (duplicate.fingerprint !== fingerprint)
        throw new UserError('That media requestId is already bound to a different request.');
      if (duplicate.state === 'sent' && duplicate.result) return { ...duplicate.result, alreadySent: true };
      throw new UserError(
        'That media request is already being prepared or has an uncertain delivery. Check the destination before starting a new request.',
      );
    }
    if (rows.length >= 500 || own.length >= 10)
      throw new UserError('Media delivery limit reached; receipts expire after ten minutes.');
    // Destination permissions are checked before an image generation can incur cost.
    await resolveMediaDestination(ctx, input.channelId ?? ctx.channelId, action === 'media.generate-send');
    assertUserRequestCurrent(ctx);
    // Recheck after the fresh destination await, without allowing another concurrent paid generation.
    const after = ctx.store.list<Delivery>('media.deliveries').filter((row) => row.key.startsWith(prefix));
    const concurrent = input.requestId
      ? ctx.store.get<Delivery>('media.deliveries', prefix + input.requestId)
      : after.find((row) => row.value.fingerprint === fingerprint && row.value.createdAt > now - 60000)
          ?.value;
    if (concurrent) throw new UserError('That media request is already being prepared or delivered.');
    if (after.length >= 10 || ctx.store.list('media.deliveries').length >= 500)
      throw new UserError('Media delivery limit reached.');
    const key = prefix + (input.requestId ?? randomBytes(12).toString('base64url'));
    const record: Delivery = { fingerprint, createdAt: now, expiresAt: now + 600000, state: 'preparing' };
    ctx.store.set('media.deliveries', key, record);
    let dispatched = false;
    try {
      const content = await prepare();
      const { fresh, channel } = await resolveMediaDestination(
        ctx,
        input.channelId ?? ctx.channelId,
        typeof content !== 'string',
      );
      registry.assertPolicy(fresh, action);
      assertUserRequestCurrent(fresh);
      record.state = 'sending';
      ctx.store.set('media.deliveries', key, record);
      dispatched = true;
      const message = await channel.send(
        typeof content === 'string'
          ? { content, allowedMentions: { parse: [] } }
          : { files: [content], allowedMentions: { parse: [] } },
      );
      record.state = 'sent';
      record.result = {
        messageId: message.id,
        channelId: channel.id,
        ...(typeof content === 'string' ? { source: content } : { generated: true as const }),
      };
      ctx.store.set('media.deliveries', key, record);
      return record.result;
    } catch (error) {
      if (dispatched) {
        record.state = 'unknown';
        ctx.store.set('media.deliveries', key, record);
      } else ctx.store.delete('media.deliveries', key);
      throw error;
    }
  }
  const base = { category: 'media', risk: 'write' as const, userPermissions: [], botPermissions: [] };
  registry.register({
    ...base,
    id: 'media.generate-send',
    description:
      'Generate an OpenAI image from a prompt and post it to the requested permitted channel, using the configured image model and AI quota. Optional requestId prevents duplicate retries.',
    schema: z.strictObject({
      prompt: z.string().trim().min(1).max(4000),
      transparent: z.boolean().default(false),
      ...destination,
    }),
    execute: async (ctx, input) => {
      if (!options.ai) throw new UserError('AI image generation is unavailable. Configure OPENAI_API_KEY.');
      return once(
        ctx,
        'media.generate-send',
        input,
        digest(['generate', input.channelId ?? ctx.channelId, input.prompt, input.transparent]),
        async () => {
          const file = await options.ai!.image(ctx, input.prompt, undefined, input.transparent);
          assertUserRequestCurrent(ctx);
          if (
            !Buffer.isBuffer(file.attachment) ||
            !file.attachment.length ||
            file.attachment.length > 8 * 1048576
          )
            throw new UserError('Generated image exceeds the supported 8 MiB attachment limit.');
          const inspected = await runMediaJob({ kind: 'image-info', data: file.attachment });
          if (!('format' in inspected) || !['png', 'jpeg', 'webp'].includes(inspected.format))
            throw new UserError('Image generator returned an unsupported image format.');
          return {
            attachment: file.attachment,
            name: `vibe-generated.${inspected.format === 'jpeg' ? 'jpg' : inspected.format}`,
          };
        },
      );
    },
  });
  registry.register({
    ...base,
    id: 'media.link-send',
    description:
      'Post a user-supplied original public Pinterest Pin or KLIPY GIF link to a permitted channel without scraping/rehosting or a provider key. Discord controls previews; animation is not guaranteed.',
    schema: z.strictObject({ url: z.string().max(1000).transform(publicMediaPage), ...destination }),
    execute: (ctx, input) =>
      once(
        ctx,
        'media.link-send',
        input,
        digest(['link', input.channelId ?? ctx.channelId, input.url]),
        async () => input.url,
      ),
  });
}
