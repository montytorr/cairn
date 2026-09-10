/**
 * Per-key token bucket, held in process memory.
 *
 * Cairn runs as a single container, so an in-memory bucket is the honest
 * choice — a Redis-backed limiter would add a dependency to solve a problem
 * this deployment does not have. If it ever runs more than one replica this
 * becomes per-replica, which is the point at which to move it.
 */
type Bucket = { tokens: number; updatedAt: number }

const BUCKETS = new Map<string, Bucket>()

const CAPACITY = 120 // burst
const REFILL_PER_SECOND = 2 // sustained: 120/min

export type RateLimitResult = { allowed: boolean; remaining: number; retryAfter: number }

export const checkRateLimit = (identity: string): RateLimitResult => {
  const now = Date.now()
  const bucket = BUCKETS.get(identity) ?? { tokens: CAPACITY, updatedAt: now }

  const elapsedSeconds = (now - bucket.updatedAt) / 1000
  const tokens = Math.min(CAPACITY, bucket.tokens + elapsedSeconds * REFILL_PER_SECOND)

  if (tokens < 1) {
    BUCKETS.set(identity, { tokens, updatedAt: now })
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((1 - tokens) / REFILL_PER_SECOND) }
  }

  BUCKETS.set(identity, { tokens: tokens - 1, updatedAt: now })
  return { allowed: true, remaining: Math.floor(tokens - 1), retryAfter: 0 }
}
