import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { assertUserRequestCurrent, isCurrentUserRequest, type Action, type ActionContext } from './types.js';
import { UserError } from './errors.js';
import { assertPermissions, freshContext } from './permissions.js';

export type ActionOutcome =
  | { status: 'completed'; action: string; result: unknown }
  | { status: 'confirmation'; action: string; id: string; input: unknown; expiresAt: number };
type Guard = (context: ActionContext, action: Action, input: unknown) => Promise<ActionContext>;
export type ConfirmationMode = 'always' | 'smart';
export interface RegistryOptions {
  confirmationMode?: ConfirmationMode;
}
export interface ActionAccessGate {
  authorize(ctx: ActionContext, action: Action): Promise<unknown>;
  begin(
    ctx: ActionContext,
    action: Action,
    grant: unknown,
  ): void | { finish(status: 'success' | 'failure'): void };
}
export interface ActionPolicy {
  enabled: boolean;
  roleIds: string[];
  channelIds: string[];
}
const policyExempt = new Set([
  'ai.memory.forget',
  'ai.knowledge.remove',
  'oauth.unlink',
  'oauth.accounts',
  'raffle.withdraw',
  'raffle.cancel',
  'approval.chain.withdraw',
  'approval.chain.cancel',
  'voice.recordings.erase',
  'voice.recordings.list',
  'activity.erase',
  'game-stats.remove',
  'relay.consent',
  'conversation.channel.consent',
  'tracking.remove',
  'relay.remove',
  'community.erase',
  'membership.roles.consent',
  'membership.roles.view',
  'reminder.cancel',
  'reminder.list',
  'notification.cancel',
  'notification.preferences',
  'notification.reminders',
  'notification.subscribe',
  'games.erase.mine',
  'game.leave',
  'game.close',
  'form.erase-own',
  'analytics.erase.mine',
  'analytics.privacy',
  'analytics.privacy.view',
  'celebration.remove',
  'workflow.remove',
  'schedule.remove',
  'integration.watch-remove',
  'voiceroom.hub-remove',
  'calendar.cancel',
  'voice.playlist-remove',
  'report.schedule.remove',
  'group.leave',
  'group.erase.mine',
  'group.assignment.respond',
  'engagement.questions.remove',
  'engagement.milestone.remove',
  'warning.job.cancel',
  'operation.tasks',
  'operation.history',
  'operation.run.acknowledge',
  'operation.schedule.list',
  'operation.schedule.remove',
  'translation.optout',
  'translation.preferences',
  'translation.consent',
  'statuspanel.remove',
  'eventchannel.pause',
  'eventchannel.remove',
  'ticket.thread-close',
  'ticket.thread-view',
  'ticket.thread-list',
  'ticket.thread-reconcile',
  'ticket.thread-transcript',
  'ticket.thread-settings',
  'voice.trivia-stop',
  'voice.trivia-status',
  'voice.library',
]);
export function actionPolicyExempt(id: string): boolean {
  return policyExempt.has(id);
}
/** These writes change authority, execute host tasks or send to an external recipient. */
export function needsExactConfirmation(
  action: Pick<Action, 'id' | 'category' | 'risk' | 'confirmation'>,
): boolean {
  return (
    action.risk === 'destructive' ||
    action.confirmation === 'always' ||
    action.category === 'permissions' ||
    action.id === 'ai.plan.step' ||
    action.id === 'role.create' ||
    /^(?:system\.(?:features|ai\.access|action-policy\.(?:set|remove))|bot\.profile\.global|role\.(?:assign|assign-many|edit|position)|host\.run|operation\.(?:run|schedule\.set)|oauth\.(?:link\.confirm|guild\.join|linked-role\.update)|integration\.(?:cloudflare\.dns-update|email\.send|sms\.send))$/.test(
      action.id,
    )
  );
}
export class ActionRegistry {
  private readonly actions = new Map<string, Action>();
  private accessGate: ActionAccessGate | undefined;
  setAccessGate(gate: ActionAccessGate | undefined): void {
    this.accessGate = gate;
  }
  private gated(action: Action): boolean {
    return !!this.accessGate && action.category !== 'system' && !actionPolicyExempt(action.id);
  }
  private observer:
    | ((ctx: ActionContext, action: Action, status: 'success' | 'failure', durationMs: number) => void)
    | undefined;
  setObserver(
    observer: (ctx: ActionContext, action: Action, status: 'success' | 'failure', durationMs: number) => void,
  ): void {
    this.observer = observer;
  }
  constructor(
    private readonly confirmationSeconds = 120,
    private readonly guard: Guard = async (ctx, action, input) => {
      const fresh = await freshContext(ctx);
      await assertPermissions(fresh, action.userPermissions, action.botPermissions, input);
      return fresh;
    },
    private readonly options: RegistryOptions = {},
  ) {}
  confirmationMode(): ConfirmationMode {
    return this.options.confirmationMode ?? 'always';
  }
  register<S extends z.ZodType>(action: Action<S>): void {
    if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(action.id) || this.actions.has(action.id))
      throw new Error(`Invalid or duplicate action: ${action.id}`);
    this.actions.set(action.id, action as unknown as Action);
  }
  get(id: string): Action {
    const action = this.actions.get(id);
    if (!action) throw new UserError(`Unknown action: ${id}. Use /help or /action autocomplete.`);
    return action;
  }
  list(): Action[] {
    return [...this.actions.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  listAvailable(): Action[] {
    return this.list().filter((action) => action.available?.() !== false);
  }
  /** Checks module/action restrictions only; automated callers must also refresh and authorize permissions. */
  assertPolicy(ctx: ActionContext, id: string): void {
    this.assertEnabled(ctx, this.get(id));
  }
  async request(ctx: ActionContext, id: string, raw: unknown): Promise<ActionOutcome> {
    assertUserRequestCurrent(ctx);
    const action = this.get(id);
    const input = action.schema.parse(raw);
    this.assertEnabled(ctx, action);
    const grant = this.gated(action) ? await this.accessGate!.authorize(ctx, action) : undefined;
    assertUserRequestCurrent(ctx);
    const fresh = await this.guard(ctx, action, input);
    assertUserRequestCurrent(ctx);
    assertUserRequestCurrent(fresh);
    this.assertEnabled(fresh, action);
    if (action.risk !== 'read' && JSON.stringify(input).length > 12000000)
      throw new UserError('Action input exceeds the 12 MB persistence limit.');
    if (
      action.risk === 'read' ||
      (this.confirmationMode() === 'smart' && isCurrentUserRequest(fresh) && !needsExactConfirmation(action))
    )
      return this.execute(fresh, action, input, grant);
    const pending = Number(
      ctx.store.db
        .prepare('SELECT count(*) AS n FROM confirmations WHERE guild_id=? AND user_id=? AND expires_at>?')
        .get(ctx.guild.id, ctx.member.id, Date.now())?.n ?? 0,
    );
    if (pending >= 10)
      throw new UserError('Confirm or cancel pending actions before requesting more (limit 10).');
    const guildPending = Number(
      ctx.store.db
        .prepare('SELECT count(*) AS n FROM confirmations WHERE guild_id=? AND expires_at>?')
        .get(ctx.guild.id, Date.now())?.n ?? 0,
    );
    if (guildPending >= 100)
      throw new UserError('This server has too many pending actions. Confirm or cancel existing requests.');
    const token = randomBytes(12).toString('base64url');
    const expiresAt = Date.now() + this.confirmationSeconds * 1000;
    ctx.store.db
      .prepare('INSERT INTO confirmations VALUES(?,?,?,?,?,?,?)')
      .run(token, ctx.guild.id, ctx.member.id, ctx.channelId, id, JSON.stringify(input), expiresAt);
    ctx.store.audit({
      guildId: ctx.guild.id,
      userId: action.auditIdentity === 'private' ? 'private-submission' : ctx.member.id,
      action: id,
      status: 'pending',
    });
    return { status: 'confirmation', action: id, id: token, input, expiresAt };
  }
  /** Only this member's live previews from the exact origin channel; newest first. */
  pending(ctx: ActionContext): Extract<ActionOutcome, { status: 'confirmation' }>[] {
    return ctx.store.db
      .prepare(
        'SELECT * FROM confirmations WHERE guild_id=? AND user_id=? AND channel_id=? AND expires_at>? ORDER BY rowid DESC LIMIT 10',
      )
      .all(ctx.guild.id, ctx.member.id, ctx.channelId, Date.now())
      .map((row) => ({
        status: 'confirmation',
        action: String(row.action),
        id: String(row.id),
        input: JSON.parse(String(row.input)),
        expiresAt: Number(row.expires_at),
      }));
  }
  async confirmLatest(
    ctx: ActionContext,
    options: { latest?: boolean; id?: string } = {},
  ): Promise<ActionOutcome> {
    if (options.id) return this.confirm(ctx, options.id);
    const pending = this.pending(ctx);
    if (!pending.length) throw new UserError('There is no pending change to confirm in this conversation.');
    if (pending.length > 1 && !options.latest)
      throw new UserError(
        `There are ${pending.length} pending changes. Say “confirm last” or use /confirm id:ID for the one you want.`,
      );
    return this.confirm(ctx, pending[0]!.id);
  }
  async confirm(ctx: ActionContext, token: string): Promise<ActionOutcome> {
    assertUserRequestCurrent(ctx);
    const row = ctx.store.db.prepare('SELECT * FROM confirmations WHERE id=?').get(token);
    if (
      !row ||
      row.guild_id !== ctx.guild.id ||
      row.user_id !== ctx.member.id ||
      row.channel_id !== ctx.channelId
    )
      throw new UserError('This confirmation is unavailable or belongs to another person/channel.');
    if (Number(row.expires_at) <= Date.now()) {
      ctx.store.db.prepare('DELETE FROM confirmations WHERE id=?').run(token);
      throw new UserError('Confirmation expired. Submit the action again.');
    }
    const action = this.get(String(row.action));
    const input = action.schema.parse(JSON.parse(String(row.input)));
    this.assertEnabled(ctx, action);
    const grant = this.gated(action) ? await this.accessGate!.authorize(ctx, action) : undefined;
    assertUserRequestCurrent(ctx);
    const fresh = await this.guard(ctx, action, input);
    assertUserRequestCurrent(ctx);
    assertUserRequestCurrent(fresh);
    this.assertEnabled(fresh, action);
    // Claim after the asynchronous authorization check, before side effects. Concurrent clicks can only win once.
    if (
      ctx.store.db.prepare('DELETE FROM confirmations WHERE id=? AND expires_at>?').run(token, Date.now())
        .changes !== 1
    )
      throw new UserError('This confirmation expired or has already been used.');
    return this.execute(fresh, action, input, grant);
  }
  cancel(ctx: ActionContext, token: string): boolean {
    return (
      ctx.store.db
        .prepare('DELETE FROM confirmations WHERE id=? AND guild_id=? AND user_id=? AND channel_id=?')
        .run(token, ctx.guild.id, ctx.member.id, ctx.channelId).changes === 1
    );
  }
  private assertEnabled(ctx: ActionContext, action: Action): void {
    if (action.available?.() === false)
      throw new UserError(action.unavailableReason ?? 'This optional service is not configured on the host.');
    if (actionPolicyExempt(action.id)) return;
    const disabled = ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? [];
    if (disabled.includes(action.category) && action.category !== 'system')
      throw new UserError(`${action.category} is disabled in this server.`);
    if (action.category === 'system') return;
    const policy = ctx.store.get<ActionPolicy>('core.actionPolicies', `${ctx.guild.id}:${action.id}`);
    if (!policy) return;
    if (!policy.enabled) throw new UserError('This action is disabled by server policy.');
    if (policy.channelIds.length && !policy.channelIds.includes(ctx.channelId))
      throw new UserError('This action is unavailable in this channel.');
    if (policy.roleIds.length && !policy.roleIds.some((id) => ctx.member.roles.cache.has(id)))
      throw new UserError('Your roles do not allow this action under server policy.');
  }
  private async execute(
    ctx: ActionContext,
    action: Action,
    input: unknown,
    grant?: unknown,
  ): Promise<ActionOutcome> {
    assertUserRequestCurrent(ctx);
    const started = performance.now();
    let status: 'success' | 'failure' = 'failure';
    const access = this.gated(action) ? this.accessGate!.begin(ctx, action, grant) : undefined;
    try {
      assertUserRequestCurrent(ctx);
      const result = await action.execute(ctx, input);
      status = 'success';
      ctx.store.audit({
        guildId: ctx.guild.id,
        userId: action.auditIdentity === 'private' ? 'private-submission' : ctx.member.id,
        action: action.id,
        status: 'success',
      });
      return { status: 'completed', action: action.id, result };
    } catch (error) {
      // API messages can contain request fragments. Persist only the error class.
      ctx.store.audit({
        guildId: ctx.guild.id,
        userId: action.auditIdentity === 'private' ? 'private-submission' : ctx.member.id,
        action: action.id,
        status: 'failure',
        detail: error instanceof Error ? error.name : 'Error',
      });
      throw error;
    } finally {
      try {
        access?.finish(status);
      } catch {
        /* Usage diagnostics cannot change a completed remote operation. */
      }
      try {
        this.observer?.(ctx, action, status, performance.now() - started);
      } catch {
        /* Diagnostics must not change the outcome of a completed Discord mutation. */
      }
    }
  }
}
