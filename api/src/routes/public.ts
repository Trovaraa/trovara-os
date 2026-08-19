import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import QRCode from 'qrcode'
import { db } from '../db/index.js'
import { cropCycles, farms, harvestLots, invoices, orders, plots } from '../db/schema.js'
import { orderReference } from '../lib/customer-cart.js'
import { checkDurableRateLimit } from '../lib/rate-limit.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'
import {
  renderInvoiceHtml,
  type InvoiceSnapshot,
} from '../lib/invoice-html.js'
import { renderInvoicePdf } from '../lib/invoice-pdf.js'
import {
  redactCustomerDisplayName,
  renderBoxLabelHtml,
  renderTraceabilityCertificateHtml,
} from '../lib/traceability-certificate.js'
import { publicAppBaseUrl, publicLotPageUrl } from '../lib/public-app-url.js'

export const publicRoutes = new Hono()

const PUBLIC_LOT_RATE = { max: 60, windowMs: 60_000 }

function appBaseUrl() {
  return publicAppBaseUrl()
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
  return null
}

/** True when a lot exists for this link but is not yet publicly verifiable. */
async function isPendingPublicLot(farmSlug: string, tokenOrCode: string): Promise<boolean> {
  const [byToken] = await db
    .select({ status: harvestLots.verificationStatus })
    .from(harvestLots)
    .innerJoin(farms, eq(harvestLots.farmId, farms.id))
    .where(and(eq(farms.slug, farmSlug), eq(harvestLots.publicToken, tokenOrCode)))
    .limit(1)
  return byToken?.status === 'reported'
}

async function rateLimitOrNull(c: { req: { header: (name: string) => string | undefined }; header: (k: string, v: string) => void }) {
  const ip = clientIpFromHeaders((name) => c.req.header(name)) ?? 'unknown'
  const rateKey = `public-lot:${ip}`
  return checkDurableRateLimit(rateKey, PUBLIC_LOT_RATE.max, PUBLIC_LOT_RATE.windowMs)
}

publicRoutes.get('/lots/:farmSlug/:tokenOrCode', async (c) => {
  const { allowed, retryAfterSec } = await rateLimitOrNull(c)
  if (!allowed) {
    c.header('Retry-After', String(retryAfterSec))
    return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  }

  const farmSlug = c.req.param('farmSlug')
  const tokenOrCode = c.req.param('tokenOrCode')

  const lot = await lookupPublicLot(farmSlug, tokenOrCode)
  if (!lot) {
    if (await isPendingPublicLot(farmSlug, tokenOrCode)) {
      return c.json(
        {
          error:
            'Your traceability certificate is being prepared. It will be available here once the farm confirms your order.',
          code: 'pending_verification',
        },
        404,
      )
    }
    return c.json({ error: 'Lot not found', code: 'not_found' }, 404)
  }

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
  const { allowed, retryAfterSec } = await rateLimitOrNull(c)
  if (!allowed) {
    c.header('Retry-After', String(retryAfterSec))
    return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  }

  const farmSlug = c.req.param('farmSlug')
  const tokenOrCode = c.req.param('tokenOrCode')
  const lot = await lookupPublicLot(farmSlug, tokenOrCode)
  if (!lot) {
    if (await isPendingPublicLot(farmSlug, tokenOrCode)) {
      return c.json(
        {
          error:
            'Your traceability certificate is being prepared. It will be available here once the farm confirms your order.',
          code: 'pending_verification',
        },
        404,
      )
    }
    return c.json({ error: 'Lot not found', code: 'not_found' }, 404)
  }

  const publicUrl = publicLotPageUrl(lot.farmSlug, lot.publicToken)
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
  const { allowed, retryAfterSec } = await rateLimitOrNull(c)
  if (!allowed) {
    c.header('Retry-After', String(retryAfterSec))
    return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  }

  const farmSlug = c.req.param('farmSlug')
  const tokenOrCode = c.req.param('tokenOrCode')
  const lot = await lookupPublicLot(farmSlug, tokenOrCode)
  if (!lot) return c.json({ error: 'Lot not found' }, 404)

  const publicUrl = publicLotPageUrl(lot.farmSlug, lot.publicToken)
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

const PUBLIC_INVOICE_RATE = { max: 60, windowMs: 60_000 }

async function loadPublicInvoice(token: string) {
  const [row] = await db
    .select({
      invoiceNumber: invoices.invoiceNumber,
      amountKobo: invoices.amountKobo,
      currency: invoices.currency,
      createdAt: invoices.createdAt,
      snapshot: invoices.snapshot,
      publicToken: invoices.publicToken,
      farmName: farms.name,
    })
    .from(invoices)
    .innerJoin(farms, eq(invoices.farmId, farms.id))
    .where(eq(invoices.publicToken, token))
    .limit(1)
  return row ?? null
}

/** Public printable invoice by token (no auth). */
publicRoutes.get('/invoices/:token', async (c) => {
  const ip = clientIpFromHeaders((name) => c.req.header(name)) ?? 'unknown'
  const { allowed, retryAfterSec } = await checkDurableRateLimit(
    `public-invoice:${ip}`,
    PUBLIC_INVOICE_RATE.max,
    PUBLIC_INVOICE_RATE.windowMs,
  )
  if (!allowed) {
    c.header('Retry-After', String(retryAfterSec))
    return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  }

  const row = await loadPublicInvoice(c.req.param('token'))
  if (!row) return c.json({ error: 'Invoice not found' }, 404)

  const publicUrl = `${appBaseUrl()}/public/invoices/${row.publicToken}`
  const html = renderInvoiceHtml({
    invoiceNumber: row.invoiceNumber,
    amountKobo: row.amountKobo,
    currency: row.currency,
    createdAt: row.createdAt,
    snapshot: (row.snapshot ?? {}) as InvoiceSnapshot,
    farmName: row.farmName,
    publicUrl,
    autoPrint: c.req.query('autoprint') === '1',
  })

  c.header('Content-Type', 'text/html; charset=utf-8')
  c.header('Content-Disposition', `inline; filename="${row.invoiceNumber}.html"`)
  return c.body(html)
})

/** Public PDF invoice by token (no auth). */
publicRoutes.get('/invoices/:token/pdf', async (c) => {
  const ip = clientIpFromHeaders((name) => c.req.header(name)) ?? 'unknown'
  const { allowed, retryAfterSec } = await checkDurableRateLimit(
    `public-invoice-pdf:${ip}`,
    PUBLIC_INVOICE_RATE.max,
    PUBLIC_INVOICE_RATE.windowMs,
  )
  if (!allowed) {
    c.header('Retry-After', String(retryAfterSec))
    return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  }

  const row = await loadPublicInvoice(c.req.param('token'))
  if (!row) return c.json({ error: 'Invoice not found' }, 404)

  const publicUrl = `${appBaseUrl()}/public/invoices/${row.publicToken}`
  const pdf = await renderInvoicePdf({
    invoiceNumber: row.invoiceNumber,
    amountKobo: row.amountKobo,
    currency: row.currency,
    createdAt: row.createdAt,
    snapshot: (row.snapshot ?? {}) as InvoiceSnapshot,
    farmName: row.farmName,
    publicUrl,
  })

  c.header('Content-Type', 'application/pdf')
  c.header('Content-Disposition', `attachment; filename="${row.invoiceNumber}.pdf"`)
  return c.body(new Uint8Array(pdf))
})
