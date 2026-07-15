/**
 * Sync the customer-bot catalogue from the canonical farm knowledge
 * (`lib/farm-knowledge.ts`, mirrored from the trovera website) into the DB.
 *
 * Safe to run in production and re-run any time:
 *  - Upserts by (farm_id, name): inserts missing products, updates existing ones
 *    to the canonical unit/price/currency/sort order/active flag.
 *  - NEVER deletes products, so anything a Founder added by hand stays untouched.
 *
 * Targets the same farm the customer bot sells for: TELEGRAM_CUSTOMER_FARM_SLUG
 * if set, otherwise the oldest farm (single-farm pilot).
 *
 * Usage: npm run sync-catalog -w api
 */
import '../lib/env.js'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farms, products } from '../db/schema.js'
import { CANONICAL_PRODUCTS } from '../lib/farm-knowledge.js'

async function resolveFarm(): Promise<{ id: string; name: string } | null> {
  const slug = process.env.TELEGRAM_CUSTOMER_FARM_SLUG?.trim()
  if (slug) {
    const [f] = await db.select().from(farms).where(eq(farms.slug, slug)).limit(1)
    if (f) return { id: f.id, name: f.name }
    console.warn(`No farm with slug "${slug}"; falling back to the oldest farm.`)
  }
  const [first] = await db.select().from(farms).orderBy(asc(farms.createdAt)).limit(1)
  return first ? { id: first.id, name: first.name } : null
}

async function main() {
  const farm = await resolveFarm()
  if (!farm) {
    console.error('No farm found. Seed or create a farm before syncing the catalogue.')
    process.exit(1)
  }

  console.log(`Syncing ${CANONICAL_PRODUCTS.length} products into "${farm.name}"...`)
  let inserted = 0
  let updated = 0

  for (const p of CANONICAL_PRODUCTS) {
    const [existing] = await db
      .select()
      .from(products)
      .where(and(eq(products.farmId, farm.id), eq(products.name, p.name)))
      .limit(1)

    if (existing) {
      await db
        .update(products)
        .set({
          unit: p.unit,
          priceKobo: p.priceKobo,
          currency: p.currency,
          sortOrder: p.sortOrder,
          active: p.active,
          updatedAt: new Date(),
        })
        .where(eq(products.id, existing.id))
      updated += 1
      console.log(`  updated  ${p.name}`)
    } else {
      await db.insert(products).values({
        farmId: farm.id,
        name: p.name,
        unit: p.unit,
        priceKobo: p.priceKobo,
        currency: p.currency,
        sortOrder: p.sortOrder,
        active: p.active,
      })
      inserted += 1
      console.log(`  inserted ${p.name}`)
    }
  }

  console.log(`Catalogue sync complete: ${inserted} inserted, ${updated} updated.`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
