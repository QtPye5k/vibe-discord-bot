import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import { registerSystemActions } from '../src/features/system.js';
import { AiService } from '../src/features/ai.js';

const G = '760000000000000001',
  U = '760000000000000002',
  C = '760000000000000003',
  ROLE = '760000000000000004';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(t: TestContext) {
  const store = new Store(':memory:'),
    registry = new ActionRegistry(120, async (ctx) => ctx);
  const member = { id: U, roles: { cache: new Map([[ROLE, {}]]) } };
  const ctx = {
    store,
    channelId: C,
    member,
    guild: {
      id: G,
      ownerId: '760000000000000009',
      members: { cache: new Map([[U, member]]) },
      roles: { fetch: async (id: string) => (id === ROLE ? { id } : null) },
    },
  } as unknown as ActionContext;
  let providerCalls = 0;
  const provider = new OpenAI({
    apiKey: 'test-only-not-a-real-key',
    maxRetries: 0,
    fetch: async () => {
      providerCalls++;
      throw new Error('No remote API should be needed');
    },
  });
  registerSystemActions(registry, loadConfig({}));
  const ai = new AiService(loadConfig({}), store, registry, provider);
  const change = async (roleIds: string[]) => {
    const action = registry.get('system.ai.access');
    return action.execute(ctx, action.schema.parse({ roleIds }));
  };
  t.after(() => store.close());
  return { ctx, store, ai, change, providerCalls: () => providerCalls };
}

test('The real AI role policy handler increments the shared access epoch only after all roles validate', async (t) => {
  const f = fixture(t);
  f.store.set('ai.policyEpoch', G, 7);
  await assert.rejects(f.change(['760000000000000099']), /Role not found/);
  assert.equal(f.store.get('ai.policyEpoch', G), 7);
  assert.equal(f.store.get('core.aiRoles', G), undefined);
  await f.change([ROLE]);
  assert.deepEqual(f.store.get('core.aiRoles', G), [ROLE]);
  assert.equal(f.store.get('ai.policyEpoch', G), 8);
  await f.change([]);
  assert.deepEqual(f.store.get('core.aiRoles', G), []);
  assert.equal(f.store.get('ai.policyEpoch', G), 9);
});

test('Changing role access while billing waits cancels admission before a stream or quota charge', async (t) => {
  const f = fixture(t),
    entered = deferred(),
    resume = deferred();
  let operations = 0;
  f.ai.setAllowanceResolver(async () => {
    entered.resolve();
    await resume.promise;
    return undefined;
  });
  const pending = f.ai.admitVoice(f.ctx, async () => {
    operations++;
  });
  await entered.promise;
  await f.change([ROLE]);
  resume.resolve();
  await assert.rejects(pending, /access settings changed/);
  assert.equal(operations, 0);
  assert.equal(f.providerCalls(), 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM quota').get()?.n, 0);
});

test('Changing role access during an admitted voice operation invalidates its delayed result', async (t) => {
  const f = fixture(t),
    entered = deferred(),
    resume = deferred();
  const pending = f.ai.admitVoice(f.ctx, async () => {
    entered.resolve();
    await resume.promise;
    return 'Late speech';
  });
  await entered.promise;
  await f.change([ROLE]);
  resume.resolve();
  await assert.rejects(pending, /access policy changed/);
  assert.equal(f.providerCalls(), 0);
});

test('Role membership lost during billing is rechecked from the current member cache without charging a request', async (t) => {
  const f = fixture(t),
    entered = deferred(),
    resume = deferred();
  await f.change([ROLE]);
  f.ai.setAllowanceResolver(async () => {
    entered.resolve();
    await resume.promise;
    return undefined;
  });
  const pending = f.ai.admitVoice(f.ctx, async () => {
    throw new Error('Forbidden stream');
  });
  await entered.promise;
  f.ctx.guild.members.cache.set(U, {
    ...f.ctx.member,
    roles: { cache: new Map() },
  } as ActionContext['member']);
  resume.resolve();
  await assert.rejects(pending, /roles do not allow/);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM quota').get()?.n, 0);
  assert.equal(f.providerCalls(), 0);
});
