import { createHash, createPublicKey, verify } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Store } from '../core/store.js';
import type { ActionRegistry } from '../core/registry.js';
import { PermissionFlagsBits as P } from 'discord.js';
import { assertOperator } from '../core/operator.js';

const payloadSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(1), application_id: z.string().regex(/^\d{17,20}$/), type: z.literal(0) }),
  z.object({
    version: z.literal(1),
    application_id: z.string().regex(/^\d{17,20}$/),
    type: z.literal(1),
    event: z.object({
      type: z.string().min(1).max(100),
      timestamp: z.string().max(60),
      data: z.unknown().optional(),
    }),
  }),
]);
export type DiscordWebhookPayload = z.infer<typeof payloadSchema>;
interface InboxRow {
  payload: DiscordWebhookPayload;
  status: 'pending' | 'processing' | 'done' | 'failed';
  createdAt: number;
  nextAt: number;
  attempts: number;
  lastError?: string;
}
export interface WebhookOptions {
  store: Store;
  publicKey: () => string | undefined;
  applicationId?: () => string | undefined;
  now?: () => number;
}
function finish(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end();
}
async function rawBody(request: IncomingMessage): Promise<Buffer> {
  const limit = 256 * 1024;
  if (Number(request.headers['content-length'] ?? 0) > limit) throw new RangeError('body');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += data.length;
    if (length > limit) throw new RangeError('body');
    chunks.push(data);
  }
  return Buffer.concat(chunks, length);
}
export function validateDiscordSignature(
  publicKey: string,
  signature: string,
  timestamp: string,
  body: Buffer,
  now = Date.now(),
): boolean {
  if (
    !/^[a-fA-F0-9]{64}$/.test(publicKey) ||
    !/^[a-fA-F0-9]{128}$/.test(signature) ||
    !/^\d{10,11}$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 600
  )
    return false;
  try {
    const key = createPublicKey({
      format: 'der',
      type: 'spki',
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'hex')]),
    });
    return verify(null, Buffer.concat([Buffer.from(timestamp), body]), key, Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}
export function createDiscordWebhookHandler(options: WebhookOptions): RequestListener {
  let active = 0;
  return (request, response) => {
    if (request.url !== '/discord/events') {
      finish(response, 404);
      return;
    }
    if (request.method !== 'POST') {
      finish(response, 405);
      return;
    }
    if (active >= 32) {
      finish(response, 503);
      return;
    }
    const key = options.publicKey();
    if (!key) {
      finish(response, 503);
      return;
    }
    const signature = request.headers['x-signature-ed25519'],
      timestamp = request.headers['x-signature-timestamp'];
    if (typeof signature !== 'string' || typeof timestamp !== 'string') {
      finish(response, 401);
      return;
    }
    active++;
    const deadline = setTimeout(() => {
      if (!response.writableEnded) finish(response, 408);
      request.destroy();
    }, 2500);
    deadline.unref();
    void (async () => {
      let body: Buffer;
      try {
        body = await rawBody(request);
      } catch (error) {
        if (!response.writableEnded) finish(response, error instanceof RangeError ? 413 : 400);
        return;
      }
      const now = options.now?.() ?? Date.now();
      if (!validateDiscordSignature(key, signature, timestamp, body, now)) {
        finish(response, 401);
        return;
      }
      let payload: DiscordWebhookPayload;
      try {
        payload = payloadSchema.parse(JSON.parse(body.toString('utf8')));
      } catch {
        finish(response, 400);
        return;
      }
      const appId = options.applicationId?.();
      if (appId && payload.application_id !== appId) {
        finish(response, 403);
        return;
      }
      if (payload.type === 0) {
        finish(response, 204);
        return;
      }
      const id = `${payload.application_id}:${createHash('sha256').update(body).digest('hex')}`;
      if (options.store.get('webhook.inbox', id)) {
        finish(response, 204);
        return;
      }
      const pending = Number(
        options.store.db
          .prepare(
            "SELECT count(*) AS n FROM kv WHERE namespace='webhook.inbox' AND json_extract(value,'$.status') IN ('pending','processing')",
          )
          .get()?.n ?? 0,
      );
      if (pending >= 1000) {
        finish(response, 503);
        return;
      }
      options.store.set('webhook.inbox', id, {
        payload,
        status: 'pending',
        createdAt: now,
        nextAt: now,
        attempts: 0,
      } satisfies InboxRow);
      finish(response, 204);
    })()
      .catch(() => {
        if (!response.writableEnded) finish(response, 500);
      })
      .finally(() => {
        clearTimeout(deadline);
        active--;
      });
  };
}
export class WebhookInbox {
  private running = false;
  constructor(
    private readonly store: Store,
    private readonly dispatch: (payload: DiscordWebhookPayload) => Promise<void>,
  ) {
    store.db
      .prepare(
        "UPDATE kv SET value=json_set(value,'$.status','pending') WHERE namespace='webhook.inbox' AND json_extract(value,'$.status')='processing'",
      )
      .run();
  }
  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.store.db
        .prepare("DELETE FROM kv WHERE namespace='webhook.inbox' AND json_extract(value,'$.createdAt')<?")
        .run(now - 3 * 86400000);
      // Bound retained completed payloads as well as pending work; never load the whole inbox into RAM.
      this.store.db.exec(
        "DELETE FROM kv WHERE namespace='webhook.inbox' AND key IN (SELECT key FROM kv WHERE namespace='webhook.inbox' AND json_extract(value,'$.status') IN ('done','failed') ORDER BY updated_at DESC,key DESC LIMIT -1 OFFSET 5000)",
      );
      const rows = this.store.db
        .prepare(
          "SELECT key,value FROM kv WHERE namespace='webhook.inbox' AND json_extract(value,'$.status')='pending' AND json_extract(value,'$.nextAt')<=? ORDER BY json_extract(value,'$.nextAt'),key LIMIT 20",
        )
        .all(now)
        .map((row) => ({ key: String(row.key), value: JSON.parse(String(row.value)) as InboxRow }));
      for (const row of rows) {
        const value = { ...row.value, status: 'processing' as const, attempts: row.value.attempts + 1 };
        this.store.set('webhook.inbox', row.key, value);
        try {
          await this.dispatch(value.payload);
          this.store.set('webhook.inbox', row.key, { ...value, status: 'done' });
        } catch (error) {
          this.store.set('webhook.inbox', row.key, {
            ...value,
            status: value.attempts >= 5 ? 'failed' : 'pending',
            nextAt: now + Math.min(600000, 30000 * 2 ** value.attempts),
            lastError: error instanceof Error ? error.name : 'Error',
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
export function registerWebhookEventActions(
  registry: ActionRegistry,
  operatorIds: readonly string[] = [],
): void {
  registry.register({
    id: 'webhook.events.status',
    description: 'Read signed event inbox metadata without revealing event contents.',
    category: 'webhooks',
    schema: z.strictObject({}),
    userPermissions: [P.ManageGuild],
    botPermissions: [],
    risk: 'read',
    execute: async (ctx) => {
      await assertOperator(ctx, operatorIds);
      const counts: Record<string, number> = { pending: 0, processing: 0, done: 0, failed: 0 };
      // Event contents are application-wide and can contain private data from other installations.
      for (const row of ctx.store.db
        .prepare(
          "SELECT json_extract(value,'$.status') AS status,count(*) AS n FROM kv WHERE namespace='webhook.inbox' GROUP BY json_extract(value,'$.status')",
        )
        .all())
        counts[String(row.status)] = Number(row.n);
      return {
        endpointPath: '/discord/events',
        ...counts,
        delivery:
          'Durable bounded inbox; retries may repeat downstream side effects after an ambiguous failure.',
      };
    },
  });
}
