import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const selectQueue: Row[][] = []
let sessionUser: Row = {
  id: '11111111-1111-4111-8111-111111111111',
  farmId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'owner',
}

vi.mock('../db/index.js', () => ({
  db: {
    select: () => {
      const rows = selectQueue.shift() ?? []
      const chain: Record<string, unknown> = {}
      const same = () => chain
      Object.assign(chain, {
        from: same,
        where: same,
        orderBy: same,
        groupBy: same,
        limit: same,
        then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      })
      return chain
    },
  },
}))

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set('user', sessionUser)
    await next()
  },
}))

const { shopCustomerRoutes } = await import('./shop-customers.js')

function app() {
  const hono = new Hono()
  hono.route('/api/shop-customers', shopCustomerRoutes)
  return hono
}

describe('shop-customers staff list', () => {
  beforeEach(() => {
    selectQueue.length = 0
    sessionUser = {
      id: '11111111-1111-4111-8111-111111111111',
      farmId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      role: 'owner',
    }
  })

  it('forbids field workers', async () => {
    sessionUser.role = 'field_worker'
    const res = await app().request('/api/shop-customers')
    expect(res.status).toBe(403)
  })

  it('lists customers with linked channels, credits, referrals, and summary', async () => {
    selectQueue.push(
      [
        {
          id: 'cust-1',
          email: 'ada@example.com',
          name: 'Ada',
          phone: '+2348000000000',
          emailVerifiedAt: new Date('2026-08-01T12:00:00Z'),
          active: true,
          createdAt: new Date('2026-08-01T10:00:00Z'),
          updatedAt: new Date('2026-08-01T12:00:00Z'),
        },
      ],
      [{ customerAccountId: 'cust-1', channel: 'telegram', name: 'Ada TG' }],
      [{ accountId: 'cust-1', balance: 3000 }],
      [{ accountId: 'cust-1', referralCount: 2, rewardsActivated: 1 }],
      [{ accountId: 'cust-1', code: 'TRVADA' }],
      [{ total: 1, verified: 1, unverified: 0, inactive: 0 }],
      [{ creditsBalance: 3000 }],
      [{ referrals: 2, rewardsActivated: 1 }],
    )

    const res = await app().request('/api/shop-customers')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.customers).toHaveLength(1)
    expect(body.customers[0].email).toBe('ada@example.com')
    expect(body.customers[0].channels).toEqual([{ channel: 'telegram', name: 'Ada TG' }])
    expect(body.customers[0]).toMatchObject({
      creditsBalance: 3000,
      referralCount: 2,
      rewardsActivated: 1,
      referralCode: 'TRVADA',
    })
    expect(body.summary).toEqual({
      total: 1,
      verified: 1,
      unverified: 0,
      inactive: 0,
      creditsBalance: 3000,
      referrals: 2,
      rewardsActivated: 1,
    })
    expect(JSON.stringify(body)).not.toContain('password')
  })

  it('allows sales role', async () => {
    sessionUser.role = 'sales'
    selectQueue.push(
      [],
      [{ total: 0, verified: 0, unverified: 0, inactive: 0 }],
      [{ creditsBalance: 0 }],
      [{ referrals: 0, rewardsActivated: 0 }],
    )
    const res = await app().request('/api/shop-customers')
    expect(res.status).toBe(200)
  })

  it('allows a custom content role with leads permission', async () => {
    sessionUser = {
      ...sessionUser,
      role: 'supervisor',
      permissions: ['leads.manage'],
    }
    selectQueue.push(
      [],
      [{ total: 0, verified: 0, unverified: 0, inactive: 0 }],
      [{ creditsBalance: 0 }],
      [{ referrals: 0, rewardsActivated: 0 }],
    )
    const res = await app().request('/api/shop-customers')
    expect(res.status).toBe(200)
  })
})
