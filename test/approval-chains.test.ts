import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Collection, PermissionsBitField, PermissionFlagsBits as P, type GuildMember } from 'discord.js';
import { z } from 'zod';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import type { AiService } from '../src/features/ai.js';
import { registerAiEnhancementActions, type AiPlan } from '../src/features/ai-enhancements.js';
import {
  assertPlanApprovals,
  registerApprovalChainActions,
  sweepApprovalChains,
} from '../src/features/approval-chains.js';
const G = '740000000000000001',
  U = '740000000000000002',
  A = '740000000000000003',
  B = '740000000000000004',
  C = '740000000000000005',
  R = '740000000000000006',
  BOT = '740000000000000007';
function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let effects = 0;
  const hooks: { fetch?: (userId: string) => void } = {};
  const make = (id: string) => ({
    id,
    user: { id, bot: false },
    permissions: new PermissionsBitField(P.Administrator),
    roles: { cache: new Collection([[R, { id: R }]]) },
  });
  const user = make(U),
    first = make(A),
    second = make(B),
    bot = make(BOT),
    members = new Map([
      [U, user],
      [A, first],
      [B, second],
      [BOT, bot],
    ]);
  const hidden = new Set<string>(),
    channel = {
      id: C,
      guildId: G,
      type: 0,
      permissionsFor: (member: { id: string }) =>
        new PermissionsBitField(hidden.has(member.id) ? 0n : P.Administrator),
    };
  const guild = {
    id: G,
    ownerId: U,
    members: {
      me: bot,
      fetch: async (input: string | { user: string }) => {
        const id = typeof input === 'string' ? input : input.user;
        hooks.fetch?.(id);
        const member = members.get(id);
        if (!member) throw new Error('Unknown member');
        return member;
      },
      fetchMe: async () => bot,
    },
    channels: { fetch: async () => channel },
    roles: { fetch: async () => ({ id: R, guild: { id: G } }) },
  };
  for (const member of members.values()) Object.assign(member, { guild });
  const ctx = {
    store,
    guild,
    member: user,
    channelId: C,
    client: { user: { id: BOT } },
  } as unknown as ActionContext;
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  registry.register({
    id: 'example.change',
    category: 'example',
    risk: 'write',
    schema: z.strictObject({ amount: z.number().int() }),
    description: 'Reviewed test mutation',
    userPermissions: [],
    botPermissions: [],
    execute: (_ctx, input) => {
      effects += input.amount;
      return { effects };
    },
  });
  registerAiEnhancementActions(registry, { configureModelRoutes: () => {} } as unknown as AiService, {
    assertPlanApprovals,
  });
  registerApprovalChainActions(registry);
  const run = async (id: string, input: unknown, context = ctx) => {
    const requested = await registry.request(context, id, input);
    return requested.status === 'confirmation' ? registry.confirm(context, requested.id) : requested;
  };
  const result = (outcome: Awaited<ReturnType<typeof run>>) => {
    assert.equal(outcome.status, 'completed');
    return outcome.status === 'completed' ? (outcome.result as Record<string, unknown>) : {};
  };
  const reviewer = (member: typeof user) => ({ ...ctx, member: member as unknown as GuildMember });
  const setup = async (stages = [{ roleId: R, quorum: 2 }]) => {
    const plan = result(
      await run('ai.plan.create', {
        name: 'Shared review',
        steps: [{ action: 'example.change', input: { amount: 3 } }],
      }),
    ) as unknown as AiPlan;
    const chain = result(await run('approval.chain.create', { planId: plan.id, stages }));
    return { plan, chain, hash: String(chain.planHash) };
  };
  const approve = (planId: string, hash: string, member = first) =>
    run('approval.chain.review', { ownerId: U, planId, planHash: hash, approve: true }, reviewer(member));
  return {
    store,
    ctx,
    registry,
    run,
    result,
    setup,
    approve,
    reviewer,
    user,
    first,
    second,
    hooks,
    hidden,
    effects: () => effects,
  };
}
test('real plan execution stays blocked until independent reviewers approve the exact immutable plan', async (t) => {
  const f = fixture(t),
    { plan, hash } = await f.setup();
  const next = f.result(await f.run('ai.plan.view', { id: plan.id })).nextRequest;
  await assert.rejects(() => f.run('ai.plan.step', next), /reviewer approvals/);
  assert.equal(f.effects(), 0);
  await f.approve(plan.id, hash);
  await assert.rejects(() => f.run('ai.plan.step', next), /reviewer approvals/);
  await f.approve(plan.id, hash, f.second);
  await f.run('ai.plan.step', next);
  assert.equal(f.effects(), 3);
});
test('owners cannot self-approve and a reviewer cannot satisfy multiple staged roles', async (t) => {
  const f = fixture(t),
    { plan, hash } = await f.setup([
      { roleId: R, quorum: 1 },
      { roleId: R, quorum: 1 },
    ]);
  await assert.rejects(() => f.approve(plan.id, hash, f.user), /own plan/);
  await f.approve(plan.id, hash);
  await assert.rejects(() => f.approve(plan.id, hash), /only one stage/);
  await f.approve(plan.id, hash, f.second);
  await assertPlanApprovals(f.ctx, plan);
});
test('withdrawing a vote or losing the reviewer role blocks subsequent plan execution', async (t) => {
  const f = fixture(t),
    { plan, hash } = await f.setup();
  await f.approve(plan.id, hash);
  await f.approve(plan.id, hash, f.second);
  f.first.roles.cache.clear();
  await assert.rejects(() => assertPlanApprovals(f.ctx, plan), /required role/);
  f.first.roles.cache.set(R, { id: R });
  await f.run('approval.chain.withdraw', { ownerId: U, planId: plan.id }, f.reviewer(f.first));
  await assert.rejects(() => assertPlanApprovals(f.ctx, plan), /reviewer approvals/);
});
test('reviewer source visibility and exact plan content are rechecked rather than trusting stored approval counts', async (t) => {
  const f = fixture(t),
    { plan, hash } = await f.setup();
  await f.approve(plan.id, hash);
  await f.approve(plan.id, hash, f.second);
  f.hidden.add(A);
  await assert.rejects(() => assertPlanApprovals(f.ctx, plan), /view/);
  f.hidden.clear();
  const changed = { ...plan, steps: [{ action: 'example.change', input: { amount: 9 } }] };
  await assert.rejects(() => assertPlanApprovals(f.ctx, changed), /exact plan/);
});
test('approval withdrawal during asynchronous reviewer lookup cannot race into a child mutation', async (t) => {
  const f = fixture(t),
    { plan, hash } = await f.setup();
  await f.approve(plan.id, hash);
  await f.approve(plan.id, hash, f.second);
  f.hooks.fetch = (id) => {
    if (id === A) {
      const row = f.store.get<{ state: string }>('approval.chains', `${G}:${U}:${plan.id}`)!;
      row.state = 'cancelled';
      f.store.set('approval.chains', `${G}:${U}:${plan.id}`, row);
    }
  };
  await assert.rejects(() => assertPlanApprovals(f.ctx, plan), /changed during/);
  assert.equal(f.effects(), 0);
});
test('rejection requires a fresh renewal which clears every old vote', async (t) => {
  const f = fixture(t),
    { plan, hash } = await f.setup();
  await f.run(
    'approval.chain.review',
    { ownerId: U, planId: plan.id, planHash: hash, approve: false, note: 'Needs another review' },
    f.reviewer(f.first),
  );
  await assert.rejects(() => assertPlanApprovals(f.ctx, plan), /reviewer approvals/);
  const renewed = f.result(await f.run('approval.chain.renew', { planId: plan.id }));
  assert.deepEqual(renewed.votes, []);
  assert.equal(renewed.state, 'review');
});
test('private plan reviews reject outsiders and orphan chain cleanup cannot leave a stale reusable approval', async (t) => {
  const f = fixture(t),
    { plan } = await f.setup();
  f.first.roles.cache.clear();
  await assert.rejects(
    () => f.run('approval.chain.view', { ownerId: U, planId: plan.id }, f.reviewer(f.first)),
    /shared only/,
  );
  f.store.delete('ai.plans', `${G}:${U}:${plan.id}`);
  sweepApprovalChains(f.store);
  assert.equal(f.store.list('approval.chains').length, 0);
});
test('configured chain review and saved voters obey the shared private-channel and current seniority gate', async (t) => {
  const f = fixture(t),
    { plan, hash } = await f.setup(),
    approvalChannel = '740000000000000009';
  let demoted = false;
  f.registry.setConfirmationPolicy({
    channelId: () => approvalChannel,
    publish: async () => {},
    authorize: async (ctx) => {
      if (ctx.channelId !== approvalChannel) throw new Error('Private confirmation channel required');
      if (![A, B].includes(ctx.member.id) || (demoted && ctx.member.id === A))
        throw new Error('Highest role must be above Vibe');
      return ctx;
    },
  });
  const review = f.registry.get('approval.chain.review'),
    input = review.schema.parse({ ownerId: U, planId: plan.id, planHash: hash, approve: true });
  await assert.rejects(
    Promise.resolve().then(() => review.execute(f.reviewer(f.first), input)),
    /Private confirmation/,
  );
  await assert.rejects(
    Promise.resolve().then(() => review.execute({ ...f.ctx, channelId: approvalChannel }, input)),
    /above Vibe/,
  );
  await review.execute({ ...f.reviewer(f.first), channelId: approvalChannel }, input);
  await review.execute({ ...f.reviewer(f.second), channelId: approvalChannel }, input);
  await assertPlanApprovals(f.ctx, plan, f.registry);
  demoted = true;
  await assert.rejects(assertPlanApprovals(f.ctx, plan, f.registry), /above Vibe/);
  assert.equal(f.effects(), 0);
});
