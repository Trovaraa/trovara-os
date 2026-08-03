import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, eq, inArray, or } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  cropCycles,
  farmEvents,
  plantingUnits,
  plots,
  tasks,
  users,
  zones,
} from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import { normalizeCropType } from '../lib/crop-normalize.js'
import {
  authorLocaleForUserId,
  authorLocaleHint,
  toCanonicalEnglish,
  toViewerLocaleMany,
} from '../lib/content-locale.js'
import { resolveStaffReplyLocale } from '../lib/reply-locale.js'
import {
  contentLocaleValues,
  mergeContentLocale,
  type ContentLocaleMeta,
} from '../lib/task-drafts.js'

async function preferredLocaleForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row?.preferredLocale ?? null
}

/**
 * Normalize a zone's `description` or a block's `notes` to English for storage -
 * the only prose these endpoints persist, and the two columns the translation
 * retry job repairs on `zones` and `plots`.
 *
 * `cropType` is deliberately not normalized here: it is an exact lookup key
 * resolved through the deterministic crop lexicon below, so it never reaches a
 * translator. Zone and block names, block codes, planting-unit labels and unit
 * types are proper nouns or lookup keys; areas, coordinates, counts and statuses
 * are not prose.
 *
 * A translation failure yields the author's own words at 'pending' so the retry
 * job repairs the row later; it must never fail the write it serves.
 */
async function canonicalProse(
  text: string | null | undefined,
  farmId: string,
  hint: string | null,
): Promise<{ text?: string; locale: ContentLocaleMeta }> {
  if (typeof text !== 'string' || text.trim() === '') {
    return { locale: { sourceLocale: null, translationStatus: 'done' } }
  }

  try {
    const result = await toCanonicalEnglish({ text, farmId, sourceLocale: hint })
    return {
      text: result.english,
      locale: { sourceLocale: result.sourceLocale, translationStatus: result.status },
    }
  } catch {
    return { text, locale: { sourceLocale: hint, translationStatus: 'pending' } }
  }
}

/**
 * Render prose in the viewer's language with ONE batched translation call per
 * response, mapping the results back by position. An English viewer
 * short-circuits before the cache query and the LLM call.
 *
 * On these endpoints the prose is a block's `notes` and a zone's `description`,
 * the two columns their `translation_status` covers. Block and zone names, block
 * codes, `cropType`, planting-unit labels and unit types are lookup keys or
 * proper nouns; areas, coordinates, counts, statuses and event types are not
 * prose.
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

const createZoneSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
})

const updateZoneSchema = createZoneSchema.partial()

const createPlantingUnitSchema = z.object({
  plotId: z.string().uuid(),
  label: z.string().min(1).max(200),
  unitType: z.string().min(1).max(100),
  status: z.string().max(50).optional(),
  plantedAt: z.string().datetime().optional(),
})

const updatePlantingUnitSchema = createPlantingUnitSchema.partial().omit({ plotId: true })

const createBlockSchema = z.object({
  zoneId: z.string().uuid(),
  name: z.string().min(1).max(200),
  code: z.string().max(50).optional(),
  notes: z.string().max(5000).optional(),
  areaAcres: z.string().max(50).optional(),
  cropType: z.string().max(100).optional(),
  cropVariety: z.string().max(100).optional(),
  latitude: z.string().max(50).optional(),
  longitude: z.string().max(50).optional(),
})

const updateBlockSchema = createBlockSchema.partial().omit({ zoneId: true }).extend({
  zoneId: z.string().uuid().optional(),
})

export const zoneRoutes = new Hono<{ Variables: AppVariables }>()

zoneRoutes.use('*', authMiddleware)

zoneRoutes.get('/planting-units', async (c) => {
  const user = c.get('user')
  const plotId = c.req.query('plotId')

  const conditions = [eq(plantingUnits.farmId, user.farmId)]
  if (plotId) {
    conditions.push(eq(plantingUnits.plotId, plotId))
  }

  const rows = await db
    .select({
      id: plantingUnits.id,
      plotId: plantingUnits.plotId,
      plotName: plots.name,
      label: plantingUnits.label,
      unitType: plantingUnits.unitType,
      status: plantingUnits.status,
      plantedAt: plantingUnits.plantedAt,
      createdAt: plantingUnits.createdAt,
    })
    .from(plantingUnits)
    .leftJoin(plots, eq(plantingUnits.plotId, plots.id))
    .where(and(...conditions))
    .orderBy(plantingUnits.label)

  return c.json({ plantingUnits: rows })
})

zoneRoutes.post('/planting-units', zValidator('json', createPlantingUnitSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')

  const [plot] = await db
    .select()
    .from(plots)
    .where(and(eq(plots.id, body.plotId), eq(plots.farmId, user.farmId)))
    .limit(1)

  if (!plot) return c.json({ error: 'Invalid plot' }, 400)

  const [unit] = await db
    .insert(plantingUnits)
    .values({
      farmId: user.farmId,
      plotId: body.plotId,
      label: body.label,
      unitType: body.unitType,
      status: body.status ?? 'active',
      plantedAt: body.plantedAt ? new Date(body.plantedAt) : undefined,
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'planting_unit',
    entityId: unit.id,
  })

  return c.json({ plantingUnit: unit }, 201)
})

zoneRoutes.patch('/planting-units/:id', zValidator('json', updatePlantingUnitSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const unitId = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(plantingUnits)
    .where(and(eq(plantingUnits.id, unitId), eq(plantingUnits.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  const updates: Partial<typeof existing> = {}
  if (body.label !== undefined) updates.label = body.label
  if (body.unitType !== undefined) updates.unitType = body.unitType
  if (body.status !== undefined) updates.status = body.status
  if (body.plantedAt !== undefined) updates.plantedAt = new Date(body.plantedAt)

  const [unit] = await db
    .update(plantingUnits)
    .set(updates)
    .where(eq(plantingUnits.id, unitId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'planting_unit',
    entityId: unitId,
  })

  return c.json({ plantingUnit: unit })
})

zoneRoutes.delete('/planting-units/:id', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const unitId = c.req.param('id')

  const [existing] = await db
    .select()
    .from(plantingUnits)
    .where(and(eq(plantingUnits.id, unitId), eq(plantingUnits.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.delete(plantingUnits).where(eq(plantingUnits.id, unitId))

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'planting_unit',
    entityId: unitId,
  })

  return c.json({ ok: true })
})

zoneRoutes.get('/plots', async (c) => {
  const user = c.get('user')
  const zoneId = c.req.query('zoneId')
  const includeArchived = c.req.query('includeArchived') === '1'

  const conditions = [eq(plots.farmId, user.farmId)]
  if (zoneId) conditions.push(eq(plots.zoneId, zoneId))
  if (!includeArchived) conditions.push(eq(plots.active, true))

  const rows = await db
    .select({
      id: plots.id,
      name: plots.name,
      code: plots.code,
      notes: plots.notes,
      zoneId: plots.zoneId,
      zoneName: zones.name,
      cropType: plots.cropType,
      cropVariety: plots.cropVariety,
      areaAcres: plots.areaAcres,
      plantCount: plots.plantCount,
      latitude: plots.latitude,
      longitude: plots.longitude,
      active: plots.active,
      archivedAt: plots.archivedAt,
      createdAt: plots.createdAt,
      updatedAt: plots.updatedAt,
    })
    .from(plots)
    .leftJoin(zones, eq(plots.zoneId, zones.id))
    .where(and(...conditions))
    .orderBy(plots.name)

  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(rows, ['notes'], user.farmId, viewerLocale)

  return c.json({ plots: localized, blocks: localized })
})

zoneRoutes.post('/plots', zValidator('json', createBlockSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  const [zone] = await db
    .select()
    .from(zones)
    .where(and(eq(zones.id, body.zoneId), eq(zones.farmId, user.farmId)))
    .limit(1)
  if (!zone) return c.json({ error: 'Invalid zone' }, 400)

  const typedNotes = body.notes?.trim() || null
  const canonical = await canonicalProse(
    typedNotes,
    user.farmId,
    await authorLocaleForUserId(user.id),
  )

  const [block] = await db
    .insert(plots)
    .values({
      farmId: user.farmId,
      zoneId: body.zoneId,
      name: body.name.trim(),
      code: body.code?.trim() || null,
      notes: canonical.text ?? typedNotes,
      ...contentLocaleValues(canonical.locale),
      // The lifecycle and advisory lookups exact-match this string against their
      // English keys, so a block crop typed in the operator's own language is
      // resolved here, the same way crop cycles do it. Crops we have no playbook
      // for are stored as typed.
      cropType: normalizeCropType(body.cropType?.trim() || 'mixed').canonical,
      cropVariety: body.cropVariety?.trim() || null,
      areaAcres: body.areaAcres?.trim() || null,
      latitude: body.latitude?.trim() || null,
      longitude: body.longitude?.trim() || null,
      active: true,
      updatedAt: new Date(),
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'block',
    entityId: block.id,
  })

  // The author reads back their own words; the row holds the English.
  const created = { ...block, notes: typedNotes ?? block.notes }

  return c.json({ plot: created, block: created }, 201)
})

zoneRoutes.patch('/plots/:plotId', zValidator('json', updateBlockSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const plotId = c.req.param('plotId')
  const body = c.req.valid('json')
  const [existing] = await db
    .select()
    .from(plots)
    .where(and(eq(plots.id, plotId), eq(plots.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  if (body.zoneId) {
    const [zone] = await db
      .select()
      .from(zones)
      .where(and(eq(zones.id, body.zoneId), eq(zones.farmId, user.farmId)))
      .limit(1)
    if (!zone) return c.json({ error: 'Invalid zone' }, 400)
  }

  const viewerLocale = await preferredLocaleForUser(user.id)
  const authorLocale = authorLocaleHint(viewerLocale)
  const typedNotes = body.notes !== undefined ? body.notes?.trim() || null : undefined
  const canonical = await canonicalProse(typedNotes, user.farmId, authorLocale)

  const updates: Partial<typeof existing> = { updatedAt: new Date() }
  if (body.zoneId !== undefined) updates.zoneId = body.zoneId
  if (body.name !== undefined) updates.name = body.name.trim()
  if (body.code !== undefined) updates.code = body.code?.trim() || null
  if (typedNotes !== undefined) {
    updates.notes = canonical.text ?? typedNotes
    // Escalates a row to 'pending' but never downgrades one the retry job still
    // owes work on. A patch that carries no notes never touches the pair.
    Object.assign(updates, mergeContentLocale(existing, canonical.locale))
  }
  if (body.areaAcres !== undefined) updates.areaAcres = body.areaAcres?.trim() || null
  if (body.cropType !== undefined) {
    updates.cropType = normalizeCropType(body.cropType.trim() || 'mixed').canonical
  }
  if (body.cropVariety !== undefined) updates.cropVariety = body.cropVariety?.trim() || null
  if (body.latitude !== undefined) updates.latitude = body.latitude?.trim() || null
  if (body.longitude !== undefined) updates.longitude = body.longitude?.trim() || null

  const [block] = await db.update(plots).set(updates).where(eq(plots.id, plotId)).returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'block',
    entityId: plotId,
  })

  // Notes this author just wrote are echoed in their own words (no round trip);
  // a patch that left them alone renders the stored English for the viewer.
  const [localized] = await localizeRows(
    [block],
    typedNotes !== undefined ? [] : ['notes'],
    user.farmId,
    viewerLocale,
  )
  const patched = typedNotes !== undefined ? { ...localized, notes: typedNotes } : localized

  return c.json({ plot: patched, block: patched })
})

zoneRoutes.post('/plots/:plotId/archive', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const plotId = c.req.param('plotId')
  const [existing] = await db
    .select()
    .from(plots)
    .where(and(eq(plots.id, plotId), eq(plots.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const [block] = await db
    .update(plots)
    .set({ active: false, archivedAt: new Date(), updatedAt: new Date() })
    .where(eq(plots.id, plotId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'archive',
    entityType: 'block',
    entityId: plotId,
  })

  // Archiving writes no text, so the notes on the row are someone's canonical
  // English and are rendered for whoever is reading them.
  const viewerLocale = await preferredLocaleForUser(user.id)
  const [localized] = await localizeRows([block], ['notes'], user.farmId, viewerLocale)

  return c.json({ plot: localized, block: localized })
})

zoneRoutes.get('/plots/:plotId/timeline', async (c) => {
  const user = c.get('user')
  const plotId = c.req.param('plotId')

  const [plot] = await db
    .select()
    .from(plots)
    .where(and(eq(plots.id, plotId), eq(plots.farmId, user.farmId)))
    .limit(1)

  if (!plot) return c.json({ error: 'Not found' }, 404)

  const plotTasks = await db
    .select({
      id: tasks.id,
      kind: tasks.status,
      title: tasks.title,
      status: tasks.status,
      eventType: tasks.status,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(and(eq(tasks.farmId, user.farmId), eq(tasks.plotId, plotId)))

  const plotCropCycles = await db
    .select({ id: cropCycles.id })
    .from(cropCycles)
    .where(and(eq(cropCycles.farmId, user.farmId), eq(cropCycles.plotId, plotId)))

  const cycleIds = plotCropCycles.map((c) => c.id)
  const plotTaskIds = plotTasks.map((t) => t.id)

  const entityFilters = [
    and(eq(farmEvents.entityType, 'plot'), eq(farmEvents.entityId, plotId)),
  ]

  if (cycleIds.length > 0) {
    entityFilters.push(
      and(eq(farmEvents.entityType, 'crop_cycle'), inArray(farmEvents.entityId, cycleIds)),
    )
  }

  if (plotTaskIds.length > 0) {
    entityFilters.push(
      and(eq(farmEvents.entityType, 'task'), inArray(farmEvents.entityId, plotTaskIds)),
    )
  }

  const allEvents =
    entityFilters.length > 0
      ? await db
          .select({
            id: farmEvents.id,
            kind: farmEvents.eventType,
            title: farmEvents.eventType,
            status: farmEvents.approvalStatus,
            eventType: farmEvents.eventType,
            createdAt: farmEvents.createdAt,
          })
          .from(farmEvents)
          .where(and(eq(farmEvents.farmId, user.farmId), or(...entityFilters)))
      : []

  // A farm event's `title` is its event type, a machine key the client renders,
  // so task titles are the only prose on this endpoint.
  const viewerLocale = await preferredLocaleForUser(user.id)
  const localizedTasks = await localizeRows(plotTasks, ['title'], user.farmId, viewerLocale)

  const timeline = [
    ...localizedTasks.map((t) => ({
      id: t.id,
      type: 'task' as const,
      title: t.title,
      status: t.status,
      eventType: null as string | null,
      createdAt: t.createdAt,
    })),
    ...allEvents.map((e) => ({
      id: e.id,
      type: 'farm_event' as const,
      title: e.title,
      status: e.status,
      eventType: e.eventType,
      createdAt: e.createdAt,
    })),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  return c.json({ plotId, timeline })
})

zoneRoutes.get('/', async (c) => {
  const user = c.get('user')
  // Match Zones UI (managerOnly): farm layout listing is ops, not sales.
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const rows = await db
    .select()
    .from(zones)
    .where(eq(zones.farmId, user.farmId))
    .orderBy(zones.name)

  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(rows, ['description'], user.farmId, viewerLocale)

  return c.json({ zones: localized })
})

zoneRoutes.get('/:id', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)
  const zoneId = c.req.param('id')

  const [zone] = await db
    .select()
    .from(zones)
    .where(and(eq(zones.id, zoneId), eq(zones.farmId, user.farmId)))
    .limit(1)

  if (!zone) return c.json({ error: 'Not found' }, 404)

  const viewerLocale = await preferredLocaleForUser(user.id)
  const [localized] = await localizeRows([zone], ['description'], user.farmId, viewerLocale)

  return c.json({ zone: localized })
})

zoneRoutes.post('/', zValidator('json', createZoneSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')

  const canonical = await canonicalProse(
    body.description,
    user.farmId,
    await authorLocaleForUserId(user.id),
  )

  const [zone] = await db
    .insert(zones)
    .values({
      farmId: user.farmId,
      name: body.name,
      description: canonical.text ?? body.description,
      ...contentLocaleValues(canonical.locale),
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'zone',
    entityId: zone.id,
  })

  // The author reads back their own words; the row holds the English.
  return c.json({ zone: { ...zone, description: body.description ?? zone.description } }, 201)
})

zoneRoutes.patch('/:id', zValidator('json', updateZoneSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const zoneId = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(zones)
    .where(and(eq(zones.id, zoneId), eq(zones.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  const viewerLocale = await preferredLocaleForUser(user.id)
  const authorLocale = authorLocaleHint(viewerLocale)
  const canonical = await canonicalProse(body.description, user.farmId, authorLocale)

  const updates: Partial<typeof existing> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.description !== undefined) {
    updates.description = canonical.text ?? body.description
    // Escalates a row to 'pending' but never downgrades one the retry job still
    // owes work on. A rename that carries no description never touches the pair.
    Object.assign(updates, mergeContentLocale(existing, canonical.locale))
  }

  const [zone] = await db
    .update(zones)
    .set(updates)
    .where(eq(zones.id, zoneId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'zone',
    entityId: zoneId,
  })

  // A description this author just wrote is echoed in their own words (no round
  // trip); a rename renders the stored English for the viewer.
  const [localized] = await localizeRows(
    [zone],
    body.description !== undefined ? [] : ['description'],
    user.farmId,
    viewerLocale,
  )

  return c.json({
    zone:
      body.description !== undefined
        ? { ...localized, description: body.description }
        : localized,
  })
})

zoneRoutes.delete('/:id', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const zoneId = c.req.param('id')

  const [existing] = await db
    .select()
    .from(zones)
    .where(and(eq(zones.id, zoneId), eq(zones.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  const [activeBlock] = await db
    .select({ id: plots.id })
    .from(plots)
    .where(and(eq(plots.zoneId, zoneId), eq(plots.active, true)))
    .limit(1)
  if (activeBlock) {
    return c.json({ error: 'Archive or move all blocks in this zone before deleting it' }, 400)
  }

  const linkedBlocks = await db
    .select({ id: plots.id })
    .from(plots)
    .where(eq(plots.zoneId, zoneId))
  if (linkedBlocks.length > 0) {
    return c.json(
      { error: 'Zone still has archived blocks; keep the zone for historical references' },
      400,
    )
  }

  await db.delete(zones).where(eq(zones.id, zoneId))

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'zone',
    entityId: zoneId,
  })

  return c.json({ ok: true })
})
