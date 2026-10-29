import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { UserError } from '../core/errors.js';
import { isPublicAddress, publicUrl, type PublicResponse } from '../features/integrations.js';

export interface ProviderRequest {
  provider: string;
  url: URL;
  address: string;
  family: number;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers: Record<string, string>;
  body?: Buffer;
  maxBytes: number;
  timeoutMs: number;
}
export interface ProviderTransport {
  resolve(host: string): Promise<{ address: string; family: number }[]>;
  connect(options: ProviderRequest): Promise<PublicResponse>;
}
export interface ProviderInput {
  method?: ProviderRequest['method'];
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  body?: Buffer;
  contentType?: string;
  maxBytes?: number;
}
export async function connectProviderPinned(options: ProviderRequest): Promise<PublicResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new UserError(
          `${options.provider} request failed or timed out. Verify the remote outcome before retrying a write.`,
        ),
      );
    };
    const req = request(
      options.url,
      {
        method: options.method,
        agent: false,
        family: options.family,
        servername: options.url.hostname,
        lookup: (_host, _opts, callback) => callback(null, options.address, options.family),
        headers: options.headers,
      },
      (response) => {
        if (Number(response.headers['content-length'] ?? 0) > options.maxBytes) {
          response.destroy();
          req.destroy();
          fail();
          return;
        }
        const parts: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > options.maxBytes) {
            response.destroy();
            req.destroy();
            fail();
          } else parts.push(chunk);
        });
        response.once('error', fail);
        response.once('aborted', fail);
        response.once('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(parts, bytes),
            headers: Object.fromEntries(
              Object.entries(response.headers).map(([name, value]) => [
                name,
                Array.isArray(value) ? value.join(',') : value,
              ]),
            ),
          });
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      fail();
    }, options.timeoutMs);
    timer.unref();
    req.once('error', fail);
    req.end(options.body);
  });
}
const defaultTransport: ProviderTransport = {
  resolve: async (host) => {
    const resolver = new Resolver({ timeout: 2500, tries: 1 });
    const timer = setTimeout(() => resolver.cancel(), 5000);
    timer.unref();
    try {
      const results = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
      return results.flatMap((result, index) =>
        result.status === 'fulfilled'
          ? result.value.map((address) => ({ address, family: index ? 6 : 4 }))
          : [],
      );
    } finally {
      clearTimeout(timer);
    }
  },
  connect: connectProviderPinned,
};
let active = 0;
const providerActive = new Map<string, number>();
/** Binds authorization to an operator-chosen exact origin. Caller input can never override the destination. */
export function providerHttp(
  provider: string,
  origin: string,
  transport: ProviderTransport = defaultTransport,
) {
  const base = publicUrl(origin);
  if (base.pathname !== '/' || base.search)
    throw new UserError(`${provider} origin must have no path or query.`);
  return async (
    path: string,
    input: ProviderInput = {},
    beforeSend?: () => Promise<void>,
  ): Promise<PublicResponse> => {
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      path.includes('\\') ||
      path.includes('#') ||
      path.includes('?')
    )
      throw new UserError('Invalid fixed provider route.');
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw new UserError('Provider origin changed.');
    for (const [key, value] of Object.entries(input.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const headers = { 'User-Agent': 'Discord-Unified-Bot/2.0', Accept: 'application/json', ...input.headers };
    for (const [name, value] of Object.entries(headers))
      if (/[\r\n]/.test(name + value)) throw new UserError('Invalid provider authorization/configuration.');
    let body = input.body;
    if (input.json !== undefined) {
      if (body || input.form) throw new UserError('Choose one provider body encoding.');
      body = Buffer.from(JSON.stringify(input.json));
      Object.assign(headers, { 'Content-Type': 'application/json' });
    }
    if (input.form) {
      if (body) throw new UserError('Choose one provider body encoding.');
      body = Buffer.from(new URLSearchParams(input.form).toString());
      Object.assign(headers, { 'Content-Type': 'application/x-www-form-urlencoded' });
    }
    if (body && body.length > 8 * 1048576) throw new UserError('Provider request exceeds 8 MiB.');
    if (input.contentType) Object.assign(headers, { 'Content-Type': input.contentType });
    if (body) Object.assign(headers, { 'Content-Length': String(body.length) });
    const count = providerActive.get(provider) ?? 0;
    if (active >= 4 || count >= 2) throw new UserError('External services are busy. Retry later.');
    active++;
    providerActive.set(provider, count + 1);
    const started = Date.now();
    try {
      const host = url.hostname.replace(/^\[|\]$/g, ''),
        literal = isIP(host),
        addresses = literal ? [{ address: host, family: literal }] : await transport.resolve(host);
      if (!addresses.length || addresses.some((value) => !isPublicAddress(value.address)))
        throw new UserError('Provider hostname resolves to a private or unsupported network.');
      await beforeSend?.();
      const remaining = 15000 - (Date.now() - started);
      if (remaining <= 0) throw new UserError('Provider request deadline exceeded.');
      const pin = addresses.find((value) => value.family === 4) ?? addresses[0]!,
        maxBytes = Math.max(1, Math.min(8 * 1048576, input.maxBytes ?? 2 * 1048576));
      const response = await transport.connect({
        provider,
        url,
        address: pin.address,
        family: pin.family,
        method: input.method ?? 'GET',
        headers,
        body,
        maxBytes,
        timeoutMs: remaining,
      });
      if (response.body.length > maxBytes) throw new UserError('Provider response exceeds its size limit.');
      if (response.status >= 300 && response.status < 400)
        throw new UserError('Provider redirect refused; credentials were not forwarded.');
      return response;
    } catch (error) {
      if (error instanceof UserError) throw error;
      throw new UserError(
        `${provider} request failed. Check authorization, connectivity and remote state before retrying.`,
      );
    } finally {
      active--;
      const left = (providerActive.get(provider) ?? 1) - 1;
      if (left) providerActive.set(provider, left);
      else providerActive.delete(provider);
    }
  };
}
export function providerJson(response: PublicResponse, provider: string): unknown {
  if (response.status < 200 || response.status >= 300)
    throw new UserError(
      `${provider} returned HTTP ${response.status}. Check the service configuration, permissions and quota. No write retry was attempted.`,
    );
  if (response.status === 204 || !response.body.length) return { ok: true };
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
  } catch {
    throw new UserError(`${provider} returned invalid JSON.`);
  }
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 50000 || depth > 40)
      throw new UserError(`${provider} returned an overly complex response.`);
    if (item && typeof item === 'object') for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(value, 0);
  return value;
}
export function safeProviderValue(value: unknown, secrets: readonly string[]): unknown {
  const visit = (item: unknown): unknown => {
    if (Buffer.isBuffer(item)) return item;
    if (typeof item === 'string') {
      let text = item;
      for (const secret of secrets) if (secret.length >= 8) text = text.split(secret).join('[REDACTED]');
      return text;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .filter(
            ([name]) =>
              !/^(?:access_token|refresh_token|authorization|api[_-]?key|client_secret|password|secret)$/i.test(
                name,
              ),
          )
          .map(([name, child]) => [name, visit(child)]),
      );
    return item;
  };
  return visit(value);
}
