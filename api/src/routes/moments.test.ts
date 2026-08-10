import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
let selectedRows: Row[] = []

vi.mock('../db/index.js', () => ({
  db: {
    select: () => {
      const chain: Record<string, unknown> = {}
      const same = () => chain
      Object.assign(chain, {
        from: same,
        where: same,
        orderBy: same,
        groupBy: same,
        limit: same,
        then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(selectedRows).then(resolve, reject),
      })
      return chain
    },
  },
}))

vi.mock('../lib/customer-orders.js', () => ({
  resolveCustomerFarm: vi.fn(async () => ({ id: 'farm-1' })),
}))
vi.mock('../lib/rate-limit.js', () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSec: 0 }),
}))
vi.mock('../lib/evidence-store.js', () => ({
  getEvidenceStorageRoot: () => '/tmp/trovara-moments-test',
}))
vi.mock('../lib/notifications.js', () => ({ sendEmail: vi.fn() }))
vi.mock('../lib/farm-notify.js', () => ({ notifyRolesTelegram: vi.fn() }))
vi.mock('../lib/registration.js', () => ({ getBreakGlassEmail: () => 'breakglass@example.com' }))
vi.mock('../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../lib/rbac.js', () => ({ hasPermission: () => true }))
vi.mock('../middleware/auth.js', () => ({ authMiddleware: vi.fn() }))

async function publicApp() {
  const { publicMomentsRoutes } = await import('./moments.js')
  const app = new Hono()
  app.route('/', publicMomentsRoutes)
  return app
}

describe('public Moments media', () => {
  beforeEach(() => {
    selectedRows = []
  })

  it.each(['pending', 'rejected'])('does not serve %s submissions', async (status) => {
    selectedRows = [{
      id: 'moment-1',
      status,
      storageKey: 'moments/farm-1/example.jpg',
      mimeType: 'image/jpeg',
    }]

    const response = await (await publicApp()).request('/moment-1/media')

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Not found' })
  })
})
