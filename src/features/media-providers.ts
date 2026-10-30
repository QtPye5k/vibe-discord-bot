import { createHmac } from 'node:crypto';
import { UserError } from '../core/errors.js';
import { fetchPublic, publicUrl, type PublicTransport } from './integrations.js';

export type MediaProvider = 'commons' | 'klipy' | 'pinterest';
export interface ProviderMedia {
  provider: MediaProvider;
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
  delivery?: 'link';
  slug?: string;
  query?: string;
  customerId?: string;
}
export interface MediaProviderOptions {
  klipyApiKey?: string;
  klipyBotApproved?: boolean;
  pinterestAccessToken?: string;
  pinterestCountryCode?: string;
  transport?: PublicTransport;
  shareFetch?: typeof fetch;
}
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown, limit = 200) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f@`<>]/g, ' ')
    .trim()
    .slice(0, limit);
const klipyHosts = ['static.klipy.com', 'static1.klipy.com', 'static2.klipy.com'];
export function providerMediaUrl(value: string, provider: MediaProvider): string {
  const url = publicUrl(value, provider === 'klipy' ? klipyHosts : ['i.pinimg.com']);
  if (provider === 'commons' || !/\.(?:gif|png|jpe?g|webp)$/i.test(url.pathname))
    throw new UserError('Unsupported provider image URL.');
  // Keep provider query parameters intact; they can carry required delivery data.
  return url.href;
}
export async function searchProvider(
  provider: 'klipy' | 'pinterest',
  query: string,
  userId: string,
  options: MediaProviderOptions,
): Promise<ProviderMedia[]> {
  if (provider === 'klipy' && (!options.klipyApiKey || !options.klipyBotApproved))
    throw new UserError(
      'KLIPY requires KLIPY_API_KEY and prior provider approval for this bot (KLIPY_BOT_APPROVED).',
    );
  if (provider === 'pinterest' && !options.pinterestAccessToken)
    throw new UserError(
      'Pinterest requires PINTEREST_ACCESS_TOKEN with approved public partner-search access.',
    );
  const customerId =
    provider === 'klipy'
      ? createHmac('sha256', options.klipyApiKey!).update(`vibe-media:${userId}`).digest('hex').slice(0, 32)
      : undefined;
  const url =
    provider === 'klipy'
      ? new URL(`https://api.klipy.com/api/v1/${encodeURIComponent(options.klipyApiKey!)}/gifs/search`)
      : new URL('https://api.pinterest.com/v5/search/partner/pins');
  const params =
    provider === 'klipy'
      ? {
          q: query,
          page: '1',
          per_page: '8',
          customer_id: customerId!,
          locale: 'us',
          content_filter: 'high',
          format_filter: 'gif',
        }
      : { term: query, country_code: options.pinterestCountryCode || 'US', limit: '10' };
  if (provider === 'pinterest' && !/^[A-Z]{2}$/.test(params.country_code!))
    throw new UserError('PINTEREST_COUNTRY_CODE must be a two-letter uppercase country code.');
  for (const [key, value] of Object.entries(params))
    if (value !== undefined) url.searchParams.set(key, value);
  let data: Record<string, unknown>;
  try {
    const response = await fetchPublic(
      url.href,
      {
        allowedHosts: [url.hostname],
        maxBytes: 262144,
        headers: {
          Accept: 'application/json',
          ...(provider === 'pinterest' ? { Authorization: `Bearer ${options.pinterestAccessToken}` } : {}),
        },
      },
      options.transport,
    );
    if (response.status !== 200) {
      if (provider === 'pinterest' && [401, 403, 404].includes(response.status))
        throw new UserError(
          'Pinterest public partner search is not authorized. Check token scopes and Pinterest app beta approval.',
        );
      throw new UserError(
        `${provider === 'klipy' ? 'KLIPY' : 'Pinterest'} search is unavailable (HTTP ${response.status}).`,
      );
    }
    if (!response.headers['content-type']?.includes('application/json')) throw new Error('Invalid type');
    data = object(JSON.parse(response.body.toString('utf8')));
  } catch (error) {
    // Raw transport errors may contain a KLIPY key in the URL. Never retain that error/cause.
    if (error instanceof UserError) throw error;
    throw new UserError(`${provider === 'klipy' ? 'KLIPY' : 'Pinterest'} search could not be completed.`);
  }
  const raw = provider === 'klipy' ? object(data.data).data : data.items;
  if (!Array.isArray(raw) || (provider === 'klipy' && data.result !== true))
    throw new UserError('The provider returned an unsupported media search response.');
  const results: ProviderMedia[] = [];
  for (const value of raw.slice(0, provider === 'klipy' ? 8 : 10)) {
    const item = object(value);
    if (provider === 'klipy') {
      if (item.is_ad || item.ad)
        throw new UserError('This KLIPY response requires an approved sponsored-content presentation.');
      const file = object(item.file);
      const gif = ['md', 'sm', 'hd', 'xs']
        .map((size) => object(object(file[size]).gif))
        .find((v) => typeof v.url === 'string');
      const slug = String(item.slug ?? '');
      if (!gif || !/^[A-Za-z0-9_-]{1,200}$/.test(slug))
        throw new UserError(
          'KLIPY returned an unsupported GIF result; the result set was not filtered or reordered.',
        );
      results.push({
        provider,
        title: text(item.title) || 'KLIPY GIF',
        url: providerMediaUrl(String(gif.url), provider),
        source: `https://klipy.com/gifs/${slug}`,
        mime: 'image/gif',
        size: Number(gif.size) || 0,
        width: Number(gif.width) || 0,
        height: Number(gif.height) || 0,
        artist: 'KLIPY',
        credit: 'Powered by KLIPY',
        license: 'Provider terms apply',
        delivery: 'link',
        slug,
        query,
        customerId,
      });
    } else {
      const id = String(item.id ?? ''),
        media = object(item.media);
      if (!/^\d{1,30}$/.test(id) || media.media_type !== 'image') continue;
      const candidates = Object.values(object(media.images))
        .map(object)
        .filter((v) => typeof v.url === 'string')
        .sort((a, b) => Number(b.width) * Number(b.height) - Number(a.width) * Number(a.height));
      const image = candidates.find(
        (v) => Number(v.width) > 0 && Number(v.height) > 0 && Number(v.width) * Number(v.height) <= 40000000,
      );
      if (!image) continue;
      let imageUrl: string;
      try {
        imageUrl = providerMediaUrl(String(image.url), provider);
      } catch {
        continue;
      }
      results.push({
        provider,
        title: text(item.title) || `Pinterest Pin ${id}`,
        url: imageUrl,
        source: `https://www.pinterest.com/pin/${id}/`,
        mime: 'image/unknown',
        size: 0,
        width: Number(image.width),
        height: Number(image.height),
        artist: 'See original Pin',
        credit: 'Pinterest',
        license: 'Original creator rights apply',
        delivery: 'link',
      });
      if (results.length === 5) break;
    }
  }
  return results;
}
/** Optional provider analytics runs only after a successful Discord share. No message content or raw Discord ID is supplied. */
export async function recordKlipyShare(
  result: ProviderMedia,
  options: MediaProviderOptions,
): Promise<boolean> {
  if (result.provider !== 'klipy') return true;
  try {
    const response = await (options.shareFetch ?? fetch)(
      `https://api.klipy.com/api/v1/${encodeURIComponent(options.klipyApiKey!)}/gifs/share/${encodeURIComponent(result.slug!)}`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: result.customerId, q: result.query }),
      },
    );
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
