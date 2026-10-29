import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';

// The supervisor is deliberately native ESM so it works before any TypeScript tooling starts.
const moduleUrl = new URL('../scripts/supervise.mjs', import.meta.url).href;
const { restartDecision, runSupervisor } = await import(moduleUrl);
function fake() {
  const signals = new EventEmitter(),
    children: FakeChild[] = [],
    timers = new Map<number, { callback: () => void; delay: number }>();
  let serial = 0;
  class FakeChild extends EventEmitter {
    connected = true;
    kills: string[] = [];
    messages: unknown[] = [];
    kill(signal: string) {
      this.kills.push(signal);
      return true;
    }
    send(message: unknown, callback: (error: Error | null) => void) {
      this.messages.push(message);
      callback(null);
    }
  }
  const spawns: { executable: string; args: string[]; options: Record<string, unknown> }[] = [];
  const promise = runSupervisor({
    signalSource: signals,
    platform: 'win32',
    env: { SAFE_TEST: '1' },
    now: () => 1000000,
    log: () => {},
    spawnProcess: (executable: string, args: string[], options: Record<string, unknown>) => {
      spawns.push({ executable, args, options });
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    setTimer: (callback: () => void, delay: number) => {
      timers.set(++serial, { callback, delay });
      return serial;
    },
    clearTimer: (id: number) => timers.delete(id),
  });
  const tick = () => {
    const item = timers.entries().next().value as
      [number, { callback: () => void; delay: number }] | undefined;
    assert.ok(item, 'Expected a scheduled supervisor timer');
    timers.delete(item[0]);
    item[1].callback();
    return item[1].delay;
  };
  return { signals, children, timers, spawns, promise, tick };
}
test('unexpected restart backoff is bounded and resets after five stable minutes', () => {
  assert.equal(restartDecision({ startedAt: 0, now: 1000, code: 1, failures: 0 }).delayMs, 1000);
  assert.equal(restartDecision({ startedAt: 0, now: 1000, code: 1, failures: 3 }).delayMs, 8000);
  assert.equal(restartDecision({ startedAt: 0, now: 1000, code: 1, failures: 15 }).delayMs, 60000);
  const stable = restartDecision({ startedAt: 0, now: 300000, code: 1, failures: 15 });
  assert.equal(stable.failures, 1);
  assert.equal(stable.delayMs, 1000);
});
test('planned exit75 does not add a failure but still consumes hourly restart budget', () => {
  const planned = restartDecision({ startedAt: 0, now: 1000, code: 75, failures: 3, recent: [] });
  assert.equal(planned.failures, 3);
  assert.equal(planned.recent.length, 1);
  assert.equal(planned.delayMs, 1000);
  assert.equal(
    restartDecision({ startedAt: 0, now: 1000, code: 75, recent: Array(10).fill(500) }).allowed,
    false,
  );
  assert.equal(
    restartDecision({ startedAt: 0, now: 4000000, code: 1, recent: Array(10).fill(1) }).allowed,
    true,
  );
});
test('supervisor starts the verified-release wrapper with hidden no-shell settings and inherited configured environment', async () => {
  const f = fake();
  assert.equal(f.spawns.length, 1);
  assert.equal(f.spawns[0]!.executable, process.execPath);
  assert.match(f.spawns[0]!.args[0]!, /scripts[\\/]start\.mjs$/);
  assert.equal(f.spawns[0]!.options.shell, false);
  assert.equal(f.spawns[0]!.options.windowsHide, true);
  assert.deepEqual(f.spawns[0]!.options.env, { SAFE_TEST: '1', BOT_SUPERVISED: '1' });
  f.signals.emit('SIGTERM');
  f.children[0]!.emit('close', 0, null);
  assert.equal(await f.promise, 0);
  assert.equal(f.timers.size, 0);
});
test('crashes restart at bounded delays and stop after ten restarts in an hour', async () => {
  const f = fake();
  for (let index = 0; index < 10; index++) {
    f.children[index]!.emit('close', 1, null);
    const delay = f.tick();
    assert.ok(delay >= 1000 && delay <= 60000);
  }
  assert.equal(f.children.length, 11);
  f.children[10]!.emit('close', 1, null);
  assert.equal(await f.promise, 1);
  assert.equal(f.timers.size, 0);
});
test('Windows shutdown forwards IPC and enforces ninety-second maximum drain before kill', async () => {
  const f = fake();
  f.signals.emit('SIGINT');
  assert.deepEqual(f.children[0]!.messages, [{ type: 'bot.shutdown', signal: 'SIGINT' }]);
  assert.deepEqual(f.children[0]!.kills, []);
  assert.equal(f.tick(), 90000);
  assert.deepEqual(f.children[0]!.kills, ['SIGKILL']);
  f.children[0]!.emit('close', null, 'SIGKILL');
  assert.equal(await f.promise, 0);
});
test('shutdown during restart backoff cancels restart without spawning another child', async () => {
  const f = fake();
  f.children[0]!.emit('close', 75, null);
  assert.equal(f.timers.size, 1);
  f.signals.emit('SIGTERM');
  assert.equal(await f.promise, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.children.length, 1);
});
test('real harmless Node child receives supervisor marker and drains via shutdown IPC', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'discord-supervisor-test-'));
  t.after(async () => {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('discord-supervisor-test-'));
    await rm(target, { recursive: true, force: true });
  });
  const marker = join(directory, 'marker.txt'),
    entry = join(directory, 'child.mjs');
  await writeFile(
    entry,
    `import {writeFileSync}from'node:fs';process.on('message',message=>{if(message.type==='bot.shutdown'){writeFileSync(${JSON.stringify(marker)},process.env.BOT_SUPERVISED);process.disconnect();}});process.send({ready:true});`,
  );
  const signals = new EventEmitter();
  let observed = false;
  const exit = await runSupervisor({
    entry,
    cwd: directory,
    signalSource: signals,
    platform: 'win32',
    graceMs: 1000,
    log: () => {},
    spawnProcess: (executable: string, args: string[], options: Record<string, unknown>) => {
      const child = spawn(executable, args, { ...options, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', () => {
        observed = true;
        signals.emit('SIGTERM');
      });
      return child;
    },
  });
  assert.equal(exit, 0);
  assert.equal(observed, true);
  assert.equal(await readFile(marker, 'utf8'), '1');
});
