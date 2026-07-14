import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { cropCycles, farms, harvestLots, plots } from '../db/schema.js'

export const publicRoutes = new Hono()

publicRoutes.get('/lots/:lotCode', async (c) => {
  const lotCode = c.req.param('lotCode')

  const [lot] = await db
    .select({
      lotCode: harvestLots.lotCode,
      productName: harvestLots.productName,
      quantityKg: harvestLots.quantityKg,
      publicNotes: harvestLots.publicNotes,
      harvestedAt: harvestLots.harvestedAt,
      plotName: plots.name,
      cropType: cropCycles.cropType,
      farmName: farms.name,
      farmLocation: farms.location,
    })
    .from(harvestLots)
    .innerJoin(farms, eq(harvestLots.farmId, farms.id))
    .leftJoin(plots, eq(harvestLots.plotId, plots.id))
    .leftJoin(cropCycles, eq(harvestLots.cropCycleId, cropCycles.id))
    .where(eq(harvestLots.lotCode, lotCode))
    .limit(1)

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
      farm: { name: lot.farmName, location: lot.farmLocation },
    },
    verified: true,
    scannedAt: new Date().toISOString(),
  })
})
