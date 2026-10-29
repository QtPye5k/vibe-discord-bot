import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { WorkerOptions } from 'node:worker_threads';
import {
  createLocalTranscriber,
  decodeLocalTranscriptionWav,
  type LocalTranscriptionWorker,
} from '../src/voice/local-transcriber.js';
import { inferLocalTranscript } from '../src/voice/local-transcriber-worker.js';
function wav(samples: number[], rate = 16000, channels = 1) {
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(channels, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * channels * 2, 28);
  data.writeUInt16LE(channels * 2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => data.writeInt16LE(sample, 44 + index * 2));
  return data;
}
class FakeWorker extends EventEmitter implements LocalTranscriptionWorker {
  messages: { type: string; id: number; audio?: Float32Array }[] = [];
  terminated = 0;
  postMessage(value: unknown, transfer: readonly ArrayBuffer[] = []) {
    this.messages.push(structuredClone(value, { transfer: [...transfer] }) as never);
  }
  async terminate() {
    this.terminated++;
    return 0;
  }
  ready() {
    this.emit('message', { type: 'ready' });
  }
  finish(text: string, type = 'result') {
    const current = this.messages.filter((item) => item.type === 'transcribe').at(-1)!;
    current.audio?.fill(0);
    this.emit('message', { type, id: current.id, text });
  }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(t: TestContext, overrides: { timeoutMs?: number; now?: () => number } = {}) {
  let worker: FakeWorker | undefined, settings: WorkerOptions | undefined;
  const service = createLocalTranscriber({
    cacheDir: '.cache/models',
    allowDownload: false,
    ...overrides,
    workerFactory: (_url, options) => {
      settings = options;
      worker = new FakeWorker();
      return worker;
    },
  });
  t.after(() => service.close());
  return {
    service,
    worker: () => worker!,
    settings: () => settings!,
    prepare: async () => {
      const ready = service.prepare();
      worker!.ready();
      await ready;
    },
  };
}
test('PCM16 WAV decoding preserves sign, mixes stereo, filters downsampling and supports mono upsampling', () => {
  const mono = decodeLocalTranscriptionWav(wav([-32768, 0, 32767]));
  assert.deepEqual([...mono], [-1, 0, 32767 / 32768]);
  const stereo = decodeLocalTranscriptionWav(wav([1000, -1000, 2000, -2000, 3000, -3000], 16000, 2));
  assert.deepEqual([...stereo], [0, 0, 0]);
  const down = decodeLocalTranscriptionWav(
    wav([0, 0, 3000, 3000, 6000, 6000, 9000, 9000, 12000, 12000, 15000, 15000], 48000, 2),
  );
  assert.deepEqual([...down], [3000 / 32768, 12000 / 32768]);
  const up = decodeLocalTranscriptionWav(wav([0, 32000], 8000));
  assert.deepEqual([...up], [0, 16000 / 32768, 32000 / 32768, 32000 / 32768]);
});
test('Malformed, compressed, misaligned, oversized and longer-than-15-second WAV input is rejected before worker creation', async (t) => {
  const f = fixture(t),
    badRate = wav([1, 2], 48001),
    compressed = wav([1, 2]);
  compressed.writeUInt16LE(3, 20);
  const truncated = wav([1, 2]);
  truncated.writeUInt32LE(truncated.length, 4);
  for (const data of [
    Buffer.from('bad'),
    badRate,
    compressed,
    truncated,
    wav([1, 2, 3], 16000, 2),
    Buffer.alloc(8 * 1024 * 1024 + 1),
    wav(Array(240001).fill(0)),
  ])
    await assert.rejects(() => f.service.transcribe(data), /WAV|15 seconds/);
  assert.equal(f.worker(), undefined);
});
test('The worker is lazy, prepares once, excludes API credentials and receives transferred mono Float32 audio', async (t) => {
  const f = fixture(t);
  assert.equal(f.worker(), undefined);
  const first = f.service.prepare(),
    second = f.service.prepare();
  assert.equal(first, second);
  f.worker().ready();
  await first;
  const settings = f.settings(),
    environment = settings.env as Record<string, string>;
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.DISCORD_TOKEN, undefined);
  assert.equal((settings.workerData as { allowDownload: boolean }).allowDownload, false);
  const input = wav([1, 2, 3, 4]),
    original = Buffer.from(input),
    result = f.service.transcribe(input);
  await tick();
  const received = f.worker().messages[0]!;
  assert(received.audio instanceof Float32Array);
  assert.equal(received.audio.length, 4);
  assert.deepEqual(input, original);
  f.worker().finish('  Vibe hello  ');
  assert.equal(await result, 'Vibe hello');
});
test('One active and four queued utterances are bounded; a fifth waiting request fails without accumulating audio', async (t) => {
  const f = fixture(t);
  await f.prepare();
  const results: Promise<string>[] = [];
  for (let index = 0; index < 5; index++) {
    const result = f.service.transcribe(wav([index + 1, 2, 3]));
    void result.catch(() => {});
    results.push(result);
    await tick();
  }
  assert.equal(f.worker().messages.filter((item) => item.type === 'transcribe').length, 1);
  await assert.rejects(() => f.service.transcribe(wav([9, 9, 9])), /busy/);
  for (let index = 0; index < 5; index++) {
    f.worker().finish(`turn-${index}`);
    await tick();
  }
  assert.deepEqual(await Promise.all(results), ['turn-0', 'turn-1', 'turn-2', 'turn-3', 'turn-4']);
});
test('Queued cancellation zeros its owned samples, active cancellation drops results, and remaining jobs resume serially', async (t) => {
  const f = fixture(t);
  await f.prepare();
  const original = Float32Array.prototype.fill,
    wiped: number[][] = [];
  t.mock.method(Float32Array.prototype, 'fill', function (this: Float32Array, value: number, ...args: []) {
    if (value === 0) wiped.push([...this]);
    return original.call(this, value, ...args);
  });
  const activeSignal = new AbortController(),
    queuedSignal = new AbortController(),
    active = f.service.transcribe(wav([1000, 2000, 3000]), activeSignal.signal),
    activeRejected = assert.rejects(active, /cancelled/);
  await tick();
  const queued = f.service.transcribe(wav([4000, 5000, 6000]), queuedSignal.signal),
    queuedRejected = assert.rejects(queued, /cancelled/);
  queuedSignal.abort();
  await queuedRejected;
  assert(wiped.some((samples) => samples[0] === 4000 / 32768));
  const next = f.service.transcribe(wav([7000, 8000, 9000]));
  activeSignal.abort();
  await activeRejected;
  assert(f.worker().messages.some((item) => item.type === 'cancel'));
  f.worker().finish('private cancelled words');
  await tick();
  f.worker().finish('next');
  assert.equal(await next, 'next');
});
test('Fifteen-second stale audio is discarded instead of creating a delayed conversation', async (t) => {
  let now = 1700000000000;
  const f = fixture(t, { now: () => now });
  await f.prepare();
  const active = f.service.transcribe(wav([1, 2, 3]));
  await tick();
  const queued = f.service.transcribe(wav([4, 5, 6]));
  now += 15001;
  f.worker().finish('current');
  assert.equal(await active, 'current');
  assert.equal(await queued, '');
  assert.equal(f.worker().messages.filter((item) => item.type === 'transcribe').length, 1);
});
test('Worker deadline/fatal failure rejects pending jobs without any remote transcription fallback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { timeoutMs: 1000 });
  await f.prepare();
  const active = f.service.transcribe(wav([1, 2, 3])),
    rejected = assert.rejects(active, /timed out/);
  await tick();
  const queued = f.service.transcribe(wav([4, 5, 6])),
    queueRejected = assert.rejects(queued, /timed out/);
  t.mock.timers.tick(1001);
  await rejected;
  await queueRejected;
  assert.equal(f.worker().terminated, 1);
  await assert.rejects(() => f.service.transcribe(wav([1, 2, 3])), /not uploaded/);
  const another = fixture(t),
    prepare = another.service.prepare(),
    failed = assert.rejects(prepare, /model could not load/);
  another.worker().emit('message', { type: 'fatal', error: 'PRIVATE_PATH_AND_CREDENTIAL' });
  await failed;
  assert.equal(another.worker().terminated, 1);
});
test('Closing during preparation or inference settles all callers and waits for worker termination', async (t) => {
  const f = fixture(t),
    preparing = f.service.prepare(),
    rejected = assert.rejects(preparing, /cancelled/);
  await f.service.close();
  await rejected;
  assert.equal(f.worker().terminated, 1);
  await f.service.close();
  assert.equal(f.worker().terminated, 1);
  const another = fixture(t);
  await another.prepare();
  const pending = another.service.transcribe(wav([1, 2, 3])),
    pendingRejected = assert.rejects(pending, /cancelled/);
  await tick();
  await another.service.close();
  await pendingRejected;
  await assert.rejects(() => another.service.transcribe(wav([1, 2, 3])), /closed/);
});
test('Close waits for an already failing worker and concurrent shutdown calls share termination', async (t) => {
  const f = fixture(t);
  await f.prepare();
  let stopped!: () => void;
  t.mock.method(
    f.worker(),
    'terminate',
    () =>
      new Promise<number>((resolve) => {
        stopped = () => resolve(0);
      }),
  );
  f.worker().emit('error', new Error('private native failure'));
  let firstDone = false,
    secondDone = false;
  const first = f.service.close().then(() => {
      firstDone = true;
    }),
    second = f.service.close().then(() => {
      secondDone = true;
    });
  await tick();
  assert.equal(firstDone, false);
  assert.equal(secondDone, false);
  stopped();
  await Promise.all([first, second]);
  assert.equal(firstDone, true);
  assert.equal(secondDone, true);
});
test('The actual worker inference adapter zeroes inputs on success, cancellation and failure', async () => {
  for (const mode of ['success', 'cancelled', 'failure']) {
    const audio = new Float32Array([0.5, -0.5]);
    const result = await inferLocalTranscript(
      async () => {
        assert.deepEqual([...audio], [0.5, -0.5]);
        if (mode === 'failure') throw new Error('PRIVATE_ERROR');
        return { text: 'Vibe' };
      },
      audio,
      () => mode === 'cancelled',
    );
    assert.equal(result.type, mode === 'success' ? 'result' : mode === 'cancelled' ? 'cancelled' : 'error');
    assert.deepEqual([...audio], [0, 0]);
    assert(!JSON.stringify(result).includes('PRIVATE_ERROR'));
  }
});
test('The worker drops marker-only hallucinations while preserving short addressed commands', async () => {
  for (const text of [
    '[BLANK_AUDIO] [BLANK_AUDIO]',
    '[shh]',
    '(blows kiss)',
    'Vibe',
    'confirm',
    'Vibe, join',
  ]) {
    const audio = new Float32Array([0.1, -0.1]),
      result = await inferLocalTranscript(
        async () => ({ text }),
        audio,
        () => false,
      );
    assert.deepEqual(result, {
      type: 'result',
      text: text.startsWith('[') || text.startsWith('(') ? '' : text,
    });
    assert.deepEqual([...audio], [0, 0]);
  }
});
