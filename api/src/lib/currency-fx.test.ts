import { afterEach, describe, expect, it, vi } from 'vitest'
import { convertToNgn, FxAmountOverflowError, rateToNgn } from './currency-fx.js'

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.FX_FALLBACK_RATES
})

describe('currency FX', () => {
  it('passes NGN through without conversion metadata', async () => {
    await expect(convertToNgn(12500, 'ngn')).resolves.toEqual({
      amount: 12500,
      currency: 'NGN',
      originalAmount: null,
      originalCurrency: null,
      fxRate: null,
      fxConvertedAt: null,
      fxRateDate: null,
      fxRateSource: null,
    })
  })

  it('converts a foreign amount using the live NGN rate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ result: 'success', rates: { NGN: 1550.25 } }),
      ),
    )

    const converted = await convertToNgn(20, 'USD')

    expect(converted).toMatchObject({
      amount: 31005,
      currency: 'NGN',
      originalAmount: '20',
      originalCurrency: 'USD',
      fxRate: '1550.25',
      fxRateSource: 'open.er-api.com',
    })
    expect(converted?.fxConvertedAt).toBeInstanceOf(Date)
  })

  it('uses configured fallback rates when the live service is unavailable', async () => {
    process.env.FX_FALLBACK_RATES = 'USD:1500, EUR:1700'
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline')
    }))

    await expect(rateToNgn('usd')).resolves.toBe(1500)
  })

  it('returns null instead of inventing an exchange rate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    await expect(convertToNgn(20, 'USD')).resolves.toBeNull()
  })

  it('uses a transaction-date rate for historical expenses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ date: '2020-01-15', usd: { ngn: 360.5 } })),
    )

    const converted = await convertToNgn(20, 'USD', new Date('2020-01-15T12:00:00Z'))

    expect(converted).toMatchObject({
      amount: 7210,
      fxRate: '360.5',
      fxRateDate: '2020-01-15',
      fxRateSource: 'fawazahmed0-currency-api',
    })
  })

  it('rejects conversions that would overflow the integer amount column', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ result: 'success', rates: { NGN: 1550 } })),
    )

    await expect(convertToNgn(2_000_000, 'USD')).rejects.toBeInstanceOf(FxAmountOverflowError)
  })
})