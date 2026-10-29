import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat, realpath } from 'node:fs/promises';
import { isAbsolute, extname } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { Client } from 'discord.js';
import { z } from 'zod';
import type { ActionRegistry, ActionPolicy } from '../core/registry.js';
import type { ActionContext } from '../core/types.js';
import type { Store } from '../core/store.js';
import { assertOperator } from '../core/operator.js';
import { freshContext, resolveChannel } from '../core/permissions.js';
import { redact } from '../core/logger.js';
import { UserError } from '../core/errors.js';
import { parseCron, nextCron } from './automation.js';

export const OPERATION_LIMITS = Object.freeze({
  manifestBytes: 65536,
  tasks: 20,
  concurrency: 2,
  outputBytes: 65536,
  timeoutSeconds: 60,
  runsPerGuild: 100,
  runsTotal: 1000,
  schedulesPerGuild: 10,
});
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  hash = z.string().regex(/^[a-f0-9]{64}$/),
  runId = z.string().regex(/^[a-f0-9]{16}$/);
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => isAbsolute(value) && !value.startsWith('\\\\') && !value.includes('\0'),
    'Use an absolute local filesystem path.',
  );
const taskSchema = z.strictObject({
  id,
  description: z.string().min(1).max(300),
  executable: absolute,
  arguments: z
    .array(
      z
        .string()
        .max(4096)
        .refine((value) => !value.includes('\0')),
    )
    .max(50),
  cwd: absolute,
  timeoutSeconds: z.number().int().min(1).max(60),
  retrySafe: z.boolean().default(false),
});
const manifestSchema = z.strictObject({
  version: z.literal(1),
  tasks: z
    .array(taskSchema)
    .max(20)
    .refine(
      (tasks) => new Set(tasks.map((task) => task.id)).size === tasks.length,
      'Task IDs must be unique.',
    ),
});
export type OperationTask = z.infer<typeof taskSchema>;
interface Definition extends OperationTask {
  definitionHash: string;
}
type RunState =
  'running' | 'success' | 'failed' | 'timeout' | 'output-limit' | 'spawn-error' | 'unknown' | 'acknowledged';
interface Run {
  id: string;
  guildId: string;
  userId: string;
  taskId: string;
  definitionHash: string;
  startedAt: number;
  finishedAt?: number;
  state: RunState;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  scheduleId?: string;
  scheduleVersion?: string;
}
interface Schedule {
  id: string;
  guildId: string;
  authorId: string;
  channelId: string;
  taskId: string;
  definitionHash: string;
  cron: string;
  version: string;
  nextAt: number;
  enabled: boolean;
  inFlightRunId?: string;
  blockedByRunId?: string;
  lastRunId?: string;
  lastError?: string;
}
const runsNamespace = 'operations.runs',
  schedulesNamespace = 'operations.schedules';
const key = (guildId: string, value: string) => `${guildId}:${value}`;
const paused = (store: Store, guildId: string) =>
  (store.get<string[]>('core.disabled', guildId) ?? []).includes('operations');
const activeIds = new WeakMap<Store, Set<string>>(),
  pending = new WeakMap<Store, Set<Promise<unknown>>>(),
  closing = new WeakSet<Store>();
let active = 0;
export function operationDefinitionHash(raw: OperationTask): string {
  const task = taskSchema.parse(raw);
  return createHash('sha256').update(JSON.stringify(task)).digest('hex');
}
function secrets(): string[] {
  return Object.entries(process.env)
    .filter(
      ([name, value]) =>
        /(?:TOKEN|SECRET|PASS|CREDENTIAL|API_KEY|KEY$)/i.test(name) && !!value && value.length > 8,
    )
    .map(([, value]) => value!);
}
function safeOutput(value: Buffer | string, initialSecrets: readonly string[] = []): string {
  return stripVTControlCharacters(redact(String(value), [...initialSecrets, ...secrets()])).replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    '',
  );
}
/** Intentionally excludes NODE_OPTIONS, language startup hooks and every bot/provider credential. */
export function operationEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ']);
  return Object.fromEntries(
    Object.entries(source).filter(([name, value]) => allowed.has(name.toUpperCase()) && value !== undefined),
  );
}
export async function loadOperationManifest(path: string): Promise<Definition[]> {
  if (!path)
    throw new UserError(
      'Local operations are disabled. Configure an absolute LOCAL_OPERATIONS_MANIFEST path locally.',
    );
  absolute.parse(path);
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > OPERATION_LIMITS.manifestBytes)
    throw new UserError('Operation manifest must be a regular file no larger than 64 KiB.');
  const data = await readFile(path);
  if (data.length > OPERATION_LIMITS.manifestBytes) throw new UserError('Operation manifest exceeds 64 KiB.');
  let input: unknown;
  try {
    input = JSON.parse(data.toString('utf8'));
  } catch {
    throw new UserError('Operation manifest is not valid JSON.');
  }
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success)
    throw new UserError('Operation manifest has unsupported fields, bounds, paths or duplicate task IDs.');
  const encoded = JSON.stringify(parsed.data);
  if (redact(encoded, secrets()) !== encoded)
    throw new UserError(
      'Operation definitions cannot contain recognized credentials. Keep secrets out of task arguments and descriptions.',
    );
  return parsed.data.tasks.map((task) => ({ ...task, definitionHash: operationDefinitionHash(task) }));
}
function recover(store: Store): void {
  const ids = activeIds.get(store);
  for (const row of store.list<Run>(runsNamespace))
    if (row.value.state === 'running' && !ids?.has(row.value.id)) {
      row.value.state = 'unknown';
      row.value.finishedAt = Date.now();
      row.value.stderr =
        'The bot stopped before recording a subprocess result. Inspect the host before acknowledging; no automatic retry was made.';
      store.set(runsNamespace, row.key, row.value);
      if (row.value.scheduleId) {
        const scheduleKey = key(row.value.guildId, row.value.scheduleId),
          schedule = store.get<Schedule>(schedulesNamespace, scheduleKey);
        if (schedule && schedule.version === row.value.scheduleVersion) {
          schedule.enabled = false;
          schedule.blockedByRunId = row.value.id;
          schedule.lastError = 'Interrupted';
          delete schedule.inFlightRunId;
          store.set(schedulesNamespace, scheduleKey, schedule);
        }
      }
    }
}
function checkPolicy(ctx: ActionContext, action: string): void {
  if (paused(ctx.store, ctx.guild.id)) throw new UserError('Local operations are disabled in this server.');
  const policy = ctx.store.get<ActionPolicy>('core.actionPolicies', key(ctx.guild.id, action));
  if (
    policy &&
    (!policy.enabled ||
      (policy.channelIds.length && !policy.channelIds.includes(ctx.channelId)) ||
      (policy.roleIds.length && !policy.roleIds.some((role) => ctx.member.roles.cache.has(role))))
  )
    throw new UserError('Local operation action policy was revoked.');
}
async function context(
  ctx: ActionContext,
  operatorIds: readonly string[],
  action: string,
): Promise<ActionContext> {
  ctx = await freshContext(ctx);
  assertOperator(ctx, operatorIds);
  await resolveChannel(ctx, ctx.channelId);
  assertOperator(ctx, operatorIds);
  checkPolicy(ctx, action);
  return ctx;
}
function track<T>(store: Store, fn: () => Promise<T>): Promise<T> {
  if (closing.has(store))
    return Promise.reject(new UserError('The bot is shutting down; no local operation was started.'));
  const set = pending.get(store) ?? new Set<Promise<unknown>>();
  pending.set(store, set);
  const promise = Promise.resolve().then(fn);
  set.add(promise);
  void promise.finally(() => set.delete(promise)).catch(() => {});
  return promise;
}
export async function drainOperations(store: Store): Promise<void> {
  closing.add(store);
  await Promise.allSettled([...(pending.get(store) ?? [])]);
}
function sameSchedule(store: Store, schedule: Schedule): boolean {
  const current = store.get<Schedule>(schedulesNamespace, key(schedule.guildId, schedule.id));
  return (
    current?.enabled === true && current.version === schedule.version && !paused(store, schedule.guildId)
  );
}
function ensureHistoryCapacity(store: Store, guildId: string): void {
  const runs = store
    .list<Run>(runsNamespace, `${guildId}:`)
    .sort((a, b) => a.value.startedAt - b.value.startedAt);
  let remove = Math.max(0, runs.length - OPERATION_LIMITS.runsPerGuild + 1);
  for (const row of runs)
    if (remove && row.value.state !== 'running' && row.value.state !== 'unknown') {
      store.delete(runsNamespace, row.key);
      remove--;
    }
  if (remove)
    throw new UserError(
      'Local operation history is full of unresolved runs. Review and acknowledge unknown host outcomes first.',
    );
  const all = store.list<Run>(runsNamespace).sort((a, b) => a.value.startedAt - b.value.startedAt);
  let globalRemove = Math.max(0, all.length - OPERATION_LIMITS.runsTotal + 1);
  for (const row of all)
    if (globalRemove && row.value.state !== 'running' && row.value.state !== 'unknown') {
      store.delete(runsNamespace, row.key);
      globalRemove--;
    }
  if (globalRemove)
    throw new UserError(
      'Global operation history is full of unresolved runs. Acknowledge unknown host outcomes first.',
    );
}
async function executeFixed(
  ctx: ActionContext,
  taskId: string,
  expectedHash: string,
  operatorIds: readonly string[],
  manifestPath: string,
  schedule?: Schedule,
): Promise<Run> {
  recover(ctx.store);
  const task = (await loadOperationManifest(manifestPath)).find((value) => value.id === taskId);
  if (!task || task.definitionHash !== expectedHash)
    throw new UserError(
      'The fixed task definition changed or is unavailable. Inspect operation.tasks and approve the current exact hash.',
    );
  const [binary, directory] = await Promise.all([realpath(task.executable), realpath(task.cwd)]);
  const [binaryInfo, directoryInfo] = await Promise.all([stat(binary), stat(directory)]);
  if (
    !binaryInfo.isFile() ||
    !directoryInfo.isDirectory() ||
    ['.cmd', '.bat'].includes(extname(binary).toLowerCase())
  )
    throw new UserError(
      'Use a regular executable and directory. Batch files require a locally configured interpreter with fixed arguments.',
    );
  ctx = await context(ctx, operatorIds, schedule ? 'operation.schedule.set' : 'operation.run');
  const current = (await loadOperationManifest(manifestPath)).find((value) => value.id === taskId);
  if (!current || current.definitionHash !== expectedHash)
    throw new UserError(
      'The local task changed during authorization. Inspect the current definition before approval.',
    );
  assertOperator(ctx, operatorIds);
  checkPolicy(ctx, schedule ? 'operation.schedule.set' : 'operation.run');
  if (closing.has(ctx.store))
    throw new UserError('The bot is shutting down; no local operation was started.');
  if (schedule && !sameSchedule(ctx.store, schedule))
    throw new UserError('Scheduled local operation was cancelled or replaced.');
  if (
    ctx.store
      .list<Run>(runsNamespace)
      .some((row) => row.value.taskId === taskId && row.value.state === 'unknown')
  )
    throw new UserError(
      'This task has an unknown previous outcome. Inspect operation.history and acknowledge the run before repeating it.',
    );
  if (active >= OPERATION_LIMITS.concurrency)
    throw new UserError('Both local operation slots are busy. Try again later.');
  ensureHistoryCapacity(ctx.store, ctx.guild.id);
  const run: Run = {
    id: randomBytes(8).toString('hex'),
    guildId: ctx.guild.id,
    userId: ctx.member.id,
    taskId,
    definitionHash: expectedHash,
    startedAt: Date.now(),
    state: 'running',
    stdout: '',
    stderr: '',
    exitCode: null,
    signal: null,
    ...(schedule ? { scheduleId: schedule.id, scheduleVersion: schedule.version } : {}),
  };
  const ids = activeIds.get(ctx.store) ?? new Set<string>();
  activeIds.set(ctx.store, ids);
  ids.add(run.id);
  active++;
  try {
    ctx.store.transaction(() => {
      ctx.store.set(runsNamespace, key(ctx.guild.id, run.id), run);
      if (schedule) {
        schedule.inFlightRunId = run.id;
        ctx.store.set(schedulesNamespace, key(schedule.guildId, schedule.id), schedule);
      }
    });
    const result = await runChild(binary, task.arguments, directory, task.timeoutSeconds);
    Object.assign(run, result, { finishedAt: Date.now() });
    ctx.store.set(runsNamespace, key(ctx.guild.id, run.id), run);
    return run;
  } finally {
    active--;
    ids.delete(run.id);
  }
}
function runChild(
  executable: string,
  args: string[],
  cwd: string,
  timeoutSeconds: number,
): Promise<Pick<Run, 'state' | 'stdout' | 'stderr' | 'exitCode' | 'signal'>> {
  return new Promise((resolve) => {
    const initialSecrets = secrets();
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let bytes = 0,
      failure: RunState | undefined;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: operationEnvironment(),
      });
    } catch {
      return resolve({
        state: 'spawn-error',
        stdout: '',
        stderr: 'Subprocess could not be started.',
        exitCode: null,
        signal: null,
      });
    }
    const timer = setTimeout(() => {
      failure ??= 'timeout';
      child.kill('SIGKILL');
    }, timeoutSeconds * 1000);
    const accept = (buffer: Buffer, destination: Buffer[]) => {
      const remaining = Math.max(0, OPERATION_LIMITS.outputBytes - bytes);
      if (remaining) destination.push(buffer.subarray(0, remaining));
      bytes += buffer.length;
      if (bytes > OPERATION_LIMITS.outputBytes) {
        failure ??= 'output-limit';
        child.kill('SIGKILL');
      }
    };
    child.stdout!.on('data', (data: Buffer) => accept(data, stdout));
    child.stderr!.on('data', (data: Buffer) => accept(data, stderr));
    child.once('error', () => {
      failure = 'spawn-error';
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      let safeStdout = safeOutput(Buffer.concat(stdout), initialSecrets);
      let safeStderr = safeOutput(Buffer.concat(stderr), initialSecrets);
      // Redaction can lengthen short secret values. Bound the final UTF-8 representation as well.
      while (Buffer.byteLength(safeStdout) + Buffer.byteLength(safeStderr) > OPERATION_LIMITS.outputBytes) {
        if (safeStderr.length) safeStderr = safeStderr.slice(0, Math.max(0, safeStderr.length - 1024));
        else safeStdout = safeStdout.slice(0, Math.max(0, safeStdout.length - 1024));
      }
      resolve({
        state: failure ?? (code === 0 ? 'success' : 'failed'),
        stdout: safeStdout,
        stderr: safeStderr,
        exitCode: code,
        signal,
      });
    });
  });
}
const cron = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      parseCron(value);
      return true;
    } catch {
      return false;
    }
  }, 'Use a valid five-field UTC cron expression.');
export function registerOperationActions(
  registry: ActionRegistry,
  operatorIds: readonly string[] = [],
  manifestPath = '',
): void {
  const base = { category: 'operations', userPermissions: [] as bigint[], botPermissions: [] as bigint[] };
  registry.register({
    ...base,
    id: 'operation.tasks',
    risk: 'read',
    description:
      'Application owner inspects locally configured fixed task definitions and their exact hashes. No task is started.',
    schema: z.strictObject({}),
    execute: async (ctx) => {
      assertOperator(ctx, operatorIds);
      if (!manifestPath) return { enabled: false, tasks: [] };
      return {
        enabled: true,
        tasks: await loadOperationManifest(manifestPath),
        notice:
          'Only these fixed local definitions can execute; no Discord-provided arguments, shell text, environment or paths are accepted.',
      };
    },
  });
  registry.register({
    ...base,
    id: 'operation.run',
    risk: 'destructive',
    description:
      'Owner runs one locally configured fixed executable/arguments task after confirming its exact current definition hash. Never automatically retried.',
    schema: z.strictObject({ taskId: id, definitionHash: hash }),
    execute: (ctx, input) => {
      assertOperator(ctx, operatorIds);
      return track(ctx.store, () =>
        executeFixed(ctx, input.taskId, input.definitionHash, operatorIds, manifestPath),
      );
    },
  });
  registry.register({
    ...base,
    id: 'operation.history',
    risk: 'read',
    description:
      'Owner reads retained redacted fixed-task outcomes; interrupted runs are marked unknown and block repetition until acknowledged.',
    schema: z.strictObject({ limit: z.number().int().min(1).max(25).default(10) }),
    execute: (ctx, input) => {
      assertOperator(ctx, operatorIds);
      recover(ctx.store);
      return ctx.store
        .list<Run>(runsNamespace, `${ctx.guild.id}:`)
        .map((row) => row.value)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, input.limit);
    },
  });
  registry.register({
    ...base,
    id: 'operation.run.acknowledge',
    risk: 'destructive',
    description:
      'After inspecting host state, owner acknowledges an interrupted unknown run. This does not rerun or undo it.',
    schema: z.strictObject({ runId, reviewedHostState: z.literal(true) }),
    execute: (ctx, input) => {
      assertOperator(ctx, operatorIds);
      recover(ctx.store);
      const run = ctx.store.get<Run>(runsNamespace, key(ctx.guild.id, input.runId));
      if (!run || run.state !== 'unknown')
        throw new UserError('Only an unknown interrupted run in this server can be acknowledged.');
      run.state = 'acknowledged';
      ctx.store.set(runsNamespace, key(ctx.guild.id, run.id), run);
      return { acknowledged: run.id, noExecutionPerformed: true };
    },
  });
  registry.register({
    ...base,
    id: 'operation.schedule.set',
    risk: 'destructive',
    description:
      'Owner schedules an exact fixed task hash using UTC cron. Failed or unknown subprocess outcomes pause it without retries.',
    schema: z.strictObject({ id, taskId: id, definitionHash: hash, cron }),
    execute: (ctx, input) => {
      assertOperator(ctx, operatorIds);
      return track(ctx.store, async () => {
        recover(ctx.store);
        const task = (await loadOperationManifest(manifestPath)).find((task) => task.id === input.taskId);
        if (!task || task.definitionHash !== input.definitionHash)
          throw new UserError('Inspect and approve the current fixed task hash first.');
        await context(ctx, operatorIds, 'operation.schedule.set');
        if (
          ctx.store
            .list<Run>(runsNamespace)
            .some((row) => row.value.taskId === input.taskId && row.value.state === 'unknown')
        )
          throw new UserError(
            'A previous task outcome is unknown. Inspect and acknowledge its run before scheduling.',
          );
        if (
          !ctx.store.get(schedulesNamespace, key(ctx.guild.id, input.id)) &&
          ctx.store.list(schedulesNamespace, `${ctx.guild.id}:`).length >= 10
        )
          throw new UserError('Limit: ten local task schedules per server.');
        const value: Schedule = {
          ...input,
          guildId: ctx.guild.id,
          authorId: ctx.member.id,
          channelId: ctx.channelId,
          version: randomBytes(8).toString('hex'),
          enabled: true,
          nextAt: nextCron(input.cron, Date.now()),
        };
        ctx.store.set(schedulesNamespace, key(ctx.guild.id, input.id), value);
        return value;
      });
    },
  });
  registry.register({
    ...base,
    id: 'operation.schedule.list',
    risk: 'read',
    description: 'Owner inspects persisted fixed-task UTC schedules and paused/failure state.',
    schema: z.strictObject({}),
    execute: (ctx) => {
      assertOperator(ctx, operatorIds);
      recover(ctx.store);
      return ctx.store.list<Schedule>(schedulesNamespace, `${ctx.guild.id}:`).map((row) => row.value);
    },
  });
  registry.register({
    ...base,
    id: 'operation.schedule.remove',
    risk: 'write',
    description:
      'Owner cancels future executions of a fixed local task schedule. An already started process is not recalled.',
    schema: z.strictObject({ id }),
    execute: (ctx, input) => {
      assertOperator(ctx, operatorIds);
      return { removed: ctx.store.delete(schedulesNamespace, key(ctx.guild.id, input.id)) };
    },
  });
}
const sweeping = new WeakSet<Store>();
export async function sweepOperationTasks(
  client: Client,
  store: Store,
  operatorIds: readonly string[],
  manifestPath: string,
  now = Date.now(),
  allowedGuildIds: readonly string[] = [],
): Promise<void> {
  if (sweeping.has(store) || closing.has(store) || !manifestPath) return;
  sweeping.add(store);
  const stopAt = Date.now() + 20000;
  try {
    recover(store);
    for (const { key: scheduleKey, value: schedule } of store
      .list<Schedule>(schedulesNamespace)
      .filter(
        (row) =>
          row.value.enabled &&
          row.value.nextAt <= now &&
          !paused(store, row.value.guildId) &&
          (!allowedGuildIds.length || allowedGuildIds.includes(row.value.guildId)),
      )
      .sort((a, b) => a.value.nextAt - b.value.nextAt)
      .slice(0, 2)) {
      if (Date.now() >= stopAt || closing.has(store)) break;
      try {
        const guild = await client.guilds.fetch(schedule.guildId);
        const ctx: ActionContext = {
          client,
          store,
          guild,
          member: { id: schedule.authorId } as ActionContext['member'],
          channelId: schedule.channelId,
        };
        if (!sameSchedule(store, schedule)) continue;
        const run = await track(store, () =>
          executeFixed(ctx, schedule.taskId, schedule.definitionHash, operatorIds, manifestPath, schedule),
        );
        if (!sameSchedule(store, schedule)) continue;
        delete schedule.inFlightRunId;
        schedule.lastRunId = run.id;
        if (run.state === 'success') {
          schedule.nextAt = nextCron(schedule.cron, now);
          delete schedule.lastError;
        } else {
          schedule.enabled = false;
          schedule.lastError = run.state;
        }
        store.set(schedulesNamespace, scheduleKey, schedule);
      } catch (error) {
        if (!sameSchedule(store, schedule)) continue;
        schedule.enabled = false;
        schedule.lastError = error instanceof Error ? error.name : 'Error';
        delete schedule.inFlightRunId;
        store.set(schedulesNamespace, scheduleKey, schedule);
      }
    }
  } finally {
    sweeping.delete(store);
  }
}
