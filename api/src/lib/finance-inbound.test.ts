import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isAllowedInboundDownloadUrl,
  isFinanceInboundRecipient,
  processFinanceInboundWebhook,
} from './finance-inbound.js'
import { verifyResendWebhook } from './newsletter-resend.js'

type Row = Record<string, unknown>

const {
  eventData,
  insertReturning,
  expenseInsertReturning,
  insertedValues,
  updates,
  selectQueue,
  resendGet,
  resendAttachmentList,
  mkdir,
  writeFile,
  convertToNgn,
} = vi.hoisted(() => ({
  eventData: {
    email_id: 'email-1' as string | undefined,
    from: 'Vendor Co <bills@vendor.test>',
    to: ['finance@trovara.farm'],
    subject: 'Invoice NGN 12,500',
    message_id: '<msg-1>',
  },
  insertReturning: vi.fn(),
  expenseInsertReturning: vi.fn(),
  insertedValues: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  selectQueue: [] as Array<Array<Record<string, unknown>>>,
  resendGet: vi.fn(),
  resendAttachmentList: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  convertToNgn: vi.fn(),
}))

vi.mock('./newsletter-resend.js', () => ({
  verifyResendWebhook: vi.fn(() => ({
    type: 'email.received',
    data: { ...eventData, to: [...eventData.to] },
  })),
  resendInboundWebhookSecret: vi.fn(() => 'whsec_inbound_test'),
}))

vi.mock('../db/index.js', () => ({
  db: {
    insert: () => ({
      values: (values: Row) => {
        insertedValues.push(values)
        return {
          onConflictDoNothing: () => ({ returning: insertReturning }),
          returning: expenseInsertReturning,
        }
      },
    }),
    update: () => ({
      set: (values: Row) => {
        updates.push(values)
        return {
          where: vi.fn(() => ({
            returning: async () => [{ id: 'evt-1', svixId: 'msg_1', ...values }],
          })),
        }
      },
    }),
    select: () => {
      const rows = selectQueue.shift() ?? []
      const chain: Record<string, unknown> = {}
      const same = () => chain
      Object.assign(chain, {
        from: same,
        where: same,
        orderBy: same,
        limit: async () => rows,
        then: (
          resolve: (value: Row[]) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise.resolve(rows).then(resolve, reject),
      })
      return chain
    },
  },
}))

vi.mock('./customer-orders.js', () => ({
  resolveCustomerFarm: vi.fn(async () => ({ id: 'farm-1', name: 'Trovara', location: 'Abeokuta' })),
}))

vi.mock('./evidence-store.js', () => ({
  getEvidenceStorageRoot: () => '/tmp/trovara-evidence-test',
}))

vi.mock('./audit.js', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('./currency-fx.js', () => ({ convertToNgn }))

vi.mock('node:fs/promises', () => ({ mkdir, writeFile }))

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      receiving: {
        get: resendGet,
        attachments: {
          list: resendAttachmentList,
        },
      },
    }
  },
}))

describe('processFinanceInboundWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.RESEND_API_KEY = 're_test'
    process.env.RESEND_INBOUND_WEBHOOK_SECRET = 'whsec_inbound_test'
    process.env.FINANCE_INBOUND_FARM_ID = 'farm-1'
    delete process.env.FINANCE_INBOUND_RECIPIENTS
    eventData.email_id = 'email-1'
    eventData.to = ['finance@trovara.farm']
    insertedValues.length = 0
    updates.length = 0
    selectQueue.length = 0
    insertReturning.mockResolvedValue([{ id: 'evt-1' }])
    expenseInsertReturning.mockResolvedValue([
      {
        id: 'exp-1',
        amount: 12500,
      },
    ])
    convertToNgn.mockImplementation(async (amount: number, currency: string) =>
      currency === 'NGN'
        ? {
            amount,
            currency: 'NGN',
            originalAmount: null,
            originalCurrency: null,
            fxRate: null,
            fxConvertedAt: null,
          }
        : {
            amount: Math.round(amount * 1550),
            currency: 'NGN',
            originalAmount: String(amount),
            originalCurrency: currency,
            fxRate: '1550',
            fxConvertedAt: new Date('2026-08-10T12:01:00.000Z'),
          },
    )
    vi.mocked(verifyResendWebhook).mockImplementation(() => ({
      type: 'email.received',
      data: { ...eventData, to: [...eventData.to] },
    }) as never)
    resendGet.mockResolvedValue({
      data: {
        subject: 'Invoice NGN 12,500',
        from: 'Vendor Co <bills@vendor.test>',
        text: 'Please pay NGN 12,500',
        created_at: '2026-08-10T12:00:00.000Z',
      },
      error: null,
    })
    resendAttachmentList.mockResolvedValue({
      data: {
        data: [
          {
            id: 'pdf-default',
            filename: 'invoice.pdf',
            content_type: 'application/pdf',
            download_url: 'https://files.test/default-invoice',
          },
        ],
      },
      error: null,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 })),
    )
    selectQueue.push([{ id: 'user-1' }], [])
  })

  it('creates a pending draft expense from email.received', async () => {
    const result = await processFinanceInboundWebhook({
      rawBody: '{}',
      svixId: 'msg_1',
      svixTimestamp: '1',
      svixSignature: 'v1,sig',
    })
    expect(result.ok).toBe(true)
    expect(result.expenseId).toBe('exp-1')
    expect(expenseInsertReturning).toHaveBeenCalled()
    expect(insertedValues[1]).toMatchObject({
      farmId: 'farm-1',
      amount: 12500,
      source: 'inbound_email',
      inboundMessageId: 'email-1',
      inboundSenderEmail: 'bills@vendor.test',
      inboundSenderName: 'Vendor Co',
      receiptRef: '<msg-1>',
      approvalStatus: 'pending',
    })
    expect(verifyResendWebhook).toHaveBeenCalledWith(
      '{}',
      { id: 'msg_1', timestamp: '1', signature: 'v1,sig' },
      { webhookSecret: 'whsec_inbound_test' },
    )
  })

  it('stores foreign invoices in NGN while preserving the original amount and rate', async () => {
    resendGet.mockResolvedValueOnce({
      data: {
        subject: 'Resend invoice USD 20.00',
        from: 'Resend <billing@resend.com>',
        text: 'Total due: USD 20.00',
        created_at: '2026-08-10T12:00:00.000Z',
      },
      error: null,
    })

    const result = await processFinanceInboundWebhook({
      rawBody: '{}',
      svixId: 'msg_usd',
      svixTimestamp: '1',
      svixSignature: 'v1,sig',
    })

    expect(result.expenseId).toBe('exp-1')
    expect(convertToNgn).toHaveBeenCalledWith(
      20,
      'USD',
      new Date('2026-08-10T12:00:00.000Z'),
    )
    expect(insertedValues[1]).toMatchObject({
      amount: 31000,
      currency: 'NGN',
      originalAmount: '20',
      originalCurrency: 'USD',
      fxRate: '1550',
      approvalStatus: 'pending',
    })
  })

  it('rejects an invalid signature before recording an event', async () => {
    vi.mocked(verifyResendWebhook).mockImplementationOnce(() => {
      throw new Error('Invalid webhook signature')
    })

    await expect(
      processFinanceInboundWebhook({
        rawBody: '{"type":"email.received"}',
        svixId: 'msg_bad',
        svixTimestamp: '1',
        svixSignature: 'v1,bad',
      }),
    ).rejects.toThrow('Invalid webhook signature')
    expect(insertReturning).not.toHaveBeenCalled()
    expect(expenseInsertReturning).not.toHaveBeenCalled()
  })

  it('returns idempotently for a repeated Svix event', async () => {
    insertReturning.mockResolvedValueOnce([])
    selectQueue.length = 0
    selectQueue.push([{ id: 'evt-existing', status: 'processed', expenseId: null }])

    const result = await processFinanceInboundWebhook({
      rawBody: '{}',
      svixId: 'msg_repeat',
      svixTimestamp: '1',
      svixSignature: 'v1,sig',
    })

    expect(result).toEqual({ ok: true, duplicate: true })
    expect(resendGet).not.toHaveBeenCalled()
    expect(expenseInsertReturning).not.toHaveBeenCalled()
  })

  it('reuses an expense when Resend retries the email under a new Svix id', async () => {
    selectQueue.length = 0
    selectQueue.push([{ id: 'user-1' }], [{ id: 'exp-existing' }])

    const result = await processFinanceInboundWebhook({
      rawBody: '{}',
      svixId: 'msg_new_delivery',
      svixTimestamp: '1',
      svixSignature: 'v1,sig',
    })

    expect(result).toEqual({ ok: true, expenseId: 'exp-existing', duplicate: true })
    expect(updates).toContainEqual(
      expect.objectContaining({
        status: 'duplicate',
        expenseId: 'exp-existing',
        resendEmailId: 'email-1',
      }),
    )
    expect(resendGet).not.toHaveBeenCalled()
    expect(expenseInsertReturning).not.toHaveBeenCalled()
  })

  it('ignores mail not addressed to a configured finance recipient', async () => {
    eventData.to = ['orders@trovara.farm']

    const result = await processFinanceInboundWebhook({
      rawBody: '{}',
      svixId: 'msg_orders',
      svixTimestamp: '1',
      svixSignature: 'v1,sig',
    })

    expect(result).toEqual({ ok: true, ignored: true })
    expect(updates).toContainEqual(
      expect.objectContaining({
        status: 'ignored',
        resendEmailId: 'email-1',
      }),
    )
    expect(resendGet).not.toHaveBeenCalled()
    expect(expenseInsertReturning).not.toHaveBeenCalled()
  })

  it('records email without a supported attachment as ignored and creates no expense', async () => {
    resendAttachmentList.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: 'text-1',
            filename: 'notes.txt',
            content_type: 'text/plain',
            download_url: 'https://files.test/notes',
          },
        ],
      },
      error: null,
    })

    const result = await processFinanceInboundWebhook({
      rawBody: '{}',
      svixId: 'msg_no_supported_attachment',
      svixTimestamp: '1',
      svixSignature: 'v1,sig',
    })

    expect(result).toEqual({ ok: true, ignored: true })
    expect(updates).toContainEqual(
      expect.objectContaining({
        status: 'ignored',
        resendEmailId: 'email-1',
        detail: 'No supported PDF, JPEG, PNG, or WebP attachment was available',
      }),
    )
    expect(expenseInsertReturning).not.toHaveBeenCalled()
    expect(insertedValues).toHaveLength(1)
  })

  it('ignores a PDF whose download host is outside the Resend allowlist', async () => {
    resendAttachmentList.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: 'pdf-1',
            filename: 'invoice.pdf',
            content_type: 'application/pdf',
            download_url: 'https://files.example/invoice.pdf',
          },
        ],
      },
      error: null,
    })

    const result = await processFinanceInboundWebhook({
      rawBody: '{}',
      svixId: 'msg_blocked_host',
      svixTimestamp: '1',
      svixSignature: 'v1,sig',
    })

    expect(result).toEqual({ ok: true, ignored: true })
    expect(expenseInsertReturning).not.toHaveBeenCalled()
  })

  it('stores a PDF from the Resend attachment CDN', async () => {
    resendAttachmentList.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: 'pdf-cdn',
            filename: 'invoice.pdf',
            content_type: 'application/pdf',
            download_url: 'https://cdn.resend.app/attachments/invoice.pdf',
          },
        ],
      },
      error: null,
    })

    const result = await processFinanceInboundWebhook({
      rawBody: '{}',
      svixId: 'msg_resend_cdn',
      svixTimestamp: '1',
      svixSignature: 'v1,sig',
    })

    expect(result.ok).toBe(true)
    expect(result.expenseId).toBe('exp-1')
    expect(expenseInsertReturning).toHaveBeenCalled()
  })

  it('downloads and stores the first allowed attachment on the draft', async () => {
    resendAttachmentList.mockResolvedValueOnce({
      data: {
        data: [
          {
            id: 'text-1',
            filename: 'notes.txt',
            content_type: 'text/plain',
            download_url: 'https://files.test/notes',
          },
          {
            id: 'pdf-1',
            filename: '../../Invoice August',
            content_type: 'application/pdf',
            download_url: 'https://files.test/invoice',
          },
        ],
      },
      error: null,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 })),
    )

    const result = await processFinanceInboundWebhook({
      rawBody: '{}',
      svixId: 'msg_attachment',
      svixTimestamp: '1',
      svixSignature: 'v1,sig',
    })

    expect(result.expenseId).toBe('exp-1')
    expect(fetch).toHaveBeenCalledWith('https://files.test/invoice')
    expect(mkdir).toHaveBeenCalledWith(
      '/tmp/trovara-evidence-test/finance-inbound/farm-1',
      { recursive: true },
    )
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/tmp\/trovara-evidence-test\/finance-inbound\/farm-1\/[^/]+-Invoice_August\.pdf$/,
      ),
      Buffer.from([37, 80, 68, 70]),
    )
    expect(insertedValues[1]).toMatchObject({
      attachmentFilename: 'Invoice_August.pdf',
      attachmentStorageKey: expect.stringMatching(
        /^finance-inbound\/farm-1\/[^/]+-Invoice_August\.pdf$/,
      ),
      attachmentMimeType: 'application/pdf',
    })
  })
})

describe('isFinanceInboundRecipient', () => {
  beforeEach(() => {
    delete process.env.FINANCE_INBOUND_RECIPIENTS
  })

  it('accepts finance aliases on configured-domain subdomains, but not other mailboxes', () => {
    expect(isFinanceInboundRecipient(['Finance <FINANCE@inbound.trovara.farm>'])).toBe(true)
    expect(isFinanceInboundRecipient(['orders@inbound.trovara.farm'])).toBe(false)
    expect(isFinanceInboundRecipient(['finance@trovara.example'])).toBe(false)
  })

  it('supports an explicit comma-separated recipient allowlist', () => {
    process.env.FINANCE_INBOUND_RECIPIENTS =
      'accounts@example.test, invoices@billing.example.test'
    expect(isFinanceInboundRecipient(['accounts@receive.example.test'])).toBe(true)
    expect(isFinanceInboundRecipient(['finance@trovara.farm'])).toBe(false)
  })
})

describe('isAllowedInboundDownloadUrl', () => {
  it('accepts Resend CDN hosts used for receiving attachments', () => {
    expect(isAllowedInboundDownloadUrl('https://cdn.resend.app/attachments/invoice.pdf')).toBe(true)
    expect(isAllowedInboundDownloadUrl('https://files.resend.com/attachments/invoice.pdf')).toBe(true)
    expect(isAllowedInboundDownloadUrl('https://bucket.s3.amazonaws.com/invoice.pdf')).toBe(true)
  })

  it('rejects http and unrelated hosts', () => {
    expect(isAllowedInboundDownloadUrl('http://cdn.resend.app/invoice.pdf')).toBe(false)
    expect(isAllowedInboundDownloadUrl('https://evil.example/invoice.pdf')).toBe(false)
    expect(isAllowedInboundDownloadUrl('https://cdn.resend.app.evil.example/invoice.pdf')).toBe(false)
  })
})
