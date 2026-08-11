import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { rateLimitBuckets } from '../db/schema.js'
import { eq } from 'drizzle-orm'

type Bucket = { count: number; resetAt: number }

const buckets = new Map<string, Bucket>()

/**
 * Simple in-memory fixed-window rate limiter. Single-node only (resets on
 * restart) - swap for a Redis-backed limiter if the API ever runs multi-instance.
 */
export function checkRateLimit(
  key: string,
  max: number,
  windowMs: number,
): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now()

  // Lazy sweep so the map stays bounded
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) {
      if (now > b.resetAt) buckets.delete(k)
    }
  }

  const bucket = buckets.get(key)
  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { allowed: true, retryAfterSec: 0 }
  }

  bucket.count += 1
  if (bucket.count > max) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) }
  }
  return { allowed: true, retryAfterSec: 0 }
}

export function resetRateLimitBucket(key?: string) {
  if (key) {
    buckets.delete(key)
    return
  }
  buckets.clear()
}

export type RateLimitResult = { allowed: boolean; retryAfterSec: number }

/**
 * PostgreSQL fixed-window limiter for public and cross-instance request limits.
 * The upsert is atomic, so concurrent API instances cannot overspend a bucket.
 *
 * Backed by rateLimitBuckets from the shared schema.
 */
export async function checkDurableRateLimit(
  key: string,
  max: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const bucketKey = key.trim() || 'unknown'
  const now = new Date()
  const expiresAt = new Date(now.getTime() + windowMs)
  const [row] = await db
    .insert(rateLimitBuckets)
    .values({
      rateKey: bucketKey,
      attemptCount: 1,
      windowStartsAt: now,
      expiresAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: rateLimitBuckets.rateKey,
      set: {
        attemptCount: sql`CASE
          WHEN ${rateLimitBuckets.expiresAt} <= now() THEN 1
          ELSE ${rateLimitBuckets.attemptCount} + 1
        END`,
        windowStartsAt: sql`CASE
          WHEN ${rateLimitBuckets.expiresAt} <= now() THEN now()
          ELSE ${rateLimitBuckets.windowStartsAt}
        END`,
        expiresAt: sql`CASE
          WHEN ${rateLimitBuckets.expiresAt} <= now()
          THEN now() + (${windowMs} * interval '1 millisecond')
          ELSE ${rateLimitBuckets.expiresAt}
        END`,
        updatedAt: sql`now()`,
      },
    })
    .returning({
      attemptCount: rateLimitBuckets.attemptCount,
      expiresAt: rateLimitBuckets.expiresAt,
    })
  const count = row?.attemptCount ?? 1
  return {
    allowed: count <= max,
    retryAfterSec:
      count <= max
        ? 0
        : Math.max(1, Math.ceil(((row?.expiresAt.getTime() ?? expiresAt.getTime()) - Date.now()) / 1000)),
  }
}

export async function resetDurableRateLimitBucket(key: string): Promise<void> {
  await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.rateKey, key))
}
