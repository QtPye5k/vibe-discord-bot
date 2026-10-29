import type { Store } from '../core/store.js';
export interface ApiMetric {
  provider: string;
  endpoint: string;
  day: string;
  requests: number;
  errors: number;
  durationMs: number;
  maximumMs: number;
}
/** Bounded aggregate diagnostics only: never store URLs, request/response bodies or credentials. */
export function recordApiMetric(
  store: Store,
  guildId: string,
  provider: string,
  endpoint: string,
  success: boolean,
  durationMs: number,
  now = Date.now(),
): void {
  if (!/^[a-z0-9._-]{1,60}$/.test(provider) || !/^[a-z0-9._-]{1,60}$/.test(endpoint)) return;
  const day = new Date(now).toISOString().slice(0, 10),
    key = `${guildId}:${day}:${provider}:${endpoint}`;
  const previous = store.get<ApiMetric>('api.metrics', key);
  const elapsed = Math.max(0, Math.min(300000, Number.isFinite(durationMs) ? durationMs : 0));
  if (!previous && store.list('api.metrics', `${guildId}:`).length >= 2000) return;
  store.set('api.metrics', key, {
    provider,
    endpoint,
    day,
    requests: (previous?.requests ?? 0) + 1,
    errors: (previous?.errors ?? 0) + (success ? 0 : 1),
    durationMs: (previous?.durationMs ?? 0) + elapsed,
    maximumMs: Math.max(previous?.maximumMs ?? 0, elapsed),
  } satisfies ApiMetric);
  const cutoff = new Date(now - 90 * 86400000).toISOString().slice(0, 10);
  for (const row of store.list<ApiMetric>('api.metrics', `${guildId}:`))
    if (row.value.day < cutoff) store.delete('api.metrics', row.key);
}
