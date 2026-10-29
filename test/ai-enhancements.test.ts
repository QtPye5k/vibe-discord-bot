import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { Collection, PermissionFlagsBits as P, PermissionsBitField, type Guild } from 'discord.js';
import { z } from 'zod';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import { loadConfig } from '../src/config.js';
import { AiService, forgetAiData } from '../src/features/ai.js';
import {
  registerAiEnhancementActions,
  analyzeText,
  type AiEnhancementOptions,
} from '../src/features/ai-enhancements.js';
import { recordApiMetric } from '../src/features/api-metrics.js';
const G = '910000000000000001',
  U = '910000000000000002',
  B = '910000000000000003',
  C = '910000000000000004',
  R = '910000000000000005';
function fixture(t: TestContext, enhancements: AiEnhancementOptions = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const member = {
      id: U,
      permissions: new PermissionsBitField(P.Administrator),
      roles: { cache: new Collection([[R, {}]]) },
    },
    bot = { id: B, permissions: new PermissionsBitField(P.Administrator) };
  const hidden = new Set<string>();
  const channel = {
    id: C,
    guildId: G,
    type: 0,
    permissionsFor: (who: { id: string }) =>
      new PermissionsBitField(hidden.has(who.id) ? 0n : P.Administrator),
    isTextBased: () => true,
    messages: {
      fetch: async (_input: unknown) =>
        new Collection<
          string,
          { id: string; createdTimestamp: number; author: { id: string }; content: string }
        >(),
    },
  };
  const guild = {
    id: G,
    ownerId: U,
    name: 'Example',
    members: { me: bot, fetch: async () => member, fetchMe: async () => bot },
    channels: { fetch: async () => channel },
    roles: { fetch: async (id: string) => ({ id, guild: { id: G } }) },
  } as unknown as Guild;
  const ctx = { store, guild, member, channelId: C, client: {} } as unknown as ActionContext;
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let hook: ((body: Record<string, unknown>, path: string) => unknown) | undefined;
  const provider = new OpenAI({
    apiKey: 'test-only-not-a-real-key',
    maxRetries: 0,
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
        path = String(url);
      requests.push({ path, body });
      const output =
        hook?.(body, path) ??
        (path.endsWith('/embeddings')
          ? { data: [{ embedding: [1, 0] }] }
          : {
              id: 'response-test',
              object: 'response',
              status: 'completed',
              output: [
                {
                  id: 'message-test',
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'Supported answer', annotations: [] }],
                },
              ],
            });
      return new Response(JSON.stringify(output), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  const registry = new ActionRegistry(),
    ai = new AiService(loadConfig({}), store, registry, provider);
  registerAiEnhancementActions(registry, ai, {
    operatorIds: [U],
    modelRoutes: { coding: 'configured-coding-model', reasoning: 'configured-reasoning-model' },
    ...enhancements,
  });
  const execute = async (id: string, input: unknown = {}) => {
    const outcome = await registry.request(ctx, id, input);
    return outcome.status === 'confirmation' ? registry.confirm(ctx, outcome.id) : outcome;
  };
  return {
    store,
    ctx,
    member,
    bot,
    channel,
    guild,
    registry,
    ai,
    requests,
    hidden,
    execute,
    setHook(value: typeof hook) {
      hook = value;
    },
  };
}
const result = (outcome: Awaited<ReturnType<ReturnType<typeof fixture>['execute']>>) => {
  assert.equal(outcome.status, 'completed');
  return outcome.status === 'completed' ? outcome.result : undefined;
};

test('AI exact calculator action/tool and model routes use actual SDK request/response orchestration', async (t) => {
  const f = fixture(t);
  assert.equal(
    (result(await f.execute('math.calculate', { expression: '0.1+0.2' })) as { decimal: string }).decimal,
    '0.3',
  );
  let call = 0;
  f.setHook((body) => {
    if (++call === 1)
      return {
        id: 'response-test',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            id: 'function-test',
            call_id: 'calculate-call',
            name: 'calculate',
            arguments: '{"expression":"0.1+0.2"}',
            status: 'completed',
          },
        ],
      };
    const inputs = body.input as { type?: string; output?: string }[];
    assert.ok(
      inputs.some((value) => value.type === 'function_call_output' && value.output?.includes('3/10')),
    );
    return undefined;
  });
  await f.ai.chat(f.ctx, 'Calculate 0.1+0.2');
  assert.equal(f.requests[0]!.body.model, 'configured-reasoning-model');
  f.setHook(undefined);
  await f.ai.chat(f.ctx, 'Debug this Python code');
  assert.equal(f.requests.at(-1)!.body.model, 'configured-coding-model');
});
test('AI policies enforce individual/admin limits, suppress tools/search and invalidate in-flight results', async (t) => {
  const f = fixture(t);
  await f.execute('ai.access.configure', { scope: 'user', userId: U, enabled: false });
  await assert.rejects(() => f.ai.chat(f.ctx, 'Hi'), /access is disabled/);
  assert.equal(f.requests.length, 0);
  await f.execute('ai.access.remove', { scope: 'user', userId: U });
  await f.execute('ai.access.configure', {
    scope: 'administrators',
    enabled: true,
    allowTools: false,
    maxDailyRequests: 1,
  });
  await f.ai.chat(f.ctx, 'Hi');
  assert.deepEqual(f.requests[0]!.body.tools, []);
  await assert.rejects(() => f.ai.chat(f.ctx, 'Again'), /daily AI request allowance/);
  await f.execute('ai.access.remove', { scope: 'administrators' });
  f.setHook(() => {
    f.store.set('ai.policyEpoch', G, 999);
    return undefined;
  });
  await assert.rejects(() => f.ai.chat(f.ctx, 'A delayed request'), /access policy changed/);
});
test('pinned private memory is durable, excluded from shared requests and erased with personal AI data', async (t) => {
  const f = fixture(t);
  await f.execute('ai.memory.pin', { name: 'preference', text: 'private permanent fact' });
  await f.ai.chat(f.ctx, 'Remember');
  assert.match(String(f.requests.at(-1)!.body.instructions), /private permanent fact/);
  await f.ai.chat(f.ctx, 'Shared', undefined, false, { usePreferences: false, retainHistory: false });
  assert.doesNotMatch(String(f.requests.at(-1)!.body.instructions), /private permanent fact/);
  assert.equal(f.store.list('ai.pinned').length, 1);
  forgetAiData(f.store, U, G);
  assert.equal(f.store.list('ai.pinned').length, 0);
});
test('durable plans require exact one-use step confirmation and stop after ambiguous effects', async (t) => {
  const f = fixture(t);
  let effects = 0;
  f.registry.register({
    id: 'example.change',
    category: 'example',
    risk: 'write',
    description: 'A reviewed fixture mutation',
    schema: z.strictObject({ value: z.number() }),
    userPermissions: [],
    botPermissions: [],
    execute: (_ctx, input) => {
      effects += input.value;
      return { effects };
    },
  });
  const plan = result(
    await f.execute('ai.plan.create', {
      name: 'Two changes',
      steps: [
        { action: 'example.change', input: { value: 2 } },
        { action: 'example.change', input: { value: 3 } },
      ],
    }),
  ) as { id: string; revision: string };
  assert.equal(effects, 0);
  const preview = await f.registry.request(f.ctx, 'ai.plan.step', {
    id: plan.id,
    revision: plan.revision,
    step: 0,
    action: 'example.change',
    input: { value: 2 },
  });
  assert.equal(effects, 0);
  assert.equal(preview.status, 'confirmation');
  if (preview.status !== 'confirmation') throw new Error();
  await Promise.allSettled([f.registry.confirm(f.ctx, preview.id), f.registry.confirm(f.ctx, preview.id)]);
  assert.equal(effects, 2);
  const next = result(await f.execute('ai.plan.view', { id: plan.id })) as { nextRequest: unknown };
  await f.execute('ai.plan.step', next.nextRequest);
  assert.equal(effects, 5);
  const view = result(await f.execute('ai.plan.view', { id: plan.id })) as { state: string };
  assert.equal(view.state, 'done');
  f.registry.register({
    id: 'example.ambiguous',
    category: 'example',
    risk: 'write',
    description: 'A fixture with ambiguous remote outcome',
    schema: z.strictObject({}),
    userPermissions: [],
    botPermissions: [],
    execute: () => {
      effects++;
      throw new Error('Connection lost after effect');
    },
  });
  const failed = result(
    await f.execute('ai.plan.create', {
      name: 'Unknown result',
      steps: [{ action: 'example.ambiguous', input: {} }],
    }),
  ) as { id: string; revision: string };
  await assert.rejects(
    () =>
      f.execute('ai.plan.step', {
        id: failed.id,
        revision: failed.revision,
        step: 0,
        action: 'example.ambiguous',
        input: {},
      }),
    /Connection lost/,
  );
  assert.equal(effects, 6);
  const failedView = result(await f.execute('ai.plan.view', { id: failed.id })) as { state: string };
  assert.equal(failedView.state, 'review-required');
  await assert.rejects(
    () =>
      f.execute('ai.plan.step', {
        id: failed.id,
        revision: failed.revision,
        step: 0,
        action: 'example.ambiguous',
        input: {},
      }),
    /Plan state/,
  );
  assert.equal(effects, 6);
});
test('shared knowledge rechecks role/source access and refuses changed documents after the model response', async (t) => {
  const f = fixture(t);
  await f.execute('ai.knowledge.shared-add', { name: 'staff', text: 'Staff procedure', roleIds: [R] });
  assert.equal((result(await f.execute('ai.knowledge.shared-list')) as unknown[]).length, 1);
  f.setHook((_body, path) => {
    if (path.endsWith('/responses')) {
      const value = f.store.get<Record<string, unknown>>('ai.sharedDocuments', `${G}:staff`)!;
      f.store.set('ai.sharedDocuments', `${G}:staff`, { ...value, version: 'changed' });
    }
    return undefined;
  });
  await assert.rejects(
    () => f.execute('ai.knowledge.shared-ask', { question: 'Procedure?' }),
    /knowledge or access changed/,
  );
  f.member.permissions = new PermissionsBitField(P.ViewChannel);
  f.member.roles.cache.clear();
  assert.deepEqual(result(await f.execute('ai.knowledge.shared-list')), []);
});
test('multi-stage source analysis bounds provider inputs and reports actual source coverage', async (t) => {
  const f = fixture(t),
    source = '"\\'.repeat(18000);
  const answer = await analyzeText(f.ai, f.ctx, 'Summarize', source, 'test-analysis');
  assert.equal(answer.truncated, true);
  assert.equal(answer.charactersAnalyzed, 30000);
  assert.equal(answer.requests, 13);
  for (const request of f.requests) {
    const inputs = request.body.input as { content: { text?: string }[] }[];
    const text = inputs
      .flatMap((input) => input.content)
      .map((content) => content.text ?? '')
      .join('');
    assert.ok(text.length <= 8000);
  }
});
test('endpoint telemetry stores aggregate request/error and latency fields without payloads', async (t) => {
  const f = fixture(t);
  await f.ai.chat(f.ctx, 'One request');
  recordApiMetric(f.store, G, 'fixture', 'read', false, 25);
  const metrics = result(await f.execute('analytics.api')) as {
    provider: string;
    requests: number;
    errors: number;
    meanMs: number;
  }[];
  assert.ok(metrics.some((row) => row.provider === 'openai' && row.requests === 1 && row.errors === 0));
  assert.ok(metrics.some((row) => row.provider === 'fixture' && row.errors === 1 && row.meanMs === 25));
  assert.doesNotMatch(JSON.stringify(metrics), /One request|test-only-not-a-real-key/);
});

test('asynchronous premium allowances preserve stricter personal limits after another request consumes the final allowance', async (t) => {
  const f = fixture(t);
  await f.execute('ai.access.configure', { scope: 'user', userId: U, enabled: true, maxDailyRequests: 1 });
  let release!: () => void,
    calls = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.ai.setAllowanceResolver(async () => {
    if (++calls === 1) await gate;
    return { userDaily: 1000, guildDaily: 1000 };
  });
  const first = f.ai.chat(f.ctx, 'Waiting for entitlement'),
    rejected = assert.rejects(first, /configured daily AI request allowance/);
  await f.ai.chat(f.ctx, 'Uses the final request');
  release();
  await rejected;
  assert.equal(f.requests.length, 1);
  assert.equal(f.store.db.prepare('SELECT count FROM quota WHERE scope=?').get(`user:${G}:${U}`)?.count, 1);
});

test('erasure or policy changes while resolving an AI allowance prevent the provider request and quota charge', async (t) => {
  for (const change of ['erase', 'policy'] as const) {
    const f = fixture(t);
    f.ai.setAllowanceResolver(async () => {
      if (change === 'erase') forgetAiData(f.store, U, G);
      else f.store.set('ai.policyEpoch', G, 999);
      return { userDaily: 1000 };
    });
    await assert.rejects(() => f.ai.chat(f.ctx, 'Private waiting input'), /cancelled after/);
    assert.equal(f.requests.length, 0);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM quota').get()?.n, 0);
  }
});

test('retained plan erasure invalidates approval gates and forbids reconciliation while a step is still active', async (t) => {
  let release!: () => void,
    gates = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(t, {
    assertPlanApprovals: async () => {
      if (++gates === 2) await gate;
    },
  });
  let effects = 0;
  f.registry.register({
    id: 'example.delayed',
    category: 'example',
    risk: 'write',
    description: 'Deferred permission gate fixture',
    schema: z.strictObject({}),
    userPermissions: [],
    botPermissions: [],
    execute: () => {
      effects++;
      return {};
    },
  });
  const plan = result(
    await f.execute('ai.plan.create', {
      name: 'Erase while gated',
      steps: [{ action: 'example.delayed', input: {} }],
    }),
  ) as { id: string; revision: string };
  const pending = f.execute('ai.plan.step', {
    id: plan.id,
    revision: plan.revision,
    step: 0,
    action: 'example.delayed',
    input: {},
  });
  const rejected = assert.rejects(pending, /Plan is unavailable/);
  while (gates < 2) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => f.execute('ai.plan.reconcile', { id: plan.id, outcome: 'retry', reviewedExternalState: true }),
    /still running/,
  );
  f.store.set('approval.chains', `${G}:${U}:${plan.id}`, { fixture: true });
  forgetAiData(f.store, U, G);
  release();
  await rejected;
  assert.equal(effects, 0);
  assert.equal(f.store.list('ai.plans').length, 0);
  assert.equal(f.store.list('approval.chains').length, 0);
});

test('a completed already-started plan step remains recorded after cancellation without scheduling another step', async (t) => {
  const f = fixture(t);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    begun = new Promise<void>((resolve) => {
      started = resolve;
    });
  f.registry.register({
    id: 'example.remote',
    category: 'example',
    risk: 'write',
    description: 'An already-started remote operation fixture',
    schema: z.strictObject({}),
    userPermissions: [],
    botPermissions: [],
    execute: async () => {
      started();
      await gate;
      return { remoteCompleted: true };
    },
  });
  const plan = result(
    await f.execute('ai.plan.create', {
      name: 'Cancel next steps',
      steps: [
        { action: 'example.remote', input: {} },
        { action: 'example.remote', input: {} },
      ],
    }),
  ) as { id: string; revision: string };
  const pending = f.execute('ai.plan.step', {
    id: plan.id,
    revision: plan.revision,
    step: 0,
    action: 'example.remote',
    input: {},
  });
  await begun;
  await f.execute('ai.plan.cancel', { id: plan.id });
  release();
  await pending;
  const saved = result(await f.execute('ai.plan.view', { id: plan.id })) as {
    state: string;
    next: number;
    results: { status: string }[];
  };
  assert.equal(saved.state, 'cancelled');
  assert.equal(saved.next, 0);
  assert.equal(saved.results.at(-1)?.status, 'completed-after-cancel');
});

test('history coverage probes for older messages after a short requested page instead of claiming the history ended', async (t) => {
  const f = fixture(t),
    limits: number[] = [];
  f.channel.messages.fetch = async (raw: unknown) => {
    const input = raw as { limit: number; before?: string };
    limits.push(input.limit);
    const ids = input.before ? ['930000000000000001'] : ['930000000000000003', '930000000000000002'];
    return new Collection(
      ids.map((id, index) => [
        id,
        { id, createdTimestamp: 3 - index, author: { id: U }, content: 'Accessible historical evidence' },
      ]),
    );
  };
  const answer = result(
    await f.execute('ai.history.answer', { channelId: C, question: 'What happened?', maxMessages: 2 }),
  ) as { hasMoreHistory: boolean; fetchedMessages: number; messageIds: string[] };
  assert.equal(answer.hasMoreHistory, true);
  assert.equal(answer.fetchedMessages, 2);
  assert.equal(answer.messageIds.length, 2);
  assert.deepEqual(limits, [2, 1]);
});

test('transparent image generation sends explicit supported alpha-output fields through the real SDK', async (t) => {
  const f = fixture(t);
  f.setHook((_body, path) =>
    path.endsWith('/images/generations')
      ? { data: [{ b64_json: Buffer.from('fixture-image').toString('base64') }] }
      : undefined,
  );
  await f.ai.image(f.ctx, 'A cutout concept', undefined, true);
  assert.equal(f.requests[0]!.body.background, 'transparent');
  assert.equal(f.requests[0]!.body.output_format, 'png');
});
