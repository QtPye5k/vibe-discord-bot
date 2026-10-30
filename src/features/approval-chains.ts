import { PermissionFlagsBits as P } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import { freshContext, resolveChannel, resolveRole } from '../core/permissions.js';
import { UserError } from '../core/errors.js';
import { aiPlanContentHash, getOwnedAiPlan, type AiPlan } from './ai-enhancements.js';
const id = z.string().regex(/^\d{17,20}$/),
  slug = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
interface Chain {
  id: string;
  guildId: string;
  ownerId: string;
  channelId: string;
  planId: string;
  planHash: string;
  createdAt: number;
  expiresAt: number;
  stages: { roleId: string; quorum: number }[];
  votes: { userId: string; stage: number; at: number; note: string }[];
  state: 'review' | 'approved' | 'rejected' | 'cancelled';
  rejectedBy?: string;
  decision?: string;
}
const chainKey = (guildId: string, ownerId: string, planId: string) => `${guildId}:${ownerId}:${planId}`;
function stageIndex(chain: Chain) {
  return chain.stages.findIndex(
    (stage, index) => chain.votes.filter((vote) => vote.stage === index).length < stage.quorum,
  );
}
function chainFor(ctx: ActionContext, ownerId: string, planId: string) {
  const key = chainKey(ctx.guild.id, ownerId, planId),
    row = ctx.store.get<Chain>('approval.chains', key);
  if (!row) throw new UserError('Approval chain is unavailable.');
  return { key, row };
}
function assertEnabled(ctx: ActionContext) {
  if ((ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? []).includes('automation'))
    throw new UserError('Approval workflows are disabled.');
}
function assertAudience(ctx: ActionContext, chain: Chain) {
  if (
    chain.ownerId !== ctx.member.id &&
    !chain.stages.some((stage) => ctx.member.roles.cache.has(stage.roleId))
  )
    throw new UserError('This plan is shared only with its owner and configured reviewer roles.');
}
function currentPlan(ctx: ActionContext, chain: Chain) {
  const plan = ctx.store.get<AiPlan>('ai.plans', chainKey(chain.guildId, chain.ownerId, chain.planId));
  if (
    !plan ||
    aiPlanContentHash(plan) !== chain.planHash ||
    plan.guildId !== chain.guildId ||
    plan.channelId !== chain.channelId
  )
    throw new UserError('The plan changed or is unavailable; its old approvals cannot be reused.');
  return plan;
}
function view(chain: Chain) {
  return {
    ...chain,
    nextStage: stageIndex(chain),
    ready: chain.state === 'approved' && chain.expiresAt > Date.now(),
  };
}
/** The existing plan runner calls this before claiming, before child request and before child confirmation. */
export async function assertPlanApprovals(
  ctx: ActionContext,
  plan: AiPlan,
  registry?: ActionRegistry,
): Promise<void> {
  const rowKey = chainKey(plan.guildId, plan.userId, plan.id),
    initial = ctx.store.get<Chain>('approval.chains', rowKey);
  if (!initial) return;
  assertEnabled(ctx);
  if (ctx.member.id !== plan.userId || ctx.guild.id !== plan.guildId || ctx.channelId !== plan.channelId)
    throw new UserError('Approval owner context changed.');
  if (
    initial.state !== 'approved' ||
    initial.expiresAt <= Date.now() ||
    aiPlanContentHash(plan) !== initial.planHash
  )
    throw new UserError('This exact plan still requires current reviewer approvals.');
  const signature = JSON.stringify(initial);
  for (let index = 0; index < initial.stages.length; index++) {
    const stage = initial.stages[index]!,
      voters = [...new Set(initial.votes.filter((vote) => vote.stage === index).map((vote) => vote.userId))];
    if (voters.length < stage.quorum) throw new UserError('An approval stage has not reached its quorum.');
    for (const userId of voters) {
      if (userId === plan.userId) throw new UserError('A plan owner cannot approve their own plan.');
      const reviewer = await ctx.guild.members.fetch({ user: userId, force: true });
      if (reviewer.user.bot || !reviewer.roles.cache.has(stage.roleId))
        throw new UserError('A reviewer no longer holds the required role.');
      if (registry?.hasConfirmationPolicy()) {
        const channelId = registry.confirmationChannelId(ctx);
        if (!channelId) throw new UserError('The dedicated confirmation channel is unavailable.');
        await registry.assertConfirmationAuthority({
          client: ctx.client,
          guild: ctx.guild,
          store: ctx.store,
          member: reviewer,
          channelId,
        });
      }
      const channel = await resolveChannel({ ...ctx, member: reviewer }, initial.channelId);
      if (!channel.permissionsFor(reviewer)?.has(P.ReadMessageHistory))
        throw new UserError('A reviewer lost access to the reviewed plan context.');
      const latest = ctx.store.get<Chain>('approval.chains', rowKey);
      if (!latest || JSON.stringify(latest) !== signature)
        throw new UserError('Approvals changed during authorization.');
    }
  }
  assertEnabled(ctx);
  const latest = ctx.store.get<Chain>('approval.chains', rowKey);
  if (!latest || JSON.stringify(latest) !== signature || latest.expiresAt <= Date.now())
    throw new UserError('Approvals changed during authorization.');
  currentPlan(ctx, initial);
}
export function registerApprovalChainActions(registry: ActionRegistry) {
  const base = { category: 'automation', userPermissions: [], botPermissions: [], risk: 'write' as const };
  registry.register({
    ...base,
    id: 'approval.chain.create',
    description:
      'Share your immutable plan with staged reviewer roles and require distinct human quorums before any further plan steps can execute.',
    schema: z.strictObject({
      planId: slug,
      stages: z
        .array(z.strictObject({ roleId: id, quorum: z.number().int().min(1).max(3).default(1) }))
        .min(1)
        .max(5),
      expiresHours: z.number().int().min(1).max(168).default(72),
    }),
    execute: async (ctx, input) => {
      const plan = getOwnedAiPlan(ctx, input.planId);
      if (['running', 'done', 'cancelled'].includes(plan.state))
        throw new UserError('Attach a chain to a plan awaiting its next step.');
      const rowKey = chainKey(ctx.guild.id, ctx.member.id, plan.id);
      if (ctx.store.get('approval.chains', rowKey))
        throw new UserError('This plan already has an approval chain. Renew that chain instead.');
      for (const stage of input.stages)
        if (!(await resolveRole(ctx, stage.roleId))) throw new UserError('Reviewer role unavailable.');
      const channel = await resolveChannel(ctx, ctx.channelId);
      if (!channel.permissionsFor(ctx.member)?.has(P.ReadMessageHistory))
        throw new UserError('Read Message History required to share this review context.');
      const latest = getOwnedAiPlan(ctx, input.planId);
      if (aiPlanContentHash(latest) !== aiPlanContentHash(plan) || latest.state === 'running')
        throw new UserError('The plan changed while configuring approvals.');
      if (ctx.store.list('approval.chains', `${ctx.guild.id}:`).length >= 100)
        throw new UserError(
          'Approval chain retention capacity reached. Delete old plans and clear their orphaned chains.',
        );
      const now = Date.now(),
        chain: Chain = {
          id: plan.id,
          guildId: ctx.guild.id,
          ownerId: ctx.member.id,
          channelId: ctx.channelId,
          planId: plan.id,
          planHash: aiPlanContentHash(plan),
          stages: input.stages,
          votes: [],
          createdAt: now,
          expiresAt: now + input.expiresHours * 3600000,
          state: 'review',
        };
      ctx.store.set('approval.chains', rowKey, chain);
      return {
        ...view(chain),
        notice:
          'Reviewers must use approval.chain.view and approve this exact content hash. Every plan step still needs the owner’s ordinary exact-input confirmation.',
      };
    },
  });
  registry.register({
    ...base,
    id: 'approval.chain.view',
    risk: 'read',
    description:
      'Read the exact plan content shared with your configured reviewer role, its approval stages, content hash and current progress.',
    schema: z.strictObject({ ownerId: id, planId: slug }),
    execute: async (ctx, input) => {
      ctx = await freshContext(ctx);
      ctx = await registry.assertConfirmationAuthority(ctx);
      const { row } = chainFor(ctx, input.ownerId, input.planId);
      assertAudience(ctx, row);
      if (!registry.hasConfirmationPolicy() && row.channelId !== ctx.channelId)
        throw new UserError('Review this plan in its original channel.');
      const channel = await resolveChannel(ctx, row.channelId);
      if (!channel.permissionsFor(ctx.member)?.has(P.ReadMessageHistory))
        throw new UserError('Current message history access required.');
      const plan = currentPlan(ctx, row);
      return { chain: view(row), plan };
    },
  });
  registry.register({
    ...base,
    id: 'approval.chain.review',
    description:
      'Approve the current stage or reject an exact plan hash as an independent current reviewer; owners cannot self-approve.',
    schema: z.strictObject({
      ownerId: id,
      planId: slug,
      planHash: z.string().regex(/^[a-f0-9]{64}$/),
      approve: z.boolean(),
      note: z.string().max(500).default(''),
    }),
    execute: async (ctx, input) => {
      ctx = await freshContext(ctx);
      ctx = await registry.assertConfirmationAuthority(ctx);
      const { key, row } = chainFor(ctx, input.ownerId, input.planId);
      if (row.ownerId === ctx.member.id) throw new UserError('You cannot approve your own plan.');
      if (!registry.hasConfirmationPolicy() && row.channelId !== ctx.channelId)
        throw new UserError('Use the original review channel.');
      if (
        row.planHash !== input.planHash ||
        row.expiresAt <= Date.now() ||
        !['review', 'approved'].includes(row.state)
      )
        throw new UserError('This approval request changed, expired or is closed.');
      currentPlan(ctx, row);
      const index = stageIndex(row);
      if (index < 0) throw new UserError('Every stage is already approved.');
      if (!ctx.member.roles.cache.has(row.stages[index]!.roleId))
        throw new UserError('Your current roles cannot approve this stage.');
      if (row.votes.some((vote) => vote.userId === ctx.member.id))
        throw new UserError('Each reviewer can approve only one stage of a chain.');
      const channel = await resolveChannel(ctx, row.channelId);
      if (!channel.permissionsFor(ctx.member)?.has(P.ReadMessageHistory))
        throw new UserError('Current review history access required.');
      const latest = chainFor(ctx, input.ownerId, input.planId).row;
      if (JSON.stringify(latest) !== JSON.stringify(row) || row.expiresAt <= Date.now())
        throw new UserError('The chain changed or expired during your review.');
      ctx = await registry.assertConfirmationAuthority(ctx);
      const afterAuthority = chainFor(ctx, input.ownerId, input.planId).row;
      if (JSON.stringify(afterAuthority) !== JSON.stringify(row) || row.expiresAt <= Date.now())
        throw new UserError('The chain changed or expired during your review.');
      if (!ctx.member.roles.cache.has(row.stages[index]!.roleId))
        throw new UserError('Your current roles cannot approve this stage.');
      currentPlan(ctx, row);
      if (!input.approve) {
        row.state = 'rejected';
        row.rejectedBy = ctx.member.id;
        row.decision = input.note;
      } else {
        row.votes.push({ userId: ctx.member.id, stage: index, at: Date.now(), note: input.note });
        row.state = stageIndex(row) < 0 ? 'approved' : 'review';
      }
      ctx.store.set('approval.chains', key, row);
      return view(row);
    },
  });
  registry.register({
    ...base,
    id: 'approval.chain.withdraw',
    description:
      'Withdraw your own approvals, including after a quorum was reached; future plan steps are gated again.',
    schema: z.strictObject({ ownerId: id, planId: slug }),
    execute: (ctx, input) => {
      const { key, row } = chainFor(ctx, input.ownerId, input.planId);
      const before = row.votes.length;
      row.votes = row.votes.filter((vote) => vote.userId !== ctx.member.id);
      if (row.state === 'approved' && stageIndex(row) >= 0) row.state = 'review';
      ctx.store.set('approval.chains', key, row);
      return { withdrawn: before - row.votes.length, ...view(row) };
    },
  });
  registry.register({
    ...base,
    id: 'approval.chain.renew',
    description:
      'Renew your attached chain after expiry or rejection, discarding all previous votes and requiring a completely fresh review.',
    schema: z.strictObject({ planId: slug, expiresHours: z.number().int().min(1).max(168).default(72) }),
    execute: (ctx, input) => {
      const { key, row } = chainFor(ctx, ctx.member.id, input.planId),
        plan = getOwnedAiPlan(ctx, input.planId);
      if (['running', 'done', 'cancelled'].includes(plan.state))
        throw new UserError('This plan is not awaiting a review.');
      row.planHash = aiPlanContentHash(plan);
      row.votes = [];
      row.state = 'review';
      row.expiresAt = Date.now() + input.expiresHours * 3600000;
      delete row.rejectedBy;
      delete row.decision;
      ctx.store.set('approval.chains', key, row);
      return view(row);
    },
  });
  registry.register({
    ...base,
    id: 'approval.chain.cancel',
    description: 'Cancel your attached approval chain so remaining plan steps cannot execute.',
    schema: z.strictObject({ planId: slug }),
    execute: (ctx, input) => {
      const { key, row } = chainFor(ctx, ctx.member.id, input.planId);
      row.state = 'cancelled';
      ctx.store.set('approval.chains', key, row);
      return { cancelled: true };
    },
  });
}
export function sweepApprovalChains(store: ActionContext['store']) {
  for (const row of store.list<Chain>('approval.chains'))
    if (!store.get('ai.plans', row.key)) store.delete('approval.chains', row.key);
}
