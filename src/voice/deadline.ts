import { UserError } from '../core/errors.js';

/** Bound an adapter stage even when an SDK queue does not observe cancellation. */
export async function voiceDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs: number; message: string },
): Promise<T> {
  const controller = new AbortController(),
    signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
    timer = setTimeout(() => controller.abort(new UserError(options.message)), options.timeoutMs);
  timer.unref();
  let abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return operation(signal);
      }),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener('abort', abort);
  }
}
