import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type WebSocket from 'ws';
import { createRealtimeVoice, type RealtimeSocket } from '../src/voice/realtime.js';
import type { ActionContext } from '../src/core/types.js';
import { toDiscordPcm } from '../src/features/voice.js';
import { prepareVoiceRuntime } from '../src/voice/runtime.js';

class FakeSocket extends EventEmitter implements RealtimeSocket {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  paused = 0;
  resumed = 0;
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  open() {
    this.readyState = 1;
    this.emit('open');
  }
  server(value: unknown) {
    this.emit('message', Buffer.from(JSON.stringify(value)));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.emit('close');
  }
  terminate() {
    this.close();
  }
  pause() {
    this.paused++;
  }
  resume() {
    this.resumed++;
  }
}
const ctx = (user = 'user', channel = 'text', voice = 'voice') =>
  ({
    guild: { id: 'guild' },
    member: { id: user, voice: { channelId: voice } },
    channelId: channel,
  }) as unknown as ActionContext;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(
  t: TestContext,
  overrides: { maxSessions?: number; now?: () => number; timeoutMs?: number } = {},
) {
  const sockets: FakeSocket[] = [],
    connections: { url: string; settings: WebSocket.ClientOptions }[] = [];
  const service = createRealtimeVoice({
    apiKey: 'fixture-key-not-real',
    model: 'gpt-realtime-2.1',
    voice: 'marin',
    botName: 'Vibe',
    maxOutputTokens: 256,
    ...overrides,
    socketFactory: (url, settings) => {
      connections.push({ url, settings });
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  t.after(() => service.close());
  async function start(context = ctx(), audio: (pcm: Uint8Array) => Promise<void> = async () => {}) {
    const controller = new AbortController(),
      promise = service.reply(context, 'Hello Vibe', { signal: controller.signal, audio }),
      socket = sockets.at(-1)!;
    if (socket.readyState === 0) {
      socket.open();
      socket.server({ type: 'session.updated' });
    }
    await tick();
    const request = socket.sent.filter((value) => value.type === 'response.create').at(-1)!;
    return {
      controller,
      promise,
      socket,
      id: (request.response as { metadata: { vibe_request_id: string } }).metadata.vibe_request_id,
    };
  }
  return { service, sockets, connections, start };
}
function created(socket: FakeSocket, requestId: string, response = 'response', item = 'output') {
  socket.server({
    type: 'response.created',
    response: { id: response, metadata: { vibe_request_id: requestId } },
  });
  socket.server({
    type: 'response.output_item.added',
    response_id: response,
    output_index: 0,
    item: { id: item, type: 'message', role: 'assistant' },
  });
}
function audio(
  socket: FakeSocket,
  bytes = Buffer.from([1, 0, 2, 0]),
  response = 'response',
  item = 'output',
) {
  socket.server({
    type: 'response.output_audio.delta',
    response_id: response,
    item_id: item,
    output_index: 0,
    content_index: 0,
    delta: bytes.toString('base64'),
  });
}
function done(socket: FakeSocket, response = 'response', text = 'Hi, I’m Vibe.') {
  socket.server({
    type: 'response.output_audio_transcript.done',
    response_id: response,
    item_id: 'output',
    output_index: 0,
    content_index: 0,
    transcript: text,
  });
  socket.server({ type: 'response.done', response: { id: response, status: 'completed' } });
}
test('Realtime requests wait for session readiness and use current audio-only 24kHz protocol without tool execution', async (t) => {
  const f = fixture(t),
    controller = new AbortController(),
    received: Uint8Array[] = [];
  const promise = f.service.reply(ctx(), 'Tell me something', {
    audio: async (data) => {
      received.push(data);
    },
    signal: controller.signal,
  });
  const socket = f.sockets[0]!;
  assert.equal(socket.sent.length, 0);
  socket.open();
  assert.equal(socket.sent[0]!.type, 'session.update');
  assert.equal(socket.sent.length, 1);
  const connection = f.connections[0]!;
  assert.equal(connection.url, 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1');
  assert.equal(connection.settings.followRedirects, false);
  assert.equal(connection.settings.maxPayload, 1048576);
  const session = socket.sent[0]!.session as Record<string, unknown>;
  assert.deepEqual(session.output_modalities, ['audio']);
  assert.deepEqual(session.tools, []);
  assert.equal(session.tool_choice, 'none');
  assert.deepEqual(session.audio, {
    input: { format: { type: 'audio/pcm', rate: 24000 }, turn_detection: null },
    output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'marin' },
  });
  socket.server({ type: 'session.updated' });
  await tick();
  assert.deepEqual(
    socket.sent.map((value) => value.type),
    ['session.update', 'conversation.item.create', 'response.create'],
  );
  const inputItem = socket.sent[1]!.item as { id: string };
  assert(inputItem.id.length <= 32);
  const request = socket.sent[2]!.response as { metadata: { vibe_request_id: string }; instructions: string };
  assert.match(request.instructions, /no external tools/i);
  created(socket, request.metadata.vibe_request_id);
  audio(socket);
  await tick();
  assert.equal(received.length, 1);
  done(socket);
  assert.equal((await promise).text, 'Hi, I’m Vibe.');
});
test('Audio is streamed before completion, callbacks serialize with backpressure, and final completion waits for delivery', async (t) => {
  const f = fixture(t),
    calls: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = await f.start(ctx(), async (data) => {
    calls.push(data[0]!);
    if (calls.length === 1) await gate;
  });
  created(active.socket, active.id);
  audio(active.socket, Buffer.from([1, 0]));
  audio(active.socket, Buffer.from([2, 0]));
  await tick();
  assert.deepEqual(calls, [1]);
  assert(active.socket.paused > 0);
  let settled = false;
  void active.promise.then(() => {
    settled = true;
  });
  done(active.socket);
  await tick();
  assert.equal(settled, false);
  release();
  assert.equal((await active.promise).text, 'Hi, I’m Vibe.');
  assert.deepEqual(calls, [1, 2]);
  assert(active.socket.resumed > 0);
});
test('Sessions are reused only for the same speaker and exact text/voice channel; clear forgets only that user', async (t) => {
  const f = fixture(t),
    first = await f.start();
  created(first.socket, first.id);
  audio(first.socket);
  done(first.socket);
  await first.promise;
  const second = await f.start();
  assert.equal(second.socket, first.socket);
  created(second.socket, second.id, 'next');
  audio(second.socket, undefined, 'next');
  done(second.socket, 'next');
  await second.promise;
  const other = await f.start(ctx('other'));
  assert.equal(f.sockets.length, 2);
  created(other.socket, other.id);
  audio(other.socket);
  done(other.socket);
  await other.promise;
  const moved = await f.start(ctx('user', 'text', 'another-voice'));
  assert.equal(f.sockets.length, 3);
  created(moved.socket, moved.id);
  audio(moved.socket);
  done(moved.socket);
  await moved.promise;
  f.service.clear('guild', 'user');
  assert(first.socket.closed);
  assert(moved.socket.closed);
  assert.equal(other.socket.closed, false);
  const fresh = await f.start();
  assert.notEqual(fresh.socket, first.socket);
  created(fresh.socket, fresh.id);
  audio(fresh.socket);
  done(fresh.socket);
  await fresh.promise;
});

test('forty turns across several minutes reuse and rotate Realtime sessions without a one-minute cutoff', async (t) => {
  let now = 1700000000000;
  const f = fixture(t, { now: () => now });
  for (let turn = 0; turn < 40; turn++) {
    now += 5000;
    const active = await f.start();
    created(active.socket, active.id);
    audio(active.socket);
    done(active.socket);
    assert.equal((await active.promise).text, 'Hi, I’m Vibe.');
  }
  assert.equal(f.sockets.length, 2, 'the 32-turn context rotation reconnects cleanly');
  assert.equal(f.sockets[0]!.closed, true);
  assert.equal(f.sockets[1]!.closed, false);
});

test('provider completion flushes queued audio and calls the PCM completion hook before resolving', async (t) => {
  const f = fixture(t),
    order: string[] = [];
  const controller = new AbortController(),
    response = f.service.reply(ctx(), 'Hello', {
      signal: controller.signal,
      audio: async () => {
        order.push('audio');
      },
      complete: async () => {
        order.push('complete');
      },
    });
  const socket = f.sockets[0]!;
  socket.open();
  socket.server({ type: 'session.updated' });
  await tick();
  const request = socket.sent.find((value) => value.type === 'response.create')!;
  created(socket, (request.response as { metadata: { vibe_request_id: string } }).metadata.vibe_request_id);
  audio(socket);
  done(socket);
  await response;
  assert.deepEqual(order, ['audio', 'complete']);
});
test('Unattributed or mismatched response/item audio cannot reach playback', async (t) => {
  const f = fixture(t),
    chunks: Uint8Array[] = [],
    active = await f.start(ctx(), async (data) => {
      chunks.push(data);
    });
  audio(active.socket);
  created(active.socket, 'wrong-request');
  audio(active.socket);
  created(active.socket, active.id);
  audio(active.socket, undefined, 'wrong-response');
  audio(active.socket, undefined, 'response', 'wrong-item');
  await tick();
  assert.equal(chunks.length, 0);
  audio(active.socket);
  done(active.socket);
  await active.promise;
  assert.equal(chunks.length, 1);
});
test('Aborting during connection or queued audio closes context and prevents later chunks without automatic retry', async (t) => {
  const f = fixture(t),
    controller = new AbortController(),
    connecting = f.service.reply(ctx(), 'Hi', {
      signal: controller.signal,
      audio: async () => {
        throw new Error('should not run');
      },
    }),
    rejected = assert.rejects(connecting, /cancelled/);
  controller.abort();
  await rejected;
  assert(f.sockets[0]!.closed);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    chunks: number[] = [];
  const active = await f.start(ctx(), async (data) => {
    chunks.push(data[0]!);
    await gate;
  });
  created(active.socket, active.id);
  audio(active.socket, Buffer.from([1, 0]));
  audio(active.socket, Buffer.from([2, 0]));
  await tick();
  const aborted = assert.rejects(active.promise, /cancelled/);
  active.controller.abort();
  await aborted;
  release();
  await tick();
  assert.deepEqual(chunks, [1]);
  assert.equal(f.sockets.length, 2);
  assert(active.socket.sent.some((value) => value.type === 'response.cancel'));
});
test('Provider failures remain sanitized, reject partial output without replay, and close sessions', async (t) => {
  const f = fixture(t),
    active = await f.start();
  created(active.socket, active.id);
  audio(active.socket);
  await tick();
  const rejected = assert.rejects(active.promise, (error) => {
    assert.match(String(error), /insufficient_quota/);
    assert.doesNotMatch(String(error), /PRIVATE_SECRET/);
    return true;
  });
  active.socket.server({ type: 'error', error: { code: 'insufficient_quota', message: 'PRIVATE_SECRET' } });
  await rejected;
  assert(active.socket.closed);
  assert.equal(f.sockets.length, 1);
});
test('Session admission, idle expiry and total request deadlines stay bounded', async (t) => {
  let time = 1700000000000;
  const f = fixture(t, { maxSessions: 1, now: () => time, timeoutMs: 1000 });
  const active = await f.start();
  await assert.rejects(
    () => f.service.reply(ctx(), 'Overlap', { signal: new AbortController().signal, audio: async () => {} }),
    /previous voice response/,
  );
  created(active.socket, active.id);
  audio(active.socket);
  done(active.socket);
  await active.promise;
  await assert.rejects(
    () =>
      f.service.reply(ctx('other'), 'No slot', {
        signal: new AbortController().signal,
        audio: async () => {},
      }),
    /session limit/,
  );
  time += 10 * 60000;
  const expired = await f.start(ctx('other'));
  assert(active.socket.closed);
  created(expired.socket, expired.id);
  audio(expired.socket);
  done(expired.socket);
  await expired.promise;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController(),
    waiting = f.service.reply(ctx('other'), 'Wait', { signal: controller.signal, audio: async () => {} }),
    rejected = assert.rejects(waiting, /timed out/);
  t.mock.timers.tick(1001);
  await rejected;
  assert(expired.socket.closed);
});
test('Invalid audio and excessive transcript output fail closed; no silent model retries occur', async (t) => {
  const f = fixture(t),
    first = await f.start();
  created(first.socket, first.id);
  const rejected = assert.rejects(first.promise, /invalid PCM/);
  first.socket.server({
    type: 'response.output_audio.delta',
    response_id: 'response',
    item_id: 'output',
    output_index: 0,
    content_index: 0,
    delta: 'bad!',
  });
  await rejected;
  const second = await f.start();
  created(second.socket, second.id);
  const textRejected = assert.rejects(second.promise, /transcript limit/);
  second.socket.server({
    type: 'response.output_audio_transcript.delta',
    response_id: 'response',
    item_id: 'output',
    output_index: 0,
    content_index: 0,
    delta: 'x'.repeat(16001),
  });
  await textRejected;
  assert.equal(f.sockets.length, 2);
});
test('Realtime PCM chunks feed the actual production resampler and installed Opus encoder/decoder', async (t) => {
  const f = fixture(t),
    chunks: Buffer[] = [],
    active = await f.start(ctx(), async (bytes) => {
      chunks.push(Buffer.from(bytes));
    }),
    pcm = Buffer.alloc(4800);
  for (let frame = 0; frame < 2400; frame++)
    pcm.writeInt16LE(Math.round(8000 * Math.sin((frame * 440 * 2 * Math.PI) / 24000)), frame * 2);
  created(active.socket, active.id);
  for (let offset = 0; offset < pcm.length; offset += 960)
    audio(active.socket, pcm.subarray(offset, offset + 960));
  done(active.socket);
  await active.promise;
  assert.deepEqual(Buffer.concat(chunks), pcm);
  const discord = toDiscordPcm(Buffer.concat(chunks), 24000, 1),
    { sdk, prism } = await prepareVoiceRuntime(),
    resource = sdk.createAudioResource(Readable.from([discord]), { inputType: sdk.StreamType.Raw }),
    decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 }),
    decoded: Buffer[] = [];
  let packets = 0;
  resource.playStream.on('data', () => {
    packets++;
  });
  resource.playStream.once('error', (error) => decoder.destroy(error));
  resource.playStream.pipe(decoder);
  try {
    for await (const bytes of decoder) decoded.push(bytes as Buffer);
    const output = Buffer.concat(decoded);
    assert.equal(packets, 5);
    assert.equal(output.length, 19200);
    let peak = 0;
    for (let offset = 0; offset < output.length; offset += 2)
      peak = Math.max(peak, Math.abs(output.readInt16LE(offset)));
    assert(peak > 500);
  } finally {
    resource.playStream.destroy();
    decoder.destroy();
  }
});
