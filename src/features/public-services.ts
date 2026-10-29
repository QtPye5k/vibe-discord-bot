import { Resolver } from 'node:dns/promises';
import { createConnection, isIP, type Socket } from 'node:net';
import { TextDecoder } from 'node:util';
import { PermissionFlagsBits as P } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import { freshContext } from '../core/permissions.js';
import { UserError } from '../core/errors.js';
import {
  connectPinned,
  fetchPublic,
  isPublicAddress,
  publicUrl,
  type PublicTransport,
} from './integrations.js';

export const PUBLIC_SERVICE_LIMITS = Object.freeze({
  cacheEntries: 100,
  fxCacheMs: 60 * 60000,
  minecraftCacheMs: 30000,
  jsonBytes: 262144,
  graphqlResponseNodes: 10000,
  graphqlResponseDepth: 32,
  minecraftBytes: 65536,
  minecraftConnections: 2,
  minecraftTimeoutMs: 5000,
  minecraftPort: 25565,
});
const currencyCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/)
  .transform((value) => value.toUpperCase());
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const time = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
  }, 'Use a valid calendar date');
const currencySchema = z.strictObject({
  base: currencyCode,
  quote: currencyCode,
  amount: z.number().min(0).max(1e12).default(1),
  date: date.optional(),
});
const jsonVariables = z
  .record(z.string().max(100), z.unknown())
  .default({})
  .superRefine((value, ctx) => {
    try {
      validateVariables(value);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message:
          'Variables must be finite JSON, at most 1,000 nodes, ten nested levels and 2,000 serialized characters.',
      });
    }
  });
interface GraphqlRequest {
  url: string;
  query: string;
  variables: Record<string, unknown>;
  operationName?: string | undefined;
}
/** A bounded operation-envelope parser, not schema or field-level validation. */
function validateGraphqlQuery(source: string, operationName?: string): void {
  const tokens: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    const tail = source.slice(offset),
      char = source[offset]!;
    if (/[\s,\uFEFF]/u.test(char)) {
      offset++;
      continue;
    }
    if (char === '#') {
      const end = /[\r\n]/.exec(tail);
      offset = end ? offset + end.index + 1 : source.length;
      continue;
    }
    if (tail.startsWith('"""'))
      throw new UserError('GraphQL block strings are not supported; use JSON-style quoted strings.');
    if (char === '"') {
      const match = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(tail);
      if (!match) throw new UserError('Invalid GraphQL quoted string.');
      tokens.push('"string"');
      offset += match[0].length;
      continue;
    }
    const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(tail);
    if (name) {
      tokens.push(name[0]);
      offset += name[0].length;
      continue;
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(tail);
    if (number) {
      tokens.push('0');
      offset += number[0].length;
      continue;
    }
    if (tail.startsWith('...')) {
      tokens.push('...');
      offset += 3;
      continue;
    }
    if ('!$():=@[]{|}&'.includes(char)) {
      tokens.push(char);
      offset++;
      continue;
    }
    throw new UserError('Unsupported GraphQL document token.');
  }
  let cursor = 0,
    queries = 0,
    queryName: string | undefined;
  const name = () => {
    const value = tokens[cursor];
    if (!value || !/^[_A-Za-z][_0-9A-Za-z]*$/.test(value)) throw new UserError('Expected a GraphQL name.');
    cursor++;
    return value;
  };
  const group = (open: string, depth = 0): void => {
    if (depth >= 32 || tokens[cursor++] !== open)
      throw new UserError('Invalid or deeply nested GraphQL document.');
    const close = ({ '{': '}', '(': ')', '[': ']' } as Record<string, string>)[open]!;
    let count = 0;
    while (tokens[cursor] !== close) {
      const token = tokens[cursor];
      if (!token || '})]'.includes(token)) throw new UserError('Unbalanced GraphQL document.');
      if (['{', '(', '['].includes(token)) group(token, depth + 1);
      else cursor++;
      count++;
    }
    if (!count && depth === 0 && open === '{')
      throw new UserError('A GraphQL selection set cannot be empty.');
    cursor++;
  };
  const directives = () => {
    while (tokens[cursor] === '@') {
      cursor++;
      name();
      if (tokens[cursor] === '(') group('(');
    }
  };
  const fragments = new Set<string>();
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (token === '{') {
      if (++queries > 1) throw new UserError('Use exactly one GraphQL query operation.');
      group('{');
    } else if (token === 'query') {
      if (++queries > 1) throw new UserError('Use exactly one GraphQL query operation.');
      cursor++;
      if (tokens[cursor] && /^[_A-Za-z]/.test(tokens[cursor]!)) queryName = name();
      if (tokens[cursor] === '(') group('(');
      directives();
      group('{');
    } else if (token === 'fragment') {
      cursor++;
      const fragmentName = name();
      if (fragmentName === 'on' || fragments.has(fragmentName))
        throw new UserError('Invalid or duplicate GraphQL fragment name.');
      fragments.add(fragmentName);
      if (name() !== 'on') throw new UserError('Expected a GraphQL fragment type condition.');
      name();
      directives();
      group('{');
    } else
      throw new UserError(
        'Only one GraphQL query operation and optional fragments are supported; mutations and subscriptions are disabled.',
      );
  }
  if (queries !== 1 || (operationName !== undefined && operationName !== queryName))
    throw new UserError('Use exactly one query and its matching operationName, when supplied.');
}
function validateVariables(value: unknown): void {
  const stack = [{ value, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++count > 1000 || current.depth > 10) throw new UserError('GraphQL variable limits exceeded.');
    const node = current.value;
    if (node === null || typeof node === 'string' || typeof node === 'boolean') continue;
    if (typeof node === 'number' && Number.isFinite(node)) continue;
    if (
      !node ||
      typeof node !== 'object' ||
      (!Array.isArray(node) &&
        Object.getPrototypeOf(node) !== Object.prototype &&
        Object.getPrototypeOf(node) !== null)
    )
      throw new UserError('GraphQL variables must contain only JSON values.');
    for (const child of Object.values(node)) stack.push({ value: child, depth: current.depth + 1 });
  }
  if (JSON.stringify(value).length > 2000)
    throw new UserError('GraphQL variables exceed 2,000 serialized characters.');
}
function validateGraphqlResponseBounds(value: unknown): void {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (
      ++nodes > PUBLIC_SERVICE_LIMITS.graphqlResponseNodes ||
      current.depth > PUBLIC_SERVICE_LIMITS.graphqlResponseDepth
    )
      throw new UserError('GraphQL response exceeds its JSON node/depth limit.');
    if (current.value && typeof current.value === 'object')
      for (const child of Object.values(current.value))
        stack.push({ value: child, depth: current.depth + 1 });
  }
}
function graphqlUrl(input: GraphqlRequest): URL {
  validateGraphqlQuery(input.query, input.operationName);
  const url = publicUrl(input.url);
  for (const key of ['query', 'variables', 'operationName'])
    if (url.searchParams.has(key))
      throw new UserError('GraphQL endpoint URL must not predefine query, variables or operationName.');
  url.searchParams.set('query', input.query);
  url.searchParams.set('variables', JSON.stringify(input.variables));
  if (input.operationName) url.searchParams.set('operationName', input.operationName);
  if (url.href.length > 4096)
    throw new UserError('Encoded GraphQL GET URL exceeds 4,096 characters. Shorten the query or variables.');
  return url;
}
const graphqlSchema = z
  .strictObject({
    url: z.string().max(2048),
    query: z.string().trim().min(1).max(2000),
    variables: jsonVariables,
    operationName: z
      .string()
      .regex(/^[_A-Za-z][_0-9A-Za-z]*$/)
      .max(100)
      .optional(),
  })
  .superRefine((value, ctx) => {
    try {
      graphqlUrl(value);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof UserError ? error.message : 'Invalid public GraphQL GET request.',
      });
    }
  });
export function buildGraphqlGet(input: z.input<typeof graphqlSchema>): URL {
  return graphqlUrl(graphqlSchema.parse(input));
}
const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
  .refine((value) =>
    value.split('.').every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)),
  )
  .refine((value) => {
    try {
      return publicUrl(`https://${value}/`).hostname === value;
    } catch {
      return false;
    }
  }, 'Use an exact public DNS hostname or IPv4 address without port/path');
interface Address {
  address: string;
  family: number;
}
export interface MinecraftRequest {
  hostname: string;
  address: string;
  family: number;
  handshake: Buffer;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
}
export interface MinecraftTransport {
  resolve(hostname: string, signal?: AbortSignal): Promise<Address[]>;
  connect(options: MinecraftRequest): Promise<Buffer>;
}
export interface PublicServiceOptions {
  http?: PublicTransport;
  minecraft?: MinecraftTransport;
  now?: () => number;
}
async function resolvePublic(host: string, signal?: AbortSignal): Promise<Address[]> {
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  const resolver = new Resolver({ timeout: 2500, tries: 1 }),
    timer = setTimeout(() => resolver.cancel(), 5000);
  const abort = () => resolver.cancel();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    return [
      ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 })) : []),
      ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 })) : []),
    ];
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
export function encodeMinecraftVarInt(value: number): Buffer {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)
    throw new UserError('Invalid Minecraft VarInt.');
  let number = value >>> 0;
  const output: number[] = [];
  do {
    let byte = number & 0x7f;
    number >>>= 7;
    if (number) byte |= 0x80;
    output.push(byte);
  } while (number);
  return Buffer.from(output);
}
function varInt(input: Buffer, offset = 0): { value: number; offset: number } | null {
  let value = 0;
  for (let index = 0; index < 5; index++) {
    const byte = input[offset + index];
    if (byte === undefined) return null;
    if (index === 4 && byte & 0xf0) throw new UserError('Invalid Minecraft packet VarInt.');
    value |= (byte & 0x7f) << (7 * index);
    if (!(byte & 0x80)) return { value, offset: offset + index + 1 };
  }
  throw new UserError('Minecraft packet VarInt exceeds five bytes.');
}
export function minecraftHandshake(rawHost: string): Buffer {
  const host = hostname.parse(rawHost),
    name = Buffer.from(host),
    port = Buffer.alloc(2);
  port.writeUInt16BE(PUBLIC_SERVICE_LIMITS.minecraftPort);
  const payload = Buffer.concat([
    Buffer.from([0]),
    encodeMinecraftVarInt(-1),
    encodeMinecraftVarInt(name.length),
    name,
    port,
    Buffer.from([1]),
  ]);
  return Buffer.concat([encodeMinecraftVarInt(payload.length), payload, Buffer.from([1, 0])]);
}
function packetLength(data: Buffer): number | null {
  const length = varInt(data);
  if (!length) return null;
  if (length.value < 1 || length.value > PUBLIC_SERVICE_LIMITS.minecraftBytes)
    throw new UserError('Minecraft status packet exceeds the 64 KiB bound.');
  return length.offset + length.value;
}
export async function connectMinecraft(
  options: MinecraftRequest,
  openSocket: (options: { host: string; family: number; port: number }) => Socket = createConnection,
): Promise<Buffer> {
  // Socket injection exists for local protocol tests; action input never controls a port or socket factory.
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = openSocket({
      host: options.address,
      family: options.family,
      port: PUBLIC_SERVICE_LIMITS.minecraftPort,
    });
    let settled = false,
      bytes = 0,
      chunks = 0,
      headerBytes = 0,
      expected: number | null = null;
    const header = Buffer.alloc(5),
      parts: Buffer[] = [];
    const finish = (error?: Error, result?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(
      () => finish(new UserError('Public Minecraft status request timed out.')),
      options.timeoutMs,
    );
    const abort = () => finish(new UserError('Public Minecraft status request timed out.'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    socket.once('connect', () => socket.write(options.handshake));
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (++chunks > 512 || bytes > options.maxBytes + 5) {
        finish(new UserError('Minecraft status response exceeds its size/chunk limit.'));
        return;
      }
      parts.push(chunk);
      const copied = Math.min(5 - headerBytes, chunk.length);
      if (copied > 0) {
        chunk.copy(header, headerBytes, 0, copied);
        headerBytes += copied;
      }
      try {
        expected ??= packetLength(header.subarray(0, headerBytes));
        if (expected !== null && bytes >= expected) {
          if (bytes !== expected) throw new UserError('Unexpected extra Minecraft status packet bytes.');
          finish(undefined, Buffer.concat(parts, bytes));
        }
      } catch (error) {
        finish(error instanceof Error ? error : new UserError('Malformed Minecraft status response.'));
      }
    });
    socket.once('error', () =>
      finish(new UserError('Public Minecraft status connection failed or was refused.')),
    );
    socket.once('end', () =>
      finish(new UserError('Minecraft server closed without a complete status response.')),
    );
    socket.once('close', () => {
      if (!settled) finish(new UserError('Minecraft server closed without a complete status response.'));
    });
  });
}
function motdText(input: unknown): string {
  const parts: string[] = [],
    stack = [{ value: input, depth: 0 }];
  let nodes = 0;
  while (stack.length && ++nodes <= 128) {
    const item = stack.pop()!;
    if (item.depth > 8) continue;
    if (typeof item.value === 'string') parts.push(item.value);
    else if (Array.isArray(item.value))
      for (const child of [...item.value].reverse()) stack.push({ value: child, depth: item.depth + 1 });
    else if (item.value && typeof item.value === 'object') {
      const value = item.value as Record<string, unknown>;
      if (Array.isArray(value.extra))
        for (const extra of [...value.extra].reverse()) stack.push({ value: extra, depth: item.depth + 1 });
      if (typeof value.text === 'string') parts.push(value.text);
    }
  }
  return parts
    .join('')
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f@`]/g, '')
    .slice(0, 500);
}
export function decodeMinecraftStatus(input: Uint8Array): {
  version: string;
  protocol: number;
  players: { online: number; max: number };
  motd: string;
} {
  const buffer = Buffer.from(input);
  if (buffer.length > PUBLIC_SERVICE_LIMITS.minecraftBytes + 5)
    throw new UserError('Minecraft status response is too large.');
  const length = varInt(buffer);
  if (
    !length ||
    length.value < 1 ||
    length.value > PUBLIC_SERVICE_LIMITS.minecraftBytes ||
    length.offset + length.value !== buffer.length
  )
    throw new UserError('Incomplete or invalid Minecraft status packet length.');
  const packet = varInt(buffer, length.offset);
  if (!packet || packet.value !== 0) throw new UserError('Expected Minecraft status response packet zero.');
  const text = varInt(buffer, packet.offset);
  if (!text || text.value < 1 || text.offset + text.value !== buffer.length)
    throw new UserError('Invalid Minecraft status JSON length.');
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(text.offset)));
  } catch {
    throw new UserError('Invalid Minecraft status JSON.');
  }
  const schema = z.object({
    version: z.object({ name: z.string().max(1000), protocol: z.number().int().min(0).max(2147483647) }),
    players: z.object({
      online: z.number().int().min(0).max(2147483647),
      max: z.number().int().min(0).max(2147483647),
    }),
    description: z.unknown().optional(),
  });
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new UserError('The server did not return a supported Java Minecraft status response.');
  return {
    version: motdText(parsed.data.version.name).slice(0, 100),
    protocol: parsed.data.version.protocol,
    players: parsed.data.players,
    motd: motdText(parsed.data.description),
  };
}
let minecraftActive = 0;
export class PublicService {
  private readonly cache = new Map<string, { expires: number; value: unknown }>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  constructor(private readonly options: PublicServiceOptions = {}) {
    this.now = options.now ?? Date.now;
  }
  private async cached<T>(key: string, duration: number, run: () => Promise<T>): Promise<T> {
    const current = this.cache.get(key);
    if (current && current.expires > this.now()) return structuredClone(current.value) as T;
    const pending = this.pending.get(key);
    if (pending) return structuredClone(await pending) as T;
    if (this.pending.size >= 4) throw new UserError('Public service requests are busy.');
    const work = run();
    this.pending.set(key, work);
    try {
      const value = await work;
      for (const [key, entry] of this.cache) if (entry.expires <= this.now()) this.cache.delete(key);
      if (this.cache.size >= PUBLIC_SERVICE_LIMITS.cacheEntries)
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { value: structuredClone(value), expires: this.now() + duration });
      return value;
    } finally {
      this.pending.delete(key);
    }
  }
  async currency(raw: z.input<typeof currencySchema>): Promise<unknown> {
    const input = currencySchema.parse(raw);
    const rate =
      input.base === input.quote
        ? { date: input.date ?? null, base: input.base, quote: input.quote, rate: 1 }
        : await this.cached(
            `currency:${input.base}:${input.quote}:${input.date ?? 'latest'}`,
            PUBLIC_SERVICE_LIMITS.fxCacheMs,
            async () => {
              const url = new URL(
                `https://api.frankfurter.dev/v2/rate/${input.base.toLowerCase()}/${input.quote.toLowerCase()}`,
              );
              if (input.date) url.searchParams.set('date', input.date);
              const response = await fetchPublic(
                url.href,
                {
                  allowedHosts: ['api.frankfurter.dev'],
                  maxBytes: 32768,
                  headers: { Accept: 'application/json' },
                },
                this.options.http,
              );
              const value = parseJson(
                response.status,
                response.headers['content-type'],
                response.body,
                'Frankfurter',
              );
              const result = z
                .object({ date, base: z.string(), quote: z.string(), rate: z.number().positive().max(1e12) })
                .safeParse(value);
              if (
                !result.success ||
                result.data.base.toUpperCase() !== input.base ||
                result.data.quote.toUpperCase() !== input.quote
              )
                throw new UserError('Frankfurter returned an invalid currency pair/rate.');
              return result.data;
            },
          );
    return {
      source:
        input.base === input.quote
          ? 'Identical-currency conversion'
          : 'Frankfurter v2 blended reference rate',
      ...rate,
      requestedDate: input.date ?? 'latest',
      amount: input.amount,
      convertedEstimate: input.amount * rate.rate,
      notice:
        'Dated reference-rate estimate using JavaScript number arithmetic. These are not live intraday quotes, settlement guarantees or an accounting ledger.',
    };
  }
  private async graphqlAuthority(ctx: ActionContext, url: URL): Promise<void> {
    const fresh = await freshContext(ctx);
    if (!fresh.member.permissions.has(P.ManageGuild))
      throw new UserError('Current Manage Server permission is required for a public GraphQL request.');
    publicUrl(url.href, fresh.store.get<string[]>('integration.hosts', fresh.guild.id) ?? []);
    if ((fresh.store.get<string[]>('core.disabled', fresh.guild.id) ?? []).includes('integrations'))
      throw new UserError('Integrations are disabled in this server.');
  }
  private minecraftAuthority(ctx: ActionContext, host: string): void {
    if ((ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? []).includes('integrations'))
      throw new UserError('Integrations are disabled in this server.');
    if (!(ctx.store.get<string[]>('integration.hosts', ctx.guild.id) ?? []).includes(host))
      throw new UserError(
        'Confirm this exact public hostname with integration.hosts before querying Minecraft status.',
      );
  }
  async graphql(ctx: ActionContext, raw: z.input<typeof graphqlSchema>): Promise<unknown> {
    const input = graphqlSchema.parse(raw),
      url = graphqlUrl(input);
    await this.graphqlAuthority(ctx, url);
    const transport = this.options.http ?? { resolve: resolvePublic, connect: connectPinned };
    const response = await fetchPublic(
      url.href,
      {
        allowedHosts: ctx.store.get<string[]>('integration.hosts', ctx.guild.id) ?? [],
        maxBytes: PUBLIC_SERVICE_LIMITS.jsonBytes,
        headers: { Accept: 'application/graphql-response+json, application/json' },
      },
      {
        resolve: transport.resolve,
        connect: async (options) => {
          await this.graphqlAuthority(ctx, url);
          return transport.connect(options);
        },
      },
    );
    const value = parseJson(
      response.status,
      response.headers['content-type'],
      response.body,
      'GraphQL',
      true,
    );
    validateGraphqlResponseBounds(value);
    const envelope = z
      .object({
        data: z.record(z.string(), z.unknown()).nullable().optional(),
        errors: z
          .array(z.object({ message: z.string().min(1).max(5000) }).passthrough())
          .min(1)
          .max(100)
          .optional(),
        extensions: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough()
      .safeParse(value);
    if (
      !envelope.success ||
      (!('data' in envelope.data) && !envelope.data.errors) ||
      (response.status >= 400 && !envelope.data.errors)
    )
      throw new UserError('Endpoint returned an invalid GraphQL data/errors response.');
    await this.graphqlAuthority(ctx, url);
    return {
      endpoint: input.url,
      status: response.status,
      ok: response.status < 400 && !envelope.data.errors,
      response: envelope.data,
      notice:
        'Exact confirmed single-query GraphQL GET payload. Envelope parsing does not validate the remote schema or guarantee side-effect-free resolvers. No authentication, POST, subscriptions or automatic retries.',
    };
  }
  async minecraft(ctx: ActionContext, rawHost: string): Promise<unknown> {
    const host = hostname.parse(rawHost);
    this.minecraftAuthority(ctx, host);
    return this.cached(`minecraft:${host}`, PUBLIC_SERVICE_LIMITS.minecraftCacheMs, async () => {
      if (minecraftActive >= PUBLIC_SERVICE_LIMITS.minecraftConnections)
        throw new UserError('Public Minecraft status connections are busy.');
      minecraftActive++;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          (async () => {
            const driver = this.options.minecraft ?? { resolve: resolvePublic, connect: connectMinecraft },
              start = performance.now(),
              addresses = isIP(host)
                ? [{ address: host, family: isIP(host) }]
                : await driver.resolve(host, controller.signal);
            controller.signal.throwIfAborted();
            if (
              !addresses.length ||
              addresses.some(
                (value) =>
                  !isPublicAddress(value.address) ||
                  ![4, 6].includes(value.family) ||
                  isIP(value.address) !== value.family,
              )
            )
              throw new UserError('Minecraft hostname resolves to a private or unsupported network.');
            this.minecraftAuthority(ctx, host);
            const address = addresses.find((value) => value.family === 4) ?? addresses[0]!;
            const data = await driver.connect({
              hostname: host,
              address: address.address,
              family: address.family,
              handshake: minecraftHandshake(host),
              timeoutMs: Math.max(1, PUBLIC_SERVICE_LIMITS.minecraftTimeoutMs - (performance.now() - start)),
              maxBytes: PUBLIC_SERVICE_LIMITS.minecraftBytes,
              signal: controller.signal,
            });
            controller.signal.throwIfAborted();
            this.minecraftAuthority(ctx, host);
            return {
              source: 'Direct Minecraft Java status handshake',
              host,
              port: PUBLIC_SERVICE_LIMITS.minecraftPort,
              online: true,
              ...decodeMinecraftStatus(data),
              responseMs: Math.round(performance.now() - start),
              notice:
                'A status reply from this bot’s network vantage point; no login, world health, player identities, SRV/custom-port lookup or Bedrock/RCON administration.',
            };
          })(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new UserError('Public Minecraft status request timed out.'));
              controller.abort();
            }, PUBLIC_SERVICE_LIMITS.minecraftTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        minecraftActive--;
      }
    });
  }
}
function parseJson(
  status: number,
  type: string | undefined,
  body: Buffer,
  provider: string,
  allowErrors = false,
): unknown {
  if (
    status < 200 ||
    status >= (allowErrors ? 500 : 300) ||
    !type
      ?.split(';')[0]
      ?.trim()
      .toLowerCase()
      .match(/^application\/(?:json|graphql-response\+json)$/)
  )
    throw new UserError(`${provider} returned an unsupported HTTP status or JSON media type (${status}).`);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new UserError(`${provider} returned invalid JSON.`);
  }
}
export function registerPublicServiceActions(
  registry: ActionRegistry,
  options: PublicServiceOptions = {},
): void {
  const service = new PublicService(options),
    base = { category: 'integrations', risk: 'read' as const, userPermissions: [], botPermissions: [] };
  registry.register({
    ...base,
    id: 'integration.currency',
    description:
      'Get a dated Frankfurter currency reference rate and bounded amount conversion estimate (not an intraday quote).',
    schema: currencySchema,
    execute: (_ctx, input) => service.currency(input),
  });
  registry.register({
    ...base,
    id: 'integration.graphql-get',
    risk: 'write',
    userPermissions: [P.ManageGuild],
    description:
      'After exact-payload confirmation, send one query by public GraphQL GET to a confirmed hostname; remote resolver side effects remain possible.',
    schema: graphqlSchema,
    execute: (ctx, input) => service.graphql(ctx, input),
  });
  registry.register({
    ...base,
    id: 'integration.minecraft-status',
    description:
      'Query Java Minecraft status on a confirmed public hostname, fixed TCP port 25565; no SRV, login, RCON or arbitrary ports.',
    schema: z.strictObject({ hostname }),
    execute: (ctx, input) => service.minecraft(ctx, input.hostname),
  });
}
