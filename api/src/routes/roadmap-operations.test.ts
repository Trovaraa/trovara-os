import { Hono } from 'hono'
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const tableName = (table: unknown) => getTableName(table as never)
const queues = new Map<string, Row[][]>()
const inserted: Array<{ table: string; values: Row }> = []
let sessionUser: Row = { id: '00000000-0000-4000-8000-000000000001', farmId: '00000000-0000-4000-8000-000000000010', role: 'supervisor' }

function queue(table: string, rows: Row[]) {
  const current = queues.get(table) ?? []
  current.push(rows)
  queues.set(table, current)
}

vi.mock('../db/index.js', () => {
  const select = () => {
    let rows: Row[] = []
    const chain: Record<string, unknown> = {}
    const same = () => chain
    Object.assign(chain, {
      from: (table: unknown) => { rows = queues.get(tableName(table))?.shift() ?? []; return chain },
      where: same,
      orderBy: same,
      limit: same,
      then: (resolve: (value: Row[]) => unknown) => Promise.resolve(rows).then(resolve),
    })
    return chain
  }
  return { db: {
    select,
    insert: (table: unknown) => ({ values: (values: Row) => {
      const name = tableName(table)
      inserted.push({ table: name, values })
      return { returning: async () => [{ id: '00000000-0000-4000-8000-000000000099', ...values }] }
    } }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
  } }
})

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => { c.set('user', sessionUser); await next() },
}))
vi.mock('../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../lib/evidence-store.js', () => ({ validateEvidenceRef: vi.fn(() => true), processEvidenceValue: vi.fn(async (_farm: string, value: string) => value) }))
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,qr') } }))

async function app() {
  const [{ scanningRoutes }, { maintenanceRoutes }, { contractorRoutes }] = await Promise.all([
    import('./scanning.js'), import('./maintenance.js'), import('./contractors.js'),
  ])
  const instance = new Hono()
  instance.route('/scan', scanningRoutes)
  instance.route('/maintenance', maintenanceRoutes)
  instance.route('/contractors', contractorRoutes)
  instance.onError((error, c) => error.message === 'FORBIDDEN'
    ? c.json({ error: 'Forbidden' }, 403)
    : c.json({ error: 'Internal server error' }, 500))
  return instance
}

beforeEach(() => {
  vi.clearAllMocks()
  queues.clear()
  inserted.length = 0
  sessionUser = { id: '00000000-0000-4000-8000-000000000001', farmId: '00000000-0000-4000-8000-000000000010', role: 'supervisor' }
})

describe('scanning', () => {
  it('resolves a farm-scoped inventory QR token', async () => {
    queue('inventory_items', [{ id: '00000000-0000-4000-8000-000000000020', farmId: sessionUser.farmId, sku: 'PLT-25', name: 'Plantain crate' }])
    const response = await (await app()).request('/scan/resolve?code=TRV%3AINV%3A00000000-0000-4000-8000-000000000020')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ kind: 'inventory', record: { sku: 'PLT-25' } })
  })

  it('does not reveal an unknown or other-farm QR token', async () => {
    queue('assets', [])
    const response = await (await app()).request('/scan/resolve?code=TRV%3AAST%3A00000000-0000-4000-8000-000000000020')
    expect(response.status).toBe(404)
  })
})

describe('maintenance authorization and tenancy', () => {
  it('does not let a field worker schedule maintenance', async () => {
    sessionUser = { ...sessionUser, role: 'field_worker' }
    const response = await (await app()).request('/maintenance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetId: '00000000-0000-4000-8000-000000000020', title: 'Service pump' }) })
    expect(response.status).toBe(403)
  })

  it('rejects an equipment id outside the current farm', async () => {
    queue('assets', [])
    const response = await (await app()).request('/maintenance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assetId: '00000000-0000-4000-8000-000000000020', title: 'Service pump' }) })
    expect(response.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })

  it('requires every checklist item before maintenance can be completed', async () => {
    queue('maintenance_work_orders', [{
      id: '00000000-0000-4000-8000-000000000030',
      farmId: sessionUser.farmId,
      assetId: '00000000-0000-4000-8000-000000000020',
      assignedToId: null,
      status: 'in_progress',
      checklist: ['Turn off power', 'Check belt'],
    }])
    const response = await (await app()).request('/maintenance/00000000-0000-4000-8000-000000000030/status', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed', completionNotes: 'Belt changed', completedChecklist: ['Turn off power'] }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('checklist') })
  })
})

describe('contractor tracking', () => {
  it('creates a contractor for a supervisor', async () => {
    const response = await (await app()).request('/contractors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ade Repairs', specialty: 'Irrigation pumps' }) })
    expect(response.status).toBe(201)
    expect(inserted.find((row) => row.table === 'contractors')?.values).toMatchObject({ farmId: sessionUser.farmId, name: 'Ade Repairs' })
  })

  it('rejects an engagement for a contractor outside the farm', async () => {
    queue('contractors', [])
    const response = await (await app()).request('/contractors/engagements', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contractorId: '00000000-0000-4000-8000-000000000020', title: 'Repair pump', startDate: '2026-08-20', agreedAmountMinor: 500000 }) })
    expect(response.status).toBe(400)
  })

  it('rejects a contractor payment above the agreed amount', async () => {
    queue('contractors', [{ id: '00000000-0000-4000-8000-000000000020' }])
    const response = await (await app()).request('/contractors/engagements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contractorId: '00000000-0000-4000-8000-000000000020', title: 'Repair pump', startDate: '2026-08-20', agreedAmountMinor: 500000, paidAmountMinor: 600000 }),
    })
    expect(response.status).toBe(400)
    expect(inserted).toHaveLength(0)
  })
})
