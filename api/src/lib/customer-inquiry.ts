/**
 * Customer inquiry handling for the order bot.
 *
 * Customers can ask free-text questions about the farm and its produce ("do you
 * have eggs?", "how much is plantain?", "where are you?"). We answer from PUBLIC
 * info only (product catalogue, farm name/location, ordering + payment policy) -
 * never internal farm data (staff, finances, tasks). If an LLM is configured we
 * use it for natural replies; otherwise a deterministic FAQ fallback keeps the
 * bot useful with zero external dependencies.
 *
 * Every question is logged so Founders can see what customers ask most, and the
 * bot can suggest popular questions back to new customers.
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { customerInquiries } from '../db/schema.js'
import { PROMPT_INJECTION_RULES } from './ai-advisor.js'
import { completeChat, isLlmConfigured } from './llm.js'
import { formatCatalog, type CatalogItem } from './customer-cart.js'
import { farmKnowledgeText } from './farm-knowledge.js'

type Channel = 'telegram' | 'whatsapp'
type AnsweredVia = 'catalog' | 'llm' | 'faq' | 'suggested'

/** Starter suggestions shown before real usage data accumulates. */
export const DEFAULT_SUGGESTIONS = [
  'What do you sell?',
  'How much is plantain?',
  'Where are you located?',
  'How does delivery work?',
]

/**
 * Curated labels for bot suggestion chips. More-specific topics first.
 * Founder insights keep raw customer phrasing; only customer-facing prompts
 * go through {@link canonicalizeForSuggestion}.
 */
const CANONICAL_TOPICS: { label: string; match: (normalized: string) => boolean }[] = [
  {
    label: 'How much is plantain?',
    match: (n) =>
      n === normalizeQuestion('How much is plantain?') ||
      (n.includes('plantain') && /(price|cost|how much|much be|naira)/.test(n)),
  },
  {
    label: 'What are your prices?',
    match: (n) => /(price|cost|how much|much be|naira)/.test(n),
  },
  {
    label: 'Where are you located?',
    match: (n) => /(where|location|located|address|find you|come to|visit)/.test(n),
  },
  {
    label: 'How does delivery work?',
    match: (n) => /(deliver|delivery|ship|bring|dispatch)/.test(n),
  },
  {
    label: 'How do I pay?',
    match: (n) => /(pay|payment|transfer|card|cash)/.test(n),
  },
  {
    label: 'What do you sell?',
    match: (n) =>
      /(what|which|available|sell|have|stock|catalog|catalogue|produce|product)/.test(n),
  },
]

/** Collapse a question to a grouping key so "same" questions count together. */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
}

/**
 * Map a logged customer question to curated suggestion copy when the topic is
 * known; otherwise return the trimmed original (typos may still show).
 */
export function canonicalizeForSuggestion(question: string): string {
  const trimmed = question.trim()
  if (!trimmed) return trimmed
  const n = normalizeQuestion(trimmed)
  for (const topic of CANONICAL_TOPICS) {
    if (topic.match(n)) return topic.label
  }
  // Exact match against starter defaults (handles punct/case variants).
  for (const label of DEFAULT_SUGGESTIONS) {
    if (n === normalizeQuestion(label)) return label
  }
  return trimmed
}

export async function logInquiry(params: {
  farmId: string
  contactId?: string | null
  channel: Channel
  question: string
  answeredVia: AnsweredVia
}): Promise<void> {
  const question = params.question.trim().slice(0, 500)
  const normalized = normalizeQuestion(question)
  if (!normalized) return
  try {
    await db.insert(customerInquiries).values({
      farmId: params.farmId,
      contactId: params.contactId ?? null,
      channel: params.channel,
      question,
      normalized,
      answeredVia: params.answeredVia,
    })
  } catch (err) {
    // Analytics must never break the customer conversation.
    console.error('logInquiry failed:', err instanceof Error ? err.message : err)
  }
}

export type TopQuestion = { question: string; normalized: string; count: number }

/** Most-asked questions for a farm, grouped by normalized form (verbatim label). */
export async function topQuestions(farmId: string, limit = 10): Promise<TopQuestion[]> {
  const rows = await db
    .select({
      normalized: customerInquiries.normalized,
      count: sql<number>`COUNT(*)`.mapWith(Number),
      question: sql<string>`MAX(${customerInquiries.question})`,
    })
    .from(customerInquiries)
    .where(eq(customerInquiries.farmId, farmId))
    .groupBy(customerInquiries.normalized)
    .orderBy(desc(sql`COUNT(*)`))
    .limit(limit)
  return rows.map((r) => ({ question: r.question, normalized: r.normalized, count: r.count }))
}

/**
 * Questions to suggest to a customer: popular topics first (with curated
 * labels), padded with defaults so new farms still get useful prompts.
 */
export async function suggestedQuestions(farmId: string, limit = 3): Promise<string[]> {
  const top = await topQuestions(farmId, limit)
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of top) {
    const q = canonicalizeForSuggestion(t.question)
    const key = normalizeQuestion(q)
    if (q && !seen.has(key)) {
      seen.add(key)
      out.push(q)
    }
  }
  for (const q of DEFAULT_SUGGESTIONS) {
    if (out.length >= limit) break
    const key = normalizeQuestion(q)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(q)
    }
  }
  return out.slice(0, limit)
}

function policyLines(): string[] {
  return [
    'How to order: reply "1" and pick items by number.',
    'Payment: pay on delivery (card/transfer coming soon).',
    'Delivery: we call to confirm your order, then deliver to your address.',
  ]
}

function publicInfo(params: {
  farmName: string
  farmLocation: string
  catalog: CatalogItem[]
}): string {
  return [
    `Farm: ${params.farmName}`,
    `Location: ${params.farmLocation}`,
    '',
    'Price list (the only prices you may quote):',
    formatCatalog(params.catalog),
    '',
    ...policyLines(),
    '',
    farmKnowledgeText(),
  ].join('\n')
}

/** Keyword FAQ used when no LLM is configured (or as a safety net). */
function deterministicAnswer(params: {
  farmName: string
  farmLocation: string
  catalog: CatalogItem[]
  question: string
}): { reply: string; answeredVia: AnsweredVia } {
  const q = params.question.toLowerCase()
  const { catalog, farmName, farmLocation } = params

  const matched = catalog.filter((p) => {
    const name = p.name.toLowerCase()
    return q.includes(name) || name.split(/\s+/).some((w) => w.length > 3 && q.includes(w))
  })
  if (matched.length) {
    const lines = matched.map(
      (p) =>
        `• ${p.name} - ${
          p.priceKobo > 0
            ? `${(p.priceKobo / 100).toLocaleString('en-NG')} ${p.currency} / ${p.unit}`
            : 'price on request'
        } - available`,
    )
    return {
      reply: `Yes! Here's what we have:\n\n${lines.join('\n')}\n\nReply "1" to place an order.`,
      answeredVia: 'catalog',
    }
  }

  if (/(price|cost|how much|much be|magnitude|₦|naira)/.test(q)) {
    return {
      reply: `Here's our price list:\n\n${formatCatalog(catalog)}\n\nReply "1" to order.`,
      answeredVia: 'catalog',
    }
  }
  if (/(where|location|located|address|find you|come to|visit)/.test(q)) {
    return {
      reply: `${farmName} is based in ${farmLocation}. We deliver to you - reply "1" to order.`,
      answeredVia: 'faq',
    }
  }
  if (/(deliver|delivery|ship|bring|dispatch)/.test(q)) {
    return {
      reply:
        'We deliver to your address. After you order, we call to confirm, then deliver. Payment is on delivery.',
      answeredVia: 'faq',
    }
  }
  if (/(pay|payment|transfer|card|cash)/.test(q)) {
    return {
      reply: 'Payment is on delivery for now (card/transfer coming soon).',
      answeredVia: 'faq',
    }
  }
  if (/(what|which|available|sell|have|stock|catalog|catalogue|produce|product)/.test(q)) {
    return {
      reply: `Here's what we sell:\n\n${formatCatalog(catalog)}\n\nReply "1" to place an order.`,
      answeredVia: 'catalog',
    }
  }

  return {
    reply: [
      `Thanks for reaching out to ${farmName}! Here's what we sell:`,
      '',
      formatCatalog(catalog),
      '',
      'Reply "1" to place an order, or ask me anything about our produce.',
    ].join('\n'),
    answeredVia: 'faq',
  }
}

const CUSTOMER_PERSONA = [
  'You are the friendly sales assistant for a farm in Nigeria that sells fresh produce directly to customers over chat.',
  'Answer ONLY using the PUBLIC INFO provided below (products, prices, location, delivery and payment policy, how to order).',
  'If asked about anything not covered - internal operations, staff, finances, other customers, or topics unrelated to buying our produce - politely say you can only help with our produce and orders.',
  'Never invent products, prices, or availability that are not in the PUBLIC INFO. If a product is not listed, say we do not currently sell it.',
  'Reply in the SAME language the customer used (English, Nigerian Pidgin, Yoruba, Hausa, or Igbo). Be warm, short, and plain text - no markdown, no tables.',
  'Gently encourage the customer to place an order by replying "1" when it fits.',
].join(' ')

/**
 * Answer a customer's free-text question about the farm/produce. Uses the LLM
 * when configured, otherwise a deterministic keyword FAQ. Always public-safe.
 */
export async function answerCustomerInquiry(params: {
  farmName: string
  farmLocation: string
  catalog: CatalogItem[]
  question: string
}): Promise<{ reply: string; answeredVia: AnsweredVia }> {
  const fallback = deterministicAnswer(params)

  if (!isLlmConfigured()) return fallback

  try {
    const system = [
      CUSTOMER_PERSONA,
      PROMPT_INJECTION_RULES,
      '\nPUBLIC INFO (the only facts you may use):',
      publicInfo(params),
    ].join('\n\n')
    const { text } = await completeChat(system, params.question.slice(0, 500))
    if (text) return { reply: text, answeredVia: 'llm' }
  } catch (err) {
    console.error('answerCustomerInquiry LLM failed:', err instanceof Error ? err.message : err)
  }
  return fallback
}
