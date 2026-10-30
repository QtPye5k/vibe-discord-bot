import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { PermissionFlagsBits as P, PermissionsBitField, type Guild } from 'discord.js';
import { z } from 'zod';
import { Store } from '../src/core/store.js';
import { ActionRegistry } from '../src/core/registry.js';
import type { ActionContext } from '../src/core/types.js';
import { registerDiscordActions } from '../src/discord/actions.js';
import { registerMediaWorkflowActions, perceptualDistance } from '../src/features/media-workflows.js';
import { processImage, createBarChart, runMediaJob, type MediaFile } from '../src/features/media.js';
import { extractFile } from '../src/features/files.js';
import { decodeAudioPcm, processAudioMedia } from '../src/features/audio-media.js';
import { pcmToWav } from '../src/features/voice.js';
const G = '920000000000000001',
  U = '920000000000000002',
  B = '920000000000000003',
  C = '920000000000000004',
  D = '920000000000000005';
const attachment = 'https://cdn.discordapp.com/attachments/920000000000000001/920000000000000009/image.png';
async function fixture(t: TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const member = {
      id: U,
      displayName: 'Example member',
      permissions: new PermissionsBitField(P.Administrator),
      roles: { cache: new Map() },
    },
    bot = { id: B, permissions: new PermissionsBitField(P.Administrator) };
  const hidden = new Set<string>(),
    uploads: { kind: string; data: unknown }[] = [],
    profiles: string[] = [];
  const channel = {
    id: C,
    guildId: G,
    type: 0,
    permissionsFor: (principal: { id: string }) =>
      new PermissionsBitField(hidden.has(principal.id) ? 0n : P.Administrator),
  };
  const guild = {
    id: G,
    ownerId: U,
    name: 'Example server',
    memberCount: 123,
    premiumSubscriptionCount: 4,
    fetch: async () => guild,
    members: { me: bot, fetch: async () => member, fetchMe: async () => bot },
    channels: {
      fetch: async (id: string) =>
        id === C
          ? channel
          : { ...channel, id: D, permissionsFor: () => new PermissionsBitField(P.Administrator) },
    },
    emojis: {
      create: async (data: unknown) => {
        uploads.push({ kind: 'emoji', data });
        return { id: 'emoji', name: 'emoji' };
      },
    },
    soundboardSounds: {
      create: async (data: unknown) => {
        uploads.push({ kind: 'soundboard', data });
        return { id: 'sound', name: 'sound', volume: 1 };
      },
    },
  } as unknown as Guild;
  Object.assign(member, { guild });
  Object.assign(bot, { guild });
  const ctx = { store, guild, member, channelId: C, client: {} } as unknown as ActionContext;
  const png = await sharp({ create: { width: 100, height: 80, channels: 4, background: '#ff0000' } })
    .png()
    .toBuffer();
  let source: Buffer = png;
  const registry = new ActionRegistry();
  registerDiscordActions(registry);
  registry.register({
    id: 'level.profile',
    category: 'community',
    description: 'A real profile binding fixture',
    risk: 'read',
    userPermissions: [],
    botPermissions: [],
    schema: z.strictObject({ userId: z.string() }),
    execute: (_ctx, input) => {
      profiles.push(input.userId);
      return { level: 4, xp: 1800, nextLevelXp: 2500, observedActiveMessages: 47 };
    },
  });
  registry.register({
    id: 'analytics.observed',
    category: 'analytics',
    description: 'Observed counters fixture',
    risk: 'read',
    userPermissions: [P.ManageGuild],
    botPermissions: [],
    schema: z.strictObject({ days: z.number() }),
    execute: () => [{ day: new Date().toISOString().slice(0, 10), kind: 'messages', count: 42 }],
  });
  registerMediaWorkflowActions(registry, { download: async () => Buffer.from(source) });
  const execute = async (id: string, input: unknown = {}) => {
    const requested = await registry.request(ctx, id, input);
    const completed =
      requested.status === 'confirmation' ? await registry.confirm(ctx, requested.id) : requested;
    assert.equal(completed.status, 'completed');
    return completed.status === 'completed' ? completed.result : undefined;
  };
  return {
    store,
    ctx,
    member,
    guild,
    registry,
    execute,
    hidden,
    uploads,
    profiles,
    png,
    setSource(value: Buffer) {
      source = value;
    },
  };
}
test('real image filter stacks preserve order and local background removal preserves enclosed foreground details', async () => {
  const input = await sharp({ create: { width: 5, height: 5, channels: 4, background: '#ffffff' } })
    .raw()
    .toBuffer();
  for (let y = 1; y < 4; y++)
    for (let x = 1; x < 4; x++) {
      if (x === 2 && y === 2) continue;
      const i = (y * 5 + x) * 4;
      input[i] = 255;
      input[i + 1] = 0;
      input[i + 2] = 0;
    }
  const png = await sharp(input, { raw: { width: 5, height: 5, channels: 4 } })
    .png()
    .toBuffer();
  const transparent = await processImage(png, {
    kind: 'background-remove',
    color: '#ffffff',
    tolerance: 0,
    feather: 0,
  });
  const raw = await sharp(transparent.attachment).ensureAlpha().raw().toBuffer();
  assert.equal(raw[3], 0);
  assert.equal(raw[(2 * 5 + 2) * 4 + 3], 255);
  assert.equal(raw[(1 * 5 + 1) * 4 + 3], 255);
  const source = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#ff0000' } })
    .png()
    .toBuffer();
  const first = await processImage(source, {
    kind: 'filters',
    steps: [{ kind: 'modulate', brightness: 0.5 }, { kind: 'negate' }],
  });
  const second = await processImage(source, {
    kind: 'filters',
    steps: [{ kind: 'negate' }, { kind: 'modulate', brightness: 0.5 }],
  });
  assert.notDeepEqual(first.attachment, second.attachment);
  assert.equal((await sharp(first.attachment).metadata()).hasAlpha, true);
});
test('line, area, scatter and pie graph renderers produce real bounded PNGs', async () => {
  for (const style of ['line', 'area', 'scatter', 'pie'] as const) {
    const file = await createBarChart({
      title: 'Actual chart <safe>',
      style,
      values: [
        { label: 'One', value: 2 },
        { label: 'Two', value: 7 },
        { label: 'Three', value: 4 },
      ],
    });
    const metadata = await sharp(file.attachment).metadata();
    assert.equal(metadata.width, 1100);
    assert.equal(metadata.height, 650);
    assert.equal(metadata.format, 'png');
  }
  await assert.rejects(
    () => createBarChart({ title: 'Empty pie', style: 'pie', values: [{ label: 'None', value: 0 }] }),
    /positive total/,
  );
});
test('perceptual hashes recognize matching pixels across encodings and distinguish mirrored gradients', async () => {
  const raw = Buffer.alloc(9 * 8 * 3);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 9; x++) raw.fill(x * 25, (y * 9 + x) * 3, (y * 9 + x + 1) * 3);
  const image = sharp(raw, { raw: { width: 9, height: 8, channels: 3 } }),
    png = await image.clone().png().toBuffer(),
    other = await image.clone().webp({ lossless: true }).toBuffer(),
    mirror = await image.clone().flop().png().toBuffer();
  const hashes = [];
  for (const data of [png, other, mirror]) {
    const result = await runMediaJob({ kind: 'image-hash', data });
    assert.ok('perceptualHash' in result);
    hashes.push(result as { perceptualHash: string; sha256: string });
  }
  assert.notEqual(hashes[0]!.sha256, hashes[1]!.sha256);
  assert.equal(perceptualDistance(hashes[0]!.perceptualHash, hashes[1]!.perceptualHash), 0);
  assert.equal(perceptualDistance(hashes[0]!.perceptualHash, hashes[2]!.perceptualHash), 64);
});
test('profile/rank/statistics bindings and one-step observed workbook use actual source records', async (t) => {
  const f = await fixture(t);
  const rank = (await f.execute('image.rank')) as MediaFile;
  assert.equal((await sharp(rank.attachment).metadata()).width, 1024);
  assert.deepEqual(f.profiles, [U]);
  const stats = (await f.execute('image.statistics')) as MediaFile;
  assert.equal((await sharp(stats.attachment).metadata()).height, 320);
  const workbook = (await f.execute('analytics.workbook')) as MediaFile;
  const extracted = extractFile(workbook.attachment, 'analytics.xlsx');
  assert.equal(extracted.sheets?.length, 2);
  assert.equal(extracted.sheets?.[0]?.rows[1]?.[2], 42);
});
test('duplicate media index excludes records whose source channel becomes inaccessible', async (t) => {
  const f = await fixture(t);
  await f.execute('media.index.add', { url: attachment, name: 'Private media' });
  assert.equal(((await f.execute('media.duplicates', { url: attachment })) as unknown[]).length, 1);
  f.ctx.channelId = D;
  f.hidden.add(U);
  assert.deepEqual(await f.execute('media.duplicates', { url: attachment }), []);
});
test('emoji and soundboard preparation performs no native write before human confirmation', async (t) => {
  const f = await fixture(t);
  const pending = await f.registry.request(f.ctx, 'image.emoji.create', {
    url: attachment,
    name: 'test_emoji',
  });
  assert.equal(f.uploads.length, 0);
  assert.equal(pending.status, 'confirmation');
  if (pending.status !== 'confirmation') throw new Error();
  await f.registry.confirm(f.ctx, pending.id);
  const emoji = f.uploads[0]!.data as { attachment: string };
  assert.equal((await sharp(Buffer.from(emoji.attachment.split(',')[1]!, 'base64')).metadata()).width, 128);
  f.setSource(pcmToWav(Buffer.alloc(48000 * 4)));
  const sound = await f.registry.request(f.ctx, 'media.soundboard.create', {
    url: attachment,
    name: 'Test sound',
    durationSeconds: 0.5,
  });
  assert.equal(f.uploads.length, 1);
  if (sound.status !== 'confirmation') throw new Error();
  await f.registry.confirm(f.ctx, sound.id);
  assert.equal(f.uploads[1]!.kind, 'soundboard');
});
test('compressed audio decoding and fixed equalizer/compressor/effect graphs execute real FFmpeg processing', async () => {
  const pcm = Buffer.alloc(48000 * 4);
  for (let index = 0; index < 48000; index++) {
    const value = Math.round(6000 * Math.sin((2 * Math.PI * 440 * index) / 48000));
    pcm.writeInt16LE(value, index * 4);
    pcm.writeInt16LE(value, index * 4 + 2);
  }
  const mp3 = await processAudioMedia(pcmToWav(pcm), {
    kind: 'audio',
    format: 'mp3',
    durationSeconds: 0.8,
    effects: [
      { kind: 'equalizer', frequency: 440, gainDb: -6 },
      { kind: 'compressor', threshold: 0.1, ratio: 4 },
      { kind: 'echo', delayMs: 50, decay: 0.2 },
      { kind: 'highpass', frequency: 40 },
    ],
  });
  const decoded = await decodeAudioPcm(mp3.attachment);
  assert.ok(decoded.length > 48000);
  assert.ok(decoded.length < 48000 * 4 * 2);
  assert.ok((await decodeAudioPcm(mp3.attachment, 0.1)).length <= 19200);
  assert.ok((await decodeAudioPcm(pcmToWav(pcm), 0.1)).length <= 19200);
  await assert.rejects(
    () =>
      processAudioMedia(pcmToWav(pcm), {
        kind: 'audio',
        effects: [{ kind: 'equalizer', frequency: 440, gainDb: 99 }],
      }),
    /greater than|Too big|<=12/,
  );
});
test('prepared media workflows route native uploads to staff approval without implicit confirmation', async (t) => {
  const f = await fixture(t),
    approvalChannelId = '920000000000000009',
    published: string[] = [];
  f.registry.setConfirmationPolicy({
    channelId: () => approvalChannelId,
    publish: async (_ctx, pending) => {
      published.push(pending.action);
    },
    authorize: async (ctx) => {
      if (ctx.channelId !== approvalChannelId) throw new Error('Private staff approval required');
      return ctx;
    },
  });
  const execute = async (id: string, input: unknown) => {
    const requested = await f.registry.request(f.ctx, id, input);
    assert.equal(requested.status, 'confirmation');
    if (requested.status !== 'confirmation') throw new Error('Missing preview');
    const approved = await f.registry.confirm({ ...f.ctx, channelId: approvalChannelId }, requested.id);
    assert.equal(approved.status, 'completed');
    return approved.status === 'completed' ? approved.result : undefined;
  };
  const emoji = (await execute('image.emoji.create', { url: attachment, name: 'test_emoji' })) as {
    status: string;
    notice: string;
    approvalChannelId: string;
  };
  assert.equal(emoji.status, 'approval-routed');
  assert.match(emoji.notice, /has not been created/);
  assert.equal(emoji.approvalChannelId, approvalChannelId);
  f.setSource(pcmToWav(Buffer.alloc(48000 * 4)));
  const sound = (await execute('media.soundboard.create', {
    url: attachment,
    name: 'Test sound',
    durationSeconds: 0.5,
  })) as { status: string; notice: string };
  assert.equal(sound.status, 'approval-routed');
  assert.match(sound.notice, /has not been created/);
  assert.deepEqual(published, [
    'image.emoji.create',
    'emoji.create',
    'media.soundboard.create',
    'soundboard.create',
  ]);
  assert.deepEqual(f.uploads, []);
});
