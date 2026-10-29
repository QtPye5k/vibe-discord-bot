import type { ActionContext } from '../core/types.js';

/** One case journal shared by native moderation, warnings and appeal views. No message content is copied. */
export function recordModerationCase(
  ctx: ActionContext,
  kind: string,
  userId: string,
  reason: string,
  details: Record<string, unknown> = {},
) {
  return ctx.store.transaction(() => {
    const key = `${ctx.guild.id}:case`,
      value = (ctx.store.get<number>('community.sequence', key) ?? 0) + 1;
    ctx.store.set('community.sequence', key, value);
    const record = {
      id: String(value),
      userId,
      moderatorId: ctx.member.id,
      reason,
      createdAt: Date.now(),
      notes: [],
      kind,
      details,
    };
    ctx.store.set('community.cases', `${ctx.guild.id}:${record.id}`, record);
    return record;
  });
}
