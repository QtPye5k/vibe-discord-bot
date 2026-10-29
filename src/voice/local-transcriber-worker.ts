import { parentPort, workerData } from 'node:worker_threads';
import { pipeline, env } from '@huggingface/transformers';
import { filterTranscription } from './transcript-filter.js';

interface Settings {
  model: string;
  cacheDir: string;
  allowDownload: boolean;
}
export async function inferLocalTranscript(
  recognize: (
    audio: Float32Array,
    options: { max_new_tokens: number; chunk_length_s: number; return_timestamps: false },
  ) => Promise<unknown>,
  audio: Float32Array,
  isCancelled: () => boolean,
): Promise<{ type: 'result' | 'cancelled' | 'error'; text?: string }> {
  try {
    const result = await recognize(audio, {
      max_new_tokens: 128,
      chunk_length_s: 30,
      return_timestamps: false,
    });
    const selected = Array.isArray(result) ? result[0] : result,
      text = selected && typeof selected === 'object' ? (selected as { text?: unknown }).text : undefined;
    if (isCancelled()) return { type: 'cancelled' };
    return typeof text === 'string' && text.length <= 6000
      ? { type: 'result', text: filterTranscription(text) }
      : { type: 'error' };
  } catch {
    return { type: isCancelled() ? 'cancelled' : 'error' };
  } finally {
    audio.fill(0);
  }
}
if (parentPort) {
  const settings = workerData as Settings,
    port = parentPort;
  env.cacheDir = settings.cacheDir;
  env.allowLocalModels = true;
  env.localModelPath = settings.cacheDir;
  env.allowRemoteModels = settings.allowDownload;
  if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 2;
  const cancelled = new Set<number>();
  let busy = false,
    activeId: number | undefined;
  try {
    const recognizer = await pipeline('automatic-speech-recognition', settings.model, {
      dtype: 'q8',
      device: 'cpu',
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1, logSeverityLevel: 3 },
    });
    port.on('message', async (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const message = value as { type?: unknown; id?: unknown; audio?: unknown };
      if (!Number.isSafeInteger(message.id)) return;
      const id = message.id as number;
      if (message.type === 'cancel') {
        if (activeId === id) cancelled.add(id);
        return;
      }
      if (message.type !== 'transcribe' || !(message.audio instanceof Float32Array)) return;
      const audio = message.audio;
      if (busy || audio.length < 1 || audio.length > 240000) {
        audio.fill(0);
        port.postMessage({ type: 'error', id });
        return;
      }
      busy = true;
      activeId = id;
      try {
        const result = await inferLocalTranscript(
          (data, options) => recognizer(data, options),
          audio,
          () => cancelled.has(id),
        );
        port.postMessage({ ...result, id });
      } catch {
        port.postMessage({ type: cancelled.has(id) ? 'cancelled' : 'error', id });
      } finally {
        audio.fill(0);
        cancelled.delete(id);
        busy = false;
        activeId = undefined;
      }
    });
    port.postMessage({ type: 'ready' });
  } catch {
    port.postMessage({ type: 'fatal' });
  }
}
