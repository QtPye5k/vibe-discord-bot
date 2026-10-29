import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, createServer, type Socket } from 'node:net';
import { PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { ActionRegistry } from '../src/core/registry.js';
import { Store } from '../src/core/store.js';
import type { ActionContext } from '../src/core/types.js';
import type { PinnedRequest, PublicTransport } from '../src/features/integrations.js';
import {
  PUBLIC_SERVICE_LIMITS,
  PublicService,
  buildGraphqlGet,
  connectMinecraft,
  decodeMinecraftStatus,
  encodeMinecraftVarInt,
  minecraftHandshake,
  registerPublicServiceActions,
  type MinecraftRequest,
  type MinecraftTransport,
  type PublicServiceOptions,
} from '../src/features/public-services.js';

const guildId = '600000000000000001',
  userId = '600000000000000002';
const address = { address: '93.184.216.34', family: 4 };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(t: TestContext, options: PublicServiceOptions = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const actor = { id: userId, permissions: new PermissionsBitField(P.ManageGuild) };
  const guild = { id: guildId, members: { fetch: async () => actor, fetchMe: async () => ({}) } };
  const ctx = { store, guild, member: actor, channelId: '600000000000000003' } as unknown as ActionContext;
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  registerPublicServiceActions(registry, options);
  return { ctx, store, actor, registry, service: new PublicService(options) };
}
function http(body: unknown, status = 200, contentType = 'application/json') {
  const requests: PinnedRequest[] = [];
  const hosts: string[] = [];
  const transport: PublicTransport = {
    resolve: async (host) => {
      hosts.push(host);
      return [address];
    },
    connect: async (options) => {
      requests.push(options);
      return {
        status,
        body: Buffer.isBuffer(body)
          ? body
          : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
        headers: { 'content-type': contentType },
      };
    },
  };
  return { transport, requests, hosts };
}
const fx = { date: '2026-10-28', base: 'EUR', quote: 'USD', rate: 1.1 };
const status = {
  version: { name: 'Java 1.21', protocol: 767 },
  players: { online: 2, max: 20 },
  description: { text: '§aHello ', extra: [{ text: '@everyone`' }, { text: ' world' }] },
};
function statusPacket(value: unknown = status): Buffer {
  const json = Buffer.from(JSON.stringify(value));
  const body = Buffer.concat([Buffer.from([0]), encodeMinecraftVarInt(json.length), json]);
  return Buffer.concat([encodeMinecraftVarInt(body.length), body]);
}
function minecraftDriver(packet = statusPacket()) {
  const requests: MinecraftRequest[] = [];
  const hosts: string[] = [];
  const driver: MinecraftTransport = {
    resolve: async (host) => {
      hosts.push(host);
      return [address];
    },
    connect: async (options) => {
      requests.push(options);
      return packet;
    },
  };
  return { driver, requests, hosts };
}

test('Currency uses the real Frankfurter v2 pair route with a dated reference-rate estimate and amount-independent cache', async () => {
  const mock = http(fx);
  let now = 0;
  const service = new PublicService({ http: mock.transport, now: () => now });
  const first = (await service.currency({
    base: ' eur ',
    quote: 'usd',
    amount: 10,
    date: '2026-10-28',
  })) as Record<string, unknown>;
  assert.equal(mock.requests[0]?.url.href, 'https://api.frankfurter.dev/v2/rate/eur/usd?date=2026-10-28');
  assert.equal(mock.requests[0]?.address, address.address);
  assert.equal(mock.requests[0]?.family, 4);
  assert.equal(mock.requests[0]?.maxBytes, 32768);
  assert.equal(mock.requests[0]?.headers.Accept, 'application/json');
  assert.equal(first.convertedEstimate, 11);
  assert.match(String(first.source), /Frankfurter v2/);
  const second = (await service.currency({
    base: 'EUR',
    quote: 'USD',
    amount: 20,
    date: '2026-10-28',
  })) as Record<string, unknown>;
  assert.equal(second.convertedEstimate, 22);
  assert.equal(mock.requests.length, 1);
  now += PUBLIC_SERVICE_LIMITS.fxCacheMs;
  await service.currency({ base: 'EUR', quote: 'USD', date: '2026-10-28' });
  assert.equal(mock.requests.length, 2);
});

test('Currency coalesces equivalent requests, handles identity locally and validates inputs before transport', async () => {
  const mock = http(fx),
    service = new PublicService({ http: mock.transport });
  await Promise.all([
    service.currency({ base: 'EUR', quote: 'USD' }),
    service.currency({ base: 'eur', quote: 'usd', amount: 7 }),
  ]);
  assert.equal(mock.requests.length, 1);
  const identity = (await service.currency({ base: 'USD', quote: 'USD', amount: 4 })) as Record<
    string,
    unknown
  >;
  assert.equal(identity.convertedEstimate, 4);
  assert.equal(mock.requests.length, 1);
  for (const input of [
    { base: 'ER', quote: 'USD' },
    { base: 'EUR', quote: '../USD' },
    { base: 'EUR', quote: 'USD', amount: -1 },
    { base: 'EUR', quote: 'USD', amount: Infinity },
    { base: 'EUR', quote: 'USD', amount: 1e13 },
    { base: 'EUR', quote: 'USD', date: '2026-02-30' },
    { base: 'EUR', quote: 'USD', date: '2026-1-2' },
  ])
    await assert.rejects(service.currency(input));
});

test('Currency rejects provider errors, mismatched pairs, invalid rate/date, unsafe DNS and malformed UTF-8 JSON', async () => {
  for (const mock of [
    http({ error: 'unsupported currency' }, 422),
    http(fx, 500),
    http(fx, 302),
    http(fx, 200, 'text/html'),
    http({ ...fx, quote: 'GBP' }),
    http({ ...fx, rate: 0 }),
    http({ ...fx, date: '2026-02-30' }),
    http('not-json'),
    http(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125])),
    http(Buffer.alloc(32769, 32)),
  ])
    await assert.rejects(new PublicService({ http: mock.transport }).currency({ base: 'EUR', quote: 'USD' }));
  const mock = http(fx);
  mock.transport.resolve = async () => [address, { address: '169.254.169.254', family: 4 }];
  await assert.rejects(
    new PublicService({ http: mock.transport }).currency({ base: 'EUR', quote: 'USD' }),
    /private/,
  );
  assert.equal(mock.requests.length, 0);
});

test('Currency pending and bounded cache slots are released after failures and evict the oldest entry', async () => {
  let fails = true,
    calls = 0;
  const mock = http(fx);
  mock.transport.connect = async (request) => {
    calls++;
    if (fails) throw new Error('synthetic failure');
    const requestedDate = request.url.searchParams.get('date') ?? fx.date;
    return {
      status: 200,
      body: Buffer.from(JSON.stringify({ ...fx, date: requestedDate })),
      headers: { 'content-type': 'application/json' },
    };
  };
  const service = new PublicService({ http: mock.transport });
  await assert.rejects(service.currency({ base: 'EUR', quote: 'USD' }), /synthetic/);
  fails = false;
  await service.currency({ base: 'EUR', quote: 'USD' });
  for (let i = 0; i < PUBLIC_SERVICE_LIMITS.cacheEntries; i++) {
    await service.currency({
      base: 'EUR',
      quote: 'USD',
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    });
  }
  await service.currency({ base: 'EUR', quote: 'USD' });
  assert.equal(calls, PUBLIC_SERVICE_LIMITS.cacheEntries + 3);
});

test('Currency permits four distinct in-flight requests, coalesces a duplicate and frees every pending slot on failure', async () => {
  const mock = http(fx),
    gate = deferred<void>();
  let calls = 0;
  mock.transport.connect = async () => {
    calls++;
    await gate.promise;
    throw new Error('synthetic transport failure');
  };
  const service = new PublicService({ http: mock.transport });
  const quotes = ['USD', 'GBP', 'CAD', 'AUD'];
  const jobs = quotes.map((quote) => service.currency({ base: 'EUR', quote }));
  jobs.push(service.currency({ base: 'EUR', quote: 'USD' }));
  await tick();
  assert.equal(calls, 4);
  await assert.rejects(service.currency({ base: 'EUR', quote: 'JPY' }), /busy/);
  const failures = jobs.map((job) => assert.rejects(job, /synthetic/));
  gate.resolve();
  await Promise.all(failures);
  mock.transport.connect = http(fx).transport.connect;
  await service.currency({ base: 'EUR', quote: 'USD' });
});

test('GraphQL GET preserves the exact query, variables, endpoint parameters and matching operation name', () => {
  const query = 'query Country($code: ID!) { country(code: $code) { name } }';
  const url = buildGraphqlGet({
    url: 'https://example.com/graphql?language=en',
    query,
    variables: { code: 'CA' },
    operationName: 'Country',
  });
  assert.equal(url.searchParams.get('query'), query);
  assert.equal(url.searchParams.get('variables'), '{"code":"CA"}');
  assert.equal(url.searchParams.get('operationName'), 'Country');
  assert.equal(url.searchParams.get('language'), 'en');
  assert.equal(
    buildGraphqlGet({
      url: 'https://example.com/graphql',
      query: '{ mutation: field(text: "subscription { }", items: []) } # mutation Ignored { nope }',
    }).searchParams.get('variables'),
    '{}',
  );
  buildGraphqlGet({
    url: 'https://example.com/graphql',
    query: 'fragment Part on Country { name } query Country { country(code: "CA") { ...Part } }',
    operationName: 'Country',
  });
});

test('GraphQL bounded operation parser rejects mutation, subscription, multiple operations and ambiguous documents', () => {
  for (const query of [
    'mutation { deleteEverything }',
    'subscription { events }',
    '{ one } mutation Hidden { two }',
    '{ one } # comment\rmutation Hidden { two }',
    'query One { one } query Two { two }',
    '{ one } { two }',
    '# comment only',
    'fragment Only on Thing { value }',
    'schema { query: Root }',
    'query Broken { value',
    'query Broken { field(text: "unterminated) }',
    'query Q { value } ) mutation Hidden { two }',
    'query Q { field(text: """block""") }',
    'query Q { value } fragment A on Thing { one } fragment A on Thing { two }',
    `{ ${'field {'.repeat(35)} value ${'}'.repeat(35)} }`,
  ])
    assert.throws(() => buildGraphqlGet({ url: 'https://example.com/graphql', query }), Error, query);
  assert.throws(
    () =>
      buildGraphqlGet({
        url: 'https://example.com/graphql',
        query: 'query Q { value }',
        operationName: 'Other',
      }),
    /operationName/,
  );
  assert.throws(
    () => buildGraphqlGet({ url: 'https://example.com/graphql', query: '{ value }', operationName: 'Q' }),
    /operationName/,
  );
});

test('GraphQL endpoints and variables reject SSRF URLs, parameter overrides, non-JSON values and size/depth excess', () => {
  for (const url of [
    'http://example.com/graphql',
    'https://127.1/graphql',
    'https://user:pass@example.com/graphql',
    'https://example.com:444/graphql',
    'https://example.com/graphql#fragment',
    'https://example.com/graphql?query={old}',
    'https://example.com/graphql?variables={}',
    'https://example.com/graphql?operationName=Old',
  ]) {
    assert.throws(() => buildGraphqlGet({ url, query: '{ value }' }));
  }
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  let deep: unknown = 1;
  for (let i = 0; i < 12; i++) deep = { nested: deep };
  for (const variables of [
    { bad: NaN },
    { bad: Infinity },
    { bad: undefined },
    { bad: () => 1 },
    { bad: new Date() },
    circular,
    { deep },
    { nodes: Array(1001).fill(1) },
    { text: 'x'.repeat(2001) },
  ]) {
    assert.throws(() =>
      buildGraphqlGet({ url: 'https://example.com/graphql', query: '{ value }', variables }),
    );
  }
  assert.throws(
    () =>
      buildGraphqlGet({
        url: 'https://example.com/graphql',
        query: `{ field(text: "${'é'.repeat(1500)}") }`,
      }),
    /4,096/,
  );
});

test('GraphQL requires a confirmation, Manage Server and an exact host allowlist before its pinned GET', async (t) => {
  const mock = http({ data: { value: 'ok' } });
  const f = fixture(t, { http: mock.transport });
  f.store.set('integration.hosts', guildId, ['example.com']);
  const input = { url: 'https://example.com/graphql', query: 'query Q { value }', operationName: 'Q' };
  const confirmation = await f.registry.request(f.ctx, 'integration.graphql-get', input);
  assert.equal(confirmation.status, 'confirmation');
  assert.equal(mock.requests.length, 0);
  if (confirmation.status !== 'confirmation') throw new Error('Expected confirmation');
  const result = await f.registry.confirm(f.ctx, confirmation.id);
  assert.equal(result.status, 'completed');
  assert.equal(mock.hosts.length, 1);
  assert.equal(mock.requests[0]?.address, address.address);
  assert.equal(mock.requests[0]?.url.searchParams.get('query'), input.query);
  assert.equal(mock.requests[0]?.headers.Accept, 'application/graphql-response+json, application/json');
  assert.equal(mock.requests[0]?.headers.Authorization, undefined);
  assert.equal(mock.requests[0]?.maxBytes, PUBLIC_SERVICE_LIMITS.jsonBytes);
  f.actor.permissions = new PermissionsBitField();
  await assert.rejects(f.service.graphql(f.ctx, input), /Manage Server/);
  f.actor.permissions = new PermissionsBitField(P.ManageGuild);
  f.store.set('integration.hosts', guildId, ['example.com.evil.test']);
  await assert.rejects(f.service.graphql(f.ctx, input), /allowlist/);
  f.store.set('integration.hosts', guildId, ['example.com']);
  f.store.set('core.disabled', guildId, ['integrations']);
  await assert.rejects(f.service.graphql(f.ctx, input), /disabled/);
  assert.equal(mock.requests.length, 1);
});

test('GraphQL rechecks fresh authority after DNS and rejects mixed public/private DNS without connecting', async (t) => {
  const mock = http({ data: { value: 'ok' } }),
    f = fixture(t, { http: mock.transport });
  const input = { url: 'https://example.com/graphql', query: '{ value }' };
  for (const reason of ['allowlist', 'permission', 'module', 'private']) {
    f.actor.permissions = new PermissionsBitField(P.ManageGuild);
    f.store.set('integration.hosts', guildId, ['example.com']);
    f.store.set('core.disabled', guildId, []);
    mock.transport.resolve = async () => {
      if (reason === 'allowlist') f.store.set('integration.hosts', guildId, []);
      if (reason === 'permission') f.actor.permissions = new PermissionsBitField();
      if (reason === 'module') f.store.set('core.disabled', guildId, ['integrations']);
      return reason === 'private' ? [address, { address: '127.0.0.1', family: 4 }] : [address];
    };
    await assert.rejects(f.service.graphql(f.ctx, input));
  }
  assert.equal(mock.requests.length, 0);
});

test('GraphQL distinguishes data from application errors and rejects invalid envelopes/server failures', async (t) => {
  const f = fixture(t);
  f.store.set('integration.hosts', guildId, ['example.com']);
  const input = { url: 'https://example.com/graphql', query: '{ value }' };
  for (const [body, code, ok] of [
    [{ data: { value: 'ok' } }, 200, true],
    [{ data: null, errors: [{ message: 'unknown field' }] }, 200, false],
    [{ errors: [{ message: 'invalid query' }] }, 400, false],
  ] as const) {
    const result = (await new PublicService({
      http: http(body, code, 'application/graphql-response+json; charset=utf-8').transport,
    }).graphql(f.ctx, input)) as Record<string, unknown>;
    assert.equal(result.ok, ok);
    assert.equal(result.status, code);
    assert.deepEqual(result.response, body);
  }
  for (const mock of [
    http({ value: 'missing envelope' }),
    http({ data: [] }),
    http({ data: 1 }),
    http({ errors: [] }),
    http({ errors: [{ text: 'missing message' }] }),
    http({ data: {} }, 400),
    http({ errors: [{ message: 'failed' }] }, 503),
    http({ data: {} }, 200, 'text/plain'),
    http('{bad'),
    http(Buffer.alloc(PUBLIC_SERVICE_LIMITS.jsonBytes + 1)),
  ])
    await assert.rejects(new PublicService({ http: mock.transport }).graphql(f.ctx, input));
});

test('GraphQL discards a late result if current server authority changes while the GET is running', async (t) => {
  const mock = http({ data: { value: 'late' } }),
    f = fixture(t, { http: mock.transport });
  f.store.set('integration.hosts', guildId, ['example.com']);
  mock.transport.connect = async () => {
    f.store.set('integration.hosts', guildId, []);
    return {
      status: 200,
      body: Buffer.from('{"data":{"value":"late"}}'),
      headers: { 'content-type': 'application/json' },
    };
  };
  await assert.rejects(
    f.service.graphql(f.ctx, { url: 'https://example.com/graphql', query: '{ value }' }),
    /allowlist/,
  );
});

test('GraphQL response node and depth bounds protect downstream result serialization', async (t) => {
  const f = fixture(t);
  f.store.set('integration.hosts', guildId, ['example.com']);
  let deep: unknown = 1;
  for (let i = 0; i < PUBLIC_SERVICE_LIMITS.graphqlResponseDepth + 1; i++) deep = { nested: deep };
  for (const body of [
    { data: { deep } },
    { data: { nodes: Array(PUBLIC_SERVICE_LIMITS.graphqlResponseNodes).fill(0) } },
  ])
    await assert.rejects(
      new PublicService({ http: http(body).transport }).graphql(f.ctx, {
        url: 'https://example.com/graphql',
        query: '{ value }',
      }),
      /node\/depth/,
    );
});

test('Minecraft handshake implements Java status framing, protocol -1, original hostname and fixed port 25565', () => {
  const packet = minecraftHandshake('Play.Example.com');
  const read = (from: number) => {
    let value = 0,
      index = from;
    do {
      const byte = packet[index++]!;
      value |= (byte & 127) << (7 * (index - from - 1));
      if (!(byte & 128)) break;
    } while (index - from < 5);
    return { value, offset: index };
  };
  const size = read(0),
    packetId = read(size.offset),
    protocol = read(packetId.offset),
    hostLength = read(protocol.offset);
  assert.equal(size.value, packet.length - size.offset - 2);
  assert.equal(packetId.value, 0);
  assert.equal(protocol.value, -1);
  assert.equal(
    packet.subarray(hostLength.offset, hostLength.offset + hostLength.value).toString(),
    'play.example.com',
  );
  assert.equal(packet.readUInt16BE(hostLength.offset + hostLength.value), 25565);
  assert.deepEqual([...packet.subarray(-3)], [1, 1, 0]);
  assert.deepEqual([...encodeMinecraftVarInt(2147483647)], [255, 255, 255, 255, 7]);
  for (const number of [NaN, 1.5, -2147483649, 2147483648])
    assert.throws(() => encodeMinecraftVarInt(number));
  for (const host of [
    'localhost',
    '127.0.0.1',
    'example.com:1234',
    'https://example.com',
    'play.example.com/path',
    'a..example.com',
    '-bad.example.com',
    'a'.repeat(64) + '.example.com',
    '2130706433',
    '127.1',
  ])
    assert.throws(() => minecraftHandshake(host), Error, host);
});

test('Minecraft status decoder validates complete packets and extracts bounded safe MOTD without player identities/icons', () => {
  const value = decodeMinecraftStatus(
    statusPacket({
      ...status,
      favicon: 'data:private',
      players: { ...status.players, sample: [{ name: 'not exposed', id: 'private' }] },
    }),
  );
  assert.deepEqual(value, {
    version: 'Java 1.21',
    protocol: 767,
    players: { online: 2, max: 20 },
    motd: 'Hello everyone world',
  });
  assert.equal(
    decodeMinecraftStatus(statusPacket({ ...status, description: ['One', { text: 'Two' }] })).motd,
    'OneTwo',
  );
  assert.equal(
    decodeMinecraftStatus(statusPacket({ ...status, description: 'x'.repeat(2000) })).motd.length,
    500,
  );
  const valid = statusPacket();
  for (const packet of [
    valid.subarray(0, -1),
    Buffer.concat([valid, Buffer.from([0])]),
    Buffer.from([1, 1]),
    Buffer.from([2, 0, 127]),
    Buffer.from([255, 255, 255, 255, 127]),
    Buffer.from([255, 255, 255, 255, 255, 1]),
    Buffer.from([4, 0, 2, 34, 255]),
    Buffer.alloc(PUBLIC_SERVICE_LIMITS.minecraftBytes + 6),
    statusPacket(null),
    statusPacket({ ...status, players: { online: -1, max: 20 } }),
  ])
    assert.throws(() => decodeMinecraftStatus(packet));
});

async function localMinecraft(t: TestContext, respond: (socket: Socket, request: Buffer) => void) {
  const sockets = new Set<Socket>();
  const expected = minecraftHandshake('play.example.com');
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let parts = Buffer.alloc(0),
      responded = false;
    socket.on('data', (chunk) => {
      parts = Buffer.concat([parts, chunk]);
      if (!responded && parts.length >= expected.length) {
        responded = true;
        received.push(parts);
        respond(socket, parts);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const listening = server.address();
  if (!listening || typeof listening === 'string') throw new Error('Expected TCP listener');
  const requests: { host: string; family: number; port: number }[] = [];
  const open = (options: { host: string; family: number; port: number }) => {
    requests.push(options);
    return createConnection({ host: '127.0.0.1', port: listening.port });
  };
  const options = {
    hostname: 'play.example.com',
    ...address,
    handshake: expected,
    timeoutMs: 1000,
    maxBytes: PUBLIC_SERVICE_LIMITS.minecraftBytes,
  };
  return { open, options, received, requests };
}

test('Actual Minecraft socket sends handshake to a pinned public address/fixed port and decodes a fragmented TCP status frame', async (t) => {
  const packet = statusPacket({ ...status, description: 'Hello 🌎 ' + 'x'.repeat(300) });
  const local = await localMinecraft(t, (socket) => {
    socket.write(packet.subarray(0, 1));
    setImmediate(() => socket.write(packet.subarray(1, 7)));
    setImmediate(() => socket.end(packet.subarray(7)));
  });
  const result = await connectMinecraft(local.options, local.open);
  assert.deepEqual(result, packet);
  assert.deepEqual(local.received[0], local.options.handshake);
  assert.deepEqual(local.requests, [{ host: address.address, family: 4, port: 25565 }]);
  assert.match(decodeMinecraftStatus(result).motd, /Hello 🌎/);
});

test('Actual Minecraft sockets reject incomplete, extra, oversized and stalled packets and support cancellation', async (t) => {
  for (const [name, respond, error] of [
    ['incomplete', (socket: Socket) => socket.end(Buffer.from([4, 0])), /complete/],
    ['extra', (socket: Socket) => socket.end(Buffer.concat([statusPacket(), Buffer.from([0])])), /extra/],
    [
      'oversized',
      (socket: Socket) => socket.write(encodeMinecraftVarInt(PUBLIC_SERVICE_LIMITS.minecraftBytes + 1)),
      /64 KiB/,
    ],
    ['stall', (_socket: Socket) => {}, /timed out/],
  ] as const) {
    await t.test(name, async (sub) => {
      const local = await localMinecraft(sub, respond);
      await assert.rejects(
        connectMinecraft({ ...local.options, timeoutMs: name === 'stall' ? 25 : 1000 }, local.open),
        error,
      );
    });
  }
  await t.test('abort', async (sub) => {
    const local = await localMinecraft(sub, () => {}),
      controller = new AbortController();
    const job = connectMinecraft({ ...local.options, signal: controller.signal }, local.open);
    controller.abort();
    await assert.rejects(job, /timed out/);
  });
});

test('Minecraft service resolves once, pins the chosen public address, caches/coalesces and preserves safe result copies', async (t) => {
  const mock = minecraftDriver();
  let now = 0;
  const f = fixture(t, { minecraft: mock.driver, now: () => now });
  f.store.set('integration.hosts', guildId, ['play.example.com']);
  const results = (await Promise.all([
    f.service.minecraft(f.ctx, 'Play.Example.com'),
    f.service.minecraft(f.ctx, 'play.example.com'),
  ])) as Record<string, unknown>[];
  assert.equal(mock.hosts.length, 1);
  assert.equal(mock.requests.length, 1);
  assert.equal(mock.requests[0]?.address, address.address);
  assert.equal(mock.requests[0]?.family, 4);
  assert.deepEqual(mock.requests[0]?.handshake, minecraftHandshake('play.example.com'));
  assert.ok(mock.requests[0]!.timeoutMs <= PUBLIC_SERVICE_LIMITS.minecraftTimeoutMs);
  assert.equal(results[0]?.port, 25565);
  assert.equal(results[0]?.online, true);
  (results[0]!.players as { online: number }).online = 999;
  assert.equal((results[1]!.players as { online: number }).online, 2);
  const cached = (await f.service.minecraft(f.ctx, 'play.example.com')) as { players: { online: number } };
  assert.equal(cached.players.online, 2);
  now = PUBLIC_SERVICE_LIMITS.minecraftCacheMs;
  await f.service.minecraft(f.ctx, 'play.example.com');
  assert.equal(mock.requests.length, 2);
  f.store.set('integration.hosts', guildId, []);
  await assert.rejects(f.service.minecraft(f.ctx, 'play.example.com'), /integration.hosts/);
});

test('Minecraft rejects private/mixed DNS, invalid families and changed policy before opening a socket', async (t) => {
  const mock = minecraftDriver(),
    f = fixture(t, { minecraft: mock.driver });
  f.store.set('integration.hosts', guildId, ['play.example.com']);
  for (const answers of [
    [],
    [{ address: '10.0.0.1', family: 4 }],
    [address, { address: '::1', family: 6 }],
    [{ ...address, family: 6 }],
    [{ ...address, family: 0 }],
  ]) {
    mock.driver.resolve = async () => answers;
    await assert.rejects(f.service.minecraft(f.ctx, 'play.example.com'), /private|unsupported/);
  }
  mock.driver.resolve = async () => {
    f.store.set('integration.hosts', guildId, []);
    return [address];
  };
  await assert.rejects(f.service.minecraft(f.ctx, 'play.example.com'), /integration.hosts/);
  f.store.set('integration.hosts', guildId, ['play.example.com']);
  f.store.set('core.disabled', guildId, ['integrations']);
  await assert.rejects(f.service.minecraft(f.ctx, 'play.example.com'), /disabled/);
  assert.equal(mock.requests.length, 0);
});

test('Minecraft global concurrency is bounded and slots/pending state recover after transport or framing failure', async (t) => {
  const mock = minecraftDriver(),
    f = fixture(t, { minecraft: mock.driver });
  f.store.set('integration.hosts', guildId, ['one.example.com', 'two.example.com', 'three.example.com']);
  const gates = [deferred<Buffer>(), deferred<Buffer>()];
  let calls = 0;
  mock.driver.connect = async () => gates[calls++]!.promise;
  const jobs = [f.service.minecraft(f.ctx, 'one.example.com'), f.service.minecraft(f.ctx, 'two.example.com')];
  await tick();
  await assert.rejects(f.service.minecraft(f.ctx, 'three.example.com'), /busy/);
  const failures = jobs.map((job) => assert.rejects(job));
  gates[0]!.reject(new Error('synthetic network failure'));
  gates[1]!.resolve(Buffer.from([1, 1]));
  await Promise.all(failures);
  mock.driver.connect = async () => statusPacket();
  await f.service.minecraft(f.ctx, 'one.example.com');
  await f.service.minecraft(f.ctx, 'three.example.com');
});

test('Minecraft total deadline covers DNS, aborts transport and releases concurrency slots even if injected DNS never resolves', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mock = minecraftDriver(),
    f = fixture(t, { minecraft: mock.driver });
  f.store.set('integration.hosts', guildId, ['one.example.com', 'two.example.com', 'three.example.com']);
  let signal: AbortSignal | undefined;
  mock.driver.resolve = async (_host, abort) => {
    signal = abort;
    return new Promise(() => {});
  };
  const jobs = [f.service.minecraft(f.ctx, 'one.example.com'), f.service.minecraft(f.ctx, 'two.example.com')];
  const failures = jobs.map((job) => assert.rejects(job, /timed out/));
  t.mock.timers.tick(PUBLIC_SERVICE_LIMITS.minecraftTimeoutMs);
  await Promise.all(failures);
  assert.equal(signal?.aborted, true);
  mock.driver.resolve = async () => [address];
  await f.service.minecraft(f.ctx, 'three.example.com');
  assert.equal(mock.requests.length, 1);
});

test('Minecraft late responses after allowlist revocation are discarded rather than cached', async (t) => {
  const mock = minecraftDriver(),
    f = fixture(t, { minecraft: mock.driver }),
    gate = deferred<Buffer>();
  f.store.set('integration.hosts', guildId, ['play.example.com']);
  mock.driver.connect = async () => gate.promise;
  const pending = f.service.minecraft(f.ctx, 'play.example.com');
  await tick();
  f.store.set('integration.hosts', guildId, []);
  const rejected = assert.rejects(pending, /integration.hosts/);
  gate.resolve(statusPacket());
  await rejected;
  f.store.set('integration.hosts', guildId, ['play.example.com']);
  let calls = 0;
  mock.driver.connect = async () => {
    calls++;
    return statusPacket();
  };
  await f.service.minecraft(f.ctx, 'play.example.com');
  assert.equal(calls, 1);
});
