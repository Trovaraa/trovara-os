import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  harvestLots,
  inventoryItems,
  inventoryMovements,
  inventoryShrinkAlerts,
  orderItems,
  orders,
} from '../db/schema.js'

/**
 * Machine markers that share `inventory_movements.reason` with worker prose.
 * Keep in sync with writers in inventory / tasks / purchase-orders / this module.
 */
export const MOVEMENT_REASON_SENTINELS: ReadonlySet<string> = new Set([
  'opening_stock_count',
  'task_consumption',
  'goods_receipt',
  'verified_count_session',
  'sale',
  'harvest_in',
  'spoilage',
])

export const EXPLAINED_OUT_REASONS = new Set([
  'sale',
  'task_consumption',
  'spoilage',
  'verified_count_session',
])

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function applyStockDelta(
  tx: Tx,
  params: {
    farmId: string
    itemId: string
    delta: number
    reason: string
    recordedById: string
    sourceType?: string | null
    sourceId?: string | null
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (params.delta === 0) return { ok: true }

  const [item] = await tx
    .select({ id: inventoryItems.id, quantity: inventoryItems.quantity, name: inventoryItems.name })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, params.itemId), eq(inventoryItems.farmId, params.farmId)))
    .limit(1)
  if (!item) return { ok: false, error: 'Inventory item not found' }

  const newQty = item.quantity + params.delta
  if (newQty < 0) {
    return {
      ok: false,
      error: `Insufficient stock for ${item.name} (have ${item.quantity}, need ${Math.abs(params.delta)})`,
    }
  }

  try {
    await tx.insert(inventoryMovements).values({
      farmId: params.farmId,
      itemId: params.itemId,
      delta: params.delta,
      reason: params.reason,
      sourceType: params.sourceType ?? null,
      sourceId: params.sourceId ?? null,
      recordedById: params.recordedById,
    })
  } catch (err) {
    // Idempotent re-dispatch / re-verify: unique (farm, sourceType, sourceId).
    const message = err instanceof Error ? err.message : String(err)
    if (/inventory_movements_source_uq|unique/i.test(message)) {
      return { ok: true }
    }
    throw err
  }

  await tx
    .update(inventoryItems)
    .set({
      quantity: sql`${inventoryItems.quantity} + ${params.delta}`,
      updatedAt: new Date(),
    })
    .where(and(eq(inventoryItems.id, params.itemId), eq(inventoryItems.farmId, params.farmId)))

  return { ok: true }
}

/** Decrement finished-goods stock for each order line linked to an inventory item. */
export async function applyOrderSaleOnDispatch(params: {
  farmId: string
  orderId: string
  recordedById: string
}): Promise<{ ok: true; moved: number } | { ok: false; error: string }> {
  const lines = await db
    .select({
      orderItemId: orderItems.id,
      productId: orderItems.productId,
      quantity: orderItems.quantity,
      productName: orderItems.productName,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, params.orderId))

  const productIds = lines.map((l) => l.productId).filter((id): id is string => Boolean(id))
  if (productIds.length === 0) return { ok: true, moved: 0 }

  const linked = await db
    .select({
      id: inventoryItems.id,
      productId: inventoryItems.productId,
      name: inventoryItems.name,
      quantity: inventoryItems.quantity,
    })
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.farmId, params.farmId),
        inArray(inventoryItems.productId, productIds),
      ),
    )

  const byProduct = new Map(linked.map((row) => [row.productId!, row]))
  let moved = 0

  const outcome = await db.transaction(async (tx) => {
    for (const line of lines) {
      if (!line.productId) continue
      const item = byProduct.get(line.productId)
      if (!item) continue

      const result = await applyStockDelta(tx, {
        farmId: params.farmId,
        itemId: item.id,
        delta: -Math.abs(line.quantity),
        reason: 'sale',
        sourceType: 'order_item',
        sourceId: line.orderItemId,
        recordedById: params.recordedById,
      })
      if (!result.ok) return result
      moved += 1
    }
    return { ok: true as const }
  })

  if (!outcome.ok) return outcome
  return { ok: true, moved }
}

/** Credit finished-goods stock when a harvest lot is verified (idempotent). */
export async function applyHarvestStockIn(params: {
  farmId: string
  lotId: string
  productId: string | null
  quantity: number
  recordedById: string
}): Promise<{ ok: true; moved: boolean } | { ok: false; error: string }> {
  if (!params.productId || params.quantity <= 0) return { ok: true, moved: false }

  const [item] = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.farmId, params.farmId),
        eq(inventoryItems.productId, params.productId),
      ),
    )
    .limit(1)
  if (!item) return { ok: true, moved: false }

  const outcome = await db.transaction(async (tx) => {
    return applyStockDelta(tx, {
      farmId: params.farmId,
      itemId: item.id,
      delta: params.quantity,
      reason: 'harvest_in',
      sourceType: 'harvest_lot',
      sourceId: params.lotId,
      recordedById: params.recordedById,
    })
  })

  if (!outcome.ok) return outcome
  return { ok: true, moved: true }
}

export type ShrinkItemRow = {
  itemId: string
  sku: string
  name: string
  unit: string
  productId: string | null
  quantity: number
  varianceTolerance: number
  qtyIn: number
  qtyOutSale: number
  qtyOutTask: number
  qtyOutSpoilage: number
  qtyOutOther: number
  soldQty: number
  unexplainedOut: number
  salesMismatch: number
  flags: Array<'unexplained_out' | 'sales_stock_mismatch'>
}

export async function computeInventoryShrinkReport(
  farmId: string,
  periodDays = 30,
): Promise<{
  generatedAt: string
  periodDays: number
  periodStart: string
  periodEnd: string
  items: ShrinkItemRow[]
}> {
  const days = Math.min(Math.max(periodDays, 1), 365)
  const periodEnd = new Date()
  const periodStart = new Date(periodEnd.getTime() - days * 24 * 60 * 60 * 1000)

  const items = await db
    .select({
      id: inventoryItems.id,
      sku: inventoryItems.sku,
      name: inventoryItems.name,
      unit: inventoryItems.unit,
      productId: inventoryItems.productId,
      quantity: inventoryItems.quantity,
      varianceTolerance: inventoryItems.varianceTolerance,
    })
    .from(inventoryItems)
    .where(eq(inventoryItems.farmId, farmId))

  const movements = await db
    .select({
      itemId: inventoryMovements.itemId,
      delta: inventoryMovements.delta,
      reason: inventoryMovements.reason,
    })
    .from(inventoryMovements)
    .where(
      and(eq(inventoryMovements.farmId, farmId), gte(inventoryMovements.createdAt, periodStart)),
    )

  const productIds = items.map((i) => i.productId).filter((id): id is string => Boolean(id))
  const soldByProduct = new Map<string, number>()
  if (productIds.length > 0) {
    const soldRows = await db
      .select({
        productId: orderItems.productId,
        total: sql<number>`COALESCE(SUM(${orderItems.quantity}), 0)`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(
        and(
          eq(orders.farmId, farmId),
          inArray(orderItems.productId, productIds),
          inArray(orders.status, ['dispatched', 'delivered']),
          gte(orders.dispatchedAt, periodStart),
          isNotNull(orders.dispatchedAt),
        ),
      )
      .groupBy(orderItems.productId)

    for (const row of soldRows) {
      if (row.productId) soldByProduct.set(row.productId, Number(row.total))
    }
  }

  const byItem = new Map<
    string,
    {
      qtyIn: number
      qtyOutSale: number
      qtyOutTask: number
      qtyOutSpoilage: number
      qtyOutOther: number
    }
  >()

  for (const m of movements) {
    const bucket = byItem.get(m.itemId) ?? {
      qtyIn: 0,
      qtyOutSale: 0,
      qtyOutTask: 0,
      qtyOutSpoilage: 0,
      qtyOutOther: 0,
    }
    if (m.delta > 0) {
      bucket.qtyIn += m.delta
    } else {
      const out = Math.abs(m.delta)
      if (m.reason === 'sale') bucket.qtyOutSale += out
      else if (m.reason === 'task_consumption') bucket.qtyOutTask += out
      else if (m.reason === 'spoilage') bucket.qtyOutSpoilage += out
      else if (EXPLAINED_OUT_REASONS.has(m.reason)) {
        // verified_count_session negatives are explained count corrections
      } else {
        bucket.qtyOutOther += out
      }
    }
    byItem.set(m.itemId, bucket)
  }

  const reportItems: ShrinkItemRow[] = items.map((item) => {
    const bucket = byItem.get(item.id) ?? {
      qtyIn: 0,
      qtyOutSale: 0,
      qtyOutTask: 0,
      qtyOutSpoilage: 0,
      qtyOutOther: 0,
    }
    const soldQty = item.productId ? (soldByProduct.get(item.productId) ?? 0) : 0
    const unexplainedOut = bucket.qtyOutOther
    const salesMismatch =
      item.productId != null ? Math.abs(soldQty - bucket.qtyOutSale) : 0
    const flags: ShrinkItemRow['flags'] = []
    if (unexplainedOut > item.varianceTolerance) flags.push('unexplained_out')
    if (salesMismatch > item.varianceTolerance) flags.push('sales_stock_mismatch')

    return {
      itemId: item.id,
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      productId: item.productId,
      quantity: item.quantity,
      varianceTolerance: item.varianceTolerance,
      qtyIn: bucket.qtyIn,
      qtyOutSale: bucket.qtyOutSale,
      qtyOutTask: bucket.qtyOutTask,
      qtyOutSpoilage: bucket.qtyOutSpoilage,
      qtyOutOther: bucket.qtyOutOther,
      soldQty,
      unexplainedOut,
      salesMismatch,
      flags,
    }
  })

  reportItems.sort((a, b) => {
    if (a.flags.length !== b.flags.length) return b.flags.length - a.flags.length
    return b.unexplainedOut - a.unexplainedOut || b.salesMismatch - a.salesMismatch
  })

  return {
    generatedAt: periodEnd.toISOString(),
    periodDays: days,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    items: reportItems,
  }
}

/** Upsert open shrink alerts from the current period report. */
export async function refreshShrinkAlerts(
  farmId: string,
  periodDays = 30,
): Promise<{ created: number; updated: number; cleared: number; items: ShrinkItemRow[] }> {
  const report = await computeInventoryShrinkReport(farmId, periodDays)
  let created = 0
  let updated = 0
  let cleared = 0

  const flaggedKeys = new Set<string>()

  for (const item of report.items) {
    for (const alertType of item.flags) {
      flaggedKeys.add(`${item.itemId}:${alertType}`)
      const [existing] = await db
        .select()
        .from(inventoryShrinkAlerts)
        .where(
          and(
            eq(inventoryShrinkAlerts.farmId, farmId),
            eq(inventoryShrinkAlerts.itemId, item.itemId),
            eq(inventoryShrinkAlerts.alertType, alertType),
            sql`${inventoryShrinkAlerts.status} <> 'resolved'`,
          ),
        )
        .limit(1)

      const payload = {
        sku: item.sku,
        periodDays: report.periodDays,
        periodStart: new Date(report.periodStart),
        periodEnd: new Date(report.periodEnd),
        qtyIn: item.qtyIn,
        qtyOutSale: item.qtyOutSale,
        qtyOutTask: item.qtyOutTask,
        qtyOutSpoilage: item.qtyOutSpoilage,
        qtyOutOther: item.qtyOutOther,
        soldQty: item.soldQty,
        unexplainedOut: item.unexplainedOut,
        tolerance: item.varianceTolerance,
        updatedAt: new Date(),
      }

      if (existing) {
        await db
          .update(inventoryShrinkAlerts)
          .set(payload)
          .where(eq(inventoryShrinkAlerts.id, existing.id))
        updated += 1
      } else {
        await db.insert(inventoryShrinkAlerts).values({
          farmId,
          itemId: item.itemId,
          alertType,
          status: 'open',
          ...payload,
        })
        created += 1
      }
    }
  }

  // Auto-resolve open alerts that no longer flag on the latest scan.
  const openAlerts = await db
    .select()
    .from(inventoryShrinkAlerts)
    .where(
      and(
        eq(inventoryShrinkAlerts.farmId, farmId),
        sql`${inventoryShrinkAlerts.status} <> 'resolved'`,
      ),
    )

  for (const alert of openAlerts) {
    if (flaggedKeys.has(`${alert.itemId}:${alert.alertType}`)) continue
    await db
      .update(inventoryShrinkAlerts)
      .set({
        status: 'resolved',
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(inventoryShrinkAlerts.id, alert.id))
    cleared += 1
  }

  return { created, updated, cleared, items: report.items }
}

/** Re-export for harvest create paths that already have the lot row. */
export async function applyHarvestStockInForLot(params: {
  farmId: string
  lot: typeof harvestLots.$inferSelect
  recordedById: string
}) {
  return applyHarvestStockIn({
    farmId: params.farmId,
    lotId: params.lot.id,
    productId: params.lot.productId,
    quantity: params.lot.quantityKg,
    recordedById: params.recordedById,
  })
}
