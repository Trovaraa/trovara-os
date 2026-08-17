import { Hono } from 'hono'
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const queues = new Map<string, Row[][]>()
let sessionUser: Row = { id: '00000000-0000-4000-8000-000000000001', farmId: '00000000-0000-4000-8000-000000000010', role: 'supervisor' }
const queue = (table: string, rows: Row[]) => queues.set(table, [...(queues.get(table) ?? []), rows])

vi.mock('../db/index.js', () => ({ db: {
  select: () => {
    let rows: Row[] = []
    const chain: Record<string, unknown> = {}
    const same = () => chain
    Object.assign(chain, { from: (table: unknown) => { rows = queues.get(getTableName(table as never))?.shift() ?? []; return chain }, where: same, orderBy: same, limit: same, then: (resolve: (value: Row[]) => unknown) => Promise.resolve(rows).then(resolve) })
    return chain
  },
  update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
} }))
vi.mock('../middleware/auth.js', () => ({ authMiddleware: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => { c.set('user', sessionUser); await next() } }))
vi.mock('../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../lib/anomaly-observations.js', () => ({ runAnomalyObservationMode: vi.fn(async () => ({ mode: 'observation', candidates: 2, created: 1, refreshed: 1, notified: false, sourceRecordsChanged: false })) }))

async function app() {
  const { anomalyRoutes } = await import('./anomalies.js')
  const instance = new Hono()
  instance.route('/anomalies', anomalyRoutes)
  instance.onError((error, c) => error.message === 'FORBIDDEN' ? c.json({ error: 'Forbidden' }, 403) : c.json({ error: 'Internal server error' }, 500))
  return instance
}

beforeEach(() => {
  queues.clear()
  sessionUser = { id: '00000000-0000-4000-8000-000000000001', farmId: '00000000-0000-4000-8000-000000000010', role: 'supervisor' }
})

describe('anomaly observation routes', () => {
  it('does not expose observations to field workers', async () => {
    sessionUser = { ...sessionUser, role: 'field_worker' }
    const response = await (await app()).request('/anomalies')
    expect(response.status).toBe(403)
  })

  it('returns observation mode explicitly', async () => {
    queue('anomaly_observations', [{ id: '00000000-0000-4000-8000-000000000020', status: 'observed' }])
    const response = await (await app()).request('/anomalies')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ mode: 'observation', observations: [{ status: 'observed' }] })
  })

  it('runs silently without changing source records', async () => {
    const response = await (await app()).request('/anomalies/run', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ mode: 'observation', notified: false, sourceRecordsChanged: false })
  })

  it('requires a review note', async () => {
    const response = await (await app()).request('/anomalies/00000000-0000-4000-8000-000000000020/review', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'false_positive', reviewNote: '' }) })
    expect(response.status).toBe(400)
  })
})
