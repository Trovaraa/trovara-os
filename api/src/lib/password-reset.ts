import { and, eq, gt, isNull } from 'drizzle-orm'
import { db } from '../db/index.js'
import { passwordResetTokens, users } from '../db/schema.js'

export async function resetStaffPasswordWithToken(input: {
  tokenHash: string
  passwordHash: string
  now?: Date
}): Promise<{ userId: string; farmId: string } | null> {
  const now = input.now ?? new Date()
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(passwordResetTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, input.tokenHash),
          gt(passwordResetTokens.expiresAt, now),
          isNull(passwordResetTokens.usedAt),
        ),
      )
      .returning({ userId: passwordResetTokens.userId })
    if (!claimed) return null

    const [updatedUser] = await tx
      .update(users)
      .set({
        passwordHash: input.passwordHash,
        mustChangePassword: false,
      })
      .where(eq(users.id, claimed.userId))
      .returning({ farmId: users.farmId })
    if (!updatedUser) throw new Error('RESET_USER_NOT_FOUND')

    return { userId: claimed.userId, farmId: updatedUser.farmId }
  })
}
