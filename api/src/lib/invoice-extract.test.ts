import { beforeEach, describe, expect, it, vi } from 'vitest'

const { extractText, getDocumentProxy, completeChat, completeChatVision, isLlmConfigured, checkLlmBudget, consumeLlmBudget } =
  vi.hoisted(() => ({
    extractText: vi.fn(),
    getDocumentProxy: vi.fn(),
    completeChat: vi.fn(),
    completeChatVision: vi.fn(),
    isLlmConfigured: vi.fn(() => false),
    checkLlmBudget: vi.fn(() => ({ allowed: true, used: 0, limit: 500 })),
    consumeLlmBudget: vi.fn(),
  }))

vi.mock('unpdf', () => ({
  extractText,
  getDocumentProxy,
}))

vi.mock('./llm.js', () => ({
  completeChat,
  completeChatVision,
  isLlmConfigured,
}))

vi.mock('./llm-budget.js', () => ({
  checkLlmBudget,
  consumeLlmBudget,
}))

import {
  extractInvoiceFields,
  parseMoneyHeuristic,
  parseVendorHeuristic,
} from './invoice-extract.js'

describe('parseMoneyHeuristic', () => {
  it('reads USD amount due from invoice-style text', () => {
    expect(
      parseMoneyHeuristic('Amount due: $20.00 USD\nSubtotal $20.00\nTotal $20.00'),
    ).toEqual({ amount: 20, currency: 'USD' })
  })

  it('reads NGN totals from email subjects', () => {
    expect(parseMoneyHeuristic('Invoice NGN 12,500')).toEqual({ amount: 12500, currency: 'NGN' })
  })
})

describe('parseVendorHeuristic', () => {
  it('reads a digital-PDF issuer from a company address block', () => {
    expect(
      parseVendorHeuristic(
        [
          'Resend',
          '2261 Market Street #5039',
          'San Francisco, CA 94114',
          'United States',
          'Invoice',
        ].join('\n'),
      ),
    ).toBe('Resend')
  })

  it('does not guess a vendor from an unstructured invoice heading', () => {
    expect(parseVendorHeuristic('Invoice\nMonthly subscription\nAmount due: $20.00 USD')).toBeNull()
  })
})

describe('extractInvoiceFields', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isLlmConfigured.mockReturnValue(false)
    checkLlmBudget.mockReturnValue({ allowed: true, used: 0, limit: 500 })
    getDocumentProxy.mockResolvedValue({})
    extractText.mockResolvedValue({
      totalPages: 1,
      text: 'Resend\nAmount Due $20.00 USD\nDate of issue: August 10, 2026',
    })
  })

  it('prefills from PDF text before calling the LLM', async () => {
    const result = await extractInvoiceFields({
      farmId: 'farm-1',
      subject: 'Invoice for Resend subscription',
      bodyText: 'Kindly find attached',
      fromVendorHint: 'adefemi171',
      mime: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4'),
    })

    expect(result).toMatchObject({
      amount: 20,
      currency: 'USD',
      method: 'pdf_text',
    })
    expect(result.expenseDate?.toISOString()).toBe('2026-08-10T12:00:00.000Z')
    expect(completeChat).not.toHaveBeenCalled()
    expect(completeChatVision).not.toHaveBeenCalled()
  })

  it('falls back to LLM text when heuristics miss', async () => {
    isLlmConfigured.mockReturnValue(true)
    extractText.mockResolvedValue({
      totalPages: 1,
      text: 'Thanks for your business. See attached details.',
    })
    completeChat.mockResolvedValue({
      text: '{"amount":45,"currency":"USD","vendor":"Acme Tools","expenseDate":"2026-07-01"}',
      model: 'gpt-4o-mini',
    })

    const result = await extractInvoiceFields({
      farmId: 'farm-1',
      subject: 'Invoice attached',
      bodyText: 'Please process when you can',
      fromVendorHint: 'billing',
      mime: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4'),
    })

    expect(result).toEqual({
      amount: 45,
      currency: 'USD',
      vendor: 'Acme Tools',
      expenseDate: new Date('2026-07-01T12:00:00.000Z'),
      method: 'llm_text',
    })
    expect(consumeLlmBudget).toHaveBeenCalledWith('farm-1')
  })

  it('uses vision for image attachments when amount is missing', async () => {
    isLlmConfigured.mockReturnValue(true)
    completeChatVision.mockResolvedValue({
      text: '{"amount":8,"currency":"NGN","vendor":"Market Stall","expenseDate":null}',
      model: 'gpt-4o-mini',
    })

    const result = await extractInvoiceFields({
      farmId: 'farm-1',
      subject: 'Receipt photo',
      bodyText: 'from today',
      fromVendorHint: null,
      mime: 'image/jpeg',
      buffer: Buffer.from([0xff, 0xd8, 0xff]),
    })

    expect(result).toMatchObject({
      amount: 8,
      currency: 'NGN',
      vendor: 'Market Stall',
      method: 'llm_vision',
    })
    expect(completeChatVision).toHaveBeenCalled()
  })
})
