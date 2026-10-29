import { UserError } from './errors.js';
let activeDownloads = 0;
export function discordAttachmentUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UserError('A Discord attachment URL is required.');
  }
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) ||
    !url.pathname.startsWith('/attachments/')
  )
    throw new UserError('Only HTTPS Discord attachment URLs are accepted.');
  return url;
}
export async function downloadAttachment(
  url: string,
  maxBytes: number,
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  const parsed = discordAttachmentUrl(url);
  if (activeDownloads >= 4) throw new UserError('Attachment downloads are busy. Try again shortly.');
  activeDownloads++;
  try {
    const response = await fetcher(parsed, { redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok || !response.body)
      throw new UserError(`Attachment download failed (${response.status}).`);
    const length = Number(response.headers.get('content-length'));
    if (length > maxBytes) {
      await response.body.cancel();
      throw new UserError('Attachment is too large.');
    }
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new UserError('Attachment is too large.');
        parts.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(parts, bytes);
  } finally {
    activeDownloads--;
  }
}
export function csv(rows: readonly Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const quote = (value: unknown) => {
    let text =
      value === null || value === undefined
        ? ''
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
    if (/^[\s]*[=+@\-\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [keys.map(quote).join(','), ...rows.map((row) => keys.map((key) => quote(row[key])).join(','))].join(
    '\r\n',
  );
}
