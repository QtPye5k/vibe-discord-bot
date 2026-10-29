import { randomBytes } from 'node:crypto';
import { PermissionFlagsBits as P, type Client } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { Store } from '../core/store.js';
import { UserError } from '../core/errors.js';
import { assertHierarchy, freshContext, resolveChannel, resolveMember } from '../core/permissions.js';
import { recordModerationCase } from './moderation-cases.js';
interface TempBan {
  id: string;
  guildId: string;
  userId: string;
  actorId: string;
  originChannelId: string;
  expectedReason: string;
  expiresAt: number;
  createdAt: number;
  state: 'applying' | 'active' | 'unknown' | 'expiring' | 'expired' | 'conflict' | 'failed';
  attempts: number;
  retryAt: number;
  lastError?: string;
  caseId?: string;
}
const id = z.string().regex(/^\d{17,20}$/),
  token = z.string().regex(/^[a-f0-9]{16}$/),
  key = (guildId: string, value: string) => `${guildId}:${value}`;
const absent = (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === 10026;
async function expire(client: Client, store: Store, row: TempBan, now: number) {
  const guild = await client.guilds.fetch(row.guildId);
  await guild.members.fetchMe({ force: true });
  if (!guild.members.me?.permissions.has(P.BanMembers))
    throw new UserError('The bot cannot expire this ban.');
  const ban = await guild.bans.fetch(row.userId).catch((error) => {
    if (absent(error)) return null;
    throw error;
  });
  if (!ban) {
    row.state = 'expired';
    row.lastError = undefined;
    store.set('moderation.tempBans', key(row.guildId, row.id), row);
    return;
  }
  if (ban.reason !== row.expectedReason) {
    row.state = 'conflict';
    row.lastError = 'BanChangedOutsideOriginalTemporaryPunishment';
    store.set('moderation.tempBans', key(row.guildId, row.id), row);
    return;
  }
  if (row.expiresAt > now) {
    row.state = 'active';
    store.set('moderation.tempBans', key(row.guildId, row.id), row);
    return;
  }
  row.state = 'expiring';
  store.set('moderation.tempBans', key(row.guildId, row.id), row);
  await guild.bans.remove(row.userId, `Expiry of original temporary ban ${row.id}`);
  row.state = 'expired';
  row.lastError = undefined;
  store.set('moderation.tempBans', key(row.guildId, row.id), row);
}
export function registerTemporaryBanActions(registry: ActionRegistry) {
  const base = { category: 'moderation', userPermissions: [P.BanMembers], botPermissions: [P.BanMembers] };
  registry.register({
    ...base,
    id: 'moderation.tempban',
    risk: 'destructive',
    description:
      'Ban a current manageable member until a fixed deadline; expiry removes only the exact original bot-managed ban and preserves replacement bans.',
    schema: z.strictObject({
      memberId: id,
      durationSeconds: z.number().int().min(60).max(31536000),
      deleteMessageSeconds: z.number().int().min(0).max(604800).default(0),
      reason: z.string().min(1).max(300),
    }),
    execute: async (ctx, input) => {
      ctx = await freshContext(ctx);
      const target = await resolveMember(ctx, input.memberId);
      assertHierarchy(ctx, target);
      if (!target.bannable) throw new UserError('This member cannot be banned.');
      const rows = ctx.store.list<TempBan>('moderation.tempBans', `${ctx.guild.id}:`);
      if (
        rows.some(
          (row) =>
            row.value.userId === input.memberId &&
            ['applying', 'active', 'unknown', 'expiring'].includes(row.value.state),
        )
      )
        throw new UserError('This member already has a tracked temporary ban.');
      if (rows.filter((row) => !['expired', 'conflict', 'failed'].includes(row.value.state)).length >= 200)
        throw new UserError('Limit: 200 active temporary bans per server.');
      const now = Date.now(),
        banId = randomBytes(8).toString('hex'),
        expectedReason = `Temporary ban ${banId}: ${input.reason} [requested by ${ctx.member.id}]`;
      const row: TempBan = {
        id: banId,
        guildId: ctx.guild.id,
        userId: target.id,
        actorId: ctx.member.id,
        originChannelId: ctx.channelId,
        expectedReason,
        expiresAt: now + input.durationSeconds * 1000,
        createdAt: now,
        state: 'applying',
        attempts: 0,
        retryAt: 0,
      };
      ctx.store.set('moderation.tempBans', key(row.guildId, row.id), row);
      try {
        await target.ban({ reason: expectedReason, deleteMessageSeconds: input.deleteMessageSeconds });
        row.state = 'active';
        row.caseId = recordModerationCase(ctx, 'temporary-ban', target.id, input.reason, {
          temporaryBanId: row.id,
          expiresAt: row.expiresAt,
        }).id;
      } catch (error) {
        row.state = 'unknown';
        row.lastError = error instanceof Error ? error.name : 'Error';
        ctx.store.set('moderation.tempBans', key(row.guildId, row.id), row);
        throw error;
      }
      ctx.store.set('moderation.tempBans', key(row.guildId, row.id), row);
      return row;
    },
  });
  registry.register({
    ...base,
    id: 'moderation.tempbans',
    risk: 'read',
    description:
      'Inspect retained temporary punishments and any permission, provenance or unknown-outcome expiry failures.',
    schema: z.strictObject({ userId: id.optional() }),
    execute: (ctx, input) =>
      ctx.store
        .list<TempBan>('moderation.tempBans', `${ctx.guild.id}:`)
        .map((row) => row.value)
        .filter((row) => !input.userId || row.userId === input.userId)
        .slice(-200),
  });
  registry.register({
    ...base,
    id: 'moderation.tempban-revoke',
    risk: 'write',
    description:
      'Revoke a tracked temporary ban early only if Discord still contains its exact original bot-managed reason.',
    schema: z.strictObject({ id: token }),
    execute: async (ctx, input) => {
      ctx = await freshContext(ctx);
      await resolveChannel(ctx, ctx.channelId);
      if (!ctx.member.permissions.has(P.BanMembers))
        throw new UserError('Current Ban Members permission required.');
      const row = ctx.store.get<TempBan>('moderation.tempBans', key(ctx.guild.id, input.id));
      if (!row || row.state === 'expired') throw new UserError('Temporary ban is unavailable.');
      await expire(ctx.client, ctx.store, { ...row, expiresAt: Date.now() }, Date.now());
      const latest = ctx.store.get<TempBan>('moderation.tempBans', key(ctx.guild.id, row.id))!;
      if (latest.state !== 'expired')
        throw new UserError('The ban changed; the current punishment was preserved for manual review.');
      recordModerationCase(
        ctx,
        'temporary-ban-revoked',
        row.userId,
        `Reviewed early removal of temporary ban ${row.id}`,
      );
      return latest;
    },
  });
}
const sweeping = new WeakSet<Store>();
export async function sweepTemporaryBans(
  client: Client,
  store: Store,
  now = Date.now(),
  allowedGuildIds: readonly string[] = [],
) {
  if (sweeping.has(store)) return;
  sweeping.add(store);
  try {
    let count = 0;
    const deadline = Date.now() + 20000;
    for (const { key: rowKey, value: row } of store.list<TempBan>('moderation.tempBans')) {
      if (count >= 20 || Date.now() >= deadline) break;
      if (
        (allowedGuildIds.length && !allowedGuildIds.includes(row.guildId)) ||
        ['expired', 'conflict', 'failed'].includes(row.state) ||
        row.retryAt > now ||
        (row.state === 'active' && row.expiresAt > now)
      )
        continue;
      count++;
      try {
        await expire(client, store, row, now);
      } catch (error) {
        row.attempts++;
        row.state = row.attempts >= 10 ? 'failed' : 'unknown';
        row.lastError = error instanceof Error ? error.name : 'Error';
        row.retryAt = now + Math.min(3600000, 30000 * 2 ** Math.min(7, row.attempts));
        store.set('moderation.tempBans', rowKey, row);
      }
    }
    for (const { key: rowKey, value: row } of store.list<TempBan>('moderation.tempBans'))
      if (row.state === 'expired' && now - row.expiresAt > 30 * 86400000)
        store.delete('moderation.tempBans', rowKey);
  } finally {
    sweeping.delete(store);
  }
}
