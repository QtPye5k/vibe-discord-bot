import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as tick } from 'node:timers/promises';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import { z } from 'zod';
import type { ActionContext } from '../src/core/types.js';
import {
  VoiceService,
  pcmToWav,
  readLocalVoiceAudio,
  voiceAlertPcm,
  type VoiceDriver,
  type VoiceHooks,
  type VoiceOptions,
} from '../src/features/voice.js';
import {
  VOICE_TRIVIA_LIMITS,
  VoiceExperienceService,
  registerVoiceExperienceActions,
} from '../src/features/voice-experiences.js';

class Driver implements VoiceDriver {
  played: Buffer[] = [];
  destroyed = false;
  constructor(readonly hooks: VoiceHooks) {}
  play(pcm: Buffer) {
    this.played.push(pcm);
  }
  pause() {
    return true;
  }
  resume() {
    return true;
  }
  stop() {
    this.hooks.idle();
  }
  destroy() {
    this.destroyed = true;
  }
  receive() {
    return () => {};
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function directory(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'discord-voice-test-'));
  t.after(async () => {
    assert.equal(dirname(root), tmpdir());
    assert.match(basename(root), /^discord-voice-test-/);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
function fixture(t: TestContext, options: VoiceOptions = {}, guildId = 'voice-games') {
  const store = new Store(':memory:');
  const voiceChannel = {
    id: `voice-${guildId}`,
    guild: { id: guildId },
    name: 'Voice',
    permissionsFor: () => ({ has: () => true }),
  };
  const member = {
    id: 'speaker',
    displayName: 'Speaker',
    user: { bot: false },
    voice: { channelId: voiceChannel.id, channel: voiceChannel },
  };
  const members = new Map([[member.id, member]]);
  let access = true;
  const guild = {
    id: guildId,
    members: {
      me: {},
      fetch: async (input: { user: string } | string) =>
        members.get(typeof input === 'string' ? input : input.user)!,
    },
    channels: {
      fetch: async () => ({
        guildId,
        isTextBased: () => true,
        permissionsFor: () => ({ has: () => access }),
      }),
    },
  };
  const ctx = { store, guild, member, channelId: `text-${guildId}` } as unknown as ActionContext;
  const drivers: Driver[] = [];
  const voice = new VoiceService({
    send: async (channel, payload, signal, current) => {
      signal.throwIfAborted();
      current?.();
      await channel.send(payload);
    },
    ...options,
    driverFactory: async (_channel, hooks) => {
      const driver = new Driver(hooks);
      drivers.push(driver);
      return driver;
    },
  });
  t.after(async () => {
    voice.close();
    await voice.drain();
    store.close();
  });
  const other = (id: string) => {
    const actor = { ...member, id, displayName: id, voice: { ...member.voice } };
    members.set(id, actor);
    return { ...ctx, member: actor } as unknown as ActionContext;
  };
  return {
    ctx,
    voice,
    drivers,
    member,
    guild,
    other,
    revoke: () => {
      access = false;
    },
  };
}

test('local voice library is disabled by default and approved file IDs cannot select paths, URLs or arbitrary extensions', async (t) => {
  const root = await directory(t);
  const pcm = Buffer.alloc(4000);
  pcm.writeInt16LE(1234);
  await writeFile(join(root, 'chime.wav'), pcmToWav(pcm));
  assert.deepEqual(await readLocalVoiceAudio(root, 'chime'), pcm);
  await assert.rejects(readLocalVoiceAudio('', 'chime'), /disabled/);
  for (const id of [
    '../chime',
    'C:\\secret',
    '/secret',
    'https://example.com',
    'chime.wav',
    'UPPER',
    'x'.repeat(33),
  ])
    await assert.rejects(readLocalVoiceAudio(root, id));
  const f = fixture(t);
  await f.voice.join(f.ctx);
  await assert.rejects(f.voice.library(f.ctx), /disabled/);
  assert.throws(() => f.voice.playLocal(f.ctx, 'chime'), /disabled/);
});

test('approved local WAV reads enforce file type, byte bound, PCM format and duration before allocating playback', async (t) => {
  const root = await directory(t);
  await writeFile(join(root, 'bad.wav'), 'not a WAV');
  await mkdir(join(root, 'folder.wav'));
  await writeFile(join(root, 'large.wav'), '');
  await truncate(join(root, 'large.wav'), 8 * 1024 * 1024 + 1);
  const compressed = pcmToWav(Buffer.alloc(4000));
  compressed.writeUInt16LE(3, 20);
  await writeFile(join(root, 'compressed.wav'), compressed);
  const long = Buffer.alloc(44 + 8000 * 2 * 121),
    header = pcmToWav(Buffer.alloc(4000)).subarray(0, 44);
  header.copy(long);
  long.writeUInt32LE(long.length - 8, 4);
  long.writeUInt16LE(1, 22);
  long.writeUInt32LE(8000, 24);
  long.writeUInt32LE(16000, 28);
  long.writeUInt16LE(2, 32);
  long.writeUInt32LE(long.length - 44, 40);
  await writeFile(join(root, 'long.wav'), long);
  for (const id of ['bad', 'folder', 'large', 'compressed', 'long', 'missing'])
    await assert.rejects(readLocalVoiceAudio(root, id));
});

test('realpath checks reject symlink escape from the approved audio root', async (t) => {
  const parent = await directory(t),
    root = join(parent, 'approved');
  await mkdir(root);
  await writeFile(join(parent, 'outside.wav'), pcmToWav(Buffer.alloc(4000)));
  try {
    await symlink(join(parent, 'outside.wav'), join(root, 'escape.wav'), 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      // Windows permits junctions without the privilege required for file symlinks.
      const outside = join(parent, 'outside');
      await mkdir(outside);
      await symlink(outside, join(root, 'escape.wav'), 'junction');
    } else {
      throw error;
    }
  }
  await assert.rejects(readLocalVoiceAudio(root, 'escape'), /leaves the approved library/);
});

test('local library listing and playback select only approved file IDs and refresh current history access', async (t) => {
  const root = await directory(t);
  await writeFile(join(root, 'chime.wav'), pcmToWav(Buffer.alloc(4000)));
  await writeFile(join(root, 'not-audio.txt'), 'x');
  await writeFile(join(root, 'Upper.wav'), 'x');
  await mkdir(join(root, 'folder.wav'));
  const f = fixture(t, { audioDirectory: root });
  await f.voice.join(f.ctx);
  assert.deepEqual(await f.voice.library(f.ctx), { files: ['chime'], truncated: false });
  await f.voice.playLocal(f.ctx, 'chime');
  assert.equal(f.drivers[0]!.played.length, 1);
  assert.equal(f.drivers[0]!.played[0]!.length, 4000);
  f.revoke();
  await assert.rejects(f.voice.playLocal(f.ctx, 'chime'), /view|History/);
});

test('stop, disconnect and changed voice membership prevent local playback completing after asynchronous file access', async (t) => {
  const root = await directory(t);
  await writeFile(join(root, 'chime.wav'), pcmToWav(Buffer.alloc(4000)));
  for (const change of ['stop', 'disconnect', 'move'] as const) {
    const f = fixture(t, { audioDirectory: root }, change);
    await f.voice.join(f.ctx);
    const entered = deferred<void>(),
      gate = deferred<void>();
    let fetches = 0;
    f.guild.members.fetch = async () => {
      if (++fetches === 2) {
        entered.resolve();
        await gate.promise;
      }
      return f.member;
    };
    const pending = f.voice.playLocal(f.ctx, 'chime');
    const rejected = assert.rejects(pending, /cancelled/);
    await entered.promise;
    if (change === 'stop') f.voice.stop(f.ctx);
    if (change === 'disconnect') f.drivers[0]!.hooks.disconnected();
    if (change === 'move') f.member.voice.channelId = 'other';
    gate.resolve();
    await rejected;
    assert.deepEqual(f.drivers[0]!.played, []);
  }
});

test('deterministic alerts produce bounded stereo PCM without a provider and obey current voice authority/queue limits', async (t) => {
  for (const kind of ['notice', 'success', 'warning'] as const) {
    const pcm = voiceAlertPcm(kind);
    assert.deepEqual(pcm, voiceAlertPcm(kind));
    assert.equal(pcm.length % 4, 0);
    assert.ok(pcm.length <= 48000 * 4);
    let peak = 0;
    for (let offset = 0; offset < pcm.length; offset += 4) {
      assert.equal(pcm.readInt16LE(offset), pcm.readInt16LE(offset + 2));
      peak = Math.max(peak, Math.abs(pcm.readInt16LE(offset)));
    }
    assert.ok(peak > 0 && peak <= 5000);
  }
  const f = fixture(t);
  await f.voice.join(f.ctx);
  await f.voice.alert(f.ctx, 'notice');
  assert.equal(f.drivers[0]!.played.length, 1);
  for (let i = 0; i < 5; i++) await f.voice.alert(f.ctx, 'success');
  await assert.rejects(f.voice.alert(f.ctx, 'warning'), /queue is full/);
  f.member.voice.channelId = 'other';
  await assert.rejects(f.voice.alert(f.ctx, 'notice'), /same voice/);
});

test('voice experience registration exposes strict actions and write confirmation for playback/trivia', async (t) => {
  const f = fixture(t),
    registry = new ActionRegistry(120, async (ctx) => ctx);
  registerVoiceExperienceActions(registry, f.voice);
  assert.equal(registry.list().length, 8);
  assert.throws(() => registry.get('voice.library-play').schema.parse({ id: '../escape' }));
  assert.throws(() => registry.get('voice.alert').schema.parse({ kind: 'arbitrary-script' }));
  assert.throws(() => registry.get('voice.trivia-start').schema.parse({ questionId: 'generated' }));
  assert.throws(() => registry.get('voice.trivia-answer').schema.parse({ answer: 'x'.repeat(101) }));
  assert.equal((await registry.request(f.ctx, 'voice.alert', { kind: 'success' })).status, 'confirmation');
  assert.deepEqual(f.drivers, []);
});

test('voice attendance exports observed durations or delegates exact event access to the authorized calendar exporter', async (t) => {
  const f = fixture(t),
    registry = new ActionRegistry(120, async (ctx) => ctx);
  registerVoiceExperienceActions(registry, f.voice);
  let eventId = '';
  registry.register({
    id: 'analytics.activity',
    category: 'analytics',
    description: 'Observed fixture',
    risk: 'read',
    userPermissions: [],
    botPermissions: [],
    schema: z.strictObject({ inactiveDays: z.literal(0), limit: z.number().int().max(1000) }),
    execute: () => [{ user_id: '930000000000000002', voice_seconds: 125, last_seen: Date.UTC(2026, 0, 2) }],
  });
  registry.register({
    id: 'calendar.export',
    category: 'calendar',
    description: 'Source access fixture',
    risk: 'read',
    userPermissions: [],
    botPermissions: [],
    schema: z.strictObject({ id: z.string() }),
    execute: (_ctx, input) => {
      eventId = input.id;
      return { attachment: Buffer.from('event,attended'), name: 'event.csv' };
    },
  });
  const output = await registry.request(f.ctx, 'voice.attendance.report', {});
  assert.equal(output.status, 'completed');
  if (output.status !== 'completed') throw new Error();
  const file = output.result as { attachment: Buffer; notice: string; rows: number };
  assert.match(file.attachment.toString(), /observed_voice_seconds/);
  assert.match(file.attachment.toString(), /125/);
  assert.equal(file.rows, 1);
  assert.match(file.notice, /gaps/);
  await registry.request(f.ctx, 'voice.attendance.report', { eventId: 'meeting' });
  assert.equal(eventId, 'meeting');
  f.ctx.store.set('core.disabled', f.ctx.guild.id, ['analytics']);
  await assert.rejects(() => registry.request(f.ctx, 'voice.attendance.report', {}), /analytics is disabled/);
});

test('spoken trivia uses fixed questions, checks known answers, prevents duplicate awards and retains bounded session scores', async (t) => {
  const spoken: string[] = [];
  const f = fixture(t, {
    speech: async (_ctx, text) => {
      spoken.push(text);
      return Buffer.alloc(4800);
    },
  });
  await f.voice.join(f.ctx);
  const games = new VoiceExperienceService(f.voice);
  const question = (await games.start(f.ctx, 'arithmetic')) as { question: string };
  assert.match(question.question, /seven multiplied by eight/);
  assert.doesNotMatch(spoken[0]!, /56|fifty.six/);
  assert.equal(f.drivers[0]!.played.length, 1);
  await assert.rejects(games.start(f.ctx), /already/);
  assert.deepEqual(await games.answer(f.ctx, 'wrong'), { correct: false, guessesRemaining: 2 });
  const correct = (await games.answer(f.ctx, 'fifty-six')) as { correct: boolean; scores: unknown[] };
  assert.equal(correct.correct, true);
  assert.deepEqual(correct.scores, [{ userId: 'speaker', points: 1 }]);
  await assert.rejects(games.answer(f.ctx, '56'), /closed/);
  f.drivers[0]!.hooks.idle();
  await games.start(f.ctx, 'japan');
  await games.answer(f.ctx, 'Tokyo');
  assert.deepEqual(((await games.status(f.ctx)) as { scores: unknown[] }).scores, [
    { userId: 'speaker', points: 2 },
  ]);
});

test('voice trivia enforces TTL, three guesses and per-question participant limits without exposing the answer early', async (t) => {
  let now = 1000;
  const f = fixture(t, { speech: async () => Buffer.alloc(4800), now: () => now });
  await f.voice.join(f.ctx);
  const games = new VoiceExperienceService(f.voice, () => now);
  await games.start(f.ctx, 'triangle');
  const current = await games.status(f.ctx);
  assert.equal('answer' in (current as object), false);
  for (let i = 0; i < VOICE_TRIVIA_LIMITS.attempts; i++) await games.answer(f.ctx, 'wrong');
  await assert.rejects(games.answer(f.ctx, 'three'), /all three/);
  for (let i = 1; i < VOICE_TRIVIA_LIMITS.participants; i++)
    await games.answer(f.other(`user-${i}`), 'wrong');
  await assert.rejects(games.answer(f.other('overflow'), 'three'), /participant/);
  now += VOICE_TRIVIA_LIMITS.questionMs;
  await assert.rejects(games.answer(f.other('user-1'), '3'), /expired/);
  now += VOICE_TRIVIA_LIMITS.scoresMs;
  await assert.rejects(games.status(f.ctx), /No voice trivia/);
});

test('spoken trivia is scoped to the current voice/text channel and stop invalidates old games', async (t) => {
  const f = fixture(t, { speech: async () => Buffer.alloc(4800) });
  await f.voice.join(f.ctx);
  const games = new VoiceExperienceService(f.voice);
  await games.start(f.ctx, 'water');
  await assert.rejects(games.answer({ ...f.ctx, channelId: 'other-text' }, 'H2O'), /text channel/);
  const outsider = f.other('outsider');
  (outsider.member.voice as { channelId: string }).channelId = 'elsewhere';
  await assert.rejects(games.answer(outsider, 'H2O'), /same voice/);
  f.voice.stop(f.ctx);
  await assert.rejects(games.status(f.ctx), /cancelled/);
  await games.start(f.ctx, 'water');
  await games.stop(f.ctx);
  await assert.rejects(games.status(f.ctx), /No voice trivia/);
});

test('stopping while a spoken trivia question is being synthesized cancels the question and late playback', async (t) => {
  const gate = deferred<Uint8Array>();
  const f = fixture(t, { speech: async () => gate.promise });
  await f.voice.join(f.ctx);
  const games = new VoiceExperienceService(f.voice),
    pending = games.start(f.ctx, 'hexagon');
  const rejected = assert.rejects(pending, /cancelled/);
  await tick();
  await assert.rejects(games.answer(f.ctx, 'six'), /prepared/);
  f.voice.stop(f.ctx);
  gate.resolve(Buffer.alloc(4800));
  await rejected;
  assert.deepEqual(f.drivers[0]!.played, []);
  await assert.rejects(games.status(f.ctx), /No voice trivia/);
});
