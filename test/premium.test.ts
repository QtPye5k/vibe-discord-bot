import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import {
  Collection,
  PermissionFlagsBits as P,
  PermissionsBitField,
  SKUType,
  SKUFlags,
  EntitlementType,
  type Client,
  type Entitlement,
  type SKU,
  type Subscription,
} from 'discord.js';
import { z } from 'zod';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import { createPremiumService } from '../src/features/premium.js';

const APP = '620000000000000001',
  G = '620000000000000002',
  U = '620000000000000003',
  B = '620000000000000004',
  C = '620000000000000005',
  SKU_ID = '620000000000000006',
  ENT = '620000000000000007';
const basePolicy = () => ({
  version: 1,
  products: [
    {
      id: 'plus',
      skuId: SKU_ID,
      name: 'Plus',
      kind: 'subscription',
      scope: 'user',
      actions: ['test.paid'],
      commandLimits: { 'test.paid': 2 } as Record<string, number>,
      aiUserDailyLimit: 100,
      themes: ['gold'],
      interfaces: ['compact'],
    },
  ],
  themes: [{ id: 'gold', name: 'Gold', background: '#101010', foreground: '#ffffff', accent: '#d4af37' }],
  interfaces: [{ id: 'compact', name: 'Compact', compact: true, showAnalytics: false }],
});
function fixture(t: TestContext, policyValue: unknown = basePolicy()) {
  const temporaryRoot = realpathSync(tmpdir()),
    directory = mkdtempSync(join(temporaryRoot, 'discord-premium-test-')),
    file = join(directory, 'policy.json');
  if (policyValue !== null)
    writeFileSync(file, typeof policyValue === 'string' ? policyValue : JSON.stringify(policyValue));
  const store = new Store(':memory:');
  let time = Date.now(),
    effects = 0,
    consumeCalls = 0;
  const actor = {
      id: U,
      permissions: new PermissionsBitField([P.ViewChannel, P.ReadMessageHistory]),
      roles: { cache: new Collection() },
    },
    bot = { ...actor, id: B, permissions: new PermissionsBitField(P.Administrator) };
  const channel = {
    id: C,
    guildId: G,
    type: 0,
    permissionsFor: (member: { permissions: PermissionsBitField }) => member.permissions,
  };
  const guild = {
    id: G,
    name: 'Fixture',
    ownerId: 'owner',
    members: { me: bot, fetch: async () => actor, fetchMe: async () => bot },
    channels: { fetch: async () => channel },
    roles: { everyone: { id: G } },
  };
  const sku = {
    id: SKU_ID,
    applicationId: APP,
    name: 'Plus',
    type: SKUType.Subscription,
    flags: { bitfield: SKUFlags.UserSubscription | SKUFlags.Available },
  } as SKU;
  const entitlement = {
    id: ENT,
    applicationId: APP,
    skuId: SKU_ID,
    userId: U,
    guildId: null,
    type: EntitlementType.ApplicationSubscription,
    deleted: false,
    consumed: false,
    startsTimestamp: null,
    endsTimestamp: null,
  } as Entitlement;
  const all: Entitlement[] = [entitlement];
  let pageHook:
      | ((
          options: Record<string, unknown>,
        ) => Promise<Collection<string, Entitlement>> | Collection<string, Entitlement>)
      | undefined,
    consumeHook: ((id: string) => Promise<void>) | undefined,
    subscriptionHook:
      | ((
          options: Record<string, unknown>,
        ) => Promise<Collection<string, Subscription>> | Collection<string, Subscription>)
      | undefined;
  const fetches: Record<string, unknown>[] = [],
    application = {
      id: APP,
      fetch: async () => application,
      fetchSKUs: async () => new Collection([[SKU_ID, sku]]),
      entitlements: {
        fetch: async (options: Record<string, unknown>) => {
          fetches.push(options);
          if (pageHook) return pageHook(options);
          return new Collection(
            all
              .filter(
                (row) =>
                  (options.guild
                    ? row.guildId === options.guild
                    : row.userId === options.user && row.guildId === null) &&
                  (options.skus as string[]).includes(row.skuId),
              )
              .map((row) => [row.id, row]),
          );
        },
        consume: async (id: string) => {
          consumeCalls++;
          if (consumeHook) return consumeHook(id);
          entitlement.consumed = true;
        },
      },
      subscriptions: {
        fetch: async (options: Record<string, unknown>) =>
          subscriptionHook ? subscriptionHook(options) : new Collection<string, Subscription>(),
      },
    };
  const client = { user: { id: B }, application, guilds: { fetch: async () => guild } } as unknown as Client;
  const ctx = { client, store, guild, member: actor, channelId: C } as unknown as ActionContext;
  const service = createPremiumService({
      policyFile: policyValue === null ? '' : file,
      operatorIds: [U],
      now: () => time,
    }),
    registry = new ActionRegistry();
  for (const risk of ['read', 'write'] as const)
    registry.register({
      id: risk === 'read' ? 'test.paid' : 'test.write',
      category: 'test',
      description: 'Test a real protected action through the registry',
      risk,
      schema: z.strictObject({}),
      userPermissions: [],
      botPermissions: [],
      execute: () => ({ effects: ++effects }),
    });
  service.registerActions(registry);
  registry.setAccessGate({
    authorize: (ctx, action) => service.authorize(ctx, action.id),
    begin: (ctx, action, grant) => service.begin(ctx, action.id, grant),
  });
  t.after(() => {
    service.close();
    store.close();
    assert.equal(dirname(resolve(directory)), temporaryRoot);
    assert.match(basename(directory), /^discord-premium-test-/);
    rmSync(directory, { recursive: true, force: true });
  });
  const run = (id: string, input: unknown = {}, context = ctx) => registry.request(context, id, input);
  const confirm = async (id: string, input: unknown = {}, context = ctx) => {
    const pending = await run(id, input, context);
    assert.equal(pending.status, 'confirmation');
    if (pending.status !== 'confirmation') throw new Error('Missing preview');
    return registry.confirm(context, pending.id);
  };
  return {
    store,
    ctx,
    actor,
    bot,
    channel,
    guild,
    client,
    application,
    sku,
    entitlement,
    all,
    service,
    registry,
    run,
    confirm,
    file,
    fetches,
    get effects() {
      return effects;
    },
    get consumeCalls() {
      return consumeCalls;
    },
    get time() {
      return time;
    },
    setTime(value: number) {
      time = value;
    },
    setPageHook(value: typeof pageHook) {
      pageHook = value;
    },
    setConsumeHook(value: typeof consumeHook) {
      consumeHook = value;
    },
    setSubscriptionHook(value: typeof subscriptionHook) {
      subscriptionHook = value;
    },
  };
}

test('Blank premium configuration leaves ordinary actions free and hides optional premium operations', async (t) => {
  const f = fixture(t, null);
  assert.equal(f.service.status().configured, false);
  assert.equal(
    f.registry.listAvailable().some((action) => action.id === 'premium.claim'),
    false,
  );
  await f.run('test.paid');
  assert.equal(f.effects, 1);
  assert.equal(f.fetches.length, 0);
  assert.equal(await f.service.aiAllowance(f.ctx), undefined);
});
test('Invalid policy is reported without a startup crash and protected access fails closed', async (t) => {
  const f = fixture(t, '{malformed');
  assert.equal(f.service.status().configured, false);
  assert.ok(f.service.status().error);
  await assert.rejects(() => f.run('test.paid'), /policy unavailable|configuration is invalid/);
  const action = f.registry.get('premium.configuration');
  assert.equal(action.category, 'system');
  const result = await action.execute(f.ctx, {});
  assert.equal((result as { configured: boolean }).configured, false);
});
test('Premium schemas serialize and invalid/duplicate products, unsafe colors and paywalled recovery controls are rejected', (t) => {
  const f = fixture(t);
  for (const action of f.registry.list())
    assert.doesNotThrow(() => JSON.stringify(z.toJSONSchema(action.schema, { io: 'input' })), action.id);
  for (const change of ['recovery', 'privacy', 'duplicate', 'color', 'mixed-scope'] as const) {
    const bad = basePolicy();
    if (change === 'recovery') bad.products[0]!.actions = ['system.status'];
    if (change === 'privacy') bad.products[0]!.actions = ['voice.recordings.erase'];
    if (change === 'duplicate') bad.products.push({ ...bad.products[0]! });
    if (change === 'color') bad.themes[0]!.accent = 'red;background:url(evil)';
    if (change === 'mixed-scope')
      bad.products.push({ ...bad.products[0]!, id: 'guild', skuId: '620000000000000098', scope: 'guild' });
    writeFileSync(f.file, JSON.stringify(bad));
    const denied = createPremiumService({ policyFile: f.file });
    assert.equal(denied.status().configured, false, change);
    denied.close();
  }
});
test('User subscriptions gate commands from fresh own-app entitlement proof and apply atomic daily limits', async (t) => {
  const f = fixture(t);
  await f.run('test.paid');
  await f.run('test.paid');
  await assert.rejects(() => f.run('test.paid'), /allowance/);
  assert.equal(f.effects, 2);
  assert.ok(f.fetches.length >= 3);
  const usage = f.store.list<{ status: string }>('premium.usage');
  assert.equal(usage.length, 2);
  assert.ok(usage.every((row) => row.value.status === 'success'));
  f.setTime(f.time + 86400000);
  await f.run('test.paid');
  assert.equal(f.effects, 3);
});
test('Request previews consume no quota and confirmation rechecks premium expiry before side effects', async (t) => {
  const p = basePolicy();
  p.products[0]!.actions = ['test.write'];
  p.products[0]!.commandLimits = { 'test.write': 1 };
  const f = fixture(t, p);
  const pending = await f.run('test.write');
  assert.equal(pending.status, 'confirmation');
  assert.equal(f.store.list('premium.usage').length, 0);
  f.entitlement.endsTimestamp = f.time - 1;
  if (pending.status === 'confirmation')
    await assert.rejects(() => f.registry.confirm(f.ctx, pending.id), /requires an active/);
  assert.equal(f.effects, 0);
  assert.equal(f.store.list('premium.usage').length, 0);
});
test('Guild subscriptions authorize members of the entitled guild without granting another guild access', async (t) => {
  const p = basePolicy();
  p.products[0]!.scope = 'guild';
  const f = fixture(t, p);
  f.sku.flags = { bitfield: SKUFlags.GuildSubscription | SKUFlags.Available } as SKU['flags'];
  f.entitlement.guildId = G;
  f.entitlement.userId = '620000000000000099';
  await f.run('test.paid');
  assert.equal(f.effects, 1);
  assert.ok(f.fetches.some((options) => options.guild === G));
  f.entitlement.guildId = '620000000000000098';
  await assert.rejects(() => f.run('test.paid'), /requires an active/);
});
test('Foreign application/owner/SKU, unknown flags, malformed periods, consumed subscriptions and test grants never grant paid access', async (t) => {
  for (const change of ['application', 'owner', 'sku', 'flags', 'period', 'consumed', 'test'] as const)
    await t.test(change, async (sub) => {
      const f = fixture(sub);
      if (change === 'application') f.entitlement.applicationId = 'foreign';
      if (change === 'owner') f.entitlement.userId = 'foreign';
      if (change === 'sku') f.sku.applicationId = 'foreign';
      if (change === 'flags') f.sku.flags = { bitfield: 1n << 45n } as unknown as SKU['flags'];
      if (change === 'period') f.entitlement.startsTimestamp = f.time + 1000;
      if (change === 'consumed') f.entitlement.consumed = true;
      if (change === 'test') f.entitlement.type = EntitlementType.TestModePurchase;
      await assert.rejects(() => f.run('test.paid'));
      assert.equal(f.effects, 0);
    });
});
test('Entitlement pagination must be complete and rejects duplicated/nonadvancing cursors', async (t) => {
  const f = fixture(t);
  f.setPageHook(
    () =>
      new Collection(
        Array.from({ length: 100 }, (_, index) => {
          const item = { ...f.entitlement, id: String(BigInt(ENT) + BigInt(index)) } as Entitlement;
          return [item.id, item];
        }),
      ),
  );
  await assert.rejects(() => f.run('test.paid'), /pagination/);
  assert.equal(f.effects, 0);
});

test('A valid purchase is still honored when an unrelated test entitlement exists for that offering', async (t) => {
  const f = fixture(t);
  f.all.push({
    ...f.entitlement,
    id: '620000000000000099',
    type: EntitlementType.TestModePurchase,
  } as Entitlement);
  await f.run('test.paid');
  assert.equal(f.effects, 1);
});

test('User plan command limits remain one per-user allowance across servers', async (t) => {
  const f = fixture(t);
  await f.run('test.paid');
  f.guild.id = '620000000000000098';
  f.channel.guildId = f.guild.id;
  await f.run('test.paid');
  await assert.rejects(() => f.run('test.paid'), /allowance/);
  assert.equal(f.effects, 2);
});

test('Actual subscription history is fully paginated, owner-checked and does not itself grant premium access', async (t) => {
  const f = fixture(t),
    calls: Record<string, unknown>[] = [];
  const row = (offset: number) =>
    ({
      id: String(BigInt(ENT) + BigInt(offset)),
      userId: U,
      skuIds: [SKU_ID],
      status: 2,
      currentPeriodStartTimestamp: f.time - 86400000,
      currentPeriodEndTimestamp: f.time + 86400000,
      canceledTimestamp: f.time - 1000,
    }) as Subscription;
  f.setSubscriptionHook((options) => {
    calls.push(options);
    const values = options.after === '0' ? Array.from({ length: 100 }, (_, index) => row(index)) : [row(100)];
    return new Collection(values.map((value) => [value.id, value]));
  });
  const history = await f.run('premium.subscriptions', { productId: 'plus' });
  assert.equal(history.status, 'completed');
  if (history.status === 'completed') assert.equal((history.result as unknown[]).length, 101);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.after, row(99).id);
  f.entitlement.deleted = true;
  await assert.rejects(() => f.run('test.paid'), /requires an active/);
  f.setSubscriptionHook(
    () => new Collection([[ENT, { ...row(0), userId: '620000000000000099' } as Subscription]]),
  );
  await assert.rejects(() => f.run('premium.subscriptions', { productId: 'plus' }), /identity/);
});
test('Entitlements expiring after authorization but before execution cannot consume a paid allowance', async (t) => {
  const f = fixture(t);
  f.entitlement.endsTimestamp = f.time + 1000;
  const grant = await f.service.authorize(f.ctx, 'test.paid');
  f.setTime(f.time + 1001);
  assert.throws(() => f.service.begin(f.ctx, 'test.paid', grant), /allowance/);
  assert.equal(f.store.list('premium.usage').length, 0);
});
test('Module changes and stale/cross-user grants are rejected before quota reservation', async (t) => {
  const f = fixture(t),
    grant = await f.service.authorize(f.ctx, 'test.paid');
  f.store.set('core.featureEpochs', `${G}:premium`, 2);
  assert.throws(() => f.service.begin(f.ctx, 'test.paid', grant), /expired/);
  f.store.set('core.featureEpochs', `${G}:premium`, 0);
  f.setTime(f.time + 16000);
  assert.throws(() => f.service.begin(f.ctx, 'test.paid', grant), /expired/);
});
test('Premium disablement preserves unrelated free commands and removes passive AI/theme benefits', async (t) => {
  const f = fixture(t);
  f.store.set('core.disabled', G, ['premium']);
  await f.run('test.write');
  assert.equal(f.effects, 0);
  assert.equal(await f.service.aiAllowance(f.ctx), undefined);
  assert.deepEqual(await f.service.appearance(f.ctx), {});
  await assert.rejects(() => f.run('test.paid'), /disabled/);
});
test('Durable purchases unlock actual validated themes/interfaces and expired/refunded access restores defaults', async (t) => {
  const p = basePolicy();
  p.products[0]!.kind = 'durable';
  const f = fixture(t, p);
  f.sku.type = SKUType.Durable;
  f.sku.flags = { bitfield: SKUFlags.Available } as SKU['flags'];
  f.entitlement.type = EntitlementType.Purchase;
  await f.confirm('premium.theme.set', { id: 'gold' });
  await f.confirm('premium.interface.set', { id: 'compact' });
  assert.equal((await f.service.appearance(f.ctx)).theme?.accent, '#d4af37');
  assert.equal((await f.service.appearance(f.ctx)).interface?.compact, true);
  f.entitlement.deleted = true;
  assert.deepEqual(await f.service.appearance(f.ctx), { theme: undefined, interface: undefined });
});
test('Active premium plans can raise AI allowances while unentitled members receive no bonus', async (t) => {
  const f = fixture(t);
  assert.equal((await f.service.aiAllowance(f.ctx))?.maxAiRequestsPerUserDay, 100);
  f.entitlement.deleted = true;
  assert.equal((await f.service.aiAllowance(f.ctx))?.maxAiRequestsPerUserDay, undefined);
});

test('Consumable policies cannot spend a final admission credit for continuous native Activity access', (t) => {
  const policy = consumable();
  policy.products[0]!.actions = ['activity.launch'];
  const f = fixture(t, policy);
  assert.equal(f.service.status().configured, false);
});
test('Native purchase opportunities use the configured own-app SKU and never initiate payment', async (t) => {
  const f = fixture(t),
    result = await f.run('premium.purchase', { productId: 'plus' });
  assert.equal(result.status, 'completed');
  if (result.status === 'completed') {
    const payload = result.result as {
      premiumPurchase: boolean;
      components: { toJSON(): { components: { sku_id: string }[] } }[];
    };
    assert.equal(payload.premiumPurchase, true);
    assert.equal(payload.components[0]!.toJSON().components[0]!.sku_id, SKU_ID);
  }
  assert.equal(f.consumeCalls, 0);
});
function consumable() {
  const p = basePolicy() as unknown as {
    version: number;
    products: Record<string, unknown>[];
    themes: unknown[];
    interfaces: unknown[];
  };
  p.products = [
    {
      id: 'credits',
      skuId: SKU_ID,
      name: 'Credits',
      kind: 'consumable',
      scope: 'user',
      actions: ['test.paid'],
      credits: 3,
      creditsPerAction: 1,
    },
  ];
  p.themes = [];
  p.interfaces = [];
  return p;
}
function makeConsumable(f: ReturnType<typeof fixture>) {
  f.sku.type = SKUType.Consumable;
  f.sku.flags = { bitfield: SKUFlags.Available } as SKU['flags'];
  f.entitlement.type = EntitlementType.Purchase;
}
test('Consumable claims consume the exact entitlement once and meter a finite global user credit balance', async (t) => {
  const f = fixture(t, consumable());
  makeConsumable(f);
  await assert.rejects(() => f.run('test.paid'), /requires an active/);
  await f.confirm('premium.claim', { productId: 'credits', entitlementId: ENT });
  assert.equal(f.consumeCalls, 1);
  await assert.rejects(() => f.confirm('premium.claim', { productId: 'credits', entitlementId: ENT }));
  await f.run('test.paid');
  await f.run('test.paid');
  await f.run('test.paid');
  await assert.rejects(() => f.run('test.paid'), /requires an active|balance/);
  assert.equal(f.effects, 3);
  assert.equal((await f.service.getAccess(f.ctx)).availableCredits.credits, 0);
});

test('A consumed purchase has exactly one portable user balance and cannot be claimed again in another guild', async (t) => {
  const f = fixture(t, consumable());
  makeConsumable(f);
  await f.confirm('premium.claim', { productId: 'credits', entitlementId: ENT });
  await f.run('test.paid');
  f.guild.id = '620000000000000098';
  f.channel.guildId = f.guild.id;
  assert.equal((await f.service.getAccess(f.ctx)).availableCredits.credits, 2);
  await f.run('test.paid');
  await assert.rejects(() => f.confirm('premium.claim', { productId: 'credits', entitlementId: ENT }));
  assert.equal(f.consumeCalls, 1);
  assert.equal((await f.service.getAccess(f.ctx)).availableCredits.credits, 1);
  assert.equal(f.store.list('premium.claims').length, 1);
});

test('Overlapping consumed-purchase claims cannot mint duplicate credits while the remote request is pending', async (t) => {
  const f = fixture(t, consumable());
  makeConsumable(f);
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.setConsumeHook(async () => {
    entered();
    await pending;
    f.entitlement.consumed = true;
  });
  const original = f.confirm('premium.claim', { productId: 'credits', entitlementId: ENT });
  await started;
  await assert.rejects(
    () => f.confirm('premium.claim', { productId: 'credits', entitlementId: ENT }),
    /already has/,
  );
  await assert.rejects(() => f.confirm('premium.claim-review', { entitlementId: ENT }), /still running/);
  finish();
  await original;
  assert.equal(f.consumeCalls, 1);
  assert.equal((await f.service.getAccess(f.ctx)).availableCredits.credits, 3);
});
test('An uncertain consumption is never automatically repeated; a fresh consumed proof grants credits once', async (t) => {
  const f = fixture(t, consumable());
  makeConsumable(f);
  f.setConsumeHook(async () => {
    f.entitlement.consumed = true;
    throw new Error('Unknown response');
  });
  await assert.rejects(
    () => f.confirm('premium.claim', { productId: 'credits', entitlementId: ENT }),
    /requires review/,
  );
  assert.equal(f.consumeCalls, 1);
  assert.equal((await f.service.getAccess(f.ctx)).availableCredits.credits, undefined);
  await f.confirm('premium.claim-review', { entitlementId: ENT });
  assert.equal(f.consumeCalls, 1);
  assert.equal((await f.service.getAccess(f.ctx)).availableCredits.credits, 3);
  await assert.rejects(() => f.confirm('premium.claim-review', { entitlementId: ENT }), /No unresolved/);
});
test('An explicitly reviewed unconsumed purchase can be retried without minting a duplicate credit claim', async (t) => {
  const f = fixture(t, consumable());
  makeConsumable(f);
  f.setConsumeHook(async () => {
    throw new Error('Rejected');
  });
  await assert.rejects(() => f.confirm('premium.claim', { productId: 'credits', entitlementId: ENT }));
  await assert.rejects(() => f.confirm('premium.claim-review', { entitlementId: ENT }), /unconsumed/);
  f.setConsumeHook(async () => {
    f.entitlement.consumed = true;
  });
  await f.confirm('premium.claim-review', { entitlementId: ENT, outcome: 'retry-unconsumed' });
  assert.equal(f.consumeCalls, 2);
  assert.equal(f.store.list('premium.claims').length, 1);
  assert.equal((await f.service.getAccess(f.ctx)).availableCredits.credits, 3);
});
test('Refunded/deleted consumed purchases cannot provide remaining credits and failed commands retain an explicit attempted outcome', async (t) => {
  const f = fixture(t, consumable());
  makeConsumable(f);
  await f.confirm('premium.claim', { productId: 'credits', entitlementId: ENT });
  const grant = await f.service.authorize(f.ctx, 'test.paid'),
    use = f.service.begin(f.ctx, 'test.paid', grant)!;
  use.finish('failure');
  use.finish('success');
  assert.equal(f.store.list<{ status: string }>('premium.usage')[0]!.value.status, 'failure');
  assert.equal((await f.service.getAccess(f.ctx)).availableCredits.credits, 2);
  f.entitlement.deleted = true;
  await assert.rejects(() => f.run('test.paid'), /requires an active/);
});
test('Consumed credit purchases remain usable after a cosmetic policy edit without changing the purchased credit quantity', async (t) => {
  const f = fixture(t, consumable());
  makeConsumable(f);
  await f.confirm('premium.claim', { productId: 'credits', entitlementId: ENT });
  const p = consumable();
  p.products[0]!.name = 'Renamed';
  p.products[0]!.credits = 999;
  writeFileSync(f.file, JSON.stringify(p));
  const reloaded = createPremiumService({ policyFile: f.file, operatorIds: [U], now: () => f.time });
  t.after(() => reloaded.close());
  assert.equal((await reloaded.getAccess(f.ctx)).availableCredits.credits, 3);
});

test('Support restores only exact failed-attempt debits once and refuses refunded purchases or unrelated cases', async (t) => {
  const f = fixture(t, consumable());
  makeConsumable(f);
  await f.confirm('premium.claim', { productId: 'credits', entitlementId: ENT });
  const grant = await f.service.authorize(f.ctx, 'test.paid');
  f.service.begin(f.ctx, 'test.paid', grant)!.finish('failure');
  const usage = f.store.list<{ id: string }>('premium.usage')[0]!.value,
    opened = await f.confirm('premium.support.open', {
      kind: 'billing',
      subject: 'Failed attempt',
      text: 'Please review the attempt.',
    });
  assert.equal(opened.status, 'completed');
  if (opened.status !== 'completed') return;
  const caseId = (opened.result as { id: string }).id,
    input = {
      caseId,
      usageId: usage.id,
      remoteStateReviewed: true,
      reason: 'Remote service confirms no output was generated.',
    };
  assert.equal((await f.service.getAccess(f.ctx)).availableCredits.credits, 2);
  f.entitlement.deleted = true;
  await assert.rejects(() => f.confirm('premium.support.restore-credits', input), /could not be proved/);
  assert.equal(f.store.list<{ spent: number }>('premium.claims')[0]!.value.spent, 1);
  f.entitlement.deleted = false;
  await f.confirm('premium.support.restore-credits', input);
  assert.equal((await f.service.getAccess(f.ctx)).availableCredits.credits, 3);
  await assert.rejects(() => f.confirm('premium.support.restore-credits', input), /unrestored/);
  assert.equal((await f.service.getAccess(f.ctx)).availableCredits.credits, 3);
  f.actor.id = '620000000000000099';
  await assert.rejects(
    () => f.confirm('premium.support.restore-credits', input),
    /application owner|OPERATOR_IDS/,
  );
});
test('Premium support conversations are isolated to their customer and operators and can be resolved through the bot', async (t) => {
  const f = fixture(t),
    opened = await f.confirm('premium.support.open', {
      kind: 'billing',
      subject: 'Question',
      text: 'Please inspect my purchase.',
    });
  assert.equal(opened.status, 'completed');
  if (opened.status !== 'completed') return;
  const caseId = (opened.result as { id: string }).id;
  await f.confirm('premium.support.reply', { caseId, text: 'Additional information' });
  const original = f.actor.id;
  f.actor.id = '620000000000000099';
  await assert.rejects(
    () => f.confirm('premium.support.reply', { caseId, text: 'Unauthorized' }),
    /application owner|OPERATOR_IDS/,
  );
  const own = await f.run('premium.support.mine');
  assert.equal(own.status, 'completed');
  if (own.status === 'completed') assert.deepEqual(own.result, []);
  f.actor.id = original;
  // A staff operator replies from a distinct locally authorized account.
  const staffService = createPremiumService({
      policyFile: f.file,
      operatorIds: ['620000000000000099'],
      now: () => f.time,
    }),
    staffRegistry = new ActionRegistry();
  staffService.registerActions(staffRegistry);
  t.after(() => staffService.close());
  f.actor.id = '620000000000000099';
  const action = staffRegistry.get('premium.support.reply');
  await action.execute(f.ctx, action.schema.parse({ caseId, text: 'Resolved', resolve: true }));
  assert.equal(f.store.get<{ state: string }>('premium.support', `${G}:${caseId}`)?.state, 'resolved');
});
test('Observed lifecycle events deduplicate and usage retention marks interrupted attempts unknown', async (t) => {
  const f = fixture(t);
  f.service.recordEvent(f.client, f.store, 'entitlementCreate', f.entitlement);
  f.service.recordEvent(f.client, f.store, 'entitlementCreate', f.entitlement);
  assert.equal(f.store.list('premium.events').length, 1);
  f.setTime(f.time + 60000);
  f.service.recordEvent(f.client, f.store, 'entitlementCreate', f.entitlement);
  f.service.recordEvent(f.client, f.store, 'entitlementCreate', null);
  assert.equal(f.store.list('premium.events').length, 1);
  f.service.recordEvent(f.client, f.store, 'subscriptionUpdate', {
    id: ENT,
    skuIds: [SKU_ID],
    userId: U,
    status: 0,
    currentPeriodStartTimestamp: f.time,
    currentPeriodEndTimestamp: f.time + 86400000,
  });
  f.service.recordEvent(f.client, f.store, 'subscriptionUpdate', {
    id: ENT,
    skuIds: [SKU_ID],
    userId: U,
    status: 0,
    currentPeriodStartTimestamp: f.time + 86400000,
    currentPeriodEndTimestamp: f.time + 2 * 86400000,
  });
  assert.equal(f.store.list('premium.events').length, 3);
  const grant = await f.service.authorize(f.ctx, 'test.paid');
  f.service.begin(f.ctx, 'test.paid', grant);
  f.setTime(f.time + 600001);
  f.service.sweep(f.store, f.time);
  assert.equal(f.store.list<{ status: string }>('premium.usage')[0]!.value.status, 'unknown');
  f.setTime(f.time + 91 * 86400000);
  f.service.sweep(f.store, f.time);
  assert.equal(f.store.list('premium.usage').length, 0);
  assert.equal(f.store.list('premium.events').length, 0);
});
