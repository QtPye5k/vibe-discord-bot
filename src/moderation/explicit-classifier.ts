import OpenAI from 'openai';
import type { ModerationMultiModalInput } from 'openai/resources/moderations';
import type { Message } from 'discord.js';
import sharp from 'sharp';
import { UserError } from '../core/errors.js';
import { matchContentRules, moderationContentText } from './rules.js';

export interface ExplicitClassification {
  remove: boolean;
  /** Sanitized deletion-policy categories; sexual/minors remains text-only. */
  categories: string[];
  scannedImages: number;
  unscannable?: string[];
}
export interface ExplicitClassifierOptions {
  apiKey: string;
  model?: string;
  maxAttachmentBytes?: number;
  timeoutMs?: number;
  client?: OpenAI;
  fetcher?: typeof fetch;
}
interface Candidate {
  url: string;
  label: string;
  size?: number;
}
const MAX_IMAGES = 10,
  MAX_PIXELS = 16000000,
  MAX_NORMALIZED_BYTES = 2 * 1024 * 1024;
const cancelled = () => new UserError('Explicit-content scanning was cancelled or timed out.');
const unavailable = () =>
  new UserError(
    'Explicit-content scanning is unavailable. Check the configured OpenAI key, model access and service status.',
  );
function bounded(value: number | undefined, fallback: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.floor(Number.isFinite(value) ? value! : fallback)));
}
/** Never fetch a sender-controlled origin; external previews must use Discord's media proxy. */
export function explicitImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UserError('Untrusted image URL.');
  }
  if (
    value.length > 4096 ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    ![
      'cdn.discordapp.com',
      'media.discordapp.net',
      'images-ext-1.discordapp.net',
      'images-ext-2.discordapp.net',
    ].includes(url.hostname) ||
    !(
      (['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) &&
        url.pathname.startsWith('/attachments/')) ||
      (url.hostname !== 'cdn.discordapp.com' && url.pathname.startsWith('/external/'))
    )
  )
    throw new UserError('Untrusted image URL.');
  return url;
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
        cleanup();
        reject(cancelled());
      },
      cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
function imageMagic(data: Buffer): boolean {
  return (
    data.length >= 12 &&
    (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      data.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
      /^GIF8[79]a$/.test(data.toString('ascii', 0, 6)) ||
      (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') ||
      (data.toString('ascii', 4, 8) === 'ftyp' &&
        /^(avif|avis|heic|heix|mif1|msf1)$/.test(data.toString('ascii', 8, 12))) ||
      data.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) ||
      data.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42])))
  );
}
function collect(message: Message): { images: Candidate[]; unscannable: string[] } {
  const images: Candidate[] = [],
    unscannable: string[] = [],
    seen = new Set<string>();
  const add = (candidate: Candidate) => {
    let url: URL;
    try {
      url = explicitImageUrl(candidate.url);
    } catch {
      unscannable.push(`${candidate.label}: untrusted image URL`);
      return;
    }
    // Discord embeds often repeat the exact attachment with different sizing/signature queries.
    const identity = url.pathname;
    if (seen.has(identity)) return;
    seen.add(identity);
    if (images.length >= MAX_IMAGES) {
      unscannable.push(`${candidate.label}: ten-image scan limit`);
      return;
    }
    images.push({ ...candidate, url: url.href });
  };
  let index = 0;
  for (const file of message.attachments.values()) {
    const label = `attachment ${++index}`,
      type = file.contentType?.toLowerCase() ?? '',
      name = file.name ?? '';
    if (type.startsWith('video/') || /\.(?:mp4|webm|mov|mkv)$/i.test(name)) {
      unscannable.push(`${label}: video is not scanned`);
      continue;
    }
    if (type.startsWith('image/') || /\.(?:png|jpe?g|webp|gif|avif|heic|tiff?|bmp|svg)$/i.test(name))
      add({ url: file.url, label, size: file.size });
  }
  for (const [index, embed] of message.embeds.entries()) {
    if (embed.video)
      unscannable.push(`embed ${index + 1}: only still previews are scanned; video is not scanned`);
    for (const [kind, asset] of [
      ['image', embed.image],
      ['thumbnail', embed.thumbnail],
    ] as const)
      if (asset) add({ url: asset.proxyURL ?? asset.url, label: `embed ${index + 1} ${kind}` });
  }
  return { images, unscannable };
}
async function download(
  candidate: Candidate,
  maxBytes: number,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<Buffer> {
  if (candidate.size !== undefined && candidate.size > maxBytes) throw new Error('image byte limit exceeded');
  signal.throwIfAborted();
  const response = await abortable(
    fetcher(explicitImageUrl(candidate.url), { redirect: 'error', signal }),
    signal,
  );
  if (
    !response.ok ||
    !response.body ||
    response.redirected ||
    (response.url && !explicitImageUrl(response.url))
  )
    throw new Error('image download unavailable');
  if (Number(response.headers.get('content-length')) > maxBytes) {
    void response.body.cancel().catch(() => {});
    throw new Error('image byte limit exceeded');
  }
  const reader = response.body.getReader(),
    pieces: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('image byte limit exceeded');
      pieces.push(value);
    }
    return Buffer.concat(pieces, bytes);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
async function normalize(bytes: Buffer, signal: AbortSignal, timeoutMs: number): Promise<Buffer> {
  if (!imageMagic(bytes)) throw new Error('unsupported or invalid image bytes');
  const image = sharp(bytes, {
    limitInputPixels: MAX_PIXELS,
    sequentialRead: true,
    failOn: 'warning',
    animated: false,
  });
  const abort = () => image.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const metadata = await abortable(image.metadata(), signal);
    if ((metadata.pages ?? 1) > 1) throw new Error('animated or multi-page images are not scanned');
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS)
      throw new Error('image pixel limit exceeded');
    const output = await abortable(
      image
        .rotate()
        .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 82 })
        .timeout({ seconds: Math.max(1, Math.ceil(timeoutMs / 1000)) })
        .toBuffer(),
      signal,
    );
    if (output.length > MAX_NORMALIZED_BYTES) {
      output.fill(0);
      throw new Error('normalized image byte limit exceeded');
    }
    return output;
  } finally {
    signal.removeEventListener('abort', abort);
    image.destroy();
  }
}

/** Classifies unknown text/still images. This is not a CSAM detector or a full video/animation scan. */
export function createExplicitClassifier(options: ExplicitClassifierOptions) {
  const timeoutMs = bounded(options.timeoutMs, 12000, 100, 12000),
    maxBytes = bounded(options.maxAttachmentBytes, 8 * 1024 * 1024, 1024, 20 * 1024 * 1024),
    client =
      options.client ??
      (options.apiKey.trim()
        ? new OpenAI({ apiKey: options.apiKey, maxRetries: 0, timeout: timeoutMs })
        : undefined),
    model = options.model?.trim() || 'omni-moderation-latest',
    fetcher = options.fetcher ?? fetch,
    active = new Set<AbortController>();
  let closed = false;
  return {
    async classify(message: Message, signal?: AbortSignal): Promise<ExplicitClassification> {
      if (closed) throw new UserError('Explicit-content scanning is closed.');
      if (signal?.aborted) throw cancelled();
      const rule = matchContentRules(message);
      if (rule.remove) return { ...rule, scannedImages: 0 };
      if (!client) throw unavailable();
      const controller = new AbortController(),
        timer = setTimeout(() => controller.abort(), timeoutMs),
        combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      active.add(controller);
      try {
        if (combined.aborted) throw cancelled();
        const { images, unscannable } = collect(message),
          extracted = moderationContentText(message),
          text = extracted.text.trim();
        if (extracted.truncated)
          unscannable.push('message or embed text beyond the bounded scan is not scanned');
        let scannedImages = 0,
          totalBytes = 0,
          textScanned = false;
        const verdict = (categories: string[]): ExplicitClassification => ({
          remove: categories.length > 0,
          categories,
          scannedImages,
          ...(unscannable.length ? { unscannable } : {}),
        });
        const evaluate = async (input: ModerationMultiModalInput[], hasText: boolean): Promise<string[]> => {
          const result = await abortable(
            client.moderations.create(
              { model, input },
              { signal: combined, timeout: timeoutMs, maxRetries: 0 },
            ),
            combined,
          );
          if (combined.aborted) throw cancelled();
          if (
            !result.results?.length ||
            result.results.some(
              (row) =>
                typeof row.categories?.sexual !== 'boolean' ||
                typeof row.categories?.['sexual/minors'] !== 'boolean',
            )
          )
            throw unavailable();
          return ['sexual', 'sexual/minors', 'hate', 'hate/threatening', 'harassment/threatening'].filter(
            (category) =>
              (category === 'sexual' || hasText) &&
              result.results.some((row) => row.categories[category as keyof typeof row.categories] === true),
          );
        };
        for (const candidate of images) {
          let bytes: Buffer | undefined, normalized: Buffer | undefined;
          let image: ModerationMultiModalInput | undefined;
          try {
            bytes = await download(
              candidate,
              Math.min(maxBytes, 32 * 1024 * 1024 - totalBytes),
              fetcher,
              combined,
            );
            totalBytes += bytes.length;
            normalized = await normalize(bytes, combined, timeoutMs);
            image = {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${normalized.toString('base64')}` },
            };
          } catch (error) {
            if (combined.aborted) throw cancelled();
            const reason =
              error instanceof Error &&
              /^(?:image byte limit exceeded|image pixel limit exceeded|unsupported or invalid image bytes|animated or multi-page images are not scanned|normalized image byte limit exceeded)$/.test(
                error.message,
              )
                ? error.message
                : 'image download or decoding unavailable';
            unscannable.push(`${candidate.label}: ${reason}`);
          } finally {
            bytes?.fill(0);
            normalized?.fill(0);
          }
          if (!image) continue;
          // The live moderation transport accepts one image per request. Keep every request sequential
          // and under the same overall deadline; do not repeat text-only policy decisions on later images.
          const hasText: boolean = !!text && !textScanned;
          const categories = await evaluate(hasText ? [{ type: 'text', text }, image] : [image], hasText);
          scannedImages++;
          textScanned ||= hasText;
          if (categories.length) return verdict(categories);
        }
        if (text && !textScanned) return verdict(await evaluate([{ type: 'text', text }], true));
        return verdict([]);
      } catch {
        if (combined.aborted) throw cancelled();
        throw unavailable();
      } finally {
        clearTimeout(timer);
        active.delete(controller);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const controller of active) controller.abort();
      active.clear();
    },
  };
}
