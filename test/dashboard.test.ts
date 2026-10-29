import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { Script } from 'node:vm';
import { Collection, PermissionFlagsBits as P, PermissionsBitField, type Client } from 'discord.js';
import { z } from 'zod';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import { createDashboard, type DashboardOptions } from '../src/features/dashboard.js';
import { dashboardPage } from '../src/discord/dashboard-page.js';

const GUILD = '550000000000000001',
  USER = '550000000000000002',
  BOT = '550000000000000003',
  CHANNEL = '550000000000000004';
async function fixture(t: TestContext, settings: { enabled?: boolean; baseUrl?: string } = {}) {
  const store = new Store(':memory:');
  const member = {
    id: USER,
    user: { id: USER, username: 'Operator', bot: false },
    permissions: new PermissionsBitField(P.ManageGuild),
    roles: { cache: new Collection() },
  };
  const bot = { ...member, id: BOT, user: { id: BOT, username: 'Bot', bot: true } };
  const hidden = new Set<string>(),
    noHistory = new Set<string>();
  const channel = {
    id: CHANNEL,
    guildId: GUILD,
    type: 0,
    permissionsFor: (principal: { id: string }) =>
      new PermissionsBitField(
        hidden.has(principal.id) ? 0n : noHistory.has(principal.id) ? P.ViewChannel : P.Administrator,
      ),
  };
  let fetches = 0,
    changed = 0,
    currentTime = Date.now(),
    enabled = settings.enabled ?? true;
  let fetchHook: (() => Promise<void> | void) | undefined;
  const guild = {
    id: GUILD,
    name: 'Operator test server',
    ownerId: USER,
    members: {
      me: bot,
      fetchMe: async () => bot,
      fetch: async (input: string | { user: string }) => {
        await fetchHook?.();
        const id = typeof input === 'string' ? input : input.user;
        if (id !== USER && id !== BOT) throw new Error('Unknown member');
        return id === BOT ? bot : member;
      },
    },
    channels: { fetch: async (id: string) => (id === CHANNEL ? channel : null) },
  };
  Object.assign(member, { guild });
  Object.assign(bot, { guild });
  const client = {
    user: { id: BOT, username: 'Test bot' },
    ws: { ping: 8 },
    guilds: {
      fetch: async () => {
        fetches++;
        return guild;
      },
    },
  } as unknown as Client;
  const registry = new ActionRegistry();
  registry.register({
    id: 'example.read',
    category: 'example',
    risk: 'read',
    description: 'Read current value',
    schema: z.strictObject({}),
    userPermissions: [],
    botPermissions: [],
    execute: () => ({ changed }),
  });
  registry.register({
    id: 'example.change',
    category: 'example',
    risk: 'write',
    description: 'Change a reviewed value',
    schema: z.strictObject({ value: z.number().int().min(1).max(10) }),
    userPermissions: [P.ManageGuild],
    botPermissions: [],
    execute: (_ctx, input) => {
      changed += input.value;
      return { changed };
    },
  });
  registry.register({
    id: 'analytics.observed',
    category: 'analytics',
    risk: 'read',
    description: 'Observed aggregate data',
    schema: z.strictObject({ days: z.number().int() }),
    userPermissions: [P.ManageGuild],
    botPermissions: [],
    execute: () => [{ day: '2026-10-29', kind: 'messages', count: 4 }],
  });
  let dashboard: ReturnType<typeof createDashboard>;
  const server: Server = createServer((request, response) => {
    void dashboard
      .handle(request, response)
      .then((handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      })
      .catch(() => {
        response.writeHead(500);
        response.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const transport = `http://127.0.0.1:${port}`;
  const baseUrl = settings.baseUrl ?? transport;
  const operatorIds = [USER],
    guildIds = [GUILD];
  const options: DashboardOptions = {
    client,
    store,
    registry,
    operatorIds,
    guildIds,
    baseUrl,
    enabled: () => enabled,
    now: () => currentTime,
  };
  dashboard = createDashboard(options);
  dashboard.registerActions();
  const ctx = { client, guild, member, store, channelId: CHANNEL } as unknown as ActionContext;
  t.after(async () => {
    dashboard.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  async function raw(
    path: string,
    init: { method?: string; headers?: Record<string, string>; content?: string } = {},
  ) {
    return new Promise<{ status: number; headers: Headers; value: unknown }>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: init.method ?? 'GET',
          headers: { Host: new URL(baseUrl).host, ...init.headers },
        },
        (response) => {
          let content = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            content += chunk;
          });
          response.on('error', reject);
          response.on('end', () => {
            let value: unknown;
            try {
              value = JSON.parse(content);
            } catch {
              value = content;
            }
            const headers = new Headers();
            for (const [key, value] of Object.entries(response.headers))
              for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value])
                headers.append(key, item);
            resolve({ status: response.statusCode!, headers, value });
          });
        },
      );
      request.on('error', reject);
      request.end(init.content);
    });
  }
  async function magic() {
    const pending = await registry.request(ctx, 'dashboard.login', {});
    assert.equal(pending.status, 'confirmation');
    if (pending.status !== 'confirmation') throw new Error('Expected confirmation');
    const completed = await registry.confirm(ctx, pending.id);
    assert.equal(completed.status, 'completed');
    if (completed.status !== 'completed') throw new Error('Expected completion');
    return completed.result as { url: string; expiresAt: number };
  }
  async function login() {
    const link = await magic(),
      url = new URL(link.url);
    const response = await raw(`${url.pathname}${url.search}`);
    assert.equal(response.status, 303);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const bootstrap = await raw('/dashboard/api/bootstrap', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: new URL(baseUrl).origin,
        'Content-Type': 'application/json',
        'X-Dashboard-Request': '1',
      },
      content: '{}',
    });
    assert.equal(bootstrap.status, 200);
    const state = bootstrap.value as { csrf: string };
    return { cookie, csrf: state.csrf, link, response };
  }
  const api = (
    credentials: { cookie: string; csrf: string },
    route: string,
    input: unknown = {},
    extra: Record<string, string> = {},
  ) =>
    raw(`/dashboard/api/${route}`, {
      method: 'POST',
      headers: {
        Cookie: credentials.cookie,
        Origin: new URL(baseUrl).origin,
        'Content-Type': 'application/json',
        'X-Dashboard-Request': '1',
        'X-CSRF-Token': credentials.csrf,
        ...extra,
      },
      content: JSON.stringify(input),
    });
  return {
    store,
    registry,
    dashboard,
    options,
    ctx,
    raw,
    magic,
    login,
    api,
    member,
    bot,
    hidden,
    noHistory,
    operatorIds,
    guildIds,
    transport,
    baseUrl,
    changed: () => changed,
    fetches: () => fetches,
    setFetchHook: (hook?: () => Promise<void> | void) => {
      fetchHook = hook;
    },
    advance: (ms: number) => {
      currentTime += ms;
    },
    enable: (value: boolean) => {
      enabled = value;
    },
  };
}

test('dashboard defaults to explicit hosting enablement and exposes no unauthenticated server data', async (t) => {
  const f = await fixture(t, { enabled: false });
  assert.equal((await f.raw('/dashboard')).status, 404);
  f.enable(true);
  const page = await f.raw('/dashboard');
  assert.equal(page.status, 200);
  assert.match(String(page.value), /Control room/);
  assert.equal(String(page.value).includes('Operator test server'), false);
  const response = await f.raw('/dashboard/api/bootstrap', {
    method: 'POST',
    headers: { Origin: f.baseUrl, 'Content-Type': 'application/json', 'X-Dashboard-Request': '1' },
    content: '{}',
  });
  assert.equal(response.status, 401);
  assert.equal(f.fetches(), 0);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('confirmed Discord login uses one-use expiring credentials and clears the query on redirect', async (t) => {
  const f = await fixture(t),
    state = await f.login();
  assert.equal(new URL(state.link.url).searchParams.get('token')?.length, 43);
  assert.equal(state.response.headers.get('location'), '/dashboard');
  assert.match(state.response.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict; Max-Age=900/);
  assert.equal(state.response.headers.get('referrer-policy'), 'no-referrer');
  const reused = await f.raw(new URL(state.link.url).pathname + new URL(state.link.url).search);
  assert.equal(reused.status, 401);
  const expired = await f.magic();
  f.advance(120001);
  assert.equal((await f.raw(new URL(expired.url).pathname + new URL(expired.url).search)).status, 401);
  assert.equal(f.store.list('dashboard.sessions').length + f.store.list('dashboard.links').length, 0);
});

test('all API calls require the exact origin, POST, custom header, cookie and per-session CSRF', async (t) => {
  const f = await fixture(t),
    state = await f.login();
  assert.equal((await f.api(state, 'status', {}, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.api(state, 'status', {}, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await f.api(state, 'status', {}, { 'X-Dashboard-Request': '0' })).status, 403);
  assert.equal((await f.raw('/dashboard/api/status', { headers: { Cookie: state.cookie } })).status, 405);
  assert.equal((await f.raw('/dashboard', { headers: { Host: 'attacker.example' } })).status, 421);
  const status = await f.api(state, 'status');
  assert.equal(status.status, 200);
  assert.equal((status.value as { bot: string }).bot, 'Test bot');
  assert.equal(status.headers.get('cache-control'), 'no-store');
});

test('HTTPS sessions use Secure cookies and insecure remote origins are rejected', async (t) => {
  const f = await fixture(t, { baseUrl: 'https://dashboard.example.test' }),
    state = await f.login();
  assert.match(state.response.headers.get('set-cookie')!, /^__Secure-discord_dashboard=/);
  assert.match(state.response.headers.get('set-cookie')!, /; Secure$/);
  assert.throws(() => createDashboard({ ...f.options, baseUrl: 'http://dashboard.example.test' }), /HTTPS/);
  assert.throws(() => createDashboard({ ...f.options, baseUrl: 'https://user:pass@example.test' }), /HTTPS/);
});

test('action requests retain the exact registry preview and only that session can confirm it once', async (t) => {
  const f = await fixture(t),
    state = await f.login();
  const schema = await f.api(state, 'schema', { action: 'example.change' });
  assert.equal(schema.status, 200);
  const requested = await f.api(state, 'request', { action: 'example.change', input: { value: 3 } });
  const preview = requested.value as {
    id: string;
    action: string;
    input: unknown;
    previewHash: string;
    status: string;
  };
  assert.equal(preview.status, 'confirmation');
  assert.deepEqual(preview.input, { value: 3 });
  assert.equal(f.changed(), 0);
  assert.equal((await f.api(state, 'confirm', { id: preview.id, previewHash: '0'.repeat(64) })).status, 403);
  const confirmed = await f.api(state, 'confirm', { id: preview.id, previewHash: preview.previewHash });
  assert.equal(confirmed.status, 200);
  assert.equal(f.changed(), 3);
  assert.equal(
    (await f.api(state, 'confirm', { id: preview.id, previewHash: preview.previewHash })).status,
    403,
  );
  const read = await f.api(state, 'request', { action: 'example.read', input: {} });
  assert.equal((read.value as { status: string }).status, 'completed');
});

test('dashboard confirmation cannot consume a Discord-only preview or one from a replaced session', async (t) => {
  const f = await fixture(t),
    first = await f.login();
  const discord = await f.registry.request(f.ctx, 'example.change', { value: 2 });
  assert.equal(discord.status, 'confirmation');
  if (discord.status !== 'confirmation') return;
  assert.equal((await f.api(first, 'confirm', { id: discord.id, previewHash: '0'.repeat(64) })).status, 403);
  const request = await f.api(first, 'request', { action: 'example.change', input: { value: 4 } });
  const preview = request.value as { id: string; previewHash: string };
  const second = await f.login();
  assert.equal(
    (await f.api(second, 'confirm', { id: preview.id, previewHash: preview.previewHash })).status,
    403,
  );
  assert.equal((await f.api(first, 'status')).status, 401);
  assert.equal(f.changed(), 0);
});

test('fresh operator, server, manager, channel and action policy are rechecked on API calls', async (t) => {
  for (const changed of ['operator', 'guild', 'manager', 'channel', 'history', 'policy', 'feature']) {
    const f = await fixture(t),
      state = await f.login();
    if (changed === 'operator') f.operatorIds.splice(0);
    if (changed === 'guild') f.guildIds.splice(0, 1, '550000000000000099');
    if (changed === 'manager') f.member.permissions = new PermissionsBitField(0n);
    if (changed === 'channel') f.hidden.add(USER);
    if (changed === 'history') f.noHistory.add(BOT);
    if (changed === 'policy')
      f.store.set('core.actionPolicies', `${GUILD}:dashboard.login`, {
        enabled: false,
        roleIds: [],
        channelIds: [],
      });
    if (changed === 'feature') f.store.set('core.featureEpochs', `${GUILD}:dashboard`, 2);
    assert.ok([401, 403].includes((await f.api(state, 'status')).status), changed);
  }
});

test('current registry action policy still applies on confirmation after preview', async (t) => {
  const f = await fixture(t),
    state = await f.login();
  const requested = await f.api(state, 'request', { action: 'example.change', input: { value: 6 } });
  const preview = requested.value as { id: string; previewHash: string };
  f.store.set('core.actionPolicies', `${GUILD}:example.change`, {
    enabled: false,
    roleIds: [],
    channelIds: [],
  });
  assert.equal(
    (await f.api(state, 'confirm', { id: preview.id, previewHash: preview.previewHash })).status,
    403,
  );
  assert.equal(f.changed(), 0);
});

test('non-configured application owners are refreshed before dashboard authorization', async (t) => {
  const f = await fixture(t);
  f.operatorIds.splice(0);
  let owner = USER,
    reads = 0;
  const application = {
    owner: { id: USER },
    fetch: async () => {
      reads++;
      application.owner = { id: owner };
      return application;
    },
  };
  Object.assign(f.options.client, { application });
  const state = await f.login();
  assert.ok(reads >= 2);
  owner = '550000000000000099';
  assert.equal((await f.api(state, 'status')).status, 403);
});

test('generated files have authenticated downloads, safe names and repeat delivery until expiry', async (t) => {
  const f = await fixture(t),
    state = await f.login();
  const data = Buffer.from('generated contents');
  data.toJSON = () => {
    throw new Error('Buffer.toJSON must not allocate a numeric array');
  };
  f.registry.register({
    id: 'example.file',
    category: 'example',
    risk: 'read',
    description: 'Generate a file',
    schema: z.strictObject({}),
    userPermissions: [],
    botPermissions: [],
    execute: () => ({ attachment: data, name: '../../unsafe\r\n"name.txt' }),
  });
  const result = await f.api(state, 'request', { action: 'example.file', input: {} });
  assert.equal(result.status, 200);
  const file = (result.value as { result: { download: { url: string; name: string; bytes: number } } }).result
    .download;
  assert.equal(file.bytes, data.length);
  assert.match(file.url, /^\/dashboard\/file\/[A-Za-z0-9_-]{43}$/);
  const headers = { Cookie: state.cookie, Origin: f.baseUrl };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await f.raw(file.url, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.value, 'generated contents');
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.match(response.headers.get('content-disposition')!, /^attachment; filename="[A-Za-z0-9._-]+"$/);
  }
  assert.equal(
    (await f.raw(file.url, { headers: { ...headers, Origin: 'https://other.example' } })).status,
    403,
  );
  assert.equal((await f.raw(file.url, { headers: { Origin: f.baseUrl } })).status, 401);
  f.advance(120001);
  assert.equal((await f.raw(file.url, { headers })).status, 404);
});

test('file downloads cannot cross sessions and their count and total bytes remain bounded', async (t) => {
  const f = await fixture(t),
    first = await f.login();
  f.registry.register({
    id: 'example.file',
    category: 'example',
    risk: 'read',
    description: 'Generate bounded files',
    schema: z.strictObject({
      size: z
        .number()
        .int()
        .min(1)
        .max(25 * 1048576)
        .default(10),
    }),
    userPermissions: [],
    botPermissions: [],
    execute: (_ctx, input) => ({ attachment: Buffer.alloc(input.size), name: 'example.bin' }),
  });
  const create = async (size = 10) => {
    const response = await f.api(first, 'request', { action: 'example.file', input: { size } });
    assert.equal(response.status, 200);
    return (response.value as { result: { download: { url?: string; unavailable?: string } } }).result
      .download;
  };
  const files = [];
  for (let index = 0; index < 4; index++) files.push(await create());
  const headers = { Cookie: first.cookie, Origin: f.baseUrl };
  assert.equal((await f.raw(files[0]!.url!, { headers })).status, 404);
  assert.equal((await f.raw(files[3]!.url!, { headers })).status, 200);
  const large = await create(13 * 1048576);
  await create(13 * 1048576);
  assert.equal((await f.raw(large.url!, { headers })).status, 404);
  const oversized = await create(25 * 1048576);
  assert.equal(oversized.url, undefined);
  assert.match(oversized.unavailable!, /limit/);
  const second = await f.login();
  assert.equal(
    (await f.raw(files[3]!.url!, { headers: { Cookie: second.cookie, Origin: f.baseUrl } })).status,
    404,
  );
});

test('sessions expire, logout invalidates them and restarts cannot reuse their credentials', async (t) => {
  const f = await fixture(t),
    first = await f.login();
  assert.equal((await f.api(first, 'logout')).status, 200);
  assert.equal((await f.api(first, 'status')).status, 401);
  const second = await f.login();
  f.advance(900001);
  assert.equal((await f.api(second, 'status')).status, 401);
  const third = await f.login();
  f.dashboard.close();
  const restarted = createDashboard(f.options);
  const response = await new Promise<{ status: number }>((resolve) => {
    const server = createServer((request, result) => {
      void restarted.handle(request, result);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: address.port,
          path: '/dashboard/api/bootstrap',
          method: 'POST',
          headers: {
            Host: new URL(f.baseUrl).host,
            Origin: f.baseUrl,
            Cookie: third.cookie,
            'Content-Type': 'application/json',
            'X-Dashboard-Request': '1',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            server.close();
            resolve({ status: res.statusCode! });
          });
        },
      );
      req.end('{}');
    });
  });
  restarted.close();
  assert.equal(response.status, 401);
});

test('analytics are aggregate registry reads and login cannot be minted through the browser API', async (t) => {
  const f = await fixture(t),
    state = await f.login();
  const result = await f.api(state, 'analytics');
  assert.deepEqual(result.value, {
    available: true,
    points: [{ day: '2026-10-29', kind: 'messages', count: 4 }],
  });
  f.store.set('core.disabled', GUILD, ['analytics']);
  assert.deepEqual((await f.api(state, 'analytics')).value, { available: false, points: [] });
  assert.equal((await f.api(state, 'request', { action: 'dashboard.login', input: {} })).status, 403);
  const listed = (await f.api(state, 'actions')).value as { id: string }[];
  assert.equal(
    listed.some((row) => row.id === 'dashboard.login'),
    false,
  );
});

test('body types and size are bounded, while raw server/provider error details remain private', async (t) => {
  const f = await fixture(t),
    state = await f.login();
  assert.equal((await f.api(state, 'status', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(
    (await f.api(state, 'request', { action: 'example.read', input: { content: 'x'.repeat(66000) } })).status,
    413,
  );
  const response = await f.raw('/dashboard/api/status', {
    method: 'POST',
    headers: {
      Cookie: state.cookie,
      Origin: f.baseUrl,
      'X-Dashboard-Request': '1',
      'X-CSRF-Token': state.csrf,
      'Content-Type': 'application/json',
    },
    content: '{broken',
  });
  assert.equal(response.status, 400);
  f.setFetchHook(() => {
    throw new Error('SENSITIVE raw provider body');
  });
  const privateError = await f.api(state, 'status');
  assert.equal(privateError.status, 503);
  assert.equal(JSON.stringify(privateError.value).includes('SENSITIVE'), false);
});

test('dashboard admits at most 32 concurrent requests while Discord authorization is waiting', async (t) => {
  const f = await fixture(t),
    state = await f.login();
  let arrived = 0,
    ready!: () => void,
    release!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setFetchHook(async () => {
    arrived++;
    if (arrived === 32) ready();
    await waiting;
  });
  const admitted = Array.from({ length: 32 }, () => f.api(state, 'status'));
  try {
    await started;
    assert.equal((await f.api(state, 'status')).status, 503);
  } finally {
    release();
    f.setFetchHook(undefined);
  }
  assert.equal(
    (await Promise.all(admitted)).every((response) => response.status === 200),
    true,
  );
});

test('an incomplete body hits an absolute deadline even when the connection stays open', async (t) => {
  const f = await fixture(t),
    state = await f.login(),
    target = new URL(f.transport);
  const result = await new Promise<{ status: number; content: string }>((resolve, reject) => {
    const request = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: '/dashboard/api/status',
        method: 'POST',
        headers: {
          Host: new URL(f.baseUrl).host,
          Origin: f.baseUrl,
          Cookie: state.cookie,
          'Content-Type': 'application/json',
          'X-Dashboard-Request': '1',
          'X-CSRF-Token': state.csrf,
          'Content-Length': '100',
        },
      },
      (response) => {
        let content = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          content += chunk;
        });
        response.on('end', () => {
          request.destroy();
          resolve({ status: response.statusCode!, content });
        });
      },
    );
    request.on('error', reject);
    request.write('{');
  });
  assert.equal(result.status, 408);
  assert.match(result.content, /deadline/);
});

test('the buildless page applies a CSP nonce and never inserts API values as HTML', () => {
  const nonce = 'a'.repeat(43),
    html = dashboardPage(nonce);
  assert.match(html, new RegExp(`<script nonce="${nonce}">`));
  assert.equal(html.includes('innerHTML'), false);
  assert.equal(html.includes('https://'), false);
  assert.match(html, /setInterval\(.*30000\)/);
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
  assert.throws(() => dashboardPage('unsafe"'), /Invalid/);
});

/** Small DOM surface for executing the shipped page without adding a browser dependency. */
class PageNode {
  textContent = '';
  value = '';
  hidden = false;
  disabled = false;
  readOnly = false;
  className = '';
  type = '';
  title = '';
  href = '';
  download = '';
  rel = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: PageNode[] = [];
  classList = { toggle: (_name: string, _enabled: boolean) => undefined };
  private listeners = new Map<string, (() => unknown)[]>();
  addEventListener(event: string, listener: () => unknown) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  async dispatch(event: string) {
    for (const listener of this.listeners.get(event) ?? []) await listener();
  }
  append(...children: PageNode[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: PageNode[]) {
    this.children = children;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  scrollIntoView() {}
}

async function pageFixture() {
  const html = dashboardPage('a'.repeat(43));
  const nodes = new Map<string, PageNode>();
  for (const match of html.matchAll(/<[a-z][\w-]*\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = new PageNode();
    node.hidden = /\bhidden\b/.test(match[0]);
    node.disabled = /\bdisabled\b/.test(match[0]);
    const text = html.slice(match.index! + match[0].length).split('<')[0]!;
    node.textContent = text;
    node.value = match[0].startsWith('<textarea') ? text : '';
    nodes.set(match[1]!, node);
  }
  const nav = ['overview', 'console', 'notes'].map((name) => {
    const node = new PageNode();
    node.dataset.view = name;
    return node;
  });
  const node = (id: string) => {
    const found = nodes.get(id);
    assert.ok(found, `Page node ${id} must exist`);
    return found;
  };
  const definitions = [
    {
      id: 'private.export',
      category: 'private',
      description: 'Private data export',
      risk: 'read',
      available: true,
    },
    {
      id: 'private.change',
      category: 'private',
      description: 'Private change',
      risk: 'write',
      available: true,
    },
  ];
  let rejectedRoute = '',
    delayRoute = '',
    release: (() => void) | undefined;
  const requests: { route: string; headers: Record<string, string> }[] = [];
  const fetch = async (url: string, options: { headers: Record<string, string>; body: string }) => {
    const route = url.slice('/dashboard/api/'.length);
    requests.push({ route, headers: options.headers });
    if (route === delayRoute)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    const input = JSON.parse(options.body);
    let body: unknown;
    if (route === rejectedRoute) body = { error: 'Sign-in required.' };
    else if (route === 'bootstrap')
      body = {
        csrf: 'former-session-secret',
        user: { id: USER, name: 'Former private operator' },
        guild: { id: GUILD, name: 'Former private server' },
        channelId: CHANNEL,
        expiresAt: Date.now() + 60000,
      };
    else if (route === 'actions') body = definitions;
    else if (route === 'schema') {
      const action = definitions.find((item) => item.id === input.action)!;
      body = {
        ...action,
        action: action.id,
        schema: { secretSchema: 'former schema data' },
        userPermissions: [],
        botPermissions: [],
      };
    } else if (route === 'status')
      body = {
        gatewayLatencyMs: 42,
        uptimeSeconds: 900,
        actionCount: 2,
        bot: 'Former private bot',
        memoryMiB: 100,
        disabledCategories: ['former-paused-module'],
      };
    else if (route === 'analytics')
      body = {
        available: true,
        points: [{ day: new Date().toISOString().slice(0, 10), kind: 'messages', count: 17 }],
      };
    else if (route === 'request')
      body =
        input.action === 'private.change'
          ? {
              status: 'confirmation',
              id: 'former-preview-id',
              previewHash: 'former-preview-hash',
              action: input.action,
              input: input.input,
              expiresAt: Date.now() + 60000,
            }
          : {
              status: 'completed',
              result: {
                secret: 'former export data',
                download: {
                  url: '/dashboard/file/' + 'b'.repeat(43),
                  name: 'former-private-file.txt',
                  bytes: 10,
                },
              },
            };
    else body = { status: 'completed' };
    return {
      status: route === rejectedRoute ? 401 : 200,
      ok: route !== rejectedRoute,
      json: async () => body,
    };
  };
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)![1]!;
  new Script(script).runInNewContext({
    document: {
      hidden: false,
      getElementById: node,
      createElement: () => new PageNode(),
      querySelectorAll: () => nav,
      addEventListener: () => undefined,
    },
    fetch,
    setInterval: () => undefined,
  });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  await flush();
  return {
    node,
    flush,
    requests,
    reject: (route: string) => {
      rejectedRoute = route;
    },
    delay: (route: string) => {
      delayRoute = route;
    },
    release: () => {
      assert.ok(release);
      release();
    },
    choose: async (id: string) => {
      const button = node('action-list').children.find((item) => item.children[0]?.textContent === id);
      assert.ok(button);
      await button.dispatch('click');
    },
  };
}

function assertClearedPage(f: Awaited<ReturnType<typeof pageFixture>>) {
  assert.equal(f.node('workspace').hidden, true);
  assert.equal(f.node('login').hidden, false);
  assert.equal(f.node('logout').hidden, true);
  assert.equal(f.node('server-name').textContent, 'Your server');
  assert.equal(f.node('server-access').textContent, 'Private operator access');
  assert.equal(f.node('signed-user').textContent, 'Private session');
  assert.equal(f.node('session-status').textContent, 'SIGN-IN REQUIRED');
  for (const id of [
    'latency',
    'uptime',
    'action-count',
    'bot-name',
    'memory',
    'channel-id',
    'paused',
    'expires',
  ])
    assert.equal(f.node(id).textContent, '—', id);
  assert.equal(f.node('json-input').value, '{}');
  assert.equal(f.node('json-input').readOnly, false);
  assert.equal(f.node('search').value, '');
  assert.equal(f.node('category').value, '');
  assert.equal(f.node('category').children.length, 1);
  for (const id of ['action-list', 'downloads', 'chart', 'chart-days'])
    assert.equal(f.node(id).children.length, 0, id);
  assert.equal(f.node('selected-name').textContent, 'Choose an action');
  assert.equal(f.node('schema').textContent, 'Select an action from the list.');
  assert.equal(f.node('confirmation').hidden, true);
  assert.equal(f.node('preview').textContent, '');
  assert.equal(f.node('preview-expiry').textContent, '');
  assert.equal(f.node('request-action').disabled, true);
  assert.equal(f.node('output').textContent.includes('former'), false);
}

test('the real page script clears identity, exported results and downloads after sign-out', async () => {
  const f = await pageFixture();
  assert.equal(f.node('server-name').textContent, 'Former private server');
  await f.choose('private.export');
  await f.node('request-action').dispatch('click');
  assert.match(f.node('output').textContent, /former export data/);
  assert.equal(f.node('downloads').children.length, 1);
  f.node('json-input').value = '{"sensitive":"former input"}';
  await f.node('logout').dispatch('click');
  assertClearedPage(f);
  // Filtering after reset must not rediscover a retained catalog, nor can hidden buttons submit it.
  await f.node('search').dispatch('input');
  assert.equal(f.node('action-list').children.length, 0);
  const before = f.requests.length;
  await f.node('request-action').dispatch('click');
  assert.equal(f.requests.length, before);
});

test('HTTP 401 clears the real page pending review and drops a late successful schema response', async () => {
  const f = await pageFixture();
  await f.choose('private.change');
  f.node('json-input').value = '{"sensitive":"former preview data"}';
  await f.node('request-action').dispatch('click');
  assert.match(f.node('preview').textContent, /former preview data/);
  assert.equal(f.node('confirmation').hidden, false);
  f.reject('cancel');
  await f.node('cancel-action').dispatch('click');
  assertClearedPage(f);
  const before = f.requests.length;
  await f.node('confirm-action').dispatch('click');
  assert.equal(f.requests.length, before);

  // Another signed-in page has an unresolved read when logout completes.
  const delayed = await pageFixture();
  delayed.delay('schema');
  const selecting = delayed.choose('private.export');
  await delayed.flush();
  await delayed.node('logout').dispatch('click');
  delayed.release();
  await selecting;
  assertClearedPage(delayed);
});
