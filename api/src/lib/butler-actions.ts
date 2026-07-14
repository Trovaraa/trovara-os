export type TaskDraft = {
  title: string
  description?: string
}

/**
 * Parse a user utterance into a lightweight task draft.
 * Examples:
 * - "create task spray maize plot this evening"
 * - "add task: fix broken water line in pen B"
 */
export function parseTaskDraft(text: string): TaskDraft | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const match = trimmed.match(
    /\b(create|add|new)\s+task\b[:\s-]*(?<title>.+)$/i,
  )
  const rawTitle = match?.groups?.title?.trim() ?? ''
  if (!rawTitle) return null

  const title = rawTitle
    .replace(/^to\s+/i, '')
    .replace(/[.。]+$/, '')
    .trim()
  if (!title) return null

  return { title }
}
