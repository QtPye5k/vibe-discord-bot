import test from 'node:test';
import assert from 'node:assert/strict';
import { createUptimeMonitor, type MonitorState } from '../src/monitor/service.js';
test('Independent monitor requires repeated failures, reports one outage, and reports confirmed recovery', async () => {
  let healthy = true;
  const events: string[] = [];
  const monitor = createUptimeMonitor({
    target: 'http://127.0.0.1/ready',
    fetch: (async () => new Response('', { status: healthy ? 200 : 503 })) as typeof fetch,
    notify: async (event) => {
      events.push(event);
    },
  });
  await monitor.tick();
  await monitor.tick();
  assert.equal(monitor.state().up, true);
  healthy = false;
  await monitor.tick();
  await monitor.tick();
  assert.deepEqual(events, []);
  await monitor.tick();
  await monitor.tick();
  assert.deepEqual(events, ['down']);
  healthy = true;
  await monitor.tick();
  assert.deepEqual(events, ['down']);
  await monitor.tick();
  await monitor.tick();
  assert.deepEqual(events, ['down', 'recovered']);
});
test('Persisted downtime does not create another alert after monitor restart and redirects are forbidden', async () => {
  let options: RequestInit | undefined,
    calls = 0;
  const monitor = createUptimeMonitor({
    target: 'https://example.com/ready',
    initial: { up: false, failures: 3, successes: 0, lastNotification: 'down' },
    fetch: (async (_url, init) => {
      options = init;
      return new Response('', { status: 503 });
    }) as typeof fetch,
    notify: async () => {
      calls++;
    },
  });
  await monitor.tick();
  assert.equal(calls, 0);
  assert.equal(options?.redirect, 'error');
  assert.ok(options?.signal);
});
test('failed outage notification is persisted and retries on the next tick with the same event identity', async () => {
  let persisted: MonitorState | undefined,
    fail = true;
  const deliveries: { event: string; id: string }[] = [];
  const monitor = createUptimeMonitor({
    target: 'http://127.0.0.1/ready',
    fetch: (async () => new Response('', { status: 503 })) as typeof fetch,
    persist: (state) => {
      persisted = state;
    },
    notify: async (event, _at, delivery) => {
      assert.equal(persisted?.pending?.[0]?.id, delivery.id);
      deliveries.push({ event, id: delivery.id });
      if (fail) throw new Error('destination unavailable');
    },
  });
  await monitor.tick();
  await monitor.tick();
  await assert.rejects(() => monitor.tick(), /destination unavailable/);
  assert.equal(monitor.state().up, false);
  assert.equal(persisted!.pending!.length, 1);
  assert.equal(persisted!.lastNotification, undefined);
  fail = false;
  await monitor.tick();
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0]!.id, deliveries[1]!.id);
  assert.equal(persisted!.pending!.length, 0);
  assert.equal(persisted!.lastNotification, 'down');
});
test('restart retries pending downtime before recovery and acknowledges only successful sends', async () => {
  let persisted: MonitorState = {
    up: false,
    failures: 3,
    successes: 0,
    pending: [{ id: 'saved', event: 'down', at: 100, attempts: 2 }],
  };
  const events: string[] = [];
  const monitor = createUptimeMonitor({
    target: 'http://127.0.0.1/ready',
    initial: persisted,
    fetch: (async () => new Response('', { status: 200 })) as typeof fetch,
    persist: (state) => {
      persisted = state;
    },
    notify: async (event) => {
      events.push(event);
    },
  });
  await monitor.tick();
  await monitor.tick();
  assert.deepEqual(events, ['down', 'recovered']);
  assert.equal(persisted.pending!.length, 0);
  assert.equal(persisted.lastNotification, 'recovered');
});
test('pending transition snapshots are independent and bounded overflow is visibly summarized after service recovery', async () => {
  const pending = Array.from({ length: 32 }, (_, index) => ({
    id: String(index),
    event: (index % 2 ? 'recovered' : 'down') as 'down' | 'recovered',
    at: index,
    attempts: 0,
  }));
  let healthy = false,
    fail = true;
  const counts: number[] = [];
  const monitor = createUptimeMonitor({
    target: 'http://127.0.0.1/ready',
    initial: { up: true, failures: 2, successes: 0, pending },
    fetch: (async () => new Response('', { status: healthy ? 200 : 503 })) as typeof fetch,
    notify: async (_event, _at, delivery) => {
      if (fail) throw new Error('offline');
      counts.push(delivery.coalescedTransitions);
    },
  });
  await assert.rejects(() => monitor.tick());
  healthy = true;
  await assert.rejects(() => monitor.tick());
  await assert.rejects(() => monitor.tick());
  assert.equal(monitor.state().pending!.length, 32);
  assert.equal(monitor.state().overflow!.count, 2);
  const snapshot = monitor.state();
  snapshot.pending!.pop();
  assert.equal(monitor.state().pending!.length, 32);
  fail = false;
  for (let index = 0; index < 5; index++) await monitor.tick();
  assert.equal(monitor.state().pending!.length, 0);
  assert.ok(counts.includes(2));
  assert.equal(monitor.state().overflow, undefined);
});
test('an acknowledgement persistence failure retains the same pending transition for retry', async () => {
  let failAck = true;
  const ids: string[] = [];
  const monitor = createUptimeMonitor({
    target: 'http://127.0.0.1/ready',
    initial: {
      up: false,
      failures: 3,
      successes: 0,
      pending: [{ id: 'same', event: 'down', at: 1, attempts: 0 }],
    },
    fetch: (async () => new Response('', { status: 503 })) as typeof fetch,
    persist: (state) => {
      if (failAck && state.lastNotification === 'down' && !state.pending!.length)
        throw new Error('disk unavailable');
    },
    notify: async (_event, _at, delivery) => {
      ids.push(delivery.id);
    },
  });
  await assert.rejects(() => monitor.tick(), /disk unavailable/);
  assert.equal(monitor.state().pending!.length, 1);
  assert.equal(monitor.state().lastNotification, undefined);
  failAck = false;
  await monitor.tick();
  assert.deepEqual(ids, ['same', 'same']);
  assert.equal(monitor.state().pending!.length, 0);
});
