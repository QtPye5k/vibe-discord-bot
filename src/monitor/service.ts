import { randomBytes } from 'node:crypto';
export interface MonitorTransition {
  id: string;
  event: 'down' | 'recovered';
  at: number;
  attempts: number;
  coalescedTransitions?: number;
}
export interface MonitorState {
  up: boolean | undefined;
  failures: number;
  successes: number;
  lastNotification?: 'down' | 'recovered';
  changedAt?: number;
  pending?: MonitorTransition[];
  overflow?: { count: number; event: 'down' | 'recovered'; at: number };
}
export interface MonitorDelivery {
  id: string;
  coalescedTransitions: number;
}
const CAPACITY = 32;
/** Runs independently of the Gateway process. A different host is needed to observe host outages.
 * Notifications are at-least-once: ambiguous remote acceptance may duplicate a later retry. */
export function createUptimeMonitor(options: {
  target: string;
  notify: (event: 'down' | 'recovered', at: number, delivery: MonitorDelivery) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  initial?: MonitorState;
  persist?: (state: MonitorState) => void;
}) {
  const target = new URL(options.target);
  if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.hash)
    throw new Error('Use a configured HTTP(S) readiness URL without credentials.');
  const state: MonitorState = {
      ...{ up: undefined, failures: 0, successes: 0 },
      ...options.initial,
      pending: (options.initial?.pending ?? []).map((row) => ({ ...row })),
    },
    now = options.now ?? Date.now;
  if (options.initial?.overflow) state.overflow = { ...options.initial.overflow };
  const snapshot = (): MonitorState => ({
    ...state,
    pending: state.pending!.map((row) => ({ ...row })),
    ...(state.overflow ? { overflow: { ...state.overflow } } : {}),
  });
  const persist = () => options.persist?.(snapshot());
  if (state.pending!.length > CAPACITY) {
    const extra = state.pending!.splice(CAPACITY),
      last = extra.at(-1)!;
    state.overflow = {
      count: Math.min(Number.MAX_SAFE_INTEGER, (state.overflow?.count ?? 0) + extra.length),
      event: last.event,
      at: last.at,
    };
  }
  let running = false;
  function enqueue(event: 'down' | 'recovered', at: number) {
    if (state.pending!.length < CAPACITY && !state.overflow)
      state.pending!.push({ id: randomBytes(12).toString('hex'), event, at, attempts: 0 });
    else
      state.overflow = {
        count: Math.min(Number.MAX_SAFE_INTEGER, (state.overflow?.count ?? 0) + 1),
        event,
        at,
      };
  }
  async function flush() {
    for (let delivered = 0; delivered < 8 && state.pending!.length; delivered++) {
      const transition = state.pending![0]!;
      transition.attempts = Math.min(2147483647, transition.attempts + 1);
      persist();
      await options.notify(transition.event, transition.at, {
        id: transition.id,
        coalescedTransitions: transition.coalescedTransitions ?? 1,
      });
      const before = snapshot();
      state.pending!.shift();
      state.lastNotification = transition.event;
      if (state.overflow && state.pending!.length < CAPACITY) {
        const overflow = state.overflow;
        state.pending!.push({
          id: randomBytes(12).toString('hex'),
          event: overflow.event,
          at: overflow.at,
          attempts: 0,
          coalescedTransitions: overflow.count,
        });
        delete state.overflow;
      }
      try {
        persist();
      } catch (error) {
        delete state.lastNotification;
        delete state.overflow;
        Object.assign(state, before);
        throw error;
      }
    }
  }
  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      let healthy = false;
      try {
        const response = await (options.fetch ?? fetch)(target, {
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
          headers: { 'User-Agent': 'Discord-Unified-Bot-Monitor/2.0' },
        });
        healthy = response.ok;
        await response.body?.cancel();
      } catch {
        /* Failed requests are observations, not process failures. */
      }
      state.failures = healthy ? 0 : Math.min(3, state.failures + 1);
      state.successes = healthy ? Math.min(2, state.successes + 1) : 0;
      const changed =
        healthy && state.successes >= 2 && state.up === false
          ? 'recovered'
          : !healthy && state.failures >= 3 && state.up !== false
            ? 'down'
            : undefined;
      if (state.up === undefined && healthy && state.successes >= 2) state.up = true;
      if (changed) {
        state.up = changed === 'recovered';
        state.changedAt = now();
        enqueue(changed, state.changedAt);
      }
      persist();
      await flush();
    } finally {
      running = false;
    }
  }
  return { tick, state: snapshot };
}
