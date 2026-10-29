import type { ActionContext } from './types.js';
import { UserError } from './errors.js';
export function assertOperator(ctx: ActionContext, operatorIds: readonly string[] = []): void {
  const owner = ctx.client.application?.owner;
  const id = owner && 'ownerId' in owner ? owner.ownerId : owner?.id;
  if (!operatorIds.includes(ctx.member.id) && ctx.member.id !== id)
    throw new UserError(
      'Only the application owner or a locally configured OPERATOR_IDS user can change global bot settings.',
    );
}
