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
import { desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { customerInquiries } from '../db/schema.js'
import { PROMPT_INJECTION_RULES } from './ai-advisor.js'
import { completeChat, isLlmConfigured } from './llm.js'
import { checkLlmBudget, consumeLlmBudget } from './llm-budget.js'
import { formatCatalog, type CatalogItem } from './customer-cart.js'
import { foldForMatch } from './crop-normalize.js'
import { farmKnowledgeText } from './farm-knowledge.js'
import {
  publicMarketingUrlOrDefault,
  publicShopBaseUrl,
} from './public-app-url.js'
import {
  CUSTOMER_FAQ_MATCHERS,
  customerCatalogReply,
  customerDeliveryReply,
  customerLocationReply,
  customerPaymentReply,
  detectReplyLocale,
} from './reply-locale.js'

type Channel = 'telegram' | 'whatsapp'
type AnsweredVia = 'catalog' | 'llm' | 'faq' | 'suggested'

/** Starter suggestions shown before real usage data accumulates. */
export const DEFAULT_SUGGESTIONS = [
  'What do you sell?',
  'How much is plantain?',
  'How do Trovara Credits work?',
  'Where is the online shop?',
  'Where are you located?',
  'How does delivery work?',
]

export type CustomerRewardsContext = {
  balance: number
  referralCode: string
  referralUrl: string
  referralCount: number
  referralPendingCount: number
  referralActivatedCount: number
  welcomeCredits: number
  welcomeCreditAwarded: boolean
  referralCredits: number
  referralRefundWindowDays: number
}

/**
 * Curated labels for bot suggestion chips. More-specific topics first.
 * Founder insights keep raw customer phrasing; only customer-facing prompts
 * go through {@link canonicalizeForSuggestion}.
 */
const CANONICAL_TOPICS: { label: string; match: (normalized: string) => boolean }[] = [
  {
    label: 'How do Trovara Credits work?',
    match: (n) => /\b(trovara )?credits?\b/.test(n),
  },
  {
    label: 'Where is the online shop?',
    match: (n) => /\b(online shop|shop website|shop link|where.*shop)\b/.test(n),
  },
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

/** Questions whose answers depend on exact customer-programme terms or links. */
export function isCustomerProgrammeQuestion(question: string): boolean {
  return /\b(referral|refer|invite friend|ref code|referral code|personal link|(trovara )?credits?|credit balance|welcome credits?|basket|cart|buy again|repeat order|recurring order|family basket|survey|questionnaire|shop|online shop|shop website|shop link|customer account|sign up|register|log in|login)\b/.test(
    foldForMatch(question),
  )
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
    'Payment: pay online via the Paystack link we send after you order (when prices are set), or pay on delivery otherwise. Cancel within 24h: cancel TRV-ORD-…',
    'Delivery: we call to confirm your order, then deliver to your address.',
    `Online shop and customer account: ${publicShopBaseUrl()}`,
    `Customer food survey: ${new URL('/survey', publicMarketingUrlOrDefault()).toString()}`,
    'Baskets: customers can build or customise a basket in the shop. Recurring baskets are optional and require customer approval at checkout each time.',
    'Trovara Credits: eligible invited survey respondents receive 2,000 promotional credits after activating their Trovara account. Credits are not cash and can only be used on eligible Trovara Farm products.',
    'Referrals: a linked account has a personal survey link. The referrer receives 1,000 credits only after the referred customer completes the survey, activates an account, completes a first eligible purchase, and the refund period passes without a refund.',
  ]
}

function publicInfo(params: {
  farmName: string
  farmLocation: string
  catalog: CatalogItem[]
  rewards?: CustomerRewardsContext | null
}): string {
  const rewards = params.rewards
  return [
    `Farm: ${params.farmName}`,
    `Location: ${params.farmLocation}`,
    '',
    'Price list (the only prices you may quote):',
    formatCatalog(params.catalog),
    '',
    ...policyLines(),
    ...(rewards
      ? [
          '',
          'Linked customer rewards (private to this customer):',
          `Available balance: ${rewards.balance.toLocaleString('en-NG')} Trovara Credits`,
          `Referral code: ${rewards.referralCode}`,
          `Personal referral survey link: ${rewards.referralUrl}`,
          `Referrals: ${rewards.referralCount}; pending: ${rewards.referralPendingCount}; activated: ${rewards.referralActivatedCount}`,
        ]
      : []),
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
  rewards?: CustomerRewardsContext | null
}): { reply: string; answeredVia: AnsweredVia } {
  const { catalog, farmName, farmLocation } = params
  const locale = detectReplyLocale(params.question)

  // Folded on both sides so a buyer asking about "noix de coco?" reaches
  // "Noix de Coco": accents, case and punctuation stop mattering. This stays a
  // substring search, not the exact-name resolution `entity-name-match` does —
  // a question is prose that happens to contain a product name.
  const q = foldForMatch(params.question)
  const shopUrl = publicShopBaseUrl()
  const surveyUrl = new URL('/survey', publicMarketingUrlOrDefault()).toString()

  if (/\b(referral|refer|invite friend|ref code|referral code|personal link)\b/.test(q)) {
    if (params.rewards) {
      return {
        reply: [
          `Your referral code is ${params.rewards.referralCode}.`,
          `Share this personal survey link: ${params.rewards.referralUrl}`,
          `You have ${params.rewards.referralCount} referred survey${params.rewards.referralCount === 1 ? '' : 's'} (${params.rewards.referralPendingCount} pending, ${params.rewards.referralActivatedCount} activated).`,
          `You receive ${params.rewards.referralCredits.toLocaleString('en-NG')} Trovara Credits after a referred customer activates their account, completes their first eligible purchase, and its ${params.rewards.referralRefundWindowDays}-day refund period passes without a refund.`,
        ].join('\n'),
        answeredVia: 'faq',
      }
    }
    return {
      reply: `Your personal referral code and survey link are in the Trovara Credits tab after you sign in. To let me show account details here, link this chat from Connect Chat in ${shopUrl}.`,
      answeredVia: 'faq',
    }
  }

  if (/\b(trovara )?credits?\b|\bcredit balance\b|\bwelcome (award|credits?)\b/.test(q)) {
    if (params.rewards) {
      const welcome = params.rewards.welcomeCreditAwarded
        ? `${params.rewards.welcomeCredits.toLocaleString('en-NG')} welcome credits were awarded.`
        : 'No welcome-credit award is recorded on this account.'
      return {
        reply: `You have ${params.rewards.balance.toLocaleString('en-NG')} Trovara Credits available. ${welcome}\nView your balance and activity: ${shopUrl}`,
        answeredVia: 'faq',
      }
    }
    return {
      reply: `Trovara Credits are promotional credits for eligible Trovara Farm products, not cash. Eligible invited survey respondents receive 2,000 after activating their account. Sign in or connect this chat at ${shopUrl}.`,
      answeredVia: 'faq',
    }
  }

  if (/\b(basket|cart|buy again|repeat order|recurring order|family basket)\b/.test(q)) {
    return {
      reply: `Build or customise a basket at ${shopUrl}. Recurring baskets are optional, and you approve each one at checkout. You can also place an order here by replying "1". I cannot see an unfinished browser basket until it is checked out.`,
      answeredVia: 'faq',
    }
  }

  if (/\b(survey|questionnaire)\b/.test(q)) {
    return {
      reply: `Our food survey records the products and basket options customers want. Complete it here: ${surveyUrl}\nCurrent products and availability are shown in the shop: ${shopUrl}`,
      answeredVia: 'faq',
    }
  }

  if (/\b(shop|online shop|shop website|shop link|customer account|sign up|register|log in|login)\b/.test(q)) {
    return {
      reply: `Trovara Farm Shop is ${shopUrl}. You can create or manage your account, build a basket, view orders, connect WhatsApp or Telegram, and see Trovara Credits there.`,
      answeredVia: 'faq',
    }
  }
  const matched = catalog.filter((p) => {
    const name = foldForMatch(p.name)
    // An empty fold (a name that is only punctuation or a script the fold drops)
    // would otherwise match every question, since every string contains ''.
    if (!name) return false
    return q.includes(name) || name.split(' ').some((w) => w.length > 3 && q.includes(w))
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
      reply: `${customerCatalogReply(locale, lines.join('\n'), { kind: 'matched' })}\n\nShop online: ${shopUrl}`,
      answeredVia: 'catalog',
    }
  }

  if (CUSTOMER_FAQ_MATCHERS.price.test(q)) {
    return {
      reply: `${customerCatalogReply(locale, formatCatalog(catalog), { kind: 'priceList' })}\n\nShop online: ${shopUrl}`,
      answeredVia: 'catalog',
    }
  }
  if (CUSTOMER_FAQ_MATCHERS.location.test(q)) {
    return {
      reply: customerLocationReply(locale, farmName, farmLocation),
      answeredVia: 'faq',
    }
  }
  if (CUSTOMER_FAQ_MATCHERS.delivery.test(q)) {
    return {
      reply: customerDeliveryReply(locale),
      answeredVia: 'faq',
    }
  }
  if (CUSTOMER_FAQ_MATCHERS.payment.test(q)) {
    return {
      reply: customerPaymentReply(locale),
      answeredVia: 'faq',
    }
  }
  if (CUSTOMER_FAQ_MATCHERS.catalog.test(q)) {
    return {
      reply: `${customerCatalogReply(locale, formatCatalog(catalog), { kind: 'whatWeSell' })}\n\nShop online: ${shopUrl}`,
      answeredVia: 'catalog',
    }
  }

  return {
    reply: customerCatalogReply(locale, formatCatalog(catalog), {
      kind: 'thanks',
      farmName,
    }),
    answeredVia: 'faq',
  }
}

const CUSTOMER_PERSONA = [
  'You are the friendly sales assistant for a farm in Nigeria that sells fresh produce directly to customers over chat.',
  'Answer ONLY using the PUBLIC INFO provided below (products, prices, location, delivery and payment policy, customer shop, survey, baskets, Trovara Credits, referrals, and how to order).',
  'If asked about anything not covered - internal operations, staff, finances, other customers, or topics unrelated to buying our produce - politely say you can only help with our produce and orders.',
  'Never invent products, prices, or availability that are not in the PUBLIC INFO. If a product is not listed, say we do not currently sell it.',
  'Reply in the SAME language the customer used (English, Nigerian Pidgin, Yoruba, French, Hausa, or Igbo). Be warm, short, and plain text - no markdown, no tables.',
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
  farmId?: string
  rewards?: CustomerRewardsContext | null
}): Promise<{ reply: string; answeredVia: AnsweredVia }> {
  const fallback = deterministicAnswer(params)

  // Programme answers contain exact URLs, eligibility rules, and (when the
  // chat is linked) private customer balances. Keep these deterministic so an
  // LLM cannot alter the programme terms or expose a different customer's data.
  if (isCustomerProgrammeQuestion(params.question)) {
    return fallback
  }

  if (!isLlmConfigured()) return fallback

  if (params.farmId) {
    const budget = checkLlmBudget(params.farmId)
    if (!budget.allowed) return fallback
  }

  try {
    const system = [
      CUSTOMER_PERSONA,
      PROMPT_INJECTION_RULES,
      '\nPUBLIC INFO (the only facts you may use):',
      publicInfo(params),
    ].join('\n\n')
    const { text } = await completeChat(system, params.question.slice(0, 500))
    if (text) {
      if (params.farmId) consumeLlmBudget(params.farmId)
      return { reply: text, answeredVia: 'llm' }
    }
  } catch (err) {
    console.error('answerCustomerInquiry LLM failed:', err instanceof Error ? err.message : err)
  }
  return fallback
}
