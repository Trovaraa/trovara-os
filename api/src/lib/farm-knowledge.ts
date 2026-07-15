/**
 * Canonical Trovara Farm product & farm knowledge.
 *
 * Source of truth mirrored from the public marketing site (`trovera/src/stores/
 * products.ts`). Kept as a plain, committed data module (NOT a runtime import of
 * the marketing app) so the OS API has no cross-repo/runtime dependency. When the
 * website content changes, update this file and re-run `npm run sync-catalog -w api`.
 *
 * Two consumers:
 *  - `scripts/sync-catalog.ts` upserts the orderable subset into the `products`
 *    table (prices/units the bot needs to build carts + orders).
 *  - `customer-inquiry.ts` renders the descriptive knowledge (price-free) into the
 *    LLM grounding so answers about produce are accurate and rich.
 *
 * Prices live in the `products` table (single price source). Keep money OUT of the
 * knowledge text so the AI never sees two conflicting figures for one item.
 */

export type CanonicalProduct = {
  /** Customer-facing catalogue name (used to match/upsert by name). */
  name: string
  /** Ordering unit shown in the catalogue and carts. */
  unit: string
  /** Price per unit in kobo. 0 = "price on request" (quote-based/bulk). */
  priceKobo: number
  currency: string
  /** Display order in the catalogue. */
  sortOrder: number
  /** Whether the item is orderable right now. */
  active: boolean
  /** Short marketing line. */
  tagline: string
  /** Rich description used to ground AI answers. */
  description: string
  /** Selling points used to ground AI answers. */
  benefits: string[]
  /** Fact rows (grades, packaging, shelf life, delivery). */
  specs: { label: string; value: string }[]
  /** Optional extra note (e.g. subscription availability) - no money figures. */
  note?: string
}

/** Regions the farm delivers to. */
export const FARM_DELIVERY_AREAS = ['Ogun', 'Lagos', 'Ibadan']

/** Short farm story used to ground the AI persona. */
export const FARM_STORY =
  'Trovara Farm grows fresh produce in rich tropical soil with no synthetic chemicals, ' +
  'harvested at peak maturity and graded before it leaves the farm. We sell directly to ' +
  'homes, shops, restaurants and retailers, delivering on scheduled routes.'

/**
 * Orderable catalogue (the transactional source of truth for the bot). Prices in
 * kobo; 0 means quote-based. Names/units are customer-facing and editable later in
 * the Products admin.
 */
export const CANONICAL_PRODUCTS: CanonicalProduct[] = [
  {
    name: 'Pasture-Raised Eggs',
    unit: 'crate (30)',
    priceKobo: 650000,
    currency: 'NGN',
    sortOrder: 1,
    active: true,
    tagline: 'Taste what an egg is supposed to be.',
    description:
      'Hens live outdoors on open pasture every day - rotated across fresh grass, never caged. ' +
      'They forage on natural feed and clean water, with no antibiotics and no hormones. Eggs are ' +
      'hand-collected at dawn and graded before they leave the farm.',
    benefits: [
      'Genuinely pasture-raised - hens on grass every day',
      'Deep-golden, richer-tasting yolks',
      'No antibiotics, no hormones, ever',
      'Hand-collected at dawn and date-stamped',
    ],
    specs: [
      { label: 'Grades', value: 'Farm-fresh, graded pasture-raised eggs' },
      { label: 'Packaging', value: 'Crates of 30; half-crates on request' },
      { label: 'Freshness', value: 'Collected at dawn; date-stamped per crate' },
    ],
    note: 'A weekly egg subscription (4 crates/month) is available - ask for current subscription pricing.',
  },
  {
    name: 'Plantain',
    unit: 'bunch',
    priceKobo: 0,
    currency: 'NGN',
    sortOrder: 2,
    active: true,
    tagline: "The world's most versatile staple.",
    description:
      'Grown in rich tropical soil and harvested at the perfect stage - green for cooking, ripe for ' +
      'sweeter preparations. Starchier and heartier than regular bananas. Grown with zero synthetic ' +
      'chemicals and harvested to export-grade standards. Also available as chips and flour.',
    benefits: [
      'High in resistant starch and complex carbohydrates',
      'Rich in potassium, vitamin C, and fiber',
      'Versatile: boiled, fried, dried, or milled into flour',
      'No artificial ripening - grown and harvested naturally',
    ],
    specs: [
      { label: 'Grades', value: 'Grade A green; Grade A ripe (prepackaged boxes)' },
      { label: 'Packaging', value: 'Graded cartons, 18-20 kg; chips & flour in sealed packs' },
      { label: 'Shelf life', value: 'Green: 7-10 days; ripe: 3-5 days; flour: 12 months' },
    ],
  },
  {
    name: 'Coconut',
    unit: 'piece',
    priceKobo: 0,
    currency: 'NGN',
    sortOrder: 3,
    active: true,
    tagline: 'The fruit of a thousand uses.',
    description:
      'Grown in rich tropical soil and harvested at peak maturity for maximum sweetness, water content ' +
      'and nutrition. Available from fresh coconut water to dried copra, in bulk for trade.',
    benefits: [
      'Rich in electrolytes and hydration',
      'Naturally sweet, chemical-free',
      'Harvested at full maturity',
      'Multi-purpose: water, flesh, oil, husk',
    ],
    specs: [
      { label: 'Grades', value: 'Export-grade, mature coconuts' },
      { label: 'Packaging', value: 'Mesh bags (25-50 kg) or custom bulk' },
      { label: 'Shelf life', value: '3-4 weeks at ambient; longer with cold chain' },
    ],
    note: 'Sold in bulk - price on request based on volume.',
  },
  {
    name: 'Free-Range Poultry',
    unit: 'bird',
    priceKobo: 0,
    currency: 'NGN',
    sortOrder: 4,
    active: true,
    tagline: 'Raised with care. Served with pride.',
    description:
      'Birds are raised in open, free-range environments with natural feed and clean water, no growth ' +
      'hormones. Healthy birds, ethical practices, premium free-range poultry meat.',
    benefits: [
      'Free-range, open environment',
      'Natural grain-based feed',
      'No growth hormones',
      'Premium free-range poultry meat',
    ],
    specs: [
      { label: 'Grades', value: 'Free-range broilers & mature hens' },
      { label: 'Packaging', value: 'Vacuum-sealed or ice-packed' },
      { label: 'Shelf life', value: 'Fresh: 3-5 days refrigerated; longer frozen' },
    ],
    note: 'Sold whole or in cuts - price on request. Recurring supply contracts available.',
  },
]

/**
 * Descriptive, PRICE-FREE knowledge block for grounding AI replies. Prices are
 * supplied separately from the live catalogue so there is a single price source.
 */
export function farmKnowledgeText(): string {
  const lines: string[] = []
  lines.push('About the farm:')
  lines.push(FARM_STORY)
  lines.push('')
  lines.push(`Delivery areas: ${FARM_DELIVERY_AREAS.join(', ')} (scheduled routes).`)
  lines.push('')
  lines.push('Produce details (for descriptions only - use the price list above for prices):')
  for (const p of CANONICAL_PRODUCTS) {
    lines.push('')
    lines.push(`• ${p.name} - ${p.tagline}`)
    lines.push(`  ${p.description}`)
    if (p.benefits.length) lines.push(`  Benefits: ${p.benefits.join('; ')}.`)
    for (const s of p.specs) lines.push(`  ${s.label}: ${s.value}.`)
    if (p.note) lines.push(`  Note: ${p.note}`)
  }
  return lines.join('\n')
}
