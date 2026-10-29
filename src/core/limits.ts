import type { Store } from './store.js';
import { UserError } from './errors.js';
export class AiLimits {
  private active = 0;
  private readonly users = new Set<string>();
  constructor(
    private readonly store: Store,
    private readonly options: {
      maxAiConcurrent: number;
      maxAiRequestsPerUserDay: number;
      maxAiRequestsPerGuildDay: number;
    },
  ) {}
  enter(
    guildId: string,
    userId: string,
    now = Date.now(),
    allowance?: { userDaily?: number; guildDaily?: number },
  ): () => void {
    const user = `${guildId}:${userId}`;
    if (this.active >= this.options.maxAiConcurrent || this.users.has(user))
      throw new UserError('AI is busy. Wait for the current request to finish.');
    const day = new Date(now).toISOString().slice(0, 10);
    this.store.transaction(() => {
      for (const [scope, limit] of [
        [`user:${user}`, allowance?.userDaily ?? this.options.maxAiRequestsPerUserDay],
        [`guild:${guildId}`, allowance?.guildDaily ?? this.options.maxAiRequestsPerGuildDay],
      ] as const) {
        const count = Number(
          this.store.db.prepare('SELECT count FROM quota WHERE scope=? AND day=?').get(scope, day)?.count ??
            0,
        );
        if (count >= limit) throw new UserError('Daily AI request allowance reached (resets at 00:00 UTC).');
        this.store.db
          .prepare('INSERT INTO quota VALUES(?,?,1) ON CONFLICT(scope,day) DO UPDATE SET count=count+1')
          .run(scope, day);
      }
    });
    this.active++;
    this.users.add(user);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
        this.users.delete(user);
      }
    };
  }
}

export class Cooldowns {
  private readonly timestamps = new Map<string, number>();
  take(key: string, ms: number, now = Date.now()): boolean {
    const previous = this.timestamps.get(key);
    if (previous !== undefined && now < previous) return false;
    if (this.timestamps.size >= 10000)
      for (const [entry, expiresAt] of this.timestamps) if (expiresAt <= now) this.timestamps.delete(entry);
    if (this.timestamps.size >= 10000) return false;
    this.timestamps.set(key, now + ms);
    return true;
  }
}
