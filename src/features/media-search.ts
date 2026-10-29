import { randomBytes } from 'node:crypto';
import { PermissionFlagsBits as P } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import { assertUserRequestCurrent } from '../core/types.js';
import { UserError } from '../core/errors.js';
import { freshContext, resolveChannel } from '../core/permissions.js';
import { fetchPublic, publicUrl, type PublicTransport } from './integrations.js';
import { runMediaJob } from './media.js';

export const MEDIA_SEARCH_LIMITS = Object.freeze({
  results: 5,
  cacheEntries: 100,
  cacheMs: 5 * 60000,
  tokenMs: 10 * 60000,
  tokens: 500,
  perUserTokens: 10,
  perGuildTokens: 100,
  responseBytes: 262144,
  fileBytes: 2 * 1024 * 1024,
});
interface SearchResult {
  title: string;
  url: string;
  source: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  artist: string;
  credit: string;
  license: string;
  state: 'available' | 'sending' | 'sent' | 'unknown';
  messageId?: string;
}
interface SearchToken {
  userId: string;
  guildId: string;
  channelId: string;
  expiresAt: number;
  results: SearchResult[];
}
export interface MediaSearchOptions {
  transport?: PublicTransport;
  now?: () => number;
}
const searchSchema = z.strictObject({ query: z.string().trim().min(1).max(150) });
const sendSchema = z.strictObject({
  searchId: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  index: z.number().int().min(1).max(5),
  title: z.string().min(1).max(200),
  channelId: z
    .string()
    .regex(/^\d{17,20}$/)
    .optional(),
});
const formats: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export function metadataText(value: unknown, max = 300): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|#39|#34|#x[0-9a-f]+|#[0-9]+);/gi, (entity) => {
      const simple: Record<string, string> = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&apos;': "'",
        '&#39;': "'",
        '&#34;': '"',
      };
      if (simple[entity]) return simple[entity]!;
      const value = entity.slice(2, -1),
        point = value[0]?.toLowerCase() === 'x' ? Number.parseInt(value.slice(1), 16) : Number(value);
      return point >= 32 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : '';
    })
    .replace(/[\u0000-\u001f\u007f@`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
export function commonsUploadUrl(value: string): string {
  const url = publicUrl(value, ['upload.wikimedia.org']);
  if (
    !url.pathname.startsWith('/wikipedia/commons/') ||
    [...url.searchParams.keys()].some(
      (key) => !['utm_source', 'utm_campaign', 'utm_content'].includes(key),
    ) ||
    url.hash
  )
    throw new UserError('The search result has an unsupported Wikimedia upload URL.');
  url.search = '';
  return url.href;
}
export class MediaSearchService {
  private readonly cache = new Map<string, { expires: number; results: SearchResult[] }>();
  private readonly pending = new Map<string, Promise<SearchResult[]>>();
  private readonly now: () => number;
  constructor(private readonly options: MediaSearchOptions = {}) {
    this.now = options.now ?? Date.now;
  }
  private async query(query: string, kind: 'image' | 'gif'): Promise<SearchResult[]> {
    const key = `${kind}:${query.toLowerCase()}`,
      cached = this.cache.get(key);
    if (cached && cached.expires > this.now()) return cached.results;
    const current = this.pending.get(key);
    if (current) return current;
    if (this.pending.size >= 4) throw new UserError('Media search is busy. Try again shortly.');
    const work = (async () => {
      const url = new URL('https://commons.wikimedia.org/w/api.php');
      for (const [key, value] of Object.entries({
        action: 'query',
        generator: 'search',
        gsrsearch: `${query} filetype:bitmap filesize:<2048${kind === 'gif' ? ' filemime:"image/gif"' : ''}`,
        gsrnamespace: '6',
        gsrlimit: '10',
        prop: 'imageinfo',
        iiprop: 'url|size|mime|extmetadata',
        iiextmetadatafilter: 'Artist|Credit|LicenseShortName',
        format: 'json',
        formatversion: '2',
        maxlag: '5',
      }))
        url.searchParams.set(key, value);
      const response = await fetchPublic(
        url.href,
        {
          allowedHosts: ['commons.wikimedia.org'],
          maxBytes: MEDIA_SEARCH_LIMITS.responseBytes,
          headers: { Accept: 'application/json' },
        },
        this.options.transport,
      );
      if (
        response.status !== 200 ||
        !response.headers['content-type']?.toLowerCase().includes('application/json')
      )
        throw new UserError(`Wikimedia media search is unavailable (${response.status}).`);
      let data: Record<string, unknown>;
      try {
        data = object(JSON.parse(response.body.toString()));
      } catch {
        throw new UserError('Wikimedia returned invalid search data.');
      }
      if (data.error) throw new UserError('Wikimedia could not complete that media search. Try again later.');
      const pages = object(data.query).pages;
      if (pages !== undefined && !Array.isArray(pages))
        throw new UserError('Wikimedia returned an unsupported search response.');
      const results: SearchResult[] = [];
      for (const raw of Array.isArray(pages) ? pages.slice(0, 10) : []) {
        const page = object(raw),
          info = object(Array.isArray(page.imageinfo) ? page.imageinfo[0] : undefined),
          mime = String(info.mime ?? '').toLowerCase();
        if (!formats[mime] || (kind === 'gif' && mime !== 'image/gif')) continue;
        const size = Number(info.size),
          width = Number(info.width),
          height = Number(info.height),
          title = metadataText(page.title, 200);
        if (
          !Number.isInteger(size) ||
          size < 1 ||
          size > MEDIA_SEARCH_LIMITS.fileBytes ||
          !Number.isInteger(width) ||
          !Number.isInteger(height) ||
          width < 1 ||
          height < 1 ||
          width > 16384 ||
          height > 16384 ||
          width * height > 40000000 ||
          !title.startsWith('File:') ||
          String(page.title).length > 512
        )
          continue;
        let upload: string;
        try {
          upload = commonsUploadUrl(String(info.url));
        } catch {
          continue;
        }
        const metadata = object(info.extmetadata),
          get = (name: string, max = 300) => metadataText(object(metadata[name]).value, max);
        results.push({
          title,
          url: upload,
          source: `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(page.title))}`,
          mime,
          size,
          width,
          height,
          artist: get('Artist') || 'See source file page',
          credit: get('Credit', 200),
          license: get('LicenseShortName', 100) || 'See source file page for terms',
          state: 'available',
        });
        if (results.length >= MEDIA_SEARCH_LIMITS.results) break;
      }
      for (const [key, cached] of this.cache) if (cached.expires <= this.now()) this.cache.delete(key);
      if (this.cache.size >= MEDIA_SEARCH_LIMITS.cacheEntries)
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { expires: this.now() + MEDIA_SEARCH_LIMITS.cacheMs, results });
      return results;
    })();
    this.pending.set(key, work);
    try {
      return await work;
    } finally {
      this.pending.delete(key);
    }
  }
  async search(ctx: ActionContext, query: string, kind: 'image' | 'gif'): Promise<unknown> {
    query = searchSchema.parse({ query }).query;
    const records = ctx.store.list<SearchToken>('media.search');
    for (const record of records)
      if (record.value.expiresAt <= this.now()) ctx.store.delete('media.search', record.key);
    const remaining = records.filter((record) => record.value.expiresAt > this.now());
    if (
      remaining.length >= MEDIA_SEARCH_LIMITS.tokens ||
      remaining.filter((record) => record.value.guildId === ctx.guild.id).length >=
        MEDIA_SEARCH_LIMITS.perGuildTokens ||
      remaining.filter(
        (record) => record.value.userId === ctx.member.id && record.value.guildId === ctx.guild.id,
      ).length >= MEDIA_SEARCH_LIMITS.perUserTokens
    )
      throw new UserError(
        'Media search selection limit reached. Existing selections expire after ten minutes.',
      );
    const results = await this.query(query, kind),
      searchId = randomBytes(12).toString('base64url'),
      expiresAt = this.now() + MEDIA_SEARCH_LIMITS.tokenMs;
    assertUserRequestCurrent(ctx);
    // Recheck limits after the provider await so concurrent searches cannot exceed the persistent bound.
    const live = ctx.store
      .list<SearchToken>('media.search')
      .filter((record) => record.value.expiresAt > this.now());
    if (
      live.length >= MEDIA_SEARCH_LIMITS.tokens ||
      live.filter((record) => record.value.guildId === ctx.guild.id).length >=
        MEDIA_SEARCH_LIMITS.perGuildTokens ||
      live.filter((record) => record.value.guildId === ctx.guild.id && record.value.userId === ctx.member.id)
        .length >= MEDIA_SEARCH_LIMITS.perUserTokens
    )
      throw new UserError('Media search selection limit reached.');
    ctx.store.set('media.search', searchId, {
      userId: ctx.member.id,
      guildId: ctx.guild.id,
      channelId: ctx.channelId,
      expiresAt,
      results: structuredClone(results),
    } satisfies SearchToken);
    return {
      provider: 'Wikimedia Commons',
      searchId,
      expiresAt,
      results: results.map((result, index) => ({
        index: index + 1,
        title: result.title,
        source: result.source,
        artist: result.artist,
        credit: result.credit,
        license: result.license,
        mime: result.mime,
        size: result.size,
        width: result.width,
        height: result.height,
        send: { searchId, index: index + 1, title: result.title },
      })),
      notice:
        'Use media.search-send with an exact returned selection and optional target channelId. A direct send request can choose a relevant result without another questionnaire; the configured confirmation policy still applies. Attribution and full license terms are on each source file page. GIF search covers Commons files; it is not a Giphy/Tenor search.',
    };
  }
  private selection(
    ctx: ActionContext,
    input: z.infer<typeof sendSchema>,
  ): { token: SearchToken; result: SearchResult } {
    const token = ctx.store.get<SearchToken>('media.search', input.searchId);
    if (
      !token ||
      token.userId !== ctx.member.id ||
      token.guildId !== ctx.guild.id ||
      token.channelId !== ctx.channelId ||
      token.expiresAt <= this.now()
    )
      throw new UserError('That media search selection expired or belongs to another user/channel.');
    const result = token.results[input.index - 1];
    if (!result || result.title !== input.title || result.state !== 'available')
      throw new UserError(
        'The exact selected search result is unavailable or has already been sent/claimed.',
      );
    return { token, result };
  }
  async send(ctx: ActionContext, raw: z.input<typeof sendSchema>): Promise<unknown> {
    assertUserRequestCurrent(ctx);
    const input = sendSchema.parse(raw),
      selected = this.selection(ctx, input).result;
    const response = await fetchPublic(
      commonsUploadUrl(selected.url),
      {
        allowedHosts: ['upload.wikimedia.org'],
        maxBytes: MEDIA_SEARCH_LIMITS.fileBytes,
        headers: { Accept: selected.mime },
      },
      this.options.transport,
    );
    if (
      response.status !== 200 ||
      response.headers['content-type']?.split(';')[0]?.toLowerCase() !== selected.mime
    )
      throw new UserError('Selected image download has an invalid status or media type.');
    const inspected = await runMediaJob({ kind: 'image-info', data: response.body });
    assertUserRequestCurrent(ctx);
    if (!('format' in inspected) || inspected.format !== formats[selected.mime])
      throw new UserError('Selected media bytes do not match the declared image format.');
    const fresh = await freshContext(ctx),
      channel = await resolveChannel(fresh, input.channelId ?? ctx.channelId);
    assertUserRequestCurrent(fresh);
    const send = channel.isThread() ? P.SendMessagesInThreads : P.SendMessages;
    for (const principal of [fresh.member, fresh.guild.members.me!])
      if (!channel.permissionsFor(principal)?.has([P.ViewChannel, send, P.AttachFiles]))
        throw new UserError(
          'You and the bot need current View Channel, Send Messages and Attach Files permissions.',
        );
    if (!channel.isTextBased() || !('send' in channel))
      throw new UserError('Send media from a writable server text channel.');
    if ((ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? []).includes('media'))
      throw new UserError('Media is disabled in this server.');
    ctx.store.transaction(() => {
      const { token, result } = this.selection(fresh, input);
      result.state = 'sending';
      ctx.store.set('media.search', input.searchId, token);
    });
    try {
      assertUserRequestCurrent(fresh);
      const attribution = `${selected.title}\nArtist: ${selected.artist}${selected.credit ? `\nCredit: ${selected.credit}` : ''}\nLicense: ${selected.license}\nSource and full terms: ${selected.source}`;
      const message = await channel.send({
        content: attribution.slice(0, 1900),
        files: [
          {
            attachment: response.body,
            name: `commons-image.${formats[selected.mime] === 'jpeg' ? 'jpg' : formats[selected.mime]}`,
          },
        ],
        allowedMentions: { parse: [] },
      });
      const token = ctx.store.get<SearchToken>('media.search', input.searchId);
      if (token) {
        token.results[input.index - 1]!.state = 'sent';
        token.results[input.index - 1]!.messageId = message.id;
        ctx.store.set('media.search', input.searchId, token);
      }
      return {
        messageId: message.id,
        channelId: channel.id,
        title: selected.title,
        source: selected.source,
        provider: 'Wikimedia Commons',
      };
    } catch (error) {
      const token = ctx.store.get<SearchToken>('media.search', input.searchId);
      if (token) {
        token.results[input.index - 1]!.state = 'unknown';
        ctx.store.set('media.search', input.searchId, token);
      }
      throw error;
    }
  }
}
export function registerMediaSearchActions(registry: ActionRegistry, options: MediaSearchOptions = {}): void {
  const service = new MediaSearchService(options),
    base = { category: 'media', userPermissions: [], botPermissions: [], risk: 'read' as const };
  registry.register({
    ...base,
    id: 'image.search',
    description:
      'Search public Wikimedia Commons raster images with source, artist and license metadata; no extra API key.',
    schema: searchSchema,
    execute: (ctx, input) => service.search(ctx, input.query, 'image'),
  });
  registry.register({
    ...base,
    id: 'gif.search',
    description:
      'Search public Wikimedia Commons GIF files with attribution (Commons catalog, not Giphy/Tenor).',
    schema: searchSchema,
    execute: (ctx, input) => service.search(ctx, input.query, 'gif'),
  });
  registry.register({
    ...base,
    id: 'media.search-send',
    risk: 'write',
    userPermissions: [P.AttachFiles],
    botPermissions: [P.AttachFiles],
    description:
      'Send an exact returned Commons image/GIF selection to a visible writable server channel with attribution; search origin and owner bound, expiring and one-use per result. Uses the configured confirmation policy.',
    schema: sendSchema,
    execute: (ctx, input) => service.send(ctx, input),
  });
}
