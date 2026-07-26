import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { inventoryItems, inventoryMovements } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { canManageInventory } from './rbac.js'
import { logAudit } from './audit.js'
import {
  contentLocaleValues,
  storeActionDraft,
  type ContentLocaleMeta,
} from './task-drafts.js'
import { findByName } from './entity-name-match.js'

export {
  parseStockMoveIntent,
  parseOpeningCountIntent,
  parseLowStockAckIntent,
} from './action-draft-inventory-parse.js'

type LowStockItemPayload = {
  itemId: string
  name: string
  quantity: number
  reorderLevel: number
}

/**
 * The inventory item a worker's words name. Accents, hyphens, case and spacing
 * are folded at comparison time only — the row keeps the farm's own spelling.
 */
export async function resolveInventoryItemByName(
  farmId: string,
  query: string,
): Promise<{
  id: string
  name: string
  quantity: number
  reorderLevel: number
  unit: string
} | null> {
  const items = await db
    .select({
      id: inventoryItems.id,
      name: inventoryItems.name,
      quantity: inventoryItems.quantity,
      reorderLevel: inventoryItems.reorderLevel,
      unit: inventoryItems.unit,
    })
    .from(inventoryItems)
    .where(eq(inventoryItems.farmId, farmId))

  return findByName(items, query)
}

export async function prepareStockMoveDraft(params: {
  user: SessionUser
  itemQuery: string
  delta: number
  reason: string
  channel: string
  externalChatId: string
}): Promise<{ ok: true; preview: string; draftId: string } | { ok: false; error: string }> {
  if (!canManageInventory(params.user)) {
    return { ok: false, error: 'Only Admin, Supervisor, or Sales can record stock moves.' }
  }
  if (!Number.isInteger(params.delta) || params.delta === 0) {
    return { ok: false, error: 'Delta must be a non-zero integer.' }
  }
  const reason = params.reason.trim()
  if (!reason) return { ok: false, error: 'Reason is required.' }

  const item = await resolveInventoryItemByName(params.user.farmId, params.itemQuery)
  if (!item) {
    return {
      ok: false,
      error: `Item "${params.itemQuery}" not found. Use the exact inventory item name.`,
    }
  }

  const newQty = item.quantity + params.delta
  if (newQty < 0) {
    return {
      ok: false,
      error: `Insufficient stock for ${item.name} (on hand ${item.quantity}).`,
    }
  }

  const stored = await storeActionDraft({
    userId: params.user.id,
    farmId: params.user.farmId,
    actionType: 'stock_move',
    payload: {
      itemId: item.id,
      itemName: item.name,
      delta: params.delta,
      reason,
      quantityBefore: item.quantity,
      quantityAfter: newQty,
      unit: item.unit,
    },
    channel: params.channel,
    externalChatId: params.externalChatId,
  })

  return {
    ok: true,
    draftId: stored.id,
    preview: [
      'Draft stock move ready:',
      `Item: ${item.name}`,
      `Delta: ${params.delta > 0 ? '+' : ''}${params.delta} ${item.unit}`,
      `On hand: ${item.quantity} → ${newQty}`,
      `Reason: ${reason}`,
    ].join('\n'),
  }
}

export async function prepareOpeningCountDraft(params: {
  user: SessionUser
  itemQuery: string
  countedQuantity: number
  channel: string
  externalChatId: string
}): Promise<{ ok: true; preview: string; draftId: string } | { ok: false; error: string }> {
  if (!canManageInventory(params.user)) {
    return { ok: false, error: 'Only Admin, Supervisor, or Sales can record opening counts.' }
  }
  if (!Number.isInteger(params.countedQuantity) || params.countedQuantity < 0) {
    return { ok: false, error: 'Counted quantity must be a non-negative integer.' }
  }

  const item = await resolveInventoryItemByName(params.user.farmId, params.itemQuery)
  if (!item) {
    return {
      ok: false,
      error: `Item "${params.itemQuery}" not found. Use the exact inventory item name.`,
    }
  }

  const delta = params.countedQuantity - item.quantity
  const stored = await storeActionDraft({
    userId: params.user.id,
    farmId: params.user.farmId,
    actionType: 'opening_count',
    payload: {
      itemId: item.id,
      itemName: item.name,
      countedQuantity: params.countedQuantity,
      quantityBefore: item.quantity,
      delta,
      unit: item.unit,
    },
    channel: params.channel,
    externalChatId: params.externalChatId,
  })

  return {
    ok: true,
    draftId: stored.id,
    preview: [
      'Draft opening count ready:',
      `Item: ${item.name}`,
      `Counted: ${params.countedQuantity} ${item.unit}`,
      `On hand: ${item.quantity} → ${params.countedQuantity} (delta ${delta > 0 ? '+' : ''}${delta})`,
    ].join('\n'),
  }
}

export async function prepareLowStockAckDraft(params: {
  user: SessionUser
  itemQuery: string | null
  channel: string
  externalChatId: string
}): Promise<{ ok: true; preview: string; draftId: string } | { ok: false; error: string }> {
  if (!canManageInventory(params.user)) {
    return { ok: false, error: 'Only Admin, Supervisor, or Sales can acknowledge low stock.' }
  }

  let items: LowStockItemPayload[]

  if (params.itemQuery) {
    const item = await resolveInventoryItemByName(params.user.farmId, params.itemQuery)
    if (!item) {
      return {
        ok: false,
        error: `Item "${params.itemQuery}" not found. Use the exact inventory item name.`,
      }
    }
    if (item.quantity > item.reorderLevel) {
      return {
        ok: false,
        error: `${item.name} is not low stock (${item.quantity} on hand, reorder at ${item.reorderLevel}).`,
      }
    }
    items = [
      {
        itemId: item.id,
        name: item.name,
        quantity: item.quantity,
        reorderLevel: item.reorderLevel,
      },
    ]
  } else {
    const rows = await db
      .select({
        itemId: inventoryItems.id,
        name: inventoryItems.name,
        quantity: inventoryItems.quantity,
        reorderLevel: inventoryItems.reorderLevel,
      })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.farmId, params.user.farmId),
          sql`${inventoryItems.quantity} <= ${inventoryItems.reorderLevel}`,
        ),
      )

    items = rows
    if (items.length === 0) {
      return { ok: false, error: 'No low-stock items to acknowledge.' }
    }
  }

  const stored = await storeActionDraft({
    userId: params.user.id,
    farmId: params.user.farmId,
    actionType: 'low_stock_ack',
    payload: { items },
    channel: params.channel,
    externalChatId: params.externalChatId,
  })

  return {
    ok: true,
    draftId: stored.id,
    preview: [
      'Draft low-stock acknowledgement ready:',
      ...items.map(
        (item) => `• ${item.name}: ${item.quantity} on hand (reorder ${item.reorderLevel})`,
      ),
    ].join('\n'),
  }
}

export async function executeConfirmedStockMove(
  user: SessionUser,
  payload: Record<string, unknown>,
  source = 'butler',
  locale?: ContentLocaleMeta,
): Promise<string> {
  if (!canManageInventory(user)) {
    return 'Only Admin, Supervisor, or Sales can record stock moves.'
  }

  const itemId = String(payload.itemId ?? '')
  const delta = Number(payload.delta)
  const reason = String(payload.reason ?? '').trim()
  if (!itemId || !Number.isInteger(delta) || delta === 0 || !reason) {
    return 'Draft was missing stock move fields.'
  }

  const [item] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.farmId, user.farmId)))
    .limit(1)

  if (!item) return 'Item no longer found.'

  const newQty = item.quantity + delta
  if (newQty < 0) return 'Insufficient stock.'

  const updated = await db.transaction(async (tx) => {
    await tx.insert(inventoryMovements).values({
      farmId: user.farmId,
      itemId,
      delta,
      reason,
      recordedById: user.id,
      ...contentLocaleValues(locale),
    })

    const [row] = await tx
      .update(inventoryItems)
      .set({ quantity: newQty, updatedAt: new Date() })
      .where(eq(inventoryItems.id, itemId))
      .returning()

    return row
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'inventory_movement',
    entityType: 'inventory_item',
    entityId: itemId,
    metadata: { delta, reason, source },
  })

  return `✅ Stock updated: ${updated.name} ${delta > 0 ? '+' : ''}${delta} → ${updated.quantity} ${updated.unit} (${reason}).`
}

export async function executeConfirmedOpeningCount(
  user: SessionUser,
  payload: Record<string, unknown>,
  source = 'butler',
): Promise<string> {
  if (!canManageInventory(user)) {
    return 'Only Admin, Supervisor, or Sales can record opening counts.'
  }

  const itemId = String(payload.itemId ?? '')
  const countedQuantity = Number(payload.countedQuantity)
  if (!itemId || !Number.isInteger(countedQuantity) || countedQuantity < 0) {
    return 'Draft was missing opening count fields.'
  }

  const [current] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.farmId, user.farmId)))
    .limit(1)

  if (!current) return 'Item no longer found.'

  const delta = countedQuantity - current.quantity

  const updated = await db.transaction(async (tx) => {
    if (delta !== 0) {
      await tx.insert(inventoryMovements).values({
        farmId: user.farmId,
        itemId,
        delta,
        reason: 'opening_stock_count',
        recordedById: user.id,
      })
    }

    const [row] = await tx
      .update(inventoryItems)
      .set({
        quantity: countedQuantity,
        updatedAt: new Date(),
      })
      .where(eq(inventoryItems.id, itemId))
      .returning()

    return row
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'inventory_opening_count',
    entityType: 'inventory_item',
    entityId: itemId,
    metadata: {
      itemCount: 1,
      reason: 'opening_stock_count',
      source,
    },
  })

  return `✅ Opening count set: ${updated.name} → ${updated.quantity} ${updated.unit}.`
}

export async function executeConfirmedLowStockAck(
  user: SessionUser,
  payload: Record<string, unknown>,
  source = 'butler',
): Promise<string> {
  if (!canManageInventory(user)) {
    return 'Only Admin, Supervisor, or Sales can acknowledge low stock.'
  }

  const rawItems = Array.isArray(payload.items) ? payload.items : []
  const items: LowStockItemPayload[] = rawItems
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null
      const row = entry as Record<string, unknown>
      const itemId = String(row.itemId ?? '')
      const name = String(row.name ?? '').trim()
      const quantity = Number(row.quantity)
      const reorderLevel = Number(row.reorderLevel)
      if (!itemId || !name || !Number.isFinite(quantity) || !Number.isFinite(reorderLevel)) {
        return null
      }
      return { itemId, name, quantity, reorderLevel }
    })
    .filter((row): row is LowStockItemPayload => row != null)

  if (items.length === 0) return 'Draft was missing low-stock items.'

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'inventory_low_stock_ack',
    entityType: 'inventory_item',
    metadata: {
      itemCount: items.length,
      itemIds: items.map((item) => item.itemId),
      source,
    },
  })

  const list = items
    .map((item) => `• ${item.name}: ${item.quantity} (reorder ${item.reorderLevel})`)
    .join('\n')

  return `✅ Low stock acknowledged (${items.length}):\n${list}`
}

/** Apply a confirmed inventory draft. Returns null if unknown type. */
export async function applyConfirmedInventoryDraft(
  user: SessionUser,
  actionType: string,
  payload: Record<string, unknown>,
  source = 'butler',
  locale?: ContentLocaleMeta,
): Promise<string | null> {
  if (actionType === 'stock_move') return executeConfirmedStockMove(user, payload, source, locale)
  if (actionType === 'opening_count') return executeConfirmedOpeningCount(user, payload, source)
  if (actionType === 'low_stock_ack') return executeConfirmedLowStockAck(user, payload, source)
  return null
}
