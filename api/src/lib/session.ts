import { randomBytes, createHash } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'
import { eq, and, gt, ne, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { sessions, users } from '../db/schema.js'
import type { UserRole } from '../db/schema.js'

const SESSION_COOKIE = 'trovara_session'
const SESSION_DAYS = 7
/** Emergency env break-glass sessions stay short so a static credential is not a week-long key. */
export const BREAK_GLASS_SESSION_TTL_MS = 60 * 60 * 1000

export { SESSION_COOKIE }

let dummyHashPromise: Promise<string> | null = null

/** Argon2 hash used for constant-time login when the user is unknown or inactive. */
export async function getDummyPasswordHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword('trovara-timing-mitigation-dummy-v1')
  }
  return dummyHashPromise
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, {
    memoryCost: 19456,
    timeCost: 2,
    outputLen: 32,
    parallelism: 1,
  })
}

export async function verifyPassword(hashStr: string, password: string): Promise<boolean> {
  return verify(hashStr, password)
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function hashOpaqueToken(token: string): string {
  return hashToken(token)
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex')
}

/**
 * True when this user has prior sessions and none used this IP hash.
 * First-ever login is not treated as unusual.
 */
export async function isUnusualLoginIp(
  userId: string,
  ipHash: string | undefined,
): Promise<boolean> {
  if (!ipHash) return false
  const prior = await db
    .select({ ipHash: sessions.ipHash })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .limit(100)
  if (prior.length === 0) return false
  return !prior.some((row) => row.ipHash === ipHash)
}

export type CreateSessionOptions = {
  userAgent?: string
  ipHash?: string
  /** Override default 7-day lifetime (e.g. break-glass emergency sessions). */
  ttlMs?: number
}

export async function createSession(userId: string, options: CreateSessionOptions = {}): Promise<string> {
  const token = generateSessionToken()
  const ttlMs = options.ttlMs ?? SESSION_DAYS * 24 * 60 * 60 * 1000
  const expiresAt = new Date(Date.now() + ttlMs)
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    userAgent: options.userAgent,
    ipHash: options.ipHash,
  })
  return token
}

export async function deleteSession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)))
}

export async function revokeOtherSessions(
  userId: string,
  currentToken: string | undefined,
): Promise<number> {
  const now = new Date()
  if (!currentToken) {
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(sessions)
      .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now)))
    await db.delete(sessions).where(eq(sessions.userId, userId))
    return Number(total ?? 0)
  }

  const currentHash = hashToken(currentToken)
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(sessions)
    .where(
      and(eq(sessions.userId, userId), ne(sessions.tokenHash, currentHash), gt(sessions.expiresAt, now)),
    )

  await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.tokenHash, currentHash)))

  return Number(total ?? 0)
}

export async function countActiveSessions(userId: string): Promise<number> {
  const now = new Date()
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now)))
  return Number(row?.total ?? 0)
}

export type SessionListItem = {
  id: string
  createdAt: Date
  expiresAt: Date
  userAgent: string | null
  current: boolean
}

export async function listActiveSessions(
  userId: string,
  currentToken?: string,
): Promise<SessionListItem[]> {
  const now = new Date()
  const currentHash = currentToken ? hashToken(currentToken) : null
  const rows = await db
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
      userAgent: sessions.userAgent,
      tokenHash: sessions.tokenHash,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now)))
    .orderBy(sql`${sessions.createdAt} desc`)

  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    userAgent: r.userAgent,
    current: currentHash !== null && r.tokenHash === currentHash,
  }))
}

export async function revokeSessionById(
  userId: string,
  sessionId: string,
  currentToken?: string,
): Promise<'ok' | 'not_found' | 'current'> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .limit(1)
  if (!row) return 'not_found'
  if (currentToken && row.tokenHash === hashToken(currentToken)) return 'current'
  await db.delete(sessions).where(eq(sessions.id, sessionId))
  return 'ok'
}

export type SessionUser = {
  id: string
  farmId: string
  email: string
  name: string
  role: UserRole
  farmRoleId?: string | null
  /** Effective permission keys for this request (owner has all). */
  permissions?: string[]
  mustChangePassword?: boolean
  totpEnabled?: boolean
  butlerTtsMode?: 'off' | 'voice_replies' | 'always'
}

export async function getUserFromSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null
  const tokenHash = hashToken(token)
  const now = new Date()
  const rows = await db
    .select({
      id: users.id,
      farmId: users.farmId,
      email: users.email,
      name: users.name,
      role: users.role,
      farmRoleId: users.farmRoleId,
      mustChangePassword: users.mustChangePassword,
      totpEnabled: users.totpEnabled,
      butlerTtsMode: users.butlerTtsMode,
      active: users.active,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .limit(1)

  const row = rows[0]
  if (!row || !row.active) return null
  return {
    id: row.id,
    farmId: row.farmId,
    email: row.email,
    name: row.name,
    role: row.role,
    farmRoleId: row.farmRoleId,
    mustChangePassword: row.mustChangePassword,
    totpEnabled: row.totpEnabled,
    butlerTtsMode: row.butlerTtsMode,
  }
}

export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'Strict' as const,
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  }
}
