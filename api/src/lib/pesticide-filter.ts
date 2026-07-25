/** Hard blocklist for pesticide / herbicide / banned spray recommendations. */
const PESTICIDE_BLOCKLIST = [
  'pesticide',
  'herbicide',
  'insecticide',
  'fungicide',
  'paraquat',
  'glyphosate',
  'roundup',
  'atrazine',
  'ddt',
  'organophosphate',
  'carbamate',
  'neonicotinoid',
  'weed killer',
  'weedkiller',
  'rat poison',
  'rodenticide',
  'sniper',
  'otapiapia',
  'force up',
  'forceup',
]

export function containsPesticideLanguage(text: string): boolean {
  const lower = text.toLowerCase()
  return PESTICIDE_BLOCKLIST.some((term) => lower.includes(term))
}

export function filterUnsafeProductText<T extends { title?: string; reason?: string; snippet?: string }>(
  items: T[],
): T[] {
  return items.filter((item) => {
    const blob = [item.title, item.reason, item.snippet].filter(Boolean).join(' ')
    return !containsPesticideLanguage(blob)
  })
}
