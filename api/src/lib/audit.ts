import { db } from '../db/index.js'
import { auditEvents } from '../db/schema.js'

export async function logAudit(params: {
  farmId: string
  userId?: string
  action: string
  entityType: string
  entityId?: string
  metadata?: Record<string, unknown>
}) {
  await db.insert(auditEvents).values({
    farmId: params.farmId,
    userId: params.userId,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    metadata: params.metadata,
  })
}
