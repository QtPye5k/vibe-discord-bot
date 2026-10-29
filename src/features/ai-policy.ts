import { PermissionFlagsBits as P } from 'discord.js';
import type { ActionContext } from '../core/types.js';
export interface AiAccessPolicy {
  enabled: boolean;
  allowTools: boolean;
  allowWebSearch: boolean;
  maxDailyRequests?: number;
  route: string;
}
export function effectiveAiPolicy(ctx: ActionContext): AiAccessPolicy {
  const result: AiAccessPolicy = { enabled: true, allowTools: true, allowWebSearch: true, route: 'auto' };
  const keys = [
    `${ctx.guild.id}:server`,
    ...(ctx.member.permissions?.has(P.Administrator) ? [`${ctx.guild.id}:administrators`] : []),
    `${ctx.guild.id}:user:${ctx.member.id}`,
  ];
  for (const key of keys) {
    const policy = ctx.store.get<AiAccessPolicy>('ai.policies', key);
    if (!policy) continue;
    result.enabled &&= policy.enabled;
    result.allowTools &&= policy.allowTools;
    result.allowWebSearch &&= policy.allowWebSearch;
    if (policy.maxDailyRequests !== undefined)
      result.maxDailyRequests = Math.min(result.maxDailyRequests ?? Infinity, policy.maxDailyRequests);
    if (policy.route !== 'auto') result.route = policy.route;
  }
  return result;
}
export const aiPolicyEpoch = (ctx: ActionContext) =>
  ctx.store.get<number>('ai.policyEpoch', ctx.guild.id) ?? 0;
