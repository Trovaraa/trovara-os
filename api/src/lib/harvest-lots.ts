import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farms, harvestLots, orders, plots, users } from '../db/schema.js'
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
import { authorLocaleForUserId, toCanonicalEnglish } from './content-locale.js'
import { mergeContentLocale, type ContentLocaleMeta } from './task-drafts.js'

export type OrderLineForLot = {
  productName: string
  unit: string
  quantity: number
}

/**
 * The only prose on a lot. `lotCode`, `publicToken`, `productName` and `unit`
 * are identifiers, proper nouns and enum values that appear verbatim on the
 * public traceability page and on printed labels, so they never reach a
 * translator.
 *
 * `publicNotes` is externally visible traceability text, which is why the
 * storage language matters here beyond the audit trail: the public page renders
 * whatever the column holds.
 */
const LOT_TEXT_FIELDS = ['publicNotes', 'internalNotes'] as const
type LotTextField = (typeof LOT_TEXT_FIELDS)[number]

type CanonicalLotNotes = {
  text: Partial<Record<LotTextField, string>>
  locale: ContentLocaleMeta
}

const NOTHING_TO_NORMALIZE: CanonicalLotNotes = {
  text: {},
  locale: { sourceLocale: null, translationStatus: 'done' },
}

/**
 * Look up an author's locale hint when the caller has their id but not their
 * profile.
 *
 * Deliberately *not* called `authorLocaleHint`: that name belongs to the shared
 * synchronous rule in `content-locale.ts`, which takes a preference rather than
 * an id. Two same-named exports with different signatures is how the "pass the
 * raw preference" mistake gets made — either import would compile here and both
 * would silently return null for the wrong reason. This resolves the id and
 * then applies that one rule, so there is still only one definition of it.
 */
export async function authorLocaleForUser(userId: string): Promise<string | null> {
  return authorLocaleForUserId(userId)
}

/**
 * Normalize lot notes to English for storage.
 *
 * Each note is its own column, so they translate concurrently instead of as one
 * merged prompt: neither field can bleed into the other's column. A degraded
 * translator yields the author's own words with status 'pending' so the retry
 * job repairs the row — a row holding French while claiming 'done' is never
 * swept again.
 */
async function canonicalLotNotes(
  notes: Partial<Record<LotTextField, string | null | undefined>>,
  farmId: string,
  userId: string,
): Promise<CanonicalLotNotes> {
  const entries = LOT_TEXT_FIELDS.flatMap((field) => {
    const value = notes[field]
    return typeof value === 'string' && value.trim() !== ''
      ? ([[field, value]] as [LotTextField, string][])
      : []
  })
  if (entries.length === 0) return NOTHING_TO_NORMALIZE

  const hint = await authorLocaleForUser(userId)
  const results = await Promise.all(
    entries.map(async ([, value]) => {
      try {
        return await toCanonicalEnglish({ text: value, farmId, sourceLocale: hint })
      } catch {
        // A translation failure must never fail the write it serves.
        return { english: value, sourceLocale: hint, status: 'pending' as const }
      }
    }),
  )

  const text: Partial<Record<LotTextField, string>> = {}
  let pending = false
  let sourceLocale: string | null = null
  entries.forEach(([field], index) => {
    const result = results[index]
    text[field] = result.english
    if (result.status === 'pending') pending = true
    // One column pair describes the whole row, so a non-English locale is the
    // informative one for the retry job.
    if (!sourceLocale || sourceLocale === 'en') sourceLocale = result.sourceLocale
  })

  return { text, locale: { sourceLocale, translationStatus: pending ? 'pending' : 'done' } }
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
  /**
   * How the notes in `updates` were normalized, for a caller that already did it
   * — the chat channels normalize at draft creation and only they know whether
   * it succeeded. Omit it and the notes are normalized here, which is what a web
   * form carrying the worker's own words needs.
   */
  contentLocale?: ContentLocaleMeta
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

  const canonical =
    params.contentLocale === undefined
      ? await canonicalLotNotes(
          { publicNotes: body.publicNotes, internalNotes: body.internalNotes },
          params.farmId,
          params.userId,
        )
      : { text: {}, locale: params.contentLocale }

  const updates: Partial<typeof existing> = {}
  if (body.productName !== undefined) updates.productName = body.productName
  if (body.quantityKg !== undefined) updates.quantityKg = body.quantityKg
  if (body.unit !== undefined) updates.unit = body.unit
  if (body.plotId !== undefined) updates.plotId = body.plotId
  if (body.publicNotes !== undefined) {
    updates.publicNotes = canonical.text.publicNotes ?? body.publicNotes
  }
  if (body.internalNotes !== undefined) {
    updates.internalNotes = canonical.text.internalNotes ?? body.internalNotes
  }
  if (body.photoUrl !== undefined) updates.photoUrl = body.photoUrl
  // Escalates a row to 'pending' but never downgrades one the retry job still
  // owes work on.
  Object.assign(updates, mergeContentLocale(existing, canonical.locale))

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
  /** How `note` was normalized, when the caller already did it. */
  contentLocale?: ContentLocaleMeta
}): Promise<{ lot: typeof harvestLots.$inferSelect } | { error: string; status: 400 | 404 }> {
  const [existing] = await db
    .select()
    .from(harvestLots)
    .where(and(eq(harvestLots.id, params.lotId), eq(harvestLots.farmId, params.farmId)))
    .limit(1)
  if (!existing) return { error: 'Not found', status: 404 }

  // The verification note is prose and lands in `internal_notes`; the status is
  // an enum and the verifier is an id, so neither is ever translated.
  const canonical =
    params.contentLocale === undefined
      ? await canonicalLotNotes({ internalNotes: params.note }, params.farmId, params.userId)
      : { text: {}, locale: params.contentLocale }

  const [lot] = await db
    .update(harvestLots)
    .set({
      verificationStatus: params.status,
      verifiedById: params.userId,
      verifiedAt: new Date(),
      internalNotes: params.note
        ? canonical.text.internalNotes ?? params.note
        : existing.internalNotes,
      ...(params.note ? mergeContentLocale(existing, canonical.locale) : {}),
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
