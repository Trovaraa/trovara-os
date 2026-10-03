import { Hono } from 'hono'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '../lib/session.js'
const select = vi.hoisted(() => vi.fn())
vi.mock('../db/index.js', () => ({ db: { select } }))
let user: SessionUser
vi.mock('../middleware/auth.js', () => ({ authMiddleware: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => { c.set('user', user); await next() } }))
import { eventRoutes } from './events.js'

describe('event permissions', () => {
  it.each(['supervisor', 'sales', 'field_worker'] as const)('denies %s without events.read before querying farm data', async role => {
    select.mockClear()
    user = { id: 'synthetic', email: 'synthetic@example.test', name: 'Test', farmId: 'farm', role, farmRoleId: 'custom', permissions: ['brand.manage'], mustChangePassword: false }
    const response = await new Hono().route('/events', eventRoutes).request('/events')
    expect(response.status).toBe(403)
    expect(select).not.toHaveBeenCalled()
  })
  it.each(['owner', 'supervisor', 'sales', 'field_worker'] as const)('allows explicit grant for %s while keeping farm scope', async role => {
    const where = vi.fn((_condition: SQL) => ({ orderBy: () => ({ limit: async () => [] }) }))
    select.mockReturnValue({ from: () => ({ leftJoin: () => ({ where }) }) })
    user = { id: 'synthetic', email: 'synthetic@example.test', name: 'Test', farmId: 'farm', role, permissions: ['events.read'], mustChangePassword: false }
    expect((await new Hono().route('/events', eventRoutes).request('/events')).status).toBe(200)
    const { PgDialect } = await import('drizzle-orm/pg-core')
    expect(new PgDialect().sqlToQuery(where.mock.calls[0][0]).params).toContain('farm')
  })
})
