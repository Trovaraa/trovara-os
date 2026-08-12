import { extractText, getDocumentProxy } from 'unpdf'
import { completeChat, completeChatVision, isLlmConfigured } from './llm.js'
import { checkLlmBudget, consumeLlmBudget } from './llm-budget.js'

const ALLOWED_CURRENCIES = new Set([
  'NGN',
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'GHS',
  'KES',
  'ZAR',
  'XOF',
  'XAF',
])

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

const MONTHS: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
}

export type InvoiceExtractionMethod =
  | 'heuristic'
  | 'pdf_text'
  | 'llm_text'
  | 'llm_vision'
  | 'none'

export type InvoiceExtraction = {
  amount: number
  currency: string
  vendor: string | null
  expenseDate: Date | null
  method: InvoiceExtractionMethod
}

type MoneyHit = { amount: number; currency: string }

function normalizeCurrency(raw: string | null | undefined): string | null {
  if (!raw) return null
  const code = raw.trim().toUpperCase()
  return ALLOWED_CURRENCIES.has(code) ? code : null
}

function parseNumber(raw: string): number | null {
  const value = Number(raw.replace(/,/g, ''))
  if (!Number.isFinite(value) || value < 1) return null
  return Math.round(value)
}

/** Prefer labeled totals, then currency-prefixed amounts in the provided text. */
export function parseMoneyHeuristic(text: string): MoneyHit | null {
  const labeled = [
    ...text.matchAll(
      /(?:amount\s*due|total\s*due|balance\s*due|grand\s*total|invoice\s*total|\btotal\b)\s*[:.]?\s*(?:([A-Z]{3})\s*)?(?:\$|€|£|₦)?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)\s*(?:([A-Z]{3}))?/gi,
    ),
  ]
  for (const match of labeled) {
    const amount = parseNumber(match[2] ?? '')
    if (amount === null) continue
    const currency =
      normalizeCurrency(match[1]) ||
      normalizeCurrency(match[3]) ||
      (match[0].includes('$')
        ? 'USD'
        : match[0].includes('€')
          ? 'EUR'
          : match[0].includes('£')
            ? 'GBP'
            : match[0].includes('₦')
              ? 'NGN'
              : 'NGN')
    return { amount, currency }
  }

  const prefixed = [
    ...text.matchAll(
      /(?:USD|NGN|EUR|GBP|CAD|GHS|KES|ZAR|XOF|XAF)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/gi,
    ),
    ...text.matchAll(
      /(?:\$|€|£|₦)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)\s*(?:USD|NGN|EUR|GBP)?/gi,
    ),
    ...text.matchAll(/\bN\s*([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?)\b/gi),
  ]
  for (const match of prefixed) {
    const amount = parseNumber(match[1] ?? '')
    if (amount === null) continue
    const whole = match[0]
    const currency =
      normalizeCurrency(whole.match(/\b(USD|NGN|EUR|GBP|CAD|GHS|KES|ZAR|XOF|XAF)\b/i)?.[1]) ||
      (whole.includes('$') ? 'USD' : whole.includes('€') ? 'EUR' : whole.includes('£') ? 'GBP' : 'NGN')
    return { amount, currency }
  }

  return null
}

export function parseVendorHeuristic(text: string): string | null {
  const billFrom = text.match(/(?:bill\s*from|from|vendor|supplier)\s*[:]\s*([^\n\r|]{2,80})/i)
  if (billFrom?.[1]) return billFrom[1].trim().slice(0, 200)

  // Digital invoices often render the issuer as a company name followed by its
  // postal address, without a "Vendor:" label. Only accept the company line
  // when the following lines have a strong address shape; a lone heading is not
  // enough evidence to guess a vendor.
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const generic = /^(?:invoice|receipt|statement|bill|tax invoice|amount due|from|to)$/i
  const streetAddress = /^\d{1,6}\s+[\p{L}\d][\p{L}\d .,'#/-]{2,80}$/u
  const locality = /\b(?:[A-Z]{2}\s+\d{5}(?:-\d{4})?|\d{4,6}|[A-Z]\d[A-Z]\s?\d[A-Z]\d)\b/i
  for (let index = 0; index < lines.length - 2; index += 1) {
    const candidate = lines[index]
    if (
      candidate.length < 2 ||
      candidate.length > 120 ||
      generic.test(candidate) ||
      /[@$€£₦]|\b(?:total|date|due|invoice|receipt)\b/i.test(candidate)
    ) {
      continue
    }
    if (streetAddress.test(lines[index + 1]) && locality.test(lines[index + 2])) {
      return candidate.slice(0, 200)
    }
  }
  return null
}

/** Parse common invoice date labels into a UTC calendar date (noon UTC). */
export function parseDateHeuristic(text: string): Date | null {
  const labeled = text.match(
    /(?:date\s*of\s*issue|invoice\s*date|issue\s*date|dated)\s*[:.]?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})/i,
  )
  const raw = labeled?.[1]?.trim()
  if (!raw) return null

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) {
    return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12))
  }

  const named = raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/)
  if (named) {
    const month = MONTHS[named[1].toLowerCase()]
    if (month === undefined) return null
    return new Date(Date.UTC(Number(named[3]), month, Number(named[2]), 12))
  }

  const slash = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/)
  if (slash) {
    let year = Number(slash[3])
    if (year < 100) year += 2000
    // Prefer day-first for farm ops (common outside US); clamp invalid months.
    const day = Number(slash[1])
    const monthIndex = Number(slash[2]) - 1
    if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null
    return new Date(Date.UTC(year, monthIndex, day, 12))
  }

  return null
}

export async function extractPdfPlainText(buffer: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { text } = await extractText(pdf, { mergePages: true })
  if (Array.isArray(text)) return text.join('\n').trim()
  return String(text ?? '').trim()
}

function parseLlmJson(raw: string): Partial<InvoiceExtraction> | null {
  const fenced = raw.match(/\{[\s\S]*\}/)
  if (!fenced) return null
  try {
    const parsed = JSON.parse(fenced[0]) as {
      amount?: unknown
      currency?: unknown
      vendor?: unknown
      expenseDate?: unknown
    }
    const amount =
      typeof parsed.amount === 'number'
        ? Math.round(parsed.amount)
        : typeof parsed.amount === 'string'
          ? parseNumber(parsed.amount)
          : null
    const currency = normalizeCurrency(typeof parsed.currency === 'string' ? parsed.currency : null)
    const vendor =
      typeof parsed.vendor === 'string' && parsed.vendor.trim()
        ? parsed.vendor.trim().slice(0, 200)
        : null
    let expenseDate: Date | null = null
    if (typeof parsed.expenseDate === 'string' && parsed.expenseDate.trim()) {
      expenseDate = parseDateHeuristic(`invoice date: ${parsed.expenseDate}`)
      if (!expenseDate) {
        const date = new Date(parsed.expenseDate)
        if (!Number.isNaN(date.getTime())) expenseDate = date
      }
    }
    const usefulAmount = amount !== null && amount >= 1 ? amount : undefined
    if (usefulAmount === undefined && !currency && !vendor && !expenseDate) return null
    return {
      amount: usefulAmount,
      currency: currency ?? undefined,
      vendor,
      expenseDate,
    }
  } catch {
    return null
  }
}

const EXTRACT_SYSTEM = `You extract invoice fields for farm accounting.
Return ONLY compact JSON with keys: amount (number), currency (ISO 4217 like USD/NGN), vendor (string|null), expenseDate (YYYY-MM-DD|null).
Prefer Amount Due / Total. Do not invent values.`

async function extractWithLlmText(farmId: string, text: string): Promise<Partial<InvoiceExtraction> | null> {
  if (!isLlmConfigured()) return null
  const budget = checkLlmBudget(farmId)
  if (!budget.allowed) return null
  try {
    const { text: reply } = await completeChat(
      EXTRACT_SYSTEM,
      `Extract invoice fields from this text:\n\n${text.slice(0, 12000)}`,
    )
    consumeLlmBudget(farmId)
    return parseLlmJson(reply)
  } catch {
    return null
  }
}

async function extractWithLlmVision(
  farmId: string,
  mime: string,
  buffer: Buffer,
  context: string,
): Promise<Partial<InvoiceExtraction> | null> {
  if (!isLlmConfigured()) return null
  const budget = checkLlmBudget(farmId)
  if (!budget.allowed) return null
  const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
  try {
    const { text: reply } = await completeChatVision(
      EXTRACT_SYSTEM,
      `Extract invoice fields from this receipt/invoice image.\nContext:\n${context.slice(0, 2000)}`,
      [dataUrl],
    )
    consumeLlmBudget(farmId)
    return parseLlmJson(reply)
  } catch {
    return null
  }
}

function mergeExtraction(
  base: InvoiceExtraction,
  next: Partial<InvoiceExtraction> | null,
  method: InvoiceExtractionMethod,
): InvoiceExtraction {
  if (!next) return base
  const hasUsefulValue =
    (typeof next.amount === 'number' && next.amount >= 1) ||
    Boolean(next.currency) ||
    Boolean(next.vendor) ||
    Boolean(next.expenseDate)
  if (!hasUsefulValue) return base
  return {
    amount: typeof next.amount === 'number' && next.amount >= 1 ? next.amount : base.amount,
    currency: next.currency || base.currency || 'NGN',
    vendor: next.vendor ?? base.vendor,
    expenseDate: next.expenseDate ?? base.expenseDate,
    method,
  }
}

/**
 * Hybrid invoice extraction: PDF text + heuristics first, then LLM text/vision fallback.
 */
export async function extractInvoiceFields(params: {
  farmId: string
  subject: string
  bodyText: string
  fromVendorHint: string | null
  mime: string | null
  buffer: Buffer | null
}): Promise<InvoiceExtraction> {
  let documentText = ''
  if (params.buffer && params.mime === 'application/pdf') {
    try {
      documentText = await extractPdfPlainText(params.buffer)
    } catch {
      documentText = ''
    }
  }

  const combined = [params.subject, params.bodyText, documentText].filter(Boolean).join('\n')
  const money = parseMoneyHeuristic(combined)
  const parsedVendor = parseVendorHeuristic(combined)
  const parsedDate = parseDateHeuristic(combined)
  const hasHeuristicValue = Boolean(money || parsedVendor || parsedDate)
  let result: InvoiceExtraction = {
    amount: money?.amount ?? 0,
    currency: money?.currency ?? 'NGN',
    vendor: parsedVendor ?? params.fromVendorHint,
    expenseDate: parsedDate,
    method: hasHeuristicValue ? (documentText ? 'pdf_text' : 'heuristic') : 'none',
  }

  if (result.amount >= 1) return result

  if (params.buffer && params.mime && IMAGE_TYPES.has(params.mime)) {
    const vision = await extractWithLlmVision(
      params.farmId,
      params.mime,
      params.buffer,
      `${params.subject}\n${params.bodyText}`,
    )
    result = mergeExtraction(result, vision, 'llm_vision')
    if (result.amount >= 1) return result
  }

  if (combined.trim().length >= 40) {
    const llm = await extractWithLlmText(params.farmId, combined)
    result = mergeExtraction(result, llm, 'llm_text')
  }

  return result
}
