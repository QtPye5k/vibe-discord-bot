import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { once } from 'node:events';
import test from 'node:test';
import prism from 'prism-media';
import {
  acousticVoiceActivity,
  ownVoiceRecordings,
  voiceRecording,
  eraseVoiceRecordings,
  saveVoiceRecording,
  pruneVoiceRecordings,
  type VoiceRecordingPolicy,
} from '../src/voice/recordings.js';
import type { ActionContext } from '../src/core/types.js';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import {
  VoiceService,
  decodeWav,
  pcmToWav,
  toDiscordPcm,
  type VoiceDriver,
  type VoiceHooks,
  type VoiceOptions,
  registerVoiceActions,
} from '../src/features/voice.js';

class FakeDriver implements VoiceDriver {
  played: Buffer[] = [];
  destroyed = 0;
  stopped = 0;
  cancelled = 0;
  received: string[] = [];
  chunks: ((pcm: Buffer) => void) | undefined;
  end: (() => void) | undefined;
  constructor(readonly hooks: VoiceHooks) {}
  play(pcm: Buffer): void {
    this.played.push(pcm);
  }
  pause(): boolean {
    return true;
  }
  resume(): boolean {
    return true;
  }
  stop(): void {
    this.stopped++;
    this.hooks.idle();
  }
  destroy(): void {
    this.destroyed++;
  }
  receive(userId: string, chunk: (pcm: Buffer) => void, end: () => void): () => void {
    this.received.push(userId);
    this.chunks = chunk;
    this.end = end;
    return () => {
      this.cancelled++;
    };
  }
}

function fixture(guildId = 'guild-a', userId = 'user-a', canViewTranscript = true) {
  const messages: unknown[] = [];
  const channelId = `voice-${guildId}`;
  const member = {
    id: userId,
    displayName: userId,
    user: { bot: false },
    voice: {
      channelId,
      channel: {
        id: channelId,
        guild: { id: guildId },
        name: 'Voice',
        isStageVoice: () => false,
        permissionsFor: () => ({ has: () => true }),
      },
    },
  };
  const guild = {
    id: guildId,
    members: { me: {}, fetch: async () => member },
    channels: {
      fetch: async () => ({
        guildId,
        isTextBased: () => true,
        permissionsFor: () => ({ has: () => canViewTranscript }),
        send: async (value: unknown) => {
          messages.push(value);
        },
      }),
    },
  };
  return {
    ctx: { guild, member, channelId: `text-${guildId}` } as unknown as ActionContext,
    messages,
    member,
  };
}

function service(options: VoiceOptions = {}) {
  const drivers: FakeDriver[] = [];
  const voice = new VoiceService({
    send: async (channel, payload, signal, current) => {
      signal.throwIfAborted();
      current?.();
      await channel.send(payload);
    },
    ...options,
    driverFactory: async (_channel, hooks) => {
      const driver = new FakeDriver(hooks);
      drivers.push(driver);
      return driver;
    },
  });
  return { voice, drivers };
}

test('Joining explains spoken replies and speech controls without starting capture before individual consent', async (t) => {
  const f = fixture(),
    { voice, drivers } = service();
  t.after(() => voice.close());
  const joined = await voice.join(f.ctx);
  assert.match(joined, /\/consent replies:true/);
  assert.match(joined, /\/speak text:/);
  assert.match(joined, /Each speaker must consent individually/);
  assert.deepEqual(drivers[0]!.received, []);
});

test('current-track volume is applied to the active transport without restarting the track', async (t) => {
  const f = fixture(),
    { voice, drivers } = service();
  t.after(() => voice.close());
  await voice.join(f.ctx);
  voice.enqueue(f.ctx, Buffer.alloc(3840), 'track');
  const updates: number[] = [];
  Object.assign(drivers[0]!, { setVolume: (value: number) => updates.push(value) });
  voice.volume(f.ctx, 0.25);
  assert.deepEqual(updates, [0.25]);
  assert.equal(drivers[0]!.played.length, 1);
});
test('music source references survive shutdown and restore only after current source reauthorization', async (t) => {
  const f = playlistFixture(),
    wav = pcmToWav(Buffer.alloc(48000 * 4)),
    first = service({ download: async () => wav }),
    second = service({ download: async () => wav });
  let denied: ReturnType<typeof service> | undefined;
  t.after(() => {
    first.voice.close();
    second.voice.close();
    denied?.voice.close();
    f.ctx.store.close();
  });
  await first.voice.join(f.ctx);
  await first.voice.playUploaded(f.ctx, '12345678901234567', 0);
  const saved = f.ctx.store.get<{ tracks: unknown[] }>('voice.queues', f.ctx.guild.id);
  assert.equal(saved?.tracks.length, 1);
  assert.doesNotMatch(JSON.stringify(saved), /"pcm"|"attachment":|base64|https:/);
  first.voice.close();
  await second.voice.join(f.ctx);
  await second.voice.restoreQueue(f.ctx);
  assert.equal(second.drivers[0]!.played.length, 1);
  second.voice.close();
  denied = service({ download: async () => wav });
  await denied.voice.join(f.ctx);
  f.revokeAccess();
  await assert.rejects(() => denied!.voice.restoreQueue(f.ctx), /History|history|source|view/);
  assert.deepEqual(denied.drivers[0]!.played, []);
});
test('seamless moves preserve the transport and discard old consent while expected bot Gateway moves do not destroy it', async (t) => {
  const f = fixture(),
    { voice, drivers } = service();
  f.ctx.store = new Store(':memory:');
  Object.assign(f.ctx, { client: { user: { id: 'test-bot' } } });
  t.after(() => {
    voice.close();
    f.ctx.store.close();
  });
  const target = {
    id: 'target-voice',
    guildId: f.ctx.guild.id,
    guild: f.ctx.guild,
    name: 'Target',
    type: 2,
    isVoiceBased: () => true,
    permissionsFor: () => ({ has: () => true }),
  };
  const text = {
    guildId: f.ctx.guild.id,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
  };
  f.ctx.guild.channels.fetch = (async (id: string) =>
    id === target.id ? target : text) as unknown as typeof f.ctx.guild.channels.fetch;
  await voice.join(f.ctx);
  Object.assign(drivers[0]!, {
    move: async () => {
      voice.memberLeft(f.ctx.guild.id, 'test-bot', target.id);
    },
  });
  await voice.move(f.ctx, target.id);
  assert.equal(drivers[0]!.destroyed, 0);
  f.member.voice.channelId = target.id;
  assert.equal((voice.status(f.ctx) as { channelId: string }).channelId, target.id);
});
test('energy VAD distinguishes actual PCM activity from silence and reports bounded acoustic metrics', () => {
  assert.equal(acousticVoiceActivity(Buffer.alloc(48000 * 4)).active, false);
  const signal = Buffer.alloc(48000 * 4);
  for (let i = 0; i < 48000; i++) {
    const value = Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / 48000));
    signal.writeInt16LE(value, i * 4);
    signal.writeInt16LE(value, i * 4 + 2);
  }
  const report = acousticVoiceActivity(signal);
  assert.equal(report.active, true);
  assert.equal(report.frames, 50);
  assert.ok(report.rmsDb > -30);
  assert.throws(() => acousticVoiceActivity(Buffer.alloc(3)), /PCM16/);
});
test('separate recording-only consent stores one speaker WAV without any transcription provider', async (t) => {
  const f = fixture(),
    store = new Store(':memory:');
  f.ctx.store = store;
  const { voice, drivers } = service({ store });
  t.after(() => {
    voice.close();
    store.close();
  });
  const policy: VoiceRecordingPolicy = {
    enabled: true,
    retentionHours: 1,
    maximumRecordings: 5,
    version: 'approved',
  };
  store.set('voice.recordingPolicy', f.ctx.guild.id, policy);
  await voice.join(f.ctx);
  voice.consent(f.ctx, true, false, false, false, undefined, true, true, false);
  const signal = Buffer.alloc(48000 * 2);
  for (let i = 0; i < signal.length / 2; i++) signal.writeInt16LE(Math.round(3000 * Math.sin(i / 10)), i * 2);
  drivers[0]!.hooks.speaking(f.ctx.member.id);
  drivers[0]!.chunks!(signal);
  drivers[0]!.end!();
  await voice.drain();
  const records = ownVoiceRecordings(store, f.ctx.guild.id, f.ctx.member.id);
  assert.equal(records.length, 1);
  const file = voiceRecording(store, f.ctx.guild.id, f.ctx.member.id, String(records[0]!.id));
  assert.ok(decodeWav(file.attachment).length > 0);
  assert.throws(
    () => voiceRecording(store, f.ctx.guild.id, 'other', String(records[0]!.id)),
    /another account/,
  );
  assert.equal(eraseVoiceRecordings(store, f.ctx.guild.id, f.ctx.member.id), 1);
  assert.equal(ownVoiceRecordings(store, f.ctx.guild.id, f.ctx.member.id).length, 0);
});
test('recording archives enforce policy versions, per-server capacity and expiration without loading other audio blobs', () => {
  const store = new Store(':memory:');
  try {
    const now = Date.now(),
      policy: VoiceRecordingPolicy = {
        enabled: true,
        retentionHours: 1,
        maximumRecordings: 1,
        version: 'current',
      };
    store.set('voice.recordingPolicy', 'guild', policy);
    const wav = pcmToWav(Buffer.alloc(4000));
    saveVoiceRecording(store, 'guild', 'user', 'text', wav, policy, now);
    assert.throws(() => saveVoiceRecording(store, 'guild', 'user', 'text', wav, policy, now), /full/);
    assert.throws(
      () => saveVoiceRecording(store, 'guild', 'other', 'text', wav, { ...policy, version: 'old' }, now),
      /policy changed/,
    );
    pruneVoiceRecordings(store, now + 3600001);
    assert.equal(ownVoiceRecordings(store, 'guild', 'user', now + 3600001).length, 0);
  } finally {
    store.close();
  }
});

test('recording erasure revokes active consent and invalidates an export waiting for source authorization', async (t) => {
  const f = fixture(),
    store = new Store(':memory:'),
    { voice } = service();
  f.ctx.store = store;
  t.after(() => {
    voice.close();
    store.close();
  });
  const policy: VoiceRecordingPolicy = {
    enabled: true,
    retentionHours: 1,
    maximumRecordings: 5,
    version: 'current',
  };
  store.set('voice.recordingPolicy', f.ctx.guild.id, policy);
  const saved = saveVoiceRecording(
    store,
    f.ctx.guild.id,
    f.ctx.member.id,
    f.ctx.channelId,
    pcmToWav(Buffer.alloc(4000)),
    policy,
  );
  await voice.join(f.ctx);
  voice.consent(f.ctx, true, false, false, false, undefined, false, true, false);
  const registry = new ActionRegistry(120, async (ctx) => ctx);
  registerVoiceActions(registry, voice);
  let release!: (value: typeof f.member) => void;
  const memberGate = new Promise<typeof f.member>((resolve) => {
    release = resolve;
  });
  f.ctx.guild.members.fetch = (() => memberGate) as unknown as typeof f.ctx.guild.members.fetch;
  const pending = registry.get('voice.recordings.export').execute(f.ctx, { id: saved.id });
  const rejected = assert.rejects(Promise.resolve(pending), /expired|another account/);
  await registry.get('voice.recordings.erase').execute(f.ctx, {});
  release(f.member);
  await rejected;
  assert.equal((voice.status(f.ctx) as { consentingSpeakers: number }).consentingSpeakers, 0);
  assert.equal(ownVoiceRecordings(store, f.ctx.guild.id, f.ctx.member.id).length, 0);
});

test('PCM16 WAV validation rejects corruption, compressed formats and duration overruns', () => {
  const pcm = Buffer.alloc(48_000 * 4);
  assert.deepEqual(decodeWav(pcmToWav(pcm)), pcm);
  assert.throws(() => decodeWav(Buffer.from('malformed')), /valid PCM16 WAV/);
  const corrupt = pcmToWav(pcm);
  corrupt.writeUInt32LE(corrupt.length, 4);
  assert.throws(() => decodeWav(corrupt), /malformed/);
  const compressed = pcmToWav(pcm);
  compressed.writeUInt16LE(3, 20);
  assert.throws(() => decodeWav(compressed), /uncompressed PCM16/);
  assert.throws(() => decodeWav(pcmToWav(pcm), 0.5), /second limit/);
  assert.throws(() => pcmToWav(Buffer.alloc(15 * 48_000 * 4 + 4)), /oversized/);
});

test('PCM conversion duplicates mono channels, preserves sample amplitudes and bounds allocation', () => {
  const source = Buffer.alloc(4);
  source.writeInt16LE(-1234);
  source.writeInt16LE(5678, 2);
  const stereo = toDiscordPcm(source, 24_000, 1);
  assert.equal(stereo.length, 16);
  assert.equal(stereo.readInt16LE(0), -1234);
  assert.equal(stereo.readInt16LE(2), -1234);
  assert.equal(stereo.readInt16LE(12), 5678);
  assert.throws(() => toDiscordPcm(Buffer.alloc(3), 24_000, 1), /Invalid/);
  assert.throws(() => toDiscordPcm(Buffer.alloc(48_000 * 4 * 2), 48_000, 2, 1), /second limit/);
});

test('installed Opus codec encodes and decodes an actual Discord-sized PCM frame', async () => {
  const encoder = new prism.opus.Encoder({ rate: 48_000, channels: 2, frameSize: 960 });
  const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
  const decoded: Buffer[] = [];
  decoder.on('data', (data: Buffer) => decoded.push(data));
  const finished = once(decoder, 'end');
  encoder.pipe(decoder);
  encoder.end(Buffer.alloc(960 * 4));
  await finished;
  assert.equal(Buffer.concat(decoded).length, 960 * 4);
});

test('voice queues are isolated by server and bounded; stop and leave release all tracks', async (t) => {
  const { voice, drivers } = service();
  t.after(() => voice.close());
  const a = fixture('a').ctx,
    b = fixture('b').ctx;
  await voice.join(a);
  await voice.join(b);
  const audio = Buffer.alloc(400);
  voice.enqueue(a, audio, 'first');
  voice.enqueue(a, audio, 'second');
  voice.enqueue(b, audio, 'other guild');
  assert.equal(drivers[0]!.played.length, 1);
  assert.equal(drivers[1]!.played.length, 1);
  drivers[0]!.hooks.idle();
  assert.equal(drivers[0]!.played.length, 2);
  for (let i = 0; i < 5; i++) voice.enqueue(a, audio, `waiting ${i}`);
  assert.throws(() => voice.enqueue(a, audio, 'overflow'), /full/);
  voice.stop(a);
  drivers[0]!.hooks.idle();
  assert.equal(drivers[0]!.played.length, 2);
  assert.equal(drivers[1]!.destroyed, 0);
  voice.leave(a);
  assert.equal(drivers[0]!.destroyed, 1);
  assert.throws(() => voice.status(a), /not connected/);
});

test('voice controls reject users in a different channel and invalid volume', async (t) => {
  const { voice } = service();
  t.after(() => voice.close());
  const { ctx, member } = fixture();
  await voice.join(ctx);
  member.voice.channelId = 'another-channel';
  assert.throws(() => voice.stop(ctx), /same voice channel/);
  member.voice.channelId = 'voice-guild-a';
  assert.throws(() => voice.volume(ctx, Infinity), /between/);
  assert.throws(() => voice.volume(ctx, 1.1), /between/);
});

test('voice session caps count connected and joining guilds, free slots on leave and reject invalid configuration', async (t) => {
  for (const maxSessions of [0, -1, 21, 1.5, Infinity])
    assert.throws(() => new VoiceService({ maxSessions }), /1 to 20/);
  const { voice } = service({ maxSessions: 1 });
  t.after(() => voice.close());
  const first = fixture('first').ctx,
    second = fixture('second').ctx;
  await voice.join(first);
  await assert.rejects(voice.join(second), /session limit/);
  voice.leave(first);
  await voice.join(second);
  let release!: (driver: VoiceDriver) => void, hooks!: VoiceHooks;
  const pendingVoice = new VoiceService({
    maxSessions: 1,
    driverFactory: async (_channel, value) => {
      hooks = value;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  t.after(() => pendingVoice.close());
  const pending = pendingVoice.join(first);
  await assert.rejects(pendingVoice.join(second), /session limit/);
  pendingVoice.close();
  release(new FakeDriver(hooks));
  await assert.rejects(pending, /cancelled/);
});

test('audio is captured only after individual consent and revoked on channel departure', async (t) => {
  const { voice, drivers } = service({ transcribe: async () => 'hello' });
  t.after(() => voice.close());
  const { ctx } = fixture();
  await voice.join(ctx);
  const driver = drivers[0]!;
  driver.hooks.speaking(ctx.member.id);
  assert.deepEqual(driver.received, []);
  voice.consent(ctx, true);
  driver.hooks.speaking('other-user');
  assert.deepEqual(driver.received, []);
  driver.hooks.speaking(ctx.member.id);
  assert.deepEqual(driver.received, [ctx.member.id]);
  voice.memberLeft(ctx.guild.id, ctx.member.id, null);
  assert.equal(driver.cancelled, 1);
  driver.hooks.speaking(ctx.member.id);
  assert.equal(driver.received.length, 1);
});

test('enabling consent requires the disclosed transcript channel and module disable stops capture', async (t) => {
  const { voice, drivers } = service({ transcribe: async () => 'hello' });
  t.after(() => voice.close());
  const { ctx } = fixture();
  ctx.store = new Store(':memory:');
  t.after(() => ctx.store.close());
  await voice.join(ctx);
  assert.throws(
    () => voice.consent({ ...ctx, channelId: 'other-text-channel' }, true),
    /transcript destination/,
  );
  voice.consent(ctx, true);
  ctx.store.set('core.disabled', ctx.guild.id, ['voice']);
  drivers[0]!.hooks.speaking(ctx.member.id);
  assert.deepEqual(drivers[0]!.received, []);
  voice.disableGuild(ctx.guild.id);
  assert.equal(drivers[0]!.destroyed, 1);
  assert.match(voice.consent(ctx, false), /inactive/);
});

test('stopped speech releases its generation lock and a late old completion cannot unlock newer speech', async (t) => {
  const pending: ((value: Buffer) => void)[] = [];
  const { voice, drivers } = service({
    speech: () => new Promise<Buffer>((resolve) => pending.push(resolve)),
  });
  t.after(() => voice.close());
  const { ctx } = fixture();
  await voice.join(ctx);
  const old = voice.speak(ctx, 'Old request');
  await tick();
  assert.equal(pending.length, 1);
  voice.stop(ctx);
  const current = voice.speak(ctx, 'New request');
  await tick();
  assert.equal(pending.length, 2);
  pending[0]!(Buffer.alloc(4800));
  await assert.rejects(old, /cancelled/);
  assert.equal((voice.status(ctx) as { speechPending: boolean }).speechPending, true);
  await assert.rejects(voice.speak(ctx, 'Overlapping request'), /already being generated/);
  pending[1]!(Buffer.alloc(4800));
  await current;
  assert.equal((voice.status(ctx) as { speechPending: boolean }).speechPending, false);
  assert.equal(drivers[0]!.played.length, 1);
});

test('revoking consent discards a transcription already in flight', async (t) => {
  let resolve!: (value: string) => void;
  let requests = 0;
  const pending = new Promise<string>((done) => {
    resolve = done;
  });
  const { voice, drivers } = service({
    transcribe: async () => {
      requests++;
      return pending;
    },
  });
  t.after(() => voice.close());
  const { ctx, messages } = fixture();
  await voice.join(ctx);
  voice.consent(ctx, true);
  const driver = drivers[0]!;
  driver.hooks.speaking(ctx.member.id);
  driver.chunks!(Buffer.alloc(48_000 * 4));
  driver.end!();
  await tick();
  assert.equal(requests, 1);
  voice.consent(ctx, false);
  resolve('private words');
  await tick();
  await tick();
  assert.deepEqual(messages, []);
});

test('transcription never uploads audio when speaker cannot view the disclosed transcript destination', async (t) => {
  let requests = 0;
  const { voice, drivers } = service({
    transcribe: async () => {
      requests++;
      return 'private';
    },
  });
  t.after(() => voice.close());
  const { ctx, messages, member } = fixture('private-guild', 'speaker', false);
  await voice.join(ctx);
  voice.consent(ctx, true);
  const driver = drivers[0]!;
  driver.hooks.speaking(ctx.member.id);
  driver.chunks!(Buffer.alloc(48_000 * 4));
  driver.end!();
  await tick();
  await tick();
  assert.equal(requests, 0);
  assert.deepEqual(messages, []);
  member.voice.channelId = 'different-channel';
  assert.match(voice.consent(ctx, false), /revoked/);
});

test('consent expires and bounds one capture and one processing operation per guild', async (t) => {
  let now = 1000,
    requests = 0;
  const { voice, drivers } = service({
    now: () => now,
    transcribe: async (_ctx, wav) => {
      requests++;
      assert.ok(wav.length <= 15 * 48_000 * 4 + 44);
      return 'bounded';
    },
  });
  t.after(() => voice.close());
  const { ctx, messages } = fixture();
  await voice.join(ctx);
  voice.consent(ctx, true);
  const driver = drivers[0]!;
  driver.hooks.speaking(ctx.member.id);
  driver.hooks.speaking(ctx.member.id);
  assert.equal(driver.received.length, 1);
  driver.chunks!(Buffer.alloc(14 * 48_000 * 4));
  driver.chunks!(Buffer.alloc(2 * 48_000 * 4));
  driver.hooks.speaking(ctx.member.id);
  await tick();
  await tick();
  assert.equal(requests, 1);
  assert.equal(messages.length, 1);
  now += 10 * 60_000 + 1;
  driver.hooks.speaking(ctx.member.id);
  assert.equal(driver.received.length, 1);
});

test('disconnect clears consent/capture and destroys the transport exactly once', async (t) => {
  const { voice, drivers } = service({ transcribe: async () => 'hello' });
  t.after(() => voice.close());
  const { ctx } = fixture();
  await voice.join(ctx);
  voice.consent(ctx, true);
  const driver = drivers[0]!;
  driver.hooks.speaking(ctx.member.id);
  driver.hooks.disconnected();
  driver.hooks.disconnected();
  assert.equal(driver.destroyed, 1);
  assert.equal(driver.cancelled, 1);
  assert.throws(() => voice.status(ctx), /not connected/);
});

test('stop invalidates delayed speech generation, preventing stale playback', async (t) => {
  let resolve!: (value: Uint8Array) => void;
  const { voice, drivers } = service({
    speech: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  t.after(() => voice.close());
  const { ctx } = fixture();
  await voice.join(ctx);
  const pending = voice.speak(ctx, 'hello');
  await tick();
  voice.stop(ctx);
  resolve(Buffer.alloc(48_000));
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(drivers[0]!.played, []);
});

test('close during asynchronous join destroys the new transport and rejects joining', async () => {
  let resolve!: (driver: VoiceDriver) => void;
  let hooks!: VoiceHooks;
  const voice = new VoiceService({
    driverFactory: async (_channel, value) => {
      hooks = value;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const pending = voice.join(fixture().ctx);
  voice.close();
  const driver = new FakeDriver(hooks);
  resolve(driver);
  await assert.rejects(pending, /cancelled/);
  assert.equal(driver.destroyed, 1);
});

test('shutdown drain waits for pending AI speech while preventing playback', async () => {
  let resolve!: (value: Uint8Array) => void;
  const { voice, drivers } = service({
    speech: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const { ctx } = fixture();
  await voice.join(ctx);
  const pending = voice.speak(ctx, 'hello');
  // Attach rejection handling before resolving the adapter, as a real command router would.
  const rejection = assert.rejects(pending, /cancelled/);
  await tick();
  voice.close();
  let drained = false;
  const drain = voice.drain().then(() => {
    drained = true;
  });
  await tick();
  assert.equal(drained, false);
  resolve(Buffer.alloc(48_000));
  await drain;
  await rejection;
  assert.equal(drivers[0]!.destroyed, 1);
  assert.deepEqual(drivers[0]!.played, []);
});

function playlistFixture() {
  const setup = fixture();
  setup.ctx.store = new Store(':memory:');
  let access = true;
  const channel = {
    guildId: setup.ctx.guild.id,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => access }),
    messages: {
      fetch: async (id: string) => ({
        id,
        attachments: new Map([
          [
            'file',
            { name: 'track.wav', size: 4044, url: 'https://cdn.discordapp.com/attachments/1/2/track.wav' },
          ],
        ]),
      }),
    },
  };
  (setup.ctx.guild.channels as unknown as { fetch: () => Promise<unknown> }).fetch = async () => channel;
  return {
    ...setup,
    revokeAccess: () => {
      access = false;
    },
  };
}
const playlistInput = { name: 'favorites', tracks: [{ messageId: '12345678901234567' }] };
test('voice actions include strict personal playlists, durable queues and explicit recording/meeting consent', () => {
  const voice = new VoiceService(),
    registry = new ActionRegistry();
  try {
    registerVoiceActions(registry, voice);
    assert.ok(registry.list().length >= 28);
    for (const id of [
      'voice.move',
      'voice.stream',
      'voice.queue.saved',
      'voice.queue.restore',
      'voice.recordings.export',
      'voice.recordings.erase',
    ])
      assert.ok(registry.get(id));
    const consent = registry.get('voice.consent').schema.parse({ enabled: true });
    assert.deepEqual(consent, {
      enabled: true,
      replies: false,
      meetings: false,
      commands: false,
      vad: false,
      recording: false,
      transcription: true,
    });
    assert.throws(() =>
      registry.get('voice.playlist-save').schema.parse({ name: '../escape', tracks: playlistInput.tracks }),
    );
    assert.throws(() =>
      registry
        .get('voice.playlist-save')
        .schema.parse({ ...playlistInput, tracks: Array(6).fill(playlistInput.tracks[0]) }),
    );
  } finally {
    voice.close();
  }
});
test('personal playlist persistence stores bounded message references and reauthorizes playback', async (t) => {
  const setup = playlistFixture();
  let downloads = 0;
  const { voice, drivers } = service({
    download: async () => {
      downloads++;
      return pcmToWav(Buffer.alloc(4000));
    },
  });
  t.after(async () => {
    voice.close();
    await voice.drain();
    setup.ctx.store.close();
  });
  await voice.savePlaylist(setup.ctx, playlistInput);
  assert.equal(downloads, 1);
  const records = setup.ctx.store.list('voice.playlists');
  assert.equal(records.length, 1);
  assert.doesNotMatch(JSON.stringify(records), /"attachment":|"pcm":|https:/);
  assert.deepEqual(
    (voice.playlists(setup.ctx) as { name: string; tracks: number }[]).map((value) => [
      value.name,
      value.tracks,
    ]),
    [['favorites', 1]],
  );
  assert.deepEqual(
    voice.playlists({ ...setup.ctx, member: { ...setup.ctx.member, id: 'someone-else' } } as ActionContext),
    [],
  );
  await voice.join(setup.ctx);
  await voice.playPlaylist(setup.ctx, 'favorites');
  assert.equal(downloads, 2);
  assert.equal(drivers[0]!.played.length, 1);
  setup.revokeAccess();
  await assert.rejects(voice.playPlaylist(setup.ctx, 'favorites'), /view|History/);
  assert.equal(downloads, 2);
  voice.removePlaylist(setup.ctx, 'favorites');
  assert.deepEqual(voice.playlists(setup.ctx), []);
});
test('playlist enqueue is atomic when existing queue cannot fit and stop cancels delayed playback', async (t) => {
  const setup = playlistFixture();
  let release: ((value: Buffer) => void) | undefined,
    delay = false;
  const { voice, drivers } = service({
    download: async () =>
      delay
        ? new Promise<Buffer>((resolve) => {
            release = resolve;
          })
        : pcmToWav(Buffer.alloc(4000)),
  });
  t.after(async () => {
    voice.close();
    await voice.drain();
    setup.ctx.store.close();
  });
  await voice.savePlaylist(setup.ctx, { ...playlistInput, tracks: Array(5).fill(playlistInput.tracks[0]) });
  await voice.join(setup.ctx);
  for (let i = 0; i < 3; i++) voice.enqueue(setup.ctx, Buffer.alloc(400), 'existing');
  await assert.rejects(voice.playPlaylist(setup.ctx, 'favorites'), /queue is full/);
  assert.equal((voice.status(setup.ctx) as { queue: string[] }).queue.length, 2);
  assert.equal(drivers[0]!.played.length, 1);
  voice.stop(setup.ctx);
  voice.removePlaylist(setup.ctx, 'favorites');
  await voice.savePlaylist(setup.ctx, playlistInput);
  delay = true;
  const pending = voice.playPlaylist(setup.ctx, 'favorites');
  await tick();
  voice.stop(setup.ctx);
  release!(pcmToWav(Buffer.alloc(4000)));
  await assert.rejects(pending, /cancelled/);
  assert.equal(drivers[0]!.played.length, 1);
});
test('direct uploaded playback is tracked for shutdown and stop prevents late enqueue', async (t) => {
  const setup = playlistFixture();
  let release!: (value: Buffer) => void;
  const { voice, drivers } = service({
    download: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  t.after(async () => {
    voice.close();
    await voice.drain();
    setup.ctx.store.close();
  });
  await voice.join(setup.ctx);
  const pending = voice.playUploaded(setup.ctx, playlistInput.tracks[0]!.messageId, 0);
  await tick();
  voice.stop(setup.ctx);
  release(pcmToWav(Buffer.alloc(4000)));
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(drivers[0]!.played, []);
});
async function utterance(driver: FakeDriver, userId: string) {
  driver.hooks.speaking(userId);
  driver.chunks!(Buffer.alloc(40000));
  driver.end!();
  for (let i = 0; i < 5; i++) await tick();
}
test('meeting summaries include only explicitly opted-in current excerpts and stay within the disclosed text scope', async (t) => {
  const received: string[] = [];
  const { voice, drivers } = service({
    transcribe: async () => 'consented words',
    summarize: async (_ctx, text) => {
      received.push(text);
      return 'summary';
    },
  });
  t.after(() => voice.close());
  const { ctx } = fixture();
  await voice.join(ctx);
  voice.consent(ctx, true);
  await utterance(drivers[0]!, ctx.member.id);
  await assert.rejects(voice.summarizeMeeting(ctx), /No current/);
  assert.deepEqual(received, []);
  voice.consent(ctx, true, false, true);
  await utterance(drivers[0]!, ctx.member.id);
  await assert.rejects(voice.summarizeMeeting({ ...ctx, channelId: 'other-text' }), /disclosed/);
  assert.deepEqual(received, []);
  const result = await voice.summarizeMeeting(ctx);
  assert.equal(result.attachment.toString(), 'summary');
  assert.match(received[0]!, /user-a: consented words/);
  voice.consent(ctx, false);
  await assert.rejects(voice.summarizeMeeting(ctx), /No current/);
});
test('meeting summary output is discarded after stop, revoke, leave, disabled module, or lost text history access', async (t) => {
  for (const change of ['stop', 'revoke', 'leave', 'disable', 'history'] as const) {
    let resolve!: (value: string) => void;
    const { voice, drivers } = service({
      transcribe: async () => 'private words',
      summarize: async () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const setup = fixture();
    let history = true;
    (setup.ctx.guild.channels as unknown as { fetch: () => Promise<unknown> }).fetch = async () => ({
      guildId: setup.ctx.guild.id,
      isTextBased: () => true,
      permissionsFor: () => ({ has: () => history }),
      send: async () => {},
    });
    t.after(() => voice.close());
    await voice.join(setup.ctx);
    voice.consent(setup.ctx, true, false, true);
    await utterance(drivers[0]!, setup.ctx.member.id);
    const pending = voice.summarizeMeeting(setup.ctx);
    for (let i = 0; i < 5 && !resolve; i++) await tick();
    assert.ok(resolve);
    if (change === 'stop') voice.stop(setup.ctx);
    else if (change === 'revoke') voice.consent(setup.ctx, false);
    else if (change === 'leave') voice.memberLeft(setup.ctx.guild.id, setup.ctx.member.id, null);
    else if (change === 'disable') voice.disableGuild(setup.ctx.guild.id);
    else history = false;
    resolve('must be discarded');
    await assert.rejects(pending, /cancelled|view|History/);
  }
});
test('meeting excerpt memory is bounded and expired consent removes it before another provider call', async (t) => {
  let now = 1,
    size = 0,
    requests = 0;
  const { voice, drivers } = service({
    now: () => now,
    transcribe: async () => 'x'.repeat(3000),
    summarize: async (_ctx, text) => {
      requests++;
      size = text.length;
      return 'bounded';
    },
  });
  t.after(() => voice.close());
  const { ctx } = fixture();
  await voice.join(ctx);
  voice.consent(ctx, true, false, true);
  for (let i = 0; i < 10; i++) await utterance(drivers[0]!, ctx.member.id);
  await voice.summarizeMeeting(ctx);
  assert.ok(size <= 6000 && size > 0);
  assert.ok(((await voice.meetingStatus(ctx)) as { retainedSegments: number }).retainedSegments < 10);
  now += 600001;
  await assert.rejects(voice.summarizeMeeting(ctx), /No current/);
  assert.equal(requests, 1);
});

test('voice commands require explicit separate consent and return reviewed payloads in the disclosed text channel', async (t) => {
  const calls: { ctx: ActionContext; text: string }[] = [];
  const { voice, drivers } = service({
    transcribe: async () => 'pause playback',
    onTranscript: async (ctx, text) => {
      calls.push({ ctx, text });
      return { content: 'Review this voice action', allowedMentions: { parse: ['everyone'] } };
    },
  });
  t.after(() => voice.close());
  const setup = fixture();
  await voice.join(setup.ctx);
  voice.consent(setup.ctx, true);
  await utterance(drivers[0]!, setup.ctx.member.id);
  assert.equal(calls.length, 0);
  const disclosure = voice.consent(setup.ctx, true, false, false, true);
  assert.match(disclosure, /allowlisted voice commands/);
  assert.match(disclosure, /OpenAI/);
  assert.match(disclosure, /same action checks as text/);
  await utterance(drivers[0]!, setup.ctx.member.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.ctx.member.id, setup.ctx.member.id);
  assert.equal(calls[0]!.ctx.channelId, setup.ctx.channelId);
  assert.equal(calls[0]!.text, 'pause playback');
  assert.deepEqual(setup.messages.at(-1), {
    content: 'Review this voice action',
    allowedMentions: { parse: [] },
  });
});

test('delayed command confirmation payloads are discarded after stop, revoke, departure, disable or lost history', async (t) => {
  for (const change of ['stop', 'revoke', 'leave', 'disable', 'history'] as const) {
    let release!: (value: { content: string }) => void;
    const { voice, drivers } = service({
      transcribe: async () => 'requested action',
      onTranscript: async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    t.after(() => voice.close());
    const setup = fixture();
    let access = true;
    (setup.ctx.guild.channels as unknown as { fetch: () => Promise<unknown> }).fetch = async () => ({
      guildId: setup.ctx.guild.id,
      isTextBased: () => true,
      permissionsFor: () => ({ has: () => access }),
      send: async (value: unknown) => {
        setup.messages.push(value);
      },
    });
    await voice.join(setup.ctx);
    voice.consent(setup.ctx, true, false, false, true);
    await utterance(drivers[0]!, setup.ctx.member.id);
    assert.ok(release);
    if (change === 'stop') voice.stop(setup.ctx);
    if (change === 'revoke') voice.consent(setup.ctx, false);
    if (change === 'leave') voice.memberLeft(setup.ctx.guild.id, setup.ctx.member.id, null);
    if (change === 'disable') voice.disableGuild(setup.ctx.guild.id);
    if (change === 'history') access = false;
    release({ content: 'must not post' });
    await voice.drain();
    assert.equal(setup.messages.length, 1, change);
  }
});

test('spoken translation is explicitly consented, bounded, displayed without mentions and synthesized from translated text', async (t) => {
  const translated: string[] = [],
    spoken: string[] = [];
  const { voice, drivers } = service({
    transcribe: async () => 'hello',
    translate: async (_ctx, text, language) => {
      translated.push(`${language}:${text}`);
      return 'hola @everyone';
    },
    speech: async (_ctx, text) => {
      spoken.push(text);
      return Buffer.alloc(4800);
    },
  });
  t.after(() => voice.close());
  const setup = fixture();
  await voice.join(setup.ctx);
  const disclosure = voice.consent(setup.ctx, true, false, false, false, 'es');
  assert.match(disclosure, /translation and synthetic speech in es/);
  assert.match(disclosure, /transcripts and translated text/);
  await utterance(drivers[0]!, setup.ctx.member.id);
  await voice.drain();
  assert.deepEqual(translated, ['es:hello']);
  assert.deepEqual(spoken, ['hola @everyone']);
  assert.equal(setup.messages.length, 2);
  assert.equal(drivers[0]!.played.length, 1);
  assert.deepEqual((setup.messages[1] as { allowedMentions: unknown }).allowedMentions, { parse: [] });
  voice.consent(setup.ctx, false);
  assert.equal(drivers[0]!.stopped, 1);
  assert.equal((voice.status(setup.ctx) as { playing: unknown }).playing, null);
});

test('translation responses are discarded before posting or speech upload after consent/session/history changes', async (t) => {
  for (const change of ['stop', 'revoke', 'renew', 'leave', 'disable', 'history', 'move'] as const) {
    let release!: (value: string) => void,
      speech = 0;
    const { voice, drivers } = service({
      transcribe: async () => 'private words',
      translate: async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      speech: async () => {
        speech++;
        return Buffer.alloc(4800);
      },
    });
    t.after(() => voice.close());
    const setup = fixture();
    let access = true;
    (setup.ctx.guild.channels as unknown as { fetch: () => Promise<unknown> }).fetch = async () => ({
      guildId: setup.ctx.guild.id,
      isTextBased: () => true,
      permissionsFor: () => ({ has: () => access }),
      send: async (value: unknown) => {
        setup.messages.push(value);
      },
    });
    await voice.join(setup.ctx);
    voice.consent(setup.ctx, true, false, false, false, 'fr');
    await utterance(drivers[0]!, setup.ctx.member.id);
    assert.ok(release);
    if (change === 'stop') voice.stop(setup.ctx);
    if (change === 'revoke') voice.consent(setup.ctx, false);
    if (change === 'renew') voice.consent(setup.ctx, true, false, false, false, 'fr');
    if (change === 'leave') voice.memberLeft(setup.ctx.guild.id, setup.ctx.member.id, null);
    if (change === 'disable') voice.disableGuild(setup.ctx.guild.id);
    if (change === 'history') access = false;
    if (change === 'move') setup.member.voice.channelId = 'other';
    release('must be discarded');
    await voice.drain();
    assert.equal(setup.messages.length, 1, change);
    assert.equal(speech, 0, change);
    assert.deepEqual(drivers[0]!.played, [], change);
  }
});

test('consented speech already being generated is discarded on revocation and removed from a waiting queue', async (t) => {
  for (const queued of [false, true]) {
    let release!: (value: Uint8Array) => void;
    const { voice, drivers } = service({
      transcribe: async () => 'hello',
      translate: async () => 'hola',
      speech: async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    t.after(() => voice.close());
    const setup = fixture();
    await voice.join(setup.ctx);
    voice.consent(setup.ctx, true, false, false, false, 'es');
    await utterance(drivers[0]!, setup.ctx.member.id);
    assert.ok(release);
    if (queued) voice.enqueue(setup.ctx, Buffer.alloc(400), 'unrelated audio');
    if (!queued) voice.consent(setup.ctx, false);
    release(Buffer.alloc(4800));
    await voice.drain();
    if (queued) {
      assert.equal((voice.status(setup.ctx) as { queue: string[] }).queue.length, 1);
      voice.consent(setup.ctx, false);
      assert.equal((voice.status(setup.ctx) as { queue: string[] }).queue.length, 0);
      drivers[0]!.hooks.idle();
    }
    assert.equal(drivers[0]!.played.length, queued ? 1 : 0);
  }
});

test('voice consent schemas reject unsupported languages and unavailable optional command/translation adapters', async (t) => {
  const { voice } = service({ transcribe: async () => 'words' });
  t.after(() => voice.close());
  const setup = fixture();
  await voice.join(setup.ctx);
  assert.throws(() => voice.consent(setup.ctx, true, false, false, true), /not configured/);
  assert.throws(() => voice.consent(setup.ctx, true, false, false, false, 'es'), /not configured/);
  const registry = new ActionRegistry();
  registerVoiceActions(registry, voice);
  assert.throws(() =>
    registry.get('voice.consent').schema.parse({ enabled: true, language: 'arbitrary-language' }),
  );
  assert.equal(
    (
      registry.get('voice.consent').schema.parse({ enabled: true, commands: true, language: 'ja' }) as {
        language: string;
      }
    ).language,
    'ja',
  );
});
