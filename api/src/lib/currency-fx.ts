const FX_ENDPOINT = 'https://open.er-api.com/v6/latest'
const FX_HISTORICAL_ENDPOINT =
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api'
const FX_TIMEOUT_MS = 5_000
/** PostgreSQL integer upper bound used by expenses.amount. */
export const MAX_EXPENSE_AMOUNT = 2_147_483_647

export class FxAmountOverflowError extends Error {
  constructor() {
    super('Converted amount exceeds the maximum stored expense amount')
    this.name = 'FxAmountOverflowError'
  }
}

export type NgnConversion = {
  amount: number
  currency: 'NGN'
  originalAmount: string | null
  originalCurrency: string | null
  fxRate: string | null
  fxConvertedAt: Date | null
  fxRateDate: string | null
  fxRateSource: string | null
}

function normalizedCurrency(value: string): string {
  return value.trim().toUpperCase()
}

function fallbackRate(currency: string): number | null {
  const entries = (process.env.FX_FALLBACK_RATES ?? '').split(',')
  for (const entry of entries) {
    const [code, rawRate] = entry.split(':').map((part) => part.trim())
    if (normalizedCurrency(code ?? '') !== currency) continue
    const rate = Number(rawRate)
    return Number.isFinite(rate) && rate > 0 ? rate : null
  }
  return null
}

async function liveRate(currency: string): Promise<number | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FX_TIMEOUT_MS)
  try {
    const response = await fetch(`${FX_ENDPOINT}/${encodeURIComponent(currency)}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return null
    const payload = (await response.json()) as {
      result?: string
      rates?: Record<string, unknown>
    }
    const rate = Number(payload.rates?.NGN)
    return payload.result === 'success' && Number.isFinite(rate) && rate > 0 ? rate : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function historicalRate(
  currency: string,
  rateDate: string,
): Promise<number | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FX_TIMEOUT_MS)
  try {
    const code = currency.toLowerCase()
    const response = await fetch(
      `${FX_HISTORICAL_ENDPOINT}@${encodeURIComponent(rateDate)}/v1/currencies/${encodeURIComponent(code)}.json`,
      { headers: { Accept: 'application/json' }, signal: controller.signal },
    )
    if (!response.ok) return null
    const payload = (await response.json()) as Record<string, unknown>
    const rates = payload[code]
    const rate =
      rates && typeof rates === 'object'
        ? Number((rates as Record<string, unknown>).ngn)
        : Number.NaN
    return Number.isFinite(rate) && rate > 0 ? rate : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function assertStorableAmount(amount: number): number {
  const rounded = Math.round(amount)
  if (!Number.isFinite(rounded) || rounded < 0 || rounded > MAX_EXPENSE_AMOUNT) {
    throw new FxAmountOverflowError()
  }
  return rounded
}

export async function rateToNgn(currency: string): Promise<number | null> {
  const normalized = normalizedCurrency(currency)
  if (normalized === 'NGN') return 1
  return (await liveRate(normalized)) ?? fallbackRate(normalized)
}

async function currentRateQuote(
  currency: string,
): Promise<{ rate: number; source: string } | null> {
  const live = await liveRate(currency)
  if (live !== null) return { rate: live, source: 'open.er-api.com' }
  const fallback = fallbackRate(currency)
  return fallback === null ? null : { rate: fallback, source: 'FX_FALLBACK_RATES' }
}

export async function convertToNgn(
  amount: number,
  currency: string,
  asOfDate: Date = new Date(),
): Promise<NgnConversion | null> {
  const normalized = normalizedCurrency(currency)
  const rateDate = asOfDate.toISOString().slice(0, 10)
  if (normalized === 'NGN') {
    return {
      amount: assertStorableAmount(amount),
      currency: 'NGN',
      originalAmount: null,
      originalCurrency: null,
      fxRate: null,
      fxConvertedAt: null,
      fxRateDate: null,
      fxRateSource: null,
    }
  }

  const today = new Date().toISOString().slice(0, 10)
  const isHistorical = rateDate < today
  const quote = isHistorical
    ? {
        rate: await historicalRate(normalized, rateDate),
        source: 'fawazahmed0-currency-api',
      }
    : await currentRateQuote(normalized)
  if (!quote || quote.rate === null) return null

  return {
    amount: assertStorableAmount(amount * quote.rate),
    currency: 'NGN',
    originalAmount: String(amount),
    originalCurrency: normalized,
    fxRate: String(quote.rate),
    fxConvertedAt: new Date(),
    fxRateDate: rateDate,
    fxRateSource: quote.source,
  }
}
