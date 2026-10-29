import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Collection, PermissionsBitField, PermissionFlagsBits as P } from 'discord.js';
import type { Pool } from 'pg';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import {
  createDeploymentService,
  verifyRelease,
  readDeploymentPointer,
  pruneDeploymentBackups,
} from '../src/features/deployment.js';
import { createExternalDatabaseService, validateReadQuery } from '../src/features/external-database.js';
import { createExternalAutomationService } from '../src/features/external-automation.js';
import type { ProviderRequest, ProviderTransport } from '../src/integrations/http.js';
const G = '770000000000000001',
  U = '770000000000000002',
  B = '770000000000000003',
  C = '770000000000000004';
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'discord-approved-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(':memory:');
  t.after(() => store.close());
  const member = {
      id: U,
      user: { id: U, bot: false },
      permissions: new PermissionsBitField(P.Administrator),
      roles: { cache: new Collection() },
    },
    bot = { ...member, id: B, user: { id: B, bot: true } };
  const sent: unknown[] = [];
  const hooks: { send?: () => void; fetch?: () => void } = {};
  const channel = {
    id: C,
    guildId: G,
    type: 0,
    isTextBased: () => true,
    isThread: () => false,
    isSendable: () => true,
    permissionsFor: () => new PermissionsBitField(P.Administrator),
    send: async (input: unknown) => {
      hooks.send?.();
      sent.push(input);
      return { id: String(880000000000000000n + BigInt(sent.length)) };
    },
  };
  const guild = {
    id: G,
    ownerId: U,
    channels: { fetch: async () => channel },
    members: {
      me: bot,
      fetch: async () => {
        hooks.fetch?.();
        return member;
      },
      fetchMe: async () => bot,
    },
  };
  Object.assign(member, { guild });
  Object.assign(bot, { guild });
  const client = { guilds: { fetch: async () => guild }, user: { id: B } },
    ctx = { store, client, guild, member, channelId: C } as unknown as ActionContext,
    registry = new ActionRegistry(500, async (ctx) => ctx);
  const run = async (id: string, input: unknown = {}) => {
    const requested = await registry.request(ctx, id, input);
    const result =
      requested.status === 'confirmation' ? await registry.confirm(ctx, requested.id) : requested;
    assert.equal(result.status, 'completed');
    return result.status === 'completed' ? (result.result as Record<string, unknown>) : {};
  };
  return { directory, store, ctx, registry, run, sent, hooks, member, client: ctx.client };
}
async function release(root: string, id: string, source = 'export const ready=true;') {
  const directory = join(root, id);
  await mkdir(join(directory, 'dist'), { recursive: true });
  await writeFile(join(directory, 'dist/main.js'), source);
  await writeFile(
    join(directory, 'release.json'),
    JSON.stringify({
      version: 1,
      id,
      entry: 'dist/main.js',
      files: { 'dist/main.js': createHash('sha256').update(source).digest('hex') },
      databaseSchemaVersion: 1,
    }),
  );
  return verifyRelease(root, id);
}
test('approved deployment verifies immutable files, snapshots SQLite, activates and rolls back only the exact previous selection', async (t) => {
  const f = await fixture(t),
    releases = join(f.directory, 'releases'),
    active = join(f.directory, 'active.json');
  const first = await release(releases, 'release-one'),
    second = await release(releases, 'release-two', 'export const ready=2;');
  let restarts = 0;
  const service = createDeploymentService({
    releasesDirectory: releases,
    activeFile: active,
    operatorIds: [U],
    canRestart: () => true,
    restart: () => {
      restarts++;
    },
  });
  service.registerActions(f.registry);
  await f.run('deployment.activate', { id: first.id, manifestHash: first.manifestHash });
  await f.run('deployment.activate', { id: second.id, manifestHash: second.manifestHash });
  assert.equal((await readDeploymentPointer(active))!.previous!.id, first.id);
  const result = await f.run('deployment.rollback', { id: first.id, manifestHash: first.manifestHash });
  assert.equal(result.databaseRestored, false);
  assert.equal(restarts, 3);
  const pointer = (await readDeploymentPointer(active))!;
  const backup = await readFile(join(f.directory, 'backups', pointer.backupSnapshot!.file));
  assert.equal(backup.subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal(createHash('sha256').update(backup).digest('hex'), pointer.backupSnapshot!.sha256);
  await assert.rejects(
    () => f.run('deployment.rollback', { id: first.id, manifestHash: first.manifestHash }),
    /exact current previous/,
  );
});
test('deployment rejects hash changes, escaping paths, schema changes and unconfigured host operators', async (t) => {
  const f = await fixture(t),
    root = join(f.directory, 'releases'),
    first = await release(root, 'one');
  await writeFile(first.entry, 'changed');
  await assert.rejects(() => verifyRelease(root, 'one', first.manifestHash), /hash mismatch/);
  const second = await release(root, 'two');
  const manifestPath = join(second.directory, 'release.json'),
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.files = { '../outside.js': '0'.repeat(64), 'dist/main.js': '0'.repeat(64) };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(() => verifyRelease(root, 'two'), /built files/);
  manifest.files = { 'dist/main.js': '0'.repeat(64) };
  manifest.databaseSchemaVersion = 2;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(() => verifyRelease(root, 'two'));
  const service = createDeploymentService({
    releasesDirectory: root,
    activeFile: join(f.directory, 'active.json'),
    operatorIds: [],
    canRestart: () => true,
    restart: () => {},
  });
  service.registerActions(f.registry);
  await assert.rejects(() => f.run('deployment.status'), /host operator/);
});
test('deployment snapshot retention preserves the active snapshot and unrelated operator backups', async (t) => {
  const f = await fixture(t),
    active = join(f.directory, 'active.json'),
    directory = join(f.directory, 'backups');
  await mkdir(directory);
  const selected = 'deployment_1000000000000_000000000000.sqlite';
  for (let index = 0; index < 25; index++)
    await writeFile(join(directory, `deployment_${1000000000000 + index}_000000000000.sqlite`), 'backup');
  await writeFile(join(directory, 'operator-backup.sqlite'), 'keep');
  await writeFile(
    active,
    JSON.stringify({
      version: 1,
      current: { id: 'one', manifestHash: '0'.repeat(64) },
      previous: null,
      generation: 1,
      activatedAt: 0,
      backupSnapshot: { file: selected, sha256: '0'.repeat(64) },
    }),
  );
  await pruneDeploymentBackups(active);
  assert.equal((await readFile(join(directory, selected))).toString(), 'backup');
  assert.equal((await readFile(join(directory, 'operator-backup.sqlite'))).toString(), 'keep');
  await assert.rejects(() => readFile(join(directory, 'deployment_1000000000001_000000000000.sqlite')));
});
test('SQL lexer accepts read-only strings/comments but rejects multi-statements, mutating CTEs and malformed quotes', () => {
  validateReadQuery("/* SELECT */ WITH x AS (SELECT 'delete; update' AS value) SELECT * FROM x -- comment");
  validateReadQuery('SELECT $$drop;$$ AS value');
  for (const sql of [
    'SELECT 1; DROP TABLE x',
    'WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x',
    'SELECT pg_sleep(20)',
    'SELECT * INTO stolen FROM users',
    "SELECT 'unterminated",
    'SELECT /* unclosed',
  ])
    assert.throws(() => validateReadQuery(sql));
});
test('approved PostgreSQL queries bind parameters and apply read-only, deadlines, row caps and typed validation', async (t) => {
  const f = await fixture(t),
    path = join(f.directory, 'queries.json');
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      queries: [
        {
          id: 'lookup',
          description: 'Lookup public account',
          sql: 'SELECT username FROM public_accounts WHERE id=$1',
          parameters: [{ type: 'integer', min: 1, max: 10 }],
          rowLimit: 1,
        },
      ],
    }),
  );
  const calls: { text: string; values?: unknown[] }[] = [];
  let releases = 0;
  const pool = {
    on: () => {},
    end: async () => {},
    connect: async () => ({
      query: async (input: string | { text: string; values?: unknown[] }) => {
        const call = typeof input === 'string' ? { text: input } : input;
        calls.push(call);
        return {
          rows: call.text.startsWith('SELECT CASE')
            ? [{ payload: '{"username":"test"}' }, { payload: '{"username":"next"}' }]
            : [],
        };
      },
      release: () => {
        releases++;
      },
    }),
  } as unknown as Pool;
  const service = createExternalDatabaseService({
    url: 'postgres://configured',
    queriesFile: path,
    createPool: () => pool,
  });
  service.registerActions(f.registry);
  t.after(() => service.close());
  const result = await f.run('database.query', { id: 'lookup', parameters: [3] });
  assert.deepEqual(result.rows, [{ username: 'test' }]);
  assert.equal(result.truncated, true);
  assert.equal(calls[0]!.text, 'BEGIN READ ONLY');
  assert.match(calls[1]!.text, /statement_timeout/);
  assert.deepEqual(calls.find((call) => call.text.startsWith('SELECT CASE'))!.values, [3]);
  assert.equal(releases, 1);
  await assert.rejects(() => f.run('database.query', { id: 'lookup', parameters: [0] }), /approved range/);
  await assert.rejects(
    () => f.run('database.query', { id: 'lookup', parameters: ['1 OR 1=1'] }),
    /must be integer/,
  );
  assert.equal(releases, 1);
});
test('database result is withheld when permissions or approved catalog change during the query and failed transactions roll back', async (t) => {
  const f = await fixture(t),
    path = join(f.directory, 'queries.json');
  const manifest = { version: 1, queries: [{ id: 'read', description: 'Read', sql: 'SELECT 1' }] };
  await writeFile(path, JSON.stringify(manifest));
  let fail = false,
    rollbacks = 0;
  const pool = {
    on: () => {},
    end: async () => {},
    connect: async () => ({
      query: async (input: string | { text: string }) => {
        const sql = typeof input === 'string' ? input : input.text;
        if (sql === 'ROLLBACK') rollbacks++;
        if (sql.startsWith('SELECT CASE')) {
          if (fail) throw new Error('secret connection detail');
          f.member.permissions = new PermissionsBitField(0n);
          return { rows: [{ payload: '{"secret":1}' }] };
        }
        return { rows: [] };
      },
      release: () => {},
    }),
  } as unknown as Pool;
  const service = createExternalDatabaseService({
    url: 'postgres://configured',
    queriesFile: path,
    createPool: () => pool,
  });
  service.registerActions(f.registry);
  t.after(() => service.close());
  await assert.rejects(() => f.run('database.query', { id: 'read' }), /management permission/);
  f.member.permissions = new PermissionsBitField(P.Administrator);
  fail = true;
  await assert.rejects(() => f.run('database.query', { id: 'read' }), /failed or timed out/);
  assert.equal(rollbacks, 1);
});
async function endpoint(t: TestContext, service: ReturnType<typeof createExternalAutomationService>) {
  const server = createServer((req, res) => {
    void service.handleHttp(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/hooks/deployments`;
}
function signed(body: string, secret = 'fixture-secret', timestamp = String(Math.floor(Date.now() / 1000))) {
  return {
    'x-deployment-timestamp': timestamp,
    'x-deployment-signature': `v1=${createHmac('sha256', secret)
      .update(timestamp + '.')
      .update(body)
      .digest('hex')}`,
  };
}
test('signed deployment endpoint rejects forged/stale events, deduplicates exact events and routes without caller-selected destination', async (t) => {
  const f = await fixture(t),
    service = createExternalAutomationService({
      client: f.client,
      store: f.store,
      deploymentWebhookSecret: 'fixture-secret',
    });
  service.registerActions(f.registry);
  const url = await endpoint(t, service);
  await f.run('deployment.notifications.configure', {
    id: 'site',
    channelId: C,
    project: 'web',
    environment: 'production',
  });
  const body = JSON.stringify({
    eventId: 'build-1',
    project: 'web',
    environment: 'production',
    status: 'succeeded',
    releaseId: 'r1',
  });
  assert.equal((await fetch(url, { method: 'POST', headers: signed(body, 'wrong'), body })).status, 401);
  assert.equal(
    (await fetch(url, { method: 'POST', headers: signed(body, 'fixture-secret', '1000000000'), body }))
      .status,
    401,
  );
  assert.equal((await fetch(url, { method: 'POST', headers: signed(body), body })).status, 204);
  assert.equal((await fetch(url, { method: 'POST', headers: signed(body), body })).status, 204);
  assert.equal(f.store.list('deploy.deliveries').length, 1);
  await service.sweep();
  assert.equal(f.sent.length, 1);
  await service.sweep();
  assert.equal(f.sent.length, 1);
  assert.match(String((f.sent[0] as { content: string }).content), /Deployment succeeded/);
  const changed = body.replace('succeeded', 'failed');
  assert.equal((await fetch(url, { method: 'POST', headers: signed(changed), body: changed })).status, 409);
});
test('unknown notification sends never blindly retry and changed route or manager permissions cancel queued sends', async (t) => {
  const f = await fixture(t),
    service = createExternalAutomationService({
      client: f.client,
      store: f.store,
      deploymentWebhookSecret: 'fixture-secret',
    });
  service.registerActions(f.registry);
  const url = await endpoint(t, service);
  await f.run('deployment.notifications.configure', {
    id: 'site',
    channelId: C,
    project: 'web',
    environment: 'test',
  });
  const post = async (eventId: string) => {
    const body = JSON.stringify({ eventId, project: 'web', environment: 'test', status: 'started' });
    return fetch(url, { method: 'POST', headers: signed(body), body });
  };
  await post('one');
  f.hooks.send = () => {
    throw new Error('socket lost');
  };
  await service.sweep();
  assert.equal(f.store.list<{ state: string }>('deploy.deliveries')[0]!.value.state, 'unknown');
  await service.sweep();
  assert.equal(f.store.list<{ attempts: number }>('deploy.deliveries')[0]!.value.attempts, 1);
  f.hooks.send = undefined;
  await post('two');
  f.member.permissions = new PermissionsBitField(0n);
  await service.sweep();
  assert.equal(f.sent.length, 0);
  assert.ok(
    f.store.list<{ state: string }>('deploy.deliveries').some((row) => row.value.state === 'cancelled'),
  );
});
test('outgoing metadata outbox is signed, fixed-target, consent-policy checked after DNS and retry-stable by event ID', async (t) => {
  const f = await fixture(t),
    requests: ProviderRequest[] = [];
  let status = 503;
  const transport: ProviderTransport = {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    connect: async (request) => {
      requests.push(request);
      return { status, headers: {}, body: Buffer.alloc(0) };
    },
  };
  const service = createExternalAutomationService({
    client: f.client,
    store: f.store,
    outboundUrl: 'https://events.example.com/hooks/discord?source=bot',
    outboundKey: 'fixture-key',
    transport,
  });
  service.registerActions(f.registry);
  await f.run('automation.external.configure', { events: ['messageDelete'] });
  service.observe('messageDelete', [
    { id: '880000000000000001', guildId: G, channelId: C, author: { id: U }, content: 'NEVER EXPORTED' },
  ]);
  await service.sweep();
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.url.pathname, '/hooks/discord');
  assert.equal(request.url.searchParams.get('source'), 'bot');
  assert.equal(request.address, '8.8.8.8');
  assert.doesNotMatch(request.body!.toString(), /NEVER EXPORTED/);
  const timestamp = request.headers['x-automation-timestamp'];
  assert.equal(
    request.headers['x-automation-signature'],
    `v1=${createHmac('sha256', 'fixture-key')
      .update(timestamp + '.')
      .update(request.body!)
      .digest('hex')}`,
  );
  status = 204;
  await service.sweep(Date.now() + 60000);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.headers['idempotency-key'], request.headers['idempotency-key']);
  assert.equal(f.store.list<{ state: string }>('automation.externalOutbox')[0]!.value.state, 'done');
});
test('outgoing webhook authorization withdrawal during DNS prevents the network write', async (t) => {
  const f = await fixture(t);
  let writes = 0;
  const transport: ProviderTransport = {
    resolve: async () => {
      f.member.permissions = new PermissionsBitField(0n);
      return [{ address: '8.8.8.8', family: 4 }];
    },
    connect: async () => {
      writes++;
      return { status: 204, headers: {}, body: Buffer.alloc(0) };
    },
  };
  const service = createExternalAutomationService({
    client: f.client,
    store: f.store,
    outboundUrl: 'https://events.example.com/hook',
    outboundKey: 'fixture',
    transport,
  });
  service.registerActions(f.registry);
  await f.run('automation.external.configure', { events: ['roleDelete'] });
  service.observe('roleDelete', [{ id: '880000000000000001', guild: { id: G } }]);
  await service.sweep();
  assert.equal(writes, 0);
});
test('blank optional service settings fail closed without database pools or HTTP listeners', async (t) => {
  const f = await fixture(t);
  let pools = 0;
  const database = createExternalDatabaseService({
    createPool: () => {
      pools++;
      throw new Error('unexpected');
    },
  });
  database.registerActions(f.registry);
  createDeploymentService({ operatorIds: [U] }).registerActions(f.registry);
  const service = createExternalAutomationService({ client: f.client, store: f.store });
  service.registerActions(f.registry);
  const attempts: [string, unknown][] = [
    ['database.query', { id: 'lookup' }],
    ['deployment.activate', { id: 'release', manifestHash: '0'.repeat(64) }],
    ['automation.external.configure', { events: ['roleDelete'] }],
    ['deployment.notifications.configure', { id: 'site', channelId: C, project: 'web', environment: 'test' }],
  ];
  for (const [action, input] of attempts)
    await assert.rejects(() => f.run(action, input), /Set |configure|unavailable|disabled|requires/i);
  assert.equal(pools, 0);
  const url = await endpoint(t, service);
  assert.equal((await fetch(url, { method: 'POST' })).status, 503);
});
