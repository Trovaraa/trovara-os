import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let sessionUser: Record<string, unknown>

vi.mock('../db/index.js', () => ({
  db: { select: vi.fn(() => { throw new Error('database should not be queried') }) },
}))
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', sessionUser)
    await next()
  },
}))
vi.mock('../lib/exceptions.js', () => ({ gatherExceptions: vi.fn() }))
vi.mock('../lib/plot-profitability.js', () => ({ computePlotProfitability: vi.fn() }))
vi.mock('../lib/inventory-stock.js', () => ({ computeInventoryShrinkReport: vi.fn() }))
vi.mock('../lib/export-audit.js', () => ({
  exportJsonMeta: vi.fn(),
  exportWatermarkComment: vi.fn(),
  logDataExport: vi.fn(),
  parseExportReason: vi.fn(),
}))

beforeEach(() => {
  sessionUser = {
    id: 'user-1',
    farmId: 'farm-1',
    email: 'user@example.com',
    name: 'User',
    role: 'supervisor',
    mustChangePassword: false,
    permissions: [],
  }
})

describe('report and export permissions', () => {
  it('requires audit.export before the owner report exposes audit data', async () => {
    sessionUser.permissions = ['reports.read', 'finance.read']
    const { reportRoutes } = await import('./reports.js')
    const app = new Hono().route('/reports', reportRoutes)
    expect((await app.request('/reports/owner')).status).toBe(403)
  })

  it('requires both reports.read and audit.export for audit reports', async () => {
    sessionUser.permissions = ['audit.export']
    const { reportRoutes } = await import('./reports.js')
    const app = new Hono().route('/reports', reportRoutes)
    expect((await app.request('/reports/audit-export')).status).toBe(403)
  })

  it('does not let finance permission substitute for audit.export', async () => {
    sessionUser.permissions = ['reports.read', 'finance.read']
    const { exportRoutes } = await import('./exports.js')
    const app = new Hono().route('/exports', exportRoutes)
    expect((await app.request('/exports/audit.csv')).status).toBe(403)
  })

  it('requires reports.read in addition to a report-specific grant', async () => {
    sessionUser.permissions = ['tasks.approve']
    const { reportRoutes } = await import('./reports.js')
    const app = new Hono().route('/reports', reportRoutes)
    expect((await app.request('/reports/digest')).status).toBe(403)
  })
})
