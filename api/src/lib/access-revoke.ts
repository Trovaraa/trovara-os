/**
 * Atomic-ish access revocation when a user is deactivated or their password
 * is admin-reset: kill web sessions, Telegram links, and pending task drafts.
 */
import { revokeOtherSessions } from './session.js'
import { revokeTelegramLink } from './butler-link-codes.js'
import { clearTaskDraftsForUser } from './task-drafts.js'

export async function revokeAllUserAccess(userId: string): Promise<{
  sessions: number
}> {
  const sessions = await revokeOtherSessions(userId, undefined)
  await revokeTelegramLink(userId)
  try {
    await clearTaskDraftsForUser(userId)
  } catch {
    // Ignore draft cleanup failures during revoke.
  }
  return { sessions }
}
