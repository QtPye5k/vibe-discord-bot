import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ActionRegistry } from '../core/registry.js';
import { UserError } from '../core/errors.js';
import { discordAttachmentUrl, downloadAttachment } from '../core/files.js';
import { heavyWork } from '../core/work-budget.js';

export const AUDIO_MEDIA_LIMITS = Object.freeze({
  inputBytes: 8 * 1024 * 1024,
  outputBytes: 8 * 1024 * 1024,
  timeoutMs: 20_000,
  workers: 2,
  durationSeconds: 120,
  pixels: 2_073_600,
  streams: 8,
});
const trimSchema = {
  startSeconds: z.number().min(0).max(7200).default(0),
  durationSeconds: z.number().min(0.1).max(120).default(30),
};
export const audioEffectSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('equalizer'),
    frequency: z.number().min(20).max(20000),
    gainDb: z.number().min(-12).max(12),
    widthOctaves: z.number().min(0.1).max(4).default(1),
  }),
  z.strictObject({
    kind: z.literal('compressor'),
    threshold: z.number().min(0.001).max(1).default(0.125),
    ratio: z.number().min(1).max(20).default(4),
    attackMs: z.number().min(0.01).max(2000).default(20),
    releaseMs: z.number().min(0.01).max(9000).default(250),
    makeup: z.number().min(1).max(8).default(1),
  }),
  z.strictObject({ kind: z.literal('highpass'), frequency: z.number().min(20).max(20000) }),
  z.strictObject({ kind: z.literal('lowpass'), frequency: z.number().min(20).max(20000) }),
  z.strictObject({
    kind: z.literal('echo'),
    delayMs: z.number().min(10).max(1000).default(100),
    decay: z.number().min(0.1).max(0.8).default(0.3),
  }),
  z.strictObject({ kind: z.literal('tempo'), factor: z.number().min(0.5).max(2) }),
]);
const audioSchema = z.strictObject({
  kind: z.literal('audio'),
  format: z.enum(['mp3', 'ogg', 'wav', 'flac']).default('mp3'),
  bitrateKbps: z.union([z.literal(64), z.literal(96), z.literal(128), z.literal(192)]).default(128),
  volume: z.number().min(0).max(2).default(1),
  effects: z.array(audioEffectSchema).max(6).default([]),
  ...trimSchema,
});
const videoSchema = z.strictObject({
  kind: z.literal('video'),
  format: z.enum(['mp4', 'webm']).default('mp4'),
  width: z
    .number()
    .int()
    .min(32)
    .max(1280)
    .refine((value) => value % 2 === 0, 'Use an even width')
    .default(720),
  quality: z.number().int().min(24).max(40).default(30),
  mute: z.boolean().default(false),
  ...trimSchema,
});
const thumbnailSchema = z.strictObject({
  kind: z.literal('thumbnail'),
  atSeconds: z.number().min(0).max(7200).default(0),
  width: z.number().int().min(32).max(1280).default(640),
});
const waveformSchema = z.strictObject({
  kind: z.literal('waveform'),
  width: z.number().int().min(64).max(1280).default(800),
  height: z.number().int().min(32).max(720).default(200),
  ...trimSchema,
});
export const audioMediaSchema = z.union([audioSchema, videoSchema, thumbnailSchema, waveformSchema]);
export type AudioMediaInput = z.input<typeof audioMediaSchema>;
export interface AudioMediaFile {
  attachment: Buffer;
  name: string;
  notice?: string;
}
export interface AudioMediaInfo {
  format: string;
  bytes: number;
  durationSeconds: number | null;
  streams: {
    type: string;
    codec: string;
    width?: number;
    height?: number;
    channels?: number;
    sampleRate?: number;
  }[];
}
type Container = 'wav' | 'mp3' | 'flac' | 'ogg' | 'mov' | 'matroska';
export function detectMediaContainer(data: Uint8Array): Container {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (!b.length || b.length > AUDIO_MEDIA_LIMITS.inputBytes)
    throw new UserError('Media input must be between 1 byte and 8 MB.');
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WAVE') return 'wav';
  if (b.subarray(0, 4).toString() === 'fLaC') return 'flac';
  if (b.subarray(0, 4).toString() === 'OggS') return 'ogg';
  if (
    b.subarray(0, 3).toString() === 'ID3' ||
    (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 6) !== 0)
  )
    return 'mp3';
  if (b.length >= 12 && b.subarray(4, 8).toString() === 'ftyp') return 'mov';
  if (b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'matroska';
  throw new UserError(
    'Use a WAV, MP3, FLAC, Ogg, MP4 or WebM attachment. Playlists and arbitrary URLs are unsupported.',
  );
}
let active = 0;
async function limited<T>(fn: (deadline: number) => Promise<T>): Promise<T> {
  if (active >= AUDIO_MEDIA_LIMITS.workers)
    throw new UserError('Audio/video processors are busy. Try again shortly.');
  const release = heavyWork.enter();
  active++;
  try {
    return await fn(Date.now() + AUDIO_MEDIA_LIMITS.timeoutMs);
  } finally {
    active--;
    release();
  }
}
function run(
  binary: 'ffmpeg' | 'ffprobe',
  args: string[],
  input: Uint8Array,
  deadline: number,
  maxBytes = AUDIO_MEDIA_LIMITS.outputBytes,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (Date.now() >= deadline) {
      reject(new UserError('Audio/video processing timed out.'));
      return;
    }
    const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let length = 0,
      failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(
      () => stop(new UserError('Audio/video processing timed out.')),
      Math.max(1, deadline - Date.now()),
    );
    child.once('error', () => {
      failure ??= new UserError(`${binary} is unavailable. Install FFmpeg and ffprobe on the host PATH.`);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > maxBytes)
        stop(new UserError('Generated media exceeds 8 MB. Reduce duration, size or bitrate.'));
      else chunks.push(chunk);
    });
    // Discard stderr as it may include attacker-controlled metadata. No unbounded accumulation.
    child.stderr.resume();
    child.stdin.on('error', () => {}); // Decoder exit can close stdin early.
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0 || !length)
        reject(
          new UserError(
            'Invalid, unsupported or non-streamable media. MP4 inputs require a front-loaded moov header (faststart).',
          ),
        );
      else resolve(Buffer.concat(chunks, length));
    });
    child.stdin.end(input);
  });
}
const safeInput = (container: Container) => [
  '-protocol_whitelist',
  'pipe',
  '-format_whitelist',
  container,
  '-probesize',
  '4194304',
  '-analyzeduration',
  '2000000',
  '-max_streams',
  String(AUDIO_MEDIA_LIMITS.streams),
  '-threads',
  '1',
  '-max_pixels',
  String(AUDIO_MEDIA_LIMITS.pixels),
  '-f',
  container,
  '-i',
  'pipe:0',
];
async function probe(data: Uint8Array, container: Container, deadline: number): Promise<AudioMediaInfo> {
  const output = await run(
    'ffprobe',
    [
      '-v',
      'error',
      ...safeInput(container),
      '-show_entries',
      'format=format_name,duration:stream=codec_type,codec_name,width,height,channels,sample_rate,duration',
      '-of',
      'json',
    ],
    data,
    deadline,
    65536,
  );
  let value: { streams?: Record<string, unknown>[]; format?: Record<string, unknown> };
  try {
    value = JSON.parse(output.toString()) as typeof value;
  } catch {
    throw new UserError('Invalid media metadata.');
  }
  if (
    !Array.isArray(value.streams) ||
    !value.streams.length ||
    value.streams.length > AUDIO_MEDIA_LIMITS.streams
  )
    throw new UserError('Media stream count is invalid.');
  const streams = value.streams.map((stream) => {
    const type = String(stream.codec_type ?? 'unknown'),
      width = Number(stream.width),
      height = Number(stream.height),
      channels = Number(stream.channels),
      sampleRate = Number(stream.sample_rate);
    if (
      type === 'video' &&
      (!Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1 ||
        width > 4096 ||
        height > 4096 ||
        width * height > AUDIO_MEDIA_LIMITS.pixels)
    )
      throw new UserError('Video input exceeds 2,073,600 pixels or supported dimensions.');
    if (
      type === 'audio' &&
      (!Number.isFinite(channels) ||
        channels < 1 ||
        channels > 8 ||
        !Number.isFinite(sampleRate) ||
        sampleRate < 8000 ||
        sampleRate > 192000)
    )
      throw new UserError('Audio channels or sample rate exceed supported limits.');
    return {
      type,
      codec: String(stream.codec_name ?? 'unknown').slice(0, 60),
      ...(type === 'video' ? { width, height } : {}),
      ...(type === 'audio' ? { channels, sampleRate } : {}),
    };
  });
  const duration = Number(
    value.format?.duration ??
      value.streams.find((stream) => Number.isFinite(Number(stream.duration)))?.duration,
  );
  return {
    format: String(value.format?.format_name ?? container).slice(0, 100),
    bytes: data.length,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
    streams,
  };
}
export async function inspectAudioMedia(data: Uint8Array): Promise<AudioMediaInfo> {
  const container = detectMediaContainer(data);
  return limited((deadline) => probe(data, container, deadline));
}
/** Decode uploaded/approved bounded audio to Discord PCM; no URL, filesystem or external protocol reaches FFmpeg. */
export async function decodeAudioPcm(data: Uint8Array, maxSeconds = 120): Promise<Buffer> {
  if (!Number.isFinite(maxSeconds) || maxSeconds < 0.1 || maxSeconds > 120)
    throw new UserError('Audio decoding duration must be 0.1–120 seconds.');
  const container = detectMediaContainer(data);
  return limited(async (deadline) => {
    const info = await probe(data, container, deadline);
    if (!info.streams.some((stream) => stream.type === 'audio'))
      throw new UserError('The attachment contains no audio stream.');
    if (info.durationSeconds !== null && info.durationSeconds > maxSeconds + 0.05)
      throw new UserError(`Audio exceeds the ${maxSeconds}-second voice playback limit; trim it first.`);
    const pcm = await run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        ...safeInput(container),
        '-t',
        String(maxSeconds),
        '-map',
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-ac',
        '2',
        '-ar',
        '48000',
        '-c:a',
        'pcm_s16le',
        '-f',
        's16le',
        '-threads',
        '1',
        'pipe:1',
      ],
      data,
      deadline,
      Math.ceil(maxSeconds * 48000 * 4),
    );
    if (!pcm.length || pcm.length % 4) throw new UserError('Audio decoder returned incomplete PCM.');
    return pcm;
  });
}
export async function processAudioMedia(data: Uint8Array, raw: AudioMediaInput): Promise<AudioMediaFile> {
  const options = audioMediaSchema.parse(raw),
    container = detectMediaContainer(data);
  return limited(async (deadline) => {
    const info = await probe(data, container, deadline);
    const audio = info.streams.some((stream) => stream.type === 'audio'),
      video = info.streams.some((stream) => stream.type === 'video');
    if ((options.kind === 'audio' || options.kind === 'waveform') && !audio)
      throw new UserError('This operation requires an audio stream.');
    if ((options.kind === 'video' || options.kind === 'thumbnail') && !video)
      throw new UserError('This operation requires a video stream.');
    const start = options.kind === 'thumbnail' ? options.atSeconds : options.startSeconds;
    if (info.durationSeconds !== null && start >= info.durationSeconds)
      throw new UserError('The requested start is past the end of this media.');
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-filter_threads',
      '1',
      '-filter_complex_threads',
      '1',
      ...safeInput(container),
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
    ];
    if (options.kind !== 'waveform') args.push('-ss', String(start));
    let name: string;
    if (options.kind === 'audio') {
      args.push(
        '-t',
        String(options.durationSeconds),
        '-map',
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        '-ac',
        '2',
        '-ar',
        '48000',
        '-af',
        [
          `volume=${options.volume}`,
          ...options.effects.map((effect) =>
            effect.kind === 'equalizer'
              ? `equalizer=f=${effect.frequency}:t=o:w=${effect.widthOctaves}:g=${effect.gainDb}`
              : effect.kind === 'compressor'
                ? `acompressor=threshold=${effect.threshold}:ratio=${effect.ratio}:attack=${effect.attackMs}:release=${effect.releaseMs}:makeup=${effect.makeup}`
                : effect.kind === 'highpass' || effect.kind === 'lowpass'
                  ? `${effect.kind}=f=${effect.frequency}`
                  : effect.kind === 'echo'
                    ? `aecho=0.8:0.8:${effect.delayMs}:${effect.decay}`
                    : `atempo=${effect.factor}`,
          ),
        ].join(','),
        '-threads',
        '1',
      );
      if (options.format === 'mp3')
        args.push('-c:a', 'libmp3lame', '-b:a', `${options.bitrateKbps}k`, '-f', 'mp3');
      else if (options.format === 'ogg')
        args.push('-c:a', 'libopus', '-b:a', `${options.bitrateKbps}k`, '-f', 'ogg');
      else args.push('-c:a', options.format === 'flac' ? 'flac' : 'pcm_s16le', '-f', options.format);
      name = `audio.${options.format}`;
    } else if (options.kind === 'video') {
      args.push(
        '-t',
        String(options.durationSeconds),
        '-map',
        '0:v:0',
        '-sn',
        '-dn',
        '-vf',
        `scale=w='min(${options.width},iw)':h=-2:flags=fast_bilinear`,
        '-r',
        '24',
        '-pix_fmt',
        'yuv420p',
        '-threads',
        '1',
      );
      if (options.mute || !audio) args.push('-an');
      else
        args.push(
          '-map',
          '0:a:0',
          '-ac',
          '2',
          '-ar',
          '48000',
          '-c:a',
          options.format === 'mp4' ? 'aac' : 'libopus',
          '-b:a',
          '96k',
        );
      if (options.format === 'mp4')
        args.push(
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-crf',
          String(options.quality),
          '-movflags',
          'frag_keyframe+empty_moov',
          '-f',
          'mp4',
        );
      else
        args.push(
          '-c:v',
          'libvpx-vp9',
          '-deadline',
          'realtime',
          '-cpu-used',
          '8',
          '-crf',
          String(options.quality),
          '-b:v',
          '0',
          '-f',
          'webm',
        );
      name = `video.${options.format}`;
    } else if (options.kind === 'thumbnail') {
      args.push(
        '-map',
        '0:v:0',
        '-frames:v',
        '1',
        '-an',
        '-sn',
        '-dn',
        '-vf',
        `scale=w='min(${options.width},iw)':h=-2`,
        '-threads',
        '1',
        '-c:v',
        'png',
        '-f',
        'image2pipe',
      );
      name = 'thumbnail.png';
    } else {
      args.push(
        '-t',
        String(options.durationSeconds),
        '-filter_complex',
        `[0:a:0]atrim=start=${options.startSeconds}:duration=${options.durationSeconds},asetpts=PTS-STARTPTS,showwavespic=s=${options.width}x${options.height}:colors=6366f1[v]`,
        '-map',
        '[v]',
        '-frames:v',
        '1',
        '-an',
        '-sn',
        '-dn',
        '-threads',
        '1',
        '-c:v',
        'png',
        '-f',
        'image2pipe',
      );
      name = 'waveform.png';
    }
    args.push('pipe:1');
    return {
      attachment: await run('ffmpeg', args, data, deadline),
      name,
      notice:
        'Only the selected first stream is processed. Output is bounded to the requested duration and 8 MB; metadata and embedded subtitles are removed.',
    };
  });
}
const subtitleSchema = z.strictObject({
  segments: z
    .array(
      z.strictObject({
        startSeconds: z.number().min(0).max(86400),
        endSeconds: z.number().min(0).max(86400),
        text: z.string().min(1).max(1000),
      }),
    )
    .min(1)
    .max(1000),
  format: z.enum(['srt', 'vtt']).default('srt'),
});
export function createSubtitles(raw: z.input<typeof subtitleSchema>): AudioMediaFile {
  const input = subtitleSchema.parse(raw);
  let last = 0;
  const stamp = (value: number) => {
    const ms = Math.round(value * 1000);
    return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${input.format === 'srt' ? ',' : '.'}${String(ms % 1000).padStart(3, '0')}`;
  };
  const blocks = input.segments.map((segment, index) => {
    if (segment.endSeconds <= segment.startSeconds || segment.startSeconds < last)
      throw new UserError('Subtitle segments must be ordered, non-overlapping, and have positive duration.');
    last = segment.endSeconds;
    const text = segment.text
      .replace(/\r/g, '')
      .replace(/\n{2,}/g, '\n')
      .replace(/-->/g, '→')
      .replace(/[<>]/g, '')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    return `${input.format === 'srt' ? `${index + 1}\n` : ''}${stamp(segment.startSeconds)} --> ${stamp(segment.endSeconds)}\n${text}`;
  });
  return {
    attachment: Buffer.from(`${input.format === 'vtt' ? 'WEBVTT\n\n' : ''}${blocks.join('\n\n')}\n`),
    name: `subtitles.${input.format}`,
  };
}
export function registerAudioMediaActions(registry: ActionRegistry): void {
  const base = { category: 'media', risk: 'read' as const, userPermissions: [], botPermissions: [] };
  const url = z
    .string()
    .max(4096)
    .refine((value) => {
      try {
        discordAttachmentUrl(value);
        return true;
      } catch {
        return false;
      }
    }, 'Use a Discord-hosted HTTPS attachment URL');
  registry.register({
    ...base,
    id: 'media.info',
    description: 'Inspect bounded WAV/MP3/FLAC/Ogg/MP4/WebM stream metadata with FFprobe.',
    schema: z.strictObject({ url }),
    execute: async (_ctx, input) =>
      inspectAudioMedia(await downloadAttachment(input.url, AUDIO_MEDIA_LIMITS.inputBytes)),
  });
  for (const [id, schema, description] of [
    [
      'audio.convert',
      audioSchema.omit({ kind: true }),
      'Convert or trim audio to MP3, Opus/Ogg, WAV or FLAC, with validated volume, equalizer, compressor, pass filters, echo and tempo effects.',
    ],
    [
      'video.convert',
      videoSchema.omit({ kind: true }),
      'Trim, compress, resize or mute the first video stream to MP4/WebM.',
    ],
    [
      'video.thumbnail',
      thumbnailSchema.omit({ kind: true }),
      'Extract a bounded PNG thumbnail at a video timestamp.',
    ],
    ['audio.waveform', waveformSchema.omit({ kind: true }), 'Render a bounded audio waveform PNG.'],
  ] as const) {
    const kind =
      id === 'audio.convert'
        ? 'audio'
        : id === 'video.convert'
          ? 'video'
          : id === 'video.thumbnail'
            ? 'thumbnail'
            : 'waveform';
    registry.register({
      ...base,
      id,
      description,
      schema: z.strictObject({ url, ...schema.shape }),
      execute: async (_ctx, input) => {
        const { url: source, ...options } = input;
        return processAudioMedia(await downloadAttachment(source, AUDIO_MEDIA_LIMITS.inputBytes), {
          kind,
          ...options,
        } as AudioMediaInput);
      },
    });
  }
  registry.register({
    ...base,
    id: 'media.subtitles',
    description: 'Generate valid SRT or WebVTT from explicit timed transcript segments.',
    schema: subtitleSchema,
    execute: (_ctx, input) => createSubtitles(input),
  });
}
