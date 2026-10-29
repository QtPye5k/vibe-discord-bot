import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { ChannelType, PermissionFlagsBits as P, PermissionsBitField, type Client } from 'discord.js';
import { z } from 'zod';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import {
  registerOperationActions,
  loadOperationManifest,
  operationDefinitionHash,
  operationEnvironment,
  sweepOperationTasks,
  drainOperations,
  type OperationTask,
  OPERATION_LIMITS,
} from '../src/features/operations.js';
const G = '800000000000000001',
  A = '800000000000000002',
  B = '800000000000000003',
  C = '800000000000000004',
  U = '800000000000000005',
  OTHER = '800000000000000006';
const RUNS = 'operations.runs',
  SCHEDULES = 'operations.schedules';
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'discord-fixed-operations-'));
  const store = new Store(':memory:');
  t.after(async () => {
    await drainOperations(store);
    store.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('discord-fixed-operations-'));
    await rm(target, { recursive: true, force: true });
  });
  const manifestPath = join(directory, 'tasks.json');
  const controls = { fetch: async () => {} };
  const actor = {
      id: A,
      guild: { id: G },
      permissions: new PermissionsBitField(P.Administrator),
      roles: { cache: new Map() },
    },
    bot = { id: B, permissions: new PermissionsBitField(P.Administrator) },
    user = { ...actor, id: U };
  const channel = {
    id: C,
    guildId: G,
    type: ChannelType.GuildText,
    isThread: () => false,
    permissionsFor: () => new PermissionsBitField(P.Administrator),
  };
  const guild = {
    id: G,
    members: {
      me: bot,
      fetch: async (options: string | { user: string }) =>
        (typeof options === 'string' ? options : options.user) === U ? user : actor,
      fetchMe: async () => bot,
    },
    channels: {
      fetch: async () => {
        await controls.fetch();
        return channel;
      },
    },
  };
  const client = {
    application: { owner: { id: A } },
    guilds: { fetch: async () => guild },
  } as unknown as Client;
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  registerOperationActions(registry, [], manifestPath);
  const context = (id = A) =>
    ({ client, store, guild, member: id === A ? actor : user, channelId: C }) as unknown as ActionContext;
  const execute = async (name: string, input: unknown = {}, id = A) => {
    const action = registry.get(name);
    return action.execute(context(id), action.schema.parse(input));
  };
  const task = (id = 'version', args = ['--version'], timeoutSeconds = 5): OperationTask => ({
    id,
    description: 'Fixed offline test',
    executable: process.execPath,
    arguments: args,
    cwd: directory,
    timeoutSeconds,
    retrySafe: false,
  });
  const manifest = async (tasks: OperationTask[]) =>
    writeFile(manifestPath, JSON.stringify({ version: 1, tasks }));
  await manifest([task()]);
  const run = async (value = task()) =>
    execute('operation.run', { taskId: value.id, definitionHash: operationDefinitionHash(value) });
  const schedule = async (value = task()) =>
    execute('operation.schedule.set', {
      id: 'scheduled',
      taskId: value.id,
      definitionHash: operationDefinitionHash(value),
      cron: '0 0 * * *',
    });
  const due = () => {
    const row = store.get<Record<string, unknown>>(SCHEDULES, `${G}:scheduled`)!;
    row.nextAt = Date.now() - 1000;
    store.set(SCHEDULES, `${G}:scheduled`, row);
  };
  return {
    directory,
    manifestPath,
    store,
    client,
    registry,
    context,
    execute,
    task,
    manifest,
    run,
    schedule,
    due,
    controls,
  };
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timed out waiting for local test process');
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
test('fixed-task definitions hash exact normalized fields and reject invalid local manifests', async (t) => {
  const f = await fixture(t),
    task = f.task();
  const loaded = await loadOperationManifest(f.manifestPath);
  assert.equal(loaded[0]!.definitionHash, operationDefinitionHash(task));
  assert.notEqual(operationDefinitionHash({ ...task, arguments: ['--help'] }), loaded[0]!.definitionHash);
  await writeFile(f.manifestPath, 'x'.repeat(65537));
  await assert.rejects(loadOperationManifest(f.manifestPath), /64 KiB/);
  await writeFile(f.manifestPath, '{oops');
  await assert.rejects(loadOperationManifest(f.manifestPath), /valid JSON/);
  await f.manifest([task, task]);
  await assert.rejects(loadOperationManifest(f.manifestPath), /duplicate/);
  await f.manifest([{ ...task, executable: 'relative-node' }]);
  await assert.rejects(loadOperationManifest(f.manifestPath), /paths/);
  await f.manifest([{ ...task, timeoutSeconds: 61 }]);
  await assert.rejects(loadOperationManifest(f.manifestPath), /bounds/);
});
test('operation environment excludes credentials and interpreter startup hooks', () => {
  const result = operationEnvironment({
    PATH: 'bin',
    SystemRoot: 'C:\\Windows',
    OPENAI_API_KEY: 'placeholder',
    DISCORD_TOKEN: 'placeholder',
    NODE_OPTIONS: '--require injected',
    PYTHONPATH: 'injected',
    TEST_SECRET: 'placeholder',
    TEMP: 'tmp',
  });
  assert.deepEqual(result, { PATH: 'bin', SystemRoot: 'C:\\Windows', TEMP: 'tmp' });
});
test('all operations are owner gated and fixed run schema has no user arguments or path override', async (t) => {
  const f = await fixture(t);
  for (const action of f.registry.list()) assert.doesNotThrow(() => z.toJSONSchema(action.schema));
  await assert.rejects(f.execute('operation.tasks', {}, U), /application owner/);
  await assert.rejects(f.run({ ...f.task(), description: 'changed' }), /definition changed/);
  assert.throws(() =>
    f.registry.get('operation.run').schema.parse({
      taskId: 'version',
      definitionHash: operationDefinitionHash(f.task()),
      arguments: ['--anything'],
    }),
  );
  const pending = await f.registry.request(f.context(), 'operation.run', {
    taskId: 'version',
    definitionHash: operationDefinitionHash(f.task()),
  });
  assert.equal(pending.status, 'confirmation');
  assert.equal(f.store.list(RUNS).length, 0);
  await assert.rejects(
    f.execute('operation.run', { taskId: 'version', definitionHash: operationDefinitionHash(f.task()) }, U),
    /application owner/,
  );
});
test('an actual approved absolute Node executable runs without shell and records a successful bounded result', async (t) => {
  const f = await fixture(t);
  const result = (await f.run()) as { state: string; stdout: string; exitCode: number; id: string };
  assert.equal(result.state, 'success');
  assert.match(result.stdout, /^v24\./);
  assert.equal(result.exitCode, 0);
  assert.ok(f.store.get(RUNS, `${G}:${result.id}`));
});
test('child receives no bot credentials or arbitrary parent environment', async (t) => {
  const f = await fixture(t),
    script = join(f.directory, 'environment.mjs');
  await writeFile(
    script,
    "process.stdout.write(JSON.stringify({openai:'OPENAI_API_KEY'in process.env,discord:'DISCORD_TOKEN'in process.env,startup:'NODE_OPTIONS'in process.env,stdin:process.stdin.isTTY===true}));",
  );
  const task = f.task('environment', [script]);
  await f.manifest([task]);
  const result = (await f.run(task)) as { stdout: string };
  assert.deepEqual(JSON.parse(result.stdout), {
    openai: false,
    discord: false,
    startup: false,
    stdin: false,
  });
});
test('returned subprocess output is redacted and ANSI/control sequences are removed', async (t) => {
  const f = await fixture(t),
    script = join(f.directory, 'output.mjs'),
    secret = 'example_operation_secret_123456789';
  const previous = process.env.TEST_OPERATION_SECRET;
  process.env.TEST_OPERATION_SECRET = secret;
  t.after(() => {
    if (previous === undefined) delete process.env.TEST_OPERATION_SECRET;
    else process.env.TEST_OPERATION_SECRET = previous;
  });
  await writeFile(
    script,
    `process.stdout.write(${JSON.stringify('\u001b[31m' + secret + ' sk-proj-abcdefghijklmnopqrstuv0123456789\u001b[0m\u0000')});`,
  );
  const task = f.task('output', [script]);
  await f.manifest([task]);
  const result = (await f.run(task)) as { stdout: string };
  assert.equal(result.stdout.includes(secret), false);
  assert.equal(result.stdout.includes('sk-proj-'), false);
  assert.equal(result.stdout.includes('\u001b'), false);
  assert.match(result.stdout, /REDACTED/);
});
test('process output and deadlines terminate bounded children without automatic retries', async (t) => {
  const f = await fixture(t),
    large = join(f.directory, 'large.mjs'),
    slow = join(f.directory, 'slow.mjs');
  await writeFile(large, "process.stdout.write('x'.repeat(200000));");
  await writeFile(slow, 'setInterval(()=>{},1000);');
  const largeTask = f.task('large', [large]),
    slowTask = f.task('slow', [slow], 1);
  await f.manifest([largeTask, slowTask]);
  const output = (await f.run(largeTask)) as { state: string; stdout: string; stderr: string };
  assert.equal(output.state, 'output-limit');
  assert.ok(
    Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) <= OPERATION_LIMITS.outputBytes,
  );
  const timeout = (await f.run(slowTask)) as { state: string };
  assert.equal(timeout.state, 'timeout');
  assert.equal(f.store.list(RUNS).length, 2);
});
test('manifest edits during awaited authorization prevent stale approved task execution', async (t) => {
  const f = await fixture(t);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    entered = new Promise<void>((r) => {
      started = r;
    });
  f.controls.fetch = async () => {
    started();
    await gate;
  };
  const running = f.run();
  await entered;
  await f.manifest([{ ...f.task(), arguments: ['--help'] }]);
  release();
  await assert.rejects(running, /changed during authorization/);
  assert.equal(f.store.list(RUNS).length, 0);
});
test('interrupted persisted runs become unknown and block repetition until explicit host acknowledgement', async (t) => {
  const f = await fixture(t),
    unknown = '1234567890abcdef';
  f.store.set(RUNS, `${G}:${unknown}`, {
    id: unknown,
    guildId: G,
    userId: A,
    taskId: 'version',
    definitionHash: operationDefinitionHash(f.task()),
    startedAt: Date.now() - 1000,
    state: 'running',
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
  });
  const history = (await f.execute('operation.history')) as { state: string }[];
  assert.equal(history[0]!.state, 'unknown');
  await assert.rejects(f.run(), /unknown previous outcome/);
  await f.execute('operation.run.acknowledge', { runId: unknown, reviewedHostState: true });
  const result = (await f.run()) as { state: string };
  assert.equal(result.state, 'success');
});
test('two global process slots bound concurrency and shutdown drains accepted work', async (t) => {
  const f = await fixture(t),
    script = join(f.directory, 'wait.mjs');
  await writeFile(script, "setTimeout(()=>process.stdout.write('done'),300);");
  const task = f.task('wait', [script]);
  await f.manifest([task]);
  const first = f.run(task),
    second = f.run(task);
  await until(
    () => f.store.list<{ state: string }>(RUNS).filter((row) => row.value.state === 'running').length === 2,
  );
  await assert.rejects(f.run(task), /slots are busy/);
  await drainOperations(f.store);
  assert.equal(((await first) as { state: string }).state, 'success');
  assert.equal(((await second) as { state: string }).state, 'success');
  await assert.rejects(f.run(task), /shutting down/);
});
test('scheduled fixed tasks run only for allowed guilds and advance to future UTC occurrence on success', async (t) => {
  const f = await fixture(t);
  await f.schedule();
  f.due();
  const now = Date.now();
  await sweepOperationTasks(f.client, f.store, [], f.manifestPath, now, [OTHER]);
  assert.equal(f.store.list(RUNS).length, 0);
  f.store.set('core.disabled', G, ['operations']);
  await sweepOperationTasks(f.client, f.store, [], f.manifestPath, now);
  assert.equal(f.store.list(RUNS).length, 0);
  f.store.set('core.disabled', G, []);
  await sweepOperationTasks(f.client, f.store, [], f.manifestPath, now);
  const schedule = f.store.get<{ nextAt: number; enabled: boolean; lastRunId: string }>(
    SCHEDULES,
    `${G}:scheduled`,
  )!;
  assert.equal(schedule.enabled, true);
  assert.ok(schedule.nextAt > now);
  assert.ok(schedule.lastRunId);
  assert.equal(f.store.list(RUNS).length, 1);
});
test('failed scheduled processes pause without automatic retries', async (t) => {
  const f = await fixture(t),
    script = join(f.directory, 'fail.mjs');
  await writeFile(script, 'process.exitCode=4;');
  const task = f.task('fail', [script]);
  await f.manifest([task]);
  await f.schedule(task);
  f.due();
  await sweepOperationTasks(f.client, f.store, [], f.manifestPath);
  await sweepOperationTasks(f.client, f.store, [], f.manifestPath, Date.now() + 86400000);
  assert.equal(f.store.list(RUNS).length, 1);
  const schedule = f.store.get<{ enabled: boolean; lastError: string }>(SCHEDULES, `${G}:scheduled`)!;
  assert.equal(schedule.enabled, false);
  assert.equal(schedule.lastError, 'failed');
});
test('scheduled cancellation during authorization cannot start or resurrect task', async (t) => {
  const f = await fixture(t);
  await f.schedule();
  f.due();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    entered = new Promise<void>((r) => {
      started = r;
    });
  f.controls.fetch = async () => {
    started();
    await gate;
  };
  const running = sweepOperationTasks(f.client, f.store, [], f.manifestPath);
  await entered;
  await f.execute('operation.schedule.remove', { id: 'scheduled' });
  release();
  await running;
  assert.equal(f.store.list(RUNS).length, 0);
  assert.equal(f.store.list(SCHEDULES).length, 0);
});
test('recovered scheduled run pauses its policy and requires host acknowledgement before replacement', async (t) => {
  const f = await fixture(t);
  await f.schedule();
  const schedule = f.store.get<{ version: string }>(SCHEDULES, `${G}:scheduled`)!;
  const unknown = 'abcdef1234567890';
  f.store.set(RUNS, `${G}:${unknown}`, {
    id: unknown,
    guildId: G,
    userId: A,
    taskId: 'version',
    definitionHash: operationDefinitionHash(f.task()),
    startedAt: Date.now() - 1000,
    state: 'running',
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    scheduleId: 'scheduled',
    scheduleVersion: schedule.version,
  });
  const list = (await f.execute('operation.schedule.list')) as { enabled: boolean; blockedByRunId: string }[];
  assert.equal(list[0]!.enabled, false);
  assert.equal(list[0]!.blockedByRunId, unknown);
  await assert.rejects(f.schedule(), /unknown/);
  await f.execute('operation.run.acknowledge', { runId: unknown, reviewedHostState: true });
  await f.schedule();
  assert.equal(f.store.get<{ enabled: boolean }>(SCHEDULES, `${G}:scheduled`)!.enabled, true);
});
