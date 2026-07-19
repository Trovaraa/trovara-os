/**
 * Farm product knowledge + canonical customer-bot catalogue.
 * Names/units/prices sync into `products` via `npm run sync-catalog`.
 */

export type CanonicalProduct = {
  name: string
  unit: string
  /** Integer minor units (kobo). 0 => price on request. */
  priceKobo: number
  currency: string
  sortOrder: number
  active: boolean
  tagline: string
  description: string
  benefits: string[]
  specs: Array<{ label: string; value: string }>
  note?: string
}

export const FARM_BLURB =
  'Trovara Fresh grows pasture-raised eggs, plantain, coconut and free-range poultry for ' +
  'homes, shops, restaurants and retailers, delivering on scheduled routes.'

/**
 * Orderable catalogue (the transactional source of truth for the bot). Prices in
 * kobo; 0 means quote-based. Names/units are customer-facing and editable later in
 * the Products admin.
 */
export const CANONICAL_PRODUCTS: CanonicalProduct[] = [
  {
    name: 'Trovara Fresh Pasture-Raised Eggs',
    unit: 'crate',
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
    name: 'Trovara Fresh Plantain',
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
    name: 'Trovara Fresh Coconut',
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
    name: 'Trovara Fresh Chicken',
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
  {
    name: 'Trovara Fresh Plantain Flour',
    unit: 'pack',
    priceKobo: 0,
    currency: 'NGN',
    sortOrder: 5,
    active: true,
    tagline: 'Plantain, milled fine.',
    description: 'Naturally dried plantain milled into flour for baking and cooking.',
    benefits: ['Gluten-free staple', 'No additives', 'Farm-milled'],
    specs: [{ label: 'Packaging', value: 'Sealed packs' }],
  },
  {
    name: 'Trovara Fresh Dried Plantain',
    unit: 'pack',
    priceKobo: 0,
    currency: 'NGN',
    sortOrder: 6,
    active: true,
    tagline: 'Crisp, natural chips.',
    description: 'Sun-dried or low-heat dried plantain chips for snacking and trade.',
    benefits: ['No artificial ripening', 'Long shelf life'],
    specs: [{ label: 'Packaging', value: 'Sealed packs' }],
  },
]

/**
 * Descriptive, PRICE-FREE knowledge block for grounding AI replies. Prices are
 * supplied separately from the live catalogue so there is a single price source.
 */
export function farmKnowledgeText(): string {
  const lines: string[] = [FARM_BLURB, '', 'Products:']
  for (const p of CANONICAL_PRODUCTS) {
    lines.push(`- ${p.name} (${p.unit}): ${p.tagline}`)
    lines.push(`  ${p.description}`)
  }
  return lines.join('\n')
}
