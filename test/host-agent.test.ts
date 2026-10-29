import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { Store } from '../src/core/store.js';
import { createHostAgent, signedAgentHeaders, type AgentRun } from '../src/host-agent/service.js';
import { ActionRegistry } from '../src/core/registry.js';
import { registerRemoteHostActions } from '../src/features/remote-host.js';
const key = 'test-only-host-key-'.repeat(3);
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'discord-agent-test-')),
    manifest = join(directory, 'tasks.json');
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 'inspect',
          description: 'Harmless fixed command',
          executable: process.execPath,
          arguments: ['-e', 'process.stdout.write("remote-ok")'],
          cwd: directory,
          timeoutSeconds: 3,
          retrySafe: false,
        },
      ],
    }),
  );
  const store = new Store(':memory:'),
    agent = createHostAgent({ store, key, manifest });
  const server = createServer((req, res) => {
    void agent.handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No agent port.');
  const url = `http://127.0.0.1:${address.port}/agent/rpc`;
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await agent.close();
    store.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const call = async (input: unknown, headers?: Record<string, string>) => {
    const body = Buffer.from(JSON.stringify(input));
    return fetch(url, { method: 'POST', headers: headers ?? signedAgentHeaders(key, body), body });
  };
  return { store, call, key };
}
test('Remote agent rejects missing, modified and replayed authorizations before returning host data', async (t) => {
  const f = await fixture(t as never),
    body = Buffer.from(JSON.stringify({ operation: 'status' })),
    headers = signedAgentHeaders(key, body);
  assert.equal((await f.call({ operation: 'status' }, { 'content-type': 'application/json' })).status, 401);
  assert.equal((await f.call({ operation: 'tasks' }, headers)).status, 401);
  const response = await f.call({ operation: 'status' }, headers);
  assert.equal(response.status, 200);
  assert.equal(typeof (await response.json()).uptimeSeconds, 'number');
  assert.equal((await f.call({ operation: 'status' }, headers)).status, 409);
});
test('Fixed remote tasks execute real child process once, bind definitions, and expose retained results', async (t) => {
  const f = await fixture(t as never),
    tasks = (await (await f.call({ operation: 'tasks' })).json()) as { id: string; definitionHash: string }[];
  const input = {
    operation: 'run',
    id: 'a'.repeat(32),
    taskId: 'inspect',
    definitionHash: tasks[0]!.definitionHash,
  };
  assert.equal((await f.call(input)).status, 200);
  for (let i = 0; i < 100 && f.store.get<AgentRun>('agent.runs', input.id)?.state === 'running'; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const result = await (await f.call({ operation: 'result', id: input.id })).json();
  assert.equal(result.state, 'success');
  assert.equal(result.output, 'remote-ok');
  assert.equal((await f.call(input)).status, 200);
  assert.equal(f.store.list('agent.runs').length, 1);
  assert.equal((await f.call({ ...input, definitionHash: 'b'.repeat(64) })).status, 409);
  assert.equal((await f.call({ ...input, id: 'b'.repeat(32), arguments: ['arbitrary'] })).status, 400);
});
test('Interrupted host tasks require explicit state review instead of silently repeating', async (t) => {
  const f = await fixture(t as never),
    tasks = (await (await f.call({ operation: 'tasks' })).json()) as { definitionHash: string }[];
  f.store.set('agent.runs', 'c'.repeat(32), {
    id: 'c'.repeat(32),
    taskId: 'inspect',
    definitionHash: tasks[0]!.definitionHash,
    state: 'unknown',
    startedAt: 1,
    output: 'Interrupted',
  });
  assert.equal(
    (
      await f.call({
        operation: 'run',
        id: 'd'.repeat(32),
        taskId: 'inspect',
        definitionHash: tasks[0]!.definitionHash,
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.call({ operation: 'acknowledge', id: 'c'.repeat(32), reviewedHostState: true })).status,
    200,
  );
  assert.equal(f.store.get<AgentRun>('agent.runs', 'c'.repeat(32))?.state, 'acknowledged');
});
test('Blank remote configuration hides all remote actions and cannot create confirmations', async () => {
  const registry = new ActionRegistry();
  registerRemoteHostActions(registry, { url: '', key: '', operatorIds: [] });
  assert.equal(registry.listAvailable().length, 0);
  assert.equal(registry.list().length, 5);
  await assert.rejects(
    () => registry.request({} as never, 'host.run', { taskId: 'inspect', definitionHash: 'a'.repeat(64) }),
    /disabled/,
  );
});
