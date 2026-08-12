import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { cropCycles, livestockBatches, plots } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { hasPermission } from './rbac.js'
import { logAudit } from './audit.js'
import { recordFarmEvent } from './farm-events.js'
import {
  asPoultryBatchType,
  matchPoultryTypeAnswer,
  normalizeSpeciesForWrite,
  type PoultryBatchType,
} from './species-normalize.js'
import { findByName } from './entity-name-match.js'
import { getLatestPendingDraft, mergeActionDraftPayload } from './task-drafts.js'

export {
  parseCropCycleIntent,
  parseLivestockBatchIntent,
} from './action-draft-farm-parse.js'

export async function executeConfirmedCropCycle(
  user: SessionUser,
  payload: Record<string, unknown>,
): Promise<string> {
  if (!hasPermission(user, 'crops.manage')) return 'You do not have permission to manage crops.'
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
  if (!hasPermission(user, 'livestock.manage')) return 'You do not have permission to manage livestock.'
  const name = String(payload.name ?? '').trim()
  const species = String(payload.species ?? '').trim()
  const headCount = Number(payload.headCount)
  const acquiredAt = String(payload.acquiredAt ?? '')
  if (!name || !species || !Number.isFinite(headCount) || headCount < 1 || !acquiredAt) {
    return 'Draft was missing livestock fields.'
  }

  // Drafts created after the lexicon landed already carry the canonical species,
  // but a draft stored before it (or one created by a path that missed it) still
  // holds raw text, so normalizing here is what makes the stored row consistent.
  const { species: canonicalSpecies, batchType } = normalizeSpeciesForWrite(species)
  // A type the worker answered cannot be derived from `species` a second time:
  // they were asked precisely because their words do not name one.
  const answeredType = asPoultryBatchType(payload.batchType)

  const [batch] = await db
    .insert(livestockBatches)
    .values({
      farmId: user.farmId,
      name,
      species: canonicalSpecies,
      batchType: answeredType ?? batchType,
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

  // The worker reads back the words they sent, not the lookup key we stored.
  const typedSpecies = String(payload.speciesTyped ?? species).trim() || species
  return `✅ Livestock batch created: ${name} · ${typedSpecies} · ${headCount} head.`
}

export type PoultryTypeAnswer =
  | { handled: false }
  | { handled: true; draftId: string; batchType: PoultryBatchType }

/**
 * Put a worker's answer to the poultry-type question onto the batch draft that
 * is waiting for it, the way `applyLotEnrichText` applies the follow-up lines of
 * a lot draft: the draft row is the pending question, and the next message is
 * read against it.
 *
 * Nothing is claimed unless a draft is actually waiting and the message is one
 * of the options, so every other message still reaches the butler.
 */
export async function applyPoultryTypeAnswer(
  user: SessionUser,
  text: string,
): Promise<PoultryTypeAnswer> {
  const draft = await getLatestPendingDraft(user.id, 'create_livestock_batch')
  if (!draft?.payload.awaitingBatchType) return { handled: false }

  const batchType = matchPoultryTypeAnswer(text)
  if (!batchType) return { handled: false }

  await mergeActionDraftPayload(draft.id, user.id, { batchType, awaitingBatchType: false })
  return { handled: true, draftId: draft.id, batchType }
}

/**
 * The active plot a worker's words name. Accents, hyphens, case and spacing are
 * folded at comparison time only — the row keeps the farm's own spelling.
 */
export async function resolvePlotByName(
  farmId: string,
  plotName: string,
): Promise<{ id: string; name: string } | null> {
  const farmPlots = await db
    .select({ id: plots.id, name: plots.name })
    .from(plots)
    .where(and(eq(plots.farmId, farmId), eq(plots.active, true)))
  return findByName(farmPlots, plotName)
}
