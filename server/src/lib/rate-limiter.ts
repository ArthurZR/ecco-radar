/** Simple per-key token bucket. Used to keep each source under its documented request rate. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Returns how many ms the caller must wait before a token is available (0 = go now) and takes it. */
  reserve(key: string, perMinute: number): number {
    const capacity = Math.max(1, Math.ceil(perMinute / 6)); // allow short bursts of ~10s worth
    const refillPerMs = perMinute / 60000;
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: capacity, updated: t };
    b.tokens = Math.min(capacity, b.tokens + (t - b.updated) * refillPerMs);
    b.updated = t;
    b.tokens -= 1;
    this.buckets.set(key, b);
    return b.tokens >= 0 ? 0 : Math.ceil(-b.tokens / refillPerMs);
  }

  async acquire(key: string, perMinute: number): Promise<void> {
    const wait = this.reserve(key, perMinute);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

export const sharedRateLimiter = new RateLimiter();
