import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PermissionFlagsBits as P, PermissionsBitField, type Client } from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import { createCaptchaService } from '../src/services/captcha.js';
import { registerWebsiteAnalyticsActions } from '../src/features/website-analytics.js';
import { registerServiceStatus } from '../src/features/service-status.js';
import { loadConfig } from '../src/config.js';
import type { ProviderRequest, ProviderTransport } from '../src/integrations/http.js';

const G = '650000000000000001',
  U = '650000000000000002',
  B = '650000000000000003',
  C = '650000000000000004';
async function fixture(t: TestContext) {
  const store = new Store(':memory:'),
    registry = new ActionRegistry(),
    permissions = new PermissionsBitField(P.Administrator);
  const member = { id: U, user: { id: U, username: 'Fixture' }, permissions, roles: { cache: new Map() } },
    bot = { ...member, id: B };
  const channel = { id: C, guildId: G, type: 0, permissionsFor: () => permissions };
  const guild = {
    id: G,
    ownerId: U,
    members: { me: bot, fetch: async () => member, fetchMe: async () => bot },
    channels: { fetch: async () => channel },
  };
  const client = {
    application: { owner: { id: U } },
    guilds: { fetch: async () => guild },
  } as unknown as Client;
  const ctx = { client, guild, member, channelId: C, store } as unknown as ActionContext;
  let service!: ReturnType<typeof createCaptchaService>,
    hostname = '127.0.0.1',
    onRequest: (req: ProviderRequest) => void = () => {};
  const server = createServer((req, res) => {
    void service.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture listener');
  const base = `http://127.0.0.1:${address.port}`,
    calls: ProviderRequest[] = [];
  const env = {
    APP_PUBLIC_URL: base,
    TURNSTILE_SITE_KEY: 'fixture-site',
    TURNSTILE_SECRET_KEY: 'fixture-secret',
    PLAUSIBLE_API_KEY: 'fixture-plausible-secret',
    PLAUSIBLE_SITE_ID: 'example.org',
  };
  const transport: ProviderTransport = {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    connect: async (req) => {
      calls.push(req);
      onRequest(req);
      const flow = store.list<{ id: string }>('captcha.flows')[0]?.value;
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify(
            req.url.hostname === 'plausible.io'
              ? { results: [{ metrics: [12, 20, 30], dimensions: [] }] }
              : { success: true, action: 'verify-member', cdata: flow?.id, hostname },
          ),
        ),
      };
    },
  };
  service = createCaptchaService({ env, store, registry, transport });
  service.registerActions();
  registerWebsiteAnalyticsActions(registry, { env, operatorIds: [U], transport });
  registerServiceStatus(registry, { env, operatorIds: [U], healthPort: address.port });
  t.after(async () => {
    service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  const execute = async (id: string, input: unknown = {}) => {
    const result = await registry.request(ctx, id, input);
    return result.status === 'confirmation'
      ? ((await registry.confirm(ctx, result.id)) as { result: unknown }).result
      : result.result;
  };
  async function challenge() {
    store.set('ui.verification', G, { version: 'rules-1', captchaRequired: true });
    const link = (await execute('verification.captcha.start')) as { url: string };
    const page = await fetch(link.url);
    const cookie = page.headers.get('set-cookie')!.split(';')[0]!;
    await page.text();
    return { url: link.url, cookie };
  }
  const submit = (url: string, cookie: string) =>
    fetch(url, {
      method: 'POST',
      headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'cf-turnstile-response=fixture-answer',
    });
  return {
    store,
    registry,
    ctx,
    service,
    env,
    calls,
    execute,
    challenge,
    submit,
    setHostname: (value: string) => {
      hostname = value;
    },
    onRequest: (hook: typeof onRequest) => {
      onRequest = hook;
    },
  };
}
test('CAPTCHA browser proof is accepted once in the exact current verification context', async (t) => {
  const f = await fixture(t),
    challenge = await f.challenge();
  assert.equal((await f.submit(challenge.url, challenge.cookie)).status, 200);
  f.service.assertCaptcha(f.ctx, 'rules-1');
  assert.throws(() => f.service.assertCaptcha(f.ctx, 'rules-1'), /fresh/);
  assert.equal((await f.submit(challenge.url, challenge.cookie)).status, 401);
  assert.equal(f.calls.length, 1);
});
test('CAPTCHA rejects another browser and mismatched provider hostname without a proof', async (t) => {
  const f = await fixture(t),
    challenge = await f.challenge();
  assert.equal((await f.submit(challenge.url, 'captcha_session=wrong')).status, 401);
  assert.equal(f.calls.length, 0);
  f.setHostname('attacker.example');
  assert.equal((await f.submit(challenge.url, challenge.cookie)).status, 403);
  assert.equal(f.store.list('captcha.proofs').length, 0);
});
test('CAPTCHA proof cannot survive a server policy epoch change', async (t) => {
  const f = await fixture(t),
    challenge = await f.challenge();
  assert.equal((await f.submit(challenge.url, challenge.cookie)).status, 200);
  f.store.set('core.featureEpochs', `${G}:interfaces`, 1);
  assert.throws(() => f.service.assertCaptcha(f.ctx, 'rules-1'), /fresh/);
});
test('website analytics sends a bounded fixed-site authenticated Stats API query', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await f.execute('website.analytics', {
      metrics: ['visitors', 'conversion_rate'],
      goal: 'Signup',
      limit: 10,
    }),
    { results: [{ metrics: [12, 20, 30], dimensions: [] }] },
  );
  const req = f.calls[0]!;
  assert.equal(req.url.href, 'https://plausible.io/api/v2/query');
  assert.equal(req.headers.Authorization, 'Bearer fixture-plausible-secret');
  assert.deepEqual(JSON.parse(req.body!.toString()), {
    site_id: 'example.org',
    metrics: ['visitors', 'conversion_rate'],
    date_range: '7d',
    dimensions: [],
    filters: [['is', 'event:goal', ['Signup']]],
    pagination: { limit: 10, offset: 0 },
  });
  await assert.rejects(() => f.execute('website.analytics', { metrics: ['conversion_rate'] }), /goal/);
  await assert.rejects(() => f.execute('website.analytics', { site: 'unapproved.example' }));
});
test('website analytics drops remote results after access changes and configuration status never exposes secrets', async (t) => {
  const f = await fixture(t);
  f.onRequest(() =>
    f.store.set('core.actionPolicies', `${G}:website.analytics`, {
      enabled: false,
      roleIds: [],
      channelIds: [],
    }),
  );
  await assert.rejects(() => f.execute('website.analytics'), /disabled/);
  const status = JSON.stringify(await f.execute('system.services'));
  assert(!status.includes(f.env.PLAUSIBLE_API_KEY));
  assert(status.includes('PLAUSIBLE_API_KEY'));
});
test('optional hosted configuration starts the companion listener; unrelated blanks leave it off', () => {
  assert.equal(loadConfig({}).healthPort, 0);
  assert.equal(loadConfig({ APP_PUBLIC_URL: 'https://bot.example.org', HEALTH_PORT: '0' }).healthPort, 3000);
  assert.equal(
    loadConfig({ ACTIVITY_PUBLIC_URL: 'https://activity.example.org', HEALTH_PORT: '3456' }).healthPort,
    3456,
  );
  assert.equal(loadConfig({ DEPLOYMENT_WEBHOOK_SECRET: 'fixture-secret' }).healthPort, 3000);
});
