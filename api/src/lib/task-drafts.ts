import { randomBytes } from 'node:crypto'

export type TaskDraftFields = {
  title: string
  description?: string
  plotId?: string
  assignedToId?: string
}

type StoredTaskDraft = TaskDraftFields & {
  userId: string
  farmId: string
  expiresAt: number
}

const DRAFT_TTL_MS = 10 * 60 * 1000
const drafts = new Map<string, StoredTaskDraft>()

function sweepExpired(now = Date.now()): void {
  if (drafts.size <= 500) return
  for (const [id, draft] of drafts) {
    if (draft.expiresAt <= now) drafts.delete(id)
  }
}

export function storeTaskDraft(
  userId: string,
  farmId: string,
  fields: TaskDraftFields,
): { draftId: string; draft: TaskDraftFields; expiresAt: number } {
  sweepExpired()
  const draftId = randomBytes(32).toString('base64url')
  const expiresAt = Date.now() + DRAFT_TTL_MS
  drafts.set(draftId, { ...fields, userId, farmId, expiresAt })
  return { draftId, draft: fields, expiresAt }
}

export function takeTaskDraft(draftId: string, userId: string): StoredTaskDraft | null {
  const draft = drafts.get(draftId)
  if (!draft) return null
  drafts.delete(draftId)
  if (draft.expiresAt <= Date.now()) return null
  if (draft.userId !== userId) return null
  return draft
}
