/**
 * Soft-remove a staff user who left: revoke access, wipe PII, keep the row
 * so task/audit FKs stay valid (NDPA-style erasure, not hard DELETE).
 */
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { sessions, users } from '../db/schema.js'
import { hashPassword } from './session.js'
import {
  sanitizeAnonymizedEmail,
  sanitizeAnonymizedName,
} from './tenant-scope.js'
import { revokeAllUserAccess } from './access-revoke.js'
import { randomBytes } from 'node:crypto'

export function isAnonymizedUserEmail(email: string): boolean {
  return /^anon@.+\.invalid$/i.test(email.trim())
}

export async function removeStaffUser(userId: string): Promise<void> {
  const anonymizedEmail = sanitizeAnonymizedEmail(userId)
  const unusableHash = await hashPassword(randomBytes(32).toString('hex'))

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        name: sanitizeAnonymizedName(),
        email: anonymizedEmail,
        phone: null,
        monthlyWageNgn: null,
        monthlyWageEffectiveFrom: null,
        monthlyWageConfirmedAt: null,
        monthlyWageConfirmedById: null,
        nextOfKinName: null,
        nextOfKinPhone: null,
        nextOfKinRelationship: null,
        employeeNumber: null,
        jobTitle: null,
        employmentType: null,
        employmentStartDate: null,
        employmentEndDate: null,
        employmentStatus: 'ended',
        active: false,
        totpSecret: null,
        totpEnabled: false,
        passwordHash: unusableHash,
        mustChangePassword: true,
        workerAlertsSubscribed: false,
        orderAlertsSubscribed: false,
      })
      .where(eq(users.id, userId))

    await tx.delete(sessions).where(eq(sessions.userId, userId))
  })

  await revokeAllUserAccess(userId)
}
