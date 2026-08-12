import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sendEmail, receivingGet, updates, selectQueue } = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  receivingGet: vi.fn(),
  updates: [] as Array<Record<string, unknown>>,
  selectQueue: [] as Array<Array<Record<string, unknown>>>,
}))

vi.mock('./notifications.js', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}))

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      receiving: {
        get: (...args: unknown[]) => receivingGet(...args),
      },
    }
  },
}))

vi.mock('../db/index.js', () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values)
        return {
          where: () => ({
            returning: async () =>
              values.inboundAckSentAt === null ? [] : [{ id: 'expense-1' }],
          }),
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
        limit: async () => rows,
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      })
      return chain
    },
  },
}))

import { maybeSendInboundApprovalAck, shouldAutoAckInboundSender } from './finance-inbound-ack.js'
import { parseInboundFromHeader } from './finance-inbound.js'

describe('parseInboundFromHeader', () => {
  it('splits display name and mailbox', () => {
    expect(parseInboundFromHeader('Vendor Co <bills@vendor.test>')).toEqual({
      email: 'bills@vendor.test',
      name: 'Vendor Co',
    })
  })

  it('handles bare addresses', () => {
    expect(parseInboundFromHeader('bills@vendor.test')).toEqual({
      email: 'bills@vendor.test',
      name: null,
    })
  })
})

describe('shouldAutoAckInboundSender', () => {
  it('skips noreply and farm mailboxes', () => {
    expect(shouldAutoAckInboundSender('noreply@vendor.test')).toBe(false)
    expect(shouldAutoAckInboundSender('finance@trovara.farm')).toBe(false)
    expect(shouldAutoAckInboundSender('billing@resend.com')).toBe(true)
  })
})

describe('maybeSendInboundApprovalAck', () => {
  beforeEach(() => {
    updates.length = 0
    selectQueue.length = 0
    sendEmail.mockReset()
    receivingGet.mockReset()
    process.env.RESEND_API_KEY = 're_test'
    process.env.EMAIL_FROM = 'Trovara <no-reply@trovara.farm>'
    process.env.FINANCE_INBOUND_RECIPIENTS = 'finance@trovara.farm'
  })

  it('sends once when an inbound draft is approved', async () => {
    sendEmail.mockResolvedValueOnce({ channel: 'email', status: 'delivered', required: false })

    const result = await maybeSendInboundApprovalAck({
      previousStatus: 'pending',
      expense: {
        id: 'expense-1',
        farmId: 'farm-1',
        source: 'inbound_email',
        approvalStatus: 'approved',
        inboundAckSentAt: null,
        inboundSenderEmail: 'billing@resend.com',
        inboundSenderName: 'Resend',
        inboundMessageId: 'email-1',
        receiptRef: '<msg-1@mail.gmail.com>',
        description: 'Inbound invoice: Resend Subscription Invoice',
      } as never,
    })

    expect(result).toEqual({ sent: true, to: 'billing@resend.com' })
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'billing@resend.com',
        replyTo: 'finance@trovara.farm',
        headers: {
          'In-Reply-To': '<msg-1@mail.gmail.com>',
          References: '<msg-1@mail.gmail.com>',
        },
      }),
    )
    expect(updates[0]).toMatchObject({ inboundAckSentAt: expect.any(Date) })
  })

  it('skips when already acknowledged', async () => {
    const result = await maybeSendInboundApprovalAck({
      previousStatus: 'pending',
      expense: {
        id: 'expense-1',
        farmId: 'farm-1',
        source: 'inbound_email',
        approvalStatus: 'approved',
        inboundAckSentAt: new Date(),
        inboundSenderEmail: 'billing@resend.com',
      } as never,
    })
    expect(result.sent).toBe(false)
    expect(sendEmail).not.toHaveBeenCalled()
  })
})
