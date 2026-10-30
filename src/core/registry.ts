import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { assertUserRequestCurrent, isCurrentUserRequest, type Action, type ActionContext } from './types.js';
import { UserError } from './errors.js';
import { assertPermissions, freshContext } from './permissions.js';

export type ActionOutcome =
  | { status: 'completed'; action: string; result: unknown }
  | {
      status: 'confirmation';
      action: string;
      id: string;
      input: unknown;
      expiresAt: number;
      approvalChannelId?: string;
    };
export type PendingConfirmation = Extract<ActionOutcome, { status: 'confirmation' }>;
export type CompletedActionOutcome = Extract<ActionOutcome, { status: 'completed' }>;
export interface PrivateConfirmationResult {
  deliver(outcome: CompletedActionOutcome): Promise<void>;
}
/** Host-installed, shared by every transport. Action input cannot install or bypass this policy. */
export interface ConfirmationPolicy {
  channelId(ctx: ActionContext): string | undefined;
  authorize(ctx: ActionContext): Promise<ActionContext>;
  publish(ctx: ActionContext, pending: PendingConfirmation): Promise<void>;
  /** Prove the original requester's private destination before claiming an approved private action. */
  preparePrivateResult?(ctx: ActionContext, action: string): Promise<PrivateConfirmationResult | undefined>;
}
type Guard = (context: ActionContext, action: Action, input: unknown) => Promise<ActionContext>;
const APPROVED_CHILD = Symbol('exact-approved-plan-child');
interface ApprovedChild {
  active: boolean;
  used: boolean;
  guildId: string;
  userId: string;
  channelId: string;
  action: string;
  input: string;
}
type ApprovedContext = ActionContext & { [APPROVED_CHILD]?: ApprovedChild };
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
  private readonly requestContexts = new Map<
    string,
    { ctx: ActionContext; expiresAt: number; origins: WeakSet<ActionContext> }
  >();
  private confirmationPolicy: ConfirmationPolicy | undefined;
  setConfirmationPolicy(policy: ConfirmationPolicy | undefined): void {
    this.confirmationPolicy = policy;
  }
  confirmationChannelId(ctx: ActionContext): string | undefined {
    return this.confirmationPolicy?.channelId(ctx);
  }
  hasConfirmationPolicy(): boolean {
    return this.confirmationPolicy !== undefined;
  }
  /** The policy is deliberately exposed only through authorization, never a caller-controlled flag. */
  async assertConfirmationAuthority(ctx: ActionContext): Promise<ActionContext> {
    return this.confirmationPolicy ? this.confirmationPolicy.authorize(ctx) : ctx;
  }
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
      (this.confirmationMode() === 'smart' &&
        isCurrentUserRequest(fresh) &&
        !needsExactConfirmation(action)) ||
      this.claimApprovedChild(fresh, action, input)
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
    const outcome: PendingConfirmation = { status: 'confirmation', action: id, id: token, input, expiresAt };
    if (this.confirmationPolicy) {
      for (const [id, request] of this.requestContexts)
        if (request.expiresAt <= Date.now()) this.requestContexts.delete(id);
      this.requestContexts.set(token, { ctx: fresh, expiresAt, origins: new WeakSet([ctx, fresh]) });
      try {
        await this.confirmationPolicy.publish(fresh, outcome);
      } catch (error) {
        // A failed/uncertain delivery must not leave an actionable invisible request behind.
        ctx.store.db.prepare('DELETE FROM confirmations WHERE id=?').run(token);
        this.requestContexts.delete(token);
        throw error;
      }
      const approvalChannelId = this.confirmationPolicy.channelId(fresh);
      if (!approvalChannelId) {
        ctx.store.db.prepare('DELETE FROM confirmations WHERE id=?').run(token);
        this.requestContexts.delete(token);
        throw new UserError('The private confirmation channel is unavailable.');
      }
      return { ...outcome, input: null, approvalChannelId };
    }
    return outcome;
  }
  /** Only this member's live previews from the exact origin channel; newest first. */
  pending(ctx: ActionContext): Extract<ActionOutcome, { status: 'confirmation' }>[] {
    if (this.confirmationPolicy) {
      if (this.confirmationPolicy.channelId(ctx) !== ctx.channelId) return [];
      return ctx.store.db
        .prepare(
          'SELECT * FROM confirmations WHERE guild_id=? AND expires_at>? ORDER BY rowid DESC LIMIT 100',
        )
        .all(ctx.guild.id, Date.now())
        .map((row) => ({
          status: 'confirmation' as const,
          action: String(row.action),
          id: String(row.id),
          input: JSON.parse(String(row.input)),
          expiresAt: Number(row.expires_at),
        }));
    }
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
    await this.assertConfirmationAuthority(ctx);
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
    const policy = this.confirmationPolicy;
    if (policy) ctx = await policy.authorize(ctx);
    const row = ctx.store.db.prepare('SELECT * FROM confirmations WHERE id=?').get(token);
    if (
      !row ||
      row.guild_id !== ctx.guild.id ||
      (!policy && (row.user_id !== ctx.member.id || row.channel_id !== ctx.channelId))
    )
      throw new UserError('This confirmation is unavailable or belongs to another person/channel.');
    if (Number(row.expires_at) <= Date.now()) {
      ctx.store.db.prepare('DELETE FROM confirmations WHERE id=?').run(token);
      this.requestContexts.delete(token);
      throw new UserError('Confirmation expired. Submit the action again.');
    }
    const action = this.get(String(row.action));
    const input = action.schema.parse(JSON.parse(String(row.input)));
    // Approval grants no requester authority: run under the original member and original channel.
    const original = this.requestContexts.get(token)?.ctx;
    if (policy && !original) {
      ctx.store.db.prepare('DELETE FROM confirmations WHERE id=?').run(token);
      throw new UserError(
        'This approval lost its live requester authorization after a restart or expiry. Submit the action again.',
      );
    }
    if (original) assertUserRequestCurrent(original);
    const requester = policy
      ? {
          ...(original ?? {}),
          client: ctx.client,
          guild: ctx.guild,
          member: await ctx.guild.members.fetch({ user: String(row.user_id), force: true }),
          channelId: String(row.channel_id),
          store: ctx.store,
        }
      : ctx;
    this.assertEnabled(requester, action);
    let grant = this.gated(action) ? await this.accessGate!.authorize(requester, action) : undefined;
    assertUserRequestCurrent(ctx);
    let fresh = await this.guard(requester, action, input);
    assertUserRequestCurrent(ctx);
    assertUserRequestCurrent(fresh);
    this.assertEnabled(fresh, action);
    if (policy) await policy.authorize(ctx);
    assertUserRequestCurrent(fresh);
    assertUserRequestCurrent(ctx);
    const privateResult = await policy?.preparePrivateResult?.(fresh, action.id);
    if (privateResult) {
      // DM creation is asynchronous: neither the requester nor reviewer may retain stale authority.
      assertUserRequestCurrent(fresh);
      assertUserRequestCurrent(ctx);
      fresh = await this.guard(fresh, action, input);
      assertUserRequestCurrent(fresh);
      this.assertEnabled(fresh, action);
      grant = this.gated(action) ? await this.accessGate!.authorize(fresh, action) : undefined;
      await policy!.authorize(ctx);
      assertUserRequestCurrent(fresh);
      assertUserRequestCurrent(ctx);
      this.assertEnabled(fresh, action);
    }
    // Claim after the asynchronous authorization check, before side effects. Concurrent clicks can only win once.
    if (
      ctx.store.db.prepare('DELETE FROM confirmations WHERE id=? AND expires_at>?').run(token, Date.now())
        .changes !== 1
    )
      throw new UserError('This confirmation expired or has already been used.');
    this.requestContexts.delete(token);
    const execute = async (): Promise<CompletedActionOutcome> => {
      // ai.plan.step displays the exact child action+schema-normalized input in its own preview.
      // Carry only that one child approval, never a blanket approval of future nested requests.
      if (policy && action.id === 'ai.plan.step' && input && typeof input === 'object') {
        const step = input as { action?: unknown; input?: unknown };
        if (typeof step.action === 'string') {
          const child = this.get(step.action),
            normalized = child.schema.parse(step.input);
          const scope: ApprovedChild = {
            active: true,
            used: false,
            guildId: fresh.guild.id,
            userId: fresh.member.id,
            channelId: fresh.channelId,
            action: child.id,
            input: JSON.stringify(normalized),
          };
          try {
            return await this.execute(
              { ...fresh, [APPROVED_CHILD]: scope } as ApprovedContext,
              action,
              input,
              grant,
            );
          } finally {
            scope.active = false;
          }
        }
      }
      return this.execute(fresh, action, input, grant);
    };
    let outcome: CompletedActionOutcome;
    try {
      outcome = await execute();
    } catch (error) {
      if (privateResult)
        throw new UserError(
          'The private action failed or may be incomplete. No private result was shared with the reviewer; this request was not retried.',
        );
      throw error;
    }
    if (!privateResult) return outcome;
    try {
      await privateResult.deliver(outcome);
      return {
        status: 'completed',
        action: action.id,
        result: {
          privateResult: 'delivered',
          notice: 'The action completed. Its private result was sent only to the original requester’s DMs.',
        },
      };
    } catch {
      // The action already completed. Never expose the credential/file in an error or invite a mutation retry.
      return {
        status: 'completed',
        action: action.id,
        result: {
          privateResult: 'delivery-failed',
          notice:
            'The action completed, but its private result could not be delivered. No private result was shared with the reviewer. Do not repeat the action automatically; verify the actual result first.',
        },
      };
    }
  }
  /** Reviewer rejection uses exactly the same private-channel and fresh hierarchy gate as approval. */
  async reject(ctx: ActionContext, token: string): Promise<boolean> {
    assertUserRequestCurrent(ctx);
    if (!this.confirmationPolicy) return this.cancel(ctx, token);
    ctx = await this.confirmationPolicy.authorize(ctx);
    assertUserRequestCurrent(ctx);
    const deleted =
      ctx.store.db
        .prepare('DELETE FROM confirmations WHERE id=? AND guild_id=? AND expires_at>?')
        .run(token, ctx.guild.id, Date.now()).changes === 1;
    if (deleted) this.requestContexts.delete(token);
    return deleted;
  }
  cancel(ctx: ActionContext, token: string): boolean {
    // Legacy synchronous/internal cancellation must never become an unguarded reviewer bypass.
    if (this.confirmationPolicy) return false;
    return (
      ctx.store.db
        .prepare('DELETE FROM confirmations WHERE id=? AND guild_id=? AND user_id=? AND channel_id=?')
        .run(token, ctx.guild.id, ctx.member.id, ctx.channelId).changes === 1
    );
  }
  /** Internal failed-workflow invalidation, bound to a live originating context identity, never a reviewer decision. */
  invalidatePending(ctx: ActionContext, token: string): boolean {
    if (!this.confirmationPolicy) return this.cancel(ctx, token);
    const origin = this.requestContexts.get(token);
    if (!origin?.origins.has(ctx)) return false;
    const deleted =
      ctx.store.db
        .prepare('DELETE FROM confirmations WHERE id=? AND guild_id=? AND user_id=? AND channel_id=?')
        .run(token, ctx.guild.id, ctx.member.id, ctx.channelId).changes === 1;
    if (deleted) this.requestContexts.delete(token);
    return deleted;
  }
  private claimApprovedChild(ctx: ActionContext, action: Action, input: unknown): boolean {
    const scope = (ctx as ApprovedContext)[APPROVED_CHILD];
    if (
      !scope?.active ||
      scope.used ||
      scope.guildId !== ctx.guild.id ||
      scope.userId !== ctx.member.id ||
      scope.channelId !== ctx.channelId ||
      scope.action !== action.id ||
      scope.input !== JSON.stringify(input)
    )
      return false;
    scope.used = true;
    return true;
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
  ): Promise<CompletedActionOutcome> {
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
