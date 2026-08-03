import { db } from '../db/index.js'
import { auditEvents } from '../db/schema.js'
import type { RequestAccessMeta } from './request-access-meta.js'

export async function logAudit(params: {
  farmId: string
  userId?: string
  action: string
  entityType: string
  entityId?: string
  metadata?: Record<string, unknown>
  /** Optional IP / country / region from the request (stored in metadata). */
  access?: RequestAccessMeta
}) {
  const metadata = {
    ...(params.metadata ?? {}),
    ...(params.access?.ip ? { ip: params.access.ip } : {}),
    ...(params.access?.country ? { country: params.access.country } : {}),
    ...(params.access?.region ? { region: params.access.region } : {}),
  }
  await db.insert(auditEvents).values({
    farmId: params.farmId,
    userId: params.userId,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    metadata: Object.keys(metadata).length ? metadata : undefined,
  })
}
