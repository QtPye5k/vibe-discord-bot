import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { ActionRegistry, type ActionAccessGate } from '../src/core/registry.js';
import {
  assertUserRequestCurrent,
  isCurrentUserRequest,
  userRequestContext,
  type ActionContext,
} from '../src/core/types.js';
import { Store } from '../src/core/store.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  t: TestContext,
  guard: (ctx: ActionContext) => Promise<ActionContext> = async (ctx) => ({ ...ctx }),
) {
  const store = new Store(':memory:'),
    effects: string[] = [];
  const ctx = {
    store,
    guild: { id: '710000000000000001' },
    member: { id: '710000000000000002', roles: { cache: new Map() } },
    channelId: '710000000000000003',
  } as unknown as ActionContext;
  const registry = new ActionRegistry(120, guard, { confirmationMode: 'smart' });
  for (const risk of ['read', 'write', 'destructive'] as const)
    registry.register({
      id: `test.${risk}`,
      category: 'testing',
      risk,
      schema: z.strictObject({}),
      userPermissions: [],
      botPermissions: [],
      description: 'Lease fixture',
      execute: () => {
        effects.push(risk);
        return risk;
      },
    });
  t.after(() => store.close());
  return { store, ctx, registry, effects };
}

test('Request leases fail closed after revocation or callback failure, while unsigned persisted work retains its normal policy', async (t) => {
  const f = fixture(t);
  let active = true;
  const request = userRequestContext(f.ctx, 'voice', { valid: () => active });
  assert(isCurrentUserRequest(request));
  active = false;
  assert.equal(isCurrentUserRequest(request), false);
  assert.throws(() => assertUserRequestCurrent(request), /cancelled/);
  await assert.rejects(f.registry.request(request, 'test.write', {}), /cancelled/);
  assert.deepEqual(f.registry.pending(f.ctx), []);
  const broken = userRequestContext(f.ctx, 'voice', {
    valid: () => {
      throw new Error('stale session');
    },
  });
  assert.equal(isCurrentUserRequest(broken), false);
  assert.throws(() => assertUserRequestCurrent(broken), /cancelled/);
  const persisted = JSON.parse(JSON.stringify({ ...request, store: undefined }));
  persisted.store = f.store;
  assert.doesNotThrow(() => assertUserRequestCurrent(persisted));
  assert.equal((await f.registry.request(persisted, 'test.write', {})).status, 'confirmation');
  assert.deepEqual(f.effects, []);
});

for (const phase of ['allowance', 'permissions'] as const) {
  test(`Revocation during awaited ${phase} prevents a write and prevents a replacement preview`, async (t) => {
    const entered = deferred(),
      resume = deferred();
    let active = true,
      begins = 0;
    const wait = async () => {
      entered.resolve();
      await resume.promise;
    };
    const f = fixture(t, async (ctx) => {
      if (phase === 'permissions') await wait();
      return { ...ctx };
    });
    f.registry.setAccessGate({
      authorize: async () => {
        if (phase === 'allowance') await wait();
        return undefined;
      },
      begin: () => {
        begins++;
      },
    });
    const request = userRequestContext(f.ctx, 'voice', { valid: () => active });
    const outcome = f.registry.request(request, 'test.write', {});
    await entered.promise;
    active = false;
    resume.resolve();
    await assert.rejects(outcome, /cancelled/);
    assert.deepEqual(f.effects, []);
    assert.deepEqual(f.registry.pending(f.ctx), []);
    assert.equal(begins, 0);
  });

  test(`Revocation during confirmation ${phase} preserves the real preview and executes nothing`, async (t) => {
    const entered = deferred(),
      resume = deferred();
    let active = true,
      waiting = false;
    const wait = async () => {
      if (waiting) {
        entered.resolve();
        await resume.promise;
      }
    };
    const f = fixture(t, async (ctx) => {
      if (phase === 'permissions') await wait();
      return { ...ctx };
    });
    f.registry.setAccessGate({
      authorize: async () => {
        if (phase === 'allowance') await wait();
        return undefined;
      },
      begin: () => {
        throw new Error('Cancelled confirmation must not enter execution');
      },
    });
    const preview = await f.registry.request(f.ctx, 'test.destructive', {});
    assert.equal(preview.status, 'confirmation');
    if (preview.status !== 'confirmation') throw new Error('Missing preview');
    waiting = true;
    const request = userRequestContext(f.ctx, 'voice', { valid: () => active });
    const outcome = f.registry.confirm(request, preview.id);
    await entered.promise;
    active = false;
    resume.resolve();
    await assert.rejects(outcome, /cancelled/);
    assert.deepEqual(f.effects, []);
    assert.equal(f.registry.pending(f.ctx)[0]?.id, preview.id);
  });
}

test('The fresh permission context is supplied to the lease validator and execution checks again after quota admission', async (t) => {
  const checked: ActionContext[] = [];
  const f = fixture(t, async (ctx) => ({ ...ctx, member: { ...ctx.member } as ActionContext['member'] }));
  let active = true,
    finished: string | undefined;
  const gate: ActionAccessGate = {
    authorize: async () => undefined,
    begin: () => {
      active = false;
      return {
        finish: (status) => {
          finished = status;
        },
      };
    },
  };
  f.registry.setAccessGate(gate);
  const request = userRequestContext(f.ctx, 'voice', {
    valid: (ctx) => {
      checked.push(ctx);
      return active;
    },
  });
  await assert.rejects(f.registry.request(request, 'test.write', {}), /cancelled/);
  assert(checked.some((ctx) => ctx.member !== f.ctx.member));
  assert.equal(finished, 'failure');
  assert.deepEqual(f.effects, []);
});
