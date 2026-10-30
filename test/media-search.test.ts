import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import sharp from 'sharp';
import { PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import { userRequestContext, type ActionContext } from '../src/core/types.js';
import {
  MediaSearchService,
  registerMediaSearchActions,
  commonsUploadUrl,
  metadataText,
  MEDIA_SEARCH_LIMITS,
} from '../src/features/media-search.js';
import type { PublicTransport, PinnedRequest, PublicResponse } from '../src/features/integrations.js';
const G = '500000000000000001',
  U = '500000000000000002',
  B = '500000000000000003',
  C = '500000000000000004';
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const sent: Record<string, unknown>[] = [];
  let access = true,
    thread = false,
    failSend = false;
  const member = { id: U, permissions: new PermissionsBitField(P.Administrator) },
    bot = { id: B, permissions: new PermissionsBitField(P.Administrator) };
  const channel = {
    id: C,
    guildId: G,
    type: 0,
    isTextBased: () => true,
    isThread: () => thread,
    permissionsFor: () =>
      new PermissionsBitField(
        access
          ? [
              P.ViewChannel,
              P.ReadMessageHistory,
              P.AttachFiles,
              P.EmbedLinks,
              thread ? P.SendMessagesInThreads : P.SendMessages,
            ]
          : [],
      ),
    send: async (payload: Record<string, unknown>) => {
      sent.push(payload);
      if (failSend) throw new Error('ambiguous HTTP failure');
      return { id: 'sent-message' };
    },
  };
  const guild = {
    id: G,
    members: { me: bot, fetch: async () => member, fetchMe: async () => bot },
    channels: { fetch: async () => channel },
  };
  return {
    ctx: { store, member, guild, channelId: C } as unknown as ActionContext,
    sent,
    setAccess: (value: boolean) => {
      access = value;
    },
    setThread: () => {
      thread = true;
    },
    failSend: () => {
      failSend = true;
    },
  };
}
function page(mime = 'image/png', extra: Record<string, unknown> = {}) {
  return {
    pageid: 1,
    title: 'File:Sample image.png',
    imageinfo: [
      {
        url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Sample_image.png',
        size: 100,
        width: 32,
        height: 16,
        mime,
        extmetadata: {
          Artist: { value: '<a href="https://example.com">Author &amp; Friend</a>' },
          Credit: { value: 'Provided by source' },
          LicenseShortName: { value: 'CC BY-SA 4.0' },
        },
        ...extra,
      },
    ],
  };
}
async function transport(pages: unknown[] = [page()]) {
  const png = await sharp({ create: { width: 32, height: 16, channels: 4, background: '#ff0000' } })
    .png()
    .toBuffer();
  const connections: PinnedRequest[] = [];
  let download: ((options: PinnedRequest) => Promise<PublicResponse>) | undefined;
  const driver: PublicTransport = {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    connect: async (options) => {
      connections.push(options);
      if (options.url.hostname === 'commons.wikimedia.org')
        return {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: Buffer.from(JSON.stringify({ query: { pages } })),
        };
      return download
        ? download(options)
        : { status: 200, headers: { 'content-type': 'image/png' }, body: png };
    },
  };
  return {
    driver,
    connections,
    png,
    setDownload: (fn: typeof download) => {
      download = fn;
    },
  };
}
interface Search {
  searchId: string;
  results: {
    title: string;
    source: string;
    artist: string;
    mime: string;
    send: { searchId: string; index: number; title: string };
  }[];
}

test('A search remains bound to its origin while a direct selected-media send resolves the requested destination', async (t) => {
  const f = fixture(t),
    provider = await transport(),
    service = new MediaSearchService({ transport: provider.driver });
  const targetId = '500000000000000005';
  const origin = await f.ctx.guild.channels.fetch(C);
  assert(origin);
  let destination = '';
  const target = {
    ...origin,
    id: targetId,
    send: async () => {
      destination = targetId;
      return { id: 'target-message' };
    },
  };
  f.ctx.guild.channels.fetch = (async (id: string) =>
    id === targetId ? target : origin) as typeof f.ctx.guild.channels.fetch;
  const found = (await service.search(f.ctx, 'bunny', 'image')) as Search;
  const result = (await service.send(f.ctx, { ...found.results[0]!.send, channelId: targetId })) as {
    channelId: string;
  };
  assert.equal(destination, targetId);
  assert.equal(result.channelId, targetId);
  await assert.rejects(
    service.send({ ...f.ctx, channelId: targetId }, found.results[0]!.send),
    /belongs to another user\/channel/,
  );
});

test('A voice request cancelled during media download cannot post a late image', async (t) => {
  const f = fixture(t),
    provider = await transport(),
    service = new MediaSearchService({ transport: provider.driver });
  let valid = true;
  const ctx = userRequestContext(f.ctx, 'voice', { valid: () => valid });
  const found = (await service.search(ctx, 'bunny', 'image')) as Search;
  provider.setDownload(async () => {
    valid = false;
    return { status: 200, headers: { 'content-type': 'image/png' }, body: provider.png };
  });
  await assert.rejects(service.send(ctx, found.results[0]!.send), /expired|cancelled/);
  assert.equal(f.sent.length, 0);
});
test('media search registers provider-selectable reads and one confirmed write with no arbitrary URL substitution', () => {
  const registry = new ActionRegistry();
  registerMediaSearchActions(registry);
  assert.equal(registry.list().length, 3);
  assert.equal(registry.get('media.search-send').risk, 'write');
  assert.throws(() => registry.get('image.search').schema.parse({ query: '' }));
  assert.throws(() =>
    registry
      .get('media.search-send')
      .schema.parse({ searchId: 'aaaaaaaaaaaaaaaa', index: 1, title: 'x', url: 'https://evil.test/' }),
  );
  for (const url of [
    'https://upload.wikimedia.org.evil.test/wikipedia/commons/a',
    'http://upload.wikimedia.org/wikipedia/commons/a',
    'https://upload.wikimedia.org/private',
    'https://upload.wikimedia.org/wikipedia/commons/a?redirect=evil',
    'file:///secret',
  ])
    assert.throws(() => commonsUploadUrl(url));
  assert.equal(metadataText('<b>Hello</b> &amp; &#x1f600; @everyone'), 'Hello & 😀 everyone');
  assert.equal(
    commonsUploadUrl(
      'https://upload.wikimedia.org/wikipedia/commons/a/ab/Cat.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original',
    ),
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Cat.jpg',
  );
});

test('KLIPY official GIF format preserves provider order/URLs, posts to the destination, and reports one share without exposing Discord IDs', async (t) => {
  const f = fixture(t),
    connections: PinnedRequest[] = [],
    shares: { url: string; init?: RequestInit }[] = [];
  const provider: PublicTransport = {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    connect: async (request) => {
      connections.push(request);
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            result: true,
            data: {
              data: Array.from({ length: 8 }, (_, i) => ({
                slug: `hello-${i}`,
                title: `Hello ${i}`,
                file: {
                  md: {
                    gif: {
                      url: `https://static.klipy.com/media/hello-${i}.gif?delivery=keep`,
                      width: 200,
                      height: 100,
                      size: 20000,
                    },
                  },
                },
              })),
            },
          }),
        ),
      };
    },
  };
  const service = new MediaSearchService({
    klipyApiKey: 'synthetic-klipy-example',
    klipyBotApproved: true,
    transport: provider,
    shareFetch: (async (url, init) => {
      shares.push({ url: String(url), init });
      return new Response('{}', { status: 200 });
    }) as typeof fetch,
  });
  const found = (await service.search(f.ctx, 'hello', 'gif')) as Search;
  assert.equal(found.results.length, 8);
  assert.equal(found.results[7]!.title, 'Hello 7');
  assert.equal(connections[0]!.url.hostname, 'api.klipy.com');
  assert.equal(connections[0]!.url.searchParams.get('per_page'), '8');
  assert.equal(connections[0]!.url.searchParams.get('format_filter'), 'gif');
  assert.equal(connections[0]!.url.searchParams.get('content_filter'), 'high');
  assert(!connections[0]!.url.href.includes(U));
  await service.send(f.ctx, found.results[7]!.send);
  assert.equal(connections.length, 1, 'provider media stays at its direct URL, never downloaded/rehosted');
  assert.match(String(f.sent[0]!.content), /https:\/\/static\.klipy\.com\/media\/hello-7.gif\?delivery=keep/);
  assert.deepEqual(f.sent[0]!.files, []);
  assert.equal(shares.length, 1);
  assert.equal(shares[0]!.init!.method, 'POST');
  assert(!String(shares[0]!.init!.body).includes(U));
  assert.match(String(shares[0]!.init!.body), /"q":"hello"/);
  await assert.rejects(service.send(f.ctx, found.results[7]!.send), /claimed/);
  assert.equal(shares.length, 1);
});

test('optional providers fail clearly when unconfigured or unapproved and never silently substitute another catalog', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const transport: PublicTransport = {
    resolve: async () => {
      calls++;
      return [];
    },
    connect: async () => {
      throw new Error('unexpected');
    },
  };
  const service = new MediaSearchService({ transport, klipyApiKey: 'synthetic-example' });
  await assert.rejects(service.search(f.ctx, 'hello', 'gif', 'klipy'), /KLIPY_BOT_APPROVED/);
  await assert.rejects(service.search(f.ctx, 'flower', 'image', 'pinterest'), /PINTEREST_ACCESS_TOKEN/);
  await assert.rejects(service.search(f.ctx, 'dance', 'gif', 'pinterest'), /no supported GIF-only/);
  assert.equal(calls, 0);
});

test('Pinterest uses only the official public partner endpoint and safe returned media, with authorization failures surfaced', async (t) => {
  const f = fixture(t),
    requests: PinnedRequest[] = [];
  let status = 200;
  const transport: PublicTransport = {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    connect: async (request) => {
      requests.push(request);
      return {
        status,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            items: [
              {
                id: '123456789',
                title: 'Public flower',
                media: {
                  media_type: 'image',
                  images: {
                    '600x': { url: 'https://i.pinimg.com/600x/aa/flower.jpg', width: 600, height: 800 },
                  },
                },
              },
              {
                id: '987654321',
                title: 'Invalid image',
                media: {
                  media_type: 'image',
                  images: {
                    orig: { url: 'https://i.pinimg.com.evil.test/private.jpg', width: 100, height: 100 },
                  },
                },
              },
            ],
          }),
        ),
      };
    },
  };
  const service = new MediaSearchService({
    pinterestAccessToken: 'synthetic-pinterest-example',
    pinterestCountryCode: 'US',
    transport,
  });
  const found = (await service.search(f.ctx, 'flower', 'image', 'pinterest')) as Search;
  assert.equal(found.results.length, 1);
  assert.equal(requests[0]!.url.pathname, '/v5/search/partner/pins');
  assert.equal(requests[0]!.url.searchParams.get('term'), 'flower');
  assert.equal(requests[0]!.url.searchParams.get('country_code'), 'US');
  assert.equal(requests[0]!.headers.Authorization, 'Bearer synthetic-pinterest-example');
  await service.send(f.ctx, found.results[0]!.send);
  assert.match(String(f.sent[0]!.content), /i\.pinimg\.com\/600x\/aa\/flower.jpg/);
  assert.equal(requests.length, 1);
  status = 403;
  await assert.rejects(service.search(f.ctx, 'other', 'image', 'pinterest'), /beta approval/);
  assert(requests.every((request) => request.url.pathname === '/v5/search/partner/pins'));
});

test('provider-link sends stop after fresh permission revocation and transport errors do not leak key-bearing URLs', async (t) => {
  const f = fixture(t),
    key = 'synthetic-private-provider-key';
  const transport: PublicTransport = {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    connect: async (request) => {
      throw new Error(`Failed ${request.url.href}`);
    },
  };
  const service = new MediaSearchService({ klipyApiKey: key, klipyBotApproved: true, transport });
  await assert.rejects(service.search(f.ctx, 'hello', 'gif', 'klipy'), (error) => {
    assert(!String(error).includes(key));
    return true;
  });
  const pinterest = new MediaSearchService({
    pinterestAccessToken: 'synthetic-pinterest-example',
    transport: {
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      connect: async () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            items: [
              {
                id: '12345',
                title: 'Public picture',
                media: {
                  media_type: 'image',
                  images: {
                    orig: { url: 'https://i.pinimg.com/originals/picture.png', width: 100, height: 100 },
                  },
                },
              },
            ],
          }),
        ),
      }),
    },
  });
  const found = (await pinterest.search(f.ctx, 'picture', 'image', 'pinterest')) as Search;
  f.setAccess(false);
  await assert.rejects(pinterest.send(f.ctx, found.results[0]!.send), /view|permission/);
  assert.equal(f.sent.length, 0);
});
test('official API query is fixed-host, filtered, cached, and result tokens are owner/channel scoped', async (t) => {
  const setup = fixture(t),
    mock = await transport(),
    service = new MediaSearchService({ transport: mock.driver });
  const first = (await service.search(setup.ctx, 'red panda', 'image')) as Search,
    second = (await service.search(setup.ctx, 'Red Panda', 'image')) as Search;
  assert.equal(mock.connections.length, 1);
  const request = mock.connections[0]!;
  assert.equal(request.url.hostname, 'commons.wikimedia.org');
  assert.equal(request.url.searchParams.get('gsrnamespace'), '6');
  assert.match(request.url.searchParams.get('gsrsearch')!, /filesize:<2048/);
  assert.equal(request.maxBytes, MEDIA_SEARCH_LIMITS.responseBytes);
  assert.notEqual(first.searchId, second.searchId);
  assert.equal(first.results[0]!.artist, 'Author & Friend');
  assert.match(first.results[0]!.source, /^https:\/\/commons.wikimedia.org\/wiki\/File/);
  const input = first.results[0]!.send;
  for (const ctx of [
    { ...setup.ctx, channelId: 'other' },
    { ...setup.ctx, guild: { ...setup.ctx.guild, id: 'other' } },
    { ...setup.ctx, member: { ...setup.ctx.member, id: 'other' } },
  ])
    await assert.rejects(service.send(ctx as ActionContext, input), /another user\/channel/);
  assert.equal(mock.connections.length, 1);
});
test('GIF search uses filemime filter and rejects non-GIF, SVG, private URLs, huge images and invalid dimensions', async (t) => {
  const setup = fixture(t),
    mock = await transport([
      page(),
      page('image/svg+xml'),
      page('image/gif', { url: 'https://evil.test/a.gif' }),
      page('image/gif', { size: 3000000 }),
      page('image/gif', { width: 40000 }),
      page('image/gif'),
    ]),
    service = new MediaSearchService({ transport: mock.driver });
  const result = (await service.search(setup.ctx, 'orbit', 'gif')) as Search;
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0]!.mime, 'image/gif');
  assert.match(mock.connections[0]!.url.searchParams.get('gsrsearch')!, /filemime:"image\/gif"/);
});
test('sending a selected real image requires registry confirmation and includes attribution once', async (t) => {
  const setup = fixture(t),
    mock = await transport(),
    registry = new ActionRegistry(120, async (ctx) => ctx);
  registerMediaSearchActions(registry, { transport: mock.driver });
  const found = await registry.request(setup.ctx, 'image.search', { query: 'image' });
  assert.equal(found.status, 'completed');
  const search = found.status === 'completed' ? (found.result as Search) : undefined;
  assert.ok(search);
  const pending = await registry.request(setup.ctx, 'media.search-send', search.results[0]!.send);
  assert.equal(pending.status, 'confirmation');
  assert.equal(setup.sent.length, 0);
  assert.equal(mock.connections.length, 1);
  if (pending.status === 'confirmation') {
    await registry.confirm(setup.ctx, pending.id);
    await assert.rejects(registry.confirm(setup.ctx, pending.id));
  }
  assert.equal(setup.sent.length, 1);
  assert.match(String(setup.sent[0]!.content), /Artist: Author & Friend/);
  assert.match(String(setup.sent[0]!.content), /CC BY-SA 4.0/);
  assert.deepEqual(setup.sent[0]!.allowedMentions, { parse: [] });
  await assert.rejects(
    registry
      .request(setup.ctx, 'media.search-send', { ...search.results[0]!.send, title: 'tampered' })
      .then(async (pending) => {
        if (pending.status === 'confirmation') return registry.confirm(setup.ctx, pending.id);
      }),
    /unavailable/,
  );
  assert.equal(setup.sent.length, 1);
});
test('thread sending rechecks Send Messages in Threads and rejects revoked rights after a delayed download', async (t) => {
  const setup = fixture(t),
    mock = await transport(),
    service = new MediaSearchService({ transport: mock.driver });
  setup.setThread();
  const result = (await service.search(setup.ctx, 'thread', 'image')) as Search;
  await service.send(setup.ctx, result.results[0]!.send);
  assert.equal(setup.sent.length, 1);
  const other = (await service.search(setup.ctx, 'other', 'image')) as Search;
  let release!: () => void;
  mock.setDownload(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { status: 200, headers: { 'content-type': 'image/png' }, body: mock.png };
  });
  const pending = service.send(setup.ctx, other.results[0]!.send);
  for (let i = 0; i < 10 && !release; i++) await tick();
  setup.setAccess(false);
  release();
  await assert.rejects(pending, /view|permissions/);
  assert.equal(setup.sent.length, 1);
});
test('actual signature, content type and size are verified before send, and ambiguous sends are never retried', async (t) => {
  const setup = fixture(t),
    mock = await transport(),
    service = new MediaSearchService({ transport: mock.driver });
  const result = (await service.search(setup.ctx, 'invalid', 'image')) as Search;
  mock.setDownload(async () => ({
    status: 200,
    headers: { 'content-type': 'image/png' },
    body: Buffer.from('<svg><image href="file:///secret"/></svg>'),
  }));
  await assert.rejects(service.send(setup.ctx, result.results[0]!.send), /PNG, JPEG/);
  assert.deepEqual(setup.sent, []);
  mock.setDownload(async () => ({ status: 200, headers: { 'content-type': 'text/html' }, body: mock.png }));
  await assert.rejects(service.send(setup.ctx, result.results[0]!.send), /media type/);
  mock.setDownload(async () => ({
    status: 200,
    headers: { 'content-type': 'image/png' },
    body: Buffer.alloc(MEDIA_SEARCH_LIMITS.fileBytes + 1),
  }));
  await assert.rejects(service.send(setup.ctx, result.results[0]!.send), /too large/);
  mock.setDownload(undefined);
  setup.failSend();
  await assert.rejects(service.send(setup.ctx, result.results[0]!.send), /ambiguous/);
  await assert.rejects(service.send(setup.ctx, result.results[0]!.send), /claimed/);
  assert.equal(setup.sent.length, 1);
});
test('token expiry, persistent quotas and private DNS responses prevent sends/search growth', async (t) => {
  let now = 1;
  const setup = fixture(t),
    mock = await transport(),
    service = new MediaSearchService({ transport: mock.driver, now: () => now });
  const first = (await service.search(setup.ctx, 'one', 'image')) as Search;
  now += MEDIA_SEARCH_LIMITS.tokenMs + 1;
  await assert.rejects(service.send(setup.ctx, first.results[0]!.send), /expired/);
  for (let i = 0; i < 10; i++) await service.search(setup.ctx, 'cached', 'image');
  assert.equal(setup.ctx.store.list('media.search').length, 10);
  await assert.rejects(service.search(setup.ctx, 'overflow', 'image'), /limit/);
  const privateService = new MediaSearchService({
    transport: {
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      connect: async () => {
        throw new Error('must never connect');
      },
    },
  });
  now += MEDIA_SEARCH_LIMITS.tokenMs + 1;
  const newSetup = fixture(t);
  await assert.rejects(privateService.search(newSetup.ctx, 'loopback', 'image'), /private/);
});
