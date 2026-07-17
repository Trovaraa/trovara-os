import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import QRCode from 'qrcode'
import { and, asc, desc, eq, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db/index.js'
import { auditEvents, cropCycles, farmEvents, farms, harvestLots, plots, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAccessFinance, canAssignTasks } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import { recordFarmEvent } from '../lib/farm-events.js'
import { validateEvidenceDataUrl } from '../lib/evidence-url.js'
import type { SessionUser } from '../lib/session.js'

const createLotSchema = z.object({
  lotCode: z.string().min(1).max(50),
  plotId: z.string().uuid().optional(),
  cropCycleId: z.string().uuid().optional(),
  productName: z.string().min(1).max(200),
  quantityKg: z.number().int().min(1),
  harvestedAt: z.string().datetime(),
  publicNotes: z.string().max(4000).optional(),
  internalNotes: z.string().max(4000).optional(),
  photoUrl: z.string().max(2_000_000).optional(),
})

const updateLotSchema = createLotSchema.partial()

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

function escapeHtml(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
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
      cropCycleId: harvestLots.cropCycleId,
      productName: harvestLots.productName,
      quantityKg: harvestLots.quantityKg,
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
    .leftJoin(reporter, eq(harvestLots.reportedById, reporter.id))
    .leftJoin(verifier, eq(harvestLots.verifiedById, verifier.id))
    .where(eq(harvestLots.farmId, user.farmId))
    .orderBy(desc(harvestLots.harvestedAt))

  return c.json({ lots: rows })
})

traceabilityRoutes.post('/', zValidator('json', createLotSchema), async (c) => {
  // Any staff member can report a harvest. Supervisor/owner reports are trusted
  // (verified immediately); field-worker reports land as 'reported' and need a
  // supervisor/owner to verify before they go public.
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

  const [existingCode] = await db
    .select()
    .from(harvestLots)
    .where(and(eq(harvestLots.farmId, user.farmId), eq(harvestLots.lotCode, body.lotCode)))
    .limit(1)

  if (existingCode) return c.json({ error: 'Lot code already exists' }, 400)

  const trusted = canAssignTasks(user)

  const [lot] = await db
    .insert(harvestLots)
    .values({
      farmId: user.farmId,
      lotCode: body.lotCode,
      plotId: body.plotId,
      cropCycleId: body.cropCycleId,
      productName: body.productName,
      quantityKg: body.quantityKg,
      publicNotes: body.publicNotes,
      internalNotes: body.internalNotes,
      photoUrl: body.photoUrl,
      harvestedAt: new Date(body.harvestedAt),
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
    afterValue: { quantityKg: lot.quantityKg, status: lot.verificationStatus },
    metadata: { lotCode: lot.lotCode, plotId: lot.plotId ?? undefined },
  })

  return c.json({ lot }, 201)
})

traceabilityRoutes.patch('/:id', zValidator('json', updateLotSchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const lotId = c.req.param('id')
  const body = c.req.valid('json')

  if (body.photoUrl && !validateEvidenceDataUrl(body.photoUrl)) {
    return c.json({ error: 'Invalid photo evidence URL' }, 400)
  }

  const [existing] = await db
    .select()
    .from(harvestLots)
    .where(and(eq(harvestLots.id, lotId), eq(harvestLots.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  if (body.lotCode && body.lotCode !== existing.lotCode) {
    const [duplicate] = await db
      .select()
      .from(harvestLots)
      .where(and(eq(harvestLots.farmId, user.farmId), eq(harvestLots.lotCode, body.lotCode)))
      .limit(1)
    if (duplicate) return c.json({ error: 'Lot code already exists' }, 400)
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

  const updates: Partial<typeof existing> = {}
  if (body.lotCode !== undefined) updates.lotCode = body.lotCode
  if (body.plotId !== undefined) updates.plotId = body.plotId
  if (body.cropCycleId !== undefined) updates.cropCycleId = body.cropCycleId
  if (body.productName !== undefined) updates.productName = body.productName
  if (body.quantityKg !== undefined) updates.quantityKg = body.quantityKg
  if (body.publicNotes !== undefined) updates.publicNotes = body.publicNotes
  if (body.internalNotes !== undefined) updates.internalNotes = body.internalNotes
  if (body.photoUrl !== undefined) updates.photoUrl = body.photoUrl
  if (body.harvestedAt !== undefined) updates.harvestedAt = new Date(body.harvestedAt)

  const [lot] = await db
    .update(harvestLots)
    .set(updates)
    .where(eq(harvestLots.id, lotId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'harvest_lot',
    entityId: lotId,
    metadata: { lotCode: lot.lotCode },
  })

  return c.json({ lot })
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
  const user = requireOwner(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)

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
      publicNotes: harvestLots.publicNotes,
      harvestedAt: harvestLots.harvestedAt,
      plotId: harvestLots.plotId,
      cropCycleId: harvestLots.cropCycleId,
      plotName: plots.name,
      cropType: cropCycles.cropType,
      farmSlug: farms.slug,
      farmName: farms.name,
      farmLocation: farms.location,
    })
    .from(harvestLots)
    .innerJoin(farms, eq(harvestLots.farmId, farms.id))
    .leftJoin(plots, eq(harvestLots.plotId, plots.id))
    .leftJoin(cropCycles, eq(harvestLots.cropCycleId, cropCycles.id))
    .where(and(eq(harvestLots.id, lotId), eq(harvestLots.farmId, user.farmId)))
    .limit(1)

  if (!lot) return c.json({ error: 'Not found' }, 404)

  const timeline = await db
    .select({
      id: farmEvents.id,
      eventType: farmEvents.eventType,
      entityType: farmEvents.entityType,
      source: farmEvents.source,
      metadata: farmEvents.metadata,
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
    .map((event) => {
      const metadata = event.metadata && typeof event.metadata === 'object'
        ? JSON.stringify(event.metadata)
        : ''
      return `<tr>
  <td>${new Date(event.createdAt).toLocaleString()}</td>
  <td>${escapeHtml(event.eventType)}</td>
  <td>${escapeHtml(event.entityType)}</td>
  <td>${escapeHtml(event.source ?? 'web')}</td>
  <td>${escapeHtml(metadata)}</td>
</tr>`
    })
    .join('\n')

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Traceability Certificate - ${escapeHtml(lot.lotCode)}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #111827; margin: 24px; }
    h1 { margin: 0 0 4px; font-size: 24px; }
    h2 { margin: 24px 0 8px; font-size: 16px; }
    .subtle { color: #6b7280; font-size: 13px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 20px; margin-top: 16px; }
    .row b { display: inline-block; min-width: 140px; }
    .qr { margin-top: 20px; display: flex; gap: 20px; align-items: flex-start; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
    th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f3f4f6; }
    @media print { body { margin: 10mm; } a { color: inherit; text-decoration: none; } }
  </style>
</head>
<body>
  <h1>Trovara Traceability Certificate</h1>
  <div class="subtle">Generated ${new Date().toLocaleString()}</div>

  <div class="grid">
    <div class="row"><b>Farm</b> ${escapeHtml(lot.farmName)}</div>
    <div class="row"><b>Location</b> ${escapeHtml(lot.farmLocation)}</div>
    <div class="row"><b>Lot code</b> ${escapeHtml(lot.lotCode)}</div>
    <div class="row"><b>Product</b> ${escapeHtml(lot.productName)}</div>
    <div class="row"><b>Quantity</b> ${lot.quantityKg} kg</div>
    <div class="row"><b>Harvested</b> ${new Date(lot.harvestedAt).toLocaleDateString()}</div>
    <div class="row"><b>Plot</b> ${escapeHtml(lot.plotName ?? '-')}</div>
    <div class="row"><b>Crop type</b> ${escapeHtml(lot.cropType ?? '-')}</div>
  </div>

  <h2>Public verification link</h2>
  <div class="qr">
    <div>${qrSvg}</div>
    <div>
      <div><a href="${escapeHtml(publicUrl)}">${escapeHtml(publicUrl)}</a></div>
      <div class="subtle" style="margin-top:8px;">Scan to open the public lot page.</div>
      <div style="margin-top:12px;"><b>Public notes:</b> ${escapeHtml(lot.publicNotes ?? '-')}</div>
    </div>
  </div>

  <h2>Timeline events</h2>
  <table>
    <thead>
      <tr><th>Time</th><th>Event</th><th>Entity</th><th>Source</th><th>Metadata</th></tr>
    </thead>
    <tbody>
      ${timelineItems || '<tr><td colspan="5">No events found.</td></tr>'}
    </tbody>
  </table>
</body>
</html>`

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
