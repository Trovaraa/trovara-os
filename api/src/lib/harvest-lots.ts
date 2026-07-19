import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farms, harvestLots, orders, plots } from '../db/schema.js'
import { orderReference } from './customer-cart.js'
import {
  allocateLotCode,
  buildLotCodeBase,
  harvestPeriodAt,
  normalizeLotUnit,
  type LotUnit,
} from './lot-codes.js'
import { validateEvidenceDataUrl } from './evidence-url.js'
import { logAudit } from './audit.js'
import { recordFarmEvent } from './farm-events.js'

export type OrderLineForLot = {
  productName: string
  unit: string
  quantity: number
}

export async function createHarvestLotForOrder(params: {
  farmId: string
  orderId: string
  lines: OrderLineForLot[]
  reportedById?: string | null
  timeZone?: string
}): Promise<typeof harvestLots.$inferSelect> {
  const [farm] = await db
    .select({ timezone: farms.timezone })
    .from(farms)
    .where(eq(farms.id, params.farmId))
    .limit(1)

  const timeZone = params.timeZone ?? farm?.timezone ?? 'Africa/Lagos'
  const now = new Date()
  const period = harvestPeriodAt(now, timeZone)
  const reference = orderReference(params.orderId)
  const base = buildLotCodeBase({ orderReference: reference, period })

  const existing = await db
    .select({ lotCode: harvestLots.lotCode })
    .from(harvestLots)
    .where(eq(harvestLots.farmId, params.farmId))

  const lotCode = allocateLotCode(
    base,
    existing.map((r) => r.lotCode),
  )

  const primary = params.lines[0]
  const productName =
    params.lines.length === 1
      ? primary?.productName ?? 'Order items'
      : params.lines.length > 1
        ? `${primary?.productName ?? 'Items'} +${params.lines.length - 1} more`
        : 'Order items'

  const unit = normalizeLotUnit(primary?.unit)
  const quantity =
    params.lines.length === 1
      ? Math.max(1, Math.round(primary?.quantity ?? 1))
      : Math.max(
          1,
          params.lines.reduce((sum, line) => sum + Math.round(line.quantity), 0),
        )

  const [lot] = await db
    .insert(harvestLots)
    .values({
      farmId: params.farmId,
      lotCode,
      orderId: params.orderId,
      productName,
      quantityKg: quantity,
      unit,
      harvestedAt: now,
      reportedById: params.reportedById ?? null,
      verificationStatus: 'reported',
    })
    .returning()

  await db
    .update(orders)
    .set({ lotId: lot.id, updatedAt: new Date() })
    .where(and(eq(orders.id, params.orderId), eq(orders.farmId, params.farmId)))

  await recordFarmEvent({
    farmId: params.farmId,
    actorUserId: params.reportedById ?? undefined,
    entityType: 'harvest_lot',
    entityId: lot.id,
    eventType: 'harvested',
    afterValue: { quantityKg: lot.quantityKg, unit: lot.unit, status: lot.verificationStatus },
    metadata: { lotCode: lot.lotCode, orderId: params.orderId, autoCreated: true },
  })

  return lot
}

export type EnrichHarvestLotInput = {
  productName?: string
  quantityKg?: number
  unit?: LotUnit
  plotId?: string | null
  publicNotes?: string | null
  internalNotes?: string | null
  photoUrl?: string | null
}

export async function enrichHarvestLot(params: {
  farmId: string
  lotId: string
  userId: string
  updates: EnrichHarvestLotInput
}): Promise<{ lot: typeof harvestLots.$inferSelect } | { error: string; status: 400 | 404 }> {
  const [existing] = await db
    .select()
    .from(harvestLots)
    .where(and(eq(harvestLots.id, params.lotId), eq(harvestLots.farmId, params.farmId)))
    .limit(1)

  if (!existing) return { error: 'Not found', status: 404 }

  const body = params.updates
  if (body.photoUrl && !validateEvidenceDataUrl(body.photoUrl)) {
    return { error: 'Invalid photo evidence URL', status: 400 }
  }

  if (body.plotId) {
    const [plot] = await db
      .select({ id: plots.id })
      .from(plots)
      .where(and(eq(plots.id, body.plotId), eq(plots.farmId, params.farmId)))
      .limit(1)
    if (!plot) return { error: 'Invalid plot', status: 400 }
  }

  if (body.quantityKg !== undefined && (!Number.isInteger(body.quantityKg) || body.quantityKg < 1)) {
    return { error: 'Quantity must be a positive integer', status: 400 }
  }

  const updates: Partial<typeof existing> = {}
  if (body.productName !== undefined) updates.productName = body.productName
  if (body.quantityKg !== undefined) updates.quantityKg = body.quantityKg
  if (body.unit !== undefined) updates.unit = body.unit
  if (body.plotId !== undefined) updates.plotId = body.plotId
  if (body.publicNotes !== undefined) updates.publicNotes = body.publicNotes
  if (body.internalNotes !== undefined) updates.internalNotes = body.internalNotes
  if (body.photoUrl !== undefined) updates.photoUrl = body.photoUrl

  const [lot] = await db
    .update(harvestLots)
    .set(updates)
    .where(eq(harvestLots.id, params.lotId))
    .returning()

  await logAudit({
    farmId: params.farmId,
    userId: params.userId,
    action: 'update',
    entityType: 'harvest_lot',
    entityId: lot.id,
    metadata: { lotCode: lot.lotCode, enrich: true },
  })

  return { lot }
}

/** Supervisor/owner verify or reject a reported harvest lot. */
export async function verifyHarvestLot(params: {
  farmId: string
  lotId: string
  userId: string
  status: 'verified' | 'rejected'
  note?: string | null
}): Promise<{ lot: typeof harvestLots.$inferSelect } | { error: string; status: 400 | 404 }> {
  const [existing] = await db
    .select()
    .from(harvestLots)
    .where(and(eq(harvestLots.id, params.lotId), eq(harvestLots.farmId, params.farmId)))
    .limit(1)
  if (!existing) return { error: 'Not found', status: 404 }

  const [lot] = await db
    .update(harvestLots)
    .set({
      verificationStatus: params.status,
      verifiedById: params.userId,
      verifiedAt: new Date(),
      internalNotes: params.note ? params.note : existing.internalNotes,
    })
    .where(eq(harvestLots.id, params.lotId))
    .returning()

  await logAudit({
    farmId: params.farmId,
    userId: params.userId,
    action: 'update',
    entityType: 'harvest_lot',
    entityId: params.lotId,
    metadata: { lotCode: lot.lotCode, verificationStatus: lot.verificationStatus },
  })

  return { lot }
}

export async function listIncompleteLots(farmId: string, limit = 15) {
  return db
    .select({
      id: harvestLots.id,
      lotCode: harvestLots.lotCode,
      productName: harvestLots.productName,
      quantityKg: harvestLots.quantityKg,
      unit: harvestLots.unit,
      plotId: harvestLots.plotId,
      photoUrl: harvestLots.photoUrl,
      verificationStatus: harvestLots.verificationStatus,
      orderId: harvestLots.orderId,
    })
    .from(harvestLots)
    .where(
      and(
        eq(harvestLots.farmId, farmId),
        sql`(
          ${harvestLots.verificationStatus} = 'reported'
          OR ${harvestLots.plotId} IS NULL
          OR ${harvestLots.photoUrl} IS NULL
        )`,
      ),
    )
    .orderBy(desc(harvestLots.createdAt))
    .limit(limit)
}

export async function findLotByCode(farmId: string, lotCode: string) {
  const [lot] = await db
    .select()
    .from(harvestLots)
    .where(and(eq(harvestLots.farmId, farmId), eq(harvestLots.lotCode, lotCode)))
    .limit(1)
  return lot ?? null
}
