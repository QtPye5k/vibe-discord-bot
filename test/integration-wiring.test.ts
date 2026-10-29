import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute, sep } from 'node:path';
import { createServer } from 'node:http';
import {
  Collection,
  Events,
  PermissionsBitField,
  PermissionFlagsBits as P,
  SKUType,
  SKUFlags,
  EntitlementType,
  type Message,
  type Entitlement,
  type Subscription,
  type ClientEvents,
} from 'discord.js';
import { createServices, bindEvents, startBot, helpPayload } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/core/store.js';
import type { ActionContext } from '../src/core/types.js';

const APP = '790000000000000001',
  G = '790000000000000002',
  U = '790000000000000003',
  B = '790000000000000004',
  C = '790000000000000005',
  D = '790000000000000006',
  OTHER = '790000000000000007',
  SKU = '790000000000000008',
  ENT = '790000000000000009';
async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function temporary(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'discord-wiring-'));
  t.after(async () => {
    const rel = relative(tmpdir(), root);
    assert.ok(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
function fixture(t: TestContext, environment: NodeJS.ProcessEnv = {}) {
  const services = createServices(
    loadConfig({ DATABASE_PATH: ':memory:', ENABLE_VOICE: 'false', DISCORD_GUILD_IDS: G, ...environment }),
    { store: new Store(':memory:') },
  );
  services.logger.error = () => {};
  services.logger.info = () => {};
  const member = {
      id: U,
      user: { id: U, username: 'fixture', bot: false },
      permissions: new PermissionsBitField(P.Administrator),
      roles: { cache: new Collection() },
      voice: { channelId: C },
    },
    bot = { ...member, id: B, user: { id: B, username: 'bot', bot: true } };
  const forwarded: string[] = [];
  const messages = new Map<string, Message<true>>(),
    hooks: { forward?: (id: string) => Promise<void> | void } = {};
  const makeChannel = (id: string) => ({
    id,
    guildId: G,
    type: 0,
    name: 'fixture',
    isThread: () => false,
    isTextBased: () => true,
    isSendable: () => true,
    permissionsFor: () => new PermissionsBitField(P.Administrator),
    messages: {
      fetch: async (input: { message?: string }) => {
        if (input.message) {
          const value = messages.get(input.message);
          if (!value) throw new Error('Unknown fixture message');
          return value;
        }
        return new Collection();
      },
    },
    send: async () => ({ id: '890000000000000999' }),
  });
  const channels = new Map([
      [C, makeChannel(C)],
      [D, makeChannel(D)],
    ]),
    guild = {
      id: G,
      name: 'Fixture',
      ownerId: U,
      channels: { fetch: async (id: string) => channels.get(id) ?? null },
      members: { me: bot, fetch: async () => member, fetchMe: async () => bot },
    };
  Object.assign(member, { guild });
  Object.assign(bot, { guild });
  services.client.guilds.fetch = (async () => guild) as unknown as typeof services.client.guilds.fetch;
  Object.defineProperty(services.client, 'user', { value: { id: B }, configurable: true });
  const application = { id: APP, fetch: async () => application };
  Object.defineProperty(services.client, 'application', { value: application, configurable: true });
  const ctx = {
    client: services.client,
    store: services.store,
    guild,
    member,
    channelId: C,
  } as unknown as ActionContext;
  let unbind: (() => Promise<void>) | undefined, stop: (() => Promise<void>) | undefined;
  const direct = async (action: string, input: unknown = {}) => {
    const definition = services.registry.get(action);
    return definition.execute(ctx, definition.schema.parse(input));
  };
  const message = (id: string, reference?: string) => {
    const value = {
      id,
      guildId: G,
      guild,
      client: services.client,
      member,
      channelId: C,
      author: member.user,
      content: 'Ordinary consented message',
      system: false,
      webhookId: null,
      reference: reference ? { messageId: reference } : null,
      createdAt: new Date(),
      createdTimestamp: Date.now(),
      attachments: new Collection(),
      mentions: { users: new Collection(), roles: new Collection(), everyone: false },
      forward: async (target: { id: string }) => {
        assert.equal(target.id, D);
        await hooks.forward?.(id);
        forwarded.push(id);
        return { id: String(890000000000000000n + BigInt(forwarded.length)) };
      },
    } as unknown as Message<true>;
    messages.set(id, value);
    return value;
  };
  t.after(async () => {
    await unbind?.();
    await stop?.();
    await services.close();
  });
  return {
    services,
    ctx,
    guild,
    member,
    application,
    channels,
    forwarded,
    hooks,
    message,
    direct,
    bind() {
      unbind ??= bindEvents(services);
      return unbind;
    },
    async start(ready = false) {
      services.client.rest.put = (async () => []) as typeof services.client.rest.put;
      services.client.login = async () => {
        if (ready) services.client.emit(Events.ClientReady, services.client as never);
        return 'fixture-login';
      };
      stop = await startBot(services);
      return stop;
    },
  };
}
async function bounded<T>(promise: Promise<T>, milliseconds = 2000) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Expected runtime integration did not complete.')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function relay(f: ReturnType<typeof fixture>) {
  await f.direct('relay.configure', { id: 'copy', sourceChannelId: C, targetChannelId: D });
  await f.direct('relay.consent', { id: 'copy', enabled: true });
}

test('real service composition registers completed native features while blank optional services remain hidden, unavailable and safely closable', async (t) => {
  const f = fixture(t),
    all = new Set(f.services.registry.list().map((action) => action.id)),
    available = new Set(f.services.registry.listAvailable().map((action) => action.id));
  for (const id of [
    'guild.system-flags',
    'guild.community',
    'guild.onboarding-edit',
    'member.permissions-compare',
    'message.search',
    'moderation.tempban',
    'currency.create',
    'raffle.create',
    'approval.chain.create',
    'eventroles.configure',
    'tournament.schedule',
    'tracking.watch',
    'ui.pages.publish',
    'analytics.api-latency',
    'database.query',
    'deployment.activate',
    'deployment.notifications.configure',
    'automation.external.configure',
  ])
    assert.ok(all.has(id), `Missing registered action ${id}`);
  for (const id of [
    'database.query',
    'deployment.activate',
    'deployment.notifications.configure',
    'automation.external.configure',
    'relay.configure',
    'conversation.channel.configure',
    'premium.purchase',
    'activity.launch',
  ])
    assert.ok(!available.has(id), `Blank service unexpectedly available: ${id}`);
  assert.equal(f.services.ai.available, false);
  assert.doesNotMatch(helpPayload(f.services, 'database').content ?? '', /`database.query`/);
  await f.services.close();
  await f.services.close();
  assert.throws(() => f.services.store.get('test', 'closed'), /closed|finalized/);
});
test('configured optional services expose exact actions without opening providers; deployment additionally needs a controlled restart handler', async (t) => {
  const root = await temporary(t),
    f = fixture(t, {
      OUTBOUND_AUTOMATION_URL: 'https://events.example.com/hooks',
      OUTBOUND_AUTOMATION_KEY: 'fixture-key-32-characters-or-more!!',
      EXTERNAL_DATABASE_URL: 'postgres://fixture.invalid/database',
      EXTERNAL_DATABASE_QUERIES_FILE: join(root, 'queries.json'),
      DEPLOYMENT_RELEASES_DIRECTORY: join(root, 'releases'),
      DEPLOYMENT_ACTIVE_FILE: join(root, 'active.json'),
    });
  assert.equal(f.services.registry.get('database.query').available?.(), true);
  assert.equal(f.services.registry.get('automation.external.configure').available?.(), true);
  assert.equal(f.services.registry.get('deployment.activate').available?.(), false);
  f.services.setRestartHandler(() => {});
  assert.equal(f.services.registry.get('deployment.activate').available?.(), true);
  f.services.setRestartHandler(undefined);
  assert.equal(f.services.registry.get('deployment.activate').available?.(), false);
});
test('ordinary admitted MessageCreate events reach relay forwarding and reply tracking; excluded guild events have no effect', async (t) => {
  const f = fixture(t, { ENABLE_MESSAGE_CONTENT: 'true' });
  await relay(f);
  const original = f.message('890000000000000001');
  const watch = (await f.direct('tracking.watch', { channelId: C, messageId: original.id })) as {
    id: string;
  };
  f.bind();
  const message = f.message('890000000000000002', original.id);
  f.services.client.emit(Events.MessageCreate, message);
  const excluded = {
    ...f.message('890000000000000003'),
    guildId: OTHER,
    guild: { ...f.guild, id: OTHER },
  } as unknown as Message<true>;
  f.services.client.emit(Events.MessageCreate, excluded);
  await f.bind()();
  assert.deepEqual(f.forwarded, [message.id]);
  const result = (await f.direct('tracking.view', { id: watch.id })) as { replyCount: number };
  assert.equal(result.replyCount, 1);
});
test('actual startup maintenance drains busy deferred relays after their original sends complete', async (t) => {
  const f = fixture(t, { ENABLE_MESSAGE_CONTENT: 'true' });
  await relay(f);
  let release!: () => void, drained!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    finished = new Promise<void>((resolve) => {
      drained = resolve;
    });
  let entered = 0;
  f.hooks.forward = async (id) => {
    entered++;
    if (id === '890000000000000015') {
      drained();
      return;
    }
    await gate;
  };
  f.bind();
  for (let index = 1; index <= 5; index++)
    f.services.client.emit(Events.MessageCreate, f.message(String(890000000000000010n + BigInt(index))));
  for (let turns = 0; turns < 20 && entered < 4; turns++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entered, 4);
  release();
  await f.bind()();
  assert.equal(
    f.services.store
      .list<{ state: string }>('message.relayDeliveries')
      .filter((row) => row.value.state === 'deferred').length,
    1,
  );
  const stop = await f.start(true);
  await bounded(finished);
  await stop();
  assert.equal(f.forwarded.length, 5);
});
test('actual ban, unban and role-delete Gateway events enqueue outbound metadata only for admitted servers', async (t) => {
  const f = fixture(t, {
    OUTBOUND_AUTOMATION_URL: 'https://events.example.com/hooks',
    OUTBOUND_AUTOMATION_KEY: 'fixture-key-32-characters-or-more!!',
  });
  await f.direct('automation.external.configure', {
    events: ['guildBanAdd', 'guildBanRemove', 'roleDelete'],
  });
  f.bind();
  const ban = {
    guild: f.guild,
    user: { id: U, bot: false },
  } as unknown as ClientEvents[Events.GuildBanAdd][0];
  f.services.client.emit(Events.GuildBanAdd, ban);
  f.services.client.emit(Events.GuildBanRemove, ban);
  const role = {
    id: '790000000000000011',
    guild: f.guild,
  } as unknown as ClientEvents[Events.GuildRoleDelete][0];
  f.services.client.emit(Events.GuildRoleDelete, role);
  f.services.client.emit(Events.GuildRoleDelete, {
    ...role,
    guild: { ...f.guild, id: OTHER },
  } as unknown as ClientEvents[Events.GuildRoleDelete][0]);
  await f.bind()();
  const jobs = f.services.store.list<{ body: string }>('automation.externalOutbox');
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.map((row) => JSON.parse(row.value.body).event).sort(), [
    'guildBanAdd',
    'guildBanRemove',
    'roleDelete',
  ]);
});
test('global Gateway entitlement/subscription events update premium lifecycle outside guild admission and deduplicate repeated events', async (t) => {
  const root = await temporary(t),
    policy = join(root, 'premium.json');
  await writeFile(
    policy,
    JSON.stringify({
      version: 1,
      products: [
        { id: 'plus', skuId: SKU, name: 'Plus', kind: 'subscription', actions: ['activity.launch'] },
      ],
    }),
  );
  const f = fixture(t, { PREMIUM_POLICY_FILE: policy });
  f.bind();
  const entitlement = {
    id: ENT,
    applicationId: APP,
    skuId: SKU,
    userId: U,
    guildId: null,
    deleted: false,
    consumed: false,
    startsTimestamp: null,
    endsTimestamp: null,
  } as unknown as Entitlement;
  f.services.client.emit(Events.EntitlementCreate, entitlement);
  f.services.client.emit(Events.EntitlementCreate, entitlement);
  f.services.client.emit(Events.EntitlementUpdate, entitlement, {
    ...entitlement,
    consumed: true,
  } as Entitlement);
  const subscription = {
    id: '790000000000000010',
    skuIds: [SKU],
    userId: U,
    status: 0,
    currentPeriodStartTimestamp: 100,
    currentPeriodEndTimestamp: 200,
    canceledTimestamp: null,
  } as unknown as Subscription;
  f.services.client.emit(Events.SubscriptionCreate, subscription);
  f.services.client.emit(Events.SubscriptionUpdate, subscription, {
    ...subscription,
    status: 1,
  } as Subscription);
  assert.equal(f.services.store.list('premium.events').length, 4);
  assert.equal(f.services.store.get<number>('premium.entitlementEpoch', 'current'), 4);
  f.services.client.emit(Events.EntitlementDelete, { ...entitlement, applicationId: OTHER } as Entitlement);
  assert.equal(f.services.store.list('premium.events').length, 4);
  await f.bind()();
  f.services.client.emit(Events.SubscriptionDelete, subscription);
  assert.equal(f.services.store.list('premium.events').length, 4);
});
test('Activity launch access is premium checked without charging admission before a native instance join', async (t) => {
  const root = await temporary(t),
    policy = join(root, 'premium.json');
  await writeFile(
    policy,
    JSON.stringify({
      version: 1,
      products: [
        {
          id: 'plus',
          skuId: SKU,
          name: 'Plus',
          kind: 'subscription',
          actions: ['activity.launch'],
          commandLimits: { 'activity.launch': 1 },
        },
      ],
    }),
  );
  const f = fixture(t, {
    PREMIUM_POLICY_FILE: policy,
    ACTIVITY_PUBLIC_URL: 'https://activity.example.com',
    DISCORD_CLIENT_ID: APP,
    DISCORD_CLIENT_SECRET: 'fixture-only-not-a-real-secret',
  });
  let current = true;
  const sku = {
      id: SKU,
      applicationId: APP,
      name: 'Plus',
      type: SKUType.Subscription,
      flags: { bitfield: SKUFlags.UserSubscription | SKUFlags.Available },
    },
    entitlement = {
      id: ENT,
      applicationId: APP,
      skuId: SKU,
      userId: U,
      guildId: null,
      type: EntitlementType.ApplicationSubscription,
      deleted: false,
      consumed: false,
      startsTimestamp: null,
      endsTimestamp: null,
    };
  Object.assign(f.application, {
    fetchSKUs: async () => new Collection([[SKU, sku]]),
    entitlements: { fetch: async () => new Collection(current ? [[ENT, entitlement]] : []) },
  });
  for (let index = 0; index < 3; index++) {
    const result = await f.services.registry.request(f.ctx, 'activity.launch', {});
    assert.equal(result.status, 'completed');
  }
  assert.equal(f.services.store.list('premium.usage').length, 0);
  current = false;
  await assert.rejects(
    () => f.services.registry.request(f.ctx, 'activity.launch', {}),
    /purchase|premium|entitlement/i,
  );
  assert.equal(f.services.store.list('premium.usage').length, 0);
});
test('real HTTP listener admits signed deployment notifications and all six global premium event types before guild filtering', async (t) => {
  const root = await temporary(t),
    policy = join(root, 'premium.json');
  await writeFile(
    policy,
    JSON.stringify({
      version: 1,
      products: [{ id: 'plus', skuId: SKU, name: 'Plus', kind: 'subscription' }],
    }),
  );
  const keys = generateKeyPairSync('ed25519'),
    publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'),
    listener = await port();
  const f = fixture(t, {
    HEALTH_PORT: String(listener),
    ENABLE_WEBHOOK_EVENTS: 'true',
    DISCORD_PUBLIC_KEY: publicKey,
    DEPLOYMENT_WEBHOOK_SECRET: 'fixture-webhook-secret',
    PREMIUM_POLICY_FILE: policy,
  });
  await f.direct('deployment.notifications.configure', {
    id: 'web',
    channelId: C,
    project: 'website',
    environment: 'test',
  });
  await f.start();
  const origin = `http://127.0.0.1:${listener}`,
    timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
      eventId: 'build-1',
      project: 'website',
      environment: 'test',
      status: 'succeeded',
    }),
    signature = createHmac('sha256', 'fixture-webhook-secret')
      .update(timestamp + '.')
      .update(body)
      .digest('hex');
  let response = await fetch(origin + '/hooks/deployments', {
    method: 'POST',
    headers: { 'x-deployment-timestamp': timestamp, 'x-deployment-signature': `v1=${signature}` },
    body,
  });
  assert.equal(response.status, 204);
  assert.equal(f.services.store.list('deploy.deliveries').length, 1);
  response = await fetch(origin + '/unknown');
  assert.equal(response.status, 404);
  for (const kind of [
    'ENTITLEMENT_CREATE',
    'ENTITLEMENT_UPDATE',
    'ENTITLEMENT_DELETE',
    'SUBSCRIPTION_CREATE',
    'SUBSCRIPTION_UPDATE',
    'SUBSCRIPTION_DELETE',
  ]) {
    const payload = JSON.stringify({
        version: 1,
        application_id: APP,
        type: 1,
        event: {
          type: kind,
          timestamp: new Date().toISOString(),
          data: {
            id: ENT,
            sku_id: SKU,
            sku_ids: [SKU],
            user_id: U,
            status: 1,
            consumed: false,
            starts_at: '2026-01-01T00:00:00.000Z',
            current_period_start: '2026-01-01T00:00:00.000Z',
            current_period_end: '2026-02-01T00:00:00.000Z',
          },
        },
      }),
      raw = Buffer.from(payload),
      signed = sign(null, Buffer.concat([Buffer.from(timestamp), raw]), keys.privateKey).toString('hex');
    response = await fetch(origin + '/discord/events', {
      method: 'POST',
      headers: { 'x-signature-timestamp': timestamp, 'x-signature-ed25519': signed },
      body: payload,
    });
    assert.equal(response.status, 204, kind);
  }
  await f.services.webhookInbox.tick();
  const recorded = f.services.store.list<{
    kind: string;
    lifecycle: { startsTimestamp: number; currentPeriodStartTimestamp: number };
  }>('premium.events');
  assert.equal(recorded.length, 6);
  assert.equal(new Set(recorded.map((row) => row.value.kind)).size, 6);
  assert.equal(
    recorded.find((row) => row.value.kind === 'entitlementCreate')!.value.lifecycle.startsTimestamp,
    Date.parse('2026-01-01T00:00:00.000Z'),
  );
  assert.equal(
    recorded.find((row) => row.value.kind === 'subscriptionCreate')!.value.lifecycle
      .currentPeriodStartTimestamp,
    Date.parse('2026-01-01T00:00:00.000Z'),
  );
  assert.equal(
    f.services.store.list<{ status: string }>('webhook.inbox').filter((row) => row.value.status === 'done')
      .length,
    6,
  );
});
