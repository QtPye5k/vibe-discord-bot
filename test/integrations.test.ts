import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits as P, PermissionsBitField, type Client } from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import {
  isPublicAddress,
  publicUrl,
  fetchPublic,
  cachedPublicJson,
  parseFeed,
  registerIntegrationActions,
  sweepIntegrationTasks,
  type PublicTransport,
  type PinnedRequest,
} from '../src/features/integrations.js';
const G = '600000000000000001',
  U = '600000000000000002',
  B = '600000000000000003',
  C = '600000000000000004';
function transport(body: string, status = 200) {
  const connections: PinnedRequest[] = [];
  let resolutions = 0;
  const driver: PublicTransport = {
    resolve: async () => {
      resolutions++;
      return [{ address: '93.184.216.34', family: 4 }];
    },
    connect: async (options) => {
      connections.push(options);
      return { status, body: Buffer.from(body), headers: { 'content-type': 'application/json' } };
    },
  };
  return {
    driver,
    connections,
    get resolutions() {
      return resolutions;
    },
  };
}
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const sends: Record<string, unknown>[] = [];
  const actor = { id: U, permissions: new PermissionsBitField(P.Administrator) };
  const bot = { id: B, permissions: new PermissionsBitField(P.Administrator) };
  const transport = {
    send: async (value: Record<string, unknown>) => {
      sends.push(value);
      return { id: 'msg' };
    },
  };
  const channel = {
    id: C,
    guildId: G,
    type: 0,
    isTextBased: () => true,
    isThread: () => false,
    isSendable: () => true,
    permissionsFor: () => new PermissionsBitField(P.Administrator),
    send: (value: Record<string, unknown>) => transport.send(value),
  };
  const guild = {
    id: G,
    members: { me: bot, fetch: async () => actor, fetchMe: async () => bot },
    channels: { fetch: async () => channel },
  };
  const client = { guilds: { fetch: async () => guild } } as unknown as Client;
  const ctx = { client, store, guild, member: actor, channelId: C } as unknown as ActionContext;
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  registerIntegrationActions(registry);
  const execute = async (id: string, input: unknown = {}) => {
    const action = registry.get(id);
    return action.execute(ctx, action.schema.parse(input));
  };
  return { store, client, ctx, registry, execute, sends, actor, channel, transport };
}
test('Public address checks reject private, loopback, metadata, mapped, transition and documentation networks', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '198.18.0.1',
    '192.0.2.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    '2001:0db8::1',
    '2002:7f00:1::',
    '2001:0000:1234::1',
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('93.184.216.34'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});
test('Public HTTPS URL validation rejects credentials, private literals, lookalikes, ports and unapproved hosts', () => {
  for (const value of [
    'http://example.com',
    'file:///secret',
    'https://user:pass@example.com',
    'https://example.com:444',
    'https://127.1/',
    'https://localhost/',
    'https://example.local/',
    'https://example.com/#token',
  ])
    assert.throws(() => publicUrl(value));
  assert.throws(() => publicUrl('https://example.com.evil.test/', ['example.com']), /allowlist/);
  assert.equal(publicUrl('https://example.com/a', ['example.com']).hostname, 'example.com');
});
test('Actual connection receives a pinned validated IP and never re-resolves a hostname after validation', async () => {
  const fake = transport('ok');
  const response = await fetchPublic('https://example.com/data', {}, fake.driver);
  assert.equal(response.body.toString(), 'ok');
  assert.equal(fake.resolutions, 1);
  assert.equal(fake.connections[0]?.address, '93.184.216.34');
  assert.equal(fake.connections[0]?.url.hostname, 'example.com');
  assert.equal(fake.connections[0]?.family, 4);
});
test('Any private DNS answer rejects the request before transport even when other answers are public', async () => {
  let calls = 0;
  await assert.rejects(
    fetchPublic(
      'https://example.com/',
      {},
      {
        resolve: async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ],
        connect: async () => {
          calls++;
          throw new Error('must not connect');
        },
      },
    ),
    /private/,
  );
  assert.equal(calls, 0);
});
test('Public integrations reject redirects, oversized responses and free every concurrency slot', async () => {
  await assert.rejects(
    fetchPublic('https://example.com/', {}, transport('redirect', 302).driver),
    /redirect/,
  );
  await assert.rejects(
    fetchPublic('https://example.com/', { maxBytes: 3 }, transport('too big').driver),
    /large/,
  );
  const releases: (() => void)[] = [];
  const driver: PublicTransport = {
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    connect: async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { status: 200, body: Buffer.from('ok'), headers: {} };
    },
  };
  const jobs = Array.from({ length: 4 }, () => fetchPublic('https://example.com/', {}, driver));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(fetchPublic('https://example.com/', {}, driver), /busy/);
  releases.forEach((release) => release());
  await Promise.all(jobs);
  assert.equal(
    (await fetchPublic('https://example.com/', {}, transport('recovered').driver)).body.toString(),
    'recovered',
  );
});
test('Public JSON caches repeated provider queries and coalesces concurrent requests', async () => {
  const fake = transport('{"name":"cached"}');
  const url = 'https://example.com/public-cache-test';
  const results = await Promise.all([cachedPublicJson(url, fake.driver), cachedPublicJson(url, fake.driver)]);
  assert.deepEqual(results, [{ name: 'cached' }, { name: 'cached' }]);
  await cachedPublicJson(url, fake.driver);
  assert.equal(fake.connections.length, 1);
  await assert.rejects(
    cachedPublicJson('https://example.com/invalid-json', transport('not-json').driver),
    /JSON/,
  );
});
test('RSS/Atom parsing supports CDATA entities and alternate links without expanding XML declarations', () => {
  const rss = parseFeed(
    '<rss><channel><item><title><![CDATA[News &amp; update]]></title><link>https://example.com/a?x=1&amp;y=2</link><guid>one</guid><pubDate>today</pubDate></item></channel></rss>',
  );
  assert.equal(rss[0]?.title, 'News & update');
  assert.equal(rss[0]?.url, 'https://example.com/a?x=1&y=2');
  assert.equal(rss[0]?.id, 'one');
  const atom = parseFeed(
    '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>two</id><title>Atom</title><link rel="alternate" href="https://example.com/atom"/></entry></feed>',
  );
  assert.equal(atom[0]?.url, 'https://example.com/atom');
  assert.throws(() => parseFeed('<!DOCTYPE rss [<!ENTITY a SYSTEM "file:///secret">]><rss/>'), /DTD/);
  assert.throws(() => parseFeed('not xml'), /RSS/);
});
test('Malformed and adversarial feed markup remains bounded and never creates unsafe links', () => {
  assert.equal(parseFeed(`<rss>${'<item><title>'.repeat(10000)}</rss>`).length, 0);
  assert.equal(
    parseFeed(
      '<rss><item><title>bad</title><link>javascript:alert(1)</link></item><item><title>bad</title><link>https://user:pass@example.com</link></item></rss>',
    ).length,
    0,
  );
});
test('Monitor host policy is per guild and a monitor cannot be configured before its hostname is confirmed', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.execute('integration.watch', { id: 'site', kind: 'change', url: 'https://example.com/', channelId: C }),
    /allowlist/,
  );
  await f.execute('integration.hosts', { hosts: ['example.com'] });
  await f.execute('integration.watch', {
    id: 'site',
    kind: 'change',
    url: 'https://example.com/',
    channelId: C,
  });
  assert.equal(f.store.list('integration.watches').length, 1);
  assert.deepEqual(f.store.get('integration.hosts', 'other'), undefined);
});
test('Content monitors establish silent baseline and deliver only a real subsequent change', async (t) => {
  const f = fixture(t);
  await f.execute('integration.hosts', { hosts: ['example.com'] });
  await f.execute('integration.watch', {
    id: 'site',
    kind: 'change',
    url: 'https://example.com/',
    channelId: C,
    intervalMinutes: 5,
  });
  const now = Date.now();
  await sweepIntegrationTasks(f.client, f.store, now, [], transport('first').driver);
  assert.equal(f.sends.length, 0);
  await sweepIntegrationTasks(f.client, f.store, now + 300001, [], transport('second').driver);
  assert.equal(f.sends.length, 1);
  assert.match(String(f.sends[0]?.content), /change detected/);
  assert.deepEqual(f.sends[0]?.allowedMentions, { parse: [] });
});
test('RSS monitor remembers item IDs across process-local reconstruction and does not repost old entries', async (t) => {
  const f = fixture(t);
  await f.execute('integration.hosts', { hosts: ['example.com'] });
  await f.execute('integration.watch', {
    id: 'feed',
    kind: 'rss',
    url: 'https://example.com/rss',
    channelId: C,
    intervalMinutes: 5,
  });
  const one = '<item><title>One</title><link>https://example.com/one</link><guid>one</guid></item>';
  const two = '<item><title>Two</title><link>https://example.com/two</link><guid>two</guid></item>';
  const now = Date.now();
  await sweepIntegrationTasks(f.client, f.store, now, [], transport(`<rss>${one}</rss>`).driver);
  await sweepIntegrationTasks(
    f.client,
    f.store,
    now + 300001,
    [],
    transport(`<rss>${two}${one}</rss>`).driver,
  );
  await sweepIntegrationTasks(
    f.client,
    f.store,
    now + 600002,
    [],
    transport(`<rss>${two}${one}</rss>`).driver,
  );
  assert.equal(f.sends.length, 1);
  assert.match(String(f.sends[0]?.content), /Two/);
  assert.ok(!String(f.sends[0]?.content).includes('One'));
});
test('Monitor delivery retries preserve nonce and stop after three failures', async (t) => {
  const f = fixture(t);
  await f.execute('integration.hosts', { hosts: ['example.com'] });
  await f.execute('integration.watch', {
    id: 'site',
    kind: 'change',
    url: 'https://example.com/',
    channelId: C,
    intervalMinutes: 5,
  });
  const now = Date.now();
  await sweepIntegrationTasks(f.client, f.store, now, [], transport('first').driver);
  f.transport.send = async (options) => {
    f.sends.push(options);
    throw new Error('provider secret should not be saved');
  };
  await sweepIntegrationTasks(f.client, f.store, now + 300001, [], transport('second').driver);
  for (let i = 0; i < 2; i++) {
    const watch = f.store.get<{ pending: { retryAt: number } }>('integration.watches', `${G}:site`)!;
    await sweepIntegrationTasks(f.client, f.store, watch.pending.retryAt, [], transport('second').driver);
  }
  const watch = f.store.get<{ enabled: boolean; lastError: string }>('integration.watches', `${G}:site`)!;
  assert.equal(watch.enabled, false);
  assert.equal(watch.lastError, 'Error');
  assert.equal(f.sends.length, 3);
  assert.equal(new Set(f.sends.map((row) => row.nonce)).size, 1);
});
test('Removing host authorization or losing author permissions disables monitors before any HTTP request', async (t) => {
  const f = fixture(t);
  await f.execute('integration.hosts', { hosts: ['example.com'] });
  await f.execute('integration.watch', {
    id: 'site',
    kind: 'change',
    url: 'https://example.com/',
    channelId: C,
  });
  f.store.set('integration.hosts', G, []);
  const fake = transport('never');
  await sweepIntegrationTasks(f.client, f.store, Date.now(), [], fake.driver);
  assert.equal(fake.connections.length, 0);
  assert.equal(f.store.get<{ enabled: boolean }>('integration.watches', `${G}:site`)?.enabled, false);
});
test('Guild restrictions and module disable prevent monitor requests', async (t) => {
  const f = fixture(t);
  await f.execute('integration.hosts', { hosts: ['example.com'] });
  await f.execute('integration.watch', {
    id: 'site',
    kind: 'change',
    url: 'https://example.com/',
    channelId: C,
  });
  const fake = transport('never');
  await sweepIntegrationTasks(f.client, f.store, Date.now(), ['other'], fake.driver);
  f.store.set('core.disabled', G, ['integrations']);
  await sweepIntegrationTasks(f.client, f.store, Date.now(), [], fake.driver);
  assert.equal(fake.connections.length, 0);
});

test('Removing a monitor during its HTTP request cannot resurrect it or emit its late response', async (t) => {
  const f = fixture(t);
  await f.execute('integration.hosts', { hosts: ['example.com'] });
  await f.execute('integration.watch', {
    id: 'site',
    kind: 'change',
    url: 'https://example.com/',
    channelId: C,
  });
  let release!: () => void;
  const fake = transport('first');
  fake.driver.connect = async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { status: 200, body: Buffer.from('first'), headers: {} };
  };
  const pending = sweepIntegrationTasks(f.client, f.store, Date.now(), [], fake.driver);
  await new Promise((resolve) => setImmediate(resolve));
  await f.execute('integration.watch-remove', { id: 'site' });
  release();
  await pending;
  assert.equal(f.store.list('integration.watches').length, 0);
  assert.equal(f.sends.length, 0);
});
