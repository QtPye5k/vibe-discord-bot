import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PermissionsBitField, PermissionFlagsBits as P, type Client } from 'discord.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import { createAccountLinking } from '../src/services/account-linking.js';
import { createCaptchaService } from '../src/services/captcha.js';
import { createActivityService } from '../src/activities/service.js';
import { registerRemoteHostActions } from '../src/features/remote-host.js';
import type { ProviderTransport, ProviderRequest } from '../src/integrations/http.js';

const G = '630000000000000001',
  U = '630000000000000002',
  B = '630000000000000003',
  C = '630000000000000004';
const TARGET = '630000000000000005';
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function fixture(
  t: TestContext,
  activityOverrides: Partial<Parameters<typeof createActivityService>[0]> = {},
) {
  const store = new Store(':memory:'),
    registry = new ActionRegistry(),
    permissions = new PermissionsBitField(P.Administrator);
  let membershipHook: (() => Promise<void> | void) | undefined,
    transportHook: ((request: ProviderRequest) => Promise<void> | void) | undefined,
    keyHook: (() => void) | undefined,
    authenticationHook: (() => Promise<void> | void) | undefined,
    joinHook: (() => Promise<void> | void) | undefined,
    current = 1700000000000;
  const member = {
      id: U,
      user: { id: U, username: 'Fixture user' },
      permissions,
      roles: { cache: new Map() },
    },
    bot = { ...member, id: B },
    channel = { id: C, guildId: G, type: 0, permissionsFor: () => permissions };
  const guild = {
    id: G,
    members: {
      me: bot,
      fetchMe: async () => bot,
      fetch: async () => {
        await membershipHook?.();
        return member;
      },
    },
    channels: { fetch: async () => channel },
  };
  const joins: { userId: string; options: Record<string, unknown> }[] = [],
    targetBot = { ...bot, permissions: new PermissionsBitField(P.Administrator) },
    targetGuild = {
      ...guild,
      id: TARGET,
      members: {
        ...guild.members,
        fetchMe: async () => targetBot,
        add: async (userId: string, options: Record<string, unknown>) => {
          joins.push({ userId, options });
          await joinHook?.();
          return { id: userId, pending: true };
        },
      },
    };
  const client = {
    guilds: { fetch: async (id: string) => (id === TARGET ? targetGuild : guild) },
    application: {
      id: B,
      fetchActivityInstance: async (instanceId: string) => ({
        applicationId: B,
        instanceId,
        users: [U],
        location: { guildId: G, channelId: C },
      }),
    },
  } as unknown as Client;
  const ctx = { client, store, guild, member, channelId: C } as unknown as ActionContext;
  let oauth!: ReturnType<typeof createAccountLinking>,
    captcha!: ReturnType<typeof createCaptchaService>,
    activity!: ReturnType<typeof createActivityService>;
  const server = createServer((request, response) => {
    void (async () => {
      if (
        (await oauth.handle(request, response)) ||
        (await captcha.handle(request, response)) ||
        (await activity.handle(request, response))
      )
        return;
      response.writeHead(404);
      response.end();
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const base = `http://127.0.0.1:${address.port}`,
    env = {
      APP_PUBLIC_URL: base,
      ACTIVITY_PUBLIC_URL: base,
      DISCORD_CLIENT_ID: B,
      DISCORD_CLIENT_SECRET: 'fixture-discord-secret',
      GOOGLE_CLIENT_ID: 'fixture-google-client',
      GOOGLE_CLIENT_SECRET: 'fixture-google-secret',
      TURNSTILE_SITE_KEY: 'fixture-site',
      TURNSTILE_SECRET_KEY: 'fixture-turnstile-secret',
      OAUTH_JOIN_GUILD_IDS: TARGET,
    };
  const transport: ProviderTransport = {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    connect: async (request) => {
      await transportHook?.(request);
      let data: unknown;
      if (request.url.pathname.endsWith('/siteverify')) {
        const flow = store.list<{ id: string }>('captcha.flows')[0]!.value;
        data = { success: true, action: 'verify-member', cdata: flow.id, hostname: '127.0.0.1' };
      } else if (request.url.pathname.endsWith('/token'))
        data = {
          access_token: 'fixture-provider-access-secret',
          refresh_token: 'fixture-provider-refresh-secret',
          expires_in: 3600,
          scope:
            'identify guilds.join application_identities.write openid profile email https://www.googleapis.com/auth/calendar.events',
        };
      else
        data =
          request.url.hostname === 'openidconnect.googleapis.com'
            ? { sub: 'fixture-google-account', name: 'Private name' }
            : { id: U, username: 'Fixture user' };
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify(data)),
      };
    },
  };
  const oauthOptions = {
    env,
    store,
    client,
    registry,
    allowedGuildIds: [G],
    transport,
    now: () => current,
    get encryptionKey() {
      keyHook?.();
      return Buffer.alloc(32, 2);
    },
  };
  oauth = createAccountLinking(oauthOptions);
  oauth.registerActions();
  captcha = createCaptchaService({ env, store, registry, transport, now: () => current });
  captcha.registerActions();
  activity = createActivityService({
    env,
    store,
    client,
    registry,
    allowedGuildIds: [G],
    now: () => current,
    authenticate: async () => {
      await authenticationHook?.();
      return {
        accessToken: 'fixture-discord-activity-secret',
        identity: { id: U, name: 'Fixture user' },
        expiresAt: current + 3600000,
      };
    },
    ...activityOverrides,
  });
  activity.registerActions();
  t.after(async () => {
    oauth.close();
    captcha.close();
    activity.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  });
  async function execute(id: string, input: unknown = {}) {
    const action = registry.get(id);
    return action.execute(ctx, action.schema.parse(input));
  }
  async function oauthStart(
    provider: 'google' | 'discord' = 'google',
    purpose?: string,
    joinGuildId = TARGET,
  ) {
    const started = (await execute('oauth.start', {
      provider,
      purpose: purpose ?? (provider === 'google' ? 'calendar' : 'identity'),
      ...(purpose === 'join' ? { joinGuildId } : {}),
    })) as { url: string };
    const response = await fetch(started.url, { redirect: 'manual' });
    assert.equal(response.status, 302);
    const destination = new URL(response.headers.get('location')!);
    return {
      state: destination.searchParams.get('state')!,
      cookie: response.headers.getSetCookie()[0]!.split(';')[0]!,
      provider,
      destination,
    };
  }
  async function callback(flow: Awaited<ReturnType<typeof oauthStart>>) {
    return fetch(`${base}/oauth/callback/${flow.provider}?state=${flow.state}&code=fixture-code`, {
      headers: { cookie: flow.cookie },
    });
  }
  const post = (path: string, data: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        origin: base,
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(data),
    });
  return {
    store,
    registry,
    client,
    ctx,
    base,
    oauth,
    activity,
    captcha,
    execute,
    oauthStart,
    callback,
    post,
    setMembershipHook(hook: typeof membershipHook) {
      membershipHook = hook;
    },
    setTransportHook(hook: typeof transportHook) {
      transportHook = hook;
    },
    setKeyHook(hook: typeof keyHook) {
      keyHook = hook;
    },
    setAuthenticationHook(hook: typeof authenticationHook) {
      authenticationHook = hook;
    },
    joins,
    targetBot,
    setJoinHook(hook: typeof joinHook) {
      joinHook = hook;
    },
    advance(ms: number) {
      current += ms;
    },
  };
}

test('OAuth erasure during encryption cannot recreate a pending authorization', async (t) => {
  const f = await fixture(t),
    flow = await f.oauthStart();
  f.setKeyHook(() => {
    for (const row of f.store.list('oauth.flows')) f.store.delete('oauth.flows', row.key);
  });
  assert.equal((await f.callback(flow)).status, 409);
  assert.equal(f.store.list('oauth.flows').length, 0);
  assert.equal(f.store.list('oauth.accounts').length, 0);
});

test('Pending OAuth confirmation is invalidated by identity disable/re-enable during membership refresh', async (t) => {
  const f = await fixture(t),
    flow = await f.oauthStart();
  assert.equal((await f.callback(flow)).status, 200);
  const pending = f.store.list<{ id: string; identity: { id: string } }>('oauth.flows')[0]!.value;
  f.setMembershipHook(() => {
    f.setMembershipHook(undefined);
    f.store.set('core.featureEpochs', `${G}:identity`, 2);
  });
  await assert.rejects(() =>
    f.execute('oauth.link.confirm', { id: pending.id, provider: 'google', accountId: pending.identity.id }),
  );
  assert.equal(f.store.list('oauth.accounts').length, 0);
});

test('OAuth start and final confirmation recheck changed action policy before writing flow/account state', async (t) => {
  const f = await fixture(t),
    started = (await f.execute('oauth.start', { provider: 'google', purpose: 'identity' })) as {
      url: string;
    };
  f.setMembershipHook(() => {
    f.setMembershipHook(undefined);
    f.store.set('core.actionPolicies', `${G}:oauth.start`, { enabled: false, roleIds: [], channelIds: [] });
  });
  assert.notEqual((await fetch(started.url, { redirect: 'manual' })).status, 302);
  f.store.delete('core.actionPolicies', `${G}:oauth.start`);
  const flow = await f.oauthStart();
  assert.equal((await f.callback(flow)).status, 200);
  const pending = f.store
    .list<{ id: string; identity?: { id: string } }>('oauth.flows')
    .find((row) => row.value.identity)!.value;
  f.setMembershipHook(() => {
    f.setMembershipHook(undefined);
    f.store.set('core.actionPolicies', `${G}:oauth.link.confirm`, {
      enabled: false,
      roleIds: [],
      channelIds: [],
    });
  });
  await assert.rejects(
    () =>
      f.execute('oauth.link.confirm', {
        id: pending.id,
        provider: 'google',
        accountId: pending.identity!.id,
      }),
    /disabled/,
  );
  assert.equal(f.store.list('oauth.accounts').length, 0);
});

test('An identity-only Google flow cannot regain prior data privileges from a broader provider token', async (t) => {
  const f = await fixture(t),
    flow = await f.oauthStart('google', 'identity');
  assert.equal((await f.callback(flow)).status, 200);
  const pending = f.store.list<{ id: string; identity: { id: string } }>('oauth.flows')[0]!.value;
  await f.execute('oauth.link.confirm', {
    id: pending.id,
    provider: 'google',
    accountId: pending.identity.id,
  });
  const credential = await f.oauth.credential('google', f.ctx);
  assert.ok(credential);
  assert.equal(credential.scopes.includes('https://www.googleapis.com/auth/calendar.events'), false);
});

async function linkOwnDiscord(f: Awaited<ReturnType<typeof fixture>>, purpose: string) {
  const flow = await f.oauthStart('discord', purpose);
  assert.equal((await f.callback(flow)).status, 200);
  const pending = f.store
    .list<{ id: string; identity: { id: string } }>('oauth.flows')
    .find((row) => row.value.identity)?.value;
  assert.ok(pending);
  await f.execute('oauth.link.confirm', {
    id: pending.id,
    provider: 'discord',
    accountId: pending.identity.id,
  });
  return flow;
}

test('Discord self-join requires exact target consent and a normal confirmation; game-stats grants retain only their requested scope', async (t) => {
  const f = await fixture(t),
    flow = await linkOwnDiscord(f, 'join');
  assert.equal(flow.destination.searchParams.get('scope'), 'identify guilds.join');
  const preview = await f.registry.request(f.ctx, 'oauth.guild.join', { guildId: TARGET });
  assert.equal(preview.status, 'confirmation');
  assert.equal(f.joins.length, 0);
  if (preview.status !== 'confirmation') return;
  const joined = await f.registry.confirm(f.ctx, preview.id);
  assert.equal(joined.status, 'completed');
  assert.equal(f.joins.length, 1);
  assert.deepEqual(Object.keys(f.joins[0]!.options).sort(), ['accessToken', 'fetchWhenExisting', 'force']);
  assert.equal(f.joins[0]!.userId, U);
  const ledger = f.store.list<{ state: string }>('oauth.joins');
  assert.equal(ledger[0]!.value.state, 'joined');
  assert.equal(JSON.stringify(ledger).includes('fixture-provider-access-secret'), false);
  await assert.rejects(() => f.execute('oauth.guild.join', { guildId: G }), /approved/);
  await linkOwnDiscord(f, 'game-stats');
  const auth = await f.oauth.credential('discord', f.ctx);
  assert.deepEqual(auth?.scopes, ['identify', 'application_identities.write']);
  await assert.rejects(() => f.execute('oauth.guild.join', { guildId: TARGET }), /exact joinGuildId/);
});

test('OAuth self-join rejects identity-only consent, missing target bot permission and revocation before dispatch', async (t) => {
  const f = await fixture(t);
  await assert.rejects(() => f.oauthStart('discord', 'join', G), /approved/);
  await linkOwnDiscord(f, 'identity');
  await assert.rejects(() => f.execute('oauth.guild.join', { guildId: TARGET }), /exact joinGuildId/);
  await linkOwnDiscord(f, 'join');
  f.targetBot.permissions.remove(P.Administrator);
  await assert.rejects(() => f.execute('oauth.guild.join', { guildId: TARGET }), /Create Instant Invite/);
  f.targetBot.permissions.add(P.Administrator);
  f.setMembershipHook(async () => {
    f.setMembershipHook(undefined);
    await f.execute('oauth.unlink', { provider: 'discord' });
  });
  await assert.rejects(() => f.execute('oauth.guild.join', { guildId: TARGET }), /authorization changed/);
  assert.equal(f.joins.length, 0);
});

test('Unlinking during a dispatched self-join preserves its unknown outcome and requires explicit review before retry', async (t) => {
  const f = await fixture(t);
  await linkOwnDiscord(f, 'join');
  const entered = latch(),
    finish = latch();
  f.setJoinHook(async () => {
    entered.release();
    await finish.promise;
  });
  const pending = f.execute('oauth.guild.join', { guildId: TARGET });
  await entered.promise;
  await f.execute('oauth.unlink', { provider: 'discord' });
  finish.release();
  await assert.rejects(() => pending, /requires review/);
  assert.equal(f.joins.length, 1);
  assert.equal(f.store.list<{ state: string }>('oauth.joins')[0]!.value.state, 'unknown');
  await linkOwnDiscord(f, 'join');
  f.setJoinHook(undefined);
  await assert.rejects(() => f.execute('oauth.guild.join', { guildId: TARGET }), /remoteStateReviewed/);
  assert.equal(f.joins.length, 1);
  await f.execute('oauth.guild.join', { guildId: TARGET, remoteStateReviewed: true });
  assert.equal(f.joins.length, 2);
});

test('Account dashboard rechecks a session revoked while its membership refresh is pending', async (t) => {
  const f = await fixture(t),
    flow = await f.oauthStart('discord'),
    callback = await f.callback(flow);
  const cookie = callback.headers
    .getSetCookie()
    .find((value) => value.startsWith('account_session='))!
    .split(';')[0]!;
  f.setMembershipHook(async () => {
    f.setMembershipHook(undefined);
    await f.execute('oauth.unlink', { provider: 'discord' });
  });
  assert.equal((await fetch(`${f.base}/account`, { headers: { cookie } })).status, 401);
});

test('CAPTCHA disable/re-enable while siteverify is pending cannot issue a reusable verification proof', async (t) => {
  const f = await fixture(t),
    entered = latch(),
    finish = latch();
  f.store.set('ui.verification', G, { version: 'rules-v1', captchaRequired: true });
  const link = (await f.execute('verification.captcha.start')) as { url: string },
    page = await fetch(link.url);
  const cookie = page.headers.getSetCookie()[0]!.split(';')[0]!;
  f.setTransportHook(async (request) => {
    if (request.url.pathname.endsWith('/siteverify')) {
      entered.release();
      await finish.promise;
    }
  });
  const response = fetch(link.url, {
    method: 'POST',
    headers: { origin: f.base, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'cf-turnstile-response=fixture-response',
  });
  await entered.promise;
  f.store.set('core.featureEpochs', `${G}:interfaces`, 2);
  finish.release();
  assert.equal((await response).status, 409);
  assert.equal(f.store.list('captcha.proofs').length, 0);
});

test('Activity native authentication verifies actual Discord instance membership', async (t) => {
  const f = await fixture(t);
  f.client.application!.fetchActivityInstance = async () => {
    throw new Error('No such real instance');
  };
  const response = await f.post('/activity/api/auth', {
    code: 'fixture-code',
    guildId: G,
    channelId: C,
    instanceId: 'fabricated-instance',
  });
  assert.notEqual(response.status, 200);
  assert.equal(f.store.list('activity.rooms').length, 0);
});

test('Native Activity authentication creates no room before the authenticated SDK user joins the verified instance', async (t) => {
  const f = await fixture(t),
    input = { code: 'fixture-code', guildId: G, channelId: C, instanceId: 'i-fixture' };
  let connected = false;
  f.client.application!.fetchActivityInstance = (async (instanceId: string) => ({
    applicationId: B,
    instanceId,
    location: { guildId: G, channelId: C },
    users: connected ? [U] : [],
  })) as NonNullable<Client['application']>['fetchActivityInstance'];
  const response = await f.post('/activity/api/auth', input),
    authorization = (await response.json()) as {
      pending: string;
      access_token: string;
      userId: string;
      token?: string;
      room?: unknown;
    };
  assert.equal(response.status, 200);
  assert.ok(authorization.pending);
  assert.equal(authorization.access_token, 'fixture-discord-activity-secret');
  assert.equal(authorization.userId, U);
  assert.equal(authorization.token, undefined);
  assert.equal(authorization.room, undefined);
  assert.equal(f.store.list('activity.rooms').length, 0);
  assert.equal((await f.post('/activity/api/join', { pending: authorization.pending })).status, 403);
  connected = true;
  // A failed claim stays single-use; a new authorization is required after SDK setup is corrected.
  assert.equal((await f.post('/activity/api/join', { pending: authorization.pending })).status, 401);
  const newAuthorization = (await (await f.post('/activity/api/auth', input)).json()) as { pending: string };
  const joined = await f.post('/activity/api/join', { pending: newAuthorization.pending }),
    state = (await joined.json()) as { token: string; room: { participants: { id: string }[] } };
  assert.equal(joined.status, 200);
  assert.ok(state.token);
  assert.equal(state.room.participants[0]!.id, U);
  assert.equal(f.store.list('activity.rooms').length, 1);
  assert.equal((await f.post('/activity/api/join', { pending: newAuthorization.pending })).status, 401);
});

test('Activity pending joins expire and are invalidated when the user erases data before joining', async (t) => {
  const f = await fixture(t),
    input = { code: 'fixture-code', guildId: G, channelId: C, instanceId: 'i-fixture' };
  const old = (await (await f.post('/activity/api/auth', input)).json()) as { pending: string };
  f.advance(60001);
  assert.equal((await f.post('/activity/api/join', { pending: old.pending })).status, 401);
  const erased = (await (await f.post('/activity/api/auth', input)).json()) as { pending: string };
  await f.execute('activity.erase');
  assert.equal((await f.post('/activity/api/join', { pending: erased.pending })).status, 401);
  assert.equal(f.store.list('activity.rooms').length, 0);
  const fresh = (await (await f.post('/activity/api/auth', input)).json()) as { pending: string };
  assert.equal((await f.post('/activity/api/join', { pending: fresh.pending })).status, 200);
});

test('Simultaneous joins claim a pending Activity authorization only once before asynchronous instance verification', async (t) => {
  const f = await fixture(t),
    input = { code: 'fixture-code', guildId: G, channelId: C, instanceId: 'i-fixture' },
    authorization = (await (await f.post('/activity/api/auth', input)).json()) as { pending: string },
    entered = latch(),
    finish = latch();
  f.client.application!.fetchActivityInstance = (async (instanceId: string) => {
    entered.release();
    await finish.promise;
    return { applicationId: B, instanceId, users: [U], location: { guildId: G, channelId: C } };
  }) as NonNullable<Client['application']>['fetchActivityInstance'];
  const original = f.post('/activity/api/join', { pending: authorization.pending });
  await entered.promise;
  assert.equal((await f.post('/activity/api/join', { pending: authorization.pending })).status, 401);
  finish.release();
  assert.equal((await original).status, 200);
  assert.equal(f.store.list('activity.rooms').length, 1);
});

test('Activity cached state reads reject module disable/re-enable immediately and a fresh preview remains usable', async (t) => {
  const f = await fixture(t),
    preview = (await f.execute('activity.preview')) as { url: string },
    auth = (await (
      await f.post('/activity/api/auth', { preview: new URL(preview.url).searchParams.get('preview') })
    ).json()) as { token: string };
  f.store.set('core.disabled', G, ['activities']);
  assert.equal((await f.post('/activity/api/state', {}, auth.token)).status, 403);
  f.store.set('core.disabled', G, []);
  f.store.set('core.featureEpochs', `${G}:activities`, 2);
  f.advance(201);
  assert.equal((await f.post('/activity/api/state', {}, auth.token)).status, 403);
  const newPreview = (await f.execute('activity.preview')) as { url: string };
  assert.equal(
    (await f.post('/activity/api/auth', { preview: new URL(newPreview.url).searchParams.get('preview') }))
      .status,
    200,
  );
});

test('Activity read leases bound billing/appearance calls, invalidate on observed changes and still check every mutation freshly', async (t) => {
  let checks = 0,
    admissions = 0,
    appearances = 0,
    permitted = true;
  const theme = { id: 'gold', name: 'Gold', background: '#101010', foreground: '#ffffff', accent: '#d4af37' };
  const f = await fixture(t, {
    authorizeFeature: async (_ctx, action) => {
      assert.equal(action, 'activity.launch');
      checks++;
      if (!permitted) throw new Error('Entitlement expired');
    },
    onNativeJoin: async () => {
      admissions++;
    },
    appearance: async () => {
      appearances++;
      return { theme };
    },
  });
  const auth = (await (
    await f.post('/activity/api/auth', {
      code: 'fixture-code',
      guildId: G,
      channelId: C,
      instanceId: 'i-fixture',
    })
  ).json()) as { pending: string };
  assert.equal(admissions, 0);
  assert.equal(f.store.list('activity.rooms').length, 0);
  const joined = await f.post('/activity/api/join', { pending: auth.pending }),
    state = (await joined.json()) as { token: string; appearance: unknown };
  assert.equal(joined.status, 200);
  assert.equal(admissions, 1);
  assert.deepEqual(state.appearance, { theme });
  const count = checks,
    appearanceCount = appearances;
  assert.equal((await f.post('/activity/api/state', {}, state.token)).status, 200);
  assert.equal(checks, count);
  assert.equal(appearances, appearanceCount);
  assert.equal(admissions, 1);
  f.advance(201);
  permitted = false;
  const revision = f.store.list<{ revision: number }>('activity.rooms')[0]!.value.revision;
  assert.notEqual(
    (
      await f.post(
        '/activity/api/operation',
        { revision, operation: { kind: 'mode', mode: 'stats' } },
        state.token,
      )
    ).status,
    200,
  );
  assert.ok(checks > count);
  // A failed fresh mutation check invalidates its preceding read lease too.
  assert.notEqual((await f.post('/activity/api/state', {}, state.token)).status, 200);
  permitted = true;
  f.advance(5001);
  assert.equal((await f.post('/activity/api/state', {}, state.token)).status, 200);
  const refreshed = checks;
  permitted = false;
  f.advance(201);
  f.store.set('premium.entitlementEpoch', 'current', 1);
  assert.notEqual((await f.post('/activity/api/state', {}, state.token)).status, 200);
  assert.ok(checks > refreshed, 'Observed refund/expiry invalidates the five-second lease immediately.');
  assert.equal(admissions, 1);
});

test('An Activity source policy applied after preview creation blocks browser state and polling never blocks a reviewed mutation', async (t) => {
  const f = await fixture(t),
    preview = (await f.execute('activity.preview')) as { url: string },
    auth = (await (
      await f.post('/activity/api/auth', { preview: new URL(preview.url).searchParams.get('preview') })
    ).json()) as { token: string; room: { revision: number } };
  assert.equal((await f.post('/activity/api/state', {}, auth.token)).status, 200);
  assert.equal(
    (
      await f.post(
        '/activity/api/operation',
        { revision: auth.room.revision, operation: { kind: 'mode', mode: 'whiteboard' } },
        auth.token,
      )
    ).status,
    200,
  );
  f.store.set('core.actionPolicies', `${G}:activity.preview`, {
    enabled: false,
    roleIds: [],
    channelIds: [],
  });
  f.advance(201);
  assert.notEqual((await f.post('/activity/api/state', {}, auth.token)).status, 200);
});

test('Erasure while an Activity appearance callback waits cannot restore a room or deliver its old response', async (t) => {
  let waiting = false;
  const entered = latch(),
    finish = latch(),
    f = await fixture(t, {
      appearance: async () => {
        if (waiting) {
          entered.release();
          await finish.promise;
        }
        return {};
      },
    }),
    preview = (await f.execute('activity.preview')) as { url: string };
  waiting = true;
  const pending = f.post('/activity/api/auth', { preview: new URL(preview.url).searchParams.get('preview') });
  await entered.promise;
  await f.execute('activity.erase');
  finish.release();
  assert.notEqual((await pending).status, 200);
  assert.equal(f.store.list('activity.rooms').length, 0);
});

test('An erased Activity session cannot resume or restore shared state after membership refresh completes', async (t) => {
  const f = await fixture(t),
    preview = (await f.execute('activity.preview')) as { url: string };
  const response = await f.post('/activity/api/auth', {
    preview: new URL(preview.url).searchParams.get('preview'),
  });
  assert.equal(response.status, 200);
  const auth = (await response.json()) as { token: string; room: { revision: number } };
  f.setMembershipHook(async () => {
    f.setMembershipHook(undefined);
    await f.execute('activity.erase');
  });
  f.advance(6000);
  const outcome = await f.post(
    '/activity/api/operation',
    { revision: auth.room.revision, operation: { kind: 'editor', text: 'must not survive erase' } },
    auth.token,
  );
  assert.notEqual(outcome.status, 200);
  assert.equal(f.store.list('activity.rooms').length, 0);
});

test('Activity authentication started before erasure cannot recreate erased user state after its provider returns', async (t) => {
  const f = await fixture(t),
    entered = latch(),
    finish = latch();
  f.setAuthenticationHook(async () => {
    entered.release();
    await finish.promise;
  });
  const pending = f.post('/activity/api/auth', {
    code: 'fixture-code',
    guildId: G,
    channelId: C,
    instanceId: 'i-fixture',
  });
  await entered.promise;
  await f.execute('activity.erase');
  finish.release();
  assert.notEqual((await pending).status, 200);
  assert.equal(f.store.list('activity.rooms').length, 0);
});

test('Remote host output is withheld when source-channel access is revoked during the RPC', async (t) => {
  const f = await fixture(t),
    entered = latch(),
    finish = latch();
  registerRemoteHostActions(f.registry, {
    url: 'https://agent.example.test',
    key: 'fixture-agent-authorization-key-1234567890',
    operatorIds: [U],
    fetch: (async () => {
      entered.release();
      await finish.promise;
      return new Response(JSON.stringify({ output: 'private host operation output' }), { status: 200 });
    }) as typeof fetch,
  });
  const pending = f.execute('host.result', { id: 'a'.repeat(32) });
  await entered.promise;
  f.ctx.member.permissions.remove(P.Administrator);
  finish.release();
  await assert.rejects(() => pending);
});

test('Remote host results from a previous module epoch are withheld after disable/re-enable', async (t) => {
  const f = await fixture(t),
    entered = latch(),
    finish = latch();
  registerRemoteHostActions(f.registry, {
    url: 'https://agent.example.test',
    key: 'fixture-agent-authorization-key-1234567890',
    operatorIds: [U],
    fetch: (async () => {
      entered.release();
      await finish.promise;
      return new Response(JSON.stringify({ output: 'previous-epoch host output' }), { status: 200 });
    }) as typeof fetch,
  });
  const pending = f.execute('host.result', { id: 'a'.repeat(32) });
  await entered.promise;
  f.store.set('core.featureEpochs', `${G}:operations`, 2);
  finish.release();
  await assert.rejects(() => pending, /Host access changed/);
});
