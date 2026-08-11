import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, lt } from 'drizzle-orm'
import {
  generateSecret as otpGenerateSecret,
  generateURI,
  verifySync,
} from 'otplib'
import { db } from '../db/index.js'
import {
  rateLimitBuckets,
  totpChallenges,
  totpReplaySteps,
} from '../db/schema.js'
import {
  checkDurableRateLimit,
  resetDurableRateLimitBucket,
} from './rate-limit.js'

const FIVE_MINUTES_MS = 5 * 60 * 1000
const TOTP_STEP_SECONDS = 30
function challengeHash(challenge: string): string {
  return createHash('sha256').update(challenge).digest('hex')
}

async function pruneExpiredChallenges(now = new Date()): Promise<void> {
  await db.delete(totpChallenges).where(lt(totpChallenges.expiresAt, now))
}

function currentTotpStep(now = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_STEP_SECONDS)
}

export function generateSecret(): string {
  return otpGenerateSecret()
}

function tokenIsValid(secret: string, token: string): boolean {
  const normalized = token.replace(/\s+/g, '')
  if (!normalized) return false
  try {
    return verifySync({ secret, token: normalized }).valid
  } catch {
    // Guardrails throw on malformed input (e.g. bad length); treat as invalid.
    return false
  }
}

export function verifyToken(secret: string, token: string): boolean {
  return tokenIsValid(secret, token)
}

export async function verifyTokenForUser(
  userId: string,
  secret: string,
  token: string,
): Promise<boolean> {
  if (!tokenIsValid(secret, token)) return false

  const step = currentTotpStep()
  await db
    .delete(totpReplaySteps)
    .where(lt(totpReplaySteps.acceptedAt, new Date(Date.now() - 24 * 60 * 60 * 1000)))
  const inserted = await db
    .insert(totpReplaySteps)
    .values({ userId, step })
    .onConflictDoNothing()
    .returning({ step: totpReplaySteps.step })
  return inserted.length === 1
}

export function buildOtpAuthUrl(params: { email: string; secret: string; issuer?: string }): string {
  const issuer = params.issuer?.trim() || 'Trovara OS'
  return generateURI({ issuer, label: params.email, secret: params.secret })
}

export async function createTotpChallenge(userId: string): Promise<string> {
  await pruneExpiredChallenges()
  const challenge = randomBytes(24).toString('base64url')
  await db.insert(totpChallenges).values({
    challengeHash: challengeHash(challenge),
    userId,
    expiresAt: new Date(Date.now() + FIVE_MINUTES_MS),
  })
  return challenge
}

export async function peekTotpChallenge(challenge: string): Promise<string | null> {
  await pruneExpiredChallenges()
  const [entry] = await db
    .select({ userId: totpChallenges.userId })
    .from(totpChallenges)
    .where(
      and(
        eq(totpChallenges.challengeHash, challengeHash(challenge)),
        gt(totpChallenges.expiresAt, new Date()),
      ),
    )
    .limit(1)
  return entry?.userId ?? null
}

export async function invalidateTotpChallenge(challenge: string): Promise<void> {
  await db
    .delete(totpChallenges)
    .where(eq(totpChallenges.challengeHash, challengeHash(challenge)))
}

export async function consumeTotpChallenge(challenge: string): Promise<string | null> {
  const [entry] = await db
    .delete(totpChallenges)
    .where(
      and(
        eq(totpChallenges.challengeHash, challengeHash(challenge)),
        gt(totpChallenges.expiresAt, new Date()),
      ),
    )
    .returning({ userId: totpChallenges.userId })
  return entry?.userId ?? null
}

const TOTP_FAILURE_WINDOW_MS = 15 * 60 * 1000
const TOTP_FAILURE_MAX = 5
function totpFailureKey(challenge: string, ip: string): string {
  return `totp-fail:${challengeHash(challenge)}:${ip}`
}

export async function checkTotpChallengeRateLimit(challenge: string, ip: string): Promise<{
  allowed: boolean
  retryAfterSec: number
}> {
  const [entry] = await db
    .select({
      attemptCount: rateLimitBuckets.attemptCount,
      expiresAt: rateLimitBuckets.expiresAt,
    })
    .from(rateLimitBuckets)
    .where(eq(rateLimitBuckets.rateKey, totpFailureKey(challenge, ip)))
    .limit(1)
  if (!entry || entry.expiresAt <= new Date() || entry.attemptCount < TOTP_FAILURE_MAX) {
    return { allowed: true, retryAfterSec: 0 }
  }
  return {
    allowed: false,
    retryAfterSec: Math.max(1, Math.ceil((entry.expiresAt.getTime() - Date.now()) / 1000)),
  }
}

export async function recordTotpChallengeFailure(
  challenge: string,
  ip: string,
): Promise<boolean> {
  const result = await checkDurableRateLimit(
    totpFailureKey(challenge, ip),
    TOTP_FAILURE_MAX - 1,
    TOTP_FAILURE_WINDOW_MS,
  )
  if (!result.allowed) {
    await invalidateTotpChallenge(challenge)
    return true
  }
  return false
}

export async function resetTotpChallengeRateLimit(challenge: string, ip: string): Promise<void> {
  await resetDurableRateLimitBucket(totpFailureKey(challenge, ip))
}

export async function resetTotpStateForTests(): Promise<void> {
  await db.delete(totpChallenges)
  await db.delete(totpReplaySteps)
}
