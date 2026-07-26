/**
 * Re-asking workers to pick their Butler language.
 *
 * A worker who never answers the prompt sits on the `preferred_locale` default,
 * and every free-text thing they send is then stored under a language guessed
 * from the text rather than one they stated. The guess is weak on operational
 * prose, so the canonical-English guarantee is materially better for workers who
 * have answered — hence asking again rather than asking once and giving up.
 *
 * Capped at one ask a day: the prompt interrupts someone who may be reporting a
 * dead bird, so it should be easy to ignore and impossible to hit twice in a row.
 */
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'

export const LANGUAGE_PROMPT_INTERVAL_MS = 24 * 60 * 60 * 1000

export type LanguagePromptState = {
  preferredLocaleSetAt?: Date | null
  preferredLocalePromptedAt?: Date | null
}

/** Whether to re-ask this worker now. Answered workers are never asked again. */
export function shouldPromptLanguage(user: LanguagePromptState, now: Date = new Date()): boolean {
  if (user.preferredLocaleSetAt) return false
  const last = user.preferredLocalePromptedAt
  if (!last) return true
  return now.getTime() - last.getTime() >= LANGUAGE_PROMPT_INTERVAL_MS
}

/**
 * Record that we asked. Called after the prompt is sent rather than before, so a
 * send that fails is retried tomorrow instead of being silently skipped.
 *
 * Never throws: failing to record this must not fail the worker's message.
 */
export async function markLanguagePrompted(userId: string, now: Date = new Date()): Promise<void> {
  try {
    await db.update(users).set({ preferredLocalePromptedAt: now }).where(eq(users.id, userId))
  } catch {
    // Worst case we ask again sooner than intended.
  }
}
