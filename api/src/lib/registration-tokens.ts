import { createHash, randomBytes } from 'node:crypto'
import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { db } from '../db/index.js'
import { registrationTokens, users } from '../db/schema.js'

/** Bytes of entropy per token (base64url ≈ 43 chars). */
const TOKEN_BYTES = 32
export const DEFAULT_TTL_HOURS = 24
export const MAX_TTL_HOURS = 24 * 30

export function hashRegistrationToken(raw: string): string {
  return createHash('sha256').update(raw.trim()).digest('hex')
}

export type GeneratedRegistrationToken = {
  id: string
  farmId: string
  token: string
  expiresAt: Date
}

export async function createRegistrationToken(params: {
  farmId: string
  createdByUserId?: string | null
  label?: string | null
  ttlHours?: number
}): Promise<GeneratedRegistrationToken> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  const requested = params.ttlHours && params.ttlHours > 0 ? params.ttlHours : DEFAULT_TTL_HOURS
  const ttlHours = Math.min(requested, MAX_TTL_HOURS)
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000)

  const [row] = await db
    .insert(registrationTokens)
    .values({
      farmId: params.farmId,
      tokenHash: hashRegistrationToken(token),
      label: params.label?.trim() || null,
      createdByUserId: params.createdByUserId ?? null,
      expiresAt,
    })
    .returning({ id: registrationTokens.id })

  return { id: row.id, farmId: params.farmId, token, expiresAt }
}

export type RegistrationTokenStatus = 'valid' | 'used' | 'expired' | 'revoked' | 'not_found'

/**
 * Pure status precedence for an existing token row: revoked → used → expired →
 * valid. Shared by the register flow and the owner-facing list.
 */
export function computeRegistrationTokenStatus(
  row: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date },
  now: Date = new Date(),
): Exclude<RegistrationTokenStatus, 'not_found'> {
  if (row.revokedAt) return 'revoked'
  if (row.usedAt) return 'used'
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired'
  return 'valid'
}

export type InspectResult =
  | { status: 'valid'; id: string; farmId: string }
  | { status: Exclude<RegistrationTokenStatus, 'valid'> }

/** Non-mutating validity check used to decide the registration flow. */
export async function inspectRegistrationToken(rawToken: string): Promise<InspectResult> {
  const [row] = await db
    .select()
    .from(registrationTokens)
    .where(eq(registrationTokens.tokenHash, hashRegistrationToken(rawToken)))
    .limit(1)

  if (!row) return { status: 'not_found' }
  const status = computeRegistrationTokenStatus(row)
  return status === 'valid' ? { status: 'valid', id: row.id, farmId: row.farmId } : { status }
}

/**
 * Atomically claim a token so exactly one concurrent request can win. The
 * `used_at IS NULL` guard means a second caller with the same token loses.
 * Returns false if the token was already claimed / expired / revoked.
 */
export async function claimRegistrationToken(
  tokenId: string,
): Promise<{ farmId: string } | null> {
  const now = new Date()
  const claimed = await db
    .update(registrationTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(registrationTokens.id, tokenId),
        isNull(registrationTokens.usedAt),
        isNull(registrationTokens.revokedAt),
        gt(registrationTokens.expiresAt, now),
      ),
    )
    .returning({ farmId: registrationTokens.farmId })
  return claimed[0] ?? null
}

/** Record which user consumed the token (after the account is created). */
export async function attachRegistrationTokenUser(
  tokenId: string,
  userId: string,
): Promise<void> {
  await db
    .update(registrationTokens)
    .set({ usedByUserId: userId })
    .where(eq(registrationTokens.id, tokenId))
}

/** Undo a claim if account creation fails after the token was claimed. */
export async function releaseRegistrationToken(tokenId: string): Promise<void> {
  await db
    .update(registrationTokens)
    .set({ usedAt: null, usedByUserId: null })
    .where(eq(registrationTokens.id, tokenId))
}

/** True when at least one token could still be used (enables registration). */
export async function hasActiveRegistrationTokens(): Promise<boolean> {
  const [row] = await db
    .select({ id: registrationTokens.id })
    .from(registrationTokens)
    .where(
      and(
        isNull(registrationTokens.usedAt),
        isNull(registrationTokens.revokedAt),
        gt(registrationTokens.expiresAt, new Date()),
      ),
    )
    .limit(1)
  return Boolean(row)
}

export type RegistrationTokenSummary = {
  id: string
  farmId: string
  label: string | null
  createdAt: string
  expiresAt: string
  usedAt: string | null
  usedByEmail: string | null
  revokedAt: string | null
  status: RegistrationTokenStatus
}

/** Owner-facing list (never exposes the raw token or its hash). */
export async function listRegistrationTokens(farmId: string): Promise<RegistrationTokenSummary[]> {
  const rows = await db
    .select({
      id: registrationTokens.id,
      farmId: registrationTokens.farmId,
      label: registrationTokens.label,
      createdAt: registrationTokens.createdAt,
      expiresAt: registrationTokens.expiresAt,
      usedAt: registrationTokens.usedAt,
      revokedAt: registrationTokens.revokedAt,
      usedByEmail: users.email,
    })
    .from(registrationTokens)
    .leftJoin(users, eq(registrationTokens.usedByUserId, users.id))
    .where(eq(registrationTokens.farmId, farmId))
    .orderBy(desc(registrationTokens.createdAt))
    .limit(200)

  return rows.map((row) => ({
    id: row.id,
    farmId: row.farmId,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    usedAt: row.usedAt ? row.usedAt.toISOString() : null,
    usedByEmail: row.usedByEmail ?? null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    status: computeRegistrationTokenStatus(row),
  }))
}

/** Revoke an unused token. Returns false if it does not exist. */
export async function revokeRegistrationToken(farmId: string, tokenId: string): Promise<boolean> {
  const revoked = await db
    .update(registrationTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(registrationTokens.id, tokenId),
        eq(registrationTokens.farmId, farmId),
        isNull(registrationTokens.usedAt),
      ),
    )
    .returning({ id: registrationTokens.id })
  return revoked.length > 0
}
