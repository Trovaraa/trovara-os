import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { cropCycles, livestockBatches, plots } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { canAssignTasks } from './rbac.js'
import { logAudit } from './audit.js'
import { recordFarmEvent } from './farm-events.js'

export {
  parseCropCycleIntent,
  parseLivestockBatchIntent,
} from './action-draft-farm-parse.js'

export async function executeConfirmedCropCycle(
  user: SessionUser,
  payload: Record<string, unknown>,
): Promise<string> {
  if (!canAssignTasks(user)) return 'Only Admin or Supervisor can create crop cycles.'
  const plotId = String(payload.plotId ?? '')
  const cropType = String(payload.cropType ?? '').trim()
  const plantedAt = String(payload.plantedAt ?? '')
  if (!plotId || !cropType || !plantedAt) return 'Draft was missing crop fields.'

  const [cycle] = await db
    .insert(cropCycles)
    .values({
      farmId: user.farmId,
      plotId,
      cropType,
      stage: 'planted',
      plantedAt: new Date(plantedAt),
      stageEnteredAt: new Date(plantedAt),
      expectedHarvestAt: payload.expectedHarvestAt
        ? new Date(String(payload.expectedHarvestAt))
        : undefined,
      expectedYieldKg:
        payload.expectedYieldKg != null ? Number(payload.expectedYieldKg) : undefined,
    })
    .returning()

  await recordFarmEvent({
    farmId: user.farmId,
    actorUserId: user.id,
    entityType: 'crop_cycle',
    entityId: cycle.id,
    eventType: 'planted',
    afterValue: { stage: 'planted', cropType },
    metadata: { plotId, source: 'butler' },
  })
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'crop_cycle',
    entityId: cycle.id,
    metadata: { source: 'butler' },
  })

  return `✅ Crop cycle created: ${cropType} on ${payload.plotName ?? 'plot'} (planted).`
}

export async function executeConfirmedLivestockBatch(
  user: SessionUser,
  payload: Record<string, unknown>,
): Promise<string> {
  if (!canAssignTasks(user)) return 'Only Admin or Supervisor can create livestock batches.'
  const name = String(payload.name ?? '').trim()
  const species = String(payload.species ?? '').trim()
  const headCount = Number(payload.headCount)
  const acquiredAt = String(payload.acquiredAt ?? '')
  if (!name || !species || !Number.isFinite(headCount) || headCount < 1 || !acquiredAt) {
    return 'Draft was missing livestock fields.'
  }

  const [batch] = await db
    .insert(livestockBatches)
    .values({
      farmId: user.farmId,
      name,
      species,
      headCount,
      plotId: payload.plotId ? String(payload.plotId) : undefined,
      acquiredAt: new Date(acquiredAt),
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'livestock_batch',
    entityId: batch.id,
    metadata: { source: 'butler' },
  })

  return `✅ Livestock batch created: ${name} · ${species} · ${headCount} head.`
}

export async function resolvePlotByName(
  farmId: string,
  plotName: string,
): Promise<{ id: string; name: string } | null> {
  const farmPlots = await db
    .select({ id: plots.id, name: plots.name })
    .from(plots)
    .where(and(eq(plots.farmId, farmId), eq(plots.active, true)))
  return (
    farmPlots.find((p) => p.name.toLowerCase() === plotName.toLowerCase()) ?? null
  )
}

export function shortDraftHint(draftId: string): string {
  return draftId.slice(0, 8)
}
