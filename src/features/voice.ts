import { Readable, PassThrough } from 'node:stream';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, opendir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import {
  ChannelType,
  PermissionFlagsBits as P,
  type MessageCreateOptions,
  type VoiceBasedChannel,
  type SendableChannels,
} from 'discord.js';
import { z } from 'zod';
import { CompletedActionError, UserError } from '../core/errors.js';
import { downloadAttachment } from '../core/files.js';
import { resolveChannel } from '../core/permissions.js';
import type { ActionRegistry } from '../core/registry.js';
import { userRequestContext, type ActionContext } from '../core/types.js';
import type { Store } from '../core/store.js';
import { prepareVoiceRuntime, waitForVoiceRecovery } from '../voice/runtime.js';
import { VoiceConversation, type VoiceReply, type VoiceTurnMeta } from '../voice/conversation.js';
import { SpeechPcmStream } from '../voice/pcm-stream.js';
import { voiceDeadline } from '../voice/deadline.js';
import { sendVoiceMessage } from '../voice/delivery.js';
import { filterTranscription } from '../voice/transcript-filter.js';
import { assertPrivateTranscriptPrivacy } from '../voice/transcripts.js';
import { decodeAudioPcm } from './audio-media.js';
import { fetchPublic } from './integrations.js';
import {
  acousticVoiceActivity,
  saveVoiceRecording,
  ownVoiceRecordings,
  voiceRecording,
  eraseVoiceRecordings,
  pruneVoiceRecordings,
  type VoiceRecordingPolicy,
} from '../voice/recordings.js';

const MAX_ATTACHMENT = 8 * 1024 * 1024;
const MAX_PLAY_SECONDS = 120;
const PCM_BYTES_SECOND = 48_000 * 2 * 2;
const MAX_QUEUE_BYTES = 24 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 15 * PCM_BYTES_SECOND;
const CONSENT_MS = 10 * 60_000;
const PLAYBACK_GRACE_MS = 10_000;
export const VOICE_LANGUAGES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh', 'ar', 'hi'] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];
const localAudioId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);

export interface VoiceHooks {
  idle(): void;
  speaking(userId: string): void;
  disconnected(): void;
  error(error: unknown): void;
  connectionState?(state: 'ready' | 'recovering'): void;
  diagnostic?(stage: string, fields?: Record<string, string | number | boolean | undefined>): void;
}
export interface VoiceDriver {
  play(pcm: Buffer, volume: number): void;
  playStream?(pcm: Readable, volume: number): void;
  pause(): boolean;
  resume(): boolean;
  stop(): void;
  destroy(): void;
  setVolume?(value: number): void;
  move?(channel: VoiceBasedChannel): Promise<void>;
  receive(
    userId: string,
    chunk: (pcm: Buffer) => void,
    end: () => void,
    error: (error: unknown) => void,
  ): () => void;
}
export type VoiceDriverFactory = (channel: VoiceBasedChannel, hooks: VoiceHooks) => Promise<VoiceDriver>;
export type VoiceCommandPayload = MessageCreateOptions & {
  voiceResponse?: string;
  followUp?: VoiceReply['followUp'];
};
export interface VoiceRequestHooks {
  signal: AbortSignal;
}
export interface VoiceOptions {
  transcriptionProvider?: 'local' | 'openai';
  onSpeakerReset?: (guildId: string, userId?: string) => void;
  botName?: string;
  wakeWords?: readonly string[];
  followUpSeconds?: number;
  /** Enabled by the application; false only for explicit legacy standalone integrations. */
  requireWakeWord?: boolean;
  requirePrivateTranscripts?: boolean;
  resolveTranscriptChannel?: (ctx: ActionContext) => Promise<string>;
  silenceMs?: number;
  realtimeReply?: (
    ctx: ActionContext,
    text: string,
    meta: VoiceTurnMeta,
    hooks: {
      audio: (pcm24k: Uint8Array) => Promise<void>;
      audioDone: () => Promise<void>;
      signal: AbortSignal;
    },
  ) => Promise<string | VoiceReply | undefined>;
  store?: Store;
  /** Concurrent connected/joining servers, default 5, hard range 1–20. */
  maxSessions?: number;
  /** Return signed 16-bit little-endian PCM, 24 kHz, mono (OpenAI speech format: pcm). */
  speech?: (ctx: ActionContext, text: string, hooks?: VoiceRequestHooks) => Promise<Uint8Array>;
  transcribe?: (ctx: ActionContext, wav: Buffer, hooks?: VoiceRequestHooks) => Promise<string>;
  /** Tools, if enabled by the host, still execute as the current authorized speaker through the registry. */
  reply?: (
    ctx: ActionContext,
    text: string,
    meta?: VoiceTurnMeta,
    hooks?: VoiceRequestHooks,
  ) => Promise<string | VoiceReply>;
  /** No tools, preferences, or retained AI conversation history. Receives at most 6,000 transcript characters. */
  summarize?: (ctx: ActionContext, transcript: string) => Promise<string>;
  /** Fixed operator-approved PCM16 WAV root. Empty/unset disables the local library. */
  audioDirectory?: string;
  /** Fixed host-approved finite HTTPS audio sources. Empty disables remote source playback. */
  streamSources?: Readonly<Record<string, string>>;
  /** Translate only this utterance; no tools, preferences or conversation history. */
  translate?: (ctx: ActionContext, text: string, language: VoiceLanguage) => Promise<string>;
  /** Addressed controls/confirmations admitted by commands or replies consent. Return a payload; never send from this callback. */
  onTranscript?: (
    ctx: ActionContext,
    text: string,
    meta?: VoiceTurnMeta,
    hooks?: VoiceRequestHooks,
  ) => Promise<VoiceCommandPayload | undefined>;
  /** Injectable bounded Discord attachment downloader; defaults to downloadAttachment. */
  download?: typeof downloadAttachment;
  onError?: (error: unknown) => void;
  /** Lifecycle metadata only. Never includes speech, transcript text, names or credentials. */
  onDiagnostic?: (event: string, fields: Record<string, string | number | boolean | undefined>) => void;
  /** Injectable transport for tests/custom clients; production defaults to abortable Discord REST. */
  send?: typeof sendVoiceMessage;
  driverFactory?: VoiceDriverFactory;
  now?: () => number;
}
interface Track {
  title: string;
  pcm: Buffer;
  cancel?: () => void;
  streamStartedAt?: number;
  streamDurationMs?: number;
  streamEnded?: boolean;
  generated?: boolean;
  playbackStartedAt?: number;
  playbackPausedAt?: number;
  playbackPausedMs?: number;
  authorization?: { userId: string; token: symbol };
  reference?: VoiceQueueReference;
}
type VoiceQueueReference =
  | { kind: 'attachment'; channelId: string; messageId: string; index: number; title: string }
  | { kind: 'source'; id: string; title: string }
  | { kind: 'local'; id: string; title: string };
interface SavedQueue {
  tracks: VoiceQueueReference[];
  updatedAt: number;
}
interface Consent {
  expiresAt: number;
  replies: boolean;
  token: symbol;
  meetings: boolean;
  commands: boolean;
  language?: VoiceLanguage;
  vad: boolean;
  recording: boolean;
  transcription: boolean;
  recordingVersion?: string;
}
interface MeetingSegment {
  userId: string;
  name: string;
  text: string;
  at: number;
  token: symbol;
}
interface Playlist {
  name: string;
  tracks: { channelId: string; messageId: string; attachmentIndex: number; title: string }[];
  updatedAt: number;
  revision: string;
}
const playlistName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
const playlistSchema = z.strictObject({
  name: playlistName,
  tracks: z
    .array(
      z.strictObject({
        messageId: z.string().regex(/^\d{17,20}$/),
        attachmentIndex: z.number().int().min(0).max(9).default(0),
      }),
    )
    .min(1)
    .max(5),
});
interface Capture {
  userId: string;
  cancel(): void;
  timer: NodeJS.Timeout;
}
interface VoiceRequestState {
  userId: string;
  generation: number;
  controller: AbortController;
  signal: AbortSignal;
  completedActions?: readonly string[];
}
interface Session {
  id: string;
  ctx: ActionContext;
  originChannelId: string;
  conversation: VoiceConversation;
  realtime?: { controller: AbortController; source: PassThrough; userId: string; token: symbol };
  channelId: string;
  movingTo?: string;
  driver: VoiceDriver;
  queue: Track[];
  current: Track | undefined;
  playbackWatchdog?: NodeJS.Timeout;
  volume: number;
  paused: boolean;
  transportReady: boolean;
  diagnostics: {
    captures: number;
    transcriptions: number;
    addressed: number;
    wakeIgnored: number;
    followUpIgnored: number;
    replies: number;
    failures: number;
    stage: string;
    stageAt: number;
    lastCaptureAt?: number;
    lastTranscriptAt?: number;
    lastAddressedAt?: number;
    lastPlaybackAt?: number;
    lastFailureCode?: string;
    lastSkipAt?: number;
    lastErrorNoticeAt?: number;
  };
  consent: Map<string, Consent>;
  capture: Capture | undefined;
  processing: boolean;
  request?: VoiceRequestState;
  speechPending: boolean;
  speechWork?: { request?: VoiceRequestState };
  generation: number;
  meeting: MeetingSegment[];
  summaryPending: boolean;
}

/** Parse only PCM16 WAV. Reject compressed, truncated and oversized files before conversion. */
export function decodeWav(wav: Buffer, maxSeconds = MAX_PLAY_SECONDS): Buffer {
  if (
    wav.length < 44 ||
    wav.length > MAX_ATTACHMENT ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new UserError('Upload a valid PCM16 WAV file, at most 8 MiB.');
  }
  if (wav.readUInt32LE(4) + 8 !== wav.length) throw new UserError('Truncated or malformed WAV file.');
  let rate = 0,
    channels = 0,
    data: Buffer | undefined;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const name = wav.toString('ascii', offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > wav.length) throw new UserError('Truncated WAV chunk.');
    if (name === 'fmt ') {
      if (length < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 14) !== 16)
        throw new UserError('Only uncompressed PCM16 WAV is supported.');
      channels = wav.readUInt16LE(start + 2);
      rate = wav.readUInt32LE(start + 4);
      if (
        ![1, 2].includes(channels) ||
        rate < 8_000 ||
        rate > 48_000 ||
        wav.readUInt16LE(start + 12) !== channels * 2 ||
        wav.readUInt32LE(start + 8) !== rate * channels * 2
      ) {
        throw new UserError('WAV must be mono/stereo PCM16, 8–48 kHz.');
      }
    } else if (name === 'data') {
      if (data) throw new UserError('Multiple WAV data chunks are unsupported.');
      data = wav.subarray(start, start + length);
    }
    offset = start + length + (length % 2);
  }
  if (!data || !rate || !channels) throw new UserError('WAV is missing format or audio data.');
  return toDiscordPcm(data, rate, channels, maxSeconds);
}

/** Bounded linear conversion to Discord's 48 kHz stereo PCM16. */
export function toDiscordPcm(
  pcm: Buffer,
  rate: number,
  channels: number,
  maxSeconds = MAX_PLAY_SECONDS,
): Buffer {
  if (
    ![1, 2].includes(channels) ||
    !Number.isInteger(rate) ||
    rate < 8_000 ||
    rate > 48_000 ||
    pcm.length === 0 ||
    pcm.length % (channels * 2)
  )
    throw new UserError('Invalid PCM audio.');
  const frames = pcm.length / (channels * 2);
  if (frames / rate > maxSeconds) throw new UserError(`Audio exceeds the ${maxSeconds}-second limit.`);
  const outputFrames = Math.floor((frames * 48_000) / rate);
  const output = Buffer.allocUnsafe(outputFrames * 4);
  for (let i = 0; i < outputFrames; i++) {
    const source = (i * rate) / 48_000;
    const left = Math.floor(source),
      right = Math.min(left + 1, frames - 1),
      fraction = source - left;
    for (let channel = 0; channel < 2; channel++) {
      const sourceChannel = Math.min(channel, channels - 1);
      const a = pcm.readInt16LE((left * channels + sourceChannel) * 2);
      const b = pcm.readInt16LE((right * channels + sourceChannel) * 2);
      output.writeInt16LE(Math.round(a + (b - a) * fraction), i * 4 + channel * 2);
    }
  }
  return output;
}

export function pcmToWav(pcm: Buffer): Buffer {
  if (pcm.length === 0 || pcm.length % 4 || pcm.length > MAX_CAPTURE_BYTES)
    throw new UserError('Invalid or oversized captured audio.');
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48_000, 24);
  header.writeUInt32LE(PCM_BYTES_SECOND, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function withinAudioRoot(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path !== '' &&
    !isAbsolute(path) &&
    path !== '..' &&
    !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  );
}
/** IDs select fixed .wav files inside an operator-approved root; no user-controlled paths or URLs. */
export async function readLocalVoiceAudio(directory: string, id: string): Promise<Buffer> {
  localAudioId.parse(id);
  if (!directory.trim()) throw new UserError('The local voice audio library is disabled.');
  const root = await realpath(directory);
  const path = await realpath(join(root, `${id}.wav`));
  if (!withinAudioRoot(root, path))
    throw new UserError('The selected audio file leaves the approved library.');
  const expected = await stat(path);
  if (!expected.isFile() || expected.size < 44 || expected.size > MAX_ATTACHMENT)
    throw new UserError('Approved library files must be PCM16 WAV, at most 8 MiB.');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await file.stat();
    if (
      !actual.isFile() ||
      actual.ino !== expected.ino ||
      actual.dev !== expected.dev ||
      actual.size !== expected.size
    )
      throw new UserError('The selected audio file changed while opening.');
    const bytes = Buffer.alloc(actual.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== actual.size || (await file.stat()).size !== actual.size)
      throw new UserError('The selected audio file changed or exceeded its read bound.');
    return decodeWav(bytes.subarray(0, size));
  } finally {
    await file.close();
  }
}

export function voiceAlertPcm(kind: 'notice' | 'success' | 'warning'): Buffer {
  const pattern = { notice: [660], success: [660, 880], warning: [440, 440, 440] }[kind];
  if (!pattern) throw new UserError('Unknown voice alert.');
  const toneFrames = 7200,
    gapFrames = 2400;
  const pcm = Buffer.alloc((pattern.length * toneFrames + (pattern.length - 1) * gapFrames) * 4);
  for (const [index, frequency] of pattern.entries())
    for (let frame = 0; frame < toneFrames; frame++) {
      const envelope = Math.min(1, frame / 480, (toneFrames - 1 - frame) / 480);
      const sample = Math.round(Math.sin((2 * Math.PI * frequency * frame) / 48000) * 5000 * envelope);
      const offset = (index * (toneFrames + gapFrames) + frame) * 4;
      pcm.writeInt16LE(sample, offset);
      pcm.writeInt16LE(sample, offset + 2);
    }
  return pcm;
}

async function createDriver(
  channel: VoiceBasedChannel,
  hooks: VoiceHooks,
  silenceMs = 450,
): Promise<VoiceDriver> {
  const { sdk, prism } = await prepareVoiceRuntime();
  const {
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType,
    VoiceConnectionStatus,
    EndBehaviorType,
    createAudioPlayer,
    createAudioResource,
    entersState,
    joinVoiceChannel,
  } = sdk;
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 50 },
  });
  let destroyed = false;
  let moving = false,
    currentResource: ReturnType<typeof createAudioResource> | undefined;
  const lifetime = new AbortController();
  let recovery: Promise<void> | undefined,
    connected = false;
  const captures = new Set<() => void>();
  player.on(AudioPlayerStatus.Idle, hooks.idle);
  player.on('error', hooks.error);
  connection.on('error', hooks.error);
  const captureSpeaker = (userId: string) => {
    if (!destroyed && connection.state.status === VoiceConnectionStatus.Ready) hooks.speaking(userId);
  };
  connection.receiver.speaking.on('start', captureSpeaker);
  const recover = () => {
    if (moving || destroyed || recovery) return;
    hooks.connectionState?.('recovering');
    hooks.diagnostic?.('transport.recovering');
    recovery = waitForVoiceRecovery(connection, sdk, lifetime.signal)
      .then(() => {
        if (destroyed) return;
        hooks.connectionState?.('ready');
        hooks.diagnostic?.('transport.recovered');
        for (const userId of connection.receiver.speaking.users.keys()) captureSpeaker(userId);
      })
      .catch(() => {
        if (!destroyed && !moving) {
          hooks.diagnostic?.('transport.disconnected');
          hooks.disconnected();
        }
      })
      .finally(() => {
        recovery = undefined;
      });
  };
  connection.on('stateChange', (before, after) => {
    hooks.diagnostic?.('transport.state', {
      from: before.status,
      to: after.status,
      closeCode:
        after.status === VoiceConnectionStatus.Disconnected && 'closeCode' in after
          ? after.closeCode
          : undefined,
    });
    if (after.status === VoiceConnectionStatus.Ready) {
      connected = true;
      hooks.connectionState?.('ready');
    } else if (after.status !== VoiceConnectionStatus.Destroyed) {
      hooks.connectionState?.('recovering');
      if (connected) recover();
    }
  });
  connection.on(VoiceConnectionStatus.Disconnected, recover);
  connection.on(VoiceConnectionStatus.Destroyed, () => {
    if (!destroyed) hooks.disconnected();
  });
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    lifetime.abort();
    for (const cancel of captures) cancel();
    player.removeAllListeners();
    connection.receiver.speaking.removeAllListeners();
    connection.removeAllListeners();
    player.stop(true);
    connection.destroy();
  };
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    if (channel.type === ChannelType.GuildStageVoice)
      await channel.guild.members.me!.voice.setSuppressed(false);
  } catch (error) {
    destroy();
    throw error;
  }
  connection.subscribe(player);
  return {
    play(pcm, volume) {
      const resource = createAudioResource(Readable.from([pcm]), {
        inputType: StreamType.Raw,
        inlineVolume: true,
      });
      resource.volume?.setVolume(volume);
      currentResource = resource;
      player.play(resource);
    },
    playStream(source, volume) {
      const resource = createAudioResource(source, { inputType: StreamType.Raw, inlineVolume: true });
      resource.volume!.setVolume(volume);
      currentResource = resource;
      player.play(resource);
    },
    pause: () => player.pause(),
    resume: () => player.unpause(),
    stop: () => {
      player.stop(true);
    },
    destroy,
    setVolume: (value) => currentResource?.volume?.setVolume(value),
    async move(target) {
      moving = true;
      try {
        if (!connection.rejoin({ channelId: target.id, selfDeaf: false, selfMute: false }))
          throw new UserError('Voice transport rejected the move.');
        await entersState(connection, VoiceConnectionStatus.Ready, 20000);
        if (target.type === ChannelType.GuildStageVoice)
          await target.guild.members.me!.voice.setSuppressed(false);
      } finally {
        moving = false;
      }
    },
    receive(userId, onChunk, onEnd, onError) {
      const stream = connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: silenceMs },
      });
      const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
      let ended = false;
      const cleanup = () => {
        if (ended) return;
        ended = true;
        captures.delete(cleanup);
        stream.unpipe(decoder);
        stream.destroy();
        decoder.destroy();
      };
      const finish = () => {
        if (!ended) {
          cleanup();
          onEnd();
        }
      };
      const fail = (error: unknown) => {
        if (!ended) {
          cleanup();
          onError(error);
        }
      };
      captures.add(cleanup);
      stream.on('error', fail);
      decoder.on('error', fail);
      decoder.on('data', (chunk: Buffer) => {
        if (!ended) onChunk(chunk);
      });
      decoder.on('end', finish);
      stream.pipe(decoder);
      return cleanup;
    },
  };
}

export class VoiceService {
  private readonly sessions = new Map<string, Session>();
  private readonly joining = new Map<string, symbol>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly playlistJobs = new Set<string>();
  private readonly now: () => number;
  private readonly driverFactory: VoiceDriverFactory;
  private readonly maintenance: NodeJS.Timeout;
  private readonly maxSessions: number;
  private readonly archiveStores = new Set<Store>();
  private closed = false;

  constructor(private readonly options: VoiceOptions = {}) {
    if (options.store) {
      this.archiveStores.add(options.store);
      pruneVoiceRecordings(options.store);
    }
    this.maxSessions = options.maxSessions ?? 5;
    if (!Number.isInteger(this.maxSessions) || this.maxSessions < 1 || this.maxSessions > 20)
      throw new UserError('Voice maxSessions must be an integer from 1 to 20.');
    this.now = options.now ?? Date.now;
    new VoiceConversation({
      botName: options.botName,
      wakeWords: options.wakeWords,
      followUpSeconds: options.followUpSeconds,
    });
    const silence = options.silenceMs ?? 450;
    if (!Number.isInteger(silence) || silence < 250 || silence > 1500)
      throw new UserError('Voice silenceMs must be an integer from250 to1500.');
    this.driverFactory = options.driverFactory ?? ((channel, hooks) => createDriver(channel, hooks, silence));
    this.maintenance = setInterval(() => this.expireConsent(), 30_000);
    this.maintenance.unref();
  }

  async join(ctx: ActionContext): Promise<string> {
    if (this.closed) throw new UserError('Voice service is shutting down.');
    const channel = ctx.member.voice.channel;
    if (!channel) throw new UserError('Join a voice or Stage channel first.');
    if (channel.type === ChannelType.GuildStageVoice)
      for (const principal of [ctx.member, ctx.guild.members.me!])
        if (!channel.permissionsFor(principal)?.has(P.MuteMembers))
          throw new UserError(
            'Stage playback requires you and the bot to be Stage moderators with Mute Members.',
          );
    if (this.sessions.has(ctx.guild.id) || this.joining.has(ctx.guild.id))
      throw new UserError('Already connected or joining. Leave before changing channels.');
    if (this.sessions.size + this.joining.size >= this.maxSessions)
      throw new UserError(`Voice session limit reached (${this.maxSessions} connected or joining servers).`);
    for (const flag of [P.ViewChannel, P.Connect, P.Speak]) {
      if (
        !channel.permissionsFor(ctx.member)?.has(flag) ||
        !channel.permissionsFor(ctx.guild.members.me!)?.has(flag)
      )
        throw new UserError('You and the bot need View Channel, Connect and Speak in that voice channel.');
    }
    const token = Symbol();
    this.joining.set(ctx.guild.id, token);
    let session: Session | undefined;
    try {
      const originChannelId = ctx.channelId;
      if (this.options.requirePrivateTranscripts && !this.options.resolveTranscriptChannel)
        throw new UserError('A dedicated private voice transcript channel is required before joining.');
      if (this.options.resolveTranscriptChannel) {
        const transcriptChannelId = await this.options.resolveTranscriptChannel(ctx);
        if (!transcriptChannelId)
          throw new UserError('A dedicated private voice transcript channel is required before joining.');
        ctx = { ...ctx, channelId: transcriptChannelId };
        await this.transcriptChannel(ctx);
      }
      if (this.closed || this.joining.get(ctx.guild.id) !== token)
        throw new UserError('Voice connection was cancelled.');
      const driver = await this.track(
        this.driverFactory(channel, {
          idle: () => {
            if (session && this.sessions.get(ctx.guild.id) === session) {
              this.clearPlaybackWatchdog(session);
              const completed = session.current;
              if (completed?.streamStartedAt !== undefined && !completed.streamEnded) {
                this.diagnostic(session, 'playback.interrupted');
                completed.cancel?.();
              } else if (completed?.authorization)
                session.conversation.playbackComplete(completed.authorization.userId, this.now());
              session.current = undefined;
              this.diagnostic(session, 'playback.idle');
              this.next(session);
            }
          },
          speaking: (userId) => {
            if (session) this.capture(session, userId);
          },
          disconnected: () => {
            if (session && this.sessions.get(ctx.guild.id) === session) this.destroy(ctx.guild.id);
          },
          error: (error) => {
            this.options.onError?.(error);
            if (session && this.sessions.get(ctx.guild.id) === session) this.destroy(ctx.guild.id);
          },
          connectionState: (state) => {
            if (session && this.sessions.get(ctx.guild.id) === session) {
              session.transportReady = state === 'ready';
              if (!session.transportReady) {
                this.cancelCapture(session);
                this.suspendPlaybackWatchdog(session);
              } else this.resumePlaybackWatchdog(session);
            }
          },
          diagnostic: (stage, fields) => {
            if (session) this.diagnostic(session, stage, fields);
          },
        }),
      );
      if (this.closed || this.joining.get(ctx.guild.id) !== token) {
        driver.destroy();
        throw new UserError('Voice connection was cancelled.');
      }
      session = {
        id: randomUUID(),
        // Session identity outlives the /join request. Never retain that
        // command's channel-bound, expiring provenance in future captures.
        ctx: {
          client: ctx.client,
          guild: ctx.guild,
          member: ctx.member,
          channelId: ctx.channelId,
          store: ctx.store,
        },
        originChannelId,
        conversation: new VoiceConversation({
          botName: this.options.botName,
          wakeWords: this.options.wakeWords,
          followUpSeconds: this.options.followUpSeconds,
        }),
        channelId: channel.id,
        driver,
        queue: [],
        current: undefined,
        volume: 1,
        paused: false,
        transportReady: true,
        diagnostics: {
          captures: 0,
          transcriptions: 0,
          addressed: 0,
          wakeIgnored: 0,
          followUpIgnored: 0,
          replies: 0,
          failures: 0,
          stage: 'ready',
          stageAt: this.now(),
        },
        consent: new Map(),
        capture: undefined,
        processing: false,
        speechPending: false,
        generation: 0,
        meeting: [],
        summaryPending: false,
      };
      this.sessions.set(ctx.guild.id, session);
      this.diagnostic(session, 'session.joined');
      return `Joined ${channel.name}. Use /speak text:your message for generated speech, or /consent replies:true to enable listening and AI spoken replies for your own voice. Each speaker must consent individually; joining alone captures no audio. Consent lasts 10 minutes; transcripts are posted only in <#${ctx.channelId}>. ${this.options.transcriptionProvider === 'local' ? 'Audio transcription runs on this host.' : 'Consented utterances are sent to OpenAI for transcription.'}${this.options.requireWakeWord ? ` Say ${this.options.botName ?? 'Vibe'} before a new request; short related follow-ups use the same speaker’s active turn.` : ''} AI speech is synthetic.`;
    } finally {
      if (this.joining.get(ctx.guild.id) === token) this.joining.delete(ctx.guild.id);
    }
  }

  private session(ctx: ActionContext): Session {
    const session = this.sessions.get(ctx.guild.id);
    if (!session) throw new UserError('The bot is not connected to voice.');
    if (ctx.member.voice.channelId !== session.channelId)
      throw new UserError('Join the same voice channel as the bot.');
    return session;
  }
  sessionRevision(ctx: ActionContext): string {
    const session = this.session(ctx);
    return `${session.id}:${session.generation}`;
  }
  /** Clear one speaker's conversational work without extending consent or stopping other speakers. */
  resetSpeakerConversation(guildId: string, userId: string): void {
    const session = this.sessions.get(guildId);
    if (!session) {
      this.notifySpeakerReset(guildId, userId);
      return;
    }
    const consent = session.consent.get(userId);
    // Rotating the token invalidates in-flight transcription, request leases,
    // queued speech and summary snapshots while preserving the original expiry.
    if (consent) session.consent.set(userId, { ...consent, token: Symbol() });
    this.resetConversation(session, userId);
    this.discardSpeakerAudio(session, userId);
    session.meeting = session.meeting.filter((segment) => segment.userId !== userId);
    if (session.capture?.userId === userId) this.cancelCapture(session);
  }
  /** In-memory authority for one consented voice request; fresh registry guards pass their current context. */
  requestLease(ctx: ActionContext): (fresh?: ActionContext) => boolean {
    const session = this.sessions.get(ctx.guild.id),
      userId = ctx.member.id,
      consent = session?.consent.get(userId),
      generation = session?.generation,
      request = session?.request?.userId === userId ? session.request : undefined;
    if (!session || !consent || generation === undefined || ctx.channelId !== session.ctx.channelId)
      return () => false;
    let reported = false;
    const rejected = (reason: string) => {
      if (!reported) this.diagnostic(session, 'request.lease-rejected', { reason });
      reported = true;
      return false;
    };
    return (fresh = ctx) => {
      try {
        if (request?.signal.aborted) return rejected('request-cancelled');
        if (
          fresh.guild.id !== ctx.guild.id ||
          fresh.member.id !== userId ||
          fresh.channelId !== session.ctx.channelId ||
          fresh.client !== ctx.client ||
          fresh.store !== ctx.store ||
          fresh.member.user.bot ||
          fresh.member.voice.channelId !== session.channelId ||
          !(consent.replies || consent.commands) ||
          !this.validConsent(session, userId, consent, generation)
        )
          return rejected('identity-consent-session');
        const member = fresh.guild.members.cache?.get(userId) ?? fresh.member,
          voice = member.voice.channel,
          bot = fresh.guild.members.me;
        if (member.voice.channelId !== session.channelId) return rejected('voice-membership');
        if (
          voice &&
          bot &&
          [member, bot].some(
            (principal) => !voice.permissionsFor(principal)?.has([P.ViewChannel, P.Connect, P.Speak]),
          )
        )
          return rejected('voice-permission');
        if (this.options.requirePrivateTranscripts || this.options.resolveTranscriptChannel) {
          const channel = fresh.guild.channels.cache?.get(session.ctx.channelId);
          if (!channel || !bot) return rejected('private-cache-unavailable');
          assertPrivateTranscriptPrivacy(fresh, channel, bot);
          if (
            !channel.permissionsFor(member)?.has([P.ViewChannel, P.ReadMessageHistory]) ||
            !channel.permissionsFor(bot)?.has([P.ViewChannel, P.ReadMessageHistory, P.SendMessages])
          )
            return rejected('private-permission');
        }
        return true;
      } catch {
        return rejected('private-invariant');
      }
    };
  }
  private async playbackAccess(
    ctx: ActionContext,
    session: Session,
    generation: number,
    history = false,
    alreadyFreshMember = false,
  ): Promise<ActionContext> {
    const member = alreadyFreshMember
      ? ctx.member
      : await ctx.guild.members.fetch({ user: ctx.member.id, force: true });
    await ctx.guild.members.fetchMe?.({ force: true });
    const channel = member.voice.channel;
    if (
      this.closed ||
      this.sessions.get(ctx.guild.id) !== session ||
      session.generation !== generation ||
      !this.enabled(session) ||
      member.user.bot ||
      member.voice.channelId !== session.channelId ||
      !channel ||
      channel.id !== session.channelId
    )
      throw new UserError('Voice work cancelled after session or membership changed.');
    for (const principal of [member, ctx.guild.members.me!])
      if (!channel.permissionsFor(principal)?.has([P.ViewChannel, P.Connect, P.Speak]))
        throw new UserError('Current View Channel, Connect and Speak permissions are required.');
    const fresh = { ...ctx, member };
    if (history) await readableHistory(fresh, ctx.channelId);
    if (
      this.sessions.get(ctx.guild.id) !== session ||
      session.generation !== generation ||
      !this.enabled(session) ||
      member.voice.channelId !== session.channelId
    )
      throw new UserError('Voice work cancelled after current access changed.');
    return fresh;
  }
  async currentContext(ctx: ActionContext): Promise<ActionContext> {
    const session = this.session(ctx);
    return this.playbackAccess(ctx, session, session.generation, true);
  }
  async move(ctx: ActionContext, channelId: string): Promise<string> {
    const session = this.session(ctx),
      generation = session.generation;
    await this.playbackAccess(ctx, session, generation, true);
    const target = await resolveChannel(ctx, channelId);
    if (!target.isVoiceBased()) throw new UserError('Choose a voice or Stage channel.');
    for (const principal of [ctx.member, ctx.guild.members.me!]) {
      if (!target.permissionsFor(principal)?.has([P.ViewChannel, P.Connect, P.Speak]))
        throw new UserError('Current voice target permissions are required.');
      if (
        target.type === ChannelType.GuildStageVoice &&
        !target.permissionsFor(principal)?.has(P.MuteMembers)
      )
        throw new UserError('Stage moves require Stage moderator authority.');
    }
    await this.playbackAccess(ctx, session, generation, true);
    if (!session.driver.move)
      throw new UserError('The configured voice transport does not support channel moves.');
    this.stop(ctx);
    session.consent.clear();
    session.meeting = [];
    session.movingTo = target.id;
    const movingGeneration = session.generation;
    try {
      await this.track(session.driver.move(target));
      if (
        this.sessions.get(ctx.guild.id) !== session ||
        !this.enabled(session) ||
        session.generation !== movingGeneration
      )
        throw new UserError('Voice move was cancelled.');
      session.channelId = target.id;
      return `Moved to ${target.name}; previous consent and audio were discarded. Approve fresh consent in the new channel.`;
    } catch (error) {
      this.destroy(ctx.guild.id);
      throw error;
    } finally {
      session.movingTo = undefined;
    }
  }
  sources(): { id: string; host: string }[] {
    return Object.entries(this.options.streamSources ?? {})
      .slice(0, 20)
      .filter(([id, url]) => localAudioId.safeParse(id).success && /^https:\/\//.test(url))
      .map(([id, url]) => ({ id, host: new URL(url).hostname }));
  }
  stream(ctx: ActionContext, id: string): Promise<string> {
    localAudioId.parse(id);
    const configured = this.options.streamSources?.[id];
    if (!configured) throw new UserError('This approved audio source is disabled or unconfigured.');
    const session = this.session(ctx),
      generation = session.generation;
    return this.playlistJob(ctx, async () => {
      let pcm: Buffer | undefined;
      try {
        await this.playbackAccess(ctx, session, generation, true);
        const response = await fetchPublic(configured, {
          allowedHosts: [new URL(configured).hostname],
          maxBytes: 2 * 1048576,
        });
        if (response.status !== 200)
          throw new UserError('Approved audio source returned an unsuccessful response.');
        pcm = await decodeAudioPcm(response.body);
        const fresh = await this.playbackAccess(ctx, session, generation, true);
        return this.enqueue(fresh, pcm, `Source: ${id}`, undefined, {
          kind: 'source',
          id,
          title: `Source: ${id}`,
        });
      } catch (error) {
        pcm?.fill(0);
        throw error;
      }
    });
  }

  async library(ctx: ActionContext): Promise<{ files: string[]; truncated: boolean }> {
    await this.currentContext(ctx);
    if (!this.options.audioDirectory?.trim())
      throw new UserError('The local voice audio library is disabled.');
    const root = await realpath(this.options.audioDirectory),
      files: string[] = [];
    let scanned = 0,
      truncated = false;
    const directory = await opendir(root);
    try {
      for await (const entry of directory) {
        if (++scanned > 1000 || files.length >= 50) {
          truncated = true;
          break;
        }
        if (!entry.isFile() || !entry.name.endsWith('.wav')) continue;
        const id = entry.name.slice(0, -4);
        if (localAudioId.safeParse(id).success) files.push(id);
      }
    } finally {
      await directory.close().catch(() => {});
    }
    await this.currentContext(ctx);
    return { files: files.sort(), truncated };
  }
  playLocal(ctx: ActionContext, id: string): Promise<string> {
    localAudioId.parse(id);
    const session = this.session(ctx),
      generation = session.generation;
    if (!this.options.audioDirectory?.trim())
      throw new UserError('The local voice audio library is disabled.');
    return this.playlistJob(ctx, async () => {
      let pcm: Buffer | undefined;
      try {
        await this.playbackAccess(ctx, session, generation, true);
        pcm = await readLocalVoiceAudio(this.options.audioDirectory!, id);
        const fresh = await this.playbackAccess(ctx, session, generation, true);
        return this.enqueue(fresh, pcm, `Library: ${id}`, undefined, {
          kind: 'local',
          id,
          title: `Library: ${id}`,
        });
      } catch (error) {
        pcm?.fill(0);
        throw error;
      }
    });
  }
  async alert(ctx: ActionContext, kind: 'notice' | 'success' | 'warning'): Promise<string> {
    const session = this.session(ctx),
      generation = session.generation;
    const fresh = await this.playbackAccess(ctx, session, generation);
    return this.enqueue(fresh, voiceAlertPcm(kind), `Alert: ${kind}`);
  }

  status(ctx: ActionContext): unknown {
    const session = this.session(ctx);
    return {
      channelId: session.channelId,
      playing: session.current?.title ?? null,
      paused: session.paused,
      queue: session.queue.map((track) => track.title),
      volume: session.volume,
      consentingSpeakers: [...session.consent.values()].filter((consent) => consent.expiresAt > this.now())
        .length,
      processing: session.processing,
      capturing: !!session.capture,
      speechPending: session.speechPending,
      transportReady: session.transportReady,
      diagnostics: { ...session.diagnostics },
      transcriptChannelId: session.ctx.channelId,
      wakeWord: this.options.requireWakeWord ? (this.options.botName ?? 'Vibe') : null,
    };
  }

  leave(ctx: ActionContext): string {
    this.session(ctx);
    this.stop(ctx);
    this.destroy(ctx.guild.id);
    return 'Disconnected; queues, captured audio and consent discarded.';
  }
  stop(ctx: ActionContext): string {
    const session = this.session(ctx);
    session.request?.controller.abort(new UserError('Voice request stopped.'));
    session.speechWork = undefined;
    session.speechPending = false;
    this.clearPlaybackWatchdog(session);
    session.generation++;
    this.resetConversation(session);
    session.realtime?.controller.abort();
    session.realtime?.source.destroy();
    session.meeting = [];
    session.queue = [];
    session.current = undefined;
    session.paused = false;
    this.cancelCapture(session);
    session.driver.stop();
    this.diagnostic(session, 'session.stopped');
    this.persistQueue(session);
    return 'Stopped playback and pending voice work; queue cleared.';
  }
  pause(ctx: ActionContext): string {
    const session = this.session(ctx);
    session.paused = true;
    this.suspendPlaybackWatchdog(session);
    this.cancelCapture(session);
    session.driver.pause();
    return 'Playback and audio capture paused.';
  }
  resume(ctx: ActionContext): string {
    const session = this.session(ctx);
    session.paused = false;
    session.driver.resume();
    this.resumePlaybackWatchdog(session);
    this.next(session);
    return 'Voice resumed.';
  }
  skip(ctx: ActionContext): string {
    const session = this.session(ctx);
    this.clearPlaybackWatchdog(session);
    session.current = undefined;
    session.driver.stop();
    this.next(session);
    return 'Skipped.';
  }
  volume(ctx: ActionContext, value: number): string {
    if (!Number.isFinite(value) || value < 0 || value > 1)
      throw new UserError('Volume must be between 0 and 1.');
    const session = this.session(ctx);
    session.volume = value;
    session.driver.setVolume?.(value);
    return 'Volume updated for the current and subsequent tracks.';
  }

  enqueue(
    ctx: ActionContext,
    pcm: Buffer,
    title: string,
    authorization?: Track['authorization'],
    reference?: VoiceQueueReference,
    generated = false,
  ): string {
    const session = this.session(ctx);
    if (!this.enabled(session)) throw new UserError('Voice is disabled in this server.');
    if (!pcm.length || pcm.length % 4 || pcm.length > MAX_PLAY_SECONDS * PCM_BYTES_SECOND)
      throw new UserError('Invalid or oversized PCM playback.');
    const queuedBytes = session.queue.reduce(
      (sum, track) => sum + track.pcm.length,
      session.current?.pcm.length ?? 0,
    );
    if (session.queue.length >= 5 || queuedBytes + pcm.length > MAX_QUEUE_BYTES)
      throw new UserError('Voice queue is full (5 waiting tracks / 24 MiB).');
    session.queue.push({
      title: title.slice(0, 120),
      pcm,
      authorization,
      reference,
      generated: generated || !!authorization,
    });
    this.next(session);
    return `Queued ${title.slice(0, 120)}.`;
  }
  async speak(ctx: ActionContext, text: string): Promise<string> {
    if (!text.trim() || text.length > 1000)
      throw new UserError('Speech text must contain 1–1,000 characters.');
    const session = this.session(ctx),
      generation = session.generation;
    if (!this.enabled(session)) throw new UserError('Voice is disabled in this server.');
    if (!this.options.speech) throw new UserError('AI speech is not configured.');
    if (session.speechPending) throw new UserError('Speech is already being generated for this server.');
    const speechWork = {};
    session.speechWork = speechWork;
    session.speechPending = true;
    return this.track(
      (async () => {
        const before = await this.playbackAccess(ctx, session, generation);
        const data = await this.options.speech!(before, text);
        if (data.byteLength > MAX_ATTACHMENT)
          throw new UserError('Generated speech exceeds its audio bound.');
        const pcm = Buffer.from(data);
        try {
          const fresh = await this.playbackAccess(ctx, session, generation);
          if (pcm.length > MAX_ATTACHMENT) throw new UserError('Generated speech exceeds its audio bound.');
          return this.enqueue(fresh, toDiscordPcm(pcm, 24_000, 1), 'AI speech', undefined, undefined, true);
        } finally {
          pcm.fill(0);
        }
      })().finally(() => {
        if (session.speechWork === speechWork) {
          session.speechPending = false;
          session.speechWork = undefined;
        }
      }),
    );
  }
  playUploaded(ctx: ActionContext, messageId: string, index: number): Promise<string> {
    const session = this.session(ctx),
      generation = session.generation;
    return this.track(
      (async () => {
        const audio = await uploadedWav(ctx, messageId, index, this.options.download);
        const member = await ctx.guild.members.fetch({ user: ctx.member.id, force: true });
        await readableHistory({ ...ctx, member }, ctx.channelId);
        if (
          this.closed ||
          this.sessions.get(ctx.guild.id) !== session ||
          session.generation !== generation ||
          !this.enabled(session) ||
          member.voice.channelId !== session.channelId
        ) {
          audio.pcm.fill(0);
          throw new UserError('Uploaded playback cancelled.');
        }
        return this.enqueue({ ...ctx, member }, audio.pcm, audio.name, undefined, {
          kind: 'attachment',
          channelId: ctx.channelId,
          messageId,
          index,
          title: audio.name,
        });
      })(),
    );
  }

  playlists(ctx: ActionContext): unknown {
    return ctx.store
      .list<Playlist>('voice.playlists', `${ctx.guild.id}:${ctx.member.id}:`)
      .map(({ value }) => ({ name: value.name, tracks: value.tracks.length, updatedAt: value.updatedAt }));
  }
  removePlaylist(ctx: ActionContext, name: string): string {
    playlistName.parse(name);
    if (!ctx.store.delete('voice.playlists', `${ctx.guild.id}:${ctx.member.id}:${name}`))
      throw new UserError('Your playlist was not found.');
    return 'Your saved playlist references were removed.';
  }
  savePlaylist(ctx: ActionContext, raw: z.input<typeof playlistSchema>): Promise<string> {
    const input = playlistSchema.parse(raw);
    return this.playlistJob(ctx, async () => {
      const key = `${ctx.guild.id}:${ctx.member.id}:${input.name}`,
        previous = ctx.store.get<Playlist>('voice.playlists', key);
      const tracks: Playlist['tracks'] = [];
      let bytes = 0;
      for (const track of input.tracks) {
        const audio = await uploadedWav(ctx, track.messageId, track.attachmentIndex, this.options.download);
        bytes += audio.pcm.length;
        audio.pcm.fill(0);
        if (bytes > MAX_QUEUE_BYTES) throw new UserError('The playlist exceeds 24 MiB of decoded audio.');
        tracks.push({ channelId: ctx.channelId, ...track, title: audio.name.slice(0, 120) });
      }
      if (this.closed || (ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? []).includes('voice'))
        throw new UserError('Voice playlist operation cancelled.');
      const currentMember = await ctx.guild.members.fetch({ user: ctx.member.id, force: true });
      await readableHistory({ ...ctx, member: currentMember }, ctx.channelId);
      if (this.closed || (ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? []).includes('voice'))
        throw new UserError('Voice playlist operation cancelled.');
      ctx.store.transaction(() => {
        if (ctx.store.get<Playlist>('voice.playlists', key)?.revision !== previous?.revision)
          throw new UserError(
            'This playlist changed while it was being validated. Retry with the current version.',
          );
        if (
          !previous &&
          (ctx.store.list('voice.playlists', `${ctx.guild.id}:${ctx.member.id}:`).length >= 10 ||
            ctx.store.list('voice.playlists', `${ctx.guild.id}:`).length >= 50)
        )
          throw new UserError('Saved playlist limit reached (10 per user / 50 per server).');
        ctx.store.set('voice.playlists', key, {
          name: input.name,
          tracks,
          updatedAt: this.now(),
          revision: randomUUID(),
        } satisfies Playlist);
      });
      return `Saved ${tracks.length} validated WAV reference(s) as ${input.name}. Source access is checked again at playback.`;
    });
  }
  playPlaylist(ctx: ActionContext, name: string): Promise<string> {
    playlistName.parse(name);
    const session = this.session(ctx),
      generation = session.generation;
    return this.playlistJob(ctx, async () => {
      const key = `${ctx.guild.id}:${ctx.member.id}:${name}`,
        playlist = ctx.store.get<Playlist>('voice.playlists', key);
      if (!playlist || !playlist.tracks.length || playlist.tracks.length > 5)
        throw new UserError('Your bounded playlist was not found.');
      const tracks: Track[] = [];
      let bytes = 0;
      try {
        for (const track of playlist.tracks) {
          const audio = await uploadedWav(
            { ...ctx, channelId: track.channelId },
            track.messageId,
            track.attachmentIndex,
            this.options.download,
          );
          bytes += audio.pcm.length;
          tracks.push({
            title: audio.name,
            pcm: audio.pcm,
            reference: {
              kind: 'attachment',
              channelId: track.channelId,
              messageId: track.messageId,
              index: track.attachmentIndex,
              title: audio.name,
            },
          });
          if (bytes > MAX_QUEUE_BYTES) throw new UserError('The playlist exceeds 24 MiB of decoded audio.');
        }
        const member = await ctx.guild.members.fetch({ user: ctx.member.id, force: true });
        for (const channelId of new Set(playlist.tracks.map((track) => track.channelId)))
          await readableHistory({ ...ctx, member }, channelId);
        if (
          this.closed ||
          this.sessions.get(ctx.guild.id) !== session ||
          session.generation !== generation ||
          !this.enabled(session) ||
          member.voice.channelId !== session.channelId ||
          ctx.store.get<Playlist>('voice.playlists', key)?.revision !== playlist.revision
        )
          throw new UserError(
            'Playlist playback cancelled because the session, source access or saved playlist changed.',
          );
        const queuedBytes = session.queue.reduce(
          (sum, track) => sum + track.pcm.length,
          session.current?.pcm.length ?? 0,
        );
        if (
          session.queue.length + tracks.length - (session.current ? 0 : 1) > 5 ||
          queuedBytes + bytes > MAX_QUEUE_BYTES
        )
          throw new UserError('Voice queue is full (5 waiting tracks / 24 MiB).');
        session.queue.push(...tracks);
        this.next(session);
        return `Queued all ${tracks.length} tracks from ${name}.`;
      } catch (error) {
        for (const track of tracks) track.pcm.fill(0);
        throw error;
      }
    });
  }
  private playlistJob<T>(ctx: ActionContext, work: () => Promise<T>): Promise<T> {
    if (this.closed) throw new UserError('Voice service is shutting down.');
    if ((ctx.store.get<string[]>('core.disabled', ctx.guild.id) ?? []).includes('voice'))
      throw new UserError('Voice is disabled in this server.');
    if (this.playlistJobs.has(ctx.guild.id) || this.playlistJobs.size >= 2)
      throw new UserError('Voice playlist processors are busy.');
    this.playlistJobs.add(ctx.guild.id);
    return this.track(work().finally(() => this.playlistJobs.delete(ctx.guild.id)));
  }
  private meetingValid(session: Session, segment: MeetingSegment, generation: number): boolean {
    const consent = session.consent.get(segment.userId);
    return (
      !!consent &&
      consent.meetings &&
      consent.token === segment.token &&
      this.validConsent(session, segment.userId, consent, generation) &&
      segment.at + CONSENT_MS > this.now()
    );
  }
  private async meetingAccess(
    ctx: ActionContext,
    session: Session,
    segments: MeetingSegment[],
    generation: number,
  ): Promise<void> {
    if (ctx.channelId !== session.ctx.channelId)
      throw new UserError(`Use the disclosed transcript channel <#${session.ctx.channelId}>.`);
    if (
      this.sessions.get(ctx.guild.id) !== session ||
      session.generation !== generation ||
      !this.enabled(session)
    )
      throw new UserError('Meeting summary cancelled.');
    const members = await Promise.all(
      [...new Set([ctx.member.id, ...segments.map((segment) => segment.userId)])].map((user) =>
        ctx.guild.members.fetch({ user, force: true }),
      ),
    );
    if (members.some((member) => member.user.bot || member.voice.channelId !== session.channelId))
      throw new UserError(
        'Meeting participants changed; request a new summary of the current consented excerpts.',
      );
    const requester = members.find((member) => member.id === ctx.member.id);
    if (!requester) throw new UserError('Current meeting membership is unavailable.');
    await Promise.all(
      members.map((member) => this.transcriptChannel({ ...ctx, member, channelId: session.ctx.channelId })),
    );
    if (
      this.sessions.get(ctx.guild.id) !== session ||
      session.generation !== generation ||
      !this.enabled(session) ||
      members.some((member) => member.voice.channelId !== session.channelId) ||
      segments.some((segment) => !this.meetingValid(session, segment, generation))
    )
      throw new UserError('Meeting summary cancelled after consent or session changed.');
  }
  async meetingStatus(ctx: ActionContext): Promise<unknown> {
    const session = this.session(ctx);
    await this.meetingAccess(ctx, session, [], session.generation);
    session.meeting = session.meeting.filter((segment) =>
      this.meetingValid(session, segment, session.generation),
    );
    return {
      transcriptChannelId: session.ctx.channelId,
      retainedSegments: session.meeting.length,
      summaryPending: session.summaryPending,
      retention: 'In-memory current consent only; at most 6,000 characters / 60 segments / 10 speakers.',
      yourSummaryConsent: session.consent.get(ctx.member.id)?.meetings ?? false,
    };
  }
  summarizeMeeting(ctx: ActionContext): Promise<{ attachment: Buffer; name: string; notice: string }> {
    const session = this.session(ctx),
      generation = session.generation;
    if (!this.options.summarize) throw new UserError('AI meeting summarization is not configured.');
    if (session.summaryPending) throw new UserError('A meeting summary is already being generated.');
    session.summaryPending = true;
    return this.track(
      (async () => {
        session.meeting = session.meeting.filter((segment) =>
          this.meetingValid(session, segment, generation),
        );
        const snapshot = [...session.meeting];
        if (!snapshot.length)
          throw new UserError(
            'No current meeting excerpts. Speakers must opt in using voice.consent meetings:true before speaking.',
          );
        await this.meetingAccess(ctx, session, snapshot, generation);
        const transcript = snapshot.map((segment) => `${segment.name}: ${segment.text}`).join('\n');
        const summary = await this.options.summarize!(ctx, transcript);
        await this.meetingAccess(ctx, session, snapshot, generation);
        return {
          attachment: Buffer.from(summary.slice(0, 20000)),
          name: 'meeting-summary.txt',
          notice:
            'AI summary of explicitly consented current-session excerpts only. This is an excerpt summary, not a complete meeting recording.',
        };
      })().finally(() => {
        session.summaryPending = false;
      }),
    );
  }

  consent(
    ctx: ActionContext,
    enabled: boolean,
    replies = false,
    meetings = false,
    commands = false,
    language?: VoiceLanguage,
    vad = false,
    recording = false,
    transcription = true,
  ): string {
    if (!enabled) {
      const session = this.sessions.get(ctx.guild.id);
      if (!session) {
        this.notifySpeakerReset(ctx.guild.id, ctx.member.id);
        return 'Your voice consent is inactive.';
      }
      session.consent.delete(ctx.member.id);
      this.diagnostic(session, 'consent.revoked');
      this.resetConversation(session, ctx.member.id);
      this.discardSpeakerAudio(session, ctx.member.id);
      session.meeting = session.meeting.filter((segment) => segment.userId !== ctx.member.id);
      if (session.capture?.userId === ctx.member.id) this.cancelCapture(session);
      return 'Your voice consent was revoked; pending results will be discarded.';
    }
    const session = this.session(ctx);
    if (ctx.channelId !== session.ctx.channelId && ctx.channelId !== session.originChannelId)
      throw new UserError(
        `Enable voice consent from <#${session.ctx.channelId}> so you can review the transcript destination before approving.`,
      );
    if (!this.enabled(session)) throw new UserError('Voice is disabled in this server.');
    if (transcription && !this.options.transcribe) throw new UserError('Transcription is not configured.');
    if (!transcription && (replies || meetings || commands || language))
      throw new UserError(
        'Replies, meeting excerpts, commands and translation require transcription consent.',
      );
    if (!transcription && !recording)
      throw new UserError('Enable transcription or recording for this consent.');
    const recordingPolicy = ctx.store?.get<VoiceRecordingPolicy>('voice.recordingPolicy', ctx.guild.id);
    if (ctx.store) this.archiveStores.add(ctx.store);
    if (recording && !recordingPolicy?.enabled)
      throw new UserError('A manager must explicitly enable the voice recording archive first.');
    if (replies && (!this.options.reply || !this.options.speech))
      throw new UserError('Conversational AI speech is not configured.');
    if (meetings && !this.options.summarize) throw new UserError('Meeting summarization is not configured.');
    if (commands && !this.options.onTranscript)
      throw new UserError('Consented voice commands are not configured.');
    if (language !== undefined) {
      z.enum(VOICE_LANGUAGES).parse(language);
      if (!this.options.translate || !this.options.speech)
        throw new UserError('Spoken translation is not configured.');
    }
    session.meeting = session.meeting.filter((segment) => segment.userId !== ctx.member.id);
    this.resetConversation(session, ctx.member.id);
    this.discardSpeakerAudio(session, ctx.member.id);
    session.consent.set(ctx.member.id, {
      expiresAt: this.now() + CONSENT_MS,
      replies,
      meetings,
      commands,
      language,
      vad,
      recording,
      transcription,
      recordingVersion: recordingPolicy?.version,
      token: Symbol(),
    });
    this.diagnostic(session, 'consent.granted', { expiresAt: this.now() + CONSENT_MS });
    return `You consented to ${transcription ? 'transcription' : 'local audio recording'}${replies ? ', AI spoken replies' : ''}${meetings ? ', optional AI meeting summaries' : ''}${commands ? ', allowlisted voice commands and confirmation prompts' : ''}${language ? `, translation and synthetic speech in ${language}` : ''} for 10 minutes in this voice channel.${transcription ? ` Your next audible utterances (maximum 15 seconds each) ${this.options.transcriptionProvider === 'local' ? 'are transcribed on this host; addressed requests and explicitly requested AI summaries/translation text may be sent to OpenAI' : 'are sent to OpenAI for transcription'}; transcripts${language ? ' and translated text' : ''} appear only in <#${session.ctx.channelId}>.` : ' Recording-only audio is not uploaded to OpenAI.'}${recording ? ` Your individual WAV utterances are retained locally for up to ${recordingPolicy!.retentionHours} hours; host operators/backups can access the archive. Use voice.recordings.export or voice.recordings.erase for your files.` : ''}${vad ? ' Acoustic energy VAD discards silent utterances before upload/archive.' : ''}${meetings ? ' A bounded in-memory excerpt can be summarized for participants who can read that text channel; leaving or revoking removes your excerpt.' : ''}${commands || replies ? `${this.options.requireWakeWord ? ` Say ${this.options.botName ?? 'Vibe'} before a new request. Short related follow-ups are accepted only for your active conversation;` : ''} Permitted requests use the same action checks as text.` : ''} Revoke with voice.consent enabled:false or leave the channel. Revocation stops future capture; erase separately to remove archived files.`;
  }

  /** Called by gateway voiceStateUpdate so leaving/moving revokes consent immediately. */
  memberLeft(guildId: string, userId: string, channelId: string | null): void {
    const session = this.sessions.get(guildId);
    if (!session || channelId === session.channelId) return;
    if (userId === session.ctx.client?.user?.id) {
      if (session.movingTo === channelId) return;
      this.destroy(guildId);
      return;
    }
    session.consent.delete(userId);
    this.resetConversation(session, userId);
    this.discardSpeakerAudio(session, userId);
    session.meeting = session.meeting.filter((segment) => segment.userId !== userId);
    if (session.capture?.userId === userId) this.cancelCapture(session);
  }

  private next(session: Session): void {
    this.persistQueue(session);
    if (
      session.paused ||
      session.current ||
      !this.enabled(session) ||
      this.sessions.get(session.ctx.guild.id) !== session
    )
      return;
    let track = session.queue.shift();
    while (track?.authorization) {
      const consent = session.consent.get(track.authorization.userId);
      if (consent?.token === track.authorization.token && consent.expiresAt > this.now()) break;
      track.pcm.fill(0);
      track = session.queue.shift();
    }
    if (track) {
      session.current = track;
      track.playbackStartedAt = this.now();
      track.playbackPausedMs = 0;
      track.playbackPausedAt = session.transportReady ? undefined : this.now();
      session.diagnostics.lastPlaybackAt = this.now();
      this.diagnostic(session, 'playback.started', { streaming: false });
      try {
        session.driver.play(track.pcm, session.volume);
        this.armPlaybackWatchdog(session);
      } catch (error) {
        this.options.onError?.(error);
        this.destroy(session.ctx.guild.id);
        return;
      }
    }
    this.persistQueue(session);
  }
  private persistQueue(session: Session): void {
    if (!session.ctx.store) return;
    const tracks = [...(session.current ? [session.current] : []), ...session.queue].flatMap((track) =>
      track.reference && !track.authorization ? [track.reference] : [],
    );
    if (tracks.length)
      session.ctx.store.set('voice.queues', session.ctx.guild.id, {
        tracks,
        updatedAt: this.now(),
      } satisfies SavedQueue);
    else session.ctx.store.delete('voice.queues', session.ctx.guild.id);
  }
  async queueView(ctx: ActionContext): Promise<unknown> {
    const saved = ctx.store.get<SavedQueue>('voice.queues', ctx.guild.id);
    if (!saved) return { tracks: [] };
    const tracks = [];
    for (const track of saved.tracks) {
      if (track.kind === 'attachment') await readableHistory(ctx, track.channelId);
      tracks.push(track);
    }
    return {
      ...saved,
      tracks,
      notice:
        'Only music source references persist. Restoring replays an interrupted current track from its beginning; source access is checked again.',
    };
  }
  restoreQueue(ctx: ActionContext): Promise<string> {
    const session = this.session(ctx),
      generation = session.generation,
      saved = ctx.store.get<SavedQueue>('voice.queues', ctx.guild.id);
    if (!saved?.tracks.length || saved.tracks.length > 6)
      throw new UserError('No valid retained music queue is available.');
    if (session.current || session.queue.length)
      throw new UserError('Stop the current queue before restoring a saved one.');
    return this.playlistJob(ctx, async () => {
      const tracks: Track[] = [];
      let bytes = 0;
      try {
        for (const reference of saved.tracks) {
          await this.playbackAccess(ctx, session, generation, true);
          let pcm: Buffer;
          if (reference.kind === 'attachment')
            pcm = (
              await uploadedWav(
                { ...ctx, channelId: reference.channelId },
                reference.messageId,
                reference.index,
                this.options.download,
              )
            ).pcm;
          else if (reference.kind === 'local') {
            if (!this.options.audioDirectory)
              throw new UserError('The saved local library source is disabled.');
            pcm = await readLocalVoiceAudio(this.options.audioDirectory, reference.id);
          } else {
            const source = this.options.streamSources?.[reference.id];
            if (!source) throw new UserError('A saved HTTPS source is disabled.');
            const response = await fetchPublic(source, {
              allowedHosts: [new URL(source).hostname],
              maxBytes: 2 * 1048576,
            });
            if (response.status !== 200) throw new UserError('A saved HTTPS source is unavailable.');
            pcm = await decodeAudioPcm(response.body);
          }
          bytes += pcm.length;
          if (bytes > MAX_QUEUE_BYTES) {
            pcm.fill(0);
            throw new UserError('Restored queue exceeds 24 MiB.');
          }
          tracks.push({ pcm, title: reference.title, reference });
        }
        await this.playbackAccess(ctx, session, generation, true);
        if (JSON.stringify(ctx.store.get('voice.queues', ctx.guild.id)) !== JSON.stringify(saved))
          throw new UserError('Saved queue changed while restoring.');
        session.queue.push(...tracks);
        this.next(session);
        return `Restored ${tracks.length} authorized music reference(s).`;
      } catch (error) {
        for (const track of tracks) track.pcm.fill(0);
        throw error;
      }
    });
  }
  clearSavedQueue(ctx: ActionContext): string {
    if (this.sessions.has(ctx.guild.id)) this.stop(ctx);
    ctx.store.delete('voice.queues', ctx.guild.id);
    return 'Saved music references cleared.';
  }
  private notifySpeakerReset(guildId: string, userId?: string): void {
    try {
      this.options.onSpeakerReset?.(guildId, userId);
    } catch (error) {
      try {
        this.options.onError?.(error);
      } catch {
        /* Diagnostics must not prevent a consent reset. */
      }
    }
  }
  private resetConversation(session: Session, userId?: string): void {
    session.conversation.clear(userId);
    this.notifySpeakerReset(session.ctx.guild.id, userId);
  }
  private diagnostic(
    session: Session,
    stage: string,
    fields: Record<string, string | number | boolean | undefined> = {},
  ): void {
    session.diagnostics.stage = stage;
    session.diagnostics.stageAt = this.now();
    try {
      this.options.onDiagnostic?.('voice.lifecycle', {
        guildId: session.ctx.guild.id,
        sessionId: session.id,
        stage,
        at: this.now(),
        ...fields,
      });
    } catch {
      /* Diagnostics cannot prevent listening or cancellation. */
    }
  }
  private requestStage<T>(
    session: Session,
    stage: string,
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs = 10000,
    signal = session.request?.signal,
  ): Promise<T> {
    this.diagnostic(session, `${stage}.started`);
    return voiceDeadline(
      async (current) => {
        const result = await operation(current);
        current.throwIfAborted();
        this.diagnostic(session, `${stage}.finished`);
        return result;
      },
      { signal, timeoutMs, message: `Voice ${stage} timed out; the request was not repeated.` },
    );
  }
  private sendCaptured(
    session: Session,
    userId: string,
    consent: Consent,
    generation: number,
    access: { ctx: ActionContext; channel: Awaited<ReturnType<typeof readableHistory>> },
    payload: MessageCreateOptions,
    signal = session.request?.signal,
  ): Promise<void> {
    return this.requestStage(
      session,
      'private.delivery',
      (current) =>
        (this.options.send ?? sendVoiceMessage)(access.channel as SendableChannels, payload, current, () => {
          current.throwIfAborted();
          if (!this.validConsent(session, userId, consent, generation))
            throw new UserError('Voice delivery was cancelled.');
          const channel = access.ctx.guild.channels.cache?.get(access.ctx.channelId) ?? access.channel,
            bot = access.ctx.guild.members.me;
          if (!bot) throw new UserError('Bot membership is unavailable.');
          if (this.options.requirePrivateTranscripts || this.options.resolveTranscriptChannel)
            assertPrivateTranscriptPrivacy(access.ctx, channel, bot);
          if (
            !channel.permissionsFor(access.ctx.member)?.has([P.ViewChannel, P.ReadMessageHistory]) ||
            !channel.permissionsFor(bot)?.has([P.ViewChannel, P.ReadMessageHistory, P.SendMessages])
          )
            throw new UserError('Private voice delivery access changed.');
        }),
      10000,
      signal,
    );
  }
  private discardSpeakerAudio(session: Session, userId: string): void {
    if (session.request?.userId === userId)
      session.request.controller.abort(new UserError('Voice consent changed.'));
    if (session.realtime?.userId === userId) {
      session.realtime.controller.abort();
      session.realtime.source.destroy();
      session.realtime = undefined;
    }
    session.queue = session.queue.filter((track) => {
      if (track.authorization?.userId !== userId) return true;
      track.cancel?.();
      track.pcm.fill(0);
      return false;
    });
    if (session.current?.authorization?.userId === userId) {
      this.clearPlaybackWatchdog(session);
      const current = session.current;
      session.current = undefined;
      session.driver.stop();
      current.cancel?.();
      current.pcm.fill(0);
      this.next(session);
    }
  }

  private capture(session: Session, userId: string): void {
    const consent = session.consent.get(userId);
    if (!consent || consent.expiresAt <= this.now()) return;
    if (
      session.capture ||
      session.processing ||
      session.current ||
      session.paused ||
      !session.transportReady ||
      (consent.transcription && !this.options.transcribe) ||
      !this.enabled(session) ||
      this.sessions.get(session.ctx.guild.id) !== session
    ) {
      if (this.now() - (session.diagnostics.lastSkipAt ?? -Infinity) >= 10000) {
        session.diagnostics.lastSkipAt = this.now();
        this.diagnostic(session, 'capture.skipped', {
          reason: session.paused
            ? 'paused'
            : !session.transportReady
              ? 'transport'
              : session.current
                ? 'playback'
                : session.processing
                  ? 'processing'
                  : session.capture
                    ? 'capturing'
                    : 'unavailable',
        });
      }
      return;
    }
    session.diagnostics.captures++;
    session.diagnostics.lastCaptureAt = this.now();
    this.diagnostic(session, 'capture.started');
    const chunks: Buffer[] = [];
    let size = 0,
      finished = false;
    const generation = session.generation;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (session.capture?.userId === userId) this.cancelCapture(session);
      if (size >= PCM_BYTES_SECOND / 5 && size <= MAX_CAPTURE_BYTES) {
        session.processing = true;
        const pcm = Buffer.concat(chunks, size),
          controller = new AbortController(),
          request: VoiceRequestState = { userId, generation, controller, signal: controller.signal };
        session.request = request;
        const work = voiceDeadline(
          (signal) => {
            request.signal = signal;
            return this.processCapture(session, userId, consent, generation, pcm);
          },
          {
            signal: controller.signal,
            timeoutMs: 60000,
            message: 'Voice request timed out; no action was retried.',
          },
        )
          .catch(async (caught: unknown) => {
            const error =
              caught instanceof CompletedActionError || !request.completedActions?.length
                ? caught
                : new CompletedActionError(request.completedActions);
            request.controller.abort(error);
            if (session.request === request) {
              if (session.speechWork?.request === request) {
                session.speechWork = undefined;
                session.speechPending = false;
              }
              session.request = undefined;
              session.processing = false;
            }
            session.diagnostics.failures++;
            const message = error instanceof Error ? error.message : '',
              code =
                error instanceof CompletedActionError
                  ? 'completed-response'
                  : /allowance|quota|daily.*limit/i.test(message)
                    ? 'quota'
                    : /local speech/i.test(message)
                      ? 'transcription'
                      : /realtime voice/i.test(message)
                        ? 'realtime'
                        : 'processing';
            session.diagnostics.lastFailureCode = code;
            this.diagnostic(session, 'processing.failed', { code });
            try {
              this.options.onError?.(error);
            } catch {
              /* Failure reporting cannot keep the capture lock held. */
            }
            if (
              !this.validConsent(session, userId, consent, generation) ||
              this.now() - (session.diagnostics.lastErrorNoticeAt ?? -Infinity) < 30000
            )
              return;
            session.diagnostics.lastErrorNoticeAt = this.now();
            await voiceDeadline(
              async (signal) => {
                const access = await this.captureAccess(session, userId, consent, generation, signal);
                if (!access) return;
                await this.sendCaptured(
                  session,
                  userId,
                  consent,
                  generation,
                  access,
                  {
                    content:
                      error instanceof CompletedActionError
                        ? error.message
                        : code === 'quota'
                          ? 'Voice replies are unavailable because the AI request allowance was reached. The daily allowance resets at 00:00 UTC; listening consent has not been extended.'
                          : `A voice request failed (${code}). Say ${this.options.botName ?? 'Vibe'} to start another request.`,
                    allowedMentions: { parse: [] },
                  },
                  signal,
                ).catch(() => {});
              },
              { timeoutMs: 2000, message: 'Private voice failure notice timed out.' },
            ).catch(() => {});
          })
          .finally(() => {
            if (session.request === request) {
              session.request = undefined;
              session.processing = false;
            }
            this.diagnostic(session, 'processing.finished', {
              playback: !!session.current,
              processing: session.processing,
            });
          });
        void this.track(work);
      } else {
        this.diagnostic(session, 'capture.discarded', { reason: 'audio-length', bytes: size });
      }
      chunks.length = 0;
    };
    const timer = setTimeout(finish, 15_000);
    timer.unref();
    session.capture = { userId, timer, cancel: () => {} };
    try {
      const cancel = session.driver.receive(
        userId,
        (chunk) => {
          if (finished) return;
          if (size + chunk.length > MAX_CAPTURE_BYTES) {
            finish();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        },
        finish,
        (error) => {
          if (!finished) {
            finished = true;
            this.cancelCapture(session);
            chunks.length = 0;
            this.options.onError?.(error);
          }
        },
      );
      if (session.capture?.userId === userId) session.capture.cancel = cancel;
      else cancel();
    } catch (error) {
      finished = true;
      this.cancelCapture(session);
      this.options.onError?.(error);
    }
  }

  private validConsent(session: Session, userId: string, consent: Consent, generation: number): boolean {
    return (
      this.sessions.get(session.ctx.guild.id) === session &&
      session.generation === generation &&
      this.enabled(session) &&
      session.transportReady &&
      session.consent.get(userId)?.token === consent.token &&
      consent.expiresAt > this.now()
    );
  }
  private enabled(session: Session): boolean {
    return !(session.ctx.store?.get<string[]>('core.disabled', session.ctx.guild.id) ?? []).includes('voice');
  }
  private async transcriptChannel(ctx: ActionContext) {
    const channel = await readableHistory(ctx, ctx.channelId);
    if (this.options.requirePrivateTranscripts || this.options.resolveTranscriptChannel) {
      const everyone = ctx.guild.roles?.everyone;
      if (
        channel.type !== ChannelType.GuildText ||
        !everyone ||
        channel.permissionsFor(everyone)?.has(P.ViewChannel) !== false
      )
        throw new UserError(
          'Voice transcripts require a dedicated private text channel hidden from @everyone.',
        );
      if (
        !channel.isTextBased() ||
        !('send' in channel) ||
        !channel.permissionsFor(ctx.guild.members.me!)?.has(P.SendMessages)
      )
        throw new UserError(
          'The bot needs View Channel, Read Message History and Send Messages in the private transcript channel.',
        );
      assertPrivateTranscriptPrivacy(ctx, channel, ctx.guild.members.me!);
    }
    return channel;
  }
  private async captureAccess(
    session: Session,
    userId: string,
    consent: Consent,
    generation: number,
    signal = session.request?.signal,
  ) {
    if (!this.validConsent(session, userId, consent, generation)) return;
    try {
      return await this.requestStage(
        session,
        'access.refresh',
        async () => {
          const member = await session.ctx.guild.members.fetch({ user: userId, force: true });
          // This member was just force-fetched. Avoid a second identical REST lookup and a duplicate channel fetch.
          const ctx = await this.playbackAccess({ ...session.ctx, member }, session, generation, false, true);
          const channel = await this.transcriptChannel(ctx);
          if (
            !channel.isTextBased() ||
            !('send' in channel) ||
            !this.validConsent(session, userId, consent, generation)
          )
            return;
          const send = channel.isThread?.() ? P.SendMessagesInThreads : P.SendMessages;
          if (!channel.permissionsFor(ctx.guild.members.me!)?.has(send)) return;
          return { ctx, channel };
        },
        10000,
        signal,
      );
    } catch {
      this.diagnostic(session, 'access.denied');
      return;
    }
  }
  private async consentSpeech(
    session: Session,
    userId: string,
    consent: Consent,
    generation: number,
    text: string,
    title: string,
  ): Promise<void> {
    if (session.speechPending) return;
    const access = await this.captureAccess(session, userId, consent, generation);
    if (!access || session.speechPending) return;
    const speechWork = { request: session.request };
    session.speechWork = speechWork;
    session.speechPending = true;
    let pcm: Buffer | undefined;
    try {
      const lease = this.requestLease(access.ctx);
      const data = await this.requestStage(
        session,
        'speech.provider',
        (signal) =>
          this.options.speech!(
            userRequestContext(access.ctx, 'voice', {
              valid: (fresh) => !signal.aborted && lease(fresh),
            }),
            text.slice(0, 1000),
            { signal },
          ),
        60000,
      );
      if (data.byteLength > MAX_ATTACHMENT) throw new UserError('Generated speech exceeds its audio bound.');
      pcm = Buffer.from(data);
      const current = await this.captureAccess(session, userId, consent, generation);
      if (!current) return;
      this.enqueue(current.ctx, toDiscordPcm(pcm, 24_000, 1), title, { userId, token: consent.token });
    } finally {
      pcm?.fill(0);
      if (session.speechWork === speechWork) {
        session.speechPending = false;
        session.speechWork = undefined;
      }
    }
  }
  private pendingPlaybackMs(session: Session, userId: string): number {
    const current = session.current;
    if (current?.authorization?.userId !== userId) return 0;
    return this.remainingPlaybackMs(current);
  }
  private remainingPlaybackMs(track: Track): number {
    const duration =
      track.streamStartedAt === undefined
        ? (track.pcm.length / PCM_BYTES_SECOND) * 1000
        : (track.streamDurationMs ?? 0);
    const elapsed =
      track.playbackStartedAt === undefined
        ? 0
        : Math.max(
            0,
            (track.playbackPausedAt ?? this.now()) - track.playbackStartedAt - (track.playbackPausedMs ?? 0),
          );
    return Math.max(0, duration - elapsed);
  }
  private clearPlaybackWatchdog(session: Session): void {
    clearTimeout(session.playbackWatchdog);
    session.playbackWatchdog = undefined;
  }
  private suspendPlaybackWatchdog(session: Session): void {
    if (session.current && session.current.playbackPausedAt === undefined)
      session.current.playbackPausedAt = this.now();
    this.clearPlaybackWatchdog(session);
  }
  private resumePlaybackWatchdog(session: Session): void {
    if (session.paused || !session.transportReady) return;
    const track = session.current;
    if (track?.playbackPausedAt !== undefined) {
      track.playbackPausedMs =
        (track.playbackPausedMs ?? 0) + Math.max(0, this.now() - track.playbackPausedAt);
      track.playbackPausedAt = undefined;
    }
    this.armPlaybackWatchdog(session);
  }
  private armPlaybackWatchdog(session: Session): void {
    this.clearPlaybackWatchdog(session);
    const track = session.current;
    if (
      !track?.generated ||
      session.paused ||
      !session.transportReady ||
      (track.streamStartedAt !== undefined && !track.streamEnded)
    )
      return;
    const delay = Math.ceil(this.remainingPlaybackMs(track)) + PLAYBACK_GRACE_MS;
    const timer = setTimeout(() => {
      if (
        session.playbackWatchdog !== timer ||
        session.current !== track ||
        session.paused ||
        this.sessions.get(session.ctx.guild.id) !== session
      )
        return;
      this.clearPlaybackWatchdog(session);
      this.diagnostic(session, 'playback.stalled');
      session.current = undefined;
      // A missing Idle event cannot leave generated speech blocking capture forever.
      // Do not open or extend a follow-up turn for audio with uncertain delivery.
      if (track.authorization) this.resetConversation(session, track.authorization.userId);
      track.cancel?.();
      track.pcm.fill(0);
      session.driver.stop();
      this.next(session);
    }, delay);
    timer.unref();
    session.playbackWatchdog = timer;
  }
  private async realtimeSpeech(
    session: Session,
    userId: string,
    consent: Consent,
    generation: number,
    text: string,
    meta: VoiceTurnMeta,
    verifiedAccess?: { ctx: ActionContext },
  ): Promise<string | VoiceReply | undefined> {
    if (!this.options.realtimeReply) return;
    const access = verifiedAccess ?? (await this.captureAccess(session, userId, consent, generation));
    if (!access || session.speechPending) return;
    const controller = new AbortController(),
      source = new PassThrough({ highWaterMark: 65536 }),
      converter = new SpeechPcmStream(),
      chunks: Buffer[] = [];
    source.on('error', () => {});
    const state = { controller, source, userId, token: consent.token };
    const requestSignal = session.request?.signal,
      lease = this.requestLease(access.ctx);
    let started = false,
      total = 0,
      audioFinished = false,
      track: Track | undefined,
      audioFailure: unknown;
    let audioWork: Promise<void> = Promise.resolve();
    session.realtime = state;
    const speechWork = { request: session.request };
    session.speechWork = speechWork;
    session.speechPending = true;
    const current = () =>
      session.realtime === state &&
      !controller.signal.aborted &&
      !requestSignal?.aborted &&
      this.validConsent(session, userId, consent, generation) &&
      lease({ ...access.ctx, member: access.ctx.guild.members.cache?.get(userId) ?? access.ctx.member });
    const assertCurrent = () => {
      if (!current())
        throw new UserError('Realtime voice response was cancelled after consent or session changed.');
    };
    const cancelStream = () => {
      controller.abort();
      source.destroy();
      if (track && session.current === track) {
        this.clearPlaybackWatchdog(session);
        session.current = undefined;
        session.driver.stop();
      }
    };
    const write = async (output: Buffer) => {
      if (!output.length) return;
      assertCurrent();
      if (!started) {
        if (session.current || session.paused)
          throw new UserError('Realtime speech cancelled after playback changed.');
        track = {
          title: 'AI voice reply',
          pcm: Buffer.alloc(0),
          authorization: { userId, token: consent.token },
          cancel: () => {
            controller.abort();
            source.destroy();
          },
          streamStartedAt: this.now(),
          streamDurationMs: 0,
          generated: true,
          playbackStartedAt: this.now(),
          playbackPausedMs: 0,
        };
        session.current = track;
        session.diagnostics.lastPlaybackAt = this.now();
        this.diagnostic(session, 'playback.started', { streaming: true });
        started = true;
        session.driver.playStream!(source, session.volume);
      }
      track!.streamDurationMs! += (output.length / PCM_BYTES_SECOND) * 1000;
      if (!source.write(output)) await once(source, 'drain', { signal: controller.signal });
      assertCurrent();
    };
    const completeAudio = async () => {
      if (audioFinished) return;
      await audioWork;
      if (audioFailure) throw audioFailure;
      assertCurrent();
      if (session.driver.playStream) {
        await write(converter.finish());
        if (track) track.streamEnded = true;
        source.end();
        this.armPlaybackWatchdog(session);
      }
      audioFinished = true;
      this.diagnostic(session, 'audio.finished', { bytes: total });
    };
    try {
      const signal = requestSignal ? AbortSignal.any([requestSignal, controller.signal]) : controller.signal;
      const result = await this.requestStage(
        session,
        'realtime.provider',
        (currentSignal) =>
          this.options.realtimeReply!(access.ctx, text, meta, {
            signal: currentSignal,
            audioDone: completeAudio,
            audio: (value) => {
              try {
                assertCurrent();
                if (audioFinished) throw new UserError('Realtime audio arrived after output completed.');
                total += value.byteLength;
                if (total > 24000 * 2 * MAX_PLAY_SECONDS)
                  throw new UserError('Realtime speech exceeded its two-minute audio bound.');
                const bytes = Buffer.from(value);
                // WebSocket adapters may emit concurrently; retain order and honor playback backpressure.
                const job = audioWork.then(async () => {
                  try {
                    if (audioFailure) throw audioFailure;
                    assertCurrent();
                    if (session.driver.playStream) await write(converter.push(bytes));
                    else chunks.push(Buffer.from(bytes));
                  } finally {
                    bytes.fill(0);
                  }
                });
                audioWork = job.catch((error) => {
                  audioFailure ??= error;
                  cancelStream();
                });
                return job;
              } catch (error) {
                audioFailure ??= error;
                cancelStream();
                const failure = Promise.reject<void>(error);
                void failure.catch(() => {});
                return failure;
              }
            },
          }),
        45000,
        signal,
      );
      await audioWork;
      if (audioFailure) throw audioFailure;
      assertCurrent();
      if (result === undefined) {
        if (total)
          throw new UserError('Realtime speech was interrupted after audio started; it was not repeated.');
        return;
      }
      if (!(await this.captureAccess(session, userId, consent, generation)))
        throw new UserError('Realtime speech cancelled after current access changed.');
      assertCurrent();
      await completeAudio();
      if (!session.driver.playStream && total) {
        const pcm = Buffer.concat(chunks, total);
        try {
          this.enqueue(access.ctx, toDiscordPcm(pcm, 24000, 1), 'AI voice reply', {
            userId,
            token: consent.token,
          });
        } finally {
          pcm.fill(0);
        }
      }
      if (!total && (typeof result === 'string' ? result : result.text).trim()) {
        if (session.speechWork === speechWork) {
          session.speechPending = false;
          session.speechWork = undefined;
        }
        await this.consentSpeech(
          session,
          userId,
          consent,
          generation,
          typeof result === 'string' ? result : result.text,
          'AI voice reply',
        );
      }
      return result;
    } catch (error) {
      cancelStream();
      throw error;
    } finally {
      await audioWork;
      converter.clear();
      for (const chunk of chunks) chunk.fill(0);
      if (!started) source.destroy();
      if (session.realtime === state) session.realtime = undefined;
      if (session.speechWork === speechWork) {
        session.speechPending = false;
        session.speechWork = undefined;
      }
    }
  }
  private async processCapture(
    session: Session,
    userId: string,
    consent: Consent,
    generation: number,
    pcm: Buffer,
  ): Promise<void> {
    try {
      const before = await this.captureAccess(session, userId, consent, generation);
      if (!before) return;
      const activity = acousticVoiceActivity(pcm);
      if (consent.vad) {
        before.ctx.store?.set('voice.activity', `${before.ctx.guild.id}:${userId}`, {
          ...activity,
          at: this.now(),
        });
        if (!activity.active) return;
      }
      const wav = pcmToWav(pcm);
      let transcript: string;
      try {
        if (consent.recording) {
          const policy = before.ctx.store.get<VoiceRecordingPolicy>(
            'voice.recordingPolicy',
            before.ctx.guild.id,
          );
          if (
            !policy?.enabled ||
            policy.version !== consent.recordingVersion ||
            !this.validConsent(session, userId, consent, generation)
          )
            return;
          saveVoiceRecording(
            before.ctx.store,
            before.ctx.guild.id,
            userId,
            before.ctx.channelId,
            wav,
            policy,
            this.now(),
          );
        }
        if (!consent.transcription) return;
        this.diagnostic(session, 'transcription.started');
        transcript = filterTranscription(
          await this.requestStage(
            session,
            'transcription.provider',
            (signal) => this.options.transcribe!(before.ctx, wav, { signal }),
            60000,
          ),
        ).slice(0, 4000);
        session.diagnostics.transcriptions++;
        session.diagnostics.lastTranscriptAt = this.now();
        this.diagnostic(session, 'transcription.finished', { empty: !transcript.trim() });
      } finally {
        wav.fill(0);
        pcm.fill(0);
      }
      if (!transcript.trim()) return;
      const access = await this.captureAccess(session, userId, consent, generation);
      if (!access) return;
      const lease = this.requestLease(access.ctx);
      const stillCurrent = () =>
        lease({
          ...access.ctx,
          member: access.ctx.guild.members.cache?.get(userId) ?? access.ctx.member,
        });
      await this.sendCaptured(session, userId, consent, generation, access, {
        content:
          `Voice transcript (${access.ctx.member.displayName.replace(/[@`]/g, '')}): ${transcript}`.slice(
            0,
            2000,
          ),
        allowedMentions: { parse: [] },
      });
      if (consent.meetings && this.validConsent(session, userId, consent, generation)) {
        const name = access.ctx.member.displayName.replace(/[@`\r\n:]/g, '').slice(0, 40);
        session.meeting.push({
          userId,
          name,
          text: transcript.slice(0, 1000),
          at: this.now(),
          token: consent.token,
        });
        session.meeting = session.meeting.filter((segment) =>
          this.meetingValid(session, segment, generation),
        );
        while (
          session.meeting.length > 60 ||
          new Set(session.meeting.map((segment) => segment.userId)).size > 10 ||
          session.meeting.reduce(
            (total, segment) => total + segment.name.length + segment.text.length + 3,
            0,
          ) > 6000
        )
          session.meeting.shift();
      }
      const activeFollowUp = session.conversation.followUpActive(userId, this.now());
      const selected = this.options.requireWakeWord
        ? session.conversation.select(userId, transcript, this.now())
        : { text: transcript, kind: 'wake' as const };
      if (!selected) {
        session.diagnostics.wakeIgnored++;
        if (activeFollowUp) session.diagnostics.followUpIgnored++;
        this.diagnostic(session, 'wake.ignored', {
          reason: activeFollowUp ? 'unrelated-follow-up' : 'no-name-or-expired-follow-up',
        });
        return;
      }
      session.diagnostics.addressed++;
      session.diagnostics.lastAddressedAt = this.now();
      this.diagnostic(session, 'request.addressed', { kind: selected.kind, addressing: selected.addressing });
      const request = selected.text;
      if (!request) {
        if (consent.replies) {
          await this.consentSpeech(session, userId, consent, generation, 'Yes?', 'AI voice reply');
          session.conversation.complete(
            userId,
            'called your name',
            { text: 'What would you like me to do?', followUp: 'clarification' },
            this.now(),
            this.pendingPlaybackMs(session, userId),
          );
        }
        return;
      }
      if ((consent.commands || consent.replies) && this.options.onTranscript) {
        if (!stillCurrent()) return;
        const payload = await this.requestStage(
          session,
          'command.provider',
          (signal) => this.options.onTranscript!(access.ctx, request, selected, { signal }),
          60000,
        );
        if (!stillCurrent()) return;
        if (payload) {
          const current = await this.captureAccess(session, userId, consent, generation);
          if (!current) return;
          const { voiceResponse, followUp, ...messagePayload } = payload;
          await this.sendCaptured(session, userId, consent, generation, current, {
            ...messagePayload,
            allowedMentions: { parse: [] },
          });
          const text =
            voiceResponse ??
            (typeof payload.content === 'string'
              ? payload.content
                  .replace(/```[\s\S]*?```/g, '')
                  .replace(/[*`_]/g, '')
                  .trim()
                  .slice(0, 800)
              : 'Done.');
          if (consent.replies && text)
            await this.consentSpeech(session, userId, consent, generation, text, 'Voice action result');
          if (this.validConsent(session, userId, consent, generation))
            session.conversation.complete(
              userId,
              request,
              { text, followUp },
              this.now(),
              this.pendingPlaybackMs(session, userId),
            );
          return;
        }
      }
      if (consent.language) {
        const translateAccess = await this.captureAccess(session, userId, consent, generation);
        if (!translateAccess) return;
        const translated = (await this.options.translate!(translateAccess.ctx, request, consent.language))
          .trim()
          .slice(0, 1000);
        const current = await this.captureAccess(session, userId, consent, generation);
        if (!current || !translated) return;
        await this.sendCaptured(session, userId, consent, generation, current, {
          content: `Voice translation (${consent.language}): ${translated}`.slice(0, 2000),
          allowedMentions: { parse: [] },
        });
        await this.consentSpeech(
          session,
          userId,
          consent,
          generation,
          translated,
          `Voice translation: ${consent.language}`,
        );
      }
      if (consent.replies) {
        if (!stillCurrent()) return;
        this.diagnostic(session, 'reply.started');
        let response = await this.realtimeSpeech(
          session,
          userId,
          consent,
          generation,
          request,
          selected,
          access,
        );
        if (response === undefined) {
          if (!stillCurrent()) return;
          response = await this.requestStage(
            session,
            'reply.provider',
            (signal) => this.options.reply!(access.ctx, request, selected, { signal }),
            60000,
          );
          const text = typeof response === 'string' ? response : response.text;
          if (typeof response !== 'string' && response.completedActions?.length && session.request)
            session.request.completedActions = response.completedActions;
          if (text.trim()) {
            try {
              await this.consentSpeech(session, userId, consent, generation, text, 'AI voice reply');
            } catch (error) {
              if (typeof response !== 'string' && response.completedActions?.length)
                throw new CompletedActionError(response.completedActions);
              throw error;
            }
          }
        }
        if (this.validConsent(session, userId, consent, generation))
          session.conversation.complete(
            userId,
            request,
            response,
            this.now(),
            this.pendingPlaybackMs(session, userId),
          );
        session.diagnostics.replies++;
        this.diagnostic(session, 'reply.finished');
      }
    } finally {
      pcm.fill(0);
    }
  }
  private cancelCapture(session: Session): void {
    const capture = session.capture;
    session.capture = undefined;
    if (capture) {
      clearTimeout(capture.timer);
      capture.cancel();
    }
  }
  private expireConsent(): void {
    for (const store of this.archiveStores)
      try {
        pruneVoiceRecordings(store, this.now());
      } catch (error) {
        this.options.onError?.(error);
      }
    for (const session of this.sessions.values()) {
      session.conversation.prune(this.now());
      for (const [id, consent] of session.consent)
        if (consent.expiresAt <= this.now()) {
          session.consent.delete(id);
          this.diagnostic(session, 'consent.expired');
          this.resetConversation(session, id);
          this.discardSpeakerAudio(session, id);
          session.meeting = session.meeting.filter((segment) => segment.userId !== id);
          if (session.capture?.userId === id) this.cancelCapture(session);
        }
    }
  }
  private destroy(guildId: string): void {
    this.joining.delete(guildId);
    const session = this.sessions.get(guildId);
    if (!session) return;
    session.request?.controller.abort(new UserError('Voice session closed.'));
    this.clearPlaybackWatchdog(session);
    this.diagnostic(session, 'session.closed');
    this.persistQueue(session);
    this.sessions.delete(guildId);
    session.generation++;
    session.consent.clear();
    this.resetConversation(session);
    session.realtime?.controller.abort();
    session.realtime?.source.destroy();
    session.meeting = [];
    this.cancelCapture(session);
    session.queue = [];
    session.current = undefined;
    session.driver.destroy();
  }
  close(): void {
    this.closed = true;
    clearInterval(this.maintenance);
    this.joining.clear();
    for (const guildId of this.sessions.keys()) this.destroy(guildId);
    this.archiveStores.clear();
  }
  disableGuild(guildId: string): void {
    this.destroy(guildId);
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }
  /** Call after close(), before closing SQLite or the Discord client. AI adapters must use bounded requests. */
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

async function uploadedWav(
  ctx: ActionContext,
  messageId: string,
  index: number,
  downloader: typeof downloadAttachment = downloadAttachment,
): Promise<{ pcm: Buffer; name: string }> {
  const member = await ctx.guild.members.fetch({ user: ctx.member.id, force: true });
  const channel = await readableHistory({ ...ctx, member }, ctx.channelId);
  if (!channel?.isTextBased() || !('messages' in channel))
    throw new UserError('Use a server text channel with message history.');
  const message = await channel.messages.fetch(messageId);
  const attachment = [...message.attachments.values()][index];
  if (
    !attachment ||
    !/\.(wav|mp3|flac|ogg|opus|m4a|mp4|webm)$/i.test(attachment.name) ||
    attachment.size > MAX_ATTACHMENT
  )
    throw new UserError('Select a supported uploaded audio attachment, at most 8 MiB and 120 seconds.');
  const data = await downloader(attachment.url, MAX_ATTACHMENT);
  let pcm: Buffer;
  if (attachment.name.toLowerCase().endsWith('.wav')) {
    try {
      pcm = decodeWav(data);
    } catch {
      pcm = await decodeAudioPcm(data);
    }
  } else pcm = await decodeAudioPcm(data);
  return { pcm, name: attachment.name };
}

async function readableHistory(ctx: ActionContext, channelId: string) {
  const channel = await resolveChannel(ctx, channelId);
  if (
    !channel.permissionsFor(ctx.member)?.has([P.ViewChannel, P.ReadMessageHistory]) ||
    !channel.permissionsFor(ctx.guild.members.me!)?.has([P.ViewChannel, P.ReadMessageHistory])
  )
    throw new UserError('Both you and the bot need View Channel and Read Message History for this source.');
  return channel;
}

export function registerVoiceActions(registry: ActionRegistry, voice: VoiceService): void {
  const empty = z.strictObject({});
  const permissions = {
    userPermissions: [] as bigint[],
    botPermissions: [P.Connect, P.Speak, P.ViewChannel],
  };
  const base = { category: 'voice', ...permissions, risk: 'write' as const };
  registry.register({
    ...base,
    id: 'voice.join',
    description:
      'Join your voice channel, or a Stage where you and the bot are moderators. Capture needs individual consent.',
    schema: empty,
    execute: (ctx) => voice.join(ctx),
  });
  registry.register({
    ...base,
    id: 'voice.move',
    description:
      'Move the existing transport to an authorized voice/Stage channel, clearing previous audio and consent.',
    schema: z.strictObject({ channelId: z.string().regex(/^\d{17,20}$/) }),
    execute: (ctx, input) => voice.move(ctx, input.channelId),
  });
  registry.register({
    ...base,
    id: 'voice.sources',
    risk: 'read',
    description: 'List fixed host-approved HTTPS audio source IDs without exposing private URL queries.',
    schema: empty,
    execute: () => voice.sources(),
  });
  registry.register({
    ...base,
    id: 'voice.stream',
    description:
      'Play a configured authorized HTTPS source, bounded to 2 MiB download and 120 seconds, with current voice/history checks.',
    schema: z.strictObject({ id: localAudioId }),
    execute: (ctx, input) => voice.stream(ctx, input.id),
  });
  registry.register({
    ...base,
    id: 'voice.queue.saved',
    risk: 'read',
    description:
      'Read retained per-server music source references only after current source-history authorization.',
    schema: empty,
    execute: (ctx) => voice.queueView(ctx),
  });
  registry.register({
    ...base,
    id: 'voice.queue.restore',
    description:
      'Restore an interrupted per-server music queue from reauthorized uploaded/local/HTTPS source references.',
    schema: empty,
    execute: (ctx) => voice.restoreQueue(ctx),
  });
  registry.register({
    ...base,
    id: 'voice.queue.clear',
    description:
      'Clear retained music queue references and stop an active queue; no consented speech is persisted.',
    schema: empty,
    execute: (ctx) => voice.clearSavedQueue(ctx),
  });
  registry.register({
    ...base,
    id: 'voice.leave',
    description: 'Leave voice, revoke all consent and discard audio queues.',
    schema: empty,
    execute: (ctx) => voice.leave(ctx),
  });
  registry.register({
    ...base,
    id: 'voice.stop',
    description: 'Stop playback, clear queue and cancel pending voice results.',
    schema: empty,
    execute: (ctx) => voice.stop(ctx),
  });
  registry.register({
    ...base,
    id: 'voice.pause',
    description: 'Pause playback and live audio capture.',
    schema: empty,
    execute: (ctx) => voice.pause(ctx),
  });
  registry.register({
    ...base,
    id: 'voice.resume',
    description: 'Resume paused playback and consented listening.',
    schema: empty,
    execute: (ctx) => voice.resume(ctx),
  });
  registry.register({
    ...base,
    id: 'voice.skip',
    description: 'Skip the playing track.',
    schema: empty,
    execute: (ctx) => voice.skip(ctx),
  });
  registry.register({
    ...base,
    id: 'voice.status',
    risk: 'read',
    description: 'Show voice connection, playback queue and consent count.',
    schema: empty,
    execute: (ctx) => voice.status(ctx),
  });
  registry.register({
    ...base,
    id: 'voice.volume',
    description: 'Set volume 0–1 immediately for current playback and subsequent tracks.',
    schema: z.strictObject({ value: z.number().min(0).max(1) }),
    execute: (ctx, input) => voice.volume(ctx, input.value),
  });
  registry.register({
    ...base,
    id: 'voice.speak',
    description: 'Speak up to 1000 text characters using AI-generated speech.',
    schema: z.strictObject({ text: z.string().trim().min(1).max(1000) }),
    execute: (ctx, input) => voice.speak(ctx, input.text),
  });
  registry.register({
    ...base,
    botPermissions: [...base.botPermissions, P.ReadMessageHistory],
    id: 'voice.play',
    description:
      'Decode and queue an existing Discord audio attachment (8 MiB, at most 120 seconds), from this channel.',
    schema: z.strictObject({
      messageId: z.string().regex(/^\d{17,20}$/),
      attachmentIndex: z.number().int().min(0).max(9).default(0),
    }),
    execute: (ctx, input) => voice.playUploaded(ctx, input.messageId, input.attachmentIndex),
  });
  registry.register({
    ...base,
    botPermissions: [],
    id: 'voice.consent',
    description:
      'Consent for 10 min: optional transcription uploads to OpenAI; optional individual WAV archive persists locally until expiry/erasure. False revokes future capture.',
    schema: z.strictObject({
      enabled: z.boolean(),
      replies: z.boolean().default(false),
      meetings: z.boolean().default(false),
      commands: z.boolean().default(false),
      language: z.enum(VOICE_LANGUAGES).optional(),
      vad: z.boolean().default(false),
      recording: z.boolean().default(false),
      transcription: z.boolean().default(true),
    }),
    execute: (ctx, input) =>
      voice.consent(
        ctx,
        input.enabled,
        input.replies,
        input.meetings,
        input.commands,
        input.language,
        input.vad,
        input.recording,
        input.transcription,
      ),
  });
  registry.register({
    ...base,
    id: 'voice.recording.configure',
    botPermissions: [],
    userPermissions: [P.ManageGuild],
    description:
      'Enable or disable the individual consented WAV archive, with bounded retention and storage; disabled by default.',
    schema: z.strictObject({
      enabled: z.boolean(),
      retentionHours: z.number().int().min(1).max(168).default(24),
      maximumRecordings: z.number().int().min(1).max(100).default(20),
    }),
    execute: (ctx, input) => {
      const policy: VoiceRecordingPolicy = { ...input, version: randomUUID() };
      ctx.store.set('voice.recordingPolicy', ctx.guild.id, policy);
      return {
        ...policy,
        globalStorageLimitMiB: 64,
        notice:
          'Only separately consenting speakers are archived. Host operators/backups can access audio. Disabled policies stop new recording; existing files expire or may be erased by their owner.',
      };
    },
  });
  registry.register({
    ...base,
    id: 'voice.recordings.list',
    risk: 'read',
    botPermissions: [],
    description: 'List your own unexpired consented recordings without exposing another speaker’s audio.',
    schema: empty,
    execute: (ctx) => ownVoiceRecordings(ctx.store, ctx.guild.id, ctx.member.id),
  });
  registry.register({
    ...base,
    id: 'voice.recordings.export',
    risk: 'read',
    botPermissions: [],
    description:
      'Download your own individual WAV utterance after current source-channel history authorization.',
    schema: z.strictObject({ id: z.string().regex(/^[a-f0-9]{24}$/) }),
    execute: async (ctx, input) => {
      const record = voiceRecording(ctx.store, ctx.guild.id, ctx.member.id, input.id);
      try {
        const current = await ctx.guild.members.fetch({ user: ctx.member.id, force: true });
        await readableHistory({ ...ctx, member: current }, record.channelId);
      } finally {
        record.attachment.fill(0);
      }
      // An explicit erase during the access lookup must also invalidate a waiting export.
      const latest = voiceRecording(ctx.store, ctx.guild.id, ctx.member.id, input.id);
      return { attachment: latest.attachment, name: latest.name };
    },
  });
  registry.register({
    ...base,
    id: 'voice.recordings.erase',
    botPermissions: [],
    description:
      'Revoke your current voice consent and erase all of your own archived recordings in this server.',
    schema: empty,
    execute: (ctx) => {
      voice.consent(ctx, false);
      ctx.store.delete('voice.activity', `${ctx.guild.id}:${ctx.member.id}`);
      return { erased: eraseVoiceRecordings(ctx.store, ctx.guild.id, ctx.member.id) };
    },
  });
  registry.register({
    ...base,
    id: 'voice.activity',
    risk: 'read',
    botPermissions: [],
    description:
      'Read acoustic activity metadata for your last explicitly VAD-enabled utterance, without retained transcript content.',
    schema: empty,
    execute: (ctx) => ctx.store.get('voice.activity', `${ctx.guild.id}:${ctx.member.id}`) ?? null,
  });
  registry.register({
    ...base,
    botPermissions: [P.ViewChannel, P.ReadMessageHistory],
    id: 'voice.playlist-save',
    description:
      'Validate and save 1–5 supported audio attachment references from this text channel as your personal playlist; audio is reauthorized and decoded at playback.',
    schema: playlistSchema,
    execute: (ctx, input) => voice.savePlaylist(ctx, input),
  });
  registry.register({
    ...base,
    botPermissions: [],
    id: 'voice.playlist-list',
    risk: 'read',
    description: 'List names and counts of your saved playlists in this server.',
    schema: empty,
    execute: (ctx) => voice.playlists(ctx),
  });
  registry.register({
    ...base,
    botPermissions: [],
    id: 'voice.playlist-remove',
    description: 'Delete your saved playlist references in this server.',
    schema: z.strictObject({ name: playlistName }),
    execute: (ctx, input) => voice.removePlaylist(ctx, input.name),
  });
  registry.register({
    ...base,
    id: 'voice.playlist-play',
    description:
      'Reauthorize all saved source messages and atomically queue your bounded audio playlist in your current voice session.',
    schema: z.strictObject({ name: playlistName }),
    execute: (ctx, input) => voice.playPlaylist(ctx, input.name),
  });
  registry.register({
    ...base,
    userPermissions: [P.ViewChannel, P.ReadMessageHistory],
    botPermissions: [P.ViewChannel, P.ReadMessageHistory],
    id: 'voice.meeting-status',
    risk: 'read',
    description:
      'Show current consented in-memory meeting excerpt counts from the disclosed transcript channel.',
    schema: empty,
    execute: (ctx) => voice.meetingStatus(ctx),
  });
  registry.register({
    ...base,
    userPermissions: [P.ViewChannel, P.ReadMessageHistory],
    botPermissions: [P.ViewChannel, P.ReadMessageHistory],
    id: 'voice.meeting-summary',
    risk: 'read',
    description:
      'Summarize only current participants’ explicitly opted-in voice excerpts; recheck consent and text history access before returning the private summary attachment.',
    schema: empty,
    execute: (ctx) => voice.summarizeMeeting(ctx),
  });
}
