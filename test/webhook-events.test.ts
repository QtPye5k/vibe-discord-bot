import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import {
  createDiscordWebhookHandler,
  validateDiscordSignature,
  WebhookInbox,
  registerWebhookEventActions,
  type DiscordWebhookPayload,
} from '../src/features/webhook-events.js';

const APP = '530000000000000001',
  OTHER_APP = '530000000000000002';
const NOW = Date.parse('2026-10-28T20:00:00Z');
const pair = generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const ping = { version: 1, application_id: APP, type: 0 };
const event = (type = 'APPLICATION_AUTHORIZED'): DiscordWebhookPayload => ({
  version: 1,
  application_id: APP,
  type: 1,
  event: {
    type,
    timestamp: new Date(NOW).toISOString(),
    data: { user: { id: 'private-user' }, guild: { id: 'private-guild' } },
  },
});
function signed(body: string, timestamp = String(Math.floor(NOW / 1000))) {
  return {
    'content-type': 'application/json',
    'x-signature-timestamp': timestamp,
    'x-signature-ed25519': sign(null, Buffer.from(timestamp + body), pair.privateKey).toString('hex'),
  };
}
interface InboxRow {
  payload: DiscordWebhookPayload;
  status: string;
  createdAt: number;
  nextAt: number;
  attempts: number;
  lastError?: string;
}
async function fixture(t: TestContext, options: { key?: string; applicationId?: string } = {}) {
  const store = new Store(':memory:');
  const server = createServer(
    createDiscordWebhookHandler({
      store,
      publicKey: () => (options.key === undefined ? publicKey : options.key),
      applicationId: () => options.applicationId ?? APP,
      now: () => NOW,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
  });
  const send = (
    payload: unknown,
    headers?: Record<string, string>,
    path = '/discord/events',
    method = 'POST',
  ) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return fetch(url + path, {
      method,
      headers: headers ?? signed(body),
      ...(method === 'GET' ? {} : { body }),
    });
  };
  return { store, server, url, send };
}
function enqueue(store: Store, id: string, overrides: Partial<InboxRow> = {}) {
  const row: InboxRow = {
    payload: event(),
    status: 'pending',
    createdAt: NOW,
    nextAt: NOW,
    attempts: 0,
    ...overrides,
  };
  store.set('webhook.inbox', id, row);
  return row;
}

test('Real Ed25519 verification uses exact timestamp plus raw UTF-8 body and rejects normalization/tampering', () => {
  const body = ' { "message" : "hello 世界", "type" : 0 } ';
  const headers = signed(body);
  const stamp = headers['x-signature-timestamp'],
    signature = headers['x-signature-ed25519'];
  assert.equal(validateDiscordSignature(publicKey, signature, stamp, Buffer.from(body), NOW), true);
  assert.equal(
    validateDiscordSignature(publicKey, signature, stamp, Buffer.from(JSON.stringify(JSON.parse(body))), NOW),
    false,
  );
  assert.equal(validateDiscordSignature(publicKey, signature, stamp, Buffer.from(body + 'x'), NOW), false);
  const other = generateKeyPairSync('ed25519')
    .publicKey.export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('hex');
  assert.equal(validateDiscordSignature(other, signature, stamp, Buffer.from(body), NOW), false);
});

test('Malformed keys/signatures, stale timestamps and excessive future timestamps fail closed', () => {
  const body = JSON.stringify(ping);
  const headers = signed(body);
  for (const key of ['', 'bad', 'a'.repeat(63)])
    assert.equal(
      validateDiscordSignature(
        key,
        headers['x-signature-ed25519'],
        headers['x-signature-timestamp'],
        Buffer.from(body),
        NOW,
      ),
      false,
    );
  for (const stamp of [String(NOW / 1000 - 601), String(NOW / 1000 + 601), 'not-a-time']) {
    const signature = signed(body, stamp)['x-signature-ed25519'];
    assert.equal(validateDiscordSignature(publicKey, signature, stamp, Buffer.from(body), NOW), false);
  }
});

test('Signed Discord verification PING receives empty 204 with content type and no persisted event', async (t) => {
  const f = await fixture(t);
  const result = await f.send(ping);
  assert.equal(result.status, 204);
  assert.equal(await result.text(), '');
  assert.equal(result.headers.get('content-type'), 'application/json');
  assert.equal(f.store.list('webhook.inbox').length, 0);
});

test('Webhook endpoint rejects missing/invalid signatures with 401 before accepting any payload', async (t) => {
  const f = await fixture(t);
  const body = JSON.stringify(event());
  for (const headers of [{}, signed(body), { ...signed(body), 'x-signature-ed25519': 'f'.repeat(128) }]) {
    const result = await f.send(headers === undefined ? body : body + ' ', headers);
    assert.equal(result.status, 401);
  }
  assert.equal(f.store.list('webhook.inbox').length, 0);
});

test('Wrong paths/methods, unavailable verification key and mismatched applications are rejected', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send(ping, undefined, '/wrong')).status, 404);
  assert.equal((await f.send(ping, undefined, '/discord/events', 'GET')).status, 405);
  assert.equal((await f.send({ ...ping, application_id: OTHER_APP })).status, 403);
  const noKey = await fixture(t, { key: '' });
  assert.equal((await noKey.send(ping)).status, 503);
});

test('Correctly signed malformed JSON/schema and oversized body fail without persistence', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send('not JSON')).status, 400);
  assert.equal((await f.send({ version: 2, application_id: APP, type: 0 })).status, 400);
  assert.equal(
    (await f.send({ version: 1, application_id: APP, type: 1, event: { type: 'x' } })).status,
    400,
  );
  assert.equal((await f.send('x'.repeat(256 * 1024 + 1))).status, 413);
  assert.equal(f.store.list('webhook.inbox').length, 0);
});

test('Authenticated events persist before 204, deduplicate exact retries and retain private content only in inbox storage', async (t) => {
  const f = await fixture(t);
  const body = JSON.stringify(event());
  assert.equal((await f.send(body)).status, 204);
  assert.equal((await f.send(body)).status, 204);
  const rows = f.store.list<InboxRow>('webhook.inbox');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.value.status, 'pending');
  assert.equal(rows[0]?.value.attempts, 0);
  assert.deepEqual(rows[0]?.value.payload, event());
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  registerWebhookEventActions(registry, ['operator']);
  const action = registry.get('webhook.events.status');
  const status = await action.execute(
    {
      store: f.store,
      guild: { id: 'visible-guild' },
      member: { id: 'operator' },
      client: {},
    } as unknown as ActionContext,
    {},
  );
  assert.ok(!JSON.stringify(status).includes('private-user'));
  assert.ok(!JSON.stringify(status).includes('private-guild'));
  await assert.rejects(
    () =>
      Promise.resolve(
        action.execute(
          {
            store: f.store,
            guild: { id: 'visible-guild' },
            member: { id: 'server-admin' },
            client: {},
          } as unknown as ActionContext,
          {},
        ),
      ),
    /application owner/,
  );
});

test('Durable inbox applies backpressure at 1000 pending events without dropping previously accepted events', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 1000; i++) enqueue(f.store, `existing:${i}`);
  const result = await f.send(event());
  assert.equal(result.status, 503);
  assert.equal(f.store.list('webhook.inbox').length, 1000);
});

test('Inbox delivers persisted events once in a normal run and recovers interrupted processing on reconstruction', async (t) => {
  const f = await fixture(t);
  enqueue(f.store, 'interrupted', { status: 'processing' });
  let delivered = 0;
  const inbox = new WebhookInbox(f.store, async (payload) => {
    assert.equal(payload.type, 1);
    delivered++;
  });
  assert.equal(f.store.get<InboxRow>('webhook.inbox', 'interrupted')?.status, 'pending');
  await inbox.tick(NOW);
  await inbox.tick(NOW);
  assert.equal(delivered, 1);
  assert.equal(f.store.get<InboxRow>('webhook.inbox', 'interrupted')?.status, 'done');
});

test('Inbox transient failures persist exponential backoff and error class without sensitive provider text', async (t) => {
  const f = await fixture(t);
  enqueue(f.store, 'retry');
  let calls = 0;
  const dispatch = async () => {
    calls++;
    if (calls === 1) throw new TypeError('sensitive event content');
  };
  const first = new WebhookInbox(f.store, dispatch);
  await first.tick(NOW);
  let row = f.store.get<InboxRow>('webhook.inbox', 'retry')!;
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.equal(row.lastError, 'TypeError');
  assert.ok(row.nextAt > NOW);
  assert.ok(!JSON.stringify(row).includes('sensitive event content'));
  await first.tick(NOW);
  assert.equal(calls, 1);
  const restarted = new WebhookInbox(f.store, dispatch);
  await restarted.tick(row.nextAt);
  row = f.store.get<InboxRow>('webhook.inbox', 'retry')!;
  assert.equal(row.status, 'done');
  assert.equal(calls, 2);
});

test('Inbox permanently fails after five attempts and processes at most 20 due events per tick', async (t) => {
  const f = await fixture(t);
  enqueue(f.store, 'permanent');
  const inbox = new WebhookInbox(f.store, async () => {
    throw new Error('failure');
  });
  let now = NOW;
  for (let i = 0; i < 5; i++) {
    await inbox.tick(now);
    now = f.store.get<InboxRow>('webhook.inbox', 'permanent')!.nextAt;
  }
  assert.equal(f.store.get<InboxRow>('webhook.inbox', 'permanent')?.status, 'failed');
  for (let i = 0; i < 25; i++) enqueue(f.store, `batch:${i}`);
  let count = 0;
  const batches = new WebhookInbox(f.store, async () => {
    count++;
  });
  await batches.tick(NOW);
  assert.equal(count, 20);
  await batches.tick(NOW);
  assert.equal(count, 25);
});

test('Concurrent tick calls serialize dispatch and old inbox entries expire after three days', async (t) => {
  const f = await fixture(t);
  enqueue(f.store, 'active');
  enqueue(f.store, 'expired', { createdAt: NOW - 4 * 86400000, status: 'done' });
  let release!: () => void,
    started!: () => void,
    calls = 0;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const inbox = new WebhookInbox(f.store, async () => {
    calls++;
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const running = inbox.tick(NOW);
  await entered;
  await inbox.tick(NOW);
  assert.equal(calls, 1);
  release();
  await running;
  assert.equal(f.store.get('webhook.inbox', 'expired'), undefined);
});
