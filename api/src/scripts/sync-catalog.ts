/**
 * Sync the customer-bot catalogue from the canonical farm knowledge
 * (`lib/farm-knowledge.ts`) into the DB.
 *
 * Safe to run in production and re-run any time:
 *  - Upserts by (farm_id, name) including legacy aliases → renames in place
 *  - NEVER deletes products; unknown extras stay (can be deactivated in Products)
 *
 * Usage: npm run sync-catalog -w api
 */
import '../lib/env.js'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farms, products } from '../db/schema.js'
import { CANONICAL_PRODUCTS } from '../lib/farm-knowledge.js'

/** Current name → older names that should be renamed to it. */
const ALIASES: Record<string, string[]> = {
  'Trovara Fresh Pasture-Raised Eggs': [
    'Pasture-Raised Eggs',
    'Trovara Farm Eggs',
    'Trovara Fresh Eggs',
  ],
  'Trovara Fresh Plantain': ['Plantain', 'Trovara Farm Plantain'],
  'Trovara Fresh Coconut': ['Coconut', 'Trovara Farm Coconut'],
  'Trovara Fresh Chicken': ['Free-Range Poultry', 'Trovara Farm Chicken'],
  'Trovara Fresh Plantain Flour': ['Trovara Farm Plantain Flour'],
  'Trovara Fresh Dried Plantain': ['Trovara Farm Dried Plantain'],
}

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

async function findByNames(farmId: string, names: string[]) {
  for (const name of names) {
    const [row] = await db
      .select()
      .from(products)
      .where(and(eq(products.farmId, farmId), eq(products.name, name)))
      .limit(1)
    if (row) return row
  }
  return null
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
    const existing = await findByNames(farm.id, [p.name, ...(ALIASES[p.name] ?? [])])

    if (existing) {
      await db
        .update(products)
        .set({
          name: p.name,
          unit: p.unit,
          priceKobo: p.priceKobo,
          currency: p.currency,
          sortOrder: p.sortOrder,
          active: p.active,
          updatedAt: new Date(),
        })
        .where(eq(products.id, existing.id))
      updated += 1
      console.log(`  updated  ${existing.name} → ${p.name} @ ${p.priceKobo} kobo`)
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

  // Deactivate leftover short-name / Farm-prefix duplicates after rename.
  const leftover = [
    'Plantain',
    'Coconut',
    'Free-Range Poultry',
    'Pasture-Raised Eggs',
    'Trovara Farm Eggs',
    'Trovara Farm Plantain',
    'Trovara Farm Coconut',
    'Trovara Farm Chicken',
    'Trovara Farm Plantain Flour',
    'Trovara Farm Dried Plantain',
  ]
  const canonicalNames = new Set(CANONICAL_PRODUCTS.map((p) => p.name))
  const toDeactivate = leftover.filter((n) => !canonicalNames.has(n))
  if (toDeactivate.length) {
    const deactivated = await db
      .update(products)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(products.farmId, farm.id), inArray(products.name, toDeactivate)))
      .returning({ name: products.name })
    for (const row of deactivated) {
      console.log(`  deactivated leftover ${row.name}`)
    }
  }

  console.log(`Catalogue sync complete: ${inserted} inserted, ${updated} updated.`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
