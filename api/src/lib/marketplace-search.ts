import { completeChat, isLlmConfigured, parseJsonFromLlm } from './llm.js'
import { checkLlmBudget, consumeLlmBudget } from './llm-budget.js'
import { containsPesticideLanguage, filterUnsafeProductText } from './pesticide-filter.js'
import type { ReplyLocale } from './reply-locale.js'
import { sanitizeForLlm } from './sanitize-input.js'

export type MarketplaceProductHit = {
  title: string
  url: string | null
  source: 'search' | 'llm'
  priceText?: string
  reason?: string
  thumbnail?: string
}

type ResolveArgs = {
  farmLocation: string | null | undefined
  needQuery: string
  locale?: ReplyLocale
  farmId?: string
  limit?: number
}

const cache = new Map<string, { expiresAt: number; hits: MarketplaceProductHit[] }>()
const CACHE_TTL_MS = 12 * 60 * 60 * 1000

function cacheKey(location: string, needQuery: string): string {
  return `${location.trim().toLowerCase()}::${needQuery.trim().toLowerCase()}`
}

function buildSearchQuery(needQuery: string, location: string): string {
  const loc = location.trim() || 'Nigeria'
  return `${needQuery} agrovet OR farm supply ${loc}`.slice(0, 200)
}

async function searchSerpApi(query: string, limit: number): Promise<MarketplaceProductHit[]> {
  const key = process.env.MARKETPLACE_SEARCH_API_KEY?.trim()
  if (!key) return []

  const provider = (process.env.MARKETPLACE_SEARCH_PROVIDER || 'serpapi').toLowerCase()
  if (provider !== 'serpapi') return []

  const url = new URL('https://serpapi.com/search.json')
  url.searchParams.set('engine', 'google')
  url.searchParams.set('q', query)
  url.searchParams.set('num', String(Math.min(limit + 2, 10)))
  url.searchParams.set('api_key', key)
  url.searchParams.set('gl', 'ng')
  url.searchParams.set('hl', 'en')

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(12_000) })
  if (!res.ok) return []
  const data = (await res.json()) as {
    organic_results?: Array<{ title?: string; link?: string; snippet?: string }>
    shopping_results?: Array<{ title?: string; link?: string; price?: string; thumbnail?: string }>
  }

  const hits: MarketplaceProductHit[] = []
  for (const row of data.shopping_results ?? []) {
    if (!row.title || !row.link) continue
    hits.push({
      title: row.title.slice(0, 120),
      url: row.link,
      source: 'search',
      priceText: row.price?.slice(0, 40),
      thumbnail: row.thumbnail,
    })
  }
  for (const row of data.organic_results ?? []) {
    if (!row.title || !row.link) continue
    hits.push({
      title: row.title.slice(0, 120),
      url: row.link,
      source: 'search',
      reason: row.snippet?.slice(0, 160),
    })
  }

  return filterUnsafeProductText(hits).slice(0, limit)
}

async function llmLocalSuggestions(
  needQuery: string,
  location: string,
  locale: ReplyLocale,
  farmId: string | undefined,
  limit: number,
): Promise<MarketplaceProductHit[]> {
  if (!isLlmConfigured()) return []
  if (farmId) {
    const budget = checkLlmBudget(farmId)
    if (!budget.allowed) return []
  }

  const prompt = [
    'You suggest farm INPUT product types available near a location in Nigeria/Africa.',
    'NEVER recommend pesticides, herbicides, insecticides, fungicides, or banned sprays.',
    'Only suggest: organic fertilizer/compost, soil amendments, mulch, irrigation aids, seeds/seedlings,',
    'poultry feed/vitamins/probiotics/disinfectants, vaccine-related supplies, tools/consumables.',
    'Do NOT invent clickable URLs. Return JSON only:',
    '{"products":[{"title":"...","reason":"why useful near this location","shopHint":"local agrovet|feed mill|market"}]}',
  ].join(' ')

  try {
    const { text } = await completeChat(
      prompt,
      `Location: ${sanitizeForLlm(location)}\nNeed: ${sanitizeForLlm(needQuery)}\nLocale: ${locale}`,
    )
    if (farmId) consumeLlmBudget(farmId)
    const parsed = parseJsonFromLlm<{ products?: Array<{ title?: string; reason?: string; shopHint?: string }> }>(
      text,
    )
    const hits: MarketplaceProductHit[] = []
    for (const p of parsed.products ?? []) {
      if (!p.title || containsPesticideLanguage(p.title) || containsPesticideLanguage(p.reason ?? '')) continue
      const reason = [p.reason, p.shopHint].filter(Boolean).join(' · ').slice(0, 200)
      hits.push({ title: p.title.slice(0, 120), url: null, source: 'llm', reason })
    }
    return hits.slice(0, limit)
  } catch {
    return []
  }
}

/** Resolve 1–3 safe product suggestions: live search first, LLM fallback. */
export async function resolveMarketplaceProducts(args: ResolveArgs): Promise<MarketplaceProductHit[]> {
  const needQuery = args.needQuery.trim()
  if (!needQuery || containsPesticideLanguage(needQuery)) return []

  const location = (args.farmLocation || 'Nigeria').trim()
  const limit = args.limit ?? 3
  const locale = args.locale ?? 'en'
  const key = cacheKey(location, needQuery)
  const cached = cache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.hits.slice(0, limit)

  let hits: MarketplaceProductHit[] = []
  try {
    hits = await searchSerpApi(buildSearchQuery(needQuery, location), limit)
  } catch {
    hits = []
  }

  if (hits.length === 0) {
    hits = await llmLocalSuggestions(needQuery, location, locale, args.farmId, limit)
  }

  hits = filterUnsafeProductText(hits).slice(0, limit)
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, hits })
  return hits
}

/** Test helper */
export function _clearMarketplaceSearchCache(): void {
  cache.clear()
}
