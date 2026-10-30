import type { ActionContext } from './types.js';
import { type ActionRegistry, type ActionOutcome } from './registry.js';
import { UserError } from './errors.js';
import { createHash } from 'node:crypto';

type Pending = Extract<ActionOutcome, { status: 'confirmation' }>;
interface Turn {
  ids: string[];
  expiresAt: number;
  fingerprints: Record<string, string>;
}
export interface ConversationActionResult {
  handled: boolean;
  outcomes: ActionOutcome[];
  message?: string;
}
const namespace = 'core.conversationActions';
const key = (ctx: ActionContext) => `${ctx.guild.id}:${ctx.member.id}:${ctx.channelId}`;
const fingerprint = (pending: Pending) =>
  createHash('sha256')
    .update(JSON.stringify([pending.id, pending.action, pending.input, pending.expiresAt]))
    .digest('hex');
/** Record only real previews shown in this exact conversation, never preview-like model prose. */
export function rememberConversationActions(ctx: ActionContext, outcomes: readonly Pending[]): void {
  const ids: string[] = [];
  const fingerprints: Record<string, string> = {};
  let expiresAt = Date.now() + 300000;
  for (const outcome of outcomes) {
    const row = ctx.store.db
      .prepare(
        'SELECT * FROM confirmations WHERE id=? AND guild_id=? AND user_id=? AND channel_id=? AND expires_at>?',
      )
      .get(outcome.id, ctx.guild.id, ctx.member.id, ctx.channelId, Date.now());
    if (
      !row ||
      row.action !== outcome.action ||
      row.input !== JSON.stringify(outcome.input) ||
      Number(row.expires_at) !== outcome.expiresAt
    )
      continue;
    if (!ids.includes(outcome.id)) ids.push(outcome.id);
    fingerprints[outcome.id] = fingerprint(outcome);
    expiresAt = Math.min(expiresAt, outcome.expiresAt);
  }
  ctx.store.set(namespace, key(ctx), { ids, expiresAt, fingerprints } satisfies Turn);
}
/** A completed/unrelated turn must not silently make an older unrelated preview the active one. */
export function clearConversationActions(ctx: ActionContext): void {
  rememberConversationActions(ctx, []);
}
function selection(ctx: ActionContext, registry: ActionRegistry, explicitLast: boolean): Pending[] {
  const pending = registry.pending(ctx);
  if (explicitLast) return pending.slice(0, 1);
  // The dedicated queue can contain requests from other members; an old reviewer's turn is not its binding.
  const remembered = registry.hasConfirmationPolicy() ? undefined : ctx.store.get<Turn>(namespace, key(ctx));
  if (remembered && remembered.expiresAt > Date.now()) {
    const selected = remembered.ids.map((id) => pending.find((item) => item.id === id));
    if (selected.some((item) => !item || remembered.fingerprints?.[item.id] !== fingerprint(item)))
      throw new UserError('That preview expired or changed. Ask for the change again before confirming.');
    return selected as Pending[];
  }
  if (remembered) ctx.store.delete(namespace, key(ctx));
  if (pending.length > 1)
    throw new UserError(
      `There are ${pending.length} pending changes. Say “confirm last” or use /confirm id:ID for the one you want.`,
    );
  return pending;
}
/** Handles only explicit short approval language. General questions and edits remain the assistant's job. */
export async function handleConversationAction(
  ctx: ActionContext,
  text: string,
  registry: ActionRegistry,
  options: { allowAction?: (id: string) => boolean } = {},
): Promise<ConversationActionResult> {
  const input = text
      .normalize('NFKC')
      .trim()
      .replace(/[.!?]+$/u, '')
      .replace(/\s+/g, ' '),
    lower = input.toLowerCase();
  const explicit = /^(confirm|cancel)\s+([A-Za-z0-9_-]{16})$/i.exec(input);
  const confirm =
    /^(?:confirm(?: (?:it|that|the change|last))?|yes(?: please)?|yes,? confirm|confirmed|do it|go ahead|okay,? confirm|ok,? confirm)$/.test(
      lower,
    );
  const cancel = /^(?:cancel(?: (?:it|that|the change|last|all))?|never mind|nevermind)$/.test(lower);
  if (!explicit && !confirm && !cancel) return { handled: false, outcomes: [] };
  const operation = explicit?.[1]?.toLowerCase() ?? (cancel ? 'cancel' : 'confirm');
  await registry.assertConfirmationAuthority(ctx);
  let selected: Pending[];
  if (explicit) {
    const pending = registry.pending(ctx).find((item) => item.id === explicit[2]);
    if (!pending) throw new UserError('That confirmation is unavailable or belongs to another conversation.');
    selected = [pending];
  } else if (lower === 'cancel all') selected = registry.pending(ctx);
  else selected = selection(ctx, registry, /\blast$/.test(lower));
  if (!selected.length) {
    if (!explicit && !/^(?:confirm|cancel)/.test(lower)) return { handled: false, outcomes: [] };
    return {
      handled: true,
      outcomes: [],
      message:
        operation === 'cancel'
          ? 'There is no pending change to cancel in this conversation.'
          : 'There is no pending change to confirm in this conversation. Tell me what you want to do.',
    };
  }
  if (operation === 'cancel') {
    let count = 0;
    for (const item of selected) count += Number(await registry.reject(ctx, item.id));
    clearConversationActions(ctx);
    return {
      handled: true,
      outcomes: [],
      message: count === 1 ? 'Cancelled that change.' : `Cancelled ${count} pending changes.`,
    };
  }
  if (options.allowAction && selected.some((item) => !options.allowAction!(item.action)))
    throw new UserError(
      'Confirm this private action with /confirm in its original private interaction; its result cannot be posted to a shared chat.',
    );
  // The selection was bound/preflighted before the first effect. Each execution still reauthorizes and claims once.
  const completed: ActionOutcome[] = [];
  try {
    for (const item of selected) completed.push(await registry.confirm(ctx, item.id));
  } catch (error) {
    clearConversationActions(ctx);
    if (!completed.length) throw error;
    return {
      handled: true,
      outcomes: completed,
      message: `Completed ${completed.length} of ${selected.length} changes. The next change could not finish; remaining changes were not retried. ${error instanceof UserError ? error.message : 'Review the bot diagnostics and actual result before requesting it again.'}`,
    };
  }
  clearConversationActions(ctx);
  return { handled: true, outcomes: completed };
}
