import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { voiceDeadline } from '../src/voice/deadline.js';

test('A stalled adapter releases its caller and cannot initiate a late send after its deadline', async () => {
  let release!: () => void;
  let sent = false;
  const queued = new Promise<void>((resolve) => {
    release = resolve;
  });
  const work = voiceDeadline(
    async (signal) => {
      await queued;
      signal.throwIfAborted();
      sent = true;
    },
    { timeoutMs: 10, message: 'Private delivery timed out.' },
  );
  // Keep the test loop alive: production also has the connected Discord client.
  await Promise.all([assert.rejects(work, /Private delivery timed out/), delay(20)]);
  release();
  await delay(0);
  assert.equal(sent, false);
});

test('Voice cancellation propagates through adapter queues and successful results remain usable', async () => {
  const controller = new AbortController();
  let invoked = false;
  const work = voiceDeadline(
    async () => {
      invoked = true;
      return new Promise<never>(() => {});
    },
    {
      signal: controller.signal,
      timeoutMs: 10000,
      message: 'timeout',
    },
  );
  controller.abort(new Error('Speaker revoked consent.'));
  await assert.rejects(work, /Speaker revoked consent/);
  assert.equal(invoked, false);
  assert.equal(await voiceDeadline(async () => 'sent', { timeoutMs: 100, message: 'timeout' }), 'sent');
});
