import { describe, expect, it } from 'vitest'
import { renderInvoicePdf } from './invoice-pdf.js'

describe('renderInvoicePdf', () => {
  it('returns a non-empty PDF buffer', async () => {
    const pdf = await renderInvoicePdf({
      invoiceNumber: 'TRV-INV-2026-00001',
      amountKobo: 150000,
      currency: 'NGN',
      createdAt: new Date('2026-07-19T12:00:00Z'),
      snapshot: {
        orderReference: 'TRV-ORD-ABCDEF',
        customerName: 'Ada O.',
        paymentReference: 'TRV-PAY-ABCDEF-12345678',
        lines: [
          {
            productName: 'Eggs crate',
            unit: 'crate',
            quantity: 2,
            unitPriceKobo: 75000,
            lineTotalKobo: 150000,
          },
        ],
        amountKobo: 150000,
        paidAt: '2026-07-19T12:05:00Z',
      },
      farmName: 'Trovara Farm',
    })

    expect(Buffer.isBuffer(pdf)).toBe(true)
    expect(pdf.length).toBeGreaterThan(500)
    expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF')
  })
})
