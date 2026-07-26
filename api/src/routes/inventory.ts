import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  inventoryCountLines,
  inventoryCountSessions,
  inventoryItems,
  inventoryMovements,
  users,
} from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canApproveTasks, canAssignTasks, canManageInventory } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import {
  authorLocaleForUserId,
  authorLocaleHint,
  toCanonicalEnglish,
  toViewerLocaleMany,
} from '../lib/content-locale.js'
import { resolveStaffReplyLocale } from '../lib/reply-locale.js'
import { contentLocaleValues, mergeContentLocale, type ContentLocaleMeta } from '../lib/task-drafts.js'

const INVENTORY_UNITS = ['kg', 'bags', 'liters', 'units', 'crates'] as const

/**
 * Prose on a count session: where the count happened and why it was rejected.
 * A count line's `notes` is prose too, but each line is its own row with its own
 * locale pair, so it is normalized per line rather than with the session.
 *
 * `itemName`, `category` and `unit` on a line are register keys and an enum —
 * `verify` creates missing inventory items straight from `itemName`, so a
 * translated one would open a duplicate item per language. An item created that
 * way carries no prose, so its own pair stays on the schema defaults.
 */
const COUNT_SESSION_TEXT_FIELDS = ['locationText', 'rejectionReason'] as const

/**
 * The only prose on an item: where the storekeeper says it is kept. `name` and
 * `category` are the register keys a count line is matched by, `supplier` is a
 * trading name and `batchNumber` an identifier.
 */
const INVENTORY_ITEM_TEXT_FIELDS = ['storageLocation'] as const

/**
 * Machine markers that share `inventory_movements.reason` with worker prose.
 * The stock paths write these exact strings and `lib/translation-retry.ts` holds
 * the same list, which is what keeps the retry job from translating them: a
 * hand-typed reason that happens to match one would be labelled with a source
 * locale the job then refuses to sweep, so it is stored verbatim instead.
 */
const MOVEMENT_REASON_SENTINELS: ReadonlySet<string> = new Set([
  'opening_stock_count',
  'task_consumption',
  'goods_receipt',
  'verified_count_session',
])

/** Concurrent canonicalization calls when a count sheet has many noted lines. */
const WRITE_CONCURRENCY = 4

const createItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  unit: z.enum(INVENTORY_UNITS),
  quantity: z.number().int().min(0).default(0),
  reorderLevel: z.number().int().min(0).default(10),
  costPerUnit: z.number().int().min(0).nullable().optional(),
  supplier: z.string().trim().max(200).nullable().optional(),
  expiryDate: z.string().datetime().nullable().optional(),
  storageLocation: z.string().trim().max(200).nullable().optional(),
  batchNumber: z.string().trim().max(100).nullable().optional(),
})

// No `quantity`: stock is owned by the movement and count ledger, and a value
// set here would move it with no movement row standing behind the change.
const updateItemSchema = createItemSchema.omit({ quantity: true }).partial()

const movementSchema = z.object({
  itemId: z.string().uuid(),
  delta: z.number().int().refine((n) => n !== 0, 'Delta must be non-zero'),
  reason: z.string().min(1).max(500),
})

// No per-item `notes` field: the movement this endpoint writes carries only the
// `opening_stock_count` sentinel in its one text column, so a note here had
// nowhere to go and was accepted and dropped. Declaring it again would promise
// storage that does not exist. A count that needs prose is a count session,
// whose lines each have their own notes column.
const openingCountSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        countedQuantity: z.number().int().min(0),
      }),
    )
    .min(1),
})

const countSessionSchema = z.object({
  taskId: z.string().uuid().nullable().optional(),
  locationText: z.string().trim().max(500).nullable().optional(),
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid().nullable().optional(),
        itemName: z.string().trim().min(1).max(200),
        category: z.string().trim().min(1).max(100).default('supplies'),
        unit: z.enum(INVENTORY_UNITS).default('units'),
        countedQuantity: z.number().int().min(0),
        notes: z.string().max(500).nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
})

const verifyCountSchema = z.object({
  status: z.enum(['verified', 'rejected']),
  rejectionReason: z.string().trim().min(5).max(2000).nullable().optional(),
})

async function preferredLocaleForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row?.preferredLocale ?? null
}

type Canonical = { english?: string; locale: ContentLocaleMeta }

const NO_TEXT: Canonical = { locale: { sourceLocale: null, translationStatus: 'done' } }

/**
 * Normalize one piece of free text to English for storage.
 *
 * A failure yields the author's own words at status 'pending' so the retry job
 * repairs the row later, and the locale hint is kept rather than widened to
 * 'en': the job filters English rows out, so mislabelling one makes the wrong
 * language permanent.
 */
async function canonicalText(
  text: string | null | undefined,
  farmId: string,
  sourceLocale: string | null,
): Promise<Canonical> {
  if (typeof text !== 'string' || text.trim() === '') return NO_TEXT
  try {
    const result = await toCanonicalEnglish({ text, farmId, sourceLocale })
    return {
      english: result.english,
      locale: { sourceLocale: result.sourceLocale, translationStatus: result.status },
    }
  } catch {
    // A translation failure must never fail the write it serves.
    return { english: text, locale: { sourceLocale, translationStatus: 'pending' } }
  }
}

/**
 * Normalize a list of independent prose values, a few calls at a time: a
 * 200-line count sheet must not open 200 concurrent LLM calls because one
 * storekeeper pressed save. Each value lands on its own row, so each keeps its
 * own locale pair rather than being folded into a shared one.
 */
async function canonicalTexts(
  texts: (string | null | undefined)[],
  farmId: string,
  sourceLocale: string | null,
): Promise<Canonical[]> {
  const out: Canonical[] = []
  for (let i = 0; i < texts.length; i += WRITE_CONCURRENCY) {
    out.push(
      ...(await Promise.all(
        texts
          .slice(i, i + WRITE_CONCURRENCY)
          .map((text) => canonicalText(text, farmId, sourceLocale)),
      )),
    )
  }
  return out
}

/**
 * Render prose in the viewer's language with ONE batched translation call per
 * response: every string across every row is collected first, translated
 * together (the service deduplicates and reads its cache in a single query),
 * then mapped back by position. An English viewer short-circuits before any of
 * this work.
 */
async function localizeRows<T extends object>(
  rows: T[],
  fields: readonly (keyof T & string)[],
  farmId: string,
  targetLocale: string | null,
): Promise<T[]> {
  if (resolveStaffReplyLocale(targetLocale) === 'en') return rows
  if (rows.length === 0 || fields.length === 0) return rows

  const texts: string[] = []
  for (const row of rows) {
    for (const field of fields) {
      const value = row[field]
      if (typeof value === 'string' && value !== '') texts.push(value)
    }
  }
  if (texts.length === 0) return rows

  const translated = await toViewerLocaleMany({ texts, targetLocale, farmId })

  let cursor = 0
  return rows.map((row) => {
    const out = { ...row }
    for (const field of fields) {
      const value = row[field]
      if (typeof value === 'string' && value !== '') {
        ;(out as Record<string, unknown>)[field] = translated[cursor++]
      }
    }
    return out
  })
}

export const inventoryRoutes = new Hono<{ Variables: AppVariables }>()

inventoryRoutes.use('*', authMiddleware)

inventoryRoutes.get('/', async (c) => {
  const user = c.get('user')
  const items = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.farmId, user.farmId))
    .orderBy(inventoryItems.name)

  const enriched = items.map((item) => ({
    ...item,
    lowStock: item.quantity <= item.reorderLevel,
  }))

  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(
    enriched,
    INVENTORY_ITEM_TEXT_FIELDS,
    user.farmId,
    viewerLocale,
  )

  return c.json({ items: localized })
})

inventoryRoutes.post('/items', zValidator('json', createItemSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const canonical = await canonicalText(
    body.storageLocation,
    user.farmId,
    await authorLocaleForUserId(user.id),
  )

  const [item] = await db
    .insert(inventoryItems)
    .values({
      farmId: user.farmId,
      name: body.name,
      category: body.category,
      unit: body.unit,
      quantity: body.quantity,
      reorderLevel: body.reorderLevel,
      costPerUnit: body.costPerUnit ?? null,
      supplier: body.supplier ?? null,
      expiryDate: body.expiryDate ? new Date(body.expiryDate) : null,
      storageLocation: canonical.english ?? body.storageLocation ?? null,
      ...contentLocaleValues(canonical.locale),
      batchNumber: body.batchNumber ?? null,
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'inventory_item',
    entityId: item.id,
    metadata: { name: item.name },
  })

  // The author reads back their own words; the row holds the English.
  return c.json(
    { item: { ...item, storageLocation: body.storageLocation ?? item.storageLocation } },
    201,
  )
})

inventoryRoutes.patch('/items/:id', zValidator('json', updateItemSchema), async (c) => {
  const user = c.get('user')
  if (!canManageInventory(user)) return c.json({ error: 'Forbidden' }, 403)

  const itemId = c.req.param('id')
  const [existing] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Item not found' }, 404)

  const body = c.req.valid('json')
  const viewerLocale = await preferredLocaleForUser(user.id)
  const canonical = await canonicalText(
    body.storageLocation,
    user.farmId,
    authorLocaleHint(viewerLocale),
  )

  const updates: Partial<typeof existing> = { updatedAt: new Date() }
  if (body.name !== undefined) updates.name = body.name
  if (body.category !== undefined) updates.category = body.category
  if (body.unit !== undefined) updates.unit = body.unit
  if (body.reorderLevel !== undefined) updates.reorderLevel = body.reorderLevel
  if (body.costPerUnit !== undefined) updates.costPerUnit = body.costPerUnit
  if (body.supplier !== undefined) updates.supplier = body.supplier
  if (body.expiryDate !== undefined) {
    updates.expiryDate = body.expiryDate ? new Date(body.expiryDate) : null
  }
  if (body.storageLocation !== undefined) {
    updates.storageLocation = canonical.english ?? body.storageLocation
    // A row the retry job still owes work on keeps its own bookkeeping: the new
    // location can escalate the pair to 'pending' but never back to 'done'.
    Object.assign(updates, mergeContentLocale(existing, canonical.locale))
  }
  if (body.batchNumber !== undefined) updates.batchNumber = body.batchNumber

  const [item] = await db
    .update(inventoryItems)
    .set(updates)
    .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.farmId, user.farmId)))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'inventory_item',
    entityId: itemId,
    metadata: { name: item.name },
  })

  // A location this author just typed comes back in their own words; one they
  // left alone is someone else's canonical English rendered for this viewer.
  if (body.storageLocation !== undefined) {
    return c.json({ item: { ...item, storageLocation: body.storageLocation } })
  }

  const [localized] = await localizeRows(
    [item],
    INVENTORY_ITEM_TEXT_FIELDS,
    user.farmId,
    viewerLocale,
  )
  return c.json({ item: localized })
})

inventoryRoutes.post('/movements', zValidator('json', movementSchema), async (c) => {
  const user = c.get('user')
  if (!canManageInventory(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const [item] = await db
    .select()
    .from(inventoryItems)
    .where(and(eq(inventoryItems.id, body.itemId), eq(inventoryItems.farmId, user.farmId)))
    .limit(1)

  if (!item) return c.json({ error: 'Item not found' }, 404)

  const newQty = item.quantity + body.delta
  if (newQty < 0) return c.json({ error: 'Insufficient stock' }, 400)

  const viewerLocale = await preferredLocaleForUser(user.id)

  // The reason a person typed is prose; the markers the stock paths write into
  // the same column are not.
  const canonical = MOVEMENT_REASON_SENTINELS.has(body.reason.trim())
    ? NO_TEXT
    : await canonicalText(body.reason, user.farmId, authorLocaleHint(viewerLocale))
  const reason = canonical.english ?? body.reason

  const updated = await db.transaction(async (tx) => {
    await tx.insert(inventoryMovements).values({
      farmId: user.farmId,
      itemId: body.itemId,
      delta: body.delta,
      reason,
      ...contentLocaleValues(canonical.locale),
      recordedById: user.id,
    })

    const [row] = await tx
      .update(inventoryItems)
      .set({ quantity: newQty, updatedAt: new Date() })
      .where(eq(inventoryItems.id, body.itemId))
      .returning()

    return row
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'inventory_movement',
    entityType: 'inventory_item',
    entityId: body.itemId,
    metadata: { delta: body.delta, reason },
  })

  // A stock move writes no text onto the item, so its storage location is
  // someone else's canonical English rendered for this viewer.
  const [localized] = await localizeRows(
    [updated],
    INVENTORY_ITEM_TEXT_FIELDS,
    user.farmId,
    viewerLocale,
  )
  return c.json({ item: localized })
})

inventoryRoutes.post('/opening-count', zValidator('json', openingCountSchema), async (c) => {
  const user = c.get('user')
  if (!canManageInventory(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const itemIds = [...new Set(body.items.map((item) => item.itemId))]

  const existingItems = await db
    .select()
    .from(inventoryItems)
    .where(eq(inventoryItems.farmId, user.farmId))
  const byId = new Map(existingItems.map((item) => [item.id, item]))

  for (const id of itemIds) {
    if (!byId.has(id)) return c.json({ error: `Item not found: ${id}` }, 404)
  }

  const updatedItems = await db.transaction(async (tx) => {
    const nextRows: typeof existingItems = []
    for (const entry of body.items) {
      const current = byId.get(entry.itemId)
      if (!current) continue
      const delta = entry.countedQuantity - current.quantity

      if (delta !== 0) {
        await tx.insert(inventoryMovements).values({
          farmId: user.farmId,
          itemId: entry.itemId,
          delta,
          // Machine sentinel, not prose: it stays English and 'done'. Nothing
          // on this path is author-written, so there is nothing to normalize.
          reason: 'opening_stock_count',
          recordedById: user.id,
        })
      }

      const [updated] = await tx
        .update(inventoryItems)
        .set({
          quantity: entry.countedQuantity,
          updatedAt: new Date(),
        })
        .where(eq(inventoryItems.id, entry.itemId))
        .returning()
      nextRows.push(updated)
    }
    return nextRows
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'inventory_opening_count',
    entityType: 'inventory_item',
    metadata: {
      itemCount: body.items.length,
      reason: 'opening_stock_count',
    },
  })

  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(
    updatedItems,
    INVENTORY_ITEM_TEXT_FIELDS,
    user.farmId,
    viewerLocale,
  )

  return c.json({ items: localized })
})

inventoryRoutes.get('/count-sessions', async (c) => {
  const user = c.get('user')
  const sessions = await db
    .select()
    .from(inventoryCountSessions)
    .where(eq(inventoryCountSessions.farmId, user.farmId))
    .orderBy(desc(inventoryCountSessions.createdAt))
    .limit(50)
  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(
    sessions,
    COUNT_SESSION_TEXT_FIELDS,
    user.farmId,
    viewerLocale,
  )
  return c.json({ sessions: localized })
})

inventoryRoutes.post('/count-sessions', zValidator('json', countSessionSchema), async (c) => {
  const user = c.get('user')
  const body = c.req.valid('json')

  const authorLocale = await authorLocaleForUserId(user.id)
  const location = await canonicalText(body.locationText, user.farmId, authorLocale)
  const lineNotes = await canonicalTexts(
    body.lines.map((line) => line.notes),
    user.farmId,
    authorLocale,
  )

  const session = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(inventoryCountSessions)
      .values({
        farmId: user.farmId,
        taskId: body.taskId ?? null,
        locationText: location.english ?? body.locationText ?? null,
        ...contentLocaleValues(location.locale),
        status: 'submitted',
        recordedById: user.id,
      })
      .returning()

    for (const [index, line] of body.lines.entries()) {
      const note = lineNotes[index]
      await tx.insert(inventoryCountLines).values({
        sessionId: row.id,
        itemId: line.itemId ?? null,
        itemName: line.itemName,
        category: line.category,
        unit: line.unit,
        countedQuantity: line.countedQuantity,
        notes: note.english ?? line.notes ?? null,
        // Each line is its own row, so it carries its own locale pair: one line
        // the LLM could not translate must not leave the other 199 pending.
        ...contentLocaleValues(note.locale),
      })
    }

    return row
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'inventory_count_submit',
    entityType: 'inventory_count_session',
    entityId: session.id,
  })

  // The author reads back their own words; the row holds the English.
  return c.json(
    { session: { ...session, locationText: body.locationText ?? session.locationText } },
    201,
  )
})

inventoryRoutes.post(
  '/count-sessions/:id/verify',
  zValidator('json', verifyCountSchema),
  async (c) => {
    const user = c.get('user')
    if (!canApproveTasks(user)) return c.json({ error: 'Forbidden' }, 403)

    const sessionId = c.req.param('id')
    const body = c.req.valid('json')

    const [session] = await db
      .select()
      .from(inventoryCountSessions)
      .where(
        and(
          eq(inventoryCountSessions.id, sessionId),
          eq(inventoryCountSessions.farmId, user.farmId),
        ),
      )
      .limit(1)

    if (!session) return c.json({ error: 'Not found' }, 404)
    if (session.recordedById === user.id) {
      return c.json({ error: 'You cannot verify your own count session' }, 400)
    }
    if (session.status !== 'submitted') {
      return c.json({ error: 'Session already resolved' }, 400)
    }
    if (body.status === 'rejected' && !body.rejectionReason?.trim()) {
      return c.json({ error: 'rejectionReason is required' }, 400)
    }

    const viewerLocale = await preferredLocaleForUser(user.id)
    const authorLocale = authorLocaleHint(viewerLocale)

    if (body.status === 'rejected') {
      // The length check above validated the verifier's own words; the row
      // stores the canonical English.
      const canonical = await canonicalText(
        body.rejectionReason!.trim(),
        user.farmId,
        authorLocale,
      )
      const [updated] = await db
        .update(inventoryCountSessions)
        .set({
          status: 'rejected',
          verifiedById: user.id,
          verifiedAt: new Date(),
          rejectionReason: canonical.english ?? body.rejectionReason!.trim(),
          // A rejection adds a second author's text to a row that already holds
          // the storekeeper's location line, and one pair describes the whole
          // row: a reason that is not English yet escalates it to 'pending', and
          // a row the retry job still owes work on is left exactly as it is.
          ...mergeContentLocale(session, canonical.locale),
        })
        .where(eq(inventoryCountSessions.id, sessionId))
        .returning()

      // The verifier reads their own reason back; the location line, written by
      // the storekeeper, is rendered from the stored English.
      const [localized] = await localizeRows(
        [updated],
        ['locationText'],
        user.farmId,
        viewerLocale,
      )
      return c.json({
        session: { ...localized, rejectionReason: body.rejectionReason!.trim() },
      })
    }

    const lines = await db
      .select()
      .from(inventoryCountLines)
      .where(eq(inventoryCountLines.sessionId, sessionId))

    const updated = await db.transaction(async (tx) => {
      for (const line of lines) {
        let itemId = line.itemId
        if (!itemId) {
          const [created] = await tx
            .insert(inventoryItems)
            // The counted name is the register key this item will be matched by
            // from now on, so it is stored exactly as it was counted.
            .values({
              farmId: user.farmId,
              name: line.itemName,
              category: line.category,
              unit: line.unit as (typeof INVENTORY_UNITS)[number],
              quantity: 0,
            })
            .returning()
          itemId = created.id
          await tx
            .update(inventoryCountLines)
            .set({ itemId })
            .where(eq(inventoryCountLines.id, line.id))
        }

        const [item] = await tx
          .select()
          .from(inventoryItems)
          .where(and(eq(inventoryItems.id, itemId), eq(inventoryItems.farmId, user.farmId)))
          .limit(1)
        if (!item) continue

        const delta = line.countedQuantity - item.quantity
        if (delta !== 0) {
          await tx.insert(inventoryMovements).values({
            farmId: user.farmId,
            itemId,
            delta,
            // Machine sentinel, not prose: it stays English and 'done'.
            reason: 'verified_count_session',
            sourceType: 'inventory_count_line',
            sourceId: line.id,
            recordedById: user.id,
          })
        }

        await tx
          .update(inventoryItems)
          .set({ quantity: line.countedQuantity, updatedAt: new Date() })
          .where(eq(inventoryItems.id, itemId))
      }

      const [row] = await tx
        .update(inventoryCountSessions)
        .set({
          status: 'verified',
          verifiedById: user.id,
          verifiedAt: new Date(),
          rejectionReason: null,
        })
        .where(eq(inventoryCountSessions.id, sessionId))
        .returning()

      return row
    })

    await logAudit({
      farmId: user.farmId,
      userId: user.id,
      action: 'inventory_count_verify',
      entityType: 'inventory_count_session',
      entityId: sessionId,
    })

    // Approving writes no text of its own, so the whole row is someone else's
    // canonical English rendered for this verifier.
    const [localized] = await localizeRows(
      [updated],
      COUNT_SESSION_TEXT_FIELDS,
      user.farmId,
      viewerLocale,
    )
    return c.json({ session: localized })
  },
)

inventoryRoutes.get('/low-stock', async (c) => {
  const user = c.get('user')
  const items = await db
    .select()
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.farmId, user.farmId),
        sql`${inventoryItems.quantity} <= ${inventoryItems.reorderLevel}`,
      ),
    )

  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(
    items,
    INVENTORY_ITEM_TEXT_FIELDS,
    user.farmId,
    viewerLocale,
  )

  return c.json({ items: localized })
})
