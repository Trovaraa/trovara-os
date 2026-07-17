import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { cropCycles, farms, harvestLots, plots } from '../db/schema.js'
import { checkRateLimit } from '../lib/rate-limit.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'

export const publicRoutes = new Hono()

const PUBLIC_LOT_RATE = { max: 60, windowMs: 60_000 }

function publicLotSelect() {
  return {
    lotCode: harvestLots.lotCode,
    publicToken: harvestLots.publicToken,
    productName: harvestLots.productName,
    quantityKg: harvestLots.quantityKg,
    publicNotes: harvestLots.publicNotes,
    harvestedAt: harvestLots.harvestedAt,
    plotName: plots.name,
    cropType: cropCycles.cropType,
    farmSlug: farms.slug,
    farmName: farms.name,
    farmLocation: farms.location,
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
    .where(and(eq(farms.slug, farmSlug), eq(harvestLots.lotCode, tokenOrCode), verifiedOnly))
    .limit(1)

  return byCode ?? null
}

publicRoutes.get('/lots/:farmSlug/:tokenOrCode', async (c) => {
  const ip = clientIpFromHeaders((name) => c.req.header(name)) ?? 'unknown'
  const rateKey = `public-lot:${ip}`
  const { allowed, retryAfterSec } = checkRateLimit(
    rateKey,
    PUBLIC_LOT_RATE.max,
    PUBLIC_LOT_RATE.windowMs,
  )
  if (!allowed) {
    c.header('Retry-After', String(retryAfterSec))
    return c.json({ error: 'Too many requests - try again shortly.' }, 429)
  }

  const farmSlug = c.req.param('farmSlug')
  const tokenOrCode = c.req.param('tokenOrCode')

  const lot = await lookupPublicLot(farmSlug, tokenOrCode)
  if (!lot) return c.json({ error: 'Lot not found' }, 404)

  return c.json({
    lot: {
      lotCode: lot.lotCode,
      productName: lot.productName,
      quantityKg: lot.quantityKg,
      publicNotes: lot.publicNotes,
      harvestedAt: lot.harvestedAt,
      plotName: lot.plotName,
      cropType: lot.cropType,
      farm: { slug: lot.farmSlug, name: lot.farmName, location: lot.farmLocation },
    },
    verified: true,
    scannedAt: new Date().toISOString(),
  })
})
