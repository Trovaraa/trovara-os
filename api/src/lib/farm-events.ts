import { db } from '../db/index.js'
import { farmEvents } from '../db/schema.js'

type FarmEventType =
  | 'planted'
  | 'watered'
  | 'weeded'
  | 'fertilized'
  | 'harvested'
  | 'fed'
  | 'vaccinated'
  | 'mortality'
  | 'sold'
  | 'moved'
  | 'incident'
  | 'other'

export async function recordFarmEvent(params: {
  farmId: string
  actorUserId?: string
  entityType: string
  entityId: string
  eventType: FarmEventType
  beforeValue?: unknown
  afterValue?: unknown
  source?: string
  metadata?: Record<string, unknown>
}) {
  const [event] = await db
    .insert(farmEvents)
    .values({
      farmId: params.farmId,
      actorUserId: params.actorUserId,
      entityType: params.entityType,
      entityId: params.entityId,
      eventType: params.eventType,
      beforeValue: params.beforeValue ?? null,
      afterValue: params.afterValue ?? null,
      source: params.source ?? 'web',
      metadata: params.metadata ?? null,
    })
    .returning()

  return event
}
