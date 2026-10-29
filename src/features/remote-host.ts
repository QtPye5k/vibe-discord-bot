import { randomBytes } from 'node:crypto';
import { PermissionFlagsBits as P } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import { assertOperator } from '../core/operator.js';
import { freshContext, assertPermissions } from '../core/permissions.js';
import { UserError } from '../core/errors.js';
import { publicOrigin } from '../core/http.js';
import { signedAgentHeaders } from '../host-agent/service.js';
export function registerRemoteHostActions(
  registry: ActionRegistry,
  options: { url: string; key: string; operatorIds: readonly string[]; fetch?: typeof fetch },
) {
  let base: URL | undefined;
  try {
    if (options.url) base = publicOrigin(options.url);
  } catch {
    /* Invalid optional service stays unavailable. */
  }
  const available = () => !!base && options.key.length >= 32;
  async function call(input: unknown) {
    if (!available()) throw new UserError('Configure REMOTE_AGENT_URL and REMOTE_AGENT_KEY.');
    const body = Buffer.from(JSON.stringify(input)),
      response = await (options.fetch ?? fetch)(new URL('/agent/rpc', base), {
        method: 'POST',
        headers: signedAgentHeaders(options.key, body),
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    const reader = response.body?.getReader(),
      chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader)
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.length;
          if (bytes > 131072) throw new UserError('Host agent response exceeded128KiB.');
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    if (!response.ok)
      throw new UserError(
        `Host agent rejected the request (${response.status}). Verify host state before retrying a task.`,
      );
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  const baseAction = {
    category: 'operations',
    userPermissions: [P.ManageGuild],
    botPermissions: [],
    available,
    unavailableReason:
      'Remote host support is disabled until REMOTE_AGENT_URL and REMOTE_AGENT_KEY are configured.',
  };
  for (const operation of ['status', 'tasks', 'result', 'run', 'acknowledge'] as const)
    registry.register({
      ...baseAction,
      id: `host.${operation}`,
      risk: operation === 'run' || operation === 'acknowledge' ? 'write' : 'read',
      description:
        operation === 'run'
          ? 'Run one reviewed fixed task on the configured authenticated host; no arbitrary command or argument input.'
          : operation === 'acknowledge'
            ? 'Acknowledge an interrupted host task only after inspecting its real host state; does not repeat or undo the task.'
            : `Read authenticated remote host ${operation} from the configured host agent.`,
      schema:
        operation === 'run'
          ? z.strictObject({
              id: z
                .string()
                .regex(/^[a-f0-9]{32}$/)
                .default(() => randomBytes(16).toString('hex')),
              taskId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
              definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
            })
          : operation === 'acknowledge'
            ? z.strictObject({ id: z.string().regex(/^[a-f0-9]{32}$/), reviewedHostState: z.literal(true) })
            : operation === 'result'
              ? z.strictObject({ id: z.string().regex(/^[a-f0-9]{32}$/) })
              : z.strictObject({}),
      execute: async (ctx, input) => {
        const expectedEpoch = ctx.store.get<number>('core.featureEpochs', `${ctx.guild.id}:operations`) ?? 0;
        const current = () => {
          if (
            (ctx.store.get<number>('core.featureEpochs', `${ctx.guild.id}:operations`) ?? 0) !==
              expectedEpoch ||
            (ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? []).includes('operations')
          )
            throw new UserError(
              'Host access changed during this request. Inspect the host before retrying any dispatched task.',
            );
        };
        const authorize = async () => {
          current();
          if (!options.operatorIds.includes(ctx.member.id)) await ctx.client.application?.fetch();
          const fresh = await freshContext(ctx);
          assertOperator(fresh, options.operatorIds);
          await assertPermissions(fresh, [P.ManageGuild], [], {});
          registry.assertPolicy(fresh, `host.${operation}`);
          current();
        };
        await authorize();
        const result = await call({ operation, ...input });
        await authorize();
        return result;
      },
    });
}
