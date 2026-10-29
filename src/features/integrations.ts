import { createHash, randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { PermissionFlagsBits as P, type Client } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import type { Store } from '../core/store.js';
import { resolveChannel } from '../core/permissions.js';
import { UserError } from '../core/errors.js';

export interface PublicResponse {
  status: number;
  body: Buffer;
  headers: Record<string, string | undefined>;
}
export interface PinnedRequest {
  url: URL;
  address: string;
  family: number;
  maxBytes: number;
  timeoutMs: number;
  headers: Record<string, string>;
}
export interface PublicTransport {
  resolve: (hostname: string) => Promise<{ address: string; family: number }[]>;
  connect: (options: PinnedRequest) => Promise<PublicResponse>;
}
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 2) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family === 6) {
    const text = new URL(`https://[${address}]/`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const first = Number.parseInt(text.split(':')[0] ?? '', 16);
    return (
      first >= 0x2000 && first <= 0x3fff && !/^2001:(?:db8|0)(?::|$)/.test(text) && !text.startsWith('2002:')
    );
  }
  return false;
}
export function publicUrl(value: string, allowedHosts?: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UserError('Use a public HTTPS URL.');
  }
  if (
    value.length > 4096 ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    url.hash
  )
    throw new UserError('Use an HTTPS URL without credentials, fragments or custom ports.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    (!host.includes('.') && !isIP(host)) ||
    (isIP(host) && !isPublicAddress(host))
  )
    throw new UserError('Local and private network destinations are not allowed.');
  if (allowedHosts && !allowedHosts.includes(host))
    throw new UserError('This hostname is not on this server’s confirmed integration allowlist.');
  return url;
}
export async function connectPinned(options: PinnedRequest): Promise<PublicResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = request(
      options.url,
      {
        method: 'GET',
        agent: false,
        family: options.family,
        servername: options.url.hostname,
        lookup: (_host, _opts, callback) => callback(null, options.address, options.family),
        headers: options.headers,
      },
      (response) => {
        const size = Number(response.headers['content-length'] ?? 0);
        if (size > options.maxBytes) {
          response.destroy();
          req.destroy(new UserError('Integration response is too large.'));
          return;
        }
        const parts: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > options.maxBytes) {
            response.destroy();
            req.destroy(new UserError('Integration response is too large.'));
          } else parts.push(chunk);
        });
        response.on('error', (error) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(error);
          }
        });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const headers: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(response.headers))
            headers[name] = Array.isArray(value) ? value.join(',') : value;
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(parts, bytes), headers });
        });
      },
    );
    const timer = setTimeout(
      () => req.destroy(new UserError('Integration request timed out.')),
      options.timeoutMs,
    );
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    req.end();
  });
}
const defaultTransport: PublicTransport = {
  resolve: async (hostname) => {
    const resolver = new Resolver({ timeout: 2500, tries: 2 });
    const timer = setTimeout(() => resolver.cancel(), 10000);
    try {
      const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
      return [
        ...(v4.status === 'fulfilled' ? v4.value.map((address) => ({ address, family: 4 })) : []),
        ...(v6.status === 'fulfilled' ? v6.value.map((address) => ({ address, family: 6 })) : []),
      ];
    } finally {
      clearTimeout(timer);
    }
  },
  connect: connectPinned,
};
let activeRequests = 0;
/** DNS is validated once and the actual HTTPS connection is pinned to that validated address. Redirects are never followed. */
export async function fetchPublic(
  value: string,
  options: { allowedHosts?: readonly string[]; maxBytes?: number; headers?: Record<string, string> } = {},
  transport: PublicTransport = defaultTransport,
): Promise<PublicResponse> {
  const url = publicUrl(value, options.allowedHosts);
  if (activeRequests >= 4) throw new UserError('Public integrations are busy. Try again shortly.');
  activeRequests++;
  try {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const literal = isIP(host);
    const addresses = literal ? [{ address: host, family: literal }] : await transport.resolve(host);
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address)))
      throw new UserError('Integration hostname resolves to a private or unsupported network.');
    const pinned = addresses.find((entry) => entry.family === 4) ?? addresses[0]!;
    const maxBytes = Math.min(2_097_152, Math.max(1, options.maxBytes ?? 1_048_576));
    const response = await transport.connect({
      url,
      address: pinned.address,
      family: pinned.family,
      maxBytes,
      timeoutMs: 10000,
      headers: {
        'User-Agent': 'Discord-Unified-Bot/2.0',
        Accept: 'application/json,application/rss+xml,application/atom+xml,text/plain;q=0.8',
        ...options.headers,
      },
    });
    if (response.body.length > maxBytes) throw new UserError('Integration response is too large.');
    if (response.status >= 300 && response.status < 400)
      throw new UserError('Integration redirects are disabled. Configure the final HTTPS URL.');
    return response;
  } finally {
    activeRequests--;
  }
}
const cache = new Map<string, { expires: number; value: unknown }>();
const pending = new Map<string, Promise<unknown>>();
export async function cachedPublicJson(url: string, transport?: PublicTransport): Promise<unknown> {
  const found = cache.get(url);
  if (found && found.expires > Date.now()) return found.value;
  const existing = pending.get(url);
  if (existing) return existing;
  const work = (async () => {
    const response = await fetchPublic(url, {}, transport);
    if (response.status < 200 || response.status >= 300)
      throw new UserError(
        `Public API returned HTTP ${response.status}. Authentication, rate limits, availability or repository visibility may apply.`,
      );
    let value: unknown;
    try {
      value = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new UserError('Public API returned invalid JSON.');
    }
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(url, { expires: Date.now() + 300000, value });
    return value;
  })();
  pending.set(url, work);
  try {
    return await work;
  } finally {
    pending.delete(url);
  }
}
function decodeText(value: string): string {
  const source = value.replaceAll('<![CDATA[', '').replaceAll(']]>', '');
  let plain = '';
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf('<', index);
    if (open < 0) {
      plain += source.slice(index);
      break;
    }
    plain += source.slice(index, open);
    const close = source.indexOf('>', open + 1);
    if (close < 0) {
      plain += source.slice(open);
      break;
    }
    index = close + 1;
  }
  return plain
    .replace(
      /&(?:amp|lt|gt|quot|apos);/g,
      (entity) =>
        ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity] ?? entity,
    )
    .replace(/&#(x[0-9a-f]{1,6}|\d{1,7});/gi, (_match, number: string) => {
      const value = number[0]?.toLowerCase() === 'x' ? Number.parseInt(number.slice(1), 16) : Number(number);
      return value > 0 && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff)
        ? String.fromCodePoint(value)
        : '';
    })
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
    .slice(0, 1000);
}
export interface FeedItem {
  id: string;
  title: string;
  url: string;
  published?: string;
}
export function parseFeed(xml: string): FeedItem[] {
  if (Buffer.byteLength(xml) > 1_048_576 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new UserError('RSS feeds must be under 1 MB and cannot contain DTD/entities.');
  if (!/<(?:rss|feed|rdf:RDF)(?:\s|>)/i.test(xml))
    throw new UserError('The endpoint did not return an RSS/Atom feed.');
  const blocks: string[] = [];
  const starts = /<(item|entry)(?:\s[^>]{0,2000})?>/gi;
  const lower = xml.toLowerCase();
  let match: RegExpExecArray | null;
  while (blocks.length < 100 && (match = starts.exec(xml))) {
    const end = lower.indexOf(`</${match[1]!.toLowerCase()}>`, starts.lastIndex);
    if (end < 0) break;
    blocks.push(xml.slice(starts.lastIndex, Math.min(end, starts.lastIndex + 32768)));
    starts.lastIndex = end + match[1]!.length + 3;
  }
  const result: FeedItem[] = [];
  const field = (block: string, tag: string) => {
    const start = new RegExp(`<${tag}(?:\\s[^>]{0,2000})?>`, 'i').exec(block);
    if (!start) return '';
    const from = start.index + start[0].length,
      end = block.toLowerCase().indexOf(`</${tag}>`, from);
    return end < 0 ? '' : decodeText(block.slice(from, end));
  };
  for (const block of blocks) {
    const title = field(block, 'title');
    const link =
      field(block, 'link') ||
      decodeText(/<link\b[^>]{0,2000}\bhref=["']([^"']{1,4096})["'][^>]*\/?\s*>/i.exec(block)?.[1] ?? '');
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue;
    const id = field(block, 'guid') || field(block, 'id') || url.href;
    if (!title) continue;
    result.push({
      id: id.slice(0, 500),
      title: title.slice(0, 300),
      url: url.href,
      published: field(block, 'pubDate') || field(block, 'published') || field(block, 'updated') || undefined,
    });
  }
  return result;
}
interface Watch {
  id: string;
  revision: string;
  guildId: string;
  authorId: string;
  channelId: string;
  url: string;
  kind: 'rss' | 'uptime' | 'change';
  intervalMinutes: number;
  nextAt: number;
  baseline?: string;
  seen?: string[];
  pending?: { text: string; nonce: string; attempts: number; retryAt: number };
  lastCheckedAt?: number;
  lastState?: string;
  lastError?: string;
  enabled: boolean;
}
function scopes(ctx: ActionContext) {
  return ctx.store.get<string[]>('integration.hosts', ctx.guild.id) ?? [];
}
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const snowflake = z.string().regex(/^\d{17,20}$/);
const publicAddress = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      publicUrl(value);
      return true;
    } catch {
      return false;
    }
  }, 'Expected a public HTTPS endpoint');
async function watchContext(client: Client, store: Store, watch: Watch): Promise<ActionContext> {
  const guild = await client.guilds.fetch(watch.guildId);
  const member = await guild.members.fetch({ user: watch.authorId, force: true });
  await guild.members.fetchMe({ force: true });
  if (!member.permissions.has(P.ManageGuild))
    throw new UserError('Integration policy author no longer has Manage Server.');
  return { client, store, guild, member, channelId: watch.channelId };
}
async function watchChannel(ctx: ActionContext, id: string) {
  const channel = await resolveChannel(ctx, id);
  if (!channel.isSendable()) throw new UserError('Integration output requires a message channel.');
  const permission = channel.isThread() ? P.SendMessagesInThreads : P.SendMessages;
  for (const member of [ctx.member, ctx.guild.members.me!])
    if (!channel.permissionsFor(member)?.has(permission))
      throw new UserError('Integration output permissions unavailable.');
  return channel;
}
const sweeps = new WeakSet<Store>();
export async function sweepIntegrationTasks(
  client: Client,
  store: Store,
  now = Date.now(),
  allowedGuildIds: readonly string[] = [],
  transport?: PublicTransport,
): Promise<void> {
  if (sweeps.has(store)) return;
  sweeps.add(store);
  const deadline = Date.now() + 20000;
  try {
    let processed = 0;
    for (const row of store.list<Watch>('integration.watches')) {
      const watch = row.value;
      if (processed >= 5 || Date.now() >= deadline) break;
      if (
        !watch.enabled ||
        (allowedGuildIds.length && !allowedGuildIds.includes(watch.guildId)) ||
        (store.get<string[]>('core.disabled', watch.guildId) ?? []).includes('integrations')
      )
        continue;
      if ((!watch.pending && watch.nextAt > now) || (watch.pending && watch.pending.retryAt > now)) continue;
      processed++;
      try {
        const ctx = await watchContext(client, store, watch);
        await watchChannel(ctx, watch.channelId);
        const hosts = scopes(ctx);
        publicUrl(watch.url, hosts);
        if (!watch.pending) {
          let state: string, text: string | undefined;
          try {
            const response = await fetchPublic(
              watch.url,
              { allowedHosts: hosts, maxBytes: 1_048_576 },
              transport,
            );
            if (watch.kind === 'uptime') {
              state = response.status >= 200 && response.status < 300 ? 'up' : 'down';
              if (watch.baseline && watch.baseline !== state)
                text = `Website monitor ${watch.id}: ${state.toUpperCase()} (HTTP ${response.status}).`;
            } else {
              if (response.status < 200 || response.status >= 300)
                throw new UserError(`Endpoint HTTP ${response.status}`);
              if (watch.kind === 'change') {
                state = createHash('sha256').update(response.body).digest('hex');
                if (watch.baseline && watch.baseline !== state)
                  text = `Website change detected: ${watch.id}\n${watch.url}`;
              } else {
                const items = parseFeed(response.body.toString('utf8'));
                state = createHash('sha256')
                  .update(items.map((item) => item.id).join('\n'))
                  .digest('hex');
                const known = new Set(watch.seen ?? []);
                const fresh = watch.baseline ? items.filter((item) => !known.has(item.id)).slice(0, 5) : [];
                if (fresh.length)
                  text =
                    `RSS updates (${watch.id}):\n${fresh.map((item) => `${item.title.replace(/[<>@]/g, '')}\n${item.url}`).join('\n\n')}`.slice(
                      0,
                      1800,
                    );
                watch.seen = [...new Set([...items.map((item) => item.id), ...(watch.seen ?? [])])].slice(
                  0,
                  200,
                );
              }
            }
            watch.baseline = state;
            watch.lastState = watch.kind === 'uptime' ? state : 'ok';
            delete watch.lastError;
          } catch (error) {
            if (watch.kind !== 'uptime') throw error;
            state = 'down';
            if (watch.baseline && watch.baseline !== 'down')
              text = `Website monitor ${watch.id}: DOWN (request failed).`;
            watch.baseline = state;
            watch.lastState = state;
            watch.lastError = error instanceof Error ? error.name : 'Error';
          }
          watch.nextAt = now + watch.intervalMinutes * 60000;
          watch.lastCheckedAt = now;
          if (text)
            watch.pending = {
              text,
              nonce: createHash('sha256')
                .update(`${watch.guildId}:${watch.id}:${state}:${now}`)
                .digest('hex')
                .slice(0, 24),
              attempts: 0,
              retryAt: now,
            };
          if (store.get<Watch>('integration.watches', row.key)?.revision !== watch.revision) continue;
          store.set('integration.watches', row.key, watch);
        }
        if (watch.pending) {
          const freshContext = await watchContext(client, store, watch);
          const freshChannel = await watchChannel(freshContext, watch.channelId);
          publicUrl(watch.url, scopes(freshContext));
          const latest = store.get<Watch>('integration.watches', row.key);
          if (
            !latest?.enabled ||
            latest.revision !== watch.revision ||
            latest.pending?.nonce !== watch.pending.nonce ||
            (store.get<string[]>('core.disabled', watch.guildId) ?? []).includes('integrations')
          )
            continue;
          await freshChannel.send({
            content: watch.pending.text,
            allowedMentions: { parse: [] },
            nonce: watch.pending.nonce,
            enforceNonce: true,
          });
          delete watch.pending;
          if (store.get<Watch>('integration.watches', row.key)?.revision === watch.revision)
            store.set('integration.watches', row.key, watch);
        }
      } catch (error) {
        if (store.get<Watch>('integration.watches', row.key)?.revision !== watch.revision) continue;
        watch.lastError = error instanceof Error ? error.name : 'Error';
        watch.nextAt = now + watch.intervalMinutes * 60000;
        if (watch.pending) {
          watch.pending.attempts++;
          watch.pending.retryAt = now + 30_000 * 2 ** watch.pending.attempts;
          if (watch.pending.attempts >= 3) {
            watch.enabled = false;
          }
        } else if (error instanceof UserError && /author|permissions|allowlist/.test(error.message))
          watch.enabled = false;
        store.set('integration.watches', row.key, watch);
      }
    }
  } finally {
    sweeps.delete(store);
  }
}
const githubSlug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
export function registerIntegrationActions(registry: ActionRegistry): void {
  const publicRead = {
    category: 'integrations',
    userPermissions: [],
    botPermissions: [],
    risk: 'read' as const,
  };
  registry.register({
    ...publicRead,
    id: 'integration.github',
    description:
      'Query public GitHub repositories, commits, releases, pull requests or Actions runs without a separate credential.',
    schema: z.strictObject({
      owner: githubSlug,
      repository: githubSlug,
      resource: z.enum(['repository', 'commits', 'releases', 'pulls', 'runs']).default('repository'),
    }),
    execute: async (_ctx, input) => {
      const suffix = {
        repository: '',
        commits: '/commits?per_page=10',
        releases: '/releases?per_page=10',
        pulls: '/pulls?state=all&per_page=10',
        runs: '/actions/runs?per_page=10',
      }[input.resource];
      const data = await cachedPublicJson(
        `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}${suffix}`,
      );
      if (input.resource === 'repository') {
        const value = data as Record<string, unknown>;
        return {
          source: 'GitHub public REST API',
          name: value.full_name,
          description: value.description,
          url: value.html_url,
          stars: value.stargazers_count,
          forks: value.forks_count,
          openIssues: value.open_issues_count,
          updatedAt: value.updated_at,
        };
      }
      const values = (
        input.resource === 'runs' ? (data as { workflow_runs?: unknown[] }).workflow_runs : data
      ) as Record<string, unknown>[];
      if (!Array.isArray(values)) throw new UserError('GitHub returned an unexpected result.');
      return {
        source: 'GitHub public REST API',
        items: values.slice(0, 10).map((value) => ({
          id: value.id ?? value.sha,
          title:
            value.title ??
            value.name ??
            (value.commit as { message?: string } | undefined)?.message?.slice(0, 500),
          url: value.html_url,
          state: value.state ?? value.status,
          conclusion: value.conclusion,
          tag: value.tag_name,
          publishedAt: value.published_at ?? value.updated_at,
        })),
      };
    },
  });
  registry.register({
    ...publicRead,
    id: 'integration.weather',
    description: 'Retrieve current modeled weather for latitude/longitude using the public Open-Meteo API.',
    schema: z.strictObject({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      fahrenheit: z.boolean().default(false),
    }),
    execute: async (_ctx, input) => {
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.searchParams.set('latitude', String(input.latitude));
      url.searchParams.set('longitude', String(input.longitude));
      url.searchParams.set('current', 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m');
      url.searchParams.set('temperature_unit', input.fahrenheit ? 'fahrenheit' : 'celsius');
      url.searchParams.set('timezone', 'UTC');
      const data = (await cachedPublicJson(url.href)) as Record<string, unknown>;
      return {
        source: 'Open-Meteo modeled current conditions',
        latitude: data.latitude,
        longitude: data.longitude,
        current: data.current,
        units: data.current_units,
      };
    },
  });
  const admin = { ...publicRead, userPermissions: [P.ManageGuild], risk: 'write' as const };
  registry.register({
    ...admin,
    id: 'integration.hosts',
    description: 'Confirm exact public HTTPS hostnames permitted for this server’s RSS and website monitors.',
    schema: z.strictObject({
      hosts: z.array(z.string().regex(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)).max(20),
    }),
    execute: (ctx, input) => {
      for (const hostname of input.hosts) publicUrl(`https://${hostname}/`);
      ctx.store.set('integration.hosts', ctx.guild.id, [...new Set(input.hosts)]);
      return { hosts: input.hosts };
    },
  });
  registry.register({
    ...admin,
    id: 'integration.rss',
    description:
      'Read up to 20 recent items from a confirmed public RSS/Atom feed; no DTD, redirects or internal destinations.',
    risk: 'read',
    schema: z.strictObject({ url: publicAddress }),
    execute: async (ctx, input) => {
      const response = await fetchPublic(input.url, { allowedHosts: scopes(ctx) });
      if (response.status !== 200) throw new UserError(`RSS endpoint returned HTTP ${response.status}.`);
      return parseFeed(response.body.toString('utf8')).slice(0, 20);
    },
  });
  registry.register({
    ...admin,
    id: 'integration.http',
    description: 'Read a bounded public HTTPS endpoint from the confirmed hostname allowlist (GET only).',
    risk: 'read',
    schema: z.strictObject({ url: publicAddress }),
    execute: async (ctx, input) => {
      const response = await fetchPublic(input.url, { allowedHosts: scopes(ctx), maxBytes: 262144 });
      return {
        status: response.status,
        contentType: response.headers['content-type'],
        body: response.body.toString('utf8').slice(0, 16000),
        truncated: response.body.length > 16000,
      };
    },
  });
  registry.register({
    ...admin,
    id: 'integration.watch',
    description:
      'Monitor a confirmed public RSS feed or website uptime/content hash; alert only on changes after the first baseline.',
    schema: z.strictObject({
      id,
      url: publicAddress,
      kind: z.enum(['rss', 'uptime', 'change']),
      channelId: snowflake,
      intervalMinutes: z.number().int().min(5).max(1440).default(15),
    }),
    execute: async (ctx, input) => {
      publicUrl(input.url, scopes(ctx));
      await watchChannel(ctx, input.channelId);
      const k = `${ctx.guild.id}:${input.id}`;
      if (
        !ctx.store.get('integration.watches', k) &&
        ctx.store.list('integration.watches', `${ctx.guild.id}:`).length >= 20
      )
        throw new UserError('Limit: 20 public monitors per server.');
      const watch: Watch = {
        ...input,
        revision: randomBytes(8).toString('hex'),
        guildId: ctx.guild.id,
        authorId: ctx.member.id,
        nextAt: Date.now(),
        enabled: true,
      };
      ctx.store.set('integration.watches', k, watch);
      return watch;
    },
  });
  registry.register({
    ...admin,
    id: 'integration.watch-list',
    description: 'Inspect configured monitors, current state, last error and undelivered changes.',
    risk: 'read',
    schema: z.strictObject({}),
    execute: (ctx) =>
      ctx.store.list<Watch>('integration.watches', `${ctx.guild.id}:`).map((row) => row.value),
  });
  registry.register({
    ...admin,
    id: 'integration.watch-remove',
    description: 'Remove a public monitor and discard pending notifications.',
    schema: z.strictObject({ id }),
    execute: (ctx, input) => ({
      removed: ctx.store.delete('integration.watches', `${ctx.guild.id}:${input.id}`),
    }),
  });
}
