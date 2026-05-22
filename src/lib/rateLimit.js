/**
 * In-process sliding-window rate limiter for express handlers.
 *
 * Why sliding window over fixed window: fixed-window allows a ~2x burst at
 * window boundaries (last tick of window N + first tick of window N+1).
 * Sliding-window is a constant rate by definition. The implementation tracks
 * a list of recent request timestamps per key and prunes lazily on each
 * check; linear in window size, fine for small caps (~10s).
 *
 * Single-process state: each wrapper container has its own buckets. That is
 * acceptable here because every wrapper is single-tenant — one Railway
 * service = one agent — so the limiter's job is to cap one attacker's burst
 * against one service, not to enforce a global ceiling. Multi-replica
 * scaling would need a shared store (Redis); not relevant today.
 *
 * On exhaustion: responds with 429 and a `Retry-After` header (seconds until
 * the oldest in-window entry expires). The body is a JSON
 * `{ error, retryAfterSeconds }` shape to match the rest of /setup/api/*.
 */

/**
 * Create an express middleware that rate-limits requests per key.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowMs=60000] - sliding window length in ms.
 * @param {number} [opts.max=10] - max requests allowed per key per window.
 * @param {(req: import("express").Request) => string} [opts.keyFn] -
 *   key extractor; defaults to source IP (req.ip → socket.remoteAddress).
 * @param {() => number} [opts.now] - clock; defaults to Date.now (override
 *   in tests for deterministic window sliding).
 * @returns {import("express").RequestHandler}
 */
export function createIpRateLimiter(opts = {}) {
  const windowMs = opts.windowMs ?? 60_000;
  const max = opts.max ?? 10;
  const keyFn =
    opts.keyFn ??
    ((req) => req.ip || req.socket?.remoteAddress || "unknown");
  const now = opts.now ?? Date.now;
  const buckets = new Map();

  return function rateLimitMiddleware(req, res, next) {
    const key = keyFn(req);
    const t = now();
    const cutoff = t - windowMs;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }

    // Prune expired entries from the front. Linear scan, but bucket length
    // is bounded by `max` in steady state so this is effectively O(1).
    while (bucket.length > 0 && bucket[0] < cutoff) bucket.shift();

    if (bucket.length >= max) {
      const oldest = bucket[0];
      const retryAfterMs = Math.max(0, oldest + windowMs - t);
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);
      res.set("Retry-After", String(retryAfterSec));
      return res.status(429).json({
        error: "rate limit exceeded",
        retryAfterSeconds: retryAfterSec,
      });
    }

    bucket.push(t);
    next();
  };
}
