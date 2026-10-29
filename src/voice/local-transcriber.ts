import { Worker, type WorkerOptions } from 'node:worker_threads';
import { resolve } from 'node:path';
import { UserError } from '../core/errors.js';
import { filterTranscription } from './transcript-filter.js';

export interface LocalTranscriptionWorker {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  postMessage(value: unknown, transfer?: readonly ArrayBuffer[]): void;
  terminate(): Promise<number> | number;
  removeAllListeners(): unknown;
}
export interface LocalTranscriberOptions {
  model?: string;
  cacheDir: string;
  allowDownload?: boolean;
  workerFactory?: (url: URL, options: WorkerOptions) => LocalTranscriptionWorker;
  now?: () => number;
  /** Fixed host/test bounds, not user-supplied audio options. */
  timeoutMs?: number;
}
const MAX_BYTES = 8 * 1024 * 1024,
  MAX_SECONDS = 15,
  QUEUE_AGE = 15000;
const cancelled = () => new UserError('Local transcription was cancelled.');
const unavailable = (detail: string) =>
  new UserError(
    `Local speech ${detail}. Run pnpm voice:prepare on this host, check the selected model/cache and restart Vibe. Audio was not uploaded to a remote transcription service.`,
  );
interface Job {
  id: number;
  at: number;
  audio?: Float32Array;
  signal?: AbortSignal;
  abort: () => void;
  settled: boolean;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}
/** Strict PCM16 WAV parsing and bounded anti-aliasing conversion to Whisper's mono Float32/16kHz input. */
export function decodeLocalTranscriptionWav(wav: Buffer): Float32Array {
  if (
    !Buffer.isBuffer(wav) ||
    wav.length < 44 ||
    wav.length > MAX_BYTES ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE' ||
    wav.readUInt32LE(4) + 8 !== wav.length
  )
    throw new UserError('Local transcription requires an intact PCM16 WAV, at most 8 MiB.');
  let channels = 0,
    rate = 0,
    data: Buffer | undefined,
    formatted = false,
    offset = 12;
  while (offset + 8 <= wav.length) {
    const name = wav.toString('ascii', offset, offset + 4),
      length = wav.readUInt32LE(offset + 4),
      start = offset + 8,
      end = start + length;
    if (end > wav.length) throw new UserError('The WAV contains a truncated chunk.');
    if (name === 'fmt ') {
      if (formatted || length < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 14) !== 16)
        throw new UserError('Local transcription accepts only one uncompressed PCM16 WAV format.');
      formatted = true;
      channels = wav.readUInt16LE(start + 2);
      rate = wav.readUInt32LE(start + 4);
      if (
        ![1, 2].includes(channels) ||
        rate < 8000 ||
        rate > 48000 ||
        wav.readUInt16LE(start + 12) !== channels * 2 ||
        wav.readUInt32LE(start + 8) !== rate * channels * 2
      )
        throw new UserError('Local transcription WAV must be mono/stereo PCM16 at 8–48 kHz.');
    } else if (name === 'data') {
      if (data) throw new UserError('Multiple WAV audio chunks are unsupported.');
      data = wav.subarray(start, end);
    }
    offset = end + (length % 2);
    if (offset > wav.length) throw new UserError('The WAV is missing chunk padding.');
  }
  if (offset !== wav.length || !formatted || !data?.length || data.length % (channels * 2) !== 0)
    throw new UserError('The WAV is missing complete format/audio data.');
  const frames = data.length / (channels * 2);
  if (frames / rate > MAX_SECONDS)
    throw new UserError('Local transcription accepts at most 15 seconds of audio.');
  const count = Math.floor((frames * 16000) / rate);
  if (!count) throw new UserError('The WAV is too short to transcribe.');
  const output = new Float32Array(count),
    ratio = rate / 16000;
  const sample = (frame: number) => {
    let value = 0;
    for (let channel = 0; channel < channels; channel++)
      value += data!.readInt16LE(frame * channels * 2 + channel * 2);
    return value / (channels * 32768);
  };
  for (let index = 0; index < count; index++) {
    if (rate >= 16000) {
      const start = index * ratio,
        end = Math.min(frames, (index + 1) * ratio);
      let sum = 0;
      for (let frame = Math.floor(start); frame < Math.ceil(end); frame++)
        sum += sample(frame) * (Math.min(end, frame + 1) - Math.max(start, frame));
      output[index] = sum / (end - start);
    } else {
      const source = index * ratio,
        left = Math.floor(source),
        right = Math.min(left + 1, frames - 1),
        fraction = source - left;
      output[index] = sample(left) * (1 - fraction) + sample(right) * fraction;
    }
  }
  return output;
}
export class LocalTranscriber {
  private worker?: LocalTranscriptionWorker;
  private ready = false;
  private closed = false;
  private failure?: UserError;
  private loading?: Promise<void>;
  private loaded?: () => void;
  private loadFailed?: (error: Error) => void;
  private loadTimer?: NodeJS.Timeout;
  private termination?: Promise<void>;
  private queue: Job[] = [];
  private active?: Job;
  private nextId = 0;
  private now: () => number;
  private timeout: number;
  private readonly model: string;
  constructor(private readonly options: LocalTranscriberOptions) {
    this.model = options.model || 'Xenova/whisper-tiny.en';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(this.model))
      throw new UserError('Use a fixed Hugging Face owner/model identifier for local transcription.');
    if (!options.cacheDir.trim())
      throw new UserError('Configure a local transcription model cache directory.');
    this.now = options.now ?? Date.now;
    this.timeout = Number.isFinite(options.timeoutMs)
      ? Math.max(1000, Math.min(60000, Math.floor(options.timeoutMs!)))
      : 60000;
  }
  prepare(): Promise<void> {
    if (this.closed) return Promise.reject(unavailable('detector is closed'));
    if (this.ready) return Promise.resolve();
    if (this.failure) return Promise.reject(this.failure);
    if (this.loading) return this.loading;
    this.loading = new Promise<void>((resolveReady, reject) => {
      this.loaded = () => {
        clearTimeout(this.loadTimer);
        this.ready = true;
        this.loaded = undefined;
        this.loadFailed = undefined;
        resolveReady();
        this.pump();
      };
      this.loadFailed = reject;
      this.loadTimer = setTimeout(() => this.fail(unavailable('model loading timed out')), this.timeout);
      try {
        const env: Record<string, string> = {
          HF_HUB_DISABLE_TELEMETRY: '1',
          DO_NOT_TRACK: '1',
          OMP_NUM_THREADS: '2',
          TOKENIZERS_PARALLELISM: 'false',
        };
        for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR'])
          if (process.env[key]) env[key] = process.env[key]!;
        const worker = (this.options.workerFactory ?? ((url, settings) => new Worker(url, settings)))(
          new URL(
            import.meta.url.endsWith('.ts')
              ? './local-transcriber-worker.ts'
              : './local-transcriber-worker.js',
            import.meta.url,
          ),
          {
            workerData: {
              model: this.model,
              cacheDir: resolve(this.options.cacheDir),
              allowDownload: this.options.allowDownload !== false,
            },
            env,
            resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
          },
        );
        this.worker = worker;
        worker.on('message', (value) => this.message(value));
        worker.on('error', () => this.fail(unavailable('worker failed')));
        worker.on('exit', () => {
          if (!this.closed && !this.failure) this.fail(unavailable('worker exited'));
        });
      } catch {
        this.fail(unavailable('worker could not start'));
      }
    });
    return this.loading;
  }
  transcribe(wav: Buffer, signal?: AbortSignal): Promise<string> {
    if (this.closed) return Promise.reject(unavailable('detector is closed'));
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(cancelled());
    // Admission precedes decoding/allocation, including while the model is still initializing.
    if (this.queue.length >= (this.active ? 4 : 5))
      return Promise.reject(
        new UserError('Local speech is busy. Finish the current utterance before trying again.'),
      );
    let audio: Float32Array;
    try {
      audio = decodeLocalTranscriptionWav(wav);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<string>((resolveText, reject) => {
      const job: Job = {
        id: ++this.nextId,
        at: this.now(),
        audio,
        signal,
        settled: false,
        resolve: resolveText,
        reject,
        abort: () => {
          if (job === this.active) {
            this.settle(job, cancelled());
            try {
              this.worker?.postMessage({ type: 'cancel', id: job.id });
            } catch {
              this.fail(unavailable('cancellation failed'));
            }
          } else {
            this.queue = this.queue.filter((item) => item !== job);
            this.settle(job, cancelled());
          }
        },
      };
      signal?.addEventListener('abort', job.abort, { once: true });
      if (signal?.aborted) {
        this.settle(job, cancelled());
        return;
      }
      this.queue.push(job);
      void this.prepare()
        .then(() => this.pump())
        .catch(() => {});
    });
  }
  private wipe(job: Job) {
    if (job.audio?.byteLength) job.audio.fill(0);
    job.audio = undefined;
  }
  private settle(job: Job, error?: Error, text = '') {
    this.wipe(job);
    if (job.settled) return;
    job.settled = true;
    job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error);
    else job.resolve(text);
  }
  private pump() {
    if (!this.ready || this.closed || this.active || this.failure) return;
    let job: Job | undefined;
    while ((job = this.queue.shift())) {
      if (job.signal?.aborted) {
        this.settle(job, cancelled());
        continue;
      }
      if (this.now() - job.at >= QUEUE_AGE) {
        this.settle(job, undefined, '');
        continue;
      }
      const current = job;
      this.active = current;
      current.timer = setTimeout(() => this.fail(unavailable('transcription timed out')), this.timeout);
      const audio = current.audio!;
      current.audio = undefined;
      try {
        this.worker!.postMessage({ type: 'transcribe', id: current.id, audio }, [
          audio.buffer as ArrayBuffer,
        ]);
      } catch {
        if (audio.byteLength) audio.fill(0);
        this.fail(unavailable('worker transfer failed'));
      }
      return;
    }
  }
  private message(value: unknown) {
    if (this.closed || this.failure || !value || typeof value !== 'object') return;
    const message = value as { type?: unknown; id?: unknown; text?: unknown };
    if (message.type === 'ready') {
      this.loaded?.();
      return;
    }
    if (message.type === 'fatal') {
      this.fail(unavailable('model could not load'));
      return;
    }
    const current = this.active;
    if (
      !current ||
      message.id !== current.id ||
      !['result', 'cancelled', 'error'].includes(String(message.type))
    )
      return;
    clearTimeout(current.timer);
    this.active = undefined;
    if (current.signal?.aborted || message.type === 'cancelled') this.settle(current, cancelled());
    else if (message.type === 'error')
      this.settle(current, unavailable('could not transcribe this utterance'));
    else if (typeof message.text !== 'string' || message.text.length > 6000)
      this.settle(current, unavailable('returned an invalid transcript'));
    else this.settle(current, undefined, filterTranscription(message.text));
    this.pump();
  }
  private fail(error: UserError) {
    if (this.failure || this.closed) return;
    this.failure = error;
    this.ready = false;
    clearTimeout(this.loadTimer);
    this.loadFailed?.(error);
    this.loaded = undefined;
    this.loadFailed = undefined;
    if (this.active) {
      clearTimeout(this.active.timer);
      this.settle(this.active, error);
      this.active = undefined;
    }
    for (const job of this.queue.splice(0)) this.settle(job, error);
    void this.terminateWorker();
  }
  private terminateWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (!worker) return this.termination ?? Promise.resolve();
    worker.removeAllListeners();
    worker.on('error', () => {});
    try {
      this.termination = Promise.resolve(worker.terminate()).then(
        () => {},
        () => {},
      );
    } catch {
      this.termination = Promise.resolve();
    }
    return this.termination;
  }
  async close(): Promise<void> {
    if (this.closed) return this.termination;
    this.closed = true;
    this.ready = false;
    clearTimeout(this.loadTimer);
    this.loadFailed?.(cancelled());
    this.loaded = undefined;
    this.loadFailed = undefined;
    if (this.active) {
      clearTimeout(this.active.timer);
      this.settle(this.active, cancelled());
      this.active = undefined;
    }
    for (const job of this.queue.splice(0)) this.settle(job, cancelled());
    await this.terminateWorker();
  }
}
export const createLocalTranscriber = (options: LocalTranscriberOptions) => new LocalTranscriber(options);
