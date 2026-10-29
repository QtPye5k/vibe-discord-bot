import type { IncomingMessage, ServerResponse } from 'node:http';
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function readBody(request: IncomingMessage, limit = 65536, timeoutMs = 5000): Promise<Buffer> {
  const length = request.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > limit))
    return Promise.reject(new HttpError(413, 'Request body is too large.'));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0,
      finished = false;
    const cleanup = () => {
      clearTimeout(timer);
      request.off('data', data);
      request.off('end', end);
      request.off('error', fail);
      request.off('aborted', aborted);
    };
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      cleanup();
      request.pause();
      reject(error);
    };
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) fail(new HttpError(413, 'Request body is too large.'));
      else chunks.push(chunk);
    };
    const end = () => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const aborted = () => fail(new HttpError(400, 'Request interrupted.'));
    const timer = setTimeout(() => fail(new HttpError(408, 'Request body deadline exceeded.')), timeoutMs);
    timer.unref();
    request.on('data', data);
    request.once('end', end);
    request.once('error', fail);
    request.once('aborted', aborted);
  });
}
export function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? String(item) : item));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(text);
}
export function publicOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
  )
    throw new Error('Use an HTTPS origin, or loopback HTTP for local development.');
  return url;
}
