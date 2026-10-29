import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { PermissionFlagsBits as P, PermissionsBitField, type Client } from 'discord.js';
import type { ActionContext } from '../src/core/types.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import { createAccountLinking } from '../src/services/account-linking.js';
import type { ProviderTransport, ProviderRequest } from '../src/integrations/http.js';
const G = '610000000000000001',
  U = '610000000000000002',
  B = '610000000000000003',
  C = '610000000000000004',
  OTHER = '610000000000000005';
async function fixture(t: TestContext) {
  const store = new Store(':memory:'),
    registry = new ActionRegistry(),
    calls: ProviderRequest[] = [],
    permissions = new PermissionsBitField(P.Administrator);
  const member = { id: U, user: { id: U }, permissions, roles: { cache: new Map() } },
    bot = { ...member, id: B },
    other = { ...member, id: OTHER };
  const channel = { id: C, guildId: G, type: 0, permissionsFor: () => permissions };
  const guild = {
    id: G,
    members: {
      me: bot,
      fetchMe: async () => bot,
      fetch: async (input: { user: string } | string) =>
        (typeof input === 'string' ? input : input.user) === OTHER ? other : member,
    },
    channels: { fetch: async () => channel },
  };
  const client = { guilds: { fetch: async () => guild }, application: { id: B } } as unknown as Client,
    ctx = { store, client, guild, member, channelId: C } as unknown as ActionContext;
  let service: ReturnType<typeof createAccountLinking> | undefined,
    current = 1000000000000;
  const server = createServer((req, res) => {
    void service!.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No OAuth port');
  const base = `http://127.0.0.1:${address.port}`;
  const transport: ProviderTransport = {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    connect: async (input) => {
      calls.push(input);
      const raw = input.url.pathname.endsWith('/token')
        ? {
            access_token: 'test-provider-access-secret',
            refresh_token: 'test-provider-refresh-secret',
            expires_in: 3600,
            scope: 'openid profile email https://www.googleapis.com/auth/calendar.events',
          }
        : input.url.hostname === 'openidconnect.googleapis.com'
          ? { sub: 'google-account-123', name: 'Private provider name', email: 'person@example.test' }
          : { id: U, username: 'Discord test user' };
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify(raw)),
      };
    },
  };
  service = createAccountLinking({
    env: {
      APP_PUBLIC_URL: base,
      GOOGLE_CLIENT_ID: 'google-client',
      GOOGLE_CLIENT_SECRET: 'google-client-secret',
      DISCORD_CLIENT_ID: B,
      DISCORD_CLIENT_SECRET: 'discord-client-secret',
    },
    store,
    client,
    registry,
    allowedGuildIds: [G],
    transport,
    now: () => current,
    encryptionKey: Buffer.alloc(32, 1),
  });
  service.registerActions();
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service!.close();
    store.close();
  });
  async function run(id: string, input: unknown = {}, context = ctx) {
    const outcome = await registry.request(context, id, input);
    return outcome.status === 'confirmation' ? registry.confirm(context, outcome.id) : outcome;
  }
  async function start(provider = 'google') {
    const outcome = await run('oauth.start', {
      provider,
      purpose: provider === 'google' ? 'calendar' : 'identity',
    });
    assert.equal(outcome.status, 'completed');
    if (outcome.status !== 'completed') throw new Error('No link');
    const link = (outcome.result as { url: string }).url,
      response = await fetch(link, { redirect: 'manual' }),
      cookie = response.headers.get('set-cookie')!.split(';')[0]!,
      location = new URL(response.headers.get('location')!);
    assert.equal(response.status, 302);
    return { cookie, state: location.searchParams.get('state')!, location };
  }
  const callback = (
    flow: { cookie: string; state: string },
    provider = 'google',
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}/oauth/callback/${provider}?state=${flow.state}&code=test-code`, {
      headers: { cookie: flow.cookie, ...headers },
    });
  return {
    store,
    registry,
    ctx,
    service,
    calls,
    base,
    run,
    start,
    callback,
    advance: (ms: number) => {
      current += ms;
    },
  };
}
test('OAuth uses single-use browser-bound PKCE and saves tokens only after exact Discord account confirmation', async (t) => {
  const f = await fixture(t),
    flow = await f.start();
  assert.equal(flow.location.hostname, 'accounts.google.com');
  assert.equal(flow.location.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(flow.location.searchParams.get('code_challenge'));
  assert.equal((await f.callback({ ...flow, cookie: 'oauth_state=wrong' })).status, 401);
  assert.equal(f.calls.length, 0);
  const response = await f.callback(flow);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /oauth.link.confirm/);
  assert.ok(!text.includes('test-provider-access-secret'));
  assert.equal(f.store.list('oauth.accounts').length, 0);
  const pending = f.store.list<{ id: string; identity: { id: string } }>('oauth.flows')[0]!.value;
  await assert.rejects(
    () => f.run('oauth.link.confirm', { id: pending.id, provider: 'google', accountId: 'someone-else' }),
    /does not belong/,
  );
  await f.run('oauth.link.confirm', { id: pending.id, provider: 'google', accountId: pending.identity.id });
  assert.equal(f.store.list('oauth.accounts').length, 1);
  const persisted = JSON.stringify(f.store.list('oauth.accounts'));
  assert.ok(!persisted.includes('test-provider-access-secret'));
  assert.ok(!persisted.includes('test-provider-refresh-secret'));
  const credential = await f.service.credential('google', f.ctx);
  assert.equal(credential?.subjectUserId, U);
  assert.equal(credential?.subjectGuildId, G);
  assert.equal(credential?.token, 'test-provider-access-secret');
  assert.equal(credential?.current(), true);
  assert.equal((await f.callback(flow)).status, 401);
});
test('Another Discord member cannot approve a provider link, and unlink invalidates issued credentials immediately', async (t) => {
  const f = await fixture(t),
    flow = await f.start();
  await f.callback(flow);
  const pending = f.store.list<{ id: string; identity: { id: string } }>('oauth.flows')[0]!.value;
  await assert.rejects(
    () =>
      f.run(
        'oauth.link.confirm',
        { id: pending.id, provider: 'google', accountId: pending.identity.id },
        { ...f.ctx, member: { ...f.ctx.member, id: OTHER } as ActionContext['member'] },
      ),
    /does not belong/,
  );
  await f.run('oauth.link.confirm', { id: pending.id, provider: 'google', accountId: pending.identity.id });
  const credential = await f.service.credential('google', f.ctx);
  f.store.set('core.disabled', G, ['identity']);
  await f.run('oauth.unlink', { provider: 'google' });
  assert.equal(credential?.current(), false);
  assert.equal(await f.service.credential('google', f.ctx), undefined);
});
test('OAuth callback rejects changed hosts, expires links, and uses fresh channel membership before connecting accounts', async (t) => {
  const f = await fixture(t),
    flow = await f.start();
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      `${f.base}/oauth/callback/google?state=${flow.state}&code=test-code`,
      { headers: { host: 'attacker.example', cookie: flow.cookie } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.once('error', reject);
    request.end();
  });
  assert.equal(status, 403);
  assert.equal(f.calls.length, 0);
  f.advance(600001);
  assert.equal((await f.callback(flow)).status, 401);
  assert.equal(f.calls.length, 0);
});
test('Discord OAuth authenticates only the requesting Discord identity and issues a private account dashboard session', async (t) => {
  const f = await fixture(t),
    flow = await f.start('discord'),
    response = await f.callback(flow, 'discord');
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie(),
    session = cookies.find((value) => value.startsWith('account_session='))!.split(';')[0]!;
  const account = await fetch(`${f.base}/account`, { headers: { cookie: session } });
  assert.equal(account.status, 200);
  assert.match(await account.text(), new RegExp(U));
  assert.equal((await fetch(`${f.base}/account`)).status, 401);
});
