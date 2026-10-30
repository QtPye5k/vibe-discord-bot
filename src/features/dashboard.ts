import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PermissionFlagsBits as P, type Client } from 'discord.js';
import { z } from 'zod';
import type { Store } from '../core/store.js';
import type { ActionContext } from '../core/types.js';
import { type ActionRegistry, actionPolicyExempt } from '../core/registry.js';
import { freshContext } from '../core/permissions.js';
import { assertOperator } from '../core/operator.js';
import { UserError } from '../core/errors.js';
import { channelWith } from '../discord/actions/shared.js';
import { dashboardPage } from '../discord/dashboard-page.js';
import type { PremiumAppearance } from './premium.js';

export interface DashboardOptions {
  client: Client;
  store: Store;
  registry: ActionRegistry;
  operatorIds: readonly string[];
  guildIds: readonly string[];
  baseUrl: string;
  enabled: boolean | (() => boolean);
  now?: () => number;
  appearance?: (ctx: ActionContext) => Promise<PremiumAppearance>;
}
interface Principal {
  userId: string;
  guildId: string;
  channelId: string;
  expiresAt: number;
  epoch: number;
}
interface Session extends Principal {
  csrfHash?: string;
  pending: Map<string, { previewHash: string; expiresAt: number }>;
  artifacts: Map<string, Artifact>;
}
interface Artifact {
  data: Buffer;
  name: string;
  expiresAt: number;
  createdAt: number;
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const secret = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equalHash = (left: string, right: string) =>
  left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const secretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const actionId = z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/);
const empty = z.strictObject({});

function body(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
    return Promise.reject(new HttpError(415, 'Use application/json.'));
  const declared = request.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 65536))
    return Promise.reject(new HttpError(413, 'Request body exceeds 64 KiB.'));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      request.off('data', data);
      request.off('end', end);
      request.off('aborted', aborted);
      request.off('error', failed);
    };
    const fail = (error: HttpError) => {
      cleanup();
      request.pause();
      reject(error);
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 65536) fail(new HttpError(413, 'Request body exceeds 64 KiB.'));
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON.'));
      }
    };
    const aborted = () => fail(new HttpError(400, 'Request body was interrupted.'));
    const failed = () => fail(new HttpError(400, 'Request body could not be read.'));
    // This is an absolute deadline, unaffected by clients sending a byte at a time.
    const timer = setTimeout(() => fail(new HttpError(408, 'Request body deadline exceeded.')), 5000);
    timer.unref();
    request.on('data', data);
    request.once('end', end);
    request.once('aborted', aborted);
    request.once('error', failed);
  });
}

function safeValue(value: unknown, file?: (data: Buffer, name: string) => unknown): unknown {
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  function visit(item: unknown, depth: number): unknown {
    if (++nodes > 10000 || depth > 30) return '[Result truncated]';
    if (Buffer.isBuffer(item)) return { attachmentBytes: item.length };
    if (typeof item === 'bigint') return String(item);
    if (!item || typeof item !== 'object') return item;
    if (
      'status' in item &&
      item.status === 'confirmation' &&
      'approvalChannelId' in item &&
      typeof item.approvalChannelId === 'string'
    )
      return {
        status: 'approval-routed',
        approvalChannelId: item.approvalChannelId,
        notice:
          'Review and approve or reject this request in the dedicated private Discord confirmation channel.',
      };
    if (ancestors.has(item)) return '[Circular value]';
    if (
      'attachment' in item &&
      Buffer.isBuffer(item.attachment) &&
      'name' in item &&
      typeof item.name === 'string'
    )
      return {
        name: item.name,
        ...('notice' in item && typeof item.notice === 'string' ? { notice: item.notice } : {}),
        download: file?.(item.attachment, item.name) ?? { attachmentBytes: item.attachment.length },
      };
    ancestors.add(item);
    const result = Array.isArray(item)
      ? item.map((child) => visit(child, depth + 1))
      : Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, depth + 1)]));
    ancestors.delete(item);
    return result;
  }
  return visit(value, 0);
}
function json(response: ServerResponse, status: number, value: unknown): void {
  // Inspect Buffers before stringify invokes Buffer.toJSON and allocates a huge numeric array.
  const encoded = JSON.stringify(safeValue(value));
  if (Buffer.byteLength(encoded) > 1048576)
    throw new HttpError(422, 'Result exceeds the dashboard limit. Inspect it through Discord.');
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(encoded);
}

export function createDashboard(options: DashboardOptions) {
  const { client, store, registry } = options;
  const base = new URL(options.baseUrl);
  if (
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash ||
    (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))
  )
    throw new Error('Dashboard baseUrl must be an HTTPS origin or a loopback HTTP origin.');
  const cookieName = base.protocol === 'https:' ? '__Secure-discord_dashboard' : 'discord_dashboard';
  const now = options.now ?? Date.now;
  const links = new Map<string, Principal>();
  const sessions = new Map<string, Session>();
  const FILE_LIMIT = 24 * 1048576,
    GLOBAL_FILE_LIMIT = 96 * 1048576;
  let closed = false,
    registered = false,
    active = 0;
  const globalEnabled = () =>
    !closed && (typeof options.enabled === 'function' ? options.enabled() : options.enabled);
  const epoch = (guildId: string) => store.get<number>('core.featureEpochs', `${guildId}:dashboard`) ?? 0;
  const available = (principal: Principal) =>
    globalEnabled() &&
    principal.expiresAt > now() &&
    (!options.guildIds.length || options.guildIds.includes(principal.guildId)) &&
    !(store.get<string[]>('core.disabled', principal.guildId) ?? []).includes('dashboard') &&
    epoch(principal.guildId) === principal.epoch;
  const prune = () => {
    for (const map of [links, sessions])
      for (const [key, value] of map) if (!available(value)) map.delete(key);
    for (const value of sessions.values())
      for (const [key, artifact] of value.artifacts)
        if (artifact.expiresAt <= now()) value.artifacts.delete(key);
  };
  const artifactBytes = (session: Session) =>
    [...session.artifacts.values()].reduce((sum, item) => sum + item.data.length, 0);
  function storeArtifact(session: Session, data: Buffer, originalName: string): unknown {
    prune();
    if (data.length > FILE_LIMIT)
      return {
        bytes: data.length,
        unavailable: 'File exceeds the 24 MiB dashboard limit. Receive it through Discord.',
      };
    while (session.artifacts.size >= 3 || artifactBytes(session) + data.length > FILE_LIMIT) {
      const oldest = session.artifacts.keys().next().value;
      if (!oldest) break;
      session.artifacts.delete(oldest);
    }
    while (
      [...sessions.values()].reduce((sum, item) => sum + artifactBytes(item), 0) + data.length >
      GLOBAL_FILE_LIMIT
    ) {
      const oldest = [...sessions.values()]
        .flatMap((session) =>
          [...session.artifacts].map(([key, file]) => ({ session, key, at: file.createdAt })),
        )
        .sort((a, b) => a.at - b.at)[0];
      if (!oldest) break;
      oldest.session.artifacts.delete(oldest.key);
    }
    const token = secret(),
      name =
        originalName
          .replace(/[^A-Za-z0-9._-]/g, '_')
          .replace(/^\.+/, '')
          .slice(0, 120) || 'download.bin';
    const expiresAt = Math.min(session.expiresAt, now() + 120000);
    session.artifacts.set(hash(token), { data, name, expiresAt, createdAt: now() });
    return { url: `/dashboard/file/${token}`, name, bytes: data.length, expiresAt };
  }
  const outcomeValue = (value: unknown, session: Session) => {
    if (
      value &&
      typeof value === 'object' &&
      'status' in value &&
      value.status === 'confirmation' &&
      'approvalChannelId' in value &&
      typeof value.approvalChannelId === 'string'
    )
      return {
        status: 'approval-routed',
        approvalChannelId: value.approvalChannelId,
        notice:
          'Review and approve or reject this request in the dedicated private Discord confirmation channel.',
      };
    let count = 0,
      bytes = 0;
    return safeValue(value, (data, name) => {
      if (count >= 3 || bytes + data.length > FILE_LIMIT)
        return {
          bytes: data.length,
          unavailable:
            'This result exceeds the dashboard file limit. Receive remaining files through Discord.',
        };
      count++;
      bytes += data.length;
      return storeArtifact(session, data, name);
    });
  };
  function actionAllowed(ctx: ActionContext, id: string): boolean {
    const action = registry.get(id);
    if (action.available?.() === false) return false;
    if (action.category === 'system' || actionPolicyExempt(id)) return true;
    if ((store.get<string[]>('core.disabled', ctx.guild.id) ?? []).includes(action.category)) return false;
    const policy = store.get<{ enabled: boolean; roleIds: string[]; channelIds: string[] }>(
      'core.actionPolicies',
      `${ctx.guild.id}:${id}`,
    );
    return (
      !policy ||
      (policy.enabled &&
        (!policy.channelIds.length || policy.channelIds.includes(ctx.channelId)) &&
        (!policy.roleIds.length || policy.roleIds.some((id) => ctx.member.roles.cache.has(id))))
    );
  }
  async function authorize(principal: Principal): Promise<ActionContext> {
    if (!available(principal)) throw new HttpError(401, 'Sign in through Discord again.');
    const guild = await client.guilds.fetch(principal.guildId);
    if (guild.id !== principal.guildId) throw new HttpError(403, 'Server access is unavailable.');
    const member = await guild.members.fetch({ user: principal.userId, force: true });
    const ctx = await freshContext({ client, guild, member, channelId: principal.channelId, store });
    if (!options.operatorIds.includes(ctx.member.id)) await client.application?.fetch();
    assertOperator(ctx, options.operatorIds);
    if (!ctx.member.permissions.has(P.ManageGuild))
      throw new HttpError(403, 'Manage Server permission is required.');
    await channelWith(ctx, ctx.channelId, [P.ReadMessageHistory]);
    assertOperator(ctx, options.operatorIds);
    if (!ctx.member.permissions.has(P.ManageGuild))
      throw new HttpError(403, 'Manage Server permission is required.');
    if (!available(principal) || !actionAllowed(ctx, 'dashboard.login'))
      throw new HttpError(403, 'Dashboard access is no longer permitted.');
    return ctx;
  }
  const cookie = (value: string, maxAge: number) =>
    `${cookieName}=${value}; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${base.protocol === 'https:' ? '; Secure' : ''}`;
  function session(request: IncomingMessage): { key: string; value: Session } {
    const raw = request.headers.cookie ?? '';
    const values =
      raw.length <= 4096
        ? raw
            .split(';')
            .map((part) => part.trim())
            .filter((part) => part.startsWith(`${cookieName}=`))
        : [];
    if (values.length !== 1) throw new HttpError(401, 'Sign in through Discord first.');
    const token = values[0]!.slice(cookieName.length + 1);
    if (!secretSchema.safeParse(token).success) throw new HttpError(401, 'Sign in through Discord again.');
    const key = hash(token),
      value = sessions.get(key);
    if (!value || !available(value)) {
      sessions.delete(key);
      throw new HttpError(401, 'Your session expired. Sign in through Discord again.');
    }
    return { key, value };
  }
  function registerActions(): void {
    if (registered) return;
    registered = true;
    registry.register({
      id: 'dashboard.login',
      category: 'dashboard',
      risk: 'write',
      userPermissions: [P.ManageGuild],
      botPermissions: [P.ReadMessageHistory],
      schema: empty,
      description:
        'Application operators create a private, single-use two-minute dashboard sign-in link for this server and channel. Treat the returned link as a credential.',
      execute: async (ctx) => {
        if (!globalEnabled())
          throw new UserError('The local dashboard is disabled in hosting configuration.');
        const principal: Principal = {
          userId: ctx.member.id,
          guildId: ctx.guild.id,
          channelId: ctx.channelId,
          expiresAt: now() + 120000,
          epoch: epoch(ctx.guild.id),
        };
        await authorize(principal);
        prune();
        if (links.size >= 500)
          throw new UserError('Too many outstanding dashboard links. Wait for them to expire.');
        for (const [key, value] of links)
          if (value.userId === principal.userId && value.guildId === principal.guildId) links.delete(key);
        const token = secret();
        links.set(hash(token), principal);
        return {
          url: `${base.origin}/dashboard/login?token=${token}`,
          expiresAt: principal.expiresAt,
          notice: 'Private sign-in credential. Open it once within two minutes; do not share it.',
        };
      },
    });
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', base.origin);
    } catch {
      return false;
    }
    if (url.pathname !== '/dashboard' && !url.pathname.startsWith('/dashboard/')) return false;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const stop = (status: number, message: string) => {
      request.resume();
      response.setHeader('Connection', 'close');
      json(response, status, { error: message });
    };
    if (!globalEnabled()) {
      stop(404, 'Dashboard is disabled.');
      return true;
    }
    if (url.origin !== base.origin || request.headers.host !== base.host) {
      stop(421, 'Use the configured dashboard origin.');
      return true;
    }
    if (active >= 32) {
      stop(503, 'Dashboard is busy. Retry later.');
      return true;
    }
    active++;
    try {
      prune();
      if ((url.pathname === '/dashboard' || url.pathname === '/dashboard/') && request.method === 'GET') {
        if (url.search) throw new HttpError(400, 'Unexpected dashboard query parameters.');
        const nonce = secret();
        response.setHeader(
          'Content-Security-Policy',
          `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
        );
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(dashboardPage(nonce));
        return true;
      }
      if (url.pathname === '/dashboard/login' && request.method === 'GET') {
        if (url.searchParams.size !== 1) throw new HttpError(400, 'Invalid sign-in link.');
        const token = secretSchema.parse(url.searchParams.get('token'));
        const key = hash(token),
          principal = links.get(key);
        links.delete(key); // Claim before any asynchronous checks: only one visit can win.
        if (!principal) throw new HttpError(401, 'Sign-in link expired or already used.');
        await authorize(principal);
        if (sessions.size >= 500) throw new HttpError(503, 'Too many dashboard sessions. Retry later.');
        for (const [key, value] of sessions)
          if (value.userId === principal.userId && value.guildId === principal.guildId) sessions.delete(key);
        const sessionToken = secret();
        sessions.set(hash(sessionToken), {
          ...principal,
          expiresAt: now() + 900000,
          pending: new Map(),
          artifacts: new Map(),
        });
        response.writeHead(303, { Location: '/dashboard', 'Set-Cookie': cookie(sessionToken, 900) });
        response.end();
        return true;
      }
      if (url.pathname.startsWith('/dashboard/file/')) {
        if (request.method !== 'GET' || url.search)
          throw new HttpError(405, 'Use the dashboard download link.');
        if (request.headers.origin !== undefined && request.headers.origin !== base.origin)
          throw new HttpError(403, 'A same-origin download is required.');
        if (request.headers.origin !== base.origin && request.headers['sec-fetch-site'] !== 'same-origin')
          throw new HttpError(403, 'Open this download from the dashboard.');
        const token = secretSchema.parse(url.pathname.slice('/dashboard/file/'.length));
        const current = session(request),
          file = current.value.artifacts.get(hash(token));
        if (!file || file.expiresAt <= now())
          throw new HttpError(404, 'Download expired or belongs to another session.');
        await authorize(current.value);
        if (sessions.get(current.key) !== current.value)
          throw new HttpError(401, 'Your session is no longer active.');
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${file.name}"`,
          'Content-Length': file.data.length,
        });
        response.end(file.data);
        return true;
      }
      if (!url.pathname.startsWith('/dashboard/api/')) throw new HttpError(404, 'Dashboard route not found.');
      if (request.method !== 'POST') throw new HttpError(405, 'Dashboard API requires POST.');
      if (url.search) throw new HttpError(400, 'Unexpected API query parameters.');
      if (request.headers.origin !== base.origin || request.headers['x-dashboard-request'] !== '1')
        throw new HttpError(403, 'A same-origin dashboard request is required.');
      const current = session(request),
        value = current.value;
      const route = url.pathname.slice('/dashboard/api/'.length);
      if (route !== 'bootstrap') {
        const csrf = request.headers['x-csrf-token'];
        if (typeof csrf !== 'string' || !value.csrfHash || !equalHash(hash(csrf), value.csrfHash))
          throw new HttpError(403, 'Reload the dashboard before making this request.');
      }
      const input = await body(request);
      const ctx = await authorize(value);
      const appearance =
        route === 'bootstrap' || route === 'status' ? await options.appearance?.(ctx) : undefined;
      if (sessions.get(current.key) !== value) throw new HttpError(401, 'Your session is no longer active.');
      if (appearance) await authorize(value);
      switch (route) {
        case 'bootstrap': {
          empty.parse(input);
          const csrf = secret();
          value.csrfHash = hash(csrf);
          json(response, 200, {
            csrf,
            expiresAt: value.expiresAt,
            guild: { id: ctx.guild.id, name: ctx.guild.name },
            channelId: ctx.channelId,
            user: { id: ctx.member.id, name: ctx.member.user.username },
            appearance,
          });
          break;
        }
        case 'status':
          empty.parse(input);
          json(response, 200, {
            uptimeSeconds: Math.floor(process.uptime()),
            memoryMiB: Math.round(process.memoryUsage().rss / 1048576),
            gatewayLatencyMs: client.ws.ping,
            actionCount: registry.listAvailable().length,
            appearance,
            bot: client.user?.username ?? 'Vibe',
            disabledCategories: store.get<string[]>('core.disabled', ctx.guild.id) ?? [],
          });
          break;
        case 'analytics': {
          empty.parse(input);
          if (
            !registry.list().some((action) => action.id === 'analytics.observed') ||
            !actionAllowed(ctx, 'analytics.observed')
          ) {
            json(response, 200, { available: false, points: [] });
            break;
          }
          const outcome = await registry.request(ctx, 'analytics.observed', { days: 7 });
          json(response, 200, {
            available: true,
            points: outcome.status === 'completed' ? outcome.result : [],
          });
          break;
        }
        case 'actions':
          empty.parse(input);
          json(
            response,
            200,
            registry
              .list()
              .filter((action) => action.id !== 'dashboard.login')
              .map((action) => ({
                id: action.id,
                description: action.description,
                category: action.category,
                risk: action.risk,
                available: actionAllowed(ctx, action.id),
              })),
          );
          break;
        case 'schema': {
          const { action: id } = z.strictObject({ action: actionId }).parse(input);
          if (id === 'dashboard.login')
            throw new HttpError(403, 'Create dashboard sign-in links through Discord.');
          const action = registry.get(id);
          json(response, 200, {
            action: id,
            description: action.description,
            risk: action.risk,
            userPermissions: action.userPermissions.map(
              (flag) => Object.entries(P).find(([, value]) => value === flag)?.[0] ?? String(flag),
            ),
            botPermissions: action.botPermissions.map(
              (flag) => Object.entries(P).find(([, value]) => value === flag)?.[0] ?? String(flag),
            ),
            schema: z.toJSONSchema(action.schema, { io: 'input' }),
          });
          break;
        }
        case 'request': {
          const parsed = z.strictObject({ action: actionId, input: z.unknown() }).parse(input);
          if (parsed.action === 'dashboard.login')
            throw new HttpError(403, 'Create dashboard sign-in links through Discord.');
          for (const [id, pending] of value.pending) if (pending.expiresAt <= now()) value.pending.delete(id);
          if (value.pending.size >= 10)
            throw new HttpError(429, 'Confirm or cancel current previews before requesting more.');
          const outcome = await registry.request(ctx, parsed.action, parsed.input);
          if (outcome.status === 'confirmation' && outcome.approvalChannelId) {
            json(response, 200, outcomeValue(outcome, value));
            break;
          }
          if (outcome.status === 'confirmation') {
            const previewHash = hash(JSON.stringify(outcome));
            value.pending.set(outcome.id, { previewHash, expiresAt: outcome.expiresAt });
            json(response, 200, { ...outcome, previewHash });
          } else json(response, 200, outcomeValue(outcome, value));
          break;
        }
        case 'confirm': {
          const { id, previewHash } = z
            .strictObject({ id: z.string().min(1).max(100), previewHash: z.string().regex(/^[a-f0-9]{64}$/) })
            .parse(input);
          const saved = value.pending.get(id);
          if (!saved || saved.expiresAt <= now() || !equalHash(saved.previewHash, previewHash))
            throw new HttpError(
              403,
              'Request and review this action in the current dashboard session first.',
            );
          value.pending.delete(id);
          json(response, 200, outcomeValue(await registry.confirm(ctx, id), value));
          break;
        }
        case 'cancel': {
          const { id } = z.strictObject({ id: z.string().min(1).max(100) }).parse(input);
          if (!value.pending.delete(id))
            throw new HttpError(403, 'This action does not belong to the current dashboard session.');
          json(response, 200, { cancelled: await registry.reject(ctx, id) });
          break;
        }
        case 'logout':
          empty.parse(input);
          sessions.delete(current.key);
          response.setHeader('Set-Cookie', cookie('', 0));
          json(response, 200, { loggedOut: true });
          break;
        default:
          throw new HttpError(404, 'Dashboard API route not found.');
      }
    } catch (error) {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof z.ZodError
            ? 400
            : error instanceof UserError
              ? 403
              : 503;
      if (status === 401) response.setHeader('Set-Cookie', cookie('', 0));
      const message =
        error instanceof HttpError || error instanceof UserError
          ? error.message.slice(0, 500)
          : error instanceof z.ZodError
            ? 'Request does not match the expected schema.'
            : 'Dashboard request could not be completed. Check access and retry through Discord.';
      if (!response.headersSent) stop(status, message);
      else response.destroy();
    } finally {
      active--;
    }
    return true;
  }
  return {
    registerActions,
    handle,
    close: () => {
      closed = true;
      links.clear();
      sessions.clear();
    },
  };
}
