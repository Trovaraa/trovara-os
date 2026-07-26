import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { suppliers, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import {
  authorLocaleForUserId,
  authorLocaleHint,
  toCanonicalEnglish,
  toViewerLocaleMany,
} from '../lib/content-locale.js'
import { resolveStaffReplyLocale } from '../lib/reply-locale.js'
import { contentLocaleValues, mergeContentLocale, type ContentLocaleMeta } from '../lib/task-drafts.js'

/**
 * The only prose on a supplier. `name` is the supplier's own trading name and
 * `phone`/`email` are contact identifiers, so none of them ever reaches a
 * translator: a purchase order printed for "Ogun Feeds Ltd" must say that in
 * every language, and the register is sorted and matched on the stored name.
 */
const SUPPLIER_TEXT_FIELDS = ['notes'] as const
type SupplierTextField = (typeof SUPPLIER_TEXT_FIELDS)[number]

const supplierSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(50).nullable().optional(),
  email: z.string().trim().email().max(320).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  active: z.boolean().optional(),
})

async function preferredLocaleForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row?.preferredLocale ?? null
}

type CanonicalNotes = {
  text: Partial<Record<SupplierTextField, string>>
  locale: ContentLocaleMeta
}

/**
 * Normalize supplier notes to English for storage.
 *
 * A failure yields the author's own words at status 'pending' so the retry job
 * repairs the row later; the locale hint is kept (never widened to 'en'),
 * because a row labelled English is one the job filters out forever.
 */
async function canonicalNotes(
  notes: string | null | undefined,
  farmId: string,
  sourceLocale: string | null,
): Promise<CanonicalNotes> {
  if (typeof notes !== 'string' || notes.trim() === '') {
    return { text: {}, locale: { sourceLocale: null, translationStatus: 'done' } }
  }

  try {
    const result = await toCanonicalEnglish({ text: notes, farmId, sourceLocale })
    return {
      text: { notes: result.english },
      locale: { sourceLocale: result.sourceLocale, translationStatus: result.status },
    }
  } catch {
    // A translation failure must never fail the write it serves.
    return { text: { notes }, locale: { sourceLocale, translationStatus: 'pending' } }
  }
}

/**
 * Render supplier prose in the viewer's language with ONE batched translation
 * call per response: every string across every row is collected first,
 * translated together (the service deduplicates and reads its cache in a single
 * query), then mapped back by position. An English viewer short-circuits before
 * any of this work.
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

export const supplierRoutes = new Hono<{ Variables: AppVariables }>()

supplierRoutes.use('*', authMiddleware)

supplierRoutes.get('/', async (c) => {
  const user = c.get('user')
  const rows = await db
    .select()
    .from(suppliers)
    .where(eq(suppliers.farmId, user.farmId))
    .orderBy(asc(suppliers.name))
  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(rows, SUPPLIER_TEXT_FIELDS, user.farmId, viewerLocale)
  return c.json({ suppliers: localized })
})

supplierRoutes.post('/', zValidator('json', supplierSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const canonical = await canonicalNotes(
    body.notes,
    user.farmId,
    await authorLocaleForUserId(user.id),
  )
  const [supplier] = await db
    .insert(suppliers)
    .values({
      farmId: user.farmId,
      name: body.name,
      phone: body.phone ?? null,
      email: body.email ?? null,
      notes: canonical.text.notes ?? body.notes ?? null,
      ...contentLocaleValues(canonical.locale),
      active: body.active ?? true,
    })
    .returning()
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'supplier',
    entityId: supplier.id,
  })
  // The author reads back their own words; the row holds the English.
  return c.json({ supplier: { ...supplier, notes: body.notes ?? supplier.notes } }, 201)
})

supplierRoutes.patch('/:id', zValidator('json', supplierSchema.partial()), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const supplierId = c.req.param('id')

  // Read first: the row's existing locale pair decides whether this patch may
  // relabel it, so the update cannot be a blind `set(body)` any more.
  const [existing] = await db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Supplier not found' }, 404)

  const viewerLocale = await preferredLocaleForUser(user.id)
  const authorLocale = authorLocaleHint(viewerLocale)
  const canonical = await canonicalNotes(body.notes, user.farmId, authorLocale)

  const updates: Partial<typeof existing> = { updatedAt: new Date() }
  if (body.name !== undefined) updates.name = body.name
  if (body.phone !== undefined) updates.phone = body.phone
  if (body.email !== undefined) updates.email = body.email
  if (body.active !== undefined) updates.active = body.active
  if (body.notes !== undefined) {
    updates.notes = canonical.text.notes ?? body.notes
    // Escalates the row to 'pending' but never downgrades one the retry job
    // still owes work on. A patch that clears the notes relabels nothing.
    Object.assign(updates, mergeContentLocale(existing, canonical.locale))
  }

  const [supplier] = await db
    .update(suppliers)
    .set(updates)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.farmId, user.farmId)))
    .returning()
  if (!supplier) return c.json({ error: 'Supplier not found' }, 404)
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'supplier',
    entityId: supplier.id,
  })

  // Notes this author just submitted are echoed in their own words; notes they
  // did not write are rendered from the stored English.
  if (body.notes !== undefined) {
    return c.json({ supplier: { ...supplier, notes: body.notes } })
  }
  const [localized] = await localizeRows(
    [supplier],
    SUPPLIER_TEXT_FIELDS,
    user.farmId,
    viewerLocale,
  )
  return c.json({ supplier: localized })
})
