import { randomBytes } from 'node:crypto'
import {
  generateSecret as otpGenerateSecret,
  generateURI,
  verifySync,
} from 'otplib'

type TotpChallengeEntry = {
  userId: string
  expiresAt: number
}

const FIVE_MINUTES_MS = 5 * 60 * 1000
const TOTP_STEP_SECONDS = 30
const totpChallenges = new Map<string, TotpChallengeEntry>()
const lastAcceptedStep = new Map<string, number>()

function pruneExpiredChallenges(now = Date.now()): void {
  for (const [challenge, entry] of totpChallenges.entries()) {
    if (entry.expiresAt <= now) {
      totpChallenges.delete(challenge)
    }
  }
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

export function verifyTokenForUser(userId: string, secret: string, token: string): boolean {
  if (!tokenIsValid(secret, token)) return false

  const step = currentTotpStep()
  const last = lastAcceptedStep.get(userId)
  if (last !== undefined && step <= last) return false

  lastAcceptedStep.set(userId, step)
  return true
}

export function buildOtpAuthUrl(params: { email: string; secret: string; issuer?: string }): string {
  const issuer = params.issuer?.trim() || 'Trovara OS'
  return generateURI({ issuer, label: params.email, secret: params.secret })
}

export function createTotpChallenge(userId: string): string {
  pruneExpiredChallenges()
  const challenge = randomBytes(24).toString('base64url')
  totpChallenges.set(challenge, {
    userId,
    expiresAt: Date.now() + FIVE_MINUTES_MS,
  })
  return challenge
}

export function peekTotpChallenge(challenge: string): string | null {
  pruneExpiredChallenges()
  const entry = totpChallenges.get(challenge)
  if (!entry || entry.expiresAt <= Date.now()) return null
  return entry.userId
}

export function invalidateTotpChallenge(challenge: string): void {
  totpChallenges.delete(challenge)
}

export function consumeTotpChallenge(challenge: string): string | null {
  pruneExpiredChallenges()
  const entry = totpChallenges.get(challenge)
  if (!entry) return null
  totpChallenges.delete(challenge)
  if (entry.expiresAt <= Date.now()) return null
  return entry.userId
}

const TOTP_FAILURE_WINDOW_MS = 15 * 60 * 1000
const TOTP_FAILURE_MAX = 5
const totpFailures = new Map<string, { count: number; resetAt: number }>()

function totpFailureKey(challenge: string, ip: string): string {
  return `totp-fail:${challenge}:${ip}`
}

export function checkTotpChallengeRateLimit(challenge: string, ip: string): {
  allowed: boolean
  retryAfterSec: number
} {
  const now = Date.now()
  const entry = totpFailures.get(totpFailureKey(challenge, ip))
  if (!entry || now > entry.resetAt) {
    return { allowed: true, retryAfterSec: 0 }
  }
  if (entry.count >= TOTP_FAILURE_MAX) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    }
  }
  return { allowed: true, retryAfterSec: 0 }
}

export function recordTotpChallengeFailure(challenge: string, ip: string): boolean {
  const key = totpFailureKey(challenge, ip)
  const now = Date.now()
  let entry = totpFailures.get(key)
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + TOTP_FAILURE_WINDOW_MS }
    totpFailures.set(key, entry)
  }
  entry.count += 1
  if (entry.count >= TOTP_FAILURE_MAX) {
    invalidateTotpChallenge(challenge)
    return true
  }
  return false
}

export function resetTotpChallengeRateLimit(challenge: string, ip: string): void {
  totpFailures.delete(totpFailureKey(challenge, ip))
}

export function resetTotpStateForTests(): void {
  totpChallenges.clear()
  lastAcceptedStep.clear()
  totpFailures.clear()
}
