import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { livestockBatches, livestockLogs } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { logAudit } from './audit.js'
import { storeActionDraft } from './task-drafts.js'

export { parseLivestockLogIntent } from './action-draft-livestock-log-parse.js'

export async function resolveLivestockBatchByName(
  farmId: string,
  query: string,
): Promise<{ id: string; name: string; headCount: number; active: boolean } | null> {
  const batches = await db
    .select({
      id: livestockBatches.id,
      name: livestockBatches.name,
      headCount: livestockBatches.headCount,
      active: livestockBatches.active,
    })
    .from(livestockBatches)
    .where(eq(livestockBatches.farmId, farmId))

  const q = query.toLowerCase()
  return batches.find((b) => b.name.toLowerCase() === q) ?? null
}

export async function executeConfirmedLivestockLog(
  user: SessionUser,
  payload: Record<string, unknown>,
  source = 'butler',
): Promise<string> {
  const batchId = String(payload.batchId ?? '')
  const logType = String(payload.logType ?? '') as
    | 'feeding'
    | 'vaccination'
    | 'mortality'
    | 'incident'
    | 'health_check'
  const notes = typeof payload.notes === 'string' ? payload.notes : undefined
  const headCount =
    payload.headCount != null && Number.isFinite(Number(payload.headCount))
      ? Number(payload.headCount)
      : undefined

  if (!batchId || !logType) return 'Draft was missing livestock log fields.'

  const [batch] = await db
    .select()
    .from(livestockBatches)
    .where(and(eq(livestockBatches.id, batchId), eq(livestockBatches.farmId, user.farmId)))
    .limit(1)

  if (!batch) return 'Batch no longer found.'
  if (!batch.active) return 'Batch is inactive.'

  if (logType === 'mortality') {
    if (headCount == null || headCount < 1) return 'headCount required for mortality.'
    if (headCount > batch.headCount) return 'Mortality count exceeds batch head count.'
  }

  const log = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(livestockLogs)
      .values({
        farmId: user.farmId,
        batchId,
        logType,
        headCount,
        notes,
        recordedById: user.id,
      })
      .returning()

    if (logType === 'mortality' && headCount) {
      await tx
        .update(livestockBatches)
        .set({ headCount: batch.headCount - headCount })
        .where(eq(livestockBatches.id, batchId))
    }

    return row
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'livestock_log',
    entityId: log.id,
    metadata: { logType, batchId, source },
  })

  const batchLabel = String(payload.batchName ?? batch.name)
  if (logType === 'mortality') {
    return `✅ Mortality logged for ${batchLabel}: ${headCount} head.`
  }
  return `✅ ${logType} logged for ${batchLabel}.`
}

export async function prepareLivestockLogDraft(params: {
  user: SessionUser
  logType: 'feeding' | 'vaccination' | 'mortality'
  batchQuery: string
  headCount?: number
  notes?: string
  channel: string
  externalChatId: string
}): Promise<{ ok: true; preview: string; draftId: string } | { ok: false; error: string }> {
  const batch = await resolveLivestockBatchByName(params.user.farmId, params.batchQuery)
  if (!batch) {
    return {
      ok: false,
      error: `Batch "${params.batchQuery}" not found. Use the exact livestock batch name.`,
    }
  }
  if (!batch.active) {
    return { ok: false, error: `Batch "${batch.name}" is inactive.` }
  }

  if (params.logType === 'mortality') {
    if (params.headCount == null || params.headCount < 1) {
      return { ok: false, error: 'Mortality requires heads=<n>.' }
    }
    if (params.headCount > batch.headCount) {
      return {
        ok: false,
        error: `Mortality count exceeds batch head count (${batch.headCount}).`,
      }
    }
  }

  const stored = await storeActionDraft({
    userId: params.user.id,
    farmId: params.user.farmId,
    actionType: 'livestock_log',
    payload: {
      batchId: batch.id,
      batchName: batch.name,
      logType: params.logType,
      headCount: params.headCount ?? null,
      notes: params.notes ?? null,
    },
    channel: params.channel,
    externalChatId: params.externalChatId,
  })

  return {
    ok: true,
    draftId: stored.id,
    preview: [
      'Draft livestock log ready:',
      `Batch: ${batch.name}`,
      `Type: ${params.logType}`,
      params.headCount != null ? `Heads: ${params.headCount}` : null,
      params.notes ? `Notes: ${params.notes}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

/** Apply a confirmed livestock log draft. Returns null if unknown type. */
export async function applyConfirmedLivestockLogDraft(
  user: SessionUser,
  actionType: string,
  payload: Record<string, unknown>,
  source = 'butler',
): Promise<string | null> {
  if (actionType === 'livestock_log') {
    return executeConfirmedLivestockLog(user, payload, source)
  }
  return null
}
