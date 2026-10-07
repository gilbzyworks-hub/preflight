// Central rate limiting + short-lived memoisation for outbound data-provider calls.

export class RateLimiter {
  private stamps: number[] = [];
  private max: number;
  private windowMs: number;
  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
      if (this.stamps.length < this.max) {
        this.stamps.push(now);
        return;
      }
      const wait = this.windowMs - (now - this.stamps[0]) + 5;
      await new Promise((r) => setTimeout(r, Math.min(wait, 5000)));
    }
  }
}

const cache = new Map<string, { at: number; value: Promise<unknown> }>();

/** Share in-flight/recent results for identical requests. Failures are not cached. */
export function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = fn().catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, { at: now, value });
  if (cache.size > 500) {
    for (const [k, v] of cache) if (now - v.at > ttlMs) cache.delete(k);
  }
  return value;
}

export async function getJson(url: string, limiter: RateLimiter, init?: RequestInit): Promise<unknown> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    await limiter.take();
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(9000) });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
