import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import QRCode from 'qrcode'
import { db } from '../db/index.js'
import { cropCycles, farms, harvestLots, orders, plots } from '../db/schema.js'
import { orderReference } from '../lib/customer-cart.js'
import { checkRateLimit } from '../lib/rate-limit.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'
import {
  redactCustomerDisplayName,
  renderBoxLabelHtml,
  renderTraceabilityCertificateHtml,
} from '../lib/traceability-certificate.js'

export const publicRoutes = new Hono()

const PUBLIC_LOT_RATE = { max: 60, windowMs: 60_000 }

function appBaseUrl() {
  return (process.env.PUBLIC_APP_URL ?? 'https://os.trovara.farm').replace(/\/+$/, '')
}

function publicLotSelect() {
  return {
    lotCode: harvestLots.lotCode,
    publicToken: harvestLots.publicToken,
    productName: harvestLots.productName,
    quantityKg: harvestLots.quantityKg,
    unit: harvestLots.unit,
    publicNotes: harvestLots.publicNotes,
    harvestedAt: harvestLots.harvestedAt,
    plotName: plots.name,
    cropType: cropCycles.cropType,
    farmSlug: farms.slug,
    farmName: farms.name,
    farmLocation: farms.location,
    orderId: harvestLots.orderId,
    customerName: orders.customerName,
  }
}

async function lookupPublicLot(farmSlug: string, tokenOrCode: string) {
  const verifiedOnly = eq(harvestLots.verificationStatus, 'verified')

  const [byToken] = await db
    .select(publicLotSelect())
    .from(harvestLots)
    .innerJoin(farms, eq(harvestLots.farmId, farms.id))
    .leftJoin(plots, eq(harvestLots.plotId, plots.id))
    .leftJoin(cropCycles, eq(harvestLots.cropCycleId, cropCycles.id))
    .leftJoin(orders, eq(harvestLots.orderId, orders.id))
    .where(
      and(eq(farms.slug, farmSlug), eq(harvestLots.publicToken, tokenOrCode), verifiedOnly),
    )
    .limit(1)

  if (byToken) return byToken

  // Transition fallback: legacy QR links that still use lotCode.
  const [byCode] = await db
    .select(publicLotSelect())
    .from(harvestLots)
    .innerJoin(farms, eq(harvestLots.farmId, farms.id))
    .leftJoin(plots, eq(harvestLots.plotId, plots.id))
    .leftJoin(cropCycles, eq(harvestLots.cropCycleId, cropCycles.id))
    .leftJoin(orders, eq(harvestLots.orderId, orders.id))
    .where(and(eq(farms.slug, farmSlug), eq(harvestLots.lotCode, tokenOrCode), verifiedOnly))
    .limit(1)

  return byCode ?? null
}

function rateLimitOrNull(c: { req: { header: (name: string) => string | undefined }; header: (k: string, v: string) => void }) {
  const ip = clientIpFromHeaders((name) => c.req.header(name)) ?? 'unknown'
  const rateKey = `public-lot:${ip}`
  return checkRateLimit(rateKey, PUBLIC_LOT_RATE.max, PUBLIC_LOT_RATE.windowMs)
}

publicRoutes.get('/lots/:farmSlug/:tokenOrCode', async (c) => {
  const { allowed, retryAfterSec } = rateLimitOrNull(c)
  if (!allowed) {
    c.header('Retry-After', String(retryAfterSec))
    return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  }

  const farmSlug = c.req.param('farmSlug')
  const tokenOrCode = c.req.param('tokenOrCode')

  const lot = await lookupPublicLot(farmSlug, tokenOrCode)
  if (!lot) return c.json({ error: 'Lot not found' }, 404)

  const preparedFor = redactCustomerDisplayName(lot.customerName)
  const orderRef = lot.orderId ? orderReference(lot.orderId) : null

  return c.json({
    lot: {
      lotCode: lot.lotCode,
      productName: lot.productName,
      quantityKg: lot.quantityKg,
      unit: lot.unit,
      publicNotes: lot.publicNotes,
      harvestedAt: lot.harvestedAt,
      plotName: lot.plotName,
      cropType: lot.cropType,
      preparedFor,
      orderReference: orderRef,
      farm: { slug: lot.farmSlug, name: lot.farmName, location: lot.farmLocation },
    },
    verified: true,
    scannedAt: new Date().toISOString(),
  })
})

/** Public printable certificate for verified lots (QR scan → download). */
publicRoutes.get('/lots/:farmSlug/:tokenOrCode/certificate.html', async (c) => {
  const { allowed, retryAfterSec } = rateLimitOrNull(c)
  if (!allowed) {
    c.header('Retry-After', String(retryAfterSec))
    return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  }

  const farmSlug = c.req.param('farmSlug')
  const tokenOrCode = c.req.param('tokenOrCode')
  const lot = await lookupPublicLot(farmSlug, tokenOrCode)
  if (!lot) return c.json({ error: 'Lot not found' }, 404)

  const publicUrl = `${appBaseUrl()}/lot/${lot.farmSlug ?? 'farm'}/${lot.publicToken}`
  const qrSvg = await QRCode.toString(publicUrl, { type: 'svg', margin: 1, width: 180 })
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
      preparedForPublic: redactCustomerDisplayName(lot.customerName),
      orderReference: lot.orderId ? orderReference(lot.orderId) : null,
    },
    { publicUrl, qrSvg, audience: 'public' },
  )

  c.header('Content-Type', 'text/html; charset=utf-8')
  c.header('Content-Disposition', `inline; filename="trovara-lot-${lot.lotCode}.html"`)
  return c.body(html)
})

/** Public print sticker for a delivery box (QR + lot code). Verified lots only. */
publicRoutes.get('/lots/:farmSlug/:tokenOrCode/label.html', async (c) => {
  const { allowed, retryAfterSec } = rateLimitOrNull(c)
  if (!allowed) {
    c.header('Retry-After', String(retryAfterSec))
    return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  }

  const farmSlug = c.req.param('farmSlug')
  const tokenOrCode = c.req.param('tokenOrCode')
  const lot = await lookupPublicLot(farmSlug, tokenOrCode)
  if (!lot) return c.json({ error: 'Lot not found' }, 404)

  const publicUrl = `${appBaseUrl()}/lot/${lot.farmSlug ?? 'farm'}/${lot.publicToken}`
  const qrSvg = await QRCode.toString(publicUrl, { type: 'svg', margin: 1, width: 280 })
  const autoPrint = c.req.query('autoprint') === '1'
  const html = renderBoxLabelHtml(
    {
      lotCode: lot.lotCode,
      productName: lot.productName,
      quantityKg: lot.quantityKg,
      unit: lot.unit,
      farmName: lot.farmName,
      preparedForPublic: redactCustomerDisplayName(lot.customerName),
      orderReference: lot.orderId ? orderReference(lot.orderId) : null,
    },
    { publicUrl, qrSvg, autoPrint },
  )

  c.header('Content-Type', 'text/html; charset=utf-8')
  c.header('Content-Disposition', `inline; filename="trovara-label-${lot.lotCode}.html"`)
  return c.body(html)
})
