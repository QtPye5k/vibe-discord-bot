import { PermissionFlagsBits as P } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import { actionPolicyExempt } from '../core/registry.js';
import { assertOperator } from '../core/operator.js';
import type { Config } from '../config.js';
import { csv } from '../core/files.js';
import { UserError } from '../core/errors.js';
import { resolveChannel, resolveRole } from '../core/permissions.js';

export function registerSystemActions(
  registry: ActionRegistry,
  config: Config,
  onFeatureChange?: (guildId: string, category: string, enabled: boolean) => void,
  onRestart?: () => void,
): void {
  const base = {
    category: 'system',
    userPermissions: [P.ManageGuild],
    botPermissions: [],
    risk: 'read' as const,
  };
  const empty = z.strictObject({});
  registry.register({
    ...base,
    id: 'system.restart',
    risk: 'write',
    userPermissions: [],
    description:
      'Application operator requests a graceful restart under the bundled supervisor; no update or code download is performed.',
    schema: empty,
    execute: (ctx) => {
      assertOperator(ctx, config.operatorIds);
      if (!onRestart)
        throw new UserError('Managed restart is unavailable. Start with pnpm start:supervised.');
      onRestart();
      return {
        requested: true,
        notice:
          'A graceful restart was requested. The supervisor must successfully launch and reconnect the bot.',
      };
    },
  });
  registry.register({
    ...base,
    id: 'system.action-policy.set',
    risk: 'write',
    description:
      'Restrict an action to approved roles/channels or disable it; current policy is rechecked on confirmation.',
    schema: z.strictObject({
      action: z.string().min(2).max(64),
      enabled: z.boolean().default(true),
      roleIds: z
        .array(z.string().regex(/^\d{17,20}$/))
        .max(20)
        .default([]),
      channelIds: z
        .array(z.string().regex(/^\d{17,20}$/))
        .max(20)
        .default([]),
    }),
    execute: async (ctx, input) => {
      const action = registry.get(input.action);
      if (action.category === 'system')
        throw new UserError('System controls remain available to server managers.');
      if (actionPolicyExempt(action.id))
        throw new UserError('Privacy, consent withdrawal and cancellation controls remain available.');
      for (const id of input.roleIds) await resolveRole(ctx, id);
      for (const id of input.channelIds) await resolveChannel(ctx, id);
      const key = `${ctx.guild.id}:${action.id}`;
      if (
        ctx.store.list('core.actionPolicies', `${ctx.guild.id}:`).length >= 300 &&
        !ctx.store.get('core.actionPolicies', key)
      )
        throw new UserError('Limit: 300 action policies per server.');
      const policy = {
        enabled: input.enabled,
        roleIds: [...new Set(input.roleIds)],
        channelIds: [...new Set(input.channelIds)],
      };
      ctx.store.set('core.actionPolicies', key, policy);
      return { action: action.id, ...policy };
    },
  });
  registry.register({
    ...base,
    id: 'system.action-policy.list',
    description: 'Read configured per-action role and channel restrictions for this server.',
    schema: empty,
    execute: (ctx) =>
      ctx.store
        .list('core.actionPolicies', `${ctx.guild.id}:`)
        .map((row) => ({ action: row.key.slice(ctx.guild.id.length + 1), policy: row.value })),
  });
  registry.register({
    ...base,
    id: 'system.action-policy.remove',
    risk: 'write',
    description: 'Remove an action restriction, restoring its normal permission requirements.',
    schema: z.strictObject({ action: z.string().min(2).max(64) }),
    execute: (ctx, input) => ({
      removed: ctx.store.delete('core.actionPolicies', `${ctx.guild.id}:${input.action}`),
    }),
  });
  registry.register({
    ...base,
    id: 'system.status',
    description: 'Report uptime, process memory, Gateway latency and enabled capabilities.',
    userPermissions: [],
    schema: empty,
    execute: (ctx) => ({
      uptimeSeconds: Math.floor(process.uptime()),
      memoryMiB: Math.round(process.memoryUsage().rss / 1048576),
      gatewayLatencyMs: ctx.client.ws.ping,
      guilds: ctx.client.guilds.cache.size,
      actions: registry.list().length,
      disabledCategories: ctx.store.get('core.disabled', ctx.guild.id) ?? [],
      intents: {
        members: config.enableMembers,
        messageContent: config.enableMessageContent,
        voice: config.enableVoice,
      },
    }),
  });
  registry.register({
    ...base,
    id: 'system.features',
    description: 'Enable or disable a category for this server.',
    risk: 'write',
    schema: z.strictObject({ category: z.string().max(40), enabled: z.boolean() }),
    execute: (ctx, input) => {
      if (input.category === 'system' || !registry.list().some((a) => a.category === input.category))
        throw new UserError('Choose an existing category other than system.');
      const disabled = new Set(ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? []);
      if (input.enabled) disabled.delete(input.category);
      else disabled.add(input.category);
      ctx.store.set('core.disabled', ctx.guild.id, [...disabled]);
      const epochKey = `${ctx.guild.id}:${input.category}`;
      ctx.store.set(
        'core.featureEpochs',
        epochKey,
        (ctx.store.get<number>('core.featureEpochs', epochKey) ?? 0) + 1,
      );
      onFeatureChange?.(ctx.guild.id, input.category, input.enabled);
      return { disabledCategories: [...disabled] };
    },
  });
  registry.register({
    ...base,
    id: 'system.ai.access',
    description: 'Restrict AI spending to specified roles; an empty list allows all members.',
    risk: 'write',
    schema: z.strictObject({ roleIds: z.array(z.string().regex(/^\d{17,20}$/)).max(20) }),
    execute: async (ctx, input) => {
      for (const id of input.roleIds)
        if (!(await ctx.guild.roles.fetch(id))) throw new UserError('Role not found.');
      ctx.store.transaction(() => {
        ctx.store.set('core.aiRoles', ctx.guild.id, input.roleIds);
        ctx.store.set(
          'ai.policyEpoch',
          ctx.guild.id,
          (ctx.store.get<number>('ai.policyEpoch', ctx.guild.id) ?? 0) + 1,
        );
      });
      return { roleIds: input.roleIds };
    },
  });
  registry.register({
    ...base,
    id: 'system.audit',
    description:
      'Read the last 100 bot action audit records for this server (parameters and chat text are not logged).',
    schema: empty,
    execute: (ctx) =>
      ctx.store.db
        .prepare(
          'SELECT id,created_at,user_id,action,status,detail FROM audit WHERE guild_id=? ORDER BY id DESC LIMIT 100',
        )
        .all(ctx.guild.id),
  });
  registry.register({
    ...base,
    id: 'system.pending',
    description: 'List your own pending confirmations in this channel.',
    userPermissions: [],
    schema: empty,
    execute: (ctx) =>
      ctx.store.db
        .prepare(
          'SELECT id,action,input,expires_at FROM confirmations WHERE guild_id=? AND user_id=? AND channel_id=? AND expires_at>? ORDER BY expires_at LIMIT 10',
        )
        .all(ctx.guild.id, ctx.member.id, ctx.channelId, Date.now()),
  });
  registry.register({
    ...base,
    id: 'analytics.commands',
    description: 'Aggregate observed action counts and failures by action for this server.',
    schema: empty,
    execute: (ctx) =>
      ctx.store.db
        .prepare(
          'SELECT action,status,count(*) AS count FROM audit WHERE guild_id=? GROUP BY action,status ORDER BY count DESC LIMIT 100',
        )
        .all(ctx.guild.id),
  });
  registry.register({
    ...base,
    id: 'analytics.export',
    description: 'Export up to 10,000 action audit records from this server as spreadsheet-safe CSV.',
    schema: empty,
    execute: (ctx) => ({
      attachment: Buffer.from(
        csv(
          ctx.store.db
            .prepare(
              'SELECT id,created_at,user_id,action,status,detail FROM audit WHERE guild_id=? ORDER BY id DESC LIMIT 10000',
            )
            .all(ctx.guild.id),
        ),
      ),
      name: 'bot-audit.csv',
    }),
  });
}
