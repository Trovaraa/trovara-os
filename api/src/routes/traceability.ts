import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import QRCode from 'qrcode'
import { and, asc, desc, eq, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db/index.js'
import {
  auditEvents,
  cropCycles,
  farmEvents,
  farms,
  harvestLots,
  orders,
  plots,
  users,
  zones,
} from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAccessFinance, canAssignTasks, canManageOrders } from '../lib/rbac.js'
import { buildBoxLabelHtml, findPrintableLotById } from '../lib/lot-print.js'
import { logAudit } from '../lib/audit.js'
import { recordFarmEvent } from '../lib/farm-events.js'
import { validateEvidenceDataUrl } from '../lib/evidence-url.js'
import type { SessionUser } from '../lib/session.js'
import { orderReference } from '../lib/customer-cart.js'
import {
  allocateLotCode,
  buildLotCodeBase,
  harvestPeriodAt,
  normalizeLotUnit,
} from '../lib/lot-codes.js'
import { enrichHarvestLot } from '../lib/harvest-lots.js'
import {
  escapeHtml,
  renderTraceabilityCertificateHtml,
} from '../lib/traceability-certificate.js'

const LOT_UNITS = ['kg', 'crates'] as const

const createLotSchema = z.object({
  productName: z.string().min(1).max(200),
  quantityKg: z.number().int().min(1),
  unit: z.enum(LOT_UNITS).optional(),
  plotId: z.string().uuid().optional(),
  cropCycleId: z.string().uuid().optional(),
  harvestedAt: z.string().datetime().optional(),
  publicNotes: z.string().max(4000).nullable().optional(),
  internalNotes: z.string().max(4000).nullable().optional(),
  photoUrl: z.string().max(2_000_000).nullable().optional(),
})

const updateLotSchema = z.object({
  productName: z.string().min(1).max(200).optional(),
  quantityKg: z.number().int().min(1).optional(),
  unit: z.enum(LOT_UNITS).optional(),
  plotId: z.string().uuid().nullable().optional(),
  cropCycleId: z.string().uuid().nullable().optional(),
  publicNotes: z.string().max(4000).nullable().optional(),
  internalNotes: z.string().max(4000).nullable().optional(),
  photoUrl: z.string().max(2_000_000).nullable().optional(),
})

const verifyLotSchema = z.object({
  status: z.enum(['verified', 'rejected']),
  note: z.string().max(2000).optional(),
})

export const traceabilityRoutes = new Hono<{ Variables: AppVariables }>()

traceabilityRoutes.use('*', authMiddleware)

// Owner-only gate for finance/export-style endpoints (QR, certificate, delete).
function requireOwner(user: SessionUser): SessionUser | null {
  return canAccessFinance(user) ? user : null
}

function appBaseUrl() {
  return (process.env.PUBLIC_APP_URL ?? 'https://os.trovara.farm').replace(/\/+$/, '')
}

function publicLotUrl(farmSlug: string | null | undefined, publicToken: string): string {
  return `${appBaseUrl()}/lot/${farmSlug ?? 'farm'}/${publicToken}`
}

traceabilityRoutes.get('/', async (c) => {
  // Visible to all staff so supervisors/workers can see reports + statuses.
  const user = c.get('user')

  const reporter = alias(users, 'reporter')
  const verifier = alias(users, 'verifier')

  const rows = await db
    .select({
      id: harvestLots.id,
      lotCode: harvestLots.lotCode,
      publicToken: harvestLots.publicToken,
      plotId: harvestLots.plotId,
      plotName: plots.name,
      zoneName: zones.name,
      cropCycleId: harvestLots.cropCycleId,
      orderId: harvestLots.orderId,
      orderSource: orders.source,
      productName: harvestLots.productName,
      quantityKg: harvestLots.quantityKg,
      unit: harvestLots.unit,
      publicNotes: harvestLots.publicNotes,
      internalNotes: harvestLots.internalNotes,
      photoUrl: harvestLots.photoUrl,
      harvestedAt: harvestLots.harvestedAt,
      createdAt: harvestLots.createdAt,
      farmSlug: farms.slug,
      verificationStatus: harvestLots.verificationStatus,
      reportedById: harvestLots.reportedById,
      reportedByName: reporter.name,
      verifiedById: harvestLots.verifiedById,
      verifiedByName: verifier.name,
      verifiedAt: harvestLots.verifiedAt,
    })
    .from(harvestLots)
    .innerJoin(farms, eq(harvestLots.farmId, farms.id))
    .leftJoin(plots, eq(harvestLots.plotId, plots.id))
    .leftJoin(zones, eq(plots.zoneId, zones.id))
    .leftJoin(orders, eq(harvestLots.orderId, orders.id))
    .leftJoin(reporter, eq(harvestLots.reportedById, reporter.id))
    .leftJoin(verifier, eq(harvestLots.verifiedById, verifier.id))
    .where(eq(harvestLots.farmId, user.farmId))
    .orderBy(desc(harvestLots.harvestedAt))

  return c.json({
    lots: rows.map((row) => ({
      ...row,
      orderReference: row.orderId ? orderReference(row.orderId) : null,
    })),
  })
})

/** Standalone harvest (no customer order). Prefer order auto-create for sales. */
traceabilityRoutes.post('/', zValidator('json', createLotSchema), async (c) => {
  const user = c.get('user')
  const body = c.req.valid('json')

  if (body.photoUrl && !validateEvidenceDataUrl(body.photoUrl)) {
    return c.json({ error: 'Invalid photo evidence URL' }, 400)
  }

  if (body.plotId) {
    const [plot] = await db
      .select()
      .from(plots)
      .where(and(eq(plots.id, body.plotId), eq(plots.farmId, user.farmId)))
      .limit(1)
    if (!plot) return c.json({ error: 'Invalid plot' }, 400)
  }

  if (body.cropCycleId) {
    const [cycle] = await db
      .select()
      .from(cropCycles)
      .where(and(eq(cropCycles.id, body.cropCycleId), eq(cropCycles.farmId, user.farmId)))
      .limit(1)
    if (!cycle) return c.json({ error: 'Invalid crop cycle' }, 400)
  }

  const [farm] = await db
    .select({ timezone: farms.timezone })
    .from(farms)
    .where(eq(farms.id, user.farmId))
    .limit(1)

  const harvestedAt = body.harvestedAt ? new Date(body.harvestedAt) : new Date()
  const timeZone = farm?.timezone ?? 'Africa/Lagos'
  const period = harvestPeriodAt(harvestedAt, timeZone)
  const base = buildLotCodeBase({ period, when: harvestedAt, timeZone })
  const existingCodes = await db
    .select({ lotCode: harvestLots.lotCode })
    .from(harvestLots)
    .where(eq(harvestLots.farmId, user.farmId))
  const lotCode = allocateLotCode(
    base,
    existingCodes.map((r) => r.lotCode),
  )

  const trusted = canAssignTasks(user)
  const unit = normalizeLotUnit(body.unit)

  const [lot] = await db
    .insert(harvestLots)
    .values({
      farmId: user.farmId,
      lotCode,
      plotId: body.plotId,
      cropCycleId: body.cropCycleId,
      productName: body.productName,
      quantityKg: body.quantityKg,
      unit,
      publicNotes: body.publicNotes ?? null,
      internalNotes: body.internalNotes ?? null,
      photoUrl: body.photoUrl ?? null,
      harvestedAt,
      reportedById: user.id,
      verificationStatus: trusted ? 'verified' : 'reported',
      verifiedById: trusted ? user.id : null,
      verifiedAt: trusted ? new Date() : null,
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'harvest_lot',
    entityId: lot.id,
    metadata: { lotCode: lot.lotCode, verificationStatus: lot.verificationStatus },
  })

  await recordFarmEvent({
    farmId: user.farmId,
    actorUserId: user.id,
    entityType: 'harvest_lot',
    entityId: lot.id,
    eventType: 'harvested',
    afterValue: { quantityKg: lot.quantityKg, unit: lot.unit, status: lot.verificationStatus },
    metadata: { lotCode: lot.lotCode, plotId: lot.plotId ?? undefined },
  })

  return c.json({ lot }, 201)
})

traceabilityRoutes.patch('/:id', zValidator('json', updateLotSchema), async (c) => {
  const user = c.get('user')
  const lotId = c.req.param('id')
  const body = c.req.valid('json')

  // Any linked staff can enrich pack details; managers may also change crop cycle.
  const result = await enrichHarvestLot({
    farmId: user.farmId,
    lotId,
    userId: user.id,
    updates: {
      productName: body.productName,
      quantityKg: body.quantityKg,
      unit: body.unit,
      plotId: body.plotId,
      publicNotes: body.publicNotes,
      internalNotes: canAssignTasks(user) ? body.internalNotes : undefined,
      photoUrl: body.photoUrl,
    },
  })

  if ('error' in result) return c.json({ error: result.error }, result.status)

  if (body.cropCycleId !== undefined && canAssignTasks(user)) {
    if (body.cropCycleId) {
      const [cycle] = await db
        .select()
        .from(cropCycles)
        .where(and(eq(cropCycles.id, body.cropCycleId), eq(cropCycles.farmId, user.farmId)))
        .limit(1)
      if (!cycle) return c.json({ error: 'Invalid crop cycle' }, 400)
    }
    const [lot] = await db
      .update(harvestLots)
      .set({ cropCycleId: body.cropCycleId })
      .where(eq(harvestLots.id, lotId))
      .returning()
    return c.json({ lot })
  }

  return c.json({ lot: result.lot })
})

// Supervisor/owner verify (or reject) a reported harvest. Only verified lots
// appear on the public traceability page.
traceabilityRoutes.post('/:id/verify', zValidator('json', verifyLotSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const lotId = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(harvestLots)
    .where(and(eq(harvestLots.id, lotId), eq(harvestLots.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const [lot] = await db
    .update(harvestLots)
    .set({
      verificationStatus: body.status,
      verifiedById: user.id,
      verifiedAt: new Date(),
      internalNotes: body.note ? body.note : existing.internalNotes,
    })
    .where(eq(harvestLots.id, lotId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'harvest_lot',
    entityId: lotId,
    metadata: { lotCode: lot.lotCode, verificationStatus: lot.verificationStatus },
  })

  return c.json({ lot })
})

traceabilityRoutes.get('/:id/qr', async (c) => {
  const user = c.get('user')
  if (!canManageOrders(user)) return c.json({ error: 'Forbidden' }, 403)

  const lotId = c.req.param('id')
  const [lot] = await db
    .select({
      lotCode: harvestLots.lotCode,
      publicToken: harvestLots.publicToken,
      farmSlug: farms.slug,
    })
    .from(harvestLots)
    .innerJoin(farms, eq(harvestLots.farmId, farms.id))
    .where(and(eq(harvestLots.id, lotId), eq(harvestLots.farmId, user.farmId)))
    .limit(1)

  if (!lot) return c.json({ error: 'Not found' }, 404)

  const qrUrl = publicLotUrl(lot.farmSlug, lot.publicToken)
  const svg = await QRCode.toString(qrUrl, { type: 'svg' })
  c.header('Content-Type', 'image/svg+xml')
  return c.body(svg)
})

/** Printable box sticker (QR + lot code). Owner / supervisor / sales. */
traceabilityRoutes.get('/:id/label.html', async (c) => {
  const user = c.get('user')
  if (!canManageOrders(user)) return c.json({ error: 'Forbidden' }, 403)

  const lot = await findPrintableLotById(user.farmId, c.req.param('id'))
  if (!lot) return c.json({ error: 'Not found' }, 404)

  const { html } = await buildBoxLabelHtml(lot, {
    autoPrint: c.req.query('autoprint') === '1',
  })
  c.header('Content-Type', 'text/html; charset=utf-8')
  c.header('Content-Disposition', `inline; filename="trovara-label-${lot.lotCode}.html"`)
  return c.body(html)
})

traceabilityRoutes.get('/:id/timeline', async (c) => {
  const user = requireOwner(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)

  const lotId = c.req.param('id')
  const [lot] = await db
    .select({
      id: harvestLots.id,
      plotId: harvestLots.plotId,
      cropCycleId: harvestLots.cropCycleId,
    })
    .from(harvestLots)
    .where(and(eq(harvestLots.id, lotId), eq(harvestLots.farmId, user.farmId)))
    .limit(1)

  if (!lot) return c.json({ error: 'Not found' }, 404)

  const rows = await db
    .select()
    .from(farmEvents)
    .where(
      and(
        eq(farmEvents.farmId, user.farmId),
        or(
          and(eq(farmEvents.entityType, 'harvest_lot'), eq(farmEvents.entityId, lot.id)),
          lot.plotId ? sql`${farmEvents.metadata}->>'plotId' = ${lot.plotId}` : sql`false`,
          lot.cropCycleId
            ? sql`${farmEvents.metadata}->>'cropCycleId' = ${lot.cropCycleId}`
            : sql`false`,
        ),
      ),
    )
    .orderBy(asc(farmEvents.createdAt))

  return c.json({ events: rows })
})

traceabilityRoutes.get('/:id/certificate.html', async (c) => {
  const user = requireOwner(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)

  const lotId = c.req.param('id')
  const [lot] = await db
    .select({
      id: harvestLots.id,
      lotCode: harvestLots.lotCode,
      publicToken: harvestLots.publicToken,
      productName: harvestLots.productName,
      quantityKg: harvestLots.quantityKg,
      unit: harvestLots.unit,
      publicNotes: harvestLots.publicNotes,
      harvestedAt: harvestLots.harvestedAt,
      plotId: harvestLots.plotId,
      cropCycleId: harvestLots.cropCycleId,
      orderId: harvestLots.orderId,
      plotName: plots.name,
      cropType: cropCycles.cropType,
      farmSlug: farms.slug,
      farmName: farms.name,
      farmLocation: farms.location,
      customerName: orders.customerName,
    })
    .from(harvestLots)
    .innerJoin(farms, eq(harvestLots.farmId, farms.id))
    .leftJoin(plots, eq(harvestLots.plotId, plots.id))
    .leftJoin(cropCycles, eq(harvestLots.cropCycleId, cropCycles.id))
    .leftJoin(orders, eq(harvestLots.orderId, orders.id))
    .where(and(eq(harvestLots.id, lotId), eq(harvestLots.farmId, user.farmId)))
    .limit(1)

  if (!lot) return c.json({ error: 'Not found' }, 404)

  const timeline = await db
    .select({
      id: farmEvents.id,
      eventType: farmEvents.eventType,
      createdAt: farmEvents.createdAt,
    })
    .from(farmEvents)
    .where(
      and(
        eq(farmEvents.farmId, user.farmId),
        or(
          and(eq(farmEvents.entityType, 'harvest_lot'), eq(farmEvents.entityId, lot.id)),
          lot.plotId ? sql`${farmEvents.metadata}->>'plotId' = ${lot.plotId}` : sql`false`,
          lot.cropCycleId ? sql`${farmEvents.metadata}->>'cropCycleId' = ${lot.cropCycleId}` : sql`false`,
        ),
      ),
    )
    .orderBy(asc(farmEvents.createdAt))

  const publicUrl = publicLotUrl(lot.farmSlug, lot.publicToken)
  const qrSvg = await QRCode.toString(publicUrl, { type: 'svg', margin: 1, width: 180 })

  const timelineItems = timeline
    .map(
      (event) => `<tr>
  <td>${new Date(event.createdAt).toLocaleString()}</td>
  <td>${escapeHtml(event.eventType)}</td>
</tr>`,
    )
    .join('\n')

  const html = renderTraceabilityCertificateHtml(
    {
      lotCode: lot.lotCode,
      productName: lot.productName,
      quantityKg: lot.quantityKg,
      unit: lot.unit,
      harvestedAt: lot.harvestedAt,
      plotName: lot.plotName,
      cropType: lot.cropType,
      publicNotes: lot.publicNotes,
      farmName: lot.farmName,
      farmLocation: lot.farmLocation,
      customerName: lot.customerName,
      orderReference: lot.orderId ? orderReference(lot.orderId) : null,
    },
    { publicUrl, qrSvg, audience: 'staff', timelineHtml: timelineItems },
  )

  c.header('Content-Type', 'text/html; charset=utf-8')
  return c.body(html)
})

traceabilityRoutes.delete('/:id', async (c) => {
  const user = requireOwner(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)

  const lotId = c.req.param('id')

  const [existing] = await db
    .select()
    .from(harvestLots)
    .where(and(eq(harvestLots.id, lotId), eq(harvestLots.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.delete(harvestLots).where(eq(harvestLots.id, lotId))

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'harvest_lot',
    entityId: lotId,
    metadata: { lotCode: existing.lotCode },
  })

  return c.json({ ok: true })
})

traceabilityRoutes.get('/export', async (c) => {
  const user = requireOwner(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)

  const [lots, events] = await Promise.all([
    db
      .select({
        id: harvestLots.id,
        lotCode: harvestLots.lotCode,
        productName: harvestLots.productName,
        quantityKg: harvestLots.quantityKg,
        unit: harvestLots.unit,
        harvestedAt: harvestLots.harvestedAt,
        plotName: plots.name,
        createdAt: harvestLots.createdAt,
      })
      .from(harvestLots)
      .leftJoin(plots, eq(harvestLots.plotId, plots.id))
      .where(eq(harvestLots.farmId, user.farmId))
      .orderBy(desc(harvestLots.harvestedAt)),
    db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.farmId, user.farmId),
          or(
            eq(auditEvents.entityType, 'harvest_lot'),
            eq(auditEvents.entityType, 'order'),
          ),
        ),
      )
      .orderBy(desc(auditEvents.createdAt)),
  ])

  return c.json({
    exportedAt: new Date().toISOString(),
    harvestLots: lots,
    auditChain: events,
  })
})
