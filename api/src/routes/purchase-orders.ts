import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  goodsReceiptLines,
  goodsReceipts,
  inventoryItems,
  inventoryMovements,
  purchaseOrderLines,
  purchaseOrders,
  suppliers,
  users,
} from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import {
  purchaseOrderStatusAfterReceipt,
  receiptQuantityIsValid,
} from '../lib/purchase-order-receiving.js'
import {
  authorLocaleHint,
  toCanonicalEnglish,
  toViewerLocaleMany,
} from '../lib/content-locale.js'
import { resolveStaffReplyLocale } from '../lib/reply-locale.js'
import { contentLocaleValues, type ContentLocaleMeta } from '../lib/task-drafts.js'

const UNITS = ['kg', 'bags', 'liters', 'units', 'crates'] as const

/**
 * The only prose on a purchase order, and on a goods receipt against it.
 *
 * Everything else on this payload is procurement record: the supplier's trading
 * name, each line's `itemName` (matched against the inventory register and
 * printed on the order), the unit enum, the ordered and received quantities, the
 * unit costs, the status enum and the caller's `idempotencyKey`. A supplier
 * whose name or item lines changed language between the order and the receipt
 * would stop reconciling, so none of them ever reaches a translator.
 */
const PURCHASE_ORDER_TEXT_FIELDS = ['notes'] as const
const GOODS_RECEIPT_TEXT_FIELDS = ['notes'] as const

const createPurchaseOrderSchema = z.object({
  supplierId: z.string().uuid(),
  notes: z.string().trim().max(2000).nullable().optional(),
  expectedAt: z.string().datetime().nullable().optional(),
  lines: z.array(z.object({
    itemId: z.string().uuid().nullable().optional(),
    itemName: z.string().trim().min(1).max(200),
    unit: z.enum(UNITS),
    quantityOrdered: z.number().int().positive(),
    unitCostMinor: z.number().int().min(0).nullable().optional(),
  })).min(1).max(100),
})

const receiveSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200),
  notes: z.string().trim().max(2000).nullable().optional(),
  lines: z.array(z.object({
    purchaseOrderLineId: z.string().uuid(),
    quantityReceived: z.number().int().positive(),
  })).min(1).max(100).refine(
    (lines) => new Set(lines.map((line) => line.purchaseOrderLineId)).size === lines.length,
    'Duplicate purchase order line',
  ),
})

async function preferredLocaleForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row?.preferredLocale ?? null
}

/**
 * Normalize a note to English for storage.
 *
 * A failure yields the author's own words at status 'pending' so the retry job
 * repairs the row, and the locale hint is kept rather than widened to 'en': the
 * job filters English rows out, so mislabelling one makes it permanent.
 */
async function canonicalNote(
  note: string | null | undefined,
  farmId: string,
  sourceLocale: string | null,
): Promise<{ english?: string; locale: ContentLocaleMeta }> {
  if (typeof note !== 'string' || note.trim() === '') {
    return { locale: { sourceLocale: null, translationStatus: 'done' } }
  }
  try {
    const result = await toCanonicalEnglish({ text: note, farmId, sourceLocale })
    return {
      english: result.english,
      locale: { sourceLocale: result.sourceLocale, translationStatus: result.status },
    }
  } catch {
    // A translation failure must never fail the write it serves.
    return { english: note, locale: { sourceLocale, translationStatus: 'pending' } }
  }
}

/** One prose value in a response payload, addressed by the object holding it. */
type ProseSlot = { row: Record<string, unknown>; field: string }

/** The prose actually present on these rows, as slots a localizer can fill. */
function proseSlots(
  rows: readonly (object | null | undefined)[],
  fields: readonly string[],
): ProseSlot[] {
  const slots: ProseSlot[] = []
  for (const row of rows) {
    if (!row) continue
    const record = row as Record<string, unknown>
    for (const field of fields) {
      const value = record[field]
      if (typeof value === 'string' && value !== '') slots.push({ row: record, field })
    }
  }
  return slots
}

/**
 * Render prose in the viewer's language with ONE batched translation call per
 * response. Callers hand over every slot in the payload at once — an order
 * detail carries its own note plus one per receipt against it — so a nested
 * response still costs a single round trip: the service deduplicates and reads
 * its cache in one query. An English viewer short-circuits before any of it.
 *
 * Slots are written in place, so callers must pass objects built for the
 * response rather than rows still shared with anything else.
 */
async function localizeProse(
  slots: ProseSlot[],
  farmId: string,
  targetLocale: string | null,
): Promise<void> {
  if (resolveStaffReplyLocale(targetLocale) === 'en') return
  if (slots.length === 0) return

  const translated = await toViewerLocaleMany({
    texts: slots.map((slot) => slot.row[slot.field] as string),
    targetLocale,
    farmId,
  })
  slots.forEach((slot, index) => {
    slot.row[slot.field] = translated[index]
  })
}

async function purchaseOrderDetail(farmId: string, id: string) {
  const [order] = await db
    .select({
      id: purchaseOrders.id,
      farmId: purchaseOrders.farmId,
      supplierId: purchaseOrders.supplierId,
      supplierName: suppliers.name,
      status: purchaseOrders.status,
      createdById: purchaseOrders.createdById,
      approvedById: purchaseOrders.approvedById,
      approvedAt: purchaseOrders.approvedAt,
      notes: purchaseOrders.notes,
      expectedAt: purchaseOrders.expectedAt,
      createdAt: purchaseOrders.createdAt,
      updatedAt: purchaseOrders.updatedAt,
    })
    .from(purchaseOrders)
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.farmId, farmId)))
    .limit(1)
  if (!order) return null

  const lines = await db
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.purchaseOrderId, id))
    .orderBy(asc(purchaseOrderLines.createdAt))
  const receipts = await db
    .select()
    .from(goodsReceipts)
    .where(and(eq(goodsReceipts.purchaseOrderId, id), eq(goodsReceipts.farmId, farmId)))
    .orderBy(desc(goodsReceipts.receivedAt))
  // Receipts are copied because the localizer writes into the response payload.
  return { ...order, lines, receipts: receipts.map((receipt) => ({ ...receipt })) }
}

type PurchaseOrderDetail = NonNullable<Awaited<ReturnType<typeof purchaseOrderDetail>>>

/** Every prose slot in a detail payload: the order's note and each receipt's. */
function detailProseSlots(
  detail: PurchaseOrderDetail,
  orderFields: readonly string[] = PURCHASE_ORDER_TEXT_FIELDS,
): ProseSlot[] {
  return [
    ...proseSlots([detail], orderFields),
    ...proseSlots(detail.receipts, GOODS_RECEIPT_TEXT_FIELDS),
  ]
}

/**
 * A detail payload rendered for the staff member reading it. `echo` carries text
 * the caller just submitted, returned in their own words with no round trip
 * while the row holds the English.
 */
async function detailForViewer(
  farmId: string,
  id: string,
  viewerLocale: string | null,
  echo: { notes?: string } = {},
): Promise<PurchaseOrderDetail | null> {
  const detail = await purchaseOrderDetail(farmId, id)
  if (!detail) return null
  await localizeProse(
    detailProseSlots(
      detail,
      PURCHASE_ORDER_TEXT_FIELDS.filter((field) => !(field in echo)),
    ),
    farmId,
    viewerLocale,
  )
  return { ...detail, ...echo }
}

export const purchaseOrderRoutes = new Hono<{ Variables: AppVariables }>()

purchaseOrderRoutes.use('*', authMiddleware)

purchaseOrderRoutes.get('/', async (c) => {
  const user = c.get('user')
  const orders = await db
    .select({
      id: purchaseOrders.id,
      supplierId: purchaseOrders.supplierId,
      supplierName: suppliers.name,
      status: purchaseOrders.status,
      notes: purchaseOrders.notes,
      expectedAt: purchaseOrders.expectedAt,
      approvedById: purchaseOrders.approvedById,
      createdAt: purchaseOrders.createdAt,
      updatedAt: purchaseOrders.updatedAt,
    })
    .from(purchaseOrders)
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .where(eq(purchaseOrders.farmId, user.farmId))
    .orderBy(desc(purchaseOrders.createdAt))
    .limit(100)

  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = orders.map((order) => ({ ...order }))
  await localizeProse(
    proseSlots(localized, PURCHASE_ORDER_TEXT_FIELDS),
    user.farmId,
    viewerLocale,
  )
  return c.json({ purchaseOrders: localized })
})

purchaseOrderRoutes.get('/:id', async (c) => {
  const user = c.get('user')
  const viewerLocale = await preferredLocaleForUser(user.id)
  const order = await detailForViewer(user.farmId, c.req.param('id'), viewerLocale)
  return order ? c.json({ purchaseOrder: order }) : c.json({ error: 'Purchase order not found' }, 404)
})

purchaseOrderRoutes.post('/', zValidator('json', createPurchaseOrderSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const [supplier] = await db
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(and(
      eq(suppliers.id, body.supplierId),
      eq(suppliers.farmId, user.farmId),
      eq(suppliers.active, true),
    ))
    .limit(1)
  if (!supplier) return c.json({ error: 'Active supplier not found' }, 404)

  const itemIds = body.lines.flatMap((line) => line.itemId ? [line.itemId] : [])
  if (itemIds.length) {
    const farmItems = await db
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(and(
        eq(inventoryItems.farmId, user.farmId),
        inArray(inventoryItems.id, [...new Set(itemIds)]),
      ))
    if (farmItems.length !== new Set(itemIds).size) {
      return c.json({ error: 'One or more inventory items were not found' }, 404)
    }
  }

  const viewerLocale = await preferredLocaleForUser(user.id)
  const authorLocale = authorLocaleHint(viewerLocale)
  const canonical = await canonicalNote(body.notes, user.farmId, authorLocale)

  const orderId = await db.transaction(async (tx) => {
    const [order] = await tx
      .insert(purchaseOrders)
      .values({
        farmId: user.farmId,
        supplierId: body.supplierId,
        createdById: user.id,
        notes: canonical.english ?? body.notes ?? null,
        ...contentLocaleValues(canonical.locale),
        expectedAt: body.expectedAt ? new Date(body.expectedAt) : null,
      })
      .returning({ id: purchaseOrders.id })
    // Line item names are register keys, not prose: stored exactly as ordered.
    await tx.insert(purchaseOrderLines).values(body.lines.map((line) => ({
      purchaseOrderId: order.id,
      itemId: line.itemId ?? null,
      itemName: line.itemName,
      unit: line.unit,
      quantityOrdered: line.quantityOrdered,
      unitCostMinor: line.unitCostMinor ?? null,
    })))
    return order.id
  })
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'purchase_order',
    entityId: orderId,
  })
  return c.json(
    {
      purchaseOrder: await detailForViewer(
        user.farmId,
        orderId,
        viewerLocale,
        body.notes ? { notes: body.notes } : {},
      ),
    },
    201,
  )
})

purchaseOrderRoutes.post('/:id/approve', async (c) => {
  const user = c.get('user')
  if (user.role !== 'owner') return c.json({ error: 'Forbidden' }, 403)
  const [order] = await db
    .update(purchaseOrders)
    .set({
      status: 'approved',
      approvedById: user.id,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(purchaseOrders.id, c.req.param('id')),
      eq(purchaseOrders.farmId, user.farmId),
      eq(purchaseOrders.status, 'draft'),
    ))
    .returning()
  if (!order) return c.json({ error: 'Draft purchase order not found' }, 404)
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'approve',
    entityType: 'purchase_order',
    entityId: order.id,
  })
  const viewerLocale = await preferredLocaleForUser(user.id)
  return c.json({ purchaseOrder: await detailForViewer(user.farmId, order.id, viewerLocale) })
})

purchaseOrderRoutes.post('/:id/send', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)
  const [order] = await db
    .update(purchaseOrders)
    .set({ status: 'sent', updatedAt: new Date() })
    .where(and(
      eq(purchaseOrders.id, c.req.param('id')),
      eq(purchaseOrders.farmId, user.farmId),
      eq(purchaseOrders.status, 'approved'),
    ))
    .returning()
  if (!order) return c.json({ error: 'Approved purchase order not found' }, 404)
  const viewerLocale = await preferredLocaleForUser(user.id)
  return c.json({ purchaseOrder: await detailForViewer(user.farmId, order.id, viewerLocale) })
})

purchaseOrderRoutes.post('/:id/cancel', async (c) => {
  const user = c.get('user')
  if (user.role !== 'owner') return c.json({ error: 'Forbidden' }, 403)
  const [order] = await db
    .update(purchaseOrders)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(
      eq(purchaseOrders.id, c.req.param('id')),
      eq(purchaseOrders.farmId, user.farmId),
      inArray(purchaseOrders.status, ['draft', 'approved', 'sent']),
    ))
    .returning()
  if (!order) return c.json({ error: 'Cancellable purchase order not found' }, 404)
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'cancel',
    entityType: 'purchase_order',
    entityId: order.id,
  })
  const viewerLocale = await preferredLocaleForUser(user.id)
  return c.json({ purchaseOrder: await detailForViewer(user.farmId, order.id, viewerLocale) })
})

purchaseOrderRoutes.post('/:id/receipts', zValidator('json', receiveSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)
  const orderId = c.req.param('id')
  const body = c.req.valid('json')

  const viewerLocale = await preferredLocaleForUser(user.id)
  const authorLocale = authorLocaleHint(viewerLocale)
  const canonical = await canonicalNote(body.notes, user.farmId, authorLocale)

  try {
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id FROM purchase_orders
        WHERE id = ${orderId} AND farm_id = ${user.farmId}
        FOR UPDATE
      `)
      const [order] = await tx
        .select()
        .from(purchaseOrders)
        .where(and(eq(purchaseOrders.id, orderId), eq(purchaseOrders.farmId, user.farmId)))
        .limit(1)
      if (!order) throw new Error('PO_NOT_FOUND')
      if (!['approved', 'sent', 'partially_received'].includes(order.status)) {
        throw new Error('PO_NOT_RECEIVABLE')
      }

      const [existing] = await tx
        .select({ id: goodsReceipts.id })
        .from(goodsReceipts)
        .where(and(
          eq(goodsReceipts.purchaseOrderId, orderId),
          eq(goodsReceipts.idempotencyKey, body.idempotencyKey),
        ))
        .limit(1)
      // A replayed key returns the receipt the earlier call wrote; this request's
      // note was never stored on it, so it is not this author's text to echo.
      if (existing) return { id: existing.id, created: false }

      const lines = await tx
        .select()
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.purchaseOrderId, orderId))
      const byId = new Map(lines.map((line) => [line.id, line]))
      for (const received of body.lines) {
        const line = byId.get(received.purchaseOrderLineId)
        if (!line) throw new Error('PO_LINE_NOT_FOUND')
        if (!line.itemId) throw new Error('PO_LINE_ITEM_REQUIRED')
        if (!receiptQuantityIsValid(line, received.quantityReceived)) {
          throw new Error('PO_LINE_OVER_RECEIPT')
        }
      }

      const [receipt] = await tx
        .insert(goodsReceipts)
        .values({
          farmId: user.farmId,
          purchaseOrderId: orderId,
          idempotencyKey: body.idempotencyKey,
          receivedById: user.id,
          notes: canonical.english ?? body.notes ?? null,
          ...contentLocaleValues(canonical.locale),
        })
        .returning({ id: goodsReceipts.id })

      for (const received of body.lines) {
        const line = byId.get(received.purchaseOrderLineId)!
        const [receiptLine] = await tx
          .insert(goodsReceiptLines)
          .values({
            goodsReceiptId: receipt.id,
            purchaseOrderLineId: line.id,
            itemId: line.itemId!,
            quantityReceived: received.quantityReceived,
          })
          .returning({ id: goodsReceiptLines.id })
        const [movement] = await tx
          .insert(inventoryMovements)
          .values({
            farmId: user.farmId,
            itemId: line.itemId!,
            delta: received.quantityReceived,
            // Machine sentinel, not prose: it stays English and 'done' so the
            // retry job never sweeps it.
            reason: 'goods_receipt',
            sourceType: 'goods_receipt_line',
            sourceId: receiptLine.id,
            recordedById: user.id,
          })
          .returning({ id: inventoryMovements.id })
        await tx
          .update(goodsReceiptLines)
          .set({ inventoryMovementId: movement.id })
          .where(eq(goodsReceiptLines.id, receiptLine.id))
        await tx
          .update(inventoryItems)
          .set({
            quantity: sql`${inventoryItems.quantity} + ${received.quantityReceived}`,
            updatedAt: new Date(),
          })
          .where(and(
            eq(inventoryItems.id, line.itemId!),
            eq(inventoryItems.farmId, user.farmId),
          ))
        line.quantityReceived += received.quantityReceived
        await tx
          .update(purchaseOrderLines)
          .set({ quantityReceived: line.quantityReceived })
          .where(eq(purchaseOrderLines.id, line.id))
      }

      await tx
        .update(purchaseOrders)
        .set({
          status: purchaseOrderStatusAfterReceipt(lines),
          updatedAt: new Date(),
        })
        .where(eq(purchaseOrders.id, orderId))
      return { id: receipt.id, created: true }
    })

    const receiptId = outcome.id
    const [receipt] = await db
      .select()
      .from(goodsReceipts)
      .where(and(eq(goodsReceipts.id, receiptId), eq(goodsReceipts.farmId, user.farmId)))
      .limit(1)
    const lines = await db
      .select()
      .from(goodsReceiptLines)
      .where(eq(goodsReceiptLines.goodsReceiptId, receiptId))
    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'receive',
      entityType: 'goods_receipt',
      entityId: receiptId,
      metadata: { purchaseOrderId: orderId },
    })

    const detail = await purchaseOrderDetail(user.farmId, orderId)
    const receiptPayload = { ...receipt, lines }

    // The receiver reads their own note back, in the response and in the order's
    // receipt history alike: one response must not show the same note twice in
    // two different languages. Everything else is canonical English rendered for
    // this viewer, in a single batched call across both objects.
    const echoed = outcome.created && body.notes?.trim() ? body.notes : null
    const receiptRows = [receiptPayload, ...(detail?.receipts ?? [])]
    const localizable = echoed
      ? receiptRows.filter((row) => row.id !== receiptId)
      : receiptRows
    await localizeProse(
      [
        ...proseSlots(detail ? [detail] : [], PURCHASE_ORDER_TEXT_FIELDS),
        ...proseSlots(localizable, GOODS_RECEIPT_TEXT_FIELDS),
      ],
      user.farmId,
      viewerLocale,
    )
    if (echoed) {
      for (const row of receiptRows) {
        if (row.id === receiptId) row.notes = echoed
      }
    }

    return c.json({ receipt: receiptPayload, purchaseOrder: detail }, 201)
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    if (code === 'PO_NOT_FOUND') return c.json({ error: 'Purchase order not found' }, 404)
    if (code === 'PO_NOT_RECEIVABLE') return c.json({ error: 'Purchase order is not approved for receiving' }, 409)
    if (code === 'PO_LINE_NOT_FOUND') return c.json({ error: 'Purchase order line not found' }, 404)
    if (code === 'PO_LINE_ITEM_REQUIRED') return c.json({ error: 'Receipt line must be linked to an inventory item' }, 400)
    if (code === 'PO_LINE_OVER_RECEIPT') return c.json({ error: 'Received quantity exceeds the outstanding quantity' }, 409)
    throw error
  }
})
