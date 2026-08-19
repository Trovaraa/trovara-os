import { createHash } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { loginRateLimits } from '../db/schema.js'

export const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000
export const LOGIN_RATE_MAX_ATTEMPTS = 5
export const SHOP_EMAIL_IP_MAX_ATTEMPTS = 10
export const SHOP_EMAIL_ADDR_MAX_ATTEMPTS = 10

/** sha256 hex of `scope + '\\0' + identity` — no raw IPs or emails in DB. */
export function hashedRateKey(scope: string, identity: string): string {
  return createHash('sha256').update(`${scope}\0${identity}`).digest('hex')
}

export function staffLoginRateKey(ip: string): string {
  return hashedRateKey('staff:login', ip.trim() || 'unknown')
}

export function shopLoginRateKey(ip: string): string {
  return hashedRateKey('shop:login', ip.trim() || 'unknown')
}

export function shopEmailIpRateKey(ip: string): string {
  return hashedRateKey('shop:email:ip', ip.trim() || 'unknown')
}

export function shopEmailAddrRateKey(email: string): string {
  return hashedRateKey('shop:email:addr', email.trim().toLowerCase())
}

/** Vault password reveal step-up (TOTP / break-glass) — per user. */
export const VAULT_REVEAL_MAX_ATTEMPTS = 5

export function vaultRevealRateKey(userId: string): string {
  return hashedRateKey('vault:reveal', userId.trim() || 'unknown')
}

/**
 * Atomically record an attempt for `rateKey`.
 * Returns false when the key has exhausted its window.
 * Counters live in Postgres so API restarts cannot clear a lockout.
 */
export async function checkDurableRateLimit(
  rateKey: string,
  maxAttempts = LOGIN_RATE_MAX_ATTEMPTS,
): Promise<boolean> {
  const key = rateKey.trim() || 'unknown'

  const [row] = await db
    .insert(loginRateLimits)
    .values({
      rateKey: key,
      attemptCount: 1,
      windowStartsAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: loginRateLimits.rateKey,
      set: {
        attemptCount: sql`CASE
          WHEN ${loginRateLimits.windowStartsAt} + interval '15 minutes' < now()
          THEN 1
          ELSE ${loginRateLimits.attemptCount} + 1
        END`,
        windowStartsAt: sql`CASE
          WHEN ${loginRateLimits.windowStartsAt} + interval '15 minutes' < now()
          THEN now()
          ELSE ${loginRateLimits.windowStartsAt}
        END`,
        updatedAt: sql`now()`,
      },
    })
    .returning({
      attemptCount: loginRateLimits.attemptCount,
    })

  return (row?.attemptCount ?? 1) <= maxAttempts
}

/** @deprecated Use {@link checkDurableRateLimit} with a namespaced key helper. */
export async function checkLoginRateLimit(rateKey: string): Promise<boolean> {
  return checkDurableRateLimit(rateKey, LOGIN_RATE_MAX_ATTEMPTS)
}

export async function resetDurableRateLimit(rateKey: string): Promise<void> {
  const key = rateKey.trim() || 'unknown'
  await db.delete(loginRateLimits).where(eq(loginRateLimits.rateKey, key))
}

/** @deprecated Use {@link resetDurableRateLimit}. */
export async function resetLoginRateLimit(rateKey: string): Promise<void> {
  return resetDurableRateLimit(rateKey)
}

/** Delete rows whose 15-minute window has expired. */
export async function purgeExpiredLoginRateLimits(): Promise<number> {
  const deleted = await db
    .delete(loginRateLimits)
    .where(sql`${loginRateLimits.windowStartsAt} + interval '15 minutes' < now()`)
    .returning({ rateKey: loginRateLimits.rateKey })
  return deleted.length
}
