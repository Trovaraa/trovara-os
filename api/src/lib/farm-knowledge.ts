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
  'Trovara Fresh grows pasture-raised eggs, plantain, coconut and pasture-raised poultry for ' +
  'homes, shops, restaurants and retailers. First supply windows are opening by product - join the waitlist for updates.'

/**
 * Orderable catalogue (the transactional source of truth for the bot). Prices in
 * kobo; 0 means quote-based. Names/units are customer-facing and editable later in
 * the Products admin.
 *
 * Keep `active: false` until a product is genuinely ready for customer orders so
 * the marketing shop and bots do not offer waitlisted inventory as buy-now.
 */
export const CANONICAL_PRODUCTS: CanonicalProduct[] = [
  {
    name: 'Trovara Fresh Pasture-Raised Eggs',
    unit: 'crate',
    priceKobo: 0,
    currency: 'NGN',
    sortOrder: 1,
    active: false,
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
      { label: 'SKU', value: 'TRV-EGG-CRATE' },
      { label: 'Packaging', value: 'Crates of 30; half-crates on request' },
      { label: 'Freshness', value: 'Collected at dawn; date-stamped per crate' },
    ],
    note: 'Waitlist only until first availability is confirmed.',
  },
  {
    name: 'Trovara Fresh Plantain',
    unit: 'bunch',
    priceKobo: 0,
    currency: 'NGN',
    sortOrder: 2,
    active: false,
    tagline: "The world's most versatile staple.",
    description:
      'Grown in rich tropical soil and harvested at the perfect stage - green for cooking, ripe for ' +
      'sweeter preparations. Starchier and heartier than regular bananas. Grown with zero synthetic ' +
      'chemicals and harvested to export-grade standards. Also planned as chips and flour.',
    benefits: [
      'High in resistant starch and complex carbohydrates',
      'Rich in potassium, vitamin C, and fiber',
      'Versatile: boiled, fried, dried, or milled into flour',
      'No artificial ripening - grown and harvested naturally',
    ],
    specs: [
      { label: 'SKU', value: 'TRV-PLT-BUNCH' },
      { label: 'Packaging', value: 'Graded cartons; chips & flour in sealed packs (planned)' },
      { label: 'First harvest', value: 'March 2027 (forecast)' },
    ],
    note: 'Waitlist only until the first harvest window opens.',
  },
  {
    name: 'Trovara Fresh Coconut',
    unit: 'piece',
    priceKobo: 0,
    currency: 'NGN',
    sortOrder: 3,
    active: false,
    tagline: 'The fruit of a thousand uses.',
    description:
      'Grown in rich tropical soil and harvested at peak maturity for retail and processing. ' +
      'Whole mature fruit ships first; coconut milk, chips, and oil are planned after harvest.',
    benefits: [
      'Harvested at full maturity for retail and processing',
      'Naturally grown, chemical-free',
      'Whole fruit SKU for trade and kitchens',
      'Milk, chips, and oil planned after first harvest',
    ],
    specs: [
      { label: 'Fresh SKU', value: 'TRV-COC-PIECE' },
      { label: 'Processed SKUs', value: 'TRV-COC-MILK · TRV-COC-CHIPS · TRV-COC-OIL (planned)' },
      { label: 'Packaging', value: 'Mesh bags (25-50 kg) or custom bulk; retail packs for processed lines' },
      { label: 'First harvest', value: 'June 2027 (forecast)' },
    ],
    note: 'Waitlist only until the first harvest window opens.',
  },
  {
    name: 'Trovara Fresh Chicken',
    unit: 'bird',
    priceKobo: 0,
    currency: 'NGN',
    sortOrder: 4,
    active: false,
    tagline: 'Grass-fed. Pasture-raised. Grown with care.',
    description:
      'Birds are pasture-raised on open grass with a natural grass-and-grain diet and clean water, ' +
      'with no growth hormones. Healthy birds, ethical practices, premium pasture-raised poultry.',
    benefits: [
      'Grass-fed and pasture-raised',
      'Natural grass-and-grain diet',
      'No growth hormones',
      'Whole dressed birds and cuts on request',
    ],
    specs: [
      { label: 'SKU', value: 'TRV-CHK-BIRD' },
      { label: 'Packaging', value: 'Vacuum-sealed or ice-packed' },
      { label: 'Target supply', value: 'December 2026' },
    ],
    note: 'Waitlist only until first dressed birds are ready.',
  },
  {
    name: 'Trovara Fresh Plantain Flour',
    unit: 'pack',
    priceKobo: 0,
    currency: 'NGN',
    sortOrder: 5,
    active: false,
    tagline: 'Plantain, milled fine.',
    description: 'Naturally dried plantain milled into flour for baking and cooking.',
    benefits: ['Gluten-free staple', 'No additives', 'Farm-milled'],
    specs: [
      { label: 'SKU', value: 'TRV-PLF-PACK' },
      { label: 'Packaging', value: 'Sealed packs' },
    ],
    note: 'Planned after plantain harvest; waitlist interest welcome via Products.',
  },
  {
    name: 'Trovara Fresh Dried Plantain',
    unit: 'pack',
    priceKobo: 0,
    currency: 'NGN',
    sortOrder: 6,
    active: false,
    tagline: 'Crisp, natural chips.',
    description: 'Sun-dried or low-heat dried plantain chips for snacking and trade.',
    benefits: ['No artificial ripening', 'Long shelf life'],
    specs: [
      { label: 'SKU', value: 'TRV-DRP-PACK' },
      { label: 'Packaging', value: 'Sealed packs' },
    ],
    note: 'Planned after plantain harvest; waitlist interest welcome via Products.',
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
