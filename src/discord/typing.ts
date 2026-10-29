/** Discord's typing state expires after ten seconds. Keep it fresh only while an addressed reply is pending. */
export async function withTyping<T>(channel: unknown, operation: () => Promise<T>): Promise<T> {
  const target = channel as { sendTyping?: () => Promise<unknown> } | undefined | null;
  if (typeof target?.sendTyping !== 'function') return operation();
  const typing = target.sendTyping.bind(target);
  let active = true,
    pending: Promise<unknown> | undefined;
  const send = () => {
    if (!active || pending) return;
    try {
      pending = Promise.resolve(typing())
        .catch(() => undefined)
        .finally(() => {
          pending = undefined;
        });
    } catch {
      /* Typing feedback is best effort and must never prevent the actual reply. */
    }
  };
  send();
  const timer = setInterval(send, 8000);
  timer.unref?.();
  try {
    return await operation();
  } finally {
    active = false;
    clearInterval(timer);
  }
}
