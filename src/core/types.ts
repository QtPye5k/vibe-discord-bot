import type { Client, Guild, GuildMember } from 'discord.js';
import type { z } from 'zod';
import type { Store } from './store.js';
import { UserError } from './errors.js';

export type Risk = 'read' | 'write' | 'destructive';
export type UserRequestSource = 'command' | 'chat' | 'voice';
const USER_REQUEST = Symbol('current-user-request');
interface UserRequest {
  source: UserRequestSource;
  guildId: string;
  userId: string;
  channelId: string;
  expiresAt: number;
  valid?: (fresh: ActionContext) => boolean;
}
export interface ActionContext {
  client: Client;
  guild: Guild;
  member: GuildMember;
  channelId: string;
  store: Store;
  /** Internal request provenance; JSON/action inputs and persisted jobs cannot manufacture this symbol. */
  readonly [USER_REQUEST]?: Readonly<UserRequest>;
}
/** Mark only a currently addressed human request, never a passive job or imported tool output. */
export function userRequestContext(
  ctx: ActionContext,
  source: UserRequestSource,
  options: { valid?: (fresh: ActionContext) => boolean } = {},
): ActionContext {
  return {
    ...ctx,
    [USER_REQUEST]: Object.freeze({
      source,
      guildId: ctx.guild.id,
      userId: ctx.member.id,
      channelId: ctx.channelId,
      expiresAt: Date.now() + 300000,
      ...(options.valid ? { valid: options.valid } : {}),
    }),
  };
}
export function isCurrentUserRequest(ctx: ActionContext): boolean {
  try {
    const proof = ctx[USER_REQUEST],
      now = Date.now();
    return (
      !!proof &&
      ['command', 'chat', 'voice'].includes(proof.source) &&
      proof.guildId === ctx.guild.id &&
      proof.userId === ctx.member.id &&
      proof.channelId === ctx.channelId &&
      proof.expiresAt > now &&
      proof.expiresAt <= now + 300000 &&
      (proof.valid === undefined || proof.valid(ctx) === true)
    );
  } catch {
    return false;
  }
}
/** A revoked request must stop, rather than falling back to a new confirmation preview. */
export function assertUserRequestCurrent(ctx: ActionContext): void {
  if (USER_REQUEST in ctx && !isCurrentUserRequest(ctx))
    throw new UserError('This request expired or was cancelled. Submit the request again.');
}
export interface Action<S extends z.ZodType = z.ZodType> {
  /** Host configuration gate; unavailable actions remain documented but cannot run or be confirmed. */
  available?: () => boolean;
  unavailableReason?: string;
  auditIdentity?: 'actor' | 'private';
  id: string;
  description: string;
  category: string;
  schema: S;
  userPermissions: bigint[];
  botPermissions: bigint[];
  risk: Risk;
  /** Require one exact preview even for a direct request under smart confirmation mode. */
  confirmation?: 'always';
  execute(context: ActionContext, input: z.infer<S>): Promise<unknown> | unknown;
}
export interface AuditRecord {
  guildId: string;
  userId: string;
  action: string;
  status: 'pending' | 'success' | 'failure' | 'denied';
  detail?: string;
}
