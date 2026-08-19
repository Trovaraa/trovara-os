process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test'

import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const selectQueue: Row[][] = []
const conflictUpdates: Row[] = []
const selectMock = vi.fn()
const insertMock = vi.fn()

function selectChain(rows: Row[]) {
  const chain: Record<string, unknown> = {}
  const same = () => chain
  Object.assign(chain, {
    from: same,
    where: same,
    limit: same,
    then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  })
  return chain
}

vi.mock('../db/index.js', () => ({
  db: {
    select: (...args: unknown[]) => {
      selectMock(...args)
      return selectChain(selectQueue.shift() ?? [])
    },
    insert: (...args: unknown[]) => {
      insertMock(...args)
      return {
        values: () => ({
          onConflictDoUpdate: ({ set }: { set: Row }) => {
            conflictUpdates.push(set)
            return { returning: async () => [{ id: 'invite-1' }] }
          },
        }),
      }
    },
  },
}))

const { createOrRefreshCreditInvitation } = await import('./customer-credits.js')

beforeEach(() => {
  vi.clearAllMocks()
  selectQueue.length = 0
  conflictUpdates.length = 0
})

describe('credit invitation resend', () => {
  it('refreshes an unclaimed invitation and clears its old sent marker', async () => {
    selectQueue.push([])

    const result = await createOrRefreshCreditInvitation({
      farmId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      email: ' ADA@example.com ',
      name: 'Ada',
      surveyResponseId: 'survey-1',
      resendExisting: true,
    })

    expect(result).toMatchObject({
      kind: 'invitation',
      id: 'invite-1',
      email: 'ada@example.com',
    })
    expect(selectMock).toHaveBeenCalledTimes(1)
    expect(insertMock).toHaveBeenCalledTimes(1)
    expect(conflictUpdates[0]).toMatchObject({ sentAt: null, claimedAt: null })
  })

  it('keeps the bulk send idempotent when an active invitation was already sent', async () => {
    const expiresAt = new Date('2026-09-01T12:00:00Z')
    selectQueue.push([], [{ id: 'invite-existing', email: 'ada@example.com', name: 'Ada', expiresAt }])

    const result = await createOrRefreshCreditInvitation({
      farmId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      email: 'ada@example.com',
      name: 'Ada',
    })

    expect(result).toEqual({
      kind: 'already_invited',
      id: 'invite-existing',
      email: 'ada@example.com',
      name: 'Ada',
      expiresAt,
    })
    expect(insertMock).not.toHaveBeenCalled()
  })
})
