import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { assetEvents, assets, assetLogs, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import { recordFarmEvent } from '../lib/farm-events.js'
import { processEvidenceValue, validateEvidenceRef } from '../lib/evidence-store.js'
import {
  authorLocaleForUserId,
  authorLocaleHint,
  toCanonicalEnglish,
  toViewerLocaleMany,
} from '../lib/content-locale.js'
import { resolveStaffReplyLocale } from '../lib/reply-locale.js'
import { contentLocaleValues, mergeContentLocale, type ContentLocaleMeta } from '../lib/task-drafts.js'

const ASSET_CATEGORIES = ['ppe', 'tool', 'vehicle', 'irrigation', 'other'] as const

/**
 * Prose on an asset: what the supervisor typed about it and the free-form "where
 * it lives" line.
 *
 * Nothing else on the row is prose. `name` and `assetTag` are matched lowercased
 * by `resolveAssetByQuery`, so translating either would make the asset
 * unreachable from chat; `category` and `operationalStatus` are i18n message
 * keys in the app; `manufacturer`, `model` and `serialNumber` are the
 * manufacturer's own strings; `unit`, `currency`, the costs, the dates and the
 * staff name are units, money, timestamps and a proper noun.
 */
const ASSET_TEXT_FIELDS = ['notes', 'locationText'] as const

/**
 * The only prose on a daily log. `condition` is rendered through the i18n key
 * `assets.cond.<condition>`, so translating it breaks the label lookup, and the
 * counts and verification enum carry no prose.
 */
const ASSET_LOG_TEXT_FIELDS = ['note'] as const

/** The only prose on an asset event; `eventType` is an enum and `costMinor` money. */
const ASSET_EVENT_TEXT_FIELDS = ['notes'] as const

const createAssetSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(ASSET_CATEGORIES).default('other'),
  unit: z.string().trim().min(1).max(40).default('unit'),
  quantityOwned: z.number().int().min(0).default(0),
  trackingMode: z.enum(['pool', 'individual']).default('pool'),
  assetTag: z.string().trim().max(100).nullable().optional(),
  scanCode: z.string().trim().max(200).nullable().optional(),
  manufacturer: z.string().trim().max(200).nullable().optional(),
  model: z.string().trim().max(200).nullable().optional(),
  serialNumber: z.string().trim().max(200).nullable().optional(),
  acquisitionDate: z.string().datetime().nullable().optional(),
  acquisitionCostMinor: z.number().int().min(0).nullable().optional(),
  currency: z.string().trim().max(10).nullable().optional(),
  zoneId: z.string().uuid().nullable().optional(),
  plotId: z.string().uuid().nullable().optional(),
  locationText: z.string().trim().max(500).nullable().optional(),
  operationalStatus: z.string().trim().max(100).default('operational'),
  maintenanceIntervalDays: z.number().int().min(0).nullable().optional(),
  nextServiceAt: z.string().datetime().nullable().optional(),
  assignedToId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  active: z.boolean().default(true),
})

const updateAssetSchema = createAssetSchema.partial()

const createLogSchema = z.object({
  countAvailable: z.number().int().min(0),
  countDamaged: z.number().int().min(0).default(0),
  condition: z.string().trim().min(1).max(200).default('good'),
  note: z.string().max(2000).nullable().optional(),
  photoUrl: z.string().max(2_000_000).nullable().optional(),
})

const verifyLogSchema = z.object({
  status: z.enum(['verified', 'rejected']),
  note: z.string().max(2000).nullable().optional(),
})

const assetEventSchema = z.object({
  eventType: z.enum(['service', 'repair', 'inspection', 'transfer', 'disposal']),
  eventDate: z.string().datetime().optional(),
  costMinor: z.number().int().min(0).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  evidenceUrl: z.string().max(2_000_000).nullable().optional(),
})

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

async function preferredLocaleForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row?.preferredLocale ?? null
}

type CanonicalProse<F extends string> = {
  text: Partial<Record<F, string>>
  locale: ContentLocaleMeta
}

/**
 * Normalize a write's free text to English for storage.
 *
 * Each field is its own column, so they translate as concurrent calls rather
 * than one merged prompt: an asset with notes and a location costs one round
 * trip of latency and neither field can bleed into the other's column. One
 * `source_locale`/`translation_status` pair describes the whole row, so a single
 * field the LLM could not turn into English leaves the row 'pending'.
 *
 * A failure stores the author's own words and keeps the locale hint as it was —
 * widening it to 'en' would label the row English, and the retry job filters
 * those out, making the wrong language permanent.
 */
async function toCanonicalProse<F extends string>(
  prose: Partial<Record<F, string | null | undefined>>,
  farmId: string,
  sourceLocale: string | null,
): Promise<CanonicalProse<F>> {
  const entries = (Object.entries(prose) as [F, string | null | undefined][]).filter(
    (entry): entry is [F, string] => typeof entry[1] === 'string' && entry[1].trim() !== '',
  )
  if (entries.length === 0) {
    return { text: {}, locale: { sourceLocale: null, translationStatus: 'done' } }
  }

  const results = await Promise.all(
    entries.map(async ([, text]) => {
      try {
        return await toCanonicalEnglish({ text, farmId, sourceLocale })
      } catch {
        // A translation failure must never fail the write it serves.
        return { english: text, sourceLocale, status: 'pending' as const }
      }
    }),
  )

  const text: Partial<Record<F, string>> = {}
  let pending = false
  let resolved: string | null = null
  entries.forEach(([field], index) => {
    const result = results[index]
    text[field] = result.english
    if (result.status === 'pending') pending = true
    // One pair for the whole row: a non-English locale is the informative one.
    if (!resolved || resolved === 'en') resolved = result.sourceLocale
  })

  return { text, locale: { sourceLocale: resolved, translationStatus: pending ? 'pending' : 'done' } }
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
 * response. Callers hand over every slot in the payload at once — the register
 * carries each asset's own notes next to its latest log's note — so a nested
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

export const assetRoutes = new Hono<{ Variables: AppVariables }>()

assetRoutes.use('*', authMiddleware)

// List the register with each asset's latest verified log summary. Visible to all staff.
assetRoutes.get('/', async (c) => {
  const user = c.get('user')

  const rows = await db
    .select({
      id: assets.id,
      name: assets.name,
      category: assets.category,
      unit: assets.unit,
      quantityOwned: assets.quantityOwned,
      trackingMode: assets.trackingMode,
      assetTag: assets.assetTag,
      scanCode: assets.scanCode,
      manufacturer: assets.manufacturer,
      model: assets.model,
      serialNumber: assets.serialNumber,
      acquisitionDate: assets.acquisitionDate,
      acquisitionCostMinor: assets.acquisitionCostMinor,
      currency: assets.currency,
      zoneId: assets.zoneId,
      plotId: assets.plotId,
      locationText: assets.locationText,
      operationalStatus: assets.operationalStatus,
      maintenanceIntervalDays: assets.maintenanceIntervalDays,
      nextServiceAt: assets.nextServiceAt,
      disposedAt: assets.disposedAt,
      assignedToId: assets.assignedToId,
      assignedToName: users.name,
      notes: assets.notes,
      active: assets.active,
      createdAt: assets.createdAt,
    })
    .from(assets)
    .leftJoin(users, eq(assets.assignedToId, users.id))
    .where(eq(assets.farmId, user.farmId))
    .orderBy(desc(assets.active), assets.name)

  // Logs newest-first: first seen per asset is latest activity; first verified is trusted summary.
  const logs = await db
    .select({
      id: assetLogs.id,
      assetId: assetLogs.assetId,
      logDate: assetLogs.logDate,
      countAvailable: assetLogs.countAvailable,
      countDamaged: assetLogs.countDamaged,
      condition: assetLogs.condition,
      note: assetLogs.note,
      recordedById: assetLogs.recordedById,
      recordedByName: users.name,
      verificationStatus: assetLogs.verificationStatus,
      verifiedAt: assetLogs.verifiedAt,
      createdAt: assetLogs.createdAt,
    })
    .from(assetLogs)
    .leftJoin(users, eq(assetLogs.recordedById, users.id))
    .where(eq(assetLogs.farmId, user.farmId))
    .orderBy(desc(assetLogs.createdAt))

  const latestActivityByAsset = new Map<string, (typeof logs)[number]>()
  const latestVerifiedByAsset = new Map<string, (typeof logs)[number]>()
  for (const log of logs) {
    if (!latestActivityByAsset.has(log.assetId)) latestActivityByAsset.set(log.assetId, log)
    if (log.verificationStatus === 'verified' && !latestVerifiedByAsset.has(log.assetId)) {
      latestVerifiedByAsset.set(log.assetId, log)
    }
  }

  const now = new Date()
  const enriched = rows.map((asset) => {
    const activity = latestActivityByAsset.get(asset.id) ?? null
    const latestVerified = latestVerifiedByAsset.get(asset.id) ?? null
    const loggedToday = activity ? sameDay(new Date(activity.logDate), now) : false
    return {
      ...asset,
      // Copied because the localizer writes into the response payload and a log
      // row can be reachable as more than one asset's summary.
      latestLog: latestVerified ? { ...latestVerified } : null,
      loggedToday,
      verifiedToday: loggedToday && activity?.verificationStatus === 'verified',
      todayVerificationStatus: loggedToday ? (activity?.verificationStatus ?? null) : null,
    }
  })

  const viewerLocale = await preferredLocaleForUser(user.id)
  await localizeProse(
    [
      ...proseSlots(enriched, ASSET_TEXT_FIELDS),
      ...proseSlots(
        enriched.map((asset) => asset.latestLog),
        ASSET_LOG_TEXT_FIELDS,
      ),
    ],
    user.farmId,
    viewerLocale,
  )

  return c.json({ assets: enriched })
})

assetRoutes.post('/', zValidator('json', createAssetSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')

  if (body.assignedToId) {
    const [member] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, body.assignedToId), eq(users.farmId, user.farmId)))
      .limit(1)
    if (!member) return c.json({ error: 'Invalid assignee' }, 400)
  }

  const canonical = await toCanonicalProse(
    { notes: body.notes, locationText: body.locationText },
    user.farmId,
    await authorLocaleForUserId(user.id),
  )

  const [asset] = await db
    .insert(assets)
    .values({
      farmId: user.farmId,
      name: body.name,
      category: body.category,
      unit: body.unit,
      quantityOwned: body.quantityOwned,
      trackingMode: body.trackingMode,
      assetTag: body.assetTag ?? null,
      scanCode: body.scanCode ?? null,
      manufacturer: body.manufacturer ?? null,
      model: body.model ?? null,
      serialNumber: body.serialNumber ?? null,
      acquisitionDate: body.acquisitionDate ? new Date(body.acquisitionDate) : null,
      acquisitionCostMinor: body.acquisitionCostMinor ?? null,
      currency: body.currency ?? 'NGN',
      zoneId: body.zoneId ?? null,
      plotId: body.plotId ?? null,
      locationText: canonical.text.locationText ?? body.locationText ?? null,
      operationalStatus: body.operationalStatus,
      maintenanceIntervalDays: body.maintenanceIntervalDays ?? null,
      nextServiceAt: body.nextServiceAt ? new Date(body.nextServiceAt) : null,
      assignedToId: body.assignedToId ?? null,
      notes: canonical.text.notes ?? body.notes ?? null,
      ...contentLocaleValues(canonical.locale),
      active: body.active,
      createdById: user.id,
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'asset',
    entityId: asset.id,
    metadata: { name: asset.name },
  })

  // The author reads back their own words; the row holds the English.
  return c.json(
    {
      asset: {
        ...asset,
        notes: body.notes ?? asset.notes,
        locationText: body.locationText ?? asset.locationText,
      },
    },
    201,
  )
})

assetRoutes.patch('/:id', zValidator('json', updateAssetSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const assetId = c.req.param('id')
  const [existing] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const body = c.req.valid('json')

  if (body.assignedToId) {
    const [member] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, body.assignedToId), eq(users.farmId, user.farmId)))
      .limit(1)
    if (!member) return c.json({ error: 'Invalid assignee' }, 400)
  }

  const viewerLocale = await preferredLocaleForUser(user.id)
  const authorLocale = authorLocaleHint(viewerLocale)
  const canonical = await toCanonicalProse(
    { notes: body.notes, locationText: body.locationText },
    user.farmId,
    authorLocale,
  )

  const updates: Partial<typeof existing> = { updatedAt: new Date() }
  if (body.name !== undefined) updates.name = body.name
  if (body.category !== undefined) updates.category = body.category
  if (body.unit !== undefined) updates.unit = body.unit
  if (body.quantityOwned !== undefined) updates.quantityOwned = body.quantityOwned
  if (body.trackingMode !== undefined) updates.trackingMode = body.trackingMode
  if (body.assetTag !== undefined) updates.assetTag = body.assetTag
  if (body.scanCode !== undefined) updates.scanCode = body.scanCode
  if (body.manufacturer !== undefined) updates.manufacturer = body.manufacturer
  if (body.model !== undefined) updates.model = body.model
  if (body.serialNumber !== undefined) updates.serialNumber = body.serialNumber
  if (body.acquisitionDate !== undefined) {
    updates.acquisitionDate = body.acquisitionDate ? new Date(body.acquisitionDate) : null
  }
  if (body.acquisitionCostMinor !== undefined) {
    updates.acquisitionCostMinor = body.acquisitionCostMinor
  }
  if (body.currency !== undefined) updates.currency = body.currency
  if (body.zoneId !== undefined) updates.zoneId = body.zoneId
  if (body.plotId !== undefined) updates.plotId = body.plotId
  if (body.locationText !== undefined) {
    updates.locationText = canonical.text.locationText ?? body.locationText
  }
  if (body.operationalStatus !== undefined) updates.operationalStatus = body.operationalStatus
  if (body.maintenanceIntervalDays !== undefined) {
    updates.maintenanceIntervalDays = body.maintenanceIntervalDays
  }
  if (body.nextServiceAt !== undefined) {
    updates.nextServiceAt = body.nextServiceAt ? new Date(body.nextServiceAt) : null
  }
  if (body.assignedToId !== undefined) updates.assignedToId = body.assignedToId
  if (body.notes !== undefined) updates.notes = canonical.text.notes ?? body.notes
  if (body.active !== undefined) updates.active = body.active

  // A patch that only moves a count or a date must not relabel the row, and a
  // row the retry job still owes work on is never downgraded to 'done'.
  if (Object.keys(canonical.text).length > 0) {
    Object.assign(updates, mergeContentLocale(existing, canonical.locale))
  }

  const [asset] = await db
    .update(assets)
    .set(updates)
    .where(eq(assets.id, assetId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'asset',
    entityId: assetId,
    metadata: { name: asset.name },
  })

  // Text this author just submitted is echoed in their own words; only text they
  // did not write is rendered from the stored English.
  const echo: Record<string, string | null> = {}
  if (body.notes !== undefined) echo.notes = body.notes
  if (body.locationText !== undefined) echo.locationText = body.locationText

  const payload = { ...asset }
  await localizeProse(
    proseSlots([payload], ASSET_TEXT_FIELDS.filter((field) => !(field in echo))),
    user.farmId,
    viewerLocale,
  )

  return c.json({ asset: { ...payload, ...echo } })
})

assetRoutes.get('/:id/logs', async (c) => {
  const user = c.get('user')
  const assetId = c.req.param('id')

  const [asset] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.farmId, user.farmId)))
    .limit(1)
  if (!asset) return c.json({ error: 'Not found' }, 404)

  const rows = await db
    .select({
      id: assetLogs.id,
      logDate: assetLogs.logDate,
      countAvailable: assetLogs.countAvailable,
      countDamaged: assetLogs.countDamaged,
      condition: assetLogs.condition,
      note: assetLogs.note,
      photoUrl: assetLogs.photoUrl,
      recordedById: assetLogs.recordedById,
      recordedByName: users.name,
      verificationStatus: assetLogs.verificationStatus,
      verifiedById: assetLogs.verifiedById,
      verifiedAt: assetLogs.verifiedAt,
      createdAt: assetLogs.createdAt,
    })
    .from(assetLogs)
    .leftJoin(users, eq(assetLogs.recordedById, users.id))
    .where(and(eq(assetLogs.assetId, assetId), eq(assetLogs.farmId, user.farmId)))
    .orderBy(desc(assetLogs.createdAt))

  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = rows.map((row) => ({ ...row }))
  await localizeProse(
    proseSlots(localized, ASSET_LOG_TEXT_FIELDS),
    user.farmId,
    viewerLocale,
  )

  return c.json({ logs: localized })
})

// Any staff (incl. field workers) can record a daily log for an asset.
assetRoutes.post('/:id/logs', zValidator('json', createLogSchema), async (c) => {
  const user = c.get('user')
  const assetId = c.req.param('id')

  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.farmId, user.farmId)))
    .limit(1)
  if (!asset) return c.json({ error: 'Not found' }, 404)

  const body = c.req.valid('json')

  if (body.countAvailable + body.countDamaged > asset.quantityOwned) {
    return c.json(
      { error: 'Available and damaged counts cannot exceed quantity owned' },
      400,
    )
  }

  let photoUrl = body.photoUrl ?? null
  if (photoUrl !== null && photoUrl !== '') {
    if (!validateEvidenceRef(photoUrl)) {
      return c.json({ error: 'Invalid photo evidence URL' }, 400)
    }
    try {
      photoUrl = (await processEvidenceValue(user.farmId, photoUrl)) ?? null
    } catch {
      return c.json({ error: 'Invalid photo evidence URL' }, 400)
    }
  } else {
    photoUrl = photoUrl === '' ? null : photoUrl
  }

  // Supervisor/owner logs are trusted (verified); worker logs need verification.
  const trusted = canAssignTasks(user)

  const canonical = await toCanonicalProse(
    { note: body.note },
    user.farmId,
    await authorLocaleForUserId(user.id),
  )

  const [log] = await db
    .insert(assetLogs)
    .values({
      farmId: user.farmId,
      assetId,
      countAvailable: body.countAvailable,
      countDamaged: body.countDamaged,
      condition: body.condition,
      note: canonical.text.note ?? body.note ?? null,
      ...contentLocaleValues(canonical.locale),
      photoUrl,
      recordedById: user.id,
      verificationStatus: trusted ? 'verified' : 'reported',
      verifiedById: trusted ? user.id : null,
      verifiedAt: trusted ? new Date() : null,
    })
    .returning()

  await recordFarmEvent({
    farmId: user.farmId,
    actorUserId: user.id,
    entityType: 'asset',
    entityId: assetId,
    eventType: 'other',
    afterValue: {
      countAvailable: log.countAvailable,
      countDamaged: log.countDamaged,
      condition: log.condition,
    },
    metadata: { assetName: asset.name, kind: 'asset_log' },
  })

  // The worker reads back their own words; the row holds the English.
  return c.json({ log: { ...log, note: body.note ?? log.note } }, 201)
})

// Supervisor/owner verify (or reject) a reported daily log.
assetRoutes.post('/logs/:logId/verify', zValidator('json', verifyLogSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const logId = c.req.param('logId')
  const body = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(assetLogs)
    .where(and(eq(assetLogs.id, logId), eq(assetLogs.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const viewerLocale = await preferredLocaleForUser(user.id)
  const authorLocale = authorLocaleHint(viewerLocale)
  const canonical = await toCanonicalProse({ note: body.note }, user.farmId, authorLocale)

  const [log] = await db
    .update(assetLogs)
    .set({
      verificationStatus: body.status,
      verifiedById: user.id,
      verifiedAt: new Date(),
      note: canonical.text.note ?? body.note ?? existing.note,
      // The verifier's note replaces the worker's, so a note that is not English
      // yet escalates the row to 'pending'; a row the retry job still owes work
      // on is left exactly as it is, and a verify with no note relabels nothing.
      ...(Object.keys(canonical.text).length > 0
        ? mergeContentLocale(existing, canonical.locale)
        : {}),
    })
    .where(eq(assetLogs.id, logId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'asset_log',
    entityId: logId,
    metadata: { status: body.status },
  })

  // A note this verifier just wrote comes back in their own words; the worker's
  // note, which they did not write, is rendered from the stored English.
  if (body.note) return c.json({ log: { ...log, note: body.note } })

  const payload = { ...log }
  await localizeProse(
    proseSlots([payload], ASSET_LOG_TEXT_FIELDS),
    user.farmId,
    viewerLocale,
  )
  return c.json({ log: payload })
})

assetRoutes.get('/:id/events', async (c) => {
  const user = c.get('user')
  const assetId = c.req.param('id')
  const [asset] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.farmId, user.farmId)))
    .limit(1)
  if (!asset) return c.json({ error: 'Not found' }, 404)

  const events = await db
    .select()
    .from(assetEvents)
    .where(and(eq(assetEvents.assetId, assetId), eq(assetEvents.farmId, user.farmId)))
    .orderBy(desc(assetEvents.eventDate))

  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = events.map((event) => ({ ...event }))
  await localizeProse(
    proseSlots(localized, ASSET_EVENT_TEXT_FIELDS),
    user.farmId,
    viewerLocale,
  )

  return c.json({ events: localized })
})

assetRoutes.post('/:id/events', zValidator('json', assetEventSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const assetId = c.req.param('id')
  const body = c.req.valid('json')
  const [asset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.farmId, user.farmId)))
    .limit(1)
  if (!asset) return c.json({ error: 'Not found' }, 404)

  let evidenceUrl = body.evidenceUrl ?? null
  if (evidenceUrl) {
    if (!validateEvidenceRef(evidenceUrl)) {
      return c.json({ error: 'Invalid evidence URL' }, 400)
    }
    evidenceUrl = (await processEvidenceValue(user.farmId, evidenceUrl)) ?? null
  }

  const eventDate = body.eventDate ? new Date(body.eventDate) : new Date()

  const canonical = await toCanonicalProse(
    { notes: body.notes },
    user.farmId,
    await authorLocaleForUserId(user.id),
  )

  const [event] = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(assetEvents)
      .values({
        assetId,
        farmId: user.farmId,
        eventType: body.eventType,
        eventDate,
        costMinor: body.costMinor ?? null,
        notes: canonical.text.notes ?? body.notes ?? null,
        ...contentLocaleValues(canonical.locale),
        evidenceUrl,
        recordedById: user.id,
      })
      .returning()

    if (body.eventType === 'disposal') {
      await tx
        .update(assets)
        .set({
          disposedAt: eventDate,
          operationalStatus: 'disposed',
          active: false,
          updatedAt: new Date(),
        })
        .where(eq(assets.id, assetId))
    }

    return [row]
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'asset_event',
    entityType: 'asset',
    entityId: assetId,
    metadata: { eventType: body.eventType },
  })

  // The author reads back their own words; the row holds the English.
  return c.json({ event: { ...event, notes: body.notes ?? event.notes } }, 201)
})
