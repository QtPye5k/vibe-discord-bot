import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { ActionRegistry } from '../src/core/registry.js';
import {
  AUDIO_MEDIA_LIMITS,
  registerAudioMediaActions,
  detectMediaContainer,
  inspectAudioMedia,
  processAudioMedia,
  createSubtitles,
} from '../src/features/audio-media.js';

const available =
  spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { windowsHide: true }).status === 0;
const mediaTest = available ? test : test.skip;
function wav(seconds = 1): Buffer {
  const samples = Math.round(16000 * seconds),
    data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF');
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24);
  data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    data.writeInt16LE(Math.round(8000 * Math.sin((i * 440 * 2 * Math.PI) / 16000)), 44 + i * 2);
  return data;
}
function video() {
  return execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=96x64:r=12:d=1',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-c:a',
      'aac',
      '-t',
      '1',
      '-movflags',
      'frag_keyframe+empty_moov',
      '-f',
      'mp4',
      'pipe:1',
    ],
    { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 10000 },
  );
}
test('six media actions expose strict bounded options and Discord-only downloads', () => {
  const registry = new ActionRegistry();
  registerAudioMediaActions(registry);
  assert.equal(registry.list().length, 6);
  for (const action of registry.list()) assert.equal(action.risk, 'read');
  assert.throws(() => registry.get('media.info').schema.parse({ url: 'http://127.0.0.1/private' }));
  assert.throws(() =>
    registry
      .get('video.convert')
      .schema.parse({ url: 'https://cdn.discordapp.com/attachments/1/2/video.mp4', width: 127 }),
  );
  assert.throws(() =>
    registry
      .get('audio.convert')
      .schema.parse({ url: 'https://cdn.discordapp.com/attachments/1/2/audio.wav', durationSeconds: 121 }),
  );
  assert.throws(() =>
    registry
      .get('audio.convert')
      .schema.parse({ url: 'https://cdn.discordapp.com/attachments/1/2/audio.wav', filter: 'movie=/secret' }),
  );
});
test('container checks reject playlists, SVGs, external references and oversized inputs before spawning', () => {
  for (const source of [
    '',
    '#EXTM3U\nhttps://example.com/private',
    'ffconcat version 1.0\nfile /secret',
    '<svg/>',
    '%PDF-1.0',
  ])
    assert.throws(() => detectMediaContainer(Buffer.from(source)), /input|Use a/);
  assert.throws(() => detectMediaContainer(Buffer.alloc(AUDIO_MEDIA_LIMITS.inputBytes + 1)), /8 MB/);
  assert.equal(detectMediaContainer(wav()), 'wav');
});
mediaTest('FFprobe inspects a real PCM WAV including audio rate and channels', async () => {
  const info = await inspectAudioMedia(wav());
  assert.equal(info.format, 'wav');
  assert.equal(info.streams[0]?.channels, 1);
  assert.equal(info.streams[0]?.sampleRate, 16000);
  assert.equal(info.streams[0]?.codec, 'pcm_s16le');
});
mediaTest('real WAV is trimmed and encoded as MP3, Opus/Ogg, FLAC and WAV', async () => {
  for (const format of ['mp3', 'ogg', 'flac', 'wav'] as const) {
    const file = await processAudioMedia(wav(), {
      kind: 'audio',
      format,
      startSeconds: 0.2,
      durationSeconds: 0.3,
    });
    assert.equal(file.name, `audio.${format}`);
    assert.ok(file.attachment.length > 50);
    const info = await inspectAudioMedia(file.attachment);
    assert.equal(info.streams[0]?.type, 'audio');
    assert.equal(info.streams[0]?.channels, 2);
    const decoded = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'],
      { input: file.attachment, windowsHide: true, timeout: 10000, maxBuffer: 100000 },
    );
    assert.ok(decoded.length >= 9000 && decoded.length < 16000, `${format}: ${decoded.length}`);
  }
});
mediaTest('volume zero creates silent decoded output and malformed containers fail safely', async () => {
  const silent = await processAudioMedia(wav(), {
    kind: 'audio',
    format: 'wav',
    durationSeconds: 0.1,
    volume: 0,
  });
  const decoded = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', 'pipe:1'], {
    input: silent.attachment,
    windowsHide: true,
    timeout: 10000,
  });
  assert.ok(decoded.every((byte) => byte === 0));
  await assert.rejects(inspectAudioMedia(Buffer.from('RIFF0000WAVEbad')), /Invalid/);
  await assert.rejects(processAudioMedia(wav(), { kind: 'video' }), /requires a video/);
});
mediaTest('waveform output is a real colored PNG with requested dimensions', async () => {
  const file = await processAudioMedia(wav(), {
    kind: 'waveform',
    width: 160,
    height: 80,
    durationSeconds: 0.3,
  });
  const info = await sharp(file.attachment).metadata();
  assert.equal(info.width, 160);
  assert.equal(info.height, 80);
  assert.equal(info.format, 'png');
  const trimmed = await processAudioMedia(wav(), {
    kind: 'waveform',
    startSeconds: 0.2,
    durationSeconds: 0.3,
    width: 160,
    height: 80,
  });
  assert.equal((await sharp(trimmed.attachment).metadata()).width, 160);
});
mediaTest('a third concurrent media operation is rejected without unbounded process queues', async () => {
  const input = wav();
  const first = inspectAudioMedia(input),
    second = inspectAudioMedia(input);
  await assert.rejects(inspectAudioMedia(input), /busy/);
  await Promise.all([first, second]);
});
mediaTest('real video compresses to MP4/WebM, extracts audio and produces a thumbnail', async () => {
  const input = video();
  const info = await inspectAudioMedia(input);
  assert.ok(info.streams.some((stream) => stream.type === 'video' && stream.width === 96));
  for (const format of ['mp4', 'webm'] as const) {
    const file = await processAudioMedia(input, {
      kind: 'video',
      format,
      width: 64,
      durationSeconds: 0.5,
      mute: true,
    });
    const output = await inspectAudioMedia(file.attachment);
    assert.equal(output.streams[0]?.width, 64);
    assert.equal(output.streams[0]?.height, 42);
    assert.ok(output.streams.every((stream) => stream.type !== 'audio'));
  }
  const thumb = await processAudioMedia(input, { kind: 'thumbnail', width: 64, atSeconds: 0.2 });
  assert.equal((await sharp(thumb.attachment).metadata()).width, 64);
  const audio = await processAudioMedia(input, { kind: 'audio', durationSeconds: 0.3 });
  assert.ok((await inspectAudioMedia(audio.attachment)).streams.every((stream) => stream.type === 'audio'));
});
test('SRT and VTT use valid timestamps and reject overlapping, reversed or unordered segments', () => {
  const segments = [
    { startSeconds: 0.001, endSeconds: 1.25, text: 'Hello <script>\n\nworld --> test' },
    { startSeconds: 2, endSeconds: 3.5, text: 'Second' },
  ];
  const srt = createSubtitles({ segments }).attachment.toString();
  assert.match(srt, /^1\n00:00:00,001 --> 00:00:01,250/);
  assert.match(srt, /Hello script\nworld → test/);
  assert.match(createSubtitles({ segments, format: 'vtt' }).attachment.toString(), /^WEBVTT\n\n00:00:00.001/);
  for (const segments of [
    [{ startSeconds: 1, endSeconds: 1, text: 'a' }],
    [
      { startSeconds: 1, endSeconds: 2, text: 'a' },
      { startSeconds: 1.5, endSeconds: 3, text: 'b' },
    ],
  ])
    assert.throws(() => createSubtitles({ segments }), /ordered/);
});
