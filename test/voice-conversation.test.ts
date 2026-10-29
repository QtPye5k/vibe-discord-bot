import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { PermissionFlagsBits as P, PermissionsBitField } from 'discord.js';
import { Store } from '../src/core/store.js';
import type { ActionContext } from '../src/core/types.js';
import {
  VoiceService,
  toDiscordPcm,
  type VoiceDriver,
  type VoiceHooks,
  type VoiceOptions,
} from '../src/features/voice.js';
import { VoiceConversation } from '../src/voice/conversation.js';
import { isRelatedVoiceFollowUp, voiceRequestNeedsTools } from '../src/voice/routing.js';
import { SpeechPcmStream } from '../src/voice/pcm-stream.js';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
class Driver implements VoiceDriver {
  played: Buffer[] = [];
  streamed: Buffer[] = [];
  streams: Readable[] = [];
  autoIdle = true;
  stops = 0;
  chunks?: (pcm: Buffer) => void;
  end?: () => void;
  constructor(readonly hooks: VoiceHooks) {}
  play(data: Buffer) {
    this.played.push(Buffer.from(data));
  }
  playStream: ((source: Readable, volume: number) => void) | undefined = (source) => {
    this.streams.push(source);
    source.on('data', (data: Buffer) => this.streamed.push(Buffer.from(data)));
    source.once('end', () => {
      if (this.autoIdle) this.hooks.idle();
    });
  };
  pause() {
    return true;
  }
  resume() {
    return true;
  }
  stop() {
    this.stops++;
    this.hooks.idle();
  }
  destroy() {
    for (const stream of this.streams) stream.destroy();
  }
  receive(_user: string, chunk: (pcm: Buffer) => void, end: () => void) {
    this.chunks = chunk;
    this.end = end;
    return () => {};
  }
}
function fixture(t: TestContext, options: VoiceOptions = {}) {
  const store = new Store(':memory:'),
    messages: { channel: string; content: unknown }[] = [],
    errors: unknown[] = [];
  let time = 100000,
    publicTranscript = false,
    roleLeak = false,
    transcript = 'Vibe hello',
    beforeTranscribe: (() => Promise<void>) | undefined;
  const permissions = new PermissionsBitField(P.Administrator),
    everyone = { id: 'guild' },
    voiceChannel = {
      id: 'voice',
      guild: { id: 'guild' },
      type: 2,
      name: 'VC',
      permissionsFor: () => permissions,
    };
  const member = {
      id: 'alice',
      displayName: 'Alice',
      user: { id: 'alice', bot: false },
      roles: { cache: new Map() },
      voice: { channelId: 'voice', channel: voiceChannel },
    },
    other = { ...member, id: 'bob', displayName: 'Bob', user: { id: 'bob', bot: false } },
    bot = { ...member, id: 'bot', user: { id: 'bot', bot: true } };
  const members = new Map([
    ['alice', member],
    ['bob', other],
  ]);
  const channel = (id: string) => ({
    id,
    guildId: 'guild',
    type: 0,
    permissionOverwrites: {
      cache: new Map(
        [
          {
            id: 'guild',
            type: 0,
            allow: new PermissionsBitField(id === 'general' ? P.ViewChannel : 0n),
            deny: new PermissionsBitField(id === 'general' ? 0n : P.ViewChannel),
          },
          ...(roleLeak
            ? [
                {
                  id: 'ordinary-role',
                  type: 0,
                  allow: new PermissionsBitField(P.ViewChannel),
                  deny: new PermissionsBitField(0n),
                },
              ]
            : []),
        ].map((row) => [row.id, row]),
      ),
    },
    isTextBased: () => true,
    isThread: () => false,
    permissionsFor: (principal: unknown) =>
      principal === everyone
        ? new PermissionsBitField(publicTranscript || id === 'general' ? P.ViewChannel : 0n)
        : permissions,
    send: async (content: unknown) => {
      messages.push({ channel: id, content });
      return { id: 'sent' };
    },
  });
  const guild = {
    id: 'guild',
    roles: { everyone },
    members: {
      me: bot,
      fetch: async ({ user }: { user: string }) => members.get(user),
      fetchMe: async () => bot,
    },
    channels: {
      cache: new Map<string, ReturnType<typeof channel>>(),
      fetch: async (id: string) => {
        const value = channel(id);
        guild.channels.cache.set(id, value);
        return value;
      },
    },
  };
  const ctx = {
    guild,
    member,
    client: { user: { id: 'bot' } },
    channelId: 'general',
    store,
  } as unknown as ActionContext;
  let driver!: Driver;
  const voice = new VoiceService({
    send: async (channel, payload, signal, current) => {
      signal.throwIfAborted();
      current?.();
      await channel.send(payload);
    },
    requireWakeWord: true,
    requirePrivateTranscripts: true,
    resolveTranscriptChannel: async () => 'transcripts',
    botName: 'Vibe',
    now: () => time,
    transcribe: async () => {
      await beforeTranscribe?.();
      return transcript;
    },
    reply: async () => ({ text: 'Done.', followUp: 'none' }),
    speech: async () => Buffer.alloc(4800),
    onError: (error) => errors.push(error),
    ...options,
    driverFactory: async (_channel, hooks) => {
      driver = new Driver(hooks);
      return driver;
    },
  });
  t.after(async () => {
    voice.close();
    await voice.drain();
    store.close();
  });
  const capture = (text: string, userId = 'alice') => {
    transcript = text;
    driver.hooks.speaking(userId);
    assert(driver.chunks && driver.end, 'Capture was not admitted');
    driver.chunks(Buffer.alloc(48000));
    driver.end();
  };
  return {
    voice,
    ctx,
    store,
    messages,
    errors,
    get driver() {
      return driver;
    },
    capture,
    idle: () => driver.hooks.idle(),
    async say(text: string, userId = 'alice') {
      capture(text, userId);
      await voice.drain();
      await tick();
    },
    advance: (ms: number) => {
      time += ms;
    },
    makePublic: () => {
      publicTranscript = true;
    },
    makeRoleVisible: () => {
      roleLeak = true;
    },
    holdTranscription: (hook: () => Promise<void>) => {
      beforeTranscribe = hook;
    },
  };
}

test('voice turn gate requires its name for a new request and isolates short pending confirmations by speaker and expiry', () => {
  const gate = new VoiceConversation({ botName: 'Vibe', followUpSeconds: 20 });
  assert.equal(gate.select('alice', 'what are we having for dinner', 0), undefined);
  assert.equal(gate.select('alice', 'I think Vibe is cool', 0), undefined);
  assert.equal(gate.select('alice', 'Vibes are good', 0), undefined);
  assert.deepEqual(gate.select('alice', 'Hey, Vibe, rename the server W.', 0), {
    text: 'rename the server W.',
    kind: 'wake',
    addressing: 'name',
  });
  gate.complete(
    'alice',
    'rename the server W',
    { text: 'Confirm this rename?', followUp: 'confirmation' },
    0,
  );
  assert.equal(gate.select('bob', 'confirm', 1), undefined);
  assert.equal(gate.select('alice', 'I am talking to someone else about lunch', 1000), undefined);
  assert.equal(gate.select('alice', 'confirm the capitalized W', 19999)?.kind, 'follow-up');
  assert.equal(gate.select('alice', 'confirm', 20000), undefined);
  gate.complete('alice', 'delete this', { text: 'Please confirm.', followUp: 'confirmation' }, 30000);
  assert.equal(gate.select('alice', 'confirm', 50000), undefined);
});

test('completed generated playback with a missing Idle event releases capture after its duration and grace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const kind of ['stream', 'buffer', 'speak'] as const)
    await t.test(kind, async (sub) => {
      const events: Record<string, unknown>[] = [],
        f = fixture(sub, {
          speech: async () => Buffer.alloc(48000),
          onDiagnostic: (_event, fields) => events.push(fields),
          ...(kind === 'stream'
            ? {
                realtimeReply: async (_ctx, _text, _meta, hooks) => {
                  await hooks.audio(Buffer.alloc(48000));
                  return 'Finished generation.';
                },
              }
            : {}),
        });
      await f.voice.join(f.ctx);
      f.voice.consent(f.ctx, true, true);
      f.driver.autoIdle = false;
      if (kind === 'speak') await f.voice.speak(f.ctx, 'A generated message.');
      else await f.say('Vibe hello');
      const captured = (f.voice.status(f.ctx) as { diagnostics: { captures: number } }).diagnostics.captures;
      f.driver.hooks.speaking('alice');
      assert.equal(
        (f.voice.status(f.ctx) as { diagnostics: { captures: number } }).diagnostics.captures,
        captured,
      );
      f.advance(10000);
      t.mock.timers.tick(10000);
      assert.notEqual(
        (f.voice.status(f.ctx) as { playing: string | null }).playing,
        null,
        'normal playback and grace are not interrupted',
      );
      assert.equal(f.driver.stops, 0);
      f.advance(1001);
      t.mock.timers.tick(1001);
      assert.equal((f.voice.status(f.ctx) as { playing: string | null }).playing, null);
      assert.equal(f.driver.stops, 1);
      assert.equal(events.filter((entry) => entry.stage === 'playback.stalled').length, 1);
      f.driver.autoIdle = true;
      await f.say('Vibe hello again');
      assert.equal(
        (f.voice.status(f.ctx) as { diagnostics: { captures: number } }).diagnostics.captures,
        captured + 1,
      );
    });
});

test('unfinished speech generation has no playback watchdog and healthy Idle clears the completed watchdog', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = latch(),
    completion = latch(),
    events: Record<string, unknown>[] = [],
    f = fixture(t, {
      onDiagnostic: (_event, fields) => events.push(fields),
      realtimeReply: async (_ctx, _text, _meta, hooks) => {
        await hooks.audio(Buffer.alloc(4800));
        entered.release();
        await completion.promise;
        return 'Done.';
      },
    });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  f.capture('Vibe hello');
  await entered.promise;
  f.advance(20000);
  t.mock.timers.tick(20000);
  assert.equal(f.driver.stops, 0);
  assert(!events.some((entry) => entry.stage === 'playback.stalled'));
  completion.release();
  await f.voice.drain();
  await tick();
  assert.equal((f.voice.status(f.ctx) as { playing: string | null }).playing, null);
  f.advance(30000);
  t.mock.timers.tick(30000);
  assert.equal(f.driver.stops, 0);
  assert(!events.some((entry) => entry.stage === 'playback.stalled'));
  f.voice.enqueue(f.ctx, Buffer.alloc(192000), 'Uploaded music');
  f.advance(60000);
  t.mock.timers.tick(60000);
  assert.equal(
    (f.voice.status(f.ctx) as { playing: string | null }).playing,
    'Uploaded music',
    'non-generated media is outside the watchdog',
  );
  assert.equal(f.driver.stops, 0);
});

test('intentional pause suspends the generated-playback deadline and resume preserves remaining duration', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { speech: async () => Buffer.alloc(48000) });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  await f.say('Vibe hello');
  f.advance(500);
  t.mock.timers.tick(500);
  f.voice.pause(f.ctx);
  f.advance(60000);
  t.mock.timers.tick(60000);
  assert.equal(f.driver.stops, 0);
  assert.notEqual((f.voice.status(f.ctx) as { playing: string | null }).playing, null);
  f.voice.resume(f.ctx);
  f.advance(10499);
  t.mock.timers.tick(10499);
  assert.equal(f.driver.stops, 0, 'remaining half-second plus ten-second grace is preserved');
  f.advance(2);
  t.mock.timers.tick(2);
  assert.equal(f.driver.stops, 1);
  assert.equal((f.voice.status(f.ctx) as { playing: string | null }).playing, null);
});

test('transport recovery suspends the same playback clock without extending speaker consent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { speech: async () => Buffer.alloc(48000) });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  await f.say('Vibe hello');
  const lease = f.voice.requestLease({ ...f.ctx, channelId: 'transcripts' });
  f.advance(500);
  t.mock.timers.tick(500);
  f.driver.hooks.connectionState?.('recovering');
  f.advance(60000);
  t.mock.timers.tick(60000);
  assert.equal(f.driver.stops, 0);
  f.driver.hooks.connectionState?.('ready');
  f.advance(10499);
  t.mock.timers.tick(10499);
  assert.equal(f.driver.stops, 0);
  f.advance(2);
  t.mock.timers.tick(2);
  assert.equal(f.driver.stops, 1);
  assert.equal(lease(), true);
  f.advance(529000);
  assert.equal(lease(), false, 'recovery and the watchdog kept the original ten-minute consent expiry');
});

test('idle, stop, revoke and leave remove the generated playback watchdog instead of allowing a later stale stop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['idle', 'stop', 'revoke', 'leave'] as const)
    await t.test(action, async (sub) => {
      const events: Record<string, unknown>[] = [],
        f = fixture(sub, { onDiagnostic: (_event, fields) => events.push(fields) });
      await f.voice.join(f.ctx);
      f.voice.consent(f.ctx, true, true);
      await f.say('Vibe hello');
      if (action === 'idle') f.idle();
      if (action === 'stop') f.voice.stop(f.ctx);
      if (action === 'revoke') f.voice.consent(f.ctx, false);
      if (action === 'leave') f.voice.leave(f.ctx);
      const stops = f.driver.stops;
      f.advance(20000);
      t.mock.timers.tick(20000);
      assert.equal(f.driver.stops, stops);
      assert(!events.some((entry) => entry.stage === 'playback.stalled'));
    });
});

test('direct vocatives can follow the request while ambient third-person and numeric phrases stay ignored', () => {
  const gate = new VoiceConversation({ botName: 'Vibe' });
  for (const [spoken, request, addressing] of [
    ['Can you help me, Vibe?', 'Can you help me', 'vocative'],
    ['Tell me something interesting Vibe please.', 'Tell me something interesting', 'vocative'],
    ['Can you, Vibe, explain that?', 'Can you explain that?', 'vocative'],
    ['Vibe, can you help?', 'can you help?', 'name'],
    ['Hey Vibe, what is up?', 'what is up?', 'name'],
    ['Bibe, can you help?', 'can you help?', 'phonetic'],
    ['Five, what is the weather?', 'what is the weather?', 'phonetic'],
    ['Vybe create an event for tonight', 'create an event for tonight', 'phonetic'],
  ]) {
    const selected = gate.select('alice', spoken!, 0);
    assert.equal(selected?.text, request, spoken);
    assert.equal(selected?.addressing, addressing, spoken);
  }
  for (const spoken of [
    'I told Vibe to do that',
    'I think Vibe is cool',
    'Tell me about Vibe',
    'Show this to Vibe',
    'Vibe is offline',
    'Vibe can answer questions',
    'Vibes are good',
    'five hours sounds right',
    'five people joined',
    'bye can you help',
    'we have five channels',
    'Bibe',
  ])
    assert.equal(gate.select('alice', spoken, 0), undefined, spoken);
  assert.equal(
    new VoiceConversation({ botName: 'Echo' }).select('alice', 'Five can you help?', 0),
    undefined,
  );
});

test('forty streamed turns remain live beyond the first minute and transport recovery keeps the original consent expiry', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const events: { event: string; fields: Record<string, unknown> }[] = [],
    f = fixture(t, {
      onDiagnostic: (event, fields) => events.push({ event, fields }),
      realtimeReply: async (_ctx, _text, _meta, hooks) => {
        await hooks.audio(Buffer.alloc(4800));
        return 'A concise answer.';
      },
    });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  for (let index = 0; index < 40; index++) {
    f.advance(10000);
    t.mock.timers.tick(10000);
    if (index === 6) {
      f.driver.hooks.connectionState?.('recovering');
      f.driver.hooks.speaking('alice');
      const pending = f.voice.status(f.ctx) as { transportReady: boolean; diagnostics: { captures: number } };
      assert.equal(pending.transportReady, false);
      assert.equal(pending.diagnostics.captures, 6, 'no capture starts while transport is unavailable');
      f.driver.hooks.connectionState?.('ready');
    }
    await f.say(`Vibe PRIVATE_TEST_REQUEST_${index}`);
  }
  const status = f.voice.status(f.ctx) as {
    processing: boolean;
    speechPending: boolean;
    capturing: boolean;
    transportReady: boolean;
    diagnostics: { captures: number; replies: number; transcriptions: number; failures: number };
  };
  assert.equal(status.processing, false);
  assert.equal(status.speechPending, false);
  assert.equal(status.capturing, false);
  assert.equal(status.transportReady, true);
  assert.equal(status.diagnostics.captures, 40);
  assert.equal(status.diagnostics.replies, 40);
  assert.equal(status.diagnostics.transcriptions, 40);
  assert.equal(status.diagnostics.failures, 0);
  assert.equal(f.driver.streams.length, 40);
  assert(!JSON.stringify(events).includes('PRIVATE_TEST_REQUEST'));
  f.advance(200001);
  t.mock.timers.tick(30000);
  f.driver.hooks.speaking('alice');
  assert.equal((f.voice.status(f.ctx) as { consentingSpeakers: number }).consentingSpeakers, 0);
  assert.equal((f.voice.status(f.ctx) as typeof status).diagnostics.captures, 40);
});

test('voice diagnostics distinguish wake rejection, active-turn noise and quota failures without transcript content', async (t) => {
  const events: Record<string, unknown>[] = [];
  let fail = true;
  const f = fixture(t, {
    onDiagnostic: (_event, fields) => events.push(fields),
    reply: async () => {
      if (fail) throw new Error('Daily AI request allowance reached (PRIVATE_PROVIDER_DETAIL).');
      return { text: 'That makes sense.', followUp: 'none' };
    },
  });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  await f.say('Unrelated PRIVATE_AMBIENT_WORDS');
  assert(
    events.some((entry) => entry.stage === 'wake.ignored' && entry.reason === 'no-name-or-expired-follow-up'),
  );
  await f.say('Vibe PRIVATE_REQUEST');
  const failure = f.voice.status(f.ctx) as {
    processing: boolean;
    diagnostics: { failures: number; lastFailureCode: string };
  };
  assert.equal(failure.processing, false);
  assert.equal(failure.diagnostics.failures, 1);
  assert.equal(failure.diagnostics.lastFailureCode, 'quota');
  assert(f.messages.some((message) => JSON.stringify(message.content).includes('00:00 UTC')));
  fail = false;
  await f.say('Vibe hello');
  f.idle();
  const ignored = events.filter((entry) => entry.stage === 'wake.ignored').length;
  await f.say('Hey Taylor can you discuss PRIVATE_AMBIENT_WORDS');
  assert.equal(events.filter((entry) => entry.stage === 'wake.ignored').length, ignored + 1);
  assert(!JSON.stringify(events).includes('PRIVATE_'));
  assert(f.messages.every((message) => message.channel === 'transcripts'));
});
test('voice attention accepts ordinary conversation after a reply and still clears explicitly', () => {
  const gate = new VoiceConversation();
  gate.complete(
    'alice',
    'rename this server',
    { text: 'What name should I use?', followUp: 'clarification' },
    0,
  );
  const answer = gate.select('alice', 'W', 1)!;
  assert.equal(answer.previousRequest, 'rename this server');
  assert.equal(answer.text, 'W');
  gate.complete('alice', 'tell me about Saturn', 'Saturn has rings.', 2);
  assert.equal(gate.select('alice', 'That sounds interesting', 3)?.kind, 'follow-up');
  gate.complete('alice', 'tell me about Saturn', 'Saturn has rings.', 3);
  assert.equal(gate.select('alice', 'what about Mars?', 3)?.kind, 'follow-up');
  gate.complete('alice', 'explain a solar panel', 'It converts sunlight into electricity.', 4);
  assert.equal(gate.select('alice', 'How does it work?', 5)?.kind, 'follow-up');
  gate.complete('alice', 'called your name', { text: 'What would you like?', followUp: 'clarification' }, 4);
  assert.equal(gate.select('alice', 'create an event for tonight', 5)?.kind, 'follow-up');
  gate.complete('alice', 'rename this', { text: 'Please confirm.', followUp: 'confirmation' }, 10);
  gate.clear('alice');
  assert.equal(gate.select('alice', 'yes', 11), undefined);
});
test('local transcription disclosures describe host processing and speaker reset hooks clear idle conversation state', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const resets: { guildId: string; userId?: string }[] = [],
    f = fixture(t, {
      transcriptionProvider: 'local',
      onSpeakerReset: (guildId, userId) => resets.push({ guildId, userId }),
    });
  assert.match(await f.voice.join(f.ctx), /transcription runs on this host/);
  const disclosure = f.voice.consent(f.ctx, true, true);
  assert.match(disclosure, /transcribed on this host/);
  assert.doesNotMatch(disclosure, /utterances.*are sent to OpenAI for transcription/);
  assert.match(disclosure, /addressed requests/);
  assert.deepEqual(resets, [{ guildId: 'guild', userId: 'alice' }]);
  f.voice.consent(f.ctx, false);
  assert.deepEqual(resets.at(-1), { guildId: 'guild', userId: 'alice' });
  f.voice.consent(f.ctx, true, true);
  f.voice.stop(f.ctx);
  assert.deepEqual(resets.at(-1), { guildId: 'guild', userId: undefined });
  f.voice.consent(f.ctx, true, true);
  f.advance(600001);
  t.mock.timers.tick(30000);
  assert.deepEqual(resets.at(-1), { guildId: 'guild', userId: 'alice' });
  f.voice.disableGuild('guild');
  assert.deepEqual(resets.at(-1), { guildId: 'guild', userId: undefined });
});
test('voice request authority binds exact consent, session, speaker, private destination and current cached permissions', async (t) => {
  for (const change of ['stop', 'revoke', 'renew', 'expiry', 'leave', 'disable', 'private-role'] as const)
    await t.test(change, async (sub) => {
      const f = fixture(sub);
      await f.voice.join(f.ctx);
      f.voice.consent(f.ctx, true, true);
      const ctx = { ...f.ctx, channelId: 'transcripts' },
        valid = f.voice.requestLease(ctx);
      assert.equal(valid(), true);
      assert.equal(f.voice.requestLease(f.ctx)(), false);
      assert.equal(valid({ ...ctx, channelId: 'general' }), false);
      assert.equal(valid({ ...ctx, member: { ...ctx.member, id: 'bob' } } as ActionContext), false);
      if (change === 'stop') f.voice.stop(f.ctx);
      if (change === 'revoke') f.voice.consent(f.ctx, false);
      if (change === 'renew') f.voice.consent(f.ctx, true, true);
      if (change === 'expiry') f.advance(600001);
      if (change === 'leave') f.voice.memberLeft('guild', 'alice', null);
      if (change === 'disable') f.voice.disableGuild('guild');
      if (change === 'private-role') {
        f.makeRoleVisible();
        await f.ctx.guild.channels.fetch('transcripts');
      }
      assert.equal(valid(), false, change);
    });
});

test('forgetting one speaker clears follow-ups and old leases while preserving expiry and other speakers', async (t) => {
  const resets: { guildId: string; userId?: string }[] = [],
    requests: string[] = [],
    f = fixture(t, {
      onSpeakerReset: (guildId, userId) => resets.push({ guildId, userId }),
      reply: async (_ctx, text) => {
        requests.push(text);
        return { text: 'Would you like more?', followUp: 'clarification' };
      },
    });
  f.voice.resetSpeakerConversation('guild', 'alice');
  assert.deepEqual(resets.pop(), { guildId: 'guild', userId: 'alice' });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  const alice = { ...f.ctx, channelId: 'transcripts' },
    bob = {
      ...alice,
      member: await f.ctx.guild.members.fetch({ user: 'bob', force: true }),
    };
  f.voice.consent(bob, true, true);
  const oldAliceLease = f.voice.requestLease(alice),
    bobLease = f.voice.requestLease(bob);
  await f.say('Vibe explain rainbows');
  f.idle();
  assert.equal(oldAliceLease(), true);
  assert.equal(bobLease(), true);
  f.advance(500000);
  f.voice.resetSpeakerConversation('guild', 'alice');
  assert.deepEqual(resets.at(-1), { guildId: 'guild', userId: 'alice' });
  assert.equal(oldAliceLease(), false);
  assert.equal(bobLease(), true);
  const renewedAliceLease = f.voice.requestLease(alice);
  assert.equal(renewedAliceLease(), true, 'existing unexpired consent remains enabled');
  await f.say('explain that');
  assert.deepEqual(requests, ['explain rainbows'], 'old follow-up was forgotten');
  await f.say('Vibe hello');
  assert.deepEqual(requests, ['explain rainbows', 'hello'], 'a fresh named request is accepted');
  f.advance(100001);
  assert.equal(renewedAliceLease(), false, 'forgetting did not extend the original ten-minute consent');
});

test('forgetting a speaker cancels delayed transcription before transcript delivery or AI use', async (t) => {
  const entered = latch(),
    completion = latch();
  let replies = 0;
  const f = fixture(t, {
    reply: async () => {
      replies++;
      return 'late';
    },
  });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  f.holdTranscription(async () => {
    entered.release();
    await completion.promise;
  });
  f.capture('Vibe hello');
  await entered.promise;
  f.voice.resetSpeakerConversation('guild', 'alice');
  completion.release();
  await f.voice.drain();
  assert.equal(replies, 0);
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.driver.played, []);
});
test('network PCM conversion is byte-identical to the production buffer path across odd chunk boundaries', () => {
  const input = Buffer.alloc(1002);
  for (let i = 0; i < input.length / 2; i++) input.writeInt16LE(((i * 773) % 65536) - 32768, i * 2);
  const stream = new SpeechPcmStream(),
    result: Buffer[] = [];
  let offset = 0;
  for (const length of [1, 17, 4, 33, 3, 201, 13, 730]) {
    result.push(stream.push(input.subarray(offset, offset + length)));
    offset += length;
  }
  if (offset < input.length) result.push(stream.push(input.subarray(offset)));
  result.push(stream.finish());
  assert.deepEqual(Buffer.concat(result), toDiscordPcm(input, 24000, 1));
  const truncated = new SpeechPcmStream();
  truncated.push(Buffer.from([1]));
  assert.throws(() => truncated.finish(), /incomplete/);
  truncated.clear();
});
test('strict transcript setup fails closed before connecting and never falls back to the join channel', async (t) => {
  const missing = fixture(t, { resolveTranscriptChannel: undefined });
  await assert.rejects(() => missing.voice.join(missing.ctx), /private.*required/);
  const publicChannel = fixture(t, { resolveTranscriptChannel: async () => 'general' });
  await assert.rejects(() => publicChannel.voice.join(publicChannel.ctx), /private text channel/);
  assert.deepEqual(publicChannel.messages, []);
});
test('all consented transcripts use the dedicated private destination while ambient speech never starts chat or speech', async (t) => {
  let replies = 0,
    speech = 0,
    commands = 0;
  const f = fixture(t, {
    reply: async () => {
      replies++;
      return 'Done.';
    },
    speech: async () => {
      speech++;
      return Buffer.alloc(4800);
    },
    onTranscript: async () => {
      commands++;
      return undefined;
    },
  });
  const disclosure = await f.voice.join(f.ctx);
  assert.match(disclosure, /<#transcripts>/);
  f.voice.consent(f.ctx, true, true);
  await f.say('I was talking to Bob about dinner');
  assert.equal(replies, 0);
  assert.equal(speech, 0);
  assert.equal(commands, 0);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0]!.channel, 'transcripts');
  await f.say('Vibe tell me something interesting');
  assert.equal(replies, 1);
  assert.equal(speech, 1);
  assert.equal(commands, 1);
  assert(f.messages.every((row) => row.channel === 'transcripts'));
  assert.equal((f.voice.status(f.ctx) as { transcriptChannelId: string }).transcriptChannelId, 'transcripts');
});
test('a real confirmation follow-up is handled once without invoking the conversational model again', async (t) => {
  let replies = 0;
  let pending = true,
    deletions = 0;
  const commands: string[] = [];
  const f = fixture(t, {
    reply: async (_ctx, text) => {
      replies++;
      assert.equal(text, 'delete that event');
      return { text: 'Please confirm this event deletion.', followUp: 'confirmation' };
    },
    onTranscript: async (ctx, text) => {
      assert.equal(ctx.channelId, 'transcripts');
      commands.push(text);
      if (text !== 'confirm') return;
      if (!pending)
        return {
          content: 'There is no pending change.',
          voiceResponse: 'There is no pending change.',
          followUp: 'none',
        };
      pending = false;
      deletions++;
      return { content: 'Deleted the event.', voiceResponse: 'Deleted.', followUp: 'none' };
    },
  });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  await f.say('Vibe delete that event');
  f.idle();
  await f.say('confirm');
  assert.equal(replies, 1);
  assert.deepEqual(commands, ['delete that event', 'confirm']);
  assert.equal(deletions, 1);
  assert.equal(f.driver.played.length, 2);
  f.idle();
  await f.say('confirm');
  assert.equal(replies, 1);
  assert.deepEqual(commands, ['delete that event', 'confirm', 'confirm']);
  assert.equal(deletions, 1);
});

test('A consented speaker can answer naturally and start a guarded task after waking once, while another speaker stays quiet', async (t) => {
  const conversation: string[] = [],
    tasks: string[] = [];
  const f = fixture(t, {
    realtimeReply: async (_ctx, text, meta, hooks) => {
      assert(isRelatedVoiceFollowUp(meta, text));
      if (voiceRequestNeedsTools(text, meta)) return;
      conversation.push(text);
      await hooks.audio(Buffer.alloc(4800));
      return {
        text:
          conversation.length === 1
            ? "Hello! How's your day going?"
            : "I'm doing well too. What else is on your mind?",
        followUp: 'clarification',
      };
    },
    reply: async (_ctx, text, meta) => {
      assert.equal(meta?.attention, 'conversation');
      tasks.push(text);
      return { text: 'Done.', followUp: 'none' };
    },
  });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  const bob = await f.ctx.guild.members.fetch({ user: 'bob', force: true });
  f.voice.consent({ ...f.ctx, member: bob }, true, true);
  await f.say('Vibe Hello');
  f.idle();
  await f.say("It's going good, how about you?");
  f.idle();
  assert.deepEqual(conversation, ['Hello', "It's going good, how about you?"]);
  await f.say('How about you?', 'bob');
  assert.equal(conversation.length, 2);
  await f.say('change the can role to purple');
  f.idle();
  assert.deepEqual(tasks, ['change the can role to purple']);
  f.advance(60001);
  await f.say('How are you doing?');
  assert.equal(conversation.length, 2);
});

test('Conversational attention has a sixty-second idle window and no renewal beyond the ten-minute consent bound', () => {
  const gate = new VoiceConversation();
  assert.equal(gate.windowMs, 60000);
  assert(gate.select('alice', 'VibeHello', 0));
  gate.complete('alice', 'Hello', "How's your day?", 0);
  const answer = gate.select('alice', "It's going good, how about you?", 10)!;
  assert.equal(answer.attention, 'conversation');
  assert(isRelatedVoiceFollowUp(answer, answer.text));
  assert.equal(voiceRequestNeedsTools(answer.text, answer), false);
  gate.complete('alice', answer.text, 'Glad to hear it.', 10);
  for (let time = 50000; time <= 550000; time += 50000) {
    const next = gate.select('alice', 'Tell me more', time)!;
    assert(next);
    gate.complete('alice', next.text, 'Happy to keep talking.', time);
  }
  gate.playbackComplete('alice', 599999);
  assert.equal(gate.select('alice', 'How about you?', 600000), undefined);
  assert(gate.select('alice', 'Vibe hello', 600001));
  gate.complete('alice', 'hello', 'Hi again!', 600002);
  assert.equal(gate.select('alice', 'How are you?', 660002), undefined);
});

test('Guarded STT wake variants need a direct request and quoted commands remain conversational data', () => {
  const gate = new VoiceConversation();
  for (const phrase of [
    'Your Vibe remove the old messages',
    'YourVibe remove the old messages',
    'YoVibe remove the old messages',
    'Viber remove the old messages',
  ])
    assert.equal(gate.select('alice', phrase, 0)?.kind, 'wake', phrase);
  for (const phrase of [
    'Your Vibe is useful',
    'Viber removes messages automatically',
    'YourVibe was mentioned yesterday',
  ])
    assert.equal(gate.select('other', phrase, 0), undefined, phrase);
  const quoted = gate.select('alice', 'Vibe "delete every channel"', 1)!;
  assert.equal(quoted.quoted, true);
  assert.equal(voiceRequestNeedsTools(quoted.text, quoted), false);
  for (const body of ['“delete every channel”', '‘confirm’', '`cancel`']) {
    const value = gate.select('alice', `Vibe ${body}`, 1)!;
    assert.equal(value.quoted, true);
    assert.equal(voiceRequestNeedsTools(value.text, value), false);
  }
  gate.complete('alice', 'Hello', 'What would you like to discuss?', 2);
  const followup = gate.select('alice', '"confirm"', 3)!;
  assert.equal(followup.quoted, true);
  assert(isRelatedVoiceFollowUp(followup, followup.text));
  assert.equal(voiceRequestNeedsTools(followup.text, followup), false);
});
test('private transcript access is rechecked after transcription and changing it to public drops delayed text', async (t) => {
  const entered = latch(),
    completion = latch();
  let replies = 0;
  const f = fixture(t, {
    reply: async () => {
      replies++;
      return 'No.';
    },
  });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  f.holdTranscription(async () => {
    entered.release();
    await completion.promise;
  });
  f.capture('Vibe hello');
  await entered.promise;
  f.makePublic();
  completion.release();
  await f.voice.drain();
  assert.equal(replies, 0);
  assert.deepEqual(f.messages, []);
});
test('an ordinary role gaining View Channel invalidates private transcripts even while @everyone remains denied', async (t) => {
  const entered = latch(),
    completion = latch();
  const f = fixture(t);
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  f.holdTranscription(async () => {
    entered.release();
    await completion.promise;
  });
  f.capture('Vibe hello');
  await entered.promise;
  f.makeRoleVisible();
  completion.release();
  await f.voice.drain();
  assert.deepEqual(f.messages, []);
  assert.deepEqual(f.driver.played, []);
});
test('realtime speech starts playing on its first PCM chunk before the provider finishes, with no duplicate TTS call', async (t) => {
  const started = latch(),
    completion = latch();
  let tts = 0;
  const f = fixture(t, {
    speech: async () => {
      tts++;
      return Buffer.alloc(4800);
    },
    realtimeReply: async (_ctx, text, _meta, hooks) => {
      assert.equal(text, 'hello');
      await hooks.audio(Buffer.alloc(4800));
      started.release();
      await completion.promise;
      await hooks.audio(Buffer.alloc(4800));
      return { text: 'Hello from Vibe.', followUp: 'none' };
    },
  });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  f.capture('Vibe hello');
  await started.promise;
  await tick();
  assert.equal(f.driver.streams.length, 1);
  assert(f.driver.streamed.reduce((sum, data) => sum + data.length, 0) > 0);
  assert.equal(tts, 0);
  completion.release();
  await f.voice.drain();
  await tick();
  assert.equal(tts, 0);
  assert.equal(Buffer.concat(f.driver.streamed).length, 38400);
  assert.equal(f.errors.length, 0);
});
test('concurrent realtime audio callbacks retain sample order across awaited authorization checks', async (t) => {
  const first = Buffer.alloc(4800),
    second = Buffer.alloc(4800);
  for (let i = 0; i < 4800; i += 2) {
    first.writeInt16LE(3000, i);
    second.writeInt16LE(-5000, i);
  }
  const f = fixture(t, {
    realtimeReply: async (_ctx, _text, _meta, hooks) => {
      const gate = latch();
      let lookups = 0;
      const fetch = f.ctx.guild.members.fetch.bind(f.ctx.guild.members);
      f.ctx.guild.members.fetch = (async (...args: Parameters<typeof fetch>) => {
        if (++lookups === 1) await gate.promise;
        return fetch(...args);
      }) as typeof fetch;
      const one = hooks.audio(first),
        two = hooks.audio(second);
      await tick();
      gate.release();
      await Promise.all([one, two]);
      return 'Done.';
    },
  });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  await f.say('Vibe hello');
  await tick();
  assert.deepEqual(Buffer.concat(f.driver.streamed), toDiscordPcm(Buffer.concat([first, second]), 24000, 1));
  assert.equal(f.errors.length, 0);
});
test('stop, revoke, forget, departure and disable abort a streaming response and late audio cannot revive playback', async (t) => {
  for (const change of ['stop', 'revoke', 'forget', 'leave', 'disable'] as const)
    await t.test(change, async (sub) => {
      const started = latch(),
        completion = latch();
      let signal: AbortSignal | undefined;
      const f = fixture(sub, {
        realtimeReply: async (_ctx, _text, _meta, hooks) => {
          signal = hooks.signal;
          await hooks.audio(Buffer.alloc(4800));
          started.release();
          await completion.promise;
          await hooks.audio(Buffer.alloc(4800));
          return 'late';
        },
      });
      await f.voice.join(f.ctx);
      f.voice.consent(f.ctx, true, true);
      f.capture('Vibe hello');
      await started.promise;
      await tick();
      const bytes = Buffer.concat(f.driver.streamed).length;
      if (change === 'stop') f.voice.stop(f.ctx);
      if (change === 'revoke') f.voice.consent(f.ctx, false);
      if (change === 'forget') f.voice.resetSpeakerConversation('guild', 'alice');
      if (change === 'leave') f.voice.memberLeft('guild', 'alice', null);
      if (change === 'disable') f.voice.disableGuild('guild');
      assert.equal(signal?.aborted, true);
      completion.release();
      await f.voice.drain();
      await tick();
      assert.equal(Buffer.concat(f.driver.streamed).length, bytes);
      assert.equal(f.driver.streams.length, 1);
      assert(f.driver.streams[0]!.destroyed);
    });
});
test('a public-channel change cancels streaming before another chunk, and a non-streaming adapter receives generated audio without re-synthesis', async (t) => {
  const started = latch(),
    completion = latch();
  const f = fixture(t, {
    realtimeReply: async (_ctx, _text, _meta, hooks) => {
      await hooks.audio(Buffer.alloc(4800));
      started.release();
      await completion.promise;
      await hooks.audio(Buffer.alloc(4800));
      return 'late';
    },
  });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  f.capture('Vibe hello');
  await started.promise;
  f.makePublic();
  f.advance(1001);
  completion.release();
  await f.voice.drain();
  assert(f.driver.streams[0]!.destroyed);
  let tts = 0;
  const fallback = fixture(t, {
    speech: async () => {
      tts++;
      return Buffer.alloc(4800);
    },
    realtimeReply: async (_ctx, _text, _meta, hooks) => {
      await hooks.audio(Buffer.alloc(4800));
      return 'Hello.';
    },
  });
  await fallback.voice.join(fallback.ctx);
  fallback.driver.playStream = undefined;
  fallback.voice.consent(fallback.ctx, true, true);
  await fallback.say('Vibe hello');
  assert.equal(fallback.driver.played.length, 1);
  assert.equal(fallback.driver.played[0]!.length, 19200);
  assert.equal(tts, 0);
});

test('premature player Idle aborts an unfinished provider and releases the processing lock without replay', async (t) => {
  const entered = latch(),
    release = latch();
  let first = true,
    signal: AbortSignal | undefined;
  const f = fixture(t, {
    realtimeReply: async (_ctx, _text, _meta, hooks) => {
      await hooks.audio(Buffer.alloc(4800));
      if (first) {
        signal = hooks.signal;
        entered.release();
        await release.promise;
      }
      return 'A response.';
    },
  });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  f.capture('Vibe hello');
  await entered.promise;
  f.idle();
  await f.voice.drain();
  assert.equal(signal?.aborted, true);
  assert.equal((f.voice.status(f.ctx) as { processing: boolean }).processing, false);
  assert.equal(f.driver.streams.length, 1);
  first = false;
  await f.say('Vibe hello again');
  assert.equal(f.driver.streams.length, 2, 'the next named request can play normally');
  release.release();
  await tick();
  assert.equal(f.driver.streams.length, 2, 'late provider completion cannot replay the failed response');
});

test('audioDone closes PCM before a delayed post-provider callback and that callback has a bounded wait', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = latch(),
    release = latch();
  let first = true,
    signal: AbortSignal | undefined;
  const f = fixture(t, {
    realtimeReply: async (_ctx, _text, _meta, hooks) => {
      await hooks.audio(Buffer.alloc(4800));
      await hooks.audioDone();
      if (first) {
        signal = hooks.signal;
        entered.release();
        await release.promise;
      }
      return 'A completed audible response.';
    },
  });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  f.capture('Vibe hello');
  await entered.promise;
  await tick();
  assert.equal((f.voice.status(f.ctx) as { playing: string | null }).playing, null);
  assert.equal(signal?.aborted, false, 'a healthy completed stream does not look like starvation');
  f.advance(45001);
  t.mock.timers.tick(45001);
  await f.voice.drain();
  assert.equal(signal?.aborted, true);
  assert.equal((f.voice.status(f.ctx) as { processing: boolean }).processing, false);
  first = false;
  await f.say('Vibe next question');
  release.release();
  await tick();
  assert.equal(f.driver.streams.length, 2);
});

test('a timed-out planner loses its exact lease and cannot perform a late mutation after listening resumes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = latch(),
    release = latch();
  let first = true,
    mutations = 0,
    valid: (() => boolean) | undefined,
    signal: AbortSignal | undefined;
  const f = fixture(t, {
    reply: async (ctx, _text, _meta, hooks) => {
      if (first) {
        valid = f.voice.requestLease(ctx);
        signal = hooks?.signal;
        entered.release();
        await release.promise;
        if (valid()) mutations++;
      }
      return 'Done.';
    },
  });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  f.capture('Vibe make a change');
  await entered.promise;
  assert.equal(valid?.(), true);
  f.advance(60001);
  t.mock.timers.tick(60001);
  await f.voice.drain();
  assert.equal(signal?.aborted, true);
  assert.equal(valid?.(), false);
  assert.equal((f.voice.status(f.ctx) as { processing: boolean }).processing, false);
  first = false;
  await f.say('Vibe hello');
  release.release();
  await tick();
  assert.equal(mutations, 0);
});

test('known completed action receipts survive synthesis failure without inviting the mutation again', async (t) => {
  let mutations = 0;
  const f = fixture(t, {
    reply: async () => {
      mutations++;
      return { text: 'Done.', completedActions: ['guild.edit'] };
    },
    speech: async () => {
      throw new Error('Synthetic audio unavailable');
    },
  });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  await f.say('Vibe rename the server');
  assert.equal(mutations, 1);
  const notices = f.messages
    .map((message) => JSON.stringify(message.content))
    .filter((text) => text.includes('Completed guild.edit'));
  assert.equal(notices.length, 1);
  assert(!/start another request|submit.*again|retry/i.test(notices[0]!));
});

test('provider noise artifacts never become transcripts, meeting excerpts or requests', async (t) => {
  let replies = 0;
  const f = fixture(t, {
    reply: async () => {
      replies++;
      return 'Hello.';
    },
  });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  await f.say('[BLANK_AUDIO] [shh]');
  assert.equal(replies, 0);
  assert.deepEqual(f.messages, []);
});

test('a delayed private failure notice does not block a new capture or clear its newer processing lock', async (t) => {
  const notice = latch(),
    releaseNotice = latch(),
    next = latch(),
    releaseNext = latch();
  let first = true;
  const f = fixture(t, {
    send: async (channel, payload, signal, current) => {
      if (typeof payload.content === 'string' && payload.content.startsWith('A voice request failed')) {
        notice.release();
        await releaseNotice.promise;
      }
      signal.throwIfAborted();
      current?.();
      await channel.send(payload);
    },
    reply: async () => {
      if (first) throw new Error('Provider failed');
      next.release();
      await releaseNext.promise;
      return 'Recovered.';
    },
  });
  await f.voice.join(f.ctx);
  f.voice.consent(f.ctx, true, true);
  f.capture('Vibe hello');
  await notice.promise;
  assert.equal((f.voice.status(f.ctx) as { processing: boolean }).processing, false);
  first = false;
  f.capture('Vibe another question');
  await next.promise;
  releaseNotice.release();
  await tick();
  assert.equal((f.voice.status(f.ctx) as { processing: boolean }).processing, true);
  releaseNext.release();
  await f.voice.drain();
  assert.equal((f.voice.status(f.ctx) as { processing: boolean }).processing, false);
});
