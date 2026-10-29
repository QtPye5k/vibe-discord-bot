import { createHmac, timingSafeEqual, createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { freemem, totalmem, loadavg, hostname } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { Store } from '../core/store.js';
import { readBody, jsonResponse, HttpError } from '../core/http.js';
import { loadOperationManifest, operationEnvironment } from '../features/operations.js';
import { redact } from '../core/logger.js';

export const agentRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('status') }),
  z.strictObject({ operation: z.literal('tasks') }),
  z.strictObject({
    operation: z.literal('run'),
    id: z.string().regex(/^[a-f0-9]{32}$/),
    taskId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
    definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({ operation: z.literal('result'), id: z.string().regex(/^[a-f0-9]{32}$/) }),
  z.strictObject({
    operation: z.literal('acknowledge'),
    id: z.string().regex(/^[a-f0-9]{32}$/),
    reviewedHostState: z.literal(true),
  }),
]);
export interface AgentRun {
  id: string;
  taskId: string;
  definitionHash: string;
  state: 'running' | 'success' | 'failed' | 'timeout' | 'output-limit' | 'unknown' | 'acknowledged';
  startedAt: number;
  finishedAt?: number;
  output: string;
  exitCode?: number | null;
}
export const agentSignature = (key: string, timestamp: string, nonce: string, body: Buffer) =>
  createHmac('sha256', key).update(`${timestamp}\n${nonce}\n`).update(body).digest('hex');
export function signedAgentHeaders(key: string, body: Buffer, now = Date.now()): Record<string, string> {
  const timestamp = String(now),
    nonce = randomBytes(16).toString('hex');
  return {
    'content-type': 'application/json',
    'x-agent-time': timestamp,
    'x-agent-nonce': nonce,
    'x-agent-signature': agentSignature(key, timestamp, nonce, body),
  };
}
export function createHostAgent(options: {
  store: Store;
  key: string;
  manifest: string;
  now?: () => number;
}) {
  if (options.key.length < 32) throw new Error('Host-agent key must contain at least32characters.');
  const { store } = options,
    now = options.now ?? Date.now,
    pending = new Set<Promise<void>>();
  let active = 0,
    closed = false;
  for (const row of store.list<AgentRun>('agent.runs'))
    if (row.value.state === 'running')
      store.set('agent.runs', row.key, {
        ...row.value,
        state: 'unknown',
        finishedAt: now(),
        output: 'Agent restarted before completion was recorded. Inspect host state; no task was retried.',
      });
  async function run(
    input: Extract<z.infer<typeof agentRequestSchema>, { operation: 'run' }>,
  ): Promise<AgentRun> {
    const prior = store.get<AgentRun>('agent.runs', input.id);
    if (prior) {
      if (prior.taskId !== input.taskId || prior.definitionHash !== input.definitionHash)
        throw new HttpError(409, 'Request ID belongs to a different operation.');
      return prior;
    }
    if (closed || active >= 2) throw new HttpError(429, 'Host is busy; no task started.');
    const task = (await loadOperationManifest(options.manifest)).find(
      (task) => task.id === input.taskId && task.definitionHash === input.definitionHash,
    );
    if (!task) throw new HttpError(409, 'Task definition changed or is unavailable.');
    // Recheck admission after asynchronous manifest reads; simultaneous requests cannot overbook.
    if (closed || active >= 2) throw new HttpError(429, 'Host is busy; no task started.');
    const existing = store.get<AgentRun>('agent.runs', input.id);
    if (existing) {
      if (existing.taskId !== input.taskId || existing.definitionHash !== input.definitionHash)
        throw new HttpError(409, 'Request ID belongs to a different operation.');
      return existing;
    }
    const rows = store.list<AgentRun>('agent.runs');
    if (rows.some((row) => row.value.taskId === task.id && ['running', 'unknown'].includes(row.value.state)))
      throw new HttpError(409, 'A previous task outcome requires host review.');
    for (const row of rows
      .sort((a, b) => a.value.startedAt - b.value.startedAt)
      .slice(0, Math.max(0, rows.length - 499)))
      if (row.value.state !== 'running' && row.value.state !== 'unknown') store.delete('agent.runs', row.key);
    if (store.list('agent.runs').length >= 500) throw new HttpError(429, 'Retained operation limit reached.');
    const record: AgentRun = {
      id: input.id,
      taskId: task.id,
      definitionHash: task.definitionHash,
      state: 'running',
      startedAt: now(),
      output: '',
    };
    store.set('agent.runs', record.id, record);
    active++;
    let tracked: Promise<void>;
    tracked = new Promise<void>((resolve) => {
      let bytes = 0,
        reason: 'timeout' | 'output-limit' | undefined,
        settled = false;
      const child = spawn(task.executable, task.arguments, {
        cwd: task.cwd,
        env: operationEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => {
        reason = 'timeout';
        child.kill('SIGKILL');
      }, task.timeoutSeconds * 1000);
      timer.unref();
      const append = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 65536) {
          reason = 'output-limit';
          child.kill('SIGKILL');
          return;
        }
        record.output += redact(stripVTControlCharacters(chunk.toString('utf8')), [options.key]);
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        record.state = reason ?? (code === 0 ? 'success' : 'failed');
        record.exitCode = code;
        record.finishedAt = now();
        store.set('agent.runs', record.id, record);
        active--;
        resolve();
      };
      child.once('error', () => finish(null));
      child.once('close', (code) => finish(code));
    }).finally(() => pending.delete(tracked));
    pending.add(tracked);
    return { ...record };
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (request.url !== '/agent/rpc') return false;
    try {
      if (closed) throw new HttpError(503, 'Host agent is stopping.');
      if (request.method !== 'POST' || request.headers['content-type']?.split(';')[0] !== 'application/json')
        throw new HttpError(405, 'Use a signed JSON POST.');
      const body = await readBody(request, 32768),
        timestamp = String(request.headers['x-agent-time'] ?? ''),
        nonce = String(request.headers['x-agent-nonce'] ?? ''),
        signature = String(request.headers['x-agent-signature'] ?? '');
      if (
        !/^\d{13}$/.test(timestamp) ||
        Math.abs(now() - Number(timestamp)) > 300000 ||
        !/^[a-f0-9]{32}$/.test(nonce) ||
        !/^[a-f0-9]{64}$/.test(signature)
      )
        throw new HttpError(401, 'Invalid host authorization.');
      const expected = agentSignature(options.key, timestamp, nonce, body);
      if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature)))
        throw new HttpError(401, 'Invalid host authorization.');
      const replay = createHash('sha256').update(nonce).digest('hex');
      if (store.get('agent.nonces', replay)) throw new HttpError(409, 'Request was already received.');
      for (const row of store.list<number>('agent.nonces'))
        if (row.value < now() - 600000) store.delete('agent.nonces', row.key);
      if (store.list('agent.nonces').length >= 2000)
        throw new HttpError(429, 'Agent authorization window is full.');
      store.set('agent.nonces', replay, now());
      const input = agentRequestSchema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)),
      );
      let result: unknown;
      if (input.operation === 'status')
        result = {
          hostname: hostname(),
          uptimeSeconds: Math.floor(process.uptime()),
          freeMemoryBytes: freemem(),
          totalMemoryBytes: totalmem(),
          loadAverage: loadavg(),
          activeTasks: active,
          node: process.versions.node,
          platform: process.platform,
        };
      else if (input.operation === 'tasks')
        result = options.manifest
          ? (await loadOperationManifest(options.manifest)).map(
              ({ id, description, definitionHash, timeoutSeconds }) => ({
                id,
                description,
                definitionHash,
                timeoutSeconds,
              }),
            )
          : [];
      else if (input.operation === 'run') result = await run(input);
      else if (input.operation === 'acknowledge') {
        const record = store.get<AgentRun>('agent.runs', input.id);
        if (!record || record.state !== 'unknown')
          throw new HttpError(409, 'Only an unknown outcome can be acknowledged after host review.');
        record.state = 'acknowledged';
        store.set('agent.runs', record.id, record);
        result = { acknowledged: record.id };
      } else result = store.get<AgentRun>('agent.runs', input.id) ?? null;
      jsonResponse(response, 200, result);
    } catch (error) {
      jsonResponse(
        response,
        error instanceof HttpError
          ? error.status
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? 400
            : 500,
        {
          error: error instanceof HttpError ? error.message : 'Host request failed validation or execution.',
        },
      );
    }
    return true;
  }
  return {
    handle,
    async close() {
      closed = true;
      await Promise.allSettled([...pending]);
    },
  };
}
