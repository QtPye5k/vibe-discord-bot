import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PermissionFlagsBits as P, type Client } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import type { Store } from '../core/store.js';
import { freshContext, resolveChannel } from '../core/permissions.js';
import { sendChannel } from '../discord/actions/shared.js';
import { UserError } from '../core/errors.js';
import { providerHttp, type ProviderTransport } from '../integrations/http.js';

const slug = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/),
  id = z.string().regex(/^\d{17,20}$/);
const eventNames = [
  'guildMemberAdd',
  'guildMemberRemove',
  'channelCreate',
  'channelDelete',
  'roleCreate',
  'roleDelete',
  'guildBanAdd',
  'guildBanRemove',
  'guildScheduledEventCreate',
  'guildScheduledEventUpdate',
  'guildScheduledEventDelete',
  'messageDelete',
] as const;
const notificationSchema = z.strictObject({
  eventId: slug,
  project: slug,
  environment: slug,
  status: z.enum(['started', 'succeeded', 'failed', 'rolled-back']),
  releaseId: slug.optional(),
  url: z
    .string()
    .url()
    .max(1024)
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    })
    .optional(),
});
type Notification = z.infer<typeof notificationSchema>;
interface Route {
  id: string;
  guildId: string;
  authorId: string;
  originChannelId: string;
  channelId: string;
  project: string;
  environment: string;
  version: string;
  enabled: boolean;
}
interface Subscription {
  guildId: string;
  authorId: string;
  originChannelId: string;
  eventNames: (typeof eventNames)[number][];
  version: string;
  enabled: boolean;
}
interface Delivery {
  id: string;
  guildId: string;
  routeId: string;
  version: string;
  state: 'pending' | 'sending' | 'unknown' | 'sent' | 'cancelled' | 'failed';
  attempts: number;
  retryAt: number;
  expiresAt: number;
  notification: Notification;
  nonce: string;
  messageId?: string;
  lastError?: string;
}
interface Outgoing {
  id: string;
  guildId: string;
  subscriptionVersion: string;
  state: 'pending' | 'sending' | 'done' | 'failed' | 'cancelled';
  attempts: number;
  retryAt: number;
  expiresAt: number;
  body: string;
  lastError?: string;
}
export interface ExternalAutomationOptions {
  client: Client;
  store: Store;
  allowedGuildIds?: readonly string[];
  deploymentWebhookSecret?: string;
  outboundUrl?: string;
  outboundKey?: string;
  transport?: ProviderTransport;
}
const key = (guildId: string, value: string) => `${guildId}:${value}`;
function enabled(store: Store, guildId: string) {
  return !(store.get<string[]>('core.disabled', guildId) ?? []).includes('integrations');
}
function policy(ctx: ActionContext, action: string) {
  const rule = ctx.store.get<{ enabled: boolean; roleIds: string[]; channelIds: string[] }>(
    'core.actionPolicies',
    key(ctx.guild.id, action),
  );
  if (
    rule &&
    (!rule.enabled ||
      (rule.roleIds.length && !rule.roleIds.some((role) => ctx.member.roles.cache.has(role))) ||
      (rule.channelIds.length && !rule.channelIds.includes(ctx.channelId)))
  )
    throw new UserError('The current automation action policy denies delivery.');
}
function finish(response: ServerResponse, status: number, body = '') {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}
export function createExternalAutomationService(options: ExternalAutomationOptions) {
  const { client, store } = options;
  let sweeping = false,
    closed = false,
    incomingRequests = 0;
  const activeDeliveries = new Set<string>();
  const incoming = () => Boolean(options.deploymentWebhookSecret?.trim()),
    outgoing = () => Boolean(options.outboundUrl?.trim() && options.outboundKey?.trim());
  let endpoint: URL | undefined;
  if (outgoing()) {
    endpoint = new URL(options.outboundUrl!);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      (endpoint.port && endpoint.port !== '443')
    )
      throw new Error(
        'OUTBOUND_AUTOMATION_URL must be a fixed HTTPS origin on port 443 without credentials or fragment.',
      );
  }
  const http = endpoint ? providerHttp('event-automation', endpoint.origin, options.transport) : undefined;
  const admitted = (guildId: string) =>
    !options.allowedGuildIds?.length || options.allowedGuildIds.includes(guildId);
  async function manager(guildId: string, authorId: string, channelId: string, action: string) {
    if (!admitted(guildId) || !enabled(store, guildId))
      throw new UserError('This server is not admitted for integrations.');
    const guild = await client.guilds.fetch(guildId);
    let ctx: ActionContext = {
      client,
      store,
      guild,
      member: await guild.members.fetch({ user: authorId, force: true }),
      channelId,
    };
    ctx = await freshContext(ctx);
    if (!ctx.member.permissions.has(P.ManageGuild))
      throw new UserError('The configuring server manager no longer has permission.');
    await resolveChannel(ctx, channelId);
    policy(ctx, action);
    return ctx;
  }
  async function incomingAccess(row: Delivery) {
    const route = store.get<Route>('deploy.routes', key(row.guildId, row.routeId));
    if (!route?.enabled || route.version !== row.version)
      throw new UserError('The notification route changed or was removed.');
    const ctx = await manager(
      route.guildId,
      route.authorId,
      route.originChannelId,
      'deployment.notifications.configure',
    );
    const channel = await sendChannel(ctx, route.channelId);
    if (
      store.get<Route>('deploy.routes', key(row.guildId, row.routeId))?.version !== row.version ||
      !enabled(store, row.guildId)
    )
      throw new UserError('The notification policy changed.');
    return channel;
  }
  function content(row: Delivery) {
    const n = row.notification;
    return `Deployment ${n.status}\nProject: ${n.project}\nEnvironment: ${n.environment}${n.releaseId ? `\nRelease: ${n.releaseId}` : ''}${n.url ? `\n${n.url}` : ''}\nEvent: ${n.eventId}`;
  }
  return {
    registerActions(registry: ActionRegistry) {
      const base = {
        category: 'integrations',
        userPermissions: [P.ManageGuild],
        botPermissions: [],
        risk: 'write' as const,
      };
      registry.register({
        ...base,
        id: 'deployment.notifications.configure',
        available: incoming,
        unavailableReason: 'Set DEPLOYMENT_WEBHOOK_SECRET and expose the signed /hooks/deployments route.',
        description:
          'Route signed deployment notifications to a fixed authorized Discord channel, filtered by exact project and environment. Incoming payloads cannot choose a server/channel.',
        schema: z.strictObject({
          id: slug,
          channelId: id,
          project: slug,
          environment: slug,
          enabled: z.boolean().default(true),
        }),
        execute: async (ctx, input) => {
          await sendChannel(ctx, input.channelId);
          if (
            !store.get('deploy.routes', key(ctx.guild.id, input.id)) &&
            store.list('deploy.routes', `${ctx.guild.id}:`).length >= 20
          )
            throw new UserError('Limit: 20 deployment notification routes per server.');
          const row: Route = {
            ...input,
            guildId: ctx.guild.id,
            authorId: ctx.member.id,
            originChannelId: ctx.channelId,
            version: randomBytes(8).toString('hex'),
          };
          store.set('deploy.routes', key(ctx.guild.id, input.id), row);
          return row;
        },
      });
      registry.register({
        ...base,
        id: 'deployment.notifications.list',
        risk: 'read',
        description:
          'List this server’s configured deployment notification routes and recent delivery states. Secrets are excluded.',
        schema: z.strictObject({}),
        execute: (ctx) => ({
          routes: store.list<Route>('deploy.routes', `${ctx.guild.id}:`).map((row) => row.value),
          deliveries: store
            .list<Delivery>('deploy.deliveries', `${ctx.guild.id}:`)
            .slice(-100)
            .map(({ value: row }) => ({
              id: row.id,
              routeId: row.routeId,
              state: row.state,
              attempts: row.attempts,
              messageId: row.messageId,
              lastError: row.lastError,
            })),
        }),
      });
      registry.register({
        ...base,
        id: 'deployment.notifications.remove',
        description: 'Remove a deployment route and invalidate pending notifications for it.',
        schema: z.strictObject({ id: slug }),
        execute: (ctx, input) => ({ removed: store.delete('deploy.routes', key(ctx.guild.id, input.id)) }),
      });
      registry.register({
        ...base,
        id: 'deployment.notifications.resolve',
        risk: 'destructive',
        description:
          'Resolve an interrupted/unknown Discord notification after manual inspection. Retry is explicit and may duplicate a remote message if Discord accepted the earlier send.',
        schema: z.strictObject({
          id: z.string().regex(/^[a-f0-9]{32}$/),
          outcome: z.enum(['delivered', 'retry', 'cancel']),
        }),
        execute: (ctx, input) => {
          const rowKey = key(ctx.guild.id, input.id),
            row = store.get<Delivery>('deploy.deliveries', rowKey);
          if (activeDeliveries.has(rowKey))
            throw new UserError(
              'This notification is still sending; wait for its outcome before reconciling.',
            );
          if (!row || !['unknown', 'sending'].includes(row.state))
            throw new UserError('Only an interrupted or unknown notification can be reconciled.');
          row.state =
            input.outcome === 'delivered' ? 'sent' : input.outcome === 'retry' ? 'pending' : 'cancelled';
          row.retryAt = 0;
          store.set('deploy.deliveries', key(ctx.guild.id, row.id), row);
          return { state: row.state };
        },
      });
      registry.register({
        ...base,
        id: 'automation.external.configure',
        available: outgoing,
        unavailableReason:
          'Set OUTBOUND_AUTOMATION_URL and OUTBOUND_AUTOMATION_KEY to enable the fixed operator endpoint.',
        description:
          'Subscribe this server to selected metadata-only Discord events sent to the operator’s fixed signed HTTPS webhook. No message content, credentials or arbitrary URL input is accepted.',
        schema: z.strictObject({
          events: z.array(z.enum(eventNames)).min(1).max(eventNames.length),
          enabled: z.boolean().default(true),
        }),
        execute: (ctx, input) => {
          const row: Subscription = {
            guildId: ctx.guild.id,
            authorId: ctx.member.id,
            originChannelId: ctx.channelId,
            eventNames: [...new Set(input.events)],
            version: randomBytes(8).toString('hex'),
            enabled: input.enabled,
          };
          store.set('automation.external', ctx.guild.id, row);
          return { ...row, endpointConfigured: true };
        },
      });
      registry.register({
        ...base,
        id: 'automation.external.status',
        risk: 'read',
        description:
          'Inspect the current outbound metadata event subscription and bounded outbox counts without exposing the endpoint secret.',
        schema: z.strictObject({}),
        execute: (ctx) => {
          const counts: Record<string, number> = {};
          for (const row of store.list<Outgoing>('automation.externalOutbox', `${ctx.guild.id}:`))
            counts[row.value.state] = (counts[row.value.state] ?? 0) + 1;
          return {
            configured: outgoing(),
            subscription: store.get('automation.external', ctx.guild.id),
            counts,
            dropped: store.get<number>('automation.outboxDropped', ctx.guild.id) ?? 0,
          };
        },
      });
      registry.register({
        ...base,
        id: 'automation.external.remove',
        description:
          'Disable and remove this server’s outbound event subscription; pending deliveries are cancelled during the next sweep.',
        schema: z.strictObject({}),
        execute: (ctx) => ({ removed: store.delete('automation.external', ctx.guild.id) }),
      });
    },
    /** Parent HTTP router must await this before its 404 fallback. */
    async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
      if ((request.url ?? '').split('?')[0] !== '/hooks/deployments') return false;
      if (!incoming() || closed) {
        finish(response, 503);
        return true;
      }
      if (request.method !== 'POST') {
        finish(response, 405);
        return true;
      }
      const timestamp = request.headers['x-deployment-timestamp'],
        signature = request.headers['x-deployment-signature'];
      if (
        typeof timestamp !== 'string' ||
        !/^\d{10}$/.test(timestamp) ||
        Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
        typeof signature !== 'string' ||
        !/^v1=[a-f0-9]{64}$/.test(signature)
      ) {
        finish(response, 401);
        return true;
      }
      if (incomingRequests >= 16) {
        finish(response, 503);
        request.resume();
        return true;
      }
      incomingRequests++;
      let bytes = 0;
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => request.destroy(), 10000);
      timer.unref();
      try {
        if (Number(request.headers['content-length'] ?? 0) > 65536) {
          finish(response, 413);
          request.resume();
          return true;
        }
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > 65536) {
            finish(response, 413);
            request.destroy();
            return true;
          }
          chunks.push(buffer);
        }
        const raw = Buffer.concat(chunks),
          expected = createHmac('sha256', options.deploymentWebhookSecret!)
            .update(timestamp + '.')
            .update(raw)
            .digest(),
          supplied = Buffer.from(signature.slice(3), 'hex');
        if (!timingSafeEqual(expected, supplied)) {
          finish(response, 401);
          return true;
        }
        const parsed = notificationSchema.safeParse(JSON.parse(raw.toString('utf8')));
        if (!parsed.success) {
          finish(response, 400);
          return true;
        }
        const n = parsed.data,
          digest = createHash('sha256').update(raw).digest('hex'),
          eventKey = createHash('sha256').update(`${n.project}:${n.environment}:${n.eventId}`).digest('hex'),
          prior = store.get<{ digest: string }>('deploy.receipts', eventKey);
        if (prior) {
          finish(response, prior.digest === digest ? 204 : 409);
          return true;
        }
        const routes = store
          .list<Route>('deploy.routes')
          .filter(
            ({ value: row }) =>
              row.enabled &&
              admitted(row.guildId) &&
              enabled(store, row.guildId) &&
              row.project === n.project &&
              row.environment === n.environment,
          );
        if (
          store.list('deploy.receipts').length >= 10000 ||
          routes.some(
            ({ value: route }) =>
              store
                .list<Delivery>('deploy.deliveries', `${route.guildId}:`)
                .filter((row) => ['pending', 'sending', 'unknown'].includes(row.value.state)).length >= 500,
          )
        ) {
          finish(response, 503);
          return true;
        }
        store.transaction(() => {
          store.set('deploy.receipts', eventKey, { digest, expiresAt: Date.now() + 7 * 86400000 });
          for (const { value: route } of routes) {
            const deliveryId = createHash('sha256')
              .update(`${eventKey}:${route.guildId}:${route.id}:${route.version}`)
              .digest('hex')
              .slice(0, 32);
            store.set('deploy.deliveries', key(route.guildId, deliveryId), {
              id: deliveryId,
              guildId: route.guildId,
              routeId: route.id,
              version: route.version,
              state: 'pending',
              attempts: 0,
              retryAt: 0,
              expiresAt: Date.now() + 7 * 86400000,
              notification: n,
              nonce: BigInt('0x' + deliveryId.slice(0, 16)).toString(),
            } satisfies Delivery);
          }
        });
        finish(response, 204);
        return true;
      } catch {
        if (!response.headersSent) finish(response, 400);
        return true;
      } finally {
        clearTimeout(timer);
        incomingRequests--;
      }
    },
    observe(event: string, args: unknown[], now = Date.now()) {
      if (!outgoing() || closed || !eventNames.includes(event as (typeof eventNames)[number])) return;
      const object = (event === 'guildScheduledEventUpdate' ? args[1] : args[0]) as
        | {
            id?: string;
            guildId?: string;
            guild?: { id: string };
            user?: { id: string };
            author?: { id: string };
            channelId?: string;
            type?: number;
            name?: string;
          }
        | undefined;
      if (!object) return;
      const guildId = object.guildId ?? object.guild?.id;
      if (!guildId || !admitted(guildId) || !enabled(store, guildId)) return;
      const subscription = store.get<Subscription>('automation.external', guildId);
      if (!subscription?.enabled || !subscription.eventNames.includes(event as (typeof eventNames)[number]))
        return;
      if (
        store
          .list<Outgoing>('automation.externalOutbox', `${guildId}:`)
          .filter((row) => ['pending', 'sending'].includes(row.value.state)).length >= 500
      ) {
        store.set(
          'automation.outboxDropped',
          guildId,
          (store.get<number>('automation.outboxDropped', guildId) ?? 0) + 1,
        );
        return;
      }
      const eventId = randomBytes(16).toString('hex'),
        body = JSON.stringify({
          version: 1,
          id: eventId,
          event,
          guildId,
          occurredAt: new Date(now).toISOString(),
          resource: {
            id: object.id,
            userId: object.user?.id ?? object.author?.id,
            channelId: object.channelId,
            type: object.type,
          },
        });
      store.set('automation.externalOutbox', key(guildId, eventId), {
        id: eventId,
        guildId,
        subscriptionVersion: subscription.version,
        state: 'pending',
        attempts: 0,
        retryAt: 0,
        expiresAt: now + 7 * 86400000,
        body,
      } satisfies Outgoing);
    },
    async sweep(now = Date.now()) {
      if (sweeping || closed) return;
      sweeping = true;
      const deadline = Date.now() + 20000;
      try {
        for (const namespace of ['deploy.receipts', 'deploy.deliveries', 'automation.externalOutbox'])
          for (const row of store.list<{ expiresAt: number }>(namespace))
            if (row.value.expiresAt <= now) store.delete(namespace, row.key);
        let sent = 0;
        if (incoming())
          for (const { key: rowKey, value: row } of store.list<Delivery>('deploy.deliveries')) {
            if (row.state === 'sending') {
              row.state = 'unknown';
              store.set('deploy.deliveries', rowKey, row);
              continue;
            }
            if (row.state !== 'pending' || row.retryAt > now) continue;
            if (sent++ >= 5 || Date.now() > deadline) break;
            let channel: Awaited<ReturnType<typeof sendChannel>>;
            try {
              channel = await incomingAccess(row);
            } catch {
              row.state = 'cancelled';
              row.lastError =
                'Current route, configuring manager or destination permissions are unavailable.';
              store.set('deploy.deliveries', rowKey, row);
              continue;
            }
            if (closed) break;
            row.state = 'sending';
            row.attempts++;
            store.set('deploy.deliveries', rowKey, row);
            activeDeliveries.add(rowKey);
            try {
              const message = await channel.send({
                content: content(row),
                allowedMentions: { parse: [] },
                nonce: row.nonce,
                enforceNonce: true,
              });
              row.state = 'sent';
              row.messageId = message.id;
            } catch {
              row.state = 'unknown';
              row.lastError =
                'Discord outcome is unknown. Inspect the channel and explicitly reconcile before retrying.';
            } finally {
              activeDeliveries.delete(rowKey);
            }
            store.set('deploy.deliveries', rowKey, row);
          }
        sent = 0;
        if (outgoing())
          for (const { key: rowKey, value: row } of store.list<Outgoing>('automation.externalOutbox')) {
            if (row.state === 'sending') row.state = 'pending';
            if (row.state !== 'pending' || row.retryAt > now) continue;
            if (sent++ >= 5 || Date.now() > deadline) break;
            const subscription = store.get<Subscription>('automation.external', row.guildId);
            const check = async () => {
              if (
                closed ||
                !subscription?.enabled ||
                store.get<Subscription>('automation.external', row.guildId)?.version !==
                  row.subscriptionVersion
              )
                throw new UserError('Subscription changed.');
              await manager(
                row.guildId,
                subscription.authorId,
                subscription.originChannelId,
                'automation.external.configure',
              );
              if (
                store.get<Subscription>('automation.external', row.guildId)?.version !==
                  row.subscriptionVersion ||
                !enabled(store, row.guildId)
              )
                throw new UserError('Subscription changed.');
            };
            try {
              await check();
            } catch {
              row.state = 'cancelled';
              store.set('automation.externalOutbox', rowKey, row);
              continue;
            }
            row.state = 'sending';
            row.attempts++;
            store.set('automation.externalOutbox', rowKey, row);
            try {
              const timestamp = String(Math.floor(Date.now() / 1000)),
                body = Buffer.from(row.body),
                signature = createHmac('sha256', options.outboundKey!)
                  .update(timestamp + '.')
                  .update(body)
                  .digest('hex');
              const response = await http!(
                endpoint!.pathname,
                {
                  method: 'POST',
                  query: Object.fromEntries(endpoint!.searchParams),
                  body,
                  contentType: 'application/json',
                  headers: {
                    authorization: `Bearer ${options.outboundKey!}`,
                    'idempotency-key': row.id,
                    'x-automation-timestamp': timestamp,
                    'x-automation-signature': `v1=${signature}`,
                  },
                  maxBytes: 65536,
                },
                check,
              );
              if (response.status >= 200 && response.status < 300) row.state = 'done';
              else if (response.status === 429 || response.status >= 500) throw new Error('retryable');
              else {
                row.state = 'failed';
                row.lastError = `Endpoint rejected delivery with HTTP ${response.status}.`;
              }
            } catch {
              row.state = row.attempts >= 8 ? 'failed' : 'pending';
              row.retryAt = now + Math.min(3600000, 10000 * 2 ** row.attempts);
              row.lastError =
                'Endpoint delivery failed or was interrupted; retry uses the same idempotency key.';
            }
            store.set('automation.externalOutbox', rowKey, row);
          }
      } finally {
        sweeping = false;
      }
    },
    close() {
      closed = true;
    },
  };
}
