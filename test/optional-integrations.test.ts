import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, PermissionFlagsBits as P, PermissionsBitField, type Client } from 'discord.js';
import { z } from 'zod';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import { Store } from '../src/core/store.js';
import {
  createOptionalIntegrations,
  type OptionalIntegrationsOptions,
} from '../src/features/optional-integrations.js';
import { OPTIONAL_INTEGRATION_FIELDS, integrationStatus } from '../src/integrations/provider-catalog.js';
import {
  providerHttp,
  providerJson,
  safeProviderValue,
  type ProviderRequest,
  type ProviderTransport,
} from '../src/integrations/http.js';
import { createCredentials } from '../src/integrations/credentials.js';

const G = '610000000000000001',
  U = '610000000000000002',
  B = '610000000000000003',
  C = '610000000000000004';
const ENV: NodeJS.ProcessEnv = {
  GITHUB_TOKEN: 'test-github-secret',
  GOOGLE_ACCESS_TOKEN: 'test-google-access-secret',
  GITLAB_TOKEN: 'test-gitlab-secret',
  TRELLO_API_KEY: 'test-trello-key',
  TRELLO_TOKEN: 'test-trello-token',
  NOTION_TOKEN: 'test-notion-secret',
  YOUTUBE_API_KEY: 'test-youtube-secret',
  TWITCH_CLIENT_ID: 'test-twitch-client',
  TWITCH_ACCESS_TOKEN: 'test-twitch-secret',
  RESEND_API_KEY: 'test-resend-secret',
  EMAIL_FROM: 'bot@example.org',
  TWILIO_ACCOUNT_SID: 'ACtestaccount',
  TWILIO_AUTH_TOKEN: 'test-twilio-secret',
  TWILIO_FROM: '+15555550100',
  VIRUSTOTAL_API_KEY: 'test-virus-secret',
  TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
  TURNSTILE_EXPECTED_HOSTNAME: 'verify.example.org',
  STEAM_API_KEY: 'test-steam-secret',
  AFTERSHIP_API_KEY: 'test-aftership-secret',
  SHOPIFY_SHOP: 'example.myshopify.com',
  SHOPIFY_ADMIN_TOKEN: 'test-shopify-secret',
  MASTODON_BASE_URL: 'https://social.example.org',
  MASTODON_ACCESS_TOKEN: 'test-social-secret',
  RUNWAY_API_KEY: 'test-runway-secret',
  SHOTSTACK_API_KEY: 'test-shotstack-secret',
  CLOUDFLARE_API_TOKEN: 'test-cloudflare-secret',
  CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
};
function fixture(
  t: TestContext,
  env: NodeJS.ProcessEnv = { ...ENV },
  handler: (req: ProviderRequest) => unknown | Promise<unknown> = () => ({ ok: true }),
  overrides: Partial<OptionalIntegrationsOptions> = {},
) {
  const store = new Store(':memory:'),
    calls: ProviderRequest[] = [],
    sent: unknown[] = [];
  let time = Date.now();
  const member = {
      id: U,
      permissions: new PermissionsBitField(P.Administrator),
      roles: { cache: new Collection() },
    },
    bot = { ...member, id: B };
  const channel = {
    id: C,
    guildId: G,
    type: 0,
    isSendable: () => true,
    permissionsFor: () => new PermissionsBitField(P.Administrator),
    send: async (payload: unknown) => {
      sent.push(payload);
      return { id: 'message' };
    },
  };
  const guild = {
    id: G,
    name: 'Fixture',
    ownerId: U,
    members: { me: bot, fetch: async () => member, fetchMe: async () => bot },
    channels: { fetch: async () => channel },
  };
  const client = { user: { id: B }, guilds: { fetch: async () => guild } } as unknown as Client;
  const ctx = { client, store, guild, member, channelId: C } as unknown as ActionContext;
  const transport: ProviderTransport = {
    resolve: async () => [{ address: '1.1.1.1', family: 4 }],
    connect: async (request) => {
      calls.push(request);
      const value = await handler(request);
      return {
        status: 200,
        body: Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value)),
        headers: {},
      };
    },
  };
  const service = createOptionalIntegrations({
      env,
      operatorIds: [U],
      transport,
      now: () => time,
      ...overrides,
    }),
    registry = new ActionRegistry();
  service.registerActions(registry);
  t.after(() => {
    service.close();
    store.close();
  });
  const run = (id: string, input: unknown = {}) => registry.request(ctx, id, input);
  const confirmed = async (id: string, input: unknown = {}) => {
    const pending = await run(id, input);
    assert.equal(pending.status, 'confirmation');
    if (pending.status !== 'confirmation') throw new Error('Missing preview');
    return registry.confirm(ctx, pending.id);
  };
  return {
    store,
    ctx,
    client,
    member,
    bot,
    channel,
    service,
    registry,
    transport,
    run,
    confirmed,
    calls,
    sent,
    setTime(value: number) {
      time = value;
    },
    get time() {
      return time;
    },
  };
}
const body = (request: ProviderRequest) => JSON.parse(request.body!.toString()) as Record<string, unknown>;

test('Blank optional configuration hides adapters and prevents confirmations and network requests', async (t) => {
  const f = fixture(t, {});
  assert.ok(f.service.status().every((row) => !row.enabled));
  assert.equal(
    f.registry.listAvailable().some((row) => row.id === 'integration.email.send'),
    false,
  );
  await assert.rejects(
    () => f.run('integration.email.send', { to: ['person@example.org'], subject: 'Subject', text: 'Body' }),
    /disabled|not configured/,
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM confirmations').get()?.n, 0);
});
test('Every optional adapter has a serializable strict schema and the declared configuration fields are unique', (t) => {
  const f = fixture(t);
  assert.equal(
    new Set(OPTIONAL_INTEGRATION_FIELDS.map((row) => row.name)).size,
    OPTIONAL_INTEGRATION_FIELDS.length,
  );
  assert.ok(f.service.status().every((row) => row.enabled));
  assert.ok(f.registry.list().length >= 45);
  for (const action of f.registry.list())
    assert.doesNotThrow(() => JSON.stringify(z.toJSONSchema(action.schema, { io: 'input' })), action.id);
});
test('Shared-account provider access requires an application operator even when a caller is guild administrator', async (t) => {
  const f = fixture(t);
  f.member.id = '610000000000000099';
  await assert.rejects(
    () => f.run('integration.gitlab.project', { projectId: 'team/private' }),
    /application owner|OPERATOR_IDS/,
  );
  assert.equal(f.calls.length, 0);
});
test('Optional provider writes execute only after an exact single-use human confirmation', async (t) => {
  const f = fixture(t);
  const input = { to: ['person@example.org'], subject: 'Reviewed subject', text: 'Reviewed body' };
  const pending = await f.run('integration.email.send', input);
  assert.equal(f.calls.length, 0);
  assert.equal(pending.status, 'confirmation');
  if (pending.status !== 'confirmation') return;
  await f.registry.confirm(f.ctx, pending.id);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.url.origin, 'https://api.resend.com');
  assert.deepEqual(body(f.calls[0]!), { from: 'bot@example.org', ...input });
  await assert.rejects(() => f.registry.confirm(f.ctx, pending.id), /unavailable|already/);
  assert.equal(f.calls.length, 1);
  const saved = f.store.list('integrations.providerWatches');
  assert.deepEqual(saved, []);
  const audits = f.store.db.prepare('SELECT * FROM audit').all();
  assert.ok(!JSON.stringify(audits).includes(ENV.RESEND_API_KEY!));
});
test('Provider field changes can disable an already prepared write before confirmation', async (t) => {
  const env = { ...ENV },
    f = fixture(t, env),
    pending = await f.run('integration.sms.send', { to: '+15555550123', text: 'Reviewed' });
  assert.equal(pending.status, 'confirmation');
  delete env.TWILIO_AUTH_TOKEN;
  if (pending.status === 'confirmation')
    await assert.rejects(() => f.registry.confirm(f.ctx, pending.id), /disabled|not configured/);
  assert.equal(f.calls.length, 0);
});
test('Google Calendar appointment fields and RAW Sheets updates use actual provider routes and wire shapes', async (t) => {
  const f = fixture(t);
  await f.confirmed('integration.google-calendar.event-create', {
    title: 'Interview',
    start: '2026-11-02T10:00:00-05:00',
    end: '2026-11-02T10:30:00-05:00',
    timeZone: 'America/New_York',
    attendees: ['guest@example.org'],
  });
  assert.equal(f.calls[0]!.url.pathname, '/calendar/v3/calendars/primary/events');
  assert.equal(f.calls[0]!.headers.Authorization, `Bearer ${ENV.GOOGLE_ACCESS_TOKEN}`);
  assert.equal(f.calls[0]!.url.searchParams.get('sendUpdates'), 'all');
  assert.deepEqual(body(f.calls[0]!).start, {
    dateTime: '2026-11-02T10:00:00-05:00',
    timeZone: 'America/New_York',
  });
  await f.confirmed('integration.google-sheets.write', {
    spreadsheetId: 'sheet',
    range: 'Data!A1:B1',
    values: [['=literal', 42]],
  });
  assert.equal(f.calls[1]!.method, 'PUT');
  assert.equal(f.calls[1]!.url.searchParams.get('valueInputOption'), 'RAW');
  assert.deepEqual(body(f.calls[1]!).values, [['=literal', 42]]);
  await assert.rejects(
    () =>
      f.run('integration.google-calendar.event-create', {
        title: 'Invalid',
        start: '2026-11-02T11:00:00Z',
        end: '2026-11-02T10:00:00Z',
      }),
    /End must/,
  );
});
test('Google Drive downloads preserve actual Buffer attachments and uploads encode metadata/media separately', async (t) => {
  const f = fixture(t, { ...ENV }, (request) =>
    request.url.searchParams.get('alt') === 'media' ? Buffer.from('actual download') : { id: 'file' },
  );
  const output = await f.run('integration.google-drive.download', { fileId: 'file' });
  assert.equal(output.status, 'completed');
  if (output.status === 'completed') {
    assert.ok(Buffer.isBuffer((output.result as { attachment: Buffer }).attachment));
    assert.equal((output.result as { attachment: Buffer }).attachment.toString(), 'actual download');
  }
  await f.confirmed('integration.google-drive.upload-text', {
    name: 'note.txt',
    text: 'Body',
    folderId: 'folder',
  });
  const upload = f.calls[1]!;
  assert.equal(upload.url.pathname, '/upload/drive/v3/files');
  assert.match(upload.headers['Content-Type']!, /^multipart\/related; boundary=/);
  assert.match(upload.body!.toString(), /"parents":\["folder"\]/);
  assert.match(upload.body!.toString(), /text\/plain/);
});
test('GitLab, Trello and current Notion adapters bind inputs to dedicated documented routes', async (t) => {
  const f = fixture(t);
  await f.run('integration.gitlab.project', { projectId: 'team/private' });
  assert.equal(f.calls[0]!.url.pathname, '/api/v4/projects/team%2Fprivate');
  assert.equal(f.calls[0]!.headers['PRIVATE-TOKEN'], ENV.GITLAB_TOKEN);
  await f.confirmed('integration.trello.card-create', {
    listId: 'abc123',
    title: 'Task',
    description: 'Body',
  });
  assert.equal(f.calls[1]!.url.origin, 'https://api.trello.com');
  assert.equal(f.calls[1]!.url.searchParams.get('token'), ENV.TRELLO_TOKEN);
  assert.equal(body(f.calls[1]!).idList, 'abc123');
  await f.run('integration.notion.data-source', { dataSourceId: '12345678-1234-1234-1234-123456789abc' });
  assert.equal(f.calls[2]!.url.pathname, '/v1/data_sources/12345678-1234-1234-1234-123456789abc/query');
  assert.equal(f.calls[2]!.headers['Notion-Version'], '2025-09-03');
  assert.equal(f.calls[2]!.method, 'POST');
});
test('YouTube, Twitch, Steam and AfterShip reads use scoped real API identifiers and authentication', async (t) => {
  const f = fixture(t);
  await f.run('integration.youtube.channel', { channelId: 'UC' + 'a'.repeat(22) });
  assert.equal(f.calls[0]!.url.pathname, '/youtube/v3/channels');
  assert.equal(f.calls[0]!.url.searchParams.get('key'), ENV.YOUTUBE_API_KEY);
  await f.run('integration.twitch.streams', { login: 'example' });
  assert.equal(f.calls[1]!.url.pathname, '/helix/streams');
  assert.equal(f.calls[1]!.headers['Client-Id'], ENV.TWITCH_CLIENT_ID);
  await f.run('integration.steam.achievements', { steamId: '76561198000000000', appId: 440 });
  assert.equal(f.calls[2]!.url.pathname, '/ISteamUserStats/GetPlayerAchievements/v1/');
  assert.equal(f.calls[2]!.url.searchParams.get('appid'), '440');
  await f.run('integration.parcel.get', { trackingId: 'tracking_1' });
  assert.equal(f.calls[3]!.url.pathname, '/tracking/2026-07/trackings/tracking_1');
  assert.equal(f.calls[3]!.headers['as-api-key'], ENV.AFTERSHIP_API_KEY);
});
test('Twilio sends an exact form with basic authorization and never returns the account token', async (t) => {
  const f = fixture(t, { ...ENV }, () => ({
    sid: 'SMtest',
    status: 'queued',
    auth_token: ENV.TWILIO_AUTH_TOKEN,
  }));
  const result = await f.confirmed('integration.sms.send', { to: '+15555550123', text: 'Hello' });
  const call = f.calls[0]!;
  assert.equal(call.url.origin, 'https://api.twilio.com');
  assert.equal(new URLSearchParams(call.body!.toString()).get('Body'), 'Hello');
  assert.match(call.headers.Authorization!, /^Basic /);
  assert.ok(!JSON.stringify(result).includes(ENV.TWILIO_AUTH_TOKEN!));
});
test('VirusTotal reports and scans use exact base64 URL IDs and scan job endpoints', async (t) => {
  const f = fixture(t);
  await f.run('integration.security.url-report', { url: 'https://example.org/file' });
  assert.equal(
    f.calls[0]!.url.pathname,
    '/api/v3/urls/' + Buffer.from('https://example.org/file').toString('base64url'),
  );
  await f.confirmed('integration.security.scan-url', { url: 'https://example.org/file' });
  assert.equal(f.calls[1]!.method, 'POST');
  assert.equal(new URLSearchParams(f.calls[1]!.body!.toString()).get('url'), 'https://example.org/file');
  assert.equal(f.calls[1]!.headers['x-apikey'], ENV.VIRUSTOTAL_API_KEY);
});
test('Turnstile verifier rejects valid tokens for the wrong hostname/action before reporting success', async (t) => {
  let hostname = 'other.example.org',
    action = 'discord-verification';
  const f = fixture(t, { ...ENV }, () => ({ success: true, hostname, action }));
  await assert.rejects(
    () => f.run('integration.captcha.verify', { token: 'one-use-test-token' }),
    /CAPTCHA validation failed/,
  );
  hostname = 'verify.example.org';
  action = 'other';
  await assert.rejects(
    () => f.run('integration.captcha.verify', { token: 'second' }),
    /CAPTCHA validation failed/,
  );
  action = 'discord-verification';
  const result = await f.run('integration.captcha.verify', { token: 'third' });
  assert.equal(result.status, 'completed');
  assert.ok(!JSON.stringify(result).includes(ENV.TURNSTILE_SECRET_KEY!));
});
test('Shopify products use a fixed GraphQL query with variables, and Mastodon posts require confirmation', async (t) => {
  const f = fixture(t, { ...ENV }, () => ({ data: { products: { nodes: [] } } }));
  await f.run('integration.shopify.products', { query: 'sku:example' });
  const call = f.calls[0]!;
  assert.equal(call.url.origin, 'https://example.myshopify.com');
  assert.equal(call.url.pathname, '/admin/api/2026-10/graphql.json');
  assert.deepEqual(body(call).variables, { query: 'sku:example' });
  assert.equal(call.headers['X-Shopify-Access-Token'], ENV.SHOPIFY_ADMIN_TOKEN);
  await f.confirmed('integration.mastodon.post', { text: 'Reviewed post' });
  assert.equal(f.calls[1]!.url.origin, 'https://social.example.org');
  assert.equal(body(f.calls[1]!).visibility, 'unlisted');
});
test('Runway generation and Shotstack processing use real separate billed-job APIs and status routes', async (t) => {
  const f = fixture(t);
  await f.confirmed('integration.video.generate', { prompt: 'Mountain sunrise' });
  assert.equal(f.calls[0]!.url.pathname, '/v1/text_to_video');
  assert.equal(f.calls[0]!.headers['X-Runway-Version'], '2024-11-06');
  assert.equal(body(f.calls[0]!).model, 'gen4.5');
  await f.run('integration.video.task', { taskId: '12345678-1234-1234-1234-123456789abc' });
  assert.equal(f.calls[1]!.method, 'GET');
  await f.confirmed('integration.video.render', {
    clips: [
      { url: 'https://example.org/a.mp4', length: 5 },
      { url: 'https://example.org/b.mp4', start: 2, length: 3 },
    ],
  });
  assert.equal(f.calls[2]!.url.pathname, '/edit/stage/render');
  const edit = body(f.calls[2]!);
  assert.equal((edit.timeline as { tracks: { clips: { start: number }[] }[] }).tracks[0]!.clips[1]!.start, 5);
  await assert.rejects(
    () =>
      f.run('integration.video.render', {
        clips: [
          { url: 'https://example.org/a.mp4', length: 100 },
          { url: 'https://example.org/b.mp4', length: 100 },
        ],
      }),
    /120 seconds/,
  );
});
test('Configured cloud management is restricted to typed Cloudflare operations rather than arbitrary paths/commands', async (t) => {
  const f = fixture(t);
  await f.run('integration.cloudflare.workers');
  assert.match(f.calls[0]!.url.pathname, /\/client\/v4\/accounts\/a{32}\/workers\/scripts$/);
  await f.confirmed('integration.cloudflare.dns-update', {
    zoneId: 'b'.repeat(32),
    recordId: 'c'.repeat(32),
    type: 'A',
    name: 'host.example.org',
    content: '1.1.1.1',
  });
  assert.equal(f.calls[1]!.method, 'PUT');
  assert.equal(body(f.calls[1]!).ttl, 300);
  await assert.rejects(() =>
    f.run('integration.cloudflare.dns-update', {
      zoneId: 'b'.repeat(32),
      recordId: 'c'.repeat(32),
      type: 'A',
      name: 'host.example.org',
      content: '1.1.1.1',
      command: 'arbitrary',
    }),
  );
});
test('Private provider results are dropped if the requesting operator loses server permissions during the request', async (t) => {
  let f: ReturnType<typeof fixture>;
  f = fixture(t, { ...ENV }, () => {
    f.member.permissions = new PermissionsBitField(0n);
    return { private: 'must not deliver' };
  });
  await assert.rejects(
    () => f.run('integration.google-sheets.read', { spreadsheetId: 'sheet', range: 'A1' }),
    /required.*permissions|lack/,
  );
  assert.equal(f.calls.length, 1);
});
test('Provider monitors establish a baseline, notify actual changes once, and pause when the provider is blanked', async (t) => {
  let live = false;
  const env = { ...ENV },
    f = fixture(t, env, () => ({
      data: live
        ? [{ id: 'stream-1', user_id: '42', started_at: '2026-10-29T11:00:00Z', title: 'Live' }]
        : [],
    }));
  await f.confirmed('integration.provider-watch.create', {
    id: 'live',
    kind: 'twitch-live',
    source: { login: 'example' },
    channelId: C,
    intervalSeconds: 60,
  });
  await f.service.sweep(f.client, f.store, f.time);
  assert.equal(f.sent.length, 0);
  live = true;
  f.setTime(f.time + 60001);
  await f.service.sweep(f.client, f.store, f.time);
  assert.equal(f.sent.length, 1);
  assert.deepEqual((f.sent[0] as { allowedMentions: unknown }).allowedMentions, { parse: [] });
  f.setTime(f.time + 60001);
  await f.service.sweep(f.client, f.store, f.time);
  assert.equal(f.sent.length, 1);
  delete env.TWITCH_ACCESS_TOKEN;
  const before = f.calls.length;
  f.setTime(f.time + 60001);
  await f.service.sweep(f.client, f.store, f.time);
  assert.equal(f.calls.length, before);
});
test('Provider monitor ambiguous sends are never blindly retried and explicit delivered reconciliation advances the baseline', async (t) => {
  let live = false;
  const f = fixture(t, { ...ENV }, () => ({ data: live ? [{ id: 'stream-1' }] : [] }));
  await f.confirmed('integration.provider-watch.create', {
    id: 'live',
    kind: 'twitch-live',
    source: { login: 'example' },
    channelId: C,
    intervalSeconds: 60,
  });
  await f.service.sweep(f.client, f.store, f.time);
  live = true;
  f.channel.send = async (payload) => {
    f.sent.push(payload);
    throw new Error('Unknown remote outcome');
  };
  f.setTime(f.time + 60001);
  await f.service.sweep(f.client, f.store, f.time);
  assert.equal(f.sent.length, 1);
  f.setTime(f.time + 60001);
  await f.service.sweep(f.client, f.store, f.time);
  assert.equal(f.sent.length, 1);
  await assert.rejects(
    () => f.confirmed('integration.provider-watch.resume', { id: 'live', remoteStateReviewed: true }),
    /pendingOutcome/,
  );
  await f.confirmed('integration.provider-watch.resume', {
    id: 'live',
    remoteStateReviewed: true,
    pendingOutcome: 'delivered',
  });
  await f.service.sweep(f.client, f.store, f.time);
  assert.equal(f.sent.length, 1);
});
test('Provider monitors recheck author authority, module enablement and source-field schemas', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    () =>
      f.confirmed('integration.provider-watch.create', {
        id: 'bad',
        kind: 'twitch-live',
        source: { url: 'https://evil.example.org' },
        channelId: C,
      }),
    /exact source fields/,
  );
  await f.confirmed('integration.provider-watch.create', {
    id: 'live',
    kind: 'twitch-live',
    source: { login: 'example' },
    channelId: C,
  });
  f.store.set('core.disabled', G, ['integrations']);
  await f.service.sweep(f.client, f.store, f.time);
  assert.equal(f.calls.length, 0);
  f.store.set('core.disabled', G, []);
  f.member.permissions = new PermissionsBitField(0n);
  await f.service.sweep(f.client, f.store, f.time);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sent.length, 0);
});
test('Authenticated transport rejects private/mixed DNS, destination override and redirects without forwarding credentials', async () => {
  let calls = 0;
  const transport: ProviderTransport = {
    resolve: async () => [
      { address: '1.1.1.1', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
    connect: async () => {
      calls++;
      return { status: 200, body: Buffer.from('{}'), headers: {} };
    },
  };
  const client = providerHttp('fixture', 'https://api.example.org', transport);
  await assert.rejects(
    () => client('/data', { headers: { Authorization: 'Bearer never-forward' } }),
    /private/,
  );
  assert.equal(calls, 0);
  await assert.rejects(() => client('//evil.example.org'), /Invalid fixed/);
  transport.resolve = async () => [{ address: '1.1.1.1', family: 4 }];
  transport.connect = async (options) => {
    calls++;
    assert.equal(options.address, '1.1.1.1');
    assert.equal(options.url.origin, 'https://api.example.org');
    return { status: 302, body: Buffer.from('{}'), headers: { location: 'https://evil.example.org' } };
  };
  await assert.rejects(
    () => client('/data', { headers: { Authorization: 'Bearer bound' } }),
    /redirect refused/,
  );
  assert.equal(calls, 1);
});
test('Authenticated transport bounds response/body/JSON complexity and redacts credentials while preserving files', async () => {
  const transport: ProviderTransport = {
    resolve: async () => [{ address: '1.1.1.1', family: 4 }],
    connect: async () => ({ status: 200, body: Buffer.alloc(11), headers: {} }),
  };
  await assert.rejects(
    () => providerHttp('fixture', 'https://api.example.org', transport)('/data', { maxBytes: 10 }),
    /size limit/,
  );
  await assert.rejects(
    () =>
      providerHttp(
        'fixture',
        'https://api.example.org',
        transport,
      )('/data', { body: Buffer.alloc(8 * 1048576 + 1) }),
    /8 MiB/,
  );
  assert.throws(
    () =>
      providerJson(
        { status: 200, body: Buffer.from('['.repeat(42) + '0' + ']'.repeat(42)), headers: {} },
        'fixture',
      ),
    /complex/,
  );
  const safe = safeProviderValue(
    {
      access_token: 'never',
      nested: { title: 'secret-value-123', refresh_token: 'never' },
      attachment: Buffer.from('bytes'),
    },
    ['secret-value-123'],
  ) as { attachment: Buffer; nested: unknown };
  assert.ok(Buffer.isBuffer(safe.attachment));
  assert.deepEqual(safe.nested, { title: '[REDACTED]' });
});
test('Google renewable credentials coalesce refreshes, cache with expiry and do not use short-lived tokens after configuration removal', async () => {
  let calls = 0,
    time = 1000;
  const env: NodeJS.ProcessEnv = {
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_REFRESH_TOKEN: 'test-refresh-secret',
  };
  const transport: ProviderTransport = {
    resolve: async () => [{ address: '1.1.1.1', family: 4 }],
    connect: async (request) => {
      calls++;
      assert.equal(request.url.origin, 'https://oauth2.googleapis.com');
      assert.equal(new URLSearchParams(request.body!.toString()).get('grant_type'), 'refresh_token');
      return {
        status: 200,
        body: Buffer.from(JSON.stringify({ access_token: 'test-issued-token', expires_in: 120 })),
        headers: {},
      };
    },
  };
  const credentials = createCredentials({ env, transport, now: () => time }),
    ctx = {} as ActionContext;
  assert.deepEqual(await Promise.all([credentials.token('google', ctx), credentials.token('google', ctx)]), [
    'test-issued-token',
    'test-issued-token',
  ]);
  assert.equal(calls, 1);
  await credentials.token('google', ctx);
  assert.equal(calls, 1);
  time += 70000;
  await credentials.token('google', ctx);
  assert.equal(calls, 2);
  delete env.GOOGLE_REFRESH_TOKEN;
  assert.equal(integrationStatus(env).find((row) => row.id === 'google')?.enabled, false);
  await assert.rejects(() => credentials.token('google', ctx), /unavailable/);
  credentials.clear();
});

test('Ordinary members can use only their owned Google grants with exact user/server binding and required scopes', async (t) => {
  const f = fixture(
    t,
    { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'test-client-secret' },
    () => ({ items: [] }),
    {
      token: async (_provider, ctx) => ({
        token: 'test-owned-google-token',
        subjectUserId: ctx.member.id,
        subjectGuildId: ctx.guild.id,
        providerAccountId: 'owned-account',
        scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      }),
    },
  );
  f.member.id = '610000000000000099';
  f.member.permissions = new PermissionsBitField(P.ReadMessageHistory);
  assert.equal(f.service.status().find((row) => row.id === 'google')?.enabled, true);
  await f.run('integration.google-calendar.events');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.headers.Authorization, 'Bearer test-owned-google-token');
  await assert.rejects(
    () =>
      f.confirmed('integration.google-calendar.event-create', {
        title: 'Denied',
        start: '2026-11-02T10:00:00Z',
        end: '2026-11-02T10:30:00Z',
      }),
    /scope required/,
  );
  assert.equal(f.calls.length, 1);
});
test('Mismatched linked Google credentials never fall back to a shared host account', async (t) => {
  const f = fixture(t, { ...ENV }, () => ({ private: 'not delivered' }), {
    token: async () => ({
      token: 'wrong-user-token',
      subjectUserId: 'another-user',
      subjectGuildId: G,
      providerAccountId: 'other-account',
      scopes: ['https://www.googleapis.com/auth/drive'],
    }),
  });
  await assert.rejects(() => f.run('integration.google-drive.files'), /do not belong/);
  assert.equal(f.calls.length, 0);
});
test('Disconnecting a linked Google grant discards late private output without switching to global credentials', async (t) => {
  let linked = true;
  const f = fixture(
    t,
    { ...ENV },
    () => {
      linked = false;
      return { private: 'must not be returned' };
    },
    {
      token: async (_provider, ctx) =>
        linked
          ? {
              token: 'test-owned-google-token',
              subjectUserId: ctx.member.id,
              subjectGuildId: ctx.guild.id,
              providerAccountId: 'owned-account',
              scopes: ['https://www.googleapis.com/auth/drive.readonly'],
            }
          : undefined,
    },
  );
  f.member.id = '610000000000000099';
  f.member.permissions = new PermissionsBitField(P.ReadMessageHistory);
  await assert.rejects(() => f.run('integration.google-drive.files'), /disconnected/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.headers.Authorization, 'Bearer test-owned-google-token');
});
test('Legacy string token resolvers remain operator-only and an unlinked member receives the account-linking instruction', async (t) => {
  for (const token of ['test-legacy-shared-token', undefined])
    await t.test(String(token), async (sub) => {
      const f = fixture(
        sub,
        { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'test-client-secret' },
        () => ({ items: [] }),
        { token: async () => token },
      );
      f.member.id = '610000000000000099';
      f.member.permissions = new PermissionsBitField(P.ReadMessageHistory);
      await assert.rejects(
        () => f.run('integration.google-calendar.events'),
        /application owner|OPERATOR_IDS|oauth.start/,
      );
      assert.equal(f.calls.length, 0);
    });
});
test('A policy withdrawn during DNS resolution prevents even a confirmed external mutation from starting', async (t) => {
  const f = fixture(t);
  f.transport.resolve = async () => {
    f.store.set('core.actionPolicies', `${G}:integration.email.send`, {
      enabled: false,
      roleIds: [],
      channelIds: [],
    });
    return [{ address: '1.1.1.1', family: 4 }];
  };
  await assert.rejects(
    () =>
      f.confirmed('integration.email.send', {
        to: ['person@example.org'],
        subject: 'Reviewed',
        text: 'Body',
      }),
    /disabled/,
  );
  assert.equal(f.calls.length, 0);
});
test('Authenticated transport admits at most two calls per provider/four globally and releases capacity after failures', async () => {
  let release!: () => void,
    entered = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport: ProviderTransport = {
    resolve: async () => [{ address: '1.1.1.1', family: 4 }],
    connect: async () => {
      entered++;
      await gate;
      return { status: 200, body: Buffer.from('{}'), headers: {} };
    },
  };
  const a = providerHttp('limit-a', 'https://api.example.org', transport),
    b = providerHttp('limit-b', 'https://api.example.org', transport),
    c = providerHttp('limit-c', 'https://api.example.org', transport);
  const work = [a('/a'), a('/b'), b('/a'), b('/b')];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entered, 4);
  await assert.rejects(() => a('/c'), /busy/);
  await assert.rejects(() => c('/c'), /busy/);
  release();
  await Promise.all(work);
  await c('/c');
  assert.equal(entered, 5);
  transport.connect = async () => {
    throw new Error('private provider detail');
  };
  await assert.rejects(
    () => a('/fail'),
    (error) => error instanceof Error && !error.message.includes('private provider detail'),
  );
  transport.connect = async () => ({ status: 200, body: Buffer.from('{}'), headers: {} });
  await a('/after');
});

test('Authenticated GitHub private reads, issue writes and received emails use exact reviewed routes', async (t) => {
  const f = fixture(t);
  for (const [kind, suffix] of [
    ['repository', ''],
    ['commits', '/commits'],
    ['releases', '/releases'],
    ['issues', '/issues'],
    ['pulls', '/pulls'],
    ['runs', '/actions/runs'],
  ] as const) {
    await f.run('integration.github.read', { owner: 'team', repository: 'private', kind });
    const request = f.calls.at(-1)!;
    assert.equal(request.url.pathname, `/repos/team/private${suffix}`);
    assert.equal(request.headers.Authorization, `Bearer ${ENV.GITHUB_TOKEN}`);
    assert.equal(request.headers['X-GitHub-Api-Version'], '2026-03-10');
  }
  await f.confirmed('integration.github.issue-create', {
    owner: 'team',
    repository: 'private',
    title: 'Reviewed issue',
    text: 'Body',
  });
  assert.equal(f.calls.at(-1)!.method, 'POST');
  assert.deepEqual(body(f.calls.at(-1)!), { title: 'Reviewed issue', body: 'Body' });
  await f.run('integration.email.received', { emailId: '12345678-1234-1234-1234-123456789abc' });
  assert.equal(f.calls.at(-1)!.url.pathname, '/emails/receiving/12345678-1234-1234-1234-123456789abc');
});
test('Reauthorizing the same linked provider account cannot revive a response from the former grant version', async (t) => {
  let version = 'first';
  const f = fixture(
    t,
    { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'test-client-secret' },
    () => {
      version = 'second';
      return { private: 'old response' };
    },
    {
      token: async (_provider, ctx) => ({
        token: 'test-owned-token',
        subjectUserId: ctx.member.id,
        subjectGuildId: ctx.guild.id,
        providerAccountId: 'same-account',
        authorizationId: version,
        scopes: ['https://www.googleapis.com/auth/drive.file'],
      }),
    },
  );
  f.member.id = '610000000000000099';
  f.member.permissions = new PermissionsBitField(P.ReadMessageHistory);
  await assert.rejects(() => f.run('integration.google-drive.files'), /changed or was disconnected/);
  assert.equal(f.calls.length, 1);
});

test('Empty Google calendars establish a valid monitor baseline instead of failing serialization', async (t) => {
  const f = fixture(t, { ...ENV }, () => ({ kind: 'calendar#events' }));
  await f.confirmed('integration.provider-watch.create', {
    id: 'calendar',
    kind: 'google-calendar',
    source: { calendarId: 'primary' },
    channelId: C,
  });
  await f.service.sweep(f.client, f.store, f.time);
  const state = f.store.get<{ attempts: number; data: unknown; fingerprint?: string }>(
    'integrations.providerWatches',
    `${G}:calendar`,
  )!;
  assert.equal(state.attempts, 0);
  assert.deepEqual(state.data, []);
  assert.ok(state.fingerprint);
  assert.equal(f.sent.length, 0);
});

test('A persistent Google calendar watch cannot move to a reauthorized account or a changed shared credential', async (t) => {
  for (const mode of ['owned', 'shared'] as const)
    await t.test(mode, async (sub) => {
      let version = 'grant-v1';
      const env = { ...ENV },
        f = fixture(
          sub,
          env,
          () => ({ items: [{ id: 'event', summary: 'Private calendar title' }] }),
          mode === 'owned'
            ? {
                token: async () => ({
                  token: 'test-owned-token',
                  subjectUserId: U,
                  subjectGuildId: G,
                  providerAccountId: 'selected-google-account',
                  authorizationId: version,
                  scopes: ['https://www.googleapis.com/auth/calendar.events'],
                }),
              }
            : {},
        );
      await f.confirmed('integration.provider-watch.create', {
        id: 'calendar',
        kind: 'google-calendar',
        source: { calendarId: 'primary' },
        channelId: C,
        intervalSeconds: 60,
      });
      await f.service.sweep(f.client, f.store, f.time);
      assert.equal(f.calls.length, 1);
      version = 'grant-v2';
      if (mode === 'shared') env.GOOGLE_ACCESS_TOKEN = 'another-shared-account-token';
      f.setTime(f.time + 60001);
      await f.service.sweep(f.client, f.store, f.time);
      assert.equal(f.calls.length, 1, 'Changed account must be rejected before any calendar read.');
      assert.equal(f.sent.length, 0);
      assert.equal(
        f.store.get<{ attempts: number }>('integrations.providerWatches', `${G}:calendar`)?.attempts,
        1,
      );
    });
});
test('Parcel monitors announce changed delivery metadata without retaining or publishing customer addresses', async (t) => {
  let date = '2026-11-02';
  const f = fixture(t, { ...ENV }, () => ({
    data: {
      id: 'tracking',
      tag: 'InTransit',
      aftership_estimated_delivery_date: { estimated_delivery_date: date },
      customer: { name: 'Private customer', address: 'Private address' },
      destination_raw_location: 'Private location',
    },
  }));
  await f.confirmed('integration.provider-watch.create', {
    id: 'parcel',
    kind: 'parcels',
    source: { trackingId: 'tracking' },
    channelId: C,
    intervalSeconds: 60,
  });
  await f.service.sweep(f.client, f.store, f.time);
  date = '2026-11-03';
  f.setTime(f.time + 60001);
  await f.service.sweep(f.client, f.store, f.time);
  assert.equal(f.sent.length, 1);
  const stored = JSON.stringify(f.store.get('integrations.providerWatches', `${G}:parcel`));
  assert.ok(!stored.includes('Private'));
  assert.ok(!JSON.stringify(f.sent).includes('Private'));
  assert.match(JSON.stringify(f.sent), /2026-11-03/);
});
test('A specific GitHub pull monitor uses its exact number and emits status changes without issue bodies', async (t) => {
  let state = 'open';
  const f = fixture(t, { ...ENV }, () => ({
    number: 42,
    state,
    title: 'Reviewed title',
    body: 'Private body',
    html_url: 'https://github.com/team/private/pull/42',
  }));
  await f.confirmed('integration.provider-watch.create', {
    id: 'pull',
    kind: 'github-pulls',
    source: { owner: 'team', repository: 'private', number: '42' },
    channelId: C,
    intervalSeconds: 60,
  });
  await f.service.sweep(f.client, f.store, f.time);
  assert.equal(f.calls[0]!.url.pathname, '/repos/team/private/pulls/42');
  state = 'closed';
  f.setTime(f.time + 60001);
  await f.service.sweep(f.client, f.store, f.time);
  assert.equal(f.sent.length, 1);
  assert.ok(!JSON.stringify(f.sent).includes('Private body'));
});
test('Disabling and re-enabling integrations during DNS invalidates the old confirmed operation', async (t) => {
  const f = fixture(t);
  f.transport.resolve = async () => {
    f.store.set('core.featureEpochs', `${G}:integrations`, 2);
    return [{ address: '1.1.1.1', family: 4 }];
  };
  await assert.rejects(
    () =>
      f.confirmed('integration.email.send', {
        to: ['person@example.org'],
        subject: 'Reviewed',
        text: 'Body',
      }),
    /settings changed/,
  );
  assert.equal(f.calls.length, 0);
});
