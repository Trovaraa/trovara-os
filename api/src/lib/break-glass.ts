import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farms, users } from '../db/schema.js'
import { hashPassword } from './session.js'
import {
  getBreakGlassEmail,
  getBreakGlassPasswordFromEnv,
} from './registration.js'

export type EnsureBreakGlassResult = 'created' | 'exists' | 'skipped'

/**
 * Clean go-live skips seed, so the break-glass owner row never exists unless we
 * create it. Call on API boot and before break-glass login when the email is missing.
 */
export async function ensureBreakGlassOwner(): Promise<EnsureBreakGlassResult> {
  if (!getBreakGlassPasswordFromEnv()) {
    return 'skipped'
  }

  const email = getBreakGlassEmail()
  const [existing] = await db
    .select({ id: users.id, active: users.active })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)

  if (existing) {
    if (!existing.active) {
      await db.update(users).set({ active: true }).where(eq(users.id, existing.id))
    }
    return 'exists'
  }

  let farmId = process.env.CRON_FARM_ID?.trim() || null
  if (farmId) {
    const [farm] = await db.select({ id: farms.id }).from(farms).where(eq(farms.id, farmId)).limit(1)
    if (!farm) farmId = null
  }
  if (!farmId) {
    const [farm] = await db.select({ id: farms.id }).from(farms).limit(1)
    farmId = farm?.id ?? null
  }
  if (!farmId) {
    return 'skipped'
  }

  const passwordHash = await hashPassword(randomBytes(32).toString('base64url'))
  await db.insert(users).values({
    farmId,
    email,
    name: 'Break-glass Admin',
    passwordHash,
    role: 'owner',
    mustChangePassword: false,
    active: true,
    jobTitle: 'Admin',
  })

  return 'created'
}
